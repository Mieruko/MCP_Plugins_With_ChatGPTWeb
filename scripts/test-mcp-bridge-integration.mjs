/**
 * Integration: hub server + mock upstream + meta tools + proxy tool.
 * Self-contained — spawns child processes on random ports.
 */
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "node:child_process";
import { freePorts } from "./test-ports.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const scratch = process.env.GOAL_SCRATCH || path.join(root, ".tool-test-tmp", "bridge-integration");

const [mcpPort, adminPort, mockPort] = await freePorts(3);
const tmpDir = path.join(scratch, `run-${mcpPort}`);

function spawnNode(script, env = {}) {
  return spawn(process.execPath, [script], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitFor(url, timeoutMs = 20000) {
  const start = Date.now();
  let lastErr = "unknown";
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { headers: { Authorization: "Bearer bridge-test-admin" } });
      const text = await res.text();
      if (res.ok) {
        return text ? JSON.parse(text) : {};
      }
      lastErr = `HTTP ${res.status}: ${text.slice(0, 200)}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timeout ${url} (${lastErr})`);
}

async function mcpPost(base, body, sessionId, extraHeaders = {}) {
  const headers = {
    Authorization: "Bearer bridge-test-mcp",
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...extraHeaders,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const res = await fetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`invalid JSON from ${base}/mcp: ${text.slice(0, 300)}`);
  }
  return { status: res.status, headers: res.headers, json, text };
}

async function callTool(base, sessionId, name, args = {}) {
  const { status, json } = await mcpPost(
    base,
    { jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } },
    sessionId
  );
  if (status !== 200) throw new Error(`tools/call ${name} HTTP ${status}: ${JSON.stringify(json)}`);
  return json;
}

await fs.mkdir(tmpDir, { recursive: true });

const configPath = path.join(tmpDir, "mcp-upstream.json");
await fs.writeFile(
  configPath,
  JSON.stringify(
    {
      version: 1,
      servers: [
        {
          id: "mockhttp",
          name: "Mock HTTP",
          enabled: true,
          transport: "http",
          url: `http://127.0.0.1:${mockPort}/mcp`,
          expose: "meta_only",
          tools: [],
          tool_prefix: "mockhttp",
        },
      ],
    },
    null,
    2
  ),
  "utf-8"
);

const mockHttp = spawnNode(path.join(root, "scripts/mock-http-mcp.mjs"), { MOCK_HTTP_MCP_PORT: String(mockPort) });
const hub = spawnNode(path.join(root, "dist/index.js"), {
  PORT: String(mcpPort),
  ADMIN_PORT: String(adminPort),
  MCP_UPSTREAM_CONFIG: configPath,
  WORKSPACE_PATH: root,
  MCP_AUTH_TOKEN: "bridge-test-mcp", ADMIN_TOKEN: "bridge-test-admin", WORKBENCH_PATH: path.join(tmpDir, "workbench"), WORKBENCH_DEFAULT_MODE: "full", CHATGPT_TOOL_PROFILE: "full",
  WORKBENCH_EXPERIENCE: "advanced",
});

let hubLog = "";
let mockLog = "";
hub.stdout.on("data", (d) => (hubLog += d.toString()));
hub.stderr.on("data", (d) => (hubLog += d.toString()));
mockHttp.stdout.on("data", (d) => (mockLog += d.toString()));
mockHttp.stderr.on("data", (d) => (mockLog += d.toString()));
hub.on("exit", (code) => {
  hubLog += `\n[hub exit ${code}]`;
});

const logLines = [];
function log(msg) {
  logLines.push(msg);
  console.log(msg);
}

