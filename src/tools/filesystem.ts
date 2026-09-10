import fs from "fs/promises";
import path from "path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validatePath, getDefaultCwd } from "../lib/path-security.js";
import { audit } from "../lib/audit.js";
import { requireWriteAllowed } from "../lib/permissions.js";
import { applyMultiFilePatch, applyUnifiedPatchToText, buildSimpleDiff, isMultiFilePatch, parseMultiFilePatch } from "../lib/patch.js";
import { checkpointBefore } from "../lib/checkpoint.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { enrichAfterEdit } from "../lib/edit-enrichment.js";
import { toolResult } from "../lib/tool-result.js";
import { globFiles } from "../lib/glob-search.js";
import { grepSearch } from "../lib/grep-search.js";



async function searchDirectory(
  dir: string,
  regex: RegExp,
  globPattern: string,
  results: string[],
  maxResults: number
): Promise<void> {
  if (results.length >= maxResults) return;

  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (results.length >= maxResults) break;

    const fullPath = path.join(dir, entry.name);
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

    if (entry.isDirectory()) {
      await searchDirectory(fullPath, regex, globPattern, results, maxResults);
    } else if (matchesGlob(entry.name, globPattern)) {
      try {
        const content = await fs.readFile(await validatePath(fullPath), "utf-8");
        const lines = content.split("\n");
        lines.forEach((line, idx) => {
          if (results.length < maxResults && regex.test(line)) {
            results.push(`${fullPath}:${idx + 1}: ${line.trim()}`);
          }
        });
      } catch {}
    }
  }
}

function matchesGlob(filename: string, pattern: string): boolean {
  if (pattern === "*") return true;
  const regex = new RegExp(
    "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".") + "$"
  );
  return regex.test(filename);
}

async function buildTree(dirPath: string, depth: number, maxDepth: number): Promise<object> {
  const name = path.basename(dirPath);
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  if (depth >= maxDepth) return { name, type: "directory", truncated: true };

  const children = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const childPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) children.push(await buildTree(childPath, depth + 1, maxDepth));
    else children.push({ name: entry.name, type: "file" });
  }

  return { name, type: "directory", children };
}

