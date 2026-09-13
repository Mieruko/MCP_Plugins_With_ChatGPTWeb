import { api } from './api.js';
import { state } from './state.js';
import { $, el, setStatus } from './dom.js';

let editingDependencyTaskId = null;

function lifecycleInfo(value) {
  if (value === 'ready_to_merge') return { key: 'ready', label: 'Ready to merge' };
  if (value === 'blocked') return { key: 'blocked', label: 'Blocked' };
  if (value === 'merged') return { key: 'merged', label: 'Merged' };
  if (value === 'completed') return { key: 'merged', label: 'Finished' };
  if (value === 'archived') return { key: 'blocked', label: 'Discarded' };
  return { key: 'open', label: 'Open' };
}

function integrationAction(label, className, onClick, disabled = false) {
  const button = el('button', label, className);
  button.type = 'button';
  button.disabled = disabled;
  button.onclick = () => void Promise.resolve().then(() => onClick(button)).catch(error => setStatus(error.message));
  return button;
}

function dependencySummary(task) {
  const wrapper = el('div', undefined, 'integration-dependencies');
  const head = el('div', undefined, 'integration-dependencies-head');
  head.append(el('strong', 'Dependencies'));
  if (task.canEditDependencies) {
    head.append(integrationAction('Edit', 'mini-action integration-dependency-edit', () => openDependencyEditor(task)));
  }
  wrapper.append(head);
  const dependencies = task.dependencies || [];
  if (!dependencies.length) {
    wrapper.append(el('span', 'No dependencies · can merge as soon as this task passes preflight.', 'integration-dependency-empty'));
    return wrapper;
  }
  const chips = el('div', undefined, 'integration-dependency-chips');
  dependencies.forEach(dependency => {
    chips.append(el(
      'span',
      `${dependency.satisfied ? '✓' : '○'} ${dependency.taskTitle}`,
      `integration-dependency-chip ${dependency.satisfied ? 'satisfied' : 'waiting'}`,
    ));
  });
  wrapper.append(chips);
  return wrapper;
}

function cleanupSummary(task) {
  if (task.lifecycle !== 'merged') return null;
  const wrapper = el('div', undefined, `integration-cleanup ${task.cleanupStatus || 'not_started'}`);
  const label = task.cleanupStatus === 'completed'
    ? 'Managed worktree + branch cleaned up'
    : task.cleanupStatus === 'partial'
      ? 'Merge complete · cleanup partially completed'
      : task.cleanupStatus === 'failed'
        ? 'Merge complete · cleanup needs retry'
        : 'Merge complete · cleanup pending';
  wrapper.append(el('strong', label));
  if (task.cleanupError) wrapper.append(el('span', task.cleanupError));
  return wrapper;
}

