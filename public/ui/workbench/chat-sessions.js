import { state, currentWorkspace, currentWorkspaceTasks } from './state.js';
import { $, el, setStatus } from './dom.js';
import { assignmentPrompt, sharedCheckoutWarning, slotIssue } from './session-slots.js';

const CHATGPT_URL = 'https://chatgpt.com/';
const SLOT_COUNT = 4;
const windowHandles = new Map();
let selectedLayout = Number(localStorage.getItem('replace-chat-layout') || 4);

function storageKey() {
  return `replace-chat-prompts:${currentWorkspace()?.id || 'global'}`;
}

function readPrompts() {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey()) || '[]');
    return Array.from({ length: SLOT_COUNT }, (_, index) => String(value[index] || ''));
  } catch {
    return Array(SLOT_COUNT).fill('');
  }
}

function savePrompts(prompts) {
  localStorage.setItem(storageKey(), JSON.stringify(prompts));
}

function assignmentKey() {
  return `replace-chat-task-slots:${currentWorkspace()?.id || 'global'}`;
}

function readAssignments() {
  try {
    const value = JSON.parse(localStorage.getItem(assignmentKey()) || '[]');
    return Array.from({ length: SLOT_COUNT }, (_, index) => String(value[index] || ''));
  } catch {
    return Array(SLOT_COUNT).fill('');
  }
}

function saveAssignments(ids) {
  localStorage.setItem(assignmentKey(), JSON.stringify(ids));
}

function workspaceAgents() {
  const workspace = currentWorkspace();
  if (!workspace) return [];
  return (state.agentCoordinator?.agents || []).filter(agent => agent.workspaceId === workspace.id);
}

function agentStatus(agent) {
  if (!agent) return { label: 'Not connected', key: 'idle' };
  if (agent.queued) return { label: 'Waiting', key: 'queued' };
  if (agent.taskConfirmed === false) return { label: 'Unassigned (confirm task)', key: 'idle' };
  if (agent.status === 'approval_required') return { label: 'Approval', key: 'approval' };
  if (agent.status === 'working') return { label: 'Working', key: 'working' };
  if (agent.active) return { label: 'Connected', key: 'active' };
  return { label: 'Idle', key: 'idle' };
}

function layoutRects(count) {
  const left = Number.isFinite(screen.availLeft) ? screen.availLeft : 0;
  const top = Number.isFinite(screen.availTop) ? screen.availTop : 0;
  const width = Math.max(640, screen.availWidth || window.innerWidth || 1280);
  const height = Math.max(520, screen.availHeight || window.innerHeight || 800);
  const halfWidth = Math.floor(width / 2);
  const halfHeight = Math.floor(height / 2);
  if (count === 1) return [{ left, top, width, height }];
  if (count === 2) return [
    { left, top, width: halfWidth, height },
    { left: left + halfWidth, top, width: width - halfWidth, height },
  ];
  if (count === 3) return [
    { left, top, width: halfWidth, height: halfHeight },
    { left: left + halfWidth, top, width: width - halfWidth, height: halfHeight },
    { left, top: top + halfHeight, width, height: height - halfHeight },
  ];
  return [
    { left, top, width: halfWidth, height: halfHeight },
    { left: left + halfWidth, top, width: width - halfWidth, height: halfHeight },
    { left, top: top + halfHeight, width: halfWidth, height: height - halfHeight },
    { left: left + halfWidth, top: top + halfHeight, width: width - halfWidth, height: height - halfHeight },
  ];
}

function placeWindow(handle, rect) {
  try {
    handle.moveTo(rect.left, rect.top);
    handle.resizeTo(rect.width, rect.height);
    handle.focus();
  } catch {
    // Window placement is best-effort; the ChatGPT page remains usable.
  }
}

function openSlot(index, rect) {
  const existing = windowHandles.get(index);
  if (existing && !existing.closed) {
    placeWindow(existing, rect);
    return true;
  }
  const features = `popup=yes,left=${Math.round(rect.left)},top=${Math.round(rect.top)},width=${Math.round(rect.width)},height=${Math.round(rect.height)},resizable=yes,scrollbars=yes`;
  const handle = window.open(CHATGPT_URL, `replace-chatgpt-${index + 1}`, features);
  if (!handle) return false;
  windowHandles.set(index, handle);
  placeWindow(handle, rect);
  return true;
}

function setWindowMessage(text, attention = false) {
  const node = $('chat-window-status');
  if (!node) return;
  node.textContent = text;
  node.classList.toggle('attention', attention);
}

async function copyPrompt(text, index) {
  if (!text.trim()) return;
  await navigator.clipboard.writeText(text);
  setStatus(`ChatGPT #${index + 1} prompt copied`);
}

