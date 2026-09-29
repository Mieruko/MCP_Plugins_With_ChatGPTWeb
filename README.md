# MCP Plugins With ChatGPT Web

**A self-hosted MCP Workbench for local coding and Computer Use from ChatGPT Web.**

[![Release](https://img.shields.io/github/v/release/Mieruko/MCP_Plugins_With_ChatGPTWeb)](https://github.com/Mieruko/MCP_Plugins_With_ChatGPTWeb/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

[Quick start](#quick-start) · [Computer Use](#computer-use-for-chatgpt-web) · [Documentation](#documentation) · [V2.0.0 release notes](docs/releases/v2.0.0.md)

## What it does

- **Local coding:** inspect and edit files, search projects, run commands and background processes, and work with Git/GitHub.
- **Workbench:** manage projects, review diffs, approve changes, and restore supported file edits with checkpoints and Undo/Redo.
- **Computer Use — new in v2.0.0:** let ChatGPT Web observe and control a managed Chrome/Edge browser, upload files, and track page progress. An optional Windows desktop backend is also available.
- **Continuity:** keep task handoffs across conversations; use Advanced mode for parallel tasks and worktrees.
- **MCP hub:** connect upstream MCP servers and expose selected tools.

The server and Workbench run on your machine. ChatGPT connects to the MCP service through a tunnel; tool results and requested screenshots are returned to the connected client.

## Requirements

- **Core:** Node.js 22+ with npm, Git, and ChatGPT access that supports custom MCP apps/developer mode.
- **Browser Computer Use:** installed Chrome or Edge and the optional npm dependencies.
- **Windows desktop control:** Windows, `uv`, and the [separate backend setup](docs/computer-use.md).
- **Optional:** GitHub CLI (`gh`) for GitHub features; Docker for workspace command isolation. The automatic OpenAI tunnel installer requires Windows/PowerShell.

## Quick start

```powershell
git clone https://github.com/Mieruko/MCP_Plugins_With_ChatGPTWeb.git
cd MCP_Plugins_With_ChatGPTWeb
git checkout v2.0.0
npm ci --include=optional
npm start
```

On first launch, the wizard asks for your project folder and connection mode. It saves `.env`, builds as needed, starts the server and tunnel, and opens the local Workbench.

<a id="option-2-setup"></a>
<a id="connect-chatgpt"></a>

| Setup option | ChatGPT connection | Notes |
| --- | --- | --- |
| **1 — Cloudflare Quick Tunnel** | Server URL + OAuth | Use the printed HTTPS URL with `/mcp`; the URL changes between runs. |
| **2 — OpenAI Secure MCP Tunnel** | Tunnel + No Auth | Recommended on Windows when you have tunnel access. Requires a Tunnel ID and Runtime key with Read + Use permissions. |
| **3 — Local only** | No public ChatGPT connection | Run the Workbench and MCP service locally. |

Follow the [complete setup guide](docs/setup.md#option-2-setup) for tunnel creation, wizard prompts, authentication and repairs. Keep the terminal open while working; Ctrl+C stops the launcher and its children.

In ChatGPT, add and enable the configured app in a new conversation, then ask:

```text
Call workbench and show the current workspace, task and permissions.
```

Confirm that the returned project path is correct before requesting changes. Default addresses are MCP `http://localhost:3000/mcp` and Workbench `http://127.0.0.1:3001/ui/workbench.html`; use the printed addresses if ports are occupied.

Run `npm run setup` to reconfigure or `npm run repair:tunnel` to repair OpenAI tunnel settings. After changing server tools, refresh the ChatGPT connector and start a new conversation.

## Computer Use for ChatGPT Web

Computer Use is **disabled by default**. After installation, add these settings to `.env`:

```dotenv
COMPUTER_USE_ENABLED=true
COMPUTER_BROWSER=chrome
COMPUTER_BROWSER_HEADLESS=false
```

Use `msedge` for Edge. If optional dependencies were omitted, run `npm ci --include=optional` and `npm run build` before restarting.

1. Finish active tasks, restart the server, refresh the connector, and start a new ChatGPT conversation.
2. In Workbench, grant the task **machine scope**. Ask/Auto/Full still applies; in Basic mode the conversation must hold write control.
3. Open **Computer Use**, select the task, and open the browser to sign in yourself.
4. Ask ChatGPT to attach to the managed browser and carry out your request. Use the dashboard's **Stop** button to stop browser control.

Example request:

```text
Use Computer Use to open https://example.com in the managed browser,
inspect the page, and summarize its contents.
```

| Tool | Purpose |
| --- | --- |
| `computer_session` | Open, inspect or leave a session |
| `computer_observe` | Read the current UI and optionally capture an image |
| `computer_act` | Navigate, click, type, select, scroll or switch tabs |
| `computer_upload` | Supply local files to an open browser file chooser |
| `computer_job` | Track progress and monitor visible page evidence for up to 10 minutes |

All five tools are available in the slim profile when enabled. The browser preserves login state in a Workbench profile shared by authorized tasks and workspaces on that server. It does not automatically attach to your personal browser. Handle login, 2FA and CAPTCHA yourself.

**Current limits:** live ChatGPT tunnel workflows, Facebook/Colab completion and Windows desktop workflows are not fully validated. Job monitors cannot wake a closed chat, and matching page text alone does not establish remote success. Windows control is a separate opt-in; captures may include the full desktop. See the [Computer Use guide](docs/computer-use.md) and [verification record](docs/computer-use-verification.md).

## Workbench

| Experience | Use it for |
| --- | --- |
| **Basic — recommended** | Everyday coding with one writer conversation, review and Undo |
| **Advanced** | Separate tasks, parallel worktrees, previews and a merge queue |

Experience, permission mode and tool profile are separate settings. Change experience in **Settings → Experience**. To transfer Basic write access, use **ChatGPT write control → Choose conversation**. See [experience and task coordination](docs/experience.md).

## Permissions and security

New tasks start with **Ask + workspace-only**. Ask requires approval for mutations; Auto approves supported routine edits; Full disables Workbench approval prompts for that task. Machine scope is a separate setting required by Computer Use and other host/network operations.

Keep the admin/Workbench port local and expose only MCP through the configured tunnel. Keep `.env`, browser profiles, credentials and Workbench state out of Git. File Undo does not reverse shell commands, remote posts or Git pushes. Full does not disable the connected client's own checks.

See the [permission and sandbox reference](docs/workbench-reference.md#permissions-and-security) for path protection, optional Docker isolation and permission changes from chat.

## Upgrade

Stop the launcher, preserve local edits and `.env`, and back up the configured `WORKBENCH_PATH` before updating:

```powershell
git fetch origin --tags
git checkout v2.0.0
npm ci --include=optional
npm run build
npm start
```

Refresh the ChatGPT connector and start a new conversation after upgrading. See [release notes](docs/releases/v2.0.0.md) for this version's changes.

## Documentation

| Guide | Contents |
| --- | --- |
| [Setup and troubleshooting](docs/setup.md) | Tunnels, authentication, configuration, repairs and launcher options |
| [Computer Use](docs/computer-use.md) | Browser setup, profiles, uploads, jobs and Windows backend |
| [Computer Use verification](docs/computer-use-verification.md) | Recorded checks and remaining gaps |
| [Workbench reference](docs/workbench-reference.md) | Architecture, tools, GitHub, permissions, history and upstream MCP |
| [Basic and Advanced](docs/experience.md) | Write control, task binding and parallel work |
| [Scheduled troubleshooting](docs/scheduled-mcp-troubleshooting.md) | Task binding and client safety checks |

<a id="github-integration"></a>

For GitHub tools, install GitHub CLI and authenticate locally with `gh auth login`. See [supported GitHub operations](docs/workbench-reference.md#github-integration).

## Development

```powershell
npm ci --include=optional
npm run build
npm test
```

TypeScript source is in `src/`; the Workbench frontend is in `public/ui/`. See [development commands](docs/workbench-reference.md#development) and [Computer Use checks](docs/computer-use.md). Report reproducible bugs through [GitHub Issues](https://github.com/Mieruko/MCP_Plugins_With_ChatGPTWeb/issues).

## Upstream and project history

This project builds on [hoangcoderr/chatgpt-local-coder](https://github.com/hoangcoderr/chatgpt-local-coder), with additional Workbench and Computer Use development maintained in this fork. See [upstream workflow](docs/workbench-reference.md#repository-remotes-for-this-fork).

## License

[MIT](LICENSE). The license retains the upstream copyright notice and the notice for modifications in this fork.
