<div align="center">

# MCP Plugins With ChatGPT Web

**A self-hosted local coding Workbench that connects ChatGPT Web to your machine through MCP.**

Files · Shell · Git · GitHub · Multi-workspace · Active Agents · Review/Diff · Checkpoints · Upstream MCP

[![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-6366f1?style=flat-square)](https://modelcontextprotocol.io)
[![ChatGPT](https://img.shields.io/badge/ChatGPT-Web-10a37f?style=flat-square)](https://chatgpt.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178c6?style=flat-square)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)

[Quick Start](#quick-start) · [Workbench](#workbench) · [ChatGPT](#connect-chatgpt) · [GitHub](#github-integration) · [Security](#permissions-and-security) · [Upstream](#upstream-and-project-history)

</div>

---

## About this project

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

- Node.js 18+;
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
Copy-Item .env.example .env
npm install
npm run build
.\start.ps1
```

Default services from `.env.example`:

```text
MCP server:  http://localhost:3000
Workbench:   http://127.0.0.1:3001/ui/workbench.html
```

You can change `PORT` and `ADMIN_PORT` if those ports are already in use.

### Important environment settings

```dotenv
PORT=3000
ADMIN_PORT=3001
WORKSPACE_PATH=C:\Users\YourName\projects\my-app
CHATGPT_TOOL_PROFILE=slim
WORKBENCH_DEFAULT_MODE=ask
```

`WORKSPACE_PATH` is the bootstrap/default project. Additional projects can be registered directly from the Workbench with **Add workspace**; they do not require a server restart.

Do not commit your real `.env`, credentials, tokens or Workbench state.

## Workbench

Open:

```text
http://127.0.0.1:3001/ui/workbench.html
```

The admin server is bound to localhost. Authentication credentials are generated/stored locally when explicit environment overrides are not configured.

### Workspaces and tasks

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
.\start.ps1 -Force
```

### 2. Expose the MCP endpoint through HTTPS

The admin/Workbench port should stay local. Only expose the MCP service.

For a stable OpenAI tunnel, initialize once and then run the provided tunnel helper:

```powershell
.\openai-tunnel-init.bat
.\openai-tunnel.bat
```

A Cloudflare tunnel helper is also included for development/testing where a changing public URL is acceptable.

### 3. Configure ChatGPT

Configure the MCP connector to use the public HTTPS MCP endpoint and OAuth. When OAuth approval is requested, review and approve the matching request from your local Workbench.

After server/tool changes, refresh the connector and start a new ChatGPT conversation so the client receives the current tool schema.

## MCP tools

The server supports a `slim` profile optimized for ChatGPT Web and a `full` profile for exposing the complete local tool set.

Core capabilities include:

| Area | Examples |
| --- | --- |
| Workbench | `workbench` |
| Batched inspection | `inspect_code` |
| Files | `read_text_file`, `write_file`, `edit_file`, `multi_edit`, `apply_patch` |
| Search | `glob`, `grep`, `list_directory` |
| Shell | `run_command`, `shell_status` |
| Processes | `start_process`, `process_output`, `stop_process` |
| Git | `git_status`, `git_diff`, `git_add`, `git_commit`, `git_restore` |
| Git remote | `git_fetch`, `git_pull`, `git_push` |
| Git structure | `git_branch`, `git_worktree`, `git_log` |
| Project context | `agent_status`, `project_context`, `load_path_rules`, `remember` |
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
