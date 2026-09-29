# Workbench reference

[Back to README](../README.md) · [Setup guide](setup.md) · [Computer Use](computer-use.md)

## Architecture

```text
┌────────────────────┐       HTTPS / MCP       ┌─────────────────────────────┐
│    ChatGPT Web     │ ───────────────────────► │ MCP Plugins With ChatGPT Web│
│ Connector / OAuth  │                          │ MCP server                  │
└────────────────────┘                          └──────────────┬──────────────┘
                                                            │
                                         ┌──────────────────┴──────────────────┐
                                         │                                     │
                                ┌────────▼────────┐                   ┌────────▼────────┐
                                │ Local Workbench │                   │ Coding tools     │
                                │ localhost only  │                   │ Files/Shell/Git  │
                                └────────┬────────┘                   └─────────────────┘
                                         │
                     ┌───────────────────┼────────────────────┐
                     ▼                   ▼                    ▼
                 Workspaces            Tasks             Active agents
                 Explorer/Search       Policy/History    MCP sessions
                 Editor/Diff           Checkpoints       Task binding
```

## Workbench

Open:

```text
http://127.0.0.1:3001/ui/workbench.html
```

The admin server is bound to localhost. Authentication credentials are generated/stored locally when explicit environment overrides are not configured.

### Basic and Advanced experiences

**Basic is recommended** for everyday coding, including continuing the same project across ChatGPT conversations. New projects open in Basic: one project, a default task managed internally, full coding tools, approval requests, grouped recent work, Review and Undo/Redo. On a fresh installation, the configured `WORKSPACE_PATH` is opened automatically. Additional project folders can be added from the project switcher.

| Experience | Choose it when | Coding tools |
| --- | --- | --- |
| **Basic · Recommended** | You want ChatGPT to work on a project with straightforward review and Undo. | Complete tool registry; one writer conversation at a time. |
| **Advanced** | You need separate tasks, parallel worktrees, previews and a merge queue. | Same tools; additional coordination controls. |

Use the **Basic / Advanced** button beside Permissions, or **Settings → Experience**, to change the current project's experience. **Advanced** exposes the existing tasks, agent coordinator, worktrees, preview runtimes and integration queue. Files, task history and existing session bindings are preserved. Finish/discard active parallel work, resolve approvals and stop runtimes before returning to Basic; the dialog lists any blockers.

Basic allows one MCP conversation to control changes at a time. The first mutation claims write control; other conversations can read. Open **ChatGPT write control → Choose conversation → Give write control** to transfer it. Transfers invalidate old pending approvals and wait until managed processes and preview ports have been released. The chosen conversation must retry its rejected request. This check also applies to shell, Git and upstream mutations, including in Full permission mode.

Existing saved projects retain **Advanced** when upgrading. `WORKBENCH_EXPERIENCE=basic|advanced` sets the default for new projects only; it does not change saved projects, approval settings (`WORKBENCH_DEFAULT_MODE`) or exposed tools (`CHATGPT_TOOL_PROFILE`). See [experience behavior and limitations](experience.md).

### Workspaces, tasks and session binding

A **Workspace** represents a local project directory. A workspace may exist before it has any task.

A **Task** represents a unit of work inside one workspace and carries its own permission policy and operation history.

Known ChatGPT conversations retain their task binding across reconnects. A new conversation in an Advanced workspace with multiple tasks must explicitly select and confirm its intended task before project work. Changing the Dashboard selection does not retarget an already-bound conversation.

#### Independent parallel ChatGPT windows (Advanced)

Open **Chats** in Workbench, choose one existing task for each window, and select the 1–4 window layout. The launcher permits multiple conversations on an existing task, including tasks with active chats or pending launch assignments. Distinct tasks may share a checkout: the launcher warns instead of blocking them. Each card has its own local draft and a **Copy prompt** action containing the exact workspace/task IDs and a verified `workbench_control(action=target, task_id=..., create_missing=false)` instruction. Paste that prompt into **that window**, let it target and verify its own session/task, then send the task instructions. Do not use `task_dispatch` for assigning a task to the chat in which you are typing.

ChatGPT tool calls carrying `_meta["openai/session"]` use a persistent conversation binding, separate from the MCP transport. Reconnecting, sharing a transport, restarting the server or selecting a different Dashboard task does not move a bound conversation. A new conversation explicitly selects its intended task in a multi-task workspace. Clients without conversation metadata retain explicit transport-scoped selection; they must select again on a new transport. Once a transport uses conversation metadata, missing metadata is rejected rather than silently falling back. Opening a launcher window alone does not assign work. Same-workspace selection works under Ask, including an explicit matching workspace ID, and does not wait behind another chat's busy checkout. Run `npm run test:routing` for real HTTP reconnect, restart, shared-transport concurrency and approval tests.

