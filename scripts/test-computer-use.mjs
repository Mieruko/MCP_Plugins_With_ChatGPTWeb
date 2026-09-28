import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { freePorts } from './test-ports.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-cu-test-'));
const project = path.join(tmp, 'project'); await fs.mkdir(project);
// Machine scope permits explicitly selected files outside the task root too.
const media = path.join(tmp, 'clip.txt'); await fs.writeFile(media, 'synthetic media only');
const upstream = path.join(tmp, 'upstream.json'); await fs.writeFile(upstream, '{"version":1,"servers":[]}');
const [port, adminPort] = await freePorts(2);
const testWindows = process.env.CU_TEST_WINDOWS_PROTOCOL === 'true';
let runCount = 0;
const fixture = http.createServer((req, res) => {
  if (req.url === '/run-count' && req.method === 'POST') { runCount++; res.end('recorded'); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html><body><h1>CU local fixture</h1>
    <label>Caption <input aria-label="Caption"></label>
    <label>Media <input type="file" aria-label="Media" onchange="document.querySelector('#file').textContent=this.files[0]?.name||''"></label>
    <p id="file"></p><button onclick="fetch('/run-count',{method:'POST'});document.querySelector('#output').textContent='WAIT_TEXT_7c1';document.querySelector('#param').hidden=false">Run</button>
    <label id="param" hidden>Parameter <input aria-label="Parameter"></label>
    <button onclick="document.querySelector('#output').textContent='DONE_RUN_7c1 result-7c1.txt'">Continue</button>
    <button onclick="document.querySelector('#output').textContent='ERROR_RUN_7c1'">Fail</button>
    <pre id="output">Idle</pre></body></html>`);
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/`;
let logs = '';
const serverOptions = { cwd: tmp, windowsHide: true,
  env: { ...process.env, PORT: String(port), ADMIN_PORT: String(adminPort), WORKSPACE_PATH: project,
    WORKBENCH_PATH: path.join(tmp, 'control'), MCP_UPSTREAM_CONFIG: upstream,
    COMPUTER_BROWSER_PROFILE_PATH: path.join(tmp, 'saved-browser-profile'),
    MCP_AUTH_TOKEN: 'cu-fixture-token', ADMIN_TOKEN: 'cu-fixture-admin', WORKBENCH_DEFAULT_MODE: 'ask', WORKBENCH_EXPERIENCE: 'advanced',
    CHATGPT_TOOL_PROFILE: 'slim', COMPUTER_USE_ENABLED: 'true', COMPUTER_WINDOWS_ENABLED: String(testWindows), COMPUTER_BROWSER_HEADLESS: 'true',
    COMPUTER_WINDOWS_COMMAND: path.join(repo, '.computer-use-runtime/windows/Scripts/windows-mcp.exe'),
    WORKSPACE_PATHS: '', EXTRA_WORKSPACE_PATHS: '', ALLOWED_WORKSPACE_PATHS: '',
    AUDIT_LOG_PATH: path.join(tmp, 'audit.log'), CHECKPOINT_PATH: path.join(tmp, 'checkpoints'), MCP_SHELL_STATE_DIR: path.join(tmp, 'shell'),
  }, stdio: ['ignore', 'pipe', 'pipe'] };
let server, client;
async function startServer() {
  server = spawn(process.execPath, [path.join(repo, 'dist/index.js')], serverOptions);
  server.stdout.on('data', value => { logs += value; }); server.stderr.on('data', value => { logs += value; });
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch {}
    if (i === 149 || server.exitCode !== null) throw new Error(`server startup failed: ${logs}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  client = new Client({ name: 'computer-fixture', version: '1' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { Authorization: 'Bearer cu-fixture-token' } } });
  await client.connect(transport);
}
async function stopServer() {
  if (server?.exitCode === null && server.signalCode === null) {
    // Stop only the isolated fixture's browsers before process shutdown on Windows.
    for (const session of (await admin('/api/workbench/computer')).sessions) await admin(`/api/workbench/computer/sessions/${session.session_id}/stop`, {});
  }
  await client?.close().catch(() => {});
  if (server?.exitCode === null && server.signalCode === null) {
    const exit = once(server, 'exit'); server.kill('SIGTERM'); await exit;
  }
}
const call = (name, args = {}, owner = 'a') => client.callTool({ name, arguments: args, _meta: { 'openai/session': `cu-fixture-${owner}` } }, undefined, { timeout: 60000 });
function data(result) {
  assert.ok(!result.isError, JSON.stringify(result));
  const parsed = result.structuredContent ?? JSON.parse(result.content[0].text);
  assert.notEqual(parsed.ok, false, JSON.stringify(result));
  return parsed.data ?? parsed;
}
const fail = (result, pattern) => { assert.equal(result.isError, true); assert.match(JSON.stringify(result), pattern); };
async function admin(url, body, method = 'POST') {
  const response = await fetch(`http://127.0.0.1:${adminPort}${url}`, { method: body === undefined ? 'GET' : method,
    headers: { Authorization: 'Bearer cu-fixture-admin', 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const json = await response.json(); assert.equal(response.status, 200, JSON.stringify(json)); return json.data;
}
async function waitEmpty() {
  for (let i = 0; i < 80; i++) { if (!(await admin('/api/workbench/computer')).sessions.length) return; await new Promise(r => setTimeout(r, 100)); }
  throw new Error('session did not stop');
}
try {
  await startServer();
  const names = (await client.listTools()).tools.map(t => t.name);
  for (const name of ['computer_session', 'computer_observe', 'computer_act', 'computer_upload', 'computer_job']) assert.ok(names.includes(name));
  assert.ok(!names.includes('mcp_call'), 'CU does not expose raw upstream calls in slim');
  const initial = data(await call('workbench'));
  const taskId = initial.task.id;
  const workspaceId = (await admin('/api/workbench')).tasks.find(task => task.id === taskId).workspaceId;
  fail(await call('computer_session', { action: 'open' }), /WORKSPACE_EXTERNAL_BLOCKED/);
  const setupDenied = await fetch(`http://127.0.0.1:${adminPort}/api/workbench/computer/setup`, {
    method: 'POST', headers: { Authorization: 'Bearer cu-fixture-admin', 'Content-Type': 'application/json' },
    body: JSON.stringify({ task_id: taskId }),
  });
  assert.equal(setupDenied.status, 400);
  assert.match(await setupDenied.text(), /WORKSPACE_EXTERNAL_BLOCKED/);
  assert.equal((await admin('/api/workbench/computer')).sessions.length, 0);
  await admin(`/api/workbench/tasks/${taskId}/policy`, { mode: 'ask', workspaceOnly: false }, 'PUT');
  const pending = data(await call('computer_session', { action: 'open' }));
  assert.equal(pending.status, 'approval_required');
  assert.equal((await admin('/api/workbench/computer')).sessions.length, 0);
  const approved = data(await admin(`/api/workbench/operations/${pending.operation_id}/decision`, { approve: true }));
  assert.ok(approved.session_id);
  assert.equal(approved.profile.path, serverOptions.env.COMPUTER_BROWSER_PROFILE_PATH);
  const dashboardProfile = await admin('/api/workbench/computer');
  assert.equal(dashboardProfile.shared_profile.path, approved.profile.path);
  assert.ok(dashboardProfile.profiles.every(profile => profile.path === approved.profile.path));
  await admin(`/api/workbench/tasks/${taskId}/policy`, { mode: 'full', workspaceOnly: false }, 'PUT');
  await waitEmpty();
  console.log('OK CU slim discovery, workspace refusal, Ask approval and policy revocation');
  if (testWindows) {
    const nativeSession = data(await call('computer_session', { action: 'open', backend: 'windows', window_title: 'Protocol-only fixture; never captured' }));
    assert.ok(nativeSession.adapter_revision);
    try {
      const result = await call('computer_act', { session_id: nativeSession.session_id,
        observation_id: '00000000-0000-4000-8000-000000000001', action: { kind: 'click', target: 'Mở project' } });
      fail(result, /COMPUTER_TARGET_REQUIRED/);
      const payload = result.structuredContent ?? JSON.parse(result.content[0].text);
      assert.equal(payload.data.code, 'COMPUTER_TARGET_REQUIRED');
      assert.equal(payload.data.diagnostics.required_field, 'action.label');
      assert.equal(payload.data.diagnostics.action_sent, false);
      assert.equal(payload.data.adapter_revision, nativeSession.adapter_revision);
    } finally { data(await call('computer_session', { action: 'close', session_id: nativeSession.session_id })); }
    console.log('OK Windows target error and adapter revision survive real HTTP dispatch; no desktop captured or input sent');
  }
  let sessionId = data(await call('computer_session', { action: 'open' })).session_id;
  fail(await call('computer_observe', { session_id: sessionId }, 'b'), /COMPUTER_NOT_OWNED/);
  const firstObservation = data(await call('computer_observe', { session_id: sessionId }));
  const joined = data(await call('computer_session', { action: 'open' }, 'b'));
  assert.equal(joined.session_id, sessionId, 'same task attaches to one browser process');
  assert.equal(joined.shared, true);
  assert.equal(joined.controller_count, 2);
  assert.equal(data(await call('computer_session', { action: 'open' })).session_id, sessionId, 'idempotent open');
  assert.equal(data(await call('computer_session', { action: 'status' }, 'b')).sessions[0].session_id, sessionId);
  const observedB = data(await call('computer_observe', { session_id: sessionId }, 'b'));
  const navigatedA = data(await call('computer_act', { session_id: sessionId,
    observation_id: firstObservation.observation_id, action: { kind: 'navigate', url: fixtureUrl } }));
  assert.ok(navigatedA.observation_id, 'a second controller observing does not erase the first token');
  fail(await call('computer_act', { session_id: sessionId, observation_id: observedB.observation_id,
    action: { kind: 'key', key: 'Tab' } }, 'b'), /COMPUTER_STALE_OBSERVATION/);
  const currentB = data(await call('computer_observe', { session_id: sessionId }, 'b'));
  const currentA = data(await call('computer_observe', { session_id: sessionId }));
  const changedByB = data(await call('computer_act', { session_id: sessionId,
    observation_id: currentB.observation_id, action: { kind: 'key', key: 'Tab' } }, 'b'));
  assert.equal(changedByB.completed, 1);
  fail(await call('computer_act', { session_id: sessionId, observation_id: currentA.observation_id,
    action: { kind: 'key', key: 'Tab' } }), /COMPUTER_STALE_OBSERVATION/);
  const detachedB = data(await call('computer_session', { action: 'close', session_id: sessionId }, 'b'));
  assert.equal(detachedB.detached, true);
  assert.equal(detachedB.closed, false);
  assert.equal(data(await call('computer_session', { action: 'status' })).sessions[0].controller_count, 1);
  fail(await call('computer_observe', { session_id: sessionId }, 'b'), /COMPUTER_NOT_OWNED/);
  assert.ok(data(await call('computer_observe', { session_id: sessionId })).observation_id,
    'detaching second chat leaves original browser operational');
  console.log('OK two conversations share one task browser, serialized actions, isolated observations and detach without closing Chrome');
  const secondTask = await admin('/api/workbench/tasks', { title: 'Other CU task', workspaceId, environment: { mode: 'local' } });
  await admin(`/api/workbench/tasks/${secondTask.id}/policy`, { mode: 'full', workspaceOnly: false }, 'PUT');
  fail(await call('workbench_control', { action: 'target', task_id: secondTask.id, create_missing: false }), /CONTROL_BUSY/);
  data(await call('workbench_control', { action: 'target', task_id: secondTask.id, create_missing: false }, 'b'));
  fail(await call('computer_observe', { session_id: sessionId }, 'b'), /COMPUTER_NOT_OWNED/);
  const secondSession = data(await call('computer_session', { action: 'open' }, 'b')).session_id;
  fail(await call('workbench_control', { action: 'target', task_id: taskId, create_missing: false }, 'b'), /CONTROL_BUSY/);
  assert.equal(secondSession, sessionId, 'another task in same workspace attaches to global browser');
  assert.equal(data(await call('computer_session', { action: 'status' }, 'b')).sessions[0].task_id, secondTask.id,
    'status reports invoking task, not the first browser owner');
  assert.equal(data(await call('computer_session', { action: 'close', session_id: secondSession }, 'b')).detached, true);
  data(await call('workbench_control', { action: 'target', task_id: taskId, create_missing: false }, 'b'));
  let observation;
  async function observe(image = false) {
    const result = await call('computer_observe', { session_id: sessionId, image });
    observation = data(result);
    if (image) assert.ok(result.content.some(c => c.type === 'image'));
    return observation.output ?? result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  }
  async function act(action) {
    return data(await call('computer_act', { session_id: sessionId, observation_id: observation.observation_id, action }));
  }
  function ref(text, role, label) {
    const line = text.split('\n').find(line => line.includes(`${role} "${label}"`));
    const value = /\[ref=([^\]]+)\]/.exec(line ?? '')?.[1];
    assert.ok(value, `missing ${role} ${label}: ${text}`); return value;
  }
  await observe();
  const batchReady = await act({ kind: 'navigate', url: fixtureUrl });
  // Reuse the returned snapshot; no extra observe/model turn between actions.
  assert.ok(batchReady.observation_id);
  const batched = data(await call('computer_act', { session_id: sessionId, observation_id: batchReady.observation_id,
    action: { kind: 'click', target: ref(batchReady.output, 'button', 'Continue'), repeat: 20 } }));
  assert.equal(batched.completed, 20); assert.equal(batched.remaining, 0);
  console.log(`OK 20 repeated clicks through HTTP dispatch: ${batched.elapsed_ms}ms with returned observation`);
  let snapshot = await observe(true);
  const oldObservation = observation.observation_id;
  await act({ kind: 'type', target: ref(snapshot, 'textbox', 'Caption'), text: 'Tiếng Việt — mô tả ảnh và clip' });
  fail(await call('computer_act', { session_id: sessionId, observation_id: oldObservation, action: { kind: 'key', key: 'Enter' } }), /COMPUTER_STALE_OBSERVATION/);
  snapshot = await observe(); assert.ok(snapshot.includes('Tiếng Việt'));
  assert.equal(data(await call('computer_session', { action: 'open' }, 'b')).session_id, sessionId);
  await act({ kind: 'click', target: ref(snapshot, 'button', 'Media') });
  fail(await call('computer_observe', { session_id: sessionId }, 'b'), /COMPUTER_FILE_CHOOSER_PENDING/);
  snapshot = await observe();
  fail(await call('computer_upload', { session_id: sessionId, observation_id: observation.observation_id, paths: [path.join(tmp, 'missing.txt')] }), /ENOENT|COMPUTER_FILE/);
  const uploaded = await call('computer_upload', { session_id: sessionId, observation_id: observation.observation_id, paths: [media] });
  data(uploaded);
  assert.equal(data(await call('computer_session', { action: 'close', session_id: sessionId }, 'b')).detached, true);
  snapshot = await observe(); assert.ok(snapshot.includes('clip.txt'));
  const job = data(await call('computer_job', { action: 'create', workflow: 'generic', session_id: sessionId, expected_url: fixtureUrl,
    success_text: ['DONE_RUN_7c1'], failure_text: 'ERROR_RUN_7c1', input_text: 'WAIT_TEXT_7c1', artifact_text: 'result-7c1.txt' }));
  data(await call('workbench_control', { action: 'target', task_id: secondTask.id, create_missing: false }, 'b'));
  fail(await call('computer_job', { action: 'status', job_id: job.id }, 'b'), /ENOENT|NOT_OWNED/);
  data(await call('workbench_control', { action: 'target', task_id: taskId, create_missing: false }, 'b'));
  await act({ kind: 'click', target: ref(snapshot, 'button', 'Run') });
  fail(await call('computer_job', { action: 'poll', job_id: job.id }, 'b'), /COMPUTER_JOB_NOT_OWNED/);
  fail(await call('computer_job', { action: 'cancel', job_id: job.id }, 'b'), /COMPUTER_JOB_NOT_OWNED/);
  assert.equal(data(await call('computer_job', { action: 'poll', job_id: job.id })).state, 'waiting_input');
  snapshot = await observe();
  await act({ kind: 'type', target: ref(snapshot, 'textbox', 'Parameter'), text: 'đầu vào bổ sung' });
  snapshot = await observe(); await act({ kind: 'click', target: ref(snapshot, 'button', 'Continue') });
  data(await call('computer_job', { action: 'monitor', job_id: job.id, duration_seconds: 10 }));
  let monitored;
  for (let i = 0; i < 40; i++) {
    monitored = data(await call('computer_job', { action: 'status', job_id: job.id }));
    if (monitored.state === 'succeeded') break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(monitored.state, 'succeeded');
  const wrongTarget = data(await call('computer_job', { action: 'create', session_id: sessionId, expected_url: fixtureUrl + 'different', success_text: ['DONE_RUN_7c1'] }));
  assert.equal(data(await call('computer_job', { action: 'poll', job_id: wrongTarget.id })).state, 'unknown');
  const failedJob = data(await call('computer_job', { action: 'create', session_id: sessionId, expected_url: fixtureUrl, success_text: ['DONE_RUN_7c1'], failure_text: 'ERROR_RUN_7c1' }));
  snapshot = await observe(); await act({ kind: 'click', target: ref(snapshot, 'button', 'Fail') });
  assert.equal(data(await call('computer_job', { action: 'poll', job_id: failedJob.id })).state, 'failed');
  console.log(`OK real ${process.env.COMPUTER_BROWSER === 'msedge' ? 'Edge' : 'Chrome'}: native screenshot, Vietnamese, stale action refusal, file chooser/upload, input wait and verified completion markers`);

  const next = data(await call('computer_job', { action: 'create', session_id: sessionId, expected_url: fixtureUrl, success_text: ['NEVER_COMPLETE'] }));
  assert.equal(data(await call('computer_job', { action: 'poll', job_id: next.id })).state, 'running');
  data(await call('computer_job', { action: 'monitor', job_id: next.id, duration_seconds: 600 }));
  assert.ok(data(await call('computer_job', { action: 'list' })).jobs.find(j => j.id === next.id).monitoring);
  await admin(`/api/workbench/computer/sessions/${sessionId}/stop`, {});
  await waitEmpty();
  const actionsBeforeRestart = runCount;
  await stopServer();
  await startServer();
  assert.equal(data(await call('workbench')).task.id, taskId, 'conversation retained its task after real server restart');
  assert.equal(data(await call('computer_job', { action: 'status', job_id: job.id })).state, 'succeeded');
  assert.ok(!data(await call('computer_job', { action: 'list' })).jobs.find(j => j.id === next.id).monitoring, 'monitor must not restart implicitly');
  assert.equal((await admin('/api/workbench/computer')).sessions.length, 0);
  assert.equal(runCount, actionsBeforeRestart, 'restart must not replay Run');
  console.log('OK real server restart preserves jobs/task binding without reopening browser, monitor or replaying Run');
  fail(await call('computer_observe', { session_id: sessionId }), /COMPUTER_NOT_OWNED/);
  assert.equal(data(await call('computer_job', { action: 'poll', job_id: next.id })).state, 'disconnected');
  sessionId = data(await call('computer_session', { action: 'open' })).session_id;
  data(await call('computer_job', { action: 'resume', job_id: next.id, session_id: sessionId }));
  await observe(); await act({ kind: 'navigate', url: fixtureUrl });
  assert.equal(data(await call('computer_job', { action: 'poll', job_id: next.id })).state, 'running');
  assert.equal(data(await call('computer_job', { action: 'cancel', job_id: next.id })).state, 'cancelled');
  await waitEmpty();
  assert.ok((await admin('/api/workbench/computer')).jobs.some(j => j.id === job.id && j.state === 'succeeded'));
  console.log('OK dashboard stop, persisted job progress, disconnected/resume without replay and cancellation');
  await admin(`/api/workbench/tasks/${taskId}/policy`, { mode: 'auto', workspaceOnly: false }, 'PUT');
  const autoPending = data(await call('computer_session', { action: 'open' }));
  assert.equal(autoPending.status, 'approval_required');
  await admin(`/api/workbench/operations/${autoPending.operation_id}/decision`, { approve: false });
  assert.equal((await admin('/api/workbench/computer')).sessions.length, 0);
  await admin(`/api/workbench/tasks/${taskId}/policy`, { mode: 'full', workspaceOnly: false }, 'PUT');
  await admin(`/api/workbench/workspaces/${workspaceId}/experience`, { mode: 'basic' }, 'PUT');
  // Basic routes both conversations to its one task, retaining machine policy.
  const basicTaskId = data(await call('workbench')).task.id;
  await admin(`/api/workbench/tasks/${basicTaskId}/policy`, { mode: 'full', workspaceOnly: false }, 'PUT');
  sessionId = data(await call('computer_session', { action: 'open' })).session_id;
  data(await call('workbench', {}, 'b'));
  fail(await call('computer_observe', { session_id: sessionId }, 'b'), /WRITER_REQUIRED/);
  const experience = await admin(`/api/workbench/workspaces/${workspaceId}/experience`);
  const nextWriter = experience.sessions.find(s => s.sessionId !== experience.writer.sessionId);
  assert.ok(nextWriter);
  await admin(`/api/workbench/workspaces/${workspaceId}/writer`, { sessionId: nextWriter.sessionId, expectedSessionId: experience.writer.sessionId });
  await waitEmpty();
  fail(await call('computer_session', { action: 'open' }), /WRITER_REQUIRED/);
  console.log('OK two-task session/job isolation, active CU blocks retarget, Auto approval, Basic writer capture refusal and transfer revocation');
  if (process.env.CU_TEST_SETUP_HEADED === 'true') {
    const beforeSetup = await admin('/api/workbench');
    const setup = await admin('/api/workbench/computer/setup', { task_id: basicTaskId });
    assert.ok(setup.session_id, JSON.stringify(setup));
    assert.equal(setup.manual_setup, true);
    assert.equal(setup.profile.headed, true, 'manual setup opens a visible browser even if automation is headless');
    assert.equal(setup.profile.persistent, true);
    const linkedSetup = data(await call('computer_session', { action: 'open' }, 'b'));
    assert.equal(linkedSetup.session_id, setup.session_id, 'automation attaches to the headed setup browser');
    assert.equal(linkedSetup.manual_setup, false, 'explicit open transitions setup to automation');
    assert.equal(linkedSetup.profile.headed, true, 'do not relaunch the setup profile headless');
    assert.ok(data(await call('computer_observe', { session_id: setup.session_id }, 'b')).observation_id);
    const afterSetup = await admin('/api/workbench');
    assert.deepEqual(afterSetup.tasks.map(t => [t.id, t.policy]), beforeSetup.tasks.map(t => [t.id, t.policy]));
    const afterExperience = await admin(`/api/workbench/workspaces/${workspaceId}/experience`);
    assert.equal(afterExperience.writer.sessionId, nextWriter.sessionId, 'setup does not transfer writer');
    await admin(`/api/workbench/computer/sessions/${setup.session_id}/stop`, {});
    await waitEmpty();
    console.log('OK dashboard setup browser reused by ChatGPT without closing/reopening, same profile and policy/writer unchanged');
  }
} catch (error) {
  await fs.writeFile(path.join(tmp, 'server.log'), logs);
  console.error(`Fixture logs: ${tmp}`); throw error;
} finally {
  await stopServer();
  await new Promise(resolve => fixture.close(resolve));
}