export function registerFilesystemTools(server: McpServer): void {
  server.registerTool(
    "read_text_file",
    {
      title: "Read Text File",
      description: "Read a file before editing. Use offset+limit for partial reads (1-based line numbers). Always read files you plan to patch.",
      inputSchema: {
        path: z.string(),
        offset: z.number().int().positive().optional().describe("1-based line number to start reading"),
        limit: z.number().int().positive().optional().describe("Number of lines to read from offset"),
        head: z.number().optional(),
        tail: z.number().optional(),
      },

      annotations: toolAnnotations("read"),
    },
    async ({ path: filePath, offset, limit, head, tail }) => {
      const validPath = await validatePath(filePath);
      const content = await fs.readFile(validPath, "utf-8");
      const lines = content.split("\n");

      if (offset !== undefined) {
        const start = Math.max(0, offset - 1);
        const end = limit !== undefined ? start + limit : lines.length;
        const slice = lines.slice(start, end);
        const numbered = slice.map((line, idx) => `${String(start + idx + 1).padStart(6, " ")}|${line}`);
        await audit({ tool: "read_text_file", action: "read", target: validPath, status: "ok", details: { offset, limit } });
        return toolResult("read_text_file", { path: validPath, content: numbered.join("\n"), offset, limit, lines: slice.length });
      }

      const result =
        head !== undefined ? lines.slice(0, head).join("\n") : tail !== undefined ? lines.slice(-tail).join("\n") : content;
      await audit({ tool: "read_text_file", action: "read", target: validPath, status: "ok" });
      return toolResult("read_text_file", { path: validPath, content: result, head, tail });
    }
  );

  server.registerTool(
    "read_file_base64",
    {
      title: "Read File Base64",
      description: "Read any local file as base64. Use offset/length for large files. Max chunk 8 MiB.",
      inputSchema: {
        path: z.string(),
        offset: z.number().int().nonnegative().optional().default(0),
        length: z.number().int().positive().max(8 * 1024 * 1024).optional().default(1024 * 1024),
      },

      annotations: toolAnnotations("read"),
    },
    async ({ path: filePath, offset, length }) => {
      const validPath = await validatePath(filePath);
      const stat = await fs.stat(validPath);
      if (!stat.isFile()) throw new Error("Path is not a regular file");
      const start = Math.min(offset, stat.size);
      const chunkLength = Math.min(length, 8 * 1024 * 1024, stat.size - start);
      const handle = await fs.open(validPath, "r");
      try {
        const buffer = Buffer.alloc(chunkLength);
        const { bytesRead } = await handle.read(buffer, 0, chunkLength, start);
        const data = buffer.subarray(0, bytesRead);
        const nextOffset = start + bytesRead;
        await audit({ tool: "read_file_base64", action: "read", target: validPath, status: "ok", details: { offset: start, bytesRead } });
        return toolResult("read_file_base64", {
          path: validPath,
          size: stat.size,
          offset: start,
          bytes_read: bytesRead,
          next_offset: nextOffset < stat.size ? nextOffset : null,
          done: nextOffset >= stat.size,
          encoding: "base64",
          content: data.toString("base64"),
        });
      } finally {
        await handle.close();
      }
    }
  );

  server.registerTool(
    "write_file",
    {
      title: "Write File",
      description: "Save text to a local file. Routine local file update.",
      inputSchema: { path: z.string(), content: z.string() },

      annotations: toolAnnotations("edit"),
    },
    async ({ path: filePath, content }) => {
      requireWriteAllowed();
      const validPath = await validatePath(filePath);
      const checkpointId = await checkpointBefore("write_file", [validPath]);
      await fs.mkdir(path.dirname(validPath), { recursive: true });
      await fs.writeFile(validPath, content, "utf-8");
      await audit({ tool: "write_file", action: "write", target: validPath, status: "ok", details: { bytes: Buffer.byteLength(content) } });
      const data = await enrichAfterEdit(
        { path: validPath, bytes: Buffer.byteLength(content), checkpoint_id: checkpointId },
        [validPath]
      );
      return toolResult("write_file", data);
    }
  );

  server.registerTool(
    "write_file_base64",
    {
      title: "Write File Base64",
      description: "Create or overwrite a binary file from base64 content.",
      inputSchema: { path: z.string(), content: z.string() },

      annotations: toolAnnotations("edit"),
    },
    async ({ path: filePath, content }) => {
      requireWriteAllowed();
      const validPath = await validatePath(filePath);
      const checkpointId = await checkpointBefore("write_file_base64", [validPath]);
      const buffer = Buffer.from(content, "base64");
      await fs.mkdir(path.dirname(validPath), { recursive: true });
      await fs.writeFile(validPath, buffer);
      await audit({ tool: "write_file_base64", action: "write", target: validPath, status: "ok", details: { bytes: buffer.length } });
      return toolResult("write_file_base64", { path: validPath, bytes: buffer.length, checkpoint_id: checkpointId });
    }
  );

  server.registerTool(
    "edit_file",
    {
      title: "Edit File",
      description: "Apply exact text replacement to a file. Returns diff.",
      inputSchema: {
        path: z.string(),
        old_text: z.string(),
        new_text: z.string(),
        replace_all: z.boolean().optional().default(false),
        dry_run: z.boolean().optional().default(false),
      },

      annotations: toolAnnotations("edit"),
    },
    async ({ path: filePath, old_text, new_text, replace_all, dry_run }) => {
      requireWriteAllowed();
      const validPath = await validatePath(filePath);
      const content = await fs.readFile(validPath, "utf-8");
      if (!content.includes(old_text)) throw new Error("old_text not found in file. Ensure exact match.");
      const newContent = replace_all ? content.split(old_text).join(new_text) : content.replace(old_text, new_text);
      const diff = buildSimpleDiff(content, newContent);
      const checkpointId = await checkpointBefore("edit_file", [validPath], { dry_run });
      if (!dry_run) await fs.writeFile(validPath, newContent, "utf-8");
      await audit({ tool: "edit_file", action: "edit", target: validPath, status: dry_run ? "dry-run" : "ok" });
      const data = await enrichAfterEdit({ path: validPath, diff, dry_run, checkpoint_id: checkpointId }, [validPath], dry_run);
      return toolResult("edit_file", data, { summary: dry_run ? `dry-run ${validPath}` : `edited ${validPath}` });
    }
  );

  server.registerTool(
    "multi_edit",
    {
      title: "Multi Edit",
      description: "Apply multiple exact replacements to one text file atomically.",
      inputSchema: {
        path: z.string(),
        edits: z.array(z.object({ old_text: z.string(), new_text: z.string(), replace_all: z.boolean().optional().default(false) })),
        dry_run: z.boolean().optional().default(false),
      },

      annotations: toolAnnotations("edit"),
    },
    async ({ path: filePath, edits, dry_run }) => {
      requireWriteAllowed();
      const validPath = await validatePath(filePath);
      const original = await fs.readFile(validPath, "utf-8");
      let next = original;
      for (const edit of edits) {
        if (!next.includes(edit.old_text)) throw new Error(`old_text not found: ${edit.old_text.slice(0, 120)}`);
        next = edit.replace_all ? next.split(edit.old_text).join(edit.new_text) : next.replace(edit.old_text, edit.new_text);
      }
      const diff = buildSimpleDiff(original, next);
      const checkpointId = await checkpointBefore("multi_edit", [validPath], { dry_run });
      if (!dry_run) await fs.writeFile(validPath, next, "utf-8");
      await audit({ tool: "multi_edit", action: "edit", target: validPath, status: dry_run ? "dry-run" : "ok", details: { edits: edits.length } });
      const data = await enrichAfterEdit(
        { path: validPath, diff, edits: edits.length, dry_run, checkpoint_id: checkpointId },
        [validPath],
        dry_run
      );
      return toolResult("multi_edit", data);
    }
  );

  server.registerTool(
    "replace_regex",
    {
      title: "Replace Regex",
      description: "Apply a JavaScript regex replacement to a text file.",
      inputSchema: { path: z.string(), pattern: z.string(), replacement: z.string(), flags: z.string().optional().default("g"), dry_run: z.boolean().optional().default(false) },

      annotations: toolAnnotations("edit"),
    },
    async ({ path: filePath, pattern, replacement, flags, dry_run }) => {
      requireWriteAllowed();
      const validPath = await validatePath(filePath);
      const original = await fs.readFile(validPath, "utf-8");
      const regex = new RegExp(pattern, flags);
      const next = original.replace(regex, replacement);
      if (next === original) throw new Error("Regex made no changes.");
      const diff = buildSimpleDiff(original, next);
      const checkpointId = await checkpointBefore("replace_regex", [validPath], { dry_run });
      if (!dry_run) await fs.writeFile(validPath, next, "utf-8");
      await audit({ tool: "replace_regex", action: "edit", target: validPath, status: dry_run ? "dry-run" : "ok" });
      return toolResult("replace_regex", { path: validPath, diff, dry_run, checkpoint_id: checkpointId });
    }
  );

  server.registerTool(
    "apply_patch",
    {
      title: "Apply Patch",
      description:
        "Preferred way to edit code. Codex @@ hunks or *** Begin Patch format. Read the file first. Use dry_run:true to preview.",
      inputSchema: {
        path: z.string().optional().describe("Target file (single-file) or base directory (multi-file)"),
        patch: z.string(),
        dry_run: z.boolean().optional().default(false),
      },

      annotations: toolAnnotations("edit"),
    },
    async ({ path: filePath, patch, dry_run }) => {
      requireWriteAllowed();

      if (isMultiFilePatch(patch)) {
        let baseDir: string | undefined = getDefaultCwd();
        if (filePath) {
          const validPath = await validatePath(filePath);
          const stat = await fs.stat(validPath);
          baseDir = stat.isDirectory() ? validPath : path.dirname(validPath);
        }
        const patchPaths = parseMultiFilePatch(patch, baseDir).map((op) => op.path);
        for (const patchPath of patchPaths) await validatePath(patchPath);
        const checkpointId = await checkpointBefore("apply_patch", patchPaths, { dry_run });
        const results = await applyMultiFilePatch(patch, { base_dir: baseDir, dry_run });
        const failed = results.filter((r) => !r.ok);
        await audit({
          tool: "apply_patch",
          action: "patch",
          target: baseDir || "multi",
          status: failed.length ? "error" : dry_run ? "dry-run" : "ok",
          details: { files: results.length, failed: failed.length },
        });
        const okPaths = results.filter((r) => r.ok && r.path).map((r) => r.path as string);
        const payload = await enrichAfterEdit(
          { files: results, dry_run, multi_file: true, checkpoint_id: checkpointId },
          okPaths,
          dry_run
        );
        return toolResult("apply_patch", payload, {
          ok: failed.length === 0,
          summary: `patched ${results.length} file(s)${failed.length ? `, ${failed.length} failed` : ""}`,
        });
      }

      if (!filePath) throw new Error("path is required for single-file patches");
      const validPath = await validatePath(filePath);
      const original = await fs.readFile(validPath, "utf-8");
      const next = applyUnifiedPatchToText(original, patch);
      const diff = buildSimpleDiff(original, next);
      const checkpointId = await checkpointBefore("apply_patch", [validPath], { dry_run });
      if (!dry_run) await fs.writeFile(validPath, next, "utf-8");
      await audit({ tool: "apply_patch", action: "patch", target: validPath, status: dry_run ? "dry-run" : "ok" });
      const data = await enrichAfterEdit({ path: validPath, diff, dry_run, checkpoint_id: checkpointId }, [validPath], dry_run);
      return toolResult("apply_patch", data);
    }
  );

  server.registerTool(
    "list_directory",
    {
      title: "List Directory",
      description: "List files and directories in a path. Claude LS equivalent with optional ignore globs.",
      inputSchema: {
        path: z.string(),
        ignore: z.array(z.string()).optional().describe("Glob patterns to ignore, e.g. node_modules, *.log"),
      },

      annotations: toolAnnotations("read"),
    },
    async ({ path: dirPath, ignore }) => {
      const validPath = await validatePath(dirPath);
      const entries = await fs.readdir(validPath, { withFileTypes: true });
      const ignoreMatchers = (ignore || []).map(
        (p) => new RegExp("^" + p.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i")
      );
      const filtered = entries.filter((e) => !ignoreMatchers.some((m) => m.test(e.name)));
      const items = filtered.map((e) => ({ name: e.name, type: e.isDirectory() ? "directory" : "file" }));
      await audit({ tool: "list_directory", action: "list", target: validPath, status: "ok" });
      return toolResult("list_directory", { path: validPath, entries: items, count: items.length });
    }
  );

  server.registerTool(
    "glob",
    {
      title: "Glob",
      description: "Explore: find files by name pattern under a directory. Use before read_text_file when you do not know exact paths.",
      inputSchema: {
        pattern: z.string().describe('Glob pattern like "**/*.ts" or "src/**/*.tsx"'),
        path: z.string().optional().describe("Directory to search in; defaults to workspace root context"),
        max_results: z.number().int().positive().max(500).optional().default(100),
      },

      annotations: toolAnnotations("read"),
    },
    async ({ pattern, path: searchPath, max_results }) => {
      const validPath = searchPath ? await validatePath(searchPath) : (await import("../lib/path-security.js")).getAllowedRoots()[0];
      const matches = await globFiles(validPath, pattern, max_results);
      await audit({ tool: "glob", action: "glob", target: validPath, status: "ok", details: { pattern, results: matches.length } });
      return toolResult("glob", { path: validPath, pattern, matches: matches.map((m) => m.path), count: matches.length });
    }
  );

  server.registerTool(
    "grep",
    {
      title: "Grep",
      description: "Explore: search file contents by regex. Prefer over reading many files blindly. Modes: content, files_with_matches, count.",
      inputSchema: {
        pattern: z.string(),
        path: z.string().optional(),
        glob: z.string().optional().default("*"),
        output_mode: z.enum(["content", "files_with_matches", "count"]).optional().default("content"),
        case_insensitive: z.boolean().optional().default(false),
        multiline: z.boolean().optional().default(false),
        head_limit: z.number().int().positive().max(1000).optional().default(200),
        context_before: z.number().int().nonnegative().max(20).optional().default(0),
        context_after: z.number().int().nonnegative().max(20).optional().default(0),
        context_around: z.number().int().nonnegative().max(20).optional().default(0),
      },

      annotations: toolAnnotations("read"),
    },
    async ({
      pattern,
      path: searchPath,
      glob: globPattern,
      output_mode,
      case_insensitive,
      multiline,
      head_limit,
      context_before,
      context_after,
      context_around,
    }) => {
      const validPath = searchPath ? await validatePath(searchPath) : (await import("../lib/path-security.js")).getAllowedRoots()[0];
      const output = await grepSearch({
        pattern,
        path: validPath,
        glob: globPattern,
        outputMode: output_mode,
        caseInsensitive: case_insensitive,
        multiline,
        headLimit: head_limit,
        contextBefore: context_before,
        contextAfter: context_after,
        contextAround: context_around,
      });
      await audit({ tool: "grep", action: "grep", target: validPath, status: "ok", details: { pattern, output_mode } });
      return toolResult("grep", { path: validPath, pattern, output_mode, output });
    }
  );

  server.registerTool(
    "delete_file",
    {
      title: "Delete File",
      description: "Delete a file from the filesystem.",
      inputSchema: { path: z.string() },

      annotations: toolAnnotations("edit"),
    },
    async ({ path: filePath }) => {
      requireWriteAllowed();
      const validPath = await validatePath(filePath);
      const stat = await fs.stat(validPath);
      if (!stat.isFile()) throw new Error("Path is not a file");
      const checkpointId = await checkpointBefore("delete_file", [validPath]);
      await fs.unlink(validPath);
      await audit({ tool: "delete_file", action: "delete", target: validPath, status: "ok" });
      return toolResult("delete_file", { path: validPath, checkpoint_id: checkpointId });
    }
  );

  server.registerTool(
    "create_directory",
    {
      title: "Create Directory",
      description: "Create a directory (and parents if needed).",
      inputSchema: { path: z.string() },

      annotations: toolAnnotations("edit"),
    },
    async ({ path: dirPath }) => {
      requireWriteAllowed();
      const validPath = await validatePath(dirPath);
      await checkpointBefore("create_directory", [validPath]);
      await fs.mkdir(validPath, { recursive: true });
      await audit({ tool: "create_directory", action: "mkdir", target: validPath, status: "ok" });
      return toolResult("create_directory", { path: validPath });
    }
  );

  server.registerTool(
    "delete_directory",
    {
      title: "Remove Local Folder",
      description:
        "Remove a folder from the local workspace (user-specified path). Does not affect remote servers.",
      inputSchema: { path: z.string() },

      annotations: toolAnnotations("edit"),
    },
    async ({ path: dirPath }) => {
      requireWriteAllowed();
      const validPath = await validatePath(dirPath);
      const stat = await fs.stat(validPath);
      if (!stat.isDirectory()) throw new Error("Path is not a directory");
      const checkpointId = await checkpointBefore("delete_directory", [validPath]);
      await fs.rm(validPath, { recursive: true, force: true });
      await audit({ tool: "delete_directory", action: "rmdir", target: validPath, status: "ok" });
      return toolResult("delete_directory", {
        path: validPath,
        checkpoint_id: checkpointId,
        run_command_fallback: `Remove-Item -Recurse -Force "${validPath}"`,
      });
    }
  );

  server.registerTool(
    "copy_file",
    {
      title: "Copy File",
      description: "Copy a file to a new location.",
      inputSchema: { source: z.string(), destination: z.string() },

      annotations: toolAnnotations("edit"),
    },
    async ({ source, destination }) => {
      requireWriteAllowed();
      const src = await validatePath(source);
      const dest = await validatePath(destination);
      const stat = await fs.stat(src);
      if (!stat.isFile()) throw new Error("Source is not a file");
      const checkpointId = await checkpointBefore("copy_file", [dest]);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
      await audit({ tool: "copy_file", action: "copy", target: dest, status: "ok", details: { source: src } });
      return toolResult("copy_file", { source: src, destination: dest, checkpoint_id: checkpointId });
    }
  );

  server.registerTool(
    "move_file",
    {
      title: "Move File",
      description: "Move or rename a file or directory.",
      inputSchema: { source: z.string(), destination: z.string() },

      annotations: toolAnnotations("edit"),
    },
    async ({ source, destination }) => {
      requireWriteAllowed();
      const src = await validatePath(source);
      const dest = await validatePath(destination);
      const checkpointId = await checkpointBefore("move_file", [src, dest]);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.rename(src, dest);
      await audit({ tool: "move_file", action: "move", target: dest, status: "ok", details: { source: src } });
      return toolResult("move_file", { source: src, destination: dest, checkpoint_id: checkpointId });
    }
  );

  server.registerTool("search_files", { title: "Search Files", description: "Search file contents for a text pattern.", inputSchema: { path: z.string(), pattern: z.string(), glob: z.string().optional().default("*"), max_results: z.number().optional().default(50) }, annotations: toolAnnotations("read") }, async ({ path: searchPath, pattern, glob: globPattern, max_results }) => {
    const validPath = await validatePath(searchPath);
    const results: string[] = [];
    await searchDirectory(validPath, new RegExp(pattern, "i"), globPattern, results, max_results);
    await audit({ tool: "search_files", action: "search", target: validPath, status: "ok", details: { pattern, results: results.length } });
    return toolResult("search_files", { path: validPath, pattern, matches: results, count: results.length });
  });

  server.registerTool("directory_tree", { title: "Directory Tree", description: "Get recursive directory structure as JSON.", inputSchema: { path: z.string(), max_depth: z.number().optional().default(4) }, annotations: toolAnnotations("read") }, async ({ path: dirPath, max_depth }) => {
    const validPath = await validatePath(dirPath);
    const tree = await buildTree(validPath, 0, max_depth);
    await audit({ tool: "directory_tree", action: "tree", target: validPath, status: "ok" });
    return toolResult("directory_tree", { path: validPath, tree, max_depth });
  });

  server.registerTool("list_allowed_directories", { title: "List Allowed Directories", description: "Show default working directory and machine access scope.", inputSchema: {}, annotations: toolAnnotations("read") }, async () => {
    const { getDefaultCwd, getMachineRoots } = await import("../lib/path-security.js");
    const { describePermissionProfile } = await import("../lib/permissions.js");
    const machineRoots = getMachineRoots();
    return toolResult("list_allowed_directories", {
      full_machine_access: true,
      permission: describePermissionProfile(),
      default_cwd: getDefaultCwd(),
      machine_roots: machineRoots,
    });
  });
}
