import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { McpUpstreamManager } from "./mcp-upstream-manager.js";
import type { UpstreamServerConfig } from "./mcp-upstream-config.js";
import { toolAnnotations } from "./tool-annotations.js";
import { toolResult } from "./tool-result.js";

const proxyRegistry = new WeakMap<McpServer, Map<string, RegisteredTool>>();

function getRegistry(server: McpServer): Map<string, RegisteredTool> {
  let map = proxyRegistry.get(server);
  if (!map) {
    map = new Map();
    proxyRegistry.set(server, map);
  }
  return map;
}

export function jsonSchemaToZodShape(schema: Tool["inputSchema"]): Record<string, z.ZodTypeAny> {
  if (!schema || typeof schema !== "object") return {};
  const schemaObj = schema as { properties?: Record<string, unknown>; required?: string[] };
  const props = schemaObj.properties;
  if (!props || typeof props !== "object") return {};

  const required = new Set(Array.isArray(schemaObj.required) ? schemaObj.required : []);

  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, prop] of Object.entries(props)) {
    const p = prop as { type?: string; description?: string };
    let field: z.ZodTypeAny = z.any();
    if (p.type === "string") field = z.string();
    else if (p.type === "number" || p.type === "integer") field = z.number();
    else if (p.type === "boolean") field = z.boolean();
    else if (p.type === "array") field = z.array(z.any());
    else if (p.type === "object") field = z.record(z.string(), z.any());
    if (p.description) field = field.describe(p.description);
    shape[key] = required.has(key) ? field : field.optional();
  }
  return shape;
}

function shouldExposeTool(config: UpstreamServerConfig, toolName: string): boolean {
  if (!config.enabled) return false;
  if (config.expose === "none" || config.expose === "meta_only") return false;
  if (config.expose === "all") return true;
  return (config.tools ?? []).includes(toolName);
}

export async function refreshProxiedTools(server: McpServer, manager: McpUpstreamManager): Promise<string[]> {
  const registry = getRegistry(server);
  const activeNames = new Set<string>();

  for (const config of manager.listServerConfigs()) {
    if (!config.enabled) continue;
    if (config.expose !== "all" && config.expose !== "allowlist") continue;

    let tools: Tool[] = [];
    try {
      tools = await manager.listTools(config.id);
    } catch {
      continue;
    }

    const prefix = `${config.tool_prefix ?? config.id}__`;
    for (const tool of tools) {
      if (!shouldExposeTool(config, tool.name)) continue;
      const proxyName = `${prefix}${tool.name}`;
      activeNames.add(proxyName);

      if (registry.has(proxyName)) continue;

      const inputShape = jsonSchemaToZodShape(tool.inputSchema);
      const hasSchema = Object.keys(inputShape).length > 0;

      const registered = server.registerTool(
        proxyName,
        {
          title: tool.title ?? tool.name,
          description: `[${config.name}] ${tool.description ?? tool.name}`,
          inputSchema: hasSchema ? inputShape : {},
          annotations: toolAnnotations("edit"),
        },
        async (args: Record<string, unknown>) => {
          const raw = await manager.callTool(config.id, tool.name, args ?? {});
          const content = formatUpstreamResult(raw);
          return toolResult(proxyName, {
            upstream_server: config.id,
            upstream_tool: tool.name,
            result: content,
          });
        }
      );
      registry.set(proxyName, registered);
    }
  }

  for (const [name, registered] of registry.entries()) {
    if (!activeNames.has(name)) {
      registered.remove();
      registry.delete(name);
    }
  }

  return [...activeNames];
}

function formatUpstreamResult(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const obj = raw as { content?: unknown; structuredContent?: unknown; isError?: boolean };
  if (obj.structuredContent) return obj.structuredContent;
  if (Array.isArray(obj.content)) {
    return obj.content
      .map((c) => {
        if (c && typeof c === "object" && "text" in c) return (c as { text: string }).text;
        return c;
      })
      .join("\n");
  }
  return raw;
}

export function clearProxiedTools(server: McpServer): void {
  const registry = getRegistry(server);
  for (const registered of registry.values()) {
    registered.remove();
  }
  registry.clear();
}