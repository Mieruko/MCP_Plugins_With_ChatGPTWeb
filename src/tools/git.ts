import { spawn } from "child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validatePath, getDefaultCwd } from "../lib/path-security.js";
import { audit } from "../lib/audit.js";
import { requireWriteAllowed } from "../lib/permissions.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolResult } from "../lib/tool-result.js";
import { requireUnrestrictedExecution, childEnvironment } from "../lib/workbench-context.js";
import { executionNeedsSandbox, spawnSandboxedProgram, terminateSandboxContainer } from "../lib/os-sandbox.js";

interface GitRunResult {
  stdout: string;
  stderr: string;
  exit_code: number;
}

interface GitStatusEntry {
  path: string;
  status: string;
  original_path?: string;
}

interface LinkedWorktreeSandbox {
  env: Record<string, string>;
  mounts: Array<{ hostPath: string; containerPath: string }>;
}

async function linkedWorktreeSandbox(cwd: string): Promise<LinkedWorktreeSandbox | undefined> {
  const dotGit = path.join(cwd, ".git");
  let stat;
  try { stat = await fs.stat(dotGit); } catch { return undefined; }
  if (!stat.isFile()) return undefined;
  const marker = (await fs.readFile(dotGit, "utf8")).trim();
  const match = marker.match(/^gitdir:\s*(.+)$/i);
  if (!match) return undefined;
  const gitDir = path.resolve(cwd, match[1]);
  const commonMarker = (await fs.readFile(path.join(gitDir, "commondir"), "utf8")).trim();
  const commonDir = path.resolve(gitDir, commonMarker);
  const relativeGitDir = path.relative(commonDir, gitDir).split(path.sep).join("/");
  if (!relativeGitDir || relativeGitDir.startsWith("../") || path.isAbsolute(relativeGitDir)) {
    throw new Error("Invalid linked worktree Git metadata layout");
  }
  return {
    env: {
      GIT_DIR: `/git-common/${relativeGitDir}`,
      GIT_COMMON_DIR: "/git-common",
      GIT_WORK_TREE: "/workspace",
    },
    mounts: [{ hostPath: commonDir, containerPath: "/git-common" }],
  };
}

function parsePorcelainV2(raw: string) {
  const staged: GitStatusEntry[] = [];
  const unstaged: GitStatusEntry[] = [];
  const untracked: GitStatusEntry[] = [];
  let branch = "";
  let head_oid = "";
  let upstream = "";
  let ahead = 0;
  let behind = 0;
  const records = raw.split("\0").filter(Boolean);
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.startsWith("# branch.head ")) { branch = record.slice(14); continue; }
    if (record.startsWith("# branch.oid ")) { head_oid = record.slice(13); continue; }
    if (record.startsWith("# branch.upstream ")) { upstream = record.slice(18); continue; }
    if (record.startsWith("# branch.ab ")) {
      const match = record.match(/\+(\d+)\s+-(\d+)/);
      if (match) { ahead = Number(match[1]); behind = Number(match[2]); }
      continue;
    }
    if (record.startsWith("? ")) { untracked.push({ path: record.slice(2), status: "?" }); continue; }
    if (record.startsWith("! ")) continue;
    const ordinary = record.match(/^1 ([^ ]{2}) [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ (.*)$/);
    const renamed = record.match(/^2 ([^ ]{2}) [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ [^ ]+ (.*)$/);
    const match = ordinary || renamed;
    if (!match) continue;
    const xy = match[1];
    const path = match[2];
    const original_path = renamed ? records[++i] : undefined;
    if (xy[0] !== ".") staged.push({ path, status: xy[0], ...(original_path ? { original_path } : {}) });
    if (xy[1] !== ".") unstaged.push({ path, status: xy[1], ...(original_path ? { original_path } : {}) });
  }
  return { branch: branch === "(detached)" ? "" : branch, head_oid, upstream, ahead, behind, staged, unstaged, untracked };
}

