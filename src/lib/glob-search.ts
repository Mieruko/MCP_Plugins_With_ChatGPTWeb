import fs from "fs/promises";
import path from "path";

function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, "/");
  const parts = normalized.split("**");
  let regex = "";

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const escaped = part
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]");
    regex += escaped;
    if (i < parts.length - 1) regex += ".*";
  }

  return new RegExp(`^${regex}$`, "i");
}

function shouldSkipDir(name: string): boolean {
  return name === "node_modules" || name === ".git" || name === "dist" || name === "build";
}

export async function globFiles(
  rootDir: string,
  pattern: string,
  maxResults: number
): Promise<Array<{ path: string; mtimeMs: number }>> {
  const matcher = globToRegExp(pattern.replace(/\\/g, "/"));
  const matches: Array<{ path: string; mtimeMs: number }> = [];

  async function walk(dir: string): Promise<void> {
    if (matches.length >= maxResults) return;

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (matches.length >= maxResults) break;
      if (entry.name.startsWith(".") && entry.name !== ".") continue;
      const fullPath = path.join(dir, entry.name);
      const rel = path.relative(rootDir, fullPath).replace(/\\/g, "/");

      if (entry.isDirectory()) {
        if (!shouldSkipDir(entry.name)) await walk(fullPath);
        continue;
      }

      if (!matcher.test(rel) && !matcher.test(entry.name)) continue;

      try {
        const stat = await fs.stat(fullPath);
        matches.push({ path: fullPath, mtimeMs: stat.mtimeMs });
      } catch {}
    }
  }

  await walk(rootDir);
  matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return matches;
}