/**
 * Full verification suite for ChatGPT MCP readiness.
 */
import { spawn } from "node:child_process";
import path from "path";
import { fileURLToPath } from "url";
import fs from "node:fs/promises";
import os from "node:os";
import { freePorts } from "./test-ports.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const [mcpPort, adminPort] = await freePorts(2);

function runNode(script, env = {}) {
  const scriptPath = path.join(root, script);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${script} exit ${code}`))));
  });
}

function runBuild() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "node_modules/typescript/bin/tsc")], {
      cwd: root,
      env: process.env,
      stdio: "inherit",
    });
    child.on("error", () => {
      const fallback = spawn("npm", ["run", "build"], { cwd: root, stdio: "inherit", shell: true });
      fallback.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`build exit ${code}`))));
    });
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tsc exit ${code}`))));
  });
}

async function waitFor(url, ms = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const res = await fetch(url, { headers: { Authorization: "Bearer all-test-admin" } });
      if (res.ok) return await res.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timeout ${url}`);
}

console.log("=== Build ===");
await runBuild();

const unitScripts = [
  "scripts/test-state-ownership.mjs",
  "scripts/test-patch.mjs",
  "scripts/test-tools.mjs",
  "scripts/test-checkpoints.mjs",
  "scripts/test-activity-log.mjs",
  "scripts/test-project-memory.mjs",
  "scripts/test-auto-memory.mjs",
  "scripts/test-tool-profile.mjs",
  "scripts/test-skills.mjs",
  "scripts/test-shell-persist.mjs",
  "scripts/test-chatgpt-web.mjs",
  "scripts/test-continuity.mjs",
  "scripts/test-handoff-expiry.mjs",
  "scripts/test-control-permissions.mjs",
  "scripts/test-workbench.mjs",
  "scripts/test-experience.mjs",
];

if (!process.argv.includes("--readiness-only")) {
  console.log("\n=== Unit tests ===");
  for (const script of unitScripts) {
    console.log(`\n--- ${script} ---`);
    await runNode(script);
  }
}

console.log("\n=== Integration (spawn server) ===");
const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-all-tests-"));
const control = path.join(fixtureRoot, "control");
const workspace = path.join(fixtureRoot, "project");
await fs.mkdir(workspace);
await fs.writeFile(path.join(fixtureRoot, "upstream.json"), '{"version":1,"servers":[]}');
const server = spawn(process.execPath, [path.join(root, "dist/index.js")], {
  cwd: fixtureRoot,
  windowsHide: true,
  env: {
    ...process.env,
    PORT: String(mcpPort),
    ADMIN_PORT: String(adminPort),
    CHATGPT_TOOL_PROFILE: "slim",
    ADMIN_TOKEN: "all-test-admin", MCP_AUTH_TOKEN: "all-test-mcp", WORKBENCH_PATH: control, WORKBENCH_DEFAULT_MODE: "full",
    WORKBENCH_EXPERIENCE: "advanced", WORKBENCH_REMOTE_POLICY_CONTROL: "false",
    WORKSPACE_PATH: workspace, WORKSPACE_PATHS: "", EXTRA_WORKSPACE_PATHS: "", ALLOWED_WORKSPACE_PATHS: "",
    CODEX_HOME: path.join(fixtureRoot, "codex"), MCP_UPSTREAM_CONFIG: path.join(fixtureRoot, "upstream.json"),
    AUDIT_LOG_PATH: path.join(fixtureRoot, "audit.log"), CHECKPOINT_PATH: path.join(fixtureRoot, "checkpoints"),
    MCP_SHELL_STATE_DIR: path.join(fixtureRoot, "shell"), PUBLIC_BASE_URL: `http://127.0.0.1:${mcpPort}`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let serverLog = "";
server.stdout?.on("data", (d) => (serverLog += d));
server.stderr?.on("data", (d) => (serverLog += d));

try {
  const health = await waitFor(`http://127.0.0.1:${mcpPort}/health`);
  if (!health.instructions?.tool_profile) throw new Error("health missing instructions");
  console.log(`OK  health: profile=${health.instructions.tool_profile}, memory=${health.instructions.memory_files?.length ?? 0} files`);

  const admin = await waitFor(`http://127.0.0.1:${adminPort}/health`);
  if (!admin.instructions) throw new Error("admin health missing instructions");
  console.log("OK  admin health");

  const preview = await (await fetch(`http://127.0.0.1:${adminPort}/api/instructions/preview`, { headers: { Authorization: "Bearer all-test-admin" } })).json();
  if (!preview.preview?.includes("Agent workflow")) throw new Error("instructions preview missing agent prompt");
  console.log(`OK  instructions preview ${preview.total_chars} chars`);

  // MCP session + tools/list count
  const initRes = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer all-test-mcp" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    }),
  });
  const sid = initRes.headers.get("mcp-session-id");
  if (!sid) throw new Error("no session id");

  const listRes = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "mcp-session-id": sid,
      "mcp-protocol-version": "2025-03-26",
      Authorization: "Bearer all-test-mcp",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });
  const listText = await listRes.text();
  const listJson = JSON.parse(listText);
  const tools = listJson?.result?.tools || [];
  const bytes = Buffer.byteLength(listText, "utf-8");
  console.log(`OK  tools/list: ${tools.length} tools, ${Math.round(bytes / 1024)}KB`);
  if (health.instructions.tool_profile !== "slim") throw new Error("Readiness fixture did not use the slim profile");
  if (!tools.some((t) => t.name === "apply_patch")) throw new Error("apply_patch missing");
  if (!tools.some((t) => t.name === "task_complete")) throw new Error("task_complete missing");

  process.env.PORT = String(mcpPort);
  await runNode("scripts/test-mcp-session.mjs", { PORT: String(mcpPort), MCP_AUTH_TOKEN: "all-test-mcp" });
  console.log("OK  test-mcp-session");
} finally {
  const closed = new Promise(resolve => server.once("exit", resolve));
  server.kill();
  await closed;
  if (path.dirname(fixtureRoot) === path.resolve(os.tmpdir()) && path.basename(fixtureRoot).startsWith("workbench-all-tests-")) await fs.rm(fixtureRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

console.log(process.argv.includes("--readiness-only") ? "\n=== READINESS TESTS PASSED ===" : "\n=== ALL TESTS PASSED ===");
