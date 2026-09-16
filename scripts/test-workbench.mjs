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
  WORKBENCH_BOOTSTRAP_TOKEN: 'workbench-test-bootstrap',
  WORKBENCH_EXPERIENCE: 'advanced',
  MCP_UPSTREAM_CONFIG: path.join(tmp, 'upstream.json'), AUDIT_LOG_PATH: path.join(tmp, 'audit.log'), CHECKPOINT_PATH: path.join(tmp, 'checkpoints'),
  MCP_SHELL_STATE_DIR: path.join(tmp, 'shell'), CODEX_HOME: path.join(tmp, 'codex'), CHATGPT_TOOL_PROFILE: 'full',
  MCP_ACTIVE_SESSION_MS: '1000',
  LOCAL_CODER_CONNECTION_MODE: 'local', WORKBENCH_REMOTE_POLICY_CONTROL: 'false', WORKBENCH_REVIEW_QUIESCENCE_MS: '1000',
  PUBLIC_BASE_URL: base,
  WORKBENCH_PREVIEW_PORT_RANGE: '20000-24999',
  WORKBENCH_SANDBOX_PROVIDER: 'none',
  WORKSPACE_PATHS: '', EXTRA_WORKSPACE_PATHS: '', ALLOWED_WORKSPACE_PATHS: '' };
