import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { executionContext } from '../dist/lib/workbench-context.js';
import { openComputerSession, ownedComputerSession, observeComputer, actComputer, closeComputerSession } from '../dist/lib/computer-use.js';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cu-performance-'));
let dynamic = 0;
const site = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  if (req.url === '/tick') { res.end(String(++dynamic)); return; }
  res.end(`<!doctype html><title>CU performance fixture</title>
    <button onclick="count.textContent=++window.n">Click</button><p id="count">0</p>
    <p id="ad">Advertisement 0</p>
    <button onclick="localStorage.setItem('saved','YES');document.cookie='cu_saved=YES; Max-Age=3600; Path=/';saved.textContent='Saved'">Save profile</button>
    <p id="saved"></p><p id="stored"></p>
    <button onclick="this.textContent='Changed target'">Changing</button>
    <button onclick="document.querySelector('dialog').showModal()">Open modal</button>
    <dialog><p>New confirmation</p><button onclick="this.closest('dialog').close()">Close modal</button></dialog>
    <script>window.n=0;stored.textContent='Storage '+(localStorage.getItem('saved')||'EMPTY')+' Cookie '+document.cookie;
    setInterval(()=>fetch('/tick').then(r=>r.text()).then(v=>ad.textContent='Advertisement '+v),50);</script>`);
});
await new Promise(resolve => site.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${site.address().port}/`;
process.env.WORKBENCH_PATH = path.join(temp, 'control');
process.env.COMPUTER_USE_ENABLED = 'true';
process.env.COMPUTER_BROWSER_HEADLESS = 'true';
const data = r => r.structuredContent.data;
const ref = (r, label) => {
  const found = new RegExp('button "'+label+'"(?: \\[active\\])? \\[ref=([^\\]]+)\\]').exec(data(r).output)?.[1];
  assert.ok(found, data(r).output); return found;
};
const context = taskId => ({taskId,sessionId:'performance-owner',workspace:temp,workspaceOnly:false,operationId:'performance',capture:async()=>{}});
let id;
try {
  await executionContext.run(context('profile-a'), async () => {
    const opened = await openComputerSession('browser'); id = opened.session_id;
    assert.equal(opened.profile.persistent, true);
    const profilePath = opened.profile.path;
    let r = await observeComputer(id, false);
    r = await actComputer(id, data(r).observation_id, {kind:'navigate',url});
    assert.ok(data(r).observation_id, JSON.stringify(r));
    const target = ref(r, 'Click');
    const start = Date.now();
    r = await actComputer(id, data(r).observation_id, {kind:'click',target,repeat:20});
    assert.equal(r.isError, false, JSON.stringify(r));
    assert.equal(data(r).completed, 20);
    assert.match(data(r).output, /paragraph \[ref=[^\]]+\]: "20"/);
    console.log(`OK 20 clicks in one call with changing advertisement: ${Date.now()-start}ms; final UI count 20`);
    r = await actComputer(id, data(r).observation_id, {kind:'click',target:ref(r,'Save profile')});
    assert.equal(r.isError, false);
    r = await actComputer(id, data(r).observation_id, {kind:'click',target:ref(r,'Changing'),repeat:3});
    assert.equal(r.isError, true); assert.equal(data(r).completed, 1);
    assert.equal(data(r).uncertain_attempt, false);
    r = await observeComputer(id, false);
    r = await actComputer(id, data(r).observation_id, {kind:'click',target:ref(r,'Open modal'),repeat:3});
    assert.equal(r.isError, true); assert.equal(data(r).completed, 1);
    assert.equal(data(r).remaining, 2);
    console.log('OK target/modal changes stop repetition with exact acknowledged counts');
    r = await observeComputer(id, false);
    r = await actComputer(id, data(r).observation_id, {kind:'click',target:ref(r,'Close modal')});
    const session = ownedComputerSession(id);
    const realCall = session.client.callTool.bind(session.client);
    let clicks = 0;
    session.client.callTool = async (...args) => {
      const result = await realCall(...args);
      if (args[0].name === 'browser_click' && ++clicks === 3) throw new Error('lost third click response');
      return result;
    };
    r = await actComputer(id, data(r).observation_id, {kind:'click',target:ref(r,'Click'),repeat:5});
    assert.equal(r.isError, true); assert.equal(data(r).completed, 2); assert.equal(data(r).uncertain_attempt, true);
    assert.equal(data(r).observation_id, undefined);
    session.client.callTool = realCall;
    r = await observeComputer(id, false); assert.match(data(r).output, /paragraph \[ref=[^\]]+\]: "23"/);
    console.log('OK lost third response stops batch: 2 acknowledged, 1 uncertain, no replay');
    const outside = path.join(temp, 'page-2026-09-27T00-00-00.yml');
    await fs.writeFile(outside, 'PRIVATE_FIXTURE_SENTINEL');
    session.client.callTool = async (...args) => {
      const result = await realCall(...args);
      if (args[0].name !== 'browser_click') return result;
      return { content: [{ type: 'text', text: `### Page\n- Page URL: ${url}\n### Snapshot\n- [Snapshot](${outside})` }] };
    };
    r = await actComputer(id, data(r).observation_id, {kind:'click',target:ref(r,'Click')});
    assert.equal(r.isError, true); assert.equal(data(r).completed, 1);
    assert.equal(data(r).observation_id, undefined);
    assert.doesNotMatch(JSON.stringify(r), /PRIVATE_FIXTURE_SENTINEL/);
    assert.match(data(r).output, /COMPUTER_SNAPSHOT_FILE/);
    session.client.callTool = realCall;
    console.log('OK action snapshot cannot read an arbitrary path outside task output; completed action is not retried');
    await closeComputerSession(id); id = undefined;
    const reopened = await openComputerSession('browser'); id = reopened.session_id;
    assert.equal(reopened.profile.path, profilePath);
    r = await observeComputer(id, false);
    r = await actComputer(id, data(r).observation_id, {kind:'navigate',url});
    assert.match(data(r).output, /Storage YES Cookie cu_saved=YES/);
    console.log('OK same task retains localStorage and persistent cookie after closing/reopening Chrome');
    await closeComputerSession(id); id = undefined;
  });
  await executionContext.run(context('profile-b'), async () => {
    id = (await openComputerSession('browser')).session_id;
    let r = await observeComputer(id,false);
    r = await actComputer(id,data(r).observation_id,{kind:'navigate',url});
    assert.match(data(r).output,/Storage EMPTY/); assert.doesNotMatch(data(r).output,/cu_saved=YES/);
    console.log('OK another task does not inherit the saved profile');
  });
} finally {
  if (id) await closeComputerSession(id);
  await new Promise(resolve => site.close(resolve));
}
