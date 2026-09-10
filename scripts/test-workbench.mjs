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
  MCP_ACTIVE_SESSION_MS: '1000',
  WORKBENCH_SANDBOX_PROVIDER: 'none',
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
function sseEvents(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const next = async () => {
    while (true) {
      const end = buffer.indexOf('\n\n');
      if (end !== -1) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (!frame || frame.startsWith(':')) continue;
        const event = frame.split('\n').find(line => line.startsWith('event:'))?.slice(6).trim() || 'message';
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
        return { event, data: data ? JSON.parse(data) : null };
      }
      const { done, value } = await reader.read();
      if (done) throw new Error('SSE stream closed before the next event');
      buffer += decoder.decode(value, { stream: true });
    }
  };
  return { next, close: () => reader.cancel() };
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
  const workbenchHtmlResponse = await fetch(admin + '/ui/workbench.html');
  assert.equal(workbenchHtmlResponse.status, 200);
  const workbenchHtml = await workbenchHtmlResponse.text();
  assert.match(workbenchHtml, /Workspace & tasks/);
  assert.match(workbenchHtml, /\+ Add workspace/);
  assert.match(workbenchHtml, /Add project folder/);
  assert.match(workbenchHtml, /What are you working on\?/);
  assert.match(workbenchHtml, /Restrict access to this workspace/);
  assert.doesNotMatch(workbenchHtml, /Use task for new ChatGPT session/);
  assert.doesNotMatch(workbenchHtml, /Task & permissions/);
  assert.equal((await fetch(admin + '/ui/workbench-app.css')).status, 200);
  assert.equal((await fetch(admin + '/ui/workbench/app.js')).status, 200);
  assert.equal((await fetch(admin + '/ui/workbench/history.js')).status, 200);
  assert.equal((await fetch(admin + '/ui/workbench/agent-identity.js')).status, 200);
  assert.equal((await fetch(admin + '/ui/workbench/agent-presence.js')).status, 200);
  assert.equal((await fetch(admin + '/ui/workbench/terminal.js')).status, 200);
  assert.equal((await fetch(admin + '/ui/workbench/monaco.js')).status, 200);
  assert.equal((await fetch(admin + '/vendor/monaco/vs/loader.js')).status, 200);
  const initialWorkbench = await adminRequest('/api/workbench');
  assert.equal(initialWorkbench.capabilities.osSandbox, false);
  assert.equal(initialWorkbench.capabilities.sandbox.provider, 'none');
  assert.equal(initialWorkbench.capabilities.sandbox.available, false);
  const { isLiveAgentSession, liveAgentPriority } = await import(new URL('../public/ui/workbench/agent-presence.js', import.meta.url));
  const presenceNow = Date.now();
  assert.equal(isLiveAgentSession({ id: 'legacy-old', lastAccessedAt: new Date(presenceNow - 60_000).toISOString() }, [], presenceNow), false, 'legacy recoverable session is not implicitly active');
  assert.equal(isLiveAgentSession({ id: 'legacy-new', lastAccessedAt: new Date(presenceNow - 5_000).toISOString() }, [], presenceNow), true, 'legacy backend only gets a short recent fallback');
  assert.equal(isLiveAgentSession({ id: 'explicit-idle', active: false, connected: false, inFlightRequests: 0, liveConnections: 0, lastAccessedAt: new Date(presenceNow).toISOString() }, [], presenceNow), false, 'explicit dormant telemetry wins over recency');
  assert.equal(isLiveAgentSession({ id: 'working', active: false, inFlightRequests: 1, lastAccessedAt: new Date(presenceNow - 60_000).toISOString() }, [], presenceNow), true, 'in-flight work is always active');
  assert.ok(liveAgentPriority({ id: 'working', inFlightRequests: 1 }, []) < liveAgentPriority({ id: 'connected', connected: true }, []), 'working agents sort ahead of merely connected agents');
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'workbench-tests', version: '1' } });
  const task = payload(await call('workbench')).task;
  assert.equal(task.policy.mode, 'ask'); assert.equal(task.policy.workspaceOnly, true);
  let workspaceState = await adminRequest('/api/workbench');
  assert.equal(workspaceState.workspaces.length, 1, 'bootstrap task creates one registered workspace');
  assert.equal(task.workspaceId, workspaceState.workspaces[0].id);
  assert.equal(workspaceState.selectedWorkspaceId, task.workspaceId);
  let sessionHealth = await adminRequest('/health');
  assert.equal(sessionHealth.active_sessions, 1, 'one live/recent ChatGPT session is one active agent');
  assert.equal(sessionHealth.recoverable_sessions, 1);
  assert.equal(sessionHealth.sessions[0].active, true);
  await new Promise(resolve => setTimeout(resolve, 1350));
  sessionHealth = await adminRequest('/health');
  assert.equal(sessionHealth.active_sessions, 0, 'recoverable historical sessions are not counted as active agents');
  assert.equal(sessionHealth.recoverable_sessions, 1, 'inactive session remains available for recovery');
  assert.equal(sessionHealth.sessions[0].active, false);
  await call('workbench');
  sessionHealth = await adminRequest('/health');
  assert.equal(sessionHealth.active_sessions, 1, 'a real request makes the session active again');
  const longEditorContent = Array.from({ length: 2105 }, (_, index) => `editor-line-${index + 1}`).join('\n');
  await fs.writeFile(path.join(workspace, 'long-editor.txt'), longEditorContent);
  const fullEditorFile = await adminRequest(`/api/workbench/tasks/${task.id}/file?path=long-editor.txt`);
  assert.equal(fullEditorFile.content, longEditorContent, 'editor file route must not truncate editable content');
  const limitedEditorFile = await adminRequest(`/api/workbench/tasks/${task.id}/file?path=long-editor.txt&limit=20`);
  assert.equal(limitedEditorFile.content.split('\n').length, 20, 'explicit preview limit remains supported');
  const editorSave = await adminRequest(`/api/workbench/tasks/${task.id}/file`, { path: 'sample.txt', content: 'editor pending\n' }, 'PUT');
  const editorSavePayload = JSON.parse(editorSave.content[0].text);
  assert.equal(editorSavePayload.status, 'approval_required', 'editor save honors Ask policy');
  assert.equal(await fs.readFile(path.join(workspace, 'sample.txt'), 'utf8'), 'before\n', 'pending editor save must not write before approval');
  await adminRequest(`/api/workbench/operations/${editorSavePayload.operation_id}/decision`, { approve: false });
  const eventResponse = await fetch(admin + '/api/workbench/events', { headers: { Authorization: 'Bearer workbench-test-admin' } });
  assert.equal(eventResponse.status, 200);
  const eventStream = sseEvents(eventResponse);
  const initialEvent = await eventStream.next();
  assert.equal(initialEvent.event, 'change');
  assert.deepEqual(initialEvent.data.scopes, ['state']);
  assert.equal(initialEvent.data.reason, 'initial');
  const typedEventPromise = eventStream.next();
  await policy(task.id, 'ask', true);
  const typedEvent = await typedEventPromise;
  assert.equal(typedEvent.event, 'change');
  assert.equal(typedEvent.data.taskId, task.id);
  assert.ok(typedEvent.data.scopes.includes('tasks'));
  assert.ok(typedEvent.data.scopes.includes('operations'));
  await eventStream.close();
  const toolList = await rpc('tools/list', {});
  assert.ok(toolList.tools.some(t => t.name === 'github'));
  assert.equal(toolList.tools.find(t => t.name === 'run_command').annotations.openWorldHint, true);
  console.log('OK authentication, origin guard, default policy, honest tool metadata');

  const originalSid = sid;
  const secondWorkspace = path.join(tmp, 'second-project');
  await fs.mkdir(secondWorkspace);
  await fs.writeFile(path.join(secondWorkspace, 'sample.txt'), 'second workspace');
  await fs.writeFile(path.join(secondWorkspace, 'AGENTS.md'), 'SECOND_PROJECT_INSTRUCTIONS');
  const folderListing = await adminRequest(`/api/workbench/folders?path=${encodeURIComponent(tmp)}`);
  assert.ok(folderListing.directories.some(entry => entry.path === secondWorkspace), 'folder browser exposes local project directories');
  const secondWorkspaceRecord = await adminRequest('/api/workbench/workspaces', { name: 'Second project', path: secondWorkspace });
  workspaceState = await adminRequest('/api/workbench');
  assert.equal(workspaceState.workspaces.length, 2);
  assert.equal(workspaceState.tasks.filter(item => item.workspaceId === secondWorkspaceRecord.id).length, 0, 'workspace may exist without a task');
  await adminRequest(`/api/workbench/workspaces/${secondWorkspaceRecord.id}/select`, {});
  workspaceState = await adminRequest('/api/workbench');
  assert.equal(workspaceState.selectedWorkspaceId, secondWorkspaceRecord.id);
  assert.equal(workspaceState.selectedTaskId, undefined, 'selecting an empty workspace does not invent a dashboard task');
  const secondTask = await adminRequest('/api/workbench/tasks', { title: 'Second project', workspaceId: secondWorkspaceRecord.id });
  assert.equal(secondTask.workspaceId, secondWorkspaceRecord.id);
  assert.equal(secondTask.workspace, secondWorkspace);
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
  // Non-read operations in different workspaces should overlap, while two
  // mutations in the same workspace must remain serialized. Use timestamps
  // written by the child commands instead of a flaky wall-clock threshold.
  await policy(task.id, 'full', false);
  const timedCommand = (file, waitMs) => `node -e "const fs=require('fs');const f='${file}';const v={start:Date.now()};fs.writeFileSync(f,JSON.stringify(v));setTimeout(()=>{v.end=Date.now();fs.writeFileSync(f,JSON.stringify(v));},${waitMs})"`;
  await Promise.all([
    adminRequest(`/api/workbench/tasks/${task.id}/shell`, { command: timedCommand('parallel-a.json', 650) }),
    adminRequest(`/api/workbench/tasks/${secondTask.id}/shell`, { command: timedCommand('parallel-b.json', 650) }),
  ]);
  const parallelA = JSON.parse(await fs.readFile(path.join(workspace, 'parallel-a.json'), 'utf8'));
  const parallelB = JSON.parse(await fs.readFile(path.join(secondWorkspace, 'parallel-b.json'), 'utf8'));
  assert.ok(parallelA.start < parallelB.end && parallelB.start < parallelA.end, 'different workspaces execute non-read operations concurrently');
  await Promise.all([
    adminRequest(`/api/workbench/tasks/${task.id}/shell`, { command: timedCommand('serial-a.json', 350) }),
    adminRequest(`/api/workbench/tasks/${task.id}/shell`, { command: timedCommand('serial-b.json', 350) }),
  ]);
  const serialA = JSON.parse(await fs.readFile(path.join(workspace, 'serial-a.json'), 'utf8'));
  const serialB = JSON.parse(await fs.readFile(path.join(workspace, 'serial-b.json'), 'utf8'));
  assert.ok(serialA.end <= serialB.start || serialB.end <= serialA.start, 'same workspace non-read operations remain serialized');
  await policy(task.id, 'ask', true);
  console.log('OK different workspaces execute concurrently while same-workspace mutations remain serialized');
  execFileSync('git', ['init'], { cwd: secondWorkspace, windowsHide: true, stdio: 'pipe' });
  const secondGit = args => execFileSync('git', args, { cwd: secondWorkspace, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  secondGit(['config', 'user.name', 'Workbench Test']); secondGit(['config', 'user.email', 'workbench@example.invalid']);
  secondGit(['add', '--', 'sample.txt']); secondGit(['commit', '-m', 'second baseline']);
  secondGit(['branch', 'ui-overview-test']);
  const gitOverview = await adminRequest(`/api/workbench/tasks/${secondTask.id}/git/overview`);
  assert.ok(gitOverview.branches.some(branch => branch.name === 'ui-overview-test' && branch.remote === false));
  assert.ok(gitOverview.branches.some(branch => branch.current));
  assert.ok(gitOverview.commits.some(commit => commit.includes('second baseline')));
  await fs.writeFile(path.join(secondWorkspace, 'sample.txt'), 'second workspace changed\n');
  await adminRequest(`/api/workbench/tasks/${secondTask.id}/git`, { tool: 'git_add', args: { files: ['sample.txt'] } });
  let gitUiStatus = await adminRequest(`/api/workbench/tasks/${secondTask.id}/git/status`);
  assert.ok(gitUiStatus.staged.some(entry => entry.path === 'sample.txt'));
  const stagedFileDiff = await adminRequest(`/api/workbench/tasks/${secondTask.id}/git`, { tool: 'git_diff', args: { staged: true, file: 'sample.txt' } });
  assert.match(stagedFileDiff.structuredContent.data.output, /second workspace changed/);
  await adminRequest(`/api/workbench/tasks/${secondTask.id}/git`, { tool: 'git_unstage', args: { files: ['sample.txt'] } });
  gitUiStatus = await adminRequest(`/api/workbench/tasks/${secondTask.id}/git/status`);
  assert.ok(gitUiStatus.unstaged.some(entry => entry.path === 'sample.txt'));
  await fs.writeFile(path.join(secondWorkspace, 'sample.txt'), 'second workspace');
  assert.equal((await call('git_status')).isError, undefined, 'Git uses selected task workspace');
  assert.ok(text(await call('run_command', { command: 'node -p "process.cwd()"' })).includes('second-project'));
  const tree = await adminRequest(`/api/workbench/tasks/${secondTask.id}/tree?path=.`);
  assert.ok(tree.entries.some(entry => entry.name === 'sample.txt' && entry.type === 'file'));
  const filePreview = await adminRequest(`/api/workbench/tasks/${secondTask.id}/file?path=sample.txt&limit=20`);
  assert.ok(filePreview.content.includes('second workspace'));
  const workspaceSearch = await adminRequest(`/api/workbench/tasks/${secondTask.id}/search`, { query: 'second workspace', glob: '*.txt', caseInsensitive: true, mode: 'content', maxResults: 50 });
  assert.match(workspaceSearch.output, /sample\.txt|second workspace/i);
  const workspaceGlob = await adminRequest(`/api/workbench/tasks/${secondTask.id}/glob`, { pattern: '*.txt', maxResults: 50 });
  assert.ok(workspaceGlob.matches.some(file => file.replace(/\\/g, '/').endsWith('/sample.txt')));
  const projectContext = await adminRequest(`/api/workbench/tasks/${secondTask.id}/context`);
  assert.ok(projectContext.files.some(file => file.path.replace(/\\/g, '/').endsWith('/AGENTS.md')));
  assert.ok(projectContext.files.some(file => file.content.includes('SECOND_PROJECT_INSTRUCTIONS')));
  const externalCheckpoint = await adminRequest(`/api/workbench/tasks/${secondTask.id}/checkpoints`, { title: 'Before process actions' });
  const shellRun = await adminRequest(`/api/workbench/tasks/${secondTask.id}/shell`, { command: 'node -p "process.cwd()"' });
  assert.ok(shellRun.stdout.includes('second-project'));
  const background = await adminRequest(`/api/workbench/tasks/${secondTask.id}/processes`, { command: 'node -e "console.log(731)"', yield_time_ms: 1000 });
  assert.ok(background.id);
  const processList = await adminRequest(`/api/workbench/tasks/${secondTask.id}/processes`);
  assert.ok(processList.processes.some(process => process.id === background.id));
  const processTail = await adminRequest(`/api/workbench/tasks/${secondTask.id}/processes/${background.id}/output?tail=2000`);
  assert.ok(processTail.stdout.includes('731'));
  const cursorProcess = await adminRequest(`/api/workbench/tasks/${secondTask.id}/processes`, {
    command: 'node -e "console.log(\'cursor-one\');setTimeout(()=>console.log(\'cursor-two\'),1500)"',
    yield_time_ms: 500,
  });
  let cursorBase = cursorProcess;
  if (!cursorBase.stdout.includes('cursor-one')) {
    cursorBase = await adminRequest(`/api/workbench/tasks/${secondTask.id}/processes/${cursorProcess.id}/output?tail=2000&stdout_cursor=${cursorProcess.cursor.stdout}&stderr_cursor=${cursorProcess.cursor.stderr}&wait_ms=1000`);
  }
  assert.ok(cursorBase.stdout.includes('cursor-one'));
  assert.ok(cursorBase.cursor && Number.isInteger(cursorBase.cursor.stdout) && Number.isInteger(cursorBase.cursor.stderr));
  const cursorDelta = await adminRequest(`/api/workbench/tasks/${secondTask.id}/processes/${cursorProcess.id}/output?tail=2000&stdout_cursor=${cursorBase.cursor.stdout}&stderr_cursor=${cursorBase.cursor.stderr}&wait_ms=3000`);
  assert.ok(cursorDelta.stdout.includes('cursor-two'));
  assert.ok(!cursorDelta.stdout.includes('cursor-one'));
  assert.ok(cursorDelta.cursor.stdout > cursorBase.cursor.stdout);
  const structuredGit = await adminRequest(`/api/workbench/tasks/${secondTask.id}/git/status`);
  assert.ok(Array.isArray(structuredGit.staged) && Array.isArray(structuredGit.unstaged) && Array.isArray(structuredGit.untracked));
  const externalPlan = await adminRequest(`/api/workbench/checkpoints/${externalCheckpoint.id}/preview`);
  assert.equal(externalPlan.files.length, 0);
  assert.ok(externalPlan.externalEffects.some(effect => effect.tool === 'run_command'));
  assert.ok(externalPlan.externalEffects.some(effect => effect.tool === 'start_process'));
  const taskActivity = await adminRequest(`/api/activity?task=${secondTask.id}&limit=100`);
  assert.ok(taskActivity.entries.length > 0);
  assert.ok(taskActivity.entries.every(entry => entry.task_id === secondTask.id));
  assert.ok(taskActivity.entries.some(entry => entry.tool === 'run_command'));
  const longRunning = await adminRequest(`/api/workbench/tasks/${secondTask.id}/processes`, { command: 'node -e "setTimeout(()=>{},10000)"', yield_time_ms: 0 });
  await policy(secondTask.id, 'auto', true);
  const scopedProcesses = await adminRequest(`/api/workbench/tasks/${secondTask.id}/processes`);
  assert.ok(scopedProcesses.processes.some(process => process.id === longRunning.id && process.running));
  await adminRequest(`/api/workbench/tasks/${secondTask.id}/processes/${longRunning.id}/stop`, { force: true });
  const previewPort = await freePort();
  const previewUrl = `http://127.0.0.1:${previewPort}/`;
  const previewCommand = `node -e "require('http').createServer((q,s)=>s.end('preview-ok')).listen(${previewPort},'127.0.0.1')"`;
  await adminRequest(`/api/workbench/tasks/${secondTask.id}/preview`, { command: previewCommand, url: previewUrl }, 'PUT');
  assert.match(JSON.stringify(await adminRequest(`/api/workbench/tasks/${secondTask.id}/preview/start`, { command: previewCommand, url: previewUrl }, 'POST', 400)), /WORKSPACE_EXTERNAL_BLOCKED/);
  assert.match(JSON.stringify(await adminRequest(`/api/workbench/tasks/${secondTask.id}/preview`, { command: 'npm run dev', url: 'https://example.com' }, 'PUT', 400)), /localhost|127\.0\.0\.1/);
  await policy(secondTask.id, 'full', false);
  const orphanMarker = path.join(secondWorkspace, 'orphan-marker.txt');
  const treeProcess = await adminRequest(`/api/workbench/tasks/${secondTask.id}/processes`, { command: 'node -e "setTimeout(()=>require(\'fs\').writeFileSync(\'orphan-marker.txt\',\'bad\'),1200)"', yield_time_ms: 0 });
  await adminRequest(`/api/workbench/tasks/${secondTask.id}/processes/${treeProcess.id}/stop`, { force: true });
  await new Promise(resolve => setTimeout(resolve, 1500));
  await assert.rejects(fs.stat(orphanMarker));
  const previewStart = await adminRequest(`/api/workbench/tasks/${secondTask.id}/preview/start`, { command: previewCommand, url: previewUrl });
  assert.ok(previewStart.id);
  let previewStatus;
  for (let i = 0; i < 30; i++) {
    previewStatus = await adminRequest(`/api/workbench/tasks/${secondTask.id}/preview`);
    if (previewStatus.running && previewStatus.reachable) break;
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  assert.equal(previewStatus.configured, true); assert.equal(previewStatus.running, true); assert.equal(previewStatus.reachable, true); assert.equal(previewStatus.processId, previewStart.id);
  assert.equal(await (await fetch(previewUrl)).text(), 'preview-ok');
  assert.match(JSON.stringify(await adminRequest(`/api/workbench/tasks/${secondTask.id}/preview/start`, { command: previewCommand, url: `http://localhost:${previewPort}/` }, 'POST', 400)), /already running/);
  await adminRequest(`/api/workbench/tasks/${secondTask.id}/preview/stop`, {});
  previewStatus = await adminRequest(`/api/workbench/tasks/${secondTask.id}/preview`);
  assert.equal(previewStatus.running, false); assert.equal(previewStatus.configured, true);
  const health = await adminRequest('/health');
  assert.ok(health.sessions.some(session => session.taskId === secondTask.id && session.clientInfo?.name === 'second-session'));
  assert.equal(health.tool_profile, 'full'); assert.ok(Array.isArray(health.core_tools));
  console.log('OK Workbench project explorer, shell/process/preview APIs, structured Git status, sessions and task activity');
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
  const pendingReview = await adminRequest(`/api/workbench/operations/${request.operation_id}`);
  assert.equal(pendingReview.sessionId, sid, 'MCP operation is attributed to the originating session');
  const sessionToolActivity = await adminRequest(`/api/activity?limit=100&kind=tool&q=${encodeURIComponent(sid)}`);
  assert.ok(sessionToolActivity.entries.some(entry => entry.session_id === sid), 'tool activity can be filtered by originating session');
  assert.ok(sessionToolActivity.entries.every(entry => entry.kind === 'tool'));
  assert.equal(pendingReview.review.files.length, 1);
  assert.equal(pendingReview.review.files[0].operation, 'update');
  assert.match(pendingReview.review.files[0].diff, /- ?before/);
  assert.match(pendingReview.review.files[0].diff, /\+ ?after/);
  const workbenchSummary = await adminRequest('/api/workbench');
  const summarizedPending = workbenchSummary.operations.find(operation => operation.id === request.operation_id);
  assert.equal(summarizedPending.review.files.length, 1);
  assert.equal('diff' in summarizedPending.review.files[0], false, 'list payload must not include full pending diff');
  await approve(request.operation_id);
  assert.equal(await fs.readFile(path.join(workspace, 'sample.txt'), 'utf8'), 'after\n');
  await approve(request.operation_id, 400);
  let op = await adminRequest(`/api/workbench/operations/${request.operation_id}`);
  assert.equal(op.changes.length, 1);
  assert.equal(op.review.files.length, 1, 'completed file operation keeps a reviewable actual diff');
  assert.match(op.review.files[0].diff, /- ?before/);
  assert.match(op.review.files[0].diff, /\+ ?after/);
  await fs.writeFile(path.join(workspace, 'sample.txt'), 'human edit\n');
  assert.match(JSON.stringify(await undo(request.operation_id, false, 400)), /UNDO_CONFLICT/);
  assert.equal(await fs.readFile(path.join(workspace, 'sample.txt'), 'utf8'), 'human edit\n');
  await fs.writeFile(path.join(workspace, 'sample.txt'), 'after\n');
  await undo(request.operation_id); assert.equal(await fs.readFile(path.join(workspace, 'sample.txt'), 'utf8'), 'before\n');
  await undo(request.operation_id, true); assert.equal(await fs.readFile(path.join(workspace, 'sample.txt'), 'utf8'), 'after\n');
  const partialUndoRequest = payload(await call('apply_patch', { patch: '*** Begin Patch\n*** Add File: partial-a.txt\n+alpha\n*** Add File: partial-b.txt\n+beta\n*** End Patch' }));
  assert.equal(partialUndoRequest.status, 'approval_required');
  await approve(partialUndoRequest.operation_id);
  const partialUndoDetail = await adminRequest(`/api/workbench/operations/${partialUndoRequest.operation_id}`);
  const partialA = partialUndoDetail.changes.find(change => change.path.replace(/\\/g, '/').endsWith('/partial-a.txt')).path;
  await adminRequest(`/api/workbench/operations/${partialUndoRequest.operation_id}/undo`, { redo: false, file: partialA });
  await assert.rejects(fs.stat(path.join(workspace, 'partial-a.txt')));
  assert.equal(await fs.readFile(path.join(workspace, 'partial-b.txt'), 'utf8'), 'beta');
  await adminRequest(`/api/workbench/operations/${partialUndoRequest.operation_id}/undo`, { redo: true, file: partialA });
  assert.equal(await fs.readFile(path.join(workspace, 'partial-a.txt'), 'utf8'), 'alpha');
  await undo(partialUndoRequest.operation_id);
  await assert.rejects(fs.stat(path.join(workspace, 'partial-a.txt')));
  await assert.rejects(fs.stat(path.join(workspace, 'partial-b.txt')));
  const patchPreviewRequest = payload(await call('apply_patch', { patch: '*** Begin Patch\n*** Add File: preview-a.txt\n+one\n*** Add File: preview-b.txt\n+two\n*** End Patch' }));
  assert.equal(patchPreviewRequest.status, 'approval_required');
  const patchPreview = await adminRequest(`/api/workbench/operations/${patchPreviewRequest.operation_id}`);
  assert.equal(patchPreview.review.files.length, 2);
  assert.equal(patchPreview.review.files.every(file => file.operation === 'create'), true);
  assert.equal(patchPreview.review.additions, 2);
  await adminRequest(`/api/workbench/operations/${patchPreviewRequest.operation_id}/decision`, { approve: false });
  await assert.rejects(fs.stat(path.join(workspace, 'preview-a.txt')));
  const cleanCheckpoint = await adminRequest(`/api/workbench/tasks/${task.id}/checkpoints`, { title: 'Before task batch' });
  await policy(task.id, 'auto', true);
  assert.equal((await call('write_file', { path: 'sample.txt', content: 'checkpoint change\n' })).isError, undefined);
  assert.equal((await call('write_file', { path: 'checkpoint-new.txt', content: 'new from checkpoint\n' })).isError, undefined);
  const cleanPlan = await adminRequest(`/api/workbench/checkpoints/${cleanCheckpoint.id}/preview`);
  assert.equal(cleanPlan.operationCount, 2);
  assert.equal(cleanPlan.files.length, 2);
  await adminRequest(`/api/workbench/checkpoints/${cleanCheckpoint.id}/restore`, {});
  assert.equal(await fs.readFile(path.join(workspace, 'sample.txt'), 'utf8'), 'after\n');
  await assert.rejects(fs.stat(path.join(workspace, 'checkpoint-new.txt')));
  const postRestoreOps = (await adminRequest('/api/workbench')).operations.filter(operation => operation.taskId === task.id);
  assert.ok(postRestoreOps.filter(operation => ['write_file'].includes(operation.tool)).slice(0, 2).every(operation => operation.changes.every(change => change.undone)));

  const conflictCheckpoint = await adminRequest(`/api/workbench/tasks/${task.id}/checkpoints`, { title: 'Conflict checkpoint' });
  assert.equal((await call('write_file', { path: 'sample.txt', content: 'checkpoint conflict\n' })).isError, undefined);
  const conflictOp = (await adminRequest('/api/workbench')).operations.find(operation => operation.taskId === task.id && operation.tool === 'write_file' && operation.changes.some(change => change.path.endsWith('sample.txt') && !change.undone));
  await fs.writeFile(path.join(workspace, 'sample.txt'), 'human after checkpoint\n');
  assert.match(JSON.stringify(await adminRequest(`/api/workbench/checkpoints/${conflictCheckpoint.id}/preview`, undefined, 'GET', 400)), /CHECKPOINT_CONFLICT/);
  assert.equal(await fs.readFile(path.join(workspace, 'sample.txt'), 'utf8'), 'human after checkpoint\n');
  await fs.writeFile(path.join(workspace, 'sample.txt'), 'checkpoint conflict\n');
  await undo(conflictOp.id);
  assert.equal(await fs.readFile(path.join(workspace, 'sample.txt'), 'utf8'), 'after\n');
  await policy(task.id, 'ask', true);
  console.log('OK task checkpoints restore file journal, reject conflicts and report external effects');
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
  assert.equal((await call('mcp_servers')).isError, true, 'Workspace-only must not let metadata reads connect/spawn upstream MCP servers');
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
