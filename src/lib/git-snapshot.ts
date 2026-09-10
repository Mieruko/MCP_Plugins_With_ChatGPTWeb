import { spawn } from "child_process";
import os from "os";
import { executionContext } from "./workbench-context.js";

interface GitRunResult {
  stdout: string;
  stderr: string;
  exit_code: number;
}

function runGit(args: string[], cwd: string): Promise<GitRunResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => {
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exit_code: code ?? 1 });
    });
    child.on("error", () => resolve({ stdout: "", stderr: "git not found", exit_code: 127 }));
  });
}

export interface GitSnapshot {
  is_repo: boolean;
  branch?: string;
  status_short?: string;
  recent_commits?: string[];
  error?: string;
}

export async function collectGitSnapshot(cwd: string): Promise<GitSnapshot> {
  if (executionContext.getStore()?.workspaceOnly) return { is_repo: false, error: "Git discovery deferred until task grants process execution" };
  const root = await runGit(["rev-parse", "--show-toplevel"], cwd);
  if (root.exit_code !== 0) {
    return { is_repo: false, error: root.stderr || "not a git repository" };
  }

  const [branch, status, log] = await Promise.all([
    runGit(["branch", "--show-current"], cwd),
    runGit(["status", "--short", "--branch"], cwd),
    runGit(["log", "-3", "--oneline", "--no-decorate"], cwd),
  ]);

  return {
    is_repo: true,
    branch: branch.stdout || "(detached)",
    status_short: status.stdout.slice(0, 1200),
    recent_commits: log.stdout ? log.stdout.split("\n").filter(Boolean) : [],
  };
}

export function formatGitSnapshotForInstructions(snapshot: GitSnapshot): string {
  if (!snapshot.is_repo) {
    return "## Git\nNot a git repository at WORKSPACE_PATH (or git unavailable).";
  }

  const lines = [
    "## Git (auto-loaded like Claude Code)",
    `Branch: ${snapshot.branch}`,
    "Status:",
    snapshot.status_short || "(clean)",
  ];
  if (snapshot.recent_commits?.length) {
    lines.push("Recent commits:", ...snapshot.recent_commits.map((c) => `- ${c}`));
  }
  return lines.join("\n");
}

export function formatEnvironmentForInstructions(opts: {
  workspaceRoot: string;
  workspaceRoots: string[];
  pid: number;
  adminPort: number;
  nodeVersion: string;
}): string {
  return [
    "## Environment",
    `Platform: ${process.platform} ${os.release()} (${os.arch()})`,
    `Node: ${opts.nodeVersion}`,
    `MCP PID: ${opts.pid}`,
    `Default cwd (WORKSPACE_PATH): ${opts.workspaceRoot}`,
    `Admin UI: http://127.0.0.1:${opts.adminPort}/ui`,
    opts.workspaceRoots.length > 1
      ? `Additional workspace roots:\n${opts.workspaceRoots.slice(1).map((r) => `- ${r}`).join("\n")}`
      : "",
    "Relative paths resolve from default cwd. Use absolute paths when working outside it.",
  ]
    .filter(Boolean)
    .join("\n");
}
