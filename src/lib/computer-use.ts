import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult, ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { executionContext } from "./workbench-context.js";
import { upstreamToolResult } from "./upstream-result.js";
import { validatePath } from "./path-security.js";
import { browserEvidence, browserTarget, observationIdentity, windowsEvidence, decodeWindowsSnapshotText, windowsParseDiagnostics, windowsChangeDiagnostics } from "./computer-observation.js";
import { ComputerUiError } from "./computer-error.js";

export const COMPUTER_TOOLS = new Set(["computer_session", "computer_observe", "computer_act", "computer_upload", "computer_job"]);
export const computerEnabled = () => process.env.COMPUTER_USE_ENABLED === "true";
const require = createRequire(import.meta.url);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const root = () => path.join(path.resolve(process.env.WORKBENCH_PATH || path.join(os.homedir(), ".chatgpt-local-coder", "workbench")), "computer-use");
const LEASE_MS = 10 * 60_000;
const OBSERVATION_MS = 60_000;
export const COMPUTER_ADAPTER_REVISION = "windows-2026-09-28-focus-coordination-3";
const WINDOWS_CALL_TIMEOUT_MS = 12_000;

interface ActionReceipt {
  session_id: string; task_id: string; owner: string; request_id: string; kind: string;
  status: "dispatched" | "acknowledged" | "unknown";
  action_dispatched: boolean; action_completed: null;
  started_at: string; updated_at: string; elapsed_ms: number;
}
const actionReceipts = new Map<string, ActionReceipt>();
function updateActionReceipt(session: Session, requestId: string, kind: string, status: ActionReceipt["status"], started: number) {
  const previous = actionReceipts.get(session.id);
  actionReceipts.set(session.id, { session_id: session.id, task_id: session.taskId, owner: session.owner,
    request_id: requestId, kind, status, action_dispatched: true, action_completed: null,
    started_at: previous?.request_id === requestId ? previous.started_at : new Date(started).toISOString(),
    updated_at: new Date().toISOString(), elapsed_ms: Date.now() - started });
}
export function recentComputerActionStatuses() {
  const actor = computerAuthority();
  const cutoff = Date.now() - LEASE_MS;
  for (const [key, receipt] of actionReceipts) if (Date.parse(receipt.updated_at) < cutoff) actionReceipts.delete(key);
  return [...actionReceipts.values()].filter(receipt => receipt.task_id === actor.taskId && receipt.owner === actor.owner)
    .map(({ task_id: _task, owner: _owner, ...publicReceipt }) => publicReceipt);
}

interface Session {
  id: string; taskId: string; owner: string; workspace: string; members: Map<string, ComputerMember>;
  backend: "browser" | "windows"; windowTitle?: string;
  manual?: boolean; profilePath?: string; windowHandle?: string;
  client: Client; transport: StdioClientTransport; tools: Map<string, Record<string, unknown>>;
  expires: number; timer?: NodeJS.Timeout; observation?: Observation;
  observations: Map<string, Observation>; queue?: Promise<void>; chooserOwner?: string; headed?: boolean;
  release: () => Promise<void>; revoked: boolean; busy: boolean; fileChooser?: boolean; closing?: Promise<void>;
}
type Observation = { id: string; digest: string; text: string; at: number };
type ComputerMember = ReturnType<typeof computerAuthority>;
const sessions = new Map<string, Session>();
const generations = new Map<string, number>();
const browserOpenings = new Map<string, Promise<unknown>>();
const normalizedWorkspace = (workspace: string) => process.platform === "win32" ? path.resolve(workspace).toLowerCase() : path.resolve(workspace);
const memberKey = (actor: ComputerMember) => JSON.stringify([actor.taskId, normalizedWorkspace(actor.workspace), actor.owner]);
const GLOBAL_BROWSER_KEY = "workbench-shared-browser";
export function computerDesktopBlocked(session: { backend: string; headed?: boolean }) {
  // Retain the exclusion even if Windows Stop failed: its worker may still run.
  return session.backend === "browser" && session.headed !== false
    && [...sessions.values()].some(candidate => candidate.backend === "windows");
}
function assertBrowserDesktopAvailable(session: { backend: string; headed?: boolean }) {
  if (computerDesktopBlocked(session)) throw new ComputerUiError("COMPUTER_DESKTOP_BUSY",
    "Visible Chrome is paused while Windows Computer Use owns the desktop. Close the Windows session before resuming browser UI calls; the Chrome profile and tabs are retained.",
    { action_sent: false, blocking_backend: "windows", retry_after: "windows_session_closed" });
}
function assertWindowsDesktopAvailable() {
  if ([...sessions.values()].some(session => session.backend === "browser" && session.headed !== false && session.busy)) {
    throw new ComputerUiError("COMPUTER_DESKTOP_BUSY", "Wait for the active visible Chrome call to finish before opening Windows Computer Use.",
      { action_sent: false, blocking_backend: "browser", retry_after: "browser_call_completed" });
  }
}
function currentObservation(session: Session) {
  return session.backend === "browser" ? session.observations.get(memberKey(computerAuthority())) : session.observation;
}
function saveObservation(session: Session, observation: Observation) {
  session.observation = observation;
  if (session.backend === "browser") session.observations.set(memberKey(computerAuthority()), observation);
}
function clearObservation(session: Session, all = false) {
  if (all) session.observations.clear();
  else session.observations.delete(memberKey(computerAuthority()));
  session.observation = undefined;
}

