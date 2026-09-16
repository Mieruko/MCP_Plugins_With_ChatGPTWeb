import { api } from './api.js';
import { currentWorkspace, currentWorkspaceOperations, isBasic, state } from './state.js';
import { $, el, renderUnifiedDiff, setStatus } from './dom.js';
import { invalidateRestoredEditorTabs, openFile, openGitDiff, openTextDiff } from './editor.js';
import { agentLabel } from './agent-identity.js';
import { languageForPath } from './monaco.js';

let changesLoadGeneration = 0;

function taskForOperation(operation) {
  return (state.data?.tasks || []).find(task => task.id === operation?.taskId) || null;
}

function pendingOperations() {
  return currentWorkspaceOperations().filter(operation => operation.status === 'pending');
}

function actionLabel(operation) {
  const labels = { write_file: 'Edit file', edit_file: 'Edit file', apply_patch: 'Edit files', multi_edit: 'Edit file',
    run_command: 'Run command', start_process: 'Start process', git_commit: 'Commit changes', git_push: 'Push commits' };
  return labels[operation.tool] || operation.tool.replaceAll('_', ' ');
}

function approvalLabel(operation) {
  return isBasic() ? `ChatGPT wants to ${actionLabel(operation).toLowerCase()}` : operation.tool;
}

function permissionSummary(operation) {
  const permission = operation?.permission;
  if (!permission) return '';
  const risk = permission.riskLevel || permission.risk || 'unknown';
  const effects = Array.isArray(permission.effects) && permission.effects.length ? permission.effects.join(', ') : 'workspace';
  return `${risk} risk · ${effects}`;
}

function setReviewDecisionState(kind = '', message = '', action = 'approve') {
  const status = $('review-decision-status');
  const approve = $('approve-operation');
  const deny = $('deny-operation');
  const busy = kind === 'busy';
  if (status) {
    status.hidden = !message;
    status.textContent = message;
    status.className = `review-decision-status${kind ? ` ${kind}` : ''}`;
  }
  if (approve) {
    approve.disabled = busy;
    approve.textContent = busy ? (action === 'deny' ? 'Please wait…' : 'Approving…') : (isBasic() ? 'Allow once' : 'Approve once');
  }
  if (deny) {
    deny.disabled = busy;
    deny.textContent = busy && action === 'deny' ? 'Denying…' : 'Deny';
  }
}

function updateLocalOperationStatus(id, status) {
  const operation = (state.data?.operations || []).find(item => item.id === id);
  if (operation && status) operation.status = status;
  renderApprovals();
}

function connectionExpiryLabel(expiresAt) {
  const remaining = Math.max(0, Number(expiresAt || 0) - Date.now());
  if (!remaining) return 'expires now';
  const minutes = Math.max(1, Math.ceil(remaining / 60_000));
  return `expires in ${minutes} min`;
}

function mergeChanges(git) {
  const map = new Map();
  const add = (entry, kind) => {
    const path = String(entry.path || '').replace(/\\/g, '/');
    if (!path) return;
    const current = map.get(path) || { path, staged: false, unstaged: false, untracked: false, statuses: [] };
    current[kind] = true;
    current.statuses.push(entry.status || (kind === 'untracked' ? '?' : 'M'));
    if (entry.original_path) current.originalPath = entry.original_path;
    map.set(path, current);
  };
  for (const item of git.staged || []) add(item, 'staged');
  for (const item of git.unstaged || []) add(item, 'unstaged');
  for (const item of git.untracked || []) add(item, 'untracked');
  return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function relativeForTask(value, task) {
  if (!task || !value) return normalizePath(value);
  const root = normalizePath(task.execution?.path || task.workspace).replace(/\/$/, '');
  const normalized = normalizePath(value);
  return root && normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)
    ? normalized.slice(root.length + 1)
    : normalized;
}

function comparableOperationPath(value, operation) {
  return relativeForTask(value, taskForOperation(operation)).toLowerCase();
}

