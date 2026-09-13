import { createHash } from "node:crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { executionContext } from "./workbench-context.js";
import { validatePath } from "./path-security.js";
import { checkpointBefore } from "./checkpoint.js";

const DEFAULT_MAX_BYTES = 25_000;
const DEFAULT_MAX_LINES = 200;
const DISK_HEADER = "# Auto memory (cross-session notes)";
const INSTRUCTION_HEADER = "## Auto memory (learned across sessions)";
const HISTORY_NOTICE = "[Older auto-memory notes omitted. Full history remains on disk; use read_text_file on .local-coder/MEMORY.md to inspect it.]";
const LEGACY_NOTICE = "[Legacy auto-memory format detected; showing the newest content. Full history remains on disk; use read_text_file on .local-coder/MEMORY.md to inspect it.]";
const NOTE_TRUNCATED_NOTICE = "[Newest auto-memory note truncated to fit the instruction budget.]";

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function limits(): { maxBytes: number; maxLines: number } {
  return {
    maxBytes: positiveInt(process.env.AUTO_MEMORY_MAX_BYTES, DEFAULT_MAX_BYTES),
    maxLines: positiveInt(process.env.AUTO_MEMORY_MAX_LINES, DEFAULT_MAX_LINES),
  };
}

function lineCount(text: string): number {
  return text ? text.split("\n").length : 0;
}

function formattedFits(content: string, maxBytes: number, maxLines: number): boolean {
  const formatted = `${INSTRUCTION_HEADER}\n${content}`;
  return Buffer.byteLength(formatted, "utf-8") <= maxBytes && lineCount(formatted) <= maxLines;
}

function utf8Prefix(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let bytes = 0;
  let output = "";
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf-8");
    if (bytes + size > maxBytes) break;
    output += char;
    bytes += size;
  }
  return output;
}

function fitPrefix(text: string, maxBytes: number, maxLines: number): string {
  if (maxBytes <= 0 || maxLines <= 0) return "";
  const byLines = text.split("\n").slice(0, maxLines).join("\n");
  return utf8Prefix(byLines, maxBytes).replace(/[\r\n]+$/g, "");
}

function parseDatedEntries(text: string): { recognized: boolean; entries: string[] } {
  const lines = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").split("\n");
  let index = 0;
  if (lines[index]?.trim() === DISK_HEADER) index++;
  while (index < lines.length && !lines[index].trim()) index++;
  if (index >= lines.length) return { recognized: true, entries: [] };

  const entries: string[] = [];
  let current: string[] | undefined;
  for (; index < lines.length; index++) {
    const line = lines[index];
    if (/^- \d{4}-\d{2}-\d{2}:\s/.test(line)) {
      if (current) entries.push(current.join("\n").replace(/[\r\n]+$/g, ""));
      current = [line];
      continue;
    }
    if (!current) {
      if (line.trim()) return { recognized: false, entries: [] };
      continue;
    }
    current.push(line);
  }
  if (current) entries.push(current.join("\n").replace(/[\r\n]+$/g, ""));
  return { recognized: entries.length > 0, entries };
}

function selectRecentEntries(entries: string[], maxBytes: number, maxLines: number): string | null {
  if (!entries.length) return null;
  const all = entries.join("\n");
  if (formattedFits(all, maxBytes, maxLines)) return all;

  const selected: string[] = [];
  for (let index = entries.length - 1; index >= 0; index--) {
    const candidateEntries = [entries[index], ...selected];
    const candidate = `${HISTORY_NOTICE}\n${candidateEntries.join("\n")}`;
    if (formattedFits(candidate, maxBytes, maxLines)) {
      selected.unshift(entries[index]);
      continue;
    }
    if (selected.length) break;

    const fixed = `${HISTORY_NOTICE}\n${NOTE_TRUNCATED_NOTICE}\n`;
    const fixedBytes = Buffer.byteLength(`${INSTRUCTION_HEADER}\n${fixed}`, "utf-8");
    const fixedLines = lineCount(`${INSTRUCTION_HEADER}\n${fixed}`);
    const prefix = fitPrefix(entries[index], maxBytes - fixedBytes, maxLines - fixedLines);
    const truncated = prefix ? `${fixed}${prefix}` : `${HISTORY_NOTICE}\n${NOTE_TRUNCATED_NOTICE}`;
    return formattedFits(truncated, maxBytes, maxLines) ? truncated : null;
  }

  const content = `${HISTORY_NOTICE}\n${selected.join("\n")}`;
  return selected.length && formattedFits(content, maxBytes, maxLines) ? content : null;
}

function selectLegacyTail(text: string, maxBytes: number, maxLines: number): string | null {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/[\r\n]+$/g, "");
  if (!normalized.trim()) return null;
  const lines = normalized.split("\n");
  const selected: string[] = [];
  for (let index = lines.length - 1; index >= 0; index--) {
    const candidate = `${LEGACY_NOTICE}\n${[lines[index], ...selected].join("\n")}`;
    if (!formattedFits(candidate, maxBytes, maxLines)) break;
    selected.unshift(lines[index]);
  }
  if (selected.length) return `${LEGACY_NOTICE}\n${selected.join("\n")}`;

  const fixed = `${LEGACY_NOTICE}\n${NOTE_TRUNCATED_NOTICE}\n`;
  const fixedBytes = Buffer.byteLength(`${INSTRUCTION_HEADER}\n${fixed}`, "utf-8");
  const fixedLines = lineCount(`${INSTRUCTION_HEADER}\n${fixed}`);
  const prefix = fitPrefix(lines.at(-1) || "", maxBytes - fixedBytes, maxLines - fixedLines);
  const content = prefix ? `${fixed}${prefix}` : LEGACY_NOTICE;
  return formattedFits(content, maxBytes, maxLines) ? content : null;
}

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
    const { maxBytes, maxLines } = limits();
    const parsed = parseDatedEntries(text);
    return parsed.recognized
      ? selectRecentEntries(parsed.entries, maxBytes, maxLines)
      : selectLegacyTail(text, maxBytes, maxLines);
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
  return [INSTRUCTION_HEADER, content].join("\n");
}