function renderSlot(index, prompt, task, agents, selectedIds, prompts, tasks) {
  // Agent rows are ordered by activity, NOT by browser window; never pair them by array index.
  const matching = agents.filter(agent => agent.taskId === task?.id && !agent.queued && agent.taskConfirmed !== false);
  const agent = matching.find(item => item.active) || matching[0];
  const status = agentStatus(agent);
  const issue = slotIssue(task, tasks, selectedIds, index, agents);
  const sharedWarning = sharedCheckoutWarning(task, tasks, selectedIds, index);
  const card = el('article', undefined, 'chat-slot-card');
  const head = el('div', undefined, 'chat-slot-head');
  const identity = el('div', undefined, 'chat-slot-identity');
  identity.append(el('small', `CHATGPT #${index + 1}`), el('strong', task?.title || 'Choose a task'));
  head.append(identity, el('span', agent ? `Task: ${status.label}` : 'Not verified', `chat-slot-status ${agent ? status.key : 'idle'}`));

  const selector = el('label', 'Assign task to this window', 'chat-slot-task-label');
  const select = document.createElement('select');
  select.className = 'chat-slot-task-select';
  select.setAttribute('aria-label', `Task for ChatGPT window ${index + 1}`);
  select.append(new Option('Select a task…', ''));
  for (const candidate of tasks.filter(item => ['open', 'blocked'].includes(item.lifecycle))) {
    select.append(new Option(`${candidate.title} · ${candidate.execution?.mode === 'worktree' ? 'isolated worktree' : 'shared checkout'}`, candidate.id));
  }
  select.value = task?.id || '';
  select.onchange = () => {
    selectedIds[index] = select.value;
    saveAssignments(selectedIds);
    renderChatSessions();
  };
  selector.append(select);

  const meta = el('div', undefined, 'chat-slot-meta');
  meta.append(
    el('span', task?.execution?.branch || 'No separate branch'),
    el('span', agent ? `${matching.length} MCP session(s) on task; window identity unverified` : 'No MCP session verified for this window'),
  );

  const safety = el('p', issue || sharedWarning || 'Ready to copy assignment instructions. Verify the task ID in ChatGPT before working.', `chat-slot-safety${issue || sharedWarning ? ' attention' : ''}`);

  const textarea = document.createElement('textarea');
  textarea.className = 'chat-slot-prompt';
  textarea.rows = 5;
  textarea.placeholder = 'Write the prompt for this ChatGPT window…';
  textarea.value = prompt;

  const actions = el('div', undefined, 'chat-slot-actions');
  const copy = el('button', 'Copy prompt', 'mini-action');
  copy.type = 'button';
  copy.disabled = Boolean(issue);
  textarea.oninput = () => {
    prompts[index] = textarea.value;
    savePrompts(prompts);
    copy.disabled = Boolean(issue);
  };
  copy.onclick = () => void copyPrompt(assignmentPrompt(task, currentWorkspace(), textarea.value), index).catch(error => setStatus(error.message));

  const open = el('button', windowHandles.get(index) && !windowHandles.get(index).closed ? 'Focus ChatGPT' : 'Open ChatGPT', 'secondary-button compact-action chat-slot-open');
  open.type = 'button';
  open.disabled = Boolean(issue);
  open.onclick = () => {
    if (issue) { setWindowMessage(issue, true); return; }
    const rects = layoutRects(selectedLayout);
    const rect = rects[Math.min(index, rects.length - 1)] || layoutRects(1)[0];
    if (!openSlot(index, rect)) {
      setWindowMessage('Chrome blocked the window. Allow pop-ups for this local Workbench, then retry.', true);
      return;
    }
    setWindowMessage(`ChatGPT #${index + 1} opened for ${task.title}. Copy the assignment prompt, paste it there, and verify the task ID. Opening a window does not bind its MCP session.`);
    renderChatSessions();
  };

  actions.append(copy, open);
  card.append(head, selector, meta, safety, textarea, actions);
  return card;
}

export function renderChatSessions() {
  if (!$('chat-sessions-dialog')) return;
  const agents = workspaceAgents();
  const prompts = readPrompts();
  const selectedIds = readAssignments();
  const tasks = currentWorkspaceTasks();
  $('chat-session-workspace').textContent = currentWorkspace()?.name || 'No workspace';
  $('chat-session-live-summary').textContent = `${agents.filter(agent => agent.active).length} connected · ${agents.filter(agent => agent.queued).length} waiting`;
  $('chat-session-grid').replaceChildren(...Array.from({ length: SLOT_COUNT }, (_, index) =>
    renderSlot(index, prompts[index], tasks.find(item => item.id === selectedIds[index]), agents, selectedIds, prompts, tasks)));
  $('chat-sessions-count').textContent = String(agents.filter(agent => agent.active).length);
  document.querySelectorAll('[data-chat-layout]').forEach(button => button.classList.toggle('active', Number(button.dataset.chatLayout) === selectedLayout));
}

function openLayout(count) {
  selectedLayout = count;
  localStorage.setItem('replace-chat-layout', String(count));
  const ids = readAssignments();
  const tasks = currentWorkspaceTasks();
  const agents = workspaceAgents();
  for (let index = 0; index < count; index += 1) {
    const issue = slotIssue(tasks.find(task => task.id === ids[index]), tasks, ids.slice(0, count), index, agents);
    if (issue) {
      setWindowMessage(`ChatGPT #${index + 1}: ${issue} Assign a different available task to each window.`, true);
      renderChatSessions();
      return;
    }
  }
  const rects = layoutRects(count);
  let blocked = 0;
  for (let index = 0; index < count; index += 1) {
    if (!openSlot(index, rects[index])) blocked += 1;
  }
  const sharing = ids.slice(0, count).some((id, index) => sharedCheckoutWarning(tasks.find(task => task.id === id), tasks, ids.slice(0, count), index));
  setWindowMessage(blocked ? `${blocked} window${blocked === 1 ? '' : 's'} blocked. Allow pop-ups and click the layout again.` : `${count} windows opened. Verify each exact task ID before work.${sharing ? ' Shared checkouts allow parallel chats, but mutating operations wait their turn and changes are visible to every task.' : ''}`, Boolean(blocked || sharing));
  renderChatSessions();
}

export function setupChatSessions() {
  $('chat-sessions-button').onclick = () => {
    renderChatSessions();
    $('chat-sessions-dialog').showModal();
  };
  document.querySelectorAll('[data-chat-layout]').forEach(button => {
    button.onclick = () => openLayout(Number(button.dataset.chatLayout));
  });
  window.addEventListener('workbench:agents-updated', renderChatSessions);
  renderChatSessions();
}