try {
  log(`ports mcp=${mcpPort} admin=${adminPort} mock=${mockPort}`);
  await waitFor(`http://127.0.0.1:${mockPort}/health`);
  await waitFor(`http://127.0.0.1:${mcpPort}/health`);
  await waitFor(`http://127.0.0.1:${adminPort}/health`);

  const init = await mcpPost(
    `http://127.0.0.1:${mcpPort}`,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "bridge-integration", version: "1.0.0" },
      },
    },
    null
  );
  const sessionId = init.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("missing session id");

  await mcpPost(
    `http://127.0.0.1:${mcpPort}`,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    sessionId,
    { "mcp-protocol-version": "2025-03-26" }
  );

  const servers = await callTool(`http://127.0.0.1:${mcpPort}`, sessionId, "mcp_servers", {});
  const serversPayload = JSON.parse(servers.result.content[0].text);
  if (!serversPayload.ok || serversPayload.data.count < 1) throw new Error(JSON.stringify(serversPayload));

  const tools = await callTool(`http://127.0.0.1:${mcpPort}`, sessionId, "mcp_tools", { server_id: "mockhttp" });
  const toolsPayload = JSON.parse(tools.result.content[0].text);
  if (!toolsPayload.ok || toolsPayload.data.count < 1) throw new Error(JSON.stringify(toolsPayload));

  const called = await callTool(`http://127.0.0.1:${mcpPort}`, sessionId, "mcp_call", {
    server_id: "mockhttp",
    tool: "add",
    arguments: { a: 4, b: 6 },
  });
  const callPayload = JSON.parse(called.result.content[0].text);
  if (!callPayload.ok) throw new Error(JSON.stringify(callPayload));
  const outputText = JSON.stringify(callPayload.data);
  if (!outputText.includes("10")) throw new Error(outputText);

  const listBefore = await mcpPost(
    `http://127.0.0.1:${mcpPort}`,
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    sessionId,
    { "mcp-protocol-version": "2025-03-26" }
  );
  const toolNamesBefore = listBefore.json.result.tools.map((t) => t.name);
  if (toolNamesBefore.includes("mockhttp__add")) {
    throw new Error(`proxy should not exist before allowlist: ${toolNamesBefore.join(",")}`);
  }
  log(`tools/list before allowlist: mockhttp__add absent (${toolNamesBefore.length} tools)`);

  const enableProxy = await (
    await fetch(`http://127.0.0.1:${adminPort}/api/upstream`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer bridge-test-admin" },
      body: JSON.stringify({
        server: {
          id: "mockhttp",
          name: "Mock HTTP",
          enabled: true,
          transport: "http",
          url: `http://127.0.0.1:${mockPort}/mcp`,
          expose: "allowlist",
          tools: ["add"],
          tool_prefix: "mockhttp",
        },
      }),
    })
  ).json();
  if (!enableProxy.ok) throw new Error(JSON.stringify(enableProxy));
  log("admin API enabled allowlist proxy for mockhttp__add");

  const listAfter = await mcpPost(
    `http://127.0.0.1:${mcpPort}`,
    { jsonrpc: "2.0", id: 3, method: "tools/list", params: {} },
    sessionId,
    { "mcp-protocol-version": "2025-03-26" }
  );
  const toolNamesAfter = listAfter.json.result.tools.map((t) => t.name);
  if (!toolNamesAfter.includes("mockhttp__add")) {
    throw new Error(`proxy missing after allowlist: ${toolNamesAfter.join(",")}`);
  }
  log(`tools/list after allowlist: mockhttp__add present`);

  const proxied = await callTool(`http://127.0.0.1:${mcpPort}`, sessionId, "mockhttp__add", { a: 1, b: 2 });
  const proxiedPayload = JSON.parse(proxied.result.content[0].text);
  if (!proxiedPayload.ok) throw new Error(JSON.stringify(proxiedPayload));

  const adminHtml = await (await fetch(`http://127.0.0.1:${adminPort}/ui/`)).text();
  if (!adminHtml.includes("Import") || !adminHtml.includes("Claude Code") || !adminHtml.includes("OpenCode")) {
    throw new Error("admin ui missing expected import controls");
  }

  const fixture = path.join(tmpDir, "cursor-mcp-fixture.json");
  await fs.writeFile(
    fixture,
    JSON.stringify({ mcpServers: { imported: { command: "node", args: ["x.js"] } } }),
    "utf-8"
  );
  const imported = await (
    await fetch(`http://127.0.0.1:${adminPort}/api/import/cursor`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer bridge-test-admin" },
      body: JSON.stringify({ path: fixture, merge: true }),
    })
  ).json();
  if (!imported.ok || !imported.imported.includes("imported")) throw new Error(JSON.stringify(imported));

  log("OK  bridge integration complete");
  await fs.writeFile(
    path.join(scratch, "mcp-bridge.log"),
    logLines.join("\n") +
      "\n" +
      JSON.stringify({ serversPayload, callPayload, toolNamesBefore, toolNamesAfter, proxiedPayload }, null, 2)
  );
  await fs.writeFile(
    path.join(scratch, "proxy-tool.log"),
    JSON.stringify({ before: toolNamesBefore, after: toolNamesAfter, result: proxiedPayload }, null, 2)
  );
  await fs.writeFile(path.join(scratch, "admin-ui.html"), adminHtml);
  await fs.writeFile(path.join(scratch, "import.log"), JSON.stringify(imported, null, 2));
  await fs.writeFile(path.join(scratch, "hub-boot.log"), hubLog);
} catch (err) {
  await fs.mkdir(scratch, { recursive: true });
  await fs.writeFile(path.join(scratch, "hub-boot.log"), hubLog + "\n--- mock ---\n" + mockLog);
  await fs.writeFile(path.join(scratch, "integration-error.log"), String(err?.stack || err));
  console.error("FAIL bridge integration:", err.message || err);
  console.error(hubLog.slice(-2000));
  process.exit(1);
} finally {
  hub.kill("SIGTERM");
  mockHttp.kill("SIGTERM");
}