export function computerAuthority() {
  const context = executionContext.getStore();
  if (!computerEnabled()) throw new Error("COMPUTER_DISABLED: enable Computer Use locally first");
  if (!context?.sessionId) throw new Error("COMPUTER_SESSION_REQUIRED: authenticated task/session binding required");
  if (context.workspaceOnly) throw new Error("WORKSPACE_EXTERNAL_BLOCKED: Computer Use requires machine scope");
  return { taskId: context.taskId, owner: context.sessionId, workspace: context.workspace };
}

async function leaseFile(file: string, id: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    const handle = await fs.open(file, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify({ pid: process.pid, id })); } finally { await handle.close(); }
    return async () => {
      try { if (JSON.parse(await fs.readFile(file, "utf8")).id === id) await fs.unlink(file); } catch {}
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Fail closed instead of racing another process to reclaim a stale lease.
    throw new Error(`COMPUTER_BUSY: desktop/profile lease exists at ${file}. Stop its owner; after a crash verify the owner is gone before removing this lease locally.`);
  }
}

function renew(session: Session) {
  const lease = session.manual ? 60 * 60_000 : LEASE_MS;
  session.expires = Date.now() + lease;
  clearTimeout(session.timer);
  session.timer = setTimeout(() => { void closeComputerSession(session.id).catch(() => {}); }, lease);
  session.timer.unref();
}

export async function closeComputerSession(id: string) {
  const session = sessions.get(id);
  if (!session) return;
  if (session.closing) return session.closing;
  session.revoked = true;
  clearTimeout(session.timer);
  // Keep the lease until the backend has been stopped.
  session.closing = (async () => {
    await session.transport.close();
    await session.release();
    sessions.delete(id);
    session.members.clear();
    session.observations.clear();
  })();
  try { await session.closing; }
  catch (error) {
    // Retain the revoked lease, but let an explicit Stop retry cleanup.
    session.closing = undefined;
    throw error;
  }
}
// A conversation may leave the Workbench-shared browser without shutting down other
// controllers. Stop/revoke/fault paths still close the entire child explicitly.
export async function leaveComputerSession(id: string) {
  const session = ownedComputerSession(id, true);
  const key = memberKey(computerAuthority());
  if (session.backend !== "browser" || session.members.size <= 1 || session.revoked) {
    await closeComputerSession(id);
    return { closed: true, detached: false };
  }
  if (session.fileChooser && session.chooserOwner === key) {
    throw new Error("COMPUTER_FILE_CHOOSER_PENDING: resolve the chooser or explicitly Stop the shared browser");
  }
  // Do not detach during an in-flight UI call; queued calls recheck membership.
  await session.queue;
  ownedComputerSession(id, true);
  session.members.delete(key);
  session.observations.delete(key);
  refreshRepresentative(session);
  return { closed: false, detached: true, remaining_controllers: session.members.size };
}
function refreshRepresentative(session: Session) {
  const first = session.members.values().next().value as ComputerMember | undefined;
  if (first) {
    session.taskId = first.taskId;
    session.workspace = normalizedWorkspace(first.workspace);
    session.owner = first.owner;
  }
}
export function revokeComputerTask(taskId: string) {
  generations.set(taskId, (generations.get(taskId) ?? 0) + 1);
  for (const session of sessions.values()) {
    if (session.backend !== "browser") {
      if (session.taskId === taskId) {
        session.revoked = true;
        void closeComputerSession(session.id).catch(() => {});
      }
      continue;
    }
    for (const [key, member] of session.members) if (member.taskId === taskId) {
      session.members.delete(key);
      session.observations.delete(key);
      // An orphaned chooser cannot be safely uploaded by another task. Retain
      // the browser for other members, but require Dashboard Stop to clear it.
      if (session.chooserOwner === key) session.chooserOwner = undefined;
    }
    if (!session.members.size) {
      session.revoked = true;
      void closeComputerSession(session.id).catch(() => {});
    } else refreshRepresentative(session);
  }
}
export async function shutdownComputerUse() { await Promise.allSettled([...sessions.keys()].map(closeComputerSession)); }
export function computerSessionSummaries() {
  return [...sessions.values()].map(session => ({ session_id: session.id, task_id: session.taskId,
    owner: session.owner, backend: session.backend, expires_at: new Date(session.expires).toISOString(),
    manual_setup: Boolean(session.manual), profile_path: session.profilePath, adapter_revision: COMPUTER_ADAPTER_REVISION,
    desktop_paused: computerDesktopBlocked(session),
    controller_count: session.members.size, shared: session.backend === "browser" && session.members.size > 1,
    task_count: new Set([...session.members.values()].map(member => member.taskId)).size,
    workspace_count: new Set([...session.members.values()].map(member => normalizedWorkspace(member.workspace))).size,
    state: session.revoked ? "stopping" : session.busy ? "busy" : "ready", window_title: session.windowTitle }));
}
export function ownedComputerSessionSummaries() {
  const actor = computerAuthority();
  return computerSessionSummaries().filter(summary => {
    const session = sessions.get(summary.session_id);
    return session?.members.has(memberKey(actor));
  }).map(summary => ({ ...summary, task_id: actor.taskId, owner: actor.owner }));
}
export function ownedComputerSession(id: string, allowStopped = false) {
  const actor = computerAuthority();
  const session = sessions.get(id);
  if (!session || !session.members.has(memberKey(actor))) throw new Error("COMPUTER_NOT_OWNED: join the shared browser from this task using computer_session(open) first");
  if (!allowStopped && (session.revoked || session.expires <= Date.now())) throw new Error("COMPUTER_LEASE_EXPIRED: open a new session");
  return session;
}
export function computerMemberAttached(id: string, taskId: string, owner: string) {
  return Boolean(sessions.get(id)?.members && [...sessions.get(id)!.members.values()]
    .some(member => member.taskId === taskId && member.owner === owner));
}

