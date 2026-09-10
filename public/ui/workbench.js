const $ = id => document.getElementById(id);
let token = '', data, taskId, eventController, refreshTimer;
const node = (tag, text, cls) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (cls) n.className = cls; return n; };
const button = (text, action, cls) => { const b = node('button', text, cls); b.onclick = () => perform(action); return b; };
async function api(url, body, method = 'POST') {
  const response = await fetch(url, { method: body === undefined ? 'GET' : method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`);
  return result.data;
}
async function perform(fn) {
  $('error').hidden = true;
  $('review-error').hidden = true;
  try { await fn(); } catch (error) {
    const target = $('review').open ? $('review-error') : $('error');
    target.textContent = error.message; target.hidden = false;
  }
}
async function refresh() {
  data = await api('/api/workbench');
  const connections = await api('/api/workbench/connections');
  $('oauth-requests').replaceChildren(...connections.map(request => {
    const card = node('div', undefined, 'card'); card.append(node('strong', request.clientName), node('p', request.redirectUri), node('p', `Mã: ${request.id}`, 'muted'));
    const row = node('div', undefined, 'row');
    row.append(button('Duyệt kết nối', async () => { await api(`/api/workbench/connections/${request.id}`, { approve: true }); await refresh(); }),
      button('Từ chối', async () => { await api(`/api/workbench/connections/${request.id}`, { approve: false }); await refresh(); }, 'danger'));
    card.append(row); return card;
  }));
  if (!connections.length) $('oauth-requests').append(node('p', 'Không có yêu cầu kết nối. Mở connector OAuth trong ChatGPT để bắt đầu.', 'muted'));
  if (!data.tasks.some(t => t.id === taskId)) taskId = data.tasks[0]?.id;
  $('tasks').replaceChildren(...data.tasks.map(t => { const o = node('option', t.title); o.value = t.id; return o; }));
  $('tasks').value = taskId || '';
  const task = data.tasks.find(t => t.id === taskId);
  if (!task) return;
  $('title').textContent = task.title; $('root').textContent = task.workspace;
  if (!['mode', 'scope'].includes(document.activeElement.id)) { $('mode').value = task.policy.mode; $('scope').checked = task.policy.workspaceOnly; }
  const operations = data.operations.filter(o => o.taskId === taskId);
  const pending = operations.filter(o => o.status === 'pending');
  $('pending-count').textContent = pending.length;
  $('approvals').replaceChildren(...pending.map(op => {
    const card = node('div', undefined, 'card'); card.append(node('strong', op.tool), node('p', `Hết hạn: ${new Date(op.expiresAt).toLocaleTimeString()}`, 'muted'));
    const details = node('details'); details.append(node('summary', 'Xem chính xác thao tác'), node('pre', JSON.stringify(op.args, null, 2))); card.append(details);
    const row = node('div', undefined, 'row');
    row.append(button('Duyệt một lần', async () => { await api(`/api/workbench/operations/${op.id}/decision`, { approve: true }); await refresh(); }),
      button('Từ chối', async () => { await api(`/api/workbench/operations/${op.id}/decision`, { approve: false }); await refresh(); }, 'danger'));
    card.append(row); return card;
  }));
  if (!pending.length) $('approvals').append(node('p', 'Không có thao tác chờ duyệt.', 'muted'));
  $('changes').replaceChildren(...operations.filter(o => o.status !== 'pending').slice(0, 50).map(op => {
    const card = node('div', undefined, 'card'); card.append(node('strong', `${op.tool} · ${op.status}`), node('p', new Date(op.createdAt).toLocaleString(), 'muted'));
    if (op.error) card.append(node('p', op.error));
    for (const file of op.changes) card.append(node('p', `${file.undone ? '↶' : file.before === 'missing' ? 'A' : file.after === 'missing' ? 'D' : 'M'}  ${file.path}`));
    if (op.tracking !== 'file-tools') card.append(node('p', 'Thao tác này không có bảo đảm Undo cho thay đổi từ tiến trình hoặc remote.', 'notice'));
    const row = node('div', undefined, 'row'); row.append(button('Review / kết quả', () => review(op.id)));
    if (op.changes.length && ['completed', 'failed'].includes(op.status)) {
      row.append(button('Undo thao tác', async () => { await api(`/api/workbench/operations/${op.id}/undo`, { redo: false }); await refresh(); }),
        button('Redo', async () => { await api(`/api/workbench/operations/${op.id}/undo`, { redo: true }); await refresh(); }));
    }
    card.append(row); return card;
  }));
  if (!$('changes').children.length) $('changes').append(node('p', 'File được sửa qua tool sẽ xuất hiện ở đây.', 'muted'));
}
function textSnapshot(s) {
  if (s.kind !== 'file') return `[${s.kind}]`;
  const bytes = Uint8Array.from(atob(s.content || ''), c => c.charCodeAt(0));
  if (bytes.length > 200000) return `[File ${bytes.length} bytes · quá lớn để hiển thị]`;
  try { if (bytes.includes(0)) throw new Error(); return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return `[Binary · ${bytes.length} bytes]`; }
}
async function review(id) {
  const op = await api(`/api/workbench/operations/${id}`);
  $('review-error').hidden = true;
  $('review-title').textContent = `${op.tool} · ${op.changes.length} file`;
  $('review-note').textContent = 'Bản trước và sau thao tác. Undo sẽ dừng nếu file hiện tại có thay đổi khác.';
  $('review-files').replaceChildren();
  for (const c of op.changes) {
    const heading = node('div', undefined, 'section-title'); heading.append(node('strong', c.path), button(c.undone ? 'Redo file' : 'Undo file', async () => {
      await api(`/api/workbench/operations/${id}/undo`, { file: c.path, redo: !!c.undone }); await review(id); await refresh();
    }));
    const diff = node('div', undefined, 'diff'); diff.append(node('pre', `TRƯỚC\n\n${textSnapshot(c.before)}`, 'before'), node('pre', `SAU\n\n${textSnapshot(c.after)}`, 'after'));
    $('review-files').append(heading, diff);
  }
  const details = node('details'); details.append(node('summary', 'Kết quả thao tác'), node('pre', JSON.stringify(op.result || op.error || {}, null, 2), 'output')); $('review-files').append(details);
  if (!$('review').open) $('review').showModal();
}
async function events() {
  eventController?.abort(); eventController = new AbortController();
  try {
    const res = await fetch('/api/workbench/events', { headers: { Authorization: `Bearer ${token}` }, signal: eventController.signal });
    if (!res.ok) throw new Error('Không thể nhận cập nhật');
    const reader = res.body.getReader(), decoder = new TextDecoder();
    let pending = '';
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      pending += decoder.decode(value, { stream: true });
      let end;
      while ((end = pending.indexOf('\n\n')) !== -1) {
        const frame = pending.slice(0, end); pending = pending.slice(end + 2);
        if (frame.split('\n').some(line => line === 'event: change')) {
          clearTimeout(refreshTimer); refreshTimer = setTimeout(() => perform(refresh), 200);
        }
      }
    }
    $('connection').textContent = 'Mất kết nối cập nhật · bấm Kết nối';
  } catch (error) { if (error.name !== 'AbortError') $('connection').textContent = 'Cập nhật trực tiếp đã ngắt'; }
}
$('connect').onclick = () => perform(async () => { token = $('token').value.trim(); await refresh(); $('connection').textContent = 'Đã kết nối'; void events(); });
$('refresh').onclick = () => perform(refresh);
$('tasks').onchange = () => { taskId = $('tasks').value; perform(refresh); };
$('select-task').onclick = () => perform(async () => { await api(`/api/workbench/tasks/${taskId}/select`, {}); $('connection').textContent = 'Đã chọn · mở kết nối MCP mới để dùng task này'; });
$('create-task').onclick = () => perform(async () => { const task = await api('/api/workbench/tasks', { title: $('task-title').value, workspace: $('workspace').value }); taskId = task.id; await refresh(); });
$('mode').onchange = () => { if ($('mode').value === 'full') $('scope').checked = false; };
$('save-policy').onclick = () => perform(async () => {
  if (!$('scope').checked && !confirm('Cho phép task truy cập ngoài workspace? Lệnh có thể truy cập toàn bộ dữ liệu và mạng theo quyền tài khoản chạy server.')) return;
  await api(`/api/workbench/tasks/${taskId}/policy`, { mode: $('mode').value, workspaceOnly: $('scope').checked }, 'PUT'); await refresh();
});
$('close-review').onclick = () => $('review').close();
$('run-git').onclick = () => perform(async () => {
  let tool = $('git-action').value, args = {};
  if (tool === 'git_staged') { tool = 'git_diff'; args.staged = true; }
  if (['git_add', 'git_unstage'].includes(tool)) args.files = $('git-files').value.split('\n').map(s => s.trim()).filter(Boolean);
  if (tool === 'git_commit') args.message = $('git-message').value;
  if (tool === 'git_branch') Object.assign(args, { action: 'create-and-switch', name: $('git-branch').value });
  if (tool === 'git_push') Object.assign(args, { branch: $('git-branch').value, set_upstream: true });
  if (tool === 'git_worktree') Object.assign(args, { action: 'add', directory: $('git-directory').value, branch: $('git-branch').value });
  if (tool === 'git_push' && !confirm(`Push branch ${args.branch} lên origin?`)) return;
  const result = await api(`/api/workbench/tasks/${taskId}/git`, { tool, args }); $('git-output').textContent = JSON.stringify(result, null, 2); await refresh();
});
$('run-gh').onclick = () => perform(async () => {
  const args = { action: $('gh-action').value, repo: $('gh-repo').value };
  for (const [field, id] of [['base', 'gh-base'], ['head', 'gh-head'], ['expected_head', 'gh-sha']]) if ($(id).value) args[field] = $(id).value;
  if ($('gh-number').value) args.number = Number($('gh-number').value);
  if (args.action === 'pr_create_draft') { args.title = $('gh-title').value; args.body = $('gh-body').value; }
  if (['pr_create_draft', 'pr_merge'].includes(args.action) && !confirm(`${args.action} trên ${args.repo}? Kiểm tra nội dung và branch đã nhập trước khi tiếp tục.`)) return;
  const result = await api(`/api/workbench/tasks/${taskId}/github`, args); $('gh-output').textContent = JSON.stringify(result, null, 2); await refresh();
});
