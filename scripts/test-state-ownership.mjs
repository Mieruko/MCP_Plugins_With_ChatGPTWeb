import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.argv.includes('--child')) {
  const wb = await import('../dist/lib/workbench.js');
  try {
    await Promise.all([wb.claimWorkbenchStateOwnership(), wb.claimWorkbenchStateOwnership()]);
    process.send({ claimed: true });
    await new Promise(resolve => process.once('message', resolve));
    await wb.releaseWorkbenchStateOwnership();
  } catch (error) { process.send({ claimed: false, error: String(error) }); }
  process.disconnect();
} else {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-owner-test-'));
  const claims = path.join(tmp, 'owner-claims');
  await fs.mkdir(claims);
  const children = [];
  function contender() {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--child'], {
      env: { ...process.env, WORKBENCH_PATH: tmp }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    const closed = new Promise(resolve => child.once('exit', resolve));
    const result = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Ownership contender timed out: ' + stderr)), 10000);
      child.once('message', value => { clearTimeout(timeout); resolve(value); });
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); if (code) reject(new Error(stderr)); });
    });
    const item = { child, closed, result };
    children.push(item);
    return item;
  }
  async function release(item) { item.child.send('release'); assert.equal(await item.closed, 0); }
  try {
    const incomplete = path.join(claims, `${process.pid}.json`);
    await fs.writeFile(incomplete, '');
    const blocked = contender();
    assert.match((await blocked.result).error, /WORKBENCH_STATE_IN_USE/);
    await blocked.closed;
    assert.equal(await fs.readFile(incomplete, 'utf8'), '');
    await fs.unlink(incomplete);
    console.log('OK incomplete live ownership claim is preserved and excludes another server');

    const owner = contender();
    assert.equal((await owner.result).claimed, true);
    const duplicate = contender();
    assert.match((await duplicate.result).error, /WORKBENCH_STATE_IN_USE/);
    await duplicate.closed;
    await release(owner);
    const next = contender();
    assert.equal((await next.result).claimed, true);
    next.child.kill('SIGKILL');
    await next.closed;
    const afterCrash = contender();
    assert.equal((await afterCrash.result).claimed, true);
    await release(afterCrash);
    console.log('OK duplicate refusal, graceful release, same-process calls and recovery after a killed owner');

    const burst = Array.from({ length: 8 }, contender);
    const results = await Promise.all(burst.map(item => item.result));
    const winners = burst.filter((_, index) => results[index].claimed);
    assert.ok(winners.length <= 1, 'concurrent servers must never both own the state');
    for (const winner of winners) await release(winner);
    await Promise.all(burst.map(item => item.closed));
    const retry = contender();
    assert.equal((await retry.result).claimed, true);
    await release(retry);
    console.log('OK simultaneous startup has at most one owner and leaves state available afterward');

    await fs.writeFile(path.join(tmp, 'owner.lock'), JSON.stringify({ pid: process.pid }));
    const legacy = contender();
    assert.match((await legacy.result).error, /WORKBENCH_STATE_IN_USE/);
    await legacy.closed;
    await fs.writeFile(path.join(tmp, 'owner.lock'), JSON.stringify({ pid: next.child.pid }));
    const stale = contender();
    assert.equal((await stale.result).claimed, true);
    await release(stale);
    console.log('OK legacy live lock is respected and dead legacy lock permits migration');
  } finally {
    for (const item of children) {
      if (item.child.exitCode === null && item.child.signalCode === null) item.child.kill('SIGKILL');
      await item.closed;
    }
    assert.equal(path.dirname(path.resolve(tmp)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(tmp).startsWith('workbench-owner-test-'));
    await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
