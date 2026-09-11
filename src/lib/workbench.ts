import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { childEnvironment, executionContext } from "./workbench-context.js";
import { validatePath } from "./path-security.js";
import { applyUnifiedPatchToText, buildSimpleDiff, isMultiFilePatch, parseMultiFilePatch } from "./patch.js";
import { gitApprovalFingerprint } from "./git-approval.js";
import { getSandboxStatus } from "./os-sandbox.js";

export type PermissionMode = "ask" | "auto" | "full";
export type Args = Record<string, any>;
export interface Policy { mode: PermissionMode; workspaceOnly: boolean; revision: number }
export interface TaskPreview { command: string; url: string; processId?: string; startedAt?: string }
export interface Workspace { id: string; name: string; path: string; createdAt: string; lastOpenedAt: string }
export interface TaskExecution {
  mode: "local" | "worktree";
  path: string;
  startingRef?: string;
  branch?: string;
  detached?: boolean;
  managed?: boolean;
}
export interface Task { id: string; workspaceId: string; title: string; workspace: string; execution: TaskExecution; createdAt: string; policy: Policy; preview?: TaskPreview }
export interface TaskCheckpoint { id: string; taskId: string; title: string; createdAt: string; operationIndex: number }
interface Snapshot { kind: "missing" | "file" | "directory"; content?: string; mode?: number }
export interface Change { path: string; before: Snapshot; after: Snapshot; undone?: boolean }
export interface OperationReviewFile {
  path: string;
  operation: "create" | "update" | "delete" | "copy" | "move" | "binary" | "directory";
  diff?: string;
  additions?: number;
  deletions?: number;
  note?: string;
}
export interface OperationReview {
  files: OperationReviewFile[];
  additions: number;
  deletions: number;
  truncated: boolean;
  warning?: string;
}
export interface Operation {
  id: string; taskId: string; sessionId?: string; changeSetId?: string; tool: string; args: Args; createdAt: string; expiresAt: number;
  policyRevision: number; status: "pending" | "running" | "completed" | "failed" | "denied" | "expired" | "interrupted";
  changes: Change[]; error?: string; result?: unknown;
  review?: OperationReview;
  tracking: "file-tools" | "external-effects-not-tracked";
}
interface State { version: 3; workspaces: Workspace[]; tasks: Task[]; operations: Operation[]; checkpoints?: TaskCheckpoint[]; selectedWorkspaceId?: string; selectedTaskId?: string; sessionTasks?: Record<string, string> }
const events = new EventEmitter();
export type WorkbenchChangeScope = "state" | "workspaces" | "tasks" | "operations" | "checkpoints" | "workspace";
export interface WorkbenchChange {
  scopes: WorkbenchChangeScope[];
  taskId?: string;
  operationId?: string;
  reason?: string;
}
const genericWorkbenchChange = (): WorkbenchChange => ({ scopes: ["state"] });
export function notifyWorkbench(change: WorkbenchChange = genericWorkbenchChange()) { events.emit("change", change); }
const callbacks = new Map<string, () => Promise<unknown>>();
let state: State;
let initialization: Promise<void> | undefined;
let globalQueue = Promise.resolve();
let saveQueue = Promise.resolve();
const workspaceQueues = new Map<string, Promise<void>>();
const activeChangeSets = new Map<string, { id: string; startedAt: number; lastAt: number }>();
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 2000;

export function workbenchRoot(): string {
  return path.resolve(process.env.WORKBENCH_PATH || path.join(os.homedir(), ".chatgpt-local-coder", "workbench"));
}
function workspacePathKey(value: string): string {
  const normalized = path.resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
function workspaceNameFromPath(value: string): string {
  return path.basename(path.resolve(value)) || path.resolve(value);
}
function workspaceById(id: string): Workspace {
  const workspace = state.workspaces.find(item => item.id === id);
  if (!workspace) throw new Error("Unknown workspace");
  return workspace;
}
async function canonicalWorkspacePath(value: string): Promise<string> {
  const root = await fs.realpath(path.resolve(value));
  if (!(await fs.stat(root)).isDirectory()) throw new Error("Workspace must be a directory");
  return root;
}
function findWorkspaceByPath(value: string): Workspace | undefined {
  const key = workspacePathKey(value);
  return state.workspaces.find(item => workspacePathKey(item.path) === key);
}
function createWorkspaceRecord(root: string, name?: string, createdAt = new Date().toISOString()): Workspace {
  const fallbackName = workspaceNameFromPath(root);
  const workspace: Workspace = {
    id: randomUUID(),
    name: (name || fallbackName).trim().slice(0, 120) || fallbackName,
    path: root,
    createdAt,
    lastOpenedAt: createdAt,
  };
  state.workspaces.push(workspace);
  return workspace;
}

export function taskExecutionPath(task: Pick<Task, "workspace" | "execution">): string {
  return task.execution?.path || task.workspace;
}

function localExecution(workspace: string): TaskExecution {
  return { mode: "local", path: workspace, managed: false, detached: false };
}

async function runControlGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["--no-pager", "-c", "core.fsmonitor=false", ...args], {
      cwd,
      windowsHide: true,
      env: { ...childEnvironment(), GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "false", GIT_SEQUENCE_EDITOR: "false" },
    });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Git environment operation timed out")); }, 120_000);
    child.stdout.on("data", chunk => { stdout = (stdout + chunk.toString()).slice(-200000); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-200000); });
    child.once("error", () => { clearTimeout(timer); reject(new Error("git not found. Install Git for Windows.")); });
    child.once("close", code => {
      clearTimeout(timer);
      if ((code ?? 1) !== 0) reject(new Error(stderr.trim() || stdout.trim() || `git exited with code ${code}`));
      else resolve(stdout.trim());
    });
  });
}

