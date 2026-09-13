import { randomUUID } from "node:crypto";

export type AgentClientType = "chatgpt" | "mcp";

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
  createdAt: string;
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

export function queueAgentAssignment(state: AgentCoordinatorState, taskId: string, createdAt = new Date().toISOString()): AgentAssignment {
  const existing = state.agentAssignments.find(item => item.taskId === taskId);
  if (existing) return existing;
  const assignment: AgentAssignment = { id: randomUUID(), taskId, createdAt };
  state.agentAssignments.push(assignment);
  return assignment;
}

export function cancelAgentAssignment(state: AgentCoordinatorState, taskId: string): boolean {
  const before = state.agentAssignments.length;
  state.agentAssignments = state.agentAssignments.filter(item => item.taskId !== taskId);
  return state.agentAssignments.length !== before;
}

export function claimSessionTask(
  state: AgentCoordinatorState,
  input: {
    sessionId: string;
    clientType: AgentClientType;
    fallbackTaskId?: string;
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
    const assignment = state.agentAssignments.find(item => input.taskExists(item.taskId));
    if (assignment) {
      taskId = assignment.taskId;
      claimedAssignmentId = assignment.id;
      state.agentAssignments = state.agentAssignments.filter(item => item.id !== assignment.id);
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
