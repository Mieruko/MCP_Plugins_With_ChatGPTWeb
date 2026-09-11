#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SETUP_VERSION = "1";

function parseEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

export function readSetupEnv(root) {
  return parseEnvFile(path.join(root, ".env"));
}

function cleanValue(value) {
  return String(value ?? "").replace(/[\r\n]/g, "").trim();
}

export function writeEnvValues(root, updates) {
  const file = path.join(root, ".env");
  const example = path.join(root, ".env.example");
  let lines = fs.existsSync(file)
    ? fs.readFileSync(file, "utf8").split(/\r?\n/)
    : fs.existsSync(example)
      ? fs.readFileSync(example, "utf8").split(/\r?\n/)
      : [];

  for (const [key, rawValue] of Object.entries(updates)) {
    const value = cleanValue(rawValue);
    const matcher = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`);
    let replaced = false;
    lines = lines.map(line => {
      if (!replaced && matcher.test(line) && !line.trimStart().startsWith("#")) {
        replaced = true;
        return `${key}=${value}`;
      }
      return line;
    });
    if (!replaced) lines.push(`${key}=${value}`);
  }

  while (lines.length && lines.at(-1) === "") lines.pop();
  fs.writeFileSync(file, `${lines.join(os.EOL)}${os.EOL}`, "utf8");
}

export function findCloudflared(root) {
  const exe = process.platform === "win32" ? "cloudflared.exe" : "cloudflared";
  const candidates = [path.join(root, "bin", exe), path.join(root, exe)];
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", ["cloudflared"], { encoding: "utf8", windowsHide: true });
  if (probe.status === 0) return "cloudflared";
  return null;
}

function cloudflaredAssetName() {
  const arch = process.arch === "arm64" ? "arm64" : "amd64";
  if (process.platform === "win32") return `cloudflared-windows-${arch}.exe`;
  if (process.platform === "linux") return `cloudflared-linux-${arch}`;
  return null;
}

export async function installCloudflared(root) {
  const existing = findCloudflared(root);
  if (existing) return existing;
  const asset = cloudflaredAssetName();
  if (!asset) throw new Error("Automatic cloudflared install is currently supported on Windows and Linux only.");

  const url = `https://github.com/cloudflare/cloudflared/releases/latest/download/${asset}`;
  const dir = path.join(root, "bin");
  const target = path.join(dir, process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
  fs.mkdirSync(dir, { recursive: true });
  console.log("  Downloading cloudflared from the official Cloudflare GitHub release...");
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`cloudflared download failed: HTTP ${response.status}`);
  fs.writeFileSync(target, Buffer.from(await response.arrayBuffer()));
  if (process.platform !== "win32") fs.chmodSync(target, 0o755);
  const check = spawnSync(target, ["--version"], { encoding: "utf8", windowsHide: true });
  if (check.status !== 0) throw new Error("Downloaded cloudflared could not be executed.");
  return target;
}

function askSecret(promptText) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
    return Promise.resolve("");
  }
  return new Promise((resolve, reject) => {
    let value = "";
    const stdin = process.stdin;
    const stdout = process.stdout;
    const previousRaw = stdin.isRaw;
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(Boolean(previousRaw));
      stdin.pause();
    };
    const onData = chunk => {
      for (const char of String(chunk)) {
        if (char === "\u0003") {
          cleanup();
          stdout.write("\n");
          reject(new Error("Setup cancelled"));
          return;
        }
        if (char === "\r" || char === "\n") {
          cleanup();
          stdout.write("\n");
          resolve(value.trim());
          return;
        }
        if (char === "\u0008" || char === "\u007f") {
          if (value.length) {
            value = value.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }
        if (char >= " ") {
          value += char;
          stdout.write("*");
        }
      }
    };
    stdout.write(promptText);
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function askYesNo(rl, text, defaultYes = true) {
  const suffix = defaultYes ? " [Y/n] " : " [y/N] ";
  const answer = (await rl.question(text + suffix)).trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

function validTunnelId(value) {
  return /^tunnel_[0-9a-f]{32}$/i.test(value);
}

function openUrl(url) {
  try {
    if (process.platform === "win32") spawnSync("cmd", ["/c", "start", "", url], { stdio: "ignore", windowsHide: true });
    else if (process.platform === "darwin") spawnSync("open", [url], { stdio: "ignore" });
    else spawnSync("xdg-open", [url], { stdio: "ignore" });
  } catch {}
}

export function installOpenAiTunnelClient(root) {
  if (process.platform !== "win32") throw new Error("OpenAI Secure MCP Tunnel helper is currently Windows-only in this project.");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "openai-tunnel.ps1"), "-Install"], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    windowsHide: false,
  });
  if (result.status !== 0) throw new Error("Could not install tunnel-client.");
  return path.join(root, "bin", "tunnel-client.exe");
}

