# Local Coder Workbench — implementation and setup

This branch implements a local coding-agent control plane around the MCP server. It does not provide complete Codex/IDE parity, but the Workbench now exposes real task-scoped project browsing, search, process management, review, Git controls, checkpoints, preview and session/runtime state rather than dashboard-only placeholders.

## Separate main and development

- `D:\chatgpt-local-coder`: main checkout. Existing package-lock changes and diagnostics remain here.
- `D:\chatgpt-local-coder-workbench`: `codex/local-agent-workbench` worktree.
- A branch names commits; a worktree provides a separate working directory. Uncommitted files can follow `git switch`, which is why this work uses separate directories.
- No feature commits have been pushed or merged into main. Earlier ChatGPT performance changes are included on the feature branch.

## Setup

Run commands in the **workbench** directory, not the main checkout:

```powershell
cd D:\chatgpt-local-coder-workbench
npm install
Copy-Item .env.example .env   # only if .env does not already exist
# Edit WORKSPACE_PATH to the project you want to work on.
npm run build
npm start
```

If main is already running, set different `PORT` and `ADMIN_PORT` values. Use a separate `WORKBENCH_PATH` for each running Workbench server; the JSON store is single-process. Do not put it inside a project or sync it to Git.

Open `http://127.0.0.1:3001/ui/workbench.html` (or your configured admin port). The server prints the **location**, not the contents, of `credentials.json` on startup. Open that file locally and enter its `admin` value in the dashboard. Do not paste credentials into ChatGPT. `ADMIN_TOKEN` overrides the generated admin credential; `MCP_AUTH_TOKEN` overrides the generated static MCP credential.

Credentials, task snapshots and OAuth grants are stored under `%USERPROFILE%\.chatgpt-local-coder\workbench` by default. Tokens are kept only in dashboard memory, not localStorage. Snapshot contents are not encrypted; they can contain project secrets. Preserve this directory if you need Undo history.

### Connect ChatGPT with OAuth

1. Expose the MCP port through your HTTPS tunnel. Keep the admin port local.
2. Set `PUBLIC_BASE_URL` to the tunnel's exact HTTPS origin, without `/mcp`, and restart the server. A stable origin avoids invalidating OAuth metadata and grants when a quick tunnel changes.
3. Configure the ChatGPT connector with `<PUBLIC_BASE_URL>/mcp` and OAuth authentication. The server exposes authorization metadata, protected-resource metadata, dynamic registration, PKCE code exchange, refresh and revocation endpoints through the MCP SDK.
4. The authorization page displays a connection request ID. Open the local Workbench, compare that ID and the callback URI, and approve the connection you initiated.
5. The authorization page returns to ChatGPT automatically. In a new chat, select the connector and ask it to call `workbench` once to inspect the task and policy.

Default callback support covers ChatGPT's `https://chatgpt.com/connector/oauth/<callback_id>` and legacy `https://chatgpt.com/connector_platform_oauth_redirect`. Additional callbacks must be explicitly listed in `OAUTH_REDIRECT_URIS`, separated by semicolons. Never derive the issuer from an untrusted Host header.