export function computerProfilePath(_taskId?: string) {
  const configured = process.env.COMPUTER_BROWSER_PROFILE_PATH?.trim();
  if (!configured) return path.join(root(), "profiles", GLOBAL_BROWSER_KEY);
  if (!path.isAbsolute(configured)) throw new Error("COMPUTER_CONFIG: COMPUTER_BROWSER_PROFILE_PATH must be an absolute user-data directory");
  return path.resolve(configured);
}
const computerOutputPath = () => path.join(root(), "output", GLOBAL_BROWSER_KEY);

function browserSessionResponse(session: Session, shared: boolean) {
  const paused = computerDesktopBlocked(session);
  return { session_id: session.id, backend: "browser" as const, adapter_revision: COMPUTER_ADAPTER_REVISION,
    desktop_paused: paused,
    lease_seconds: session.manual ? 3600 : LEASE_MS / 1000, shared, controller_count: session.members.size,
    profile: { persistent: true, scope: "workbench", path: session.profilePath, headed: session.headed },
    manual_setup: Boolean(session.manual),
    next_step: paused ? "Browser UI is paused while Windows owns the desktop. Close the Windows session, then observe Chrome again; do not reuse an old observation."
      : session.manual ? "Finish manual setup; an authorized automation open can attach to this same browser."
      : "Use computer_observe. Authorized tasks across workspaces share one browser/profile; UI calls are serialized and stale actions are refused." };
}
function joinBrowserSession(session: Session, actor: ReturnType<typeof computerAuthority>, manual: boolean) {
  if (session.revoked || session.closing) throw new Error("COMPUTER_BUSY: existing browser is stopping; retry Stop before reopening");
  if (manual && !session.manual) return browserSessionResponse(session, true);
  if (session.manual && !manual) {
    // A deliberate automation open takes over the same headed setup browser,
    // without spawning a second Chrome process or retaining a setup-only owner.
    session.manual = false;
    session.members.clear();
    session.observations.clear();
  }
  session.members.set(memberKey(actor), actor);
  refreshRepresentative(session);
  renew(session);
  return browserSessionResponse(session, true);
}
export async function openComputerSession(backend: "browser" | "windows", windowTitle?: string, manual = false) {
  const actor = computerAuthority();
  if (backend === "browser") {
    const key = GLOBAL_BROWSER_KEY;
    const pending = browserOpenings.get(key);
    if (pending) {
      await pending;
      const created = [...sessions.values()].find(s => s.backend === backend);
      if (!created) throw new Error("COMPUTER_STOPPED: browser closed while waiting to join");
      return joinBrowserSession(created, actor, manual);
    }
    const existing = [...sessions.values()].find(s => s.backend === backend);
    if (existing) return joinBrowserSession(existing, actor, manual);
    const launch = launchComputerSession(backend, windowTitle, manual, actor);
    browserOpenings.set(key, launch);
    try { return await launch; }
    finally { if (browserOpenings.get(key) === launch) browserOpenings.delete(key); }
  }
  return launchComputerSession(backend, windowTitle, manual, actor);
}
async function launchComputerSession(backend: "browser" | "windows", windowTitle: string | undefined,
  manual: boolean, actor: ReturnType<typeof computerAuthority>) {
  if (backend === "windows") assertWindowsDesktopAvailable();
  else assertBrowserDesktopAvailable({ backend, headed: manual || process.env.COMPUTER_BROWSER_HEADLESS !== "true" });
  const generation = generations.get(actor.taskId) ?? 0;
  if ([...sessions.values()].some(s => s.backend === backend && (backend === "browser" || s.taskId === actor.taskId))) {
    throw new Error("COMPUTER_BUSY: existing backend is stopping or already active");
  }
  if (backend === "windows" && (process.env.COMPUTER_WINDOWS_ENABLED !== "true" || !windowTitle)) throw new Error("COMPUTER_WINDOWS_DISABLED: enable the Windows backend and provide a focused window title");
  const id = randomUUID();
  const folder = computerProfilePath();
  const release = await leaseFile(backend === "windows"
    ? path.join(os.homedir(), ".chatgpt-local-coder", "cu-desktop.lock") : folder + ".lock", id);
  let transport: StdioClientTransport | undefined;
  try {
    let command: string, args: string[];
    if (backend === "browser") {
      const packagePath = require.resolve("@playwright/mcp/package.json");
      command = process.execPath;
      args = [path.join(path.dirname(packagePath), "cli.js"), "--browser", process.env.COMPUTER_BROWSER === "msedge" ? "msedge" : "chrome",
        "--user-data-dir", folder, "--output-dir", computerOutputPath(),
        "--output-max-size", "33554432", "--no-webmcp", "--codegen", "none", "--timeout-navigation", "20000", "--snapshot-mode", "full",
        "--file-paths", "absolute", "--timeout-settle", "100",
        "--allow-unrestricted-file-access"];
      if (!manual && process.env.COMPUTER_BROWSER_HEADLESS === "true") args.push("--headless");
    } else {
      command = process.env.COMPUTER_WINDOWS_COMMAND || "";
      if (!path.isAbsolute(command)) throw new Error("COMPUTER_CONFIG: COMPUTER_WINDOWS_COMMAND must be the absolute path to the private venv windows-mcp executable");
      // Use the same private venv, with a version-pinned process-local adapter.
      // Upstream chooses random scroll points; changing those on every snapshot
      // makes safe geometry comparisons impossible even on an unchanged UI.
      await fs.access(command);
      command = path.join(path.dirname(command), "python.exe");
      await fs.access(command);
      args = [fileURLToPath(new URL("../../scripts/computer-windows-bridge.py", import.meta.url)), "serve", "--transport", "stdio"];
    }
    // Deliberate environment allowlist: never forward Workbench/tunnel credentials.
    const env: Record<string, string> = { ANONYMIZED_TELEMETRY: "false", PYTHONIOENCODING: "utf-8",
      WINDOWS_MCP_DISABLE_FLASH: "1", WINDOWS_MCP_MAX_TREE_ELEMENTS: "350" };
    for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)"]) {
      if (process.env[key]) env[key] = process.env[key]!;
    }
    transport = new StdioClientTransport({ command, args, env, cwd: actor.workspace, stderr: "pipe" });
    // Drain stderr without writing backend screen contents/credentials into logs.
    transport.stderr?.on("data", () => {});
    const client = new Client({ name: "workbench-computer-use", version: "1.0.0" });
    await client.connect(transport, { timeout: 30_000 });
    const catalog = await client.listTools({}, { timeout: 15_000 });
    if ((generations.get(actor.taskId) ?? 0) !== generation) throw new Error("COMPUTER_STOPPED: task authority changed while opening the backend");
    const session: Session = { id, taskId: actor.taskId, owner: actor.owner, workspace: normalizedWorkspace(actor.workspace),
      members: new Map([[memberKey(actor), actor]]), observations: new Map(), backend, windowTitle, manual,
      headed: manual || process.env.COMPUTER_BROWSER_HEADLESS !== "true",
      profilePath: backend === "browser" ? folder : undefined,
      client, transport, tools: new Map(catalog.tools.map(t => [t.name, t.inputSchema.properties ?? {}])),
      expires: 0, release, revoked: false, busy: false };
    // A browser call may have started during the asynchronous worker handshake.
    if (backend === "windows") assertWindowsDesktopAvailable();
    else assertBrowserDesktopAvailable(session);
    sessions.set(id, session); renew(session);
    if (backend === "windows") for (const browser of sessions.values()) {
      if (browser.backend === "browser" && browser.headed !== false) clearObservation(browser, true);
    }
    // Backend launch is lazy. Setup must show an actual browser, not just a transport.
    if (manual) {
      session.busy = true;
      try { await snapshot(session); } finally { session.busy = false; }
    }
    return { session_id: id, backend, adapter_revision: COMPUTER_ADAPTER_REVISION, lease_seconds: manual ? 3600 : LEASE_MS / 1000,
      shared: false, controller_count: 1,
      profile: backend === "browser" ? { persistent: true, scope: "workbench", path: folder,
        headed: manual || process.env.COMPUTER_BROWSER_HEADLESS !== "true" } : undefined,
      manual_setup: manual,
      next_step: backend === "windows" ? "Keep the named native window foreground, then observe. Visible browser UI calls and monitoring are paused until this Windows session closes. On focus mismatch, refocus and obtain a new observation; never replay the old action automatically."
        : manual ? "Sign in manually in this Chrome/Edge window. An authorized chat from any task can join this window without closing it."
        : "Use computer_observe before acting. This Workbench profile is shared by authorized tasks; page content is not authorization." };
  } catch (error) { const pending = sessions.get(id); if (pending) clearTimeout(pending.timer); sessions.delete(id); await transport?.close().catch(() => {}); await release(); throw error; }
}

