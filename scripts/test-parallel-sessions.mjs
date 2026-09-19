import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { assignmentPrompt, sharedCheckoutWarning, slotIssue } from '../public/ui/workbench/session-slots.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'parallel-sessions-'));
const project = path.join(tmp, 'project');
await fs.mkdir(project);
const git = (...args) => execFileSync('git', args, { cwd: project, windowsHide: true, encoding: 'utf8' });
const blocked = () => new Promise(resolve => { let end; end = resolve; });
try {
  // Check the deterministic browser slot contract without claiming any host identity.
  const workspace = { id: 'workspace-1' };
  const tasks = [
    { id: 'A', workspaceId: workspace.id, title: 'Review', lifecycle: 'open', execution: { path: '/tmp/shared' } },
    { id: 'B', workspaceId: workspace.id, title: 'Tester', lifecycle: 'open', execution: { path: '/tmp/isolated-b', mode: 'worktree' } },
    { id: 'C', workspaceId: workspace.id, title: 'Data', lifecycle: 'open', execution: { path: '/tmp/isolated-c', mode: 'worktree' } },
    { id: 'D', workspaceId: workspace.id, title: 'Shared', lifecycle: 'open', execution: { path: '/tmp/shared' } },
  ];
  assert.equal(slotIssue(tasks[0], tasks, ['A', 'B', 'C'], 0), '');
  assert.equal(slotIssue(tasks[1], tasks, ['A', 'B', 'C'], 1), '');
  assert.equal(slotIssue(tasks[1], tasks, ['B', 'B'], 0), '');
  assert.equal(slotIssue(tasks[3], tasks, ['A', 'D'], 1), '', 'distinct tasks sharing a checkout are permitted');
  assert.match(sharedCheckoutWarning(tasks[3], tasks, ['A', 'D'], 1), /mutations are serialized/);
  assert.equal(slotIssue(tasks[1], tasks, ['A', 'B'], 1, [{ taskId: 'B', active: true }]), '');
  assert.equal(slotIssue(tasks[1], tasks, ['A', 'B'], 1, [{ taskId: 'B', active: true, taskConfirmed: false }]), '',
    'provisional fallback is not proof that a task belongs to a chat');
  assert.equal(slotIssue(tasks[1], tasks, ['A', 'B'], 1, [{ taskId: 'B', queued: true }]), '');
  const prompt = assignmentPrompt(tasks[1], workspace, 'Run real DB integration tests.');
  assert.match(prompt, /workbench_control\(action=target, task_id=the Task ID above, create_missing=false\)/);
  assert.match(prompt, /Task ID: B/);
  assert.match(prompt, /verify the returned task ID matches exactly/);
  assert.doesNotMatch(prompt, /task_dispatch\(/);
  assert.throws(() => assignmentPrompt({ ...tasks[1], workspaceId: 'foreign' }, workspace), /not in the selected workspace/);
  console.log('OK browser slots permit shared checkouts with warnings, allow shared tasks and generate exact-ID prompts');

  process.env.WORKBENCH_PATH = path.join(tmp, 'state');
  process.env.WORKSPACE_PATH = project;
  process.env.WORKBENCH_EXPERIENCE = 'advanced';
  process.env.WORKBENCH_DEFAULT_MODE = 'full';
  process.env.WORKBENCH_SANDBOX_PROVIDER = 'none';
  git('init');
  git('config', 'user.name', 'Parallel Fixture');
  git('config', 'user.email', 'parallel@example.invalid');
  await fs.writeFile(path.join(project, 'main.txt'), 'base\n');
  git('add', 'main.txt');
  git('commit', '-m', 'fixture');
  const { createWorkspace, createTask, selectTask, resolveSessionTask, switchSessionTask, dispatch, getWorkbench, taskExecutionPath, queueAgentTaskAssignment, cancelAgentTaskAssignment } = await import('../dist/lib/workbench.js');
  const { registerTaskRuntimeProcess, forgetTaskRuntimeProcess } = await import('../dist/lib/task-runtime.js');
  const owner = await createWorkspace('Fixture', project);
  const source = await createTask('Bootstrap', undefined, owner.id, { mode: 'local' });
  const tester = await createTask('Tester', undefined, owner.id, { mode: 'worktree' });
  const data = await createTask('Data', undefined, owner.id, { mode: 'worktree' });
  const shared = await createTask('Shared local task', undefined, owner.id, { mode: 'local' });
  const sharedTwo = await createTask('Another shared local task', undefined, owner.id, { mode: 'local' });
  const reservation = await queueAgentTaskAssignment(shared.id);
  assert.equal(reservation.taskId, shared.id, 'local tasks can explicitly reserve separate sessions');
  await cancelAgentTaskAssignment(shared.id);
  await selectTask(source.id);
  assert.equal(await resolveSessionTask('chat-A', project, 'chatgpt'), source.id);
  assert.equal(await resolveSessionTask('chat-B', project, 'chatgpt'), source.id, 'new chat can initially share dashboard fallback');
  assert.equal(await resolveSessionTask('chat-C', project, 'chatgpt'), source.id);
  assert.equal(await resolveSessionTask('chat-D', project, 'chatgpt'), source.id);
  assert.equal(await resolveSessionTask('chat-E', project, 'chatgpt'), source.id);
  // All five browser transports initially have the SAME provisional fallback;
  // this must neither grant work permissions nor block A's explicit claim.
  let fallbackInvoked = false;
  await assert.rejects(() => dispatch(source.id, 'write_file', { path: 'fallback-unsafe.txt', content: 'unsafe' },
    async () => { fallbackInvoked = true; }, false, 'chat-A'), /SESSION_TASK_UNCONFIRMED/);
  assert.equal(fallbackInvoked, false);
  const confirmed = await switchSessionTask('chat-A', 'chatgpt', { taskId: source.id },
    { taskId: source.id, sessionId: 'chat-A' });
  assert.equal(confirmed.task.id, source.id);
  assert.equal((await getWorkbench()).agentBindings.find(binding => binding.sessionId === 'chat-A').taskConfirmed, true);
  assert.equal((await switchSessionTask('chat-B', 'chatgpt', { taskId: source.id },
    { taskId: source.id, sessionId: 'chat-B' })).task.id, source.id,
  'another chat may select the same task without taking over the first chat');
  console.log('OK provisional dashboard fallback cannot execute tools until THIS session confirms its task');
  assert.notEqual(taskExecutionPath(tester), taskExecutionPath(data));
  assert.notEqual(taskExecutionPath(source), taskExecutionPath(tester));

  let releaseSource;
  let sourceStarted;
  const started = new Promise(resolve => { sourceStarted = resolve; });
  const waitForRelease = new Promise(resolve => { releaseSource = resolve; });
  registerTaskRuntimeProcess({ taskId: source.id, sessionId: 'chat-A', id: 'long-source', command: 'fixture', cwd: project,
    startedAt: new Date().toISOString(), isRunning: () => true, stop: async () => {} });
  const sourceCall = dispatch(source.id, 'run_command', { command: 'fixture' }, async () => {
    sourceStarted();
    await waitForRelease;
    return { content: [{ type: 'text', text: 'source done' }] };
  }, false, 'chat-A');
  try {
    await started;
    // The source checkout is locked by A's long command. B and C must not wait
    // for A to finish before taking distinct, isolated task checkouts.
    const [b, c, d, e] = await Promise.race([
      Promise.all([
        switchSessionTask('chat-B', 'chatgpt', { taskId: tester.id }, { taskId: source.id, sessionId: 'chat-B' }),
        switchSessionTask('chat-C', 'chatgpt', { taskId: data.id }, { taskId: source.id, sessionId: 'chat-C' }),
        switchSessionTask('chat-D', 'chatgpt', { taskId: shared.id }, { taskId: source.id, sessionId: 'chat-D' }),
        switchSessionTask('chat-E', 'chatgpt', { taskId: sharedTwo.id }, { taskId: source.id, sessionId: 'chat-E' }),
      ]),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Retarget waited for another chat\'s busy checkout')), 1500)),
    ]);
    assert.equal(b.task.id, tester.id);
    assert.equal(c.task.id, data.id);
    assert.equal(d.task.id, shared.id);
    assert.equal(e.task.id, sharedTwo.id);
    assert.equal(b.dashboard_selection_unchanged, true);
    const snapshot = await getWorkbench();
    assert.equal(snapshot.agentBindings.find(binding => binding.sessionId === 'chat-A').taskId, source.id);
    assert.equal(snapshot.agentBindings.find(binding => binding.sessionId === 'chat-B').taskId, tester.id);
    assert.equal(snapshot.agentBindings.find(binding => binding.sessionId === 'chat-C').taskId, data.id);
    assert.equal(snapshot.agentBindings.find(binding => binding.sessionId === 'chat-D').taskId, shared.id);
    assert.equal(snapshot.agentBindings.find(binding => binding.sessionId === 'chat-E').taskId, sharedTwo.id);
    assert.equal((await switchSessionTask('chat-C', 'chatgpt', { taskId: tester.id },
      { taskId: data.id, sessionId: 'chat-C' })).task.id, tester.id);
    await switchSessionTask('chat-C', 'chatgpt', { taskId: data.id }, { taskId: tester.id, sessionId: 'chat-C' });
    console.log('OK sessions retarget to worktrees AND a shared local checkout while bootstrap checkout is busy; shared task selection is allowed');
  } finally {
    releaseSource();
    await sourceCall;
    forgetTaskRuntimeProcess(source.id, 'long-source');
  }

  const windows = [source, tester, data];
  let completed = 0;
  const records = await Promise.all(windows.map((task, index) => dispatch(task.id, 'run_command', { command: 'concurrency fixture' }, async () => {
    const start = Date.now();
    await fs.writeFile(path.join(taskExecutionPath(task), `agent-${index}.txt`), String(index));
    await new Promise(resolve => setTimeout(resolve, 320));
    completed += 1;
    const end = Date.now();
    return { content: [{ type: 'text', text: JSON.stringify({ start, end }) }] };
  }, false, `chat-${'ABC'[index]}`)));
  const times = records.map(record => JSON.parse(record.content[0].text));
  assert.ok(times.every((item, i) => times.every((other, j) => i === j || item.start < other.end && other.start < item.end)),
    'three different task operations must overlap in time');
  assert.equal(completed, 3);
  for (let index = 0; index < 3; index++) {
    assert.equal(await fs.readFile(path.join(taskExecutionPath(windows[index]), `agent-${index}.txt`), 'utf8'), String(index));
    for (let other = 0; other < 3; other++) if (index !== other) {
      await assert.rejects(() => fs.stat(path.join(taskExecutionPath(windows[index]), `agent-${other}.txt`)), { code: 'ENOENT' });
    }
  }
  console.log('OK three same-workspace tasks execute simultaneously without writing into one another\'s worktrees');
  const sharedOps = await Promise.all([source, shared].map((task, index) => dispatch(task.id, 'run_command', { command: 'shared checkout fixture' }, async () => {
    const start = Date.now();
    await fs.writeFile(path.join(taskExecutionPath(task), `shared-${index}.txt`), String(index));
    await new Promise(resolve => setTimeout(resolve, 120));
    const end = Date.now();
    return { content: [{ type: 'text', text: JSON.stringify({ start, end }) }] };
  }, false, index ? 'chat-D' : 'chat-A')));
  const sharedTimes = sharedOps.map(result => JSON.parse(result.content[0].text));
  assert.ok(sharedTimes[0].end <= sharedTimes[1].start || sharedTimes[1].end <= sharedTimes[0].start,
    'mutations in a shared checkout must remain serialized across distinct task IDs');
  assert.equal(await fs.readFile(path.join(project, 'shared-0.txt'), 'utf8'), '0');
  assert.equal(await fs.readFile(path.join(project, 'shared-1.txt'), 'utf8'), '1');
  console.log('OK shared-checkout chats use separate tasks and retain serialized mutations without lost files');

  // A process must never run under a task from another session, even when a
  // transport's cached task identity disagrees with Workbench's live binding.
  let wronglyInvoked = false;
  await assert.rejects(() => dispatch(tester.id, 'write_file', { path: 'wrong-task.txt', content: 'unsafe' },
    async () => { wronglyInvoked = true; }, false, 'chat-A'), /SESSION_TASK_MISMATCH/);
  assert.equal(wronglyInvoked, false);
  await assert.rejects(() => dispatch(source.id, 'write_file', { path: 'wrong-task.txt', content: 'unsafe' },
    async () => { wronglyInvoked = true; }, false, 'unknown-transport'), /SESSION_TASK_MISMATCH/);
  console.log('OK stale and unknown MCP session bindings cannot execute tools under another task');

  const localTasks = [source, shared, sharedTwo];
  const localSessions = ['chat-A', 'chat-D', 'chat-E'];
  const fileOps = await Promise.all(localTasks.map((task, index) => dispatch(task.id, 'write_file',
    { path: `independent-${index}.txt`, content: String(index) }, async () => {
      const start = Date.now();
      await new Promise(resolve => setTimeout(resolve, 220));
      await fs.writeFile(path.join(project, `independent-${index}.txt`), String(index));
      return { content: [{ type: 'text', text: JSON.stringify({ start, end: Date.now() }) }] };
    }, false, localSessions[index])));
  const fileTimes = fileOps.map(result => JSON.parse(result.content[0].text));
  assert.ok(fileTimes.every((item, i) => fileTimes.every((other, j) => i === j || item.start < other.end && other.start < item.end)),
    'three different files on the SAME checkout should be edited in overlapping intervals');
  for (let i = 0; i < 3; i++) assert.equal(await fs.readFile(path.join(project, `independent-${i}.txt`), 'utf8'), String(i));
  console.log('OK three tasks modify different files in the same checkout simultaneously');

  const sameFileOps = await Promise.all([source, shared].map((task, index) => dispatch(task.id, 'write_file',
    { path: 'contended.txt', content: String(index) }, async () => {
      const start = Date.now();
      await new Promise(resolve => setTimeout(resolve, 140));
      await fs.writeFile(path.join(project, 'contended.txt'), String(index));
      return { content: [{ type: 'text', text: JSON.stringify({ start, end: Date.now() }) }] };
    }, false, index ? 'chat-D' : 'chat-A')));
  const sameFileTimes = sameFileOps.map(result => JSON.parse(result.content[0].text));
  assert.ok(sameFileTimes[0].end <= sameFileTimes[1].start || sameFileTimes[1].end <= sameFileTimes[0].start,
    'same-file mutations must never overlap');

  // Unknown shell writes still require a root lock, and must conflict with
  // narrow file locks. The synthetic process outlives start_process's response;
  // this tests the supported long-job workflow rather than unsafe shell bypass.
  let releaseRoot;
  let rootStarted;
  const rootReady = new Promise(resolve => { rootStarted = resolve; });
  const rootWait = new Promise(resolve => { releaseRoot = resolve; });
  const rootOperation = dispatch(source.id, 'run_command', { command: 'unknown writes' }, async () => {
    rootStarted();
    await rootWait;
    return { content: [{ type: 'text', text: 'done' }] };
  }, false, 'chat-A');
  try {
    await rootReady;
    let startedFile = false;
    const blockedFile = dispatch(shared.id, 'write_file', { path: 'root-conflict.txt', content: 'ready' }, async () => {
      startedFile = true;
      await fs.writeFile(path.join(project, 'root-conflict.txt'), 'ready');
      return { content: [{ type: 'text', text: 'ready' }] };
    }, false, 'chat-D');
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(startedFile, false, 'unknown shell command must still block checkout file writes');
    releaseRoot();
    await Promise.all([rootOperation, blockedFile]);
    assert.equal(startedFile, true);
  } finally { releaseRoot(); await rootOperation; }
  let backgroundRunning = true;
  const background = await dispatch(source.id, 'start_process', { command: 'background fixture' }, async () => {
    registerTaskRuntimeProcess({ taskId: source.id, sessionId: 'chat-A', id: 'background-fixture', command: 'fixture', cwd: project,
      startedAt: new Date().toISOString(), isRunning: () => backgroundRunning, stop: async () => { backgroundRunning = false; } });
    return { content: [{ type: 'text', text: 'started' }] };
  }, false, 'chat-A');
  assert.ok(background);
  try {
    await dispatch(shared.id, 'write_file', { path: 'while-testing.txt', content: 'still working' }, async () => {
      assert.equal(backgroundRunning, true, 'the test process must still be running during UI edits');
      await fs.writeFile(path.join(project, 'while-testing.txt'), 'still working');
      return { content: [{ type: 'text', text: 'edited' }] };
    }, false, 'chat-D');
    assert.equal(await fs.readFile(path.join(project, 'while-testing.txt'), 'utf8'), 'still working');
  } finally { backgroundRunning = false; forgetTaskRuntimeProcess(source.id, 'background-fixture'); }
  console.log('OK conflicting file/root operations wait, while file edits proceed after a long background process is launched');
} finally {
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}
