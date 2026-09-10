#!/usr/bin/env node
import express from "express";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const port = parseInt(process.env.MOCK_HTTP_MCP_PORT || "3999", 10);
const sessions = {};

function buildServer() {
  const mcpServer = new McpServer({ name: "mock-http-mcp", version: "1.0.0" });
  mcpServer.registerTool(
    "add",
    {
      title: "Add",
      description: "Add two numbers",
      inputSchema: { a: z.number(), b: z.number() },
    },
    async ({ a, b }) => ({
      content: [{ type: "text", text: String(a + b) }],
      structuredContent: { sum: a + b },
    })
  );
  return mcpServer;
}

const app = express();
app.use(express.json({ limit: "5mb" }));

app.post("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  const existing = sessionId ? sessions[sessionId] : undefined;

  if (existing) {
    await existing.transport.handleRequest(req, res, req.body);
    return;
  }

  if (!isInitializeRequest(req.body)) {
    res.status(400).json({ jsonrpc: "2.0", error: { code: -32000, message: "initialize required" }, id: null });
    return;
  }

  const mcpServer = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (sid) => {
      sessions[sid] = { transport, server: mcpServer };
    },
    onsessionclosed: (sid) => {
      if (sid) delete sessions[sid];
    },
  });

  await mcpServer.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.listen(port, "127.0.0.1", () => {
  console.log(`mock-http-mcp listening on http://127.0.0.1:${port}/mcp`);
});