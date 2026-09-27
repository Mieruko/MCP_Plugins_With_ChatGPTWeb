/**
 * Integration: hub server + mock upstream + meta tools + proxy tool.
 * Self-contained — spawns child processes on random ports.
 */
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "node:child_process";
import { freePorts } from "./test-ports.mjs";
import assert from "node:assert/strict";
import { once } from "node:events";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const scratch = process.env.GOAL_SCRATCH || path.join(root, ".tool-test-tmp", "bridge-integration");

const [mcpPort, adminPort, mockPort] = await freePorts(3);
const tmpDir = path.join(scratch, `run-${mcpPort}`);

function spawnNode(script, env = {}) {
  return spawn(process.execPath, [script], {
    cwd: tmpDir,
    windowsHide: true,
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
const project = path.join(tmpDir, 'project');
await fs.mkdir(project);

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
const hubEnv = {
  PORT: String(mcpPort),
  ADMIN_PORT: String(adminPort),
  MCP_UPSTREAM_CONFIG: configPath,
  WORKSPACE_PATH: project,
  MCP_AUTH_TOKEN: "bridge-test-mcp", ADMIN_TOKEN: "bridge-test-admin", WORKBENCH_PATH: path.join(tmpDir, "workbench"), WORKBENCH_DEFAULT_MODE: "full", CHATGPT_TOOL_PROFILE: "full",
  WORKBENCH_EXPERIENCE: "advanced",
  WORKSPACE_PATHS: '', EXTRA_WORKSPACE_PATHS: '', ALLOWED_WORKSPACE_PATHS: '',
  AUDIT_LOG_PATH: path.join(tmpDir, 'audit.log'), CHECKPOINT_PATH: path.join(tmpDir, 'checkpoints'),
  MCP_SHELL_STATE_DIR: path.join(tmpDir, 'shell'), PUBLIC_BASE_URL: `http://127.0.0.1:${mcpPort}`,
};
let hub = spawnNode(path.join(root, "dist/index.js"), hubEnv);

let hubLog = "";
let mockLog = "";
function watchHub(child) {
  child.stdout.on("data", (d) => (hubLog += d.toString()));
  child.stderr.on("data", (d) => (hubLog += d.toString()));
  child.on("exit", code => { hubLog += `\n[hub exit ${code}]`; });
}
watchHub(hub);
mockHttp.stdout.on("data", (d) => (mockLog += d.toString()));
mockHttp.stderr.on("data", (d) => (mockLog += d.toString()));

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
          tools: ["add", "observation"],
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

  const base = `http://127.0.0.1:${mcpPort}`;
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  const unwrap = response => JSON.parse(response.result.content[0].text);
  const admin = async (url, body, method = 'POST') => {
    const response = await fetch(`http://127.0.0.1:${adminPort}${url}`, {
      method, headers: { Authorization: 'Bearer bridge-test-admin', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.data ?? result;
  };
  function checkImage(result, failed = false) {
    assert.equal(result.isError, failed);
    assert.equal(result.structuredContent.ok, !failed);
    assert.equal(result.content.find(item => item.type === 'image')?.data, png);
    assert.ok(!result.content[0].text.includes(png));
    assert.ok(!JSON.stringify(result.structuredContent).includes(png));
  }
  for (const name of ['mcp_call', 'mockhttp__observation']) {
    for (const args of [{}, { image_only: true }, { fail: true }]) {
      const observed = await callTool(base, sessionId, name, name === 'mcp_call'
        ? { server_id: 'mockhttp', tool: 'observation', arguments: args } : args);
      checkImage(observed.result, args.fail === true);
      if (!args.image_only) {
        const key = name === 'mcp_call' ? 'output' : 'result';
        assert.equal(observed.result.structuredContent.data[key].state, args.fail ? 'failed' : 'ready');
      }
    }
  }
  const oversized = await callTool(base, sessionId, 'mcp_call', { server_id: 'mockhttp', tool: 'observation', arguments: { oversized: true } });
  assert.equal(oversized.result.isError, true);
  assert.equal(unwrap(oversized).data.error, 'UPSTREAM_RESULT_INVALID');
  assert.equal(oversized.result.content.length, 1);
  log('OK native image/text/structured/error results survive HTTP bridge and proxy; oversized results fail explicitly');

  const workbench = unwrap(await callTool(base, sessionId, 'workbench'));
  const taskId = workbench.task.id;
  await admin(`/api/workbench/tasks/${taskId}/policy`, { mode: 'ask', workspaceOnly: false }, 'PUT');
  const pending = unwrap(await callTool(base, sessionId, 'mcp_call', { server_id: 'mockhttp', tool: 'observation' }));
  assert.equal(pending.status, 'approval_required');
  const beforeApproval = unwrap(await callTool(base, sessionId, 'workbench', { operation_id: pending.operation_id }));
  assert.equal(beforeApproval.status, 'pending');
  assert.equal(beforeApproval.result, undefined);
  const approved = await admin(`/api/workbench/operations/${pending.operation_id}/decision`, { approve: true });
  checkImage(approved);
  const retrieved = await callTool(base, sessionId, 'workbench', { operation_id: pending.operation_id });
  assert.equal(retrieved.result.content.find(item => item.type === 'image')?.data, png);
  assert.ok(!retrieved.result.content[0].text.includes(png));
  const detail = unwrap(retrieved);
  assert.equal(detail.status, 'completed');
  assert.equal(detail.media.available, true);
  assert.equal(detail.media.observation_is_historical, true);
  const again = await admin(`/api/workbench/operations/${pending.operation_id}/decision`, { approve: true });
  assert.equal(again.result.structuredContent.data.output.calls, approved.structuredContent.data.output.calls);
  assert.ok(!JSON.stringify(again).includes(png));
  const pendingNext = unwrap(await callTool(base, sessionId, 'mcp_call', { server_id: 'mockhttp', tool: 'observation' }));
  const approvedNext = await admin(`/api/workbench/operations/${pendingNext.operation_id}/decision`, { approve: true });
  assert.equal(approvedNext.structuredContent.data.output.calls, approved.structuredContent.data.output.calls + 1, 'retrieval/repeated approval must not execute again');

  const pendingError = unwrap(await callTool(base, sessionId, 'mockhttp__observation', { fail: true }));
  const approvedError = await admin(`/api/workbench/operations/${pendingError.operation_id}/decision`, { approve: true });
  checkImage(approvedError, true);
  const failedDetail = unwrap(await callTool(base, sessionId, 'workbench', { operation_id: pendingError.operation_id }));
  assert.equal(failedDetail.status, 'failed');
  assert.equal(failedDetail.result.isError, true);
  const journal = await admin(`/api/workbench/operations/${pending.operation_id}`, undefined, 'GET');
  assert.ok(!JSON.stringify(journal).includes(png));
  const history = await callTool(base, sessionId, 'workbench', { view: 'history' });
  assert.ok(!JSON.stringify(history).includes(png));
  await admin(`/api/workbench/tasks/${taskId}/policy`, { mode: 'full', workspaceOnly: true }, 'PUT');
  const scoped = await callTool(base, sessionId, 'workbench', { operation_id: pending.operation_id });
  assert.equal(scoped.result.isError, true);
  assert.ok(!JSON.stringify(scoped).includes(png));
  const scopedProxy = await callTool(base, sessionId, 'workbench', { operation_id: pendingError.operation_id });
  assert.equal(scopedProxy.result.isError, true, 'media scope must not rely on arbitrary upstream proxy naming/tracking');
  assert.ok(!JSON.stringify(scopedProxy).includes(png));
  await admin(`/api/workbench/tasks/${taskId}/policy`, { mode: 'full', workspaceOnly: false }, 'PUT');

  // A different pinned task cannot fetch the first task's observation.
  const otherTask = await admin('/api/workbench/tasks', { title: 'Other observation task', workspace: project });
  const initOther = await mcpPost(base, { jsonrpc: '2.0', id: 100, method: 'initialize', params: {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'other-task-test', version: '1' },
  } }, null);
  const otherSession = initOther.headers.get('mcp-session-id');
  assert.ok(otherSession);
  const targeted = await callTool(base, otherSession, 'workbench_control', { action: 'target', task_id: otherTask.id, create_missing: false });
  assert.ok(!targeted.result?.isError, JSON.stringify(targeted));
  const crossTask = await callTool(base, otherSession, 'workbench', { operation_id: pending.operation_id });
  assert.equal(crossTask.result.isError, true);
  assert.ok(!JSON.stringify(crossTask).includes(png));
  log('OK Ask executes once; approval retrieval returns historical images; errors persist; scope/task checks protect observations');

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

  const stateOnDisk = await fs.readFile(path.join(tmpDir, 'workbench', 'state.json'), 'utf8');
  assert.ok(!stateOnDisk.includes(png), 'persistent state never embeds native binary observations');
  const auditLog = await fs.readFile(path.join(tmpDir, 'audit.log'), 'utf8');
  assert.ok(!auditLog.includes(png), 'audit never embeds native binary observations');
  const closed = once(hub, 'exit');
  hub.kill('SIGTERM');
  await closed;
  hub = spawnNode(path.join(root, 'dist/index.js'), hubEnv);
  watchHub(hub);
  await waitFor(`${base}/health`);
  const restartInit = await mcpPost(base, { jsonrpc: '2.0', id: 200, method: 'initialize', params: {
    protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'restart-media-test', version: '1' },
  } }, null);
  const restartedSession = restartInit.headers.get('mcp-session-id');
  assert.ok(restartedSession);
  const retargeted = await callTool(base, restartedSession, 'workbench_control', { action: 'target', task_id: taskId, create_missing: false });
  assert.ok(!retargeted.result?.isError, JSON.stringify(retargeted));
  const afterRestart = await callTool(base, restartedSession, 'workbench', { operation_id: pending.operation_id });
  const restored = unwrap(afterRestart);
  assert.equal(restored.status, 'completed');
  assert.equal(restored.media.available, false);
  assert.match(restored.media.message, /Capture a new observation/);
  assert.equal(afterRestart.result.content.length, 1);
  assert.ok(!JSON.stringify(afterRestart).includes(png));
  log('OK disk/audit omit image bytes; restart retains outcome and explicitly reports unavailable historical observation');

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
  process.exitCode = 1;
} finally {
  hub.kill("SIGTERM");
  mockHttp.kill("SIGTERM");
}
