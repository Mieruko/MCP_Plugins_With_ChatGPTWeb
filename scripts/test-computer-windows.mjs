import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { executionContext } from '../dist/lib/workbench-context.js';
import { openComputerSession, ownedComputerSession, observeComputer, actComputer, closeComputerSession, computerSessionSummaries, recentComputerActionStatuses } from '../dist/lib/computer-use.js';
import { windowsEvidence, observationIdentity } from '../dist/lib/computer-observation.js';
import { windowsParseDiagnostics } from '../dist/lib/computer-observation.js';
import { registerComputerTools } from '../dist/tools/computer-use.js';

// Real protocol/catalog + injected snapshot/action responses: no user's desktop
// capture or input. Native UI behavior requires the separate native fixture.
const snapshot = (cursor = '(10, 20)', clock = '10:00', button = 'Click me') => `Cursor Position: ${cursor}
Active Desktop:
Name
---------
Desktop 1

All Desktops:
Name
---------
Desktop 1

Focused Window:
Name          Depth  Status      Width    Height    Handle
----------  -------  --------  -------  --------  --------
CU fixture        0  Normal        800       600     12345

Opened Windows:
Name              Depth  Status      Width    Height    Handle
--------------  -------  --------  -------  --------  --------
Other ${clock}          1  Normal        300       200     54321

UI Tree:
desktop
    ├── window "CU fixture"
    │   ├── (100,200) button "${button}"  [action: click]
    │   └── (100,250) edit "Description"  [action: fill]  [focused]
    └── window "Taskbar"
        └── (900,900) button "${clock}"  [action: click]`;
assert.equal(observationIdentity(snapshot(), false), observationIdentity(snapshot('(400, 500)', '10:01'), false));
assert.notEqual(observationIdentity(snapshot(), false), observationIdentity(snapshot().replace('12345', '98765'), false));
assert.notEqual(observationIdentity(snapshot(), false), observationIdentity(snapshot().replace('[focused]', ''), false));
assert.notEqual(observationIdentity(snapshot(), false), observationIdentity(snapshot().replace('(100,200)', '(110,200)'), false));
assert.equal(windowsEvidence(snapshot()).targets.length, 2, 'never expose background targets');
assert.equal(windowsEvidence(snapshot() + '\n... [truncated: reached capture limit]'), undefined);
assert.equal(windowsEvidence(snapshot().replace('CU fixture        0', 'Other app         0')), undefined);
assert.throws(() => observationIdentity('unknown format', false), /COMPUTER_OBSERVE_FORMAT/);
assert.equal(observationIdentity(JSON.stringify([snapshot()]), false), observationIdentity(snapshot(), false));
assert.equal(observationIdentity(JSON.stringify(snapshot()), false), observationIdentity(snapshot(), false));
assert.equal(observationIdentity(snapshot().replaceAll('\n', '\r\n'), false), observationIdentity(snapshot(), false));
for (const unknown of [JSON.stringify({ text: snapshot() }), JSON.stringify([snapshot(), snapshot()]), JSON.stringify([[snapshot()]]), '[broken']) {
  assert.equal(windowsEvidence(unknown), undefined, 'unknown/ambiguous envelopes fail closed');
}
assert.equal(process.platform, 'win32', 'Windows runtime test requires Windows');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.join(repo, '.computer-use-runtime/windows/Scripts/windows-mcp.exe');
await fs.access(executable);
const rendered = await promisify(execFile)(path.join(repo, '.computer-use-runtime/windows/Scripts/python.exe'),
  [path.join(repo, 'scripts/fixtures/windows-snapshot.py')], { windowsHide: true });
