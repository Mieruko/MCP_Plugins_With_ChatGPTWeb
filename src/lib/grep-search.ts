import fs from "fs/promises";
import path from "path";
import { validatePath } from "./path-security.js";

export type GrepOutputMode = "content" | "files_with_matches" | "count";

interface GrepOptions {
  pattern: string;
  path: string;
  glob?: string;
  outputMode?: GrepOutputMode;
  caseInsensitive?: boolean;
  multiline?: boolean;
  headLimit?: number;
  contextBefore?: number;
  contextAfter?: number;
  contextAround?: number;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

function shouldSkipDir(name: string): boolean {
  return name === "node_modules" || name === ".git";
}

function buildRegex(pattern: string, caseInsensitive: boolean, multiline: boolean): RegExp {
  const flags = `${caseInsensitive ? "i" : ""}${multiline ? "m" : ""}`;
  return new RegExp(pattern, flags || undefined);
}

export async function grepSearch(options: GrepOptions): Promise<string> {
  const {
    pattern,
    path: searchRoot,
    glob = "*",
    outputMode = "content",
    caseInsensitive = false,
    multiline = false,
    headLimit = 200,
    contextBefore = 0,
    contextAfter = 0,
    contextAround = 0,
  } = options;

  const before = contextAround || contextBefore;
  const after = contextAround || contextAfter;
  const regex = buildRegex(pattern, caseInsensitive, multiline);
  const globMatcher = globToRegExp(glob);

  const fileMatches = new Map<string, number>();
  const contentLines: string[] = [];
  let totalMatches = 0;

  async function walk(dir: string): Promise<void> {
    if (outputMode === "content" && contentLines.length >= headLimit) return;

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (outputMode === "content" && contentLines.length >= headLimit) break;
      if (entry.name.startsWith(".") && entry.name !== ".") continue;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipDir(entry.name)) await walk(fullPath);
        continue;
      }

      if (!globMatcher.test(entry.name)) continue;

      let text: string;
      try {
        text = await fs.readFile(await validatePath(fullPath), "utf-8");
      } catch {
        continue;
      }

      if (multiline) {
        const matches = text.match(regex);
        const count = matches?.length || 0;
        if (count > 0) {
          totalMatches += count;
          fileMatches.set(fullPath, (fileMatches.get(fullPath) || 0) + count);
          if (outputMode === "content") {
            contentLines.push(`${fullPath}: [multiline match x${count}]`);
          }
        }
        continue;
      }

      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!regex.test(lines[i])) continue;

        totalMatches++;
        fileMatches.set(fullPath, (fileMatches.get(fullPath) || 0) + 1);

        if (outputMode === "content") {
          if (contentLines.length >= headLimit) break;
          if (before > 0 || after > 0) {
            const start = Math.max(0, i - before);
            const end = Math.min(lines.length - 1, i + after);
            for (let j = start; j <= end; j++) {
              const prefix = j === i ? ":" : "-";
              contentLines.push(`${fullPath}${prefix}${j + 1}: ${lines[j]}`);
              if (contentLines.length >= headLimit) break;
            }
          } else {
            contentLines.push(`${fullPath}:${i + 1}: ${lines[i].trim()}`);
          }
        }
      }
    }
  }

  await walk(searchRoot);

  if (outputMode === "files_with_matches") {
    const files = [...fileMatches.keys()].slice(0, headLimit);
    return files.length ? files.join("\n") : "No matches found";
  }

  if (outputMode === "count") {
    const rows = [...fileMatches.entries()]
      .slice(0, headLimit)
      .map(([file, count]) => `${file}:${count}`);
    return rows.length ? rows.join("\n") : "No matches found";
  }

  return contentLines.length ? contentLines.join("\n") : "No matches found";
}
