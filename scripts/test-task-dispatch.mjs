import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createWorkspace, createTask, selectTask, resolveSessionTask, setTaskPolicy,
  dispatch, decideOperation, getWorkbench, taskDispatchInbox, mutateTaskDispatch, switchSessionTask,
} from '../dist/lib/workbench.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'task-dispatch-test-'));
const project = path.join(root, 'project');
const otherProject = path.join(root, 'other');
await fs.mkdir(project);
await fs.mkdir(otherProject);
process.env.WORKBENCH_PATH = path.join(root, 'control');
process.env.WORKBENCH_DEFAULT_MODE = 'ask';
process.env.WORKBENCH_EXPERIENCE = 'advanced';
process.env.WORKSPACE_PATH = project;
process.env.WORKBENCH_SANDBOX_PROVIDER = 'none';

async function call(taskId, sessionId, action, options = {}) {
  const args = { action, ...options };
  return dispatch(taskId, 'task_dispatch', args, () => mutateTaskDispatch({
    taskId, sessionId, action,
    targetTaskId: args.target_task_id, targetTaskTitle: args.target_task_title,
    instruction: args.instruction, messageId: args.message_id, result: args.result,
  }), false, sessionId);
}

try {
  const workspace = await createWorkspace('Test project', project);
  const source = await createTask('Default project', undefined, workspace.id);
  const target = await createTask('Tester', undefined, workspace.id);
  const otherWorkspace = await createWorkspace('Unrelated', otherProject);
  const otherTask = await createTask('Other task', undefined, otherWorkspace.id);
  await selectTask(source.id);
  assert.equal(await resolveSessionTask('chat-A', project, 'chatgpt'), source.id);
  await switchSessionTask('chat-A', 'chatgpt', { taskId: source.id }, { taskId: source.id, sessionId: 'chat-A' });
  await selectTask(target.id);
  assert.equal(await resolveSessionTask('chat-B', project, 'chatgpt'), target.id);
  await switchSessionTask('chat-B', 'chatgpt', { taskId: target.id }, { taskId: target.id, sessionId: 'chat-B' });
  await setTaskPolicy(source.id, 'ask', true);
  await setTaskPolicy(target.id, 'full', false);

  const pending = await call(source.id, 'chat-A', 'send', {
    target_task_title: 'Tester', instruction: 'PostgreSQL is available; run real integration tests.',
  });
  const approval = JSON.parse(pending.content[0].text);
  assert.equal(approval.status, 'approval_required', 'Ask must not silently send messages');
  assert.equal((await taskDispatchInbox(target.id, 'chat-B')).total, 0, 'unapproved message is not delivered');
  const approved = await decideOperation(approval.operation_id, true);
  const id = approved.message.id;
  assert.equal(approved.message.targetTaskId, target.id);
  assert.equal(approved.message.targetSessionId, 'chat-B');
  assert.equal(approved.destination_executed, false);
  assert.equal((await taskDispatchInbox(source.id, 'chat-A')).messages[0].status, 'queued');
  assert.equal((await taskDispatchInbox(target.id, 'chat-B')).messages[0].instruction, approved.message.instruction);
  assert.equal((await getWorkbench()).agentBindings.find(item => item.sessionId === 'chat-A').taskId, source.id);
  assert.equal((await getWorkbench()).agentBindings.find(item => item.sessionId === 'chat-B').taskId, target.id);
  console.log('OK Ask approval delivers one request to the existing owner without moving either chat');

  await setTaskPolicy(source.id, 'full', false);
  await assert.rejects(call(source.id, 'chat-A', 'send', {
    target_task_id: otherTask.id, instruction: 'leak',
  }), /TASK_DISPATCH_NOT_FOUND/, 'cross-workspace routing is blocked');
  await assert.rejects(call(source.id, 'chat-A', 'claim', { message_id: id }), /TASK_DISPATCH_OWNER_REQUIRED/);
  await assert.rejects(call(target.id, 'chat-B', 'complete', { message_id: id, result: 'not done' }), /TASK_DISPATCH_CLAIM_REQUIRED/);
  assert.equal((await taskDispatchInbox(target.id, 'chat-B')).messages[0].status, 'queued');
  console.log('OK only destination owner can claim; no forged completion or cross-workspace dispatch');

  const claimed = await call(target.id, 'chat-B', 'claim', { message_id: id });
  assert.equal(claimed.message.status, 'claimed');
  const second = await call(source.id, 'chat-A', 'send', { target_task_id: target.id, instruction: 'Second test request' });
  await assert.rejects(call(target.id, 'chat-B', 'claim', { message_id: second.message.id }), /TASK_DISPATCH_BUSY/);
  const finished = await call(target.id, 'chat-B', 'complete', {
    message_id: id, result: 'Integration tests passed in the destination session.',
  });
  assert.equal(finished.message.status, 'completed');
  assert.equal((await taskDispatchInbox(source.id, 'chat-A', id)).messages[0].result, finished.message.result);
  const secondClaim = await call(target.id, 'chat-B', 'claim', { message_id: second.message.id });
  assert.equal(secondClaim.message.status, 'claimed');
  const failed = await call(target.id, 'chat-B', 'fail', { message_id: second.message.id, result: 'Database is offline.' });
  assert.equal(failed.message.status, 'failed');
  console.log('OK FIFO-style single active claim, explicit result/failure, source can read outcomes');

  const cancelled = await call(source.id, 'chat-A', 'send', { target_task_id: target.id, instruction: 'Cancelled work' });
  assert.equal((await call(source.id, 'chat-A', 'cancel', { message_id: cancelled.message.id })).message.status, 'cancelled');
  await assert.rejects(call(target.id, 'chat-B', 'claim', { message_id: cancelled.message.id }), /TASK_DISPATCH_NOT_QUEUED/);
  const saved = JSON.parse(await fs.readFile(path.join(root, 'control', 'state.json'), 'utf8'));
  assert.equal(saved.taskMessages.find(item => item.id === id).status, 'completed');
  assert.equal(saved.taskMessages.find(item => item.id === cancelled.message.id).status, 'cancelled');
  console.log('OK durable mailbox persists results and cancellation in Workbench state');

  await resolveSessionTask('chat-C', project, 'chatgpt');
  await switchSessionTask('chat-C', 'chatgpt', { taskId: target.id }, { taskId: target.id, sessionId: 'chat-C' });
  const shared = await call(source.id, 'chat-A', 'send', { target_task_id: target.id, instruction: 'Shared task request' });
  assert.equal(shared.message.targetSessionId, undefined, 'multiple conversations produce a task inbox, not an ambiguous owner error');
  const claims = await Promise.allSettled(['chat-B', 'chat-C'].map(session =>
    call(target.id, session, 'claim', { message_id: shared.message.id })));
  assert.equal(claims.filter(result => result.status === 'fulfilled').length, 1, 'only one conversation executes a queued request');
  const winner = claims.find(result => result.status === 'fulfilled').value.message.claimedBySessionId;
  await call(target.id, winner, 'complete', { message_id: shared.message.id, result: 'Executed once' });
  console.log('OK shared-task mailbox supports multiple conversations and claims each request exactly once');
} finally {
  await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