function snapshotText(snapshot) {
  if (!snapshot || snapshot.kind === 'missing') return '';
  if (snapshot.kind !== 'file' || typeof snapshot.content !== 'string') return null;
  try {
    const binary = atob(snapshot.content);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function buildBrowserUnifiedDiff(beforeText, afterText) {
  const oldLines = String(beforeText).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const newLines = String(afterText).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (beforeText === afterText) return '(no visible diff)';

  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) suffix += 1;

  const oldMiddle = oldLines.slice(prefix, oldLines.length - suffix);
  const newMiddle = newLines.slice(prefix, newLines.length - suffix);
  const middle = [];
  const cells = (oldMiddle.length + 1) * (newMiddle.length + 1);

  if (cells <= 1_500_000) {
    const width = newMiddle.length + 1;
    const table = new Uint32Array(cells);
    for (let i = oldMiddle.length - 1; i >= 0; i--) {
      for (let j = newMiddle.length - 1; j >= 0; j--) {
        const index = i * width + j;
        table[index] = oldMiddle[i] === newMiddle[j]
          ? table[(i + 1) * width + j + 1] + 1
          : Math.max(table[(i + 1) * width + j], table[index + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < oldMiddle.length || j < newMiddle.length) {
      if (i < oldMiddle.length && j < newMiddle.length && oldMiddle[i] === newMiddle[j]) {
        middle.push({ type: 'context', text: oldMiddle[i] });
        i += 1; j += 1;
      } else if (j < newMiddle.length && (i >= oldMiddle.length || table[i * width + j + 1] >= table[(i + 1) * width + j])) {
        middle.push({ type: 'add', text: newMiddle[j++] });
      } else if (i < oldMiddle.length) {
        middle.push({ type: 'remove', text: oldMiddle[i++] });
      }
    }
  } else {
    for (const text of oldMiddle) middle.push({ type: 'remove', text });
    for (const text of newMiddle) middle.push({ type: 'add', text });
  }

  const raw = [
    ...oldLines.slice(0, prefix).map(text => ({ type: 'context', text })),
    ...middle,
    ...oldLines.slice(oldLines.length - suffix).map(text => ({ type: 'context', text })),
  ];
  let oldLine = 1;
  let newLine = 1;
  const ops = raw.map(op => {
    const value = { ...op, oldBefore: oldLine, newBefore: newLine };
    if (op.type !== 'add') oldLine += 1;
    if (op.type !== 'remove') newLine += 1;
    return value;
  });
  const changed = ops.map((op, index) => op.type === 'context' ? -1 : index).filter(index => index >= 0);
  if (!changed.length) return '(no visible diff)';

  const ranges = [];
  for (const index of changed) {
    const start = Math.max(0, index - 3);
    const end = Math.min(ops.length - 1, index + 3);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end + 1) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }
  const output = [];
  for (const range of ranges) {
    const hunk = ops.slice(range.start, range.end + 1);
    const oldCount = hunk.filter(op => op.type !== 'add').length;
    const newCount = hunk.filter(op => op.type !== 'remove').length;
    output.push(`@@ -${hunk[0].oldBefore},${oldCount} +${hunk[0].newBefore},${newCount} @@`);
    for (const op of hunk) output.push(`${op.type === 'add' ? '+' : op.type === 'remove' ? '-' : ' '}${op.text}`);
  }
  return output.join('\n');
}

function operationFileDiff(operation, file) {
  const stored = String(file?.diff || '');
  if (/^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/m.test(stored)) return stored;
  const wanted = comparableOperationPath(file?.path, operation);
  const change = (operation.changes || []).find(item => comparableOperationPath(item.path, operation) === wanted);
  if (!change) return stored;
  const before = snapshotText(change.before);
  const after = snapshotText(change.after);
  if (before === null || after === null) return stored;
  return buildBrowserUnifiedDiff(before, after);
}

function operationFileSnapshots(operation, file) {
  const wanted = comparableOperationPath(file?.path, operation);
  const change = (operation.changes || []).find(item => comparableOperationPath(item.path, operation) === wanted);
  if (!change) return null;
  const before = snapshotText(change.before);
  const after = snapshotText(change.after);
  if (before === null || after === null) return null;
  return { before, after };
}

async function colorizeReviewDiff(host, operation, file) {
  const pair = operationFileSnapshots(operation, file);
  const language = languageForPath(file.path);
  const oldLines = pair ? pair.before.replace(/\r\n?/g, '\n').split('\n') : null;
  const newLines = pair ? pair.after.replace(/\r\n?/g, '\n').split('\n') : null;

  const keywords = new Set([
    'abstract','and','as','async','await','break','case','catch','class','const','continue','default','def','delete','do','else','elseif','enum','export','extends','false','final','finally','for','foreach','from','function','if','implements','import','in','instanceof','interface','let','match','namespace','new','null','or','private','protected','public','readonly','return','static','super','switch','this','throw','trait','true','try','typeof','use','var','void','while','with','yield',
  ]);
  const typeWords = new Set([
    'array','bool','boolean','byte','char','decimal','double','float','int','integer','long','mixed','never','object','short','string','void',
  ]);

  const appendToken = (fragment, text, kind = 'text') => {
    const span = document.createElement('span');
    span.className = `codex-token codex-token-${kind}`;
    span.textContent = text || ' ';
    fragment.append(span);
  };

  const renderSource = (code, source) => {
    const fragment = document.createDocumentFragment();
    const input = String(source || ' ');
    let cursor = 0;
    const tokenPattern = /(\/\/.*$|#.*$|\/\*[\s\S]*?\*\/|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|\$[A-Za-z_][A-Za-z0-9_]*|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][A-Za-z0-9_]*\b|\s+|.)/gm;
    for (const match of input.matchAll(tokenPattern)) {
      const value = match[0];
      const start = match.index ?? cursor;
      if (start > cursor) appendToken(fragment, input.slice(cursor, start));
      cursor = start + value.length;
      const trimmed = value.trim();
      let kind = 'text';
      if (/^(?:\/\/|#|\/\*)/.test(value)) kind = 'comment';
      else if (/^(?:'|"|`)/.test(value)) kind = 'string';
      else if (/^\$[A-Za-z_]/.test(value)) kind = 'variable';
      else if (/^\d/.test(trimmed)) kind = 'number';
      else if (keywords.has(trimmed)) kind = 'keyword';
      else if (typeWords.has(trimmed)) kind = 'variable';
      else if (/^[A-Z][A-Za-z0-9_]*$/.test(trimmed)) kind = 'type';
      else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
        const next = input.slice(cursor).trimStart()[0];
        const previous = input.slice(0, start).trimEnd();
        if (next === '(') kind = 'function';
        else if (/\b(?:new|extends|implements|instanceof|use|import|from)\s*$/.test(previous)) kind = 'type';
        else kind = 'variable';
      } else if (/^\s+$/.test(value)) kind = 'text';
      else kind = 'punctuation';
      appendToken(fragment, value, kind);
    }
    if (cursor < input.length) appendToken(fragment, input.slice(cursor));
    code.replaceChildren(fragment);
  };

  for (const row of host.querySelectorAll('.diff-line')) {
    const type = row.dataset.diffType;
    if (type === 'header') continue;
    const code = row.querySelector('.line-code');
    if (!code) continue;
    const oldLine = Number(row.dataset.oldLine || 0);
    const newLine = Number(row.dataset.newLine || 0);
    let source = code.textContent || ' ';
    if (type === 'remove' && oldLines && oldLine > 0 && oldLine <= oldLines.length) source = oldLines[oldLine - 1];
    else if (type !== 'remove' && newLines && newLine > 0 && newLine <= newLines.length) source = newLines[newLine - 1];
    renderSource(code, source);
  }
  host.classList.add('codex-review-diff');
  host.dataset.syntax = language;
  return true;
}

function operationTouchForPath(path) {
  const wanted = normalizePath(path).toLowerCase();
  const selectedExecutionPath = normalizePath(currentExecution().path).replace(/\/$/, '').toLowerCase();
  for (const operation of currentWorkspaceOperations()) {
    if (!operation.sessionId) continue;
    const operationTask = taskForOperation(operation);
    const operationExecutionPath = normalizePath(operationTask?.execution?.path || operationTask?.workspace).replace(/\/$/, '').toLowerCase();
    if (selectedExecutionPath && operationExecutionPath && selectedExecutionPath !== operationExecutionPath) continue;
    const matched = (operation.changes || []).find(change => !change.undone && relativeForTask(change.path, operationTask).toLowerCase() === wanted);
    if (matched) return {
      sessionId: operation.sessionId,
      label: agentLabel(operation.sessionId),
      operationId: operation.id,
      tool: operation.tool,
      status: operation.status,
    };
  }
  return null;
}

function renderWorkspaceReview() {
  const review = state.workspaceReview;
  const scope = $('workspace-review-scope');
  const list = $('workspace-review-list');
  const more = $('workspace-review-more');
  const undo = $('workspace-review-undo');
  const open = $('workspace-review-open');
  const existingError = document.getElementById('workspace-review-error');
  const files = review?.review?.files || [];
  if (!review || !files.length) {
    scope.hidden = true;
    list.replaceChildren();
    existingError?.remove();
    return null;
  }

  scope.hidden = false;
  const count = files.length;
  const task = taskForOperation(review);
  const owner = review.sessionId ? agentLabel(review.sessionId) : 'Local / external';
  const operationCount = review.operationCount || 1;
  $('workspace-review-title').textContent = `Edited ${count} file${count === 1 ? '' : 's'} · ${operationCount} operation${operationCount === 1 ? '' : 's'} · ${owner}`;
  $('workspace-review-additions').textContent = `+${review.review?.additions || 0}`;
  $('workspace-review-deletions').textContent = `−${review.review?.deletions || 0}`;
  scope.title = isBasic() ? 'Recent ChatGPT work' : `${task?.title || 'Workspace task'} · ${owner} · ${review.operationCount || 1} operation${review.operationCount === 1 ? '' : 's'}`;

  list.classList.toggle('expanded', true);
  const visible = files;
  const rows = visible.map(file => {
    const row = el('button', undefined, 'workspace-review-file');
    row.type = 'button';
    row.title = 'Open file diff';
    row.append(
      el('span', relativeForTask(file.path, task), 'workspace-review-file-path'),
      el('span', `+${file.additions || 0}`, 'workspace-review-file-additions'),
      el('span', `−${file.deletions || 0}`, 'workspace-review-file-deletions'),
    );
    row.onclick = () => void openChangeSetFileDiff(review.id, file.path).catch(error => setStatus(error.message));
    return row;
  });
  list.replaceChildren(...rows);

  more.hidden = true;

  const redo = Boolean(review.canRedo && !review.canUndo);
  undo.hidden = !review.canUndo && !review.canRedo;
  undo.textContent = redo ? 'Redo ↷' : 'Undo ↶';
  undo.onclick = () => void restoreChangeSet(review.id, redo);
  open.onclick = () => void openChangeSetReview(review.id).catch(error => setStatus(error.message));
  return review;
}

function showWorkspaceReviewError(error) {
  const scope = $('workspace-review-scope');
  let target = document.getElementById('workspace-review-error');
  if (!target) {
    target = el('div', undefined, 'workspace-review-error');
    target.id = 'workspace-review-error';
    scope.insertBefore(target, $('workspace-review-list'));
  }
  target.textContent = error?.message || String(error);
  target.hidden = false;
  setStatus(target.textContent);
}

function clearWorkspaceReviewError() {
  const target = document.getElementById('workspace-review-error');
  if (target) target.hidden = true;
}

async function loadWorkspaceReview(expectedWorkspaceId = state.workspaceId, generation = changesLoadGeneration) {
  const workspace = currentWorkspace();
  if (!workspace || workspace.id !== expectedWorkspaceId) {
    state.workspaceReview = null;
    state.workspaceReviewId = null;
    state.workspaceReviewExpanded = false;
    renderWorkspaceReview();
    return null;
  }
  const payload = await api(`/api/workbench/workspaces/${encodeURIComponent(workspace.id)}/review-runs/latest`);
  if (generation !== changesLoadGeneration || state.workspaceId !== expectedWorkspaceId) return null;
  const review = payload?.reviewRun || null;
  if ((review?.id || null) !== state.workspaceReviewId) state.workspaceReviewExpanded = false;
  state.workspaceReviewId = review?.id || null;
  state.workspaceReview = review;
  renderWorkspaceReview();
  return review;
}

function enrichChanges(entries) {
  return entries.map(change => ({ ...change, agentTouch: operationTouchForPath(change.path) }));
}

function kindLabel(change) {
  const kinds = [];
  if (change.staged) kinds.push('staged');
  if (change.unstaged) kinds.push('working');
  if (change.untracked) kinds.push('new');
  return kinds.join(' + ');
}

function statusCode(change) {
  if (change.untracked) return 'A';
  if (change.statuses.includes('D')) return 'D';
  if (change.statuses.includes('R')) return 'R';
  return change.statuses.find(code => code && code !== '?') || 'M';
}

function matchesFilter(change) {
  const kindMatch = state.changeFilter === 'all' || Boolean(change[state.changeFilter]);
  const agentMatch = state.agentFilter === 'all' || change.agentTouch?.sessionId === state.agentFilter;
  return kindMatch && agentMatch;
}

function reviewCenterMatches(change) {
  return state.reviewCenterFilter === 'all' || Boolean(change[state.reviewCenterFilter]);
}

function reviewedChangeKey(path) {
  return normalizePath(path).toLowerCase();
}

function pruneReviewedChanges() {
  const current = new Set(state.changes.map(change => reviewedChangeKey(change.path)));
  for (const key of [...state.reviewedChanges]) {
    if (!current.has(key)) state.reviewedChanges.delete(key);
  }
}

function renderReviewButton() {
  const changes = isBasic() ? Math.max(state.changes.length, state.workspaceReview?.review?.files?.length || 0) : state.changes.length;
  const attention = pendingOperations().length + (state.connections || []).length;
  const recentFiles = state.workspaceReview?.review?.files?.length || 0;
  $('review-change-count').textContent = String(changes);
  const attentionBadge = $('review-attention-count');
  attentionBadge.textContent = String(attention);
  attentionBadge.hidden = attention === 0;
  $('review-button').disabled = changes === 0 && attention === 0 && recentFiles === 0;
  $('review-button').title = attention
    ? `${changes} workspace change${changes === 1 ? '' : 's'} · ${attention} item${attention === 1 ? '' : 's'} need attention`
    : `${changes} workspace change${changes === 1 ? '' : 's'}`;
}

async function openReviewCenterChange(change) {
  state.reviewedChanges.add(reviewedChangeKey(change.path));
  renderReviewCenter();
  const meta = isBasic() ? 'Project changes' : change.agentTouch ? `${change.agentTouch.label} · ${change.agentTouch.tool}` : 'Local / external';
  if (change.untracked && !change.staged && !change.unstaged) return openFile(change.path, { meta, preview: true });
  return openGitDiff(change.path, !change.unstaged && change.staged, { meta, preview: true });
}

function reviewCenterActionButton(label, onClick, className = 'mini-action') {
  const button = el('button', label, className);
  button.type = 'button';
  button.onclick = event => {
    event?.stopPropagation?.();
    void Promise.resolve().then(() => onClick(button)).catch(error => setStatus(error.message));
  };
  return button;
}

function renderReviewCenter() {
  const center = $('review-center');
  if (!center) return;
  pruneReviewedChanges();
  const workspace = currentWorkspace();
  const entries = state.changes;
  const filtered = entries.filter(reviewCenterMatches);
  const staged = entries.filter(change => change.staged);
  const pending = pendingOperations();
  const connections = state.connections || [];
  const attention = pending.length + connections.length;
  const reviewedCount = entries.filter(change => state.reviewedChanges.has(reviewedChangeKey(change.path))).length;
  const reviewedStageable = entries.filter(change => state.reviewedChanges.has(reviewedChangeKey(change.path)) && (change.unstaged || change.untracked));

  $('review-center-scope').textContent = workspace?.name || workspace?.path || 'Current workspace';
  $('review-center-change-count').textContent = String(entries.length);
  $('review-center-staged-count').textContent = String(staged.length);
  $('review-center-attention-count').textContent = String(attention);
  $('review-center-branch').textContent = state.gitError ? 'Source control unavailable' : (state.git?.branch || 'Working tree');
  $('review-center-reviewed-meta').textContent = `${reviewedCount}/${entries.length} reviewed`;
  $('review-center-filter-all').textContent = String(entries.length);
  $('review-center-filter-modified').textContent = String(entries.filter(change => change.unstaged).length);
  $('review-center-filter-staged').textContent = String(staged.length);
  $('review-center-filter-added').textContent = String(entries.filter(change => change.untracked).length);
  document.querySelectorAll('.review-center-filter').forEach(button => button.classList.toggle('active', button.dataset.reviewFilter === state.reviewCenterFilter));

  const next = filtered.find(change => !state.reviewedChanges.has(reviewedChangeKey(change.path))) || filtered[0];
  $('review-center-next').disabled = !next;
  $('review-center-next').textContent = filtered.length && filtered.every(change => state.reviewedChanges.has(reviewedChangeKey(change.path))) ? 'Review again' : 'Review next';
  $('review-center-stage-reviewed').disabled = reviewedStageable.length === 0;
  $('review-center-stage-reviewed').textContent = reviewedStageable.length ? `Stage reviewed (${reviewedStageable.length})` : 'Stage reviewed';

  const attentionSection = $('review-center-attention-section');
  attentionSection.hidden = attention === 0;
  $('review-center-attention-meta').textContent = String(attention);
  const attentionCards = [];
  for (const connection of connections) {
    const card = el('article', undefined, 'review-center-attention-card');
    const head = el('div', undefined, 'review-center-card-head');
    const copy = el('div', undefined, 'review-center-card-copy');
    copy.append(el('strong', connection.clientName || 'ChatGPT connection'), el('span', connection.redirectUri || 'wants to connect to Local Coder'));
    head.append(copy, el('span', connectionExpiryLabel(connection.expiresAt), 'review-center-card-meta'));
    const actions = el('div', undefined, 'review-center-card-actions');
    const reject = reviewCenterActionButton('Reject', async button => {
      button.disabled = true;
      await decideConnection(connection.id, false);
    }, 'mini-action danger-mini');
    const accept = reviewCenterActionButton('Accept connection', async button => {
      button.disabled = true;
      await decideConnection(connection.id, true);
    }, 'mini-action');
    actions.append(reject, accept);
    card.append(head, actions);
    attentionCards.push(card);
  }
  for (const operation of pending) {
    const card = el('article', undefined, 'review-center-attention-card');
    const head = el('div', undefined, 'review-center-card-head');
    const copy = el('div', undefined, 'review-center-card-copy');
    const task = taskForOperation(operation);
    const owner = operation.sessionId ? agentLabel(operation.sessionId) : 'Local / external';
    const fileCount = operation.review?.files?.length || operation.changes?.length || 0;
    const permission = permissionSummary(operation);
    copy.append(el('strong', approvalLabel(operation)), el('span', isBasic() ? `${fileCount} files · ${permission || 'review request'}` : `${task?.title || 'Workspace task'} · ${owner} · ${fileCount} file${fileCount === 1 ? '' : 's'}${permission ? ` · ${permission}` : ''}`));
    head.append(copy, el('span', `+${operation.review?.additions || 0} −${operation.review?.deletions || 0}`, 'review-center-card-meta'));
    const actions = el('div', undefined, 'review-center-card-actions');
    actions.append(reviewCenterActionButton('Review approval', () => openOperationReview(operation.id)));
    card.append(head, actions);
    attentionCards.push(card);
  }
  $('review-center-attention-list').replaceChildren(...attentionCards);

  const changeRows = filtered.map(change => {
    const reviewed = state.reviewedChanges.has(reviewedChangeKey(change.path));
    const row = el('div', undefined, `review-center-change${reviewed ? ' reviewed' : ''}`);
    const main = el('button', undefined, 'review-center-change-main');
    main.type = 'button';
    const code = statusCode(change);
    const copy = el('span', undefined, 'review-center-change-copy');
    const touch = change.agentTouch;
    copy.append(el('strong', change.path), el('span', isBasic() ? kindLabel(change) : `${kindLabel(change)} · ${touch ? `${touch.label} · ${touch.tool}` : 'Local / external'}`));
    main.append(el('span', code, `change-code${code === 'A' ? ' added' : ''}`), copy, el('span', reviewed ? '✓ reviewed' : '', 'reviewed-mark'));
    main.onclick = () => void openReviewCenterChange(change).catch(error => setStatus(error.message));
    const actions = el('div', undefined, 'review-center-change-actions');
    if (change.unstaged || change.untracked) actions.append(reviewCenterActionButton('Stage', () => stageFiles([change.path])));
    if (change.staged) actions.append(reviewCenterActionButton('Unstage', () => unstageFiles([change.path])));
    if (change.unstaged && !change.staged && !change.untracked) actions.append(reviewCenterActionButton('Discard', () => discardTrackedFile(change.path), 'mini-action danger-mini'));
    row.append(main, actions);
    return row;
  });
  $('review-center-changes-list').replaceChildren(...changeRows);
  if (!changeRows.length) $('review-center-changes-list').append(el('p', entries.length ? 'No files match this Review Center filter.' : 'Working tree clean.', 'empty-copy'));

  const recentSection = $('review-center-recent-section');
  const recentHost = $('review-center-recent-work');
  const recent = state.workspaceReview;
  const recentFiles = recent?.review?.files || [];
  recentSection.hidden = !recent || !recentFiles.length;
  if (recent && recentFiles.length) {
    const task = taskForOperation(recent);
    const owner = recent.sessionId ? agentLabel(recent.sessionId) : 'Local / external';
    $('review-center-recent-meta').textContent = isBasic() ? 'Latest edits' : `${recent.operationCount || 1} operation${recent.operationCount === 1 ? '' : 's'}`;
    const card = el('article', undefined, 'review-center-recent-card');
    const head = el('div', undefined, 'review-center-card-head');
    const copy = el('div', undefined, 'review-center-card-copy');
    copy.append(el('strong', isBasic() ? (recent.sessionId ? 'Recent ChatGPT work' : 'Your recent edits') : `${owner} · ${task?.title || 'Workspace task'}`), el('span', `${recentFiles.length} file${recentFiles.length === 1 ? '' : 's'} · ${isBasic() ? 'recent edits' : 'latest review run'}`));
    head.append(copy, el('span', `+${recent.review?.additions || 0} −${recent.review?.deletions || 0}`, 'review-center-card-meta'));
    const actions = el('div', undefined, 'review-center-card-actions');
    actions.append(reviewCenterActionButton(isBasic() ? 'Review changes' : 'Review run', () => openChangeSetReview(recent.id)));
    if (recent.canUndo || recent.canRedo) {
      const redo = Boolean(recent.canRedo && !recent.canUndo);
      actions.append(reviewCenterActionButton(redo ? 'Redo ↷' : 'Undo ↶', () => restoreChangeSet(recent.id, redo)));
    }
    const files = el('div', undefined, 'review-center-recent-files');
    for (const file of recentFiles) {
      const button = el('button', undefined, 'review-center-recent-file');
      button.type = 'button';
      button.append(el('code', relativeForTask(file.path, task)), el('span', `+${file.additions || 0}`, 'additions'), el('span', `−${file.deletions || 0}`, 'deletions'));
      button.onclick = () => void openChangeSetFileDiff(recent.id, file.path).catch(error => setStatus(error.message));
      files.append(button);
    }
    card.append(head, actions, files);
    recentHost.replaceChildren(card);
  } else {
    recentHost.replaceChildren();
  }
}

function renderAgentFilter(entries) {
  const select = $('agent-change-filter');
  const agents = [...new Map(entries.filter(item => item.agentTouch).map(item => [item.agentTouch.sessionId, item.agentTouch])).values()];
  select.replaceChildren(
    Object.assign(document.createElement('option'), { value: 'all', textContent: 'All agents' }),
    ...agents.map(agent => Object.assign(document.createElement('option'), { value: agent.sessionId, textContent: agent.label })),
  );
  if (!agents.some(agent => agent.sessionId === state.agentFilter)) state.agentFilter = 'all';
  select.value = state.agentFilter;
}

function renderChanges() {
  const entries = state.changes;
  const filtered = entries.filter(matchesFilter);
  renderWorkspaceReview();
  renderAgentFilter(entries);
  $('change-count').textContent = entries.length;
  $('filter-all-count').textContent = entries.length;
  $('filter-modified-count').textContent = entries.filter(item => item.unstaged).length;
  $('filter-staged-count').textContent = entries.filter(item => item.staged).length;
  $('filter-added-count').textContent = entries.filter(item => item.untracked).length;
  const notRepo = state.gitError && /not a git repository/i.test(state.gitError);
  $('change-summary-title').textContent = state.gitError ? 'Source control unavailable' : entries.length ? `${entries.length} file${entries.length === 1 ? '' : 's'} changed` : 'No changes';
  $('change-summary-sub').textContent = state.gitError
    ? (notRepo ? 'This environment is not a Git repository.' : 'Git status could not be read for this environment.')
    : (state.git?.branch ? `${state.git.branch}${state.git.ahead ? ` · ↑${state.git.ahead}` : ''}${state.git.behind ? ` · ↓${state.git.behind}` : ''}` : 'Working tree clean');
  if (isBasic() && state.gitError) {
    const recentFiles = state.workspaceReview?.review?.files?.length || 0;
    $('change-summary-title').textContent = recentFiles ? `ChatGPT edited ${recentFiles} files` : 'Project changes';
    $('change-summary-sub').textContent = 'Recorded edits and Undo work independently of Git.';
    $('change-count').textContent = recentFiles;
  }
  $('status-changes').textContent = `${entries.length} change${entries.length === 1 ? '' : 's'}`;
  const scoped = state.changeFilter !== 'all' || state.agentFilter !== 'all';
  renderReviewButton();
  renderReviewCenter();
  const staged = entries.filter(item => item.staged);
  const visibleStaged = filtered.filter(item => item.staged);
  const visibleStageable = filtered.filter(item => item.unstaged || item.untracked);
  $('stage-all').textContent = scoped ? 'Stage visible' : 'Stage all';
  $('unstage-all').textContent = scoped ? 'Unstage visible' : 'Unstage all';
  $('stage-all').disabled = !visibleStageable.length;
  $('unstage-all').disabled = !visibleStaged.length;
  $('commit-message').disabled = !staged.length;
  $('commit-button').disabled = !staged.length || !$('commit-message').value.trim();

  const rows = filtered.map(change => {
    const code = statusCode(change);
    const row = el('div', undefined, 'change-row');
    const main = el('button', undefined, 'change-main');
    main.type = 'button';
    const touch = change.agentTouch;
    const info = el('span', undefined, 'change-info');
    info.append(el('span', change.path, 'change-path'));
    const meta = el('span', undefined, 'change-meta');
    meta.append(el('span', kindLabel(change), 'change-kind'));
    if (touch) meta.append(el('span', `${touch.label} · ${touch.tool}`, 'change-agent'));
    else meta.append(el('span', 'Local / external', 'change-agent external'));
    info.append(meta);
    main.append(
      el('span', code, `change-code${code === 'A' ? ' added' : ''}`),
      info,
    );
    main.onclick = () => {
      const sourceMeta = isBasic() ? 'Project changes' : touch ? `${touch.label} · ${touch.tool}` : 'Local / external';
      const action = change.untracked && !change.staged && !change.unstaged
        ? openFile(change.path, { meta: sourceMeta })
        : openGitDiff(change.path, !change.unstaged && change.staged, { meta: sourceMeta });
      void action.catch(error => setStatus(error.message));
    };
    const actions = el('div', undefined, 'change-actions');
    if (change.unstaged || change.untracked) {
      const stage = el('button', 'Stage', 'mini-action');
      stage.type = 'button';
      stage.onclick = () => void stageFiles([change.path]).catch(error => setStatus(error.message));
      actions.append(stage);
    }
    if (change.staged) {
      const unstage = el('button', 'Unstage', 'mini-action');
      unstage.type = 'button';
      unstage.onclick = () => void unstageFiles([change.path]).catch(error => setStatus(error.message));
      actions.append(unstage);
    }
    if (change.unstaged && !change.staged && !change.untracked) {
      const discard = el('button', 'Discard', 'mini-action danger-mini');
      discard.type = 'button';
      discard.onclick = () => void discardTrackedFile(change.path).catch(error => setStatus(error.message));
      actions.append(discard);
    }
    row.append(main, actions);
    return row;
  });
  $('changes-list').replaceChildren(...rows);
  if (!rows.length) $('changes-list').append(el('p', state.gitError ? 'Agent operation diffs remain available in Activity.' : entries.length ? 'Không có file trong bộ lọc này.' : 'Working tree clean.', 'empty-copy'));
  renderEnvironment();
}

function renderApprovals() {
  const pending = pendingOperations();
  const connections = state.connections || [];
  const total = pending.length + connections.length;
  $('approval-count').textContent = total;
  $('approvals-inline').hidden = total === 0;

  const connectionCards = connections.map(connection => {
    const card = el('article', undefined, 'connection-approval-card');
    const head = el('div', undefined, 'connection-approval-head');
    const identity = el('div', undefined, 'connection-approval-identity');
    const copy = el('div', undefined, 'connection-approval-copy');
    copy.append(
      el('strong', connection.clientName || 'ChatGPT OAuth client'),
      el('span', 'wants to connect to Local Coder'),
    );
    identity.append(el('span', '◇', 'connection-approval-mark'), copy);
    head.append(identity, el('span', connectionExpiryLabel(connection.expiresAt), 'connection-expiry'));

    const callback = el('div', undefined, 'connection-callback');
    callback.append(el('span', 'Callback', 'connection-callback-label'), el('code', connection.redirectUri || '—'));

    const actions = el('div', undefined, 'connection-approval-actions');
    const reject = el('button', 'Reject', 'secondary-button compact-action connection-reject');
    const accept = el('button', 'Accept connection', 'primary-button compact-action connection-accept');
    reject.type = 'button';
    accept.type = 'button';
    const decide = approve => {
      reject.disabled = true;
      accept.disabled = true;
      void decideConnection(connection.id, approve).catch(error => {
        reject.disabled = false;
        accept.disabled = false;
        setStatus(error.message);
      });
    };
    reject.onclick = () => decide(false);
    accept.onclick = () => decide(true);
    actions.append(reject, accept);
    card.append(head, callback, actions);
    return card;
  });

  const operationCards = pending.map(operation => {
    const card = el('button', undefined, 'approval-card');
    card.type = 'button';
    const head = el('div', undefined, 'approval-card-head');
    const owner = operation.sessionId ? agentLabel(operation.sessionId) : 'Local / external';
    const task = taskForOperation(operation);
    const permission = permissionSummary(operation);
    head.append(el('strong', approvalLabel(operation)), el('span', `${isBasic() ? '' : `${task?.title || 'Workspace task'} · ${owner} · `}${operation.review?.files?.length || operation.changes?.length || 0} files${permission ? ` · ${permission}` : ''}`));
    card.append(head, el('p', operation.review ? `+${operation.review.additions || 0} −${operation.review.deletions || 0} · awaiting approval` : `${owner} · awaiting approval`));
    card.onclick = () => void openOperationReview(operation.id).catch(error => setStatus(error.message));
    return card;
  });
  $('approvals-list').replaceChildren(...connectionCards, ...operationCards);
  renderReviewButton();
  renderReviewCenter();
}

export async function loadConnections() {
  state.connections = await api('/api/workbench/connections');
  renderApprovals();
  return state.connections;
}

export async function decideConnection(id, approve) {
  setStatus(approve ? 'Accepting ChatGPT connection…' : 'Rejecting ChatGPT connection…');
  await api(`/api/workbench/connections/${encodeURIComponent(id)}`, { method: 'POST', body: { approve } });
  await loadConnections();
  setStatus(approve ? 'ChatGPT connection accepted' : 'ChatGPT connection rejected');
}

export function openReviewCenter() {
  if (isBasic() && !pendingOperations().length && !state.connections?.length && state.workspaceReview?.id && !state.changes.length) {
    void openChangeSetReview(state.workspaceReview.id).catch(error => setStatus(error.message));
    return;
  }
  renderReviewButton();
  renderReviewCenter();
  const center = $('review-center');
  center.hidden = false;
  center.setAttribute('aria-hidden', 'false');
}

export function closeReviewCenter() {
  const center = $('review-center');
  if (!center) return;
  center.hidden = true;
  center.setAttribute('aria-hidden', 'true');
}

export function setReviewCenterFilter(filter) {
  state.reviewCenterFilter = ['all', 'unstaged', 'staged', 'untracked'].includes(filter) ? filter : 'all';
  renderReviewCenter();
}

export async function reviewNextChange() {
  const filtered = state.changes.filter(reviewCenterMatches);
  const next = filtered.find(change => !state.reviewedChanges.has(reviewedChangeKey(change.path))) || filtered[0];
  if (!next) return;
  await openReviewCenterChange(next);
}

export async function stageReviewedChanges() {
  const files = state.changes
    .filter(change => state.reviewedChanges.has(reviewedChangeKey(change.path)) && (change.unstaged || change.untracked))
    .map(change => change.path);
  if (!files.length) return;
  await stageFiles(files);
}

function currentExecution() {
  const task = state.data?.tasks?.find(item => item.id === state.taskId);
  return task?.execution || { mode: 'local', path: task?.workspace || '' };
}

function renderEnvironment() {
  const execution = currentExecution();
  const entries = state.changes;
  const changes = entries.length;
  const staged = entries.filter(change => change.staged).length;
  const working = entries.filter(change => change.unstaged || change.untracked).length;
  const ahead = Number(state.git?.ahead || 0);
  const behind = Number(state.git?.behind || 0);
  const upstream = typeof state.git?.upstream === 'string' ? state.git.upstream : '';
  const branchButton = $('environment-branch');
  const changesButton = $('environment-changes');
  const primary = $('environment-primary-action');
  const status = $('environment-status');
  const syncState = $('environment-sync-state');
  $('environment-change-count').textContent = changes;
  $('environment-change-label').textContent = changes === 1 ? 'change' : 'changes';
  $('environment-change-meta').textContent = changes
    ? [working ? `${working} working` : '', staged ? `${staged} staged` : ''].filter(Boolean).join(' · ')
    : 'Clean working tree';
  changesButton.disabled = !state.taskId || changes === 0;
  changesButton.title = changes ? 'Open these changes in Review Center' : 'Working tree clean';
  $('environment-mode').textContent = execution.mode === 'worktree' ? 'Worktree' : 'Local';
  $('environment-path').textContent = execution.mode === 'worktree'
    ? (execution.startingRef ? `isolated · from ${execution.startingRef}` : 'isolated worktree')
    : 'project checkout';
  $('environment-path').title = execution.path || '';

  branchButton.disabled = Boolean(state.gitError) || !state.taskId;
  status.classList.remove('warning', 'error');
  status.textContent = 'Ready';

  primary.classList.remove('ready');
  primary.disabled = true;
  primary.dataset.action = '';
  $('environment-sync-meta').textContent = '';
  if (!state.taskId) {
    status.textContent = 'No task';
    status.classList.add('warning');
    $('environment-branch-name').textContent = 'No task selected';
    syncState.textContent = '—';
    $('environment-sync-meta').textContent = 'Select a task first';
    $('environment-primary-label').textContent = 'Select a task to continue';
    return;
  }
  if (state.gitError) {
    if (/not a git repository/i.test(state.gitError)) {
      status.textContent = 'Git not initialized';
      status.classList.add('warning');
      $('environment-branch-name').textContent = 'No repository';
      syncState.textContent = 'Not initialized';
      $('environment-sync-meta').textContent = 'Git required';
      $('environment-primary-label').textContent = 'Initialize Git';
      primary.disabled = false;
      primary.classList.add('ready');
      primary.dataset.action = 'init';
    } else {
      status.textContent = 'Source error';
      status.classList.add('error');
      $('environment-branch-name').textContent = 'Source control unavailable';
      syncState.textContent = 'Unavailable';
      $('environment-sync-meta').textContent = 'Refresh to retry';
      $('environment-primary-label').textContent = 'Source control unavailable';
    }
    return;
  }

  if (state.git?.branch) $('environment-branch-name').textContent = state.git.branch;
  else if (execution.mode === 'worktree') $('environment-branch-name').textContent = `Based on ${execution.startingRef || 'HEAD'}`;
  else $('environment-branch-name').textContent = 'Detached HEAD';

  if (!state.git?.branch) {
    syncState.textContent = 'Detached';
    $('environment-sync-meta').textContent = 'No branch sync';
  } else if (behind && ahead) {
    syncState.textContent = `↓${behind} pull · ↑${ahead} push`;
    $('environment-sync-meta').textContent = upstream || 'remote changes diverged';
  } else if (behind) {
    syncState.textContent = `${behind} to pull`;
    $('environment-sync-meta').textContent = upstream || state.git.branch;
  } else if (ahead) {
    syncState.textContent = `${ahead} to push`;
    $('environment-sync-meta').textContent = upstream || state.git.branch;
  } else if (upstream) {
    syncState.textContent = 'Up to date';
    $('environment-sync-meta').textContent = upstream;
  } else {
    syncState.textContent = 'Local branch';
    $('environment-sync-meta').textContent = 'No upstream';
  }

  if (changes) {
    $('environment-primary-label').textContent = `Review ${changes} change${changes === 1 ? '' : 's'}`;
    primary.disabled = false;
    primary.classList.add('ready');
    primary.dataset.action = 'review';
    return;
  }
  if (behind > 0 && state.git?.branch) {
    $('environment-primary-label').textContent = `Pull ${behind} commit${behind === 1 ? '' : 's'}`;
    primary.disabled = false;
    primary.classList.add('ready');
    primary.dataset.action = 'pull';
    return;
  }
  if (ahead > 0 && state.git?.branch) {
    $('environment-primary-label').textContent = `Push ${ahead} commit${ahead === 1 ? '' : 's'}`;
    primary.disabled = false;
    primary.classList.add('ready');
    primary.dataset.action = 'push';
    return;
  }
  $('environment-primary-label').textContent = state.git?.branch ? 'Environment ready' : 'Detached environment';
}

function normalizedFsPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
}

function worktreeForBranch(name) {
  const currentPath = normalizedFsPath(currentExecution().path);
  return (state.gitOverview?.worktrees || []).find(item => item.branch === name && normalizedFsPath(item.path) !== currentPath);
}

function renderBranchDialog() {
  const branches = state.gitOverview?.branches || [];
  const local = branches.filter(branch => !branch.remote);
  const remote = branches.filter(branch => branch.remote);
  const rows = [];
  const addBranch = branch => {
    const inUse = !branch.current ? worktreeForBranch(branch.name) : null;
    const row = el('button', undefined, `branch-row${branch.current ? ' current' : ''}`);
    row.type = 'button';
    // Do not add Workbench-specific branch locks here. The ChatGPT session is
    // pinned to its Task/worktree, so changing the branch viewed by the user
    // must not affect that agent. Let Git itself decide whether a particular
    // switch is legal (for example, Git may reject a branch checked out in a
    // different worktree).
    row.disabled = Boolean(branch.current || branch.remote);
    const marker = el('span', branch.current ? '✓' : ' ', 'branch-row-marker');
    const copy = el('span', undefined, 'branch-row-copy');
    copy.append(el('strong', branch.name));
    if (inUse) copy.append(el('small', `Checked out in ${inUse.path}`));
    else if (branch.remote) copy.append(el('small', 'Remote branch'));
    else if (branch.current) copy.append(el('small', 'Current branch'));
    const meta = el('span', inUse ? 'in use' : branch.remote ? 'remote' : '', 'branch-row-meta');
    row.append(marker, copy, meta);
    if (!row.disabled) row.onclick = () => void switchBranch(branch.name).catch(showBranchError);
    rows.push(row);
  };
  local.forEach(addBranch);
  if (remote.length) {
    const divider = el('div', 'REMOTE', 'history-group-head');
    rows.push(divider);
    remote.forEach(addBranch);
  }
  $('branch-list').replaceChildren(...rows);
  if (!rows.length) $('branch-list').append(el('p', 'No branches found.', 'empty-copy'));
}

function showBranchError(error) {
  $('branch-dialog-error').textContent = error?.message || String(error);
  $('branch-dialog-error').hidden = false;
  setStatus($('branch-dialog-error').textContent);
}

export async function openBranchDialog() {
  if (!state.taskId || state.gitError) return;
  $('branch-dialog-error').hidden = true;
  $('branch-list').replaceChildren(el('p', 'Loading branches…', 'empty-copy'));
  $('branch-dialog').showModal();
  try {
    state.gitOverview = await api(`/api/workbench/tasks/${state.taskId}/git/overview`);
    state.git = state.gitOverview.status;
    renderBranchDialog();
    renderEnvironment();
  } catch (error) {
    showBranchError(error);
  }
}

export async function switchBranch(name) {
  await runGitMutation('git_branch', { action: 'switch', name }, `Switching to ${name}`);
  $('branch-dialog').close();
}

export async function createBranch() {
  const name = prompt('New branch name');
  if (name === null) return;
  const value = name.trim();
  if (!value) throw new Error('Branch name is required.');
  await runGitMutation('git_branch', { action: 'create-and-switch', name: value }, `Creating ${value}`);
  $('branch-dialog').close();
}

export async function fetchBranches() {
  await runGitMutation('git_fetch', { remote: 'origin' }, 'Fetching branches');
  state.gitOverview = await api(`/api/workbench/tasks/${state.taskId}/git/overview`);
  state.git = state.gitOverview.status;
  renderBranchDialog();
  renderEnvironment();
}

export async function runEnvironmentPrimaryAction() {
  const action = $('environment-primary-action').dataset.action;
  if (action === 'review') {
    openReviewCenter();
    return;
  }
  if (action === 'init') {
    await runGitMutation('git_init', {}, 'Initializing Git');
    return;
  }
  if (action === 'push') {
    if (!state.git?.branch) throw new Error('Create a branch before pushing this worktree.');
    if (!confirm(`Push ${state.git.branch} to origin?`)) return;
    await runGitMutation('git_push', { remote: 'origin', branch: state.git.branch, set_upstream: !state.git.upstream }, 'Pushing commits');
    return;
  }
  if (action === 'pull') {
    if (!state.git?.branch) throw new Error('A branch is required before pulling.');
    if (!confirm(`Pull origin/${state.git.branch} with fast-forward only?`)) return;
    await runGitMutation('git_pull', { remote: 'origin', branch: state.git.branch }, 'Pulling commits');
  }
}

export async function loadChanges() {
  const generation = ++changesLoadGeneration;
  const expectedTaskId = state.taskId;
  const expectedWorkspaceId = state.workspaceId;
  if (!state.taskId) {
    state.git = null;
    state.gitOverview = null;
    state.gitError = null;
    state.changes = [];
    state.changeByPath = new Map();
    state.workspaceReview = null;
    state.workspaceReviewId = null;
    state.workspaceReviewExpanded = false;
    renderChanges();
    renderApprovals();
    return;
  }
  try {
    const overview = await api(`/api/workbench/tasks/${expectedTaskId}/git/overview`);
    if (generation !== changesLoadGeneration || state.taskId !== expectedTaskId || state.workspaceId !== expectedWorkspaceId) return;
    state.gitOverview = overview;
    state.git = overview.status;
    state.gitError = null;
    state.changes = enrichChanges(mergeChanges(state.git));
    state.changeByPath = new Map(state.changes.map(change => [change.path, change]));
  } catch (error) {
    if (generation !== changesLoadGeneration || state.taskId !== expectedTaskId || state.workspaceId !== expectedWorkspaceId) return;
    state.git = null;
    state.gitOverview = null;
    state.gitError = error.message;
    state.changes = [];
    state.changeByPath = new Map();
  }
  try {
    await loadWorkspaceReview(expectedWorkspaceId, generation);
  } catch (error) {
    if (generation !== changesLoadGeneration || state.taskId !== expectedTaskId || state.workspaceId !== expectedWorkspaceId) return;
    state.workspaceReview = null;
    state.workspaceReviewId = null;
    state.workspaceReviewExpanded = false;
    renderWorkspaceReview();
    setStatus(`Workspace review unavailable: ${error.message}`);
  }
  renderChanges();
  renderApprovals();
  window.dispatchEvent(new CustomEvent('workbench:git-updated'));
}

async function runGitMutation(tool, args, message) {
  if (!state.taskId) return;
  setStatus(`${message}…`);
  await api(`/api/workbench/tasks/${state.taskId}/git`, { method: 'POST', body: { tool, args } });
  window.dispatchEvent(new CustomEvent('workbench:refresh-request', { detail: { scopes: ['operations', 'workspace'], taskId: state.taskId } }));
  setStatus(`${message} done`);
}

export async function stageFiles(files) {
  await runGitMutation('git_add', { files }, 'Staging files');
}

export async function stageAllChanges() {
  const scoped = state.changeFilter !== 'all' || state.agentFilter !== 'all';
  if (!scoped) {
    await runGitMutation('git_add', { all: true }, 'Staging all changes');
    return;
  }
  const files = state.changes.filter(matchesFilter).filter(change => change.unstaged || change.untracked).map(change => change.path);
  if (!files.length) return;
  await stageFiles(files);
}

export async function unstageFiles(files) {
  await runGitMutation('git_unstage', { files }, 'Unstaging files');
}

export async function unstageAllChanges() {
  const files = state.changes.filter(matchesFilter).filter(change => change.staged).map(change => change.path);
  if (!files.length) return;
  await unstageFiles(files);
}

export async function discardTrackedFile(file) {
  if (!confirm(`Discard working-tree changes in ${file}? This restores the tracked file from HEAD.`)) return;
  await runGitMutation('git_restore', { files: [file] }, 'Discarding working changes');
}

export async function commitStaged(message) {
  const value = String(message || '').trim();
  if (!value) throw new Error('Commit message is required');
  if (!state.changes.some(change => change.staged)) throw new Error('There are no staged files to commit');
  await runGitMutation('git_commit', { message: value, stage_all: false }, 'Committing staged changes');
  $('commit-message').value = '';
}

export async function openOperationReview(id) {
  const operation = await api(`/api/workbench/operations/${id}`);
  state.currentOperationId = operation.status === 'pending' ? id : null;
  state.currentOperationTaskId = operation.status === 'pending' ? operation.taskId : null;
  const files = operation.review?.files || [];
  const operationTask = taskForOperation(operation);
  $('review-title').textContent = isBasic() ? `${actionLabel(operation)} · ${files.length} files` : `${operationTask?.title || 'Workspace task'} · ${operation.tool} · ${files.length || operation.changes?.length || 0} files`;
  const owner = operation.sessionId ? agentLabel(operation.sessionId) : 'Local / external';
  const reviewNote = $('review-note');
  const additions = operation.review?.additions || 0;
  const deletions = operation.review?.deletions || 0;
  const permission = permissionSummary(operation);
  reviewNote.replaceChildren(
    el('strong', owner, 'review-owner'),
    el('span', operation.status === 'pending' ? 'Preview before approval' : 'Actual operation diff', `review-mode ${operation.status === 'pending' ? 'pending' : 'actual'}`),
    ...(permission ? [el('span', permission, 'review-mode pending')] : []),
    el('span', `+${additions}`, 'review-additions'),
    el('span', `−${deletions}`, 'review-deletions'),
  );
  $('review-error').hidden = true;
  setReviewDecisionState('', '');
  const renderTargets = [];
  const blocks = files.map(file => {
    const block = el('section', undefined, 'review-file');
    const head = el('div', undefined, 'review-file-head');
    const meta = el('span', undefined, 'review-file-meta');
    meta.append(
      el('span', file.operation || 'update', 'review-file-operation'),
      el('span', `+${file.additions || 0}`, 'review-file-additions'),
      el('span', `−${file.deletions || 0}`, 'review-file-deletions'),
    );
    head.append(el('strong', relativeForTask(file.path, operationTask)), meta);
    const diff = el('div', undefined, 'diff-view codex-review-diff');
    const renderedDiff = operationFileDiff(operation, file);
    if (renderedDiff) renderUnifiedDiff(diff, renderedDiff);
    else diff.append(el('p', file.note || 'Không có text diff.', 'empty-copy'));
    block.append(head, diff);
    renderTargets.push({ host: diff, file });
    return block;
  });
  $('review-files').replaceChildren(...blocks);
  if (operation.status === 'pending' && operation.args) {
    const request = el('pre', undefined, 'approval-request');
    request.textContent = operation.args.command || JSON.stringify(operation.args, (key, value) => ['content', 'patch'].includes(key) ? undefined : value, 2);
    if (request.textContent && request.textContent !== '{}') $('review-files').prepend(request);
  }
  if (!blocks.length) $('review-files').append(el('p', 'Operation này không có text diff để hiển thị.', 'empty-copy'));
  $('review-actions').hidden = operation.status !== 'pending';
  $('review-dialog').showModal();
  await Promise.allSettled(renderTargets.map(async ({ host, file }) => {
    try {
      await colorizeReviewDiff(host, operation, file);
    } catch {
      // Keep the deterministic Workbench diff already rendered above.
    }
  }));
}

export async function openChangeSetReview(id) {
  const changeSet = await api(`/api/workbench/review-runs/${encodeURIComponent(id)}`);
  state.currentOperationId = null;
  state.currentOperationTaskId = null;
  const files = changeSet.review?.files || [];
  const task = taskForOperation(changeSet);
  const owner = changeSet.sessionId ? agentLabel(changeSet.sessionId) : 'Local / external';
  const additions = changeSet.review?.additions || 0;
  const deletions = changeSet.review?.deletions || 0;
  $('review-title').textContent = `${isBasic() ? (changeSet.sessionId ? 'ChatGPT edits' : 'Your edits') : task?.title || 'Workspace task'} · ${files.length} file${files.length === 1 ? '' : 's'}`;
  $('review-note').replaceChildren(
    el('strong', owner, 'review-owner'),
    el('span', isBasic() ? 'Recent work' : `${changeSet.operationCount || 1} operation${changeSet.operationCount === 1 ? '' : 's'} · current review run`, 'review-mode actual'),
    el('span', `+${additions}`, 'review-additions'),
    el('span', `−${deletions}`, 'review-deletions'),
  );
  $('review-error').hidden = true;
  const renderTargets = [];
  const blocks = files.map(file => {
    const block = el('section', undefined, 'review-file');
    const head = el('div', undefined, 'review-file-head');
    const meta = el('span', undefined, 'review-file-meta');
    meta.append(
      el('span', file.operation || 'update', 'review-file-operation'),
      el('span', `+${file.additions || 0}`, 'review-file-additions'),
      el('span', `−${file.deletions || 0}`, 'review-file-deletions'),
    );
    head.append(el('strong', relativeForTask(file.path, task)), meta);
    const diff = el('div', undefined, 'diff-view codex-review-diff');
    const renderedDiff = operationFileDiff(changeSet, file);
    if (renderedDiff) renderUnifiedDiff(diff, renderedDiff);
    else diff.append(el('p', file.note || 'Không có text diff.', 'empty-copy'));
    block.append(head, diff);
    renderTargets.push({ host: diff, file });
    return block;
  });
  $('review-files').replaceChildren(...blocks);
  if (!blocks.length) $('review-files').append(el('p', 'Review run này không có text diff để hiển thị.', 'empty-copy'));
  $('review-actions').hidden = true;
  $('review-dialog').showModal();
  await Promise.allSettled(renderTargets.map(async ({ host, file }) => {
    try {
      await colorizeReviewDiff(host, changeSet, file);
    } catch {
      // Keep the deterministic Workbench diff already rendered above.
    }
  }));
}

async function openChangeSetFileDiff(id, path) {
  const changeSet = await api(`/api/workbench/review-runs/${encodeURIComponent(id)}`);
  const wanted = comparableOperationPath(path, changeSet);
  const file = (changeSet.review?.files || []).find(item => comparableOperationPath(item.path, changeSet) === wanted);
  const renderedDiff = file ? operationFileDiff(changeSet, file) : '';
  if (!renderedDiff) throw new Error('Change set này không có text diff cho file đã chọn.');
  const owner = changeSet.sessionId ? agentLabel(changeSet.sessionId) : 'Local / external';
  openTextDiff({
    id: `change-set-diff:${changeSet.id}:${file.path}`,
    path: file.path,
    title: relativeForTask(file.path, taskForOperation(changeSet)),
    content: renderedDiff,
    meta: `${isBasic() ? 'ChatGPT edits' : `${owner} · change set`} · +${file.additions || 0} −${file.deletions || 0}`,
    preview: true,
  });
}

export async function restoreChangeSet(id, redo) {
  const current = state.workspaceReview?.id === id ? state.workspaceReview : null;
  const action = redo ? 'Redo' : 'Undo';
  const count = current?.review?.files?.length || 0;
  if (!confirm(`${action} ${isBasic() ? 'these edits' : 'this change set'}${count ? ` (${count} file${count === 1 ? '' : 's'})` : ''}? Files changed since these edits will be preserved and reported as a conflict.`)) return;
  const undoButton = $('workspace-review-undo');
  const reviewButton = $('workspace-review-open');
  clearWorkspaceReviewError();
  undoButton.disabled = true;
  reviewButton.disabled = true;
  undoButton.textContent = redo ? 'Redoing…' : 'Undoing…';
  setStatus(`${action}ing workspace change set…`);
  try {
    const next = await api(`/api/workbench/review-runs/${encodeURIComponent(id)}/undo`, { method: 'POST', body: { redo } });
    const taskId = next?.taskId || current?.taskId || state.taskId;
    const paths = (next?.changes || current?.changes || []).map(change => change.path).filter(Boolean);
    invalidateRestoredEditorTabs({ taskId, changeSetId: id, paths });
    state.workspaceReview = next;
    state.workspaceReviewId = next?.id || id;
    state.workspaceReviewExpanded = false;
    await loadChanges();
    window.dispatchEvent(new CustomEvent('workbench:refresh-request', { detail: { scopes: ['operations'], taskId } }));
    setStatus(isBasic() ? (redo ? 'Edits redone' : 'Edits undone') : (redo ? 'Workspace change set redone' : 'Workspace change set undone'));
  } catch (error) {
    renderWorkspaceReview();
    showWorkspaceReviewError(error);
  } finally {
    const latest = state.workspaceReview;
    if (latest?.id === id) renderWorkspaceReview();
  }
}

export async function openOperationFileDiff(id, path) {
  const operation = await api(`/api/workbench/operations/${id}`);
  const wanted = comparableOperationPath(path, operation);
  const file = (operation.review?.files || []).find(item => comparableOperationPath(item.path, operation) === wanted);
  const renderedDiff = file ? operationFileDiff(operation, file) : '';
  if (!renderedDiff) throw new Error('Operation này không có text diff cho file đã chọn.');
  const owner = operation.sessionId ? agentLabel(operation.sessionId) : 'Local / external';
  openTextDiff({
    id: `operation-diff:${operation.id}:${file.path}`,
    path: file.path,
    title: relativeForTask(file.path, taskForOperation(operation)),
    content: renderedDiff,
    meta: `${owner} · ${operation.tool} · +${file.additions || 0} −${file.deletions || 0}`,
  });
}

export async function decideCurrentOperation(approve) {
  if (!state.currentOperationId) return;
  const operationId = state.currentOperationId;
  const taskId = state.currentOperationTaskId || (state.data?.operations || []).find(operation => operation.id === operationId)?.taskId || state.taskId;
  const pendingOperation = (state.data?.operations || []).find(operation => operation.id === operationId);
  setReviewDecisionState('busy', approve ? 'Approval received · starting operation…' : 'Denying operation…', approve ? 'approve' : 'deny');
  $('review-error').hidden = true;
  setStatus(approve ? 'Approval received · running operation…' : 'Denying operation…');
  if (pendingOperation) pendingOperation.status = approve ? 'running' : 'denied';
  renderApprovals();
  try {
    await api(`/api/workbench/operations/${operationId}/decision`, { method: 'POST', body: { approve } });
    let latest = null;
    try { latest = await api(`/api/workbench/operations/${operationId}`); } catch { /* SSE/polling will reconcile shortly. */ }
    const finalStatus = latest?.status || (approve ? 'completed' : 'denied');
    updateLocalOperationStatus(operationId, finalStatus);
    state.currentOperationId = null;
    state.currentOperationTaskId = null;
    $('review-actions').hidden = true;
    if (approve && finalStatus === 'completed') {
      setReviewDecisionState('success', 'Approved · operation completed.');
      setStatus('Approved · operation completed');
    } else if (approve && finalStatus === 'running') {
      setReviewDecisionState('busy', 'Approved · operation is running…');
      setStatus('Approved · operation is running…');
    } else if (finalStatus === 'expired' || finalStatus === 'interrupted') {
      setReviewDecisionState('error', finalStatus === 'expired'
        ? 'Approval expired before execution. Request a new operation.'
        : 'Operation was interrupted before execution. Request a new operation.');
      setStatus(finalStatus === 'expired' ? 'Approval expired' : 'Operation interrupted');
    } else if (!approve && finalStatus === 'denied') {
      setReviewDecisionState('denied', 'Denied · operation will not run.');
      setStatus('Operation denied');
    } else if (finalStatus === 'failed') {
      setReviewDecisionState('error', 'Approved · operation failed. Review the operation details.');
      setStatus('Approved · operation failed');
    } else {
      setReviewDecisionState('success', `${approve ? 'Approved' : 'Decision saved'} · ${finalStatus}.`);
      setStatus(`${approve ? 'Approved' : 'Decision saved'} · ${finalStatus}`);
    }
    window.dispatchEvent(new CustomEvent('workbench:refresh-request', { detail: { scopes: ['operations', 'workspace'], taskId } }));
  } catch (error) {
    let latest = null;
    try { latest = await api(`/api/workbench/operations/${operationId}`); } catch { /* Preserve the optimistic UI only until the next refresh. */ }
    const stillPending = latest?.status === 'pending';
    if (latest?.status) updateLocalOperationStatus(operationId, latest.status);
    else if (pendingOperation) pendingOperation.status = 'pending';
    if (stillPending || !latest) {
      state.currentOperationId = operationId;
      state.currentOperationTaskId = taskId;
      $('review-actions').hidden = false;
      setReviewDecisionState('error', 'Approval was not applied. You can try again.');
    } else {
      state.currentOperationId = null;
      state.currentOperationTaskId = null;
      $('review-actions').hidden = true;
      if (latest.status === 'completed') {
        setReviewDecisionState('success', 'Approved · operation completed.');
        setStatus('Approved · operation completed');
      } else if (latest.status === 'running') {
        setReviewDecisionState('busy', 'Approved · operation is already running…');
        setStatus('Approved · operation is already running…');
      } else if (latest.status === 'denied') {
        setReviewDecisionState('denied', 'Denied · operation will not run.');
        setStatus('Operation denied');
      } else if (latest.status === 'expired' || latest.status === 'interrupted') {
        setReviewDecisionState('error', latest.status === 'expired'
          ? 'Approval expired before execution. Request a new operation.'
          : 'Operation was interrupted before execution. Request a new operation.');
        setStatus(latest.status === 'expired' ? 'Approval expired' : 'Operation interrupted');
      } else {
        setReviewDecisionState('error', `${approve ? 'Approved' : 'Decision saved'} · operation ${latest.status}.`);
        setStatus(`Operation ${latest.status}`);
      }
    }
    renderApprovals();
    window.dispatchEvent(new CustomEvent('workbench:refresh-request', { detail: { scopes: ['operations', 'workspace'], taskId } }));
    if (latest && latest.status !== 'pending') return;
    throw error;
  }
}

export function openPrimaryReview() {
  openReviewCenter();
  return Promise.resolve();
}

export function setChangeFilter(filter) {
  state.changeFilter = filter;
  document.querySelectorAll('.filter-chip').forEach(button => button.classList.toggle('active', button.dataset.filter === filter));
  renderChanges();
}

export function setAgentFilter(sessionId = 'all') {
  state.agentFilter = sessionId || 'all';
  if ($('agent-change-filter')) $('agent-change-filter').value = state.agentFilter;
  renderChanges();
}

export function showChangesTab(tab) {
  document.querySelectorAll('.changes-tab').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
  $('changes-panel').hidden = tab !== 'changes';
  $('history-panel').hidden = tab !== 'history';
}
