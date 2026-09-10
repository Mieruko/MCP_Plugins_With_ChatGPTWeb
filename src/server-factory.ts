import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerFilesystemTools } from "./tools/filesystem.js";
import { registerInspectTools } from "./tools/inspect.js";
import { registerShellTools } from "./tools/shell.js";
import { registerGitTools } from "./tools/git.js";
import { registerContextTools } from "./tools/context.js";
import { registerRewindTools } from "./tools/rewind.js";
import { registerMcpBridgeTools } from "./tools/mcp-bridge.js";
import { buildServerInstructions } from "./lib/quickstart.js";
import type { McpUpstreamManager } from "./lib/mcp-upstream-manager.js";
import { refreshProxiedTools } from "./lib/mcp-tool-proxy.js";
import { getChatGptToolProfile, shouldExposeTool } from "./lib/tool-profile.js";
import { installWorkbench } from "./lib/workbench-tools.js";
import { registerGithubTools } from "./tools/github.js";

const NOOP_TOOL = {
  remove: () => {},
  update: () => {},
  enable: () => {},
  disable: () => {},
  handler: async () => ({ content: [] }),
  enabled: false,
} as unknown as RegisteredTool;

function applyToolProfile(server: McpServer): void {
  const profile = getChatGptToolProfile();
  if (profile === "full") return;

  const original = server.registerTool.bind(server);
  server.registerTool = ((name, ...rest) => {
    if (!shouldExposeTool(String(name), profile)) return NOOP_TOOL;
    return original(name, ...rest);
  }) as typeof server.registerTool;
}

export function createMcpServer(
  workspaceRoot: string,
  shellTimeout: number,
  workspaceRoots: string[] = [workspaceRoot],
  fullDiskAccess = false,
  upstreamManager?: McpUpstreamManager,
  projectMemoryInstructions?: string,
  pinnedTaskId?: string,
  pinnedSessionId?: string
): McpServer {
  const server = new McpServer(
    {
      name: "codex-mcp-server",
      version: "2.0.0",
    },
    {
      capabilities: {
        logging: {},
        tools: { listChanged: true },
      },
      instructions: buildServerInstructions(
        workspaceRoot,
        workspaceRoots,
        fullDiskAccess,
        projectMemoryInstructions
      ),
    }
  );

  applyToolProfile(server);
  installWorkbench(server, workspaceRoot, pinnedTaskId, pinnedSessionId);

  registerFilesystemTools(server);
  registerInspectTools(server, workspaceRoot);
  registerShellTools(server, workspaceRoot, shellTimeout);
  registerGitTools(server, workspaceRoot);
  registerGithubTools(server, workspaceRoot);
  registerContextTools(server, workspaceRoot);
  registerRewindTools(server);

  if (upstreamManager) {
    registerMcpBridgeTools(server, upstreamManager);
    upstreamManager.registerMcpServer(server);
    void refreshProxiedTools(server, upstreamManager);
  }

  return server;
}
