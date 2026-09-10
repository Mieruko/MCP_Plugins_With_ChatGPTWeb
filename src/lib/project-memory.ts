import fs from "fs/promises";
import os from "os";
import path from "path";
import { validatePath } from "./path-security.js";

const ROOT_MEMORY_FILES = [
  "CLAUDE.md",
  ".claude/CLAUDE.md",
  "AGENTS.md",
  "CLAUDE.local.md",
] as const;

const USER_MEMORY_CANDIDATES = [
  path.join(os.homedir(), ".codex", "CLAUDE.md"),
  path.join(os.homedir(), ".claude", "CLAUDE.md"),
] as const;

const RULES_GLOB_MAX = 12;
const IMPORT_MAX_DEPTH = 4;
const DEFAULT_MAX_BYTES = parseInt(process.env.PROJECT_MEMORY_MAX_BYTES || "25000", 10);
const DEFAULT_MAX_LINES = parseInt(process.env.PROJECT_MEMORY_MAX_LINES || "200", 10);

export interface ProjectMemorySection {
  path: string;
  content: string;
  truncated: boolean;
  kind: "user" | "project" | "rule" | "import";
}

export interface ProjectMemoryBundle {
  root: string;
  workspace_roots: string[];
  sections: ProjectMemorySection[];
  total_bytes: number;
  loaded_at: string;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "");
}

function hasPathsFrontmatter(content: string): boolean {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return false;
  return /^paths\s*:/m.test(match[1]);
}

async function readTextLimited(
  filePath: string,
  maxBytes: number,
  maxLines: number,
  kind: ProjectMemorySection["kind"]
): Promise<ProjectMemorySection | null> {
  try {
    const buf = await fs.readFile(await validatePath(filePath));
    let full = stripHtmlComments(buf.toString("utf-8"));
    full = await expandImportsInContent(full, path.dirname(filePath));

    const lines = full.split(/\r?\n/).slice(0, maxLines);
    const lineLimited = lines.join("\n");
    const byteLimited =
      Buffer.byteLength(lineLimited, "utf-8") > maxBytes
        ? Buffer.from(lineLimited, "utf-8").subarray(0, maxBytes).toString("utf-8")
        : lineLimited;
    const truncated =
      buf.length > maxBytes ||
      full.split(/\r?\n/).length > maxLines ||
      byteLimited.length < full.length;
    const trimmed = byteLimited.trim();
    if (!trimmed) return null;
    return { path: filePath, content: trimmed, truncated, kind };
  } catch {
    return null;
  }
}

async function expandImportsInContent(content: string, baseDir: string): Promise<string> {
  const visited = new Set<string>();
  return expandMemoryImportsAsync(content, baseDir, visited, 0);
}

async function expandMemoryImportsAsync(
  content: string,
  baseDir: string,
  visited: Set<string>,
  depth: number
): Promise<string> {
  if (depth >= IMPORT_MAX_DEPTH) return content;

  const lines = content.split(/\r?\n/);
  const out: string[] = [];
  let inFence = false;

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }

    const importMatch = line.match(/^@(~\/[^\s`]+|[^\s`]+)\s*$/);
    if (!importMatch) {
      out.push(line);
      continue;
    }

    let importPath = importMatch[1];
    if (importPath.startsWith("~/")) {
      importPath = path.join(os.homedir(), importPath.slice(2));
    } else if (!path.isAbsolute(importPath)) {
      importPath = path.resolve(baseDir, importPath);
    }

    const resolved = path.resolve(importPath);
    if (visited.has(resolved)) {
      out.push(`<!-- skipped circular import ${resolved} -->`);
      continue;
    }

    visited.add(resolved);
    try {
      const buf = await fs.readFile(await validatePath(resolved));
      const imported = stripHtmlComments(buf.toString("utf-8"));
      const expanded = await expandMemoryImportsAsync(
        imported,
        path.dirname(resolved),
        visited,
        depth + 1
      );
      out.push(`<!-- @import ${resolved} -->`, expanded);
    } catch {
      out.push(`<!-- import failed: ${resolved} -->`);
    }
  }

  return out.join("\n");
}

