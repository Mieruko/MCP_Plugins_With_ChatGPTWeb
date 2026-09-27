// Pure helpers for the multi-window launcher. Slots are human-selected plans,
// never evidence that a particular ChatGPT browser window owns an MCP session.
export function taskCheckout(task) {
  return String(task?.execution?.path || task?.workspace || '').replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
}

export function slotIssue(task, tasks, selectedIds, index, agents = []) {
  if (!task) return 'Choose a task before opening this window.';
  if (!['open', 'blocked'].includes(task.lifecycle)) return 'This task is not open for work.';
  return '';
}

export function sharedCheckoutWarning(task, tasks, selectedIds, index) {
  if (!task) return '';
  return selectedIds.some((id, other) => other !== index
    && tasks.some(item => item.id === id && taskCheckout(item) === taskCheckout(task)))
    ? 'Shared checkout: different-file edits can overlap; same-file, shell and Git mutations are serialized. Background processes may outlive tool locks. Coordinate shared resources; uncommitted edits are visible to both tasks.'
    : '';
}

export function assignmentPrompt(task, workspace, instruction = '') {
  if (!task?.id || !workspace?.id || task.workspaceId !== workspace.id) throw new Error('Task is not in the selected workspace');
  return [
    '@Coder Assign THIS ChatGPT conversation to the existing task in this workspace (do not dispatch to another chat):',
    `Workspace ID: ${workspace.id}`,
    `Task: ${task.title}`,
    `Task ID: ${task.id}`,
    'Call workbench_control(action=target, task_id=the Task ID above, create_missing=false) in this conversation.',
    'Then call workbench(view=status, expected_task_id=the Task ID above) and require verification.matches=true before modifying files or running commands. On later scheduled runs verify this read-only status first; if already matched, do not call target again. Stop on any client safety denial without changing tools or policy.',
    'Other chats may use this task too. Keep this conversation on the requested task regardless of Dashboard selection. Report actual permission errors; never work in a fallback task.',
    'If another task shares this checkout, different-file MCP edits can overlap, while same-file, shell and Git mutations are serialized. Background processes can continue after launch. Coordinate resources; both tasks see uncommitted changes. Do not reset, restore, stash, clean or commit the other task\'s work.',
    ...(instruction.trim() ? ['', 'After successful verification, perform this task:', instruction.trim()] : []),
  ].join('\n');
}
