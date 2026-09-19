# Basic and Advanced experiences

Both experiences use the same MCP server, tool registry, task dispatcher, permission checks, operation journal, Git handlers and process manager. Experience is saved on each workspace; it is independent of permission mode and tool profile.

## Basic — recommended

Basic is the recommended v1 experience for everyday coding and the default for new projects. Choose Advanced when you need multiple tasks, managed worktrees and an integration queue. Basic has the same coding tools; it simplifies coordination rather than restricting tool access.

- Fresh installations open the configured project with a standard local task. Adding a new Basic project also creates that task immediately.
- The UI shows the project instead of its internal task. Creating additional tasks and reserving agent assignments requires Advanced, including through the local API.
- New conversations use the selected Basic project's default task. Existing session bindings remain pinned when the selected project changes.
- Explorer, editing, shell/process tools, Git, approval review, checkpoints and Undo/Redo remain available. Tool discovery is identical in both experiences.
- Recent work groups recorded file edits by persisted ReviewRun. A ChatGPT turn can include edits, commands and reads without splitting the review; only net file changes are rendered. Review retains line numbers, additions/deletions and syntax coloring. Git changes and staged/unstaged controls remain available when Git access is permitted.
- The permission UI presents **Ask for approval**, **Approve for me** and **Full access** as presets, with workspace/machine scope under Advanced scope. Workspace-only commands still require the configured OS sandbox.

## Write control

Every MCP mutation in a Basic project checks the writer under the existing workspace execution lock. The first mutation claims the writer. Reads do not claim it. A different session receives `WRITER_REQUIRED` before execution or an approval request is created. The gate covers file edits, shell, Git mutations and upstream calls; it is independent of Ask/Auto/Full.

`workbench` reports the experience, the calling session's label and its write-control status. The local UI lists bound conversations under **ChatGPT write control → Choose conversation**. A human can explicitly grant control to another open session. The transfer compares the previous writer to detect stale UI requests, invalidates pending approvals and refuses while any managed process or preview lease remains in the project. A rejected operation is not queued for replay: the new writer submits a fresh request.

`task_handoff(action=read)` is also available to non-writer Basic sessions so another conversation can understand the current task before taking control. `task_handoff(action=update)` is a mutation: the current writer/lifecycle checks still apply. In Ask it creates one approval request; Auto/Full can update this bounded metadata after the same writer checks. Approval replay rechecks the relevant state and runs once; deny/expiry leaves the previous handoff unchanged.

The default `workbench()` response is intentionally compact and reports only attention-worthy operation summaries plus a short handoff excerpt. Full handoff text is read through `task_handoff`; operation history is requested explicitly with `workbench(view=history)`, and one approved operation result with `workbench(operation_id=...)`.

The writer is saved across restarts. Idle time is not treated as the end of a conversation. A disconnected previous writer can be replaced through the same UI after managed work is stopped. Local human actions remain available and continue through the common dispatcher and policy checks.

This is coordination of MCP operations, not an OS sandbox. External editors, deliberately detached commands and processes not managed by Workbench are outside its guarantees. Shell side effects are still not undoable. Use the existing workspace sandbox for an OS boundary; machine-scope commands have the server account's access.

## Switching experiences

Use the experience button or **Settings → Experience**. Basic → Advanced reveals the existing task and history, retains session identities and does not create a branch, change permissions or modify project files. Pending approvals are invalidated if coordination changes.

Advanced → Basic checks active parallel tasks, unresolved worktree cleanup, queued assignments, pending/running operations, managed processes, preview leases and sessions still attached to other active tasks. The response and UI explain blockers. Completed history is retained; Basic's recent-work view follows its default task. Switch to Advanced to inspect other task histories.

Old workspace records without an experience field migrate to Advanced. `WORKBENCH_EXPERIENCE` defaults to `basic` and applies only when creating new workspaces. The state format is additive; existing task IDs, snapshots and session bindings are retained.

## Advanced orchestration

### User-assigned parallel ChatGPT sessions

The **Chats** launcher exposes four independently selectable task slots. It displays the selected task rather than pairing sorted Agent Coordinator rows with arbitrary browser window numbers. A per-workspace local draft preserves each selection. Multiple windows may select the same task, including tasks with active conversations or queued assignments. Shared execution directories display a warning instead of blocking selection. Each slot copies a prompt that asks **that** ChatGPT conversation to target the existing task by exact ID, verify `workbench_control(action=status)` and load its own context before work. The host supplies `_meta["openai/session"]` on supported ChatGPT tool calls. Workbench namespaces and hashes it using the authenticated connection principal and stores a persistent conversation binding. Opening a slot alone is not a server-side assignment; two tabs of the same conversation share one binding. Never assume agents ordered by activity correspond to browser windows.