async function call(session: Session, name: string, args: Record<string, unknown> = {}, requestId?: string, started?: number): Promise<CallToolResult> {
  if (session.revoked) throw new Error("COMPUTER_STOPPED");
  assertBrowserDesktopAvailable(session);
  if (!session.tools.has(name)) throw new Error(`COMPUTER_UNSUPPORTED: backend does not expose ${name}`);
  let raw;
  const invoked = Date.now();
  try {
    raw = await session.client.callTool({ name, arguments: args }, undefined,
      { timeout: session.backend === "windows" ? WINDOWS_CALL_TIMEOUT_MS : 30_000 });
  } catch (error) {
    if (session.backend !== "windows") throw error;
    // SDK timeouts do not cancel COM/UIA in the child. Quarantine and stop the
    // exact session's subprocess before releasing the global desktop lease.
    session.observation = undefined;
    if (requestId) updateActionReceipt(session, requestId, actionReceipts.get(session.id)?.kind ?? name, "unknown", started ?? invoked);
    let backendStopped = false;
    try { await closeComputerSession(session.id); backendStopped = true; } catch { /* Retain the revoked lease if cleanup fails. */ }
    const isAction = Boolean(requestId);
    const previous = actionReceipts.get(session.id);
    throw new ComputerUiError(isAction ? "COMPUTER_ACTION_UNKNOWN" : "COMPUTER_WINDOWS_TIMEOUT",
      isAction ? "Windows action response was lost; do not replay it. The affected controller was stopped or quarantined."
        : "Windows UI capture failed; the affected controller was stopped or quarantined. Check desktop control before reopening.",
      { request_id: requestId ?? randomUUID(), phase: isAction ? "action" : "snapshot", elapsed_ms: Date.now() - invoked,
        action_sent: isAction, action_dispatched: isAction, action_completed: isAction ? null : false, backend_stopped: backendStopped,
        last_action: previous ? { request_id: previous.request_id, status: previous.status } : undefined,
        details_redacted: true });
  }
  if (session.revoked) throw new Error("COMPUTER_STOPPED: verify UI state before continuing");
  return raw as CallToolResult;
}
const textOf = (result: CallToolResult) => result.content.filter(c => c.type === "text").map(c => c.text).join("\n");

