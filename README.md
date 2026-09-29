<div align="center">

# MCP Plugins With ChatGPT Web · V2.0.0

**A self-hosted local coding Workbench that connects ChatGPT Web to your machine through MCP, including Computer Use.**

**Start with Basic — the recommended experience for everyday coding.**

[Download V2.0.0](https://github.com/Mieruko/MCP_Plugins_With_ChatGPTWeb/releases/tag/v2.0.0) · [Release notes](docs/releases/v2.0.0.md)

Computer Use · Files · Shell · Git · GitHub · Multi-workspace · Active Agents · Review/Diff · Checkpoints · Upstream MCP

[![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-6366f1?style=flat-square)](https://modelcontextprotocol.io)
[![ChatGPT](https://img.shields.io/badge/ChatGPT-Web-10a37f?style=flat-square)](https://chatgpt.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178c6?style=flat-square)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Mieruko/MCP_Plugins_With_ChatGPTWeb?style=flat-square&logo=github)](https://github.com/Mieruko/MCP_Plugins_With_ChatGPTWeb/stargazers)

[Quick Start](#quick-start) · [Computer Use](#computer-use-for-chatgpt-web) · [Recommended tunnel setup](#option-2-setup) · [Workbench](#workbench) · [ChatGPT](#connect-chatgpt) · [GitHub](#github-integration) · [Security](#permissions-and-security) · [Upstream](#upstream-and-project-history)

</div>

---

## About this project

Version 2 adds opt-in Computer Use for ChatGPT Web: ChatGPT can observe and operate a Workbench-managed Chrome or Edge session through permission-checked MCP tools. Basic project workflows, Advanced task/worktree coordination, persistent handoffs and review remain part of the Workbench. Basic is the default for new projects and is recommended unless you need parallel tasks and a merge queue.

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
- Computer Use tools for a persistent Workbench-managed browser, with bounded browser jobs and file uploads;
- an optional Windows native UI backend for foreground desktop controls;
- structured Git controls for status, diff, staging, commit, branches, worktrees, fetch, pull and push;
- GitHub PR / Issue / Checks integration through GitHub CLI;
- upstream MCP server discovery and proxying;
- OAuth support for ChatGPT MCP connections;
- optional Docker isolation for workspace-only command execution;
- local admin/control APIs protected from non-local access.

The Workbench and MCP server use the same underlying task, permission and tool execution model rather than maintaining two independent implementations.

## Computer Use for ChatGPT Web

Computer Use is new in **v2.0.0**. It gives ChatGPT Web five scoped MCP tools to open a managed browser session, inspect the page, navigate and interact with visible controls, upload files, and track a bounded browser workflow. The browser backend supports Chrome and Edge through the optional Playwright MCP dependency.

Computer Use is **disabled by default**. Install optional dependencies and build the project:

```powershell
npm install --include=optional
npm run build
```

Then add these settings to `.env` and restart the server after active tasks have ended:

```dotenv
COMPUTER_USE_ENABLED=true
COMPUTER_BROWSER=chrome
COMPUTER_BROWSER_HEADLESS=false
```

In the Workbench, open **Computer Use**, choose the task, and open its browser to sign in yourself. ChatGPT Web can attach to that same session with `computer_session(action=open,backend=browser)`. The session follows the task's permission policy and requires machine scope. You handle sign-in, two-factor prompts and CAPTCHAs.

The managed browser uses a persistent profile and does not import your personal Chrome or Edge profile. All authorized tasks and workspaces on the same Workbench server share that browser, its tabs and its cookies; it is not a boundary between projects. Review the [Computer Use guide](docs/computer-use.md) before using accounts or uploading local files.

Browser jobs can poll for visible page evidence, but a matching page message does not prove that an external service completed an action. Review the destination and result yourself before treating a workflow as complete or retrying a submission.

### Optional Windows desktop backend

Windows native UI control is a separate opt-in backend. It requires Windows and `uv`, uses a private Python environment, and targets the foreground application. The screenshot may still include the full desktop. Real desktop application workflows have not been validated; see the [implementation verification record](docs/computer-use-verification.md) for tested coverage and open gaps.

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

- Node.js 22+ (npm is included with Node.js);
- Chrome or Edge for browser Computer Use; this is optional and disabled by default;
- Windows and `uv` only for the optional Windows native UI backend;
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
git checkout v2.0.0
npm ci
npm run setup
npm start
```

`npm start` is the normal launcher. On first run it opens a setup wizard, then builds when needed, starts MCP + Workbench, starts the selected tunnel, opens the Workbench, and stops its child processes when you exit. The local Workbench authenticates automatically with a one-time launcher bootstrap and an HttpOnly browser session; users do not need to find or paste an admin token.

The first-run wizard asks for the workspace and one connection mode:

- **1 — Cloudflare Quick Tunnel** — quick setup; the wizard can install `cloudflared` automatically. Use ChatGPT **Server URL + OAuth**. The public URL changes each run.
- **2 — OpenAI Secure MCP Tunnel · Recommended / Khuyên dùng (Windows)** — stable tunnel identity. The wizard installs `tunnel-client`, asks for Tunnel ID / Runtime API key / optional organization ID, and validates basic tunnel access. The Runtime key needs **Tunnels Read + Use**. Use ChatGPT **Tunnel + No Auth**. Follow the [complete option 2 guide](#option-2-setup) below.
- **3 — Local only** — Workbench/MCP stay local and no public tunnel is started.

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

<a id="option-2-setup"></a>

### Option 2 — OpenAI Secure MCP Tunnel (Recommended / Khuyên dùng)

This is the recommended connection for Windows users with access to OpenAI tunnels. You keep the same Tunnel ID between launches. The option 2 installer in this repository currently requires **Windows and PowerShell**; use option 1 or 3 on other operating systems.

#### 1. Prepare the machine and OpenAI access

Install Node.js 22+ (including npm) and Git, then open a new PowerShell terminal and check:

```powershell
node --version
npm --version
git --version
```

Docker and GitHub CLI are optional; neither is required to install this tunnel connection.

You need access to ChatGPT developer mode and the target Platform organization's tunnel permissions. Creating a tunnel requires **Tunnels Read + Manage**; running the client and selecting the tunnel require **Tunnels Read + Use**. These are separate from developer-mode access. Associate the tunnel with the **ChatGPT workspace where you will use it**, as well as its owning Platform organization. If either permission is missing, ask the respective workspace or organization administrator. See the [official OpenAI tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels#permissions-and-access).

#### 2. Create the tunnel and its Runtime API key

1. Open [Platform → Organization → Tunnels](https://platform.openai.com/settings/organization/tunnels) and select the correct organization.
2. Create a tunnel, give it a recognizable name such as `Codex Local`, and associate the intended ChatGPT workspace. Copy its **Tunnel ID** (`tunnel_` followed by 32 hexadecimal characters).
3. Open [Organization API keys](https://platform.openai.com/settings/organization/api-keys), create a Runtime API key with **Tunnels Read + Use** access, and keep the key for the setup prompt. A key without tunnel access will not work.
4. Note the owning **Organization ID** (`org_...`) if your account requires explicit organization selection.

Keep the Runtime key private. Enter it only into the local setup prompt; the wizard masks input and stores it in the ignored `.env` file.

#### 3. Install this release and run the wizard

For a new installation:

```powershell
git clone https://github.com/Mieruko/MCP_Plugins_With_ChatGPTWeb.git
cd MCP_Plugins_With_ChatGPTWeb
git checkout v2.0.0
npm ci
npm run setup
```

Answer the prompts as follows:

| Wizard prompt | What to enter |
| --- | --- |
| `Tunnel [...]` | Type **`2`** and press Enter. The bracketed default may reflect an earlier setup; explicitly choose 2. |
| `Workspace [...]` | Absolute path to the project ChatGPT should work on, for example `D:\projects\my-app`. Press Enter only if the displayed folder is correct. |
| Open tunnel + Runtime API key settings? | Enter `y` to open the two settings pages, or press Enter if you already have the values. |
| `Tunnel ID` | Paste the ID copied in step 2. |
| Reuse the Runtime API key? | Appears when a key is already saved. Press Enter to keep it, or enter `n` to replace it. |
| `Runtime API key (hidden)` | Paste the Runtime key. Its characters are masked. |
| `Organization ID (optional)` | Paste the owning `org_...` when needed; otherwise leave blank on a fresh installation. |
| Save configuration anyway? | Appears only if validation fails. Choose `n`, correct the reported access issue, then run setup again. |
| Open Workbench automatically? | Press Enter to accept `Y` on a fresh installation. |

The wizard installs `bin/tunnel-client.exe`, validates tunnel metadata access, and saves the configuration to `.env`. `Tunnel metadata access OK.` checks **Read** access; actual **Use** access is checked when the tunnel runs. `npm run setup` finishes after configuration; start the service in the next step.

#### 4. Start Workbench and the tunnel

```powershell
npm start
```

The launcher builds the project when needed, starts the MCP server and local Workbench, generates the tunnel profile, and starts `tunnel-client`. Keep this terminal open while using ChatGPT. You do not need a second terminal running `openai-tunnel.bat`.

Workbench opens automatically with local browser authentication. Use the addresses printed in the terminal: defaults are MCP `http://localhost:3000` and Workbench `http://127.0.0.1:3001/ui/workbench.html`, but occupied ports are adjusted automatically. Detailed launcher output is saved in `.runtime-logs/npm-start.log`.

#### 5. Connect from ChatGPT

Enable developer mode for the intended ChatGPT workspace, then open its Plugins/Apps area and create an app in developer mode. Choose **Connection: Tunnel** and select the tunnel or enter its `tunnel_id`. The tunnel client must stay running for discovery and tool calls. If the tunnel is absent, verify workspace association and your Read + Use permissions. See [OpenAI's ChatGPT connection steps](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels#connect-from-chatgpt).

For **this repository's launcher**, select **Authentication: None / No Auth**. The generated local profile supplies the MCP Bearer token on the private connection to the server. Do not paste the tunnel service URL into a normal Server URL/OAuth connection.

Save the app, enable it in a new ChatGPT conversation, and ask:

```text
Call workbench and show the current workspace, task and permissions.
```

Confirm that the workspace path matches the project chosen in setup before asking for edits. New tasks start with Ask and workspace-only permissions. Choose **Advanced** in Workbench when you need multiple tasks running in parallel; each conversation can target an existing task in that workspace independently of the task selected on the Dashboard.

#### 6. Daily use, repairs and upgrades

- Next time, run **`npm start`** from this repository. Saved setup values are reused.
- Press **Ctrl+C** in that terminal to stop the launcher and its child processes.
- Run **`npm run setup`** to change the workspace or connection mode, or **`npm run repair:tunnel`** to repair tunnel settings while preserving workspace/UI settings.
- For a manual repair while the launcher is running, stop it first, run the repair command, then start it again. The launcher's automatic repair prompt can restart only the tunnel client.
- After upgrading server/tool definitions, refresh the ChatGPT app/connector and start a new conversation.

| Symptom | Resolution |
| --- | --- |
| `tunnel_use_forbidden` | Replace or update the Runtime key to grant Tunnels Read + Use for this tunnel, using `npm run repair:tunnel`. A successful metadata check alone does not prove Use access. |
| `tunnel_active_organization_required` | Use the repair flow to set the owning `org_...`; it is saved as `CONTROL_PLANE_ORGANIZATION_ID`. |
| Tunnel metadata validation fails | Check the copied Tunnel ID, Runtime key, owning organization and access permissions; rerun setup after correcting them. |
| Missing or damaged `tunnel-client` | `npm start` attempts to repair the local binary. Check internet/download access if that repair fails. |
| ChatGPT cannot discover tools | Keep `npm start` running, check the terminal/runtime log for tunnel errors, and verify Connection: Tunnel with Authentication: None. |
| Workbench page requires authentication | Use the page opened by the launcher. If `OPEN_UI=0`, re-enable automatic opening through setup before the next launch. |

For an existing checkout, preserve `.env`, back up the configured `WORKBENCH_PATH`, and stop its running launcher before upgrading. Commit or otherwise preserve local source edits first; do not force checkout over them:

```powershell
git fetch origin --tags
git checkout v2.0.0
npm ci
npm run build
npm start
```

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