async function managedWorktreePath(workspaceId: string, taskId: string): Promise<string> {
  const root = path.join(path.dirname(workbenchRoot()), "worktrees", workspaceId);
  await fs.mkdir(root, { recursive: true });
  return path.join(root, taskId);
}
async function normalizeLoadedState(raw: any): Promise<State> {
  if (!raw || !Array.isArray(raw.tasks) || !Array.isArray(raw.operations)) throw new Error("Invalid workbench state");
  if ((raw.version === 2 || raw.version === 3) && Array.isArray(raw.workspaces)) {
    const next = raw as State;
    next.version = 3;
    next.checkpoints ??= [];
    for (const task of next.tasks) {
      const existing = next.workspaces.find(item => item.id === task.workspaceId)
        || next.workspaces.find(item => workspacePathKey(item.path) === workspacePathKey(task.workspace));
      if (existing) { task.workspaceId = existing.id; task.workspace = existing.path; }
      task.execution ??= localExecution(task.workspace);
      if (task.execution.mode === "local") task.execution.path = task.workspace;
    }
    if (!next.selectedWorkspaceId && next.selectedTaskId) next.selectedWorkspaceId = next.tasks.find(item => item.id === next.selectedTaskId)?.workspaceId;
    if (!next.selectedWorkspaceId) next.selectedWorkspaceId = next.workspaces[0]?.id;
    return next;
  }
  if (raw.version !== 1) throw new Error("Invalid workbench state");
  const migrated: State = {
    version: 3,
    workspaces: [],
    tasks: [],
    operations: raw.operations,
    checkpoints: raw.checkpoints || [],
    selectedTaskId: raw.selectedTaskId,
    sessionTasks: raw.sessionTasks || {},
  };
  state = migrated;
  for (const legacyTask of raw.tasks as Array<Omit<Task, "workspaceId" | "execution"> & { execution?: TaskExecution }>) {
    let root: string;
    try { root = await canonicalWorkspacePath(legacyTask.workspace); }
    catch { root = path.resolve(legacyTask.workspace); }
    const workspace = findWorkspaceByPath(root) || createWorkspaceRecord(root, workspaceNameFromPath(root), legacyTask.createdAt);
    migrated.tasks.push({ ...legacyTask, workspace: root, workspaceId: workspace.id, execution: legacyTask.execution || localExecution(root) });
  }
  migrated.selectedWorkspaceId = migrated.tasks.find(item => item.id === migrated.selectedTaskId)?.workspaceId || migrated.workspaces[0]?.id;
  return migrated;
}
async function save(change: WorkbenchChange = genericWorkbenchChange()): Promise<void> {
  const prior = saveQueue;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  saveQueue = gate;
  await prior;
  try {
    const target = path.join(workbenchRoot(), "state.json");
    const temp = `${target}.${randomUUID()}.tmp`;
    await fs.mkdir(workbenchRoot(), { recursive: true });
    // Serialize only after earlier saves finish so a slower, stale snapshot can
    // never overwrite newer in-memory state from another workspace.
    await fs.writeFile(temp, JSON.stringify(state), { mode: 0o600 });
    await fs.rename(temp, target);
    events.emit("change", change);
  } finally {
    release();
  }
}
async function init(): Promise<void> {
  if (!initialization) initialization = (async () => {
    try {
      state = await normalizeLoadedState(JSON.parse(await fs.readFile(path.join(workbenchRoot(), "state.json"), "utf8")));
      state.checkpoints ??= [];
      for (const op of state.operations) if (["pending", "running"].includes(op.status)) {
        op.status = "interrupted";
        op.error = "Server restarted. Operation was not replayed; inspect files before retrying.";
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      state = { version: 3, workspaces: [], tasks: [], operations: [], checkpoints: [] };
    }
    await save();
  })();
  await initialization;
}
export async function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const prior = globalQueue;
  let release!: () => void;
  globalQueue = new Promise<void>(resolve => { release = resolve; });
  await prior;
  try { await init(); return await fn(); } finally { release(); }
}

function workspaceLockKey(taskId: string): string {
  const workspace = taskExecutionPath(taskById(taskId));
  return process.platform === "win32" ? workspace.toLowerCase() : workspace;
}

