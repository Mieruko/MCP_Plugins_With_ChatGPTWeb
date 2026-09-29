# Setup, tunnels and troubleshooting

[Back to README](../README.md) · [Computer Use](computer-use.md)

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
