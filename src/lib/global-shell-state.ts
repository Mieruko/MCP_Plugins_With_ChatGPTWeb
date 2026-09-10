import { createHash } from "node:crypto";
import fs from "fs/promises";
import path from "path";

export interface GlobalShellState {
  workspace_key: string;
  cwd: string;
  updated_at: string;
  recent_commands: string[];
}

function stateDirectory(): string { return process.env.MCP_SHELL_STATE_DIR || path.join(process.cwd(), ".mcp-state"); }
const MAX_RECENT = 20;

function workspaceKey(workspaceRoot: string): string {
  return createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex").slice(0, 16);
}

function statePath(workspaceRoot: string): string {
  return path.join(stateDirectory(), `shell-${workspaceKey(workspaceRoot)}.json`);
}

export async function loadGlobalShellState(
  workspaceRoot: string,
  defaultCwd: string
): Promise<GlobalShellState | null> {
  try {
    const raw = await fs.readFile(statePath(workspaceRoot), "utf-8");
    const parsed = JSON.parse(raw) as GlobalShellState;
    if (!parsed.cwd) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveGlobalShellState(
  workspaceRoot: string,
  cwd: string,
  command?: string,
  previous?: GlobalShellState | null
): Promise<void> {
  const recent = [...(previous?.recent_commands ?? [])];
  if (command) {
    recent.push(command);
    while (recent.length > MAX_RECENT) recent.shift();
  }

  const state: GlobalShellState = {
    workspace_key: workspaceKey(workspaceRoot),
    cwd: path.resolve(cwd),
    updated_at: new Date().toISOString(),
    recent_commands: recent,
  };

  await fs.mkdir(stateDirectory(), { recursive: true });
  await fs.writeFile(statePath(workspaceRoot), JSON.stringify(state, null, 2), "utf-8");
}

export async function restoreShellFromDisk(
  workspaceRoot: string,
  defaultCwd: string
): Promise<string> {
  const saved = await loadGlobalShellState(workspaceRoot, defaultCwd);
  return saved?.cwd ?? path.resolve(defaultCwd);
}
