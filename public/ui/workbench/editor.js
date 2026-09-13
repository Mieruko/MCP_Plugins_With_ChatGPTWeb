import { api } from './api.js';
import { state } from './state.js';
import { $, basename, el, renderCode, renderUnifiedDiff, setStatus } from './dom.js';
import { languageForPath, loadMonaco, reconstructUnifiedDiff } from './monaco.js';

let codeEditor;
const diffEditors = { original: null, modified: null };
const diffScrollListeners = { original: null, modified: null };
let diffScrollSyncEnabled = true;
let diffScrollSyncGuard = false;
let lastDiffScrollSide = 'original';
let resizeObserver;
const monacoModels = new Map();
const modelListeners = new Map();
const diffLineDecorations = { original: [], modified: [] };
const REVIEW_PREVIEW_TAB_ID = 'review-preview';

function currentTab() {
  return state.tabs.find(item => item.id === state.activeTabId);
}

function updateSaveState() {
  const tab = currentTab();
  const save = $('save-editor');
  if (!save) return;
  if (tab?.pendingOperationId) {
    save.disabled = true;
    save.textContent = 'Pending';
    return;
  }
  save.disabled = !tab || tab.type !== 'file' || tab.preview || !tab.dirty;
  save.textContent = tab?.type === 'file' && tab.dirty ? 'Save *' : 'Save';
}