export function validateOpenAiTunnelReadAccess(binary, { tunnelId, apiKey, organizationId }) {
  const env = {
    ...process.env,
    OPENAI_TUNNEL_API_KEY: apiKey,
    CONTROL_PLANE_API_KEY: apiKey,
    CONTROL_PLANE_TUNNEL_ID: tunnelId,
  };
  if (organizationId) env.CONTROL_PLANE_ORGANIZATION_ID = organizationId;
  else delete env.CONTROL_PLANE_ORGANIZATION_ID;
  const result = spawnSync(binary, ["admin", "--json", "tunnels", "get", tunnelId], {
    env,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status === 0) return { ok: true, message: "Tunnel metadata access OK." };
  const detail = `${result.stdout || ""}\n${result.stderr || ""}`;
  if (detail.includes("tunnel_active_organization_required")) {
    return { ok: false, code: "organization", message: "This tunnel requires the organization ID that owns it." };
  }
  if (detail.includes("tunnel_use_forbidden") || detail.includes("permission")) {
    return { ok: false, code: "permission", message: "This Runtime API key does not have access to this tunnel. It needs Tunnels Read + Use." };
  }
  return { ok: false, code: "unknown", message: "OpenAI could not validate this tunnel with the supplied Runtime API key." };
}

export async function runOpenAiTunnelRepair({ root, reason = "unknown" } = {}) {
  if (!root) throw new Error("root is required");
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("OpenAI Tunnel needs repair, but this terminal is not interactive.");
    console.error("Run `npm run repair:tunnel` in a terminal.");
    return { repaired: false, env: readSetupEnv(root) };
  }

  const current = readSetupEnv(root);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("\nOpenAI Tunnel - Repair\n");
    if (reason === "permission") console.log("  Problem: Runtime API key cannot use the selected tunnel.");
    else if (reason === "organization") console.log("  Problem: the selected tunnel requires its owning organization ID.");
    else if (reason === "binary") console.log("  Problem: tunnel-client is missing, damaged, or the wrong version.");
    else console.log("  Problem: OpenAI Tunnel configuration or connectivity needs attention.");

    // Always self-heal the local client first. This preserves all credentials
    // and tunnel settings when only the executable was missing/corrupt.
    const binary = installOpenAiTunnelClient(root);
    if (reason === "binary") {
      console.log("\n  tunnel-client repaired. Existing tunnel settings were kept.\n");
      return { repaired: true, env: readSetupEnv(root), action: "retry" };
    }

    console.log("\n  1) Enter a new Runtime API key");
    console.log("  2) Choose another Tunnel ID");
    console.log("  3) Set/change Organization ID");
    console.log("  4) Switch to Cloudflare Quick Tunnel");
    console.log("  5) Start local-only");
    console.log("  6) Cancel\n");

    const defaultChoice = reason === "organization" ? "3" : reason === "permission" ? "1" : "2";
    let choice = (await rl.question(`Repair [${defaultChoice}]: `)).trim() || defaultChoice;
    if (!new Set(["1", "2", "3", "4", "5", "6"]).has(choice)) choice = defaultChoice;
    if (choice === "6") return { repaired: false, env: current, action: "cancel" };

    if (choice === "4") {
      let cloudflared = findCloudflared(root);
      if (!cloudflared) {
        console.log("  cloudflared is missing; installing it now...");
        cloudflared = await installCloudflared(root);
      }
      writeEnvValues(root, { TUNNEL_MODE: "cloudflare", SETUP_VERSION });
      console.log(`  Switched to Cloudflare: ${cloudflared}`);
      return { repaired: true, env: readSetupEnv(root), action: "restart" };
    }

    if (choice === "5") {
      writeEnvValues(root, { TUNNEL_MODE: "off", SETUP_VERSION });
      console.log("  Switched to local-only mode.");
      return { repaired: true, env: readSetupEnv(root), action: "restart" };
    }

    let tunnelId = cleanValue(current.OPENAI_TUNNEL_ID);
    let apiKey = cleanValue(current.OPENAI_TUNNEL_API_KEY);
    let organizationId = cleanValue(current.CONTROL_PLANE_ORGANIZATION_ID);

    if (choice === "1") {
      rl.pause();
      apiKey = await askSecret("New Runtime API key (hidden): ");
      rl.resume();
      if (!apiKey) throw new Error("Runtime API key was not changed.");
    } else if (choice === "2") {
      let nextId = cleanValue(await rl.question(`Tunnel ID${tunnelId ? ` [${tunnelId}]` : ""}: `)) || tunnelId;
      while (!validTunnelId(nextId)) {
        console.log("  Invalid Tunnel ID. Expected tunnel_ followed by 32 hexadecimal characters.");
        nextId = cleanValue(await rl.question("Tunnel ID: "));
      }
      tunnelId = nextId;
    } else if (choice === "3") {
      organizationId = cleanValue(await rl.question(`Organization ID${organizationId ? ` [${organizationId}]` : ""}: `)) || organizationId;
      if (!organizationId) throw new Error("Organization ID was not provided.");
    }

    if (!validTunnelId(tunnelId)) throw new Error("A valid OPENAI_TUNNEL_ID is required.");
    if (!apiKey) throw new Error("A Runtime API key is required.");

    const validation = validateOpenAiTunnelReadAccess(binary, { tunnelId, apiKey, organizationId });
    if (!validation.ok) {
      console.log(`\n  Repair validation failed: ${validation.message}`);
      console.log("  No tunnel credential changes were saved.");
      return { repaired: false, env: current, action: "retry", reason: validation.code };
    }

    writeEnvValues(root, {
      TUNNEL_MODE: "openai",
      OPENAI_TUNNEL_ID: tunnelId,
      OPENAI_TUNNEL_API_KEY: apiKey,
      CONTROL_PLANE_ORGANIZATION_ID: organizationId,
      SETUP_VERSION,
    });
    console.log("\n  OpenAI Tunnel repair saved. Existing workspace/UI settings were kept.\n");
    return { repaired: true, env: readSetupEnv(root), action: "retry" };
  } finally {
    rl.close();
  }
}

