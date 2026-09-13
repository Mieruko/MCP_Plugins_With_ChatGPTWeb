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
import { getTaskRuntime, setTaskRuntimeProcessRole, stopTaskRuntimeProcesses } from "./task-runtime.js";
import { defaultExperience, type ExperienceMode, type WriterLease } from "./experience.js";
import { isLoopbackPortAvailable, selectPreviewPort, waitForLoopbackPortAvailable, type PortLease } from "./port-leases.js";
import {
  cancelAgentAssignment as cancelAssignment,
  claimSessionTask,
  closeAgentBinding as closeBinding,
  migrateLegacySessionTasks,
  queueAgentAssignment as queueAssignment,
  type AgentAssignment,
  type AgentBinding,
  type AgentClientType,
} from "./agent-coordinator.js";

export type PermissionMode = "ask" | "auto" | "full";
export type Args = Record<string, any>;
export interface Policy { mode: PermissionMode; workspaceOnly: boolean; revision: number }
export interface ControlAuthority { taskId: string; sessionId: string; requireIdle?: boolean }
export function remotePolicyControlEnabled(): boolean {
  return process.env.WORKBENCH_REMOTE_POLICY_CONTROL === "true";
}
export interface TaskPreview {
  command: string;
  url?: string;
  port?: number;
  autoPort?: boolean;
  leaseId?: string;
  processId?: string;
  startedAt?: string;
}
export interface Workspace {
  id: string; name: string; path: string; createdAt: string; lastOpenedAt: string;
  experience: ExperienceMode;
  basicTaskId?: string;
  writer?: WriterLease;
}
export type WorkspaceAvailability = "ready" | "missing" | "unavailable";
export interface TaskExecution {
  mode: "local" | "worktree";
  path: string;
  startingRef?: string;
  baseOid?: string;
  branch?: string;
  detached?: boolean;
  managed?: boolean;
}
export type TaskKind = "standard" | "parallel";
export type TaskLifecycle = "open" | "ready_to_merge" | "blocked" | "merged" | "completed" | "archived";
export interface TaskHandoff {
  summary: string;
  nextSteps: string[];
  notes?: string;
  fromSessionId?: string;
  updatedAt: string;
}
export interface TaskIntegration {
  targetBranch?: string;
  dependsOnTaskIds?: string[];
  readyAt?: string;
  readySourceHead?: string;
  readyTargetHead?: string;
  blockedAt?: string;
  blockedReason?: string;
  conflictPaths?: string[];
  mergedAt?: string;
  mergedCommit?: string;
  mergedSourceHead?: string;
  targetHeadBeforeMerge?: string;
  cleanupStatus?: "not_started" | "completed" | "partial" | "failed";
  cleanupAttemptedAt?: string;
  worktreeRemovedAt?: string;
  branchDeletedAt?: string;
  cleanupError?: string;
  finishedAt?: string;
  discardedAt?: string;
}
export interface Task { id: string; workspaceId: string; title: string; description?: string; handoff?: TaskHandoff; workspace: string; execution: TaskExecution; createdAt: string; completedAt?: string; policy: Policy; kind: TaskKind; lifecycle: TaskLifecycle; integration?: TaskIntegration; preview?: TaskPreview }
export interface TaskCheckpoint { id: string; taskId: string; title: string; createdAt: string; operationIndex: number }
export interface AgentSessionSnapshot {
  id: string;
  taskId: string;
  workspace: string;
  clientInfo?: { name: string; version?: string };
  clientType: AgentClientType;
  createdAt: string;
  lastAccessedAt: string;
  active: boolean;
  connected: boolean;
  liveConnections: number;
  inFlightRequests: number;
  state: "working" | "connected" | "recent" | "dormant";
}
export type AgentCoordinatorStatus = "working" | "approval_required" | "connected" | "recent" | "dormant" | "waiting";
export interface AgentCoordinatorConflict {
  type: "path_overlap" | "shared_environment" | "shared_task";
  severity: "warning" | "conflict";
  withTaskId?: string;
  withTaskTitle?: string;
  withAgentId?: string;
  paths?: string[];
  message: string;
}
export interface AgentCoordinatorView {
  id: string;
  agentId?: string;
  bindingId?: string;
  assignmentId?: string;
  sessionId?: string;
  taskId: string;
  taskTitle: string;
  taskKind: TaskKind;
  taskLifecycle: TaskLifecycle;
  workspaceId: string;
  workspace: string;
  executionPath: string;
  branch: string;
  baseOid?: string;
  clientInfo?: { name: string; version?: string };
  status: AgentCoordinatorStatus;
  active: boolean;
  queued: boolean;
  createdAt: string;
  lastSeenAt?: string;
  changedPaths: string[];
  changeCoverage: "base_to_worktree" | "working_tree" | "unavailable";
  previewPort?: number;
  previewUrl?: string;
  previewRunning: boolean;
  conflicts: AgentCoordinatorConflict[];
}
export interface TaskIntegrationView {
  taskId: string;
  taskTitle: string;
  workspaceId: string;
  lifecycle: TaskLifecycle;
  branch: string;
  targetBranch: string;
  baseOid?: string;
  sourceHead?: string;
  targetHead?: string;
  readySourceHead?: string;
  sourceDirty: boolean;
  targetDirty: boolean;
  activeOperations: number;
  runningProcesses: number;
  previewPort?: number;
  previewUrl?: string;
  previewRunning: boolean;
  previewLeased: boolean;
  commitsAhead: number;
  commitsBehind: number;
  changedPaths: string[];
  conflictPaths: string[];
  queuePosition?: number;
  dependencies: Array<{ taskId: string; taskTitle: string; lifecycle: TaskLifecycle; satisfied: boolean }>;
  unresolvedDependencyIds: string[];
  reason: string;
  canMarkReady: boolean;
  canMerge: boolean;
  canResume: boolean;
  canEditDependencies: boolean;
  worktreePresent: boolean;
  cleanupStatus: "not_started" | "completed" | "partial" | "failed";
  cleanupError?: string;
  canRetryCleanup: boolean;
  mergedAt?: string;
  mergedCommit?: string;
}
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
  tracking: "file-tools" | "task-metadata" | "external-effects-not-tracked";
}
interface State { version: 5; workspaces: Workspace[]; tasks: Task[]; operations: Operation[]; checkpoints?: TaskCheckpoint[]; selectedWorkspaceId?: string; selectedTaskId?: string; agentBindings: AgentBinding[]; agentAssignments: AgentAssignment[]; portLeases: PortLease[] }
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
let portLeaseQueue = Promise.resolve();
const workspaceQueues = new Map<string, Promise<void>>();
const activeChangeSets = new Map<string, { id: string; startedAt: number; lastAt: number }>();
let stateOwnerLockPath = "";
let stateOwnerClaim: Promise<void> | undefined;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 2000;

export function workbenchRoot(): string {
  return path.resolve(process.env.WORKBENCH_PATH || path.join(os.homedir(), ".chatgpt-local-coder", "workbench"));
}

function processExists(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    // Access denied means the process may be alive under another account.
    return true;
  }
}

/**
 * Workbench state is intentionally single-writer. Two MCP server processes that
 * point at the same WORKBENCH_PATH each keep an in-memory State snapshot; without
 * this ownership guard a later save from either process can resurrect deleted
 * workspaces or erase workspaces created by the other process.
 */
export async function claimWorkbenchStateOwnership(): Promise<void> {
  if (stateOwnerLockPath) return;
  if (!stateOwnerClaim) stateOwnerClaim = claimStateOwner().finally(() => { stateOwnerClaim = undefined; });
  return stateOwnerClaim;
}

