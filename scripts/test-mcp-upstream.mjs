import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  importCursorMcpConfig,
  loadUpstreamConfig,
  parseClaudeCodeConfig,
  parseMcpServersFile,
  parseOpenCodeConfig,
  saveUpstreamConfig,
} from "../dist/lib/mcp-upstream-config.js";
import { McpUpstreamManager } from "../dist/lib/mcp-upstream-manager.js";
import { refreshProxiedTools, jsonSchemaToZodShape } from "../dist/lib/mcp-tool-proxy.js";
import { registerMcpBridgeTools } from "../dist/tools/mcp-bridge.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const tmpDir = path.join(root, ".tool-test-tmp", "mcp-upstream");

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

async function run(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    fail(name, err);
  }
}

function spawnMockHttp(port) {
  return spawn(process.execPath, [path.join(root, "scripts/mock-http-mcp.mjs")], {
    env: { ...process.env, MOCK_HTTP_MCP_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForHealth(url, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${url}`);
}

await fs.rm(tmpDir, { recursive: true, force: true });
await fs.mkdir(tmpDir, { recursive: true });

const configPath = path.join(tmpDir, "upstream.json");
process.env.MCP_UPSTREAM_CONFIG = configPath;

await run("jsonSchemaToZodShape respects required fields", async () => {
  const shape = jsonSchemaToZodShape({
    type: "object",
    properties: { a: { type: "number" }, b: { type: "string" } },
    required: ["a"],
  });
  const aParsed = shape.a.safeParse(undefined);
  const bParsed = shape.b.safeParse(undefined);
  if (aParsed.success) throw new Error("a should be required");
  if (!bParsed.success) throw new Error("b should be optional");
});

await run("save and load upstream config", async () => {
  await saveUpstreamConfig(
    {
      version: 1,
      servers: [
        {
          id: "demo",
          name: "Demo",
          enabled: true,
          transport: "http",
          url: "http://127.0.0.1:3999/mcp",
          expose: "meta_only",
        },
      ],
    },
    configPath
  );
  const loaded = await loadUpstreamConfig(configPath);
  if (loaded.servers.length !== 1 || loaded.servers[0].id !== "demo") {
    throw new Error(JSON.stringify(loaded));
  }
});

await run("parse claude code mcp config", async () => {
  const fixture = {
    projects: {
      "/proj": {
        mcpServers: {
          gh: { type: "http", url: "http://127.0.0.1:3100/mcp" },
        },
      },
    },
    mcpServers: {
      local: { command: "node", args: ["srv.js"] },
    },
  };
  const parsed = parseClaudeCodeConfig(fixture);
  if (parsed.length !== 2) throw new Error(`expected 2, got ${parsed.length}`);
});

await run("parse opencode mcp config", async () => {
  const fixture = {
    mcp: {
      demo: { type: "local", command: ["node", "srv.js"] },
      remote: { type: "remote", url: "http://127.0.0.1:3200/mcp" },
    },
  };
  const parsed = parseOpenCodeConfig(fixture);
  if (parsed.length !== 2) throw new Error(`expected 2, got ${parsed.length}`);
});

await run("parse and import cursor mcp config", async () => {
  const fixture = {
    mcpServers: {
      unity: { command: "node", args: ["C:/tools/unity.js"], cwd: "C:/game" },
      crawl: { url: "http://127.0.0.1:3100/mcp" },
    },
  };
  const parsed = parseMcpServersFile(fixture);
  if (parsed.length !== 2) throw new Error(`expected 2, got ${parsed.length}`);
  const fixturePath = path.join(tmpDir, "cursor-mcp-fixture.json");
  await fs.writeFile(fixturePath, JSON.stringify(fixture), "utf-8");
  const result = await importCursorMcpConfig(fixturePath, { merge: true });
  if (!result.imported.includes("unity") || !result.imported.includes("crawl")) {
    throw new Error(JSON.stringify(result.imported));
  }
});

const httpPort = 3901 + Math.floor(Math.random() * 200);
const mockHttp = spawnMockHttp(httpPort);
try {
  await waitForHealth(`http://127.0.0.1:${httpPort}/health`);

  await run("manager connects to http upstream and lists tools", async () => {
    const manager = new McpUpstreamManager(configPath);
    await manager.init();
    await manager.updateConfig({
      version: 1,
      servers: [
        {
          id: "mockhttp",
          name: "Mock HTTP",
          enabled: true,
          transport: "http",
          url: `http://127.0.0.1:${httpPort}/mcp`,
          expose: "allowlist",
          tools: ["add"],
          tool_prefix: "mockhttp",
        },
      ],
    });
    const tools = await manager.listTools("mockhttp");
    if (!tools.some((t) => t.name === "add")) throw new Error("add tool missing");
    const raw = await manager.callTool("mockhttp", "add", { a: 2, b: 3 });
    const text = JSON.stringify(raw);
    if (!text.includes("5")) throw new Error(text);
  });

  await run("allowlist proxy registers prefixed tool", async () => {
    const manager = new McpUpstreamManager(configPath);
    await manager.init();
    await manager.updateConfig({
      version: 1,
      servers: [
        {
          id: "mockhttp",
          name: "Mock HTTP",
          enabled: true,
          transport: "http",
          url: `http://127.0.0.1:${httpPort}/mcp`,
          expose: "allowlist",
          tools: ["add"],
          tool_prefix: "mockhttp",
        },
      ],
    });
    const hub = new McpServer({ name: "test-hub", version: "1.0.0" }, { capabilities: { tools: { listChanged: true } } });
    registerMcpBridgeTools(hub, manager);
    const proxied = await refreshProxiedTools(hub, manager);
    if (!proxied.includes("mockhttp__add")) throw new Error(JSON.stringify(proxied));
    const names = manager.getProxiedToolNames(manager.getServerConfig("mockhttp"), await manager.listTools("mockhttp"));
    if (!names.includes("mockhttp__add")) throw new Error(JSON.stringify(names));
  });
} finally {
  mockHttp.kill("SIGTERM");
}

await run("manager connects to stdio mock upstream", async () => {
  const manager = new McpUpstreamManager(configPath);
  await manager.init();
  await manager.updateConfig({
    version: 1,
    servers: [
      {
        id: "mockstdio",
        name: "Mock Stdio",
        enabled: true,
        transport: "stdio",
        command: process.execPath,
        args: [path.join(root, "scripts/mock-stdio-mcp.mjs")],
        expose: "meta_only",
      },
    ],
  });
  const tools = await manager.listTools("mockstdio");
  if (!tools.some((t) => t.name === "echo")) throw new Error(JSON.stringify(tools));
  const raw = await manager.callTool("mockstdio", "echo", { message: "hi" });
  const text = JSON.stringify(raw);
  if (!text.includes("echo:hi")) throw new Error(text);
  await manager.disconnect("mockstdio");
});

await fs.rm(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);