In Advanced, a fresh MCP transport can initially share the dashboard-selected fallback task with other transports. With multiple runnable tasks this fallback is **unconfirmed**: only task inspection/status and explicit target are available until the session targets the intended task (even if its ID matches the fallback). Task bindings are selections, not exclusive ownership. A known host conversation retains its task across new transports and server restart. Requests on a shared transport have separate async contexts and can run concurrently. Without host conversation metadata, legacy clients must explicitly select again after reconnecting; a transport already using conversation routing rejects missing metadata. `switchSessionTask` coordinates metadata without blocking on a different session's long-running source-checkout command, but its own pending operations/processes still prevent a move.

Resource locks are hierarchical: whitelisted known single-file MCP edits on different paths can overlap on one checkout; the same file serializes, as do shell/Git, unknown or multi-file writes and root-wide operations. Approval execution uses the same resource key and retains stale-write checks. Long foreground `run_command` calls hold the conservative root lock; `start_process` releases the launch lock on return, while its background process remains outside the lock. Coordinate or isolate shared files, databases, Docker resources and ports; don't commit/reset someone else's working tree changes.

Run `npm run test:parallel` for shared-task selection, provisional binding confirmation, busy-source retarget, three simultaneous worktree operations, simultaneous distinct-file edits in a shared checkout, same-file/root serialization and background-process overlap. Existing saved branches, worktrees and uncommitted work are not modified by the launcher.

Advanced tasks can reserve ChatGPT assignment leases with either managed worktrees or local checkouts. A unique queued lease is claimed atomically regardless of the dashboard workspace; with multiple queued leases, a new ChatGPT session claims the oldest lease in the selected workspace, not a global FIFO across workspaces. Initialization fails with `AGENT_ASSIGNMENT_AMBIGUOUS` when multiple leases exist but none belongs to the selected workspace. Claims record `claimedAt` / `claimedBySessionId`. Terminal `claimed`, `expired` and `cancelled` leases remain in bounded history; the public queue exposes only live `queued` leases. Dashboard task selection does not retarget already-bound conversations.

An explicit `workbench_control(action=target, task_title=<existing task>, create_missing=false)` request switches only the calling chat within its current workspace, without requiring Full machine scope. Workbench refuses task-name ambiguity and moving the calling conversation while its own operations or managed processes remain active. Other chats and reservations do not block selecting an existing task, and an explicit matching workspace selector does not require Full. It does not select another dashboard task. After success, call `project_context` to reload the destination task's instructions. Creating tasks, accessing another workspace and changing permission policy retain their independent authorization checks.

For an explicit request to **send a message to another chat**, use `task_dispatch(action=send, target_task_title=..., instruction=...)` instead of retargeting. It writes a durable, same-workspace message under the sender's task authorization without changing either task binding. In the destination chat's next turn, use `task_dispatch(action=list)`, `action=claim`, run the tools there, and `action=complete`/`fail` with an actual result; sender reads the result using `action=status` and its message ID. One active claim per destination task; excess instructions remain queued. Cross-workspace access and non-owner claim/finish are blocked. The tool is included in slim and full ChatGPT tool profiles, and its mutations follow Ask/Auto/Full approvals. `npm run test:dispatch` exercises routing, isolation and persistence.

The MCP server **cannot wake or inject messages into another ChatGPT Web conversation**: queued does not mean executing. Each destination conversation requires its own user turn to claim and do the work, and the result remains in Workbench until the sender reads it. Genuine unattended execution with replies appearing inside an idle ChatGPT window requires separate, supported ChatGPT host orchestration APIs that this project does not have; no browser automation or fake "completed" status is implied.

An orchestrator can create a bounded child task without changing the dashboard-selected task. Parent metadata records `parentTaskId`, the creating session and a delegation scope. A child delegated or reserved for another ChatGPT session defaults to a managed worktree; explicitly local children remain local-only and cannot later be queued for a second ChatGPT session. The parent `workbench(view=children)` view may expose child lifecycle/status and handoff according to that scope, but does not expose raw child operation arguments or results. Managed worktree/integration rules continue to own merge and conflict handling.

## Implementation

- `src/lib/experience.ts`: experience and writer types and the new-project default.
- `src/lib/workbench.ts`: persisted workspace experience, default-task routing, transition checks and writer enforcement at dispatch.
- `src/admin/workbench-routes.ts`: authenticated experience, writer and recent-work endpoints.
- `public/ui/workbench/experience.js`: presentation, mode switching and writer controls.
- `scripts/test-experience.mjs`: HTTP/MCP integration tests with isolated projects, concurrent sessions, real background processes, restart recovery and legacy-state migration.

Run `npm run test:experience` for the focused suite or `npm test` for regression coverage. A disposable UI fixture is available with `EXPERIENCE_UI_PREVIEW_SECONDS=300` when invoking the focused test script after building; it prints its local URL and cleans up after the timeout.

This implementation establishes the two experiences. Verification gates, declared file ownership, shared contracts, GPT-assisted conflict resolution and reviewer/resource-manager workflows remain later roadmap work.
