import { AsyncLocalStorage } from "node:async_hooks";

export interface ExecutionContext {
  taskId: string;
  workspace: string;
  workspaceOnly: boolean;
  operationId: string;
  capture: (paths: string[]) => Promise<void>;
}

export const executionContext = new AsyncLocalStorage<ExecutionContext>();

export function childEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of ["ADMIN_TOKEN", "MCP_AUTH_TOKEN", "OPENAI_TUNNEL_API_KEY"]) delete env[name];
  return env;
}

export function requireUnrestrictedExecution(): void {
  if (executionContext.getStore()?.workspaceOnly) {
    throw new Error("SANDBOX_UNAVAILABLE: this build has a filesystem boundary but no OS process sandbox. Shell, Git, hooks and upstream execution are disabled in workspace-only mode. Change scope explicitly in the local dashboard to use them.");
  }
}