function parseApproval(result) {
  const text = result?.content?.find?.(item => item?.type === 'text')?.text;
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function tabId(type, path, staged = false) {
  return `${type}:${staged ? 'staged:' : ''}${path}`;
}

function upsertTab(tab) {
  const index = state.tabs.findIndex(item => item.id === tab.id);
  if (index >= 0) {
    disposeTabModels(tab.id);
    state.tabs[index] = tab.preview ? tab : { ...state.tabs[index], ...tab };
  }
  else state.tabs.push(tab);
  state.activeTabId = tab.id;
  renderTabs();
  void renderActiveTab();
}

function disposeModels(models) {
  if (!models) return;
  for (const model of Object.values(models)) model?.dispose?.();
}

function disposeTabModels(id) {
  modelListeners.get(id)?.dispose?.();
  modelListeners.delete(id);
  disposeModels(monacoModels.get(id));
  monacoModels.delete(id);
}

function closeTab(id) {
  const index = state.tabs.findIndex(tab => tab.id === id);
  if (index < 0) return;
  const closing = state.tabs[index];
  if ((closing.dirty || closing.pendingOperationId) && !confirm(`Close ${closing.title} and discard the editor buffer?`)) return;
  const wasActive = state.activeTabId === id;
  disposeTabModels(id);
  state.tabs.splice(index, 1);
  if (wasActive) state.activeTabId = state.tabs[Math.max(0, index - 1)]?.id || state.tabs[0]?.id || null;
  renderTabs();
  void renderActiveTab();
}

function renderTabs() {
  const target = $('editor-tabs');
  target.replaceChildren(...state.tabs.map(tab => {
    const button = el('button', undefined, `editor-tab${tab.id === state.activeTabId ? ' active' : ''}${tab.preview ? ' preview' : ''}`);
    button.type = 'button';
    const marker = tab.pendingOperationId ? ' [pending]' : tab.dirty ? ' *' : '';
    button.append(el('span', `${tab.preview ? 'Preview · ' : ''}${tab.type === 'diff' ? '± ' : ''}${tab.title}${marker}`));
    const close = el('b', '×');
    close.onclick = event => { event.stopPropagation(); closeTab(tab.id); };
    button.append(close);
    button.onclick = () => { state.activeTabId = tab.id; renderTabs(); void renderActiveTab(); };
    return button;
  }));
}

function editorOptions(readOnly = true) {
  return {
    theme: 'workbench-dark',
    readOnly,
    domReadOnly: readOnly,
    lineNumbers: 'on',
    lineNumbersMinChars: 4,
    automaticLayout: false,
    fontSize: 12,
    lineHeight: 19,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    renderWhitespace: 'selection',
    wordWrap: 'off',
    stickyScroll: { enabled: true },
    padding: { top: 8, bottom: 8 },
  };
}

function ensureResizeObserver() {
  if (resizeObserver || typeof ResizeObserver === 'undefined') return;
  resizeObserver = new ResizeObserver(() => {
    if (!$('code-view').hidden) codeEditor?.layout();
    if (!$('diff-view').hidden) {
      diffEditors.original?.layout();
      diffEditors.modified?.layout();
    }
  });
  resizeObserver.observe($('code-view'));
  resizeObserver.observe($('diff-view'));
}

function modelUri(monaco, tab, suffix = '') {
  const safe = encodeURIComponent(tab.id).replace(/%/g, '_');
  return monaco.Uri.parse(`inmemory://workbench/${safe}${suffix}`);
}

function fileModel(monaco, tab) {
  let models = monacoModels.get(tab.id);
  if (!models) {
    models = {
      file: monaco.editor.createModel(tab.content || '', languageForPath(tab.path), modelUri(monaco, tab)),
    };
    monacoModels.set(tab.id, models);
    modelListeners.set(tab.id, models.file.onDidChangeContent(() => {
      if (tab.pendingOperationId) return;
      tab.content = models.file.getValue();
      tab.dirty = tab.content !== tab.savedContent;
      renderTabs();
      updateSaveState();
    }));
  }
  return models.file;
}

function diffModels(monaco, tab) {
  let models = monacoModels.get(tab.id);
  if (models) return models;
  const pair = alignDiffPair(reconstructUnifiedDiff(tab.content || ''));
  if (!pair.parsed) return null;
  const language = languageForPath(tab.path);
  models = {
    original: monaco.editor.createModel(pair.original, language, modelUri(monaco, tab, '-original')),
    modified: monaco.editor.createModel(pair.modified, language, modelUri(monaco, tab, '-modified')),
    originalLineNumbers: pair.originalLineNumbers,
    modifiedLineNumbers: pair.modifiedLineNumbers,
    originalKinds: pair.originalKinds,
    modifiedKinds: pair.modifiedKinds,
    originalIntraline: pair.originalIntraline,
    modifiedIntraline: pair.modifiedIntraline,
  };
  monacoModels.set(tab.id, models);
  return models;
}

function alignDiffPair(pair) {
  if (!pair?.parsed) return pair;
  const originalLines = pair.originalKinds.length ? pair.original.split('\n') : [];
  const modifiedLines = pair.modifiedKinds.length ? pair.modified.split('\n') : [];
  const aligned = {
    original: [],
    modified: [],
    originalLineNumbers: [],
    modifiedLineNumbers: [],
    originalKinds: [],
    modifiedKinds: [],
    parsed: true,
  };
  const pushOriginal = (index, fallbackKind = 'gap') => {
    if (index == null) {
      aligned.original.push('');
      aligned.originalLineNumbers.push(null);
      aligned.originalKinds.push(fallbackKind);
      return;
    }
    aligned.original.push(originalLines[index] ?? '');
    aligned.originalLineNumbers.push(pair.originalLineNumbers[index] ?? null);
    aligned.originalKinds.push(pair.originalKinds[index] || fallbackKind);
  };
  const pushModified = (index, fallbackKind = 'gap') => {
    if (index == null) {
      aligned.modified.push('');
      aligned.modifiedLineNumbers.push(null);
      aligned.modifiedKinds.push(fallbackKind);
      return;
    }
    aligned.modified.push(modifiedLines[index] ?? '');
    aligned.modifiedLineNumbers.push(pair.modifiedLineNumbers[index] ?? null);
    aligned.modifiedKinds.push(pair.modifiedKinds[index] || fallbackKind);
  };

  let originalIndex = 0;
  let modifiedIndex = 0;
  while (originalIndex < pair.originalKinds.length || modifiedIndex < pair.modifiedKinds.length) {
    const originalKind = pair.originalKinds[originalIndex];
    const modifiedKind = pair.modifiedKinds[modifiedIndex];
    if (originalKind === 'remove' || modifiedKind === 'add') {
      const removals = [];
      const additions = [];
      while (pair.originalKinds[originalIndex] === 'remove') removals.push(originalIndex++);
      while (pair.modifiedKinds[modifiedIndex] === 'add') additions.push(modifiedIndex++);
      const rows = Math.max(removals.length, additions.length);
      for (let row = 0; row < rows; row += 1) {
        pushOriginal(removals[row] ?? null);
        pushModified(additions[row] ?? null);
      }
      continue;
    }
    pushOriginal(originalIndex < pair.originalKinds.length ? originalIndex++ : null);
    pushModified(modifiedIndex < pair.modifiedKinds.length ? modifiedIndex++ : null);
  }

  return {
    ...pair,
    original: aligned.original.join('\n'),
    modified: aligned.modified.join('\n'),
    originalLineNumbers: aligned.originalLineNumbers,
    modifiedLineNumbers: aligned.modifiedLineNumbers,
    originalKinds: aligned.originalKinds,
    modifiedKinds: aligned.modifiedKinds,
  };
}

function decorateDiffLineNumbers(monaco, editor, kinds, side) {
  const decorations = (kinds || []).flatMap((kind, index) => {
    if (kind !== 'add' && kind !== 'remove') return [];
    const line = index + 1;
    const lineNumberClassName = kind === 'add' ? 'workbench-diff-line-number-add' : 'workbench-diff-line-number-remove';
    const changeBarClassName = kind === 'add' ? 'workbench-diff-change-bar-add' : 'workbench-diff-change-bar-remove';
    const lineClassName = kind === 'add' ? 'workbench-diff-line-add' : 'workbench-diff-line-remove';
    const marginClassName = kind === 'add' ? 'workbench-diff-margin-add' : 'workbench-diff-margin-remove';
    return [{
      range: new monaco.Range(line, 1, line, 1),
      options: {
        isWholeLine: true,
        className: lineClassName,
        marginClassName,
        lineNumberClassName,
        linesDecorationsClassName: changeBarClassName,
      },
    }];
  });
  diffLineDecorations[side] = editor.deltaDecorations(diffLineDecorations[side], decorations);
}

function clearDiffLineDecorations() {
  if (diffEditors.original) diffLineDecorations.original = diffEditors.original.deltaDecorations(diffLineDecorations.original, []);
  if (diffEditors.modified) diffLineDecorations.modified = diffEditors.modified.deltaDecorations(diffLineDecorations.modified, []);
}

function updateDiffSyncControl(visible = false) {
  const button = $('diff-sync-scroll');
  if (!button) return;
  button.hidden = !visible;
  button.classList.toggle('active', diffScrollSyncEnabled);
  button.setAttribute('aria-pressed', String(diffScrollSyncEnabled));
  button.textContent = diffScrollSyncEnabled ? '⇅ Sync scroll' : '⇅ Independent';
  button.title = diffScrollSyncEnabled
    ? 'Vertical scrolling is synchronized. Click for independent panes.'
    : 'Diff panes scroll independently. Click to synchronize them.';
}

function syncDiffScroll(sourceSide, event) {
  if (!event?.scrollTopChanged) return;
  lastDiffScrollSide = sourceSide;
  if (!diffScrollSyncEnabled || diffScrollSyncGuard) return;
  const source = diffEditors[sourceSide];
  const target = diffEditors[sourceSide === 'original' ? 'modified' : 'original'];
  if (!source || !target) return;
  const nextTop = source.getScrollTop();
  if (Math.abs(target.getScrollTop() - nextTop) < 1) return;
  diffScrollSyncGuard = true;
  try { target.setScrollTop(nextTop); }
  finally { diffScrollSyncGuard = false; }
}

function toggleDiffScrollSync() {
  diffScrollSyncEnabled = !diffScrollSyncEnabled;
  if (diffScrollSyncEnabled) {
    const source = diffEditors[lastDiffScrollSide] || diffEditors.original;
    const target = diffEditors[lastDiffScrollSide === 'original' ? 'modified' : 'original'];
    if (source && target) {
      diffScrollSyncGuard = true;
      try { target.setScrollTop(source.getScrollTop()); }
      finally { diffScrollSyncGuard = false; }
    }
  }
  updateDiffSyncControl(Boolean(currentTab()?.type === 'diff'));
}

function disposeIndependentDiffEditors() {
  for (const side of ['original', 'modified']) {
    diffScrollListeners[side]?.dispose?.();
    diffScrollListeners[side] = null;
    diffLineDecorations[side] = [];
    diffEditors[side]?.dispose?.();
    diffEditors[side] = null;
  }
}

function ensureIndependentDiffEditors(monaco, host) {
  if (diffEditors.original && diffEditors.modified) return diffEditors;
  host.replaceChildren();
  host.classList.add('monaco-host', 'independent-diff-host');
  const originalHost = el('div', undefined, 'independent-diff-pane original');
  const modifiedHost = el('div', undefined, 'independent-diff-pane modified');
  host.append(originalHost, modifiedHost);
  diffEditors.original = monaco.editor.create(originalHost, {
    ...editorOptions(true),
    ariaLabel: 'Original file',
    scrollbar: { vertical: 'visible', horizontal: 'visible' },
  });
  diffEditors.modified = monaco.editor.create(modifiedHost, {
    ...editorOptions(true),
    ariaLabel: 'Modified file',
    scrollbar: { vertical: 'visible', horizontal: 'visible' },
  });
  diffScrollListeners.original = diffEditors.original.onDidScrollChange(event => syncDiffScroll('original', event));
  diffScrollListeners.modified = diffEditors.modified.onDidScrollChange(event => syncDiffScroll('modified', event));
  return diffEditors;
}

function renderLegacy(tab, code, diff) {
  code.classList.remove('monaco-host');
  if (tab.type === 'diff') disposeIndependentDiffEditors();
  diff.classList.remove('monaco-host', 'independent-diff-host');
  if (tab.type === 'diff') renderUnifiedDiff(diff, tab.content || 'No changes');
  else renderCode(code, tab.content || '');
}

async function renderActiveTab() {
  const tab = state.tabs.find(item => item.id === state.activeTabId);
  const empty = $('editor-empty'), code = $('code-view'), diff = $('diff-view');
  if (!tab) {
    empty.hidden = false; code.hidden = true; diff.hidden = true;
    updateDiffSyncControl(false);
    $('editor-breadcrumb').textContent = 'Workspace'; $('editor-breadcrumb').title = ''; $('editor-kind').textContent = 'FILE'; $('editor-meta').textContent = '—';
    updateSaveState();
    return;
  }
  empty.hidden = true;
  $('editor-breadcrumb').textContent = tab.path.replace(/\\/g, '  ›  ');
  $('editor-breadcrumb').title = tab.path;
  const renderId = tab.id;
  let monaco;
  try { monaco = await loadMonaco(); }
  catch {
    if (state.activeTabId !== renderId) return;
    if (tab.type === 'diff') { code.hidden = true; diff.hidden = false; }
    else { diff.hidden = true; code.hidden = false; }
    renderLegacy(tab, code, diff);
    $('editor-kind').textContent = tab.type === 'diff' ? (tab.staged ? 'STAGED DIFF' : 'DIFF') : 'FILE';
    $('editor-meta').textContent = tab.meta || 'Fallback renderer';
    return;
  }
  if (state.activeTabId !== renderId) return;
  ensureResizeObserver();
  if (tab.type === 'diff') {
    updateDiffSyncControl(true);
    code.hidden = true; diff.hidden = false;
    const models = diffModels(monaco, tab);
    if (!models) {
      renderLegacy(tab, code, diff);
      $('editor-kind').textContent = tab.staged ? 'STAGED DIFF' : 'DIFF';
      $('editor-meta').textContent = tab.meta || 'Unified diff';
      return;
    }
    const panes = ensureIndependentDiffEditors(monaco, diff);
    clearDiffLineDecorations();
    panes.original.setModel(models.original);
    panes.modified.setModel(models.modified);
    panes.original.updateOptions({
      lineNumbers: line => models.originalLineNumbers?.[line - 1] == null ? '' : String(models.originalLineNumbers[line - 1]),
      lineNumbersMinChars: 4,
    });
    panes.modified.updateOptions({
      lineNumbers: line => models.modifiedLineNumbers?.[line - 1] == null ? '' : String(models.modifiedLineNumbers[line - 1]),
      lineNumbersMinChars: 4,
    });
    decorateDiffLineNumbers(monaco, panes.original, models.originalKinds, 'original');
    decorateDiffLineNumbers(monaco, panes.modified, models.modifiedKinds, 'modified');
    panes.original.layout();
    panes.modified.layout();
    $('editor-kind').textContent = tab.staged ? 'STAGED DIFF · MONACO' : 'DIFF · MONACO';
    $('editor-meta').textContent = `${tab.meta || 'Git'} · dual viewport`;
  } else {
    updateDiffSyncControl(false);
    diff.hidden = true; code.hidden = false;
    code.classList.add('monaco-host');
    if (!codeEditor) {
      code.replaceChildren();
      codeEditor = monaco.editor.create(code, editorOptions(false));
      codeEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { void saveActiveEditor(); });
    }
    codeEditor.setModel(fileModel(monaco, tab));
    const readOnly = Boolean(tab.pendingOperationId || tab.preview);
    codeEditor.updateOptions({ readOnly, domReadOnly: readOnly });
    codeEditor.layout();
    $('editor-kind').textContent = tab.pendingOperationId ? 'FILE · MONACO · PENDING' : tab.preview ? 'FILE · MONACO · PREVIEW' : 'FILE · MONACO';
    const meta = tab.meta || `${codeEditor.getModel()?.getLineCount() || 0} lines`;
    $('editor-meta').textContent = tab.pendingOperationId ? `${meta} · awaiting approval` : meta;
  }
  updateSaveState();
}

