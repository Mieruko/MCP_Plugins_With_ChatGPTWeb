import { api } from './api.js';
import { state } from './state.js';
import { $, basename, el, renderCode, renderUnifiedDiff, setStatus } from './dom.js';
import { languageForPath, loadMonaco, reconstructUnifiedDiff } from './monaco.js';

let codeEditor;
let diffEditor;
let resizeObserver;
const monacoModels = new Map();
const modelListeners = new Map();

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
  save.disabled = !tab || tab.type !== 'file' || !tab.dirty;
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
    state.tabs[index] = { ...state.tabs[index], ...tab };
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
    const button = el('button', undefined, `editor-tab${tab.id === state.activeTabId ? ' active' : ''}`);
    button.type = 'button';
    const marker = tab.pendingOperationId ? ' [pending]' : tab.dirty ? ' *' : '';
    button.append(el('span', `${tab.type === 'diff' ? '± ' : ''}${tab.title}${marker}`));
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
    if (!$('diff-view').hidden) diffEditor?.layout();
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
  const pair = reconstructUnifiedDiff(tab.content || '');
  if (!pair.parsed) return null;
  const language = languageForPath(tab.path);
  models = {
    original: monaco.editor.createModel(pair.original, language, modelUri(monaco, tab, '-original')),
    modified: monaco.editor.createModel(pair.modified, language, modelUri(monaco, tab, '-modified')),
    originalLineNumbers: pair.originalLineNumbers,
    modifiedLineNumbers: pair.modifiedLineNumbers,
  };
  monacoModels.set(tab.id, models);
  return models;
}

function renderLegacy(tab, code, diff) {
  code.classList.remove('monaco-host');
  diff.classList.remove('monaco-host');
  if (tab.type === 'diff') renderUnifiedDiff(diff, tab.content || 'No changes');
  else renderCode(code, tab.content || '');
}

async function renderActiveTab() {
  const tab = state.tabs.find(item => item.id === state.activeTabId);
  const empty = $('editor-empty'), code = $('code-view'), diff = $('diff-view');
  if (!tab) {
    empty.hidden = false; code.hidden = true; diff.hidden = true;
    $('editor-breadcrumb').textContent = 'Workspace'; $('editor-kind').textContent = 'FILE'; $('editor-meta').textContent = '—';
    updateSaveState();
    return;
  }
  empty.hidden = true;
  $('editor-breadcrumb').textContent = tab.path.replace(/\\/g, '  ›  ');
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
    code.hidden = true; diff.hidden = false;
    const models = diffModels(monaco, tab);
    if (!models) {
      renderLegacy(tab, code, diff);
      $('editor-kind').textContent = tab.staged ? 'STAGED DIFF' : 'DIFF';
      $('editor-meta').textContent = tab.meta || 'Unified diff';
      return;
    }
    diff.classList.add('monaco-host');
    if (!diffEditor) {
      diff.replaceChildren();
      diffEditor = monaco.editor.createDiffEditor(diff, {
        ...editorOptions(),
        originalEditable: false,
        renderSideBySide: true,
        useInlineViewWhenSpaceIsLimited: true,
        enableSplitViewResizing: true,
        renderOverviewRuler: true,
      });
    }
    diffEditor.setModel({ original: models.original, modified: models.modified });
    diffEditor.getOriginalEditor().updateOptions({
      lineNumbers: line => models.originalLineNumbers?.[line - 1] == null ? '' : String(models.originalLineNumbers[line - 1]),
      lineNumbersMinChars: 4,
    });
    diffEditor.getModifiedEditor().updateOptions({
      lineNumbers: line => models.modifiedLineNumbers?.[line - 1] == null ? '' : String(models.modifiedLineNumbers[line - 1]),
      lineNumbersMinChars: 4,
    });
    diffEditor.layout();
    $('editor-kind').textContent = tab.staged ? 'STAGED DIFF · MONACO' : 'DIFF · MONACO';
    $('editor-meta').textContent = `${tab.meta || 'Git'} · changed hunks`;
  } else {
    diff.hidden = true; code.hidden = false;
    code.classList.add('monaco-host');
    if (!codeEditor) {
      code.replaceChildren();
      codeEditor = monaco.editor.create(code, editorOptions(false));
      codeEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { void saveActiveEditor(); });
    }
    codeEditor.setModel(fileModel(monaco, tab));
    codeEditor.updateOptions({ readOnly: Boolean(tab.pendingOperationId), domReadOnly: Boolean(tab.pendingOperationId) });
    codeEditor.layout();
    $('editor-kind').textContent = tab.pendingOperationId ? 'FILE · MONACO · PENDING' : 'FILE · MONACO';
    const meta = tab.meta || `${codeEditor.getModel()?.getLineCount() || 0} lines`;
    $('editor-meta').textContent = tab.pendingOperationId ? `${meta} · awaiting approval` : meta;
  }
  updateSaveState();
}

export async function openFile(path, options = {}) {
  const id = tabId('file', path);
  const cached = state.tabs.find(tab => tab.id === id);
  if (cached && !options.reload) {
    state.activeTabId = id; renderTabs(); void renderActiveTab(); return;
  }
  setStatus(`Opening ${basename(path)}…`);
  const file = await api(`/api/workbench/tasks/${state.taskId}/file?path=${encodeURIComponent(path)}`);
  const content = file.content || '';
  upsertTab({ id, type: 'file', path, title: basename(path), content, savedContent: content, dirty: false, pendingOperationId: null, sourceMeta: options.meta || '', meta: options.meta || (file.lines ? `${file.lines} lines` : 'file') });
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
  upsertTab({ id: tabId('diff', path, staged), type: 'diff', path, title: basename(path), staged, content, sourceMeta: options.meta || '', meta: options.meta ? `${baseMeta} · ${options.meta}` : baseMeta });
  setStatus('Ready');
}

export function openTextDiff({ id, path, title, content, meta }) {
  upsertTab({ id: id || tabId('diff', path), type: 'diff', path, title: title || basename(path), staged: false, content, meta });
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
  if (!tab || tab.type !== 'file' || !tab.dirty || tab.pendingOperationId) return;
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
  if (tab.type === 'file') await openFile(tab.path, { reload: true, meta: tab.sourceMeta });
  else if (tab.type === 'diff' && !tab.id.startsWith('operation:')) await openGitDiff(tab.path, tab.staged, { meta: tab.sourceMeta });
}