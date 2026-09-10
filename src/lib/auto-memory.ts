import { createHash } from "node:crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { executionContext } from "./workbench-context.js";
import { validatePath } from "./path-security.js";
import { checkpointBefore } from "./checkpoint.js";

const MAX_BYTES = parseInt(process.env.AUTO_MEMORY_MAX_BYTES || "25000", 10);
const MAX_LINES = parseInt(process.env.AUTO_MEMORY_MAX_LINES || "200", 10);

function projectDir(workspaceRoot: string): string {
  if (executionContext.getStore()) return path.join(executionContext.getStore()!.workspace, ".local-coder");
  const slug = createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 12);
  const base = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.join(base, "projects", slug);
}

function memoryPath(workspaceRoot: string): string {
  return path.join(projectDir(workspaceRoot), "MEMORY.md");
}

export async function loadAutoMemory(workspaceRoot: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(await validatePath(memoryPath(workspaceRoot)));
    const text = buf.toString("utf-8");
    const lines = text.split(/\r?\n/).slice(0, MAX_LINES).join("\n");
    const limited =
      Buffer.byteLength(lines, "utf-8") > MAX_BYTES
        ? Buffer.from(lines, "utf-8").subarray(0, MAX_BYTES).toString("utf-8")
        : lines;
    return limited.trim() || null;
  } catch {
    return null;
  }
}

export async function appendAutoMemory(workspaceRoot: string, note: string): Promise<string> {
  const dir = projectDir(workspaceRoot);
  const file = memoryPath(workspaceRoot);
  await validatePath(file);
  await checkpointBefore("remember", [file]);
  await fs.mkdir(dir, { recursive: true });

  const line = `- ${new Date().toISOString().slice(0, 10)}: ${note.trim()}\n`;
  let existing = "";
  try {
    existing = await fs.readFile(file, "utf-8");
  } catch {}

  const header = existing ? "" : "# Auto memory (cross-session notes)\n\n";
  await fs.writeFile(file, header + existing + line, "utf-8");
  return file;
}

export function formatAutoMemoryForInstructions(content: string | null): string {
  if (!content) return "";
  return ["## Auto memory (learned across sessions)", content].join("\n");
}
