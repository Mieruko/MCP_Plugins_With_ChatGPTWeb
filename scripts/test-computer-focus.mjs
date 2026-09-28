import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executionContext } from '../dist/lib/workbench-context.js';
import { openComputerSession, ownedComputerSession, observeComputer, actComputer, closeComputerSession, computerSessionSummaries, computerDesktopBlocked } from '../dist/lib/computer-use.js';
import { createComputerJob, pollComputerJob, monitorComputerJob, listComputerJobs, shutdownComputerMonitors } from '../dist/lib/computer-jobs.js';
import { registerComputerTools } from '../dist/tools/computer-use.js';

// Exercise the actual session registry/queue with isolated headless workers.
// Simulate desktop ownership only; never capture/focus the user's native windows.
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cu-focus-'));
process.env.WORKBENCH_PATH = path.join(temp, 'state');
process.env.COMPUTER_USE_ENABLED = 'true';
process.env.COMPUTER_BROWSER_HEADLESS = 'true';
process.env.COMPUTER_BROWSER_PROFILE_PATH = path.join(temp, 'first-profile');
const context = { taskId: 'focus-test', sessionId: 'owner', workspace: temp, workspaceOnly: false, operationId: 'focus-test', capture: async () => {} };
await executionContext.run(context, async () => {
  let windowsId, browserId;
  const handlers = new Map();
  registerComputerTools({ registerTool(name, _config, handler) { handlers.set(name, handler); } });
  try {
    windowsId = (await openComputerSession('browser')).session_id;
    const simulatedWindows = ownedComputerSession(windowsId);
    simulatedWindows.headed = true;
    simulatedWindows.busy = true;
    await assert.rejects(openComputerSession('windows', 'Never captured'), /COMPUTER_DESKTOP_BUSY/);
    simulatedWindows.busy = false;
    simulatedWindows.backend = 'windows';
    simulatedWindows.windowTitle = 'TestEVM Windows Use Lab';
    const windowsSnapshot = (title = 'TestEVM Windows Use Lab', handle = '3997818') => `Active Desktop:
Desktop 1
All Desktops:
Desktop 1
Focused Window:
Name Depth Status Width Height Handle
---- ----- ------ ----- ------ ------
${title} 0 Normal 800 600 ${handle}
Opened Windows:
No windows found
UI Tree:
desktop
    └── window "${title}"
        └── (100,200) button "Bắt đầu lượt mới"  [action: click]`;
    let focused = windowsSnapshot(), clicks = 0;
    simulatedWindows.tools.set('Snapshot', { use_vision: {}, use_ui_tree: {} });
    simulatedWindows.tools.set('Click', { loc: {} });
    simulatedWindows.client.callTool = async request => {
      if (request.name === 'Snapshot') return { content: [{ type: 'text', text: focused }] };
      assert.equal(request.name, 'Click'); clicks++;
      return { content: [{ type: 'text', text: 'Synthetic acknowledgement' }] };
    };
    const before = (await observeComputer(windowsId, false)).structuredContent.data;
    focused = windowsSnapshot('Kiểm thử Computer Use - Google Chrome', '591062');
    await assert.rejects(actComputer(windowsId, before.observation_id, { kind: 'click', label: 0 }), error => {
      assert.equal(error.code, 'COMPUTER_WINDOW_CHANGED');
      assert.equal(error.diagnostics.expected_handle, '3997818');
      assert.equal(error.diagnostics.current_handle, '591062');
      assert.equal(error.diagnostics.requires_new_observation, true);
      assert.equal(error.diagnostics.action_sent, false);
      return true;
    });
    assert.equal(clicks, 0);
    focused = windowsSnapshot();
    await assert.rejects(actComputer(windowsId, before.observation_id, { kind: 'click', label: 0 }), /COMPUTER_STALE_OBSERVATION/);
    const fresh = (await observeComputer(windowsId, false)).structuredContent.data;
    await actComputer(windowsId, fresh.observation_id, { kind: 'click', label: 0 });
    assert.equal(clicks, 1, 'only explicitly requested action after fresh observation is dispatched');
    console.log('OK TestEVM focus reproduction: Chrome foreground blocks click; old token remains invalid; refocus + fresh observation permits one explicit action');
    process.env.COMPUTER_BROWSER_PROFILE_PATH = path.join(temp, 'second-profile');
    process.env.COMPUTER_BROWSER_HEADLESS = 'false';
    const openError = await handlers.get('computer_session')({ action: 'open', backend: 'browser' });
    assert.equal(openError.isError, true);
    assert.equal(openError.structuredContent.data.code, 'COMPUTER_DESKTOP_BUSY');
    assert.equal(openError.structuredContent.data.diagnostics.action_sent, false);
    await assert.rejects(openComputerSession('browser'), /COMPUTER_DESKTOP_BUSY/);
    await assert.rejects(openComputerSession('browser', undefined, true), /COMPUTER_DESKTOP_BUSY/);
    process.env.COMPUTER_BROWSER_HEADLESS = 'true';
    browserId = (await openComputerSession('browser')).session_id;
    const browser = ownedComputerSession(browserId);
    assert.equal(computerDesktopBlocked(browser), false);
    assert.ok((await observeComputer(browserId, false)).structuredContent.data.observation_id);
    browser.headed = true;
    const joined = await handlers.get('computer_session')({ action: 'open', backend: 'browser' });
    assert.equal(joined.structuredContent.data.desktop_paused, true);
    const uploadError = await handlers.get('computer_upload')({ session_id: browserId, observation_id: 'unused', paths: [] });
    assert.equal(uploadError.isError, true);
    assert.equal(uploadError.structuredContent.data.code, 'COMPUTER_DESKTOP_BUSY');
    let upstreamCalls = 0;
    const original = browser.client.callTool.bind(browser.client);
    browser.client.callTool = async (...args) => { upstreamCalls++; return original(...args); };
    assert.equal(computerSessionSummaries().find(s => s.session_id === browserId).desktop_paused, true);
    const blocked = await Promise.allSettled([observeComputer(browserId, false), observeComputer(browserId, false)]);
    for (const result of blocked) {
      assert.equal(result.status, 'rejected');
      assert.equal(result.reason.code, 'COMPUTER_DESKTOP_BUSY');
      assert.equal(result.reason.diagnostics.action_sent, false);
    }
    const job = await createComputerJob({ session_id: browserId, workflow: 'generic', expected_url: 'http://localhost/', success_text: ['NEVER_SEEN'] });
    const polled = await pollComputerJob(job.id);
    assert.equal(polled.state, 'created', 'desktop contention is not a disconnect or success');
    assert.match(polled.note, /paused/);
    await monitorComputerJob(job.id, 5);
    await new Promise(resolve => setTimeout(resolve, 2300));
    assert.equal(upstreamCalls, 0, 'blocked calls and monitor never reach browser worker');
    assert.equal((await listComputerJobs()).find(j => j.id === job.id).monitoring, true);
    shutdownComputerMonitors();
    simulatedWindows.revoked = true;
    assert.equal(computerDesktopBlocked(browser), true, 'failed Stop still holds desktop exclusion');
    await closeComputerSession(windowsId); windowsId = undefined;
    assert.equal(computerDesktopBlocked(browser), false);
    assert.ok((await observeComputer(browserId, false)).structuredContent.data.observation_id);
    assert.equal(upstreamCalls, 1, 'browser remains usable after Windows closes, without reopening profile');
    console.log('OK desktop coordination: headed browser/queued observations/monitor paused, headless unaffected, failed Stop retains exclusion, explicit close resumes browser');
  } finally {
    shutdownComputerMonitors();
    if (browserId) await closeComputerSession(browserId);
    if (windowsId) await closeComputerSession(windowsId);
  }
});
