import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { executionContext } from '../dist/lib/workbench-context.js';
import { openComputerSession, ownedComputerSession, observeComputer, actComputer, closeComputerSession, computerSessionSummaries } from '../dist/lib/computer-use.js';
import { createComputerJob, readComputerJob, cancelComputerJob } from '../dist/lib/computer-jobs.js';

// Fault injection at the transport boundary, with a real isolated Chrome page.
// HTTP dispatch/authorization is covered separately by test-computer-use.mjs.
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cu-fault-fixture-'));
const fixture = http.createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<button onclick="this.textContent=\'Submit count: \'+(++window.count)">Submit count: 0</button><script>window.count=0</script>');
});
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${fixture.address().port}`;
process.env.COMPUTER_USE_ENABLED = 'true';
process.env.COMPUTER_BROWSER_HEADLESS = 'true';
process.env.WORKBENCH_PATH = path.join(temp, 'control');
process.env.COMPUTER_BROWSER_PROFILE_PATH = path.join(temp, 'profile');
try {
  await executionContext.run({ taskId: 'fault-fixture', sessionId: 'fault-owner', workspace: temp,
    workspaceOnly: false, operationId: 'fault-test', capture: async () => {} }, async () => {
    let session, realCall, realClose;
    try {
      const id = (await openComputerSession('browser')).session_id;
      session = ownedComputerSession(id);
      let observation = (await observeComputer(id, false)).structuredContent.data;
      await actComputer(id, observation.observation_id, { kind: 'navigate', url });
      observation = (await observeComputer(id, false)).structuredContent.data;
      const target = /button "Submit count: 0" \[ref=([^\]]+)\]/.exec(observation.output)?.[1];
      assert.ok(target);
      realCall = session.client.callTool.bind(session.client);
      session.client.callTool = async (...args) => {
        const result = await realCall(...args);
        if (args[0].name === 'browser_click') throw new Error('Injected transport loss AFTER click');
        return result;
      };
      await assert.rejects(actComputer(id, observation.observation_id, { kind: 'click', target }), /COMPUTER_ACTION_UNKNOWN/);
      await assert.rejects(actComputer(id, observation.observation_id, { kind: 'click', target }), /COMPUTER_STALE_OBSERVATION/);
      session.client.callTool = realCall;
      observation = (await observeComputer(id, false)).structuredContent.data;
      assert.match(observation.output, /Submit count: 1/);
      assert.doesNotMatch(observation.output, /Submit count: 2/);
      console.log('OK lost response after real click invalidates observation; no duplicate submit during reconciliation');

      const job = await createComputerJob({ session_id: id, workflow: 'generic', expected_url: url, success_text: ['unreachable-success'] });
      assert.equal(job.expected_url, url + '/');
      realClose = session.transport.close.bind(session.transport);
      session.transport.close = async () => { throw new Error('Injected backend stop failure'); };
      await assert.rejects(cancelComputerJob(job.id), /Injected backend stop failure/);
      assert.equal((await readComputerJob(job.id)).state, 'created', 'failed stop must not mark cancellation successful');
      assert.equal(computerSessionSummaries()[0].state, 'stopping');
      await assert.rejects(openComputerSession('browser'), /COMPUTER_BUSY/);
      await assert.rejects(observeComputer(id, false), /COMPUTER_LEASE_EXPIRED/);
      session.transport.close = realClose;
      assert.equal((await cancelComputerJob(job.id)).state, 'cancelled', 'explicit stop retry succeeds');
      assert.equal(computerSessionSummaries().length, 0);
      console.log('OK failed Stop retains lease/revocation and job state; explicit retry cleans up without false success');
    } finally {
      if (session) {
        if (realCall) session.client.callTool = realCall;
        if (realClose) session.transport.close = realClose;
        await closeComputerSession(session.id);
      }
    }
  });
} finally { await new Promise(resolve => fixture.close(resolve)); }
