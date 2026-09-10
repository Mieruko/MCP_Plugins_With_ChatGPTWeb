# Local Coder Workbench — implementation and setup

This branch is an initial implementation of the researched design. It does not yet provide complete Codex parity.

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
| Ask | Reads run; mutations require one local approval. This first version asks on each mutation, rather than reproducing Codex's full risk classifier. |
| Approve for me | Deterministic rules auto-approve supported file edits. Git/remote mutations and arbitrary commands still require local approval. |
| Full | No server approval prompts. Workspace scope can still be enabled as a custom configuration. |

The **workspace-only** checkbox is independent from the approval reviewer. It validates canonical paths, nonexistent destinations through their nearest existing ancestor, junctions and hard links. File operations are bounded to the task workspace; the control store is inaccessible through file tools. Process execution and upstream tools are refused while this boundary is enabled because there is no OS process sandbox yet. Post-edit hooks do not run implicitly after an approved file edit.

Changing policy invalidates pending approvals. An approval expires after 15 minutes, binds to a stored tool request, and executes at most once. File changes while waiting cause `APPROVAL_CONFLICT`. Git mutation approvals fingerprint HEAD, index, tracked working changes and local configuration so a different staged version is not accidentally committed. This does not sandbox arbitrary shell commands or undo their side effects.

The model receives `approval_required` and must **not resubmit** the operation. After approval, it retrieves the original result with `workbench(operation_id)`. Server restarts invalidate pending/in-progress requests; they are never replayed automatically.

## Tasks and Review

Create/select tasks in the dashboard. The selected default applies to newly established MCP sessions. Existing sessions remain bound to their task. MCP session identity is not assumed to equal a ChatGPT conversation ID; after selecting a different task, reconnect/open a new chat and verify the task returned by `workbench`.

Initialization loads only the selected task's workspace instructions, and binds the session before its first tool call. Known session-to-task mappings are persisted so recovery after a server restart retains the original task even when the selected default changes. A completely new or unknown session uses the selected default.

File tool checkpoints feed a before/after task journal. Review shows the actual snapshots, independently of Git's index or HEAD. Undo/Redo work per operation or per file. All affected paths are checked before an Undo starts; user modifications cause `UNDO_CONFLICT` and are retained. Changes made before the task are preserved in the recorded baseline.

Git controls cover status, diff/staged diff, explicit staging, unstage, commit, branch/worktree creation, fetch and push. Commit defaults to **already staged files**, never `git add -A`. Push requires an explicit branch. Pull is fast-forward-only. Worktree creation provides a separate checkout; ordinary branch switching does not isolate uncommitted changes.

State is written before file edits and after each restore step. A failed multi-file operation can have partial changes, and these remain reviewable. File contents and modes are captured, not Windows ACLs or all filesystem metadata. Large trees/files are rejected rather than silently skipped (2000 paths / 32 MiB per capture).

## Limitations

- **No OS process sandbox.** Workspace-only permits supported file tools but blocks shell, Git, GitHub and upstream execution. Native Windows/WSL sandbox support remains a separate milestone. Full mode is not a security boundary against a malicious command running as the same OS user, including access to local credentials/control files.
- File validation cannot prevent every race with a concurrently hostile OS process. Avoid concurrent external writers while editing/restoring. Switching policy does not retroactively undo or revoke already-running unrestricted commands.
- Shell, Git index/history and remote side effects are not automatically snapshotted or undoable. A background process may continue writing after its start operation completes. Git worktrees reduce conflicts but are not sandboxes.
- Interrupted operations require manual inspection; there is no automatic crash rollback. Undo detects conflicts rather than attempting a three-way merge. Task-wide Undo, staging individual diff hunks, transactional multi-file rollback and snapshot retention management remain to be implemented.
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

Workbench tests use isolated temporary projects and local mock credentials. They cover OAuth/authorization, pending writes, policy revocation, workspace traversal/junctions, stale file/Git approvals, Undo/Redo conflicts, explicit Git staging, GitHub argument construction, and restart behavior. Existing tests cover MCP SSE/session recovery, batching, cursor logs, checkpoints and upstream tools.

Browser verification used a disposable local fixture to approve a pending write, view its before/after snapshots, and Undo/Redo one file. To reproduce manually, run `$env:WORKBENCH_UI_PREVIEW_SECONDS='240'; node scripts/test-workbench.mjs` after building; the script prints its temporary URL and fixture token, then stops and removes its temporary project automatically. This is not the production dashboard.
