import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ProcessLog } from '../dist/lib/process-log.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'chatgpt-web-test-'));
const log = new ProcessLog(8);
log.append('123456');
assert.deepEqual(log.read(0, 3), { text: '123', cursor: 3, dropped: false, has_more: true });
log.append('789ABCDE');
assert.deepEqual(log.read(3, 4), { text: '789A', cursor: 10, dropped: true, has_more: true });
assert.equal(log.read(10, 8).text, 'BCDE');
assert.throws(() => log.read(99, 10));
console.log('OK cursor pagination and eviction');

async function freePort() {
  const s = net.createServer();
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise(r => s.close(r));
  return port;
}
await fs.mkdir(path.join(tmp, '.claude/rules'), { recursive: true });
await fs.writeFile(path.join(tmp, '.claude/rules/typescript.md'), '---\npaths:\n  - "*.ts"\n---\nKeep types explicit.\n');
await fs.writeFile(path.join(tmp, 'a.ts'), 'export const first = 1;\nexport const second = 2;\n');
await fs.writeFile(path.join(tmp, 'b.ts'), 'export const third = 3;\n');
await fs.writeFile(path.join(tmp, 'large.ts'), 'x'.repeat(9000));
await fs.writeFile(path.join(tmp, 'binary.bin'), Buffer.from([0, 1, 2]));
await fs.writeFile(path.join(tmp, 'upstream.json'), '{"version":1,"servers":[]}');
const conversationalTarget = path.join(tmp, 'target-project');
await fs.mkdir(conversationalTarget);
await fs.writeFile(path.join(conversationalTarget, 'marker.txt'), 'CONVERSATIONAL_TARGET_OK\n');
const conversationalCreated = path.join(tmp, 'created-project');
await fs.mkdir(conversationalCreated);
await fs.writeFile(path.join(conversationalCreated, 'created.txt'), 'CREATE_WORKSPACE_OK\n');
const port = await freePort();
let adminPort = await freePort();
while (adminPort === port) adminPort = await freePort();
const server = spawn(process.execPath, [path.join(root, 'dist/index.js')], {
  cwd: tmp, windowsHide: true,
  env: { ...process.env, PORT: String(port), ADMIN_PORT: String(adminPort), ADMIN_TOKEN: 'test-admin', MCP_AUTH_TOKEN: 'test-mcp',
    WORKBENCH_PATH: path.join(tmp, 'control-state'), WORKBENCH_DEFAULT_MODE: 'full',
    WORKBENCH_EXPERIENCE: 'advanced',
    WORKSPACE_PATH: tmp, WORKSPACE_PATHS: '', EXTRA_WORKSPACE_PATHS: '', ALLOWED_WORKSPACE_PATHS: '',
    MCP_UPSTREAM_CONFIG: path.join(tmp, 'upstream.json'), AUDIT_LOG_PATH: path.join(tmp, 'audit.log'),
    CHECKPOINT_PATH: path.join(tmp, 'checkpoints'), CODEX_HOME: path.join(tmp, 'codex'),
    MCP_SHELL_STATE_DIR: path.join(tmp, 'shell'), CHATGPT_TOOL_PROFILE: 'slim' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', d => serverLog += d);
server.stderr.on('data', d => serverLog += d);
const base = `http://127.0.0.1:${port}`;
let id = 0;
const headers = sid => ({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
  Authorization: 'Bearer test-mcp',
  ...(sid ? { 'mcp-session-id': sid, 'mcp-protocol-version': '2025-03-26' } : {}) });
async function rpc(sid, method, params, endpoint = '/mcp') {
  const res = await fetch(base + endpoint, { method: 'POST', headers: headers(sid),
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }), signal: AbortSignal.timeout(5000) });
  const data = await res.json();
  assert.equal(res.status, 200, JSON.stringify(data));
  return { data, sid: res.headers.get('mcp-session-id') };
}
async function init(endpoint = '/mcp') {
  const result = await rpc(null, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'chatgpt-web-regression', version: '1' } }, endpoint);
  const res = await fetch(base + endpoint, { method: 'POST', headers: headers(result.sid), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), signal: AbortSignal.timeout(5000) });
  await res.text();
  assert.equal(res.status, 202);
  return result.sid;
}
async function tool(sid, name, args) {
  const { data } = await rpc(sid, 'tools/call', { name, arguments: args });
  assert.ok(!data.error, JSON.stringify(data));
  assert.ok(!data.result.isError, JSON.stringify(data));
  return data.result.structuredContent ?? JSON.parse(data.result.content[0].text);
}