const actualFormat = JSON.parse(rendered.stdout);
assert.deepEqual(windowsEvidence(actualFormat)?.targets, windowsEvidence(snapshot()).targets, 'real pinned renderer target mapping');
assert.equal(observationIdentity(actualFormat, false), observationIdentity(actualFormat.replace('(10, 20)', '(99, 99)').replaceAll('10:00', '10:01'), false));
console.log('OK actual pinned Python snapshot renderer parsed without desktop capture');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cu-windows-catalog-'));
process.env.COMPUTER_USE_ENABLED = 'true';
process.env.COMPUTER_WINDOWS_ENABLED = 'true';
process.env.COMPUTER_WINDOWS_COMMAND = executable;
process.env.WORKBENCH_PATH = path.join(temp, 'control');
await executionContext.run({ taskId: 'windows-catalog-fixture', sessionId: 'catalog-owner', workspace: temp,
  workspaceOnly: false, operationId: 'catalog-only', capture: async () => {} }, async () => {
  let id;
  try {
    id = (await openComputerSession('windows', 'CU catalog fixture (never captured)')).session_id;
    const session = ownedComputerSession(id);
    const expected = { Snapshot: ['use_vision', 'use_ui_tree'], Screenshot: ['use_annotation'],
      Click: ['loc'], Type: ['loc', 'text', 'clear', 'press_enter'], Shortcut: ['shortcut'], Scroll: ['loc', 'direction', 'wheel_times'] };
    for (const [name, parameters] of Object.entries(expected)) {
      const schema = session.tools.get(name);
      assert.ok(schema, `Missing backend tool ${name}`);
      for (const parameter of parameters) assert.ok(parameter in schema, `${name} missing ${parameter}`);
    }
    await assert.rejects(openComputerSession('windows', 'Other fixture'), /COMPUTER_BUSY/);
    console.log('OK installed Windows backend handshake and all 6 UI schemas; duplicate controller refused');
    session.windowTitle = 'CU fixture';
    const realCall = session.client.callTool.bind(session.client);
    const fixtureTransport = new StdioClientTransport({ command: path.join(repo, '.computer-use-runtime/windows/Scripts/python.exe'),
      args: [path.join(repo, 'scripts/fixtures/windows-snapshot.py'), '--serve'], stderr: 'pipe' });
    fixtureTransport.stderr?.on('data', () => {});
    const fixtureClient = new Client({ name: 'windows-protocol-test', version: '1.0.0' });
    try {
      await fixtureClient.connect(fixtureTransport);
      session.client.callTool = fixtureClient.callTool.bind(fixtureClient);
      for (const image of [false, true]) {
        const response = await observeComputer(id, image);
        assert.ok(!response.isError);
        const obs = response.structuredContent.data;
        assert.equal(obs.windows_targets.length, 2);
        assert.match(obs.output, /\n\s*Focused Window:/, 'return readable text, not escaped JSON');
        assert.equal(response.content.some(c => c.type === 'image'), image, 'preserve native image');
        const action = await actComputer(id, obs.observation_id, { kind: 'key', key: 'tab' });
        assert.equal(action.structuredContent.data.completed, 1);
      }
      console.log('OK real FastMCP stdio: list[str] JSON and text+image snapshots observed and preflight accepted');
    } finally {
      session.client.callTool = realCall;
      await fixtureTransport.close();
    }
    let current = snapshot();
    const calls = [];
    session.client.callTool = async request => {
      calls.push(request);
      if (request.name === 'Snapshot') return { content: [{ type: 'text', text: current }] };
      assert.ok(['Click', 'Type', 'Shortcut', 'Scroll'].includes(request.name), 'no separate Screenshot that clears backend tree');
      return { content: [{ type: 'text', text: 'fixture acknowledged' }] };
    };
    try {
      for (const [action, name, args] of [
        [{ kind: 'click', label: 0 }, 'Click', { loc: [100, 200] }],
        [{ kind: 'type', label: 1, text: 'Tiếng Việt' }, 'Type', { loc: [100, 250], text: 'Tiếng Việt', clear: true, press_enter: false }],
        [{ kind: 'key', key: 'tab' }, 'Shortcut', { shortcut: 'tab' }],
        [{ kind: 'scroll', label: 1, direction: 'down' }, 'Scroll', { loc: [100, 250], direction: 'down', wheel_times: 1 }],
      ]) {
        current = snapshot();
        const obs = (await observeComputer(id, true)).structuredContent.data;
        assert.equal(obs.windows_targets.length, 2);
        assert.equal(calls.at(-1).arguments.use_vision, true);
        current = snapshot('(400, 500)', '10:01');
        const result = (await actComputer(id, obs.observation_id, action)).structuredContent.data;
        assert.equal(result.completed, 1);
        assert.equal(result.action_status, 'acknowledged');
        assert.equal(result.action_completed, null, 'backend acknowledgement is not UI verification');
        assert.ok(result.request_id);
        assert.deepEqual(calls.at(-1), { name, arguments: args });
        await assert.rejects(actComputer(id, obs.observation_id, action), /COMPUTER_STALE_OBSERVATION/);
      }
      for (const changed of [snapshot(undefined, undefined, 'Delete'), snapshot().replace('12345', '98765'),
        snapshot().replace('54321', '54322'),
        snapshot().replace('(100,200)', '(110,200)'), snapshot().replace('[focused]', ''),
        snapshot().replace('    │   └──', '    │   ├──').replace('    └── window "Taskbar"', '    │   └── window "Dialog"\n    └── window "Taskbar"')]) {
        current = snapshot();
        const obs = (await observeComputer(id, false)).structuredContent.data;
        current = changed;
        const count = calls.filter(c => c.name !== 'Snapshot').length;
        await assert.rejects(actComputer(id, obs.observation_id, { kind: 'click', label: 0 }), error => {
          assert.equal(error.code, changed.includes('98765') ? 'COMPUTER_WINDOW_CHANGED' : 'COMPUTER_UI_CHANGED');
          assert.equal(error.diagnostics.action_sent, false);
          if (error.code === 'COMPUTER_UI_CHANGED') assert.ok(error.diagnostics.changed_sections.length);
          assert.ok(!JSON.stringify(error.diagnostics).includes('Delete'), 'do not log control values');
          return true;
        });
        assert.equal(calls.filter(c => c.name !== 'Snapshot').length, count);
      }
      current = snapshot();
      let obs = (await observeComputer(id, false)).structuredContent.data;
      await assert.rejects(actComputer(id, obs.observation_id, { kind: 'click', label: 99 }), /COMPUTER_TARGET_NOT_FOUND/);
      await assert.rejects(actComputer(id, obs.observation_id, { kind: 'scroll', direction: 'down' }), /COMPUTER_TARGET_REQUIRED/);
      current = snapshot().replaceAll('CU fixture', 'CU fixture dialog');
      await assert.rejects(actComputer(id, obs.observation_id, { kind: 'key', key: 'tab' }), /COMPUTER_WINDOW_CHANGED/);
      const callsBeforeInvalidTarget = calls.length;
      await assert.rejects(actComputer(id, obs.observation_id, { kind: 'click', target: 'Mở project' }), error => {
        assert.equal(error.code, 'COMPUTER_TARGET_REQUIRED');
        assert.equal(error.diagnostics.required_field, 'action.label');
        return true;
      });
      assert.equal(calls.length, callsBeforeInvalidTarget, 'bad Windows target diagnosed before UI capture');
      current = snapshot().replace('12345', '98765');
      await assert.rejects(observeComputer(id, false), /COMPUTER_WINDOW_CHANGED/, 'same title with different handle cannot rebind on observe');
      const handlers = new Map();
      registerComputerTools({ registerTool(name, _config, handler) { handlers.set(name, handler); } });
      const errorResult = await handlers.get('computer_act')({ session_id: id, observation_id: obs.observation_id, action: { kind: 'click', target: 'Mở project' } });
      assert.equal(errorResult.isError, true);
      assert.equal(errorResult.structuredContent.data.code, 'COMPUTER_TARGET_REQUIRED');
      assert.ok(errorResult.structuredContent.data.adapter_revision);
      current = snapshot().replace(/UI Tree:[\s\S]*/, 'UI Tree:\ndesktop\n    └── window "CU fixture"\n        └── (10,10) button "Close"  [action: click]');
      const notReady = await handlers.get('computer_observe')({ session_id: id, image: false });
      assert.equal(notReady.isError, true);
      assert.equal(notReady.structuredContent.data.code, 'COMPUTER_TREE_NOT_READY');
      assert.equal(session.observation, undefined, 'frame-only never issues an action token');
      current = 'unparseable sensitive desktop payload';
      const parseError = await handlers.get('computer_observe')({ session_id: id, image: false });
      assert.equal(parseError.structuredContent.data.code, 'COMPUTER_OBSERVE_FORMAT');
      assert.equal(parseError.structuredContent.data.diagnostics.reason, 'missing_sections');
      assert.ok(!JSON.stringify(parseError).includes('sensitive desktop'));
      assert.equal(windowsParseDiagnostics(snapshot() + '\n[truncated: limit]').reason, 'tree_truncated');
      assert.equal(windowsParseDiagnostics(snapshot().replace('CU fixture        0', 'Different         0')).reason, 'focused_window_tree_missing');
      console.log('OK structured errors, redacted change diagnostics, frame-only readiness and pinned handle; bad targets fail before preflight');
      current = snapshot();
      obs = (await observeComputer(id, false)).structuredContent.data;
      session.client.callTool = async request => {
        if (request.name === 'Snapshot') return { content: [{ type: 'text', text: current }] };
        throw new Error('lost response');
      };
      await assert.rejects(actComputer(id, obs.observation_id, { kind: 'click', label: 0 }), error => {
        assert.equal(error.code, 'COMPUTER_ACTION_UNKNOWN');
        assert.equal(error.diagnostics.action_dispatched, true);
        assert.equal(error.diagnostics.action_completed, null);
        assert.equal(error.diagnostics.backend_stopped, true);
        assert.ok(error.diagnostics.request_id);
        return true;
      });
      assert.equal(computerSessionSummaries().length, 0, 'failed Windows child was stopped');
      await assert.rejects(actComputer(id, obs.observation_id, { kind: 'click', label: 0 }), /COMPUTER_NOT_OWNED|COMPUTER_LEASE_EXPIRED/);
      const receipt = recentComputerActionStatuses().at(-1);
      assert.equal(receipt.status, 'unknown');
      assert.equal(receipt.kind, 'click');
      assert.equal(receipt.action_completed, null);
      await executionContext.run({ taskId: 'windows-catalog-fixture', sessionId: 'unrelated-owner', workspace: temp,
        workspaceOnly: false }, async () => assert.equal(recentComputerActionStatuses().length, 0, 'another conversation cannot read action receipt'));
      const status = await handlers.get('computer_session')({ action: 'status', backend: 'windows' });
      assert.equal(status.structuredContent.data.recent_actions.at(-1).request_id, receipt.request_id);
      assert.ok(!JSON.stringify(status).includes('lost response'), 'no raw backend details in status');
      console.log('OK Windows guard: focus/geometry/control changes refused; lost action response quarantined, receipt survives close, no replay');
    } finally { session.client.callTool = realCall; }
  } finally { if (id) await closeComputerSession(id); }
  id = (await openComputerSession('windows', 'CU fixture')).session_id;
  const timedOut = ownedComputerSession(id);
  timedOut.client.callTool = async () => { throw new Error('McpError -32001: Request timed out'); };
  await assert.rejects(observeComputer(id, false), error => {
    assert.equal(error.code, 'COMPUTER_WINDOWS_TIMEOUT');
    assert.equal(error.diagnostics.phase, 'snapshot');
    assert.equal(error.diagnostics.action_dispatched, false);
    assert.equal(error.diagnostics.backend_stopped, true);
    return true;
  });
  assert.equal(computerSessionSummaries().length, 0, 'timed-out snapshot child was stopped');
  console.log('OK Windows transport stopped and desktop lease released after action/snapshot failures; no UI actions performed');
});
