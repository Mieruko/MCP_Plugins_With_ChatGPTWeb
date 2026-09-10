import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { executionContext } from "./workbench-context.js";
import { validatePath } from "./path-security.js";
import { isMultiFilePatch, parseMultiFilePatch } from "./patch.js";
import { gitApprovalFingerprint } from "./git-approval.js";

export type PermissionMode = "ask" | "auto" | "full";
export type Args = Record<string, any>;
export interface Policy { mode: PermissionMode; workspaceOnly: boolean; revision: number }
export interface Task { id: string; title: string; workspace: string; createdAt: string; policy: Policy }
interface Snapshot { kind: "missing" | "file" | "directory"; content?: string; mode?: number }
export interface Change { path: string; before: Snapshot; after: Snapshot; undone?: boolean }
export interface Operation {
  id: string; taskId: string; tool: string; args: Args; createdAt: string; expiresAt: number;
  policyRevision: number; status: "pending" | "running" | "completed" | "failed" | "denied" | "expired" | "interrupted";
  changes: Change[]; error?: string; result?: unknown;
  tracking: "file-tools" | "external-effects-not-tracked";
}
interface State { version: 1; tasks: Task[]; operations: Operation[]; selectedTaskId?: string; sessionTasks?: Record<string, string> }
const events = new EventEmitter();
export function notifyWorkbench() { events.emit("change"); }
const callbacks = new Map<string, () => Promise<unknown>>();
let state: State;
let initialization: Promise<void> | undefined;
let queue = Promise.resolve();
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 2000;

export function workbenchRoot(): string {
  return path.resolve(process.env.WORKBENCH_PATH || path.join(os.homedir(), ".chatgpt-local-coder", "workbench"));
}
async function save(): Promise<void> {
  const target = path.join(workbenchRoot(), "state.json");
  const temp = `${target}.${randomUUID()}.tmp`;
  await fs.mkdir(workbenchRoot(), { recursive: true });
  await fs.writeFile(temp, JSON.stringify(state), { mode: 0o600 });
  await fs.rename(temp, target);
  events.emit("change");
}
async function init(): Promise<void> {
  if (!initialization) initialization = (async () => {
    try {
      state = JSON.parse(await fs.readFile(path.join(workbenchRoot(), "state.json"), "utf8"));
      if (state.version !== 1 || !Array.isArray(state.tasks) || !Array.isArray(state.operations)) throw new Error("Invalid workbench state");
      for (const op of state.operations) if (["pending", "running"].includes(op.status)) {
        op.status = "interrupted";
        op.error = "Server restarted. Operation was not replayed; inspect files before retrying.";
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      state = { version: 1, tasks: [], operations: [] };
    }
    await save();
  })();
  await initialization;
}
export async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const prior = queue;
  let release!: () => void;
  queue = new Promise<void>(resolve => { release = resolve; });
  await prior;
  try { await init(); return await fn(); } finally { release(); }
}
export function subscribeWorkbench(listener: () => void): () => void {
  events.on("change", listener);
  return () => { events.off("change", listener); };
}
function taskById(id: string): Task {
  const task = state.tasks.find(t => t.id === id);
  if (!task) throw new Error("Unknown task");
  return task;
}
function publicOperation(op: Operation) {
  const { result, args, ...summary } = op;
  return { ...summary, args: op.status === "pending" ? args : undefined, changes: op.changes.map(c => ({ path: c.path, before: c.before.kind, after: c.after.kind, undone: !!c.undone })) };
}
export async function getWorkbench() {
  await init();
  return { tasks: structuredClone(state.tasks), operations: state.operations.map(publicOperation).reverse(),
    capabilities: { osSandbox: false, fileUndo: true, shellUndo: false, approvalReviewer: "rules", chatgptWidget: false } };
}
export async function createTask(title: string, workspace: string): Promise<Task> {
  return exclusive(async () => {
    const root = await fs.realpath(path.resolve(workspace));
    if (!(await fs.stat(root)).isDirectory()) throw new Error("Workspace must be a directory");
    const mode: PermissionMode = process.env.WORKBENCH_DEFAULT_MODE === "full" ? "full" : process.env.WORKBENCH_DEFAULT_MODE === "auto" ? "auto" : "ask";
    const task: Task = { id: randomUUID(), title: title.slice(0, 200), workspace: root, createdAt: new Date().toISOString(),
      policy: { mode, workspaceOnly: mode !== "full", revision: 1 } };
    state.tasks.push(task);
    await save();
    return structuredClone(task);
  });
}

