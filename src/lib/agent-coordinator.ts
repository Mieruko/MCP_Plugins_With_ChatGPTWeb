import { randomUUID } from "node:crypto";

export type AgentClientType = "chatgpt" | "mcp";
export type AgentAssignmentClientType = AgentClientType | "worker";
export type AgentAssignmentStatus = "queued" | "claimed" | "expired" | "cancelled";

export interface AgentBinding {
  id: string;
  agentId: string;
  sessionId: string;
  taskId: string;
  clientType: AgentClientType;
  createdAt: string;
  lastSeenAt: string;
  closedAt?: string;
}

export interface AgentAssignment {
  id: string;
  taskId: string;
  workspaceId: string;
  clientType: AgentAssignmentClientType;
  createdAt: string;
  expiresAt: string;
  leaseNonce: string;
  status: AgentAssignmentStatus;
  claimedAt?: string;
  claimedBySessionId?: string;
}

export interface AgentCoordinatorState {
  agentBindings: AgentBinding[];
  agentAssignments: AgentAssignment[];
}

export function migrateLegacySessionTasks(sessionTasks: Record<string, string> | undefined, createdAt = new Date().toISOString()): AgentBinding[] {
  if (!sessionTasks) return [];
  return Object.entries(sessionTasks).map(([sessionId, taskId]) => ({
    id: randomUUID(),
    agentId: randomUUID(),
    sessionId,
    taskId,
    clientType: "mcp",
    createdAt,
    lastSeenAt: createdAt,
  }));
}

const DEFAULT_ASSIGNMENT_LEASE_MS = 15 * 60_000;

export function pruneExpiredAgentAssignments(state: AgentCoordinatorState, now = Date.now()): number {
  let expired = 0;
  for (const item of state.agentAssignments) {
    if (item.status !== "queued") continue;
    const expires = Date.parse(item.expiresAt);
    if (Number.isFinite(expires) && expires > now) continue;
    item.status = "expired";
    expired++;
  }
  trimAssignmentHistory(state);
  return expired;
}

function trimAssignmentHistory(state: AgentCoordinatorState): void {
  const queued = state.agentAssignments.filter(item => item.status === "queued");
  const terminal = state.agentAssignments.filter(item => item.status !== "queued")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 200);
  state.agentAssignments = [...queued, ...terminal];
}

export function queueAgentAssignment(
  state: AgentCoordinatorState,
  taskId: string,
  workspaceId: string,
  createdAt = new Date().toISOString(),
  leaseMs = DEFAULT_ASSIGNMENT_LEASE_MS,
  clientType: AgentAssignmentClientType = "chatgpt",
): AgentAssignment {
  pruneExpiredAgentAssignments(state, Date.parse(createdAt));
  const existing = state.agentAssignments.find(item => item.status === "queued" && item.taskId === taskId && item.workspaceId === workspaceId && item.clientType === clientType);
  if (existing) return existing;
  const assignment: AgentAssignment = {
    id: randomUUID(),
    taskId,
    workspaceId,
    clientType,
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + Math.max(30_000, leaseMs)).toISOString(),
    leaseNonce: randomUUID(),
    status: "queued",
  };
  state.agentAssignments.push(assignment);
  return assignment;
}

export function cancelAgentAssignment(state: AgentCoordinatorState, taskId: string): boolean {
  const now = new Date().toISOString();
  let changed = false;
  for (const item of state.agentAssignments) {
    if (item.taskId !== taskId || item.status !== "queued") continue;
    item.status = "cancelled";
    item.expiresAt = now;
    changed = true;
  }
  trimAssignmentHistory(state);
  return changed;
}

export function claimSessionTask(
  state: AgentCoordinatorState,
  input: {
    sessionId: string;
    clientType: AgentClientType;
    fallbackTaskId?: string;
    workspaceId?: string;
    taskExists: (taskId: string) => boolean;
    now?: string;
  },
): { taskId: string; binding: AgentBinding; claimedAssignmentId?: string; created: boolean } {
  const now = input.now || new Date().toISOString();
  const existing = state.agentBindings.find(binding => binding.sessionId === input.sessionId);
  if (existing && input.taskExists(existing.taskId)) {
    existing.lastSeenAt = now;
    existing.closedAt = undefined;
    if (input.clientType === "chatgpt") existing.clientType = "chatgpt";
    return { taskId: existing.taskId, binding: existing, created: false };
  }
  if (existing) state.agentBindings = state.agentBindings.filter(binding => binding.id !== existing.id);

  let taskId = input.fallbackTaskId;
  let claimedAssignmentId: string | undefined;
  if (input.clientType === "chatgpt") {
    pruneExpiredAgentAssignments(state, Date.parse(now));
    const assignments = state.agentAssignments
      .filter(item => item.status === "queued" && item.clientType === "chatgpt" && input.taskExists(item.taskId) && (!input.workspaceId || item.workspaceId === input.workspaceId))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    if (!input.workspaceId && assignments.length > 1) {
      throw new Error("AGENT_ASSIGNMENT_AMBIGUOUS: multiple ChatGPT task leases are waiting; bind the session to a specific lease before initialization");
    }
    const assignment = assignments[0];
    if (assignment) {
      taskId = assignment.taskId;
      claimedAssignmentId = assignment.id;
      assignment.status = "claimed";
      assignment.claimedAt = now;
      assignment.claimedBySessionId = input.sessionId;
      trimAssignmentHistory(state);
    }
  }

  if (!taskId) {
    throw new Error("AGENT_ASSIGNMENT_REQUIRED: no task is reserved for this ChatGPT session");
  }

  const binding: AgentBinding = {
    id: randomUUID(),
    agentId: randomUUID(),
    sessionId: input.sessionId,
    taskId,
    clientType: input.clientType,
    createdAt: now,
    lastSeenAt: now,
  };
  state.agentBindings.push(binding);
  return { taskId, binding, claimedAssignmentId, created: true };
}

export function closeAgentBinding(state: AgentCoordinatorState, sessionId: string, closedAt = new Date().toISOString()): AgentBinding | undefined {
  const binding = state.agentBindings.find(item => item.sessionId === sessionId);
  if (!binding) return undefined;
  binding.lastSeenAt = closedAt;
  binding.closedAt = closedAt;
  return binding;
}