function integrationCard(task) {
  const lifecycle = lifecycleInfo(task.lifecycle);
  const card = el('article', undefined, `integration-card ${lifecycle.key}`);
  const head = el('div', undefined, 'integration-card-head');
  const identity = el('div', undefined, 'integration-card-identity');
  identity.append(
    el('strong', task.taskTitle),
    el('span', `${task.branch || 'task branch'} → ${task.targetBranch || 'target branch'}`, 'integration-route'),
  );
  head.append(identity, el('span', lifecycle.label, `integration-status ${lifecycle.key}`));

  const meta = el('div', undefined, 'integration-meta');
  if (task.queuePosition) meta.append(el('span', `Queue #${task.queuePosition}`, 'queue-position'));
  meta.append(
    el('span', `${task.commitsAhead || 0} ahead`),
    el('span', `${task.commitsBehind || 0} behind`),
    el('span', `${task.changedPaths?.length || 0} files`),
  );
  if (task.sourceDirty) meta.append(el('span', 'source dirty', 'attention'));
  if (task.targetDirty) meta.append(el('span', 'target dirty', 'attention'));
  if (task.previewPort) meta.append(el('span', `${task.previewRunning ? 'Preview' : 'Port'} :${task.previewPort}`, task.previewRunning ? 'preview-running' : 'preview-port'));
  if (task.runningProcesses) meta.append(el('span', `${task.runningProcesses} process${task.runningProcesses === 1 ? '' : 'es'} running`, 'attention'));
  if (task.unresolvedDependencyIds?.length) meta.append(el('span', `${task.unresolvedDependencyIds.length} waiting deps`, 'attention'));
  if (task.lifecycle === 'merged') meta.append(el('span', `cleanup ${task.cleanupStatus || 'pending'}`, task.cleanupStatus === 'completed' ? 'cleanup-ok' : 'attention'));

  card.append(head, meta, dependencySummary(task), el('p', task.reason || 'Integration state unavailable.', 'integration-reason'));
  const cleanup = cleanupSummary(task);
  if (cleanup) card.append(cleanup);

  if (task.conflictPaths?.length) {
    const conflicts = el('div', undefined, 'integration-conflicts');
    conflicts.append(el('strong', 'Conflicts'));
    task.conflictPaths.slice(0, 8).forEach(path => conflicts.append(el('code', path)));
    if (task.conflictPaths.length > 8) conflicts.append(el('span', `+${task.conflictPaths.length - 8} more`));
    card.append(conflicts);
  }

  const actions = el('div', undefined, 'integration-actions');
  if (task.worktreePresent) {
    actions.append(integrationAction('Open task', 'secondary-button compact-action', () => {
      $('integration-dialog').close();
      window.dispatchEvent(new CustomEvent('workbench:switch-task', { detail: { taskId: task.taskId } }));
    }));
  }

  if (task.lifecycle === 'open' || task.lifecycle === 'blocked') {
    actions.append(integrationAction(
      task.lifecycle === 'blocked' ? 'Recheck' : 'Mark ready',
      'primary-button compact-action',
      button => mutateIntegration(task, 'ready', button),
      !task.canMarkReady,
    ));
  }
  if (task.runningProcesses) {
    actions.append(integrationAction('Stop processes', 'secondary-button compact-action', button => stopTaskProcesses(task, button)));
  }
  if (task.canResume) {
    actions.append(integrationAction('Resume work', 'secondary-button compact-action', button => mutateIntegration(task, 'reopen', button)));
  }
  if (task.lifecycle === 'ready_to_merge') {
    actions.append(integrationAction('Integrate & finish', 'primary-button compact-action', async button => {
      if (!task.canMerge) return;
      if (!confirm(`Integrate and finish "${task.taskTitle}" into ${task.targetBranch}?\n\nThis merges locally, cleans up its managed worktree and branch, and marks the task finished. Local Coder will never push automatically.`)) return;
      await mutateIntegration(task, 'finish', button);
    }, !task.canMerge));
  }
  if (task.lifecycle === 'merged' && task.cleanupStatus === 'completed') {
    actions.append(integrationAction('Finish task', 'primary-button compact-action', button => mutateIntegration(task, 'finish', button)));
  }
  if (task.canRetryCleanup) {
    actions.append(integrationAction('Retry cleanup', 'secondary-button compact-action', button => mutateIntegration(task, 'cleanup', button)));
  }
  if (['open', 'blocked', 'ready_to_merge'].includes(task.lifecycle)) {
    actions.append(integrationAction('Discard & clean up', 'danger-button compact-action', async button => {
      if (!confirm(`Discard "${task.taskTitle}"?\n\nThis permanently deletes all unmerged changes in its managed worktree, stops task-owned processes, deletes the ${task.branch || 'managed task'} branch, and archives the task.\n\nThe project target branch is not changed and nothing is pushed.`)) return;
      await mutateIntegration(task, 'discard', button);
    }));
  }
  card.append(actions);
  return card;
}

async function stopTaskProcesses(task, button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Stopping…';
  try {
    const result = await api(`/api/workbench/tasks/${encodeURIComponent(task.taskId)}/processes/stop-all`, {
      method: 'POST',
      body: { force: true },
    });
    await loadIntegrationQueue();
    window.dispatchEvent(new CustomEvent('workbench:refresh-request', { detail: { scopes: ['tasks', 'workspace'], taskId: task.taskId } }));
    setStatus(result.remaining?.length
      ? `${task.taskTitle} still has ${result.remaining.length} running process(es)`
      : `${task.taskTitle} processes stopped`);
  } finally {
    button.textContent = original;
    button.disabled = false;
  }
}

