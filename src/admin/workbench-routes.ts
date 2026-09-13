import fs from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpSessionSummary } from "../lib/mcp-session-manager.js";
import { attachTaskPreviewProcess, cancelAgentTaskAssignment, changeSetDetail, cleanupTaskIntegration, cloneWorkspace, createTask, createTaskCheckpoint, createWorkspace, decideOperation, discardTaskIntegration, dispatch, finishTaskIntegration, getAgentCoordinator, getIntegrationQueue, getWorkbench, latestWorkspaceChangeSet, listTaskCheckpoints, markTaskReadyForMerge, mergeTaskIntegration, operationDetail, prepareTaskPreviewStart, previewTaskCheckpoint, queueAgentTaskAssignment, releaseTaskPreviewPort, relocateWorkspace, removeWorkspace, reopenTaskIntegration, restoreTaskCheckpoint, selectTask, selectWorkspace, setTaskDescription, setTaskHandoff, setTaskIntegrationDependencies, setTaskPolicy, setTaskPreview, subscribeWorkbench, taskExecutionPath, undoChangeSet, undoOperation } from "../lib/workbench.js";
import { getMachineRoots } from "../lib/path-security.js";
import { registerFilesystemTools } from "../tools/filesystem.js";
import { registerShellTools } from "../tools/shell.js";
import { registerGitTools } from "../tools/git.js";
import { registerContextTools } from "../tools/context.js";
import { executeGithub, githubSchema } from "../tools/github.js";
import { getOAuthProvider } from "../lib/oauth-provider.js";
import { getTaskRuntime, stopTaskRuntimeProcesses } from "../lib/task-runtime.js";
import { getWorkspaceExperience, listWorkspaceChangeSets, setWorkspaceExperience, takeWorkspaceWriter } from "../lib/workbench.js";

