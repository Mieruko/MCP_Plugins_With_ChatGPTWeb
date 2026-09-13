import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'local-control-permissions-test-'));
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
  WORKBENCH_PATH: control, WORKBENCH_EXPERIENCE: 'basic', WORKBENCH_DEFAULT_MODE: 'ask', WORKBENCH_REMOTE_POLICY_CONTROL: 'false',
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
  const a = await connect(), b = await connect();
  const projectB = path.join(tmp, 'project-b');
  await fs.mkdir(projectB);
  await fs.writeFile(path.join(projectB, 'marker.txt'), 'OUTSIDE_SYNTHETIC_MARKER');
  const setPolicy = async (session, mode, workspace_only, extra = {}) => {
    const current = payload(ok(await call(session, 'workbench')));
    return call(session, 'workbench_control', { action: 'set_policy', mode, workspace_only,
      expected_revision: current.task.policy.revision, ...extra });
  };
  denied(await call(a, 'read_text_file', { path: path.join(projectB, 'marker.txt') }), /outside|denied|workspace/i);
  for (const action of ['target', 'create_workspace']) {
    denied(await call(a, 'workbench_control', { action, workspace_path: projectB }), /CONTROL_PERMISSION_REQUIRED/);
  }
  denied(await call(a, 'workbench_control', { action: 'create_task', workspace_id: workspace.id, task_title: 'Denied task' }), /CONTROL_PERMISSION_REQUIRED/);
  assert.equal((await request('/api/workbench')).workspaces.length, 1);
  denied(await setPolicy(a, 'full', false), /REMOTE_POLICY_DISABLED/);
  await policy(taskId, 'full', true);
  denied(await call(a, 'workbench_control', { action: 'target', workspace_path: projectB }), /CONTROL_PERMISSION_REQUIRED/);
  console.log('OK Ask and workspace-only cannot expand scope or create workspaces/tasks; remote policy is opt-in');

  // Change only this isolated fixture configuration, then exercise the real MCP control path.
  await stop();
  env.WORKBENCH_REMOTE_POLICY_CONTROL = 'true';
  await start();
  const session = await connect(), reader = await connect();
  const summary = payload(ok(await call(session, 'workbench')));
  assert.equal(summary.capabilities.remotePolicyControl, true);
  assert.equal(summary.capabilities.credentialContentFilter, false);
  // The old session did not acquire writer when its controls were denied.
  const full = payload(ok(await setPolicy(session, 'full', false)));
  assert.equal(full.policy.mode, 'full');
  assert.equal(full.policy.workspaceOnly, false);
  denied(await setPolicy(reader, 'ask', true), /WRITER_REQUIRED/);
  denied(await setPolicy(session, 'ask', true, { expected_revision: full.previous_policy.revision }), /POLICY_CHANGED/);
  denied(await setPolicy(session, 'ask', true, { task_id: 'another-task' }), /only changes the currently bound task/);
  const seed = [
    "import fs from 'node:fs';",
    "import { scryptSync } from 'node:crypto';",
    "const users = ['Admin','Doctor','Receptionist','Patient'].map((role, i) => ({",
    "role, username: 'fixture_' + role.toLowerCase(), password_hash: scryptSync('synthetic-password-' + i, 'fixture-salt', 32).toString('hex') }));",
    "fs.writeFileSync('accounts.json', JSON.stringify(users));"
  ].join('\n');
  ok(await call(session, 'write_file', { path: 'seed-users.mjs', content: seed }));
  ok(await call(session, 'run_command', { command: 'node seed-users.mjs', working_directory: project }));
  const accounts = JSON.parse(await fs.readFile(path.join(project, 'accounts.json'), 'utf8'));
  assert.deepEqual(accounts.map(user => user.role), ['Admin', 'Doctor', 'Receptionist', 'Patient']);
  assert.ok(accounts.every(user => /^[a-f0-9]{64}$/.test(user.password_hash)));
  console.log('OK explicit remote Full enables credential seed file and process; wrong writer, stale revision and foreign task are rejected');

  ok(await setPolicy(session, 'ask', true));
  const pending = payload(ok(await call(session, 'write_file', { path: 'must-not-run.txt', content: 'pending' })));
  assert.equal(pending.status, 'approval_required');
  ok(await setPolicy(session, 'full', false));
  assert.equal((await request('/api/workbench/operations/' + pending.operation_id)).status, 'expired');
  await assert.rejects(fs.stat(path.join(project, 'must-not-run.txt')), { code: 'ENOENT' });
  await decide(pending.operation_id, true, 400);
  console.log('OK switching to Ask restores approval; switching to Full expires pending work without replay');

  const job = payload(ok(await call(session, 'start_process', { command: 'node -e "setTimeout(()=>{},30000)"',
    working_directory: project, yield_time_ms: 1000 }))).data;
  assert.equal(job.running, true);
  denied(await call(session, 'workbench_control', { action: 'target', workspace_path: projectB }), /AGENT_TARGET_BUSY/);
  assert.equal((await view(workspace.id)).writer.sessionId, session);
  assert.equal((await request('/api/workbench')).workspaces.length, 1, 'busy target creates no workspace');
  denied(await call(reader, 'write_file', { path: 'second-writer.txt', content: 'no' }), /WRITER_REQUIRED/);
  assert.equal(payload(ok(await call(session, 'process_output', { id: job.id, cursor: job.cursor, wait_ms: 0 }))).data.running, true);
  ok(await call(session, 'stop_process', { id: job.id }));
  const previewPort = await freePort();
  await request('/api/workbench/tasks/' + taskId + '/preview', { command: 'echo fixture', url: 'http://127.0.0.1:' + previewPort }, 'PUT');
  // A leased preview also blocks retargeting even if no process is currently running.
  await request('/api/workbench/tasks/' + taskId + '/preview/start', { command: 'node -e "setTimeout(()=>{},30000)"' });
  denied(await call(session, 'workbench_control', { action: 'target', workspace_path: projectB }), /AGENT_TARGET_BUSY/);
  await request('/api/workbench/tasks/' + taskId + '/preview/stop', {});
  const target = payload(ok(await call(session, 'workbench_control', { action: 'target', workspace_path: projectB })));
  assert.equal(target.authoritative, true);
  assert.equal((await view(workspace.id)).writer, null);
  assert.match(text(ok(await call(session, 'read_text_file', { path: 'marker.txt' }))), /OUTSIDE_SYNTHETIC_MARKER/);
  assert.equal(payload(ok(await call(session, 'workbench'))).task.policy.mode, 'ask', 'Full does not silently propagate to another project');
  ok(await call(reader, 'write_file', { path: 'second-writer.txt', content: 'now allowed' }));
  console.log('OK retarget holds writer during managed process/preview and succeeds after stop; other project keeps its policy');

  await policy(taskId, 'auto', true);
  ok(await call(reader, 'task_handoff', { action: 'update', summary: 'BASELINE' }));
  await policy(taskId, 'ask', true);
  const stale = payload(ok(await call(reader, 'task_handoff', { action: 'update', summary: 'OLD_QUEUED_SUMMARY' })));
  await request('/api/workbench/tasks/' + taskId + '/handoff', { summary: 'NEWER_HUMAN_CORRECTION' }, 'PUT');
  await decide(stale.operation_id, true, 400);
  assert.equal((await handoff(reader)).summary, 'NEWER_HUMAN_CORRECTION');
  assert.match((await request('/api/workbench/operations/' + stale.operation_id)).error, /APPROVAL_CONFLICT/);
  console.log('OK stale handoff approval preserves the newer dashboard correction');

  const large = 'PENDING_BODY_MARKER_' + '漢字😀\n'.repeat(50000);
  const queued = [];
  for (let i = 0; i < 3; i++) queued.push(payload(ok(await call(reader, 'write_file', { path: 'big-' + i + '.txt', content: large }))).operation_id);
  const historyResponse = ok(await call(reader, 'workbench', { view: 'history', limit: 1 }));
  const history = payload(historyResponse);
  assert.equal(history.operations.length, 1);
  assert.equal(history.operations[0].args, undefined);
  assert.equal(history.details_omitted, true);
  assert.doesNotMatch(text(historyResponse), /PENDING_BODY_MARKER/);
  assert.ok(Buffer.byteLength(text(historyResponse)) < 26000);
  const older = payload(ok(await call(reader, 'workbench', { view: 'history', limit: 30, cursor: history.cursor })));
  assert.ok(older.operations.some(op => op.id === queued[0]));
  assert.ok(!older.operations.some(op => op.id === history.operations[0].id));
  assert.ok(Buffer.byteLength(JSON.stringify(older)) < 26000);
  for (const id of queued) await decide(id, false);
  console.log('OK pending large Unicode file bodies stay out of bounded paginated history');

  // The owner can disable conversational policy changes without granting the model a toggle for that gate.
  await stop();
  env.WORKBENCH_REMOTE_POLICY_CONTROL = 'false';
  await start();
  const disabled = await connect();
  denied(await setPolicy(disabled, 'full', false), /REMOTE_POLICY_DISABLED/);
  console.log('OK owner can turn off remote permission changes again');
} catch (error) {
  console.error(logs.slice(-6000));
  throw error;
} finally {
  await stop();
  assert.ok(path.resolve(tmp).startsWith(path.join(os.tmpdir(), 'local-control-permissions-test-')));
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
