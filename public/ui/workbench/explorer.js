import { api } from './api.js';
import { state } from './state.js';
import { $, basename, el, joinPath, setStatus } from './dom.js';
import { openFile } from './editor.js';

const expandedDirectories = new Set();
const directoryCache = new Map();
let loadedTaskId = null;

function normalized(path) {
  return String(path || '').replace(/\\/g, '/');
}

function taskRoot() {
  const task = (state.data?.tasks || []).find(item => item.id === state.taskId);
  return normalized(task?.execution?.path || task?.workspace || '').replace(/\/$/, '');
}

function relativeToTask(path) {
  const value = normalized(path);
  const root = taskRoot();
  return root && value.toLowerCase().startsWith(`${root.toLowerCase()}/`)
    ? value.slice(root.length + 1)
    : value;
}

function statusFor(path) {
  const wanted = normalized(path).toLowerCase();
  const change = state.changeByPath.get(normalized(path))
    || [...state.changeByPath.entries()].find(([key]) => normalized(key).toLowerCase() === wanted)?.[1];
  if (!change) return '';
  if (change.untracked) return 'A';
  const code = change.statuses.find(code => code && code !== '?');
  return code || 'M';
}

function sortEntries(entries) {
  return [...(entries || [])].sort((a, b) => a.type === b.type
    ? a.name.localeCompare(b.name)
    : a.type === 'directory' ? -1 : 1);
}

async function readDirectory(path, refresh = false) {
  if (!refresh && directoryCache.has(path)) return directoryCache.get(path);
  const tree = await api(`/api/workbench/tasks/${state.taskId}/tree?path=${encodeURIComponent(path)}`);
  const entries = sortEntries(tree.entries);
  directoryCache.set(path, entries);
  return entries;
}

async function renderChildren(host, path, refresh = false) {
  host.replaceChildren(el('div', 'Loading…', 'file-row loading'));
  const entries = await readDirectory(path, refresh);
  host.replaceChildren(...entries.map(entry => renderNode(entry, path)));
  if (!entries.length) host.append(el('p', 'Thư mục trống.', 'empty-copy'));
}

function renderNode(entry, basePath) {
  const fullPath = joinPath(basePath, entry.name);
  const node = el('div', undefined, 'file-tree-node');
  const row = el('button', undefined, `file-row ${entry.type}`);
  row.type = 'button';
  const icon = el('span', entry.type === 'directory' ? (expandedDirectories.has(fullPath) ? '▾' : '▸') : '·', 'file-icon');
  row.append(icon, el('span', entry.name));
  if (entry.type !== 'directory') row.append(el('span', statusFor(fullPath), 'file-status'));
  else row.append(el('span', '', 'file-status'));

  if (entry.type === 'directory') {
    const children = el('div', undefined, 'file-children');
    children.hidden = !expandedDirectories.has(fullPath);
    row.onclick = () => {
      const open = !expandedDirectories.has(fullPath);
      if (open) expandedDirectories.add(fullPath);
      else expandedDirectories.delete(fullPath);
      icon.textContent = open ? '▾' : '▸';
      children.hidden = !open;
      if (open) void renderChildren(children, fullPath).catch(error => setStatus(error.message));
    };
    node.append(row, children);
    if (!children.hidden) void renderChildren(children, fullPath).catch(error => setStatus(error.message));
  } else {
    row.onclick = () => void openFile(fullPath).catch(error => setStatus(error.message));
    node.append(row);
  }
  return node;
}

export async function loadTree() {
  if (!state.taskId) return;
  if (loadedTaskId !== state.taskId) {
    expandedDirectories.clear();
    loadedTaskId = state.taskId;
  }
  state.currentTreePath = '.';
  directoryCache.clear();
  setStatus('Reading project tree…');
  $('tree-path').textContent = 'Project tree';
  const entries = await readDirectory('.', true);
  $('file-tree').replaceChildren(...entries.map(entry => renderNode(entry, '.')));
  if (!entries.length) $('file-tree').append(el('p', 'Workspace trống.', 'empty-copy'));
  setStatus('Ready');
}

export async function collapseTree() {
  expandedDirectories.clear();
  await loadTree();
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
  const output = String(result.output || '');
  if (!output || output === 'No matches found') {
    $('search-results').replaceChildren(el('p', 'No matches.', 'empty-copy'));
    return;
  }
  const rows = output.split('\n').map(line => {
    const match = line.match(/^(.*):(\d+):\s?(.*)$/);
    if (!match) return null;
    const path = relativeToTask(match[1]);
    const button = el('button', undefined, 'search-result');
    button.type = 'button';
    button.append(
      el('strong', basename(path)),
      el('code', `L${match[2]}`),
      el('span', `${path} · ${match[3]}`),
    );
    button.onclick = () => void openFile(path).catch(error => setStatus(error.message));
    return button;
  }).filter(Boolean);
  $('search-results').replaceChildren(...rows);
  if (!rows.length) $('search-results').append(el('p', output, 'empty-copy'));
}