Mutating MCP operations on distinct worktrees overlap. On the **same checkout**, independently targeted single-file MCP edits can overlap; same-file edits are serialized. Shell, Git, multi-file/unknown writes, Undo and other checkout-wide mutations retain a root lock because their write sets cannot safely be inferred. A long `run_command` holds that lock until it finishes; prefer `start_process` for a genuinely background test, which releases its launch lock after starting. Running processes can still modify files/databases after launch, so coordinate these manually. Both tasks see uncommitted edits: check stale changes, agree on file ownership, and never reset, restore, stash, clean or commit another task's work. Shared Docker containers, preview ports and test databases also require coordination or isolation. This workflow does not auto-start ChatGPT turns, create tasks without permission, merge, discard or push files.

Run `npm run test:parallel` to validate provisional/confirmed session routing, parallel writes to three distinct files in one checkout, same-file/root conflicts, and work continuing after a background process starts. Existing saved worktrees and uncommitted changes are not migrated or deleted by this launcher.

#### Same-workspace task dispatch (Advanced)

From a ChatGPT conversation already bound to one task, you can request work for a different task in the **same** Advanced workspace: `@Coder task Tester: PostgreSQL is ready; run integration tests.` The agent selects Tester with `workbench_control(action=target, task_title="Tester", create_missing=false)`, loads `project_context`, and performs the work in the current conversation under Tester's policy. Other conversations keep running their tasks. Use `task_dispatch(action=send, ...)` only when explicitly asking to send a message to another chat; it queues work without executing it.

When the **Tester conversation receives its next user turn**, it can call `task_dispatch(action=list)`, then `action=claim`, perform the work with its existing task-scoped tools, and report the actual result via `action=complete` or `action=fail`. The sending conversation can read the result with `action=status` and the message ID. One request per destination task can be claimed at a time; additional requests remain queued. Cross-workspace requests, non-owner claims and premature completions are rejected. Dispatch mutations respect the sending or receiving task's normal Ask/Auto/Full policy, including approval when required.

**Host limitation:** This is a durable task mailbox and owner-driven execution, **not** autonomous cross-chat execution. A self-hosted MCP tool cannot create a ChatGPT turn, wake an idle ChatGPT Web tab, type into another conversation, or post the owner's model reply into the ChatGPT UI. Sending a message only means it was queued. The owner must resume its conversation to claim and run it. After updating the server, restart it and refresh the ChatGPT connector/start new conversations to discover `task_dispatch`; do not restart the MCP server during active calls.

The Workbench currently provides:

- **Workspace switcher** — register and switch between local project folders;
- **Explorer** — browse project directories and open files;
- **Search** — grep/glob project contents;
- **Editor** — inspect and edit text files using Monaco;
- **Changes** — staged, modified and untracked Git state;
- **Review** — operation-level and Git-style diffs with additions/deletions;
- **Terminal** — foreground commands and managed background jobs;
- **Active Agents** — real active MCP sessions instead of historical/stale session counts;
- **History** — task operations, checkpoints and restore actions;
- **MCP Settings** — inspect/import upstream MCP servers;
- **System Settings** — environment/context/runtime diagnostics.

## MCP tools

The server supports a `slim` profile optimized for ChatGPT Web and a `full` profile for exposing the complete local tool set.

Core capabilities include:

| Area | Examples |
| --- | --- |
| Workbench | `workbench`, `workbench_control`, `task_handoff`, `task_complete` |
| Computer Use (opt-in) | `computer_session`, `computer_observe`, `computer_act`, `computer_upload`, `computer_job` |
| Batched inspection | `inspect_code` |
| Files | `read_text_file`, `write_file`, `edit_file`, `multi_edit`, `apply_patch` |
| Search | `glob`, `grep`, `list_directory` |
| Shell | `run_command`, `shell_status` |
| Processes | `start_process`, `process_output`, `stop_process` |
| Git | `git_status`, `git_diff`, `git_add`, `git_commit`, `git_restore` |
| Git remote | `git_fetch`, `git_pull`, `git_push` |
| Git structure | `git_branch`, `git_worktree`, `git_log` |
| Project context | `agent_status`, `project_context`, `load_path_rules`, `skills`, `remember` |
| History | `rewind` |
| GitHub | `github` |
| MCP hub | `mcp_servers` and upstream MCP proxy tools |

Tool responses use structured data so ChatGPT can reason over results without scraping terminal text where a structured representation is available.

## Git and GitHub integration

### Local Git

If a workspace is a Git repository, the Workbench/MCP tools can work with its existing repository state and remotes.

Supported workflows include:

- branch/ahead/behind status;
- working and staged diffs;
- explicit staging/unstaging;
- commits;
- branch switching/creation;
- worktrees;
- fetch;
- fast-forward-only pull;
- explicit-branch push.

Remote write operations remain subject to the active Workbench permission policy.

### GitHub integration

