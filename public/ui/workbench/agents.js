import { api } from './api.js';
import { state, currentTask } from './state.js';
import { $, el, setStatus, taskRelative } from './dom.js';
import { openOperationReview } from './changes.js';
import { agentLabel, primeAgentLabels } from './agent-identity.js';
import { isLiveAgentSession, liveAgentPriority } from './agent-presence.js';

const branchCache = new Map();

function agentState(session) {
  const operations = (state.data?.operations || []).filter(operation => operation.sessionId === session.id);
  const pending = operations.find(operation => operation.status === 'pending');
  if (pending) return { key: 'approval', label: 'Waiting approval', operation: pending };
  const running = operations.find(operation => operation.status === 'running');
  if (running) return { key: 'working', label: 'Working', operation: running };
  if ((session.inFlightRequests || 0) > 0 || session.state === 'working') return { key: 'working', label: 'Working', operation: operations[0] };
  if (session.connected || session.state === 'connected') return { key: 'active', label: 'Connected', operation: operations[0] };
  const age = Date.now() - new Date(session.lastAccessedAt).getTime();
  if (session.active === false || age > 60_000) return { key: 'idle', label: 'Idle', operation: operations[0] };
  return { key: 'active', label: 'Recent', operation: operations[0] };
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function activityLabel(entry) {
  if (entry.tool) return entry.tool;
  if (entry.action) return entry.action;
  return entry.kind || 'activity';
}

function renderAgentActivity(entries) {
  $('agent-activity-count').textContent = entries.length;
  const rows = entries.map(entry => {
    const row = el('div', undefined, 'agent-activity-row');
    const marker = el('i', '', `activity-dot ${entry.status === 'error' || entry.status === 'blocked' ? 'error' : 'ok'}`);
    const copy = el('div', undefined, 'agent-activity-copy');
    copy.append(
      el('strong', activityLabel(entry)),
      el('span', `${entry.status || 'ok'} · ${formatTime(entry.time)}${entry.duration_ms != null ? ` · ${entry.duration_ms}ms` : ''}`),
    );
    if (entry.summary || entry.target) copy.append(el('span', entry.summary || entry.target, 'agent-activity-summary'));
    row.append(marker, copy);
    return row;
  });
  $('agent-activity-list').replaceChildren(...rows);
  if (!rows.length) $('agent-activity-list').append(el('p', 'Chưa có activity.', 'empty-copy'));
}

async function openAgentDetail(session, task, branch) {
  const status = agentState(session);
  const operations = (state.data?.operations || []).filter(operation => operation.sessionId === session.id).slice(0, 20);
  state.currentAgentSessionId = session.id;
  $('agent-dialog-title').textContent = agentLabel(session.id);
  $('agent-detail-status').textContent = status.operation ? `${status.label} · ${status.operation.tool}` : status.label;
  $('agent-detail-status').className = `agent-detail-status ${status.key}`;
  $('agent-detail-task').textContent = task?.title || session.taskId;
  $('agent-detail-branch').textContent = branch || '—';
  $('agent-detail-workspace').textContent = session.workspace;
  $('agent-detail-client').textContent = session.clientInfo?.name ? `${session.clientInfo.name}${session.clientInfo.version ? ` ${session.clientInfo.version}` : ''}` : 'Unknown client';
  $('agent-detail-session').textContent = session.id;
  $('agent-detail-last').textContent = formatTime(session.lastAccessedAt);
  $('agent-operation-count').textContent = operations.length;
  const rows = operations.map(operation => {
    const row = el('div', undefined, 'agent-operation-row');
    const copy = el('div', undefined, 'agent-operation-copy');
    const changedFiles = operation.changes || [];
    const fileSummary = changedFiles.length
      ? changedFiles.slice(0, 2).map(change => taskRelative(change.path)).join(', ') + (changedFiles.length > 2 ? ` +${changedFiles.length - 2}` : '')
      : 'no tracked file changes';
    copy.append(
      el('strong', operation.tool),
      el('span', `${operation.status} · ${formatTime(operation.createdAt)}`),
      el('span', fileSummary, 'agent-operation-files'),
    );
    row.append(copy);
    if (operation.review?.files?.length) {
      const review = el('button', operation.status === 'pending' ? 'Review' : 'Diff', 'mini-action');
      review.type = 'button';
      review.onclick = () => {
        $('agent-dialog').close();
        void openOperationReview(operation.id).catch(error => setStatus(error.message));
      };
      row.append(review);
    }
    return row;
  });
  $('agent-operation-list').replaceChildren(...rows);
  if (!rows.length) $('agent-operation-list').append(el('p', 'Chưa có operation.', 'empty-copy'));
  const reviewCurrent = $('agent-review-current');
  reviewCurrent.hidden = status.key !== 'approval' || !status.operation;
  reviewCurrent.onclick = status.operation ? () => {
    $('agent-dialog').close();
    void openOperationReview(status.operation.id).catch(error => setStatus(error.message));
  } : null;
  $('agent-open-task').onclick = () => {
    $('agent-dialog').close();
    window.dispatchEvent(new CustomEvent('workbench:switch-task', { detail: { taskId: session.taskId } }));
  };
  $('agent-filter-changes').onclick = () => {
    $('agent-dialog').close();
    window.dispatchEvent(new CustomEvent('workbench:show-agent-changes', { detail: { taskId: session.taskId, sessionId: session.id } }));
  };
  $('agent-dialog').showModal();
  $('agent-activity-list').replaceChildren(el('p', 'Loading activity…', 'empty-copy'));
  try {
    const activity = await api(`/api/activity?limit=80&kind=tool&task=${encodeURIComponent(session.taskId)}&q=${encodeURIComponent(session.id)}`);
    if (state.currentAgentSessionId === session.id) renderAgentActivity(activity.entries || []);
  } catch (error) {
    if (state.currentAgentSessionId === session.id) $('agent-activity-list').replaceChildren(el('p', `Activity unavailable: ${error.message}`, 'empty-copy'));
  }
}

async function branchForTask(taskId) {
  const selected = currentTask();
  if (selected?.id === taskId && state.git?.branch) return state.git.branch;
  const cached = branchCache.get(taskId);
  if (cached && Date.now() - cached.time < 5000) return cached.branch;
  try {
    const git = await api(`/api/workbench/tasks/${taskId}/git/status`);
    const branch = git.branch || '—';
    branchCache.set(taskId, { branch, time: Date.now() });
    return branch;
  } catch {
    return '—';
  }
}

export async function loadAgents() {
  const health = await api('/health');
  state.health = health;
  const allSessions = [...(health.sessions || [])].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const operations = state.data?.operations || [];
  const sessions = allSessions
    .filter(session => isLiveAgentSession(session, operations))
    .sort((a, b) => {
      const priority = liveAgentPriority(a, operations) - liveAgentPriority(b, operations);
      if (priority !== 0) return priority;
      return new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime();
    });
  primeAgentLabels(sessions);
  const tasks = new Map((state.data?.tasks || []).map(task => [task.id, task]));
  const branchPairs = await Promise.all([...new Set(sessions.map(session => session.taskId))].map(async taskId => [taskId, await branchForTask(taskId)]));
  const branches = new Map(branchPairs);
  const rows = sessions.map(session => {
    const task = tasks.get(session.taskId);
    const status = agentState(session);
    const row = el('div', undefined, 'agent-row');
    const name = el('span', undefined, 'agent-cell agent-name');
    name.append(el('i', '', `dot agent-dot ${status.key}`), el('span', agentLabel(session.id)));
    row.append(
      name,
      el('span', status.label, `agent-cell agent-status-cell ${status.key}`),
      el('span', task?.title || session.taskId.slice(0, 8), 'agent-cell'),
      el('span', branches.get(session.taskId) || '—', 'agent-cell'),
    );
    row.title = `${status.label}${status.operation ? ` · ${status.operation.tool}` : ''}\n${session.id}\n${session.workspace}`;
    row.onclick = () => void openAgentDetail(session, task, branches.get(session.taskId));
    return row;
  });
  $('agent-list').replaceChildren(...rows);
  if (!rows.length) $('agent-list').append(el('p', 'Chưa có ChatGPT session đang hoạt động.', 'empty-copy'));
  $('agent-count').textContent = `${sessions.length} active`;
  $('status-agents').textContent = `${sessions.length} agent${sessions.length === 1 ? '' : 's'} active`;
  $('mcp-dot').classList.toggle('muted-dot', sessions.length === 0);
  $('mcp-state').textContent = sessions.length ? 'Connected' : 'Waiting';
  $('status-mcp').replaceChildren(el('i', '', `dot${sessions.length ? '' : ' muted-dot'}`), document.createTextNode(sessions.length ? 'MCP connected' : 'No active chat'));
}