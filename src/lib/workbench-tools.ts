import { z } from "zod";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  assertSessionTaskBinding,
  closeSessionReviewRun,
  completeTask,
  createTask,
  dispatch,
  ensureWorkspaceForControl,
  getWorkbench,
  operationDetail,
  resolveDefaultTask,
  resolveConversationTask,
  resolveWorkspaceForControl,
  setSessionTaskPolicy,
  setTaskHandoff,
  taskDispatchInbox,
  mutateTaskDispatch,
  switchSessionTask,
  targetAgentSession,
  taskExecutionPath,
  type ReviewIdentity,
} from "./workbench.js";
import { executionContext, mcpPrincipalContext } from "./workbench-context.js";
import { validatePath } from "./path-security.js";
import { updateConversationActivity, withConversationActivity } from "./conversation-activity.js";
import { operationMediaCache } from "./operation-media.js";
import { audit } from "./audit.js";

const SUMMARY_ATTENTION_LIMIT = 8;
const HANDOFF_EXCERPT_CHARS = 700;
const HISTORY_MAX_BYTES = 24_000;

function requestHeader(headers: any, name: string): string | undefined {
  if (!headers) return undefined;
  const raw = typeof headers.get === "function"
    ? headers.get(name)
    : Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
  const first = Array.isArray(raw) ? raw[0] : raw;
  return typeof first === "string" ? first : undefined;
}

function reviewIdentity(extra: any): ReviewIdentity | undefined {
  const meta = extra?._meta;
  const metaCandidates = meta && typeof meta === "object"
    ? [meta.turn_id, meta.turnId, meta.run_id, meta.runId, meta["openai/turn_id"], meta["openai/run_id"]]
    : [];
  const headers = extra?.requestInfo?.headers;
  const candidates = [
    ...metaCandidates,
    requestHeader(headers, "x-openai-turn-id"),
    requestHeader(headers, "openai-turn-id"),
    requestHeader(headers, "x-openai-run-id"),
    requestHeader(headers, "openai-run-id"),
    requestHeader(headers, "x-chatgpt-turn-id"),
  ];
  const value = candidates.find(item => typeof item === "string" && item.trim().length > 0 && item.trim().length <= 1024)?.trim();
  if (!value) return undefined;
  return { turnKeyHash: createHash("sha256").update(value).digest("hex"), source: "host" };
}

function historySummary(op: Awaited<ReturnType<typeof getWorkbench>>["operations"][number]) {
  return { id: op.id, tool: op.tool.slice(0, 120), status: op.status, createdAt: op.createdAt,
    tracking: op.tracking, changes_count: op.changes.length,
    ...(op.error ? { error: op.error.slice(0, 400), error_truncated: op.error.length > 400 } : {}),
    ...(op.review ? { review: { additions: op.review.additions, deletions: op.review.deletions, files_count: op.review.files.length } } : {}),
    details_omitted: true };
}

function encodeHistoryCursor(taskId: string, operationId: string): string {
  return Buffer.from(JSON.stringify({ taskId, operationId }), "utf-8").toString("base64url");
}

function decodeHistoryCursor(cursor: string): { taskId: string; operationId: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8"));
    if (typeof parsed?.taskId !== "string" || typeof parsed?.operationId !== "string") throw new Error();
    return parsed;
  } catch {
    throw new Error("Invalid workbench history cursor");
  }
}

function handoffSummary(handoff: any) {
  if (!handoff) return { available: false };
  const source = [handoff.summary, ...(handoff.nextSteps || []).map((item: string) => `Next: ${item}`), handoff.notes]
    .filter(Boolean).join("\n");
  const excerpt = source.length > HANDOFF_EXCERPT_CHARS ? `${source.slice(0, HANDOFF_EXCERPT_CHARS)}…` : source;
  return { available: true, updated_at: handoff.updatedAt, excerpt, truncated: source.length > HANDOFF_EXCERPT_CHARS,
    message: "Use task_handoff(action=read) for the full handoff." };
}

