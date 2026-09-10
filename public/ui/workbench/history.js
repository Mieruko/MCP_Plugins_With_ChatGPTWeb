import { api } from './api.js';
import { state } from './state.js';
import { $, el, setStatus, taskRelative } from './dom.js';
import { openOperationFileDiff, openOperationReview } from './changes.js';

function taskOperations() {
  return (state.data?.operations || []).filter(operation => operation.taskId === state.taskId);
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function operationStatusClass(status) {
  return ['completed', 'pending', 'failed', 'denied', 'expired', 'running'].includes(status) ? status : 'unknown';
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
  const operations = taskOperations().slice(0, 40);
  $('history-count').textContent = operations.length;
  const cards = operations.map(operation => {
    const card = el('div', undefined, 'history-card operation-card');
    const body = el('div', undefined, 'history-card-body');
    const copy = el('button', undefined, 'history-main');
    copy.type = 'button';
    const title = el('strong', operation.tool);
    const status = el('span', operation.status, `operation-status ${operationStatusClass(operation.status)}`);
    const fileCount = operation.changes?.length || 0;
    const line = el('span', `${formatTime(operation.createdAt)} · ${fileCount} file${fileCount === 1 ? '' : 's'}`);
    copy.append(title, line, status);
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
          el('code', taskRelative(change.path)),
          el('span', `${change.before} → ${change.after}${change.undone ? ' · undone' : ''}`),
        );
        const reviewFile = operation.review?.files?.find(file => taskRelative(file.path) === taskRelative(change.path));
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
  if (!cards.length) $('operation-history').append(el('p', 'Chưa có operation.', 'empty-copy'));
}

export async function loadHistory() {
  if (!state.taskId) return;
  state.checkpoints = await api(`/api/workbench/tasks/${state.taskId}/checkpoints`);
  renderCheckpoints();
  renderOperations();
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
  const target = file ? taskRelative(file) : 'this operation';
  if (!confirm(`${redo ? 'Redo' : 'Undo'} ${target}? The Workbench will refuse if the recorded file state no longer matches.`)) return;
  setStatus(`${redo ? 'Redoing' : 'Undoing'} operation…`);
  await api(`/api/workbench/operations/${id}/undo`, { method: 'POST', body: { redo, ...(file ? { file } : {}) } });
  window.dispatchEvent(new CustomEvent('workbench:refresh-request', { detail: { scopes: ['operations', 'workspace'], taskId: state.taskId } }));
  setStatus(redo ? 'Operation redone' : 'Operation undone');
}