async function workspaceExclusive<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
  await init();
  const key = workspaceLockKey(taskId);
  const prior = workspaceQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  workspaceQueues.set(key, gate);
  await prior;
  try {
    return await fn();
  } finally {
    release();
    if (workspaceQueues.get(key) === gate) workspaceQueues.delete(key);
  }
}
export function subscribeWorkbench(listener: (change: WorkbenchChange) => void): () => void {
  events.on("change", listener);
  return () => { events.off("change", listener); };
}
function taskById(id: string): Task {
  const task = state.tasks.find(t => t.id === id);
  if (!task) throw new Error("Unknown task");
  return task;
}
function publicOperation(op: Operation) {
  const { result, args, review, ...summary } = op;
  const reviewSummary = review ? {
    additions: review.additions,
    deletions: review.deletions,
    truncated: review.truncated,
    warning: review.warning,
    files: review.files.map(({ diff, ...file }) => file),
  } : undefined;
  return { ...summary, review: reviewSummary, args: op.status === "pending" ? args : undefined, changes: op.changes.map(c => ({ path: c.path, before: c.before.kind, after: c.after.kind, undone: !!c.undone })) };
}
export async function getWorkbench() {
  await init();
  const sandbox = await getSandboxStatus();
  return {
    workspaces: structuredClone(state.workspaces),
    selectedWorkspaceId: state.selectedWorkspaceId,
    selectedTaskId: state.selectedTaskId,
    tasks: structuredClone(state.tasks),
    operations: state.operations.map(publicOperation).reverse(),
    capabilities: { osSandbox: sandbox.available, sandbox, fileUndo: true, shellUndo: false, approvalReviewer: "rules", chatgptWidget: false },
  };
}
export async function createWorkspace(name: string, workspacePath: string): Promise<Workspace> {
  return exclusive(async () => {
    const root = await canonicalWorkspacePath(workspacePath);
    if (workspacePathKey(root) === workspacePathKey(workbenchRoot())) throw new Error("Workbench control directory cannot be added as a workspace");
    if (findWorkspaceByPath(root)) throw new Error("Workspace already added");
    const workspace = createWorkspaceRecord(root, name);
    state.selectedWorkspaceId ??= workspace.id;
    await save({ scopes: ["workspaces"], reason: "workspace-created" });
    return structuredClone(workspace);
  });
}
export async function selectWorkspace(id: string): Promise<void> {
  await exclusive(async () => {
    const workspace = workspaceById(id);
    workspace.lastOpenedAt = new Date().toISOString();
    state.selectedWorkspaceId = workspace.id;
    const task = state.tasks.find(item => item.workspaceId === workspace.id);
    state.selectedTaskId = task?.id;
    await save({ scopes: ["workspaces", "tasks"], taskId: task?.id, reason: "workspace-selected" });
  });
}
export async function createTask(
  title: string,
  workspacePath?: string,
  workspaceId?: string,
  environment?: { mode?: "local" | "worktree"; startingRef?: string },
): Promise<Task> {
  return exclusive(async () => {
    let workspace: Workspace;
    if (workspaceId) workspace = workspaceById(workspaceId);
    else {
      if (!workspacePath) throw new Error("Workspace is required");
      const root = await canonicalWorkspacePath(workspacePath);
      workspace = findWorkspaceByPath(root) || createWorkspaceRecord(root);
    }
    const mode: PermissionMode = process.env.WORKBENCH_DEFAULT_MODE === "full" ? "full" : process.env.WORKBENCH_DEFAULT_MODE === "auto" ? "auto" : "ask";
    const taskId = randomUUID();
    let execution = localExecution(workspace.path);
    if (environment?.mode === "worktree") {
      const startingRef = (environment.startingRef || "HEAD").trim() || "HEAD";
      await runControlGit(workspace.path, ["rev-parse", "--verify", `${startingRef}^{commit}`]);
      const target = await managedWorktreePath(workspace.id, taskId);
      try {
        await fs.rm(target, { recursive: true, force: true });
        await runControlGit(workspace.path, ["worktree", "add", "--detach", target, startingRef]);
      } catch (error) {
        await fs.rm(target, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
      execution = { mode: "worktree", path: await fs.realpath(target), startingRef, detached: true, managed: true };
    }
    const task: Task = { id: taskId, workspaceId: workspace.id, title: title.slice(0, 200), workspace: workspace.path, execution, createdAt: new Date().toISOString(),
      policy: { mode, workspaceOnly: mode !== "full", revision: 1 } };
    state.tasks.push(task);
    state.selectedWorkspaceId ??= workspace.id;
    await save({ scopes: ["workspaces", "tasks"], taskId: task.id, reason: "task-created" });
    return structuredClone(task);
  });
}

export async function setTaskPreview(id: string, preview?: TaskPreview): Promise<Task> {
  return workspaceExclusive(id, async () => {
    const task = taskById(id);
    if (preview) task.preview = structuredClone(preview);
    else delete task.preview;
    await save({ scopes: ["tasks"], taskId: id, reason: "preview-updated" });
    return structuredClone(task);
  });
}

export async function selectTask(id: string): Promise<void> {
  await exclusive(async () => {
    const task = taskById(id);
    const workspace = workspaceById(task.workspaceId);
    workspace.lastOpenedAt = new Date().toISOString();
    state.selectedWorkspaceId = workspace.id;
    state.selectedTaskId = id;
    // Keep the selected default first in the local task picker.
    state.tasks = [task, ...state.tasks.filter(t => t.id !== id)];
    await save({ scopes: ["workspaces", "tasks"], taskId: id, reason: "task-selected" });
  });
}

export async function resolveDefaultTask(workspace: string): Promise<string> {
  return exclusive(async () => {
    if (state.selectedTaskId && state.tasks.some(item => item.id === state.selectedTaskId)) return taskById(state.selectedTaskId).id;
    let selectedWorkspace = state.selectedWorkspaceId ? state.workspaces.find(item => item.id === state.selectedWorkspaceId) : undefined;
    if (!selectedWorkspace) {
      const root = await canonicalWorkspacePath(workspace);
      selectedWorkspace = findWorkspaceByPath(root) || createWorkspaceRecord(root);
      state.selectedWorkspaceId = selectedWorkspace.id;
    }
    const existing = state.tasks.find(item => item.workspaceId === selectedWorkspace!.id);
    if (existing) { state.selectedTaskId = existing.id; return existing.id; }
    const mode: PermissionMode = process.env.WORKBENCH_DEFAULT_MODE === "full" ? "full" : process.env.WORKBENCH_DEFAULT_MODE === "auto" ? "auto" : "ask";
    const task: Task = { id: randomUUID(), workspaceId: selectedWorkspace.id, title: "Default project", workspace: selectedWorkspace.path, execution: localExecution(selectedWorkspace.path), createdAt: new Date().toISOString(),
      policy: { mode, workspaceOnly: mode !== "full", revision: 1 } };
    state.tasks.push(task);
    state.selectedTaskId = task.id;
    await save({ scopes: ["workspaces", "tasks"], taskId: task.id, reason: "default-task-created" });
    return task.id;
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
      await save({ scopes: ["tasks"], taskId: defaultTask, reason: "session-task-bound" });
    }
    return taskById(state.sessionTasks[sessionId]).id;
  });
}

export async function setTaskPolicy(id: string, mode: PermissionMode, workspaceOnly: boolean): Promise<void> {
  await workspaceExclusive(id, async () => {
    const task = taskById(id);
    task.policy = { mode, workspaceOnly, revision: task.policy.revision + 1 };
    for (const op of state.operations.filter(o => o.taskId === id && o.status === "pending")) {
      op.status = "expired"; callbacks.delete(op.id);
    }
    await save({ scopes: ["tasks", "operations"], taskId: id, reason: "policy-updated" });
  });
}

function checkpointById(id: string): TaskCheckpoint {
  const checkpoint = (state.checkpoints || []).find(item => item.id === id);
  if (!checkpoint) throw new Error("Unknown task checkpoint");
  return checkpoint;
}

export async function listTaskCheckpoints(taskId: string): Promise<TaskCheckpoint[]> {
  await init(); taskById(taskId);
  return structuredClone((state.checkpoints || []).filter(item => item.taskId === taskId).reverse());
}

export async function clearTaskCheckpoints(taskId: string): Promise<number> {
  return workspaceExclusive(taskId, async () => {
    taskById(taskId);
    const before = state.checkpoints || [];
    const removed = before.filter(item => item.taskId === taskId).length;
    state.checkpoints = before.filter(item => item.taskId !== taskId);
    await save({ scopes: ["checkpoints"], taskId, reason: "checkpoints-cleared" });
    return removed;
  });
}

export async function createTaskCheckpoint(taskId: string, title: string): Promise<TaskCheckpoint> {
  return workspaceExclusive(taskId, async () => {
    taskById(taskId);
    const checkpoint: TaskCheckpoint = {
      id: randomUUID(), taskId, title: title.trim().slice(0, 160) || "Checkpoint",
      createdAt: new Date().toISOString(), operationIndex: state.operations.length,
    };
    state.checkpoints ??= [];
    state.checkpoints.push(checkpoint);
    await save({ scopes: ["checkpoints"], taskId, reason: "checkpoint-created" });
    return structuredClone(checkpoint);
  });
}

interface CheckpointRestorePlan {
  checkpoint: TaskCheckpoint;
  files: Array<{ path: string; current: Snapshot["kind"]; target: Snapshot["kind"] }>;
  operationCount: number;
  externalEffects: Array<{ id: string; tool: string; status: Operation["status"] }>;
}

async function buildCheckpointRestorePlan(checkpoint: TaskCheckpoint): Promise<{ plan: CheckpointRestorePlan; targets: Map<string, Snapshot>; reversed: Change[] }> {
  const task = taskById(checkpoint.taskId);
  const executionRoot = taskExecutionPath(task);
  const operations = state.operations.slice(checkpoint.operationIndex).filter(op => op.taskId === task.id && ["completed", "failed"].includes(op.status));
  const externalEffects = operations.filter(op => op.tracking === "external-effects-not-tracked")
    .map(op => ({ id: op.id, tool: op.tool, status: op.status }));
  const fileOps = operations.filter(op => op.tracking === "file-tools" && op.changes.length);
  const paths = [...new Set(fileOps.flatMap(op => op.changes.map(change => change.path)))];
  const current = new Map<string, Snapshot>();
  const targets = new Map<string, Snapshot>();
  const reversed: Change[] = [];
  await executionContext.run({ taskId: task.id, workspace: executionRoot, workspaceOnly: task.policy.workspaceOnly, operationId: checkpoint.id, capture: async () => {} }, async () => {
    for (const filePath of paths) {
      await validatePath(filePath);
      const value = await snapshot(filePath);
      current.set(filePath, value); targets.set(filePath, value);
    }
    for (const op of [...fileOps].reverse()) {
      for (const change of [...op.changes].reverse()) {
        if (change.undone) continue;
        const virtual = targets.get(change.path) ?? await snapshot(change.path);
        if (fingerprint(virtual) !== fingerprint(change.after)) {
          throw new Error(`CHECKPOINT_CONFLICT: ${change.path} no longer matches the recorded operation state`);
        }
        targets.set(change.path, change.before);
        reversed.push(change);
      }
    }
    // Refuse to remove a directory containing content that was never part of the journal.
    for (const [filePath, target] of targets) {
      if (target.kind !== "missing" || current.get(filePath)?.kind !== "directory") continue;
      const nested = new Map<string, Snapshot>();
      await captureTree(filePath, nested);
      for (const nestedPath of nested.keys()) {
        if (nestedPath !== filePath && !targets.has(nestedPath)) throw new Error(`CHECKPOINT_CONFLICT: untracked content in ${filePath}`);
      }
    }
  });
  const files = [...targets.entries()]
    .filter(([filePath, target]) => fingerprint(current.get(filePath)!) !== fingerprint(target))
    .map(([filePath, target]) => ({ path: filePath, current: current.get(filePath)!.kind, target: target.kind }));
  return { plan: { checkpoint: structuredClone(checkpoint), files, operationCount: fileOps.length, externalEffects }, targets, reversed };
}

export async function previewTaskCheckpoint(id: string): Promise<CheckpointRestorePlan> {
  await init();
  const taskId = checkpointById(id).taskId;
  return workspaceExclusive(taskId, async () => {
    const { plan } = await buildCheckpointRestorePlan(checkpointById(id));
    return plan;
  });
}

export async function restoreTaskCheckpoint(id: string): Promise<CheckpointRestorePlan> {
  await init();
  const taskId = checkpointById(id).taskId;
  return workspaceExclusive(taskId, async () => {
    const checkpoint = checkpointById(id);
    const { plan, targets, reversed } = await buildCheckpointRestorePlan(checkpoint);
    const ordered = [...targets.entries()].filter(([filePath, target]) => plan.files.some(file => file.path === filePath) && target)
      .sort(([pathA, a], [pathB, b]) => {
        if (a.kind === "missing" && b.kind !== "missing") return 1;
        if (a.kind !== "missing" && b.kind === "missing") return -1;
        return a.kind === "missing" ? pathB.length - pathA.length : pathA.length - pathB.length;
      });
    const task = taskById(checkpoint.taskId);
    const executionRoot = taskExecutionPath(task);
    await executionContext.run({ taskId: task.id, workspace: executionRoot, workspaceOnly: task.policy.workspaceOnly, operationId: checkpoint.id, capture: async () => {} }, async () => {
      for (const [filePath, target] of ordered) { await validatePath(filePath); await restore(filePath, target); }
    });
    for (const change of reversed) change.undone = true;
    // A restore creates a new timeline. Later checkpoints from the same task would
    // otherwise point at operation states that are no longer current.
    state.checkpoints = (state.checkpoints || []).filter(item =>
      item.taskId !== checkpoint.taskId || item.operationIndex <= checkpoint.operationIndex
    );
    await save({ scopes: ["operations", "checkpoints", "workspace"], taskId: checkpoint.taskId, reason: "checkpoint-restored" });
    return plan;
  });
}

// Classification is conservative and independent of model-supplied annotations.
const READ_TOOLS = new Set(["inspect_code", "read_text_file", "read_multiple_files", "list_directory", "glob", "grep", "search_files", "directory_tree", "get_file_info", "list_allowed_directories", "agent_status", "project_context", "load_path_rules", "shell_status", "process_status", "process_output", "mcp_servers", "mcp_tools"]);
const EDIT_TOOLS = new Set(["write_file", "edit_file", "multi_edit", "apply_patch", "replace_regex", "create_directory", "copy_file", "move_file", "remember"]);
const CHANGE_SET_TOOLS = new Set([...EDIT_TOOLS, "delete_file", "delete_directory"]);
const CHANGE_SET_IDLE_MS = Math.max(5_000, Number(process.env.WORKBENCH_CHANGE_SET_IDLE_MS || 45_000));
const CHANGE_SET_MAX_MS = Math.max(CHANGE_SET_IDLE_MS, Number(process.env.WORKBENCH_CHANGE_SET_MAX_MS || 10 * 60_000));

function changeSetKey(taskId: string, sessionId: string): string {
  return `${taskId}:${sessionId}`;
}

function operationChangeSetId(taskId: string, sessionId: string | undefined, tool: string, operationId: string): string {
  if (!sessionId || !CHANGE_SET_TOOLS.has(tool)) return operationId;
  const key = changeSetKey(taskId, sessionId);
  const now = Date.now();
  const current = activeChangeSets.get(key);
  const currentWasRestored = current
    ? state.operations.some(op => op.changeSetId === current.id && op.changes.some(change => change.undone))
    : false;
  if (!current || currentWasRestored || now - current.lastAt > CHANGE_SET_IDLE_MS || now - current.startedAt > CHANGE_SET_MAX_MS) {
    const next = { id: randomUUID(), startedAt: now, lastAt: now };
    activeChangeSets.set(key, next);
    return next.id;
  }
  current.lastAt = now;
  return current.id;
}

function touchChangeSet(op: Operation): void {
  if (!op.sessionId || !op.changeSetId || !CHANGE_SET_TOOLS.has(op.tool)) return;
  const current = activeChangeSets.get(changeSetKey(op.taskId, op.sessionId));
  if (current?.id === op.changeSetId) current.lastAt = Date.now();
}
export function isReadOperation(tool: string, args: Args): boolean {
  return READ_TOOLS.has(tool) || ["git_status", "git_diff", "git_log"].includes(tool)
    || tool === "github" && ["pr_list", "pr_view", "pr_checks", "issue_list", "issue_view"].includes(args.action)
    || (["git_branch", "git_stash"].includes(tool) && (args.action || "list") === "list")
    || (tool === "git_worktree" && (args.action || "list") === "list")
    || (tool === "rewind" && ["list", "preview", "status"].includes(args.action));
}
export function isProcessOperation(tool: string): boolean {
  return tool.startsWith("git_") || tool === "github" || ["run_command", "start_process", "mcp_call", "mcp_servers", "mcp_tools", "shell_reset"].includes(tool)
    || tool.startsWith("upstream_");
}
const SANDBOX_PROCESS_TOOLS = new Set([
  "run_command", "start_process",
  "git_status", "git_diff", "git_log", "git_init", "git_add", "git_commit", "git_branch", "git_checkout", "git_restore", "git_stash", "git_reset", "git_unstage", "git_worktree",
]);
const WORKSPACE_CONTROL_TOOLS = new Set(["shell_reset", "stop_process", "clear_processes", "rewind"]);
async function assertWorkspaceOperationAllowed(tool: string): Promise<void> {
  if (WORKSPACE_CONTROL_TOOLS.has(tool)) return;
  if (!isProcessOperation(tool)) return;
  if (!SANDBOX_PROCESS_TOOLS.has(tool)) {
    throw new Error("WORKSPACE_EXTERNAL_BLOCKED: this operation requires machine/network scope and is not available inside the network-isolated workspace sandbox");
  }
  const sandbox = await getSandboxStatus();
  if (!sandbox.available) throw new Error(`SANDBOX_UNAVAILABLE: ${sandbox.reason || "workspace process sandbox is unavailable"}`);
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
function snapshotText(value: Snapshot | undefined): string | undefined {
  if (!value || value.kind === "missing") return "";
  if (value.kind !== "file") return undefined;
  const buffer = Buffer.from(value.content || "", "base64");
  if (buffer.includes(0)) return undefined;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
  catch { return undefined; }
}
function reviewFile(pathValue: string, operation: OperationReviewFile["operation"], before: string | undefined, after: string | undefined, note?: string): OperationReviewFile {
  if (before === undefined || after === undefined) return { path: pathValue, operation, note: note || "Binary or non-text content cannot be previewed." };
  const raw = buildSimpleDiff(before, after);
  const MAX_REVIEW_DIFF = 24_000;
  const truncated = raw.length > MAX_REVIEW_DIFF;
  const diff = truncated ? `${raw.slice(0, MAX_REVIEW_DIFF)}\n… [preview truncated]` : raw;
  const lines = raw.split("\n");
  return {
    path: pathValue,
    operation,
    diff,
    additions: lines.filter(line => line.startsWith("+") && !line.startsWith("+++")).length,
    deletions: lines.filter(line => line.startsWith("-") && !line.startsWith("---")).length,
    ...(truncated ? { note: "Diff preview truncated; approval still binds to the full file snapshot." } : {}),
  };
}

function reviewOperationForChange(change: Change): OperationReviewFile["operation"] {
  if (change.before.kind === "missing" && change.after.kind !== "missing") return change.after.kind === "directory" ? "directory" : "create";
  if (change.before.kind !== "missing" && change.after.kind === "missing") return change.before.kind === "directory" ? "directory" : "delete";
  if (change.before.kind === "directory" || change.after.kind === "directory") return "directory";
  return "update";
}

function buildCompletedOperationReview(changes: Change[]): OperationReview | undefined {
  if (!changes.length) return undefined;
  const files = changes.map(change => reviewFile(
    change.path,
    reviewOperationForChange(change),
    snapshotText(change.before),
    snapshotText(change.after),
  ));
  return {
    files,
    additions: files.reduce((sum, file) => sum + (file.additions || 0), 0),
    deletions: files.reduce((sum, file) => sum + (file.deletions || 0), 0),
    truncated: files.some(file => file.note?.includes("truncated")),
  };
}
async function buildOperationReview(task: Task, tool: string, args: Args, expected: Map<string, Snapshot>): Promise<OperationReview | undefined> {
  const files: OperationReviewFile[] = [];
  const executionRoot = taskExecutionPath(task);
  const resolved = async (value: string) => await validatePath(path.resolve(executionRoot, value));
  const addText = (target: string, operation: OperationReviewFile["operation"], after: string | undefined, note?: string) => {
    files.push(reviewFile(target, operation, snapshotText(expected.get(target)), after, note));
  };
  try {
    if (tool === "write_file") {
      const target = await resolved(args.path);
      addText(target, expected.get(target)?.kind === "missing" ? "create" : "update", String(args.content ?? ""));
    } else if (tool === "write_file_base64") {
      const target = await resolved(args.path);
      files.push({ path: target, operation: "binary", note: `Binary write · ${Buffer.from(String(args.content || ""), "base64").length} bytes` });
    } else if (["edit_file", "multi_edit", "replace_regex"].includes(tool)) {
      const target = await resolved(args.path);
      const before = snapshotText(expected.get(target));
      if (before === undefined) files.push({ path: target, operation: "binary", note: "Text edit preview unavailable for binary content." });
      else {
        let after = before;
        if (tool === "edit_file") {
          if (!after.includes(args.old_text)) throw new Error("old_text not found in file");
          after = args.replace_all ? after.split(args.old_text).join(args.new_text) : after.replace(args.old_text, args.new_text);
        } else if (tool === "multi_edit") {
          for (const edit of args.edits || []) {
            if (!after.includes(edit.old_text)) throw new Error(`old_text not found: ${String(edit.old_text).slice(0, 120)}`);
            after = edit.replace_all ? after.split(edit.old_text).join(edit.new_text) : after.replace(edit.old_text, edit.new_text);
          }
        } else {
          after = after.replace(new RegExp(args.pattern, args.flags || "g"), args.replacement);
        }
        files.push(reviewFile(target, "update", before, after));
      }
    } else if (tool === "apply_patch") {
      if (isMultiFilePatch(args.patch || "")) {
        let base = args.path ? await validatePath(args.path) : executionRoot;
        try { if (!(await fs.stat(base)).isDirectory()) base = path.dirname(base); } catch { base = path.dirname(base); }
        for (const edit of parseMultiFilePatch(args.patch, base)) {
          const before = snapshotText(expected.get(edit.path));
          if (edit.operation === "create") files.push(reviewFile(edit.path, "create", before ?? "", edit.content ?? ""));
          else if (edit.operation === "delete") files.push(reviewFile(edit.path, "delete", before, ""));
          else if (before === undefined) files.push({ path: edit.path, operation: "binary", note: "Patch preview unavailable for non-text content." });
          else files.push(reviewFile(edit.path, "update", before, applyUnifiedPatchToText(before, edit.patch || "")));
        }
      } else {
        const target = await resolved(args.path);
        const before = snapshotText(expected.get(target));
        files.push(before === undefined
          ? { path: target, operation: "binary", note: "Patch preview unavailable for non-text content." }
          : reviewFile(target, "update", before, applyUnifiedPatchToText(before, args.patch || "")));
      }
    } else if (tool === "delete_file") {
      const target = await resolved(args.path); files.push(reviewFile(target, "delete", snapshotText(expected.get(target)), ""));
    } else if (tool === "create_directory") {
      const target = await resolved(args.path); files.push({ path: target, operation: "directory", note: "Create directory" });
    } else if (tool === "delete_directory") {
      const target = await resolved(args.path); files.push({ path: target, operation: "directory", note: "Delete directory recursively; contained files are bound by the approval snapshot." });
    } else if (tool === "copy_file") {
      const source = await resolved(args.source), destination = await resolved(args.destination);
      files.push(reviewFile(destination, "copy", snapshotText(expected.get(destination)), snapshotText(expected.get(source)), `Copy from ${source}`));
    } else if (tool === "move_file") {
      const source = await resolved(args.source), destination = await resolved(args.destination);
      const sourceText = snapshotText(expected.get(source));
      files.push(reviewFile(source, "move", sourceText, "", `Move to ${destination}`));
      files.push(reviewFile(destination, "move", snapshotText(expected.get(destination)), sourceText, `Move from ${source}`));
    } else return undefined;
  } catch (error) {
    return { files, additions: 0, deletions: 0, truncated: false, warning: `Preview unavailable: ${String(error)}` };
  }
  const additions = files.reduce((sum, file) => sum + (file.additions || 0), 0);
  const deletions = files.reduce((sum, file) => sum + (file.deletions || 0), 0);
  return { files, additions, deletions, truncated: files.some(file => file.note?.includes("truncated")) };
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
export async function dispatch(taskId: string, tool: string, args: Args, invoke: () => Promise<unknown>, human = false, sessionId?: string): Promise<any> {
  await init();
  // Waiting for process output must not lock writes or other tasks behind it.
  if (isReadOperation(tool, args)) {
    const task = structuredClone(taskById(taskId));
    const executionRoot = taskExecutionPath(task);
    if (task.policy.workspaceOnly) {
      await assertWorkspaceOperationAllowed(tool);
    }
    return executionContext.run({ taskId, sessionId, workspace: executionRoot, workspaceOnly: task.policy.workspaceOnly, operationId: randomUUID(), capture: async () => {} }, invoke);
  }
  return workspaceExclusive(taskId, async () => {
    const task = taskById(taskId);
    const executionRoot = taskExecutionPath(task);
    if (task.policy.workspaceOnly) {
      await assertWorkspaceOperationAllowed(tool);
      if (!isProcessOperation(tool) && !READ_TOOLS.has(tool) && !EDIT_TOOLS.has(tool) && !["delete_file", "delete_directory", ...WORKSPACE_CONTROL_TOOLS].includes(tool)) {
        throw new Error("WORKSPACE_SCOPE_BLOCKED: this operation is not classified as safe for workspace-only mode");
      }
    }
    const operationId = randomUUID();
    const changeSetId = operationChangeSetId(taskId, sessionId, tool, operationId);
    if (sessionId && !CHANGE_SET_TOOLS.has(tool)) activeChangeSets.delete(changeSetKey(taskId, sessionId));
    const op: Operation = { id: operationId, taskId, ...(sessionId ? { sessionId } : {}), changeSetId, tool, args: structuredClone(args), createdAt: new Date().toISOString(),
      expiresAt: Date.now() + 15 * 60_000, policyRevision: task.policy.revision, status: "pending", changes: [],
      tracking: isProcessOperation(tool) ? "external-effects-not-tracked" : "file-tools" };
    const boundary = { taskId, sessionId, workspace: executionRoot, workspaceOnly: task.policy.workspaceOnly, operationId: op.id, capture: async (_paths: string[]) => {} };
    const expected = new Map<string, Snapshot>();
    const gitCwd = tool.startsWith("git_") ? await executionContext.run(boundary, () => validatePath(args.path || executionRoot)) : undefined;
    const gitBefore = gitCwd && !human && task.policy.mode !== "full"
      ? await executionContext.run(boundary, () => gitApprovalFingerprint(gitCwd, args.branch))
      : undefined;
    if (!isReadOperation(tool, args) && !isProcessOperation(tool)) {
      await executionContext.run(boundary, async () => {
        const targets = [args.path, args.source, args.destination].filter((p): p is string => typeof p === "string").map(p => path.resolve(executionRoot, p));
        if (tool === "remember") targets.push(path.join(executionRoot, ".local-coder", "MEMORY.md"));
        if (tool === "apply_patch" && isMultiFilePatch(args.patch || "")) {
          let base = args.path ? await validatePath(args.path) : executionRoot;
          if (!(await fs.stat(base)).isDirectory()) base = path.dirname(base);
          targets.splice(0, targets.length, ...parseMultiFilePatch(args.patch, base).map(o => o.path));
        }
        for (const p of targets) await captureTree(await validatePath(p), expected);
        op.review = await buildOperationReview(task, tool, args, expected);
      });
    }
    const execute = async () => {
      const before = new Map<string, Snapshot>();
      const context = { taskId, sessionId, workspace: executionRoot, workspaceOnly: task.policy.workspaceOnly, operationId: op.id,
        capture: async (paths: string[]) => {
          for (const p of paths) await captureTree(await validatePath(p), before);
          op.changes = [...before].map(([p, s]) => ({ path: p, before: s, after: s }));
          await save({ scopes: ["operations"], taskId, operationId: op.id, reason: "operation-baseline" }); // Write-ahead journal; never start a file edit without its baseline on disk.
        } };
      op.status = "running";
      await save({ scopes: ["operations"], taskId, operationId: op.id, reason: "operation-running" });
      let result: any;
      try {
        if (gitBefore && await executionContext.run(boundary, () => gitApprovalFingerprint(gitCwd!, args.branch)) !== gitBefore) throw new Error("APPROVAL_CONFLICT: Git HEAD, index, working tree or configuration changed while waiting for approval");
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
          if (op.tracking === "file-tools") op.review = buildCompletedOperationReview(op.changes);
        } catch (error) { op.status = "failed"; op.error = `Tracking incomplete: ${error}`; }
        op.result = result;
        touchChangeSet(op);
        await save({ scopes: ["operations", "workspace"], taskId, operationId: op.id, reason: "operation-finished" });
      }
      if (op.error) throw new Error(op.error);
      return result;
    };
    const read = isReadOperation(tool, args);
    if (read) return executionContext.run({ taskId, sessionId, workspace: executionRoot, workspaceOnly: task.policy.workspaceOnly, operationId: op.id, capture: async () => {} }, invoke);
    state.operations.push(op);
    const auto = task.policy.mode === "full" || task.policy.mode === "auto" && EDIT_TOOLS.has(tool);
    if (!human && !auto) {
      callbacks.set(op.id, execute);
      await save({ scopes: ["operations"], taskId, operationId: op.id, reason: "operation-pending" });
      return { content: [{ type: "text", text: JSON.stringify({ status: "approval_required", operation_id: op.id, task_id: taskId,
        message: "Review and approve this exact operation in the local Workbench. Do not resubmit it. Use workbench operation to get the result." }) }] };
    }
    return execute();
  });
}
export async function decideOperation(id: string, approve: boolean): Promise<unknown> {
  await init();
  const taskId = state.operations.find(o => o.id === id)?.taskId;
  if (!taskId) throw new Error("Operation is no longer pending");
  return workspaceExclusive(taskId, async () => {
    const op = state.operations.find(o => o.id === id);
    if (!op || op.status !== "pending") throw new Error("Operation is no longer pending");
    const invoke = callbacks.get(id); callbacks.delete(id);
    if (!approve) { op.status = "denied"; await save({ scopes: ["operations"], taskId: op.taskId, operationId: op.id, reason: "operation-denied" }); return publicOperation(op); }
    if (!invoke || op.expiresAt < Date.now() || taskById(op.taskId).policy.revision !== op.policyRevision) {
      op.status = "expired"; await save({ scopes: ["operations"], taskId: op.taskId, operationId: op.id, reason: "operation-expired" }); throw new Error("Approval expired; request a new operation");
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

function changeSetMembers(id: string): Operation[] {
  const grouped = state.operations.filter(op => op.changeSetId === id);
  if (grouped.length) return grouped.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const legacy = state.operations.find(op => op.id === id && !op.changeSetId);
  return legacy ? [legacy] : [];
}

function aggregateChangeSetChanges(operations: Operation[]): Change[] {
  const byPath = new Map<string, Change>();
  for (const op of operations) {
    if (op.tracking !== "file-tools" || !["completed", "failed"].includes(op.status)) continue;
    for (const change of op.changes) {
      const current = byPath.get(change.path);
      if (!current) byPath.set(change.path, { path: change.path, before: change.before, after: change.after });
      else current.after = change.after;
    }
  }
  return [...byPath.values()].filter(change => fingerprint(change.before) !== fingerprint(change.after));
}

function buildChangeSetDetail(id: string) {
  const operations = changeSetMembers(id);
  if (!operations.length) throw new Error("Unknown change set");
  const taskId = operations[0].taskId;
  if (operations.some(op => op.taskId !== taskId)) throw new Error("Change set spans multiple tasks");
  const reversible = operations.filter(op => op.tracking === "file-tools" && ["completed", "failed"].includes(op.status) && op.changes.length);
  const records = reversible.flatMap(op => op.changes);
  const anyUndone = records.some(change => !!change.undone);
  const anyActive = records.some(change => !change.undone);
  const blocked = operations.some(op => ["pending", "running"].includes(op.status));
  const changes = aggregateChangeSetChanges(operations);
  const review = buildCompletedOperationReview(changes);
  const status: Operation["status"] = operations.some(op => op.status === "pending") ? "pending"
    : operations.some(op => op.status === "running") ? "running"
      : operations.some(op => op.status === "failed") ? "failed"
        : operations.some(op => op.status === "interrupted") ? "interrupted"
          : "completed";
  return {
    id,
    taskId,
    sessionId: operations.every(op => op.sessionId === operations[0].sessionId) ? operations[0].sessionId : undefined,
    operationIds: operations.map(op => op.id),
    operationCount: operations.length,
    createdAt: operations[0].createdAt,
    updatedAt: operations[operations.length - 1].createdAt,
    status,
    canUndo: !blocked && records.length > 0 && anyActive && !anyUndone,
    canRedo: !blocked && records.length > 0 && anyUndone && !anyActive,
    mixed: anyUndone && anyActive,
    changes,
    review,
  };
}

function publicChangeSet(value: ReturnType<typeof buildChangeSetDetail>) {
  return {
    ...value,
    changes: value.changes.map(change => ({ path: change.path, before: change.before.kind, after: change.after.kind })),
    review: value.review ? {
      ...value.review,
      files: value.review.files.map(({ diff, ...file }) => file),
    } : undefined,
  };
}

export async function changeSetDetail(id: string) {
  await init();
  return structuredClone(buildChangeSetDetail(id));
}

export async function latestWorkspaceChangeSet(workspaceId: string) {
  await init();
  workspaceById(workspaceId);
  const taskIds = new Set(state.tasks.filter(task => task.workspaceId === workspaceId).map(task => task.id));
  const latest = [...state.operations].reverse().find(op =>
    taskIds.has(op.taskId)
    && op.tracking === "file-tools"
    && ["completed", "failed"].includes(op.status)
    && op.changes.length > 0
  );
  if (!latest) return null;
  return structuredClone(publicChangeSet(buildChangeSetDetail(latest.changeSetId || latest.id)));
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

export async function undoChangeSet(id: string, redo: boolean): Promise<ReturnType<typeof publicChangeSet>> {
  await init();
  const initial = changeSetMembers(id);
  const taskId = initial[0]?.taskId;
  if (!taskId) throw new Error("Change set cannot be restored");
  return workspaceExclusive(taskId, async () => {
    const detail = buildChangeSetDetail(id);
    if (detail.taskId !== taskId) throw new Error("Change set task changed");
    if (detail.mixed) throw new Error("CHANGE_SET_MIXED: this change set was partially restored; use Activity to finish Undo/Redo safely");
    if (redo ? !detail.canRedo : !detail.canUndo) throw new Error(redo ? "Change set cannot be redone" : "Change set cannot be undone");
    const operations = changeSetMembers(id).filter(op => op.tracking === "file-tools" && ["completed", "failed"].includes(op.status) && op.changes.length);
    const contributions = new Map<string, Change[]>();
    for (const op of operations) for (const change of op.changes) {
      const list = contributions.get(change.path) || [];
      list.push(change);
      contributions.set(change.path, list);
    }
    const task = taskById(taskId);
    const executionRoot = taskExecutionPath(task);
    const aggregate = aggregateChangeSetChanges(operations);
    const aggregatePaths = new Set(aggregate.map(change => change.path));
    await executionContext.run({ taskId, sessionId: detail.sessionId, workspace: executionRoot, workspaceOnly: task.policy.workspaceOnly, operationId: id, capture: async () => {} }, async () => {
      // Validate the whole change set before touching disk. This keeps batch Undo/Redo atomic on conflicts.
      for (const change of aggregate) {
        await validatePath(change.path);
        const current = await snapshot(change.path);
        const expected = redo ? change.before : change.after;
        if (fingerprint(current) !== fingerprint(expected)) throw new Error(`UNDO_CONFLICT: ${change.path} changed since this change set was recorded`);
        const target = redo ? change.after : change.before;
        if (target.kind === "missing" && current.kind === "directory") {
          const nested = new Map<string, Snapshot>();
          await captureTree(change.path, nested);
          for (const nestedPath of nested.keys()) {
            if (nestedPath !== change.path && !aggregatePaths.has(nestedPath)) throw new Error(`UNDO_CONFLICT: untracked content in ${change.path}`);
          }
        }
      }
      const ordered = [...aggregate].sort((a, b) => {
        const av = redo ? a.after : a.before, bv = redo ? b.after : b.before;
        if (av.kind === "missing" && bv.kind !== "missing") return 1;
        if (av.kind !== "missing" && bv.kind === "missing") return -1;
        return av.kind === "missing" ? b.path.length - a.path.length : a.path.length - b.path.length;
      });
      for (const change of ordered) {
        await restore(change.path, redo ? change.after : change.before);
        for (const record of contributions.get(change.path) || []) record.undone = !redo;
        await save({ scopes: ["operations", "workspace"], taskId, operationId: operations.at(-1)?.id, reason: redo ? "change-set-redone" : "change-set-undone" });
      }
      // Net-zero paths do not require disk writes, but their journal state still follows the batch action.
      for (const [pathValue, records] of contributions) {
        if (aggregatePaths.has(pathValue)) continue;
        for (const record of records) record.undone = !redo;
      }
      if ([...contributions.keys()].some(pathValue => !aggregatePaths.has(pathValue))) {
        await save({ scopes: ["operations", "workspace"], taskId, operationId: operations.at(-1)?.id, reason: redo ? "change-set-redone" : "change-set-undone" });
      }
    });
    return publicChangeSet(buildChangeSetDetail(id));
  });
}

export async function undoOperation(id: string, redo: boolean, file?: string): Promise<void> {
  await init();
  const taskId = state.operations.find(o => o.id === id)?.taskId;
  if (!taskId) throw new Error("Operation cannot be restored");
  await workspaceExclusive(taskId, async () => {
    const op = state.operations.find(o => o.id === id);
    if (!op || !["completed", "failed"].includes(op.status)) throw new Error("Operation cannot be restored");
    const task = taskById(op.taskId);
    const executionRoot = taskExecutionPath(task);
    const changes = op.changes.filter(c => (!file || c.path === file) && !!c.undone === redo);
    if (!changes.length) throw new Error("No changes to restore");
    await executionContext.run({ taskId: task.id, workspace: executionRoot, workspaceOnly: task.policy.workspaceOnly, operationId: id, capture: async () => {} }, async () => {
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
        await save({ scopes: ["operations", "workspace"], taskId: op.taskId, operationId: op.id, reason: redo ? "operation-redone" : "operation-undone" }); // Preserve recovery state if a later path fails.
      }
    });
  });
}
