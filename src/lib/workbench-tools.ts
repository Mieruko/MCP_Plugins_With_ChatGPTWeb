import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { dispatch, getWorkbench, operationDetail, resolveDefaultTask } from "./workbench.js";
import { executionContext } from "./workbench-context.js";
import { validatePath } from "./path-security.js";

/** Install before registering any tools, including dynamically proxied tools. */
export function installWorkbench(server: McpServer, workspace: string, pinnedTaskId?: string): void {
  let taskPromise: Promise<string> | undefined = pinnedTaskId ? Promise.resolve(pinnedTaskId) : undefined;
  const task = () => taskPromise ??= resolveDefaultTask(workspace);
  const original = server.registerTool.bind(server) as (...args: any[]) => any;
  server.registerTool = ((name: string, config: any, handler: any) => original(name, config, async (args: any, extra: any) => {
    const immutable = structuredClone(args);
    return dispatch(await task(), name, immutable, () => handler(structuredClone(immutable), extra));
  })) as typeof server.registerTool;
  original("workbench", {
    title: "Task workbench",
    description: "Read current task policy, edited files and approval results. Approvals execute the original operation; never resubmit a pending write. Task switching and policy changes are local dashboard actions.",
    inputSchema: { operation_id: z.string().optional() },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ operation_id }: { operation_id?: string }) => {
    const taskId = await task();
    if (operation_id) {
      const op = await operationDetail(operation_id);
      if (op.taskId !== taskId) throw new Error("Operation belongs to another task");
      const current = (await getWorkbench()).tasks.find(t => t.id === taskId)!;
      if (current.policy.workspaceOnly && op.tracking !== "file-tools") throw new Error("Operation output unavailable under current workspace-only policy");
      await executionContext.run({ taskId, workspace: current.workspace, workspaceOnly: current.policy.workspaceOnly, operationId: op.id, capture: async () => {} }, async () => {
        for (const change of op.changes) await validatePath(change.path);
      });
      return { content: [{ type: "text", text: JSON.stringify({ id: op.id, status: op.status, error: op.error, result: op.result }) }] };
    }
    const data = await getWorkbench();
    return { content: [{ type: "text", text: JSON.stringify({ task: data.tasks.find(t => t.id === taskId), capabilities: data.capabilities,
      operations: data.operations.filter(o => o.taskId === taskId).slice(0, 30).map(({ args, ...op }) => op) }) }] };
  });
}
