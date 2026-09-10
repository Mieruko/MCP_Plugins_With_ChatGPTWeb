import { api } from './api.js';
import { state } from './state.js';
import { $, el, joinPath, parentPath, setStatus } from './dom.js';
import { openFile } from './editor.js';

function statusFor(path) {
  const change = state.changeByPath.get(String(path).replace(/\\/g, '/'));
  if (!change) return '';
  if (change.untracked) return 'A';
  const code = change.statuses.find(code => code && code !== '?');
  return code || 'M';
}

export async function loadTree(path = state.currentTreePath) {
  if (!state.taskId) return;
  const nextPath = path || '.';
  setStatus(`Reading ${nextPath}…`);
  const tree = await api(`/api/workbench/tasks/${state.taskId}/tree?path=${encodeURIComponent(nextPath)}`);
  state.currentTreePath = nextPath;
  $('tree-path').textContent = nextPath;
  $('tree-up').disabled = nextPath === '.';
  const entries = [...(tree.entries || [])].sort((a, b) => a.type === b.type
    ? a.name.localeCompare(b.name)
    : a.type === 'directory' ? -1 : 1);
  const rows = entries.map(entry => {
    const fullPath = joinPath(nextPath, entry.name);
    const row = el('button', undefined, `file-row ${entry.type}`);
    row.type = 'button';
    row.append(el('span', entry.type === 'directory' ? '▸' : '·', 'file-icon'), el('span', entry.name));
    if (entry.type !== 'directory') row.append(el('span', statusFor(fullPath), 'file-status'));
    else row.append(el('span', '', 'file-status'));
    row.onclick = () => {
      if (entry.type === 'directory') void loadTree(fullPath).catch(error => setStatus(error.message));
      else void openFile(fullPath).catch(error => setStatus(error.message));
    };
    return row;
  });
  $('file-tree').replaceChildren(...rows);
  if (!rows.length) $('file-tree').append(el('p', 'Thư mục trống.', 'empty-copy'));
  setStatus('Ready');
}

export async function goUpTree() {
  await loadTree(parentPath(state.currentTreePath));
}

export async function searchWorkspace(query) {
  const value = String(query || '').trim();
  if (!value || !state.taskId) {
    $('search-results').replaceChildren();
    return;
  }
  const result = await api(`/api/workbench/tasks/${state.taskId}/search`, {
    method: 'POST',
    body: { query: value, glob: '*', caseInsensitive: true, mode: 'content', maxResults: 80 },
  });
  const pre = el('pre', result.output || 'No matches');
  $('search-results').replaceChildren(pre);
}