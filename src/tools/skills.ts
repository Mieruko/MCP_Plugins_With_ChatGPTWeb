import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDefaultCwd } from "../lib/path-security.js";
import { listSkills, loadSkillCatalog, readSkill, SkillError } from "../lib/skills-loader.js";
import { toolError, toolResult } from "../lib/tool-result.js";

export function registerSkillsTool(server: McpServer): void {
  server.registerTool("skills", {
    title: "Project Skills",
    description: "Find project workflows or read a SKILL.md/supporting text file on demand. Bound to this task's workspace. List returns IDs and revision; read returns sha256 and next_offset for bounded continuation. Reads never execute skill scripts.",
    inputSchema: {
      action: z.enum(["list", "read"]).default("list"),
      query: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(50).default(20),
      cursor: z.string().max(1024).optional(),
      id: z.string().max(512).optional().describe("Exact ID returned by list, including agents: or claude:."),
      reference: z.string().max(512).optional().describe("Optional path relative to this skill folder, such as references/testing.md."),
      expected_revision: z.string().regex(/^[a-f0-9]{64}$/).optional().describe("Reject a catalog that changed since list."),
      expected_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional().describe("Use the previous read's hash when continuing the same document."),
      offset: z.number().int().min(0).default(0).describe("Use next_offset from the previous read."),
      max_chars: z.number().int().min(500).max(24000).default(12000),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (args) => {
    try {
      if (args.action === "read" && !args.id) throw new SkillError("SKILL_ID_REQUIRED", "Choose a skill ID from skills(action: list).");
      const catalog = await loadSkillCatalog(getDefaultCwd());
      const data = args.action === "list" ? listSkills(catalog, args) : await readSkill(catalog, { ...args, id: args.id! });
      return toolResult("skills", data, { summary: args.action === "list"
        ? "Project skill catalog: " + catalog.skills.length + " readable skills"
        : "Read project skill " + args.id });
    } catch (error) {
      const known = error instanceof SkillError;
      return { ...toolError("skills", known ? error.message : "Unable to read this workspace's skill catalog.", {
        code: known ? error.code : "SKILL_UNAVAILABLE",
        next_action: "List skills in the current task and inspect catalog diagnostics before retrying.",
      }), isError: true };
    }
  });
}