import fs from "fs/promises";
import path from "path";
import { validatePath } from "./path-security.js";

export interface SkillSummary {
  name: string;
  description: string;
  path: string;
}

const MAX_SKILLS = 20;

function parseFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const block = match[1];
  const name = block.match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const description = block.match(/^description:\s*(.+)$/m)?.[1]?.trim();
  return { name, description };
}

export async function loadProjectSkills(workspaceRoot: string): Promise<SkillSummary[]> {
  const skillsDir = path.join(workspaceRoot, ".claude", "skills");
  const out: SkillSummary[] = [];

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 3 || out.length >= MAX_SKILLS) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_SKILLS) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const skillFile = path.join(full, "SKILL.md");
        try {
          const content = await fs.readFile(await validatePath(skillFile), "utf-8");
          const fm = parseFrontmatter(content);
          const name = fm.name || entry.name;
          const description = fm.description || content.split("\n").find((l) => l.trim() && !l.startsWith("#"))?.trim() || name;
          out.push({ name, description: description.slice(0, 200), path: skillFile });
        } catch {
          await walk(full, depth + 1);
        }
      }
    }
  }

  await walk(skillsDir, 0);
  return out;
}

export function formatSkillsForInstructions(skills: SkillSummary[]): string {
  if (!skills.length) return "";
  return [
    "## Skills (invoke manually — ChatGPT has no /slash; describe the skill in your prompt)",
    ...skills.map((s) => `- **${s.name}**: ${s.description}`),
  ].join("\n");
}
