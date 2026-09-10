import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { audit } from "../lib/audit.js";
import { executionContext } from "../lib/workbench-context.js";
import {
  clearTaskCheckpoints,
  listTaskCheckpoints,
  previewTaskCheckpoint,
  restoreTaskCheckpoint,
} from "../lib/workbench.js";
import { requireWriteAllowed } from "../lib/permissions.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolResult } from "../lib/tool-result.js";

function currentTaskId(): string {
  const taskId = executionContext.getStore()?.taskId;
  if (!taskId) throw new Error("rewind requires an active Workbench task");
  return taskId;
}

export function registerRewindTools(server: McpServer): void {
  server.registerTool(
    "rewind",
    {
      title: "Rewind",
      description:
        "Compatibility view over Workbench task checkpoints. Lists, previews, restores, or clears checkpoints for the current task using the same conflict-safe operation journal as Workbench. Conversation history and external shell/Git/network effects are not restored.",
      inputSchema: {
        action: z
          .enum(["list", "preview", "restore", "status", "clear"])
          .default("list")
          .describe("list=show task checkpoints; preview=show planned file changes; restore=revert journaled file changes; status=show checkpoint mode; clear=delete task checkpoint markers"),
        checkpoint_id: z.string().optional().describe("Task checkpoint id (required for preview/restore)"),
        limit: z.number().int().positive().max(200).optional().default(30).describe("Max checkpoints to return for list"),
      },
      annotations: toolAnnotations("edit"),
    },
    async ({ action, checkpoint_id, limit }) => {
      const taskId = currentTaskId();

      if (action === "status") {
        return toolResult("rewind", {
          action,
          task_id: taskId,
          config: {
            mode: "workbench_task_journal",
            conflict_detection: true,
            file_undo: true,
            shell_undo: false,
            note: "Task checkpoints are journal boundaries. External shell, Git, MCP and network effects are reported but not rolled back.",
          },
        });
      }

      if (action === "list") {
        const checkpoints = (await listTaskCheckpoints(taskId)).slice(0, limit);
        await audit({ tool: "rewind", action: "list", status: "ok", details: { taskId, count: checkpoints.length } });
        return toolResult(
          "rewind",
          {
            action,
            task_id: taskId,
            count: checkpoints.length,
            checkpoints,
            hint: "Create checkpoints in Workbench History, then use preview/restore with checkpoint_id when needed.",
          },
          { summary: `${checkpoints.length} task checkpoint(s)` }
        );
      }

      if (action === "clear") {
        requireWriteAllowed();
        const removed = await clearTaskCheckpoints(taskId);
        await audit({ tool: "rewind", action: "clear", status: "ok", details: { taskId, removed } });
        return toolResult("rewind", { action, task_id: taskId, removed });
      }

      if (!checkpoint_id) throw new Error("checkpoint_id is required for preview and restore");
      const known = (await listTaskCheckpoints(taskId)).some(checkpoint => checkpoint.id === checkpoint_id);
      if (!known) throw new Error(`Unknown checkpoint_id for current task: ${checkpoint_id}. Use action=list first.`);

      if (action === "preview") {
        const plan = await previewTaskCheckpoint(checkpoint_id);
        await audit({ tool: "rewind", action: "preview", target: checkpoint_id, status: "ok", details: { taskId, files: plan.files.length } });
        return toolResult("rewind", { action, task_id: taskId, ...plan });
      }

      requireWriteAllowed();
      const result = await restoreTaskCheckpoint(checkpoint_id);
      await audit({
        tool: "rewind",
        action: "restore",
        target: checkpoint_id,
        status: "ok",
        details: { taskId, files: result.files.length, operations: result.operationCount, externalEffects: result.externalEffects.length },
      });
      return toolResult(
        "rewind",
        {
          action,
          task_id: taskId,
          ...result,
          note: "Journaled file changes restored with conflict checks. Conversation history and external side effects are unchanged.",
        },
        { summary: `restored ${result.files.length} file(s) to task checkpoint` }
      );
    }
  );
}