try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base + '/health', { signal: AbortSignal.timeout(500) }); await r.text(); if (r.ok) { ready = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(ready, serverLog);
  // Exercise real session manager, not a reimplementation of its queue.
  for (const endpoint of ['/mcp', '/']) {
    const sid = await init(endpoint);
    const ctrl = new AbortController();
    const stream = fetch(base + endpoint, { headers: headers(sid), signal: ctrl.signal }).then(r => r.text()).catch(() => {});
    try {
      await new Promise(r => setTimeout(r, 150));
      const started = performance.now();
      const { data } = await rpc(sid, 'tools/list', {}, endpoint);
      const elapsed = Math.round(performance.now() - started);
      assert.ok(elapsed < 2000, `SSE blocked POST: ${elapsed}ms`);
      assert.ok(data.result.tools.some(t => t.name === 'inspect_code'));
      assert.ok(data.result.tools.some(t => t.name === 'stop_process'));
      const read = await rpc(sid, 'tools/call', { name: 'inspect_code', arguments: { requests: [{ kind: 'read', path: 'b.ts' }] } }, endpoint);
      assert.equal(read.data.result.structuredContent.ok, true);
      console.log(`OK ${endpoint}: tools/list with SSE still open (${elapsed}ms)`);
    } finally { ctrl.abort(); await stream; }
  }
  const sid = await init();
  const batch = await tool(sid, 'inspect_code', { requests: [
    { kind: 'read', path: 'a.ts', offset: 2, limit: 1 }, { kind: 'read', path: 'b.ts' },
    { kind: 'read', path: 'missing.ts' }, { kind: 'grep', path: tmp, pattern: 'export const', glob: '*.ts' },
    { kind: 'glob', path: tmp, pattern: '*.ts' }, { kind: 'read', path: 'binary.bin' },
  ] });
  assert.equal(batch.data.results.length, 6);
  assert.equal(batch.data.errors, 2);
  assert.equal(batch.data.results[0].content, '2: export const second = 2;');
  assert.match(batch.data.results[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(batch.data.rules.length, 1);
  assert.ok(batch.data.results[3].content.includes('a.ts'));
  assert.ok(batch.data.results[4].content.includes('b.ts'));
  const limited = await tool(sid, 'inspect_code', { requests: [{ kind: 'read', path: 'large.ts' }, { kind: 'read', path: 'b.ts' }], max_chars: 2000 });
  assert.ok(limited.data.content_chars <= 2000);
  assert.equal(limited.data.results[0].truncated, true);
  assert.equal(limited.data.results[0].next_offset, undefined);
  assert.ok(limited.data.results[1].content.includes('third'));
  console.log('OK batch ranges, partial errors, hashes, rules deduplication and output budget');

  const job = await tool(sid, 'start_process', { command: 'node -e "console.log(111);setTimeout(()=>console.log(222),700)"', working_directory: tmp, yield_time_ms: 0 });
  let cursor = job.data.cursor;
  let collected = job.data.stdout;
  let running = job.data.running;
  for (let i = 0; running && i < 8; i++) {
    const out = await tool(sid, 'process_output', { id: job.data.id, cursor, wait_ms: 3000 });
    collected += out.data.stdout;
    cursor = out.data.cursor;
    running = out.data.running;
  }
  assert.equal(running, false);
  assert.equal((collected.match(/111/g) ?? []).length, 1);
  assert.equal((collected.match(/222/g) ?? []).length, 1);
  const empty = await tool(sid, 'process_output', { id: job.data.id, cursor, wait_ms: 3000 });
  assert.equal(empty.data.stdout, '');
  assert.equal(empty.data.running, false);
  const tail = await tool(sid, 'process_output', { id: job.data.id, tail_chars: 4 });
  assert.ok(tail.data.stdout.includes('222'));
  const spawnError = await tool(sid, 'start_process', { command: 'echo unused', working_directory: path.join(tmp, 'does-not-exist'), yield_time_ms: 1000 });
  assert.equal(spawnError.ok, false);
  assert.equal(spawnError.data.running, false);
  assert.ok(spawnError.data.error);
  const failed = await tool(sid, 'start_process', { command: 'exit 7', working_directory: tmp, yield_time_ms: 10000 });
  assert.equal(failed.ok, false);
  assert.equal(failed.data.exit_code, 7);
  console.log('OK background wait, completion, exit failure and no duplicate output');

  const beforeControl = await tool(sid, 'workbench_control', { action: 'status' });
  const createdWorkspace = await tool(sid, 'workbench_control', {
    action: 'create_workspace', workspace_path: conversationalCreated, workspace_name: 'Created from chat',
  });
  assert.equal(createdWorkspace.created, true);
  assert.equal(createdWorkspace.current_chat_unchanged, true);
  assert.equal(path.resolve(createdWorkspace.workspace.path), path.resolve(conversationalCreated));
  const createdTask = await tool(sid, 'workbench_control', {
    action: 'create_task', workspace_path: conversationalCreated, task_title: 'Created without binding',
  });
  assert.equal(createdTask.created, true);
  assert.equal(createdTask.current_chat_unchanged, true);
  assert.equal((await tool(sid, 'workbench_control', { action: 'status' })).task.id, beforeControl.task.id);
  console.log('OK conversational workspace/task creation does not silently rebind the current chat');

  const targeted = await tool(sid, 'workbench_control', {
    action: 'target', workspace_path: conversationalTarget, workspace_name: 'Conversational target',
    task_title: 'Chat-created task', create_missing: true,
  });
  assert.equal(targeted.authoritative, true);
  assert.equal(path.resolve(targeted.workspace.path), path.resolve(conversationalTarget));
  assert.equal(targeted.task.title, 'Chat-created task');
  assert.equal(targeted.created.workspace, true);
  assert.equal(targeted.created.task, true);
  const targetRead = await tool(sid, 'read_text_file', { path: 'marker.txt' });
  assert.match(targetRead.data.content, /CONVERSATIONAL_TARGET_OK/);
  const targetStatus = await tool(sid, 'agent_status', {});
  assert.equal(path.resolve(targetStatus.data.default_cwd), path.resolve(conversationalTarget));
  const controlStatus = await tool(sid, 'workbench_control', { action: 'status' });
  assert.equal(controlStatus.task.id, targeted.task.id);
  assert.equal(path.resolve(controlStatus.task.execution_path), path.resolve(conversationalTarget));
  const adminStateResponse = await fetch(`http://127.0.0.1:${adminPort}/api/workbench`, {
    headers: { Authorization: 'Bearer test-admin' }, signal: AbortSignal.timeout(5000),
  });
  assert.equal(adminStateResponse.status, 200);
  const adminState = (await adminStateResponse.json()).data;
  assert.equal(adminState.selectedTaskId, targeted.task.id);
  assert.equal(adminState.agentBindings.find(binding => binding.sessionId === sid)?.taskId, targeted.task.id);
  console.log('OK conversational Workbench target retargets the same MCP session and selected task');

  const recovered = await tool('00000000-0000-4000-8000-000000000077', 'inspect_code', { requests: [{ kind: 'read', path: 'marker.txt' }] });
  assert.equal(recovered.ok, true);
  assert.match(recovered.data.results[0].content, /CONVERSATIONAL_TARGET_OK/);
  console.log('OK stale session recovery');
} catch (error) {
  console.error(serverLog);
  throw error;
} finally {
  const closed = new Promise(r => server.once('close', r));
  server.kill();
  await closed;
  assert.ok(tmp.startsWith(path.join(os.tmpdir(), 'chatgpt-web-test-')));
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
