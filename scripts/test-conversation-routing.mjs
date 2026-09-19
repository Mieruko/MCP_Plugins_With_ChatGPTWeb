import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'conversation-routing-'));
const project = path.join(tmp, 'project');
await fs.mkdir(project);
await fs.writeFile(path.join(project, 'marker.txt'), 'BASE');
await fs.writeFile(path.join(tmp, 'upstream.json'), '{"version":1,"servers":[]}');
const git = (...args) => execFileSync('git', args, { cwd: project, windowsHide: true, stdio: 'pipe' });
git('init'); git('config', 'user.name', 'Routing fixture'); git('config', 'user.email', 'fixture@example.invalid');
git('add', '.'); git('commit', '-m', 'fixture');
const freePort = async () => {
  const s = net.createServer();
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  const port = s.address().port;
  await new Promise(resolve => s.close(resolve));
  return port;
};
const port = await freePort();
let adminPort = await freePort();
while (adminPort === port) adminPort = await freePort();
const base = `http://127.0.0.1:${port}`, adminBase = `http://127.0.0.1:${adminPort}`;
const env = { ...process.env, PORT: String(port), ADMIN_PORT: String(adminPort),
  MCP_AUTH_TOKEN: 'routing-mcp', ADMIN_TOKEN: 'routing-admin', WORKSPACE_PATH: project,
  WORKBENCH_PATH: path.join(tmp, 'control'), WORKBENCH_EXPERIENCE: 'advanced', WORKBENCH_DEFAULT_MODE: 'full',
  WORKBENCH_SANDBOX_PROVIDER: 'none', LOCAL_CODER_CONNECTION_MODE: 'local',
  MCP_UPSTREAM_CONFIG: path.join(tmp, 'upstream.json'), AUDIT_LOG_PATH: path.join(tmp, 'audit.log'),
  CHECKPOINT_PATH: path.join(tmp, 'checkpoints'), CODEX_HOME: path.join(tmp, 'codex'),
  MCP_SHELL_STATE_DIR: path.join(tmp, 'shell'), CHATGPT_TOOL_PROFILE: 'full',
  WORKBENCH_REVIEW_QUIESCENCE_MS: '1000',
  WORKSPACE_PATHS: '', EXTRA_WORKSPACE_PATHS: '', ALLOWED_WORKSPACE_PATHS: '',
};
let server, logs = '', sequence = 0;
async function start() {
  server = spawn(process.execPath, [path.join(repo, 'dist/index.js')], { cwd: tmp, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', data => { logs += data; }); server.stderr.on('data', data => { logs += data; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + '/health', { signal: AbortSignal.timeout(500) })).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(logs);
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise(resolve => server.once('exit', resolve));
  server.kill();
  await exited;
}
async function rpc(sid, method, params) {
  const res = await fetch(base + '/mcp', { method: 'POST', headers: {
    Authorization: 'Bearer routing-mcp', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    ...(sid ? { 'mcp-session-id': sid } : {}),
  }, body: JSON.stringify({ jsonrpc: '2.0', id: ++sequence, method, params }), signal: AbortSignal.timeout(12000) });
  const data = await res.json();
  assert.equal(res.status, 200, JSON.stringify(data));
  return { data, sid: res.headers.get('mcp-session-id') };
}
async function init() {
  return (await rpc(null, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ChatGPT routing test', version: '1' } })).sid;
}
const text = result => result.content?.map(item => item.text || '').join('\n') || JSON.stringify(result);
async function raw(sid, conversation, name, args = {}) {
  const { data } = await rpc(sid, 'tools/call', { name, arguments: args,
    ...(conversation === undefined ? {} : { _meta: { 'openai/session': conversation } }),
  });
  return data.result ?? { isError: true, content: [{ text: JSON.stringify(data.error) }] };
}
async function call(sid, conversation, name, args = {}) {
  const result = await raw(sid, conversation, name, args);
  assert.ok(!result.isError, text(result));
  return result.structuredContent ?? JSON.parse(text(result));
}
async function admin(url, body, method = 'POST') {
  const res = await fetch(adminBase + url, { method: body === undefined ? 'GET' : method,
    headers: { Authorization: 'Bearer routing-admin', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(12000),
  });
  const data = await res.json(); assert.equal(res.status, 200, JSON.stringify(data)); return data.data ?? data;
}
try {
  await start();
  const sid = await init();
  const bootstrap = await call(sid, undefined, 'workbench_control', { action: 'status' });
  const tasks = [];
  for (const title of ['Frontend', 'Backend', 'Tester']) {
    tasks.push(await admin('/api/workbench/tasks', { title, workspaceId: bootstrap.workspace.id, environment: { mode: 'worktree' } }));
  }
  const conversations = ['conversation-A', 'conversation-B', 'conversation-C'];
  for (let i = 0; i < tasks.length; i++) {
    await fs.writeFile(path.join(tasks[i].execution.path, 'marker.txt'), conversations[i]);
    const selected = await call(sid, conversations[i], 'workbench_control', {
      action: 'target', workspace_id: bootstrap.workspace.id, task_id: tasks[i].id, create_missing: false,
    });
    assert.equal(selected.task.id, tasks[i].id);
    assert.equal(selected.dashboard_selection_unchanged, true);
  }
  await admin(`/api/workbench/tasks/${bootstrap.task.id}/select`, {});
  for (let i = 0; i < tasks.length; i++) {
    assert.equal((await call(sid, conversations[i], 'workbench')).task.id, tasks[i].id);
    assert.match(text(await raw(sid, conversations[i], 'read_text_file', { path: 'marker.txt' })), new RegExp(conversations[i]));
  }
  console.log('OK three conversations on one MCP transport keep independent task and file context despite Dashboard selection');
  const agents = await admin('/api/workbench/agents');
  for (const task of tasks) assert.ok(agents.agents.some(agent => agent.taskId === task.id && agent.sessionId.startsWith('conversation:')));
  assert.ok(!agents.agents.some(agent => agent.sessionId === sid), 'transport fallback is not displayed as an extra chat');
  const missingMetadata = await raw(sid, undefined, 'workbench');
  assert.equal(missingMetadata.isError, true); assert.match(text(missingMetadata), /CONVERSATION_ID_REQUIRED/);

  const peers = tasks.map(task => path.join(task.execution.path, 'timing.json'));
  const concurrentCode = `const fs=require('fs');const peers=${JSON.stringify(peers)};const v={start:Date.now()};
    fs.writeFileSync('timing.json',JSON.stringify(v));const timer=setInterval(()=>{
      if(peers.every(p=>fs.existsSync(p))){clearInterval(timer);setTimeout(()=>{v.end=Date.now();fs.writeFileSync('timing.json',JSON.stringify(v));},100);}
      else if(Date.now()-v.start>6000){clearInterval(timer);process.exitCode=9;}
    },20);`;
  const command = `node -e "eval(Buffer.from('${Buffer.from(concurrentCode).toString('base64')}','base64').toString())"`;
  await Promise.all(conversations.map(conversation => call(sid, conversation, 'run_command', { command })));
  const times = await Promise.all(tasks.map(task => fs.readFile(path.join(task.execution.path, 'timing.json'), 'utf8').then(JSON.parse)));
  assert.ok(times.every((a, i) => times.every((b, j) => i === j || (a.start < b.end && b.start < a.end))), JSON.stringify(times));
  console.log('OK three real shell jobs overlap on one transport in different task worktrees');

  // A reconnect may bootstrap on a completely different Dashboard workspace.
  const foreignPath = path.join(tmp, 'foreign'); await fs.mkdir(foreignPath);
  const foreignWorkspace = await admin('/api/workbench/workspaces', { name: 'Foreign', path: foreignPath });
  const foreignTask = await admin('/api/workbench/tasks', { title: 'Foreign task', workspaceId: foreignWorkspace.id });
  await admin(`/api/workbench/tasks/${foreignTask.id}/select`, {});
  const reconnected = await init();
  for (let i = 0; i < tasks.length; i++) {
    assert.equal((await call(reconnected, conversations[i], 'workbench')).task.id, tasks[i].id);
  }
  assert.equal((await admin('/api/workbench')).selectedTaskId, foreignTask.id);
  console.log('OK reconnect restores each conversation rather than adopting the newly selected workspace');

  // Explicit same-workspace selection works under Ask, with another chat attached.
  await admin(`/api/workbench/tasks/${tasks[0].id}/policy`, { mode: 'ask', workspaceOnly: true }, 'PUT');
  await admin(`/api/workbench/tasks/${tasks[1].id}/policy`, { mode: 'ask', workspaceOnly: true }, 'PUT');
  const shared = await call(reconnected, conversations[0], 'workbench_control', {
    action: 'target', workspace_id: bootstrap.workspace.id, task_id: tasks[1].id, create_missing: false,
  });
  assert.equal(shared.task.id, tasks[1].id);
  assert.equal((await call(sid, conversations[1], 'workbench')).task.id, tasks[1].id);
  await call(reconnected, conversations[0], 'workbench_control', { action: 'target', task_id: tasks[0].id, create_missing: false });
  const rejected = await raw(sid, conversations[0], 'workbench_control', {
    action: 'target', workspace_id: foreignWorkspace.id, task_id: foreignTask.id, create_missing: false,
  });
  assert.equal(rejected.isError, true, 'same-workspace support must not grant cross-workspace control');
  const shellDenied = await raw(sid, conversations[0], 'run_command', { command: 'echo unsafe' });
  assert.equal(shellDenied.isError, true, 'workspace-only process boundary remains enforced');
  const outside = await raw(sid, conversations[0], 'read_text_file', { path: path.join(tasks[1].execution.path, 'marker.txt') });
  assert.equal(outside.isError, true, 'task filesystem boundaries remain enforced');

  const pending = await call(sid, conversations[0], 'write_file', { path: 'approved.txt', content: 'RIGHT_TASK' });
  assert.equal(pending.status, 'approval_required');
  const busy = await raw(reconnected, conversations[0], 'workbench_control', { action: 'target', task_id: tasks[1].id, create_missing: false });
  assert.equal(busy.isError, true); assert.match(text(busy), /AGENT_TARGET_BUSY/);
  await call(reconnected, conversations[2], 'write_file', { path: 'other.txt', content: 'INDEPENDENT' });
  await admin(`/api/workbench/operations/${pending.operation_id}/decision`, { approve: true });
  assert.equal(await fs.readFile(path.join(tasks[0].execution.path, 'approved.txt'), 'utf8'), 'RIGHT_TASK');
  await assert.rejects(fs.stat(path.join(tasks[2].execution.path, 'approved.txt')), { code: 'ENOENT' });
  assert.equal((await call(reconnected, conversations[0], 'workbench', { operation_id: pending.operation_id })).status, 'completed');
  const handoff = await call(sid, conversations[0], 'task_handoff', { action: 'update', summary: 'Conversation approval context retained' });
  assert.equal(handoff.status, 'approval_required');
  await admin(`/api/workbench/operations/${handoff.operation_id}/decision`, { approve: true });
  assert.equal((await call(reconnected, conversations[0], 'task_handoff', { action: 'read' })).handoff.summary, 'Conversation approval context retained');
  console.log('OK shared task access under Ask, permission refusals, pending operation pinning and approval replay across reconnect');

  const malformed = await raw(sid, '', 'workbench');
  assert.equal(malformed.isError, true); assert.match(text(malformed), /CONVERSATION_ID_INVALID/);
  await new Promise(resolve => setTimeout(resolve, 1300));
  const idleState = await admin(`/api/workbench/workspaces/${bootstrap.workspace.id}/review-runs`);
  const conversationRuns = idleState.reviewRuns.filter(run => run.sessionId?.startsWith('conversation:'));
  assert.ok(conversationRuns.length > 0);
  assert.ok(conversationRuns.every(run => run.status !== 'open'),
    'conversation review runs close after quiescence rather than waiting for transport cleanup');
  await stop(); await start();
  const restarted = await init();
  for (let i = 0; i < tasks.length; i++) {
    assert.equal((await call(restarted, conversations[i], 'workbench')).task.id, tasks[i].id);
  }
  console.log('OK conversation bindings survive server restart without following Dashboard selection');
} catch (error) {
  console.error(logs.slice(-7000)); throw error;
} finally {
  await stop();
  // Only the absolute directory created by this fixture is removed.
  assert.ok(path.resolve(tmp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}
