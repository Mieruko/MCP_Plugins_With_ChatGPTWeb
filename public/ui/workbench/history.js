import { api } from './api.js';
import { currentWorkspace, currentWorkspaceOperations, isBasic, state } from './state.js';
import { $, el, setStatus, taskRelative } from './dom.js';
import { openChangeSetReview, restoreChangeSet, openOperationFileDiff, openOperationReview } from './changes.js';
import { agentLabel } from './agent-identity.js';

function taskForOperation(operation) {
  return (state.data?.tasks || []).find(task => task.id === operation?.taskId) || null;
}

function relativeForOperation(value, operation) {
  const task = taskForOperation(operation);
  if (!task || !value) return String(value || '');
  const root = String(task.execution?.path || task.workspace || '').replace(/\\/g, '/').replace(/\/$/, '');
  const normalized = String(value).replace(/\\/g, '/');
  return root && normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)
    ? normalized.slice(root.length + 1)
    : normalized;
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function operationStatusClass(status) {
  return ['completed', 'pending', 'failed', 'denied', 'expired', 'running'].includes(status) ? status : 'unknown';
}

function operationLabel(operation) {
  const files = operation.changes?.length || operation.review?.files?.length || 0;
  if (['write_file', 'write_file_base64'].includes(operation.tool)) return files === 1 ? 'Created or updated a file' : `Updated ${files} files`;
  if (['edit_file', 'multi_edit', 'replace_regex', 'apply_patch'].includes(operation.tool)) return files === 1 ? 'Changed a file' : `Changed ${files} files`;
  if (['delete_file', 'delete_directory'].includes(operation.tool)) return files === 1 ? 'Removed a file' : `Removed ${files} files`;
  if (operation.tool === 'run_command') return 'Ran a command';
  if (operation.tool === 'start_process') return 'Started a background process';
  if (operation.tool === 'git_commit') return 'Created a Git commit';
  if (operation.tool === 'git_push') return 'Pushed commits';
  if (operation.tool === 'git_pull') return 'Pulled remote changes';
  if (operation.tool === 'git_branch' || operation.tool === 'git_checkout') return 'Changed Git branch';
  if (operation.tool === 'git_add') return 'Staged changes';
  if (operation.tool === 'git_restore') return 'Restored Git changes';
  if (operation.tool === 'git_init') return 'Initialized Git';
  if (operation.tool === 'github') return 'Updated GitHub';
  return operation.tool.replaceAll('_', ' ');
}

function operationOwner(operation) {
  return operation.sessionId ? agentLabel(operation.sessionId) : 'Local / external';
}

function renderCheckpoints() {
  $('checkpoint-count').textContent = state.checkpoints.length;
  const cards = state.checkpoints.map(checkpoint => {
    const card = el('div', undefined, 'history-card');
    const copy = el('button', undefined, 'history-main');
    copy.type = 'button';
    copy.append(el('strong', checkpoint.title), el('span', formatTime(checkpoint.createdAt)));
    copy.onclick = () => void openCheckpointPreview(checkpoint.id).catch(error => setStatus(error.message));
    const actions = el('div', undefined, 'history-actions');
    const preview = el('button', 'Preview', 'mini-action');
    preview.type = 'button';
    preview.onclick = () => void openCheckpointPreview(checkpoint.id).catch(error => setStatus(error.message));
    actions.append(preview);
    card.append(copy, actions);
    return card;
  });
  $('checkpoint-list').replaceChildren(...cards);
  if (!cards.length) $('checkpoint-list').append(el('p', 'Chưa có checkpoint.', 'empty-copy'));
}

