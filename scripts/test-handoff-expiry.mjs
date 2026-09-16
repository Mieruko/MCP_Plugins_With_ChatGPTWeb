import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'handoff-expiry-test-'));
process.env.WORKBENCH_PATH = path.join(tmp, 'control');
process.env.WORKSPACE_PATH = tmp;
process.env.WORKBENCH_EXPERIENCE = 'advanced';
process.env.WORKBENCH_DEFAULT_MODE = 'ask';
process.env.WORKBENCH_SANDBOX_PROVIDER = 'none';
const wb = await import('../dist/lib/workbench.js');
const now = Date.now;
try {
  const id = await wb.resolveDefaultTask(tmp);
  const args = { action: 'update', summary: 'must never be written' };
  let invoked = 0;
  const result = await wb.dispatch(id, 'task_handoff', args, async () => {
    invoked++;
    return wb.setTaskHandoff(id, { summary: args.summary });
  }, false, 'fixture-session');
  const pending = JSON.parse(result.content[0].text);
  assert.equal(pending.status, 'approval_required');
  Date.now = () => now() + 16 * 60_000;
  await assert.rejects(wb.decideOperation(pending.operation_id, true), /expired/);
  Date.now = now;
  assert.equal((await wb.operationDetail(pending.operation_id)).status, 'expired');
  assert.equal(invoked, 0);
  assert.equal((await wb.getWorkbench()).tasks.find(t => t.id === id).handoff, undefined);
  await assert.rejects(wb.decideOperation(pending.operation_id, true), /APPROVAL_GONE/);
  console.log('OK expired handoff approval never invokes or writes, and cannot replay');
} finally {
  Date.now = now;
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