export async function selectTask(id: string): Promise<void> {
  await exclusive(async () => {
    const task = taskById(id);
    state.selectedTaskId = id;
    // Keep the selected default first in the local task picker.
    state.tasks = [task, ...state.tasks.filter(t => t.id !== id)];
    await save();
  });
}

export async function resolveDefaultTask(workspace: string): Promise<string> {
  return exclusive(async () => {
    if (state.selectedTaskId) return taskById(state.selectedTaskId).id;
    const root = await fs.realpath(path.resolve(workspace));
    const existing = state.tasks.find(t => t.workspace === root);
    if (existing) return existing.id;
    const mode: PermissionMode = process.env.WORKBENCH_DEFAULT_MODE === "full" ? "full" : process.env.WORKBENCH_DEFAULT_MODE === "auto" ? "auto" : "ask";
    const task: Task = { id: randomUUID(), title: "Default project", workspace: root, createdAt: new Date().toISOString(),
      policy: { mode, workspaceOnly: mode !== "full", revision: 1 } };
    state.tasks.push(task); await save(); return task.id;
  });
}
export async function resolveSessionTask(sessionId: string, workspace: string): Promise<string> {
  await init();
  const existing = Object.hasOwn(state.sessionTasks || {}, sessionId) ? state.sessionTasks![sessionId] : undefined;
  if (existing) return taskById(existing).id;
  const defaultTask = await resolveDefaultTask(workspace);
  return exclusive(async () => {
    state.sessionTasks ??= {};
    if (!Object.hasOwn(state.sessionTasks, sessionId)) {
      Object.defineProperty(state.sessionTasks, sessionId, { value: defaultTask, enumerable: true, writable: true, configurable: true });
      await save();
    }
    return taskById(state.sessionTasks[sessionId]).id;
  });
}

export async function setTaskPolicy(id: string, mode: PermissionMode, workspaceOnly: boolean): Promise<void> {
  await exclusive(async () => {
    const task = taskById(id);
    task.policy = { mode, workspaceOnly, revision: task.policy.revision + 1 };
    for (const op of state.operations.filter(o => o.taskId === id && o.status === "pending")) {
      op.status = "expired"; callbacks.delete(op.id);
    }
    await save();
  });
}

