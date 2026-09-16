import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'local-continuity-test-'));
const project = path.join(tmp, 'project'), control = path.join(tmp, 'control');
await fs.mkdir(project);
await fs.writeFile(path.join(project, 'sample.txt'), 'original\n');
await fs.writeFile(path.join(tmp, 'upstream.json'), '{"version":1,"servers":[]}');
const git = args => execFileSync('git', args, { cwd: project, windowsHide: true, encoding: 'utf8' }).trim();
git(['init', '-b', 'main']);
git(['config', 'user.name', 'Experience Test']);
git(['config', 'user.email', 'test@example.invalid']);
git(['add', 'sample.txt']);
git(['commit', '-m', 'Initial fixture']);
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
const port = await freePort(), adminPort = await freePort();
const base = `http://127.0.0.1:${port}`, admin = `http://127.0.0.1:${adminPort}`;
const env = { ...process.env, PORT: String(port), ADMIN_PORT: String(adminPort), WORKSPACE_PATH: project,
  WORKBENCH_PATH: control, WORKBENCH_EXPERIENCE: 'basic', WORKBENCH_DEFAULT_MODE: 'ask',
  ADMIN_TOKEN: 'experience-admin', MCP_AUTH_TOKEN: 'experience-mcp', WORKBENCH_BOOTSTRAP_TOKEN: 'experience-bootstrap',
  CHATGPT_TOOL_PROFILE: 'slim', MCP_SESSION_RECOVERY: 'true', WORKBENCH_SANDBOX_PROVIDER: 'none',
  MCP_UPSTREAM_CONFIG: path.join(tmp, 'upstream.json'), AUDIT_LOG_PATH: path.join(tmp, 'audit.log'),
  CHECKPOINT_PATH: path.join(tmp, 'checkpoints'), MCP_SHELL_STATE_DIR: path.join(tmp, 'shell'),
  CODEX_HOME: path.join(tmp, 'codex'), PUBLIC_BASE_URL: base,
  WORKSPACE_PATHS: '', EXTRA_WORKSPACE_PATHS: '', ALLOWED_WORKSPACE_PATHS: '' };
