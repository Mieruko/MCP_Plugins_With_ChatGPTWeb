import { spawn } from "child_process";
import path from "path";
import { executionContext, childEnvironment } from "./workbench-context.js";
import { validatePath } from "./path-security.js";
import { executionNeedsSandbox, spawnSandboxedShell, terminateSandboxContainer } from "./os-sandbox.js";

export interface ShellExecResult {
  command: string;
  cwd: string;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
}

import { loadGlobalShellState, saveGlobalShellState } from "./global-shell-state.js";

let sessionCwd: string | null = null;
let sessionInitializedAt: string | null = null;
let persistenceRoot: string | null = null;
const history: string[] = [];
const MAX_HISTORY = 50;
const taskShells = new Map<string, { cwd: string; started_at: string; history: string[] }>();
function taskShell() {
  const context = executionContext.getStore();
  if (!context) return undefined;
  let shell = taskShells.get(context.taskId);
  if (!shell) { shell = { cwd: context.workspace, started_at: new Date().toISOString(), history: [] }; taskShells.set(context.taskId, shell); }
  return shell;
}

export function setShellPersistenceRoot(workspaceRoot: string): void {
  persistenceRoot = path.resolve(workspaceRoot);
}

export function initShellSession(defaultCwd: string): void {
  sessionCwd = path.resolve(defaultCwd);
  sessionInitializedAt = new Date().toISOString();
  history.length = 0;
}

/** Restore cwd from disk (ChatGPT = new MCP session per tool call). */
export async function bootstrapShellSession(defaultCwd: string): Promise<void> {
  setShellPersistenceRoot(defaultCwd);
  const saved = await loadGlobalShellState(defaultCwd, defaultCwd);
  if (saved?.cwd) {
    sessionCwd = path.resolve(saved.cwd);
    sessionInitializedAt = saved.updated_at;
    if (saved.recent_commands?.length) {
      history.length = 0;
      history.push(...saved.recent_commands.slice(-MAX_HISTORY));
    }
    return;
  }
  initShellSession(defaultCwd);
}

export function getShellCwd(): string {
  if (!sessionCwd) throw new Error("Shell session not initialized");
  return sessionCwd;
}

export function resetShellSession(cwd: string): void {
  const task = taskShell();
  if (task) { task.cwd = path.resolve(cwd); return; }
  sessionCwd = path.resolve(cwd);
  sessionInitializedAt = new Date().toISOString();
  if (persistenceRoot) {
    void saveGlobalShellState(persistenceRoot, sessionCwd, undefined, null);
  }
}

export function getShellStatus() {
  const task = taskShell();
  if (task) return { active: true, cwd: task.cwd, started_at: task.started_at, recent_commands: task.history.slice(-10) };
  return {
    active: sessionCwd !== null,
    cwd: sessionCwd,
    started_at: sessionInitializedAt,
    recent_commands: [...history].slice(-10),
  };
}

function stripQuotes(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function resolveCdTarget(current: string, target: string): string {
  const cleaned = stripQuotes(target);
  if (cleaned === "-" || cleaned === "~") return current;
  return path.isAbsolute(cleaned) ? path.resolve(cleaned) : path.resolve(current, cleaned);
}

/** Cập nhật cwd khi gặp cd / Set-Location ở đầu command (giống Bash persistent). */
export function applyCwdDirectives(currentCwd: string, command: string): { cwd: string; command: string } {
  let cwd = currentCwd;
  let rest = command.trim();

  for (let i = 0; i < 8; i++) {
    const psMatch = rest.match(/^(?:Set-Location|sl)\s+(.+?)(?:\s*;\s*|\s*&&\s*|$)/i);
    if (psMatch) {
      cwd = resolveCdTarget(cwd, psMatch[1]);
      rest = rest.slice(psMatch[0].length).trim();
      continue;
    }

    const cdMatch = rest.match(/^cd(?:\s+(.+?))?(?:\s*;\s*|\s*&&\s*|$)/i);
    if (cdMatch) {
      if (cdMatch[1]) cwd = resolveCdTarget(cwd, cdMatch[1]);
      rest = rest.slice(cdMatch[0].length).trim();
      continue;
    }

    const pushdMatch = rest.match(/^pushd\s+(.+?)(?:\s*;\s*|\s*&&\s*|$)/i);
    if (pushdMatch) {
      cwd = resolveCdTarget(cwd, pushdMatch[1]);
      rest = rest.slice(pushdMatch[0].length).trim();
      continue;
    }

    break;
  }

  return { cwd, command: rest || "pwd" };
}

async function runOnce(command: string, cwd: string, timeoutMs: number): Promise<ShellExecResult> {
  const sandboxed = executionNeedsSandbox();
  const launched = sandboxed ? await spawnSandboxedShell(command, cwd) : undefined;
  return new Promise((resolve, reject) => {
    const shell = process.platform === "win32" ? "powershell.exe" : "bash";
    const args = process.platform === "win32" ? ["-NoProfile", "-Command", command] : ["-lc", command];
    const child = launched?.child ?? spawn(shell, args, { cwd, windowsHide: true, env: childEnvironment() });
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      if (launched) void terminateSandboxContainer(launched.containerName, true).finally(() => child.kill());
      else child.kill();
    }, timeoutMs);

    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Command timed out after ${timeoutMs / 1000}s`));
        return;
      }
      resolve({
        command,
        cwd,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exit_code: code,
        timed_out: false,
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export async function execInShellSession(
  command: string,
  defaultCwd: string,
  timeoutMs: number,
  workingDirectory?: string
): Promise<ShellExecResult> {
  const task = taskShell();
  if (task) {
    const parsed = applyCwdDirectives(workingDirectory || task.cwd, command);
    const safeCwd = executionContext.getStore()?.workspaceOnly ? await validatePath(parsed.cwd) : parsed.cwd;
    task.cwd = safeCwd;
    task.history.push(parsed.command);
    if (task.history.length > MAX_HISTORY) task.history.shift();
    return runOnce(parsed.command, safeCwd, timeoutMs);
  }
  if (!sessionCwd) initShellSession(defaultCwd);

  if (workingDirectory) {
    sessionCwd = path.resolve(await Promise.resolve(workingDirectory));
  }

  const { cwd, command: effective } = applyCwdDirectives(sessionCwd!, command);
  sessionCwd = executionContext.getStore()?.workspaceOnly ? await validatePath(cwd) : cwd;

  history.push(effective);
  if (history.length > MAX_HISTORY) history.shift();

  const result = await runOnce(effective, sessionCwd, timeoutMs);

  if (persistenceRoot) {
    const prev = await loadGlobalShellState(persistenceRoot, defaultCwd);
    await saveGlobalShellState(persistenceRoot, sessionCwd, effective, prev);
  }

  return result;
}
