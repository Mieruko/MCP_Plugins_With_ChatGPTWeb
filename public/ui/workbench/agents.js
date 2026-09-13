import { api } from './api.js';
import { state } from './state.js';
import { $, el, setStatus, taskRelative } from './dom.js';
import { openOperationReview } from './changes.js';

function coordinatorState(agent) {
  if (agent.taskLifecycle === 'blocked') return { key: 'conflict', label: 'Blocked' };
  if (agent.taskLifecycle === 'ready_to_merge') return { key: 'ready', label: 'Ready to merge' };
  if (agent.taskLifecycle === 'merged') return { key: 'merged', label: 'Merged' };
  if (agent.status === 'approval_required') return { key: 'approval', label: 'Waiting approval' };
  if (agent.status === 'working') return { key: 'working', label: 'Working' };
  if (agent.status === 'connected') return { key: 'active', label: 'Connected' };
  if (agent.status === 'recent') return { key: 'active', label: 'Recent' };
  if (agent.status === 'waiting') return { key: 'queued', label: 'Waiting for ChatGPT' };
  return { key: 'idle', label: 'Idle' };
}

function taskLifecycleLabel(value) {
  if (value === 'ready_to_merge') return 'Ready to merge';
  if (value === 'blocked') return 'Blocked';
  if (value === 'merged') return 'Merged';
  if (value === 'completed') return 'Completed';
  if (value === 'archived') return 'Archived';
  return 'Open';
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
  if (!rows.length) $('agent-activity-list').append(el('p', 'No recent activity.', 'empty-copy'));
}

function renderAgentConflicts(agent) {
  const conflicts = agent.conflicts || [];
  $('agent-conflicts-section').hidden = !conflicts.length;
  $('agent-conflict-detail-count').textContent = String(conflicts.length);
  const rows = conflicts.map(conflict => {
    const row = el('article', undefined, `agent-conflict-card ${conflict.severity}`);
    const head = el('div', undefined, 'agent-conflict-card-head');
    head.append(
      el('strong', conflict.type === 'path_overlap' ? 'File overlap' : conflict.type === 'shared_environment' ? 'Shared checkout' : 'Shared task'),
      el('span', conflict.severity === 'conflict' ? 'Conflict' : 'Risk', `agent-conflict-badge ${conflict.severity}`),
    );
    row.append(head, el('p', conflict.message));
    if (conflict.paths?.length) {
      const files = el('div', undefined, 'agent-conflict-paths');
      conflict.paths.slice(0, 6).forEach(path => files.append(el('code', path)));
      if (conflict.paths.length > 6) files.append(el('span', `+${conflict.paths.length - 6} more`));
      row.append(files);
    }
    return row;
  });
  $('agent-conflict-list').replaceChildren(...rows);
}

function renderAgentOperations(agent) {
  const operations = agent.sessionId
    ? (state.data?.operations || []).filter(operation => operation.sessionId === agent.sessionId).slice(0, 20)
    : [];
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
  if (!rows.length) $('agent-operation-list').append(el('p', agent.queued ? 'Waiting for a ChatGPT session.' : 'No recent operations.', 'empty-copy'));
  return operations;
}

async function cancelAssignment(agent) {
  await api(`/api/workbench/tasks/${encodeURIComponent(agent.taskId)}/assignment`, { method: 'DELETE' });
  $('agent-dialog').close();
  await loadAgents();
  setStatus(`Assignment cancelled · ${agent.taskTitle}`);
}

async function openAgentDetail(agent) {
  const status = coordinatorState(agent);
  const operations = renderAgentOperations(agent);
  const pending = operations.find(operation => operation.status === 'pending');
  state.currentAgentSessionId = agent.sessionId || null;
  state.currentAgentId = agent.id;
  $('agent-dialog-title').textContent = agent.taskTitle || 'Agent';
  $('agent-detail-status').textContent = status.label;
  $('agent-detail-status').className = `agent-detail-status ${status.key}`;
  $('agent-detail-task').textContent = agent.taskTitle || agent.taskId;
  $('agent-detail-lifecycle').textContent = taskLifecycleLabel(agent.taskLifecycle);
  $('agent-detail-branch').textContent = agent.branch || '—';
  $('agent-detail-changes').textContent = `${agent.changedPaths?.length || 0} file${agent.changedPaths?.length === 1 ? '' : 's'}`;
  $('agent-detail-preview').textContent = agent.previewPort
    ? `${agent.previewRunning ? 'Running' : 'Configured'} · :${agent.previewPort}`
    : '—';
  $('agent-detail-workspace').textContent = agent.executionPath || agent.workspace || '—';
  $('agent-detail-client').textContent = agent.queued
    ? 'Waiting for next ChatGPT session'
    : agent.clientInfo?.name ? `${agent.clientInfo.name}${agent.clientInfo.version ? ` ${agent.clientInfo.version}` : ''}` : 'ChatGPT';
  $('agent-detail-id').textContent = agent.agentId || (agent.assignmentId ? `assignment:${agent.assignmentId}` : agent.id);
  $('agent-detail-session').textContent = agent.sessionId || 'Waiting for next ChatGPT session';
  $('agent-detail-last').textContent = formatTime(agent.lastSeenAt || agent.createdAt);
  renderAgentConflicts(agent);

  const reviewCurrent = $('agent-review-current');
  reviewCurrent.hidden = !pending;
  reviewCurrent.onclick = pending ? () => {
    $('agent-dialog').close();
    void openOperationReview(pending.id).catch(error => setStatus(error.message));
  } : null;
  const cancel = $('agent-cancel-assignment');
  cancel.hidden = !agent.queued;
  cancel.onclick = agent.queued ? () => void cancelAssignment(agent).catch(error => setStatus(error.message)) : null;
  const openPreview = $('agent-open-preview');
  openPreview.hidden = !(agent.previewRunning && agent.previewUrl);
  openPreview.onclick = openPreview.hidden ? null : () => window.open(agent.previewUrl, '_blank', 'noopener,noreferrer');
  $('agent-open-task').onclick = () => {
    $('agent-dialog').close();
    window.dispatchEvent(new CustomEvent('workbench:switch-task', { detail: { taskId: agent.taskId } }));
  };
  $('agent-filter-changes').onclick = () => {
    $('agent-dialog').close();
    if (agent.sessionId) {
      window.dispatchEvent(new CustomEvent('workbench:show-agent-changes', { detail: { taskId: agent.taskId, sessionId: agent.sessionId } }));
    } else {
      window.dispatchEvent(new CustomEvent('workbench:switch-task', { detail: { taskId: agent.taskId } }));
    }
  };
  $('agent-dialog').showModal();

  if (!agent.sessionId) {
    $('agent-activity-count').textContent = '0';
    $('agent-activity-list').replaceChildren(el('p', 'Activity starts when a ChatGPT session claims this task.', 'empty-copy'));
    return;
  }
  $('agent-activity-list').replaceChildren(el('p', 'Loading activity…', 'empty-copy'));
  try {
    const activity = await api(`/api/activity?limit=80&kind=tool&task=${encodeURIComponent(agent.taskId)}&q=${encodeURIComponent(agent.sessionId)}`);
    if (state.currentAgentId === agent.id) renderAgentActivity(activity.entries || []);
  } catch (error) {
    if (state.currentAgentId === agent.id) $('agent-activity-list').replaceChildren(el('p', `Activity unavailable: ${error.message}`, 'empty-copy'));
  }
}

