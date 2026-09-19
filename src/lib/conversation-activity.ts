import type { McpSessionSummary } from "./mcp-session-manager.js";

interface Activity {
  id: string;
  taskId: string;
  workspace: string;
  createdAt: number;
  lastAccessedAt: number;
  inFlightRequests: number;
}
const conversations = new Map<string, Activity>();
const transports = new Set<string>();
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function isConversationTransport(id: string): boolean { return transports.has(id); }
export function forgetConversationTransport(id: string): void { transports.delete(id); }

export function updateConversationActivity(id: string, taskId: string, workspace: string): void {
  const activity = conversations.get(id);
  if (activity) Object.assign(activity, { taskId, workspace, lastAccessedAt: Date.now() });
}

export async function withConversationActivity<T>(
  id: string, taskId: string, workspace: string, transportId: string | undefined, invoke: () => Promise<T>,
  onIdle: () => Promise<unknown>,
): Promise<T> {
  const previousTimer = idleTimers.get(id);
  if (previousTimer) clearTimeout(previousTimer);
  idleTimers.delete(id);
  if (transportId) transports.add(transportId);
  const now = Date.now();
  const activity = conversations.get(id) ?? { id, taskId, workspace, createdAt: now, lastAccessedAt: now, inFlightRequests: 0 };
  conversations.set(id, activity);
  updateConversationActivity(id, taskId, workspace);
  activity.inFlightRequests++;
  try { return await invoke(); }
  finally {
    activity.inFlightRequests--; activity.lastAccessedAt = Date.now();
    if (!activity.inFlightRequests) {
      const delay = Math.max(1000, Number(process.env.WORKBENCH_REVIEW_QUIESCENCE_MS) || 15000);
      const timer = setTimeout(() => {
        idleTimers.delete(id);
        if (!activity.inFlightRequests) void onIdle().catch(error => console.warn("Conversation review close failed:", String(error)));
      }, delay);
      timer.unref();
      idleTimers.set(id, timer);
    }
  }
}

export function conversationActivitySnapshots(activeWindowMs: number, ttlMs: number): McpSessionSummary[] {
  const now = Date.now();
  const result: McpSessionSummary[] = [];
  for (const [id, activity] of conversations) {
    if (!activity.inFlightRequests && now - activity.lastAccessedAt > ttlMs) { conversations.delete(id); continue; }
    const active = activity.inFlightRequests > 0 || now - activity.lastAccessedAt <= activeWindowMs;
    result.push({ ...activity, clientType: "chatgpt", clientInfo: { name: "ChatGPT conversation" },
      createdAt: new Date(activity.createdAt).toISOString(), lastAccessedAt: new Date(activity.lastAccessedAt).toISOString(),
      active, connected: false, liveConnections: 0,
      state: activity.inFlightRequests ? "working" : active ? "recent" : "dormant",
    });
  }
  return result;
}