function renderOperations() {
  const operations = currentWorkspaceOperations()
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, 60);
  $('history-count').textContent = operations.length;
  const workspace = currentWorkspace();
  $('activity-scope-label').textContent = workspace ? `Only activity from ${workspace.name}` : 'Only activity from this workspace';
  const cards = operations.map(operation => {
    const card = el('div', undefined, 'history-card operation-card');
    const body = el('div', undefined, 'history-card-body');
    const copy = el('button', undefined, 'history-main');
    copy.type = 'button';
    const task = taskForOperation(operation);
    const title = el('strong', `${operationOwner(operation)} · ${operationLabel(operation)}`);
    const status = el('span', operation.status, `operation-status ${operationStatusClass(operation.status)}`);
    const fileCount = operation.changes?.length || 0;
    const additions = operation.review?.additions || 0;
    const deletions = operation.review?.deletions || 0;
    const diffSummary = operation.review ? ` · +${additions} −${deletions}` : '';
    const fileSummary = fileCount ? ` · ${fileCount} file${fileCount === 1 ? '' : 's'}` : '';
    const line = el('span', `${task?.title || 'Workspace task'} · ${formatTime(operation.createdAt)}${fileSummary}${diffSummary}`);
    const tool = el('span', operation.tool, 'activity-tool-name');
    copy.append(title, line, tool, status);
    if (operation.review?.files?.length) copy.onclick = () => void openOperationReview(operation.id).catch(error => setStatus(error.message));
    else copy.disabled = true;

    const changes = operation.changes || [];
    const canRestore = ['completed', 'failed'].includes(operation.status) && changes.length > 0;
    body.append(copy);

    if (changes.length) {
      const files = el('div', undefined, 'history-file-list');
      for (const change of changes.slice(0, 8)) {
        const fileRow = el('div', undefined, 'history-file-row');
        const fileCopy = el('button', undefined, 'history-file-copy history-file-diff-link');
        fileCopy.type = 'button';
        fileCopy.append(
          el('code', relativeForOperation(change.path, operation)),
          el('span', `${change.before} → ${change.after}${change.undone ? ' · undone' : ''}`),
        );
        const reviewFile = operation.review?.files?.find(file => relativeForOperation(file.path, operation) === relativeForOperation(change.path, operation));
        if (reviewFile) {
          fileCopy.title = 'Open code diff';
          fileCopy.onclick = () => void openOperationFileDiff(operation.id, change.path).catch(error => setStatus(error.message));
        } else {
          fileCopy.disabled = true;
        }
        fileRow.append(fileCopy);
        if (canRestore) {
          const action = el('button', change.undone ? 'Redo file' : 'Undo file', 'mini-action');
          action.type = 'button';
          action.onclick = () => void restoreOperation(operation.id, Boolean(change.undone), change.path).catch(error => setStatus(error.message));
          fileRow.append(action);
        }
        files.append(fileRow);
      }
      if (changes.length > 8) files.append(el('span', `+${changes.length - 8} more files`, 'history-more-files'));
      body.append(files);
    }

    const actions = el('div', undefined, 'history-actions');
    if (operation.review?.files?.length) {
      const diff = el('button', 'View diff', 'mini-action');
      diff.type = 'button';
      diff.onclick = () => void openOperationReview(operation.id).catch(error => setStatus(error.message));
      actions.append(diff);
    }
    if (canRestore && changes.some(change => !change.undone)) {
      const undo = el('button', 'Undo', 'mini-action');
      undo.type = 'button';
      undo.onclick = () => void restoreOperation(operation.id, false).catch(error => setStatus(error.message));
      actions.append(undo);
    }
    if (canRestore && changes.some(change => change.undone)) {
      const redo = el('button', 'Redo', 'mini-action');
      redo.type = 'button';
      redo.onclick = () => void restoreOperation(operation.id, true).catch(error => setStatus(error.message));
      actions.append(redo);
    }
    card.append(body, actions);
    return card;
  });
  $('operation-history').replaceChildren(...cards);
  if (!cards.length) $('operation-history').append(el('p', 'No activity yet.', 'empty-copy'));
}

function renderBasicHistory(changeSets) {
  const groupedIds = new Set(changeSets.flatMap(item => item.operationIds));
  const activity = [
    ...changeSets.map(item => ({ ...item, grouped: true })),
    ...currentWorkspaceOperations().filter(item => !groupedIds.has(item.id)),
  ].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 60);
  $('history-count').textContent = activity.length;
  $('activity-scope-label').textContent = 'Recent work on this project';
  const cards = activity.map(item => {
    const card = el('div', undefined, 'history-card');
    const copy = el('button', undefined, 'history-main');
    copy.type = 'button';
    const count = item.review?.files?.length || 0;
    copy.append(el('strong', item.grouped ? `Edited ${count} file${count === 1 ? '' : 's'}` : operationLabel(item)),
      el('span', `${formatTime(item.createdAt)}${item.review ? ` · +${item.review.additions} −${item.review.deletions}` : ''}`),
      el('span', item.canRedo ? 'Undone' : item.status));
    if (item.grouped) copy.onclick = () => void openChangeSetReview(item.id).catch(error => setStatus(error.message));
    else if (item.status === 'pending' || count) copy.onclick = () => void openOperationReview(item.id).catch(error => setStatus(error.message));
    else copy.disabled = true;
    const actions = el('div', undefined, 'history-actions');
    if (item.canUndo || item.canRedo) {
      const redo = !item.canUndo && item.canRedo;
      const button = el('button', redo ? 'Redo' : 'Undo', 'mini-action');
      button.type = 'button';
      button.onclick = () => void restoreChangeSet(item.id, redo).catch(error => setStatus(error.message));
      actions.append(button);
    }
    card.append(copy, actions);
    return card;
  });
  $('operation-history').replaceChildren(...cards);
  if (!cards.length) $('operation-history').append(el('p', 'Your ChatGPT edits will appear here.', 'empty-copy'));
}

