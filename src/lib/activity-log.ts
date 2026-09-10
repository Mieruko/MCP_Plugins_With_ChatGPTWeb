import { randomUUID } from "node:crypto";
import fs from "fs/promises";
import { getAuditPath } from "./audit.js";

export type ActivityKind = "tool" | "mcp" | "session" | "system";

export interface ActivityEntry {
  id: string;
  time: string;
  kind: ActivityKind;
  tool?: string;
  action?: string;
  target?: string;
  status?: string;
  duration_ms?: number;
  session_id?: string;
  client?: string;
  summary?: string;
  details?: Record<string, unknown>;
}

const MAX_ENTRIES = parseInt(process.env.ACTIVITY_LOG_MAX || "500", 10);
const entries: ActivityEntry[] = [];
const listeners = new Set<(entry: ActivityEntry) => void>();

function trimSummary(text: string, max = 160): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + "…";
}

export function summarizeToolArgs(tool: string, args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;

  if (tool === "run_command" && typeof a.command === "string") return trimSummary(a.command, 120);
  if (typeof a.path === "string") return a.path;
  if (typeof a.server_id === "string" && typeof a.tool === "string") {
    return `${a.server_id} → ${a.tool}`;
  }
  if (typeof a.pattern === "string") return `pattern: ${a.pattern}`;
  if (typeof a.checkpoint_id === "string") return `checkpoint: ${a.checkpoint_id}`;
  if (typeof a.action === "string") return `action: ${a.action}`;

  try {
    return trimSummary(JSON.stringify(a));
  } catch {
    return "";
  }
}

export function appendActivity(partial: Omit<ActivityEntry, "id" | "time"> & { time?: string }): ActivityEntry {
  const entry: ActivityEntry = {
    id: randomUUID(),
    time: partial.time ?? new Date().toISOString(),
    ...partial,
  };

  entries.push(entry);
  while (entries.length > MAX_ENTRIES) entries.shift();

  writeConsole(entry);
  for (const listener of listeners) {
    try {
      listener(entry);
    } catch {}
  }
  return entry;
}