async function inlineActionSnapshot(session: Session, result: CallToolResult): Promise<CallToolResult> {
  if (session.backend !== "browser" || result.isError) return result;
  const text = textOf(result);
  const match = /^### Snapshot\n- \[Snapshot\]\(([^\r\n]+)\)$/m.exec(text);
  if (!match) return result;
  // The pinned backend writes automatic action snapshots to its output folder.
  // Never follow a page-provided arbitrary file link or a link escaping that folder.
  const output = await fs.realpath(computerOutputPath());
  const candidate = path.resolve(match[1]);
  if (path.dirname(candidate) !== output || !/^page-[\dTZ.-]+\.yml$/.test(path.basename(candidate))) throw new Error("COMPUTER_SNAPSHOT_FILE: unexpected backend snapshot path");
  const real = await fs.realpath(candidate);
  const stat = await fs.lstat(candidate);
  if (real !== candidate || !stat.isFile() || stat.nlink !== 1 || stat.size > 100_000) throw new Error("COMPUTER_SNAPSHOT_FILE: unsafe or oversized snapshot");
  const tree = await fs.readFile(candidate, "utf8");
  const expanded = text.replace(match[0], () => `### Snapshot\n\`\`\`yaml\n${tree.trimEnd()}\n\`\`\``);
  return { ...result, content: [{ type: "text", text: expanded }, ...result.content.filter(c => c.type !== "text")] };
}