// Classification is conservative and independent of model-supplied annotations.
const READ_TOOLS = new Set(["inspect_code", "read_text_file", "read_multiple_files", "list_directory", "glob", "grep", "search_files", "directory_tree", "get_file_info", "list_allowed_directories", "agent_status", "project_context", "load_path_rules", "shell_status", "process_status", "process_output", "mcp_servers", "mcp_tools"]);
const EDIT_TOOLS = new Set(["write_file", "edit_file", "multi_edit", "apply_patch", "replace_regex", "create_directory", "copy_file", "move_file", "remember"]);
export function isReadOperation(tool: string, args: Args): boolean {
  return READ_TOOLS.has(tool) || ["git_status", "git_diff", "git_log"].includes(tool)
    || tool === "github" && ["pr_list", "pr_view", "pr_checks", "issue_list", "issue_view"].includes(args.action)
    || (["git_branch", "git_stash"].includes(tool) && (args.action || "list") === "list")
    || (tool === "rewind" && ["list", "preview", "status"].includes(args.action));
}
export function isProcessOperation(tool: string): boolean {
  return tool.startsWith("git_") || tool === "github" || ["run_command", "start_process", "mcp_call", "shell_reset"].includes(tool)
    || tool.startsWith("upstream_");
}
async function snapshot(target: string): Promise<Snapshot> {
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) throw new Error(`Review does not follow symlinks: ${target}`);
    if (stat.isDirectory()) return { kind: "directory", mode: stat.mode };
    if (!stat.isFile() || stat.size > MAX_BYTES || stat.nlink > 1) throw new Error(`Cannot safely snapshot file: ${target}`);
    return { kind: "file", mode: stat.mode, content: (await fs.readFile(target)).toString("base64") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw error;
  }
}
function fingerprint(s: Snapshot): string {
  return createHash("sha256").update(JSON.stringify(s)).digest("hex");
}
async function captureTree(target: string, found: Map<string, Snapshot>): Promise<void> {
  await validatePath(target);
  if (found.has(target)) return;
  const value = await snapshot(target);
  found.set(target, value);
  if (found.size > MAX_FILES) throw new Error("Snapshot exceeds 2000 paths; split the operation");
  if ([...found.values()].reduce((n, s) => n + (s.content?.length || 0), 0) > MAX_BYTES * 4 / 3) throw new Error("Snapshot exceeds 32 MiB; split the operation");
  if (value.kind === "directory") for (const name of await fs.readdir(target)) await captureTree(path.join(target, name), found);
}
export async function dispatch(taskId: string, tool: string, args: Args, invoke: () => Promise<unknown>, human = false): Promise<any> {
  await init();
  // Waiting for process output must not lock writes or other tasks behind it.
  if (isReadOperation(tool, args)) {
    const task = structuredClone(taskById(taskId));
    if (task.policy.workspaceOnly && (isProcessOperation(tool) || tool === "rewind")) throw new Error("SANDBOX_UNAVAILABLE: process execution is disabled in workspace-only mode");
    return executionContext.run({ taskId, workspace: task.workspace, workspaceOnly: task.policy.workspaceOnly, operationId: randomUUID(), capture: async () => {} }, invoke);
  }
  return exclusive(async () => {
    const task = taskById(taskId);
    if (task.policy.workspaceOnly && (isProcessOperation(tool) || !READ_TOOLS.has(tool) && !EDIT_TOOLS.has(tool) && !["delete_file", "delete_directory", "stop_process", "clear_processes"].includes(tool))) {
      throw new Error("SANDBOX_UNAVAILABLE: this operation can execute code or bypass the file boundary. Workspace-only mode blocks it until an OS sandbox is implemented.");
    }
    if (tool === "rewind" && ["restore", "clear"].includes(args.action)) throw new Error("Use task Review / Undo; legacy rewind cannot detect conflicts.");
    const op: Operation = { id: randomUUID(), taskId, tool, args: structuredClone(args), createdAt: new Date().toISOString(),
      expiresAt: Date.now() + 15 * 60_000, policyRevision: task.policy.revision, status: "pending", changes: [],
      tracking: isProcessOperation(tool) ? "external-effects-not-tracked" : "file-tools" };
    const boundary = { taskId, workspace: task.workspace, workspaceOnly: task.policy.workspaceOnly, operationId: op.id, capture: async (_paths: string[]) => {} };
    const expected = new Map<string, Snapshot>();
    const gitCwd = tool.startsWith("git_") ? await executionContext.run(boundary, () => validatePath(args.path || task.workspace)) : undefined;
    const gitBefore = gitCwd && !human && task.policy.mode !== "full" ? await gitApprovalFingerprint(gitCwd, args.branch) : undefined;
    if (!isReadOperation(tool, args) && !isProcessOperation(tool)) {
      await executionContext.run(boundary, async () => {
        const targets = [args.path, args.source, args.destination].filter((p): p is string => typeof p === "string").map(p => path.resolve(task.workspace, p));
        if (tool === "remember") targets.push(path.join(task.workspace, ".local-coder", "MEMORY.md"));
        if (tool === "apply_patch" && isMultiFilePatch(args.patch || "")) {
          let base = args.path ? await validatePath(args.path) : task.workspace;
          if (!(await fs.stat(base)).isDirectory()) base = path.dirname(base);
          targets.splice(0, targets.length, ...parseMultiFilePatch(args.patch, base).map(o => o.path));
        }
        for (const p of targets) await captureTree(await validatePath(p), expected);
      });
    }
    const execute = async () => {
      const before = new Map<string, Snapshot>();
      const context = { taskId, workspace: task.workspace, workspaceOnly: task.policy.workspaceOnly, operationId: op.id,
        capture: async (paths: string[]) => {
          for (const p of paths) await captureTree(await validatePath(p), before);
          op.changes = [...before].map(([p, s]) => ({ path: p, before: s, after: s }));
          await save(); // Write-ahead journal; never start a file edit without its baseline on disk.
        } };
      op.status = "running";
      await save();
      let result: any;
      try {
        if (gitBefore && await gitApprovalFingerprint(gitCwd!, args.branch) !== gitBefore) throw new Error("APPROVAL_CONFLICT: Git HEAD, index, working tree or configuration changed while waiting for approval");
        await executionContext.run(context, async () => {
          for (const [p, s] of expected) {
            await validatePath(p);
            if (fingerprint(s) !== fingerprint(await snapshot(p))) throw new Error(`APPROVAL_CONFLICT: ${p} changed while waiting for approval`);
          }
        });
        result = await executionContext.run(context, invoke);
        op.status = result?.isError ? "failed" : "completed";
      } catch (error) {
        op.status = "failed"; op.error = String(error);
      } finally {
        try {
          const after = new Map<string, Snapshot>();
          for (const p of before.keys()) await captureTree(p, after);
          op.changes = [...new Set([...before.keys(), ...after.keys()])].map(p => ({ path: p,
            before: before.get(p) || { kind: "missing" } as Snapshot, after: after.get(p) || { kind: "missing" } as Snapshot }))
            .filter(c => fingerprint(c.before) !== fingerprint(c.after));
        } catch (error) { op.status = "failed"; op.error = `Tracking incomplete: ${error}`; }
        op.result = result;
        await save();
      }
      if (op.error) throw new Error(op.error);
      return result;
    };
    const read = isReadOperation(tool, args);
    if (read) return executionContext.run({ taskId, workspace: task.workspace, workspaceOnly: task.policy.workspaceOnly, operationId: op.id, capture: async () => {} }, invoke);
    state.operations.push(op);
    const auto = task.policy.mode === "full" || task.policy.mode === "auto" && EDIT_TOOLS.has(tool);
    if (!human && !auto) {
      callbacks.set(op.id, execute);
      await save();
      return { content: [{ type: "text", text: JSON.stringify({ status: "approval_required", operation_id: op.id, task_id: taskId,
        message: "Review and approve this exact operation in the local Workbench. Do not resubmit it. Use workbench operation to get the result." }) }] };
    }
    return execute();
  });
}
export async function decideOperation(id: string, approve: boolean): Promise<unknown> {
  return exclusive(async () => {
    const op = state.operations.find(o => o.id === id);
    if (!op || op.status !== "pending") throw new Error("Operation is no longer pending");
    const invoke = callbacks.get(id); callbacks.delete(id);
    if (!approve) { op.status = "denied"; await save(); return publicOperation(op); }
    if (!invoke || op.expiresAt < Date.now() || taskById(op.taskId).policy.revision !== op.policyRevision) {
      op.status = "expired"; await save(); throw new Error("Approval expired; request a new operation");
    }
    return invoke();
  });
}
export async function operationDetail(id: string) {
  await init();
    const op = state.operations.find(o => o.id === id);
    if (!op) throw new Error("Unknown operation");
    return structuredClone(op);
}
async function restore(target: string, value: Snapshot): Promise<void> {
  if (value.kind === "missing") {
    try { const s = await fs.lstat(target); if (s.isDirectory()) await fs.rmdir(target); else await fs.unlink(target); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  } else if (value.kind === "directory") await fs.mkdir(target, { recursive: true, mode: value.mode });
  else {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, Buffer.from(value.content || "", "base64"));
    if (value.mode !== undefined) await fs.chmod(target, value.mode);
  }
}
export async function undoOperation(id: string, redo: boolean, file?: string): Promise<void> {
  await exclusive(async () => {
    const op = state.operations.find(o => o.id === id);
    if (!op || !["completed", "failed"].includes(op.status)) throw new Error("Operation cannot be restored");
    const task = taskById(op.taskId);
    const changes = op.changes.filter(c => (!file || c.path === file) && !!c.undone === redo);
    if (!changes.length) throw new Error("No changes to restore");
    await executionContext.run({ taskId: task.id, workspace: task.workspace, workspaceOnly: task.policy.workspaceOnly, operationId: id, capture: async () => {} }, async () => {
      // Validate every file first. A conflict in any file prevents all writes.
      for (const c of changes) {
        await validatePath(c.path);
        if (fingerprint(await snapshot(c.path)) !== fingerprint(redo ? c.before : c.after)) throw new Error(`UNDO_CONFLICT: ${c.path} changed since the recorded operation`);
        const target = redo ? c.after : c.before;
        if (target.kind === "missing" && (await snapshot(c.path)).kind === "directory") {
          const nested = new Map<string, Snapshot>();
          await captureTree(c.path, nested);
          for (const p of nested.keys()) if (p !== c.path && !changes.some(change => change.path === p)) throw new Error(`UNDO_CONFLICT: untracked content in ${c.path}`);
        }
      }
      const ordered = [...changes].sort((a, b) => {
        const av = redo ? a.after : a.before, bv = redo ? b.after : b.before;
        if (av.kind === "missing" && bv.kind !== "missing") return 1;
        if (av.kind !== "missing" && bv.kind === "missing") return -1;
        return av.kind === "missing" ? b.path.length - a.path.length : a.path.length - b.path.length;
      });
      for (const c of ordered) {
        await restore(c.path, redo ? c.after : c.before);
        c.undone = !redo;
        await save(); // Preserve recovery state if a later path fails.
      }
    });
  });
}