export function subscribeActivity(listener: (entry: ActivityEntry) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getRecentActivity(limit = 100, sinceId?: string): ActivityEntry[] {
  const capped = Math.min(Math.max(limit, 1), MAX_ENTRIES);
  if (!sinceId) return [...entries].slice(-capped).reverse();
  const idx = entries.findIndex((e) => e.id === sinceId);
  if (idx < 0) return [...entries].slice(-capped).reverse();
  return entries.slice(idx + 1).reverse();
}

function writeConsole(entry: ActivityEntry): void {
  const sid = entry.session_id ? ` session=${entry.session_id.slice(0, 8)}` : "";
  const dur = entry.duration_ms != null ? ` ${entry.duration_ms}ms` : "";
  const isError = entry.status === "error" || entry.status === "blocked";

  if (isError) {
    const label =
      entry.tool ? `tools/call ${entry.tool}` : entry.action || entry.kind || "mcp";
    const detail = entry.summary || entry.target || "";
    const http = entry.details?.http_status != null ? ` HTTP ${entry.details.http_status}` : "";
    console.warn(
      `[MCP ERROR]${http} ${label}${detail ? ` — ${detail}` : ""}${dur}${sid}`
    );
    return;
  }

  const status = entry.status ? ` [${entry.status}]` : "";

  if (entry.kind === "tool" && entry.tool) {
    const extra = entry.summary || entry.target || "";
    console.log(`[TOOL]${status} ${entry.tool}${extra ? ` — ${extra}` : ""}${dur}${sid}`);
    return;
  }

  if (entry.kind === "mcp") {
    const label = entry.tool ? `tools/call ${entry.tool}` : entry.action || "request";
    const extra = entry.summary ? ` — ${entry.summary}` : "";
    const discovery =
      entry.action === "tools/list" && entry.details?.tool_count != null
        ? ` (${entry.details.tool_count} tools)`
        : "";
    console.log(`[MCP]${status} ${label}${discovery}${extra}${dur}${sid}`);
    return;
  }

  if (entry.kind === "session") {
    const extra = entry.summary ? ` — ${entry.summary}` : "";
    console.log(`[MCP] session ${entry.action || "event"}${extra}${sid}`);
    return;
  }
}

export async function loadAuditHistory(limit = 80): Promise<ActivityEntry[]> {
  const auditPath = getAuditPath();
  try {
    const raw = await fs.readFile(auditPath, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const slice = lines.slice(-limit);
    return slice.map((line) => {
      try {
        const rec = JSON.parse(line) as Record<string, unknown>;
        return {
          id: randomUUID(),
          time: String(rec.time || new Date().toISOString()),
          kind: "tool" as const,
          tool: String(rec.tool || "unknown"),
          action: String(rec.action || ""),
          target: rec.target ? String(rec.target) : undefined,
          status: rec.status ? String(rec.status) : undefined,
          details: rec.details as Record<string, unknown> | undefined,
          summary: rec.target ? String(rec.target) : undefined,
        };
      } catch {
        return {
          id: randomUUID(),
          time: new Date().toISOString(),
          kind: "system" as const,
          summary: line.slice(0, 200),
        };
      }
    }).reverse();
  } catch {
    return [];
  }
}

export function logMcpHttpEvent(opts: {
  method: string;
  path: string;
  httpStatus: number;
  durationMs: number;
  sessionId?: string;
  rpcMethod?: string;
  tool?: string;
  errorMessage?: string;
  summary?: string;
}): void {
  const isError = opts.httpStatus >= 400;
  const label = opts.tool
    ? `tools/call ${opts.tool}`
    : opts.rpcMethod || `${opts.method} ${opts.path}`;
  const summary =
    opts.errorMessage ||
    opts.summary ||
    (isError ? `HTTP ${opts.httpStatus}` : undefined);

  appendActivity({
    kind: opts.rpcMethod === "initialize" ? "session" : "mcp",
    tool: opts.tool,
    action: opts.rpcMethod || `${opts.method} ${opts.path}`,
    session_id: opts.sessionId,
    client: "chatgpt",
    status: isError ? "error" : "ok",
    duration_ms: opts.durationMs,
    summary,
    details: { http_status: opts.httpStatus, method: opts.method, path: opts.path },
  });
}

export function logMcpRequest(
  body: unknown,
  sessionId: string | undefined,
  durationMs: number,
  httpStatus: number,
  errorMessage?: string
): void {
  if (typeof body !== "object" || body === null) {
    if (httpStatus >= 400) {
      logMcpHttpEvent({
        method: "POST",
        path: "/mcp",
        httpStatus,
        durationMs,
        sessionId,
        errorMessage,
      });
    }
    return;
  }
  const rpc = body as { method?: string; params?: { name?: string; arguments?: unknown; protocolVersion?: string } };
  const isError = httpStatus >= 400;
  const argSummary =
    rpc.method === "tools/call" && rpc.params?.name
      ? summarizeToolArgs(rpc.params.name, rpc.params.arguments)
      : undefined;
  const summary = errorMessage || argSummary;

  if (rpc.method === "tools/call" && rpc.params?.name) {
    const tool = rpc.params.name;
    appendActivity({
      kind: "mcp",
      tool,
      action: "tools/call",
      session_id: sessionId,
      client: "chatgpt",
      status: isError ? "error" : "ok",
      duration_ms: durationMs,
      summary,
      details: {
        http_status: httpStatus,
        arguments: rpc.params.arguments,
        ...(errorMessage ? { error: errorMessage } : {}),
      },
    });
    return;
  }

  if (rpc.method === "initialize") {
    appendActivity({
      kind: "session",
      action: "initialize",
      session_id: sessionId,
      client: "chatgpt",
      status: isError ? "error" : "ok",
      duration_ms: durationMs,
      summary: errorMessage,
      details: { http_status: httpStatus },
    });
    return;
  }

  if (rpc.method === "tools/list") {
    appendActivity({
      kind: "mcp",
      action: "tools/list",
      session_id: sessionId,
      client: "chatgpt",
      status: isError ? "error" : "ok",
      duration_ms: durationMs,
      summary: errorMessage || (isError ? `HTTP ${httpStatus}` : "discovery"),
      details: { http_status: httpStatus, phase: "connector_discovery" },
    });
    return;
  }

  if (rpc.method && !rpc.method.startsWith("notifications/")) {
    appendActivity({
      kind: "mcp",
      action: rpc.method,
      session_id: sessionId,
      client: "chatgpt",
      status: isError ? "error" : "ok",
      duration_ms: durationMs,
      summary: errorMessage,
      details: { http_status: httpStatus },
    });
  }
}