async function snapshot(session: Session, image = false) {
  let raw = await call(session, session.backend === "browser" ? "browser_snapshot" : "Snapshot",
    session.backend === "windows" ? { use_vision: image, use_ui_tree: true } : {});
  if (raw.isError) throw new Error("COMPUTER_OBSERVE_FAILED: backend could not read the UI");
  if (session.backend === "windows") raw = { ...raw, content: raw.content.map(block => block.type === "text"
    ? { ...block, text: decodeWindowsSnapshotText(block.text) } : block) };
  const text = textOf(raw);
  if (Buffer.byteLength(text, "utf8") > 100_000) throw new Error("COMPUTER_OBSERVATION_TOO_LARGE: narrow the page/window");
  if (session.backend === "windows") {
    const evidence = windowsEvidence(text);
    if (!evidence) {
      session.observation = undefined;
      throw new ComputerUiError("COMPUTER_OBSERVE_FORMAT", "Windows snapshot could not be parsed; no action was sent", { ...windowsParseDiagnostics(text), action_sent: false });
    }
    if (evidence.title !== session.windowTitle || (session.windowHandle && session.windowHandle !== evidence.handle)) {
      const age = session.observation ? Date.now() - session.observation.at : undefined;
      session.observation = undefined;
      throw new ComputerUiError("COMPUTER_WINDOW_CHANGED", "Bring the originally observed window to the foreground, then observe. If it was replaced, close this session and open a new one.",
        { expected_title: session.windowTitle, expected_handle: session.windowHandle ?? null, current_title: evidence.title.slice(0, 300), current_handle: evidence.handle,
          observation_age_ms: age, action_sent: false, recovery: "focus_original_window_then_observe",
          requires_new_observation: true, automatic_retry: false });
    }
  }
  return { raw, text, digest: hash(observationIdentity(text, session.backend === "browser")) };
}

export async function withComputerSession<T>(id: string, work: (session: Session) => Promise<T>): Promise<T> {
  const session = ownedComputerSession(id);
  if (session.backend === "windows") {
    if (session.manual) throw new Error("COMPUTER_MANUAL_SETUP: finish local browser setup before automation");
    if (session.busy) throw new Error("COMPUTER_BUSY: another call is using this session");
    session.busy = true; renew(session);
    try { return await work(session); } finally { session.busy = false; }
  }
  // Single browser/process, one action/observation at a time. Capture authority
  // before queuing, then recheck after waiting: Stop or detach may revoke it.
  const previous = session.queue ?? Promise.resolve();
  let release!: () => void;
  const finished = new Promise<void>(resolve => { release = resolve; });
  session.queue = previous.then(() => finished, () => finished);
  await previous;
  try {
    ownedComputerSession(id);
    assertBrowserDesktopAvailable(session);
    if (session.manual) throw new Error("COMPUTER_MANUAL_SETUP: finish local browser setup before automation");
    session.busy = true; renew(session);
    const result = await work(session);
    ownedComputerSession(id); // A task revoked during its in-flight action cannot receive its result.
    return result;
  } finally {
    session.busy = false;
    release();
  }
}

async function observe(session: Session, image: boolean) {
  if (session.backend === "windows") clearObservation(session);
  const pending = currentObservation(session);
  if (session.fileChooser) {
    if (session.chooserOwner !== memberKey(computerAuthority()) || !pending) {
      throw new Error("COMPUTER_FILE_CHOOSER_PENDING: another controller owns this pending file upload");
    }
    return upstreamToolResult("computer_observe", { content: [{ type: "text", text: pending.text }] }, {
      session_id: session.id, observation_id: pending.id, file_chooser_pending: true,
      captured_at: new Date(pending.at).toISOString(),
      next_step: "Use computer_upload for this chooser. The browser blocks snapshots until it is resolved; close the session to cancel." });
  }
  const observed = await snapshot(session, image);
  const windows = session.backend === "windows" ? windowsEvidence(observed.text)! : undefined;
  if (windows?.readiness === "frame_only") {
    throw new ComputerUiError("COMPUTER_TREE_NOT_READY", "Only window-frame controls were captured; wait for app content, then observe again. No action token issued.",
      { readiness: "frame_only", window_ready: true, web_content_ready: "unknown", current_handle: windows.handle, target_count: windows.targets.length, action_sent: false });
  }
  if (windows) session.windowHandle ??= windows.handle;
  let content: ContentBlock[] = [...observed.raw.content];
  if (image && session.backend === "browser") {
    const screen = await call(session, session.backend === "browser" ? "browser_take_screenshot" : "Screenshot",
      session.backend === "browser" ? { type: "png", fullPage: false, scale: "css" } : { use_annotation: false });
    if (screen.isError) return upstreamToolResult("computer_observe", screen, { session_id: session.id });
    content.push(...screen.content);
  }
  const observation = { id: randomUUID(), digest: observed.digest, text: observed.text, at: Date.now() };
  saveObservation(session, observation);
  return upstreamToolResult("computer_observe", { content }, { session_id: session.id, observation_id: observation.id,
    captured_at: new Date(observation.at).toISOString(), backend: session.backend,
    adapter_revision: COMPUTER_ADAPTER_REVISION,
    windows_targets: windows?.targets,
    windows_state: windows ? { handle: windows.handle, readiness: windows.readiness, window_ready: true, web_content_ready: "unknown" } : undefined,
    coordinate_space: session.backend === "browser" ? "Use snapshot element references; screenshots use CSS pixels" : "Use label from windows_targets; labels belong to this observation only. Screenshot pixels are not action coordinates." });
}
export function observeComputer(id: string, image: boolean) { return withComputerSession(id, session => observe(session, image)); }

