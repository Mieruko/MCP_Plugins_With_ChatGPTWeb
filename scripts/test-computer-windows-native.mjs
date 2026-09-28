// Opt-in integration test against the user's already-open Audio Wave Studio.
// Opens its project chooser once then cancels; never chooses a file, types,
// saves or renders. Kept opt-in, outside unattended/default test suites.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executionContext } from '../dist/lib/workbench-context.js';
import { openComputerSession, ownedComputerSession, observeComputer, actComputer, closeComputerSession } from '../dist/lib/computer-use.js';
import { windowsEvidence } from '../dist/lib/computer-observation.js';

assert.ok(process.argv.includes('--open-project-chooser'), 'Requires explicit --open-project-chooser; changes visible UI');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cu-native-open-project-'));
process.env.COMPUTER_USE_ENABLED = 'true';
process.env.COMPUTER_WINDOWS_ENABLED = 'true';
process.env.COMPUTER_WINDOWS_COMMAND = path.join(repo, '.computer-use-runtime/windows/Scripts/windows-mcp.exe');
process.env.WORKBENCH_PATH = path.join(temp, 'control');
await executionContext.run({ taskId: 'windows-native-fixture', sessionId: 'native-test-owner', workspace: repo,
  workspaceOnly: false, operationId: 'open-project-chooser-once', capture: async () => {} }, async () => {
  let id;
  try {
    id = (await openComputerSession('windows', 'Audio Wave Studio')).session_id;
    const observed = await observeComputer(id, false);
    assert.ok(!observed.isError);
    const data = observed.structuredContent.data;
    const targets = data.windows_targets.filter(t => /^button "Mở project"\s+\[action: click\]/.test(t.description));
    assert.equal(targets.length, 1, 'Expected exactly one observed Open project button');
    console.log(JSON.stringify({ observed: true, target: targets[0].description }));
    const result = await actComputer(id, data.observation_id, { kind: 'click', label: targets[0].label });
    assert.ok(!result.isError, 'Backend did not acknowledge click; do not replay');
    assert.equal(result.structuredContent.data.completed, 1);
    // Read-only reconciliation after the one action. Upstream may report the
    // parent title for an owned dialog, so verify actual chooser controls.
    const session = ownedComputerSession(id);
    const raw = await session.client.callTool({ name: 'Snapshot', arguments: { use_vision: false, use_ui_tree: true } });
    const evidence = windowsEvidence(raw.content.filter(c => c.type === 'text').map(c => c.text).join('\n'));
    assert.ok(evidence, 'Resulting UI must parse');
    const names = evidence.targets.map(t => t.description);
    const chooser = names.some(t => /button "(Cancel|Hủy)"/.test(t)) && names.some(t => /combo box "(File name:|Tên tệp:)|edit "(File name:|Tên tệp:)/.test(t));
    console.log(JSON.stringify({ acknowledged_clicks: 1, focused_title: evidence.title, project_chooser_verified: chooser }));
    assert.ok(chooser, 'Click acknowledged but file chooser not verified; do not replay');
    await assert.rejects(actComputer(id, data.observation_id, { kind: 'click', label: targets[0].label }), /COMPUTER_STALE_OBSERVATION/, 'Original click cannot be replayed');
    if (evidence.title !== 'Audio Wave Studio') {
      await assert.rejects(observeComputer(id, false), /COMPUTER_WINDOW_CHANGED/);
      console.log('OK native project chooser opened with a new window title; left open for manual cancel');
      return;
    }
    const chooserObservation = (await observeComputer(id, false)).structuredContent.data;
    const cancel = chooserObservation.windows_targets.filter(t => /^button "(Cancel|Hủy)"\s+\[action: click\]/.test(t.description));
    assert.equal(cancel.length, 1, 'Expected one observed Cancel button');
    const cancelled = await actComputer(id, chooserObservation.observation_id, { kind: 'click', label: cancel[0].label });
    assert.ok(!cancelled.isError);
    const restored = (await observeComputer(id, false)).structuredContent.data;
    assert.ok(restored.windows_targets.some(t => /^button "Mở project"\s+\[action: click\]/.test(t.description)));
    assert.ok(!restored.windows_targets.some(t => /^button "Cancel"\s+\[action: click\]/.test(t.description)));
    console.log('OK native Open project → verified chooser → Cancel → app restored; stale click refused; no file selected');
  } finally { if (id) await closeComputerSession(id); }
});
