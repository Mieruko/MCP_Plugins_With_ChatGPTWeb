import { randomUUID } from "node:crypto";
import { getMcpAuthToken } from "./local-auth.js";
import type { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpServer } from "../server-factory.js";
import { getUpstreamManager } from "./mcp-upstream-manager.js";
import { resolveSessionTask, getWorkbench } from "./workbench.js";
import { executionContext } from "./workbench-context.js";
import { buildInstructionContext } from "./instruction-context.js";


const DEFAULT_PROTOCOL_VERSION = "2025-03-26";
const SESSION_TTL_MS = parseInt(process.env.MCP_SESSION_TTL_MS || "86400000", 10); // 24h
const SESSION_CLEANUP_INTERVAL_MS = parseInt(
  process.env.MCP_SESSION_CLEANUP_MS || "300000",
  10
); // 5m
const SESSION_DELETE_GRACE_MS = parseInt(
  process.env.MCP_SESSION_DELETE_GRACE_MS || "45000",
  10
); // keep session after DELETE so in-flight tool calls can finish

const lastTransportErrors: Record<string, string> = {};
const sessionOpChains = new Map<string, Promise<void>>();

export interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  lastAccessedAt: number;
  createdAt: number;
}

export interface SessionManagerConfig {
  workspaceRoot: string;
  shellTimeout: number;
  workspaceRoots: string[];
  port: number;
  projectMemoryInstructions?: string;
}

export interface SessionManager {
  get(sessionId: string): McpSession | undefined;
  touch(sessionId: string): void;
  count(): number;
  createNew(req: Request, res: Response, body: unknown): Promise<void>;
  handleExisting(session: McpSession, req: Request, res: Response, body?: unknown): Promise<void>;
  tryRecoverStale(
    staleSessionId: string,
    req: Request,
    res: Response,
    body: unknown
  ): Promise<boolean>;
  sendSessionNotFound(res: Response, requestId?: string | number | null): void;
  sendBadRequest(res: Response, message: string, requestId?: string | number | null): void;
  startCleanup(): void;
  stopCleanup(): void;
}

function extractRequestId(body: unknown): string | number | null {
  if (typeof body !== "object" || body === null) return null;
  if (!("id" in body)) return null;
  const id = (body as { id?: unknown }).id;
  if (typeof id === "string" || typeof id === "number") return id;
  return null;
}

async function loopbackMcpPost(
  port: number,
  path: string,
  body: unknown,
  sessionId?: string,
  protocolVersion?: string
): Promise<{ ok: boolean; status: number; sessionId?: string }> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${getMcpAuthToken()}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  if (protocolVersion) headers["mcp-protocol-version"] = protocolVersion;

  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });

  // Drain JSON responses so recovery does not leave pooled connections occupied.
  await response.arrayBuffer();

  return {
    ok: response.ok,
    status: response.status,
    sessionId: response.headers.get("mcp-session-id") ?? undefined,
  };
}

export function consumeSessionTransportError(sessionId?: string): string | undefined {
  if (!sessionId || !lastTransportErrors[sessionId]) return undefined;
  const message = lastTransportErrors[sessionId];
  delete lastTransportErrors[sessionId];
  return message;
}