const diffSyncScrollButton = $('diff-sync-scroll');
if (diffSyncScrollButton) diffSyncScrollButton.onclick = toggleDiffScrollSync;

export async function openFile(path, options = {}) {
  const id = options.preview ? REVIEW_PREVIEW_TAB_ID : tabId('file', path);
  const cached = state.tabs.find(tab => tab.id === id);
  if (cached && cached.type === 'file' && cached.path === path && cached.taskId === state.taskId && !options.reload) {
    state.activeTabId = id; renderTabs(); void renderActiveTab(); return;
  }
  setStatus(`Opening ${basename(path)}…`);
  const taskId = state.taskId;
  const file = await api(`/api/workbench/tasks/${taskId}/file?path=${encodeURIComponent(path)}`);
  if (taskId !== state.taskId) return;
  const content = file.content || '';
  upsertTab({ id, taskId, type: 'file', path, title: basename(path), content, savedContent: content, dirty: false, pendingOperationId: null, preview: Boolean(options.preview), sourceMeta: options.meta || '', meta: options.meta || (file.lines ? `${file.lines} lines` : 'file') });
  setStatus('Ready');
}

export async function openGitDiff(path, staged = false, options = {}) {
  setStatus(`Loading diff ${basename(path)}…`);
  const result = await api(`/api/workbench/tasks/${state.taskId}/git`, {
    method: 'POST',
    body: { tool: 'git_diff', args: { file: path, staged } },
  });
  const content = result?.structuredContent?.data?.output || result?.output || 'No changes';
  const baseMeta = staged ? 'index ↔ HEAD' : 'working tree ↔ index';
  upsertTab({ id: options.preview ? REVIEW_PREVIEW_TAB_ID : tabId('diff', path, staged), type: 'diff', path, title: basename(path), staged, content, preview: Boolean(options.preview), sourceMeta: options.meta || '', meta: options.meta ? `${baseMeta} · ${options.meta}` : baseMeta });
  setStatus('Ready');
}