export function setupNeeded(root, env = readSetupEnv(root)) {
  if (!fs.existsSync(path.join(root, ".env"))) return true;
  if (env.SETUP_VERSION !== SETUP_VERSION) return true;
  const mode = String(env.TUNNEL_MODE || "auto").toLowerCase();
  if (mode === "openai" && (!env.OPENAI_TUNNEL_ID || !env.OPENAI_TUNNEL_API_KEY)) return true;
  if ((mode === "cloudflare" || mode === "auto") && !findCloudflared(root)) return true;
  return false;
}

export async function runInteractiveSetup({ root, launchCwd, force = false } = {}) {
  if (!root) throw new Error("root is required");
  const env = readSetupEnv(root);
  if (!force && !setupNeeded(root, env)) return { changed: false, env };
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.warn("  Setup is needed, but this terminal is not interactive. Run `npm run setup` in a terminal.");
    return { changed: false, env };
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("\nThe Replace - first-time setup\n");
    console.log("  1) Cloudflare Quick Tunnel  - easiest, OAuth works, public URL changes each run");
    console.log("  2) OpenAI Secure MCP Tunnel - stable tunnel, needs Tunnel ID + Runtime API key");
    console.log("  3) Local only               - no public tunnel\n");

    const currentMode = String(env.TUNNEL_MODE || "").toLowerCase();
    const defaultChoice = currentMode === "openai" ? "2" : currentMode === "off" ? "3" : "1";
    let choice = (await rl.question(`Tunnel [${defaultChoice}]: `)).trim() || defaultChoice;
    if (!new Set(["1", "2", "3"]).has(choice)) choice = defaultChoice;

    const defaultWorkspace = env.WORKSPACE_PATH || launchCwd || root;
    const workspace = cleanValue(await rl.question(`Workspace [${defaultWorkspace}]: `)) || defaultWorkspace;
    const updates = {
      WORKSPACE_PATH: workspace,
      SETUP_VERSION,
    };

    if (choice === "1") {
      updates.TUNNEL_MODE = "cloudflare";
      let binary = findCloudflared(root);
      if (!binary) {
        const install = await askYesNo(rl, "cloudflared is missing. Install it automatically?", true);
        if (!install) throw new Error("Cloudflare mode requires cloudflared. Re-run setup after installing it.");
        binary = await installCloudflared(root);
      }
      console.log(`  cloudflared ready: ${binary}`);
      console.log("  ChatGPT connection: Server URL + OAuth");
    } else if (choice === "2") {
      updates.TUNNEL_MODE = "openai";
      console.log("\n  OpenAI Tunnel requires a tunnel created for the same ChatGPT workspace.");
      console.log("  Runtime API key permissions required: Tunnels Read + Use.");
      console.log("  ChatGPT connection must use: Tunnel + No Auth.\n");
      if (await askYesNo(rl, "Open OpenAI tunnel + Runtime API key settings in your browser?", false)) {
        openUrl("https://platform.openai.com/settings/organization/tunnels");
        openUrl("https://platform.openai.com/settings/organization/api-keys");
      }
      const tunnelClient = installOpenAiTunnelClient(root);

      const currentId = cleanValue(env.OPENAI_TUNNEL_ID);
      let tunnelId = cleanValue(await rl.question(`Tunnel ID${currentId ? ` [${currentId}]` : ""}: `)) || currentId;
      while (!validTunnelId(tunnelId)) {
        console.log("  Invalid Tunnel ID. Expected tunnel_ followed by 32 hexadecimal characters.");
        tunnelId = cleanValue(await rl.question("Tunnel ID: "));
      }
      updates.OPENAI_TUNNEL_ID = tunnelId;

      let apiKey = cleanValue(env.OPENAI_TUNNEL_API_KEY);
      if (apiKey) {
        const keep = await askYesNo(rl, "Reuse the Runtime API key already stored in .env?", true);
        if (!keep) apiKey = "";
      }
      if (!apiKey) {
        rl.pause();
        apiKey = await askSecret("Runtime API key (hidden): ");
        rl.resume();
      }
      if (!apiKey) throw new Error("Runtime API key is required for OpenAI Secure MCP Tunnel.");
      updates.OPENAI_TUNNEL_API_KEY = apiKey;

      const currentOrg = cleanValue(env.CONTROL_PLANE_ORGANIZATION_ID);
      const org = cleanValue(await rl.question(`Organization ID (optional)${currentOrg ? ` [${currentOrg}]` : ""}: `)) || currentOrg;
      updates.CONTROL_PLANE_ORGANIZATION_ID = org;
      const validation = validateOpenAiTunnelReadAccess(tunnelClient, {
        tunnelId,
        apiKey,
        organizationId: org,
      });
      if (validation.ok) {
        console.log(`  ${validation.message}`);
      } else {
        console.log(`\n  WARNING: ${validation.message}`);
        if (validation.code === "organization") console.log("  Copy the owning org_... ID into the Organization ID field and run setup again.");
        const keep = await askYesNo(rl, "Save this OpenAI tunnel configuration anyway?", false);
        if (!keep) throw new Error("OpenAI tunnel setup was not saved. Fix the tunnel/key permissions and run `npm run setup` again.");
      }
      console.log("  OpenAI tunnel configuration saved. Startup will also check live Use permission in the tunnel logs.");
    } else {
      updates.TUNNEL_MODE = "off";
      console.log("  Public tunnel disabled. Workbench will remain local-only.");
    }

    const openUi = await askYesNo(rl, "Open Workbench automatically on startup?", env.OPEN_UI !== "0");
    updates.OPEN_UI = openUi ? "1" : "0";
    writeEnvValues(root, updates);
    console.log("\n  Setup saved to .env.");
    console.log("  Run `npm run setup` any time to change these settings.\n");
    return { changed: true, env: readSetupEnv(root) };
  } finally {
    rl.close();
  }
}

const isCli = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isCli) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  try {
    if (process.argv.includes("--repair-openai")) {
      await runOpenAiTunnelRepair({ root, reason: "unknown" });
    } else {
      await runInteractiveSetup({ root, launchCwd: process.cwd(), force: true });
    }
  } catch (error) {
    console.error(`\nSetup failed: ${error.message}\n`);
    process.exit(1);
  }
}