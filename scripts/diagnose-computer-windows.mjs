// Explicit local diagnostic: two read-only UI snapshots, no mouse/keyboard input.
// Raw output stays in the ignored runtime folder; it may contain desktop text.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { executionContext } from '../dist/lib/workbench-context.js';
import { openComputerSession, ownedComputerSession, observeComputer, closeComputerSession } from '../dist/lib/computer-use.js';
import { windowsEvidence } from '../dist/lib/computer-observation.js';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const title = process.argv[2];
if (!title) throw new Error('Usage: node scripts/diagnose-computer-windows.mjs "Exact window title"');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cu-windows-diagnostic-'));
process.env.COMPUTER_USE_ENABLED = 'true';
process.env.COMPUTER_WINDOWS_ENABLED = 'true';
process.env.COMPUTER_WINDOWS_COMMAND = path.join(repo, '.computer-use-runtime/windows/Scripts/windows-mcp.exe');
process.env.WORKBENCH_PATH = path.join(temp, 'control');
await executionContext.run({ taskId: 'windows-diagnostic', sessionId: 'diagnostic-owner', workspace: repo,
  workspaceOnly: false, operationId: 'read-only-snapshot', capture: async () => {} }, async () => {
  let id;
  try {
    id = (await openComputerSession('windows', title)).session_id;
    const session = ownedComputerSession(id);
    const realCall = session.client.callTool.bind(session.client);
    const snapshots = [];
    session.client.callTool = async (...args) => {
      if (args[0].name !== 'Snapshot') throw new Error('Diagnostic only permits Snapshot');
      const raw = await realCall(...args);
      snapshots.push(raw);
      await fs.writeFile(path.join(repo, '.computer-use-runtime/windows-observation.json'), JSON.stringify(raw, null, 2));
      await fs.writeFile(path.join(repo, '.computer-use-runtime/windows-observation-pair.json'), JSON.stringify(snapshots, null, 2));
      console.log(JSON.stringify({ blocks: raw.content?.map(c => ({ type: c.type, text_length: c.text?.length,
        json_wrapped: typeof c.text === 'string' && /^[\["{]/.test(c.text.trimStart()) })), isError: raw.isError }));
      return raw;
    };
    const result = await observeComputer(id, false);
    const firstIdentity = session.observation?.digest;
    const firstParts = JSON.parse(windowsEvidence(session.observation.text).identity);
    const second = await observeComputer(id, false);
    const targets = second.structuredContent?.data?.windows_targets ?? [];
    console.log(JSON.stringify({ ok: !result.isError && !second.isError, targets: targets.length,
      identity_unchanged: Boolean(firstIdentity && firstIdentity === session.observation?.digest),
      changed_sections: JSON.parse(windowsEvidence(session.observation.text).identity).flatMap((part, i) =>
        JSON.stringify(part) === JSON.stringify(firstParts[i]) ? [] : [['desktop', 'focused-window', 'background-layout', 'app-controls'][i]]),
      open_project_found: targets.some(t => t.description.includes('Mở project')) }));
  } finally { if (id) await closeComputerSession(id); }
});