async function listUnconditionalRuleFiles(rulesDir: string): Promise<string[]> {
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
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        try {
          const head = await fs.readFile(await validatePath(full), "utf-8");
          if (!hasPathsFrontmatter(head)) found.push(full);
        } catch {}
      }
    }
  }

  await walk(rulesDir, 0);
  return found.sort().slice(0, RULES_GLOB_MAX);
}

async function appendSection(
  sections: ProjectMemorySection[],
  totalBytes: { value: number },
  maxBytes: number,
  maxLines: number,
  filePath: string,
  kind: ProjectMemorySection["kind"]
): Promise<void> {
  if (totalBytes.value >= maxBytes) return;
  const section = await readTextLimited(
    filePath,
    maxBytes - totalBytes.value,
    maxLines,
    kind
  );
  if (!section?.content) return;
  sections.push(section);
  totalBytes.value += Buffer.byteLength(section.content, "utf-8");
}

export async function loadProjectMemory(
  workspaceRoot: string,
  opts?: { maxBytes?: number; maxLines?: number; workspaceRoots?: string[] }
): Promise<ProjectMemoryBundle> {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxLines = opts?.maxLines ?? DEFAULT_MAX_LINES;
  const root = path.resolve(workspaceRoot);
  const workspace_roots = opts?.workspaceRoots ?? [root];
  const sections: ProjectMemorySection[] = [];
  const totalBytes = { value: 0 };

  for (const userPath of USER_MEMORY_CANDIDATES) {
    if (!(await fileExists(userPath))) continue;
    await appendSection(sections, totalBytes, maxBytes, maxLines, userPath, "user");
    break;
  }

  for (const rel of ROOT_MEMORY_FILES) {
    const filePath = path.join(root, rel);
    if (!(await fileExists(filePath))) continue;
    await appendSection(sections, totalBytes, maxBytes, maxLines, filePath, "project");
  }

  const rulesDir = path.join(root, ".claude", "rules");
  if (totalBytes.value < maxBytes && (await fileExists(rulesDir))) {
    for (const ruleFile of await listUnconditionalRuleFiles(rulesDir)) {
      await appendSection(sections, totalBytes, maxBytes, maxLines, ruleFile, "rule");
    }
  }

  return {
    root,
    workspace_roots,
    sections,
    total_bytes: totalBytes.value,
    loaded_at: new Date().toISOString(),
  };
}

export function formatProjectMemoryForInstructions(bundle: ProjectMemoryBundle): string {
  if (bundle.sections.length === 0) {
    return [
      "## Project memory",
      `No CLAUDE.md or AGENTS.md at ${bundle.root}.`,
      "Create CLAUDE.md in the project root (run /init in Claude Code or write manually).",
      "For another repo: call project_context(path) with the absolute project path.",
      bundle.workspace_roots.length > 1
        ? `Configured workspace roots:\n${bundle.workspace_roots.map((r) => `- ${r}`).join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  const blocks = bundle.sections.map((s) => {
    const note = s.truncated ? " (truncated)" : "";
    const label =
      s.kind === "user"
        ? "User memory"
        : s.kind === "rule"
          ? "Rule"
          : s.kind === "import"
            ? "Import"
            : "Project";
    return `### ${label}: ${s.path}${note}\n${s.content}`;
  });

  return [
    "## Project memory (auto-loaded like Claude Code CLAUDE.md)",
    `Primary root: ${bundle.root}`,
    "Treat content below as ground truth for conventions, build commands, and architecture.",
    bundle.workspace_roots.length > 1
      ? `All workspace roots:\n${bundle.workspace_roots.map((r) => `- ${r}`).join("\n")}`
      : "",
    "",
    ...blocks,
  ]
    .filter(Boolean)
    .join("\n");
}