async function claimStateOwner(): Promise<void> {
  const root = workbenchRoot();
  const claims = path.join(root, "owner-claims");
  await fs.mkdir(claims, { recursive: true });
  const lockPath = path.join(claims, `${process.pid}.json`);
  const owner = {
    pid: process.pid,
    port: Number(process.env.PORT || 0) || undefined,
    adminPort: Number(process.env.ADMIN_PORT || 0) || undefined,
    startedAt: new Date().toISOString(),
  };

  // Publish our PID before inspecting other claims. Concurrent contenders may
  // both refuse, but cannot both win: each observes every earlier live claim.
  // Never reclaim another PID's path, which could delete a replacement owner.
  await fs.writeFile(lockPath, JSON.stringify(owner), { mode: 0o600 });
  try {
    let legacy: { pid?: number } | undefined;
    try { legacy = JSON.parse(await fs.readFile(path.join(root, "owner.lock"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("WORKBENCH_STATE_IN_USE: legacy owner lock is unreadable; verify the previous server has stopped."); }
    const owners = (await fs.readdir(claims)).flatMap(name => /^\d+\.json$/.test(name) ? [Number(name.slice(0, -5))] : []);
    if (legacy?.pid) owners.push(legacy.pid);
    const other = owners.find(pid => pid !== process.pid && processExists(pid));
    if (other) {
      throw new Error(`WORKBENCH_STATE_IN_USE: ${root} is owned or being claimed by PID ${other}. Give each running Local Coder / Workbench instance its own WORKBENCH_PATH.`);
    }
    stateOwnerLockPath = lockPath;
  } catch (error) {
    await fs.unlink(lockPath).catch(() => {});
    throw error;
  }
}

export async function releaseWorkbenchStateOwnership(): Promise<void> {
  await stateOwnerClaim;
  const lockPath = stateOwnerLockPath;
  if (!lockPath) return;
  try { await fs.unlink(lockPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  stateOwnerLockPath = "";
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
async function workspaceAvailability(workspace: Pick<Workspace, "path">): Promise<{ availability: WorkspaceAvailability; availabilityError?: string }> {
  try {
    const stat = await fs.stat(workspace.path);
    if (stat.isDirectory()) return { availability: "ready" };
    return { availability: "unavailable", availabilityError: "Workspace path is not a directory" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { availability: "missing" };
    return { availability: "unavailable", availabilityError: error instanceof Error ? error.message : String(error) };
  }
}
async function assertWorkspaceReady(workspace: Workspace): Promise<void> {
  const status = await workspaceAvailability(workspace);
  if (status.availability === "ready") return;
  if (status.availability === "missing") {
    throw new Error(`WORKSPACE_MISSING: project folder not found at ${workspace.path}. Locate the workspace folder or remove this workspace.`);
  }
  throw new Error(`WORKSPACE_UNAVAILABLE: cannot access ${workspace.path}${status.availabilityError ? ` (${status.availabilityError})` : ""}`);
}
function remapWorkspacePath(value: string, oldRoot: string, newRoot: string): string {
  if (!path.isAbsolute(value)) return value;
  const relative = path.relative(path.resolve(oldRoot), path.resolve(value));
  if (relative === "") return newRoot;
  if (relative.startsWith("..") || path.isAbsolute(relative)) return value;
  return path.join(newRoot, relative);
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
    experience: defaultExperience(),
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

function previewUrlPort(raw?: string): number | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.port) return Number(url.port);
    if (url.protocol === "http:") return 80;
    if (url.protocol === "https:") return 443;
  } catch {}
  return undefined;
}

function taskDefaults(task: any): Task {
  task.execution ??= localExecution(task.workspace);
  if (task.execution.mode === "local") task.execution.path = task.workspace;
  task.kind ??= task.execution.mode === "worktree" ? "parallel" : "standard";
  task.lifecycle ??= "open";
  if (task.preview) {
    task.preview.autoPort ??= false;
    task.preview.port ??= previewUrlPort(task.preview.url);
  }
  return task as Task;
}

function taskAcceptsWork(task: Pick<Task, "lifecycle">): boolean {
  return task.lifecycle === "open" || task.lifecycle === "blocked";
}

function managedBranchName(title: string, taskId: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42) || "task";
  return `local-coder/${slug}-${taskId.slice(0, 8)}`;
}

async function runControlGitResult(cwd: string, args: string[], timeoutMs = 120_000, extraEnv: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["--no-pager", "-c", "core.fsmonitor=false", ...args], {
      cwd,
      windowsHide: true,
      env: { ...childEnvironment(), GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "false", GIT_SEQUENCE_EDITOR: "false", ...extraEnv },
    });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("Git environment operation timed out")); }, timeoutMs);
    child.stdout.on("data", chunk => { stdout = (stdout + chunk.toString()).slice(-200000); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-200000); });
    child.once("error", () => { clearTimeout(timer); reject(new Error("git not found. Install Git for Windows.")); });
    child.once("close", code => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function runControlGit(cwd: string, args: string[]): Promise<string> {
  const result = await runControlGitResult(cwd, args);
  if (result.code !== 0) throw new Error(result.stderr.trim() || result.stdout.trim() || `git exited with code ${result.code}`);
  return result.stdout.trim();
}

function splitGitPathLines(value: string): string[] {
  return value.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
}

async function coordinatorTaskGit(task: Task): Promise<{ branch: string; changedPaths: string[]; coverage: AgentCoordinatorView["changeCoverage"] }> {
  const cwd = taskExecutionPath(task);
  try {
    await runControlGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
    const branch = task.execution.branch || await runControlGit(cwd, ["branch", "--show-current"]);
    const commands: Array<Promise<string>> = [
      runControlGit(cwd, ["diff", "--name-only", "--cached", "--"]),
      runControlGit(cwd, ["diff", "--name-only", "--"]),
      runControlGit(cwd, ["ls-files", "--others", "--exclude-standard"]),
    ];
    let coverage: AgentCoordinatorView["changeCoverage"] = "working_tree";
    if (task.execution.baseOid) {
      commands.push(runControlGit(cwd, ["diff", "--name-only", "--diff-filter=ACDMRTUXB", `${task.execution.baseOid}..HEAD`, "--"]));
      coverage = "base_to_worktree";
    }
    const outputs = await Promise.all(commands);
    const changedPaths = [...new Set(outputs.flatMap(splitGitPathLines))].sort((a, b) => a.localeCompare(b));
    return { branch: branch || "—", changedPaths, coverage };
  } catch {
    return { branch: task.execution.branch || "—", changedPaths: [], coverage: "unavailable" };
  }
}

async function managedWorktreePath(workspaceId: string, taskId: string): Promise<string> {
  const root = path.join(path.dirname(workbenchRoot()), "worktrees", workspaceId);
  await fs.mkdir(root, { recursive: true });
  return path.join(root, taskId);
}
async function normalizeLoadedState(raw: any): Promise<State> {
  if (!raw || !Array.isArray(raw.tasks) || !Array.isArray(raw.operations)) throw new Error("Invalid workbench state");
  if ([2, 3, 4, 5].includes(raw.version) && Array.isArray(raw.workspaces)) {
    const migratedAt = new Date().toISOString();
    const next = raw as State & { version: number; sessionTasks?: Record<string, string> };
    next.version = 5;
    next.checkpoints ??= [];
    next.agentBindings ??= migrateLegacySessionTasks(next.sessionTasks, migratedAt);
    next.agentAssignments ??= [];
    next.portLeases ??= [];
    // Existing installations retain their full task UI, regardless of the new default.
    // Repair a legacy/stale label that can end up as only a drive name (for
    // example "D:") even though the workspace path points at a real project.
    // This is display metadata only; never rewrite an explicit normal name.
    for (const workspace of next.workspaces) {
      workspace.experience ??= "advanced";
      if (/^[A-Za-z]:[\\/]?$/.test(String(workspace.name || "").trim())) {
        workspace.name = workspaceNameFromPath(workspace.path);
      }
    }
    delete next.sessionTasks;
    for (const task of next.tasks) {
      const existing = next.workspaces.find(item => item.id === task.workspaceId)
        || next.workspaces.find(item => workspacePathKey(item.path) === workspacePathKey(task.workspace));
      if (existing) { task.workspaceId = existing.id; task.workspace = existing.path; }
      taskDefaults(task);
      if (task.preview) {
        delete task.preview.processId;
        delete task.preview.startedAt;
      }
    }
    next.agentBindings = next.agentBindings.filter(binding => next.tasks.some(task => task.id === binding.taskId));
    next.agentAssignments = next.agentAssignments.filter(assignment => next.tasks.some(task => task.id === assignment.taskId));
    const activeTaskIds = new Set(next.tasks.filter(task => !["archived", "completed"].includes(task.lifecycle)).map(task => task.id));
    const keptLeases: PortLease[] = [];
    const keptPorts = new Set<number>();
    for (const lease of next.portLeases) {
      const task = next.tasks.find(item => item.id === lease.taskId);
      if (!task || !activeTaskIds.has(lease.taskId) || lease.purpose !== "preview" || keptPorts.has(lease.port)) continue;
      if (await isLoopbackPortAvailable(lease.port)) {
        if (task.preview?.leaseId === lease.id) delete task.preview.leaseId;
        continue;
      }
      keptLeases.push(lease);
      keptPorts.add(lease.port);
      if (task.preview) {
        task.preview.leaseId = lease.id;
        task.preview.port = lease.port;
      }
    }
    next.portLeases = keptLeases;
    if (!next.selectedWorkspaceId && next.selectedTaskId) next.selectedWorkspaceId = next.tasks.find(item => item.id === next.selectedTaskId)?.workspaceId;
    if (!next.selectedWorkspaceId) next.selectedWorkspaceId = next.workspaces[0]?.id;
    return next as State;
  }
  if (raw.version !== 1) throw new Error("Invalid workbench state");
  const migrated: State = {
    version: 5,
    workspaces: [],
    tasks: [],
    operations: raw.operations,
    checkpoints: raw.checkpoints || [],
    selectedTaskId: raw.selectedTaskId,
    agentBindings: migrateLegacySessionTasks(raw.sessionTasks || {}),
    agentAssignments: [],
    portLeases: [],
  };
  state = migrated;
  for (const legacyTask of raw.tasks as Array<Omit<Task, "workspaceId" | "execution"> & { execution?: TaskExecution }>) {
    let root: string;
    try { root = await canonicalWorkspacePath(legacyTask.workspace); }
    catch { root = path.resolve(legacyTask.workspace); }
    const workspace = findWorkspaceByPath(root) || createWorkspaceRecord(root, workspaceNameFromPath(root), legacyTask.createdAt);
    workspace.experience = "advanced";
    migrated.tasks.push(taskDefaults({ ...legacyTask, workspace: root, workspaceId: workspace.id, execution: legacyTask.execution || localExecution(root) }));
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
      const rawState = await fs.readFile(path.join(workbenchRoot(), "state.json"), "utf8");
      // Be tolerant of UTF-8 BOMs written by Windows tooling. Normal Workbench
      // saves are BOM-free, but a BOM should never make the whole MCP server
      // fail to initialize with HTTP 500.
      state = await normalizeLoadedState(JSON.parse(rawState.replace(/^\uFEFF/, "")));
      state.checkpoints ??= [];
      for (const op of state.operations) if (["pending", "running"].includes(op.status)) {
        op.status = "interrupted";
        op.error = "Server restarted. Operation was not replayed; inspect files before retrying.";
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      state = { version: 5, workspaces: [], tasks: [], operations: [], checkpoints: [], agentBindings: [], agentAssignments: [], portLeases: [] };
      const configuredProject = process.env.WORKSPACE_PATH?.split(";")[0]?.trim().replace(/^['"]|['"]$/g, "");
      if (defaultExperience() === "basic" && configuredProject) {
        const workspace = createWorkspaceRecord(await canonicalWorkspacePath(configuredProject));
        const task = ensureBasicTask(workspace);
        state.selectedWorkspaceId = workspace.id;
        state.selectedTaskId = task.id;
      }
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
  return workspacePathsExclusive([taskExecutionPath(taskById(taskId))], fn);
}

function assertControlSession(authority: ControlAuthority): Task {
  const binding = state.agentBindings.find(item => item.sessionId === authority.sessionId && !item.closedAt);
  if (!binding || binding.taskId !== authority.taskId) throw new Error("CONTROL_SESSION_CHANGED: refresh the current task binding before changing Workbench.");
  const task = taskById(authority.taskId);
  assertTaskMutable(task);
  return task;
}

function assertControlIdle(task: Task, sessionId: string): void {
  if (state.operations.some(op => op.sessionId === sessionId && ["pending", "running"].includes(op.status))) {
    throw new Error("AGENT_TARGET_BUSY: resolve pending or running operations before changing task.");
  }
  const workspace = workspaceById(task.workspaceId);
  const tasks = workspace.experience === "basic" ? state.tasks.filter(item => item.workspaceId === workspace.id) : [task];
  if (tasks.some(item => getTaskRuntime(item.id).running || previewLeaseForTask(item.id))) {
    throw new Error("AGENT_TARGET_BUSY: stop managed processes and release preview ports before changing task.");
  }
}

// Same lock order as dashboard control: global coordination, then source workspace.
// Recheck policy under the workspace lock so a concurrent downgrade cannot race a retarget.
async function controlExclusive<T>(authority: ControlAuthority | undefined, fn: () => Promise<T>): Promise<T> {
  return exclusive(async () => {
    if (!authority) return fn(); // Authenticated local dashboard entrypoints.
    return workspaceExclusive(authority.taskId, async () => {
      const task = assertControlSession(authority);
      if (task.policy.mode !== "full" || task.policy.workspaceOnly) {
        throw new Error("CONTROL_PERMISSION_REQUIRED: workspace/task changes require Full with machine scope on the current task. Use the local dashboard, or set_policy when remote policy control is enabled.");
      }
      if (authority.requireIdle) assertControlIdle(task, authority.sessionId);
      await assertBasicWriter(task, authority.sessionId);
      return fn();
    });
  });
}

async function workspacePathsExclusive<T>(paths: string[], fn: () => Promise<T>): Promise<T> {
  await init();
  const keys = [...new Set(paths.map(value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value)))].sort();
  const locks: Array<{ key: string; gate: Promise<void>; release: () => void }> = [];
  try {
    for (const key of keys) {
      const prior = workspaceQueues.get(key) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      workspaceQueues.set(key, gate);
      await prior;
      locks.push({ key, gate, release });
    }
    return await fn();
  } finally {
    for (const lock of locks.reverse()) {
      lock.release();
      if (workspaceQueues.get(lock.key) === lock.gate) workspaceQueues.delete(lock.key);
    }
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

async function portLeaseExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const prior = portLeaseQueue;
  let release!: () => void;
  portLeaseQueue = new Promise<void>(resolve => { release = resolve; });
  await prior;
  try { return await fn(); } finally { release(); }
}

function previewLeaseForTask(taskId: string): PortLease | undefined {
  return state.portLeases.find(lease => lease.taskId === taskId && lease.purpose === "preview");
}

function removePreviewLeaseUnlocked(taskId: string): PortLease | undefined {
  const lease = previewLeaseForTask(taskId);
  if (!lease) return undefined;
  state.portLeases = state.portLeases.filter(item => item.id !== lease.id);
  const task = state.tasks.find(item => item.id === taskId);
  if (task?.preview?.leaseId === lease.id) delete task.preview.leaseId;
  return lease;
}

async function releasePreviewLeaseForCleanup(task: Task): Promise<string | undefined> {
  return portLeaseExclusive(async () => {
    const lease = previewLeaseForTask(task.id);
    if (!lease) {
      if (task.preview) {
        delete task.preview.processId;
        delete task.preview.startedAt;
        delete task.preview.leaseId;
      }
      return undefined;
    }
    if (!await waitForLoopbackPortAvailable(lease.port)) {
      return `Preview port ${lease.port} is still occupied after task processes stopped; cleanup was refused to avoid orphaning a server.`;
    }
    removePreviewLeaseUnlocked(task.id);
    if (task.preview) {
      delete task.preview.processId;
      delete task.preview.startedAt;
    }
    return undefined;
  });
}

function assertManagedIntegrationTask(task: Task): void {
  if (task.kind !== "parallel" || task.execution.mode !== "worktree" || !task.execution.managed) {
    throw new Error("INTEGRATION_UNAVAILABLE: only managed parallel worktree tasks can use the integration queue");
  }
}

function assertTaskMutable(task: Task): void {
  if (taskAcceptsWork(task)) return;
  if (task.lifecycle === "ready_to_merge") throw new Error("TASK_INTEGRATION_LOCKED: task is ready to merge; resume work before making changes");
  if (task.lifecycle === "merged") throw new Error("TASK_INTEGRATION_LOCKED: task has already been merged");
  throw new Error(`TASK_INTEGRATION_LOCKED: task lifecycle is ${task.lifecycle}`);
}

function integrationDependencyIds(task: Task): string[] {
  return [...new Set(task.integration?.dependsOnTaskIds || [])];
}

function integrationDependencyViews(task: Task): TaskIntegrationView["dependencies"] {
  return integrationDependencyIds(task).map(taskId => {
    const dependency = state.tasks.find(item => item.id === taskId);
    return {
      taskId,
      taskTitle: dependency?.title || "Missing task",
      lifecycle: dependency?.lifecycle || "archived",
      satisfied: Boolean(dependency?.integration?.mergedCommit) && ["merged", "completed"].includes(dependency?.lifecycle || ""),
    };
  });
}

function integrationTaskPriority(task: Task): number {
  if (task.lifecycle === "ready_to_merge") return 0;
  if (task.lifecycle === "blocked") return 1;
  if (task.lifecycle === "open") return 2;
  return 3;
}

function orderIntegrationTasks(tasks: Task[]): Task[] {
  const active = tasks.filter(task => task.lifecycle !== "merged");
  const activeIds = new Set(active.map(task => task.id));
  const byId = new Map(active.map(task => [task.id, task]));
  const indegree = new Map(active.map(task => [task.id, 0]));
  const dependents = new Map<string, string[]>();
  for (const task of active) {
    for (const dependencyId of integrationDependencyIds(task)) {
      if (!activeIds.has(dependencyId)) continue;
      indegree.set(task.id, (indegree.get(task.id) || 0) + 1);
      const list = dependents.get(dependencyId) || [];
      list.push(task.id);
      dependents.set(dependencyId, list);
    }
  }
  const compare = (left: Task, right: Task) => integrationTaskPriority(left) - integrationTaskPriority(right)
    || String(left.integration?.readyAt || left.createdAt).localeCompare(String(right.integration?.readyAt || right.createdAt))
    || left.title.localeCompare(right.title);
  const ready = active.filter(task => (indegree.get(task.id) || 0) === 0).sort(compare);
  const ordered: Task[] = [];
  while (ready.length) {
    const task = ready.shift()!;
    ordered.push(task);
    for (const dependentId of dependents.get(task.id) || []) {
      const next = (indegree.get(dependentId) || 0) - 1;
      indegree.set(dependentId, next);
      if (next === 0) {
        const dependent = byId.get(dependentId);
        if (dependent) { ready.push(dependent); ready.sort(compare); }
      }
    }
  }
  const remaining = active.filter(task => !ordered.some(item => item.id === task.id)).sort(compare);
  const merged = tasks.filter(task => task.lifecycle === "merged")
    .sort((a, b) => String(b.integration?.mergedAt || b.createdAt).localeCompare(String(a.integration?.mergedAt || a.createdAt)));
  return [...ordered, ...remaining, ...merged];
}

function assertIntegrationDependencies(task: Task, dependencyIds: string[]): string[] {
  assertManagedIntegrationTask(task);
  const unique = [...new Set(dependencyIds)];
  for (const dependencyId of unique) {
    if (dependencyId === task.id) throw new Error("INTEGRATION_DEPENDENCY: a task cannot depend on itself");
    const dependency = taskById(dependencyId);
    assertManagedIntegrationTask(dependency);
    if (dependency.workspaceId !== task.workspaceId) throw new Error("INTEGRATION_DEPENDENCY: dependencies must belong to the same workspace");
    if (dependency.lifecycle === "archived" || dependency.lifecycle === "completed" && !dependency.integration?.mergedCommit) {
      throw new Error(`INTEGRATION_DEPENDENCY: ${dependency.title} is not an integrated dependency`);
    }
  }
  const dependenciesFor = (taskId: string) => taskId === task.id ? unique : integrationDependencyIds(taskById(taskId));
  const reachesTask = (startId: string): boolean => {
    const seen = new Set<string>();
    const visit = (taskId: string): boolean => {
      if (taskId === task.id) return true;
      if (seen.has(taskId)) return false;
      seen.add(taskId);
      return dependenciesFor(taskId).some(visit);
    };
    return visit(startId);
  };
  if (unique.some(reachesTask)) throw new Error("INTEGRATION_DEPENDENCY_CYCLE: dependency would create a cycle");
  return unique;
}

function mergeTreeConflictPaths(output: string): string[] {
  const tokens = output.split("\0").map(value => value.trim()).filter(Boolean);
  if (tokens.length && /^[0-9a-f]{40,64}$/i.test(tokens[0])) tokens.shift();
  return [...new Set(tokens.filter(value => !/^[0-9a-f]{40,64}$/i.test(value)))].sort((a, b) => a.localeCompare(b));
}

interface IntegrationInspection {
  view: TaskIntegrationView;
  currentTargetBranch: string;
  preflightConflict: boolean;
  preflightError?: string;
}

async function inspectTaskIntegration(task: Task, preflight = false): Promise<IntegrationInspection> {
  assertManagedIntegrationTask(task);
  const sourceRoot = taskExecutionPath(task);
  const targetRoot = workspaceById(task.workspaceId).path;
  const worktreePresent = await fs.stat(sourceRoot).then(stat => stat.isDirectory()).catch(() => false);
  const unavailableSource = { code: 1, stdout: "", stderr: "Managed worktree is unavailable" };
  const [sourceHeadResult, sourceStatusResult, sourceBranchResult, targetStatusResult, currentTargetBranchResult] = await Promise.all([
    worktreePresent ? runControlGitResult(sourceRoot, ["rev-parse", "--verify", "HEAD^{commit}"]) : Promise.resolve(unavailableSource),
    worktreePresent ? runControlGitResult(sourceRoot, ["status", "--porcelain=v1", "--untracked-files=all"]) : Promise.resolve(unavailableSource),
    worktreePresent ? runControlGitResult(sourceRoot, ["branch", "--show-current"]) : Promise.resolve(unavailableSource),
    runControlGitResult(targetRoot, ["status", "--porcelain=v1", "--untracked-files=all"]),
    runControlGitResult(targetRoot, ["branch", "--show-current"]),
  ]);
  const sourceHead = sourceHeadResult.code === 0 ? sourceHeadResult.stdout.trim() : undefined;
  const branch = task.execution.branch || sourceBranchResult.stdout.trim() || "—";
  const currentTargetBranch = currentTargetBranchResult.code === 0 ? currentTargetBranchResult.stdout.trim() : "";
  const targetBranch = task.integration?.targetBranch || currentTargetBranch || task.execution.startingRef || "";
  const targetHeadResult = targetBranch
    ? await runControlGitResult(targetRoot, ["rev-parse", "--verify", `refs/heads/${targetBranch}^{commit}`])
    : { code: 1, stdout: "", stderr: "Target branch is unavailable" };
  const targetHead = targetHeadResult.code === 0 ? targetHeadResult.stdout.trim() : undefined;
  const sourceDirty = worktreePresent && (sourceStatusResult.code !== 0 || Boolean(sourceStatusResult.stdout.trim()));
  const targetDirty = targetStatusResult.code !== 0 || Boolean(targetStatusResult.stdout.trim());
  const activeOperations = state.operations.filter(operation => operation.taskId === task.id && ["pending", "running"].includes(operation.status)).length;
  const runtime = getTaskRuntime(task.id);
  const previewLease = previewLeaseForTask(task.id);
  const previewPort = task.preview?.port ?? previewLease?.port;
  const previewRunning = runtime.previews > 0;
  const git = worktreePresent ? await coordinatorTaskGit(task) : { branch: task.execution.branch || "—", changedPaths: [], coverage: "unavailable" as const };
  const dependencies = integrationDependencyViews(task);
  const unresolvedDependencyIds = dependencies.filter(item => !item.satisfied).map(item => item.taskId);

  let commitsAhead = 0;
  let commitsBehind = 0;
  if (sourceHead && targetHead) {
    const [ahead, behind] = await Promise.all([
      runControlGitResult(sourceRoot, ["rev-list", "--count", `${targetHead}..${sourceHead}`]),
      runControlGitResult(sourceRoot, ["rev-list", "--count", `${sourceHead}..${targetHead}`]),
    ]);
    if (ahead.code === 0) commitsAhead = Number.parseInt(ahead.stdout.trim(), 10) || 0;
    if (behind.code === 0) commitsBehind = Number.parseInt(behind.stdout.trim(), 10) || 0;
  }

  let conflictPaths = task.lifecycle === "blocked" ? [...(task.integration?.conflictPaths || [])] : [];
  let preflightConflict = false;
  let preflightError: string | undefined;
  if (preflight && sourceHead && targetHead) {
    const result = await runControlGitResult(targetRoot, ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", targetHead, sourceHead]);
    if (result.code === 1) {
      preflightConflict = true;
      conflictPaths = mergeTreeConflictPaths(result.stdout);
    } else if (result.code !== 0) {
      preflightError = result.stderr.trim() || result.stdout.trim() || "Merge preflight failed";
    } else {
      conflictPaths = [];
    }
  }

  const sourceChangedAfterReady = Boolean(task.integration?.readySourceHead && sourceHead && task.integration.readySourceHead !== sourceHead);
  const canMarkReady = taskAcceptsWork(task)
    && Boolean(sourceHead && targetHead && targetBranch)
    && !sourceDirty
    && activeOperations === 0
    && runtime.running === 0
    && !previewLease
    && commitsAhead > 0;
  const canMerge = task.lifecycle === "ready_to_merge"
    && Boolean(sourceHead && targetHead && targetBranch)
    && !sourceDirty
    && !targetDirty
    && activeOperations === 0
    && runtime.running === 0
    && !previewLease
    && !sourceChangedAfterReady
    && unresolvedDependencyIds.length === 0
    && currentTargetBranch === targetBranch
    && !preflightConflict
    && !preflightError;

  let reason = "Ready for integration review.";
  if (task.lifecycle === "merged") {
    const cleanup = task.integration?.cleanupStatus || "not_started";
    reason = cleanup === "completed"
      ? `Merged locally into ${targetBranch || "the target branch"}; managed worktree and branch were cleaned up.`
      : cleanup === "partial" || cleanup === "failed"
        ? `Merged locally into ${targetBranch || "the target branch"}; cleanup needs attention.`
        : `Merged locally into ${targetBranch || "the target branch"}; no push was performed.`;
  }
  else if (!sourceHead) reason = "Source branch HEAD is unavailable.";
  else if (!targetBranch) reason = "Target checkout is detached; select a target branch first.";
  else if (!targetHead) reason = `Target branch ${targetBranch} is unavailable.`;
  else if (sourceDirty) reason = "Commit or discard source worktree changes before integration.";
  else if (activeOperations) reason = `${activeOperations} operation${activeOperations === 1 ? " is" : "s are"} still pending or running.`;
  else if (runtime.running) reason = `${runtime.running} background process${runtime.running === 1 ? " is" : "es are"} still running. Stop task processes before integration.`;
  else if (previewLease) reason = `Preview port ${previewLease.port} is still leased. Stop Preview before integration.`;
  else if (commitsAhead <= 0) reason = "No unmerged task commits are available.";
  else if (sourceChangedAfterReady) reason = "Source HEAD changed after review; resume and mark the task ready again.";
  else if (task.lifecycle === "ready_to_merge" && unresolvedDependencyIds.length) {
    const names = dependencies.filter(item => !item.satisfied).map(item => item.taskTitle);
    reason = `Waiting for ${names.length} dependenc${names.length === 1 ? "y" : "ies"}: ${names.join(", ")}.`;
  }
  else if (task.lifecycle === "ready_to_merge" && currentTargetBranch !== targetBranch) reason = `Checkout ${targetBranch} in the project workspace before merging.`;
  else if (task.lifecycle === "ready_to_merge" && targetDirty) reason = "Target checkout has uncommitted changes; clean it before merging.";
  else if (preflightConflict) reason = conflictPaths.length
    ? `Merge conflict in ${conflictPaths.length} path${conflictPaths.length === 1 ? "" : "s"}. Resume work, resolve, then recheck.`
    : "Merge preflight found conflicts. Resume work, resolve, then recheck.";
  else if (preflightError) reason = `Merge preflight failed: ${preflightError}`;
  else if (task.lifecycle === "blocked") reason = task.integration?.blockedReason || "Integration is blocked; resolve the issue and recheck.";
  else if (task.lifecycle === "ready_to_merge") reason = `Ready to merge locally into ${targetBranch}. This action does not push.`;
  else reason = `${commitsAhead} commit${commitsAhead === 1 ? "" : "s"} ready for integration review.`;

  return {
    currentTargetBranch,
    preflightConflict,
    preflightError,
    view: {
      taskId: task.id,
      taskTitle: task.title,
      workspaceId: task.workspaceId,
      lifecycle: task.lifecycle,
      branch,
      targetBranch,
      baseOid: task.execution.baseOid,
      sourceHead,
      targetHead,
      readySourceHead: task.integration?.readySourceHead,
      sourceDirty,
      targetDirty,
      activeOperations,
      runningProcesses: runtime.running,
      previewPort,
      previewUrl: task.preview?.url,
      previewRunning,
      previewLeased: Boolean(previewLease),
      commitsAhead,
      commitsBehind,
      changedPaths: git.changedPaths,
      conflictPaths,
      dependencies,
      unresolvedDependencyIds,
      reason,
      canMarkReady,
      canMerge,
      canResume: task.lifecycle === "ready_to_merge" || task.lifecycle === "blocked",
      canEditDependencies: taskAcceptsWork(task),
      worktreePresent,
      cleanupStatus: task.integration?.cleanupStatus || "not_started",
      cleanupError: task.integration?.cleanupError,
      canRetryCleanup: task.lifecycle === "merged" && task.integration?.cleanupStatus !== "completed",
      mergedAt: task.integration?.mergedAt,
      mergedCommit: task.integration?.mergedCommit,
    },
  };
}

export async function getIntegrationQueue(workspaceId?: string) {
  await init();
  const resolvedWorkspaceId = workspaceId || state.selectedWorkspaceId;
  if (!resolvedWorkspaceId) return { workspaceId: null, tasks: [], summary: { total: 0, open: 0, ready: 0, blocked: 0, merged: 0, attention: 0 } };
  workspaceById(resolvedWorkspaceId);
  const tasks = state.tasks.filter(task =>
    task.workspaceId === resolvedWorkspaceId
    && task.kind === "parallel"
    && task.execution.mode === "worktree"
    && task.execution.managed
    && !["archived", "completed"].includes(task.lifecycle)
  );
  const orderedTasks = orderIntegrationTasks(tasks);
  const inspected = await Promise.all(orderedTasks.map(task => inspectTaskIntegration(task, task.lifecycle === "ready_to_merge" || task.lifecycle === "blocked")));
  const views = inspected.map(item => item.view);
  let queuePosition = 0;
  for (const view of views) if (view.lifecycle !== "merged") view.queuePosition = ++queuePosition;
  return {
    workspaceId: resolvedWorkspaceId,
    tasks: views,
    summary: {
      total: views.length,
      open: views.filter(task => task.lifecycle === "open").length,
      ready: views.filter(task => task.lifecycle === "ready_to_merge").length,
      blocked: views.filter(task => task.lifecycle === "blocked").length,
      merged: views.filter(task => task.lifecycle === "merged").length,
      attention: views.filter(task => task.lifecycle === "ready_to_merge" || task.lifecycle === "blocked" || ["partial", "failed"].includes(task.cleanupStatus)).length,
    },
  };
}

export async function setTaskIntegrationDependencies(taskId: string, dependencyIds: string[]): Promise<TaskIntegrationView> {
  return exclusive(async () => {
    const task = taskById(taskId);
    if (!taskAcceptsWork(task)) throw new Error(`INTEGRATION_STATE: resume ${task.title} before changing dependencies`);
    const validated = assertIntegrationDependencies(task, dependencyIds);
    task.integration ??= {};
    task.integration.dependsOnTaskIds = validated;
    await save({ scopes: ["tasks"], taskId: task.id, reason: "integration-dependencies-updated" });
    return (await inspectTaskIntegration(task, task.lifecycle === "blocked")).view;
  });
}

async function cleanupMergedTaskWorktree(task: Task): Promise<void> {
  assertManagedIntegrationTask(task);
  task.integration ??= {};
  const integration = task.integration;
  const targetRoot = workspaceById(task.workspaceId).path;
  const sourceRoot = taskExecutionPath(task);
  const sourceHead = integration.mergedSourceHead || integration.readySourceHead;
  const targetHead = integration.mergedCommit;
  const branch = task.execution.branch;
  const expectedSourceRoot = await managedWorktreePath(task.workspaceId, task.id);
  const attemptedAt = new Date().toISOString();
  integration.cleanupAttemptedAt = attemptedAt;
  integration.cleanupStatus = "not_started";
  delete integration.cleanupError;
  if (!sourceHead || !targetHead || !branch) {
    integration.cleanupStatus = "failed";
    integration.cleanupError = "Cleanup metadata is incomplete; the managed branch was preserved.";
    return;
  }
  if (!branch.startsWith("local-coder/")) {
    integration.cleanupStatus = "failed";
    integration.cleanupError = "Managed branch name is outside the local-coder namespace; cleanup was refused.";
    return;
  }
  if (workspacePathKey(sourceRoot) !== workspacePathKey(expectedSourceRoot) || workspacePathKey(sourceRoot) === workspacePathKey(targetRoot)) {
    integration.cleanupStatus = "failed";
    integration.cleanupError = "Managed worktree path does not match the task-owned cleanup path; automatic deletion was refused.";
    return;
  }
  const runtimeStop = await stopTaskRuntimeProcesses(task.id, true);
  if (runtimeStop.remaining.length) {
    integration.cleanupStatus = "failed";
    integration.cleanupError = `Unable to stop ${runtimeStop.remaining.length} task process${runtimeStop.remaining.length === 1 ? "" : "es"}; worktree cleanup was refused.`;
    return;
  }
  const previewCleanupError = await releasePreviewLeaseForCleanup(task);
  if (previewCleanupError) {
    integration.cleanupStatus = "failed";
    integration.cleanupError = previewCleanupError;
    return;
  }
  const ancestor = await runControlGitResult(targetRoot, ["merge-base", "--is-ancestor", sourceHead, targetHead]);
  if (ancestor.code !== 0) {
    integration.cleanupStatus = "failed";
    integration.cleanupError = "Source commit is not verified as merged into the target; cleanup was refused.";
    return;
  }
  const sourceKey = workspacePathKey(sourceRoot);
  const list = await runControlGitResult(targetRoot, ["worktree", "list", "--porcelain"]);
  if (list.code !== 0) {
    integration.cleanupStatus = "failed";
    integration.cleanupError = list.stderr.trim() || "Unable to inspect managed worktrees.";
    return;
  }
  const registered = list.stdout.split(/\r?\n/)
    .filter(line => line.startsWith("worktree "))
    .map(line => workspacePathKey(line.slice(9)))
    .includes(sourceKey);
  if (registered) {
    const remove = await runControlGitResult(targetRoot, ["worktree", "remove", sourceRoot]);
    if (remove.code !== 0) {
      integration.cleanupStatus = "failed";
      integration.cleanupError = remove.stderr.trim() || remove.stdout.trim() || "Managed worktree could not be removed.";
      return;
    }
  }
  const prune = await runControlGitResult(targetRoot, ["worktree", "prune"]);
  if (prune.code !== 0) {
    integration.cleanupStatus = "partial";
    integration.cleanupError = prune.stderr.trim() || prune.stdout.trim() || "Managed worktree metadata could not be pruned.";
    return;
  }
  const stillExists = await fs.stat(sourceRoot).then(() => true).catch(() => false);
  if (stillExists) {
    try {
      await fs.rm(sourceRoot, { recursive: true, force: true, maxRetries: 6, retryDelay: 120 });
    } catch (error) {
      integration.cleanupStatus = "failed";
      integration.cleanupError = `Managed worktree is no longer registered by Git but its task-owned directory could not be removed: ${error instanceof Error ? error.message : String(error)}`;
      return;
    }
  }
  if (await fs.stat(sourceRoot).then(() => true).catch(() => false)) {
    integration.cleanupStatus = "failed";
    integration.cleanupError = "Managed worktree directory still exists after cleanup.";
    return;
  }
  integration.worktreeRemovedAt ??= attemptedAt;
  const branchExists = await runControlGitResult(targetRoot, ["show-ref", "--verify", `refs/heads/${branch}`]);
  if (branchExists.code === 0) {
    let removeBranch = await runControlGitResult(targetRoot, ["branch", "-d", branch]);
    // The source commit was already verified as an ancestor of the merged
    // target commit above, so this is a safe branch deletion. Retry once after
    // pruning worktree metadata to handle the common Windows case where Git
    // briefly still considers the just-removed worktree/branch in use.
    if (removeBranch.code !== 0) {
      await runControlGitResult(targetRoot, ["worktree", "prune"]);
      removeBranch = await runControlGitResult(targetRoot, ["branch", "-d", branch]);
    }
    if (removeBranch.code !== 0) {
      integration.cleanupStatus = "partial";
      integration.cleanupError = removeBranch.stderr.trim() || removeBranch.stdout.trim() || "Managed branch could not be deleted safely.";
      return;
    }
  }
  const branchStillExists = await runControlGitResult(targetRoot, ["show-ref", "--verify", `refs/heads/${branch}`]);
  if (branchStillExists.code === 0) {
    integration.cleanupStatus = "partial";
    integration.cleanupError = `Managed branch ${branch} still exists after merge cleanup.`;
    return;
  }
  integration.branchDeletedAt ??= attemptedAt;
  integration.cleanupStatus = "completed";
  delete integration.cleanupError;
}

function activeIntegrationDependents(taskId: string): Task[] {
  return state.tasks.filter(task =>
    !["archived", "completed"].includes(task.lifecycle)
    && integrationDependencyIds(task).includes(taskId)
  );
}

function selectFallbackAfterTaskClose(task: Task): void {
  if (state.selectedTaskId !== task.id) return;
  state.selectedTaskId = state.tasks.find(item =>
    item.id !== task.id
    && item.workspaceId === task.workspaceId
    && taskAcceptsWork(item)
  )?.id;
}

function interruptPendingTaskOperations(task: Task, reason: string): number {
  let count = 0;
  for (const operation of state.operations) {
    if (operation.taskId !== task.id || operation.status !== "pending") continue;
    callbacks.delete(operation.id);
    operation.status = "interrupted";
    operation.error = reason;
    count++;
  }
  for (const binding of state.agentBindings) {
    if (binding.taskId !== task.id) continue;
    activeChangeSets.delete(changeSetKey(task.id, binding.sessionId));
  }
  return count;
}

async function discardManagedTaskWorktree(task: Task): Promise<void> {
  assertManagedIntegrationTask(task);
  const targetRoot = workspaceById(task.workspaceId).path;
  const sourceRoot = taskExecutionPath(task);
  const branch = task.execution.branch;
  const expectedSourceRoot = await managedWorktreePath(task.workspaceId, task.id);
  if (!branch || !branch.startsWith("local-coder/")) throw new Error("TASK_DISCARD_REFUSED: managed branch is outside the local-coder namespace");
  if (workspacePathKey(sourceRoot) !== workspacePathKey(expectedSourceRoot) || workspacePathKey(sourceRoot) === workspacePathKey(targetRoot)) {
    throw new Error("TASK_DISCARD_REFUSED: managed worktree path does not match the task-owned path");
  }
  const runtimeStop = await stopTaskRuntimeProcesses(task.id, true);
  if (runtimeStop.remaining.length) throw new Error(`TASK_DISCARD_RUNTIME: unable to stop ${runtimeStop.remaining.length} task process${runtimeStop.remaining.length === 1 ? "" : "es"}`);
  const previewCleanupError = await releasePreviewLeaseForCleanup(task);
  if (previewCleanupError) throw new Error(`TASK_DISCARD_PREVIEW: ${previewCleanupError}`);
  const list = await runControlGitResult(targetRoot, ["worktree", "list", "--porcelain"]);
  if (list.code !== 0) throw new Error(list.stderr.trim() || "TASK_DISCARD_WORKTREE: unable to inspect managed worktrees");
  const sourceKey = workspacePathKey(sourceRoot);
  const registered = list.stdout.split(/\r?\n/)
    .filter(line => line.startsWith("worktree "))
    .map(line => workspacePathKey(line.slice(9)))
    .includes(sourceKey);
  if (registered) {
    const remove = await runControlGitResult(targetRoot, ["worktree", "remove", "--force", sourceRoot]);
    if (remove.code !== 0) throw new Error(remove.stderr.trim() || remove.stdout.trim() || "TASK_DISCARD_WORKTREE: managed worktree could not be removed");
  }
  const prune = await runControlGitResult(targetRoot, ["worktree", "prune"]);
  if (prune.code !== 0) throw new Error(prune.stderr.trim() || prune.stdout.trim() || "TASK_DISCARD_WORKTREE: managed worktree metadata could not be pruned");
  if (await fs.stat(sourceRoot).then(() => true).catch(() => false)) {
    await fs.rm(sourceRoot, { recursive: true, force: true, maxRetries: 6, retryDelay: 120 });
  }
  if (await fs.stat(sourceRoot).then(() => true).catch(() => false)) throw new Error("TASK_DISCARD_WORKTREE: managed task directory still exists after cleanup");
  const branchExists = await runControlGitResult(targetRoot, ["show-ref", "--verify", `refs/heads/${branch}`]);
  if (branchExists.code === 0) {
    const removeBranch = await runControlGitResult(targetRoot, ["branch", "-D", branch]);
    if (removeBranch.code !== 0) throw new Error(removeBranch.stderr.trim() || removeBranch.stdout.trim() || "TASK_DISCARD_BRANCH: managed branch could not be deleted");
  }
}

export interface TaskFinalizationResult {
  taskId: string;
  taskTitle: string;
  lifecycle: TaskLifecycle;
  status: "finished" | "discarded" | "needs_attention";
  message: string;
  mergedCommit?: string;
  cleanupStatus?: "not_started" | "completed" | "partial" | "failed";
}

export async function completeTask(taskId: string): Promise<TaskFinalizationResult> {
  await init();
  const initial = taskById(taskId);
  if (initial.lifecycle === "completed") {
    return {
      taskId: initial.id,
      taskTitle: initial.title,
      lifecycle: initial.lifecycle,
      status: "finished",
      message: `${initial.title} is already completed.`,
      mergedCommit: initial.integration?.mergedCommit,
      cleanupStatus: initial.integration?.cleanupStatus,
    };
  }
  if (initial.lifecycle === "archived") throw new Error(`TASK_COMPLETE_STATE: ${initial.title} was discarded and cannot be completed`);

  const managedParallel = initial.kind === "parallel" && initial.execution.mode === "worktree" && initial.execution.managed;
  if (managedParallel) {
    if (initial.lifecycle === "merged") return finishTaskIntegration(taskId);
    throw new Error(`TASK_COMPLETE_INTEGRATION_REQUIRED: ${initial.title} uses a managed worktree. Integrate and merge it in Workbench before marking the task completed; task_complete never merges code automatically.`);
  }

  return workspaceExclusive(taskId, async () => {
    const task = taskById(taskId);
    if (task.lifecycle === "completed") {
      return { taskId: task.id, taskTitle: task.title, lifecycle: task.lifecycle, status: "finished" as const, message: `${task.title} is already completed.` };
    }
    if (!taskAcceptsWork(task)) throw new Error(`TASK_COMPLETE_STATE: ${task.title} cannot be completed from lifecycle ${task.lifecycle}`);
    const runtime = getTaskRuntime(task.id);
    if (runtime.running) throw new Error(`TASK_COMPLETE_RUNTIME: stop ${runtime.running} running task process${runtime.running === 1 ? "" : "es"} before completing ${task.title}`);
    const previewLease = previewLeaseForTask(task.id);
    if (previewLease) throw new Error(`TASK_COMPLETE_PREVIEW: stop Preview and release port ${previewLease.port} before completing ${task.title}`);
    const activeOperations = state.operations.filter(operation => operation.taskId === task.id && ["pending", "running"].includes(operation.status));
    if (activeOperations.length) throw new Error(`TASK_COMPLETE_OPERATIONS: resolve ${activeOperations.length} pending or running operation${activeOperations.length === 1 ? "" : "s"} before completing ${task.title}`);

    const completedAt = new Date().toISOString();
    task.lifecycle = "completed";
    task.completedAt ??= completedAt;
    cancelAssignment(state, task.id);
    const workspace = workspaceById(task.workspaceId);
    if (workspace.experience === "basic" && workspace.basicTaskId === task.id) {
      delete workspace.writer;
      workspace.basicTaskId = undefined;
      const replacement = ensureBasicTask(workspace);
      if (state.selectedTaskId === task.id) state.selectedTaskId = replacement.id;
    } else {
      selectFallbackAfterTaskClose(task);
    }
    await save({ scopes: ["tasks", "workspace"], taskId: task.id, reason: "task-completed-by-chatgpt" });
    return {
      taskId: task.id,
      taskTitle: task.title,
      lifecycle: task.lifecycle,
      status: "finished" as const,
      message: `${task.title} was marked completed from the ChatGPT conversation.`,
    };
  });
}

export async function finishTaskIntegration(taskId: string): Promise<TaskFinalizationResult> {
  await init();
  let task = taskById(taskId);
  assertManagedIntegrationTask(task);
  if (task.lifecycle === "completed") {
    return { taskId: task.id, taskTitle: task.title, lifecycle: task.lifecycle, status: "finished", message: `${task.title} is already finished.`, mergedCommit: task.integration?.mergedCommit, cleanupStatus: task.integration?.cleanupStatus };
  }
  if (task.lifecycle === "ready_to_merge") {
    const merged = await mergeTaskIntegration(taskId);
    if (merged.lifecycle !== "merged") {
      return { taskId, taskTitle: task.title, lifecycle: merged.lifecycle, status: "needs_attention", message: merged.reason, mergedCommit: merged.mergedCommit, cleanupStatus: merged.cleanupStatus };
    }
  }
  task = taskById(taskId);
  if (task.lifecycle !== "merged") throw new Error(`TASK_FINISH_STATE: mark ${task.title} ready before integrating and finishing it`);
  if (task.integration?.cleanupStatus !== "completed") await cleanupTaskIntegration(taskId);
  task = taskById(taskId);
  if (task.integration?.cleanupStatus !== "completed") {
    return {
      taskId: task.id,
      taskTitle: task.title,
      lifecycle: task.lifecycle,
      status: "needs_attention",
      message: task.integration?.cleanupError || "The merge completed, but managed cleanup still needs attention.",
      mergedCommit: task.integration?.mergedCommit,
      cleanupStatus: task.integration?.cleanupStatus,
    };
  }
  return exclusive(async () => {
    const current = taskById(taskId);
    if (current.lifecycle !== "merged" && current.lifecycle !== "completed") throw new Error(`TASK_FINISH_STATE: task cannot finish from ${current.lifecycle}`);
    current.lifecycle = "completed";
    current.completedAt ??= new Date().toISOString();
    current.integration ??= {};
    current.integration.finishedAt ??= new Date().toISOString();
    cancelAssignment(state, current.id);
    selectFallbackAfterTaskClose(current);
    await save({ scopes: ["tasks", "workspace", "operations"], taskId: current.id, reason: "task-finished" });
    return {
      taskId: current.id,
      taskTitle: current.title,
      lifecycle: current.lifecycle,
      status: "finished" as const,
      message: `${current.title} was merged locally, cleaned up, and finished.`,
      mergedCommit: current.integration.mergedCommit,
      cleanupStatus: current.integration.cleanupStatus,
    };
  });
}

export async function discardTaskIntegration(taskId: string): Promise<TaskFinalizationResult> {
  await init();
  const initial = taskById(taskId);
  assertManagedIntegrationTask(initial);
  if (initial.lifecycle === "archived") {
    return { taskId: initial.id, taskTitle: initial.title, lifecycle: initial.lifecycle, status: "discarded", message: `${initial.title} is already discarded.` };
  }
  if (["merged", "completed"].includes(initial.lifecycle)) throw new Error("TASK_DISCARD_STATE: merged or finished work cannot be discarded");
  const targetRoot = workspaceById(initial.workspaceId).path;
  return workspacePathsExclusive([taskExecutionPath(initial), targetRoot], async () => {
    const task = taskById(taskId);
    const dependents = activeIntegrationDependents(task.id);
    if (dependents.length) throw new Error(`TASK_DISCARD_DEPENDENCY: remove ${task.title} from the dependencies of ${dependents.map(item => item.title).join(", ")} before discarding it`);
    await discardManagedTaskWorktree(task);
    interruptPendingTaskOperations(task, "Task was discarded before this operation was approved.");
    cancelAssignment(state, task.id);
    task.lifecycle = "archived";
    task.integration ??= {};
    task.integration.discardedAt ??= new Date().toISOString();
    selectFallbackAfterTaskClose(task);
    await save({ scopes: ["tasks", "workspace", "operations"], taskId: task.id, reason: "task-discarded" });
    return {
      taskId: task.id,
      taskTitle: task.title,
      lifecycle: task.lifecycle,
      status: "discarded" as const,
      message: `${task.title} was discarded; its task-owned worktree and branch were removed.`,
    };
  });
}

export async function markTaskReadyForMerge(taskId: string): Promise<TaskIntegrationView> {
  await init();
  const initial = taskById(taskId);
  assertManagedIntegrationTask(initial);
  const targetRoot = workspaceById(initial.workspaceId).path;
  return workspacePathsExclusive([taskExecutionPath(initial), targetRoot], async () => {
    const task = taskById(taskId);
    if (!taskAcceptsWork(task)) throw new Error(`INTEGRATION_STATE: task cannot be marked ready from ${task.lifecycle}`);
    const inspection = await inspectTaskIntegration(task, true);
    if (!inspection.view.canMarkReady) throw new Error(`INTEGRATION_NOT_READY: ${inspection.view.reason}`);
    task.integration ??= {};
    task.integration.targetBranch = inspection.view.targetBranch;
    if (inspection.preflightConflict || inspection.preflightError) {
      task.lifecycle = "blocked";
      task.integration.blockedAt = new Date().toISOString();
      task.integration.blockedReason = inspection.preflightError
        ? `Merge preflight failed: ${inspection.preflightError}`
        : inspection.view.conflictPaths.length
          ? `Merge conflict in ${inspection.view.conflictPaths.join(", ")}`
          : "Merge preflight found conflicts";
      task.integration.conflictPaths = [...inspection.view.conflictPaths];
      delete task.integration.readyAt;
      delete task.integration.readySourceHead;
      delete task.integration.readyTargetHead;
      cancelAssignment(state, task.id);
      await save({ scopes: ["tasks", "workspace"], taskId: task.id, reason: "integration-blocked" });
      return (await inspectTaskIntegration(task, true)).view;
    }
    task.lifecycle = "ready_to_merge";
    task.integration.readyAt = new Date().toISOString();
    task.integration.readySourceHead = inspection.view.sourceHead;
    task.integration.readyTargetHead = inspection.view.targetHead;
    delete task.integration.blockedAt;
    delete task.integration.blockedReason;
    delete task.integration.conflictPaths;
    cancelAssignment(state, task.id);
    await save({ scopes: ["tasks"], taskId: task.id, reason: "integration-ready" });
    return (await inspectTaskIntegration(task, true)).view;
  });
}

export async function reopenTaskIntegration(taskId: string): Promise<TaskIntegrationView> {
  await init();
  const initial = taskById(taskId);
  assertManagedIntegrationTask(initial);
  return workspaceExclusive(taskId, async () => {
    const task = taskById(taskId);
    if (task.lifecycle !== "ready_to_merge" && task.lifecycle !== "blocked") throw new Error(`INTEGRATION_STATE: task cannot resume from ${task.lifecycle}`);
    const targetBranch = task.integration?.targetBranch;
    const dependsOnTaskIds = integrationDependencyIds(task);
    task.lifecycle = "open";
    task.integration = targetBranch || dependsOnTaskIds.length
      ? { ...(targetBranch ? { targetBranch } : {}), ...(dependsOnTaskIds.length ? { dependsOnTaskIds } : {}) }
      : undefined;
    await save({ scopes: ["tasks"], taskId: task.id, reason: "integration-resumed" });
    return (await inspectTaskIntegration(task, false)).view;
  });
}

export async function mergeTaskIntegration(taskId: string): Promise<TaskIntegrationView> {
  await init();
  const initial = taskById(taskId);
  assertManagedIntegrationTask(initial);
  const targetRoot = workspaceById(initial.workspaceId).path;
  return workspacePathsExclusive([taskExecutionPath(initial), targetRoot], async () => {
    const task = taskById(taskId);
    if (task.lifecycle !== "ready_to_merge") throw new Error(`INTEGRATION_STATE: task cannot merge from ${task.lifecycle}`);
    const inspection = await inspectTaskIntegration(task, true);
    task.integration ??= { targetBranch: inspection.view.targetBranch };
    if (inspection.preflightConflict || inspection.preflightError) {
      task.lifecycle = "blocked";
      task.integration.blockedAt = new Date().toISOString();
      task.integration.blockedReason = inspection.preflightError
        ? `Merge preflight failed: ${inspection.preflightError}`
        : inspection.view.conflictPaths.length
          ? `Merge conflict in ${inspection.view.conflictPaths.join(", ")}`
          : "Merge preflight found conflicts";
      task.integration.conflictPaths = [...inspection.view.conflictPaths];
      await save({ scopes: ["tasks", "workspace"], taskId: task.id, reason: "integration-blocked" });
      return (await inspectTaskIntegration(task, true)).view;
    }
    if (!inspection.view.canMerge) throw new Error(`INTEGRATION_NOT_MERGEABLE: ${inspection.view.reason}`);
    const sourceHead = inspection.view.sourceHead!;
    const targetHeadBeforeMerge = inspection.view.targetHead!;
    const result = await runControlGitResult(targetRoot, ["merge", "--no-edit", sourceHead]);
    if (result.code !== 0) {
      await runControlGitResult(targetRoot, ["merge", "--abort"]).catch(() => ({ code: 1, stdout: "", stderr: "" }));
      task.lifecycle = "blocked";
      task.integration.blockedAt = new Date().toISOString();
      task.integration.blockedReason = `Merge failed: ${result.stderr.trim() || result.stdout.trim() || `git exited with code ${result.code}`}`;
      task.integration.conflictPaths = [];
      await save({ scopes: ["tasks", "workspace"], taskId: task.id, reason: "integration-merge-failed" });
      return (await inspectTaskIntegration(task, false)).view;
    }
    const mergedCommit = await runControlGit(targetRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
    task.lifecycle = "merged";
    task.integration.mergedAt = new Date().toISOString();
    task.integration.mergedCommit = mergedCommit;
    task.integration.mergedSourceHead = sourceHead;
    task.integration.targetHeadBeforeMerge = targetHeadBeforeMerge;
    delete task.integration.blockedAt;
    delete task.integration.blockedReason;
    delete task.integration.conflictPaths;
    cancelAssignment(state, task.id);
    if (state.selectedTaskId === task.id) {
      state.selectedTaskId = state.tasks.find(item => item.id !== task.id && item.workspaceId === task.workspaceId && taskAcceptsWork(item))?.id;
    }
    // Persist the successful merge before cleanup. Worktree cleanup is best-effort
    // and must never make a completed merge look unmerged after a Windows lock/error.
    await save({ scopes: ["tasks", "workspace"], taskId: task.id, reason: "integration-merged" });
    try {
      await cleanupMergedTaskWorktree(task);
    } catch (error) {
      task.integration.cleanupStatus = "failed";
      task.integration.cleanupAttemptedAt = new Date().toISOString();
      task.integration.cleanupError = error instanceof Error ? error.message : String(error);
    }
    await save({
      scopes: ["tasks", "workspace"],
      taskId: task.id,
      reason: task.integration.cleanupStatus === "completed" ? "integration-cleanup-completed" : "integration-cleanup-attention",
    });
    return (await inspectTaskIntegration(task, false)).view;
  });
}

export async function cleanupTaskIntegration(taskId: string): Promise<TaskIntegrationView> {
  await init();
  const initial = taskById(taskId);
  assertManagedIntegrationTask(initial);
  const targetRoot = workspaceById(initial.workspaceId).path;
  return workspacePathsExclusive([taskExecutionPath(initial), targetRoot], async () => {
    const task = taskById(taskId);
    if (task.lifecycle !== "merged") throw new Error(`INTEGRATION_STATE: cleanup is only available after merge, not ${task.lifecycle}`);
    try {
      await cleanupMergedTaskWorktree(task);
    } catch (error) {
      task.integration ??= {};
      task.integration.cleanupStatus = "failed";
      task.integration.cleanupAttemptedAt = new Date().toISOString();
      task.integration.cleanupError = error instanceof Error ? error.message : String(error);
    }
    await save({
      scopes: ["tasks", "workspace"],
      taskId: task.id,
      reason: task.integration?.cleanupStatus === "completed" ? "integration-cleanup-completed" : "integration-cleanup-attention",
    });
    return (await inspectTaskIntegration(task, false)).view;
  });
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
function basicTask(workspace: Workspace): Task | undefined {
  const candidates = state.tasks.filter(task => task.workspaceId === workspace.id
    && task.kind === "standard" && task.execution.mode === "local" && taskAcceptsWork(task));
  return candidates.find(task => task.id === workspace.basicTaskId)
    || candidates.find(task => task.id === state.selectedTaskId)
    || candidates[0];
}

function ensureBasicTask(workspace: Workspace): Task {
  let task = basicTask(workspace);
  if (!task) {
    const mode: PermissionMode = process.env.WORKBENCH_DEFAULT_MODE === "full" ? "full"
      : process.env.WORKBENCH_DEFAULT_MODE === "auto" ? "auto" : "ask";
    task = {
      id: randomUUID(), workspaceId: workspace.id, title: "Default project", workspace: workspace.path,
      execution: localExecution(workspace.path), kind: "standard", lifecycle: "open",
      createdAt: new Date().toISOString(), policy: { mode, workspaceOnly: mode !== "full", revision: 1 },
    };
    state.tasks.push(task);
  }
  workspace.basicTaskId = task.id;
  return task;
}

function createLocalControlTask(workspace: Workspace, title = "Default project", description?: string): Task {
  const mode: PermissionMode = process.env.WORKBENCH_DEFAULT_MODE === "full" ? "full"
    : process.env.WORKBENCH_DEFAULT_MODE === "auto" ? "auto" : "ask";
  const normalizedDescription = description?.trim().slice(0, 4000) || undefined;
  const task: Task = {
    id: randomUUID(), workspaceId: workspace.id, title: title.trim().slice(0, 200) || "Default project",
    ...(normalizedDescription ? { description: normalizedDescription } : {}),
    workspace: workspace.path, execution: localExecution(workspace.path), createdAt: new Date().toISOString(),
    policy: { mode, workspaceOnly: mode !== "full", revision: 1 }, kind: "standard", lifecycle: "open",
  };
  state.tasks.push(task);
  return task;
}

function experienceSessionIsLive(session: AgentSessionSnapshot): boolean {
  return session.active || session.connected || session.inFlightRequests > 0;
}

function experienceBindingIsLive(binding: AgentBinding, sessions?: AgentSessionSnapshot[]): boolean {
  if (!sessions) return !binding.closedAt;
  return sessions.some(session => session.id === binding.sessionId && experienceSessionIsLive(session));
}

function experienceView(workspace: Workspace, sessions?: AgentSessionSnapshot[]) {
  const defaultTask = basicTask(workspace);
  const tasks = state.tasks.filter(task => task.workspaceId === workspace.id);
  const ids = new Set(tasks.map(task => task.id));
  const blockers: Array<{ taskId?: string; message: string }> = [];
  for (const task of tasks) {
    const runtime = getTaskRuntime(task.id);
    const activeParallel = (task.kind === "parallel" || task.execution.mode === "worktree")
      && (!["completed", "archived", "merged"].includes(task.lifecycle)
        || task.lifecycle === "merged" && task.integration?.cleanupStatus !== "completed");
    if (activeParallel) blockers.push({ taskId: task.id, message: `${task.title}: finish or discard this parallel task first.` });
    if (runtime.running || previewLeaseForTask(task.id)) {
      blockers.push({ taskId: task.id, message: `${task.title}: stop its processes and release its preview port first.` });
    }
    if (state.operations.some(op => op.taskId === task.id && ["pending", "running"].includes(op.status))) {
      blockers.push({ taskId: task.id, message: `${task.title}: resolve pending approvals and wait for running work.` });
    }
    if (task.id !== defaultTask?.id && state.agentBindings.some(binding => binding.taskId === task.id && experienceBindingIsLive(binding, sessions))
      && taskAcceptsWork(task)) {
      blockers.push({ taskId: task.id, message: `${task.title}: another task still has a connected session.` });
    }
  }
  if (state.agentAssignments.some(item => ids.has(item.taskId))) {
    blockers.push({ message: "Cancel queued agent assignments before switching to Basic." });
  }
  const bindings = state.agentBindings.filter(binding => binding.taskId === defaultTask?.id && experienceBindingIsLive(binding, sessions));
  return {
    mode: workspace.experience,
    basicTaskId: defaultTask?.id,
    canSwitchToBasic: workspace.experience === "basic" || blockers.length === 0,
    blockers: workspace.experience === "basic" ? [] : blockers,
    writer: workspace.writer ? { ...workspace.writer } : null,
    runningProcesses: tasks.reduce((sum, task) => sum + getTaskRuntime(task.id).running, 0),
    previewLeased: state.portLeases.some(lease => ids.has(lease.taskId)),
    sessions: bindings.map((binding, index) => ({
      sessionId: binding.sessionId,
      label: `${binding.clientType === "chatgpt" ? "ChatGPT" : "MCP client"} ${index + 1}`,
      closed: Boolean(binding.closedAt),
      createdAt: binding.createdAt,
      isWriter: workspace.writer?.sessionId === binding.sessionId,
    })),
  };
}

export async function getWorkspaceExperience(workspaceId: string, sessions?: AgentSessionSnapshot[]) {
  await init();
  return experienceView(workspaceById(workspaceId), sessions);
}

export async function setWorkspaceExperience(workspaceId: string, mode: ExperienceMode, sessions?: AgentSessionSnapshot[]) {
  return exclusive(async () => {
    const workspace = workspaceById(workspaceId);
    await assertWorkspaceReady(workspace);
    const tasks = state.tasks.filter(task => task.workspaceId === workspace.id);
    return workspacePathsExclusive([workspace.path, ...tasks.map(taskExecutionPath)], async () => {
      if (workspace.experience === mode) return experienceView(workspace, sessions);
      if (mode === "basic") {
        const view = experienceView(workspace, sessions);
        if (!view.canSwitchToBasic) throw new Error(`EXPERIENCE_BUSY: ${view.blockers.map(item => item.message).join(" ")}`);
        const task = ensureBasicTask(workspace);
        if (state.selectedWorkspaceId === workspace.id) state.selectedTaskId = task.id;
      }
      // The approved experience change must not replay stale coordination decisions.
      for (const task of tasks) interruptPendingTaskOperations(task, "Experience changed; request this operation again.");
      workspace.experience = mode;
      delete workspace.writer;
      await save({ scopes: ["state"], reason: "experience-changed" });
      return experienceView(workspace, sessions);
    });
  });
}

export async function takeWorkspaceWriter(workspaceId: string, sessionId: string, expectedSessionId: string | null, sessions?: AgentSessionSnapshot[]) {
  return exclusive(async () => {
    const workspace = workspaceById(workspaceId);
    return workspacePathsExclusive([workspace.path], async () => {
      if (workspace.experience !== "basic") throw new Error("WRITER_MODE: writer control is only used in Basic.");
      if ((workspace.writer?.sessionId || null) !== expectedSessionId) throw new Error("WRITER_CHANGED: control changed; refresh before taking control.");
      const task = ensureBasicTask(workspace);
      const binding = state.agentBindings.find(item => item.sessionId === sessionId && item.taskId === task.id && experienceBindingIsLive(item, sessions));
      if (!binding) throw new Error("WRITER_SESSION: choose an open session for this project.");
      if (workspace.writer?.sessionId === sessionId) return experienceView(workspace, sessions);
      const view = experienceView(workspace, sessions);
      if (view.runningProcesses || view.previewLeased) throw new Error("WRITER_BUSY: stop the project's managed processes and preview before transferring control.");
      interruptPendingTaskOperations(task, "Write control was transferred. Request this operation again from the current writer.");
      workspace.writer = { sessionId, acquiredAt: new Date().toISOString() };
      await save({ scopes: ["tasks", "operations"], taskId: task.id, reason: "writer-transferred" });
      return experienceView(workspace, sessions);
    });
  });
}

async function assertBasicWriter(task: Task, sessionId?: string): Promise<void> {
  const workspace = workspaceById(task.workspaceId);
  if (workspace.experience !== "basic") return;
  if (task.id !== workspace.basicTaskId) throw new Error("BASIC_TASK: this session belongs to another task; switch this project to Advanced to continue editing it.");
  if (!sessionId) throw new Error("BASIC_SESSION: writing in Basic requires a bound MCP session.");
  if (workspace.writer && workspace.writer.sessionId !== sessionId) {
    throw new Error("WRITER_REQUIRED: another conversation controls project changes. Reads remain available. Select this conversation under ChatGPT write control in the local Workbench, then retry. Do not change tools to bypass this restriction.");
  }
  if (!workspace.writer) {
    workspace.writer = { sessionId, acquiredAt: new Date().toISOString() };
    await save({ scopes: ["tasks"], taskId: task.id, reason: "writer-acquired" });
  }
}

export async function getWorkbench(sessions?: AgentSessionSnapshot[]) {
  await init();
  const sandbox = await getSandboxStatus();
  const workspaces = await Promise.all(state.workspaces.map(async workspace => ({
    ...structuredClone(workspace),
    ...await workspaceAvailability(workspace),
  })));
  return {
    workspaces,
    selectedWorkspaceId: state.selectedWorkspaceId,
    selectedTaskId: state.selectedTaskId,
    tasks: structuredClone(state.tasks),
    agentBindings: structuredClone(state.agentBindings),
    agentAssignments: structuredClone(state.agentAssignments),
    portLeases: structuredClone(state.portLeases),
    experiences: Object.fromEntries(state.workspaces.map(workspace => [workspace.id, experienceView(workspace, sessions)])),
    operations: state.operations.map(publicOperation).reverse(),
    capabilities: { osSandbox: sandbox.available, sandbox, fileUndo: true, shellUndo: false, approvalReviewer: "rules", chatgptWidget: false,
      remotePolicyControl: remotePolicyControlEnabled(), credentialContentFilter: false },
  };
}

function coordinatorStatus(session: AgentSessionSnapshot): AgentCoordinatorStatus {
  const operations = state.operations.filter(operation => operation.sessionId === session.id);
  if (operations.some(operation => operation.status === "pending")) return "approval_required";
  if (operations.some(operation => operation.status === "running") || session.inFlightRequests > 0 || session.state === "working") return "working";
  if (session.connected || session.state === "connected") return "connected";
  if (session.active || session.state === "recent") return "recent";
  return "dormant";
}

function addCoordinatorConflict(target: Map<string, AgentCoordinatorConflict[]>, taskId: string, conflict: AgentCoordinatorConflict): void {
  const list = target.get(taskId) || [];
  const key = `${conflict.type}:${conflict.withTaskId || ""}:${conflict.withAgentId || ""}:${(conflict.paths || []).join("|")}`;
  if (!list.some(item => `${item.type}:${item.withTaskId || ""}:${item.withAgentId || ""}:${(item.paths || []).join("|")}` === key)) list.push(conflict);
  target.set(taskId, list);
}

export async function getAgentCoordinator(sessions: AgentSessionSnapshot[] = []) {
  await init();
  const chatGptSessions = sessions.filter(session => session.clientType === "chatgpt");
  const relevantTaskIds = new Set<string>([
    ...chatGptSessions.map(session => session.taskId),
    ...state.agentAssignments.map(assignment => assignment.taskId),
  ]);
  const tasks = state.tasks.filter(task => !["archived", "completed"].includes(task.lifecycle) && relevantTaskIds.has(task.id));
  const taskByIdMap = new Map(tasks.map(task => [task.id, task]));
  const gitPairs = await Promise.all(tasks.map(async task => [task.id, await coordinatorTaskGit(task)] as const));
  const gitByTask = new Map(gitPairs);
  const conflictsByTask = new Map<string, AgentCoordinatorConflict[]>();

  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const left = tasks[i], right = tasks[j];
      if (left.workspaceId !== right.workspaceId) continue;
      const leftGit = gitByTask.get(left.id)!;
      const rightGit = gitByTask.get(right.id)!;
      const rightPaths = new Set(rightGit.changedPaths);
      const overlap = leftGit.changedPaths.filter(pathValue => rightPaths.has(pathValue));
      if (overlap.length) {
        addCoordinatorConflict(conflictsByTask, left.id, {
          type: "path_overlap", severity: "conflict", withTaskId: right.id, withTaskTitle: right.title, paths: overlap,
          message: `${overlap.length} changed path${overlap.length === 1 ? "" : "s"} also changed by ${right.title}.`,
        });
        addCoordinatorConflict(conflictsByTask, right.id, {
          type: "path_overlap", severity: "conflict", withTaskId: left.id, withTaskTitle: left.title, paths: overlap,
          message: `${overlap.length} changed path${overlap.length === 1 ? "" : "s"} also changed by ${left.title}.`,
        });
      }
      if (workspacePathKey(taskExecutionPath(left)) === workspacePathKey(taskExecutionPath(right))) {
        addCoordinatorConflict(conflictsByTask, left.id, {
          type: "shared_environment", severity: "warning", withTaskId: right.id, withTaskTitle: right.title,
          message: `Shares the same checkout with ${right.title}; concurrent edits are not isolated.`,
        });
        addCoordinatorConflict(conflictsByTask, right.id, {
          type: "shared_environment", severity: "warning", withTaskId: left.id, withTaskTitle: left.title,
          message: `Shares the same checkout with ${left.title}; concurrent edits are not isolated.`,
        });
      }
    }
  }

  const activeSessionsByTask = new Map<string, AgentSessionSnapshot[]>();
  for (const session of chatGptSessions.filter(session => session.active || session.connected || session.inFlightRequests > 0)) {
    const list = activeSessionsByTask.get(session.taskId) || [];
    list.push(session);
    activeSessionsByTask.set(session.taskId, list);
  }
  for (const [taskId, taskSessions] of activeSessionsByTask) {
    if (taskSessions.length < 2) continue;
    for (const session of taskSessions) {
      const other = taskSessions.find(item => item.id !== session.id);
      if (!other) continue;
      const otherBinding = state.agentBindings.find(binding => binding.sessionId === other.id);
      addCoordinatorConflict(conflictsByTask, taskId, {
        type: "shared_task", severity: "warning", withAgentId: otherBinding?.agentId,
        message: `${taskSessions.length} active ChatGPT sessions share this task and worktree.`,
      });
    }
  }

  const agents: AgentCoordinatorView[] = [];
  for (const session of chatGptSessions) {
    const task = taskByIdMap.get(session.taskId);
    if (!task) continue;
    const binding = state.agentBindings.find(item => item.sessionId === session.id);
    const git = gitByTask.get(task.id)!;
    const runtime = getTaskRuntime(task.id);
    agents.push({
      id: binding?.agentId || `session:${session.id}`,
      agentId: binding?.agentId,
      bindingId: binding?.id,
      sessionId: session.id,
      taskId: task.id,
      taskTitle: task.title,
      taskKind: task.kind,
      taskLifecycle: task.lifecycle,
      workspaceId: task.workspaceId,
      workspace: task.workspace,
      executionPath: taskExecutionPath(task),
      branch: git.branch,
      baseOid: task.execution.baseOid,
      clientInfo: session.clientInfo,
      status: coordinatorStatus(session),
      active: session.active || session.connected || session.inFlightRequests > 0,
      queued: false,
      createdAt: binding?.createdAt || session.createdAt,
      lastSeenAt: session.lastAccessedAt,
      changedPaths: git.changedPaths,
      changeCoverage: git.coverage,
      previewPort: task.preview?.port,
      previewUrl: task.preview?.url,
      previewRunning: runtime.previews > 0,
      conflicts: structuredClone(conflictsByTask.get(task.id) || []),
    });
  }
  for (const assignment of state.agentAssignments) {
    const task = taskByIdMap.get(assignment.taskId);
    if (!task) continue;
    const git = gitByTask.get(task.id)!;
    const runtime = getTaskRuntime(task.id);
    agents.push({
      id: `assignment:${assignment.id}`,
      assignmentId: assignment.id,
      taskId: task.id,
      taskTitle: task.title,
      taskKind: task.kind,
      taskLifecycle: task.lifecycle,
      workspaceId: task.workspaceId,
      workspace: task.workspace,
      executionPath: taskExecutionPath(task),
      branch: git.branch,
      baseOid: task.execution.baseOid,
      status: "waiting",
      active: false,
      queued: true,
      createdAt: assignment.createdAt,
      changedPaths: git.changedPaths,
      changeCoverage: git.coverage,
      previewPort: task.preview?.port,
      previewUrl: task.preview?.url,
      previewRunning: runtime.previews > 0,
      conflicts: structuredClone(conflictsByTask.get(task.id) || []),
    });
  }
  agents.sort((a, b) => {
    const priority = (value: AgentCoordinatorView) => value.status === "working" ? 0 : value.status === "approval_required" ? 1 : value.active ? 2 : value.queued ? 3 : 4;
    return priority(a) - priority(b) || String(b.lastSeenAt || b.createdAt).localeCompare(String(a.lastSeenAt || a.createdAt));
  });
  const conflictAgents = agents.filter(agent => agent.conflicts.some(conflict => conflict.severity === "conflict"));
  return {
    agents,
    summary: {
      active: agents.filter(agent => agent.active).length,
      waiting: agents.filter(agent => agent.queued).length,
      dormant: agents.filter(agent => !agent.active && !agent.queued).length,
      conflicts: conflictAgents.length,
    },
  };
}
export async function createWorkspace(name: string, workspacePath: string): Promise<Workspace> {
  return exclusive(async () => {
    const root = await canonicalWorkspacePath(workspacePath);
    if (workspacePathKey(root) === workspacePathKey(workbenchRoot())) throw new Error("Workbench control directory cannot be added as a workspace");
    if (findWorkspaceByPath(root)) throw new Error("Workspace already added");
    const workspace = createWorkspaceRecord(root, name);
    if (workspace.experience === "basic") ensureBasicTask(workspace);
    state.selectedWorkspaceId ??= workspace.id;
    await save({ scopes: ["workspaces"], reason: "workspace-created" });
    return structuredClone(workspace);
  });
}

export async function relocateWorkspace(id: string, workspacePath: string, sessions?: AgentSessionSnapshot[]) {
  return exclusive(async () => {
    const workspace = workspaceById(id);
    const oldRoot = workspace.path;
    const root = await canonicalWorkspacePath(workspacePath);
    if (workspacePathKey(root) === workspacePathKey(workbenchRoot())) throw new Error("Workbench control directory cannot be used as a workspace");
    const duplicate = findWorkspaceByPath(root);
    if (duplicate && duplicate.id !== workspace.id) throw new Error(`WORKSPACE_ALREADY_ADDED: ${root} is already registered as ${duplicate.name}`);
    if (workspacePathKey(root) === workspacePathKey(oldRoot)) {
      return { workspace: { ...structuredClone(workspace), ...await workspaceAvailability(workspace) }, updatedTasks: 0, remappedChanges: 0 };
    }

    const tasks = state.tasks.filter(task => task.workspaceId === workspace.id);
    return workspacePathsExclusive([oldRoot, root, ...tasks.map(taskExecutionPath)], async () => {
      const blockers: string[] = [];
      for (const task of tasks) {
        const runtime = getTaskRuntime(task.id);
        if (runtime.running) blockers.push(`${task.title}: stop ${runtime.running} running process${runtime.running === 1 ? "" : "es"} first.`);
        if (previewLeaseForTask(task.id)) blockers.push(`${task.title}: stop Preview and release its port first.`);
        if (state.operations.some(op => op.taskId === task.id && ["pending", "running"].includes(op.status))) {
          blockers.push(`${task.title}: resolve pending approvals and running operations first.`);
        }
        if (state.agentBindings.some(binding => binding.taskId === task.id && experienceBindingIsLive(binding, sessions))) {
          blockers.push(`${task.title}: disconnect its active ChatGPT/MCP session first.`);
        }
        if (task.execution.mode === "worktree" && task.execution.managed && !["completed", "archived"].includes(task.lifecycle)) {
          blockers.push(`${task.title}: finish/discard the managed parallel task before changing the project folder.`);
        }
      }
      if (blockers.length) throw new Error(`WORKSPACE_RELOCATE_BUSY: ${blockers.join(" ")}`);

      const localTaskIds = new Set(tasks.filter(task => task.execution.mode === "local").map(task => task.id));
      let remappedChanges = 0;
      for (const task of tasks) {
        task.workspace = root;
        if (task.execution.mode === "local") task.execution.path = root;
        for (const key of [...activeChangeSets.keys()]) if (key.startsWith(`${task.id}:`)) activeChangeSets.delete(key);
      }
      for (const operation of state.operations) {
        if (!localTaskIds.has(operation.taskId)) continue;
        for (const change of operation.changes) {
          const next = remapWorkspacePath(change.path, oldRoot, root);
          if (next !== change.path) {
            change.path = next;
            remappedChanges++;
          }
        }
        if (operation.review) {
          for (const file of operation.review.files) file.path = remapWorkspacePath(file.path, oldRoot, root);
        }
      }
      workspace.path = root;
      workspace.lastOpenedAt = new Date().toISOString();
      await save({ scopes: ["state", "workspaces", "tasks", "operations"], taskId: state.selectedTaskId, reason: "workspace-relocated" });
      return {
        workspace: { ...structuredClone(workspace), ...await workspaceAvailability(workspace) },
        oldPath: oldRoot,
        newPath: root,
        updatedTasks: tasks.length,
        remappedChanges,
      };
    });
  });
}

export async function ensureWorkspaceForControl(name: string, workspacePath: string, select = true, authority?: ControlAuthority): Promise<{ workspace: Workspace; created: boolean }> {
  return controlExclusive(authority, async () => {
    const root = await canonicalWorkspacePath(workspacePath);
    if (workspacePathKey(root) === workspacePathKey(workbenchRoot())) throw new Error("Workbench control directory cannot be added as a workspace");
    let workspace = findWorkspaceByPath(root);
    const created = !workspace;
    if (!workspace) {
      workspace = createWorkspaceRecord(root, name);
      if (workspace.experience === "basic") ensureBasicTask(workspace);
    }
    if (select) {
      workspace.lastOpenedAt = new Date().toISOString();
      state.selectedWorkspaceId = workspace.id;
      const selectedTask = workspace.experience === "basic" ? ensureBasicTask(workspace)
        : state.tasks.find(item => item.workspaceId === workspace!.id && taskAcceptsWork(item));
      state.selectedTaskId = selectedTask?.id;
    }
    if (created || select) await save({ scopes: ["workspaces", "tasks"], taskId: state.selectedTaskId, reason: created ? "workspace-created-by-chatgpt" : "workspace-selected-by-chatgpt" });
    return { workspace: structuredClone(workspace), created };
  });
}

export async function resolveWorkspaceForControl(input: { workspaceId?: string; workspaceName?: string; workspacePath?: string }): Promise<Workspace> {
  return exclusive(async () => {
    let resolved: Workspace | undefined;
    const merge = (candidate: Workspace | undefined, label: string) => {
      if (!candidate) throw new Error(`WORKSPACE_TARGET_NOT_FOUND: ${label}`);
      if (resolved && resolved.id !== candidate.id) throw new Error("WORKSPACE_TARGET_CONFLICT: workspace id, name and path refer to different projects");
      resolved = candidate;
    };
    if (input.workspaceId) merge(state.workspaces.find(item => item.id === input.workspaceId), input.workspaceId);
    if (input.workspacePath) {
      const root = await canonicalWorkspacePath(input.workspacePath);
      merge(findWorkspaceByPath(root), root);
    }
    if (input.workspaceName) {
      const needle = input.workspaceName.trim().toLocaleLowerCase();
      const matches = state.workspaces.filter(item => item.name.trim().toLocaleLowerCase() === needle);
      if (matches.length > 1) throw new Error(`WORKSPACE_TARGET_AMBIGUOUS: more than one workspace is named ${input.workspaceName}`);
      merge(matches[0], input.workspaceName);
    }
    if (!resolved && state.selectedWorkspaceId) resolved = state.workspaces.find(item => item.id === state.selectedWorkspaceId);
    if (!resolved) throw new Error("WORKSPACE_TARGET_REQUIRED: specify workspace_id, workspace_name or workspace_path");
    return structuredClone(resolved);
  });
}

function inferCloneFolderName(repository: string): string {
  const trimmed = repository.trim().replace(/[\\/]+$/, "");
  const tail = trimmed.split(/[\\/:]/).filter(Boolean).pop() || "repository";
  return tail.replace(/\.git$/i, "") || "repository";
}

function validateCloneFolderName(value: string): string {
  const name = value.trim();
  if (!name || name === "." || name === ".." || /[\\/\0\r\n]/.test(name)) {
    throw new Error("CLONE_FOLDER_INVALID: folder name must be a single directory name");
  }
  if (process.platform === "win32" && (/[<>:\"|?*]/.test(name) || /[. ]$/.test(name))) {
    throw new Error("CLONE_FOLDER_INVALID: folder name contains characters Windows cannot use");
  }
  return name;
}

function pathIsInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function cloneWorkspace(input: {
  repository: string;
  destinationParent: string;
  folderName?: string;
  branch?: string;
  name?: string;
}) {
  await init();
  const repository = input.repository.trim();
  if (!repository || /[\0\r\n]/.test(repository)) throw new Error("CLONE_REPOSITORY_INVALID: repository is required");
  const branch = input.branch?.trim() || undefined;
  if (branch && /[\0\r\n]/.test(branch)) throw new Error("CLONE_BRANCH_INVALID: branch contains invalid characters");
  const parent = await canonicalWorkspacePath(input.destinationParent);
  const folderName = validateCloneFolderName(input.folderName || inferCloneFolderName(repository));
  const destination = path.resolve(parent, folderName);
  if (path.dirname(destination) !== path.resolve(parent)) throw new Error("CLONE_DESTINATION_INVALID: destination must stay inside the selected parent folder");
  if (pathIsInside(workbenchRoot(), destination)) throw new Error("CLONE_DESTINATION_INVALID: Workbench control directory cannot contain cloned projects");

  await workspacePathsExclusive([destination], async () => {
    const alreadyExists = await fs.lstat(destination).then(() => true).catch(error => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    });
    if (alreadyExists) throw new Error(`CLONE_DESTINATION_EXISTS: ${destination} already exists; open the existing folder instead`);
    const args = ["clone"];
    if (branch) args.push("--branch", branch, "--single-branch");
    args.push("--", repository, destination);
    let result: { code: number; stdout: string; stderr: string };
    try {
      result = await runControlGitResult(parent, args, 10 * 60_000, { GIT_ALLOW_PROTOCOL: "file:http:https:ssh:git" });
    } catch (error) {
      await fs.rm(destination, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }).catch(() => {});
      throw error;
    }
    if (result.code !== 0) {
      await fs.rm(destination, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }).catch(() => {});
      throw new Error(`GIT_CLONE_FAILED: ${result.stderr.trim() || result.stdout.trim() || `git exited with code ${result.code}`}`);
    }
  });

  return exclusive(async () => {
    const root = await canonicalWorkspacePath(destination);
    if (workspacePathKey(root) === workspacePathKey(workbenchRoot()) || findWorkspaceByPath(root)) {
      throw new Error("Workspace already added");
    }
    const workspace = createWorkspaceRecord(root, input.name || folderName);
    workspace.lastOpenedAt = new Date().toISOString();
    const task = workspace.experience === "basic" ? ensureBasicTask(workspace) : undefined;
    state.selectedWorkspaceId = workspace.id;
    state.selectedTaskId = task?.id;
    await save({ scopes: ["state", "workspaces", "tasks"], taskId: task?.id, reason: "workspace-cloned" });
    return {
      workspace: structuredClone(workspace),
      repository,
      destination: root,
      branch: branch || null,
      selectedWorkspaceId: workspace.id,
      selectedTaskId: task?.id || null,
    };
  });
}
export async function selectWorkspace(id: string): Promise<void> {
  await exclusive(async () => {
    const workspace = workspaceById(id);
    workspace.lastOpenedAt = new Date().toISOString();
    state.selectedWorkspaceId = workspace.id;
    const task = workspace.experience === "basic" ? ensureBasicTask(workspace)
      : state.tasks.find(item => item.workspaceId === workspace.id && taskAcceptsWork(item));
    state.selectedTaskId = task?.id;
    await save({ scopes: ["workspaces", "tasks"], taskId: task?.id, reason: "workspace-selected" });
  });
}

export async function removeWorkspace(id: string, sessions?: AgentSessionSnapshot[]) {
  return exclusive(async () => {
    const workspace = workspaceById(id);
    const tasks = state.tasks.filter(task => task.workspaceId === workspace.id);
    const taskIds = new Set(tasks.map(task => task.id));
    return workspacePathsExclusive([workspace.path, ...tasks.map(taskExecutionPath)], async () => {
      const blockers: string[] = [];
      for (const task of tasks) {
        const runtime = getTaskRuntime(task.id);
        if (runtime.running) blockers.push(`${task.title}: stop ${runtime.running} running process${runtime.running === 1 ? "" : "es"} first.`);
        if (previewLeaseForTask(task.id)) blockers.push(`${task.title}: stop Preview and release its port first.`);
        if (state.operations.some(op => op.taskId === task.id && ["pending", "running"].includes(op.status))) {
          blockers.push(`${task.title}: resolve pending approvals and running operations first.`);
        }
        if (state.agentBindings.some(binding => binding.taskId === task.id && experienceBindingIsLive(binding, sessions))) {
          blockers.push(`${task.title}: disconnect its active ChatGPT/MCP session first.`);
        }
        if (task.execution.mode === "worktree" && task.execution.managed) {
          try {
            if ((await fs.stat(task.execution.path)).isDirectory()) {
              blockers.push(`${task.title}: finish/discard the parallel task so its managed worktree is cleaned up first.`);
            }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
      }
      if (blockers.length) throw new Error(`WORKSPACE_BUSY: ${blockers.join(" ")}`);

      const operationIds = new Set(state.operations.filter(op => taskIds.has(op.taskId)).map(op => op.id));
      const removed = {
        id: workspace.id,
        name: workspace.name,
        path: workspace.path,
        tasks: tasks.length,
        operations: state.operations.filter(op => taskIds.has(op.taskId)).length,
        checkpoints: (state.checkpoints || []).filter(checkpoint => taskIds.has(checkpoint.taskId)).length,
      };

      state.operations = state.operations.filter(op => !taskIds.has(op.taskId));
      state.checkpoints = (state.checkpoints || []).filter(checkpoint => !taskIds.has(checkpoint.taskId));
      state.agentBindings = state.agentBindings.filter(binding => !taskIds.has(binding.taskId));
      state.agentAssignments = state.agentAssignments.filter(assignment => !taskIds.has(assignment.taskId));
      state.portLeases = state.portLeases.filter(lease => !taskIds.has(lease.taskId));
      state.tasks = state.tasks.filter(task => !taskIds.has(task.id));
      state.workspaces = state.workspaces.filter(item => item.id !== workspace.id);
      for (const operationId of operationIds) callbacks.delete(operationId);
      for (const taskId of taskIds) activeChangeSets.delete(taskId);

      const selectionWasRemoved = state.selectedWorkspaceId === workspace.id
        || Boolean(state.selectedTaskId && taskIds.has(state.selectedTaskId));
      if (selectionWasRemoved) {
        const fallback = [...state.workspaces].sort((left, right) => right.lastOpenedAt.localeCompare(left.lastOpenedAt))[0];
        if (fallback) {
          state.selectedWorkspaceId = fallback.id;
          const fallbackTask = fallback.experience === "basic"
            ? ensureBasicTask(fallback)
            : state.tasks.find(task => task.workspaceId === fallback.id && taskAcceptsWork(task));
          state.selectedTaskId = fallbackTask?.id;
        } else {
          delete state.selectedWorkspaceId;
          delete state.selectedTaskId;
        }
      }

      await save({ scopes: ["state", "workspaces", "tasks", "operations", "checkpoints"], reason: "workspace-removed" });
      return {
        removed,
        selectedWorkspaceId: state.selectedWorkspaceId || null,
        selectedTaskId: state.selectedTaskId || null,
        projectFilesDeleted: false,
      };
    });
  });
}

export async function createTask(
  title: string,
  workspacePath?: string,
  workspaceId?: string,
  environment?: { mode?: "local" | "worktree"; startingRef?: string },
  options?: { kind?: TaskKind; assignNextChatgpt?: boolean; description?: string; select?: boolean; controlAuthority?: ControlAuthority },
): Promise<Task> {
  return controlExclusive(options?.controlAuthority, async () => {
    let workspace: Workspace;
    if (workspaceId) workspace = workspaceById(workspaceId);
    else {
      if (!workspacePath) throw new Error("Workspace is required");
      const root = await canonicalWorkspacePath(workspacePath);
      workspace = findWorkspaceByPath(root) || createWorkspaceRecord(root);
    }
    await assertWorkspaceReady(workspace);
    if (workspace.experience === "basic") throw new Error("ADVANCED_REQUIRED: switch this project to Advanced to create additional tasks.");
    const mode: PermissionMode = process.env.WORKBENCH_DEFAULT_MODE === "full" ? "full" : process.env.WORKBENCH_DEFAULT_MODE === "auto" ? "auto" : "ask";
    const taskId = randomUUID();
    let execution = localExecution(workspace.path);
    let integration: TaskIntegration | undefined;
    if (environment?.mode === "worktree") {
      const startingRef = (environment.startingRef || "HEAD").trim() || "HEAD";
      const baseOid = await runControlGit(workspace.path, ["rev-parse", "--verify", `${startingRef}^{commit}`]);
      const targetBranch = await runControlGit(workspace.path, ["branch", "--show-current"]);
      if (!targetBranch) throw new Error("Parallel integration requires the project workspace to be checked out on a branch");
      const branch = managedBranchName(title, taskId);
      const target = await managedWorktreePath(workspace.id, taskId);
      try {
        await fs.rm(target, { recursive: true, force: true });
        await runControlGit(workspace.path, ["worktree", "add", "-b", branch, target, baseOid]);
      } catch (error) {
        await fs.rm(target, { recursive: true, force: true }).catch(() => {});
        await runControlGit(workspace.path, ["branch", "-D", branch]).catch(() => {});
        throw error;
      }
      execution = { mode: "worktree", path: await fs.realpath(target), startingRef, baseOid, branch, detached: false, managed: true };
      integration = { targetBranch };
    }
    const description = options?.description?.trim().slice(0, 4000) || undefined;
    const task: Task = { id: taskId, workspaceId: workspace.id, title: title.slice(0, 200), ...(description ? { description } : {}), workspace: workspace.path, execution, createdAt: new Date().toISOString(),
      policy: { mode, workspaceOnly: mode !== "full", revision: 1 }, kind: options?.kind || (execution.mode === "worktree" ? "parallel" : "standard"), lifecycle: "open", integration };
    state.tasks.push(task);
    if (options?.assignNextChatgpt) queueAssignment(state, task.id);
    if (options?.select) {
      workspace.lastOpenedAt = new Date().toISOString();
      state.selectedWorkspaceId = workspace.id;
      state.selectedTaskId = task.id;
    } else state.selectedWorkspaceId ??= workspace.id;
    await save({ scopes: ["workspaces", "tasks"], taskId: task.id, reason: "task-created" });
    return structuredClone(task);
  });
}

export async function targetAgentSession(
  sessionId: string,
  clientType: AgentClientType,
  input: {
    workspaceId?: string;
    workspaceName?: string;
    workspacePath?: string;
    taskId?: string;
    taskTitle?: string;
    createMissing?: boolean;
  },
  authority: ControlAuthority,
) {
  if (authority.sessionId !== sessionId) throw new Error("CONTROL_SESSION_CHANGED: target must use the current session.");
  return controlExclusive({ ...authority, requireIdle: true }, async () => {
    if (!sessionId) throw new Error("AGENT_TARGET_SESSION_REQUIRED: current MCP session is unavailable");
    const activeOperations = state.operations.filter(operation => operation.sessionId === sessionId && ["pending", "running"].includes(operation.status));
    if (activeOperations.length) {
      throw new Error(`AGENT_TARGET_BUSY: resolve ${activeOperations.length} pending or running operation${activeOperations.length === 1 ? "" : "s"} from this chat before changing task`);
    }
    const createMissing = input.createMissing !== false;
    let workspace: Workspace | undefined;
    let createdWorkspace = false;
    const mergeWorkspace = (candidate: Workspace | undefined, label: string) => {
      if (!candidate) throw new Error(`WORKSPACE_TARGET_NOT_FOUND: ${label}`);
      if (workspace && workspace.id !== candidate.id) throw new Error("WORKSPACE_TARGET_CONFLICT: workspace id, name and path refer to different projects");
      workspace = candidate;
    };

    if (input.workspaceId) mergeWorkspace(state.workspaces.find(item => item.id === input.workspaceId), input.workspaceId);
    if (input.workspacePath) {
      const root = await canonicalWorkspacePath(input.workspacePath);
      let candidate = findWorkspaceByPath(root);
      if (!candidate && createMissing) {
        if (workspacePathKey(root) === workspacePathKey(workbenchRoot())) throw new Error("Workbench control directory cannot be added as a workspace");
        candidate = createWorkspaceRecord(root, input.workspaceName);
        createdWorkspace = true;
      }
      mergeWorkspace(candidate, root);
    }
    if (input.workspaceName && !input.workspacePath) {
      const needle = input.workspaceName.trim().toLocaleLowerCase();
      const matches = state.workspaces.filter(item => item.name.trim().toLocaleLowerCase() === needle);
      if (matches.length > 1) throw new Error(`WORKSPACE_TARGET_AMBIGUOUS: more than one workspace is named ${input.workspaceName}`);
      mergeWorkspace(matches[0], input.workspaceName);
    }
    if (!workspace && input.taskId) workspace = state.workspaces.find(item => item.id === state.tasks.find(task => task.id === input.taskId)?.workspaceId);
    if (!workspace && state.selectedWorkspaceId) workspace = state.workspaces.find(item => item.id === state.selectedWorkspaceId);
    if (!workspace) throw new Error("WORKSPACE_TARGET_REQUIRED: specify a workspace path, name or id");
    await assertWorkspaceReady(workspace);

    let task: Task | undefined;
    let createdTask = false;
    if (workspace.experience === "basic") {
      task = ensureBasicTask(workspace);
      if (input.taskId && input.taskId !== task.id) throw new Error("BASIC_TASK: this project uses one default task; switch to Advanced to target another task");
      if (input.taskTitle && input.taskTitle.trim().toLocaleLowerCase() !== task.title.toLocaleLowerCase()) {
        throw new Error("BASIC_TASK: this project uses one default task; switch to Advanced to target another task");
      }
    } else if (input.taskId) {
      task = state.tasks.find(item => item.id === input.taskId && item.workspaceId === workspace!.id && taskAcceptsWork(item));
      if (!task) throw new Error(`TASK_TARGET_NOT_FOUND: ${input.taskId}`);
    } else if (input.taskTitle) {
      const needle = input.taskTitle.trim().toLocaleLowerCase();
      const matches = state.tasks.filter(item => item.workspaceId === workspace!.id && taskAcceptsWork(item) && item.title.trim().toLocaleLowerCase() === needle);
      if (matches.length > 1) throw new Error(`TASK_TARGET_AMBIGUOUS: more than one open task is named ${input.taskTitle}`);
      task = matches[0];
      if (!task && createMissing) {
        task = createLocalControlTask(workspace, input.taskTitle);
        createdTask = true;
      }
    } else {
      const selected = state.selectedTaskId ? state.tasks.find(item => item.id === state.selectedTaskId && item.workspaceId === workspace!.id && taskAcceptsWork(item)) : undefined;
      const candidates = state.tasks.filter(item => item.workspaceId === workspace!.id && taskAcceptsWork(item));
      if (selected) task = selected;
      else if (candidates.length === 1) task = candidates[0];
      else if (candidates.length === 0 && createMissing) {
        task = createLocalControlTask(workspace);
        createdTask = true;
      } else if (candidates.length > 1) {
        throw new Error("TASK_TARGET_AMBIGUOUS: this workspace has multiple open tasks; specify task_id or task_title");
      }
    }
    if (!task) throw new Error("TASK_TARGET_REQUIRED: specify an existing task or allow Workbench to create one");

    const now = new Date().toISOString();
    const binding = state.agentBindings.find(item => item.sessionId === sessionId);
    const previousTaskId = binding?.taskId;
    if (binding && binding.taskId !== task.id) {
      const previousTask = state.tasks.find(item => item.id === binding.taskId);
      const previousWorkspace = previousTask ? state.workspaces.find(item => item.id === previousTask.workspaceId) : undefined;
      if (previousWorkspace?.writer?.sessionId === sessionId) delete previousWorkspace.writer;
      activeChangeSets.delete(changeSetKey(binding.taskId, sessionId));
      binding.taskId = task.id;
      binding.clientType = clientType;
      binding.lastSeenAt = now;
      delete binding.closedAt;
    } else if (binding) {
      binding.clientType = clientType;
      binding.lastSeenAt = now;
      delete binding.closedAt;
    } else {
      state.agentBindings.push({
        id: randomUUID(), agentId: randomUUID(), sessionId, taskId: task.id, clientType,
        createdAt: now, lastSeenAt: now,
      });
    }
    state.agentAssignments = state.agentAssignments.filter(item => item.taskId !== task!.id);
    workspace.lastOpenedAt = now;
    state.selectedWorkspaceId = workspace.id;
    state.selectedTaskId = task.id;
    await save({ scopes: ["state", "workspaces", "tasks"], taskId: task.id, reason: "session-targeted-by-chatgpt" });
    return {
      authoritative: true,
      created: { workspace: createdWorkspace, task: createdTask },
      previousTaskId: previousTaskId || null,
      workspace: { id: workspace.id, name: workspace.name, path: workspace.path, experience: workspace.experience },
      task: { id: task.id, title: task.title, kind: task.kind, lifecycle: task.lifecycle, executionPath: taskExecutionPath(task), branch: task.execution.branch || null },
      session: { id: sessionId, clientType, retargeted: previousTaskId !== task.id },
    };
  });
}

export async function setTaskDescription(id: string, description: string): Promise<Task> {
  return exclusive(async () => {
    const task = taskById(id);
    const normalized = description.trim().slice(0, 4000);
    if (normalized) task.description = normalized;
    else delete task.description;
    await save({ scopes: ["tasks"], taskId: id, reason: "task-description-updated" });
    return structuredClone(task);
  });
}

export async function setTaskHandoff(id: string, input: { summary: string; nextSteps?: string[]; notes?: string; fromSessionId?: string }): Promise<Task> {
  const context = executionContext.getStore();
  const update = async () => {
    const task = taskById(id);
    assertTaskMutable(task);
    if (context) {
      const operation = state.operations.find(op => op.id === context.operationId);
      if (context.taskId !== id || operation?.taskId !== id || operation.tool !== "task_handoff"
        || operation.status !== "running" || operation.args.action !== "update") {
        throw new Error("HANDOFF_DISPATCH_REQUIRED: update must run through the bound task operation");
      }
      await assertBasicWriter(task, context.sessionId);
    }
    const summary = input.summary.trim().slice(0, 6000);
    if (!summary) throw new Error("HANDOFF_SUMMARY_REQUIRED: add a short summary of the current state");
    const nextSteps = (input.nextSteps || []).map(item => item.trim()).filter(Boolean).slice(0, 20).map(item => item.slice(0, 1000));
    const notes = input.notes?.trim().slice(0, 6000) || undefined;
    task.handoff = {
      summary,
      nextSteps,
      ...(notes ? { notes } : {}),
      ...((context?.sessionId || input.fromSessionId) ? { fromSessionId: context?.sessionId || input.fromSessionId } : {}),
      updatedAt: new Date().toISOString(),
    };
    await save({ scopes: ["tasks"], taskId: id, reason: "task-handoff-updated" });
    return structuredClone(task);
  };
  // Dispatch already owns the workspace lock. Admin updates acquire that same
  // lock; neither path acquires the global queue while holding a workspace lock.
  return context ? update() : workspaceExclusive(id, update);
}

export async function setTaskPreview(id: string, preview?: TaskPreview): Promise<Task> {
  await init();
  return portLeaseExclusive(async () => {
    const task = taskById(id);
    const existingLease = previewLeaseForTask(id);
    if (existingLease && !await isLoopbackPortAvailable(existingLease.port)) {
      throw new Error(`PREVIEW_PORT_STILL_OCCUPIED: port ${existingLease.port} is still occupied; stop Preview before changing its configuration`);
    }
    removePreviewLeaseUnlocked(id);
    if (preview) {
      const next = structuredClone(preview);
      next.autoPort ??= !next.url;
      next.port ??= previewUrlPort(next.url);
      task.preview = next;
      if (preview.processId) setTaskRuntimeProcessRole(id, preview.processId, "preview");
    }
    else delete task.preview;
    await save({ scopes: ["tasks"], taskId: id, reason: "preview-updated" });
    return structuredClone(task);
  });
}

export async function prepareTaskPreviewStart(id: string, input: { command: string; url?: string }): Promise<TaskPreview> {
  await init();
  return portLeaseExclusive(async () => {
    const task = taskById(id);
    await assertWorkspaceReady(workspaceById(task.workspaceId));
    assertTaskMutable(task);
    const existingLease = previewLeaseForTask(id);
    if (existingLease && !await isLoopbackPortAvailable(existingLease.port)) {
      throw new Error(`PREVIEW_PORT_STILL_OCCUPIED: port ${existingLease.port} is still occupied by the previous preview; stop it before starting another preview`);
    }
    const explicitUrl = input.url || (task.preview?.autoPort === false ? task.preview.url : undefined);
    const autoPort = !explicitUrl;
    const used = new Set(state.portLeases.filter(lease => lease.taskId !== id).map(lease => lease.port));
    let port: number;
    let url: string;
    if (explicitUrl) {
      const parsed = previewUrlPort(explicitUrl);
      if (!parsed) throw new Error("PREVIEW_PORT_REQUIRED: explicit preview URL must resolve to a TCP port");
      if (used.has(parsed)) throw new Error(`PREVIEW_PORT_LEASED: preview port ${parsed} is already reserved by another task`);
      if (!await isLoopbackPortAvailable(parsed)) throw new Error(`PREVIEW_PORT_BUSY: preview port ${parsed} is already in use`);
      port = parsed;
      url = explicitUrl;
    } else {
      port = await selectPreviewPort(used, task.preview?.port);
      url = `http://127.0.0.1:${port}/`;
    }
    removePreviewLeaseUnlocked(id);
    const now = new Date().toISOString();
    const lease: PortLease = { id: randomUUID(), taskId: id, purpose: "preview", port, createdAt: now, lastSeenAt: now };
    state.portLeases.push(lease);
    task.preview = { command: input.command, url, port, autoPort, leaseId: lease.id };
    await save({ scopes: ["tasks"], taskId: id, reason: "preview-port-leased" });
    return structuredClone(task.preview);
  });
}

export async function attachTaskPreviewProcess(id: string, processId: string): Promise<TaskPreview> {
  await init();
  return portLeaseExclusive(async () => {
    const task = taskById(id);
    const preview = task.preview;
    const lease = previewLeaseForTask(id);
    if (!preview || !lease || preview.leaseId !== lease.id) throw new Error("PREVIEW_LEASE_MISSING: preview port lease was lost before the process started");
    preview.processId = processId;
    preview.startedAt = new Date().toISOString();
    lease.lastSeenAt = preview.startedAt;
    setTaskRuntimeProcessRole(id, processId, "preview");
    await save({ scopes: ["tasks"], taskId: id, reason: "preview-process-attached" });
    return structuredClone(preview);
  });
}

export async function releaseTaskPreviewPort(id: string, options: { force?: boolean } = {}): Promise<{ released: boolean; port?: number; busy?: boolean }> {
  await init();
  return portLeaseExclusive(async () => {
    const task = taskById(id);
    const lease = previewLeaseForTask(id);
    if (!lease) {
      if (task.preview) {
        delete task.preview.processId;
        delete task.preview.startedAt;
        delete task.preview.leaseId;
      }
      await save({ scopes: ["tasks"], taskId: id, reason: "preview-port-cleared" });
      return { released: true };
    }
    if (!options.force && !await waitForLoopbackPortAvailable(lease.port)) {
      if (task.preview) {
        delete task.preview.processId;
        delete task.preview.startedAt;
      }
      await save({ scopes: ["tasks"], taskId: id, reason: "preview-port-still-busy" });
      return { released: false, port: lease.port, busy: true };
    }
    removePreviewLeaseUnlocked(id);
    if (task.preview) {
      delete task.preview.processId;
      delete task.preview.startedAt;
    }
    await save({ scopes: ["tasks"], taskId: id, reason: "preview-port-released" });
    return { released: true, port: lease.port, busy: false };
  });
}

export async function selectTask(id: string): Promise<void> {
  await exclusive(async () => {
    const task = taskById(id);
    const workspace = workspaceById(task.workspaceId);
    if (workspace.experience === "basic" && task.id !== workspace.basicTaskId) throw new Error("ADVANCED_REQUIRED: switch to Advanced to select another task.");
    workspace.lastOpenedAt = new Date().toISOString();
    state.selectedWorkspaceId = workspace.id;
    state.selectedTaskId = id;
    await save({ scopes: ["workspaces", "tasks"], taskId: id, reason: "task-selected" });
  });
}

async function resolveChatGptFallbackTaskUnlocked(workspace: string): Promise<string> {
  // A queued assignment is handled before this fallback. Without one, a new
  // ChatGPT session should follow the project/task the human is currently
  // viewing in Workbench. The server bootstrap WORKSPACE_PATH is only a final
  // fallback for installations that do not yet have a selected workspace.
  // Existing sessions never reach this function because their bindings are
  // reused earlier in resolveSessionTask().
  const selectedWorkspace = state.workspaces.find(item => item.id === state.selectedWorkspaceId);
  if (selectedWorkspace) await assertWorkspaceReady(selectedWorkspace);
  if (selectedWorkspace?.experience === "basic") return ensureBasicTask(selectedWorkspace).id;
  if (selectedWorkspace && state.selectedTaskId) {
    const selectedTask = state.tasks.find(task =>
      task.id === state.selectedTaskId
      && task.workspaceId === selectedWorkspace.id
      && taskAcceptsWork(task));
    if (selectedTask) return selectedTask.id;
  }

  const root = selectedWorkspace?.path || await canonicalWorkspacePath(workspace);
  const workspaceRecord = selectedWorkspace || findWorkspaceByPath(root) || createWorkspaceRecord(root);
  if (workspaceRecord.experience === "basic") return ensureBasicTask(workspaceRecord).id;
  const candidates = state.tasks
    .filter(task => task.workspaceId === workspaceRecord.id && taskAcceptsWork(task))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  const standardLocal = candidates.filter(task => task.kind === "standard" && task.execution.mode === "local");

  // If the selected workspace has no selected runnable task, keep connector
  // initialization reliable by choosing a stable local fallback. Do not let an
  // unrelated startup project win merely because WORKSPACE_PATH still points
  // at an older project.
  if (standardLocal.length === 1) return standardLocal[0].id;
  if (candidates.length === 1) return candidates[0].id;
  if (candidates.length > 1) return ensureBasicTask(workspaceRecord).id;

  return ensureBasicTask(workspaceRecord).id;
}

async function resolveDefaultTaskUnlocked(workspace: string): Promise<string> {
    const basicWorkspace = state.workspaces.find(item => item.id === state.selectedWorkspaceId && item.experience === "basic");
    if (basicWorkspace) {
      await assertWorkspaceReady(basicWorkspace);
      const task = ensureBasicTask(basicWorkspace);
      state.selectedTaskId = task.id;
      return task.id;
    }
    if (state.selectedTaskId && state.tasks.some(item => item.id === state.selectedTaskId)) {
      const selected = taskById(state.selectedTaskId);
      if (taskAcceptsWork(selected)) return selected.id;
    }
    let selectedWorkspace = state.selectedWorkspaceId ? state.workspaces.find(item => item.id === state.selectedWorkspaceId) : undefined;
    if (!selectedWorkspace) {
      const root = await canonicalWorkspacePath(workspace);
      selectedWorkspace = findWorkspaceByPath(root) || createWorkspaceRecord(root);
      state.selectedWorkspaceId = selectedWorkspace.id;
    }
    await assertWorkspaceReady(selectedWorkspace);
    if (selectedWorkspace.experience === "basic") {
      const task = ensureBasicTask(selectedWorkspace);
      state.selectedTaskId = task.id;
      return task.id;
    }
    const existing = state.tasks.find(item => item.workspaceId === selectedWorkspace!.id && taskAcceptsWork(item));
    if (existing) { state.selectedTaskId = existing.id; return existing.id; }
    const mode: PermissionMode = process.env.WORKBENCH_DEFAULT_MODE === "full" ? "full" : process.env.WORKBENCH_DEFAULT_MODE === "auto" ? "auto" : "ask";
    const task: Task = { id: randomUUID(), workspaceId: selectedWorkspace.id, title: "Default project", workspace: selectedWorkspace.path, execution: localExecution(selectedWorkspace.path), createdAt: new Date().toISOString(),
      policy: { mode, workspaceOnly: mode !== "full", revision: 1 }, kind: "standard", lifecycle: "open" };
    state.tasks.push(task);
    state.selectedTaskId = task.id;
    return task.id;
}

export async function resolveDefaultTask(workspace: string): Promise<string> {
  return exclusive(async () => {
    const beforeCount = state.tasks.length;
    const taskId = await resolveDefaultTaskUnlocked(workspace);
    if (state.tasks.length !== beforeCount) await save({ scopes: ["workspaces", "tasks"], taskId, reason: "default-task-created" });
    return taskId;
  });
}
export async function resolveSessionTask(sessionId: string, workspace: string, clientType: AgentClientType = "mcp"): Promise<string> {
  return exclusive(async () => {
    const taskExists = (taskId: string) => state.tasks.some(task => task.id === taskId && !["archived", "completed"].includes(task.lifecycle));
    const bound = state.agentBindings.find(binding => binding.sessionId === sessionId);
    if (bound) {
      const boundTask = state.tasks.find(task => task.id === bound.taskId);
      if (boundTask && ["archived", "completed"].includes(boundTask.lifecycle)) {
        throw new Error(`AGENT_TASK_CLOSED: ${boundTask.title} is ${boundTask.lifecycle === "completed" ? "finished" : "discarded"}; this session will not be rebound automatically`);
      }
    }

    // Existing sessions are immutable bindings. Most importantly, do this
    // before consulting any dashboard selection or fallback task.
    const existingBinding = state.agentBindings.find(binding => binding.sessionId === sessionId && taskExists(binding.taskId));
    if (existingBinding) {
      const claimed = claimSessionTask(state, {
        sessionId,
        clientType,
        fallbackTaskId: existingBinding.taskId,
        taskExists,
      });
      await save({ scopes: ["tasks"], taskId: claimed.taskId, reason: "session-task-reused" });
      return claimed.taskId;
    }

    // ChatGPT reservations are global and deterministic. Claim a queued task
    // before consulting the dashboard selection. Without a reservation, only
    // a *new* ChatGPT conversation follows the current Workbench selection;
    // existing conversations remain pinned by the binding check above.
    if (clientType === "chatgpt") {
      const assignment = state.agentAssignments.find(item => taskExists(item.taskId));
      if (assignment) {
        const claimed = claimSessionTask(state, {
          sessionId,
          clientType,
          fallbackTaskId: assignment.taskId,
          taskExists,
        });
        await save({ scopes: ["tasks"], taskId: claimed.taskId, reason: "agent-assignment-claimed" });
        return claimed.taskId;
      }
    }

    const fallbackTaskId = clientType === "chatgpt"
      ? await resolveChatGptFallbackTaskUnlocked(workspace)
      : await resolveDefaultTaskUnlocked(workspace);
    const claimed = claimSessionTask(state, {
      sessionId,
      clientType,
      fallbackTaskId,
      taskExists,
    });
    await save({ scopes: ["workspaces", "tasks"], taskId: claimed.taskId, reason: "session-task-bound" });
    return claimed.taskId;
  });
}

export async function queueAgentTaskAssignment(taskId: string): Promise<AgentAssignment> {
  return exclusive(async () => {
    const task = taskById(taskId);
    const workspace = workspaceById(task.workspaceId);
    await assertWorkspaceReady(workspace);
    if (workspace.experience === "basic") throw new Error("ADVANCED_REQUIRED: Basic conversations automatically use the project's default task.");
    if (!taskAcceptsWork(task)) throw new Error(`Task cannot accept a new agent while lifecycle is ${task.lifecycle}`);
    const assignment = queueAssignment(state, task.id);
    await save({ scopes: ["tasks"], taskId: task.id, reason: "agent-assignment-queued" });
    return structuredClone(assignment);
  });
}

export async function cancelAgentTaskAssignment(taskId: string): Promise<boolean> {
  return exclusive(async () => {
    taskById(taskId);
    const removed = cancelAssignment(state, taskId);
    if (removed) await save({ scopes: ["tasks"], taskId, reason: "agent-assignment-cancelled" });
    return removed;
  });
}

export async function markAgentSessionClosed(sessionId: string): Promise<void> {
  await exclusive(async () => {
    const binding = closeBinding(state, sessionId);
    if (!binding) return;
    await save({ scopes: ["tasks"], taskId: binding.taskId, reason: "agent-session-closed" });
  });
}

export async function setTaskPolicy(id: string, mode: PermissionMode, workspaceOnly: boolean): Promise<void> {
  await workspaceExclusive(id, async () => {
    const task = taskById(id);
    updateTaskPolicy(task, mode, workspaceOnly);
    await save({ scopes: ["tasks", "operations"], taskId: id, reason: "policy-updated" });
  });
}

function updateTaskPolicy(task: Task, mode: PermissionMode, workspaceOnly: boolean): void {
  task.policy = { mode, workspaceOnly, revision: task.policy.revision + 1 };
  for (const op of state.operations.filter(o => o.taskId === task.id && o.status === "pending")) {
    op.status = "expired"; callbacks.delete(op.id);
  }
}

export async function setSessionTaskPolicy(authority: ControlAuthority, mode: PermissionMode, workspaceOnly: boolean, expectedRevision: number) {
  return exclusive(() => workspaceExclusive(authority.taskId, async () => {
    if (!remotePolicyControlEnabled()) throw new Error("REMOTE_POLICY_DISABLED: this installation has not enabled conversational permission changes. The owner can enable WORKBENCH_REMOTE_POLICY_CONTROL locally.");
    const task = assertControlSession(authority);
    if (task.policy.revision !== expectedRevision) throw new Error("POLICY_CHANGED: read workbench and use the current policy revision.");
    await assertBasicWriter(task, authority.sessionId);
    const previousPolicy = { ...task.policy };
    updateTaskPolicy(task, mode, workspaceOnly);
    const op: Operation = { id: randomUUID(), taskId: task.id, sessionId: authority.sessionId, tool: "workbench_control",
      args: { action: "set_policy", mode, workspace_only: workspaceOnly, expected_revision: expectedRevision },
      createdAt: new Date().toISOString(), expiresAt: Date.now(), policyRevision: task.policy.revision,
      status: "completed", changes: [], tracking: "task-metadata" };
    const result = { task_id: task.id, previous_policy: previousPolicy, policy: { ...task.policy }, operation_id: op.id,
      message: "Task policy updated. Pending approvals were expired, not executed. Full permits authorized file and command operations without Workbench approval. Existing processes are not stopped by a policy change. Connector-side checks are independent." };
    op.result = result;
    state.operations.push(op);
    await save({ scopes: ["tasks", "operations"], taskId: task.id, operationId: op.id, reason: "policy-updated-by-chat" });
    return result;
  }));
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
    assertTaskMutable(task);
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
const READ_TOOLS = new Set(["inspect_code", "read_text_file", "read_multiple_files", "list_directory", "glob", "grep", "search_files", "directory_tree", "get_file_info", "list_allowed_directories", "agent_status", "project_context", "skills", "load_path_rules", "shell_status", "process_status", "process_output", "mcp_servers", "mcp_tools"]);
const EDIT_TOOLS = new Set(["write_file", "edit_file", "multi_edit", "apply_patch", "replace_regex", "create_directory", "copy_file", "move_file", "remember"]);
const METADATA_TOOLS = new Set(["task_handoff"]);
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
    || (tool === "task_handoff" && (args.action || "read") === "read")
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
const INTEGRATION_SAFE_CONTROL_TOOLS = new Set(["shell_reset", "stop_process", "clear_processes"]);
const MISSING_WORKSPACE_SAFE_TOOLS = new Set(["process_status", "process_output", "stop_process", "clear_processes", "shell_reset", "task_handoff"]);
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
export async function dispatch(taskId: string, tool: string, args: Args, invoke: () => Promise<unknown>, human = false, sessionId?: string, environment?: Record<string, string>): Promise<any> {
  await init();
  // The localhost Workbench UI is already a direct human-controlled surface.
  // Git actions from that UI must keep working even when a task is configured
  // workspace-only but no Docker sandbox is installed. This exception is
  // deliberately scoped to human Git actions only; MCP/ChatGPT calls keep the
  // original workspace-only sandbox policy unchanged.
  const humanGit = human && tool.startsWith("git_");
  // Waiting for process output must not lock writes or other tasks behind it.
  if (isReadOperation(tool, args)) {
    const task = structuredClone(taskById(taskId));
    if (!MISSING_WORKSPACE_SAFE_TOOLS.has(tool)) await assertWorkspaceReady(workspaceById(task.workspaceId));
    const executionRoot = taskExecutionPath(task);
    const workspaceOnly = task.policy.workspaceOnly && !humanGit;
    if (workspaceOnly) {
      await assertWorkspaceOperationAllowed(tool);
    }
    return executionContext.run({ taskId, sessionId, workspace: executionRoot, workspaceOnly, operationId: randomUUID(), environment, capture: async () => {} }, invoke);
  }
  return workspaceExclusive(taskId, async () => {
    const task = taskById(taskId);
    if (!MISSING_WORKSPACE_SAFE_TOOLS.has(tool)) await assertWorkspaceReady(workspaceById(task.workspaceId));
    if (!INTEGRATION_SAFE_CONTROL_TOOLS.has(tool)) assertTaskMutable(task);
    if (!human) await assertBasicWriter(task, sessionId);
    const executionRoot = taskExecutionPath(task);
    const workspaceOnly = task.policy.workspaceOnly && !humanGit;
    if (workspaceOnly) {
      await assertWorkspaceOperationAllowed(tool);
      if (!isProcessOperation(tool) && !READ_TOOLS.has(tool) && !EDIT_TOOLS.has(tool) && !METADATA_TOOLS.has(tool) && !["delete_file", "delete_directory", ...WORKSPACE_CONTROL_TOOLS].includes(tool)) {
        throw new Error("WORKSPACE_SCOPE_BLOCKED: this operation is not classified as safe for workspace-only mode");
      }
    }
    const operationId = randomUUID();
    const changeSetId = operationChangeSetId(taskId, sessionId, tool, operationId);
    if (sessionId && !CHANGE_SET_TOOLS.has(tool)) activeChangeSets.delete(changeSetKey(taskId, sessionId));
    const op: Operation = { id: operationId, taskId, ...(sessionId ? { sessionId } : {}), changeSetId, tool, args: structuredClone(args), createdAt: new Date().toISOString(),
      expiresAt: Date.now() + 15 * 60_000, policyRevision: task.policy.revision, status: "pending", changes: [],
      tracking: METADATA_TOOLS.has(tool) ? "task-metadata" : isProcessOperation(tool) ? "external-effects-not-tracked" : "file-tools" };
    const boundary = { taskId, sessionId, workspace: executionRoot, workspaceOnly, operationId: op.id, environment, capture: async (_paths: string[]) => {} };
    const expected = new Map<string, Snapshot>();
    const handoffBefore = tool === "task_handoff" ? JSON.stringify(task.handoff ?? null) : undefined;
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
      const context = { taskId, sessionId, workspace: executionRoot, workspaceOnly, operationId: op.id, environment,
        capture: async (paths: string[]) => {
          for (const p of paths) await captureTree(await validatePath(p), before);
          op.changes = [...before].map(([p, s]) => ({ path: p, before: s, after: s }));
          await save({ scopes: ["operations"], taskId, operationId: op.id, reason: "operation-baseline" }); // Write-ahead journal; never start a file edit without its baseline on disk.
        } };
      op.status = "running";
      await save({ scopes: ["operations"], taskId, operationId: op.id, reason: "operation-running" });
      let result: any;
      try {
        if (!INTEGRATION_SAFE_CONTROL_TOOLS.has(tool)) assertTaskMutable(task);
        if (!human) await assertBasicWriter(task, sessionId);
        if (handoffBefore !== undefined && JSON.stringify(task.handoff ?? null) !== handoffBefore) {
          throw new Error("APPROVAL_CONFLICT: task handoff changed while waiting for approval; read the latest handoff before requesting an update.");
        }
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
    if (read) return executionContext.run({ taskId, sessionId, workspace: executionRoot, workspaceOnly, operationId: op.id, environment, capture: async () => {} }, invoke);
    state.operations.push(op);
    const auto = task.policy.mode === "full" || task.policy.mode === "auto" && (EDIT_TOOLS.has(tool) || METADATA_TOOLS.has(tool));
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
  const workspace = workspaceById(workspaceId);
  const taskIds = new Set(state.tasks.filter(task => task.workspaceId === workspaceId
    && (workspace.experience !== "basic" || task.id === workspace.basicTaskId)).map(task => task.id));
  const latest = [...state.operations].reverse().find(op =>
    taskIds.has(op.taskId)
    && op.tracking === "file-tools"
    && ["completed", "failed"].includes(op.status)
    && op.changes.length > 0
  );
  if (!latest) return null;
  return structuredClone(publicChangeSet(buildChangeSetDetail(latest.changeSetId || latest.id)));
}

export async function listWorkspaceChangeSets(workspaceId: string) {
  await init();
  const workspace = workspaceById(workspaceId);
  const taskIds = new Set(state.tasks.filter(task => task.workspaceId === workspaceId
    && (workspace.experience !== "basic" || task.id === workspace.basicTaskId)).map(task => task.id));
  const ids = [...new Set([...state.operations].reverse().filter(op => taskIds.has(op.taskId)
    && op.tracking === "file-tools" && ["completed", "failed"].includes(op.status) && op.changes.length)
    .map(op => op.changeSetId || op.id))].slice(0, 60);
  return ids.map(id => publicChangeSet(buildChangeSetDetail(id)));
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
    assertTaskMutable(task);
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
    assertTaskMutable(task);
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
