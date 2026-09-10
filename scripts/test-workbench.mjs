import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { githubArguments, githubSchema } from '../dist/tools/github.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'local-workbench-test-'));
const workspace = path.join(tmp, 'project');
await fs.mkdir(workspace);
await fs.writeFile(path.join(workspace, 'sample.txt'), 'before\n');
await fs.writeFile(path.join(workspace, 'AGENTS.md'), 'FIRST_PROJECT_PRIVATE_INSTRUCTIONS');
await fs.writeFile(path.join(tmp, 'outside.txt'), 'outside-secret');
await fs.mkdir(path.join(tmp, 'external'));
await fs.writeFile(path.join(tmp, 'external', 'secret.txt'), 'junction-secret');
await fs.writeFile(path.join(tmp, 'upstream.json'), '{"version":1,"servers":[]}');
const freePort = async () => { const s = net.createServer(); await new Promise(r => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise(r => s.close(r)); return p; };
const port = await freePort(), adminPort = await freePort();
const base = `http://127.0.0.1:${port}`, admin = `http://127.0.0.1:${adminPort}`;
const env = { ...process.env, PORT: String(port), ADMIN_PORT: String(adminPort), WORKSPACE_PATH: workspace,
  MCP_AUTH_TOKEN: 'workbench-test-mcp', ADMIN_TOKEN: 'workbench-test-admin', WORKBENCH_PATH: path.join(tmp, 'control'), WORKBENCH_DEFAULT_MODE: 'ask',
  MCP_UPSTREAM_CONFIG: path.join(tmp, 'upstream.json'), AUDIT_LOG_PATH: path.join(tmp, 'audit.log'), CHECKPOINT_PATH: path.join(tmp, 'checkpoints'),
  MCP_SHELL_STATE_DIR: path.join(tmp, 'shell'), CODEX_HOME: path.join(tmp, 'codex'), CHATGPT_TOOL_PROFILE: 'full',
  WORKSPACE_PATHS: '', EXTRA_WORKSPACE_PATHS: '', ALLOWED_WORKSPACE_PATHS: '' };
let server, logs = '', sid, seq = 0;
async function start() {
  server = spawn(process.execPath, [path.join(root, 'dist/index.js')], { cwd: tmp, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', d => { logs += d; }); server.stderr.on('data', d => { logs += d; });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/health')).ok) return; } catch {} await new Promise(r => setTimeout(r, 100)); }
  throw new Error('Server failed to start: ' + logs);
}
async function stop() { if (!server || server.exitCode !== null) return; const closed = new Promise(r => server.once('exit', r)); server.kill(); await closed; }
async function rpc(method, params) {
  const res = await fetch(base + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer workbench-test-mcp', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }), signal: AbortSignal.timeout(10000) });
  assert.equal(res.status, 200);
  if (res.headers.get('mcp-session-id')) sid = res.headers.get('mcp-session-id');
  return (await res.json()).result;
}
const call = (name, args = {}) => rpc('tools/call', { name, arguments: args });
const text = result => result.content.map(c => c.text || '').join('\n');
const payload = result => JSON.parse(text(result));
async function adminRequest(url, body, method = 'POST', expected = 200) {
  const res = await fetch(admin + url, { method: body === undefined ? 'GET' : method, headers: { Authorization: 'Bearer workbench-test-admin', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const json = await res.json(); assert.equal(res.status, expected, JSON.stringify(json)); return json.data ?? json;
}
const policy = (id, mode, workspaceOnly) => adminRequest(`/api/workbench/tasks/${id}/policy`, { mode, workspaceOnly }, 'PUT');
const approve = (id, expected = 200) => adminRequest(`/api/workbench/operations/${id}/decision`, { approve: true }, 'POST', expected);
const undo = (id, redo = false, expected = 200) => adminRequest(`/api/workbench/operations/${id}/undo`, { redo }, 'POST', expected);
const git = args => execFileSync('git', args, { cwd: workspace, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
try {
  await start();
  assert.equal((await fetch(base + '/mcp')).status, 401);
  assert.equal((await fetch(admin + '/api/workbench')).status, 401);
  assert.equal((await fetch(admin + '/api/workbench', { headers: { Authorization: 'Bearer workbench-test-admin', Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(admin + '/ui/workbench.html')).status, 200);
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'workbench-tests', version: '1' } });
  const task = payload(await call('workbench')).task;
  assert.equal(task.policy.mode, 'ask'); assert.equal(task.policy.workspaceOnly, true);
  const toolList = await rpc('tools/list', {});
  assert.ok(toolList.tools.some(t => t.name === 'github'));
  assert.equal(toolList.tools.find(t => t.name === 'run_command').annotations.openWorldHint, true);
  console.log('OK authentication, origin guard, default policy, honest tool metadata');

  const originalSid = sid;
  const secondWorkspace = path.join(tmp, 'second-project');
  await fs.mkdir(secondWorkspace);
  await fs.writeFile(path.join(secondWorkspace, 'sample.txt'), 'second workspace');
  await fs.writeFile(path.join(secondWorkspace, 'AGENTS.md'), 'SECOND_PROJECT_INSTRUCTIONS');
  const secondTask = await adminRequest('/api/workbench/tasks', { title: 'Second project', workspace: secondWorkspace });
  await adminRequest(`/api/workbench/tasks/${secondTask.id}/select`, {});
  assert.equal(payload(await call('workbench')).task.id, task.id, 'Existing session stays pinned');
  sid = undefined;
  const secondInit = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'second-session', version: '1' } });
  assert.ok(secondInit.instructions.includes('SECOND_PROJECT_INSTRUCTIONS'));
  assert.ok(!secondInit.instructions.includes('FIRST_PROJECT_PRIVATE_INSTRUCTIONS'));
  await adminRequest(`/api/workbench/tasks/${task.id}/select`, {});
  assert.equal(payload(await call('workbench')).task.id, secondTask.id);
  assert.ok(text(await call('read_text_file', { path: 'sample.txt' })).includes('second workspace'));
  assert.ok(text(await call('project_context')).includes('second-project'));
  await policy(secondTask.id, 'full', false);
  execFileSync('git', ['init'], { cwd: secondWorkspace, windowsHide: true, stdio: 'pipe' });
  assert.equal((await call('git_status')).isError, undefined, 'Git uses selected task workspace');
  assert.ok(text(await call('run_command', { command: 'node -p "process.cwd()"' })).includes('second-project'));
  await adminRequest(`/api/workbench/tasks/${task.id}/select`, {});
  sid = originalSid;
  assert.ok(text(await call('read_text_file', { path: 'sample.txt' })).includes('before'));
  console.log('OK new sessions select a different workspace; existing sessions remain pinned');

  const resource = base + '/mcp', callback = 'https://chatgpt.com/connector/oauth/workbench-test';
  const registration = await fetch(base + '/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    client_name: 'Workbench OAuth Test', redirect_uris: [callback], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
  }) });
  assert.equal(registration.status, 201); const client = await registration.json();
  const verifier = randomBytes(32).toString('base64url'), challenge = createHash('sha256').update(verifier).digest('base64url');
  const query = new URLSearchParams({ client_id: client.client_id, redirect_uri: callback, response_type: 'code', code_challenge: challenge,
    code_challenge_method: 'S256', state: 'original-state', resource, scope: 'mcp' });
  const authorization = await fetch(base + '/authorize?' + query, { redirect: 'manual' });
  assert.equal(authorization.status, 302);
  const pendingUrl = authorization.headers.get('location'), cookie = authorization.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(base + pendingUrl)).status, 400);
  assert.equal((await fetch(base + pendingUrl, { headers: { Cookie: cookie } })).status, 200);
  const connection = (await adminRequest('/api/workbench/connections')).find(c => c.clientName === 'Workbench OAuth Test');
  await adminRequest(`/api/workbench/connections/${connection.id}`, { approve: true });
  const redirect = await fetch(base + pendingUrl, { headers: { Cookie: cookie }, redirect: 'manual' });
  const target = new URL(redirect.headers.get('location'));
  assert.equal(target.origin, 'https://chatgpt.com'); assert.equal(target.searchParams.get('state'), 'original-state');
  assert.equal(target.searchParams.get('iss'), base + '/');
  const exchange = values => fetch(base + '/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: client.client_id, ...values }) });
  const exchangeArgs = { grant_type: 'authorization_code', code: target.searchParams.get('code'), code_verifier: verifier, redirect_uri: callback, resource };
  assert.equal((await exchange({ ...exchangeArgs, code_verifier: 'wrong'.repeat(12) })).status, 400);
  assert.equal((await exchange({ ...exchangeArgs, resource: 'https://wrong.example/mcp' })).status, 400);
  const tokenResponse = await exchange(exchangeArgs); assert.equal(tokenResponse.status, 200); const oauthTokens = await tokenResponse.json();
  assert.equal((await exchange(exchangeArgs)).status, 400);
  const refreshed = await exchange({ grant_type: 'refresh_token', refresh_token: oauthTokens.refresh_token, resource });
  assert.equal(refreshed.status, 200); const freshTokens = await refreshed.json();
  assert.equal((await exchange({ grant_type: 'refresh_token', refresh_token: oauthTokens.refresh_token, resource })).status, 400);
  const oauthAccessStatus = async token => (await fetch(base + '/mcp', { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' } })).status;
  assert.notEqual(await oauthAccessStatus(freshTokens.access_token), 401);
  console.log('OK OAuth registration, local consent, browser binding, PKCE, audience, one-time code and refresh rotation');

  const request = payload(await call('write_file', { path: 'sample.txt', content: 'after\n' }));
  assert.equal(request.status, 'approval_required');
  assert.equal(await fs.readFile(path.join(workspace, 'sample.txt'), 'utf8'), 'before\n');
  await approve(request.operation_id);
  assert.equal(await fs.readFile(path.join(workspace, 'sample.txt'), 'utf8'), 'after\n');
  await approve(request.operation_id, 400);
  let op = await adminRequest(`/api/workbench/operations/${request.operation_id}`);
  assert.equal(op.changes.length, 1);
  await fs.writeFile(path.join(workspace, 'sample.txt'), 'human edit\n');
  assert.match(JSON.stringify(await undo(request.operation_id, false, 400)), /UNDO_CONFLICT/);
  assert.equal(await fs.readFile(path.join(workspace, 'sample.txt'), 'utf8'), 'human edit\n');
  await fs.writeFile(path.join(workspace, 'sample.txt'), 'after\n');
  await undo(request.operation_id); assert.equal(await fs.readFile(path.join(workspace, 'sample.txt'), 'utf8'), 'before\n');
  await undo(request.operation_id, true); assert.equal(await fs.readFile(path.join(workspace, 'sample.txt'), 'utf8'), 'after\n');
  console.log('OK pending write, approve once, conflict-safe Undo and Redo');

  const stale = payload(await call('write_file', { path: 'sample.txt', content: 'stale write' }));
  await fs.writeFile(path.join(workspace, 'sample.txt'), 'new human edit');
  assert.match(JSON.stringify(await approve(stale.operation_id, 400)), /APPROVAL_CONFLICT/);
  assert.equal(await fs.readFile(path.join(workspace, 'sample.txt'), 'utf8'), 'new human edit');
  const revoked = payload(await call('write_file', { path: 'sample.txt', content: 'revoked' }));
  await policy(task.id, 'auto', true); await approve(revoked.operation_id, 400);
  assert.equal((await call('write_file', { path: 'sample.txt', content: 'auto edit' })).isError, undefined);
  console.log('OK stale approval and policy changes invalidate pending requests');

  assert.equal((await call('read_text_file', { path: '../outside.txt' })).isError, true);
  assert.equal((await call('write_file', { path: '../outside.txt', content: 'escaped' })).isError, true);
  assert.equal((await call('run_command', { command: 'echo unsafe' })).isError, true);
  assert.equal((await call('git_status')).isError, true);
  assert.equal((await call('apply_patch', { patch: '*** Begin Patch\n*** Add File: ../escape.txt\n+x\n*** End Patch', dry_run: true })).isError, true);
  assert.equal(await fs.readFile(path.join(tmp, 'outside.txt'), 'utf8'), 'outside-secret');
  await fs.symlink(path.join(tmp, 'external'), path.join(workspace, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await call('read_text_file', { path: 'linked/secret.txt' })).isError, true);
  assert.ok(!text(await call('grep', { path: '.', pattern: 'junction-secret' })).includes('junction-secret\n'));
  assert.equal((await call('read_text_file', { path: path.join(tmp, 'control', 'credentials.json') })).isError, true);
  console.log('OK parent traversal, junction, patch escape, control-state access and unsandboxed execution blocked');

  await call('create_directory', { path: 'created-dir' });
  const mkdirOp = (await adminRequest('/api/workbench')).operations.find(o => o.tool === 'create_directory');
  await fs.writeFile(path.join(workspace, 'created-dir', 'human.txt'), 'keep');
  await undo(mkdirOp.id, false, 400);
  assert.equal(await fs.readFile(path.join(workspace, 'created-dir', 'human.txt'), 'utf8'), 'keep');

  git(['init']); git(['config', 'user.name', 'Workbench Test']); git(['config', 'user.email', 'workbench@example.invalid']);
  git(['add', '--', 'sample.txt']); git(['commit', '-m', 'baseline']);
  await fs.writeFile(path.join(workspace, 'sample.txt'), 'selected change');
  await fs.writeFile(path.join(workspace, 'unrelated.txt'), 'keep unstaged');
  await policy(task.id, 'full', false);
  assert.equal((await call('git_add', { files: ['sample.txt'] })).isError, undefined);
  assert.equal((await call('git_commit', { message: 'selected only' })).isError, undefined);
  assert.equal(git(['show', '--format=', '--name-only', 'HEAD']), 'sample.txt');
  assert.match(git(['status', '--short']), /unrelated.txt/);
  assert.equal((await call('git_branch', { action: 'create', name: '--force' })).isError, true);
  assert.equal((await call('git_push', {})).isError, true);
  console.log('OK local commit excludes unrelated files; option injection and implicit push rejected');
  await policy(task.id, 'ask', false);
  await fs.writeFile(path.join(workspace, 'sample.txt'), 'first staged version'); git(['add', 'sample.txt']);
  const commitApproval = payload(await call('git_commit', { message: 'must not commit a different index' }));
  await fs.writeFile(path.join(workspace, 'sample.txt'), 'different staged version'); git(['add', 'sample.txt']);
  assert.match(JSON.stringify(await approve(commitApproval.operation_id, 400)), /APPROVAL_CONFLICT/);
  assert.equal(git(['log', '-1', '--format=%s']), 'selected only');
  console.log('OK Git approval refuses an index changed after review');

  const gh = input => githubArguments(githubSchema.parse(input));
  assert.throws(() => gh({ action: 'pr_create_draft', repo: 'owner/repo', title: 'T', body: 'B', base: 'main', head: 'branch' }));
  assert.deepEqual(gh({ action: 'pr_merge', repo: 'owner/repo', number: 2, expected_head: 'a'.repeat(40) }).slice(-2), ['--match-head-commit', 'a'.repeat(40)]);
  assert.throws(() => gh({ action: 'pr_merge', repo: 'owner/repo', number: 2 }));
  console.log('OK GitHub plans bind repo/head/SHA without making network calls');

  await policy(task.id, 'ask', true);
  const interrupted = payload(await call('write_file', { path: 'restart.txt', content: 'must not execute' }));
  const preRestartSid = sid;
  await adminRequest(`/api/workbench/tasks/${secondTask.id}/select`, {});
  await stop(); sid = undefined; await start();
  sid = preRestartSid;
  assert.equal(payload(await call('workbench')).task.id, task.id, 'Recovered session retains its original task across restart');
  await adminRequest(`/api/workbench/tasks/${task.id}/select`, {});
  const recovered = await adminRequest(`/api/workbench/operations/${interrupted.operation_id}`);
  assert.equal(recovered.status, 'interrupted');
  await assert.rejects(fs.stat(path.join(workspace, 'restart.txt')));
  op = await adminRequest(`/api/workbench/operations/${request.operation_id}`);
  assert.equal(op.changes.length, 1);
  assert.notEqual(await oauthAccessStatus(freshTokens.access_token), 401);
  const revoke = await fetch(base + '/revoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: client.client_id, token: freshTokens.refresh_token }) });
  assert.equal(revoke.status, 200);
  assert.equal(await oauthAccessStatus(freshTokens.access_token), 401);
  console.log('OK restart preserves history and never replays pending writes');
  console.log('OK OAuth grants survive restart and revoke all client tokens');
  if (process.env.WORKBENCH_UI_PREVIEW_SECONDS) {
    await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ui-preview', version: '1' } });
    await call('write_file', { path: 'sample.txt', content: 'Preview change awaiting your review\n' });
    console.log(`UI_PREVIEW ${admin}/ui/workbench.html (fixture token: workbench-test-admin)`);
    await new Promise(resolve => setTimeout(resolve, Math.min(300, Number(process.env.WORKBENCH_UI_PREVIEW_SECONDS) || 0) * 1000));
  }
} catch (error) { console.error(logs.slice(-5000)); throw error; }
finally {
  await stop();
  const resolved = path.resolve(tmp);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('local-workbench-test-')) throw new Error('Unsafe test cleanup path');
  await fs.rm(resolved, { recursive: true, force: true });
}
