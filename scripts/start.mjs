#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  findCloudflared,
  installOpenAiTunnelClient,
  runInteractiveSetup,
  runOpenAiTunnelRepair,
  setupNeeded,
} from "./setup.mjs";

const launchCwd = process.cwd();
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const args = new Set(process.argv.slice(2));

function readDotEnv() {
  const file = path.join(root, ".env");
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

const initialEnv = readDotEnv();
const wantsSetup = args.has("--setup");
if (!args.has("--no-setup") && (wantsSetup || setupNeeded(root, initialEnv))) {
  try {
    await runInteractiveSetup({ root, launchCwd, force: wantsSetup });
  } catch (error) {
    console.error(`\nSetup failed: ${error.message}\n`);
    process.exit(1);
  }
}

const envFile = readDotEnv();
for (const [key, value] of Object.entries(envFile)) {
  if (process.env[key] === undefined || process.env[key] === "") process.env[key] = value;
}

// Resolve launcher options only after .env has been loaded. Otherwise values
// such as TUNNEL_MODE=openai/cloudflare in .env are silently ignored.
const tunnelMode = String(process.env.TUNNEL_MODE || "auto").trim().toLowerCase();
const noOpen = args.has("--no-open") || process.env.OPEN_UI === "0";
const noTunnel = args.has("--no-tunnel") || tunnelMode === "off";
const forceCloudflare = args.has("--cloudflare") || tunnelMode === "cloudflare";
const forceOpenAI = args.has("--openai") || tunnelMode === "openai";
const verbose = args.has("--verbose") || process.env.START_VERBOSE === "1";
const runtimeLogDir = path.join(root, ".runtime-logs");
const runtimeLogPath = path.join(runtimeLogDir, "npm-start.log");
fs.mkdirSync(runtimeLogDir, { recursive: true });
const runtimeLog = fs.createWriteStream(runtimeLogPath, { flags: "a" });
runtimeLog.write(`\n\n=== npm start ${new Date().toISOString()} ===\n`);

function appendRuntimeLog(source, chunk) {
  const text = chunk?.toString?.() ?? String(chunk ?? "");
  runtimeLog.write(`[${source}] ${text}`);
}

function relayRuntimeOutput(stream, output, source) {
  stream?.on("data", chunk => {
    appendRuntimeLog(source, chunk);
    if (verbose) output.write(chunk);
  });
}

async function waitForHttp(url, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  throw new Error(`Timed out waiting for ${url}${lastError ? ` (${lastError.message})` : ""}`);
}

async function freePort(preferred) {
  for (let port = preferred; port < preferred + 100; port++) {
    if (process.platform === "win32") {
      const result = spawnSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8", windowsHide: true });
      const busy = String(result.stdout || "")
        .split(/\r?\n/)
        .some(line => {
          const parts = line.trim().split(/\s+/);
          return parts.length >= 4 && parts.includes("LISTENING") && String(parts[1] || "").endsWith(`:${port}`);
        });
      if (!busy) return port;
      continue;
    }
    const canBind = host => new Promise(resolve => {
      const server = net.createServer();
      server.unref();
      server.once("error", () => resolve(false));
      server.listen({ host, port, ipv6Only: host === "::1" }, () => server.close(() => resolve(true)));
    });
    // Workbench binds IPv4 while the MCP listener may bind IPv6/wildcard.
    // A port is safe only when neither loopback family is already occupied.
    if (await canBind("127.0.0.1") && await canBind("::1")) return port;
  }
  throw new Error(`No free port near ${preferred}`);
}

function openBrowser(url) {
  if (noOpen) return;
  try {
    if (process.platform === "win32") spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    else if (process.platform === "darwin") spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    else spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  } catch {}
}

function runBuildIfNeeded() {
  const dist = path.join(root, "dist", "index.js");
  const src = path.join(root, "src", "index.ts");
  const needsBuild = !fs.existsSync(dist) || (fs.existsSync(src) && fs.statSync(src).mtimeMs > fs.statSync(dist).mtimeMs);
  if (!needsBuild) return;
  console.log("  Building project...");
  // Recent Node versions on Windows can reject direct .cmd execution with
  // EINVAL. npm exposes its JS entry point while running lifecycle scripts,
  // so invoke that with Node instead of spawning npm.cmd directly.
  const npmExecPath = process.env.npm_execpath;
  const command = npmExecPath && fs.existsSync(npmExecPath) ? process.execPath : (process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "npm");
  const buildArgs = npmExecPath && fs.existsSync(npmExecPath)
    ? [npmExecPath, "run", "build"]
    : (process.platform === "win32" ? ["/d", "/s", "/c", "npm.cmd run build"] : ["run", "build"]);
  const result = spawnSync(command, buildArgs, { cwd: root, stdio: "inherit", env: process.env });
  if (result.error) {
    console.error(`\nBuild failed to start: ${result.error.message}\n`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function cloudflaredPath() {
  return findCloudflared(root);
}

function startCloudflareTunnel(port) {
  return new Promise((resolve, reject) => {
    const binary = cloudflaredPath();
    if (!binary) return reject(new Error("cloudflared is not installed"));
    const child = spawn(binary, ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"], {
      cwd: root,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill();
        reject(new Error("cloudflared did not publish a URL"));
      }
    }, 15000);
    const consume = chunk => {
      const text = chunk.toString();
      appendRuntimeLog("cloudflare", chunk);
      buffer = (buffer + text).slice(-12000);
      const match = buffer.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ child, publicUrl: match[0] });
      }
    };
    child.stdout.on("data", consume);
    child.stderr.on("data", consume);
    child.once("error", error => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    child.once("exit", code => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`cloudflared exited with code ${code}`));
      }
    });
  });
}

