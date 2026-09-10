import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { audit } from "../lib/audit.js";
import {
  clearCheckpoints,
  getCheckpoint,
  getCheckpointConfig,
  listCheckpoints,
  previewRestore,
  restoreToCheckpoint,
} from "../lib/checkpoint.js";
import { requireWriteAllowed } from "../lib/permissions.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolResult } from "../lib/tool-result.js";

export function registerRewindTools(server: McpServer): void {
  server.registerTool(
    "rewind",
    {
      title: "Rewind",
      description:
        "Claude Code-style code rewind. Lists automatic checkpoints captured before file edits, previews changes, or restores files to a prior checkpoint. Does not restore conversation history. Shell/bash file changes are not tracked.",
      inputSchema: {
        action: z
          .enum(["list", "preview", "restore", "status", "clear"])
          .default("list")
          .describe("list=show checkpoints; preview=show planned file changes; restore=revert files; status=config; clear=delete all checkpoints"),
        checkpoint_id: z
          .string()
          .optional()
          .describe("Target checkpoint id (required for preview/restore)"),
        limit: z
          .number()
          .int()
          .positive()
          .max(200)
          .optional()
          .default(30)
          .describe("Max checkpoints to return for list"),
      },
      annotations: toolAnnotations("edit"),
    },
    async ({ action, checkpoint_id, limit }) => {
      if (action === "status") {
        return toolResult("rewind", {
          action,
          config: getCheckpointConfig(),
        });
      }

      if (action === "list") {
        const checkpoints = await listCheckpoints(limit);
        await audit({
          tool: "rewind",
          action: "list",
          status: "ok",
          details: { count: checkpoints.length },
        });
        return toolResult(
          "rewind",
          {
            action,
            count: checkpoints.length,
            checkpoints,
            hint: "Call rewind with action=preview or action=restore and checkpoint_id to revert file changes.",
          },
          { summary: `${checkpoints.length} checkpoint(s)` }
        );
      }

      if (action === "clear") {
        requireWriteAllowed();
        const removed = await clearCheckpoints();
        await audit({ tool: "rewind", action: "clear", status: "ok", details: { removed } });
        return toolResult("rewind", { action, removed });
      }

      if (!checkpoint_id) {
        throw new Error("checkpoint_id is required for preview and restore");
      }

      const known = await getCheckpoint(checkpoint_id);
      if (!known) {
        throw new Error(`Unknown checkpoint_id: ${checkpoint_id}. Use action=list first.`);
      }

      if (action === "preview") {
        const plan = await previewRestore(checkpoint_id);
        await audit({
          tool: "rewind",
          action: "preview",
          target: checkpoint_id,
          status: "ok",
          details: { changes: plan.changes.length },
        });
        return toolResult("rewind", { action, ...plan });
      }

      requireWriteAllowed();
      const result = await restoreToCheckpoint(checkpoint_id);
      await audit({
        tool: "rewind",
        action: "restore",
        target: checkpoint_id,
        status: "ok",
        details: {
          restored: result.restored.length,
          deleted: result.deleted.length,
          skipped: result.skipped.length,
        },
      });
      return toolResult(
        "rewind",
        {
          action,
          ...result,
          note: "Code restored. Conversation history is unchanged (client-side). Checkpoints at and after this point were removed.",
        },
        {
          summary: `restored ${result.restored.length} file(s), deleted ${result.deleted.length}`,
        }
      );
    }
  );
}