let server, logs = '', seq = 0;
async function start() {
  server = spawn(process.execPath, [path.join(root, 'dist/index.js')], { cwd: tmp, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', data => { logs += data; });
  server.stderr.on('data', data => { logs += data; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/health')).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Fixture failed to start: ${logs}`);
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const child = server;
  const closed = new Promise(resolve => child.once('exit', resolve));
  if (process.platform === 'win32') {
    await new Promise(resolve => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('close', resolve); killer.once('error', resolve);
    });
  } else child.kill('SIGTERM');
  await closed;
}
async function request(url, body, method = 'POST', expected = 200) {
  const response = await fetch(admin + url, { method: body === undefined ? 'GET' : method,
    headers: { Authorization: 'Bearer experience-admin', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
  const json = await response.json();
  assert.equal(response.status, expected, JSON.stringify(json));
  return json.data ?? json;
}
async function rpc(sessionId, method, params) {
  const response = await fetch(base + '/mcp', { method: 'POST', headers: {
    Authorization: 'Bearer experience-mcp', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
  }, body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }), signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200);
  const json = await response.json();
  return { sessionId: response.headers.get('mcp-session-id') || sessionId, result: json.result, error: json.error };
}
async function connect(name = 'ChatGPT') {
  return (await initialize(name)).sessionId;
}
async function initialize(name = 'ChatGPT') {
  return rpc(null, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name, version: '1' } });
}
const call = async (sessionId, name, args = {}) => (await rpc(sessionId, 'tools/call', { name, arguments: args }));
const text = response => response.error ? JSON.stringify(response.error) : (response.result?.content || []).map(item => item.text || '').join('\n');
const payload = response => JSON.parse(text(response));
const ok = response => { assert.ok(!response.error && !response.result?.isError && response.result?.structuredContent?.ok !== false, text(response)); return response; };
const denied = (response, pattern) => assert.match(text(response), pattern);
const view = id => request(`/api/workbench/workspaces/${id}/experience`);
const policy = (id, mode, workspaceOnly) => request(`/api/workbench/tasks/${id}/policy`, { mode, workspaceOnly }, 'PUT');
const experience = (id, mode, expected = 200) => request(`/api/workbench/workspaces/${id}/experience`, { mode }, 'PUT', expected);
const take = (id, sessionId, expectedSessionId, expected = 200) => request(`/api/workbench/workspaces/${id}/writer`, { sessionId, expectedSessionId }, 'POST', expected);

const decide = (id, approve = true, expected = 200) => request('/api/workbench/operations/' + id + '/decision', { approve }, 'POST', expected);
const handoff = async id => payload(ok(await call(id, 'task_handoff'))).handoff;
try {
  await start();
  const initial = await request('/api/workbench');
  const workspace = initial.workspaces[0], taskId = workspace.basicTaskId;
  const a = await connect();
  if (process.argv.includes('--measure')) {
    await policy(taskId, 'auto', true);
    for (let i = 0; i < 30; i++) ok(await call(a, 'write_file', { path: 'measure-' + i + '.txt', content: ('REVIEW_BODY_' + i + ' tiếng Việt 😀\n').repeat(500) }));
    await policy(taskId, 'ask', true);
    const response = ok(await call(a, 'workbench'));
    const value = payload(response);
    assert.equal((await request('/api/workbench')).operations.filter(op => op.taskId === taskId).length, 30);
    assert.equal(value.view, 'summary');
    assert.equal(value.history.total, 30);
    assert.equal(value.operations.length, 0);
    assert.doesNotMatch(text(response), /REVIEW_BODY_/);
    const page1 = payload(ok(await call(a, 'workbench', { view: 'history', limit: 10 })));
    const page2 = payload(ok(await call(a, 'workbench', { view: 'history', limit: 10, cursor: page1.cursor })));
    const page3 = payload(ok(await call(a, 'workbench', { view: 'history', limit: 10, cursor: page2.cursor })));
    assert.equal(page1.operations.length, 10);
    assert.equal(page2.operations.length, 10);
    assert.equal(page3.operations.length, 10);
    assert.equal(page3.truncated, false);
    assert.equal(new Set([...page1.operations, ...page2.operations, ...page3.operations].map(op => op.id)).size, 30);
    assert.doesNotMatch(JSON.stringify(page1), /REVIEW_BODY_/);
    console.log('PAYLOAD_MEASUREMENT ' + JSON.stringify({ operations: 30, json_bytes: Buffer.byteLength(JSON.stringify(response.result)), text_chars: text(response).length, text_bytes: Buffer.byteLength(text(response)), view: value.view || 'legacy' }));
  } else {
    const listed = (await rpc(a, 'tools/list', {})).result.tools;
    assert.ok(listed.some(t => t.name === 'task_handoff'));
    assert.equal(listed.find(t => t.name === 'task_handoff').annotations.readOnlyHint, false);
    assert.equal(await handoff(a), null);
    assert.equal((await view(workspace.id)).writer, null);
    const pending = payload(ok(await call(a, 'task_handoff', { action: 'update', summary: 'Goal A; tests pending', next_steps: ['Run tests'], notes: 'Blockers: none' })));
    assert.equal(pending.status, 'approval_required');
    assert.equal(await handoff(a), null);
    assert.equal((await request('/api/workbench')).operations.filter(op => op.taskId === taskId).length, 1);
    await decide(pending.operation_id);
    assert.equal((await decide(pending.operation_id)).status, 'completed', 'repeating the same applied approval is idempotent');
    const saved = await handoff(a);
    assert.equal(saved.summary, 'Goal A; tests pending');
    const b = await connect();
    assert.deepEqual(await handoff(b), saved);
    denied(await call(b, 'task_handoff', { action: 'update', summary: 'Forbidden B' }), /WRITER_REQUIRED/);
    assert.deepEqual(await handoff(b), saved);
    const detail = payload(ok(await call(a, 'workbench', { operation_id: pending.operation_id })));
    assert.equal(detail.status, 'completed');
    assert.ok(detail.result.content[0].text.includes('Goal A'));
    assert.equal((await request('/api/workbench/operations/' + pending.operation_id)).tracking, 'task-metadata');
    const askSummary = payload(ok(await call(a, 'workbench')));
    assert.equal(askSummary.view, 'summary');
    assert.equal(askSummary.handoff.available, true);
    assert.doesNotMatch(JSON.stringify(askSummary), /Goal A; tests pending.*Run tests.*Blockers: none.*fromSessionId/s);
    await request('/api/workbench/operations/' + pending.operation_id + '/undo', { redo: false }, 'POST', 400);
    const reject = payload(ok(await call(a, 'task_handoff', { action: 'update', summary: 'Denied' })));
    await decide(reject.operation_id, false);
    assert.deepEqual(await handoff(a), saved);
    const stalePolicy = payload(ok(await call(a, 'task_handoff', { action: 'update', summary: 'Stale policy' })));
    await policy(taskId, 'auto', true);
    await decide(stalePolicy.operation_id, true, 410);
    assert.deepEqual(await handoff(a), saved);
    ok(await call(a, 'task_handoff', { action: 'update', summary: 'Auto' }));
    await policy(taskId, 'ask', true);
    const staleWriter = payload(ok(await call(a, 'task_handoff', { action: 'update', summary: 'Stale writer' })));
    await take(workspace.id, b, a);
    await decide(staleWriter.operation_id, true, 410);
    assert.equal((await handoff(b)).summary, 'Auto');
    await policy(taskId, 'full', true);
    ok(await call(b, 'task_handoff', { action: 'update', summary: 'Full' }));
    denied(await call(b, 'start_process', { command: 'echo forbidden' }), /SANDBOX_UNAVAILABLE/);
    assert.equal((await handoff(a)).summary, 'Full');
    ok(await call(b, 'remember', { note: 'MEMORY_ROOT_A tiếng Việt 🚀' }));
    const aFresh = await initialize();
    assert.match(aFresh.result.instructions, /MEMORY_ROOT_A tiếng Việt 🚀/);
    console.log('OK slim HTTP handoff: Ask once, deny, policy/writer changes, Auto/Full, read without writer, metadata result and no file Undo');

    const projectB = path.join(tmp, 'project-b');
    await fs.mkdir(projectB);
    const workspaceB = await request('/api/workbench/workspaces', { name: 'B', path: projectB });
    const aHistory = payload(ok(await call(a, 'workbench', { view: 'history', limit: 1 })));
    await request('/api/workbench/workspaces/' + workspaceB.id + '/select', {});
    const cInit = await initialize();
    const c = cInit.sessionId;
    assert.doesNotMatch(cInit.result.instructions, /MEMORY_ROOT_A/);
    const taskB = payload(ok(await call(c, 'workbench'))).task.id;
    assert.notEqual(taskB, taskId);
    if (aHistory.cursor) denied(await call(c, 'workbench', { view: 'history', cursor: aHistory.cursor }), /another task/);
    assert.equal(await handoff(c), null);
    await policy(taskB, 'auto', true);
    ok(await call(c, 'task_handoff', { action: 'update', summary: 'Only B', taskId, workspace: project }));
    ok(await call(c, 'remember', { note: 'MEMORY_ROOT_B isolated 🧠' }));
    const bFresh = await initialize();
    assert.match(bFresh.result.instructions, /MEMORY_ROOT_B isolated 🧠/);
    assert.doesNotMatch(bFresh.result.instructions, /MEMORY_ROOT_A/);
    assert.equal((await handoff(b)).summary, 'Full');
    assert.equal((await handoff(c)).summary, 'Only B');
    denied(await call(c, 'workbench', { operation_id: pending.operation_id }), /another task/);
    ok(await call(c, 'task_complete'));
    denied(await call(c, 'task_handoff', { action: 'update', summary: 'Closed' }), /TASK_INTEGRATION_LOCKED/);
    assert.equal((await handoff(c)).summary, 'Only B');
    console.log('OK pinned task/workspace isolation, execution-root memory isolation and completed lifecycle');
  }
} catch (error) {
  console.error(logs.slice(-6000));
  throw error;
} finally {
  await stop();
  assert.ok(tmp.startsWith(path.join(os.tmpdir(), 'local-continuity-test-')));
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