function startOpenAiTunnel(port, onRepairableFailure) {
  if (process.platform !== "win32") throw new Error("OpenAI tunnel helper is currently Windows-only");
  const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "openai-tunnel.ps1"), "-Port", String(port), "-Force"], {
    cwd: root,
    env: process.env,
    windowsHide: true,
    stdio: ["inherit", "pipe", "pipe"],
  });
  const shown = new Set();
  let repairTriggered = false;
  const relay = (stream, output, source) => stream.on("data", chunk => {
    const text = chunk.toString();
    appendRuntimeLog(source, chunk);
    if (verbose) output.write(chunk);
    if (text.includes("tunnel_use_forbidden") && !shown.has("use")) {
      shown.add("use");
      console.error("\n[OpenAI Tunnel] Runtime API key cannot USE this tunnel.");
      console.error("Opening repair flow for Runtime key / Tunnel ID...\n");
      if (!repairTriggered && onRepairableFailure) {
        repairTriggered = true;
        setImmediate(() => onRepairableFailure("permission"));
      }
    }
    if (text.includes("tunnel_active_organization_required") && !shown.has("org")) {
      shown.add("org");
      console.error("\n[OpenAI Tunnel] This tunnel requires its owning organization context.");
      console.error("Opening repair flow for Organization ID...\n");
      if (!repairTriggered && onRepairableFailure) {
        repairTriggered = true;
        setImmediate(() => onRepairableFailure("organization"));
      }
    }
  });
  relay(child.stdout, process.stdout, "openai-tunnel:stdout");
  relay(child.stderr, process.stderr, "openai-tunnel:stderr");
  return child;
}

function stopTree(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else child.kill("SIGTERM");
  } catch {}
}

const mcpPort = await freePort(Number(process.env.PORT || 3000));
let adminPort = await freePort(Number(process.env.ADMIN_PORT || 3001));
if (adminPort === mcpPort) adminPort = await freePort(adminPort + 1);
process.env.PORT = String(mcpPort);
process.env.ADMIN_PORT = String(adminPort);

if (!process.env.WORKSPACE_PATH) process.env.WORKSPACE_PATH = launchCwd;

runBuildIfNeeded();

if (!verbose) console.log("\nStarting The Replace Workbench…");

let tunnelChild = null;
let tunnelLabel = "disabled";
let effectiveConnectionMode = "local";
const hasOpenAiConfig = Boolean(process.env.OPENAI_TUNNEL_ID && process.env.OPENAI_TUNNEL_API_KEY);
// Cloudflare remains the default tunnel. OpenAI Tunnel is opt-in via
// --openai or TUNNEL_MODE=openai; merely having credentials must not change
// the normal npm start behavior.
const useOpenAiTunnel = !noTunnel && forceOpenAI && hasOpenAiConfig;
if (!noTunnel && forceOpenAI && !hasOpenAiConfig) {
  console.error("\nOpenAI Tunnel was requested but OPENAI_TUNNEL_ID / OPENAI_TUNNEL_API_KEY are not configured.");
  console.error("Run `npm run setup` to configure the tunnel, or choose Cloudflare/local-only there.\n");
  process.exit(1);
}
if (useOpenAiTunnel) {
  // Self-heal the local tunnel-client before MCP starts. Missing, damaged, or
  // outdated binaries are repaired without asking for credentials again.
  try {
    installOpenAiTunnelClient(root);
  } catch (error) {
    console.error(`\nOpenAI Tunnel client repair failed: ${error.message}`);
    console.error("Run `npm run repair:tunnel` after checking network access.\n");
    process.exit(1);
  }
  tunnelLabel = "OpenAI secure tunnel";
  effectiveConnectionMode = "openai";
  // Never advertise a stale public Cloudflare origin through OAuth metadata
  // while Secure MCP Tunnel is in use. The connector authenticates via the
  // tunnel connection, while tunnel-client injects the local MCP Bearer token.
  process.env.PUBLIC_BASE_URL = `http://127.0.0.1:${mcpPort}`;
}