let server, logs = '', sid, seq = 0, testFailure;
async function start() {
  server = spawn(process.execPath, [path.join(root, 'dist/index.js')], { cwd: tmp, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', d => { logs += d; }); server.stderr.on('data', d => { logs += d; });
  for (let i = 0; i < 80; i++) { try { if ((await fetch(base + '/health')).ok) return; } catch {} await new Promise(r => setTimeout(r, 100)); }
  throw new Error('Server failed to start: ' + logs);
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  const child = server;
  const closed = new Promise(resolve => child.once('exit', resolve));

  if (process.platform === 'win32' && child.pid) {
    // child.kill() uses TerminateProcess on Windows, which can leave Preview
    // descendants alive with their cwd handle open. Kill the whole fixture
    // process tree so restart tests see a genuinely stopped runtime and the
    // temp workspace can be removed deterministically.
    await new Promise(resolve => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      const done = () => resolve();
      killer.once('close', done);
      killer.once('error', done);
    });
  } else {
    child.kill('SIGTERM');
  }

  const exited = await Promise.race([
    closed.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 6000)),
  ]);
  if (!exited && child.exitCode === null) {
    child.kill('SIGKILL');
    await closed;
  }
}
async function rpc(method, params, extraHeaders = {}) {
  const res = await fetch(base + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer workbench-test-mcp', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}), ...extraHeaders },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }), signal: AbortSignal.timeout(10000) });
  assert.equal(res.status, 200);
  if (res.headers.get('mcp-session-id')) sid = res.headers.get('mcp-session-id');
  return (await res.json()).result;
}
const call = (name, args = {}, meta) => rpc('tools/call', { name, arguments: args, ...(meta ? { _meta: meta } : {}) });
const callWithHeaders = (name, args = {}, headers = {}) => rpc('tools/call', { name, arguments: args }, headers);
async function rpcWithSession(sessionId, method, params) {
  const res = await fetch(base + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer workbench-test-mcp', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-session-id': sessionId },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }), signal: AbortSignal.timeout(10000) });
  assert.equal(res.status, 200);
  return (await res.json()).result;
}
async function rpcEnvelopeWithSession(sessionId, method, params) {
  const res = await fetch(base + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer workbench-test-mcp', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-session-id': sessionId },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }), signal: AbortSignal.timeout(10000) });
  const raw = await res.text();
  let json;
  try { json = JSON.parse(raw); } catch { json = undefined; }
  return { status: res.status, json, raw };
}
const callWithSession = (sessionId, name, args = {}) => rpcWithSession(sessionId, 'tools/call', { name, arguments: args });
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
        const id = frame.split('\n').find(line => line.startsWith('id:'))?.slice(3).trim() || '';
        const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()).join('\n');
        if (!id && !data && !frame.split('\n').some(line => line.startsWith('event:'))) continue;
        return { event, id, data: data ? JSON.parse(data) : null };
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
  const duplicatePort = await freePort(), duplicateAdminPort = await freePort();
  let duplicateLogs = '';
  const duplicate = spawn(process.execPath, [path.join(root, 'dist/index.js')], {
    cwd: tmp,
    env: { ...env, PORT: String(duplicatePort), ADMIN_PORT: String(duplicateAdminPort) },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  duplicate.stdout.on('data', data => { duplicateLogs += data; });
  duplicate.stderr.on('data', data => { duplicateLogs += data; });
  const duplicateExit = await Promise.race([
    new Promise(resolve => duplicate.once('exit', code => resolve(code))),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Duplicate Workbench unexpectedly kept running')), 5000)),
  ]);
  assert.notEqual(duplicateExit, 0, 'a second process must not share the same WORKBENCH_PATH');
  assert.match(duplicateLogs, /WORKBENCH_STATE_IN_USE/, 'duplicate state ownership fails loudly instead of overwriting another process');
  assert.equal((await fetch(base + '/health')).status, 200, 'rejecting the duplicate process leaves the original Workbench alive');
  console.log('OK Workbench state is single-writer across server processes');
  assert.equal((await fetch(base + '/mcp')).status, 401);
  assert.equal((await fetch(admin + '/api/workbench')).status, 401);
  assert.equal((await fetch(admin + '/api/workbench/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: JSON.stringify({ bootstrapToken: 'workbench-test-bootstrap' })
  })).status, 403);
  assert.equal((await fetch(admin + '/api/workbench/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bootstrapToken: 'wrong-bootstrap' })
  })).status, 401);
  const bootstrapResponse = await fetch(admin + '/api/workbench/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bootstrapToken: 'workbench-test-bootstrap' })
  });
  assert.equal(bootstrapResponse.status, 200);
  const workbenchCookie = bootstrapResponse.headers.get('set-cookie') || '';
  assert.match(workbenchCookie, /workbench_session_\d+=/);
  assert.match(workbenchCookie, /HttpOnly/i);
  assert.match(workbenchCookie, /SameSite=Strict/i);
  assert.equal((await fetch(admin + '/api/workbench', { headers: { Cookie: workbenchCookie.split(';')[0] } })).status, 200);
  assert.equal((await fetch(admin + '/api/workbench/session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bootstrapToken: 'workbench-test-bootstrap' })
  })).status, 401, 'Workbench bootstrap token is one-time');
  assert.equal((await fetch(admin + '/api/workbench', { headers: { Authorization: 'Bearer workbench-test-admin', Origin: 'https://evil.example' } })).status, 403);
  const workbenchHtmlResponse = await fetch(admin + '/ui/workbench.html');
  assert.equal(workbenchHtmlResponse.status, 200);
  const workbenchHtml = await workbenchHtmlResponse.text();
  assert.match(workbenchHtml, /Workspace & tasks/);
  assert.match(workbenchHtml, /\+ Add workspace/);
  assert.match(workbenchHtml, /<h2 id="add-workspace-heading">Add workspace<\/h2>/);
  assert.match(workbenchHtml, /id="workspace-source-clone"[^>]*>Clone repository</, 'Add workspace exposes repository cloning');
  assert.match(workbenchHtml, /id="clone-workspace-repository"/, 'clone flow accepts a repository URL or Git path');
  assert.match(workbenchHtml, /id="clone-workspace-parent"/, 'clone flow lets the user choose the destination parent');
  assert.match(workbenchHtml, /id="clone-workspace-branch"/, 'clone flow supports an optional starting branch');
  assert.match(workbenchHtml, /id="workspace-settings-remove"[^>]*>Remove</, 'workspace settings expose explicit removal');
  assert.match(workbenchHtml, /id="workspace-settings-locate"/, 'workspace settings expose project-folder relocation');
  assert.match(workbenchHtml, /id="settings-workspace-availability"/, 'workspace settings expose Ready\/Missing availability');
  assert.match(workbenchHtml, /Project files stay on disk/, 'workspace removal explains that source files are preserved');
  assert.match(workbenchHtml, /What are you working on\?/);
  assert.match(workbenchHtml, /id="new-task-error"/);
  assert.match(workbenchHtml, /Ask for approval/);
  assert.match(workbenchHtml, /Approve for me/);
  assert.match(workbenchHtml, /Full access/);
  assert.match(workbenchHtml, /Advanced scope/);
  assert.match(workbenchHtml, /Restrict process access to this workspace/);
  assert.match(workbenchHtml, /WORKSPACE REVIEW/);
  assert.match(workbenchHtml, /id="workspace-review-undo"/);
  assert.match(workbenchHtml, /id="workspace-review-more"/);
  assert.match(workbenchHtml, /Only activity from this workspace/);
  assert.doesNotMatch(workbenchHtml, /id="tree-collapse"|id="file-tree"|id="search-toggle"/, 'Explorer is intentionally removed from the main Workbench UI');
  assert.match(workbenchHtml, /id="chatgpt-button"/);
  assert.match(workbenchHtml, /id="chatgpt-state">Not connected</);
  assert.match(workbenchHtml, /id="review-center"[^>]*aria-hidden="true"[^>]*hidden/, 'top-right review opens a dedicated Review Center drawer');
  assert.match(workbenchHtml, /NEEDS ATTENTION/);
  assert.match(workbenchHtml, /RECENT AGENT WORK/);
  assert.match(workbenchHtml, /id="review-center-stage-reviewed"[^>]*>Stage reviewed</, 'Review Center exposes the reviewed-to-stage workflow');
  assert.match(workbenchHtml, /<small>LOCAL CODER<\/small><h2>Connections<\/h2>/, 'Local Coder dialog is connection-first');
  assert.match(workbenchHtml, /id="mcp-dialog-local-status">Ready</, 'Connections dialog exposes Local MCP status');
  assert.match(workbenchHtml, /id="mcp-dialog-chatgpt-status">Not connected</, 'Connections dialog exposes ChatGPT status');
  assert.match(workbenchHtml, /UPSTREAM MCP SERVERS/, 'Connections dialog keeps upstream MCP management');
  assert.doesNotMatch(workbenchHtml.slice(workbenchHtml.indexOf('id="mcp-dialog"'), workbenchHtml.indexOf('id="mcp-server-dialog"')), /PROJECT CONTEXT|tool profile/i, 'Connections dialog leaves project context and tool profile in advanced settings');
  assert.doesNotMatch(workbenchHtml, /Admin token|id="token"|connect-overlay/i);
  assert.doesNotMatch(workbenchHtml, /Use task for new ChatGPT session/);
  assert.doesNotMatch(workbenchHtml, /Task & permissions/);
  assert.match(workbenchHtml, /class="environment-summary"/, 'Environment has a dedicated context summary instead of making the whole card a branch button');
  assert.match(workbenchHtml, /id="environment-status"[^>]*>Ready</, 'Environment exposes a high-level readiness state');
  assert.match(workbenchHtml, /id="environment-change-meta">Clean working tree</, 'Environment separates working-tree detail from the change count');
  assert.match(workbenchHtml, /id="environment-sync-state">Up to date</, 'Environment exposes remote sync as its own status');
  assert.doesNotMatch(workbenchHtml, /environment-context-button|environment-actions/, 'legacy all-in-one Environment controls are removed');
  assert.match(workbenchHtml, /AGENT COORDINATOR/, 'agent rail is task-oriented instead of only session-oriented');
  assert.match(workbenchHtml, /id="agent-waiting-count"/, 'agent coordinator exposes queued assignments');
  assert.match(workbenchHtml, /id="agent-conflict-count"/, 'agent coordinator exposes conflict state');
  assert.match(workbenchHtml, /id="agent-cancel-assignment"/, 'queued agent assignments can be cancelled from the coordinator');
  assert.match(workbenchHtml, /id="integration-button"/, 'agent coordinator exposes the Integration Queue');
  assert.match(workbenchHtml, /id="integration-dialog"[^>]*class="app-dialog integration-dialog"/, 'parallel task integration has a dedicated dialog');
  assert.match(workbenchHtml, /Integration Queue/);
  assert.match(workbenchHtml, /Local merge only/);
  assert.match(workbenchHtml, /never pushes automatically/i, 'integration UI explicitly promises local-only merge behavior');
  assert.match(workbenchHtml, /id="integration-dependency-dialog"/, 'Integration Queue exposes dependency ordering controls');
  assert.match(workbenchHtml, /id="integration-dependency-save"[^>]*>Save dependencies</, 'dependency editor has an explicit save action');
  assert.match(workbenchHtml, /Cycles and cross-workspace dependencies are rejected/, 'dependency editor explains graph safety');
  assert.match(workbenchHtml, /id="agent-detail-lifecycle"/, 'agent detail exposes task lifecycle');
  assert.match(workbenchHtml, /id="agent-detail-preview"/, 'agent detail exposes its task preview lease');
  assert.match(workbenchHtml, /id="agent-open-preview"/, 'running agent preview can be opened from Agent Coordinator');
  assert.match(workbenchHtml, /id="chat-sessions-button"/, 'advanced Workbench exposes the multi-chat entry point');
  assert.match(workbenchHtml, /id="chat-sessions-dialog"/, 'multi-chat workflow has a dedicated dialog');
  assert.match(workbenchHtml, /data-chat-layout="4"/, 'multi-chat workflow includes a four-pane layout preset');
  assert.match(workbenchHtml, /No model API\. Prompts stay local until you copy them\./, 'multi-chat workflow explicitly remains ChatGPT Web only');
  const workbenchCssResponse = await fetch(admin + '/ui/workbench-app.css');
  assert.equal(workbenchCssResponse.status, 200);
  const workbenchCss = await workbenchCssResponse.text();
  assert.match(workbenchCss, /\.workspace-dialog\[open\]\s*\{[^}]*grid-template-rows:\s*auto\s+minmax\(0,1fr\)\s+auto/s, 'workspace dialog keeps header/footer visible while body scrolls');
  assert.match(workbenchCss, /\.workspace-add-body\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*auto/s, 'workspace picker body is scroll constrained');
  assert.match(workbenchCss, /\.workspace-availability\.missing,\s*\.workspace-availability\.unavailable/, 'missing workspaces have an explicit attention state');
  assert.match(workbenchCss, /\.workspace-review-additions,\s*\.workspace-review-file-additions\s*\{[^}]*color:\s*var\(--green\)/s, 'workspace review additions are green');
  assert.match(workbenchCss, /\.workspace-review-deletions,\s*\.workspace-review-file-deletions\s*\{[^}]*color:\s*#ff7b72/s, 'workspace review deletions are red');
  assert.match(workbenchCss, /\.workspace-review-list\.expanded\s*\{[^}]*max-height:\s*340px[^}]*overflow:\s*auto/s, 'expanded workspace review is height constrained');
  assert.match(workbenchCss, /\.review-center\s*\{[^}]*width:\s*min\(var\(--changes\),\s*calc\(100vw - 20px\)\)[^}]*overflow:\s*hidden/s, 'Review Center stays aligned to the Changes rail instead of overflowing over the editor');
  assert.match(workbenchCss, /\.review-center-scroll\s*\{[^}]*overflow-x:\s*hidden[^}]*overflow-y:\s*auto/s, 'Review Center owns its vertical scroll and cannot leak horizontally');
  assert.match(workbenchCss, /\.review-center-change-actions\s*\{[^}]*flex-wrap:\s*wrap/s, 'Review Center file actions wrap instead of widening the drawer');
  assert.match(workbenchCss, /\.connection-status-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,minmax\(0,1fr\)\)/s, 'Connections dialog gives Local MCP and ChatGPT equal status cards');
  assert.match(workbenchCss, /\.agent-coordinator-summary\s*\{[^}]*grid-template-columns:\s*repeat\(3,minmax\(0,1fr\)\)/s, 'agent coordinator keeps active, waiting and conflict counts visible');
  assert.match(workbenchCss, /\.integration-summary\s*\{[^}]*grid-template-columns:\s*repeat\(4,minmax\(0,1fr\)\)/s, 'Integration Queue keeps lifecycle summary visible');
  assert.match(workbenchCss, /\.integration-dialog-body\s*\{[^}]*overflow:\s*auto/s, 'Integration Queue body remains scroll constrained');
  assert.match(workbenchCss, /\.integration-dependency-chips\s*\{[^}]*flex-wrap:\s*wrap/s, 'dependency chips wrap inside Integration cards');
  assert.match(workbenchCss, /\.integration-cleanup\.completed\s*\{[^}]*border-color:\s*#28513a/s, 'completed cleanup gets a distinct safe state');
  assert.match(workbenchCss, /\.integration-meta \.preview-running/, 'Integration Queue has a visible preview-running state');
  assert.match(workbenchCss, /\.chat-session-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,1fr\)\)/s, 'multi-chat prompt board uses a compact two-column desktop grid');
  const appUiResponse = await fetch(admin + '/ui/workbench/app.js');
  assert.equal(appUiResponse.status, 200);
  const appUi = await appUiResponse.text();
  assert.match(appUi, /\/api\/workbench\/session/);
  assert.doesNotMatch(appUi, /local-coder-admin-token|getAdminToken|setAdminToken/);
  assert.match(appUi, /submit\.textContent = relocating \? 'Locating…' : cloning \? 'Cloning…' : 'Adding…'/, 'workspace creation and relocation expose distinct busy states');
  assert.match(appUi, /\/api\/workbench\/workspaces\/clone/, 'clone flow calls the dedicated workspace clone endpoint');
  assert.match(appUi, /\/api\/workbench\/workspaces\/\$\{encodeURIComponent\(relocationWorkspaceId\)\}\/path/, 'Locate folder updates the existing workspace instead of creating another workspace');
  assert.match(appUi, /workspace\.availability === 'missing'/, 'Workbench renders missing-folder state without deleting the workspace');
  assert.match(appUi, /Cloning…/, 'repository cloning exposes a busy state');
  assert.match(appUi, /inferCloneFolderName/, 'repository input infers a friendly destination folder name');
  assert.match(appUi, /relocating \? 'Workspace relocated' : cloning \? 'Repository cloned' : 'Workspace added'/, 'post-create refresh failure keeps relocate, clone and local creation distinct');
  assert.match(appUi, /\/api\/workbench\/workspaces\/\$\{encodeURIComponent\(workspace\.id\)\}/, 'workspace removal calls the dedicated backend endpoint');
  assert.match(appUi, /project files kept on disk/, 'workspace removal success message preserves the remove-vs-delete distinction');
  assert.match(appUi, /submit\.textContent = 'Creating…'/, 'task creation exposes a busy state');
  assert.match(appUi, /Task created · refresh failed:/, 'post-create task refresh failure is not reported as creation failure');
  assert.match(appUi, /new-task-error/, 'task creation errors are visible inside the task dialog');
  assert.match(appUi, /setupProcessConsole/, 'Workbench initializes the compact process console');
  assert.match(appUi, /Cloudflare Quick Tunnel/);
  assert.match(appUi, /OpenAI Secure Tunnel/);
  assert.match(appUi, /mcp-dialog-chatgpt-status/);
  assert.match(appUi, /setupChatSessions\(\)/, 'Workbench bootstraps the multi-chat controller');
  assert.match(appUi, /None configured/, 'empty upstream state avoids a misleading 0\/0 connected counter');
  assert.match(appUi, /\$\('environment-changes'\)\.onclick = \(\) => openReviewCenter\(\)/, 'Environment working-tree status opens Review Center directly');
  assert.match(appUi, /beforeunload/, 'Workbench closes EventSource and live timers when the page unloads');
  assert.match(appUi, /fallbackRevision/, 'polling keeps an independent revision cursor so SSE delivery cannot mask a failed fallback refresh');
  assert.match(appUi, /serverRevision !== beforeRevision/, 'polling reloads secondary views when the server revision advanced since the previous poll');
  assert.match(appUi, /workbenchLoadGeneration/, 'Workbench state loader rejects stale async responses after task or workspace changes');
  assert.match(appUi, /generation !== workbenchLoadGeneration/, 'only the newest Workbench state response can update the active view');
  assert.match(appUi, /selectedPolicyMode\(\) !== 'full'/, 'permission presets default workspace scope consistently');
  assert.match(appUi, /Machine scope allows authorized commands and paths outside this workspace/, 'permission scope helper explains machine access when workspace restriction is disabled');
  assert.match(appUi, /policy-scope'\)\.onchange = updatePolicyScopeHelp/, 'permission scope help updates immediately when advanced scope changes');
  const experienceUiResponse = await fetch(admin + '/ui/workbench/experience.js');
  assert.equal(experienceUiResponse.status, 200);
  const experienceUi = await experienceUiResponse.text();
  assert.match(experienceUi, /basic\.disabled = false/, 'Basic remains selectable so downgrade blockers are visible instead of looking like a broken toggle');
  assert.match(experienceUi, /Resolve blockers first/, 'blocked Advanced-to-Basic changes explain why Apply is unavailable');
  assert.match(experienceUi, /policy-auto-label'\)\.textContent = 'Approve for me'/, 'experience rendering preserves the permission preset label');
  assert.match(experienceUi, /policy-full-label'\)\.textContent = 'Full access'/, 'experience rendering preserves the Full access label');
  assert.doesNotMatch(experienceUi, /Allow safe edits|No approval prompts/, 'experience rendering cannot overwrite permission labels with legacy wording');
  assert.doesNotMatch(workbenchHtml, /terminal-command-form|terminal-command|terminal-run|terminal-start/, 'manual terminal command UI is removed');
  assert.match(workbenchHtml, /id="process-console"[^>]*hidden/, 'process console is hidden until a process is running');
  assert.match(workbenchHtml, />PROCESSES</, 'process monitor is labeled as Processes rather than Terminal');
  assert.match(workbenchCss, /\.process-console\s*\{[^}]*height:\s*38px/s, 'collapsed process console only consumes a compact editor row');
  assert.match(workbenchCss, /\.process-console\[hidden\]\s*\{[^}]*display:\s*none/s, 'idle process console does not consume editor space');
  const agentsUiResponse = await fetch(admin + '/ui/workbench/agents.js');
  assert.equal(agentsUiResponse.status, 200);
  const agentsUi = await agentsUiResponse.text();
  assert.match(agentsUi, /\/api\/workbench\/agents/, 'agent coordinator UI consumes the aggregate backend endpoint');
  assert.match(agentsUi, /Waiting for ChatGPT/, 'queued tasks are visible before a ChatGPT session exists');
  assert.match(agentsUi, /File overlap/, 'agent detail explains path overlap conflicts');
  assert.match(agentsUi, /ready_to_merge/, 'agent coordinator renders integration lifecycle state');
  assert.match(agentsUi, /agent-detail-lifecycle/, 'agent dialog renders lifecycle detail');
  assert.match(agentsUi, /agent-detail-preview/, 'agent dialog renders preview port state');
  assert.match(agentsUi, /window\.open\(agent\.previewUrl/, 'Agent Coordinator can open a running task preview');
  assert.match(agentsUi, /workbench:agents-updated/, 'agent refreshes notify the multi-chat view');
  const chatSessionsUiResponse = await fetch(admin + '/ui/workbench/chat-sessions.js');
  assert.equal(chatSessionsUiResponse.status, 200);
  const chatSessionsUi = await chatSessionsUiResponse.text();
  assert.match(chatSessionsUi, /https:\/\/chatgpt\.com\//, 'multi-chat opens ChatGPT Web rather than a model API');
  assert.match(chatSessionsUi, /window\.open\(CHATGPT_URL/, 'multi-chat opens user-controlled ChatGPT browser windows');
  assert.match(chatSessionsUi, /replace-chat-prompts:/, 'prompt drafts stay in local browser storage per workspace');
  assert.match(chatSessionsUi, /screen\.availWidth/, 'multi-chat derives window layouts from the current display');
  const integrationUiResponse = await fetch(admin + '/ui/workbench/integration.js');
  assert.equal(integrationUiResponse.status, 200);
  const integrationUi = await integrationUiResponse.text();
  assert.match(integrationUi, /\/api\/workbench\/integration/, 'Integration Queue consumes the aggregate integration endpoint');
  assert.match(integrationUi, /\/integration\/\$\{action\}/, 'Integration Queue uses lifecycle mutation endpoints');
  assert.match(integrationUi, /\/integration\/dependencies/, 'Integration Queue can persist task dependencies');
  assert.match(integrationUi, /Queue #/, 'Integration Queue renders deterministic queue positions');
  assert.match(integrationUi, /Retry cleanup/, 'merged tasks can retry managed worktree cleanup');
  assert.match(integrationUi, /Stop processes/, 'Integration Queue can stop task-owned runtimes before integration');
  assert.match(integrationUi, /processes\/stop-all/, 'Integration Queue uses the task runtime stop-all endpoint');
  assert.match(integrationUi, /task\.previewPort/, 'Integration Queue surfaces per-task preview ports');
  assert.match(integrationUi, /Integrate & finish/, 'ready tasks expose one primary integrate-and-finish action');
  assert.match(integrationUi, /Discard & clean up/, 'parallel tasks expose an explicit destructive discard action');
  assert.match(integrationUi, /permanently deletes all unmerged changes/i, 'discard confirmation explains destructive worktree cleanup');
  assert.match(integrationUi, /Local Coder will never push automatically/);
  const changesUiResponse = await fetch(admin + '/ui/workbench/changes.js');
  assert.equal(changesUiResponse.status, 200);
  const changesUi = await changesUiResponse.text();
  assert.match(changesUi, /Accept connection/);
  assert.match(changesUi, /api\/workbench\/connections/);
  assert.match(changesUi, /currentWorkspaceOperations/);
  assert.match(changesUi, /review-runs\/latest/);
  assert.doesNotMatch(changesUi, /Show \$\{count - 3\} more files/, 'workspace review no longer silently hides files after the first three');
  assert.doesNotMatch(changesUi, /recentFiles\.slice\(0,\s*6\)/, 'Review Center renders every file in the latest review run');
  assert.match(changesUi, /permissionSummary/, 'approval UI surfaces permission risk and effects');
  assert.match(workbenchHtml, /id="review-decision-status"[^>]*aria-live="polite"/, 'approval dialog has an accessible live decision status');
  assert.match(changesUi, /Approval received · starting operation…/, 'Approve gives immediate visible feedback before the command finishes');
  assert.match(changesUi, /approve\.disabled = busy/, 'Approve is disabled while a decision is in flight to prevent double execution');
  assert.match(changesUi, /pendingOperation\.status = approve \? 'running' : 'denied'/, 'pending approval cards update optimistically as soon as the user decides');
  assert.match(changesUi, /Approval was not applied\. You can try again\./, 'failed approval submission restores an actionable retry state');
  assert.match(changesUi, /Approved · operation completed\./, 'successful approval remains visibly acknowledged in the review dialog');
  assert.match(changesUi, /Approval expired before execution\. Request a new operation\./, 'stale approvals surface the actual expired state instead of a generic pending error');
  assert.match(changesUi, /latest && latest\.status !== 'pending'\) return/, 'terminal stale decisions are reconciled without rethrowing a misleading UI error');
  assert.match(workbenchCss, /\.review-decision-status\.busy/, 'approval running state has distinct visual treatment');
  assert.match(workbenchCss, /#review-actions button:disabled/, 'approval action buttons expose a disabled busy state');
  assert.match(changesUi, /latest review run/, 'Review Center uses persisted review-run terminology');
  assert.match(changesUi, /api\/workbench\/review-runs/);
  assert.match(changesUi, /Undoing…/, 'workspace review exposes an Undo busy state');
  assert.match(changesUi, /invalidateRestoredEditorTabs/, 'workspace Undo invalidates stale editor tabs after restoring files');
  assert.match(changesUi, /await loadChanges\(\)/, 'workspace Undo refreshes source control immediately after restore');
  assert.match(changesUi, /workspace-review-error/, 'workspace Undo errors are shown inline instead of only in the status bar');
  assert.match(changesUi, /state\.reviewedChanges\.add/, 'opening a Review Center file records reviewed progress');
  assert.match(changesUi, /export async function reviewNextChange/, 'Review Center can advance through unreviewed files');
  assert.match(changesUi, /export async function stageReviewedChanges/, 'Review Center can stage only reviewed files');
  assert.match(changesUi, /reviewCenterFilter/, 'Review Center has its own workspace-level filter independent of the Changes rail');
  assert.match(changesUi, /\$\('environment-change-meta'\)\.textContent = changes/, 'Environment summarizes staged and working files separately');
  assert.match(changesUi, /syncState\.textContent = `↓\$\{behind\} pull · ↑\$\{ahead\} push`/, 'Environment exposes diverged remote sync state');
  assert.match(changesUi, /if \(action === 'review'\) \{\s*openReviewCenter\(\)/s, 'Environment primary review action opens Review Center rather than only switching the Changes rail');
  assert.doesNotMatch(changesUi, /Review, commit, stash, or discard current changes before switching branches/, 'Workbench does not pre-lock branch switching because agent sessions are pinned to task worktrees');
  assert.doesNotMatch(changesUi, /is already checked out in another worktree\.\`?/, 'Workbench lets Git itself decide whether a branch switch is legal');
  assert.match(changesUi, /openGitDiff\(change\.path, !change\.unstaged && change\.staged, \{ meta, preview: true \}\)/, 'Review Center file navigation opts into one reusable preview tab');
  assert.match(changesUi, /id: `change-set-diff:[\s\S]*?preview: true,/, 'Recent work file diffs also reuse the review preview tab in both experiences');
  assert.doesNotMatch(changesUi, /\$\('review-button'\)\.textContent = pending\.length/, 'top-right review button no longer changes meaning based on the first pending item');
  assert.doesNotMatch(changesUi, /workspace-review-card/);
  assert.match(changesUi, /currentOperationTaskId/);
  const editorUiResponse = await fetch(admin + '/ui/workbench/editor.js');
  assert.equal(editorUiResponse.status, 200);
  const editorUi = await editorUiResponse.text();
  assert.doesNotMatch(editorUi, /createDiffEditor/, 'center diff does not use Monaco synchronized diff scrolling');
  assert.match(editorUi, /independent-diff-pane original/, 'center diff creates a standalone original viewport');
  assert.match(editorUi, /independent-diff-pane modified/, 'center diff creates a standalone modified viewport');
  assert.match(editorUi, /REVIEW_PREVIEW_TAB_ID = 'review-preview'/, 'Review Center owns one dedicated preview tab instead of one tab per reviewed file');
  assert.match(editorUi, /options\.preview \? REVIEW_PREVIEW_TAB_ID : tabId\('diff'/, 'Git review diffs reuse the dedicated preview tab');
  assert.match(editorUi, /tab\.pendingOperationId \|\| tab\.preview/, 'file previews from Review Center are read-only');
  assert.match(editorUi, /tab\.preview \? tab : \{ \.\.\.state\.tabs\[index\], \.\.\.tab \}/, 'switching Review Center files replaces stale preview-tab state');
  assert.match(editorUi, /scrollbar:\s*\{\s*vertical:\s*'visible',\s*horizontal:\s*'visible'\s*\}/, 'both standalone diff panes expose their own scrollbars');
  assert.match(editorUi, /alignDiffPair/, 'independent panes preserve row alignment with gap rows');
  assert.match(editorUi, /export function invalidateRestoredEditorTabs/, 'editor can invalidate restored file and change-set tabs');
  assert.match(editorUi, /onDidScrollChange\(event => syncDiffScroll\('original', event\)\)/, 'original diff viewport can drive synchronized vertical scrolling');
  assert.match(editorUi, /onDidScrollChange\(event => syncDiffScroll\('modified', event\)\)/, 'modified diff viewport can drive synchronized vertical scrolling');
  assert.match(editorUi, /diffScrollSyncEnabled = !diffScrollSyncEnabled/, 'diff synchronization can be toggled off for independent scrolling');
  assert.match(editorUi, /target\.setScrollTop\(source\.getScrollTop\(\)\)/, 're-enabling sync aligns the other pane to the last active viewport');
  assert.match(workbenchHtml, /id="diff-sync-scroll"[^>]*aria-pressed="true"[^>]*hidden>⇅ Sync scroll<\/button>/, 'diff toolbar exposes a sync-scroll toggle');
  assert.match(editorUi, /workbench-diff-line-number-add/, 'Monaco diff decorates added line numbers');
  assert.match(editorUi, /workbench-diff-line-number-remove/, 'Monaco diff decorates removed line numbers');
  assert.match(editorUi, /workbench-diff-line-add/, 'Monaco diff paints the full added line');
  assert.match(editorUi, /workbench-diff-line-remove/, 'Monaco diff paints the full removed line');
  assert.doesNotMatch(editorUi, /workbench-diff-intraline-/, 'Monaco diff does not add custom token-level highlight boxes');
  assert.match(workbenchCss, /\.diff-view\.independent-diff-host\s*\{[^}]*grid-template-columns:\s*minmax\(0,1fr\)\s+minmax\(0,1fr\)/s, 'independent diff view keeps two equal center panes');
  const monacoUiResponse = await fetch(admin + '/ui/workbench/monaco.js');
  assert.equal(monacoUiResponse.status, 200);
  const monacoUi = await monacoUiResponse.text();
  assert.match(monacoUi, /'diffEditor\.insertedTextBackground': '#223124'/, 'Monaco inserted text uses the same flat background as inserted lines');
  assert.match(monacoUi, /'diffEditor\.removedTextBackground': '#44272b'/, 'Monaco removed text uses the same flat background as removed lines');
  const historyUiResponse = await fetch(admin + '/ui/workbench/history.js');
  assert.equal(historyUiResponse.status, 200);
  const historyUi = await historyUiResponse.text();
  assert.match(historyUi, /currentWorkspaceOperations/);
  assert.match(historyUi, /Only activity from/);
  const explorerUiResponse = await fetch(admin + '/ui/workbench/explorer.js');
  assert.equal(explorerUiResponse.status, 200);
  const explorerUi = await explorerUiResponse.text();
  assert.match(explorerUi, /file-children/);
  assert.match(explorerUi, /search-result/);
  assert.equal((await fetch(admin + '/ui/workbench/agent-identity.js')).status, 200);
  assert.equal((await fetch(admin + '/ui/workbench/agent-presence.js')).status, 200);
  const processConsoleResponse = await fetch(admin + '/ui/workbench/terminal.js');
  assert.equal(processConsoleResponse.status, 200);
  const processConsoleUi = await processConsoleResponse.text();
  assert.match(processConsoleUi, /filter\(process => process\.running\)/, 'process console only surfaces live background processes');
  assert.match(processConsoleUi, /export function setupProcessConsole/, 'process console exposes its monitor-only setup');
  assert.doesNotMatch(processConsoleUi, /runOnce|startBackground|\/shell.*method:\s*'POST'/s, 'process console cannot launch arbitrary commands');
  assert.equal((await fetch(admin + '/ui/workbench/monaco.js')).status, 200);
  assert.equal((await fetch(admin + '/vendor/monaco/vs/loader.js')).status, 200);
  assert.match(agentsUi, /chatgpt\.status === 'connected'/);
  assert.match(agentsUi, /Approval required/);
  assert.match(agentsUi, /MCP ready · ChatGPT/);
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
  assert.equal(sessionHealth.connection_mode, 'local', 'health exposes the effective local/public connection mode');
  assert.equal(sessionHealth.active_sessions, 1, 'one live/recent MCP session is active');
  assert.equal(sessionHealth.recoverable_sessions, 1);
  assert.equal(sessionHealth.sessions[0].active, true);
  assert.equal(sessionHealth.sessions[0].clientType, 'mcp', 'ordinary MCP clients are not labeled as ChatGPT');
  assert.equal(sessionHealth.chatgpt.status, 'not_connected');
  assert.equal(sessionHealth.chatgpt.connected, false);
  assert.equal(sessionHealth.chatgpt.active_sessions, 0);
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
  assert.equal(Number(initialEvent.id), initialEvent.data.revision, 'SSE event id tracks the monotonic workbench revision');
  const typedEventPromise = eventStream.next();
  await policy(task.id, 'ask', true);
  const typedEvent = await typedEventPromise;
  assert.equal(typedEvent.event, 'change');
  assert.equal(typedEvent.data.taskId, task.id);
  assert.ok(typedEvent.data.scopes.includes('tasks'));
  assert.ok(typedEvent.data.scopes.includes('operations'));
  assert.ok(Number(typedEvent.id) > Number(initialEvent.id), 'persisted mutations advance the live revision');
  await eventStream.close();
  const replayResponse = await fetch(admin + `/api/workbench/events?afterRevision=${initialEvent.id}`, { headers: { Authorization: 'Bearer workbench-test-admin' } });
  const replayStream = sseEvents(replayResponse);
  const replayedEvent = await replayStream.next();
  assert.equal(replayedEvent.id, typedEvent.id, 'SSE reconnect replays missed revisions');
  assert.equal(replayedEvent.data.taskId, task.id);
  await replayStream.close();
  const toolList = await rpc('tools/list', {});
  assert.ok(toolList.tools.some(t => t.name === 'github'));
  assert.equal(toolList.tools.find(t => t.name === 'run_command').annotations.openWorldHint, true);
  console.log('OK authentication, origin guard, default policy, honest tool metadata');

  await policy(task.id, 'full', false);
  const delegatedReceipt = payload(await call('workbench_control', {
    action: 'create_task',
    task_title: 'Delegated child task',
    workspace_id: task.workspaceId,
    delegate_as_child: true,
    environment_mode: 'local',
  }));
  assert.equal(delegatedReceipt.task.parent_task_id, task.id, 'orchestrator creates a bounded child task under the current task');
  assert.equal(delegatedReceipt.assignment, null, 'local delegated child stays local unless explicitly queued');
  assert.equal(delegatedReceipt.dashboard_selection_unchanged, true, 'delegating a child does not repoint the Workbench dashboard');
  const delegatedChildId = delegatedReceipt.task.id;
  const delegatedChildren = payload(await call('workbench', { view: 'children' }));
  const delegatedChild = delegatedChildren.children.find(child => child.id === delegatedChildId);
  assert.ok(delegatedChild, 'parent can read delegated child status');
  assert.equal(delegatedChild.delegation_scope.canReadStatus, true);
  assert.equal(delegatedChild.delegation_scope.canReadHandoff, true);
  assert.equal(delegatedChild.delegation_scope.canRequestMerge, false);
  assert.match(delegatedChildren.boundary, /Raw child operation results and arguments are not exposed/);
  const delegatedState = await adminRequest('/api/workbench');
  assert.equal(delegatedState.selectedTaskId, task.id, 'child orchestration is independent from the dashboard-selected parent task');
  assert.equal(delegatedState.tasks.find(item => item.id === delegatedChildId)?.createdBySessionId, sid);
  assert.equal(delegatedState.agentAssignments.some(item => item.taskId === delegatedChildId && item.status === 'queued'), false);
  await adminRequest(`/api/workbench/tasks/${task.id}/select`, {});
  const reviewTurnMeta = { turn_id: 'workspace-review-regression-turn' };
  assert.equal((await call('write_file', { path: 'changeset-a.txt', content: 'alpha\n' }, reviewTurnMeta)).isError, undefined);
  assert.equal((await call('run_command', { command: 'node -e "process.exit(0)"' }, reviewTurnMeta)).isError, undefined, 'commands between edits remain inside the current review run');
  assert.equal((await call('read_text_file', { path: 'sample.txt' }, reviewTurnMeta)).isError, undefined, 'read-only tools do not split the active change set');
  assert.equal((await call('write_file', { path: 'changeset-b.txt', content: 'beta\n' }, reviewTurnMeta)).isError, undefined);
  const changeSetState = await adminRequest('/api/workbench');
  const changeSetOps = changeSetState.operations.filter(operation => (operation.changes || []).some(change => /changeset-[ab]\.txt$/i.test(change.path.replace(/\\/g, '/'))));
  assert.equal(changeSetOps.length, 2);
  assert.ok(changeSetOps[0].changeSetId, 'file operations expose a changeSetId');
  assert.equal(changeSetOps[0].changeSetId, changeSetOps[1].changeSetId, 'consecutive edits from one session share a change set');
  assert.equal(changeSetOps[0].reviewRunId, changeSetOps[1].reviewRunId, 'file operations expose the stable review-run identity');
  const changeSetId = changeSetOps[0].changeSetId;
  const runMembers = changeSetState.operations.filter(operation => operation.reviewRunId === changeSetId);
  assert.equal(runMembers.length, 3, 'edit -> command -> edit is one review run');
  const fullCommand = runMembers.find(operation => operation.tool === 'run_command');
  assert.ok(fullCommand);
  assert.equal(fullCommand.permission.decision, 'allow', 'Full uses the same permission engine for commands');
  assert.equal(fullCommand.permission.risk, 'command');
  assert.equal(fullCommand.permission.riskLevel, 'medium');
  assert.equal(fullCommand.permission.reasonCode, 'full_access');
  assert.ok(fullCommand.permission.effects.includes('process'));
  let latestChangeSet = (await adminRequest(`/api/workbench/workspaces/${task.workspaceId}/latest-change-set`)).changeSet;
  assert.equal(latestChangeSet.id, changeSetId);
  assert.equal(latestChangeSet.review.files.length, 2);
  assert.equal(latestChangeSet.canUndo, true);
  assert.equal(latestChangeSet.review.files.some(file => 'diff' in file), false, 'workspace summary omits full diffs');
  const changeSetDetail = await adminRequest(`/api/workbench/change-sets/${changeSetId}`);
  assert.equal(changeSetDetail.operationCount, 3);
  assert.equal(changeSetDetail.review.files.length, 2);
  assert.ok(changeSetDetail.review.files.every(file => typeof file.diff === 'string'), 'change-set review exposes aggregate diffs on demand');
  const latestReviewRun = (await adminRequest(`/api/workbench/workspaces/${task.workspaceId}/review-runs/latest`)).reviewRun;
  assert.equal(latestReviewRun.id, changeSetId, 'review-run API aliases the compatibility change-set identity');
  assert.equal(latestReviewRun.reviewRunStatus, 'open', 'active review run exposes its persisted lifecycle state');
  assert.ok(['host', 'fallback', 'explicit', 'local'].includes(latestReviewRun.identitySource));
  assert.ok(latestReviewRun.startedAt);
  const reviewRuns = (await adminRequest(`/api/workbench/workspaces/${task.workspaceId}/review-runs`)).reviewRuns;
  assert.equal(reviewRuns[0].id, changeSetId, 'review-run list returns the latest persisted review boundary first');
  const reviewRunDetail = await adminRequest(`/api/workbench/review-runs/${changeSetId}`);
  assert.equal(reviewRunDetail.operationCount, 3);
  assert.equal(reviewRunDetail.review.files.length, 2);
  await adminRequest(`/api/workbench/review-runs/${changeSetId}/undo`, { redo: false });
  await assert.rejects(fs.stat(path.join(workspace, 'changeset-a.txt')));
  await assert.rejects(fs.stat(path.join(workspace, 'changeset-b.txt')));
  latestChangeSet = (await adminRequest(`/api/workbench/workspaces/${task.workspaceId}/latest-change-set`)).changeSet;
  assert.equal(latestChangeSet.canRedo, true);
  await adminRequest(`/api/workbench/review-runs/${changeSetId}/undo`, { redo: true });
  assert.equal(await fs.readFile(path.join(workspace, 'changeset-a.txt'), 'utf8'), 'alpha\n');
  assert.equal(await fs.readFile(path.join(workspace, 'changeset-b.txt'), 'utf8'), 'beta\n');
  await fs.writeFile(path.join(workspace, 'changeset-b.txt'), 'human edit\n');
  assert.match(JSON.stringify(await adminRequest(`/api/workbench/change-sets/${changeSetId}/undo`, { redo: false }, 'POST', 400)), /UNDO_CONFLICT/);
  assert.equal(await fs.readFile(path.join(workspace, 'changeset-a.txt'), 'utf8'), 'alpha\n', 'batch conflict prevents partial Undo writes');
  assert.equal(await fs.readFile(path.join(workspace, 'changeset-b.txt'), 'utf8'), 'human edit\n');
  await fs.writeFile(path.join(workspace, 'changeset-b.txt'), 'beta\n');
  await adminRequest(`/api/workbench/change-sets/${changeSetId}/undo`, { redo: false });
  await assert.rejects(fs.stat(path.join(workspace, 'changeset-a.txt')));
  await assert.rejects(fs.stat(path.join(workspace, 'changeset-b.txt')));

  const headerTurn = { 'x-openai-turn-id': 'workspace-review-header-turn' };
  assert.equal((await callWithHeaders('write_file', { path: 'header-turn-a.txt', content: 'header-a\n' }, headerTurn)).isError, undefined);
  assert.equal((await callWithHeaders('write_file', { path: 'header-turn-b.txt', content: 'header-b\n' }, headerTurn)).isError, undefined);
  const headerTurnState = await adminRequest('/api/workbench');
  const headerTurnOps = headerTurnState.operations.filter(operation => (operation.changes || []).some(change => /header-turn-[ab]\.txt$/i.test(change.path.replace(/\\/g, '/'))));
  assert.equal(headerTurnOps.length, 2);
  assert.equal(headerTurnOps[0].reviewRunId, headerTurnOps[1].reviewRunId, 'stable host turn header groups mutations into one ReviewRun');
  assert.notEqual(headerTurnOps[0].reviewRunId, changeSetId, 'a new host turn header creates a new ReviewRun');
  await adminRequest(`/api/workbench/review-runs/${headerTurnOps[0].reviewRunId}/undo`, { redo: false });
  await assert.rejects(fs.stat(path.join(workspace, 'header-turn-a.txt')));
  await assert.rejects(fs.stat(path.join(workspace, 'header-turn-b.txt')));
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal((await call('write_file', { path: 'fallback-turn-a.txt', content: 'fallback-a\n' })).isError, undefined);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal((await call('write_file', { path: 'fallback-turn-b.txt', content: 'fallback-b\n' })).isError, undefined);
  const fallbackTurnState = await adminRequest('/api/workbench');
  const fallbackTurnOps = fallbackTurnState.operations.filter(operation => (operation.changes || []).some(change => /fallback-turn-[ab]\.txt$/i.test(change.path.replace(/\\/g, '/'))));
  assert.equal(fallbackTurnOps.length, 2);
  assert.notEqual(fallbackTurnOps[0].reviewRunId, fallbackTurnOps[1].reviewRunId, 'quiescent fallback lifecycle separates later user turns when the host supplies no turn id');
  await policy(task.id, 'ask', true);
  console.log('OK workspace review runs aggregate edits across commands and support conflict-safe batch Undo/Redo');

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
  assert.match(
    JSON.stringify(await adminRequest(`/api/workbench/tasks/${task.id}/assignment`, {}, 'POST', 400)),
    /AGENT_ASSIGNMENT_ISOLATION_REQUIRED/,
    'a second ChatGPT session cannot be queued onto the shared local checkout',
  );

  const cloneSource = path.join(tmp, 'clone-source');
  await fs.mkdir(cloneSource);
  await fs.writeFile(path.join(cloneSource, 'from-clone.txt'), 'cloned repository\n');
  execFileSync('git', ['init'], { cwd: cloneSource, windowsHide: true, stdio: 'pipe' });
  const cloneSourceGit = args => execFileSync('git', args, { cwd: cloneSource, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  cloneSourceGit(['config', 'user.name', 'Workbench Test']); cloneSourceGit(['config', 'user.email', 'workbench@example.invalid']);
  cloneSourceGit(['add', '--', 'from-clone.txt']); cloneSourceGit(['commit', '-m', 'clone fixture']);
  const cloneBranch = cloneSourceGit(['branch', '--show-current']);
  const cloneParent = path.join(tmp, 'cloned-workspaces');
  await fs.mkdir(cloneParent);
  const clonedWorkspace = await adminRequest('/api/workbench/workspaces/clone', {
    repository: cloneSource,
    destinationParent: cloneParent,
    branch: cloneBranch,
    name: 'Cloned project',
  });
  const clonedPath = path.join(cloneParent, 'clone-source');
  assert.equal(path.resolve(clonedWorkspace.destination), path.resolve(clonedPath), 'clone infers the destination folder from the repository');
  assert.equal(clonedWorkspace.workspace.name, 'Cloned project');
  assert.equal(clonedWorkspace.selectedWorkspaceId, clonedWorkspace.workspace.id, 'a cloned repository becomes the selected workspace immediately');
  assert.equal(clonedWorkspace.selectedTaskId, null, 'Advanced clone does not invent a task');
  assert.equal((await fs.readFile(path.join(clonedPath, 'from-clone.txt'), 'utf8')).replace(/\r\n/g, '\n'), 'cloned repository\n');
  assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd: clonedPath, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(), cloneBranch);
  workspaceState = await adminRequest('/api/workbench');
  assert.equal(workspaceState.selectedWorkspaceId, clonedWorkspace.workspace.id);
  assert.ok(workspaceState.workspaces.some(item => item.id === clonedWorkspace.workspace.id && path.resolve(item.path) === path.resolve(clonedPath)));
  assert.match(JSON.stringify(await adminRequest('/api/workbench/workspaces/clone', {
    repository: cloneSource,
    destinationParent: cloneParent,
    branch: cloneBranch,
  }, 'POST', 400)), /CLONE_DESTINATION_EXISTS/, 'clone never overwrites an existing destination');
  assert.match(JSON.stringify(await adminRequest('/api/workbench/workspaces/clone', {
    repository: cloneSource,
    destinationParent: cloneParent,
    folderName: '../escape',
  }, 'POST', 400)), /CLONE_FOLDER_INVALID/, 'clone rejects destination traversal');
  const failedClonePath = path.join(cloneParent, 'failed-clone');
  assert.match(JSON.stringify(await adminRequest('/api/workbench/workspaces/clone', {
    repository: path.join(tmp, 'repository-does-not-exist'),
    destinationParent: cloneParent,
    folderName: 'failed-clone',
  }, 'POST', 400)), /GIT_CLONE_FAILED/, 'failed Git clones are reported without registering a workspace');
  await assert.rejects(fs.stat(failedClonePath), 'failed clone cleanup removes only the newly-created partial destination');
  const removedClonedWorkspace = await adminRequest(`/api/workbench/workspaces/${clonedWorkspace.workspace.id}`, {}, 'DELETE');
  assert.equal(removedClonedWorkspace.projectFilesDeleted, false);
  assert.equal((await fs.readFile(path.join(clonedPath, 'from-clone.txt'), 'utf8')).replace(/\r\n/g, '\n'), 'cloned repository\n', 'removing a cloned workspace still keeps the repository on disk');
  await adminRequest(`/api/workbench/workspaces/${secondWorkspaceRecord.id}/select`, {});
  console.log('OK repository clone creates, selects and safely unregisters a workspace without network access');

  const relocatableWorkspacePath = path.join(tmp, 'relocatable-project');
  const relocatedWorkspacePath = path.join(tmp, 'relocated-project');
  const temporarilyMissingPath = path.join(tmp, 'relocated-project-away');
  await fs.mkdir(relocatableWorkspacePath);
  await fs.writeFile(path.join(relocatableWorkspacePath, 'history.txt'), 'before relocate\n');
  const relocatableWorkspace = await adminRequest('/api/workbench/workspaces', { name: 'Relocatable project', path: relocatableWorkspacePath });
  const relocatableTask = await adminRequest('/api/workbench/tasks', { title: 'Relocatable task', workspaceId: relocatableWorkspace.id });
  await policy(relocatableTask.id, 'full', false);
  await adminRequest(`/api/workbench/tasks/${relocatableTask.id}/file`, { path: 'history.txt', content: 'after relocate\n' }, 'PUT');
  workspaceState = await adminRequest('/api/workbench');
  const relocateWrite = [...workspaceState.operations].reverse().find(operation => operation.taskId === relocatableTask.id && operation.tool === 'write_file');
  assert.ok(relocateWrite?.id, 'relocation fixture keeps a real file operation in history');

  await fs.rename(relocatableWorkspacePath, relocatedWorkspacePath);
  workspaceState = await adminRequest('/api/workbench');
  const missingWorkspace = workspaceState.workspaces.find(item => item.id === relocatableWorkspace.id);
  assert.equal(missingWorkspace.availability, 'missing', 'Workbench dynamically marks an externally moved project folder as missing');
  assert.equal(path.resolve(missingWorkspace.path), path.resolve(relocatableWorkspacePath), 'missing status does not mutate or recreate the stored project path');
  await assert.rejects(fs.stat(relocatableWorkspacePath), 'Workbench never recreates an externally removed project folder');
  assert.match(JSON.stringify(await adminRequest(`/api/workbench/tasks/${relocatableTask.id}/file?path=history.txt`, undefined, 'GET', 400)), /WORKSPACE_MISSING/, 'file access is blocked while the workspace folder is missing');
  assert.match(JSON.stringify(await adminRequest(`/api/workbench/tasks/${relocatableTask.id}/shell`, { command: 'node -p "process.cwd()"' }, 'POST', 400)), /WORKSPACE_MISSING/, 'new shell work is blocked while the workspace folder is missing');
  assert.match(JSON.stringify(await adminRequest('/api/workbench/tasks', { title: 'Must not exist', workspaceId: relocatableWorkspace.id }, 'POST', 400)), /WORKSPACE_MISSING/, 'new tasks are blocked for a missing workspace');

  const relocatedWorkspace = await adminRequest(`/api/workbench/workspaces/${relocatableWorkspace.id}/path`, { path: relocatedWorkspacePath }, 'PUT');
  assert.equal(relocatedWorkspace.workspace.id, relocatableWorkspace.id, 'Locate folder preserves the workspace identity');
  assert.equal(relocatedWorkspace.workspace.availability, 'ready');
  workspaceState = await adminRequest('/api/workbench');
  const relocatedTask = workspaceState.tasks.find(item => item.id === relocatableTask.id);
  assert.equal(path.resolve(relocatedTask.workspace), path.resolve(relocatedWorkspacePath), 'Locate folder preserves the task and points it at the new project root');
  assert.equal(path.resolve(relocatedTask.execution.path), path.resolve(relocatedWorkspacePath), 'local task execution root follows the relocated workspace');
  const relocatedOperation = await adminRequest(`/api/workbench/operations/${relocateWrite.id}`);
  assert.ok(relocatedOperation.changes.every(change => path.resolve(change.path).startsWith(path.resolve(relocatedWorkspacePath))), 'operation history paths are remapped to the relocated project root');
  await adminRequest(`/api/workbench/operations/${relocateWrite.id}/undo`, { redo: false });
  assert.equal((await fs.readFile(path.join(relocatedWorkspacePath, 'history.txt'), 'utf8')).replace(/\r\n/g, '\n'), 'before relocate\n', 'Undo history remains usable after locating the moved project');
  await adminRequest(`/api/workbench/operations/${relocateWrite.id}/undo`, { redo: true });
  assert.equal((await fs.readFile(path.join(relocatedWorkspacePath, 'history.txt'), 'utf8')).replace(/\r\n/g, '\n'), 'after relocate\n');

  await fs.rename(relocatedWorkspacePath, temporarilyMissingPath);
  workspaceState = await adminRequest('/api/workbench');
  assert.equal(workspaceState.workspaces.find(item => item.id === relocatableWorkspace.id)?.availability, 'missing', 'availability is runtime-derived after a later external move');
  await fs.rename(temporarilyMissingPath, relocatedWorkspacePath);
  workspaceState = await adminRequest('/api/workbench');
  assert.equal(workspaceState.workspaces.find(item => item.id === relocatableWorkspace.id)?.availability, 'ready', 'workspace automatically returns to Ready when the same folder reappears');
  const removedRelocatedWorkspace = await adminRequest(`/api/workbench/workspaces/${relocatableWorkspace.id}`, {}, 'DELETE');
  assert.equal(removedRelocatedWorkspace.projectFilesDeleted, false, 'removing relocated metadata still never deletes the project folder');
  assert.equal((await fs.readFile(path.join(relocatedWorkspacePath, 'history.txt'), 'utf8')).replace(/\r\n/g, '\n'), 'after relocate\n');
  await adminRequest(`/api/workbench/workspaces/${secondWorkspaceRecord.id}/select`, {});
  console.log('OK missing workspace detection blocks project work, Locate preserves task/history, and restored folders auto-recover');

  const disposableWorkspace = path.join(tmp, 'disposable-project');
  await fs.mkdir(disposableWorkspace);
  await fs.writeFile(path.join(disposableWorkspace, 'keep.txt'), 'keep me');
  const disposableRecord = await adminRequest('/api/workbench/workspaces', { name: 'Disposable project', path: disposableWorkspace });
  const disposableTask = await adminRequest('/api/workbench/tasks', { title: 'Disposable task', workspaceId: disposableRecord.id });
  await adminRequest(`/api/workbench/workspaces/${disposableRecord.id}/select`, {});
  const pendingRemovalWrite = await adminRequest(`/api/workbench/tasks/${disposableTask.id}/file`, { path: 'pending.txt', content: 'pending\n' }, 'PUT');
  const pendingRemovalPayload = JSON.parse(pendingRemovalWrite.content[0].text);
  assert.equal(pendingRemovalPayload.status, 'approval_required');
  assert.match(JSON.stringify(await adminRequest(`/api/workbench/workspaces/${disposableRecord.id}`, {}, 'DELETE', 400)), /WORKSPACE_BUSY.*pending approvals/);
  await adminRequest(`/api/workbench/operations/${pendingRemovalPayload.operation_id}/decision`, { approve: false });
  const removedWorkspace = await adminRequest(`/api/workbench/workspaces/${disposableRecord.id}`, {}, 'DELETE');
  assert.equal(removedWorkspace.projectFilesDeleted, false);
  assert.equal(removedWorkspace.removed.tasks, 1);
  assert.equal(removedWorkspace.selectedWorkspaceId, secondWorkspaceRecord.id, 'removing the selected workspace falls back to the most recently opened remaining workspace');
  assert.equal(await fs.readFile(path.join(disposableWorkspace, 'keep.txt'), 'utf8'), 'keep me', 'removing a workspace never deletes project files');
  await assert.rejects(fs.stat(path.join(disposableWorkspace, 'pending.txt')), 'denied pending work is never applied while removing a workspace');
  workspaceState = await adminRequest('/api/workbench');
  assert.ok(!workspaceState.workspaces.some(item => item.id === disposableRecord.id));
  assert.ok(!workspaceState.tasks.some(item => item.id === disposableTask.id));
  assert.equal(workspaceState.selectedWorkspaceId, secondWorkspaceRecord.id);
  console.log('OK workspace removal blocks pending work, selects a fallback, and preserves project files');

  const secondTask = await adminRequest('/api/workbench/tasks', { title: 'Second project', workspaceId: secondWorkspaceRecord.id });
  assert.equal(secondTask.workspaceId, secondWorkspaceRecord.id);
  assert.equal(secondTask.workspace, secondWorkspace);
  await adminRequest(`/api/workbench/tasks/${secondTask.id}/select`, {});
  assert.equal(payload(await call('workbench')).task.id, task.id, 'Existing session stays pinned');
  sid = undefined;
  const selectedChatInit = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ChatGPT selected workspace regression', version: '1' } });
  const selectedChatSid = sid;
  assert.ok(selectedChatSid, 'selected-workspace ChatGPT regression creates a session');
  assert.ok(selectedChatInit.instructions.includes('SECOND_PROJECT_INSTRUCTIONS'), 'new ChatGPT session receives instructions from the selected Advanced workspace');
  assert.ok(!selectedChatInit.instructions.includes('FIRST_PROJECT_PRIVATE_INSTRUCTIONS'), 'new ChatGPT session must not inherit the bootstrap workspace instructions');
  assert.equal(payload(await call('workbench')).task.id, secondTask.id, 'new unassigned ChatGPT session follows the selected Advanced task instead of WORKSPACE_PATH');
  await fetch(base + '/mcp', { method: 'DELETE', headers: { Authorization: 'Bearer workbench-test-mcp', 'mcp-session-id': selectedChatSid, 'mcp-protocol-version': '2025-03-26' } });
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
  assert.equal(previewStatus.running, false); assert.equal(previewStatus.configured, true); assert.equal(previewStatus.leased, false);

  const previewSiblingTask = await adminRequest('/api/workbench/tasks', { title: 'Preview sibling', workspaceId: secondWorkspaceRecord.id });
  await policy(previewSiblingTask.id, 'full', false);
  const autoPreviewCommand = `node -e "const p=Number(process.env.PORT);require('http').createServer((q,s)=>s.end('preview-'+p)).listen(p,'127.0.0.1')"`;
  await adminRequest(`/api/workbench/tasks/${secondTask.id}/preview`, { command: autoPreviewCommand }, 'PUT');
  const autoPreviewA = await adminRequest(`/api/workbench/tasks/${secondTask.id}/preview/start`, { command: autoPreviewCommand });
  const autoPreviewB = await adminRequest(`/api/workbench/tasks/${previewSiblingTask.id}/preview/start`, { command: autoPreviewCommand });
  assert.ok(Number.isInteger(autoPreviewA.port) && Number.isInteger(autoPreviewB.port), 'auto previews receive numeric port leases');
  assert.notEqual(autoPreviewA.port, autoPreviewB.port, 'parallel task previews receive distinct ports');
  assert.match(autoPreviewA.url, new RegExp(`:${autoPreviewA.port}/`));
  assert.match(autoPreviewB.url, new RegExp(`:${autoPreviewB.port}/`));
  let autoPreviewStatusA, autoPreviewStatusB;
  for (let i = 0; i < 40; i++) {
    [autoPreviewStatusA, autoPreviewStatusB] = await Promise.all([
      adminRequest(`/api/workbench/tasks/${secondTask.id}/preview`),
      adminRequest(`/api/workbench/tasks/${previewSiblingTask.id}/preview`),
    ]);
    if (autoPreviewStatusA.reachable && autoPreviewStatusB.reachable) break;
    await new Promise(resolve => setTimeout(resolve, 70));
  }
  assert.equal(autoPreviewStatusA.running, true); assert.equal(autoPreviewStatusA.reachable, true); assert.equal(autoPreviewStatusA.leased, true);
  assert.equal(autoPreviewStatusB.running, true); assert.equal(autoPreviewStatusB.reachable, true); assert.equal(autoPreviewStatusB.leased, true);
  assert.equal(await (await fetch(autoPreviewA.url)).text(), `preview-${autoPreviewA.port}`, 'Preview A receives its leased PORT environment variable');
  assert.equal(await (await fetch(autoPreviewB.url)).text(), `preview-${autoPreviewB.port}`, 'Preview B receives its leased PORT environment variable');
  let previewLeaseState = await adminRequest('/api/workbench');
  const activePreviewLeases = previewLeaseState.portLeases.filter(lease => [secondTask.id, previewSiblingTask.id].includes(lease.taskId));
  assert.equal(activePreviewLeases.length, 2, 'Workbench persists one preview lease per running task');
  assert.equal(new Set(activePreviewLeases.map(lease => lease.port)).size, 2, 'persisted preview leases cannot share a port');
  await adminRequest(`/api/workbench/tasks/${secondTask.id}/preview/stop`, {});
  await adminRequest(`/api/workbench/tasks/${previewSiblingTask.id}/preview/stop`, {});
  previewLeaseState = await adminRequest('/api/workbench');
  assert.equal(previewLeaseState.portLeases.some(lease => [secondTask.id, previewSiblingTask.id].includes(lease.taskId)), false, 'stopping previews releases both port leases');
  const health = await adminRequest('/health');
  assert.ok(health.sessions.some(session => session.taskId === secondTask.id && session.clientInfo?.name === 'second-session'));
  assert.equal(health.tool_profile, 'full'); assert.ok(Array.isArray(health.core_tools));
  console.log('OK Workbench project explorer, shell/process/preview APIs, distinct preview port leases, structured Git status, sessions and task activity');
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
  assert.equal(connection.chatgpt, true, 'ChatGPT callback marks the pending OAuth client as ChatGPT');
  const pendingChatGptHealth = await adminRequest('/health');
  assert.equal(pendingChatGptHealth.chatgpt.status, 'approval_required');
  assert.equal(pendingChatGptHealth.chatgpt.connected, false);
  assert.equal(pendingChatGptHealth.chatgpt.pending_approvals, 1);
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
  const chatGptInitResponse = await fetch(base + '/mcp', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${oauthTokens.access_token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'chatgpt-status-init', method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'neutral-oauth-client', version: '1' } },
    }),
  });
  assert.equal(chatGptInitResponse.status, 200);
  const chatGptSid = chatGptInitResponse.headers.get('mcp-session-id');
  assert.ok(chatGptSid, 'ChatGPT OAuth initialize creates an MCP session');
  await chatGptInitResponse.arrayBuffer();
  const connectedChatGptHealth = await adminRequest('/health');
  const chatGptSession = connectedChatGptHealth.sessions.find(session => session.id === chatGptSid);
  assert.equal(chatGptSession?.clientType, 'chatgpt', 'OAuth ChatGPT identity classifies the session independently of clientInfo name');
  assert.equal(connectedChatGptHealth.chatgpt.status, 'connected');
  assert.equal(connectedChatGptHealth.chatgpt.connected, true);
  assert.ok(connectedChatGptHealth.chatgpt.active_sessions >= 1);
  assert.equal(connectedChatGptHealth.chatgpt.pending_approvals, 0);
  const refreshed = await exchange({ grant_type: 'refresh_token', refresh_token: oauthTokens.refresh_token, resource });
  assert.equal(refreshed.status, 200); const freshTokens = await refreshed.json();
  assert.equal((await exchange({ grant_type: 'refresh_token', refresh_token: oauthTokens.refresh_token, resource })).status, 400);
  const oauthAccessStatus = async token => (await fetch(base + '/mcp', { headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' } })).status;
  assert.notEqual(await oauthAccessStatus(freshTokens.access_token), 401);
  console.log('OK ChatGPT connection status transitions from not connected to approval required to connected');
  console.log('OK OAuth registration, local consent, browser binding, PKCE, audience, one-time code and refresh rotation');

  const request = payload(await call('write_file', { path: 'sample.txt', content: 'after\n' }));
  assert.equal(request.status, 'approval_required');
  assert.equal(request.risk, 'edit');
  assert.equal(request.risk_level, 'low');
  assert.equal(request.reason_code, 'approval_required');
  assert.ok(request.effects.includes('files'));
  assert.match(request.reason, /Ask requires approval/);
  assert.equal(await fs.readFile(path.join(workspace, 'sample.txt'), 'utf8'), 'before\n');
  const pendingReview = await adminRequest(`/api/workbench/operations/${request.operation_id}`);
  assert.equal(pendingReview.sessionId, sid, 'MCP operation is attributed to the originating session');
  assert.equal(pendingReview.permission.decision, 'prompt');
  assert.equal(pendingReview.permission.risk, 'edit');
  assert.equal(pendingReview.permission.riskLevel, 'low');
  assert.equal(pendingReview.permission.reasonCode, 'approval_required');
  assert.ok(pendingReview.permission.effects.includes('files'));
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
  const repeatedApproval = await approve(request.operation_id);
  assert.equal(repeatedApproval.status, 'completed', 'repeating an already-applied approval is idempotent');
  assert.match(JSON.stringify(await adminRequest(`/api/workbench/operations/${request.operation_id}/decision`, { approve: false }, 'POST', 409)), /APPROVAL_DECISION_CONFLICT/);
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
  const repeatedDenial = await adminRequest(`/api/workbench/operations/${patchPreviewRequest.operation_id}/decision`, { approve: false });
  assert.equal(repeatedDenial.status, 'denied', 'repeating a denial is idempotent');
  assert.match(JSON.stringify(await adminRequest(`/api/workbench/operations/${patchPreviewRequest.operation_id}/decision`, { approve: true }, 'POST', 409)), /APPROVAL_DECISION_CONFLICT/);
  await assert.rejects(fs.stat(path.join(workspace, 'preview-a.txt')));
  const cleanCheckpoint = await adminRequest(`/api/workbench/tasks/${task.id}/checkpoints`, { title: 'Before task batch' });
  await policy(task.id, 'auto', true);
  assert.equal((await call('write_file', { path: 'sample.txt', content: 'checkpoint change\n' })).isError, undefined);
  assert.equal((await call('write_file', { path: 'checkpoint-new.txt', content: 'new from checkpoint\n' })).isError, undefined);
  const autoPermissionState = await adminRequest('/api/workbench');
  const autoWrite = autoPermissionState.operations.find(operation => operation.taskId === task.id && operation.tool === 'write_file'
    && (operation.changes || []).some(change => /checkpoint-new\.txt$/i.test(change.path.replace(/\\/g, '/'))));
  assert.equal(autoWrite.permission.decision, 'allow', 'Auto routes routine workspace edits through the same permission engine without prompting');
  assert.equal(autoWrite.permission.risk, 'edit');
  assert.equal(autoWrite.permission.riskLevel, 'low');
  assert.equal(autoWrite.permission.reasonCode, 'auto_safe_edit');
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
  await policy(task.id, 'auto', true);
  assert.match(JSON.stringify(await approve(revoked.operation_id, 410)), /APPROVAL_GONE/, 'policy changes invalidate pending approvals with an explicit terminal response');
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

  const isolatedReceipt = payload(await call('workbench_control', {
    action: 'create_task',
    task_title: 'Isolated worktree task',
    workspace_id: task.workspaceId,
    delegate_as_child: true,
    assign_next_chatgpt: true,
  }));
  const isolatedTask = (await adminRequest('/api/workbench')).tasks.find(item => item.id === isolatedReceipt.task.id);
  assert.ok(isolatedTask, 'delegated queued child is persisted');
  assert.equal(isolatedTask.parentTaskId, task.id, 'queued child remains linked to its orchestrator parent');
  assert.equal(isolatedTask.execution.mode, 'worktree');
  assert.equal(isolatedTask.kind, 'parallel');
  assert.equal(isolatedTask.lifecycle, 'open');
  assert.equal(isolatedTask.execution.detached, false);
  assert.equal(isolatedTask.execution.managed, true);
  assert.match(isolatedTask.execution.branch, /^local-coder\/isolated-worktree-task-[a-f0-9]{8}$/);
  assert.equal(isolatedTask.execution.baseOid, git(['rev-parse', 'HEAD']));
  assert.notEqual(path.resolve(isolatedTask.execution.path), path.resolve(workspace));
  assert.equal(await fs.readFile(path.join(isolatedTask.execution.path, 'sample.txt'), 'utf8'), 'selected change');
  await policy(isolatedTask.id, 'full', false);
  const isolatedOverview = await adminRequest(`/api/workbench/tasks/${isolatedTask.id}/git/overview`);
  assert.equal(isolatedOverview.execution.mode, 'worktree');
  assert.equal(isolatedOverview.status.branch, isolatedTask.execution.branch);
  assert.equal(isolatedOverview.status.head_oid, isolatedTask.execution.baseOid);
  assert.ok(isolatedOverview.worktrees.some(item => path.resolve(item.path) === path.resolve(isolatedTask.execution.path) && item.branch === isolatedTask.execution.branch && !item.detached));

  let coordinatorState = await adminRequest('/api/workbench');
  const isolatedReservation = coordinatorState.agentAssignments.find(item => item.taskId === isolatedTask.id);
  assert.ok(isolatedReservation, 'parallel task can reserve the next ChatGPT session');
  assert.equal(isolatedReservation.status, 'queued');
  assert.equal(isolatedReservation.clientType, 'chatgpt');
  const sidBeforeAssignment = sid;
  await adminRequest(`/api/workbench/workspaces/${secondWorkspaceRecord.id}/select`, {});
  sid = undefined;
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ChatGPT assignment test', version: '1' } });
  const assignmentSid = sid;
  assert.ok(assignmentSid);
  assert.equal(payload(await call('workbench')).task.id, isolatedTask.id, 'unique queued task is claimed even while another workspace is open in the dashboard');
  coordinatorState = await adminRequest('/api/workbench');
  assert.ok(!coordinatorState.agentAssignments.some(item => item.taskId === isolatedTask.id), 'claimed assignment leaves the public queue');
  assert.ok(coordinatorState.agentBindings.some(item => item.sessionId === assignmentSid && item.taskId === isolatedTask.id && item.clientType === 'chatgpt'));
  const persistedAfterClaim = JSON.parse(await fs.readFile(path.join(env.WORKBENCH_PATH, 'state.json'), 'utf8'));
  const claimedReservation = persistedAfterClaim.agentAssignments.find(item => item.id === isolatedReservation.id);
  assert.equal(claimedReservation?.status, 'claimed', 'claimed lease is retained in bounded assignment history');
  assert.equal(claimedReservation?.claimedBySessionId, assignmentSid, 'claimed lease records the owning session');
  assert.ok(claimedReservation?.claimedAt, 'claimed lease records claim time');

  const conflictTask = await adminRequest('/api/workbench/tasks', {
    title: 'Frontend conflict task',
    workspaceId: task.workspaceId,
    environment: { mode: 'worktree', startingRef: 'HEAD' },
    kind: 'parallel',
    assignNextChatgpt: true,
  });
  const backendTask = await adminRequest('/api/workbench/tasks', {
    title: 'Backend queued task',
    workspaceId: task.workspaceId,
    environment: { mode: 'worktree', startingRef: 'HEAD' },
    kind: 'parallel',
    assignNextChatgpt: true,
  });
  const otherWorkspaceTask = await adminRequest('/api/workbench/tasks', {
    title: 'Other workspace queued task',
    workspaceId: secondWorkspaceRecord.id,
    environment: { mode: 'worktree', startingRef: 'HEAD' },
    kind: 'parallel',
    assignNextChatgpt: true,
  });
  assert.equal((await adminRequest('/api/workbench')).agentAssignments.filter(item =>
    [conflictTask.id, backendTask.id].includes(item.taskId)).length, 2,
  'two independent worktree assignments can wait in the same workspace');
  await adminRequest(`/api/workbench/workspaces/${secondWorkspaceRecord.id}/select`, {});
  sid = undefined;
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ChatGPT other workspace agent', version: '1' } });
  const otherWorkspaceSid = sid;
  assert.equal(payload(await call('workbench')).task.id, otherWorkspaceTask.id,
    'multiple queued leases cannot steal an assignment from another selected workspace');
  assert.equal((await adminRequest('/api/workbench')).agentAssignments.filter(item =>
    [conflictTask.id, backendTask.id].includes(item.taskId)).length, 2,
  'claiming another workspace leaves both queued agents untouched');
  await adminRequest(`/api/workbench/tasks/${isolatedTask.id}/select`, {});
  sid = undefined;
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ChatGPT second parallel agent', version: '1' } });
  const conflictSid = sid;
  assert.ok(conflictSid && conflictSid !== assignmentSid);
  assert.equal(payload(await call('workbench')).task.id, conflictTask.id, 'oldest lease in the selected workspace is claimed even when Task A is open');
  sid = undefined;
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ChatGPT third parallel agent', version: '1' } });
  const backendSid = sid;
  assert.ok(backendSid && backendSid !== conflictSid && backendSid !== assignmentSid);
  assert.equal(payload(await call('workbench')).task.id, backendTask.id, 'second queued lease is claimed by a different session without changing dashboard selection');
  assert.equal((await adminRequest('/api/workbench')).agentAssignments.some(item =>
    [conflictTask.id, backendTask.id].includes(item.taskId)), false, 'both leases are consumed exactly once');

  await adminRequest(`/api/workbench/tasks/${conflictTask.id}/select`, {});
  sid = assignmentSid;
  assert.equal(payload(await call('workbench')).task.id, isolatedTask.id, 'Chat A stays pinned to Task A while the Workbench UI views Task B');
  await adminRequest(`/api/workbench/tasks/${isolatedTask.id}/select`, {});
  sid = conflictSid;
  assert.equal(payload(await call('workbench')).task.id, conflictTask.id, 'Chat B stays pinned to Task B while the Workbench UI views Task A');

  await policy(isolatedTask.id, 'full', false);
  await policy(conflictTask.id, 'full', false);
  await policy(backendTask.id, 'full', false);
  const sessionTimedCommand = (file, waitMs) => `node -e "const fs=require('fs');const f='${file}';const v={start:Date.now()};fs.writeFileSync(f,JSON.stringify(v));setTimeout(()=>{v.end=Date.now();fs.writeFileSync(f,JSON.stringify(v));},${waitMs})"`;
  await Promise.all([
    callWithSession(assignmentSid, 'run_command', { command: sessionTimedCommand('agent-session-a.json', 500) }),
    callWithSession(conflictSid, 'run_command', { command: sessionTimedCommand('agent-session-b.json', 500) }),
    callWithSession(backendSid, 'run_command', { command: sessionTimedCommand('agent-session-c.json', 500) }),
  ]);
  const sessionA = JSON.parse(await fs.readFile(path.join(isolatedTask.execution.path, 'agent-session-a.json'), 'utf8'));
  const sessionB = JSON.parse(await fs.readFile(path.join(conflictTask.execution.path, 'agent-session-b.json'), 'utf8'));
  const sessionC = JSON.parse(await fs.readFile(path.join(backendTask.execution.path, 'agent-session-c.json'), 'utf8'));
  assert.ok([sessionA, sessionB, sessionC].every((current, index, all) => all.every((other, otherIndex) =>
    index === otherIndex || (current.start < other.end && other.start < current.end))),
  'three ChatGPT sessions execute concurrently on separate task worktrees');

  await fs.writeFile(path.join(isolatedTask.execution.path, 'sample.txt'), 'agent-a conflict\n');
  await fs.writeFile(path.join(conflictTask.execution.path, 'sample.txt'), 'agent-b conflict\n');
  const parallelAgentCoordinator = await adminRequest('/api/workbench/agents');
  const isolatedAgent = parallelAgentCoordinator.agents.find(agent => agent.sessionId === assignmentSid);
  const conflictAgent = parallelAgentCoordinator.agents.find(agent => agent.sessionId === conflictSid);
  assert.equal(isolatedAgent?.taskTitle, 'Isolated worktree task');
  assert.ok(isolatedAgent?.changedPaths.includes('sample.txt'), 'active parallel agent reports its changed paths');
  assert.equal(conflictAgent?.taskTitle, 'Frontend conflict task');
  assert.ok(conflictAgent?.changedPaths.includes('sample.txt'), 'second active parallel agent reports its changed paths');
  assert.ok(isolatedAgent?.conflicts.some(conflict => conflict.type === 'path_overlap' && conflict.withTaskId === conflictTask.id && conflict.paths?.includes('sample.txt')));
  assert.ok(conflictAgent?.conflicts.some(conflict => conflict.type === 'path_overlap' && conflict.withTaskId === isolatedTask.id && conflict.paths?.includes('sample.txt')));
  assert.ok(parallelAgentCoordinator.summary.conflicts >= 2, 'conflict summary counts affected agent rows');
  console.log('OK Session Routing V2 claims multiple queued tasks and runs three ChatGPT agents concurrently regardless of Workbench selection');
  console.log('OK aggregate agent coordinator reports active work, changed paths and cross-task conflicts');

  // Regression for the real chat workflow: @Coder is already bound to one task,
  // then the user explicitly asks it to read an existing different task in the
  // SAME workspace. Neither Ask/workspace-only nor dashboard selection should
  // prevent this safe operation or retarget any other chat.
  const testerTask = await adminRequest('/api/workbench/tasks', {
    title: 'Tester', workspaceId: task.workspaceId,
    environment: { mode: 'worktree', startingRef: 'HEAD' }, kind: 'parallel', assignNextChatgpt: true,
  });
  sid = undefined;
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ChatGPT fourth parallel agent', version: '1' } });
  const testerSid = sid;
  assert.equal(payload(await call('workbench')).task.id, testerTask.id, 'fourth chat claims a fourth independent task in the same workspace');
  const dataTask = await adminRequest('/api/workbench/tasks', {
    title: 'Kết nối data', workspaceId: task.workspaceId,
    environment: { mode: 'worktree', startingRef: 'HEAD' }, kind: 'parallel', assignNextChatgpt: true,
  });
  await adminRequest('/api/workbench/tasks', { title: 'Duplicate task name', workspaceId: task.workspaceId });
  await adminRequest('/api/workbench/tasks', { title: 'Duplicate task name', workspaceId: task.workspaceId });
  await fs.writeFile(path.join(dataTask.execution.path, 'data-only.txt'), 'DATA_TASK_WORKTREE_ONLY');
  await policy(backendTask.id, 'ask', true);
  sid = backendSid;
  const available = payload(await call('workbench'));
  assert.ok(available.available_tasks.some(item => item.id === dataTask.id && item.title === 'Kết nối data'));
  assert.ok(available.available_tasks.some(item => item.id === testerTask.id && item.in_use_by_other_chat));
  const selectionBeforeSwitch = (await adminRequest('/api/workbench')).selectedTaskId;
  const occupied = await call('workbench_control', { action: 'target', task_title: 'Tester', create_missing: false });
  assert.equal(occupied.isError, true);
  assert.match(text(occupied), /TASK_TARGET_IN_USE/);
  const foreign = await call('workbench_control', { action: 'target', task_title: 'Second project', create_missing: false });
  assert.equal(foreign.isError, true);
  assert.match(text(foreign), /TASK_TARGET_NOT_FOUND/);
  const ambiguous = await call('workbench_control', { action: 'target', task_title: 'Duplicate task name', create_missing: false });
  assert.equal(ambiguous.isError, true);
  assert.match(text(ambiguous), /TASK_TARGET_AMBIGUOUS/);
  const reserved = await call('workbench_control', { action: 'target', task_title: 'Kết nối data', create_missing: false });
  assert.equal(reserved.isError, true);
  assert.match(text(reserved), /TASK_TARGET_RESERVED/, 'a chat cannot silently steal another session\'s queued lease');
  await adminRequest(`/api/workbench/tasks/${dataTask.id}/assignment`, {}, 'DELETE');
  assert.equal(payload(await call('workbench')).task.id, backendTask.id, 'failed task switches do not change the binding');

  const pendingSwitch = payload(await call('write_file', { path: 'pending-before-switch.txt', content: 'must not execute' }));
  assert.equal(pendingSwitch.status, 'approval_required');
  const busySwitch = await call('workbench_control', { action: 'target', task_title: 'Kết nối data', create_missing: false });
  assert.equal(busySwitch.isError, true);
  assert.match(text(busySwitch), /AGENT_TARGET_BUSY/);
  await adminRequest(`/api/workbench/operations/${pendingSwitch.operation_id}/decision`, { approve: false });
  const switched = payload(await call('workbench_control', { action: 'target', task_title: 'Kết nối data', create_missing: false }));
  assert.equal(switched.task.id, dataTask.id);
  assert.equal(switched.created.task, false);
  assert.equal(switched.dashboard_selection_unchanged, true);
  assert.equal(payload(await call('workbench')).task.id, dataTask.id);
  assert.equal(payload(await call('workbench_control', { action: 'target', task_id: dataTask.id, create_missing: false })).session.retargeted, false,
    'target by exact task ID is idempotent');
  assert.match(text(await call('read_text_file', { path: 'data-only.txt' })), /DATA_TASK_WORKTREE_ONLY/);
  assert.equal((await call('read_text_file', { path: path.join(backendTask.execution.path, 'sample.txt') })).isError, true,
    'workspace-only after switching cannot access the previous task worktree');
  assert.equal(path.resolve(payload(await call('project_context')).data.root), path.resolve(dataTask.execution.path));
  assert.equal(path.resolve(payload(await call('shell_status')).data.cwd), path.resolve(dataTask.execution.path));
  assert.equal((await adminRequest('/api/workbench')).selectedTaskId, selectionBeforeSwitch);
  assert.equal(payload(await callWithSession(assignmentSid, 'workbench')).task.id, isolatedTask.id);
  assert.equal(payload(await callWithSession(conflictSid, 'workbench')).task.id, conflictTask.id);
  assert.equal(payload(await callWithSession(testerSid, 'workbench')).task.id, testerTask.id);

  await policy(dataTask.id, 'full', false);
  await policy(testerTask.id, 'full', false);
  await Promise.all([
    callWithSession(assignmentSid, 'run_command', { command: sessionTimedCommand('four-agent-a.json', 650) }),
    callWithSession(conflictSid, 'run_command', { command: sessionTimedCommand('four-agent-b.json', 650) }),
    callWithSession(backendSid, 'run_command', { command: sessionTimedCommand('four-agent-c.json', 650) }),
    callWithSession(testerSid, 'run_command', { command: sessionTimedCommand('four-agent-d.json', 650) }),
  ]);
  const fourAgents = await Promise.all([
    [isolatedTask.execution.path, 'four-agent-a.json'], [conflictTask.execution.path, 'four-agent-b.json'],
    [dataTask.execution.path, 'four-agent-c.json'], [testerTask.execution.path, 'four-agent-d.json'],
  ].map(async ([root, file]) => JSON.parse(await fs.readFile(path.join(root, file), 'utf8'))));
  assert.ok(fourAgents.every((current, index) => fourAgents.every((other, otherIndex) =>
    index === otherIndex || (current.start < other.end && other.start < current.end))),
  'four ChatGPT sessions perform commands concurrently in four separate worktrees in the same workspace');
  console.log('OK explicit Ask/workspace-only chat task switching is isolated, conflict-safe and four agents run simultaneously');

  const integrationWorkspacePath = path.join(tmp, 'integration-project');
  await fs.mkdir(integrationWorkspacePath);
  await fs.writeFile(path.join(integrationWorkspacePath, 'base.txt'), 'integration base\n');
  execFileSync('git', ['init'], { cwd: integrationWorkspacePath, windowsHide: true, stdio: 'pipe' });
  const integrationGit = args => execFileSync('git', args, { cwd: integrationWorkspacePath, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  integrationGit(['config', 'user.name', 'Workbench Test']); integrationGit(['config', 'user.email', 'workbench@example.invalid']);
  integrationGit(['add', '--', 'base.txt']); integrationGit(['commit', '-m', 'integration baseline']);
  const integrationTargetBranch = integrationGit(['branch', '--show-current']);
  assert.ok(integrationTargetBranch, 'integration fixture uses a real target branch');
  const integrationWorkspaceRecord = await adminRequest('/api/workbench/workspaces', { name: 'Integration project', path: integrationWorkspacePath });
  const mergeQueueTask = await adminRequest('/api/workbench/tasks', {
    title: 'Merge queue task',
    workspaceId: integrationWorkspaceRecord.id,
    environment: { mode: 'worktree', startingRef: 'HEAD' },
    kind: 'parallel',
  });
  assert.equal(mergeQueueTask.integration.targetBranch, integrationTargetBranch, 'parallel task captures its integration target branch at creation');
  const mergeQueueGit = args => execFileSync('git', args, { cwd: mergeQueueTask.execution.path, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  await fs.writeFile(path.join(mergeQueueTask.execution.path, 'base.txt'), 'merged by queue\n');
  let integrationQueue = await adminRequest(`/api/workbench/integration?workspaceId=${integrationWorkspaceRecord.id}`);
  let mergeQueueView = integrationQueue.tasks.find(item => item.taskId === mergeQueueTask.id);
  assert.equal(mergeQueueView.lifecycle, 'open');
  assert.equal(mergeQueueView.sourceDirty, true);
  assert.equal(mergeQueueView.canMarkReady, false, 'dirty source worktree cannot enter the merge queue');
  assert.match(JSON.stringify(await adminRequest(`/api/workbench/tasks/${mergeQueueTask.id}/integration/ready`, {}, 'POST', 400)), /INTEGRATION_NOT_READY|Commit or discard source worktree changes/);

  const dependentIntegrationTask = await adminRequest('/api/workbench/tasks', {
    title: 'Dependent merge task',
    workspaceId: integrationWorkspaceRecord.id,
    environment: { mode: 'worktree', startingRef: 'HEAD' },
    kind: 'parallel',
  });
  const dependentGit = args => execFileSync('git', args, { cwd: dependentIntegrationTask.execution.path, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  await fs.writeFile(path.join(dependentIntegrationTask.execution.path, 'dependent.txt'), 'depends on merge queue task\n');
  dependentGit(['add', '--', 'dependent.txt']); dependentGit(['commit', '-m', 'dependent integration change']);
  const dependencyView = await adminRequest(`/api/workbench/tasks/${dependentIntegrationTask.id}/integration/dependencies`, { taskIds: [mergeQueueTask.id] }, 'PUT');
  assert.equal(dependencyView.dependencies.length, 1);
  assert.equal(dependencyView.dependencies[0].taskId, mergeQueueTask.id);
  assert.equal(dependencyView.dependencies[0].satisfied, false);
  assert.match(JSON.stringify(await adminRequest(`/api/workbench/tasks/${mergeQueueTask.id}/integration/dependencies`, { taskIds: [dependentIntegrationTask.id] }, 'PUT', 400)), /INTEGRATION_DEPENDENCY_CYCLE/, 'dependency graph rejects cycles');
  integrationQueue = await adminRequest(`/api/workbench/integration?workspaceId=${integrationWorkspaceRecord.id}`);
  const prerequisiteBeforeReady = integrationQueue.tasks.find(item => item.taskId === mergeQueueTask.id);
  const dependentBeforeReady = integrationQueue.tasks.find(item => item.taskId === dependentIntegrationTask.id);
  assert.ok(prerequisiteBeforeReady.queuePosition < dependentBeforeReady.queuePosition, 'dependency topology orders prerequisite before dependent task');

  let dependentReady = await adminRequest(`/api/workbench/tasks/${dependentIntegrationTask.id}/integration/ready`, {});
  assert.equal(dependentReady.lifecycle, 'ready_to_merge');
  assert.equal(dependentReady.canMerge, false, 'ready task cannot merge while a dependency is unresolved');
  assert.deepEqual(dependentReady.unresolvedDependencyIds, [mergeQueueTask.id]);
  assert.match(dependentReady.reason, /Waiting for 1 dependency: Merge queue task/);
  assert.match(JSON.stringify(await adminRequest(`/api/workbench/tasks/${dependentIntegrationTask.id}/integration/dependencies`, { taskIds: [] }, 'PUT', 400)), /INTEGRATION_STATE/, 'review-locked task cannot rewrite merge ordering');
  assert.match(JSON.stringify(await adminRequest(`/api/workbench/tasks/${dependentIntegrationTask.id}/file`, { path: 'dependent.txt', content: 'review invalidated\n' }, 'PUT', 400)), /TASK_INTEGRATION_LOCKED/, 'dependency-waiting ready task remains review locked');
  const dependentResumed = await adminRequest(`/api/workbench/tasks/${dependentIntegrationTask.id}/integration/reopen`, {});
  assert.equal(dependentResumed.lifecycle, 'open');
  assert.equal(dependentResumed.dependencies[0].taskId, mergeQueueTask.id, 'resume preserves dependency ordering');
  dependentReady = await adminRequest(`/api/workbench/tasks/${dependentIntegrationTask.id}/integration/ready`, {});
  assert.equal(dependentReady.canMerge, false);

  mergeQueueGit(['add', '--', 'base.txt']); mergeQueueGit(['commit', '-m', 'parallel integration change']);
  integrationQueue = await adminRequest(`/api/workbench/integration?workspaceId=${integrationWorkspaceRecord.id}`);
  mergeQueueView = integrationQueue.tasks.find(item => item.taskId === mergeQueueTask.id);
  assert.equal(mergeQueueView.commitsAhead, 1);
  await policy(mergeQueueTask.id, 'full', false);
  const integrationRuntimeProcess = await adminRequest(`/api/workbench/tasks/${mergeQueueTask.id}/processes`, {
    command: 'node -e "setTimeout(()=>{},10000)"',
    yield_time_ms: 0,
  });
  assert.ok(integrationRuntimeProcess.id, 'parallel task owns its background process');
  let integrationRuntime = await adminRequest(`/api/workbench/tasks/${mergeQueueTask.id}/runtime`);
  assert.equal(integrationRuntime.status, 'running');
  assert.equal(integrationRuntime.running, 1);
  assert.ok(integrationRuntime.processes.some(process => process.id === integrationRuntimeProcess.id && process.running));
  integrationQueue = await adminRequest(`/api/workbench/integration?workspaceId=${integrationWorkspaceRecord.id}`);
  mergeQueueView = integrationQueue.tasks.find(item => item.taskId === mergeQueueTask.id);
  assert.equal(mergeQueueView.runningProcesses, 1, 'Integration Queue sees task-owned background processes');
  assert.equal(mergeQueueView.canMarkReady, false, 'running task processes block integration readiness');
  assert.match(mergeQueueView.reason, /background process.*running/i);
  assert.match(JSON.stringify(await adminRequest(`/api/workbench/tasks/${mergeQueueTask.id}/integration/ready`, {}, 'POST', 400)), /INTEGRATION_NOT_READY|background process/i);
  const stoppedRuntime = await adminRequest(`/api/workbench/tasks/${mergeQueueTask.id}/processes/stop-all`, { force: true });
  assert.deepEqual(stoppedRuntime.remaining, []);
  assert.ok(stoppedRuntime.stopped.includes(integrationRuntimeProcess.id));
  integrationRuntime = await adminRequest(`/api/workbench/tasks/${mergeQueueTask.id}/runtime`);
  assert.equal(integrationRuntime.status, 'idle');
  assert.equal(integrationRuntime.running, 0);
  const integrationPreview = await adminRequest(`/api/workbench/tasks/${mergeQueueTask.id}/preview/start`, { command: autoPreviewCommand });
  assert.ok(integrationPreview.port, 'integration task receives an automatic preview port');
  integrationQueue = await adminRequest(`/api/workbench/integration?workspaceId=${integrationWorkspaceRecord.id}`);
  mergeQueueView = integrationQueue.tasks.find(item => item.taskId === mergeQueueTask.id);
  assert.equal(mergeQueueView.previewRunning, true, 'Integration Queue sees a running task preview');
  assert.equal(mergeQueueView.previewLeased, true, 'Integration Queue sees the preview lease');
  assert.equal(mergeQueueView.previewPort, integrationPreview.port);
  assert.equal(mergeQueueView.canMarkReady, false, 'preview runtime blocks integration readiness');
  assert.match(JSON.stringify(await adminRequest(`/api/workbench/tasks/${mergeQueueTask.id}/integration/ready`, {}, 'POST', 400)), /INTEGRATION_NOT_READY|background process|Preview port/i);
  await adminRequest(`/api/workbench/tasks/${mergeQueueTask.id}/preview/stop`, {});
  integrationQueue = await adminRequest(`/api/workbench/integration?workspaceId=${integrationWorkspaceRecord.id}`);
  mergeQueueView = integrationQueue.tasks.find(item => item.taskId === mergeQueueTask.id);
  assert.equal(mergeQueueView.previewLeased, false, 'stopping Preview releases the integration gate');
  assert.equal(mergeQueueView.canMarkReady, true);
  const readyIntegration = await adminRequest(`/api/workbench/tasks/${mergeQueueTask.id}/integration/ready`, {});
  assert.equal(readyIntegration.lifecycle, 'ready_to_merge');
  assert.equal(readyIntegration.canMerge, true);
  assert.match(JSON.stringify(await adminRequest(`/api/workbench/tasks/${mergeQueueTask.id}/file`, { path: 'base.txt', content: 'review invalidated\n' }, 'PUT', 400)), /TASK_INTEGRATION_LOCKED/, 'ready task rejects file mutations until work is resumed');
  const mergedIntegration = await adminRequest(`/api/workbench/tasks/${mergeQueueTask.id}/integration/merge`, {});
  assert.equal(mergedIntegration.lifecycle, 'merged');
  assert.equal(mergedIntegration.targetBranch, integrationTargetBranch);
  assert.ok(mergedIntegration.mergedCommit);
  assert.equal(mergedIntegration.cleanupStatus, 'completed', 'successful local merge cleans the managed worktree and branch');
  assert.equal(mergedIntegration.worktreePresent, false);
  assert.equal(mergedIntegration.canRetryCleanup, false);
  await assert.rejects(fs.stat(mergeQueueTask.execution.path), undefined, 'managed worktree directory is removed after merge');
  assert.throws(() => integrationGit(['show-ref', '--verify', `refs/heads/${mergeQueueTask.execution.branch}`]), 'merged managed branch is deleted only after safe ancestor verification');
  assert.equal((await fs.readFile(path.join(integrationWorkspacePath, 'base.txt'), 'utf8')).replace(/\r\n/g, '\n'), 'merged by queue\n');
  assert.equal(integrationGit(['status', '--porcelain']), '', 'target checkout remains clean after local integration');
  await fs.mkdir(mergeQueueTask.execution.path, { recursive: true });
  await fs.writeFile(path.join(mergeQueueTask.execution.path, 'orphan-marker.txt'), 'orphan after git unregister\n');
  assert.ok(!integrationGit(['worktree', 'list', '--porcelain']).replace(/\\/g, '/').includes(mergeQueueTask.execution.path.replace(/\\/g, '/')), 'Git no longer registers the recreated orphan directory');
  const orphanCleanupRetry = await adminRequest(`/api/workbench/tasks/${mergeQueueTask.id}/integration/cleanup`, {});
  assert.equal(orphanCleanupRetry.cleanupStatus, 'completed', 'cleanup safely removes an orphan physical directory at the exact managed task path');
  await assert.rejects(fs.stat(mergeQueueTask.execution.path));
  const cleanupRetry = await adminRequest(`/api/workbench/tasks/${mergeQueueTask.id}/integration/cleanup`, {});
  assert.equal(cleanupRetry.cleanupStatus, 'completed', 'cleanup retry remains idempotent after orphan recovery');
  const finishedPrerequisite = await adminRequest(`/api/workbench/tasks/${mergeQueueTask.id}/integration/finish`, {});
  assert.equal(finishedPrerequisite.status, 'finished');
  assert.equal(finishedPrerequisite.lifecycle, 'completed', 'a merged and cleaned task can be closed as finished');
  assert.equal(finishedPrerequisite.cleanupStatus, 'completed');

  integrationQueue = await adminRequest(`/api/workbench/integration?workspaceId=${integrationWorkspaceRecord.id}`);
  assert.equal(integrationQueue.tasks.some(item => item.taskId === mergeQueueTask.id), false, 'finished prerequisite leaves the active Integration Queue');
  const dependentAfterPrerequisite = integrationQueue.tasks.find(item => item.taskId === dependentIntegrationTask.id);
  assert.equal(dependentAfterPrerequisite.dependencies[0].satisfied, true, 'finished merged prerequisite remains a satisfied dependency');
  assert.equal(dependentAfterPrerequisite.dependencies[0].lifecycle, 'completed');
  assert.deepEqual(dependentAfterPrerequisite.unresolvedDependencyIds, []);
  assert.equal(dependentAfterPrerequisite.canMerge, true, 'ready dependent task re-preflights against the updated target and becomes mergeable');
  const dependentFinished = await adminRequest(`/api/workbench/tasks/${dependentIntegrationTask.id}/integration/finish`, {});
  assert.equal(dependentFinished.status, 'finished', 'Integrate & Finish merges a reviewed ready task and closes it in one action');
  assert.equal(dependentFinished.lifecycle, 'completed');
  assert.equal(dependentFinished.cleanupStatus, 'completed');
  await assert.rejects(fs.stat(dependentIntegrationTask.execution.path));
  assert.throws(() => integrationGit(['show-ref', '--verify', `refs/heads/${dependentIntegrationTask.execution.branch}`]));
  assert.equal((await fs.readFile(path.join(integrationWorkspacePath, 'dependent.txt'), 'utf8')).replace(/\r\n/g, '\n'), 'depends on merge queue task\n');

  const mergedWorkbenchState = await adminRequest('/api/workbench');
  assert.equal(mergedWorkbenchState.tasks.find(item => item.id === mergeQueueTask.id)?.lifecycle, 'completed');
  assert.ok(mergedWorkbenchState.tasks.find(item => item.id === mergeQueueTask.id)?.integration?.finishedAt);
  assert.equal(mergedWorkbenchState.tasks.find(item => item.id === dependentIntegrationTask.id)?.lifecycle, 'completed');
  assert.ok(mergedWorkbenchState.tasks.find(item => item.id === dependentIntegrationTask.id)?.integration?.finishedAt);
  integrationQueue = await adminRequest(`/api/workbench/integration?workspaceId=${integrationWorkspaceRecord.id}`);
  assert.equal(integrationQueue.summary.merged, 0);
  assert.equal(integrationQueue.tasks.some(item => [mergeQueueTask.id, dependentIntegrationTask.id].includes(item.taskId)), false, 'finished tasks no longer occupy the active merge queue');

  const discardTask = await adminRequest('/api/workbench/tasks', {
    title: 'Discard dirty task',
    workspaceId: integrationWorkspaceRecord.id,
    environment: { mode: 'worktree', startingRef: 'HEAD' },
    kind: 'parallel',
  });
  const discardGuardTask = await adminRequest('/api/workbench/tasks', {
    title: 'Discard dependency guard',
    workspaceId: integrationWorkspaceRecord.id,
    environment: { mode: 'worktree', startingRef: 'HEAD' },
    kind: 'parallel',
  });
  await adminRequest(`/api/workbench/tasks/${discardGuardTask.id}/integration/dependencies`, { taskIds: [discardTask.id] }, 'PUT');
  assert.match(JSON.stringify(await adminRequest(`/api/workbench/tasks/${discardTask.id}/integration/discard`, {}, 'POST', 400)), /TASK_DISCARD_DEPENDENCY/, 'discard refuses to destroy a task still required by active work');
  await fs.stat(discardTask.execution.path);
  await adminRequest(`/api/workbench/tasks/${discardGuardTask.id}/integration/dependencies`, { taskIds: [] }, 'PUT');
  const discardedGuard = await adminRequest(`/api/workbench/tasks/${discardGuardTask.id}/integration/discard`, {});
  assert.equal(discardedGuard.status, 'discarded');
  assert.equal(discardedGuard.lifecycle, 'archived');
  await assert.rejects(fs.stat(discardGuardTask.execution.path));
  assert.throws(() => integrationGit(['show-ref', '--verify', `refs/heads/${discardGuardTask.execution.branch}`]));

  const discardTargetHead = integrationGit(['rev-parse', 'HEAD']);
  await fs.writeFile(path.join(discardTask.execution.path, 'discard-only.txt'), 'must never reach target\n');
  await policy(discardTask.id, 'full', false);
  const discardRuntimeProcess = await adminRequest(`/api/workbench/tasks/${discardTask.id}/processes`, {
    command: 'node -e "setTimeout(()=>{},10000)"',
    yield_time_ms: 0,
  });
  assert.ok(discardRuntimeProcess.id);
  const discardPreview = await adminRequest(`/api/workbench/tasks/${discardTask.id}/preview/start`, { command: autoPreviewCommand });
  assert.ok(discardPreview.port, 'discard fixture owns a preview lease');
  await policy(discardTask.id, 'ask', false);
  const discardPendingResponse = await adminRequest(`/api/workbench/tasks/${discardTask.id}/file`, { path: 'pending-discard.txt', content: 'must never execute\n' }, 'PUT');
  const discardPending = JSON.parse(discardPendingResponse.content[0].text);
  assert.equal(discardPending.status, 'approval_required');
  const discarded = await adminRequest(`/api/workbench/tasks/${discardTask.id}/integration/discard`, {});
  assert.equal(discarded.status, 'discarded');
  assert.equal(discarded.lifecycle, 'archived');
  await assert.rejects(fs.stat(discardTask.execution.path), undefined, 'discard removes even a dirty task-owned worktree');
  assert.throws(() => integrationGit(['show-ref', '--verify', `refs/heads/${discardTask.execution.branch}`]), 'discard deletes only the managed local-coder branch');
  assert.equal(integrationGit(['rev-parse', 'HEAD']), discardTargetHead, 'discard never changes target HEAD');
  assert.equal(integrationGit(['status', '--porcelain']), '', 'discard leaves the target checkout clean');
  await assert.rejects(fs.stat(path.join(integrationWorkspacePath, 'discard-only.txt')));
  await assert.rejects(fs.stat(path.join(integrationWorkspacePath, 'pending-discard.txt')));
  const discardedRuntime = await adminRequest(`/api/workbench/tasks/${discardTask.id}/runtime`);
  assert.equal(discardedRuntime.running, 0, 'discard stops task-owned background processes before deleting the worktree');
  const interruptedDiscardOperation = await adminRequest(`/api/workbench/operations/${discardPending.operation_id}`);
  assert.equal(interruptedDiscardOperation.status, 'interrupted', 'discard invalidates pending approvals tied to the deleted worktree');
  assert.match(JSON.stringify(await adminRequest(`/api/workbench/operations/${discardPending.operation_id}/decision`, { approve: true }, 'POST', 410)), /APPROVAL_GONE/);
  const discardedWorkbenchState = await adminRequest('/api/workbench');
  assert.equal(discardedWorkbenchState.tasks.find(item => item.id === discardTask.id)?.lifecycle, 'archived');
  assert.ok(discardedWorkbenchState.tasks.find(item => item.id === discardTask.id)?.integration?.discardedAt);
  assert.equal(discardedWorkbenchState.portLeases.some(lease => lease.taskId === discardTask.id), false, 'Discard releases the task preview lease after stopping its process tree');
  integrationQueue = await adminRequest(`/api/workbench/integration?workspaceId=${integrationWorkspaceRecord.id}`);
  assert.equal(integrationQueue.tasks.some(item => [discardTask.id, discardGuardTask.id].includes(item.taskId)), false, 'discarded tasks disappear from Integration Queue');

  const blockedIntegrationTask = await adminRequest('/api/workbench/tasks', {
    title: 'Blocked merge task',
    workspaceId: integrationWorkspaceRecord.id,
    environment: { mode: 'worktree', startingRef: 'HEAD' },
    kind: 'parallel',
  });
  const blockedGit = args => execFileSync('git', args, { cwd: blockedIntegrationTask.execution.path, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  await fs.writeFile(path.join(blockedIntegrationTask.execution.path, 'base.txt'), 'task side conflict\n');
  blockedGit(['add', '--', 'base.txt']); blockedGit(['commit', '-m', 'task conflict side']);
  await fs.writeFile(path.join(integrationWorkspacePath, 'base.txt'), 'target side conflict\n');
  integrationGit(['add', '--', 'base.txt']); integrationGit(['commit', '-m', 'target conflict side']);
  const blockedIntegration = await adminRequest(`/api/workbench/tasks/${blockedIntegrationTask.id}/integration/ready`, {});
  assert.equal(blockedIntegration.lifecycle, 'blocked');
  assert.ok(blockedIntegration.conflictPaths.includes('base.txt'), `expected base.txt conflict, got ${JSON.stringify(blockedIntegration.conflictPaths)}`);
  assert.equal(blockedIntegration.canResume, true);
  assert.match(blockedIntegration.reason, /conflict/i);
  const reopenedIntegration = await adminRequest(`/api/workbench/tasks/${blockedIntegrationTask.id}/integration/reopen`, {});
  assert.equal(reopenedIntegration.lifecycle, 'open');

  const closedSessionDiscard = await adminRequest(`/api/workbench/tasks/${conflictTask.id}/integration/discard`, {});
  assert.equal(closedSessionDiscard.lifecycle, 'archived', 'an active ChatGPT task can be explicitly discarded by the user');
  const closedSessionReply = await rpcEnvelopeWithSession(conflictSid, 'tools/call', { name: 'workbench', arguments: {} });
  assert.match(
    JSON.stringify(closedSessionReply.json || closedSessionReply.raw),
    /AGENT_TASK_CLOSED|discarded|will not be rebound automatically/i,
    'a session pinned to a discarded task is never silently rebound to another runnable task',
  );
  console.log('OK Integration Queue finishes merged work, discards task-owned worktrees safely, preserves dependencies and reports real merge conflicts');

  await fetch(base + '/mcp', { method: 'DELETE', headers: { Authorization: 'Bearer workbench-test-mcp', 'mcp-session-id': assignmentSid, 'mcp-protocol-version': '2025-03-26' } });
  await fetch(base + '/mcp', { method: 'DELETE', headers: { Authorization: 'Bearer workbench-test-mcp', 'mcp-session-id': conflictSid, 'mcp-protocol-version': '2025-03-26' } });
  sid = sidBeforeAssignment;
  assert.equal(payload(await call('workbench')).task.id, task.id, 'existing session remains pinned after another agent claims a task');
  console.log('OK managed parallel task uses a branch worktree and deterministic ChatGPT assignment');

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
  await policy(secondTask.id, 'full', false);
  const restartPreview = await adminRequest(`/api/workbench/tasks/${secondTask.id}/preview/start`, { command: autoPreviewCommand });
  assert.ok(restartPreview.port, 'restart fixture persists a live preview lease');
  const beforePreviewRestart = await adminRequest('/api/workbench');
  assert.ok(beforePreviewRestart.portLeases.some(lease => lease.taskId === secondTask.id && lease.port === restartPreview.port));
  await adminRequest(`/api/workbench/tasks/${secondTask.id}/select`, {});
  await stop();
  const legacyStatePath = path.join(env.WORKBENCH_PATH, 'state.json');
  const legacyState = JSON.parse(await fs.readFile(legacyStatePath, 'utf8'));
  const legacyPermissionOperation = legacyState.operations.find(operation => operation.id === request.operation_id);
  assert.ok(legacyPermissionOperation?.permission, 'restart fixture has a persisted permission decision to migrate');
  delete legacyPermissionOperation.permission.riskLevel;
  delete legacyPermissionOperation.permission.reasonCode;
  await fs.writeFile(legacyStatePath, JSON.stringify(legacyState, null, 2));
  sid = undefined; await start();
  sid = preRestartSid;
  assert.equal(payload(await call('workbench')).task.id, task.id, 'Recovered session retains its original task across restart');
  sid = backendSid;
  assert.equal(payload(await call('workbench')).task.id, dataTask.id,
    'a chat explicitly switched to another worktree retains its new task after server restart');
  assert.match(text(await call('read_text_file', { path: 'data-only.txt' })), /DATA_TASK_WORKTREE_ONLY/,
    'recovered switched chat reads from its destination worktree, not its previous one');
  sid = preRestartSid;
  const afterPreviewRestart = await adminRequest('/api/workbench');
  assert.equal(afterPreviewRestart.portLeases.some(lease => lease.taskId === secondTask.id), false, 'restart reconciles a stale preview lease after managed processes shut down');
  const restartedPreviewStatus = await adminRequest(`/api/workbench/tasks/${secondTask.id}/preview`);
  assert.equal(restartedPreviewStatus.running, false);
  assert.equal(restartedPreviewStatus.leased, false);
  await adminRequest(`/api/workbench/tasks/${task.id}/select`, {});
  const recovered = await adminRequest(`/api/workbench/operations/${interrupted.operation_id}`);
  assert.equal(recovered.status, 'interrupted');
  await assert.rejects(fs.stat(path.join(workspace, 'restart.txt')));
  op = await adminRequest(`/api/workbench/operations/${request.operation_id}`);
  assert.equal(op.changes.length, 1);
  assert.equal(op.permission.riskLevel, 'low', 'restart migrates legacy persisted permission risk metadata');
  assert.ok(op.permission.reasonCode, 'restart migrates legacy persisted permission reason codes');
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
} catch (error) { testFailure = error; console.error(logs.slice(-5000)); throw error; }
finally {
  await stop();
  const resolved = path.resolve(tmp);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('local-workbench-test-')) throw new Error('Unsafe test cleanup path');
  try {
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 });
  } catch (cleanupError) {
    if (!testFailure) throw cleanupError;
    console.error('Test cleanup also failed:', cleanupError);
  }
}
