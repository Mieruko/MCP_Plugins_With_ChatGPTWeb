import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executionContext } from '../dist/lib/workbench-context.js';
import { openComputerSession, ownedComputerSession, closeComputerSession, computerSessionSummaries } from '../dist/lib/computer-use.js';

// Protocol/catalog smoke only: deliberately no screenshot, click, typing or
// desktop capture. A successful handshake does not validate native UI behavior.
assert.equal(process.platform, 'win32', 'Windows runtime test requires Windows');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.join(repo, '.computer-use-runtime/windows/Scripts/windows-mcp.exe');
await fs.access(executable);
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
      Click: ['label'], Type: ['label', 'text', 'clear', 'press_enter'], Shortcut: ['shortcut'], Scroll: ['label', 'direction', 'wheel_times'] };
    for (const [name, parameters] of Object.entries(expected)) {
      const schema = session.tools.get(name);
      assert.ok(schema, `Missing backend tool ${name}`);
      for (const parameter of parameters) assert.ok(parameter in schema, `${name} missing ${parameter}`);
    }
    await assert.rejects(openComputerSession('windows', 'Other fixture'), /COMPUTER_BUSY/);
    console.log('OK installed Windows backend handshake and all 6 UI schemas; duplicate controller refused');
  } finally { if (id) await closeComputerSession(id); }
  assert.equal(computerSessionSummaries().length, 0);
  console.log('OK Windows transport stopped and desktop lease released; no UI actions performed');
});
