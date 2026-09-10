#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "mock-stdio-mcp", version: "1.0.0" });

server.registerTool(
  "echo",
  {
    title: "Echo",
    description: "Echo text back",
    inputSchema: { message: z.string() },
  },
  async ({ message }) => ({
    content: [{ type: "text", text: `echo:${message}` }],
  })
);

const transport = new StdioServerTransport();
await server.connect(transport);