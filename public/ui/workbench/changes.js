import { api } from './api.js';
import { state } from './state.js';
import { $, el, renderUnifiedDiff, setStatus, taskRelative } from './dom.js';
import { openFile, openGitDiff, openTextDiff } from './editor.js';
import { agentLabel } from './agent-identity.js';
import { languageForPath } from './monaco.js';

function taskOperations() {
  return (state.data?.operations || []).filter(operation => operation.taskId === state.taskId);
}

function pendingOperations() {
  return taskOperations().filter(operation => operation.status === 'pending');
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

function comparableOperationPath(value) {
  return normalizePath(taskRelative(value)).toLowerCase();
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
  const wanted = comparableOperationPath(file?.path);
  const change = (operation.changes || []).find(item => comparableOperationPath(item.path) === wanted);
  if (!change) return stored;
  const before = snapshotText(change.before);
  const after = snapshotText(change.after);
  if (before === null || after === null) return stored;
  return buildBrowserUnifiedDiff(before, after);
}

function operationFileSnapshots(operation, file) {
  const wanted = comparableOperationPath(file?.path);
  const change = (operation.changes || []).find(item => comparableOperationPath(item.path) === wanted);
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
  for (const operation of taskOperations()) {
    if (!operation.sessionId) continue;
    const matched = (operation.changes || []).find(change => !change.undone && normalizePath(taskRelative(change.path)).toLowerCase() === wanted);
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
  const pending = pendingOperations();
  renderAgentFilter(entries);
  $('change-count').textContent = entries.length;
  $('filter-all-count').textContent = entries.length;
  $('filter-modified-count').textContent = entries.filter(item => item.unstaged).length;
  $('filter-staged-count').textContent = entries.filter(item => item.staged).length;
  $('filter-added-count').textContent = entries.filter(item => item.untracked).length;
  $('change-summary-title').textContent = state.gitError ? 'Git unavailable' : entries.length ? `${entries.length} file${entries.length === 1 ? '' : 's'} changed` : 'No changes';
  $('change-summary-sub').textContent = state.gitError || (state.git?.branch ? `${state.git.branch}${state.git.ahead ? ` · ↑${state.git.ahead}` : ''}${state.git.behind ? ` · ↓${state.git.behind}` : ''}` : 'Working tree clean');
  $('status-changes').textContent = `${entries.length} change${entries.length === 1 ? '' : 's'}`;
  const scoped = state.changeFilter !== 'all' || state.agentFilter !== 'all';
  $('review-button').textContent = pending.length
    ? `Review ${pending.length} approval${pending.length === 1 ? '' : 's'}`
    : `Review ${filtered.length} change${filtered.length === 1 ? '' : 's'}${scoped ? ' visible' : ''}`;
  $('review-button').disabled = !filtered.length && !pending.length;
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
      const action = change.untracked && !change.staged && !change.unstaged
        ? openFile(change.path, { meta: touch ? `${touch.label} · ${touch.tool}` : 'Local / external' })
        : openGitDiff(change.path, !change.unstaged && change.staged, { meta: touch ? `${touch.label} · ${touch.tool}` : 'Local / external' });
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
  if (!rows.length) $('changes-list').append(el('p', entries.length ? 'Không có file trong bộ lọc này.' : 'Working tree clean.', 'empty-copy'));
}

function renderApprovals() {
  const pending = pendingOperations();
  $('approval-count').textContent = pending.length;
  const cards = pending.map(operation => {
    const card = el('button', undefined, 'approval-card');
    card.type = 'button';
    const head = el('div', undefined, 'approval-card-head');
    const owner = operation.sessionId ? agentLabel(operation.sessionId) : 'Local / external';
    head.append(el('strong', operation.tool), el('span', `${owner} · ${operation.review?.files?.length || operation.changes?.length || 0} files`));
    card.append(head, el('p', operation.review ? `+${operation.review.additions || 0} −${operation.review.deletions || 0} · awaiting approval` : `${owner} · awaiting approval`));
    card.onclick = () => void openOperationReview(operation.id).catch(error => setStatus(error.message));
    return card;
  });
  $('approvals-list').replaceChildren(...cards);
  if (!cards.length) $('approvals-list').append(el('p', 'Không có thao tác chờ duyệt.', 'empty-copy'));
}

export async function loadChanges() {
  if (!state.taskId) return;
  try {
    const git = await api(`/api/workbench/tasks/${state.taskId}/git/status`);
    state.git = git;
    state.gitError = null;
    state.changes = enrichChanges(mergeChanges(git));
    state.changeByPath = new Map(state.changes.map(change => [change.path, change]));
  } catch (error) {
    state.git = null;
    state.gitError = error.message;
    state.changes = [];
    state.changeByPath = new Map();
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
  const files = operation.review?.files || [];
  $('review-title').textContent = `${operation.tool} · ${files.length || operation.changes?.length || 0} files`;
  const owner = operation.sessionId ? agentLabel(operation.sessionId) : 'Local / external';
  const reviewNote = $('review-note');
  const additions = operation.review?.additions || 0;
  const deletions = operation.review?.deletions || 0;
  reviewNote.replaceChildren(
    el('strong', owner, 'review-owner'),
    el('span', operation.status === 'pending' ? 'Preview before approval' : 'Actual operation diff', `review-mode ${operation.status === 'pending' ? 'pending' : 'actual'}`),
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
    head.append(el('strong', taskRelative(file.path)), meta);
    const diff = el('div', undefined, 'diff-view codex-review-diff');
    const renderedDiff = operationFileDiff(operation, file);
    if (renderedDiff) renderUnifiedDiff(diff, renderedDiff);
    else diff.append(el('p', file.note || 'Không có text diff.', 'empty-copy'));
    block.append(head, diff);
    renderTargets.push({ host: diff, file });
    return block;
  });
  $('review-files').replaceChildren(...blocks);
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

export async function openOperationFileDiff(id, path) {
  const operation = await api(`/api/workbench/operations/${id}`);
  const wanted = comparableOperationPath(path);
  const file = (operation.review?.files || []).find(item => comparableOperationPath(item.path) === wanted);
  const renderedDiff = file ? operationFileDiff(operation, file) : '';
  if (!renderedDiff) throw new Error('Operation này không có text diff cho file đã chọn.');
  const owner = operation.sessionId ? agentLabel(operation.sessionId) : 'Local / external';
  openTextDiff({
    id: `operation-diff:${operation.id}:${file.path}`,
    path: file.path,
    title: taskRelative(file.path),
    content: renderedDiff,
    meta: `${owner} · ${operation.tool} · +${file.additions || 0} −${file.deletions || 0}`,
  });
}

export async function decideCurrentOperation(approve) {
  if (!state.currentOperationId) return;
  await api(`/api/workbench/operations/${state.currentOperationId}/decision`, { method: 'POST', body: { approve } });
  state.currentOperationId = null;
  $('review-dialog').close();
  window.dispatchEvent(new CustomEvent('workbench:refresh-request', { detail: { scopes: ['operations', 'workspace'], taskId: state.taskId } }));
}

export function openPrimaryReview() {
  const pending = pendingOperations();
  if (pending.length) return openOperationReview(pending[0].id);
  const change = state.changes.find(matchesFilter);
  if (!change) return Promise.resolve();
  const meta = change.agentTouch ? `${change.agentTouch.label} · ${change.agentTouch.tool}` : 'Local / external';
  return change.untracked && !change.staged && !change.unstaged
    ? openFile(change.path, { meta })
    : openGitDiff(change.path, !change.unstaged && change.staged, { meta });
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
  $('approvals-panel').hidden = tab !== 'approvals';
  $('history-panel').hidden = tab !== 'history';
}