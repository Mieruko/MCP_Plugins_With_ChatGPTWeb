import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadSkillCatalog, listSkills, readSkill, formatSkillsForInstructions } from '../dist/lib/skills-loader.js';
import { executionContext } from '../dist/lib/workbench-context.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-skills-test-'));
const workspace = path.join(tmp, 'project-a');
const second = path.join(tmp, 'project-b');
const control = path.join(tmp, 'control');
const oldControl = process.env.WORKBENCH_PATH;
process.env.WORKBENCH_PATH = control;
let server, logs = '';
const put = async (file, content) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content); };
const skill = (name, body = 'BODY_ONLY_MARKER', description = 'Review this project.') =>
  '---\nname: ' + name + '\ndescription: "' + description + '"\n---\n' + body + '\n';
const location = (base, folder, source = '.agents') => path.join(base, source, 'skills', folder, 'SKILL.md');
const scoped = (base, fn, workspaceOnly = true) => executionContext.run({
  taskId: 'fixture-task', operationId: 'fixture-read', workspace: base, workspaceOnly,
  capture: async () => { throw new Error('read must not capture edits'); },
}, fn);
const code = expected => error => error?.code === expected;
const freePort = async () => {
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
};

try {
  await fs.mkdir(workspace);
  await fs.mkdir(second);
  let catalog = await scoped(workspace, () => loadSkillCatalog(workspace));
  assert.equal(catalog.complete, true);
  assert.equal(catalog.skills.length, 0);
  await assert.rejects(readSkill(catalog, { id: 'agents:absent' }), code('SKILL_NOT_FOUND'));

  await put(location(workspace, 'alpha'), '\uFEFF---\r\nname: alpha\r\ndescription: >-\r\n  Quoted and folded\r\n  review description.\r\nmetadata:\r\n  origin: "fixture" # comment\r\n  source_revision: "abc123"\r\n---\r\nBODY_ONLY_MARKER\r\n');
  await put(location(workspace, 'category/beta'), skill('beta'));
  await put(location(workspace, 'alpha', '.claude'), skill('alpha', 'CLAUDE_BODY'));
  for (let i = 0; i < 23; i++) await put(location(workspace, 'page-' + String(i).padStart(2, '0')), skill('page-' + i));
  catalog = await scoped(workspace, () => loadSkillCatalog(workspace));
  assert.equal(catalog.skills.length, 26, 'catalog does not silently stop at the old 20-skill limit');
  assert.equal(catalog.complete, true);
  assert.equal(catalog.skills[0].description, 'Quoted and folded review description.');
  assert.equal(catalog.skills[0].origin, 'fixture');
  assert.ok(catalog.skills.some(s => s.id === 'agents:category/beta'));
  assert.ok(catalog.skills.some(s => s.id === 'claude:alpha'));
  assert.ok(catalog.diagnostics.some(d => d.code === 'SKILL_DUPLICATE_NAME'));
  assert.equal(catalog.revision, (await loadSkillCatalog(workspace)).revision);
  const firstPage = listSkills(catalog, { limit: 7 });
  let page = firstPage, ids = [];
  while (true) {
    ids.push(...page.skills.map(s => s.id));
    if (!page.next_cursor) break;
    page = listSkills(catalog, { limit: 7, cursor: page.next_cursor });
  }
  assert.deepEqual(ids, catalog.skills.map(s => s.id));
  assert.equal(listSkills(catalog, { query: '  FOLDED  ' }).total, 1);
  assert.throws(() => listSkills(catalog, { cursor: 'broken' }), code('SKILL_INVALID_CURSOR'));
  assert.throws(() => listSkills(catalog, { cursor: firstPage.next_cursor, query: 'different' }), code('SKILL_CATALOG_CHANGED'));
  const instructions = formatSkillsForInstructions(catalog);
  assert.equal(instructions.split('\n').filter(l => l.startsWith('- ')).length, 12);
  assert.ok(!instructions.includes('BODY_ONLY_MARKER'));
  console.log('OK YAML, namespaced duplicates, complete pagination, filtering and bounded initialization');

  const malformed = path.join(tmp, 'malformed');
  const invalid = [
    'name: missing-frontmatter',
    '---\nname: bad\nname: duplicate\ndescription: test\n---\n',
    '---\nname: 12\ndescription: test\n---\n',
    '---\nname: "Bad Name"\ndescription: test\n---\n',
    '---\nname: bad\ndescription: [list]\n---\n',
    '---\nname: bad\ndescription: &desc test\nmetadata:\n  origin: *desc\n---\n',
    '---\nname: bad\ndescription: !custom test\n---\n',
    '---\nname: bad\ndescription: "' + '\u0111'.repeat(4200) + '"\n---\n',
    Buffer.from([0xff, 0xfe, 0xff]), Buffer.from([0]),
    skill('large', 'x'.repeat(65536)),
  ];
  for (let i = 0; i < invalid.length; i++) await put(location(malformed, 'bad-' + i), invalid[i]);
  const badCatalog = await loadSkillCatalog(malformed);
  assert.equal(badCatalog.skills.length, 0);
  assert.equal(badCatalog.complete, false);
  assert.equal(badCatalog.diagnostics.length, invalid.length);
  await assert.rejects(readSkill(badCatalog, { id: 'agents:missing' }), code('SKILL_CATALOG_INCOMPLETE'));
  console.log('OK malformed YAML, alias/tag rejection, UTF-8 and byte limits with diagnostics');

  const content = skill('long', '[Guide](references/guide.md)\n[Missing](missing.md)\n[Escape](../secret.md)\n[Web](https://example.invalid)\n' + 'Vi\u1ec7t \ud83c\udf3f\n'.repeat(2200));
  await put(location(workspace, 'long'), content);
  const guideFile = path.join(workspace, '.agents/skills/long/references/guide.md');
  await put(guideFile, 'Guide content.\n' + 'More guidance.\n'.repeat(100));
  catalog = await loadSkillCatalog(workspace);
  let chunk = await readSkill(catalog, { id: 'agents:long', max_chars: 501 });
  assert.equal(chunk.truncated, true);
  assert.ok(chunk.references.some(r => r.path === 'references/guide.md' && r.available));
  assert.ok(chunk.references.some(r => r.path === 'missing.md' && !r.available));
  assert.ok(chunk.references.some(r => r.path === '../secret.md' && r.code === 'SKILL_PATH_DENIED'));
  assert.ok(!chunk.references.some(r => r.path.includes('https:')));
  let combined = chunk.content;
  while (chunk.next_offset !== null) {
    chunk = await readSkill(catalog, { id: 'agents:long', max_chars: 501, offset: chunk.next_offset, expected_sha256: chunk.sha256 });
    combined += chunk.content;
  }
  assert.equal(combined, content, 'chunking preserves Unicode and complete content');
  await assert.rejects(readSkill(catalog, { id: 'agents:long', offset: 10 }), code('SKILL_HASH_REQUIRED'));
  const guide = await readSkill(catalog, { id: 'agents:long', reference: 'references/guide.md', max_chars: 500 });
  await fs.appendFile(guideFile, 'Changed.');
  await assert.rejects(readSkill(catalog, { id: 'agents:long', reference: 'references/guide.md',
    offset: guide.next_offset, expected_sha256: guide.sha256 }), code('SKILL_CHANGED'));
  await fs.appendFile(location(workspace, 'long'), 'Changed.');
  await assert.rejects(readSkill(catalog, { id: 'agents:long' }), code('SKILL_CHANGED'));
  const refreshed = await loadSkillCatalog(workspace);
  assert.throws(() => listSkills(refreshed, { cursor: listSkills(catalog, { limit: 1 }).next_cursor }), code('SKILL_CATALOG_CHANGED'));
  await assert.rejects(readSkill(refreshed, { id: 'agents:long', expected_revision: catalog.revision }), code('SKILL_CATALOG_CHANGED'));
  console.log('OK content continuation, reference hints and changed-document/catalog detection');

  const outside = path.join(tmp, 'outside');
  await put(path.join(outside, 'secret.md'), 'OUTSIDE_SECRET');
  await put(path.join(outside, 'SKILL.md'), skill('external', 'OUTSIDE_SKILL_SECRET'));
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await fs.symlink(outside, path.join(workspace, '.agents/skills/linked'), linkType);
  await fs.symlink(outside, path.join(workspace, '.agents/skills/long/linked'), linkType);
  await fs.link(path.join(outside, 'secret.md'), path.join(workspace, '.agents/skills/long/hard.md'));
  const parentLinked = path.join(tmp, 'parent-linked');
  await fs.mkdir(parentLinked);
  await fs.symlink(outside, path.join(parentLinked, '.agents'), linkType);
  assert.equal((await loadSkillCatalog(parentLinked)).complete, false);
  catalog = await loadSkillCatalog(workspace);
  assert.ok(catalog.diagnostics.some(d => d.code === 'SKILL_PATH_DENIED'));
  for (const workspaceOnly of [true, false]) {
    await scoped(workspace, async () => {
      for (const reference of ['../alpha/SKILL.md', '../../../secret.md', '/secret.md', 'C:/secret.md', '..\\secret.md', 'linked/secret.md', 'hard.md']) {
        await assert.rejects(readSkill(catalog, { id: 'agents:long', reference }));
      }
    }, workspaceOnly);
  }
  const protectedFile = path.join(workspace, '.agents/skills/long/control/secret.md');
  await put(protectedFile, 'CONTROL_SECRET');
  process.env.WORKBENCH_PATH = path.dirname(protectedFile);
  await scoped(workspace, () => assert.rejects(readSkill(catalog, { id: 'agents:long', reference: 'control/secret.md' })));
  process.env.WORKBENCH_PATH = control;
  assert.ok(!JSON.stringify(catalog).includes('OUTSIDE_SKILL_SECRET'));
  console.log('OK traversal, junctions, hard links and control-state protection in workspace-only and Full scopes');

  const limited = path.join(tmp, 'limited');
  for (let i = 0; i < 513; i++) await put(location(limited, 's-' + String(i).padStart(3, '0')), skill('s-' + i));
  const capped = await loadSkillCatalog(limited);
  assert.equal(capped.skills.length, 512);
  assert.equal(capped.complete, false);
  assert.ok(capped.diagnostics.some(d => d.code === 'SKILL_SCAN_LIMIT'));
  const deep = path.join(tmp, 'deep');
  await put(location(deep, 'a/b/c/d/e'), skill('deep'));
  assert.equal((await loadSkillCatalog(deep)).complete, false);
  for (let i = 0; i < 105; i++) await put(location(deep, 'bad-' + i), 'invalid');
  const diagnostics = await loadSkillCatalog(deep);
  assert.equal(diagnostics.diagnostics.length, 100);
  assert.equal(diagnostics.diagnostics_truncated, true);
  console.log('OK bounded catalogs, depth and diagnostics');

  // Use distinct descriptions to detect initialization and live-read cross-task leakage.
  const httpA = path.join(tmp, 'http-a');
  await put(location(httpA, 'only-a'), skill('only-a', 'A_BODY_SECRET', 'A_DESCRIPTION_MARKER'));
  await put(location(second, 'only-b'), skill('only-b', 'B_BODY_SECRET', 'B_DESCRIPTION_MARKER'));
  await put(path.join(tmp, 'upstream.json'), '{"version":1,"servers":[]}');
  const port = await freePort();
  let adminPort = await freePort();
  while (adminPort === port) adminPort = await freePort();
  const base = 'http://127.0.0.1:' + port, admin = 'http://127.0.0.1:' + adminPort;
  server = spawn(process.execPath, [path.join(root, 'dist/index.js')], {
    cwd: tmp, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), ADMIN_PORT: String(adminPort), ADMIN_TOKEN: 'skills-admin', MCP_AUTH_TOKEN: 'skills-mcp',
      WORKBENCH_PATH: control, WORKBENCH_DEFAULT_MODE: 'ask', WORKBENCH_EXPERIENCE: 'advanced', WORKBENCH_SANDBOX_PROVIDER: 'none',
      WORKSPACE_PATH: httpA, WORKSPACE_PATHS: '', EXTRA_WORKSPACE_PATHS: '', ALLOWED_WORKSPACE_PATHS: '',
      MCP_UPSTREAM_CONFIG: path.join(tmp, 'upstream.json'), AUDIT_LOG_PATH: path.join(tmp, 'audit.log'),
      CHECKPOINT_PATH: path.join(tmp, 'checkpoints'), CODEX_HOME: path.join(tmp, 'codex'),
      MCP_SHELL_STATE_DIR: path.join(tmp, 'shell'), CHATGPT_TOOL_PROFILE: 'slim' },
  });
  server.stdout.on('data', data => { logs += data; });
  server.stderr.on('data', data => { logs += data; });
  server.on('error', error => { logs += error.message; });
  let ready = false, seq = 0;
  for (let i = 0; i < 100; i++) {
    try { const response = await fetch(base + '/health', { signal: AbortSignal.timeout(500) }); await response.text(); if (response.ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, logs);
  const headers = sid => ({ Authorization: 'Bearer skills-mcp', 'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) });
  async function rpc(sid, method, params) {
    const res = await fetch(base + '/mcp', { method: 'POST', headers: headers(sid),
      body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params }), signal: AbortSignal.timeout(10000) });
    const json = await res.json();
    assert.equal(res.status, 200, JSON.stringify(json));
    assert.ok(!json.error, JSON.stringify(json));
    return { result: json.result, sid: res.headers.get('mcp-session-id') };
  }
  async function init() {
    const initialized = await rpc(null, 'initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'skills-test', version: '1' } });
    const res = await fetch(base + '/mcp', { method: 'POST', headers: headers(initialized.sid),
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), signal: AbortSignal.timeout(5000) });
    await res.text();
    assert.equal(res.status, 202);
    return initialized;
  }
  async function call(sid, name, args = {}, expectedOk = true) {
    const { result } = await rpc(sid, 'tools/call', { name, arguments: args });
    const data = result.structuredContent ?? JSON.parse(result.content[0].text);
    if (expectedOk) { assert.ok(!result.isError, JSON.stringify(result)); assert.notEqual(data.ok, false, JSON.stringify(data)); }
    return data;
  }
  async function adminRequest(url, body, method = 'POST') {
    const res = await fetch(admin + url, { method: body === undefined ? 'GET' : method,
      headers: { Authorization: 'Bearer skills-admin', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
    const json = await res.json();
    assert.equal(res.status, 200, JSON.stringify(json));
    return json.data ?? json;
  }
  const a = await init();
  assert.ok(a.result.instructions.includes('A_DESCRIPTION_MARKER'));
  assert.ok(!a.result.instructions.includes('A_BODY_SECRET'));
  const listed = await rpc(a.sid, 'tools/list', {});
  assert.equal(listed.result.tools.find(t => t.name === 'skills')?.annotations?.readOnlyHint, true, 'skills exposed in slim');
  const taskA = (await call(a.sid, 'workbench')).task;
  assert.equal(taskA.policy.mode, 'ask');
  assert.equal(taskA.policy.workspaceOnly, true);
  assert.deepEqual((await call(a.sid, 'skills')).data.skills.map(s => s.id), ['agents:only-a']);
  assert.ok((await call(a.sid, 'skills', { action: 'read', id: 'agents:only-a' })).data.content.includes('A_BODY_SECRET'));
  const missingId = await call(a.sid, 'skills', { action: 'read' }, false);
  assert.equal(missingId.ok, false);
  assert.equal(missingId.data.code, 'SKILL_ID_REQUIRED');
  const wsB = await adminRequest('/api/workbench/workspaces', { name: 'B', path: second });
  const taskB = await adminRequest('/api/workbench/tasks', { title: 'B', workspaceId: wsB.id });
  await adminRequest('/api/workbench/tasks/' + taskB.id + '/select', {});
  const b = await init();
  assert.ok(b.result.instructions.includes('B_DESCRIPTION_MARKER'));
  assert.ok(!b.result.instructions.includes('A_DESCRIPTION_MARKER'));
  const both = await Promise.all([call(a.sid, 'skills'), call(b.sid, 'skills')]);
  assert.deepEqual(both.map(x => x.data.skills[0].id), ['agents:only-a', 'agents:only-b']);
  const injected = await call(a.sid, 'skills', { workspace_root: second, workspace: second });
  assert.equal(injected.data.skills[0].id, 'agents:only-a');
  assert.equal((await call(b.sid, 'skills', { action: 'read', id: 'agents:only-a' }, false)).data.code, 'SKILL_NOT_FOUND');
  const escape = await call(a.sid, 'skills', { action: 'read', id: 'agents:only-a', reference: '../../../../outside/secret.md' }, false);
  assert.equal(escape.data.code, 'SKILL_PATH_DENIED');
  const state = await adminRequest('/api/workbench');
  assert.ok(!(state.operations ?? []).some(operation => operation.status === 'pending_approval'));
  console.log('OK real MCP slim registration, Ask/workspace-only reads and pinned concurrent task isolation');

  // An isolated task must discover the checked-out worktree, not its parent workspace.
  execFileSync('git', ['init'], { cwd: second, windowsHide: true, stdio: 'pipe' });
  execFileSync('git', ['add', '.'], { cwd: second, windowsHide: true, stdio: 'pipe' });
  execFileSync('git', ['-c', 'user.name=Skills Test', '-c', 'user.email=skills@example.invalid', 'commit', '-m', 'Fixture'], { cwd: second, windowsHide: true, stdio: 'pipe' });
  const isolated = await adminRequest('/api/workbench/tasks', { title: 'Isolated skills', workspaceId: wsB.id,
    environment: { mode: 'worktree', startingRef: 'HEAD' }, kind: 'parallel', assignNextChatgpt: true });
  assert.ok(isolated.execution.path && isolated.execution.path !== second, JSON.stringify(isolated));
  await put(location(isolated.execution.path, 'worktree-only'), skill('worktree-only', 'WORKTREE_BODY', 'WORKTREE_DESCRIPTION'));
  await adminRequest('/api/workbench/tasks/' + isolated.id + '/select', {});
  const c = await init();
  assert.ok(c.result.instructions.includes('WORKTREE_DESCRIPTION'));
  const treeSkills = (await call(c.sid, 'skills')).data;
  assert.equal(await fs.realpath(treeSkills.workspace), await fs.realpath(isolated.execution.path));
  assert.ok(treeSkills.skills.some(s => s.id === 'agents:worktree-only'));
  assert.ok(!(await call(b.sid, 'skills')).data.skills.some(s => s.id === 'agents:worktree-only'));
  console.log('OK isolated task skills use the actual worktree');

  const bundled = await loadSkillCatalog(root);
  for (const id of ['workbench-mcp-design', 'workbench-security-review', 'workbench-verify', 'workbench-research']) {
    const loaded = await readSkill(bundled, { id: 'agents:' + id });
    assert.equal(loaded.truncated, false);
    assert.ok(loaded.skill.origin && loaded.skill.source_revision);
  }
  console.log('OK four repository workflows load successfully');
} catch (error) {
  if (logs) console.error(logs.slice(-8000));
  throw error;
} finally {
  process.env.WORKBENCH_PATH = oldControl ?? '';
  if (oldControl === undefined) delete process.env.WORKBENCH_PATH;
  if (server && server.exitCode === null && server.signalCode === null) {
    const closed = new Promise(resolve => server.once('close', resolve));
    server.kill();
    await closed;
  }
  const resolved = path.resolve(tmp);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('workbench-skills-test-'));
  await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}