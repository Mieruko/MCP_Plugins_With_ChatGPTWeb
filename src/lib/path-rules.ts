import fs from "fs/promises";
import path from "path";
import { validatePath } from "./path-security.js";

function parseFrontmatter(content: string): { paths?: string[] } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const pathsLine = match[1].match(/^paths:\s*\n((?:\s+-\s*.+\n?)+)/m);
  if (!pathsLine) return {};
  const paths = [...pathsLine[1].matchAll(/^\s+-\s*["']?([^"'\n]+)["']?\s*$/gm)].map((m) => m[1].trim());
  return { paths };
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/\\\\]*")
    .replace(/{{GLOBSTAR}}/g, ".*")
    .replace(/\{([^}]+)\}/g, (_, inner) => `(${inner.split(",").map((s: string) => s.trim()).join("|")})`)
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function matchesAny(filePath: string, patterns: string[]): boolean {
  const norm = filePath.replace(/\\/g, "/");
  return patterns.some((p) => globToRegex(p).test(norm) || globToRegex(p).test(path.basename(norm)));
}

async function listRuleFiles(rulesDir: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 3) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.name.endsWith(".md")) found.push(full);
    }
  }
  await walk(rulesDir, 0);
  return found;
}

export async function loadPathRulesForFile(
  workspaceRoot: string,
  filePath: string
): Promise<Array<{ path: string; content: string }>> {
  const rulesDir = path.join(workspaceRoot, ".claude", "rules");
  const matched: Array<{ path: string; content: string }> = [];

  for (const ruleFile of await listRuleFiles(rulesDir)) {
    try {
      const raw = await fs.readFile(await validatePath(ruleFile), "utf-8");
      const fm = parseFrontmatter(raw);
      if (!fm.paths?.length) continue;
      if (!matchesAny(filePath, fm.paths)) continue;
      const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
      if (body) matched.push({ path: ruleFile, content: body.slice(0, 4000) });
    } catch {}
  }

  return matched;
}