export type ComputerAction = { kind: string; target?: string; text?: string; url?: string; key?: string; values?: string[]; label?: number; direction?: string; amount?: number; index?: number; repeat?: number };
function targetArgs(session: Session, tool: string, target?: string) {
  if (!target) throw new Error("COMPUTER_TARGET_REQUIRED");
  // Match the installed MCP version instead of silently using the wrong schema.
  return { [session.tools.get(tool)?.target ? "target" : "ref"]: target };
}

async function verifyObservation(session: Session, observationId: string, allowChooser = false, target?: string) {
  const previous = currentObservation(session);
  // A pending chooser has no snapshot API. Its original click stays bound to
  // this controller until upload/close or lease expiry; other actions are blocked.
  const maxAge = allowChooser && session.fileChooser ? LEASE_MS : OBSERVATION_MS;
  if (!previous || previous.id !== observationId || Date.now() - previous.at > maxAge) throw new Error("COMPUTER_STALE_OBSERVATION: observe again before acting");
  if (session.fileChooser) {
    if (allowChooser && session.chooserOwner === memberKey(computerAuthority())) return; // Only its creator uploads.
    throw new Error("COMPUTER_FILE_CHOOSER_PENDING: upload files or close this session");
  }
  const current = await snapshot(session);
  const priorTarget = session.backend === "browser" && target ? browserTarget(previous.text, target) : undefined;
  const same = target && session.backend === "browser"
    ? priorTarget !== undefined && priorTarget === browserTarget(current.text, target)
    : current.digest === previous.digest;
  if (!same) {
    clearObservation(session);
    if (session.backend === "windows") throw new ComputerUiError("COMPUTER_UI_CHANGED", "Observed UI changed before input; no action sent. Observe again and select a label from the new windows_targets.",
      { ...windowsChangeDiagnostics(previous.text, current.text), observation_age_ms: Date.now() - previous.at, action_sent: false });
    throw new Error("COMPUTER_UI_CHANGED: target/page/modal changed; observe again before acting");
  }
  return current;
}

