import { AsyncLocalStorage } from "node:async_hooks";

export interface ExecutionContext {
  taskId: string;
  sessionId?: string;
  workspace: string;
  workspaceOnly: boolean;
  operationId: string;
  environment?: Record<string, string>;
  capture: (paths: string[]) => Promise<void>;
}

export const executionContext = new AsyncLocalStorage<ExecutionContext>();

export function childEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env, ...(executionContext.getStore()?.environment || {}) };
  for (const name of ["ADMIN_TOKEN", "MCP_AUTH_TOKEN", "OPENAI_TUNNEL_API_KEY", "WORKBENCH_BOOTSTRAP_TOKEN"]) delete env[name];
  return env;
}

export function requireUnrestrictedExecution(): void {
  if (executionContext.getStore()?.workspaceOnly) {
    throw new Error("WORKSPACE_EXTERNAL_BLOCKED: this operation requires machine or network scope and is disabled while workspace-only is enabled.");
  }
}