function openDependencyEditor(task) {
  editingDependencyTaskId = task.taskId;
  $('integration-dependency-title').textContent = task.taskTitle;
  $('integration-dependency-error').hidden = true;
  $('integration-dependency-error').textContent = '';
  const selected = new Set((task.dependencies || []).map(dependency => dependency.taskId));
  const candidateMap = new Map((state.integrationQueue?.tasks || [])
    .filter(candidate => candidate.taskId !== task.taskId)
    .map(candidate => [candidate.taskId, candidate]));
  (task.dependencies || []).forEach(dependency => {
    if (!candidateMap.has(dependency.taskId)) {
      candidateMap.set(dependency.taskId, {
        taskId: dependency.taskId,
        taskTitle: dependency.taskTitle,
        lifecycle: dependency.lifecycle,
        branch: dependency.satisfied ? 'integrated dependency' : 'unavailable dependency',
      });
    }
  });
  const candidates = [...candidateMap.values()];
  const rows = candidates.map(candidate => {
    const label = el('label', undefined, 'integration-dependency-option');
    const input = el('input');
    input.type = 'checkbox';
    input.dataset.integrationDependency = candidate.taskId;
    input.checked = selected.has(candidate.taskId);
    input.disabled = !task.canEditDependencies;
    const copy = el('span', undefined, 'integration-dependency-option-copy');
    const lifecycle = lifecycleInfo(candidate.lifecycle);
    copy.append(
      el('strong', candidate.taskTitle),
      el('small', `${candidate.queuePosition ? `Queue #${candidate.queuePosition} · ` : ''}${lifecycle.label} · ${candidate.branch || 'task branch'}`),
    );
    label.append(input, copy);
    return label;
  });
  $('integration-dependency-list').replaceChildren(...rows);
  if (!rows.length) $('integration-dependency-list').append(el('p', 'No other managed parallel tasks are available.', 'empty-copy'));
  $('integration-dependency-save').disabled = !task.canEditDependencies;
  $('integration-dependency-dialog').showModal();
}

export async function saveIntegrationDependencies() {
  if (!editingDependencyTaskId) return;
  const button = $('integration-dependency-save');
  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Saving…';
  $('integration-dependency-error').hidden = true;
  try {
    const taskIds = [...$('integration-dependency-list').querySelectorAll('[data-integration-dependency]:checked')]
      .map(input => input.dataset.integrationDependency)
      .filter(Boolean);
    await api(`/api/workbench/tasks/${encodeURIComponent(editingDependencyTaskId)}/integration/dependencies`, {
      method: 'PUT',
      body: { taskIds },
    });
    const taskId = editingDependencyTaskId;
    editingDependencyTaskId = null;
    $('integration-dependency-dialog').close();
    await loadIntegrationQueue();
    window.dispatchEvent(new CustomEvent('workbench:refresh-request', { detail: { scopes: ['tasks'], taskId } }));
    setStatus('Integration dependencies updated');
  } catch (error) {
    $('integration-dependency-error').textContent = error.message;
    $('integration-dependency-error').hidden = false;
    throw error;
  } finally {
    button.textContent = original;
    button.disabled = false;
  }
}

function renderIntegrationQueue(data) {
  state.integrationQueue = data;
  const summary = data?.summary || { total: 0, open: 0, ready: 0, blocked: 0, merged: 0, attention: 0 };
  $('integration-count').textContent = String(summary.attention || 0);
  $('integration-button').classList.toggle('attention', Boolean(summary.attention));
  $('integration-summary-open').textContent = String(summary.open || 0);
  $('integration-summary-ready').textContent = String(summary.ready || 0);
  $('integration-summary-blocked').textContent = String(summary.blocked || 0);
  $('integration-summary-merged').textContent = String(summary.merged || 0);
  const rows = (data?.tasks || []).map(integrationCard);
  $('integration-list').replaceChildren(...rows);
  if (!rows.length) $('integration-list').append(el('p', 'No managed parallel tasks in this workspace.', 'empty-copy'));
}

async function mutateIntegration(task, action, button) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = action === 'merge' ? 'Merging…'
    : action === 'finish' ? 'Finishing…'
      : action === 'discard' ? 'Discarding…'
        : action === 'reopen' ? 'Resuming…'
          : action === 'cleanup' ? 'Cleaning…'
            : 'Checking…';
  try {
    const result = await api(`/api/workbench/tasks/${encodeURIComponent(task.taskId)}/integration/${action}`, { method: 'POST', body: {} });
    await loadIntegrationQueue();
    window.dispatchEvent(new CustomEvent('workbench:refresh-request', { detail: { scopes: ['tasks', 'workspace'], taskId: task.taskId } }));
    if (action === 'finish') setStatus(result.status === 'finished'
      ? `${task.taskTitle} integrated, cleaned up, and finished · not pushed`
      : `${task.taskTitle}: ${result.message || 'finish needs attention'}`);
    else if (action === 'discard') setStatus(result.status === 'discarded'
      ? `${task.taskTitle} discarded · task worktree and branch removed`
      : `${task.taskTitle}: ${result.message || 'discard needs attention'}`);
    else if (action === 'cleanup') setStatus(result.cleanupStatus === 'completed' ? `${task.taskTitle} cleanup completed` : `${task.taskTitle} cleanup still needs attention`);
    else if (result.lifecycle === 'merged') setStatus(result.cleanupStatus === 'completed'
      ? `${task.taskTitle} merged locally · managed worktree cleaned up · not pushed`
      : `${task.taskTitle} merged locally · cleanup needs attention · not pushed`);
    else if (result.lifecycle === 'blocked') setStatus(`${task.taskTitle} is blocked by integration conflicts`);
    else if (result.lifecycle === 'ready_to_merge') setStatus(`${task.taskTitle} is ready to merge`);
    else setStatus(`${task.taskTitle} resumed for agent work`);
  } finally {
    button.textContent = original;
    button.disabled = false;
  }
}

export async function loadIntegrationQueue() {
  if (!state.workspaceId) {
    renderIntegrationQueue({ tasks: [], summary: { total: 0, open: 0, ready: 0, blocked: 0, merged: 0, attention: 0 } });
    return state.integrationQueue;
  }
  const data = await api(`/api/workbench/integration?workspaceId=${encodeURIComponent(state.workspaceId)}`);
  renderIntegrationQueue(data);
  return data;
}

export async function openIntegrationQueue() {
  await loadIntegrationQueue();
  $('integration-dialog').showModal();
}

export async function refreshIntegrationQueueIfOpen() {
  if (!$('integration-dialog')?.open) return;
  await loadIntegrationQueue();
}