import { currentTask } from './state.js';

export const $ = id => document.getElementById(id);

export function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}

export function basename(value) {
  const normalized = String(value || '').replace(/\\/g, '/').replace(/\/$/, '');
  return normalized.split('/').filter(Boolean).pop() || normalized || 'Workspace';
}

export function joinPath(base, name) {
  return `${base === '.' ? '' : String(base).replace(/\\/g, '/').replace(/\/$/, '') + '/'}${name}`;
}

export function parentPath(value) {
  const parts = String(value || '.').replace(/\\/g, '/').split('/').filter(Boolean);
  parts.pop();
  return parts.length ? parts.join('/') : '.';
}

export function taskRelative(value) {
  const task = currentTask();
  if (!task || !value) return String(value || '');
  const root = task.workspace.replace(/\\/g, '/').replace(/\/$/, '');
  const normalized = String(value).replace(/\\/g, '/');
  return normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)
    ? normalized.slice(root.length + 1)
    : normalized;
}

export function setStatus(message) {
  $('status-message').textContent = message || 'Ready';
}

export function renderCode(target, text) {
  target.replaceChildren();
  const lines = String(text || '').split('\n');
  lines.forEach((line, index) => {
    const row = el('div', undefined, 'code-line');
    row.append(el('span', index + 1, 'line-number'), el('span', line || ' ', 'line-code'));
    target.append(row);
  });
  return lines.length;
}

export function renderUnifiedDiff(target, text) {
  target.replaceChildren();
  let oldLine = null;
  let newLine = null;
  for (const raw of String(text || '').split('\n')) {
    const hunk = raw.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
    }
    const added = raw.startsWith('+') && !raw.startsWith('+++');
    const removed = raw.startsWith('-') && !raw.startsWith('---');
    const header = raw.startsWith('@@') || raw.startsWith('diff ') || raw.startsWith('index ') || raw.startsWith('---') || raw.startsWith('+++');
    const row = el('div', undefined, `diff-line${added ? ' add' : removed ? ' remove' : header ? ' header' : ''}`);
    let oldNumber = '';
    let newNumber = '';
    if (!header && oldLine !== null && newLine !== null) {
      if (added) newNumber = newLine++;
      else if (removed) oldNumber = oldLine++;
      else {
        oldNumber = oldLine++;
        newNumber = newLine++;
      }
    }
    const marker = added ? '+' : removed ? '-' : header ? '·' : ' ';
    const codeText = header ? raw : raw.slice(1);
    row.dataset.diffType = added ? 'add' : removed ? 'remove' : header ? 'header' : 'context';
    if (oldNumber !== '') row.dataset.oldLine = String(oldNumber);
    if (newNumber !== '') row.dataset.newLine = String(newNumber);
    row.append(
      el('span', oldNumber, 'line-number diff-old-line'),
      el('span', newNumber, 'line-number diff-new-line'),
      el('span', marker, 'diff-marker'),
      el('span', codeText || ' ', 'line-code'),
    );
    target.append(row);
  }
}