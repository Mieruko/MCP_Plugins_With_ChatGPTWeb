import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'local-experience-test-'));
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
  CHATGPT_TOOL_PROFILE: 'full', MCP_SESSION_RECOVERY: 'true', WORKBENCH_SANDBOX_PROVIDER: 'none',
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
  return (await rpc(null, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name, version: '1' } })).sessionId;
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

try {
  await start();
  const initial = await request('/api/workbench');
  const workspace = initial.workspaces[0];
  assert.equal(initial.workspaces.length, 1, 'first launch opens the configured Basic project before ChatGPT connects');
  assert.equal(workspace.experience, 'basic');
  assert.ok(workspace.basicTaskId);
  await request(`/api/workbench/workspaces/${workspace.id}/select`, {});
  const taskId = workspace.basicTaskId;
  let data = await request('/api/workbench');
  assert.equal(data.tasks.length, 1);
  assert.equal(data.selectedTaskId, taskId);
  assert.deepEqual(data.tasks[0].policy, { mode: 'ask', workspaceOnly: true, revision: 1 });
  assert.match(JSON.stringify(await request('/api/workbench/tasks', { title: 'Extra task', workspaceId: workspace.id }, 'POST', 400)), /ADVANCED_REQUIRED/);
  assert.match(JSON.stringify(await request(`/api/workbench/tasks/${taskId}/assignment`, {}, 'POST', 400)), /ADVANCED_REQUIRED/);

  const a = await connect(), b = await connect();
  assert.equal(payload(await call(a, 'workbench')).task.id, taskId);
  assert.equal(payload(await call(b, 'workbench')).task.id, taskId);
  const basicTools = (await rpc(a, 'tools/list', {})).result.tools.map(tool => tool.name).sort();
  assert.ok(basicTools.includes('task_complete'), 'ChatGPT exposes task_complete so an explicit completion message can close the current task');
  ok(await call(a, 'read_text_file', { path: 'sample.txt' }));
  assert.equal((await view(workspace.id)).writer, null, 'reads do not acquire write control');

  const pending = payload(ok(await call(a, 'write_file', { path: 'sample.txt', content: 'A pending\n' })));
  assert.equal(pending.status, 'approval_required');
  assert.equal((await view(workspace.id)).writer.sessionId, a);
  denied(await call(b, 'write_file', { path: 'sample.txt', content: 'B bypass\n' }), /WRITER_REQUIRED/);
  denied(await call(b, 'run_command', { command: 'echo bypass', working_directory: project }), /WRITER_REQUIRED/);
  denied(await call(b, 'git_add', { path: project, all: true }), /WRITER_REQUIRED/);
  denied(await call(b, 'start_process', { command: 'echo bypass', working_directory: project }), /WRITER_REQUIRED/);
  ok(await call(b, 'read_text_file', { path: 'sample.txt' }));
  assert.equal(await fs.readFile(path.join(project, 'sample.txt'), 'utf8'), 'original\n');
  assert.match(JSON.stringify(await take(workspace.id, b, null, 400)), /WRITER_CHANGED/);
  await take(workspace.id, b, a);
  assert.equal((await request(`/api/workbench/operations/${pending.operation_id}`)).status, 'interrupted');
  await request(`/api/workbench/operations/${pending.operation_id}/decision`, { approve: true }, 'POST', 410);
  denied(await call(a, 'write_file', { path: 'sample.txt', content: 'old writer\n' }), /WRITER_REQUIRED/);
  const pendingB = payload(ok(await call(b, 'write_file', { path: 'sample.txt', content: 'B approved\n' })));
  await request(`/api/workbench/operations/${pendingB.operation_id}/decision`, { approve: true });
  assert.equal(await fs.readFile(path.join(project, 'sample.txt'), 'utf8'), 'B approved\n');
  await policy(taskId, 'auto', true);
  ok(await call(b, 'write_file', { path: 'second.txt', content: 'Second\n' }));
  const groups = await request(`/api/workbench/workspaces/${workspace.id}/change-sets`);
  assert.equal(groups.length, 1, 'nearby edits from one session form one recent-work entry');
  assert.equal(groups[0].review.files.length, 2);
  assert.equal(groups[0].operationCount, 2);
  await request(`/api/workbench/change-sets/${groups[0].id}/undo`, { redo: false });
  assert.equal(await fs.readFile(path.join(project, 'sample.txt'), 'utf8'), 'original\n');
  await assert.rejects(fs.stat(path.join(project, 'second.txt')), { code: 'ENOENT' });
  await request(`/api/workbench/change-sets/${groups[0].id}/undo`, { redo: true });
  assert.equal(await fs.readFile(path.join(project, 'second.txt'), 'utf8'), 'Second\n');
  console.log('OK Basic default task, full tool registry, two-session writer control, stale approvals and grouped Undo/Redo');

  await policy(taskId, 'full', false);
  const processResult = payload(ok(await call(b, 'start_process', { command: 'node -e "setInterval(()=>{},1000)"', working_directory: project, yield_time_ms: 1000 }))).data;
  assert.equal(processResult.running, true);
  assert.match(JSON.stringify(await take(workspace.id, a, b, 400)), /WRITER_BUSY/);
  ok(await call(a, 'read_text_file', { path: 'sample.txt' }));
  await request(`/api/workbench/tasks/${taskId}/processes/${processResult.id}/stop`, { force: true });
  await take(workspace.id, a, b);
  denied(await call(b, 'run_command', { command: 'echo stale', working_directory: project }), /WRITER_REQUIRED/);
  ok(await call(a, 'run_command', { command: 'node -e "process.stdout.write(\'writer-ok\')"', working_directory: project }));
  console.log('OK writer transfer waits for managed background processes and gates shell/Git writes even in Full');

  const policyBefore = (await request('/api/workbench')).tasks.find(task => task.id === taskId).policy;
  await experience(workspace.id, 'advanced');
  assert.equal(payload(await call(a, 'workbench')).task.id, taskId);
  assert.equal(payload(await call(b, 'workbench')).task.id, taskId);
  assert.deepEqual((await rpc(a, 'tools/list', {})).result.tools.map(tool => tool.name).sort(), basicTools);
  assert.deepEqual((await request('/api/workbench')).tasks.find(task => task.id === taskId).policy, policyBefore);
  const extraLocal = await request('/api/workbench/tasks', { title: 'Second local task', workspaceId: workspace.id,
    environment: { mode: 'local' } });
  assert.equal(extraLocal.execution.mode, 'local');
  const completeLocal = await request('/api/workbench/tasks', { title: 'Complete from ChatGPT', workspaceId: workspace.id,
    environment: { mode: 'local' } });
  await request(`/api/workbench/tasks/${completeLocal.id}/select`, {});
  const completionSession = await connect();
  assert.equal(payload(await call(completionSession, 'workbench')).task.id, completeLocal.id);
  const completionResult = payload(ok(await call(completionSession, 'task_complete')));
  assert.equal(completionResult.lifecycle, 'completed');
  assert.equal(completionResult.status, 'finished');
  assert.equal((await request('/api/workbench')).tasks.find(item => item.id === completeLocal.id).lifecycle, 'completed');
  denied(await call(completionSession, 'write_file', { path: 'after-complete.txt', content: 'nope\n' }), /TASK_INTEGRATION_LOCKED|completed/);
  const discovery = await connect();
  assert.equal(payload(await call(discovery, 'workbench')).task.id, taskId,
    'Advanced connector/session initialization falls back to the stable local default when multiple local tasks exist');
  await request(`/api/workbench/tasks/${extraLocal.id}/select`, {});
  const staleTaskSession = await connect('stale-task-session');
  assert.equal(payload(await call(staleTaskSession, 'workbench')).task.id, extraLocal.id,
    'a session can be pinned to a secondary Advanced task');
  await request(`/api/workbench/tasks/${taskId}/select`, {});
  await stop();
  await start();
  const dormantState = await request('/api/workbench');
  assert.ok(dormantState.agentBindings.some(binding => binding.sessionId === staleTaskSession && !binding.closedAt),
    'historical task binding remains recoverable after restart');
  const dormantHealth = await request('/health');
  assert.equal(dormantHealth.sessions.some(session => session.id === staleTaskSession), false,
    'historical binding is not a live runtime session after restart');
  const dormantView = await view(workspace.id);
  assert.equal(dormantView.blockers.some(blocker => blocker.taskId === extraLocal.id && /connected session/i.test(blocker.message)), false,
    'recoverable historical sessions must not block Advanced to Basic');
  const parallel = await request('/api/workbench/tasks', { title: 'Parallel fixture', workspaceId: workspace.id,
    environment: { mode: 'worktree', startingRef: 'main' }, assignNextChatgpt: true });
  assert.equal(parallel.execution.mode, 'worktree');
  assert.equal((await view(workspace.id)).canSwitchToBasic, false);
  assert.match(JSON.stringify(await experience(workspace.id, 'basic', 400)), /EXPERIENCE_BUSY/);
  const c = await connect();
  assert.equal(payload(await call(c, 'workbench')).task.id, parallel.id);
  denied(await call(c, 'task_complete'), /TASK_COMPLETE_INTEGRATION_REQUIRED/);
  assert.equal((await request('/api/workbench')).tasks.find(item => item.id === parallel.id).lifecycle, 'open',
    'task_complete never silently merges or closes an unmerged managed worktree');
  await request(`/api/workbench/tasks/${parallel.id}/integration/discard`, {});
  await experience(workspace.id, 'basic');
  assert.equal((await request('/api/workbench')).selectedTaskId, taskId);
  assert.equal((await request(`/api/workbench/workspaces/${workspace.id}/change-sets`)).length, 1);
  assert.deepEqual((await request('/api/workbench')).tasks.find(task => task.id === taskId).policy, policyBefore);
  console.log('OK Basic/Advanced transitions preserve sessions, history and policy; active worktrees block downgrade');

  const secondProject = path.join(tmp, 'second-project');
  await fs.mkdir(secondProject);
  const secondWorkspace = await request('/api/workbench/workspaces', { name: 'Another Basic project', path: secondProject });
  await request(`/api/workbench/workspaces/${secondWorkspace.id}/select`, {});
  const d = await connect(), e = await connect();
  assert.equal(payload(await call(d, 'workbench')).task.id, secondWorkspace.basicTaskId);
  assert.equal(payload(await call(e, 'workbench')).task.id, secondWorkspace.basicTaskId);
  assert.equal(payload(await call(a, 'workbench')).task.id, taskId, 'changing projects never moves an existing chat');
  const competing = await Promise.all([d, e].map(session => call(session, 'write_file', { path: 'race.txt', content: session })));
  assert.equal(competing.filter(result => text(result).includes('approval_required')).length, 1);
  assert.equal(competing.filter(result => text(result).includes('WRITER_REQUIRED')).length, 1);
  assert.equal((await request('/api/workbench')).tasks.filter(task => task.workspaceId === secondWorkspace.id).length, 1);
  await assert.rejects(fs.stat(path.join(secondProject, 'race.txt')), { code: 'ENOENT' });
  await request(`/api/workbench/workspaces/${workspace.id}/select`, {});
  console.log('OK simultaneous writer claims are serialized; new chats use the selected Basic project and old chats stay pinned');

  ok(await call(a, 'write_file', { path: 'restart.txt', content: 'persisted\n' }));
  await stop();
  await start();
  assert.equal((await view(workspace.id)).mode, 'basic');
  assert.equal((await view(workspace.id)).writer.sessionId, a);
  assert.equal(payload(await call(a, 'workbench')).task.id, taskId, 'recovered MCP session retains the default task');
  denied(await call(b, 'write_file', { path: 'restart.txt', content: 'wrong\n' }), /WRITER_REQUIRED/);
  await stop();
  const stateFile = path.join(control, 'state.json');
  const saved = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  for (const item of saved.workspaces) { delete item.experience; delete item.basicTaskId; delete item.writer; }
  await fs.writeFile(stateFile, JSON.stringify(saved));
  await start();
  data = await request('/api/workbench');
  assert.equal(data.workspaces[0].experience, 'advanced', 'legacy workspaces retain the existing Advanced experience');
  assert.equal(data.tasks.find(task => task.id === taskId).id, taskId);
  assert.ok(data.operations.length > 0);
  console.log('OK restart persistence, session recovery and legacy state migration');
  if (process.env.EXPERIENCE_UI_PREVIEW_SECONDS) {
    await experience(workspace.id, 'basic');
    await request(`/api/workbench/workspaces/${workspace.id}/select`, {});
    console.log(`UI fixture: ${admin}/ui/workbench.html#bootstrap=experience-bootstrap`);
    console.log(`Fixture directory: ${tmp}`);
    await new Promise(resolve => setTimeout(resolve, Math.min(1800, Number(process.env.EXPERIENCE_UI_PREVIEW_SECONDS)) * 1000));
  }
} catch (error) {
  console.error(logs.slice(-9000));
  throw error;
} finally {
  await stop();
  if (path.dirname(tmp) === path.resolve(os.tmpdir()) && path.basename(tmp).startsWith('local-experience-test-')) {
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