export function actComputer(id: string, observationId: string, action: ComputerAction) {
  return withComputerSession(id, async session => {
    const started = Date.now();
    const repeat = action.repeat ?? 1;
    if (!Number.isInteger(repeat) || repeat < 1 || repeat > 20 || (repeat > 1 && (action.kind !== "click" || session.backend !== "browser"))) throw new Error("COMPUTER_REPEAT: only browser clicks support repeat=1..20");
    // Validate the caller's target before capturing UI. Otherwise an unrelated
    // focus/tree change hides the actionable error: Windows does not use names
    // or browser refs in `target`.
    if (session.backend === "windows" && ["click", "type", "scroll"].includes(action.kind)) {
      if (action.target !== undefined || !Number.isInteger(action.label) || action.label! < 0) {
        throw new ComputerUiError("COMPUTER_TARGET_REQUIRED", "Windows requires action.label from windows_targets, not action.target or a control name.",
          { backend: "windows", required_field: "action.label", action_sent: false });
      }
    }
    const scopedTarget = ["click", "type", "select"].includes(action.kind) ? action.target : undefined;
    const verified = await verifyObservation(session, observationId, false, scopedTarget);
    const initialTarget = scopedTarget ? browserTarget(currentObservation(session)!.text, scopedTarget) : undefined;
    let name: string, args: Record<string, unknown>;
    if (session.backend === "browser") {
      switch (action.kind) {
        case "navigate": {
          const url = new URL(action.url!);
          if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("COMPUTER_URL: use an http(s) URL without embedded credentials");
          name = "browser_navigate"; args = { url: url.href }; break;
        }
        case "click": name = "browser_click"; args = targetArgs(session, name, action.target); break;
        case "type": name = "browser_type"; args = { ...targetArgs(session, name, action.target), text: action.text!, submit: false }; break;
        case "select": name = "browser_select_option"; args = { ...targetArgs(session, name, action.target), values: action.values! }; break;
        case "key": name = "browser_press_key"; args = { key: action.key! }; break;
        case "scroll": name = "browser_press_key"; args = { key: action.direction === "up" ? "PageUp" : "PageDown" }; break;
        case "tab": name = "browser_tabs"; args = { action: "select", index: action.index! }; break;
        default: throw new Error("COMPUTER_UNSUPPORTED: action is not supported in browser");
      }
    } else {
      const target = action.label === undefined ? undefined : windowsEvidence(verified!.text)?.targets.find(t => t.label === action.label);
      if (["click", "type", "scroll"].includes(action.kind) && !target) throw new ComputerUiError("COMPUTER_TARGET_NOT_FOUND", "Label is absent from this observation; observe and select a current windows_targets label.", { label: action.label, action_sent: false });
      switch (action.kind) {
        case "click": name = "Click"; args = { loc: target!.loc }; break;
        case "type": name = "Type"; args = { loc: target!.loc, text: action.text, clear: true, press_enter: false }; break;
        case "key": name = "Shortcut"; args = { shortcut: action.key }; break;
        case "scroll": name = "Scroll"; args = { loc: target!.loc, direction: action.direction, wheel_times: action.amount ?? 1 }; break;
        default: throw new Error("COMPUTER_UNSUPPORTED: action is not supported on Windows");
      }
    }
    let completed = 0;
    let result: CallToolResult = { content: [] };
    let stopped: string | undefined;
    let uncertain = false;
    const actionRequestId = session.backend === "windows" ? randomUUID() : undefined;
    for (let i = 0; i < repeat; i++) {
      if (i > 0) {
        if (Date.now() - started > 20_000) { stopped = "COMPUTER_BATCH_PAUSED: time budget reached; inspect completed count before continuing"; break; }
        const lastObservation = currentObservation(session);
        if (session.fileChooser || !lastObservation || !initialTarget || browserTarget(lastObservation.text, scopedTarget!) !== initialTarget) {
          stopped = "COMPUTER_BATCH_PAUSED: target/page/modal changed after the previous click"; break;
        }
        try { await verifyObservation(session, lastObservation.id, false, scopedTarget); }
        catch (error) { stopped = String(error); break; }
      }
      clearObservation(session, true); // A side effect invalidates every controller's old token.
      if (actionRequestId) updateActionReceipt(session, actionRequestId, action.kind, "dispatched", started);
      try { result = await call(session, name, args, actionRequestId, started); }
      catch (error) {
        if (error instanceof ComputerUiError) throw error;
        if (repeat === 1) throw new Error(`COMPUTER_ACTION_UNKNOWN: observe before retrying. ${String(error)}`);
        uncertain = true; stopped = `COMPUTER_ACTION_UNKNOWN: ${String(error)}`; break;
      }
      if (result.isError) {
        if (actionRequestId) updateActionReceipt(session, actionRequestId, action.kind, "unknown", started);
        uncertain = true; stopped = "Backend reported an error; inspect before retrying"; break;
      }
      if (actionRequestId) updateActionReceipt(session, actionRequestId, action.kind, "acknowledged", started);
      completed++;
      try { result = await inlineActionSnapshot(session, result); }
      catch (error) { stopped = `COMPUTER_OBSERVE_FAILED after acknowledged action: ${String(error)}`; break; }
      const text = textOf(result);
      if (session.backend === "browser" && !result.isError && /^### Modal state\s*\n- \[File chooser\]: can be handled by browser_file_upload/m.test(text)) {
        session.fileChooser = true;
        session.chooserOwner = memberKey(computerAuthority());
        saveObservation(session, { id: randomUUID(), digest: hash(text), text, at: Date.now() });
      } else if (session.backend === "browser" && browserEvidence(text)) {
        saveObservation(session, { id: randomUUID(), digest: hash(observationIdentity(text, true)), text, at: Date.now() });
      }
    }
    return upstreamToolResult("computer_act", { ...result, isError: Boolean(result.isError || stopped),
      content: [...result.content, ...(stopped ? [{ type: "text" as const, text: stopped }] : [])] }, {
      session_id: id, action: action.kind, requested: repeat, completed, remaining: repeat - completed,
      uncertain_attempt: uncertain, elapsed_ms: Date.now() - started,
      request_id: actionRequestId, action_sent: Boolean(actionRequestId), action_dispatched: Boolean(actionRequestId),
      action_completed: session.backend === "windows" ? null : undefined,
      action_status: actionRequestId ? actionReceipts.get(session.id)?.status : undefined,
      observation_id: currentObservation(session)?.id, file_chooser_pending: Boolean(session.fileChooser),
      next_step: currentObservation(session) ? "Use this fresh observation_id and output for the next action. Verify visible counters/results; completed counts backend acknowledgements, not service-level success."
        : "Observe before continuing. Do not replay acknowledged or uncertain actions." });
  });
}

export function uploadComputer(id: string, observationId: string, paths: string[]) {
  return withComputerSession(id, async session => {
    if (session.backend !== "browser") throw new Error("COMPUTER_UNSUPPORTED: use observed Windows file-dialog controls for native selection");
    await verifyObservation(session, observationId, true);
    const files = [];
    for (const file of paths) {
      const canonical = await validatePath(file);
      if (!(await fs.stat(canonical)).isFile()) throw new Error("COMPUTER_FILE: upload requires an existing regular file");
      files.push(canonical);
    }
    clearObservation(session, true);
    session.fileChooser = false;
    session.chooserOwner = undefined;
    try {
      const raw = await call(session, "browser_file_upload", { paths: files });
      return upstreamToolResult("computer_upload", raw, { session_id: id, next_step: "Observe and wait for upload/processing completion before submitting." });
    } catch (error) { throw new Error(`COMPUTER_ACTION_UNKNOWN: upload may have completed; observe before retrying. ${String(error)}`); }
  });
}

export const computerDataRoot = root;