async function enqueueSessionOp(sessionId: string, op: () => Promise<void>): Promise<void> {
  const prev = sessionOpChains.get(sessionId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(op);
  sessionOpChains.set(sessionId, run);
  try {
    await run;
  } finally {
    if (sessionOpChains.get(sessionId) === run) {
      sessionOpChains.delete(sessionId);
    }
  }
}

export function createSessionManager(config: SessionManagerConfig): SessionManager {
  const sessions: Record<string, McpSession> = {};
  const pendingRecoveries: Record<string, McpSession> = {};
  const deleteGraceTimers: Record<string, ReturnType<typeof setTimeout>> = {};
  let cleanupTimer: ReturnType<typeof setInterval> | null = null;

  function touch(sessionId: string): void {
    cancelDeleteGrace(sessionId);
    const session = sessions[sessionId];
    if (session) {
      session.lastAccessedAt = Date.now();
    }
  }

  function cancelDeleteGrace(sessionId: string): void {
    const timer = deleteGraceTimers[sessionId];
    if (!timer) return;
    clearTimeout(timer);
    delete deleteGraceTimers[sessionId];
  }

  function scheduleDeleteGrace(sessionId: string): void {
    cancelDeleteGrace(sessionId);
    console.log(
      `[MCP] Session DELETE — giữ ${SESSION_DELETE_GRACE_MS / 1000}s để tool call đang chạy: ${sessionId}`
    );
    deleteGraceTimers[sessionId] = setTimeout(() => {
      delete deleteGraceTimers[sessionId];
      removeSession(sessionId, "client DELETE (grace expired)");
    }, SESSION_DELETE_GRACE_MS);
    deleteGraceTimers[sessionId].unref?.();
  }

  function removeSession(sessionId: string, reason: string): void {
    cancelDeleteGrace(sessionId);
    const session = sessions[sessionId];
    if (!session) return;
    getUpstreamManager().unregisterMcpServer(session.server);
    delete sessions[sessionId];
    delete lastTransportErrors[sessionId];
    sessionOpChains.delete(sessionId);
    console.log(`[MCP] Session removed (${reason}): ${sessionId}`);
  }

  function clearPendingRecovery(sessionId: string): void {
    delete pendingRecoveries[sessionId];
  }

  async function buildSession(preferredSessionId?: string): Promise<McpSession> {
    const sessionId = preferredSessionId || randomUUID();
    const taskId = await resolveSessionTask(sessionId, config.workspaceRoot);
    const task = (await getWorkbench()).tasks.find(t => t.id === taskId)!;
    // Bind both initialization memory and tools to the same task. Never send the
    // server's startup project memory to a session selected for another project.
    const context = await executionContext.run({ taskId, workspace: task.workspace, workspaceOnly: true,
      operationId: "initialization", capture: async () => {} }, () => buildInstructionContext({
        workspaceRoot: task.workspace, workspaceRoots: [task.workspace], pid: process.pid,
        adminPort: Number(process.env.ADMIN_PORT || 3001),
      }));
    const mcpServer = createMcpServer(
      task.workspace,
      config.shellTimeout,
      [task.workspace],
      !task.policy.workspaceOnly,
      getUpstreamManager(),
      context.instructionsText,
      taskId
    );

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
      enableJsonResponse: true,
      onsessioninitialized: (sid) => {
        const existing = sessions[sid];
        sessions[sid] = {
          transport,
          server: mcpServer,
          lastAccessedAt: Date.now(),
          createdAt: existing?.createdAt ?? Date.now(),
        };
        clearPendingRecovery(sid);
        console.log(`[MCP] Session initialized: ${sid}`);
      },
      onsessionclosed: (sid) => {
        if (sid) scheduleDeleteGrace(sid);
      },
    });

    transport.onerror = (error) => {
      const sid = transport.sessionId;
      const message = error.message || String(error);
      if (sid) lastTransportErrors[sid] = message;
    };

    // Keep session alive across transient SSE disconnects; explicit DELETE cleans up.
    transport.onclose = () => {
      const sid = transport.sessionId;
      if (!sid || !sessions[sid]) return;
      console.log(`[MCP] Transport closed for ${sid} (session kept for recovery)`);
    };

    await mcpServer.connect(transport);

    const sid = transport.sessionId ?? preferredSessionId ?? randomUUID();
    return (
      sessions[sid] ?? {
        transport,
        server: mcpServer,
        lastAccessedAt: Date.now(),
        createdAt: Date.now(),
      }
    );
  }

  async function warmUpRecoveredSession(
    staleSessionId: string,
    mcpPath: string,
    protocolVersion: string
  ): Promise<boolean> {
    const initResult = await loopbackMcpPost(
      config.port,
      mcpPath,
      {
        jsonrpc: "2.0",
        id: "__session_recovery_init__",
        method: "initialize",
        params: {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: "codex-mcp-session-recovery", version: "1.0.0" },
        },
      },
      staleSessionId
    );

    if (!initResult.ok) {
      console.log(
        `[MCP] Recovery initialize failed: HTTP ${initResult.status} for ${staleSessionId}`
      );
      return false;
    }

    const notifyResult = await loopbackMcpPost(
      config.port,
      mcpPath,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      staleSessionId,
      protocolVersion
    );

    if (!notifyResult.ok && notifyResult.status !== 202) {
      console.log(
        `[MCP] Recovery initialized notification failed: HTTP ${notifyResult.status}`
      );
      return false;
    }

    return Boolean(sessions[staleSessionId]);
  }

  return {
    get(sessionId: string) {
      return sessions[sessionId];
    },

    touch,

    count() {
      return Object.keys(sessions).length;
    },

    sendSessionNotFound(res: Response, requestId: string | number | null = null) {
      const message =
        "Session not found. Server restarted or connector session expired — refresh connector and open a new chat.";
      res.locals.mcpError = message;
      res.status(404).json({
        jsonrpc: "2.0",
        error: { code: -32001, message },
        id: requestId,
      });
    },

    sendBadRequest(res: Response, message: string, requestId: string | number | null = null) {
      res.locals.mcpError = message;
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message },
        id: requestId,
      });
    },

    async createNew(req: Request, res: Response, body: unknown): Promise<void> {
      const headerSessionId = req.headers["mcp-session-id"] as string | undefined;
      let session: McpSession;

      if (headerSessionId && pendingRecoveries[headerSessionId]) {
        session = pendingRecoveries[headerSessionId];
        clearPendingRecovery(headerSessionId);
        console.log(`[MCP] Using pending recovery transport for ${headerSessionId}`);
      } else {
        session = await buildSession();
      }

      const sid = headerSessionId || session.transport.sessionId;
      const run = async () => {
        await session.transport.handleRequest(req, res, body);
        const activeSid = session.transport.sessionId;
        if (activeSid) touch(activeSid);
      };

      if (sid) {
        await enqueueSessionOp(sid, run);
      } else {
        await run();
      }
    },

    async handleExisting(
      session: McpSession,
      req: Request,
      res: Response,
      body?: unknown
    ): Promise<void> {
      const sid =
        session.transport.sessionId || (req.headers["mcp-session-id"] as string | undefined);
      if (sid) touch(sid);
      const run = async () => {
        await session.transport.handleRequest(req, res, body);
      };
      // GET owns a potentially indefinite SSE stream. Queuing it with POST
      // prevents every subsequent tool call from running until SSE disconnects.
      // Notifications (including cancellation) must also reach in-flight calls.
      const notification = req.method === "POST" && body !== null &&
        typeof body === "object" && !("id" in body) && "method" in body;
      if (req.method === "GET" || notification) {
        await run();
        return;
      }
      if (sid) {
        await enqueueSessionOp(sid, run);
      } else {
        await run();
      }
    },

    async tryRecoverStale(
      staleSessionId: string,
      req: Request,
      res: Response,
      body: unknown
    ): Promise<boolean> {
      if (isInitializeRequest(body)) {
        return false;
      }

      console.log(`[MCP] Attempting session recovery for stale ID: ${staleSessionId}`);

      const protocolVersion =
        (req.headers["mcp-protocol-version"] as string | undefined) ??
        DEFAULT_PROTOCOL_VERSION;
      const mcpPath = req.path || "/mcp";

      const pending = await buildSession(staleSessionId);
      pendingRecoveries[staleSessionId] = pending;

      const warmed = await warmUpRecoveredSession(staleSessionId, mcpPath, protocolVersion);
      if (!warmed) {
        clearPendingRecovery(staleSessionId);
        removeSession(staleSessionId, "recovery failed");
        return false;
      }

      const recovered = sessions[staleSessionId];
      if (!recovered) {
        clearPendingRecovery(staleSessionId);
        return false;
      }

      touch(staleSessionId);
      console.log(`[MCP] Session recovered: ${staleSessionId}`);

      const headers = { ...req.headers, "mcp-session-id": staleSessionId };
      const patchedReq = Object.assign(req, { headers });
      await enqueueSessionOp(staleSessionId, async () => {
        await recovered.transport.handleRequest(patchedReq, res, body);
      });
      return true;
    },

    startCleanup() {
      if (cleanupTimer) return;
      cleanupTimer = setInterval(() => {
        const now = Date.now();
        for (const [sid, session] of Object.entries(sessions)) {
          if (now - session.lastAccessedAt > SESSION_TTL_MS) {
            void session.transport.close().catch(() => undefined);
            removeSession(sid, "TTL expired");
          }
        }
        for (const sid of Object.keys(pendingRecoveries)) {
          if (!sessions[sid]) clearPendingRecovery(sid);
        }
      }, SESSION_CLEANUP_INTERVAL_MS);
      cleanupTimer.unref?.();
    },

    stopCleanup() {
      if (!cleanupTimer) return;
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    },
  };
}

export function isStaleSessionRequest(
  sessionId: string | undefined,
  body: unknown,
  getSession: (id: string) => McpSession | undefined
): boolean {
  return Boolean(sessionId && !getSession(sessionId) && !isInitializeRequest(body));
}

export { extractRequestId, isInitializeRequest };