async function runGit(args: string[], cwd: string): Promise<GitRunResult> {
  const sandboxed = executionNeedsSandbox();
  const linked = sandboxed ? await linkedWorktreeSandbox(cwd) : undefined;
  const launched = sandboxed ? await spawnSandboxedProgram(
    "git",
    ["--no-pager", "-c", "core.fsmonitor=false", "-c", "safe.directory=*", ...args],
    cwd,
    { GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "false", GIT_SEQUENCE_EDITOR: "false", ...(linked?.env || {}) },
    linked?.mounts || [],
  ) : undefined;
  if (!sandboxed) requireUnrestrictedExecution();
  return new Promise((resolve, reject) => {
    const child = launched?.child ?? spawn("git", ["--no-pager", "-c", "core.fsmonitor=false", ...args], { cwd, windowsHide: true,
      env: { ...childEnvironment(), GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "false", GIT_SEQUENCE_EDITOR: "false" } });
    const timer = setTimeout(() => {
      if (launched) void terminateSandboxContainer(launched.containerName, true).finally(() => child.kill());
      else child.kill();
      reject(new Error("Git timed out after 120 seconds"));
    }, 120_000);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout = (stdout + d.toString()).slice(-200000)));
    child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-200000)));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exit_code: code ?? 1 });
    });
    child.on("error", () => { clearTimeout(timer); reject(new Error("git not found. Install Git for Windows.")); });
  });
}

async function gitOrThrow(args: string[], cwd: string): Promise<GitRunResult> {
  const result = await runGit(args, cwd);
  if (result.exit_code !== 0) {
    throw new Error(result.stderr || result.stdout || `git exited with code ${result.exit_code}`);
  }
  return result;
}

