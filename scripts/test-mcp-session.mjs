/**
 * Integration test: MCP session init, tool call, stale-session recovery.
 * Requires server running on PORT (default 3000).
 */
const PORT = parseInt(process.env.PORT || "3000", 10);
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;

function ok(name) {
  console.log(`OK  ${name}`);
  passed++;
}

function fail(name, err) {
  console.error(`FAIL ${name}: ${err.message || err}`);
  failed++;
}

async function mcpPost(path, body, sessionId, extraHeaders = {}) {
  const headers = {
    Authorization: `Bearer ${process.env.MCP_AUTH_TOKEN || ""}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...extraHeaders,
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const res = await fetch(`${BASE}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, text, json };
}

async function run(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    fail(name, err);
  }
}

async function initialize(path = "/mcp") {
  const { status, headers, json } = await mcpPost(
    path,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test-mcp-session", version: "1.0.0" },
      },
    },
    null
  );

  if (status !== 200) throw new Error(`initialize HTTP ${status}: ${JSON.stringify(json)}`);
  const sessionId = headers.get("mcp-session-id");
  if (!sessionId) throw new Error("missing mcp-session-id header");
  return { sessionId, json };
}

await run("health endpoint", async () => {
  const res = await fetch(`${BASE}/health`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.status !== "ok") throw new Error(JSON.stringify(data));
});

let sessionId;
await run("initialize session on /mcp", async () => {
  const out = await initialize("/mcp");
  sessionId = out.sessionId;
});

await run("tools/list with valid session", async () => {
  const { status, json } = await mcpPost(
    "/mcp",
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    sessionId,
    { "mcp-protocol-version": "2025-03-26" }
  );
  if (status !== 200) throw new Error(`HTTP ${status}`);
  if (!json?.result?.tools?.some((t) => t.name === "run_command")) {
    throw new Error("run_command not in tools/list");
  }
});

await run("stale session auto-recovery", async () => {
  const fakeId = "00000000-0000-4000-8000-000000000099";
  const { status, json } = await mcpPost(
    "/mcp",
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "run_command", arguments: { command: "echo stale-test" } },
    },
    fakeId,
    { "mcp-protocol-version": "2025-03-26" }
  );

  if (status !== 200) {
    throw new Error(`expected recovery HTTP 200, got ${status}: ${JSON.stringify(json)}`);
  }
  if (!json?.result || json.result.isError || json.result.structuredContent?.ok === false) throw new Error(`recovery did not execute the tool: ${JSON.stringify(json)}`);
  if (!JSON.stringify(json.result).includes("stale-test")) throw new Error("recovery did not return command output");
});

await run("re-initialize with stale session header", async () => {
  const fakeId = "00000000-0000-4000-8000-000000000088";
  const { status, headers, json } = await mcpPost(
    "/mcp",
    {
      jsonrpc: "2.0",
      id: 4,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test-reinit", version: "1.0.0" },
      },
    },
    fakeId
  );
  if (status !== 200) throw new Error(`HTTP ${status}: ${JSON.stringify(json)}`);
  const newSession = headers.get("mcp-session-id");
  if (!newSession) throw new Error("missing new session id");
  sessionId = newSession;
});

await run("run_command after re-init", async () => {
  const { status, json } = await mcpPost(
    "/mcp",
    {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "run_command",
        arguments: { command: process.platform === "win32" ? "echo mcp-ok" : "echo mcp-ok" },
      },
    },
    sessionId,
    { "mcp-protocol-version": "2025-03-26" }
  );
  if (status !== 200) throw new Error(`HTTP ${status}: ${JSON.stringify(json)}`);
  const text = JSON.stringify(json?.result ?? json);
  if (!text.includes("mcp-ok") || json?.result?.isError || json?.result?.structuredContent?.ok === false) {
    throw new Error(`unexpected result: ${text.slice(0, 300)}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
