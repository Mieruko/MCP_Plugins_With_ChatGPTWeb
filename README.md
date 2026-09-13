<div align="center">

# MCP Plugins With ChatGPT Web · v1.0.0

**A self-hosted local coding Workbench that connects ChatGPT Web to your machine through MCP.**

**Start with Basic — the recommended experience for everyday coding.**

[Download v1.0.0](https://github.com/Mieruko/MCP_Plugins_With_ChatGPTWeb/releases/tag/v1.0.0) · [Release notes](docs/releases/v1.0.0.md)

Files · Shell · Git · GitHub · Multi-workspace · Active Agents · Review/Diff · Checkpoints · Upstream MCP

[![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-6366f1?style=flat-square)](https://modelcontextprotocol.io)
[![ChatGPT](https://img.shields.io/badge/ChatGPT-Web-10a37f?style=flat-square)](https://chatgpt.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178c6?style=flat-square)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Mieruko/MCP_Plugins_With_ChatGPTWeb?style=flat-square&logo=github)](https://github.com/Mieruko/MCP_Plugins_With_ChatGPTWeb/stargazers)

[Quick Start](#quick-start) · [Workbench](#workbench) · [ChatGPT](#connect-chatgpt) · [GitHub](#github-integration) · [Security](#permissions-and-security) · [Upstream](#upstream-and-project-history)

</div>

---

## About this project

Version 1 brings Basic project workflows, Advanced task/worktree coordination, persistent handoffs, bounded MCP history and optional permission changes from chat into one release. Basic is the default for new projects and is recommended unless you need parallel tasks and a merge queue.

**MCP Plugins With ChatGPT Web** turns ChatGPT Web into a local coding agent while keeping the project, terminal, Git state and approval flow on your own computer.

It started from [`hoangcoderr/chatgpt-local-coder`](https://github.com/hoangcoderr/chatgpt-local-coder) and has since been extended into a larger local coding Workbench with a different workflow and UI.

The current project adds and develops features such as:

- a Codex-inspired local Workbench UI;
- multiple registered workspaces instead of a single fixed project;
- task-scoped permissions and persistent task/session binding;
- real Active Agent/session tracking;
- project Explorer and workspace search;
- Monaco-based file viewing/editing;
- Codex-style review and colored unified diffs;
- operation history, checkpoints, Undo/Redo and rewind compatibility;
- foreground shell and managed background processes;
- structured Git controls for status, diff, staging, commit, branches, worktrees, fetch, pull and push;
- GitHub PR / Issue / Checks integration through GitHub CLI;
- upstream MCP server discovery and proxying;
- OAuth support for ChatGPT MCP connections;
- optional Docker isolation for workspace-only command execution;
- local admin/control APIs protected from non-local access.

The Workbench and MCP server use the same underlying task, permission and tool execution model rather than maintaining two independent implementations.

## Star History

<div align="center">

[![Star History Chart](https://api.star-history.com/svg?repos=Mieruko/MCP_Plugins_With_ChatGPTWeb&type=Date)](https://star-history.com/#Mieruko/MCP_Plugins_With_ChatGPTWeb&Date)

</div>

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

## Requirements

- Node.js 22+ recommended for v1 (the release test environment uses Node.js 22);
- npm;
- Git for Git features;
- GitHub CLI (`gh`) for GitHub PR / Issue features;
- Windows PowerShell for the included Windows helper scripts;
- Docker Desktop / Docker Engine only when you explicitly enable the Docker workspace sandbox.

## Quick Start

Clone **this fork**:

```powershell
git clone https://github.com/Mieruko/MCP_Plugins_With_ChatGPTWeb.git
cd MCP_Plugins_With_ChatGPTWeb
git checkout v1.0.0
npm ci
npm start
```

`npm start` is the normal launcher. On first run it opens a setup wizard, then builds when needed, starts MCP + Workbench, starts the selected tunnel, opens the Workbench, and stops its child processes when you exit. The local Workbench authenticates automatically with a one-time launcher bootstrap and an HttpOnly browser session; users do not need to find or paste an admin token.

The first-run wizard asks for the workspace and one connection mode:

- **Cloudflare Quick Tunnel** — easiest setup; the wizard can install `cloudflared` automatically. Use ChatGPT **Server URL + OAuth**. The public URL changes each run.
- **OpenAI Secure MCP Tunnel** — stable tunnel identity. The wizard installs `tunnel-client`, asks for Tunnel ID / Runtime API key / optional organization ID, and validates basic tunnel access. The Runtime key needs **Tunnels Read + Use**. Use ChatGPT **Tunnel + No Auth**.
- **Local only** — Workbench/MCP stay local and no public tunnel is started.

The wizard creates/updates `.env` for you. Reconfigure at any time with:

```powershell
npm run setup
# or configure and immediately start
npm start -- --setup
```

OpenAI Tunnel is self-healing for local client problems: if `tunnel-client` is
missing, damaged, or an older bundled version is present, `npm start` repairs it
without asking for the Tunnel ID or Runtime key again. If OpenAI instead rejects
the configured tunnel/key/organization, the running launcher opens a focused
repair flow and keeps the local MCP + Workbench alive.

You can open that repair flow manually with:

```powershell
npm run repair:tunnel
```

The repair flow only changes the tunnel setting you choose. Workspace and UI
settings are preserved. It can replace the Runtime key, select another Tunnel
ID, set the owning organization, or fall back to Cloudflare/local-only.

Default services:

```text
MCP server:  http://localhost:3000
Workbench:   http://127.0.0.1:3001/ui/workbench.html
```

If a default port is already in use, the launcher automatically selects a nearby free port. You can still set `PORT` and `ADMIN_PORT` to choose preferred starting ports.

### Important environment settings

```dotenv
PORT=3000
ADMIN_PORT=3001
# WORKSPACE_PATH=D:\projects\my-app
CHATGPT_TOOL_PROFILE=slim
WORKBENCH_DEFAULT_MODE=ask
WORKBENCH_EXPERIENCE=basic
```

`WORKSPACE_PATH` is optional. Additional projects can be registered directly from the Workbench with **Add workspace**; they do not require a server restart.

Do not commit your real `.env`, credentials, tokens or Workbench state.

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

Existing saved projects retain **Advanced** when upgrading. `WORKBENCH_EXPERIENCE=basic|advanced` sets the default for new projects only; it does not change saved projects, approval settings (`WORKBENCH_DEFAULT_MODE`) or exposed tools (`CHATGPT_TOOL_PROFILE`). See [experience behavior and limitations](docs/experience.md).

### Workspaces, tasks and session binding

A **Workspace** represents a local project directory. A workspace may exist before it has any task.

A **Task** represents a unit of work inside one workspace and carries its own permission policy and operation history.

New MCP sessions bind to the currently selected task. Existing sessions remain pinned to the task they started with, so switching the selected workspace/task does not silently move an already-running ChatGPT session into another project.

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

## Connect ChatGPT

### 1. Start the local server

```powershell
npm start
```

### 2. Choose the connection during setup

The admin/Workbench port should stay local. Only expose the MCP service.

The setup wizard owns the normal tunnel configuration. New users do not need to manually create `.env`, run a separate Cloudflare terminal, or remember the old tunnel helper sequence.

For Cloudflare mode, `npm start` launches the Quick Tunnel and injects its current HTTPS origin into MCP OAuth metadata automatically.

For OpenAI mode, `npm start` launches the configured stable tunnel and prints a prominent diagnostic if the Runtime API key lacks tunnel **Use** permission or the tunnel requires a different organization context.

For those known OpenAI errors, an interactive terminal automatically opens the
same repair flow. Fixing the Runtime key, Tunnel ID, or organization restarts
only `tunnel-client`; the local MCP server and Workbench stay running. Switching
connection type to Cloudflare or local-only is saved and takes effect on the
next `npm start`, because the MCP public OAuth origin must be chosen before the
server boots.

When using OpenAI Secure MCP Tunnel in ChatGPT, select **Connection: Tunnel** and **Authentication: None**. The launcher-generated tunnel profile attaches the Workbench's local MCP Bearer token on the private hop from `tunnel-client` to `127.0.0.1`, so the local MCP server remains authenticated without exposing its OAuth authorization server. Do not select OAuth or Mixed for this tunnel connection: Secure MCP Tunnel forwards MCP traffic, but the local OAuth authorization/token endpoints are not automatically exposed through that tunnel.

If OpenAI reports `tunnel_active_organization_required`, set `CONTROL_PLANE_ORGANIZATION_ID=org_...` in `.env` to the organization that owns that tunnel. The launcher propagates this into the generated tunnel-client profile.

Launcher overrides are available when needed:

```powershell
npm start -- --setup        # run setup wizard again, then start
npm start -- --cloudflare   # prefer Cloudflare Quick Tunnel
npm start -- --openai       # prefer configured OpenAI Tunnel
npm start -- --no-tunnel    # local Workbench only
npm start -- --no-open      # do not open the browser automatically
npm start -- --no-setup     # skip setup checks (automation/advanced use)
```

The older `start.ps1`, `openai-tunnel.bat`, and `tunnel.ps1` helpers remain available for manual/advanced workflows.

### 3. Configure ChatGPT

For Cloudflare/public HTTPS mode, configure the MCP endpoint with OAuth and approve the matching request from your local Workbench. For OpenAI Secure MCP Tunnel mode, choose the tunnel connection itself and **Authentication: None**; do not paste the `tunnel-service.../v1/mcp/tunnel_...` URL into the normal OAuth endpoint field.

After server/tool changes, refresh the connector and start a new ChatGPT conversation so the client receives the current tool schema.

## MCP tools

The server supports a `slim` profile optimized for ChatGPT Web and a `full` profile for exposing the complete local tool set.

Core capabilities include:

| Area | Examples |
| --- | --- |
| Workbench | `workbench`, `workbench_control`, `task_handoff`, `task_complete` |
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

This opt-in authorizes authenticated MCP conversations to change their bound task's policy. It does not grant another conversation the Basic writer lease. Policy changes are recorded in history and expire existing pending approvals without executing them. Full does not automatically carry over when targeting another project. Workspace/task creation and retargeting require Full with machine scope on the source task; running processes and preview leases must be stopped before a retarget releases its writer.

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

## Upstream and project history

This repository is a fork of:

- **Original project:** [`hoangcoderr/chatgpt-local-coder`](https://github.com/hoangcoderr/chatgpt-local-coder)
- **Current fork:** [`Mieruko/MCP_Plugins_With_ChatGPTWeb`](https://github.com/Mieruko/MCP_Plugins_With_ChatGPTWeb)

The original project provided the initial MIT-licensed codebase. The current fork contains substantial additional development, including the Workbench architecture and workflows described above.

Upstream attribution is intentionally retained where required by the MIT License. GitHub fork metadata and license attribution describe project ancestry; they do not imply that upstream authors authored the later modifications in this fork.

## License

This project is distributed under the **MIT License**. See [`LICENSE`](LICENSE).

The license file retains the upstream copyright notice required for code derived from the original MIT-licensed project and adds a notice for modifications made in this fork.

---

<div align="center">

**MCP Plugins With ChatGPT Web** · maintained in the `Mieruko/MCP_Plugins_With_ChatGPTWeb` fork

</div>