export function registerGitTools(server: McpServer, defaultCwd: string): void {
  const repo = async (p?: string) => validatePath(p || getDefaultCwd());
  const ref = z.string().min(1).regex(/^[A-Za-z0-9_][A-Za-z0-9_./@{}~^+-]*$/, "Invalid ref or option-like value");

  server.registerTool("git_status", {
    title: "Git Status", description: "Show git working tree status.",
    inputSchema: { path: z.string().optional() },

    annotations: toolAnnotations("read"),
  }, async ({ path: repoPath }) => {
    const cwd = await repo(repoPath);
    const [r, porcelain] = await Promise.all([
      gitOrThrow(["status", "--short", "--branch"], cwd),
      gitOrThrow(["status", "--porcelain=v2", "--branch", "-z"], cwd),
    ]);
    const status = parsePorcelainV2(porcelain.stdout);
    await audit({ tool: "git_status", action: "git", target: cwd, status: "ok" });
    return toolResult("git_status", { path: cwd, output: r.stdout || "Clean working tree", ...status });
  });

  server.registerTool("git_init", {
    title: "Initialize Git Repository",
    description: "Initialize a Git repository in the current task environment.",
    inputSchema: { path: z.string().optional() },
    annotations: toolAnnotations("edit"),
  }, async ({ path: repoPath }) => {
    requireWriteAllowed();
    const cwd = await repo(repoPath);
    const r = await gitOrThrow(["init"], cwd);
    await audit({ tool: "git_init", action: "git", target: cwd, status: "ok" });
    return toolResult("git_init", { path: cwd, output: r.stdout || r.stderr || "Git repository initialized" });
  });

  server.registerTool("git_diff", {
    title: "Git Diff", description: "Show unstaged or staged changes.",
    inputSchema: { path: z.string().optional(), staged: z.boolean().optional().default(false), file: z.string().optional() },

    annotations: toolAnnotations("read"),
  }, async ({ path: repoPath, staged, file }) => {
    const cwd = await repo(repoPath);
    const args = ["diff", "--no-ext-diff", "--no-textconv"];
    if (staged) args.push("--staged");
    if (file) args.push("--", file);
    const r = await gitOrThrow(args, cwd);
    return toolResult("git_diff", { path: cwd, staged, file, output: r.stdout || "No changes" });
  });

  server.registerTool("git_log", {
    title: "Git Log", description: "Show recent commit history.",
    inputSchema: { path: z.string().optional(), count: z.number().optional().default(10) },

    annotations: toolAnnotations("read"),
  }, async ({ path: repoPath, count }) => {
    const cwd = await repo(repoPath);
    const r = await gitOrThrow(["log", "--no-show-signature", "--oneline", "-n", String(count)], cwd);
    return toolResult("git_log", { path: cwd, count, commits: r.stdout.split("\n").filter(Boolean) });
  });

  server.registerTool("git_add", {
    title: "Git Add", description: "Stage files for commit.",
    inputSchema: { path: z.string().optional(), files: z.array(z.string()).optional(), all: z.boolean().optional().default(false) },

    annotations: toolAnnotations("edit"),
  }, async ({ path: repoPath, files, all }) => {
    requireWriteAllowed();
    const cwd = await repo(repoPath);
    const args = ["add"];
    if (all && (!files || files.length === 0)) args.push("-A");
    else if (files?.length) args.push("--", ...files);
    else throw new Error("Select files explicitly, or set all=true to stage every change");
    const r = await gitOrThrow(args, cwd);
    return toolResult("git_add", { path: cwd, files: files || ["-A"], output: r.stdout });
  });

  server.registerTool("git_commit", {
    title: "Git Commit", description: "Commit staged changes. Does not stage unrelated files by default. Review staged diff first.",
    inputSchema: {
      message: z.string(),
      path: z.string().optional(),
      stage_all: z.boolean().optional().default(false),
    },

    annotations: toolAnnotations("edit"),
  }, async ({ message, path: repoPath, stage_all }) => {
    requireWriteAllowed();
    const cwd = await repo(repoPath);
    if (stage_all) await gitOrThrow(["add", "-A"], cwd);
    const r = await gitOrThrow(["commit", "-m", message], cwd);
    await audit({ tool: "git_commit", action: "git", target: cwd, status: "ok", details: { message } });
    return toolResult("git_commit", { path: cwd, message, output: r.stdout });
  });

  server.registerTool("git_branch", {
    title: "Git Branch", description: "List/create/switch branches.",
    inputSchema: {
      path: z.string().optional(),
      action: z.enum(["list", "create", "switch", "create-and-switch"]).optional().default("list"),
      name: ref.optional(),
    },

    annotations: toolAnnotations("edit"),
  }, async ({ path: repoPath, action, name }) => {
    const cwd = await repo(repoPath);
    let args: string[];
    if (action === "list") args = ["branch", "--all"];
    else {
      requireWriteAllowed();
      if (!name) throw new Error("name is required");
      args = action === "create" ? ["branch", name] : action === "switch" ? ["switch", name] : ["switch", "-c", name];
    }
    const r = await gitOrThrow(args, cwd);
    return toolResult("git_branch", { path: cwd, action, name, output: r.stdout });
  });

  server.registerTool("git_checkout", {
    title: "Switch Git Branch",
    description:
      "Switch the current local repository to an existing branch. Local workspace only — does not modify remotes.",
    inputSchema: {
      path: z.string().optional(),
      branch: ref.describe("Existing branch name to switch to"),
    },

    annotations: toolAnnotations("edit"),
  }, async ({ path: repoPath, branch }) => {
    requireWriteAllowed();
    const cwd = await repo(repoPath);
    const r = await gitOrThrow(["switch", branch], cwd);
    return toolResult("git_checkout", {
      path: cwd,
      branch,
      output: r.stdout || r.stderr,
      run_command_fallback: `git switch ${branch}`,
    });
  });

  server.registerTool("git_restore", {
    title: "Restore Tracked Files",
    description:
      "Restore tracked file(s) in the current repo to the last committed version. Local workspace only.",
    inputSchema: {
      path: z.string().optional(),
      files: z.array(z.string()).min(1).describe("Repo-relative file paths to restore"),
      source: ref
        .optional()
        .default("HEAD")
        .describe("Revision to restore from (default HEAD)"),
    },

    annotations: toolAnnotations("edit"),
  }, async ({ path: repoPath, files, source }) => {
    requireWriteAllowed();
    const cwd = await repo(repoPath);
    let r: GitRunResult;
    const restore = await runGit(["restore", "--source", source, "--", ...files], cwd);
    if (restore.exit_code === 0) {
      r = restore;
    } else {
      r = await gitOrThrow(["checkout", source, "--", ...files], cwd);
    }
    return toolResult("git_restore", {
      path: cwd,
      files,
      source,
      output: r.stdout || r.stderr || "Restored",
      run_command_fallback: `git restore --source ${source} -- ${files.join(" ")}`,
    });
  });

  server.registerTool("git_push", {
    title: "Sync Commits to Remote",
    description:
      "Upload local commits to the repository's configured remote (default origin). Uses the repo's existing remote URL.",
    inputSchema: {
      path: z.string().optional(),
      remote: ref.optional().default("origin"),
      branch: ref.describe("Exact branch to push; required to avoid configured multi-branch pushes"),
      set_upstream: z.boolean().optional().default(false),
    },

    annotations: toolAnnotations("edit"),
  }, async ({ path: repoPath, remote, branch, set_upstream }) => {
    requireUnrestrictedExecution();
    requireWriteAllowed();
    const cwd = await repo(repoPath);
    const args = ["push"];
    if (set_upstream) args.push("-u");
    args.push(remote);
    args.push(`refs/heads/${branch}:refs/heads/${branch}`);
    const r = await gitOrThrow(args, cwd);
    const cmd = ["git push", set_upstream ? "-u" : "", remote, branch ?? ""]
      .filter(Boolean)
      .join(" ");
    return toolResult("git_push", {
      path: cwd,
      remote,
      branch,
      output: r.stdout || r.stderr,
      run_command_fallback: cmd,
    });
  });

  server.registerTool("git_pull", {
    title: "Sync from Remote",
    description:
      "Download updates from the repository's configured remote into the local working copy.",
    inputSchema: { path: z.string().optional(), remote: ref.optional().default("origin"), branch: ref.optional() },

    annotations: toolAnnotations("edit"),
  }, async ({ path: repoPath, remote, branch }) => {
    requireUnrestrictedExecution();
    requireWriteAllowed();
    const cwd = await repo(repoPath);
    const args = ["pull", "--ff-only", remote];
    if (branch) args.push(branch);
    const r = await gitOrThrow(args, cwd);
    return toolResult("git_pull", { path: cwd, remote, branch, output: r.stdout || r.stderr });
  });

  server.registerTool("git_stash", {
    title: "Git Stash", description: "Stash list/push/pop/apply.",
    inputSchema: {
      path: z.string().optional(),
      action: z.enum(["list", "push", "pop", "apply"]).optional().default("list"),
      message: z.string().optional(),
    },

    annotations: toolAnnotations("edit"),
  }, async ({ path: repoPath, action, message }) => {
    const cwd = await repo(repoPath);
    const args = ["stash"];
    if (action === "list") args.push("list");
    else {
      requireWriteAllowed();
      if (action === "push") {
        args.push("push");
        if (message) args.push("-m", message);
      } else args.push(action);
    }
    const r = await gitOrThrow(args, cwd);
    return toolResult("git_stash", { path: cwd, action, output: r.stdout || r.stderr });
  });

  server.registerTool("git_reset", {
    title: "Git Reset",
    description:
      "Move HEAD to a ref in the local repo. mixed=unstage commits, soft=keep staged, hard=discard working changes.",
    inputSchema: {
      path: z.string().optional(),
      mode: z.enum(["soft", "mixed", "hard"]).optional().default("mixed"),
      ref: ref.optional().default("HEAD"),
    },

    annotations: toolAnnotations("edit"),
  }, async ({ path: repoPath, mode, ref }) => {
    requireWriteAllowed();
    const cwd = await repo(repoPath);
    const r = await gitOrThrow(["reset", `--${mode}`, ref], cwd);
    return toolResult("git_reset", { path: cwd, mode, ref, output: r.stdout || r.stderr });
  });

  server.registerTool("git_unstage", { title: "Unstage selected files", inputSchema: {
    path: z.string().optional(), files: z.array(z.string()).min(1),
  }, annotations: toolAnnotations("edit") }, async ({ path: p, files }) => {
    const cwd = await repo(p);
    const r = await gitOrThrow(["restore", "--staged", "--", ...files], cwd);
    return toolResult("git_unstage", r);
  });
  server.registerTool("git_fetch", { title: "Fetch remote", inputSchema: {
    path: z.string().optional(), remote: ref.default("origin"),
  }, annotations: toolAnnotations("command") }, async ({ path: p, remote }) => {
    requireUnrestrictedExecution();
    return toolResult("git_fetch", await gitOrThrow(["fetch", "--", remote], await repo(p)));
  });
  server.registerTool("git_worktree", { title: "Git worktrees", inputSchema: {
    path: z.string().optional(), action: z.enum(["list", "add"]), directory: z.string().optional(), branch: ref.optional(),
  }, annotations: toolAnnotations("command") }, async ({ path: p, action, directory, branch }) => {
    const cwd = await repo(p);
    if (action === "list") return toolResult("git_worktree", await gitOrThrow(["worktree", "list", "--porcelain"], cwd));
    requireUnrestrictedExecution();
    if (!directory || !branch) throw new Error("directory and new branch are required");
    const target = await validatePath(directory);
    return toolResult("git_worktree", await gitOrThrow(["worktree", "add", "-b", branch, "--", target], cwd));
  });
}
