export const MCP_QUICKSTART = `
## Tool workflow (when agent_status is called)
1. Read workbench() summary for the current binding/policy, then task_handoff(action=read) when taking over work. Request workbench(view=history) only when you actually need operation history. Project memory + git state are already in MCP instructions.
   When the user explicitly addresses @Workbench to create/select a workspace or task, or says to point/bind this chat at a project/task, use workbench_control. A successful target response is authoritative for later tool calls in this session.
2. Call project_context(path) only for a different repo than WORKSPACE_PATH.
3. Explore with glob (file names) and grep (content), then read_text_file.
4. Edit with apply_patch (preferred), multi_edit, or write_file for new files.
5. Run builds/tests with run_command (short) or start_process + process_output (long).
6. Inspect workbench for task policy and approval results. Review / Undo in the local dashboard. Shell/bash file changes are not tracked.

## Output format
All tools return JSON: { ok, tool, summary, data }

## Tool cheat sheet
- glob / grep / read_text_file: explore (offset+limit for partial reads)
- apply_patch: single-file @@ hunks OR multi-file *** Begin Patch format
- create_directory / delete_directory / copy_file / move_file / delete_file
- run_command: persistent shell (cd persists); shell_status / shell_reset
- git_status / git_diff / git_add / git_commit / git_branch / git_restore / git_stash
- workbench: compact task/policy/pending summary by default; view=history returns paginated operation history; operation_id returns one approval result
- workbench_control: status and owner-enabled set_policy for this chat's task; workspace/task creation and target require Full with machine scope. Explicit user targets override startup/default project context only after the server confirms the change.
- On an explicit request for full permissions, use set_policy(mode=full, workspace_only=false, expected_revision=current revision) when capabilities.remotePolicyControl is enabled. Restore approvals with mode=ask, workspace_only=true. Workbench has no credential-content ban; report actual tool errors instead of inventing one. Connector-side checks are independent.
- task_handoff: read or update current goal, completed work, test results, remaining work, blockers and concrete next steps. Update after a verified milestone or before handing over, not after every call. Metadata updates are not covered by file Undo.
- mcp_servers / mcp_tools / mcp_call — delegate to upstream MCP servers on this machine
- A policy denial must not be retried through a different tool. Pending approvals execute once from the dashboard.

## apply_patch — single file
@@
-old line
+new line
 context unchanged

## apply_patch — multi file
*** Begin Patch
*** Update File: src/foo.ts
@@
-old
+new
*** End Patch

## Paths
Access depends on task policy. Relative paths resolve from the task workspace.
`.trim();

export function buildServerInstructions(
  workspaceRoot: string,
  workspaceRoots: string[],
  _fullDiskAccess: boolean,
  contextBlock?: string
): string {
  const header = [
    "# Codex Local Coder MCP",
    `Default project: ${workspaceRoot}`,
    "Task policy is enforced by Workbench. Check workbench once for policy and task ID. Never bypass a denial with another tool.",
    "Basic and Advanced use the same tools and permissions. Basic reuses one project task across conversations and allows one writer session. WRITER_REQUIRED means ask for write control in the local Workbench; never bypass it using shell, Git or upstream tools.",
    "When the user explicitly says the current task is done, completed, finished, or equivalent, call task_complete before replying. Do not infer completion merely because tests pass or because you think the work looks finished.",
    "When the user explicitly addresses @Workbench to create/select a workspace or task, or asks to point/bind this chat to a project/task, use workbench_control. A successful target is authoritative for subsequent tool calls even if startup instructions mention another project.",
  ].join("\n");

  const footer = [
    "## Quick pointers",
    `Workspace roots: ${workspaceRoots.join("; ")}`,
    "agent_status — full tool cheat sheet + apply_patch format",
    "project_context(path) — load CLAUDE.md from another repo",
  ].join("\n");

  const body = contextBlock?.trim();
  if (!body) return `${header}\n\n${footer}`;
  return `${header}\n\n${body}\n\n${footer}`;
}