/** Install before registering any tools, including dynamically proxied tools. */
export function installWorkbench(
  server: McpServer,
  workspace: string,
  pinnedTaskId?: string,
  pinnedSessionId?: string,
  clientType: "chatgpt" | "mcp" = "mcp",
  onTaskRetarget?: (taskId: string, workspace: string) => void,
): void {
  let activeTaskId = pinnedTaskId;
  let taskPromise: Promise<string> | undefined = activeTaskId ? Promise.resolve(activeTaskId) : undefined;
  const requestScope = new AsyncLocalStorage<{ taskId: string; sessionId?: string }>();
  let conversationTransport = false;
  const session = () => executionContext.getStore()?.sessionId ?? requestScope.getStore()?.sessionId ?? pinnedSessionId;
  const task = async (requireConfirmed = true) => {
    const current = executionContext.getStore() ?? requestScope.getStore();
    const taskId = current?.taskId ?? (activeTaskId ??= await (taskPromise ??= resolveDefaultTask(workspace)));
    const sessionId = session();
    if (sessionId) await assertSessionTaskBinding(sessionId, taskId, requireConfirmed);
    return taskId;
  };
  const retarget = (taskId: string, executionPath: string) => {
    const scope = requestScope.getStore();
    if (scope) scope.taskId = taskId;
    if (scope?.sessionId?.startsWith("conversation:")) updateConversationActivity(scope.sessionId, taskId, executionPath);
    // A conversation on a shared transport must not mutate other callers.
    if (!scope || scope.sessionId === pinnedSessionId) {
      activeTaskId = taskId;
      taskPromise = Promise.resolve(taskId);
      onTaskRetarget?.(taskId, executionPath);
    }
  };
  const register = server.registerTool.bind(server) as (...args: any[]) => any;
  const original = (name: string, config: any, handler: any) => register(name, config, async (args: any, extra: any) => {
    const hostSession = extra?._meta?.["openai/session"];
    if (hostSession === undefined && conversationTransport) {
      throw new Error("CONVERSATION_ID_REQUIRED: this transport uses conversation routing; include host conversation metadata instead of falling back to the Dashboard task");
    }
    let sessionId = pinnedSessionId;
    let taskId = activeTaskId ??= await (taskPromise ??= resolveDefaultTask(workspace));
    if (hostSession !== undefined) {
      if (typeof hostSession !== "string" || !hostSession.trim() || hostSession.length > 1024) {
        throw new Error("CONVERSATION_ID_INVALID: invalid host conversation metadata");
      }
      // Metadata correlates requests; authorization still comes from the
      // authenticated connection and the destination task's existing policy.
      sessionId = "conversation:" + createHash("sha256").update(JSON.stringify([
        mcpPrincipalContext.getStore() ?? "local", hostSession,
      ])).digest("hex");
      conversationTransport = true;
      const binding = await resolveConversationTask(sessionId, taskId);
      taskId = binding.taskId;
      return withConversationActivity(sessionId, taskId, binding.workspace, pinnedSessionId,
        () => requestScope.run({ taskId, sessionId }, () => handler(args, extra)),
        () => closeSessionReviewRun(sessionId!));
    }
    return requestScope.run({ taskId, sessionId }, () => handler(args, extra));
  });
  server.registerTool = ((name: string, config: any, handler: any) => original(name, config, async (args: any, extra: any) => {
    const immutable = structuredClone(args);
    const scope = { ...requestScope.getStore()! };
    return dispatch(await task(), name, immutable,
      () => requestScope.run(scope, () => handler(structuredClone(immutable), extra)),
      false, session(), undefined, reviewIdentity(extra));
  })) as typeof server.registerTool;
  const bindingStatus = async (expectedTaskId?: string) => {
    const taskId = await task(false);
    const snapshot = await getWorkbench();
    const currentTask = snapshot.tasks.find(item => item.id === taskId);
    const currentWorkspace = currentTask ? snapshot.workspaces.find(item => item.id === currentTask.workspaceId) : undefined;
    if (!currentTask || !currentWorkspace) throw new Error("Current Workbench binding no longer exists");
    const binding = snapshot.agentBindings.find(item => item.sessionId === session());
    const confirmed = Boolean(session() && binding && binding.taskConfirmed !== false);
    const matches = expectedTaskId === taskId && confirmed;
    await audit({ tool: "workbench", action: "binding_status", status: expectedTaskId && !matches ? "blocked" : "ok",
      details: { current_task_id: taskId, expected_task_id: expectedTaskId, task_confirmed: confirmed,
        matched: expectedTaskId ? matches : undefined } });
    return { ...(expectedTaskId && !matches ? { isError: true } : {}), content: [{ type: "text" as const, text: JSON.stringify({
      authoritative: true, server_received_at: new Date().toISOString(),
      workspace: { id: currentWorkspace.id, name: currentWorkspace.name, path: currentWorkspace.path, experience: currentWorkspace.experience },
      task: { id: currentTask.id, title: currentTask.title, lifecycle: currentTask.lifecycle, kind: currentTask.kind, execution_path: taskExecutionPath(currentTask), branch: currentTask.execution.branch || null },
      session: { id: session() || null, client_type: clientType, task_confirmed: confirmed },
      policy: currentTask.policy, remote_policy_control: snapshot.capabilities.remotePolicyControl,
      ...(expectedTaskId ? { verification: { expected_task_id: expectedTaskId, matches,
        code: taskId !== expectedTaskId ? "TASK_MISMATCH" : !confirmed ? "TASK_UNCONFIRMED" : "TASK_VERIFIED",
        next_step: matches ? "Read task_handoff/project_context and continue under the existing policy; no target call needed."
          : "Stop project work. Explicit task assignment is required in an authorized interactive run; do not use the dashboard fallback." } } : {}),
    }) }] };
  };
  original("workbench", {
    title: "Task workbench",
    description: "Read the pinned task. Use view=status, expected_task_id=<ID> for read-only verification, including scheduled continuation. If verification.matches=true, no target call is needed; load handoff/context and continue under current policy. Mismatch/unconfirmed is an error: do not work on a fallback. Only an authorized explicit assignment may use workbench_control(action=target,create_missing=false). Client safety denial must be reported, never retried through other tools. summary/history/children and operation_id inspect current task progress.",
    inputSchema: {
      operation_id: z.string().optional(),
      view: z.enum(["summary", "history", "children", "status"]).default("summary"),
      expected_task_id: z.string().uuid().optional().describe("With view=status only: verify the current confirmed binding without switching task or changing policy."),
      limit: z.number().int().min(1).max(30).default(10),
      cursor: z.string().optional(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ operation_id, view, expected_task_id, limit, cursor }: { operation_id?: string; view: "summary" | "history" | "children" | "status"; expected_task_id?: string; limit: number; cursor?: string }) => {
    if (expected_task_id && view !== "status") throw new Error("expected_task_id requires view=status; it never selects a task");
    if (view === "status") {
      if (operation_id || cursor) throw new Error("view=status cannot read operation results or history cursors");
      return bindingStatus(expected_task_id);
    }
    const taskId = await task(false);
    if (operation_id) {
      const op = await operationDetail(operation_id);
      if (op.taskId !== taskId) throw new Error("Operation belongs to another task");
      const current = (await getWorkbench()).tasks.find(t => t.id === taskId)!;
      if (current.policy.workspaceOnly && (op.media || !["file-tools", "task-metadata"].includes(op.tracking))) throw new Error("Operation output unavailable under current workspace-only policy");
      await executionContext.run({ taskId, sessionId: session(), workspace: taskExecutionPath(current), workspaceOnly: current.policy.workspaceOnly, operationId: op.id, capture: async () => {} }, async () => {
        for (const change of op.changes) await validatePath(change.path);
      });
      const media = op.media ? operationMediaCache.read(taskId, op.id) : [];
      return { content: [{ type: "text", text: JSON.stringify({ id: op.id, status: op.status, error: op.error, result: op.result,
        ...(op.media ? { media: { ...op.media, available: media.length > 0,
          observation_is_historical: true,
          message: media.length ? "Recorded observation from execution time. Observe again before acting on UI."
            : "Observation expired, was evicted, or the server restarted. Capture a new observation; do not resubmit the original action." } } : {}),
      }) }, ...media] };
    }
    const data = await getWorkbench();
    const current = data.tasks.find(t => t.id === taskId)!;
    const experience = data.experiences[current.workspaceId];
    const taskOperations = data.operations.filter(o => o.taskId === taskId);
    if (view === "children") {
      if (cursor) throw new Error("cursor is only valid with view=history");
      const children = data.tasks
        .filter(child => child.parentTaskId === taskId && child.delegationScope?.canReadStatus)
        .slice(0, limit)
        .map(child => {
          const operations = data.operations.filter(operation => operation.taskId === child.id);
          const statusCounts = Object.fromEntries(["pending", "running", "failed"].map(status => [status,
            operations.filter(operation => operation.status === status).length]));
          return {
            id: child.id,
            title: child.title,
            lifecycle: child.lifecycle,
            kind: child.kind,
            branch: child.execution.branch || null,
            operation_counts: statusCounts,
            handoff: child.delegationScope?.canReadHandoff ? handoffSummary(child.handoff) : { available: false, restricted: true },
            delegation_scope: child.delegationScope,
          };
        });
      return { content: [{ type: "text", text: JSON.stringify({ view: "children", task_id: taskId, children, truncated: data.tasks.filter(child => child.parentTaskId === taskId && child.delegationScope?.canReadStatus).length > children.length,
        boundary: "Child status and handoff are bounded delegation views. Raw child operation results and arguments are not exposed." }) }] };
    }
    if (view === "history") {
      let start = 0;
      if (cursor) {
        const decoded = decodeHistoryCursor(cursor);
        if (decoded.taskId !== taskId) throw new Error("History cursor belongs to another task");
        const index = taskOperations.findIndex(op => op.id === decoded.operationId);
        if (index < 0) throw new Error("History cursor is no longer available for this task");
        start = index + 1;
      }
      const operations = [];
      let bytes = 2;
      for (const op of taskOperations.slice(start, start + limit)) {
        const item = historySummary(op);
        const size = Buffer.byteLength(JSON.stringify(item), "utf8") + 1;
        if (operations.length && bytes + size > HISTORY_MAX_BYTES) break;
        operations.push(item);
        bytes += size;
      }
      const nextIndex = start + operations.length;
      const hasMore = nextIndex < taskOperations.length;
      const nextCursor = hasMore && operations.length ? encodeHistoryCursor(taskId, operations.at(-1)!.id) : undefined;
      return { content: [{ type: "text", text: JSON.stringify({
        view: "history", task_id: taskId, total: taskOperations.length, limit, operations,
        truncated: hasMore, cursor: nextCursor,
        details_omitted: true, detail_message: "History omits arguments, file bodies and diffs. Use operation_id for one execution result; inspect the local dashboard for the full approval review.",
        cursor_behavior: "A cursor continues after its last operation. Operations added later are newer and do not shift or repeat older pages.",
      }) }] };
    }
    if (cursor) throw new Error("cursor is only valid with view=history");
    const statusCounts = Object.fromEntries(["pending", "running", "failed"].map(status => [status,
      taskOperations.filter(operation => operation.status === status).length]));
    const attentionAll = taskOperations.filter(operation => ["pending", "running", "failed"].includes(operation.status));
    const attention = attentionAll.slice(0, SUMMARY_ATTENTION_LIMIT).map(operation => ({
      id: operation.id, tool: operation.tool, status: operation.status, createdAt: operation.createdAt, error: operation.error?.slice(0, 400),
    }));
    const { handoff, ...taskSummary } = current;
    const siblingTasks = data.tasks.filter(item => item.workspaceId === current.workspaceId
      && ["open", "blocked"].includes(item.lifecycle));
    const availableTasks = siblingTasks.slice(0, 30).map(item => ({
      id: item.id, title: item.title, lifecycle: item.lifecycle, kind: item.kind,
      in_use_by_other_chat: data.agentBindings.some(binding => binding.taskId === item.id
        && binding.sessionId !== session() && !binding.closedAt && binding.taskConfirmed !== false),
    }));
    const inbox = session() ? await taskDispatchInbox(taskId, session()!, undefined, 1) : null;
    return { content: [{ type: "text", text: JSON.stringify({ view: "summary", task: taskSummary, capabilities: data.capabilities,
      experience: experience.mode, session_id: session(), handoff: handoffSummary(handoff),
      available_tasks: availableTasks, available_tasks_truncated: siblingTasks.length > availableTasks.length,
      task_dispatch: { visible_messages: inbox?.total || 0, message: "Use task_dispatch(action=list) to inspect requests/results. Other ChatGPT chats are not automatically resumed." },
      task_switch: experience.mode === "advanced"
        ? "For explicit assignment of THIS conversation to a task, call workbench_control(action=target,task_id=<exact ID>,create_missing=false), then verify status and refresh project_context before work. For explicit instructions TO ANOTHER CHAT only, task_dispatch(action=send) queues without switching."
        : "Basic mode has one task; use Advanced for independent parallel task bindings.",
      write_control: experience.mode === "basic" ? {
        owns_control: experience.writer?.sessionId === session(),
        available: !experience.writer || experience.writer.sessionId === session(),
        session_label: experience.sessions.find(item => item.sessionId === session())?.label,
        message: "Basic uses one project task across conversations. Only one session may change files, run commands or mutate Git. If another session owns control, ask the user to transfer it in the local Workbench; do not retry through a different tool.",
      } : undefined,
      operation_counts: statusCounts,
      operations: attention,
      operations_total: attentionAll.length,
      operations_truncated: attentionAll.length > attention.length,
      history: { total: taskOperations.length, message: "Use workbench(view=history, limit=10) for paginated operation history." },
    }) }] };
  });
  original("workbench_control", {
    title: "Workbench control plane",
    description: "Control Workbench on explicit request. Use read-only workbench(view=status) for status checks; this combined control tool can mutate state. To SWITCH THIS CHAT to an EXISTING task (an explicit assignment of this conversation to a task, including one used by another chat) within the SAME Advanced workspace, use action=target, task_id=<exact ID>, create_missing=false. Verify with read-only workbench(view=status,expected_task_id=<exact ID>) and refresh project_context before coding; this does not select the dashboard task, move other chats, or require Full. If user explicitly wants to SEND instructions to ANOTHER CHAT while keeping its own binding, use task_dispatch instead. Cross-workspace targeting and task/workspace creation require Full machine scope; set_policy needs owner-enabled remote policy control and current revision.",
    inputSchema: {
      action: z.enum(["status", "set_policy", "create_workspace", "create_task", "target"]),
      mode: z.enum(["ask", "auto", "full"]).optional(),
      workspace_only: z.boolean().optional(),
      expected_revision: z.number().int().positive().optional(),
      workspace_id: z.string().optional(),
      workspace_name: z.string().min(1).max(200).optional(),
      workspace_path: z.string().min(1).optional(),
      task_id: z.string().optional(),
      task_title: z.string().min(1).max(200).optional(),
      task_description: z.string().max(4000).optional(),
      environment_mode: z.enum(["local", "parallel"]).optional(),
      starting_ref: z.string().max(200).optional(),
      bind_current: z.boolean().optional(),
      create_missing: z.boolean().optional(),
      assign_next_chatgpt: z.boolean().optional(),
      delegate_as_child: z.boolean().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, async (args: {
    action: "status" | "set_policy" | "create_workspace" | "create_task" | "target";
    mode?: "ask" | "auto" | "full"; workspace_only?: boolean; expected_revision?: number;
    workspace_id?: string; workspace_name?: string; workspace_path?: string;
    task_id?: string; task_title?: string; task_description?: string;
    environment_mode?: "local" | "parallel"; starting_ref?: string;
    bind_current?: boolean; create_missing?: boolean; assign_next_chatgpt?: boolean; delegate_as_child?: boolean;
  }) => {
    const workspaceSelector = {
      workspaceId: args.workspace_id,
      workspaceName: args.workspace_name,
      workspacePath: args.workspace_path,
    };

    if (args.action === "status") return bindingStatus();

    const currentSessionId = session();
    if (!currentSessionId) throw new Error("AGENT_TARGET_SESSION_REQUIRED: current MCP session is unavailable");
    const authority = { taskId: await task(false), sessionId: currentSessionId };
    if (args.action === "set_policy") {
      if (!args.mode || args.workspace_only === undefined || args.expected_revision === undefined) {
        throw new Error("mode, workspace_only and expected_revision are required for set_policy");
      }
      if (args.workspace_id || args.workspace_name || args.workspace_path || args.task_id || args.task_title) {
        throw new Error("set_policy only changes the currently bound task; omit workspace/task selectors");
      }
      const result = await setSessionTaskPolicy(authority, args.mode, args.workspace_only, args.expected_revision);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }

    if (args.action === "create_workspace") {
      if (!args.workspace_path) throw new Error("workspace_path is required for create_workspace");
      const inferredName = path.basename(path.resolve(args.workspace_path)) || "Workspace";
      const result = await ensureWorkspaceForControl(args.workspace_name || inferredName, args.workspace_path, true, authority);
      return { content: [{ type: "text", text: JSON.stringify({
        authoritative: false,
        created: result.created,
        workspace: { id: result.workspace.id, name: result.workspace.name, path: result.workspace.path, experience: result.workspace.experience },
        current_chat_unchanged: true,
        message: "Workspace is registered and selected in Workbench. Use action=target to bind this chat to it.",
      }) }] };
    }

    if (args.action === "create_task") {
      if (!args.task_title?.trim()) throw new Error("task_title is required for create_task");
      if (args.bind_current && args.assign_next_chatgpt) throw new Error("create_task cannot bind the current chat and reserve the same task for the next ChatGPT session");
      const bindSessionId = args.bind_current ? session() : undefined;
      if (args.bind_current) {
        if (!bindSessionId) throw new Error("AGENT_TARGET_SESSION_REQUIRED: current MCP session is unavailable");
        const snapshot = await getWorkbench();
        const activeOperations = snapshot.operations.filter(operation => operation.sessionId === bindSessionId && ["pending", "running"].includes(operation.status));
        if (activeOperations.length) {
          throw new Error(`AGENT_TARGET_BUSY: resolve ${activeOperations.length} pending or running operation${activeOperations.length === 1 ? "" : "s"} from this chat before changing task`);
        }
      }
      const hasSelector = args.workspace_id || args.workspace_name || args.workspace_path;
      const currentWorkspaceId = (await getWorkbench()).tasks.find(item => item.id === authority.taskId)!.workspaceId;
      const targetWorkspace = await resolveWorkspaceForControl(hasSelector ? workspaceSelector : { workspaceId: currentWorkspaceId });
      const environmentMode = args.environment_mode || (args.delegate_as_child || args.assign_next_chatgpt ? "parallel" : "local");
      const created = await createTask(
        args.task_title,
        undefined,
        targetWorkspace.id,
        { mode: environmentMode === "parallel" ? "worktree" : "local", startingRef: args.starting_ref },
        { description: args.task_description, select: !args.delegate_as_child, controlAuthority: { ...authority, requireIdle: args.bind_current },
          assignNextChatgpt: args.assign_next_chatgpt,
          parentTaskId: args.delegate_as_child ? authority.taskId : undefined,
          createdBySessionId: session() },
      );
      if (args.bind_current) {
        const receipt = await targetAgentSession(bindSessionId!, clientType, {
          workspaceId: targetWorkspace.id,
          taskId: created.id,
          createMissing: false,
        }, authority);
        retarget(receipt.task.id, receipt.task.executionPath);
        return { content: [{ type: "text", text: JSON.stringify({
          ...receipt,
          created: { ...receipt.created, task: true },
          task: { ...receipt.task, execution_path: receipt.task.executionPath },
          next_step: "Use project_context without a path before project-specific work so context follows the new target.",
        }) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify({
        authoritative: false,
        created: true,
        workspace: { id: targetWorkspace.id, name: targetWorkspace.name, path: targetWorkspace.path },
        task: { id: created.id, title: created.title, execution_path: taskExecutionPath(created), branch: created.execution.branch || null, parent_task_id: created.parentTaskId || null },
        assignment: args.assign_next_chatgpt ? { client_type: "chatgpt", status: "queued" } : null,
        current_chat_unchanged: true,
        dashboard_selection_unchanged: Boolean(args.delegate_as_child),
        message: args.delegate_as_child
          ? "Child task created without changing the dashboard selection. The queued ChatGPT lease is claimed independently by orchestration."
          : "Task is created and selected in Workbench. Use action=target or bind_current=true to bind this chat.",
      }) }] };
    }

    if (!session()) throw new Error("AGENT_TARGET_SESSION_REQUIRED: current MCP session is unavailable");
    // A named/id task within the chat's current workspace is a scoped binding
    // change, not a machine control operation. Never silently create a task.
    const currentWorkspaceId = (await getWorkbench()).tasks.find(item => item.id === authority.taskId)!.workspaceId;
    const hasWorkspaceSelector = args.workspace_id || args.workspace_name || args.workspace_path;
    let selectedWorkspace;
    if (hasWorkspaceSelector && args.create_missing !== true) {
      try { selectedWorkspace = await resolveWorkspaceForControl(workspaceSelector); }
      catch (error) {
        // Preserve the Full-authorized create-on-target path. A missing
        // explicit workspace is never interpreted as the current workspace.
        if (args.create_missing === false || !String(error).includes("WORKSPACE_TARGET_NOT_FOUND")) throw error;
      }
    }
    const sameWorkspaceSwitch = (!hasWorkspaceSelector || selectedWorkspace?.id === currentWorkspaceId)
      && Boolean(args.task_id || args.task_title) && args.create_missing !== true;
    const receipt = sameWorkspaceSwitch
      ? await switchSessionTask(currentSessionId, clientType,
          { taskId: args.task_id, taskTitle: args.task_title }, authority)
      : await targetAgentSession(currentSessionId, clientType, {
      ...workspaceSelector,
      taskId: args.task_id,
      taskTitle: args.task_title,
      createMissing: args.create_missing,
    }, authority);
    retarget(receipt.task.id, receipt.task.executionPath);
    return { content: [{ type: "text", text: JSON.stringify({
      ...receipt,
      task: { ...receipt.task, execution_path: receipt.task.executionPath },
      next_step: "Use project_context without a path before project-specific work so context follows the new target.",
    }) }] };
  });
  server.registerTool("task_dispatch", {
    title: "Same-workspace task dispatch and inbox",
    description: "Use only when the user explicitly asks to send a message to ANOTHER chat. For @Coder task X: Y, use workbench_control(action=target) and do the work in THIS conversation. The destination ChatGPT must LIST/CLAIM the queued instruction on its own turn, execute with its bound tools, then COMPLETE/FAIL. This tool does not wake other ChatGPT chats or execute tasks itself. Do not say a queued request was executed. Mutations obey the current task's approval policy.",
    inputSchema: {
      action: z.enum(["send", "list", "status", "claim", "complete", "fail", "cancel"]).default("list"),
      target_task_id: z.string().optional(),
      target_task_title: z.string().max(200).optional(),
      instruction: z.string().max(4000).optional(),
      message_id: z.string().optional(),
      result: z.string().max(6000).optional(),
      limit: z.number().int().min(1).max(30).default(20),
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  }, async ({ action, target_task_id, target_task_title, instruction, message_id, result, limit }: {
    action: "send" | "list" | "status" | "claim" | "complete" | "fail" | "cancel";
    target_task_id?: string; target_task_title?: string; instruction?: string; message_id?: string; result?: string; limit: number;
  }) => {
    const taskId = await task();
    if (!session()) throw new Error("TASK_DISPATCH_SESSION_REQUIRED: no bound chat session");
    if (action === "status" && !message_id) throw new Error("TASK_DISPATCH_ID_REQUIRED: status requires message_id");
    const receipt = action === "list" || action === "status"
      ? await taskDispatchInbox(taskId, session()!, action === "status" ? message_id : undefined, limit)
      : await mutateTaskDispatch({ taskId, sessionId: session()!, action,
          targetTaskId: target_task_id, targetTaskTitle: target_task_title, instruction, messageId: message_id, result });
    return { content: [{ type: "text", text: JSON.stringify(receipt) }] };
  });
  server.registerTool("task_handoff", {
    title: "Task handoff",
    description: "Read or update the current task handoff for another ChatGPT conversation. Update it before transferring work; keep the summary concise and next steps concrete.",
    inputSchema: {
      action: z.enum(["read", "update"]).default("read"),
      summary: z.string().max(6000).optional(),
      next_steps: z.array(z.string().max(1000)).max(20).optional(),
      notes: z.string().max(6000).optional(),
    },
    annotations: { readOnlyHint: false, openWorldHint: false },
  }, async ({ action, summary, next_steps, notes }: { action: "read" | "update"; summary?: string; next_steps?: string[]; notes?: string }) => {
    const taskId = await task();
    if (action === "update") {
      if (!summary?.trim()) throw new Error("summary is required when updating a handoff");
      const updated = await setTaskHandoff(taskId, { summary, nextSteps: next_steps, notes, fromSessionId: session() });
      return { content: [{ type: "text", text: JSON.stringify({ task_id: updated.id, task_title: updated.title, description: updated.description, handoff: updated.handoff }) }] };
    }
    const current = (await getWorkbench()).tasks.find(item => item.id === taskId)!;
    return { content: [{ type: "text", text: JSON.stringify({ task_id: current.id, task_title: current.title, description: current.description, handoff: current.handoff || null }) }] };
  });
  original("task_complete", {
    title: "Complete current task",
    description: "Mark the current Workbench task completed when the user explicitly says this task is done, completed, finished, or equivalent. Call this before your final reply to that explicit completion message. This changes task state only; it never merges code automatically. Managed parallel/worktree tasks must already be merged before they can be completed.",
    inputSchema: {},
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => {
    const taskId = await task();
    const result = await completeTask(taskId);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  });
}
