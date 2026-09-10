import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validatePath, getDefaultCwd } from "../lib/path-security.js";
import { grepSearch } from "../lib/grep-search.js";
import { globFiles } from "../lib/glob-search.js";
import { loadPathRulesForFile } from "../lib/path-rules.js";
import { toolResult } from "../lib/tool-result.js";
import { audit } from "../lib/audit.js";

const requestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("read"), path: z.string(), offset: z.number().int().min(1).default(1), limit: z.number().int().min(1).max(1000).default(160) }),
  z.object({ kind: z.literal("grep"), path: z.string(), pattern: z.string(), glob: z.string().default("*"), ignore_case: z.boolean().default(false) }),
  z.object({ kind: z.literal("glob"), path: z.string(), pattern: z.string() }),
]);

type Request = z.infer<typeof requestSchema>;
const MAX_READ_BYTES = 1024 * 1024;

async function inspect(request: Request, root: string) {
  const filePath = await validatePath(request.path);
  if (request.kind === "glob") {
    const files = await globFiles(filePath, request.pattern, 50);
    return { content: files.map(f => f.path).join("\n"), rules: [], result_limit: 50 };
  }
  if (request.kind === "grep") {
    const content = await grepSearch({ path: filePath, pattern: request.pattern, glob: request.glob,
      caseInsensitive: request.ignore_case, headLimit: 60, contextAround: 2 });
    return { content, rules: [], result_limit: 60 };
  }
  const handle = await fs.open(filePath, "r");
  let buffer: Buffer;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Expected a regular text file");
    if (stat.size > MAX_READ_BYTES) throw new Error("File exceeds 1 MiB; use read_text_file with a range");
    // Bound even if the file grows between stat and read.
    const data = Buffer.alloc(MAX_READ_BYTES + 1);
    let length = 0;
    while (length < data.length) {
      const { bytesRead } = await handle.read(data, length, data.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_READ_BYTES) throw new Error("File exceeds 1 MiB; use read_text_file with a range");
    buffer = data.subarray(0, length);
  } finally { await handle.close(); }
  if (buffer.includes(0)) throw new Error("Binary file; use read_file_base64");
  const lines = buffer.toString("utf8").split(/\r?\n/);
  const selected = lines.slice(request.offset - 1, request.offset - 1 + request.limit);
  return {
    content: selected.map((line, i) => `${request.offset + i}: ${line}`).join("\n"),
    sha256: createHash("sha256").update(buffer).digest("hex"),
    total_lines: lines.length,
    next_offset: request.offset - 1 + selected.length < lines.length ? request.offset + selected.length : null,
    rules: await loadPathRulesForFile(root, filePath),
  };
}

export function registerInspectTools(server: McpServer, workspaceRoot: string): void {
  server.registerTool("inspect_code", {
    title: "Inspect Code in One Round Trip",
    description: "Read several known files/ranges or run independent grep/glob searches in one call. Prefer over repeated reads/searches. Reads include hashes and applicable path rules. Results stay in request order; individual errors do not discard other results. Narrow paths/patterns and follow truncation markers for more context.",
    inputSchema: {
      requests: z.array(requestSchema).min(1).max(12),
      max_chars: z.number().int().min(2000).max(60000).default(24000).describe("Total content character budget, shared across results and rules; metadata is additional."),
      workspace_root: z.string().optional().describe("Root for path rules when inspecting another project."),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ requests, max_chars, workspace_root }) => {
    const root = await validatePath(workspace_root || getDefaultCwd());
    const results: Array<Record<string, unknown>> = new Array(requests.length);
    let next = 0;
    // Fixed concurrency: batch size must not multiply open file handles without limit.
    await Promise.all(Array.from({ length: Math.min(4, requests.length) }, async () => {
      while (next < requests.length) {
        const index = next++;
        try { results[index] = { index, kind: requests[index].kind, path: requests[index].path, ok: true, ...await inspect(requests[index], root) }; }
        catch (error) { results[index] = { index, kind: requests[index].kind, path: requests[index].path, ok: false, error: String(error).slice(0, 500) }; }
      }
    }));
    let remaining = max_chars;
    const rules = new Map<string, { path: string; content: string; truncated: boolean }>();
    for (const result of results) {
      const refs: string[] = [];
      for (const rule of (result.rules ?? []) as Array<{ path: string; content: string }>) {
        refs.push(rule.path);
        if (!rules.has(rule.path)) {
          const content = rule.content.slice(0, remaining);
          remaining -= content.length;
          rules.set(rule.path, { path: rule.path, content, truncated: content.length < rule.content.length });
        }
      }
      delete result.rules;
      if (refs.length) result.rule_paths = refs;
    }
    // Fair per-result budgets prevent a large first file from hiding all later ones.
    const contentResults = results.filter(r => typeof r.content === "string");
    for (let i = 0; i < contentResults.length; i++) {
      const result = contentResults[i];
      const content = result.content as string;
      const budget = Math.floor(remaining / (contentResults.length - i));
      result.content = content.slice(0, budget);
      result.truncated = content.length > budget;
      remaining -= (result.content as string).length;
      // A character cut can split a line; do not advertise a range cursor that skips it.
      if (result.truncated) delete result.next_offset;
    }
    const errors = results.filter(r => !r.ok).length;
    await audit({ tool: "inspect_code", action: "read", target: root, status: errors ? "error" : "ok", details: { requests: requests.length, errors } });
    return toolResult("inspect_code", { results, rules: [...rules.values()], content_chars: max_chars - remaining, errors },
      { ok: errors === 0, summary: `${results.length} inspections, ${errors} errors` });
  });
}
