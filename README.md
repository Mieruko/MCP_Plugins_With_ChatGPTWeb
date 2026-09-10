<div align="center">

# ChatGPT Local Coder

**Turn ChatGPT web into a local coding agent — files, shell, git, patches, 40+ MCP tools.**

[![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-6366f1?style=flat-square)](https://modelcontextprotocol.io)
[![ChatGPT](https://img.shields.io/badge/ChatGPT-Developer%20Mode-10a37f?style=flat-square)](https://platform.openai.com/docs/guides/developer-mode)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178c6?style=flat-square)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)
[![Windows](https://img.shields.io/badge/Platform-Windows%20%7C%20macOS%20%7C%20Linux-0078d4?style=flat-square)](https://nodejs.org)

[Quick Start](#-quick-start) · [Connect ChatGPT](#-connect-chatgpt) · [Tools](#-tools) · [Tunnel](#-tunnel-options) · [Troubleshooting](#-troubleshooting) · [Tiếng Việt](#-tiếng-việt)

</div>

---

ChatGPT Local Coder is a **self-hosted MCP server** for local coding, with task permissions, approval requests, file review/undo and Git/GitHub tools.

**Workbench branch:** see [setup, behavior and known limits](docs/workbench.md). This is an initial implementation, not complete Codex parity. New tasks default to Ask + workspace-only. An OS process sandbox is not implemented; shell/Git/GitHub require explicitly disabling workspace-only scope. MCP authentication is now required; ChatGPT uses OAuth with local consent.

No desktop app. No vendor lock-in. Run one Node process on your PC, expose it through a tunnel, and code from ChatGPT in the browser.

```
┌─────────────────┐     HTTPS      ┌──────────────────┐     localhost     ┌─────────────────────┐
│   ChatGPT Web   │ ─────────────► │  Tunnel (opt.)   │ ────────────────► │  chatgpt-local-coder │
│ Developer Mode  │                │ OpenAI / CF      │      :3000/mcp    │  40+ MCP tools       │
└─────────────────┘                └──────────────────┘                   └──────────┬──────────┘
                                                                                    │
                                         ┌──────────────────────────────────────────┼──────────┐
                                         ▼                    ▼                    ▼          ▼
                                   Filesystem              Shell + Git         Background    Project
                                   read/write/patch        status/diff/commit   processes     context
```

## ✨ Why this project

| | ChatGPT alone | **+ ChatGPT Local Coder** |
|---|---|---|
| Edit your repo | ❌ | ✅ `apply_patch`, `edit_file`, `multi_edit` |
| Run tests / builds | ❌ | ✅ `run_command`, `start_process` |
| Git workflow | ❌ | ✅ `git_status`, `git_commit`, `git_push`, … |
| Explore codebase | Limited | ✅ `glob`, `grep`, `list_directory` |
| Configurable access | ❌ | ✅ Task permissions and optional workspace file boundary |
| Session recovery | — | ✅ Auto-recover after server restart |

Built for **ChatGPT Developer Mode** with batched inspection, cursor-based process output, honest tool annotations and a local Workbench dashboard.

## 🚀 Quick Start

**Requirements:** [Node.js](https://nodejs.org) 18+, npm, Git (optional, for git tools)

```powershell
git clone https://github.com/hoangcoderr/chatgpt-local-coder.git
cd chatgpt-local-coder
copy .env.example .env          # edit WORKSPACE_PATH
npm install
npm run build
.\start.ps1
```

Server runs at `http://localhost:3000` — health check: `http://localhost:3000/health`

<details>
<summary><b>macOS / Linux</b></summary>

```bash
git clone https://github.com/hoangcoderr/chatgpt-local-coder.git
cd chatgpt-local-coder
cp .env.example .env
npm install && npm run build
npm start
```

</details>

## 🔌 Connect ChatGPT

### 1. Enable Developer Mode

1. Open [ChatGPT](https://chatgpt.com) → **Settings** → **Apps & Connectors**
2. Under **Advanced**, enable **Developer mode**

### 2. Expose your server (pick one tunnel)

See [Tunnel options](#-tunnel-options) below. You need a **public HTTPS** URL pointing to `http://localhost:3000/mcp`.

### 3. Create a connector

1. **Settings** → **Connectors** → **Create**
2. Fill in:

| Field | Value |
|-------|-------|
| **Name** | `Local Coder` |
| **Description** | `Local coding agent. First call agent_status + project_context. Use glob/grep to explore, apply_patch to edit, run_command for shell.` |
| **URL** | Your tunnel HTTPS URL (e.g. `https://…` or OpenAI Tunnel ID) |
| **Authentication** | OAuth — configure PUBLIC_BASE_URL and approve the connection in local Workbench |

3. **Create** → verify tools appear in the list

### 4. Use in chat — **must tag the connector**

Every message that should use local tools **must include the connector**. If you skip this, ChatGPT only uses built-in tools, may show *"Looking for available tools"* / *"Đang tìm các công cụ có sẵn"*, then **"Error in message stream"** / **"Lỗi trong luồng tin nhắn"** — with **no error in server logs** (the MCP server was never called).

**How to tag (pick one):**

1. **Before sending:** **New chat** → **+** (tools) → **More** → enable **Local Coder** (connector stays on for that chat).
2. **In the message:** type **`@`** and choose **Local Coder** (or your connector name) so it appears as a pill/chip above the input.

Then send your prompt. You should see tool permission prompts or MCP activity — not a dead stream with no server log.

Example prompts (after tagging):

- *"Read package.json and explain the dependencies"*
- *"Run npm test and fix any failures"*
- *"Find all TODO comments with grep and summarize"*

> **Tip:** After server updates or restarts → **Refresh** the connector and start a **new chat** (re-tag the connector).  
> **Avoid** clicking **"Always allow"** on permission popups — it can reset the MCP session. Configure permissions in **Settings → Apps** instead.

## 🌐 Tunnel options

### Option A — OpenAI Secure MCP Tunnel *(recommended)*

Stable tunnel ID — connector URL never changes.

```powershell
# Terminal 1
.\start.ps1 -Force

# Terminal 2 — first time only
.\openai-tunnel-init.bat    # enter tunnel_id + Runtime API key from OpenAI Platform

# Every time after
.\openai-tunnel.bat
```

Get credentials: [OpenAI Platform → Tunnels](https://platform.openai.com/settings/organization/tunnels)

In ChatGPT Connectors: **Connection type → Tunnel** → paste your `tunnel_…` ID.

### Option B — Cloudflare Quick Tunnel

Free, but URL changes on every restart (update connector each time).

```powershell
# Terminal 1
.\start.bat

# Terminal 2
.\tunnel.bat    # copy https://….trycloudflare.com into connector URL
```

Install cloudflared: `winget install Cloudflare.cloudflared`

## 🧰 Tools

**40+ tools** with structured JSON responses `{ ok, tool, summary, data }`.

### Onboarding *(call these first)*

| Tool | Description |
|------|-------------|
| `agent_status` | Permissions, workspace roots, audit log |
| `project_context` | Reads AGENTS.md, README, CLAUDE.md, configs |

### Filesystem

| Tool | Description |
|------|-------------|
| `read_text_file` | Read source files (offset + limit) |
| `write_file` | Create or overwrite files |
| `edit_file` | Find-and-replace edits |
| `multi_edit` | Multiple edits in one file |
| `replace_regex` | Regex replace in file |
| `apply_patch` | Unified / Codex-style patches |
| `glob` | Find files by pattern (sorted by mtime) |
| `grep` | Search content (content / files / count modes) |
| `list_directory` | List folder contents |
| `directory_tree` | Recursive tree as JSON |
| `create_directory` | Create folders |
| `delete_file` / `delete_directory` | Remove files or dirs |
| `copy_file` / `move_file` | Copy or rename |
| `read_file_base64` / `write_file_base64` | Binary file support |

### Shell

| Tool | Description |
|------|-------------|
| `run_command` | Run shell commands (`npm test`, builds, …) |
| `shell_status` / `shell_reset` | Persistent shell session |
| `start_process` | Long-running / background commands |
| `process_status` / `process_output` / `stop_process` | Manage background jobs |

### Git

| Tool | Description |
|------|-------------|
| `git_status` / `git_diff` / `git_log` | Inspect repo |
| `git_add` / `git_commit` | Stage and commit |
| `git_branch` / `git_checkout` | Branch list, create, switch (local only) |
| `git_restore` | Restore tracked files to last commit |
| `git_push` / `git_pull` | Sync with configured remote |
| `git_stash` / `git_reset` | Stash and reset |

### Claude Code ↔ MCP mapping

| Claude Code | This server |
|-------------|-------------|
| `Read` | `read_text_file` |
| `Write` | `write_file` |
| `Edit` / `MultiEdit` | `edit_file` / `multi_edit` |
| `Glob` / `Grep` / `LS` | `glob` / `grep` / `list_directory` |
| `Bash` | `run_command` |
| — | `apply_patch`, `git_*`, `project_context` |

## ⚙️ Configuration

Copy `.env.example` → `.env`:

```env
PORT=3000
WORKSPACE_PATH=C:\Users\You\projects\my-app
WORKBENCH_DEFAULT_MODE=ask
SHELL_TIMEOUT=120
MCP_SESSION_RECOVERY=true

# OpenAI Secure Tunnel (optional)
OPENAI_TUNNEL_ID=
OPENAI_TUNNEL_API_KEY=
```

| Variable | Default | Description |
|----------|---------|-------------|
| `WORKSPACE_PATH` | `cwd` | **Your project root** (like `cd` before `claude`). Auto-loads `CLAUDE.md` / `AGENTS.md` into MCP instructions |
| `WORKBENCH_DEFAULT_MODE` | `ask` | Initial policy for new tasks: `ask`, `auto`, or `full`; `full` also defaults to machine scope |
| `MCP_SESSION_RECOVERY` | `true` | Auto-recover stale sessions after restart |
| `SHELL_TIMEOUT` | `120` | Max seconds for `run_command` |
| `FULL_DISK_ACCESS` / `CHATGPT_AUTO_APPROVE` | Legacy | Do not override Workbench task permissions |

> New tasks default to **Ask + workspace-only**. Use the Workbench dashboard to change scope and approval mode; changing tool annotations does not grant permission.

## 🏗️ Architecture

```
src/
├── index.ts                 # Express + MCP session manager
├── server-factory.ts        # Tool registration
├── lib/
│   ├── mcp-session-manager.ts   # Session recovery, TTL
│   ├── patch.ts             # apply_patch engine
│   └── persistent-shell.ts  # Stateful shell
└── tools/
    ├── filesystem.ts        # 18 tools
    ├── shell.ts             # 8 tools
    ├── git.ts               # 11 tools
    └── context.ts           # agent_status, project_context
```

- **Transport:** MCP Streamable HTTP (`/mcp` and `/`)
- **Session:** Stateful with auto-recovery when ChatGPT holds a stale session ID
- **Output:** Structured JSON from every tool

## 🧪 Development

### ChatGPT web performance

The default `slim` profile includes `inspect_code` for batched reads/searches with path
rules, and cursor-based background output. SSE connections no longer block subsequent
tool calls. See [design, examples and rollout](docs/chatgpt-web-performance.md).

Run `npm run test:chatgpt` for the isolated HTTP/SSE and workflow regression tests.

```powershell
npm run build          # compile TypeScript
npm test               # patch + tool unit tests
npm run dev            # watch mode (tsx)
node scripts/test-mcp-session.mjs   # integration test (server must be running)
```

## 🔒 Security

Full access is an explicit task setting. OAuth linking requires local consent, and the admin API requires its own token. Workspace-only currently restricts file tools and blocks arbitrary processes; it is not an OS sandbox. See [limitations](docs/workbench.md#limitations) before enabling unrestricted commands.

- `.env` and secrets are gitignored
- Audit log: `.mcp-audit.log` (optional, configurable)
- Use on a trusted network / personal machine only

## 🩺 Troubleshooting

| Problem | Fix |
|---------|-----|
| **"Error in message stream"** / **"Lỗi trong luồng tin nhắn"** right after *"Looking for tools"* — **no server log** | You did **not tag the connector**. New chat → **+** → **More** → enable connector, or type **`@Local Coder`** in the message. Then retry. |
| **Resource not found** on tool call | Refresh connector + new chat. Server auto-recovers sessions — ensure latest build is running. |
| **Connection failed** | Check `.\start.ps1` + tunnel are both running. URL must be HTTPS. |
| **Permission popup every call** | Settings → Apps → set connector to *Ask before important changes*. Don't use popup "Always allow". |
| **Tool denied by policy or client safety checks** | Inspect the denial and current task policy. Do not retry through another tool to bypass it. |
| **`stream canceled`** in tunnel log | Server/tunnel restarted mid-session → refresh connector, new chat. |
| **Tunnel URL keeps changing** | Switch to OpenAI Secure Tunnel (`openai-tunnel.bat`). |
| **Access denied** | Wrong path or OS permissions on that file. |
| **git not found** | Install [Git](https://git-scm.com). |

See also [AGENTS.md](AGENTS.md) for agent onboarding and `apply_patch` format.

## 📚 References

- [Model Context Protocol](https://modelcontextprotocol.io)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
- [ChatGPT Apps SDK](https://developers.openai.com/apps-sdk)
- [OpenAI Secure MCP Tunnel](https://platform.openai.com/docs/guides/secure-mcp-tunnel)

## 📄 License

[MIT](LICENSE) — use freely, attribution appreciated.

## ⭐ Support

If this saves you time, **star the repo** — it helps others find it.

---

## 🇻🇳 Tiếng Việt

**ChatGPT Local Coder** biến ChatGPT web thành agent code trên máy bạn qua MCP.

```powershell
git clone https://github.com/hoangcoderr/chatgpt-local-coder.git
cd chatgpt-local-coder
copy .env.example .env
npm install && npm run build
.\start.ps1                    # terminal 1
.\openai-tunnel.bat            # terminal 2 (tunnel cố định)
```

**ChatGPT:** Settings → Connectors → tạo connector → chọn tunnel → Refresh → chat mới.

**Bắt buộc tag connector mỗi chat:** Chat mới → **+** → **More** → bật connector, hoặc gõ **`@`** + tên connector trong ô chat. Nếu không tag, ChatGPT báo *"Đang tìm các công cụ có sẵn"* rồi *"Lỗi trong luồng tin nhắn"* — **server không có log lỗi** vì MCP chưa được gọi.

**WORKSPACE_PATH:** đặt đúng thư mục project (không phải thư mục `chatgpt-local-coder`). Server tự đọc `CLAUDE.md` / `AGENTS.md` giống Claude Code.

**Lưu ý:** Không bấm **"Luôn cho phép"** trên popup — cấu hình quyền ở Settings → Apps. Sau khi restart server: Refresh connector + mở chat mới + tag lại connector.

Chi tiết cho AI agent: [AGENTS.md](AGENTS.md)

# MCP_Plugins_With_ChatGPTWeb