function renderConnectionStatus(health) {
  $('mcp-dot').classList.remove('muted-dot', 'attention-dot');
  $('mcp-state').textContent = 'Ready';
  const chatgpt = health.chatgpt || { status: 'not_connected', connected: false, active_sessions: 0, pending_approvals: 0 };
  const chatgptDot = $('chatgpt-dot');
  chatgptDot.classList.remove('muted-dot', 'attention-dot');
  let chatgptLabel = 'Not connected';
  if (chatgpt.status === 'connected') chatgptLabel = 'Connected';
  else if (chatgpt.status === 'approval_required') {
    chatgptLabel = 'Approval required';
    chatgptDot.classList.add('attention-dot');
  } else chatgptDot.classList.add('muted-dot');
  $('chatgpt-state').textContent = chatgptLabel;
  $('status-mcp').replaceChildren(
    el('i', '', 'dot'),
    document.createTextNode(`MCP ready · ChatGPT ${chatgptLabel.toLowerCase()}`),
  );
}

export async function loadAgents() {
  const [health, coordinator] = await Promise.all([api('/health'), api('/api/workbench/agents')]);
  state.health = health;
  state.agentCoordinator = coordinator;
  const agents = (coordinator.agents || []).filter(agent => agent.active || agent.queued || agent.conflicts?.length);
  const rows = agents.map(agent => {
    const status = coordinatorState(agent);
    const hasConflict = (agent.conflicts || []).some(conflict => conflict.severity === 'conflict');
    const row = el('div', undefined, `agent-row${hasConflict ? ' has-conflict' : ''}${agent.queued ? ' queued' : ''}`);
    const name = el('span', undefined, 'agent-cell agent-name');
    name.append(el('i', '', `dot agent-dot ${hasConflict ? 'conflict' : status.key}`), el('span', agent.taskTitle || 'ChatGPT agent'));
    const changeCopy = hasConflict
      ? `⚠ ${agent.conflicts.filter(conflict => conflict.severity === 'conflict').length} · ${agent.changedPaths.length} files`
      : `${agent.changedPaths.length} file${agent.changedPaths.length === 1 ? '' : 's'}`;
    row.append(
      name,
      el('span', status.label, `agent-cell agent-status-cell ${hasConflict ? 'conflict' : status.key}`),
      el('span', agent.branch || '—', 'agent-cell agent-branch-cell'),
      el('span', changeCopy, `agent-cell agent-change-cell${hasConflict ? ' conflict' : ''}`),
    );
    row.title = `${agent.taskTitle}\n${status.label}\n${agent.branch || 'No branch'}${agent.previewPort ? `\nPreview :${agent.previewPort}${agent.previewRunning ? ' running' : ''}` : ''}\n${agent.executionPath || agent.workspace}`;
    row.onclick = () => void openAgentDetail(agent);
    return row;
  });
  $('agent-list').replaceChildren(...rows);
  if (!rows.length) $('agent-list').append(el('p', 'No ChatGPT agents or queued tasks.', 'empty-copy'));

  const summary = coordinator.summary || { active: 0, waiting: 0, conflicts: 0 };
  $('agent-active-count').textContent = String(summary.active || 0);
  $('agent-waiting-count').textContent = String(summary.waiting || 0);
  $('agent-conflict-count').textContent = String(summary.conflicts || 0);
  $('agent-conflict-summary').classList.toggle('attention', Boolean(summary.conflicts));
  const countParts = [`${summary.active || 0} active`];
  if (summary.waiting) countParts.push(`${summary.waiting} waiting`);
  if (summary.conflicts) countParts.push(`${summary.conflicts} conflict`);
  $('agent-count').textContent = countParts.join(' · ');
  $('status-agents').textContent = `${summary.active || 0} agent${summary.active === 1 ? '' : 's'} active${summary.waiting ? ` · ${summary.waiting} waiting` : ''}`;
  renderConnectionStatus(health);
  window.dispatchEvent(new CustomEvent('workbench:agents-updated', { detail: { coordinator } }));
}