export function createWorkbenchRouter(options: { sessionList?: () => McpSessionSummary[] } = {}): Router {
  const router = Router();
  type Definition = { config: any; handler: any };
  const collect = (register: (server: McpServer) => void) => {
    const definitions = new Map<string, Definition>();
    register({ registerTool: (name: string, config: any, handler: any) => { definitions.set(name, { config, handler }); } } as unknown as McpServer);
    return definitions;
  };
  const filesystemDefinitions = collect(registerFilesystemTools);
  const task = async (id: string) => {
    const found = (await getWorkbench()).tasks.find(t => t.id === id);
    if (!found) throw new Error("Unknown task");
    return found;
  };
  const executionRoot = (value: Awaited<ReturnType<typeof task>>) => taskExecutionPath(value);
  const parseWorktrees = (raw: string) => raw.split(/\r?\n\r?\n/).map(block => {
    const item: { path?: string; head?: string; branch?: string; detached?: boolean } = {};
    for (const line of block.split(/\r?\n/).filter(Boolean)) {
      if (line.startsWith("worktree ")) item.path = line.slice(9);
      else if (line.startsWith("HEAD ")) item.head = line.slice(5);
      else if (line.startsWith("branch ")) item.branch = line.slice(7).replace(/^refs\/heads\//, "");
      else if (line === "detached") item.detached = true;
    }
    return item.path ? item : null;
  }).filter(Boolean);
  const invoke = async (taskId: string, tool: string, rawArgs: Record<string, unknown>, definitions: Map<string, Definition>, human = true, environment?: Record<string, string>) => {
    const found = await task(taskId);
    const def = definitions.get(tool);
    if (!def) throw new Error(`Unknown tool: ${tool}`);
    const args = z.object(def.config.inputSchema).strict().parse(rawArgs);
    const result: any = await dispatch(found.id, tool, args, () => def.handler(args, { signal: undefined }), human, undefined, environment);
    return result?.structuredContent?.data ?? result?.structuredContent ?? result;
  };
  const shellDefinitions = (workspace: string) => collect(server => registerShellTools(server, workspace, Number(process.env.SHELL_TIMEOUT || 120)));
  const gitDefinitions = (workspace: string) => collect(server => registerGitTools(server, workspace));
  const contextDefinitions = (workspace: string) => collect(server => registerContextTools(server, workspace));
  const normalizePreviewUrl = (raw: string) => {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Preview URL must use http or https");
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error("Preview URL must point to localhost or 127.0.0.1");
    if (url.username || url.password) throw new Error("Preview URL must not contain credentials");
    return url.toString();
  };
  const probePreviewUrl = async (raw: string) => {
    const url = normalizePreviewUrl(raw);
    try {
      const response = await fetch(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(1200) });
      return { reachable: true, status: response.status, error: null };
    } catch (error) {
      return { reachable: false, status: null, error: error instanceof Error ? error.message : String(error) };
    }
  };
  const route = (handler: (req: any) => Promise<unknown>) => async (req: any, res: any) => {
    try { res.json({ ok: true, data: await handler(req) }); }
    catch (error) { res.status(400).json({ ok: false, error: String(error) }); }
  };
  router.get("/api/workbench", route(() => getWorkbench(options.sessionList?.() || [])));
  router.get("/api/workbench/agents", route(() => getAgentCoordinator(options.sessionList?.() || [])));
  router.get("/api/workbench/integration", route(req => getIntegrationQueue(typeof req.query.workspaceId === "string" ? req.query.workspaceId : undefined)));
  router.get("/api/workbench/folders", route(async req => {
    const requested = typeof req.query.path === "string" ? req.query.path.trim() : "";
    if (!requested) return { path: null, parent: null, roots: getMachineRoots(), directories: [] };
    const root = await fs.realpath(path.resolve(requested));
    if (!(await fs.stat(root)).isDirectory()) throw new Error("Path is not a directory");
    const entries = await fs.readdir(root, { withFileTypes: true });
    const directories = entries
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
      .slice(0, 500)
      .map(entry => ({ name: entry.name, path: path.join(root, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const parent = path.dirname(root) === root ? null : path.dirname(root);
    return { path: root, parent, roots: [], directories };
  }));
  router.post("/api/workbench/workspaces", route(req => {
    const body = z.object({ name: z.string().max(120).default(""), path: z.string().min(1) }).strict().parse(req.body);
    return createWorkspace(body.name, body.path);
  }));
  router.post("/api/workbench/workspaces/clone", route(req => {
    const body = z.object({
      repository: z.string().trim().min(1).max(2048),
      destinationParent: z.string().trim().min(1).max(4096),
      folderName: z.string().trim().max(240).optional(),
      branch: z.string().trim().max(200).optional(),
      name: z.string().trim().max(120).optional().default(""),
    }).strict().parse(req.body);
    return cloneWorkspace(body);
  }));
  router.post("/api/workbench/workspaces/:id/select", route(req => selectWorkspace(req.params.id)));
  router.put("/api/workbench/workspaces/:id/path", route(req => {
    const body = z.object({ path: z.string().trim().min(1).max(4096) }).strict().parse(req.body);
    return relocateWorkspace(req.params.id, body.path, options.sessionList?.() || []);
  }));
  router.delete("/api/workbench/workspaces/:id", route(req => removeWorkspace(req.params.id, options.sessionList?.())));
  router.get("/api/workbench/workspaces/:id/experience", route(req => getWorkspaceExperience(req.params.id, options.sessionList?.() || [])));
  router.get("/api/workbench/workspaces/:id/change-sets", route(req => listWorkspaceChangeSets(req.params.id)));
  router.put("/api/workbench/workspaces/:id/experience", route(req => {
    const { mode } = z.object({ mode: z.enum(["basic", "advanced"]) }).strict().parse(req.body);
    return setWorkspaceExperience(req.params.id, mode, options.sessionList?.() || []);
  }));
  router.post("/api/workbench/workspaces/:id/writer", route(req => {
    const body = z.object({ sessionId: z.string().min(1), expectedSessionId: z.string().nullable() }).strict().parse(req.body);
    return takeWorkspaceWriter(req.params.id, body.sessionId, body.expectedSessionId, options.sessionList?.() || []);
  }));
  router.get("/api/workbench/connections", route(async () => getOAuthProvider()?.listPending() || []));
  router.post("/api/workbench/connections/:id", route(async req => {
    const { approve } = z.object({ approve: z.boolean() }).strict().parse(req.body);
    const provider = getOAuthProvider(); if (!provider) throw new Error("OAuth unavailable");
    provider.decide(req.params.id, approve); return { decided: true };
  }));
  router.post("/api/workbench/tasks", route(req => {
    const body = z.object({
      title: z.string().min(1).max(200),
      workspace: z.string().min(1).optional(),
      workspaceId: z.string().min(1).optional(),
      environment: z.object({
        mode: z.enum(["local", "worktree"]).default("local"),
        startingRef: z.string().min(1).max(200).optional(),
      }).strict().optional(),
      kind: z.enum(["standard", "parallel"]).optional(),
      assignNextChatgpt: z.boolean().optional().default(false),
      description: z.string().max(4000).optional().default(""),
    }).strict().refine(value => Boolean(value.workspace || value.workspaceId), { message: "workspace or workspaceId required" }).parse(req.body);
    return createTask(body.title, body.workspace, body.workspaceId, body.environment, { kind: body.kind, assignNextChatgpt: body.assignNextChatgpt, description: body.description });
  }));
  router.post("/api/workbench/tasks/:id/select", route(req => selectTask(req.params.id)));
  router.put("/api/workbench/tasks/:id/description", route(req => {
    const body = z.object({ description: z.string().max(4000) }).strict().parse(req.body);
    return setTaskDescription(req.params.id, body.description);
  }));
  router.put("/api/workbench/tasks/:id/handoff", route(req => {
    const body = z.object({
      summary: z.string().min(1).max(6000),
      nextSteps: z.array(z.string().max(1000)).max(20).optional().default([]),
      notes: z.string().max(6000).optional().default(""),
    }).strict().parse(req.body);
    return setTaskHandoff(req.params.id, body);
  }));
  router.put("/api/workbench/tasks/:id/integration/dependencies", route(req => {
    const body = z.object({ taskIds: z.array(z.string().min(1)).max(100) }).strict().parse(req.body);
    return setTaskIntegrationDependencies(req.params.id, body.taskIds);
  }));
  router.post("/api/workbench/tasks/:id/integration/ready", route(req => markTaskReadyForMerge(req.params.id)));
  router.post("/api/workbench/tasks/:id/integration/reopen", route(req => reopenTaskIntegration(req.params.id)));
  router.post("/api/workbench/tasks/:id/integration/merge", route(req => mergeTaskIntegration(req.params.id)));
  router.post("/api/workbench/tasks/:id/integration/cleanup", route(req => cleanupTaskIntegration(req.params.id)));
  router.post("/api/workbench/tasks/:id/integration/finish", route(req => finishTaskIntegration(req.params.id)));
  router.post("/api/workbench/tasks/:id/integration/discard", route(req => discardTaskIntegration(req.params.id)));
  router.post("/api/workbench/tasks/:id/assignment", route(req => queueAgentTaskAssignment(req.params.id)));
  router.delete("/api/workbench/tasks/:id/assignment", route(req => cancelAgentTaskAssignment(req.params.id)));
  router.put("/api/workbench/tasks/:id/policy", route(req => {
    const body = z.object({ mode: z.enum(["ask", "auto", "full"]), workspaceOnly: z.boolean() }).strict().parse(req.body);
    return setTaskPolicy(req.params.id, body.mode, body.workspaceOnly);
  }));
  router.get("/api/workbench/tasks/:id/checkpoints", route(req => listTaskCheckpoints(req.params.id)));
  router.post("/api/workbench/tasks/:id/checkpoints", route(req => {
    const body = z.object({ title: z.string().max(160).default("Checkpoint") }).strict().parse(req.body || {});
    return createTaskCheckpoint(req.params.id, body.title);
  }));
  router.get("/api/workbench/checkpoints/:id/preview", route(req => previewTaskCheckpoint(req.params.id)));
  router.post("/api/workbench/checkpoints/:id/restore", route(req => restoreTaskCheckpoint(req.params.id)));
  router.get("/api/workbench/operations/:id", route(req => operationDetail(req.params.id)));
  router.post("/api/workbench/operations/:id/decision", route(req => {
    const { approve } = z.object({ approve: z.boolean() }).strict().parse(req.body);
    return decideOperation(req.params.id, approve);
  }));
  router.post("/api/workbench/operations/:id/undo", route(req => {
    const body = z.object({ redo: z.boolean().default(false), file: z.string().optional() }).strict().parse(req.body);
    return undoOperation(req.params.id, body.redo, body.file);
  }));
  router.get("/api/workbench/workspaces/:id/latest-change-set", route(async req => ({ changeSet: await latestWorkspaceChangeSet(req.params.id) })));
  router.get("/api/workbench/change-sets/:id", route(req => changeSetDetail(req.params.id)));
  router.post("/api/workbench/change-sets/:id/undo", route(req => {
    const body = z.object({ redo: z.boolean().default(false) }).strict().parse(req.body || {});
    return undoChangeSet(req.params.id, body.redo);
  }));
  router.get("/api/workbench/tasks/:id/tree", route(async req => {
    const dir = typeof req.query.path === "string" && req.query.path ? req.query.path : ".";
    return invoke(req.params.id, "list_directory", { path: dir, ignore: ["node_modules", ".git"] }, filesystemDefinitions);
  }));
  router.get("/api/workbench/tasks/:id/file", route(async req => {
    const path = z.string().min(1).parse(req.query.path);
    const offset = req.query.offset === undefined ? undefined : z.coerce.number().int().positive().parse(req.query.offset);
    const limit = req.query.limit === undefined ? undefined : z.coerce.number().int().positive().max(2000).parse(req.query.limit);
    return invoke(req.params.id, "read_text_file", { path, ...(offset ? { offset, ...(limit ? { limit } : {}) } : limit ? { head: limit } : {}) }, filesystemDefinitions);
  }));
  router.put("/api/workbench/tasks/:id/file", route(async req => {
    const body = z.object({ path: z.string().min(1), content: z.string() }).strict().parse(req.body);
    return invoke(req.params.id, "write_file", body, filesystemDefinitions, false);
  }));
  router.post("/api/workbench/tasks/:id/search", route(async req => {
    const body = z.object({
      query: z.string().min(1).max(1000),
      glob: z.string().max(500).default("*"),
      caseInsensitive: z.boolean().default(true),
      mode: z.enum(["content", "files_with_matches", "count"]).default("content"),
      maxResults: z.number().int().positive().max(500).default(120),
    }).strict().parse(req.body);
    return invoke(req.params.id, "grep", {
      pattern: body.query,
      path: ".",
      glob: body.glob,
      output_mode: body.mode,
      case_insensitive: body.caseInsensitive,
      multiline: false,
      head_limit: body.maxResults,
      context_before: 0,
      context_after: 0,
      context_around: 0,
    }, filesystemDefinitions);
  }));
  router.post("/api/workbench/tasks/:id/glob", route(async req => {
    const body = z.object({ pattern: z.string().min(1).max(500), maxResults: z.number().int().positive().max(500).default(120) }).strict().parse(req.body);
    return invoke(req.params.id, "glob", { pattern: body.pattern, path: ".", max_results: body.maxResults }, filesystemDefinitions);
  }));
  router.get("/api/workbench/tasks/:id/context", route(async req => {
    const found = await task(req.params.id);
    return invoke(found.id, "project_context", { path: ".", max_depth: 3, max_bytes_per_file: 60000 }, contextDefinitions(executionRoot(found)));
  }));
  router.post("/api/workbench/tasks/:id/shell", route(async req => {
    const found = await task(req.params.id);
    const body = z.object({ command: z.string().min(1), working_directory: z.string().optional() }).strict().parse(req.body);
    return invoke(found.id, "run_command", body, shellDefinitions(executionRoot(found)), true);
  }));
  router.get("/api/workbench/tasks/:id/processes", route(async req => {
    const found = await task(req.params.id);
    return invoke(found.id, "process_status", {}, shellDefinitions(executionRoot(found)));
  }));
  router.get("/api/workbench/tasks/:id/runtime", route(async req => {
    await task(req.params.id);
    return getTaskRuntime(req.params.id);
  }));
  router.post("/api/workbench/tasks/:id/processes/stop-all", route(async req => {
    await task(req.params.id);
    const body = z.object({ force: z.boolean().default(true) }).strict().parse(req.body || {});
    const result = await stopTaskRuntimeProcesses(req.params.id, body.force);
    const previewRelease = await releaseTaskPreviewPort(req.params.id);
    return { ...result, previewRelease };
  }));
  router.post("/api/workbench/tasks/:id/processes", route(async req => {
    const found = await task(req.params.id);
    const body = z.object({ command: z.string().min(1), working_directory: z.string().optional(), yield_time_ms: z.number().int().min(0).max(10000).default(500) }).strict().parse(req.body);
    return invoke(found.id, "start_process", body, shellDefinitions(executionRoot(found)), true);
  }));
  router.get("/api/workbench/tasks/:id/processes/:processId/output", route(async req => {
    const found = await task(req.params.id);
    const tail_chars = req.query.tail === undefined ? 12000 : z.coerce.number().int().positive().max(200000).parse(req.query.tail);
    const stdoutCursor = req.query.stdout_cursor === undefined ? undefined : z.coerce.number().int().nonnegative().parse(req.query.stdout_cursor);
    const stderrCursor = req.query.stderr_cursor === undefined ? undefined : z.coerce.number().int().nonnegative().parse(req.query.stderr_cursor);
    if ((stdoutCursor === undefined) !== (stderrCursor === undefined)) throw new Error("Both stdout_cursor and stderr_cursor are required together");
    const wait_ms = req.query.wait_ms === undefined ? 0 : z.coerce.number().int().min(0).max(10000).parse(req.query.wait_ms);
    return invoke(found.id, "process_output", {
      id: req.params.processId,
      tail_chars,
      ...(stdoutCursor === undefined ? {} : { cursor: { stdout: stdoutCursor, stderr: stderrCursor! } }),
      wait_ms,
    }, shellDefinitions(executionRoot(found)));
  }));
  router.post("/api/workbench/tasks/:id/processes/:processId/stop", route(async req => {
    const found = await task(req.params.id);
    const force = z.object({ force: z.boolean().default(false) }).strict().parse(req.body || {}).force;
    const result: any = await invoke(found.id, "stop_process", { id: req.params.processId, force }, shellDefinitions(executionRoot(found)), true);
    if (found.preview?.processId === req.params.processId) {
      return { ...result, previewRelease: await releaseTaskPreviewPort(found.id) };
    }
    return result;
  }));
  router.get("/api/workbench/tasks/:id/preview", route(async req => {
    const found = await task(req.params.id);
    if (!found.preview) return { configured: false, running: false, reachable: false, leased: false };
    const status: any = await invoke(found.id, "process_status", {}, shellDefinitions(executionRoot(found)));
    const process = (status.processes || []).find((item: any) => item.id === found.preview?.processId);
    const running = Boolean(process?.running);
    const probe = running && found.preview.url ? await probePreviewUrl(found.preview.url) : { reachable: false, status: null, error: null };
    return {
      configured: true,
      command: found.preview.command,
      url: found.preview.url,
      port: found.preview.port,
      autoPort: Boolean(found.preview.autoPort),
      leased: Boolean(found.preview.leaseId),
      processId: found.preview.processId,
      startedAt: found.preview.startedAt,
      running,
      reachable: probe.reachable,
      httpStatus: probe.status,
      probeError: probe.error,
      exitCode: process?.exit_code ?? null,
      stale: Boolean(found.preview.processId && !process),
      staleLease: Boolean(found.preview.leaseId && !running),
    };
  }));
  router.put("/api/workbench/tasks/:id/preview", route(async req => {
    const body = z.object({ command: z.string().min(1).max(4000), url: z.string().min(1).max(2048).optional() }).strict().parse(req.body);
    const found = await task(req.params.id);
    if (found.preview?.processId) {
      const status: any = await invoke(found.id, "process_status", {}, shellDefinitions(executionRoot(found)));
      if ((status.processes || []).some((item: any) => item.id === found.preview?.processId && item.running)) {
        throw new Error("Stop the running preview before changing its configuration.");
      }
    }
    return setTaskPreview(found.id, body.url
      ? { command: body.command, url: normalizePreviewUrl(body.url), autoPort: false }
      : { command: body.command, autoPort: true });
  }));
  router.post("/api/workbench/tasks/:id/preview/start", route(async req => {
    const body = z.object({ command: z.string().min(1).max(4000).optional(), url: z.string().min(1).max(2048).optional() }).strict().parse(req.body || {});
    const found = await task(req.params.id);
    if (found.policy.workspaceOnly) {
      throw new Error("WORKSPACE_EXTERNAL_BLOCKED: Project Preview needs a host-reachable port. The workspace sandbox intentionally uses network=none; switch this task to machine scope to start Preview.");
    }
    if (found.preview?.processId) {
      const status: any = await invoke(found.id, "process_status", {}, shellDefinitions(executionRoot(found)));
      if ((status.processes || []).some((item: any) => item.id === found.preview?.processId && item.running)) {
        throw new Error("Preview is already running. Stop it before starting a new preview.");
      }
    }
    const command = body.command || found.preview?.command;
    if (!command) throw new Error("Preview command is required before starting Preview.");
    const explicitUrl = body.url ? normalizePreviewUrl(body.url) : undefined;
    const prepared = await prepareTaskPreviewStart(found.id, { command, ...(explicitUrl ? { url: explicitUrl } : {}) });
    let started: any;
    try {
      started = await invoke(
        found.id,
        "start_process",
        { command, yield_time_ms: 500 },
        shellDefinitions(executionRoot(found)),
        true,
        { PORT: String(prepared.port), LOCAL_CODER_PREVIEW_PORT: String(prepared.port) },
      );
      if (!started?.id) throw new Error("Preview process did not return a process id.");
      const preview = await attachTaskPreviewProcess(found.id, started.id);
      return { ...started, url: preview.url, port: preview.port, autoPort: preview.autoPort };
    } catch (error) {
      if (started?.id) {
        await invoke(found.id, "stop_process", { id: started.id, force: true }, shellDefinitions(executionRoot(found)), true).catch(() => {});
        await releaseTaskPreviewPort(found.id).catch(() => {});
      } else {
        await releaseTaskPreviewPort(found.id, { force: true }).catch(() => {});
      }
      throw error;
    }
  }));
  router.post("/api/workbench/tasks/:id/preview/stop", route(async req => {
    const found = await task(req.params.id);
    if (!found.preview) return { stopped: false, reason: "not configured" };
    if (found.preview.processId) {
      const status: any = await invoke(found.id, "process_status", {}, shellDefinitions(executionRoot(found)));
      if ((status.processes || []).some((item: any) => item.id === found.preview?.processId && item.running)) {
        await invoke(found.id, "stop_process", { id: found.preview.processId, force: true }, shellDefinitions(executionRoot(found)), true);
      }
    }
    const released = await releaseTaskPreviewPort(found.id);
    return released.released
      ? { stopped: true, port: released.port }
      : { stopped: false, port: released.port, reason: "Preview process stopped, but the leased port is still occupied; the lease was preserved for safety." };
  }));
  router.get("/api/workbench/tasks/:id/git/status", route(async req => {
    const found = await task(req.params.id);
    return invoke(found.id, "git_status", {}, gitDefinitions(executionRoot(found)));
  }));
  router.get("/api/workbench/tasks/:id/git/overview", route(async req => {
    const found = await task(req.params.id);
    const definitions = gitDefinitions(executionRoot(found));
    const [status, log, branches, worktrees] = await Promise.all([
      invoke(found.id, "git_status", {}, definitions),
      invoke(found.id, "git_log", { count: 8 }, definitions).catch(() => ({ commits: [] })),
      invoke(found.id, "git_branch", { action: "list" }, definitions),
      invoke(found.id, "git_worktree", { action: "list" }, definitions),
    ]);
    const branchOutput = String((branches as any)?.output || "");
    const branchList = branchOutput.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.includes(" -> ")).map(line => ({
      current: line.startsWith("*"),
      name: line.replace(/^\*\s*/, "").replace(/^remotes\//, ""),
      remote: line.replace(/^\*\s*/, "").startsWith("remotes/"),
    }));
    const worktreeOutput = String((worktrees as any)?.stdout || (worktrees as any)?.output || "");
    return {
      status,
      commits: (log as any)?.commits || [],
      branches: branchList,
      worktrees: parseWorktrees(worktreeOutput),
      execution: found.execution,
      projectWorkspace: found.workspace,
    };
  }));
  router.post("/api/workbench/tasks/:id/git", route(async req => {
    const body = z.object({ tool: z.string().startsWith("git_"), args: z.record(z.any()).default({}) }).strict().parse(req.body);
    const task = (await getWorkbench()).tasks.find(t => t.id === req.params.id);
    if (!task) throw new Error("Unknown task");
    const definitions = gitDefinitions(taskExecutionPath(task));
    const def = definitions.get(body.tool);
    if (!def) throw new Error("Unknown Git action");
    const args = z.object(def.config.inputSchema).strict().parse(body.args);
    return dispatch(task.id, body.tool, args, () => def.handler(args), true);
  }));
  router.post("/api/workbench/tasks/:id/github", route(async req => {
    const input = githubSchema.parse(req.body);
    const task = (await getWorkbench()).tasks.find(t => t.id === req.params.id);
    if (!task) throw new Error("Unknown task");
    return dispatch(task.id, "github", input, () => executeGithub(input, taskExecutionPath(task)), true);
  }));
  router.get("/api/workbench/events", (_req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.flushHeaders();
    const send = (change: unknown) => res.write(`event: change\ndata: ${JSON.stringify(change)}\n\n`);
    send({ scopes: ["state"], reason: "initial" });
    const unsubscribe = subscribeWorkbench(change => send(change));
    const timer = setInterval(() => res.write(": keepalive\n\n"), 15000);
    res.on("close", () => { unsubscribe(); clearInterval(timer); });
  });
  return router;
}
