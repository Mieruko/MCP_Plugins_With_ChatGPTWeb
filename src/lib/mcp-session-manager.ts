import { randomUUID } from "node:crypto";
import { getMcpAuthToken } from "./local-auth.js";
import type { Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpServer } from "../server-factory.js";
import { getUpstreamManager } from "./mcp-upstream-manager.js";
import { resolveSessionTask, getWorkbench, markAgentSessionClosed, taskExecutionPath } from "./workbench.js";
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
const ACTIVE_SESSION_WINDOW_MS = Math.max(
  1_000,
  parseInt(process.env.MCP_ACTIVE_SESSION_MS || "60000", 10)
); // fallback when a client does not keep a GET/SSE stream open

const lastTransportErrors: Record<string, string> = {};
const sessionOpChains = new Map<string, Promise<void>>();

export interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  taskId: string;
  workspace: string;
  clientInfo?: { name: string; version?: string };
  clientType: "chatgpt" | "mcp";
  lastAccessedAt: number;
  createdAt: number;
  liveConnections: number;
  inFlightRequests: number;
  clientClosedAt?: number;
}

export interface McpSessionSummary {
  id: string;
  taskId: string;
  workspace: string;
  clientInfo?: { name: string; version?: string };
  clientType: "chatgpt" | "mcp";
  createdAt: string;
  lastAccessedAt: string;
  active: boolean;
  connected: boolean;
  liveConnections: number;
  inFlightRequests: number;
  state: "working" | "connected" | "recent" | "dormant";
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
  list(): McpSessionSummary[];
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

function extractClientInfo(body: unknown): { name: string; version?: string } | undefined {
  if (!body || typeof body !== "object") return undefined;
  const params = (body as { params?: unknown }).params;
  if (!params || typeof params !== "object") return undefined;
  const info = (params as { clientInfo?: unknown }).clientInfo;
  if (!info || typeof info !== "object") return undefined;
  const name = (info as { name?: unknown }).name;
  const version = (info as { version?: unknown }).version;
  if (typeof name !== "string" || !name.trim()) return undefined;
  return { name: name.trim().slice(0, 120), ...(typeof version === "string" ? { version: version.slice(0, 80) } : {}) };
}

function clientInfoLooksLikeChatGpt(clientInfo?: { name: string; version?: string }): boolean {
  return /chatgpt|openai/i.test(clientInfo?.name || "");
}

function requestClientType(res: Response, clientInfo?: { name: string; version?: string }): McpSession["clientType"] {
  return res.locals?.mcpAuth?.chatgpt === true || clientInfoLooksLikeChatGpt(clientInfo) ? "chatgpt" : "mcp";
}

function isSessionActive(session: McpSession, now = Date.now()): boolean {
  if (session.inFlightRequests > 0 || session.liveConnections > 0) return true;
  if (session.clientClosedAt) return false;
  return now - session.lastAccessedAt <= ACTIVE_SESSION_WINDOW_MS;
}

function sessionState(session: McpSession, now = Date.now()): McpSessionSummary["state"] {
  if (session.inFlightRequests > 0) return "working";
  if (session.liveConnections > 0) return "connected";
  return isSessionActive(session, now) ? "recent" : "dormant";
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
      session.clientClosedAt = undefined;
    }
  }

  function markClientClosed(sessionId: string): void {
    const session = sessions[sessionId];
    if (!session) return;
    session.clientClosedAt = Date.now();
    session.liveConnections = 0;
  }

  function beginLiveConnection(sessionId: string, res: Response): () => void {
    const session = sessions[sessionId];
    if (!session) return () => {};
    touch(sessionId);
    session.liveConnections += 1;
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      session.liveConnections = Math.max(0, session.liveConnections - 1);
    };
    res.once("close", end);
    res.once("finish", end);
    return end;
  }

  async function trackRequest(sessionId: string, op: () => Promise<void>): Promise<void> {
    const session = sessions[sessionId];
    if (!session) {
      await op();
      return;
    }
    touch(sessionId);
    session.inFlightRequests += 1;
    try {
      await op();
    } finally {
      session.inFlightRequests = Math.max(0, session.inFlightRequests - 1);
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
    void markAgentSessionClosed(sessionId).catch(error => console.warn(`[MCP] Failed to persist closed agent binding ${sessionId}: ${String(error)}`));
    console.log(`[MCP] Session removed (${reason}): ${sessionId}`);
  }

  function clearPendingRecovery(sessionId: string): void {
    delete pendingRecoveries[sessionId];
  }

  async function buildSession(preferredSessionId?: string, clientInfo?: { name: string; version?: string }, clientType: McpSession["clientType"] = "mcp"): Promise<McpSession> {
    const sessionId = preferredSessionId || randomUUID();
    const taskId = await resolveSessionTask(sessionId, config.workspaceRoot, clientType);
    const task = (await getWorkbench()).tasks.find(t => t.id === taskId)!;
    const executionRoot = taskExecutionPath(task);
    // Bind both initialization memory and tools to the same task. Never send the
    // server's startup project memory to a session selected for another project.
    const context = await executionContext.run({ taskId, sessionId, workspace: executionRoot, workspaceOnly: true,
      operationId: "initialization", capture: async () => {} }, () => buildInstructionContext({
        workspaceRoot: executionRoot, workspaceRoots: [executionRoot], pid: process.pid,
        adminPort: Number(process.env.ADMIN_PORT || 3001),
      }));
    const mcpServer = createMcpServer(
      executionRoot,
      config.shellTimeout,
      [executionRoot],
      !task.policy.workspaceOnly,
      getUpstreamManager(),
      context.instructionsText,
      taskId,
      sessionId,
      clientType,
      (nextTaskId, nextWorkspace) => {
        const current = sessions[sessionId];
        if (!current) return;
        current.taskId = nextTaskId;
        current.workspace = nextWorkspace;
        current.lastAccessedAt = Date.now();
      },
    );

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => sessionId,
      enableJsonResponse: true,
      onsessioninitialized: (sid) => {
        const existing = sessions[sid];
        const pending = pendingRecoveries[sid];
        sessions[sid] = {
          transport,
          server: mcpServer,
          taskId,
          workspace: executionRoot,
          clientInfo: pending?.clientInfo ?? existing?.clientInfo ?? clientInfo,
          clientType: pending?.clientType ?? existing?.clientType ?? clientType,
          lastAccessedAt: Date.now(),
          createdAt: existing?.createdAt ?? Date.now(),
          liveConnections: existing?.liveConnections ?? 0,
          inFlightRequests: existing?.inFlightRequests ?? 0,
          clientClosedAt: undefined,
        };
        clearPendingRecovery(sid);
        console.log(`[MCP] Session initialized: ${sid}`);
      },
      onsessionclosed: (sid) => {
        if (sid) {
          markClientClosed(sid);
          scheduleDeleteGrace(sid);
        }
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
        taskId,
        workspace: executionRoot,
        clientInfo,
        clientType,
        lastAccessedAt: Date.now(),
        createdAt: Date.now(),
        liveConnections: 0,
        inFlightRequests: 0,
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
      const now = Date.now();
      return Object.values(sessions).filter(session => isSessionActive(session, now)).length;
    },

    list() {
      const now = Date.now();
      return Object.entries(sessions)
        .map(([id, session]) => ({
          id,
          taskId: session.taskId,
          workspace: session.workspace,
          clientInfo: session.clientInfo,
          clientType: session.clientType,
          createdAt: new Date(session.createdAt).toISOString(),
          lastAccessedAt: new Date(session.lastAccessedAt).toISOString(),
          active: isSessionActive(session, now),
          connected: session.liveConnections > 0,
          liveConnections: session.liveConnections,
          inFlightRequests: session.inFlightRequests,
          state: sessionState(session, now),
        }))
        .sort((a, b) => b.lastAccessedAt.localeCompare(a.lastAccessedAt));
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
      const clientInfo = extractClientInfo(body);
      const clientType = requestClientType(res, clientInfo);
      let session: McpSession;

      if (headerSessionId && pendingRecoveries[headerSessionId]) {
        session = pendingRecoveries[headerSessionId];
        session.clientInfo = clientInfo ?? session.clientInfo;
        if (clientType === "chatgpt") session.clientType = "chatgpt";
        clearPendingRecovery(headerSessionId);
        console.log(`[MCP] Using pending recovery transport for ${headerSessionId}`);
      } else {
        session = await buildSession(undefined, clientInfo, clientType);
      }

      const sid = headerSessionId || session.transport.sessionId;
      const run = async () => {
        await session.transport.handleRequest(req, res, body);
        const activeSid = session.transport.sessionId;
        if (activeSid) touch(activeSid);
      };

      if (sid) {
        await enqueueSessionOp(sid, () => trackRequest(sid, run));
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
      if (req.method === "GET") {
        if (!sid) {
          await run();
          return;
        }
        const endLiveConnection = beginLiveConnection(sid, res);
        try {
          await run();
        } catch (error) {
          endLiveConnection();
          throw error;
        }
        return;
      }
      if (notification) {
        await run();
        return;
      }
      if (sid) {
        await enqueueSessionOp(sid, () => trackRequest(sid, run));
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

      const pending = await buildSession(staleSessionId, undefined, requestClientType(res));
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
        await trackRequest(staleSessionId, () => recovered.transport.handleRequest(patchedReq, res, body));
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