The full OAuth flow is tested locally, including PKCE failures, resource audience, code reuse, refresh rotation, restart persistence and revocation. Actual login/rendering in a live ChatGPT account is still an external verification step; host configuration can vary. See [OpenAI authentication documentation](https://developers.openai.com/plugins/build/auth).

### GitHub

Install Git and GitHub CLI separately. Authenticate locally with `gh auth login`. Use `gh auth setup-git` only if you want Git to use gh's credential helper. Do not send the token to the model.

The GitHub tool supports issue list/view, PR list/view/checks, creating a draft PR from an explicitly pushed `owner:branch`, and merging an exact reviewed head SHA. It does not create a fork or silently push as part of PR creation. Merge has no admin/bypass flag. No real GitHub writes are made by the tests.

## Permissions and approvals

| Mode | Behavior |
| --- | --- |
| Ask for approval | Reads run; mutations require one local approval. |
| Approve for me | Server-side rules auto-approve routine workspace edits and bounded task metadata. Commands, Git mutations, destructive/control actions and network/external effects still require local approval. |
| Full access | Authorized mutations run without a Workbench approval prompt. The UI defaults this preset to machine scope; Advanced scope can explicitly re-enable workspace-only isolation. |

The three choices are permission presets. **Advanced scope** exposes the underlying workspace-only switch for installations that need a custom combination. The centralized decision engine records a server-classified risk level, reason code and effects for every dispatched mutation; it does not trust model annotations. Workspace-only validates canonical paths, nonexistent destinations through their nearest existing ancestor, junctions and hard links. File operations are bounded to the task workspace; the control store is inaccessible through file tools. Process execution is fail-closed unless an OS sandbox provider is explicitly configured and healthy. The first provider is Docker: shell and supported local Git commands run in a short-lived container with only the task workspace bind-mounted read/write, `network=none`, dropped Linux capabilities, `no-new-privileges`, a read-only root filesystem, non-root user and CPU/memory/PID limits. GitHub, upstream MCP calls, remote Git and Preview start still require machine scope. Post-edit hooks do not run implicitly after an approved file edit.

Docker sandboxing is opt-in. Install Docker Desktop / Docker Engine, pull the configured image yourself, then set `WORKBENCH_SANDBOX_PROVIDER=docker`. The server intentionally does **not** pull images automatically. The active Docker endpoint must be local (`unix://` or Windows `npipe://`); inherited `DOCKER_HOST` / `DOCKER_CONTEXT` overrides are stripped and remote Docker endpoints are rejected. The default image is `node:22-bookworm`; change `WORKBENCH_SANDBOX_IMAGE` when the project needs another toolchain. Workspace-only shell commands run through POSIX `sh` inside that image, not the host PowerShell. `WORKBENCH_SANDBOX_USER` must be non-root; memory, CPU and PID limits are configurable in `.env.example`.

Changing policy invalidates pending approvals. An approval expires after 15 minutes, binds to a stored tool request, and executes at most once. Repeating the same already-applied decision is idempotent and does not replay the operation: repeated approve on an already approved/running/completed/failed operation, or repeated deny on a denied operation, returns the recorded state. An opposite terminal decision returns HTTP `409`; expired or interrupted approvals return HTTP `410` with `APPROVAL_GONE` and never masquerade as a successful approval. File changes while waiting cause `APPROVAL_CONFLICT`. Git mutation approvals fingerprint HEAD, index, tracked working changes and local configuration so a different staged version is not accidentally committed. This does not sandbox arbitrary shell commands or undo their side effects.

The model receives `approval_required` and must **not resubmit** the operation. After approval, it retrieves the original result with `workbench(operation_id)`. Server restarts invalidate pending/in-progress requests; they are never replayed automatically.

## Tasks and Review

Create/select tasks in the dashboard. Existing sessions remain pinned to their task. In Advanced mode, reserving a task for another ChatGPT session requires a managed worktree; a shared local checkout cannot be queued for another agent. A unique live ChatGPT assignment lease is claimed independently of whichever workspace happens to be open in the dashboard. To launch several queued agents, select their **workspace** in Workbench and open a new ChatGPT session for each: each session atomically claims the oldest unclaimed lease in that workspace, even when a different task is selected. Multiple leases across other workspaces are never consumed by a global FIFO; when none belong to the selected workspace, initialization fails closed with `AGENT_ASSIGNMENT_AMBIGUOUS`. The dashboard task selection never retargets an existing session. Parent tasks can delegate bounded child tasks and read only delegated child status/handoff data; a delegated/queued child defaults to a managed worktree, while an explicitly local child cannot be queued for another ChatGPT session. Raw child operation arguments/results are not exposed through the parent view. MCP session identity is not treated as a chat-turn identity.

Initialization loads only the bound task's workspace instructions. Known session-to-task mappings and assignment lease terminal history are persisted so recovery after a restart retains ownership and diagnostics. Dashboard selection does not retarget an already bound session.

Each mutation is associated with a persisted **ReviewRun**. When the MCP host supplies a stable turn/run identity through supported metadata or headers, its value is hashed and defines the run boundary; raw turn values are not persisted. When no host identity is available, Workbench closes the active run after the session becomes request-quiescent (`WORKBENCH_REVIEW_QUIESCENCE_MS`, default 15 seconds), with the longer ReviewRun timeout retained only as a backstop. Edit → command/test/Git → edit within the active turn remains one ReviewRun. Only file-changing operations contribute to the net diff, repeated edits to one path collapse from the first snapshot to the final snapshot, and net-zero paths disappear. Legacy `change-set` endpoints remain aliases for compatibility. Synthetic MCP fixtures cover both metadata/header identities and the no-ID quiescence fallback; whether a particular live ChatGPT connector supplies a stable host turn field remains an external integration detail rather than a server assumption.

File tool checkpoints feed a before/after task journal. Pending supported file mutations also receive an in-memory preflight diff before approval; the operation list carries only summary metadata while the local review endpoint returns the full diff. Approval remains bound to the original snapshot, so a concurrent file change still causes `APPROVAL_CONFLICT`.

Review shows the actual snapshots independently of Git's index or HEAD. Undo/Redo work per operation/file and atomically across a ReviewRun: every affected path is validated before writing, and an I/O failure after partial restore triggers best-effort rollback of already-restored paths before journal state is committed. User modifications cause `UNDO_CONFLICT` and are retained. Changes made before the task are preserved in the recorded baseline.

Task checkpoints are journal boundaries and are now the canonical restore model for both Workbench History and the compatibility `rewind` tool. A checkpoint preview computes every file that would change and refuses the whole restore if any recorded state no longer matches (`CHECKPOINT_CONFLICT`). Restoring an older checkpoint marks the affected journal changes undone and discards later checkpoints on that task timeline. Shell, Git and remote operations after the checkpoint are reported separately as external side effects and are never claimed to be rolled back. The older standalone snapshot store remains only for direct/non-Workbench compatibility and is not populated during normal task-scoped MCP operations.

Git controls cover structured branch/ahead/behind status, staged/modified/untracked file groups, per-file working/staged diff, explicit file staging/unstaging, commit, branch/worktree creation, fetch and push. Commit defaults to **already staged files**, never `git add -A`. Push requires an explicit branch. Pull is fast-forward-only. Worktree creation provides a separate checkout; ordinary branch switching does not isolate uncommitted changes.

State is written before file edits and after each restore step. A failed multi-file operation can have partial changes, and these remain reviewable. File contents and modes are captured, not Windows ACLs or all filesystem metadata. Large trees/files are rejected rather than silently skipped (2000 paths / 32 MiB per capture).

## Live synchronization

Workbench state carries a monotonically increasing revision. The local UI uses same-origin `EventSource` with SSE event IDs, automatic reconnect, replay from `Last-Event-ID`/`afterRevision`, a bounded server ring buffer and revision-gap full refresh. A 15-second polling fallback keeps its own revision cursor and refreshes Changes, Workspace Review and History when it detects a missed update. State/changes loaders use generation guards so a response from a previously selected task cannot overwrite the current view. The stream and timers are closed on page unload.

## Workbench project/runtime panels

The dashboard reuses the same tool handlers and Workbench dispatcher used by MCP sessions instead of implementing a second filesystem or command runner:

- **Project Explorer** lists task-workspace directories and previews text files through `list_directory` / `read_text_file` with the normal canonical-path checks.
- **Workspace Search** exposes task-scoped `grep` and `glob`; glob results can open directly in the file viewer.
- **Project Context** loads the selected task's `AGENTS.md`, `CLAUDE.md`, `README.md` and supported rule/config context through `project_context`.
- **Shell / Processes** runs foreground commands and starts, tails, lists and stops background processes using the normal command policy. Process records are task-scoped. In workspace-only mode these process tools use the configured Docker sandbox; if Docker/the image is unavailable they fail with `SANDBOX_UNAVAILABLE` instead of falling back to the host.
- **Project Preview** stores a task-local dev command and loopback URL, starts the dev server through `start_process`, displays its output, and embeds only `localhost` / `127.0.0.1` HTTP(S) URLs. Preview start remains machine-scope-only because the secure workspace sandbox deliberately uses `network=none` and exposes no host-reachable port.
- **MCP Sessions / Runtime** shows active session ID, bound task/workspace, client name/version and last activity. New sessions bind to the currently selected default task; existing sessions stay pinned.
- **Activity** can be filtered by task because tool events carry `task_id` and `operation_id` when available.

On Windows, stopping a managed process terminates the PowerShell process tree rather than only the shell wrapper. Server `SIGINT` and `SIGTERM` shutdown also terminate managed background process trees before exit. This prevents stopped previews/dev servers from being orphaned and continuing to hold the workspace open.

## Limitations

- **Docker is the first OS process sandbox provider, not a native Windows sandbox.** Workspace-only can run shell and supported local Git when Docker and the configured image are available; otherwise it remains fail-closed. Native Windows/WSL providers remain future work. Remote Git, GitHub, upstream MCP calls and Preview start stay outside this sandbox by design. Full/machine scope is not a security boundary against a malicious command running as the same OS user, including access to local credentials/control files.
- The Docker sandbox protects the host boundary by exposing only the workspace and disabling network, but commands can still freely modify files inside that workspace. The chosen image is part of the trust/configuration boundary and must contain the tools the project needs. Docker Desktop/daemon security itself is outside this application.
- File validation cannot prevent every race with a concurrently hostile OS process. Avoid concurrent external writers while editing/restoring. Switching policy does not retroactively undo or revoke already-running unrestricted commands.
- Shell, Git index/history and remote side effects are not automatically snapshotted or undoable. A background process can modify files for as long as it is intentionally left running. Git worktrees reduce conflicts but are not sandboxes.
- Interrupted operations require manual inspection; there is no automatic crash rollback. Undo/checkpoint restore detect conflicts rather than attempting a three-way merge. Staging individual diff hunks, transactional rollback of non-file effects and snapshot retention management remain to be implemented.
- Review is currently in the **local dashboard**; an inline ChatGPT MCP Apps widget is not yet included.
- Automatic reviewer rules are intentionally limited. Per-repository/branch remote grants, richer merge-conflict UI, releases and GitHub administration are not implemented.
- One server process per state directory. No automatic multi-process locking, encrypted snapshot database or per-user accounts. Task shell cwd is isolated in memory and resets to its workspace after restart.
- ChatGPT's own confirmation layer remains independent of server approvals.

## Verification

```powershell
npm test
npm run test:workbench
npm run test:integration
npm run test:all
```

Workbench tests use isolated temporary projects and local mock credentials. They cover OAuth/authorization, project explorer/search/context, foreground/background commands, process-tree termination, preview lifecycle and URL restrictions, task/session binding, pending preflight diffs, task checkpoints, policy revocation, workspace traversal/junctions, stale file/Git approvals, Undo/Redo conflicts, file-level Git stage/diff/unstage, GitHub argument construction, and restart behavior. `test-sandbox.mjs` additionally verifies fail-closed provider defaults and the Docker run specification (workspace-only bind, network isolation, non-root execution and resource limits) without requiring Docker. A live Docker execution test still requires a machine where Docker and the configured image are installed. Existing tests cover MCP SSE/session recovery, batching, cursor logs, legacy checkpoints and upstream tools.

Browser verification used a disposable local fixture to approve a pending write, view its before/after snapshots, and Undo/Redo one file. To reproduce manually, run `$env:WORKBENCH_UI_PREVIEW_SECONDS='240'; node scripts/test-workbench.mjs` after building; the script prints its temporary URL and fixture token, then stops and removes its temporary project automatically. This is not the production dashboard.