Install GitHub CLI and authenticate locally:

```powershell
gh auth login
gh auth status
```

GitHub support currently includes:

- list/view pull requests;
- inspect pull-request checks;
- create an explicit draft PR from an already-pushed branch;
- merge a reviewed exact head SHA;
- list/view issues.

GitHub credentials stay with the local `gh` installation. Do not place GitHub tokens in prompts, README files or committed environment files.

## Permissions and security

Each task has a permission mode:

| Mode | Behavior |
| --- | --- |
| **Ask** | Read operations run; mutations require local approval. |
| **Auto / Approve for me** | Supported safe edits can be approved by deterministic rules; higher-risk operations still require approval. |
| **Full** | Workbench approval prompts are disabled for the task. |

The workspace-only scope is independent from the approval mode.

### Change permissions from chat

The owner can enable conversational permission control once in the server's local `.env`:

```dotenv
WORKBENCH_REMOTE_POLICY_CONTROL=true
```

After restarting the server and refreshing the connector's tool definitions, say **“Bật Full quyền cho task này”**. The agent reads the current policy revision and calls `workbench_control(action=set_policy, mode=full, workspace_only=false, expected_revision=...)`. Say **“Tắt Full, hỏi trước khi sửa”** to return to Ask with workspace-only scope. Auto is also supported. Set the installation option back to `false` to disable conversational policy changes.

This opt-in authorizes authenticated MCP conversations to change their bound task's policy. It does not grant another conversation the Basic writer lease. Policy changes are recorded in history and expire existing pending approvals without executing them. Full does not automatically carry over when targeting another project. Workspace/task creation and switching to another workspace require Full with machine scope on the source task. Selecting an existing task in the same Advanced workspace does not require Full. Resolve pending approvals and stop running processes/previews before retargeting.

Workbench has no content filter that prohibits application account creation, credentials, or password seed files. Full allows the normal file/command tools to perform user-authorized setup. Client/connector review is independent: report its actual error if it rejects a request before it reaches this server. Changing Workbench permissions cannot disable that separate layer.

History returns bounded summaries without pending file bodies or command arguments. Handoff approvals detect intervening changes and preserve the newer handoff on conflict.

### Workspace path protection

Workspace-bound file operations use canonical path checks and protections for traversal and filesystem indirection. Workbench state/control files are kept outside normal project access.

### Optional Docker sandbox

Docker sandboxing is **opt-in**:

```dotenv
WORKBENCH_SANDBOX_PROVIDER=docker
WORKBENCH_SANDBOX_IMAGE=node:22-bookworm
```

Pull the image yourself before enabling it:

```powershell
docker pull node:22-bookworm
```

When active, supported workspace-only shell/local Git execution uses a constrained container with the task workspace mounted read/write and network disabled. The server intentionally does not auto-pull images.

GitHub operations, remote Git, upstream MCP calls and project Preview require machine/network scope and are not claimed to run inside that no-network sandbox.

## Review, checkpoints and Undo

Supported file mutations are journaled per task.

The Workbench can retain before/after snapshots for review and can restore recorded file states when conflict checks pass.

Important behavior:

- pending edits can be reviewed before approval;
- approval is bound to the operation/version that was reviewed;
- external concurrent file changes can invalidate an approval/restore;
- task checkpoints provide timeline boundaries;
- Undo/Redo/checkpoint restore apply to tracked file changes;
- shell commands, Git remote actions and other external side effects are reported separately and are **not falsely claimed to be undone**.

## Active Agents and session recovery

MCP sessions are tracked with their task/workspace identity, client metadata and last activity.

Session recovery can be enabled with:

```dotenv
MCP_SESSION_RECOVERY=true
```

Known session-to-task mappings are persisted so a recovered session remains associated with its original task after a server restart.

## Upstream MCP hub

The project can connect to other local/upstream MCP servers and expose selected tools through this server.

Configuration defaults to:

```dotenv
MCP_UPSTREAM_CONFIG=profiles/mcp-upstream.json
```

The Workbench can inspect configured upstream servers and includes import flows for supported MCP configuration formats.

## Development

```powershell
npm install
npm run build
npm test
```

Useful commands:

```powershell
npm run dev
npm run test:workbench
npm run test:chatgpt
npm run test:integration
node scripts/run-all-tests.mjs --readiness-only
```

The main source is TypeScript under `src/`; the Workbench frontend is under `public/ui/`.

## Repository remotes for this fork

Recommended local setup:

```text
origin   https://github.com/Mieruko/MCP_Plugins_With_ChatGPTWeb.git
upstream https://github.com/hoangcoderr/chatgpt-local-coder.git
```

Fetch upstream changes with:

```powershell
git fetch upstream
```

Review upstream changes before merging or rebasing them into your development branch. This fork has diverged substantially, so upstream updates should not be assumed to apply cleanly.