export async function loadHistory() {
  if (!state.taskId) return;
  const workspaceId = state.workspaceId, taskId = state.taskId;
  const basic = isBasic();
  const [checkpoints, changeSets] = await Promise.all([
    api(`/api/workbench/tasks/${taskId}/checkpoints`),
    basic ? api(`/api/workbench/workspaces/${workspaceId}/change-sets`) : Promise.resolve([]),
  ]);
  if (workspaceId !== state.workspaceId || taskId !== state.taskId || basic !== isBasic()) return;
  state.checkpoints = checkpoints;
  renderCheckpoints();
  if (basic) renderBasicHistory(changeSets);
  else renderOperations();
}

export async function createCheckpoint() {
  if (!state.taskId) return;
  const title = prompt('Checkpoint name', `Checkpoint ${new Date().toLocaleTimeString()}`);
  if (title === null) return;
  if (!title.trim()) throw new Error('Checkpoint name is required');
  setStatus('Creating checkpoint…');
  await api(`/api/workbench/tasks/${state.taskId}/checkpoints`, { method: 'POST', body: { title: title.trim() } });
  await loadHistory();
  setStatus('Checkpoint created');
}

export async function openCheckpointPreview(id) {
  setStatus('Building checkpoint preview…');
  const plan = await api(`/api/workbench/checkpoints/${id}/preview`);
  state.currentCheckpointId = id;
  $('checkpoint-title').textContent = plan.checkpoint?.title || 'Checkpoint';
  const fileCount = plan.files?.length || 0;
  $('checkpoint-note').textContent = `${plan.operationCount || 0} tracked operation${plan.operationCount === 1 ? '' : 's'} · ${fileCount} file${fileCount === 1 ? '' : 's'} would change`;
  $('checkpoint-error').hidden = true;
  const files = (plan.files || []).map(file => {
    const row = el('div', undefined, 'checkpoint-file');
    row.append(el('code', taskRelative(file.path)), el('span', `${file.current} → ${file.target}`));
    return row;
  });
  $('checkpoint-files').replaceChildren(...files);
  if (!files.length) $('checkpoint-files').append(el('p', 'Không có file journal nào cần restore.', 'empty-copy'));
  const effects = plan.externalEffects || [];
  $('checkpoint-effects').replaceChildren();
  if (effects.length) {
    $('checkpoint-effects').append(el('strong', 'External effects are not undoable'));
    for (const effect of effects) $('checkpoint-effects').append(el('span', `${effect.tool} · ${effect.status}`));
  }
  $('restore-checkpoint').disabled = !files.length;
  $('checkpoint-dialog').showModal();
  setStatus('Checkpoint preview ready');
}

export async function restoreCurrentCheckpoint() {
  if (!state.currentCheckpointId) return;
  const id = state.currentCheckpointId;
  if (!confirm('Restore this checkpoint? Tracked file changes after the checkpoint will be reverted when conflict checks pass. External effects are not undone.')) return;
  setStatus('Restoring checkpoint…');
  try {
    await api(`/api/workbench/checkpoints/${id}/restore`, { method: 'POST', body: {} });
    state.currentCheckpointId = null;
    $('checkpoint-dialog').close();
    window.dispatchEvent(new CustomEvent('workbench:refresh-request', { detail: { scopes: ['operations', 'checkpoints', 'workspace'], taskId: state.taskId } }));
    setStatus('Checkpoint restored');
  } catch (error) {
    $('checkpoint-error').textContent = error.message;
    $('checkpoint-error').hidden = false;
    throw error;
  }
}

export async function restoreOperation(id, redo, file) {
  const operation = (state.data?.operations || []).find(item => item.id === id);
  const target = file ? relativeForOperation(file, operation) : 'this operation';
  if (!confirm(`${redo ? 'Redo' : 'Undo'} ${target}? The Workbench will refuse if the recorded file state no longer matches.`)) return;
  setStatus(`${redo ? 'Redoing' : 'Undoing'} operation…`);
  await api(`/api/workbench/operations/${id}/undo`, { method: 'POST', body: { redo, ...(file ? { file } : {}) } });
  window.dispatchEvent(new CustomEvent('workbench:refresh-request', { detail: { scopes: ['operations', 'workspace'], taskId: operation?.taskId || state.taskId } }));
  setStatus(redo ? 'Operation redone' : 'Operation undone');
}
