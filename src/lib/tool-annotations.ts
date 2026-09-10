import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * Describe actual tool effects to the client. Annotations never grant permissions;
 * the Workbench dispatcher independently enforces each task's policy.
 */
export type ToolRisk = "read" | "edit" | "command" | "destructive";

export function toolAnnotations(risk: ToolRisk): ToolAnnotations {
  if (risk === "read") {
    return { readOnlyHint: true, openWorldHint: false };
  }

  return {
    readOnlyHint: false,
    destructiveHint: risk === "destructive" || risk === "command",
    openWorldHint: risk === "command",
    idempotentHint: false,
  };
}