// Cloudflare Quick Tunnel must start first so its public URL can become the
// OAuth issuer before the MCP server boots. The OpenAI tunnel helper expects
// MCP to already be listening, so that mode starts immediately after server.
if (!noTunnel && !useOpenAiTunnel && (forceCloudflare || cloudflaredPath())) {
  // Managed Quick Tunnels get a fresh URL every run. Never let a stale URL
  // from .env survive when cloudflared fails before publishing the new one.
  delete process.env.PUBLIC_BASE_URL;
  try {
    const tunnel = await startCloudflareTunnel(mcpPort);
    tunnelChild = tunnel.child;
    process.env.PUBLIC_BASE_URL = tunnel.publicUrl;
    tunnelLabel = tunnel.publicUrl;
    effectiveConnectionMode = "cloudflare";
  } catch (error) {
    console.warn(`  Tunnel: skipped (${error.message})`);
  }
}

process.env.LOCAL_CODER_CONNECTION_MODE = effectiveConnectionMode;

const workbenchUrl = `http://127.0.0.1:${adminPort}/ui/workbench.html`;
const workbenchBootstrapToken = randomBytes(32).toString("hex");

function printReadySummary() {
  if (!verbose && process.stdout.isTTY) console.clear();
  console.log("\nThe Replace Workbench — READY\n");
  console.log(`  Workbench  ${workbenchUrl}`);
  console.log(`  MCP        http://127.0.0.1:${mcpPort}/mcp`);
  console.log(`  Tunnel     ${tunnelLabel}`);
  console.log(`  Workspace  ${process.env.WORKSPACE_PATH}`);
  console.log(`  Logs       ${runtimeLogPath}`);
  if (!verbose) console.log("  Debug      npm start -- --verbose");
  console.log("\n  Press Ctrl+C to stop everything.\n");
}

const server = spawn(process.execPath, [path.join(root, "dist", "index.js")], {
  cwd: root,
  env: { ...process.env, WORKBENCH_BOOTSTRAP_TOKEN: workbenchBootstrapToken },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
relayRuntimeOutput(server.stdout, process.stdout, "server:stdout");
relayRuntimeOutput(server.stderr, process.stderr, "server:stderr");

let repairingOpenAiTunnel = false;
async function repairOpenAiTunnel(reason) {
  if (repairingOpenAiTunnel) return;
  repairingOpenAiTunnel = true;
  stopTree(tunnelChild);
  tunnelChild = null;
  try {
    const result = await runOpenAiTunnelRepair({ root, reason });
    if (!result.repaired) {
      console.error("\nOpenAI Tunnel is still unavailable. MCP/Workbench remain running locally.");
      console.error("Run `npm run repair:tunnel` when ready, or restart with `npm start -- --cloudflare`.\n");
      return;
    }

    if (result.action === "restart") {
      console.log("\nTunnel mode changed. Restart `npm start` once to apply the new mode cleanly.\n");
      return;
    }

    // Refresh only tunnel-related environment values. MCP stays running and
    // the repaired OpenAI tunnel reconnects to the same local MCP port.
    for (const key of ["OPENAI_TUNNEL_ID", "OPENAI_TUNNEL_API_KEY", "CONTROL_PLANE_ORGANIZATION_ID", "TUNNEL_MODE"]) {
      const value = result.env?.[key];
      if (value) process.env[key] = value;
      else delete process.env[key];
    }
    console.log("\nRetrying OpenAI Tunnel with repaired settings...\n");
    tunnelChild = startOpenAiTunnel(mcpPort, repairOpenAiTunnel);
  } catch (error) {
    console.error(`\nOpenAI Tunnel repair failed: ${error.message}`);
    console.error("MCP/Workbench remain running locally. Use `npm run repair:tunnel` to try again.\n");
  } finally {
    repairingOpenAiTunnel = false;
  }
}

if (useOpenAiTunnel) {
  tunnelChild = startOpenAiTunnel(mcpPort, repairOpenAiTunnel);
}

const shutdown = () => {
  stopTree(server);
  stopTree(tunnelChild);
  runtimeLog.end();
};
process.once("SIGINT", () => { shutdown(); process.exit(0); });
process.once("SIGTERM", () => { shutdown(); process.exit(0); });
process.once("exit", shutdown);

let startupComplete = false;
server.once("exit", code => {
  stopTree(tunnelChild);
  if (!startupComplete) {
    console.error(`\nWorkbench server stopped before startup completed. See ${runtimeLogPath}\n`);
  }
  runtimeLog.end();
  process.exit(code ?? 0);
});

try {
  await Promise.all([
    waitForHttp(`http://127.0.0.1:${mcpPort}/health`),
    waitForHttp(workbenchUrl),
  ]);
  startupComplete = true;
  printReadySummary();
  setTimeout(() => openBrowser(`${workbenchUrl}#bootstrap=${encodeURIComponent(workbenchBootstrapToken)}`), 100);
} catch (error) {
  console.error(`\nStartup failed: ${error.message}`);
  console.error(`Detailed logs: ${runtimeLogPath}\n`);
  shutdown();
  process.exit(1);
}
