import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpUpstreamManager } from "../lib/mcp-upstream-manager.js";
import { audit } from "../lib/audit.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolResult } from "../lib/tool-result.js";
import { upstreamToolResult } from "../lib/upstream-result.js";

export function registerMcpBridgeTools(server: McpServer, manager: McpUpstreamManager): void {
  server.registerTool(
    "mcp_servers",
    {
      title: "MCP Upstream Servers",
      description:
        "List configured upstream MCP servers on this machine with health status (connected/unreachable/disabled).",
      inputSchema: {
        refresh: z.boolean().optional().default(false).describe("Force reconnect before reporting health"),
      },
      annotations: toolAnnotations("read"),
    },
    async ({ refresh }) => {
      if (refresh) await manager.reloadConfig();
      const servers = await manager.listStatuses();
      await audit({ tool: "mcp_servers", action: "list", status: "ok", details: { count: servers.length } });
      return toolResult("mcp_servers", { servers, count: servers.length });
    }
  );

  server.registerTool(
    "mcp_tools",
    {
      title: "MCP Upstream Tools",
      description: "List tools exposed by a configured upstream MCP server.",
      inputSchema: {
        server_id: z.string().describe("Upstream server id from mcp_servers"),
      },
      annotations: toolAnnotations("read"),
    },
    async ({ server_id }) => {
      const config = manager.getServerConfig(server_id);
      if (!config) throw new Error(`Unknown server_id: ${server_id}`);
      const tools = await manager.listTools(server_id);
      const proxied = manager.getProxiedToolNames(config, tools);
      await audit({
        tool: "mcp_tools",
        action: "list",
        target: server_id,
        status: "ok",
        details: { tools: tools.length },
      });
      return toolResult("mcp_tools", {
        server_id,
        tools: tools.map((t) => ({ name: t.name, description: t.description, proxied_as: proxied.filter((p) => p.endsWith(`__${t.name}`)) })),
        proxied_tools: proxied,
        count: tools.length,
      });
    }
  );

  server.registerTool(
    "mcp_call",
    {
      title: "MCP Upstream Call",
      description: "Invoke a tool on a configured upstream MCP server with JSON arguments.",
      inputSchema: {
        server_id: z.string(),
        tool: z.string(),
        arguments: z.record(z.string(), z.any()).optional().default({}),
      },
      annotations: toolAnnotations("edit"),
    },
    async ({ server_id, tool, arguments: args }) => {
      const config = manager.getServerConfig(server_id);
      if (!config) throw new Error(`Unknown server_id: ${server_id}`);
      if (!config.enabled) throw new Error(`Upstream server disabled: ${server_id}`);

      const raw = await manager.callTool(server_id, tool, args ?? {});
      const result = upstreamToolResult("mcp_call", raw, { server_id, tool });
      await audit({
        tool: "mcp_call",
        action: "call",
        target: `${server_id}:${tool}`,
        status: result.isError ? "error" : "ok",
      });
      return result;
    }
  );
}