export function openTextDiff({ id, path, title, content, meta, preview = false }) {
  upsertTab({ id: preview ? REVIEW_PREVIEW_TAB_ID : (id || tabId('diff', path)), type: 'diff', path, title: title || basename(path), staged: false, content, meta, preview });
}

function normalizedEditorPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '').toLowerCase();
}

function absoluteEditorPath(value, taskId = state.taskId) {
  const normalized = normalizedEditorPath(value);
  if (!normalized) return '';
  if (/^[a-z]:\//i.test(normalized) || normalized.startsWith('/')) return normalized;
  const task = (state.data?.tasks || []).find(item => item.id === taskId);
  const root = normalizedEditorPath(task?.execution?.path || task?.workspace || '');
  return root ? `${root}/${normalized}` : normalized;
}

export function invalidateRestoredEditorTabs({ taskId, changeSetId, paths = [] } = {}) {
  if (taskId && state.taskId && taskId !== state.taskId) return false;
  const affected = new Set(paths.map(path => absoluteEditorPath(path, taskId)).filter(Boolean));
  let changed = false;
  let activeRemoved = false;
  state.tabs = state.tabs.filter(tab => {
    const fromChangeSet = Boolean(changeSetId && tab.id.startsWith(`change-set-diff:${changeSetId}:`));
    const samePath = affected.has(absoluteEditorPath(tab.path, taskId));
    if (!fromChangeSet && !samePath) return true;
    if (tab.type === 'file' && (tab.dirty || tab.pendingOperationId)) return true;
    disposeTabModels(tab.id);
    if (tab.id === state.activeTabId) activeRemoved = true;
    changed = true;
    return false;
  });
  if (!changed) return false;
  if (activeRemoved) state.activeTabId = state.tabs.at(-1)?.id || null;
  renderTabs();
  void renderActiveTab();
  return true;
}

export function resetEditor() {
  for (const id of [...monacoModels.keys()]) disposeTabModels(id);
  state.tabs = []; state.activeTabId = null; renderTabs(); void renderActiveTab();
}

export function hasUnsavedEditorChanges() {
  return state.tabs.some(tab => tab.type === 'file' && (tab.dirty || tab.pendingOperationId));
}

export function reconcileEditorState() {
  let changed = false;
  for (const tab of state.tabs) {
    if (!tab.pendingOperationId) continue;
    const operation = (state.data?.operations || []).find(item => item.id === tab.pendingOperationId);
    if (!operation || ['pending', 'running'].includes(operation.status)) continue;
    tab.pendingOperationId = null;
    if (operation.status === 'completed') {
      tab.savedContent = tab.content;
      tab.dirty = false;
    } else {
      tab.dirty = tab.content !== tab.savedContent;
    }
    changed = true;
  }
  if (changed) {
    renderTabs();
    void renderActiveTab();
  } else updateSaveState();
}

export async function saveActiveEditor() {
  const tab = currentTab();
  if (!tab || tab.type !== 'file' || tab.preview || !tab.dirty || tab.pendingOperationId) return;
  if (tab.taskId && tab.taskId !== state.taskId) {
    setStatus('This buffer belongs to another task. Return to that task before saving; your unsaved text is preserved.');
    return;
  }
  setStatus(`Saving ${tab.title}...`);
  const result = await api(`/api/workbench/tasks/${state.taskId}/file`, { method: 'PUT', body: { path: tab.path, content: tab.content } });
  const approval = parseApproval(result);
  if (approval?.status === 'approval_required') {
    tab.pendingOperationId = approval.operation_id;
    renderTabs();
    void renderActiveTab();
    setStatus(`Save awaiting approval - ${tab.title}`);
    window.dispatchEvent(new CustomEvent('workbench:refresh-request', { detail: { scopes: ['operations'], taskId: state.taskId } }));
    return approval;
  }
  tab.savedContent = tab.content;
  tab.dirty = false;
  renderTabs();
  updateSaveState();
  setStatus(`Saved ${tab.title}`);
  window.dispatchEvent(new CustomEvent('workbench:refresh-request', { detail: { scopes: ['operations', 'workspace'], taskId: state.taskId } }));
  return result;
}

export async function reloadActiveEditor() {
  const tab = state.tabs.find(item => item.id === state.activeTabId);
  if (!tab) return;
  if (tab.type === 'file' && (tab.dirty || tab.pendingOperationId) && !confirm(`Reload ${tab.title} from disk and discard the editor buffer?`)) return;
  if (tab.type === 'file') await openFile(tab.path, { reload: true, meta: tab.sourceMeta, preview: Boolean(tab.preview) });
  else if (tab.type === 'diff' && !tab.id.startsWith('operation:')) await openGitDiff(tab.path, tab.staged, { meta: tab.sourceMeta, preview: Boolean(tab.preview) });
}
