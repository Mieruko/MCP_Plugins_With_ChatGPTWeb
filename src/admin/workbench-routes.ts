import fs from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createTask, createTaskCheckpoint, createWorkspace, decideOperation, dispatch, getWorkbench, listTaskCheckpoints, operationDetail, previewTaskCheckpoint, restoreTaskCheckpoint, selectTask, selectWorkspace, setTaskPolicy, setTaskPreview, subscribeWorkbench, undoOperation } from "../lib/workbench.js";
import { getMachineRoots } from "../lib/path-security.js";
import { registerFilesystemTools } from "../tools/filesystem.js";
import { registerShellTools } from "../tools/shell.js";
import { registerGitTools } from "../tools/git.js";
import { registerContextTools } from "../tools/context.js";
import { executeGithub, githubSchema } from "../tools/github.js";
import { getOAuthProvider } from "../lib/oauth-provider.js";

export function createWorkbenchRouter(): Router {
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
  const invoke = async (taskId: string, tool: string, rawArgs: Record<string, unknown>, definitions: Map<string, Definition>, human = true) => {
    const found = await task(taskId);
    const def = definitions.get(tool);
    if (!def) throw new Error(`Unknown tool: ${tool}`);
    const args = z.object(def.config.inputSchema).strict().parse(rawArgs);
    const result: any = await dispatch(found.id, tool, args, () => def.handler(args, { signal: undefined }), human);
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
  router.get("/api/workbench", route(() => getWorkbench()));
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
  router.post("/api/workbench/workspaces/:id/select", route(req => selectWorkspace(req.params.id)));
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
    }).strict().refine(value => Boolean(value.workspace || value.workspaceId), { message: "workspace or workspaceId required" }).parse(req.body);
    return createTask(body.title, body.workspace, body.workspaceId);
  }));
  router.post("/api/workbench/tasks/:id/select", route(req => selectTask(req.params.id)));
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
    return invoke(found.id, "project_context", { path: ".", max_depth: 3, max_bytes_per_file: 60000 }, contextDefinitions(found.workspace));
  }));
  router.post("/api/workbench/tasks/:id/shell", route(async req => {
    const found = await task(req.params.id);
    const body = z.object({ command: z.string().min(1), working_directory: z.string().optional() }).strict().parse(req.body);
    return invoke(found.id, "run_command", body, shellDefinitions(found.workspace), true);
  }));
  router.get("/api/workbench/tasks/:id/processes", route(async req => {
    const found = await task(req.params.id);
    return invoke(found.id, "process_status", {}, shellDefinitions(found.workspace));
  }));
  router.post("/api/workbench/tasks/:id/processes", route(async req => {
    const found = await task(req.params.id);
    const body = z.object({ command: z.string().min(1), working_directory: z.string().optional(), yield_time_ms: z.number().int().min(0).max(10000).default(500) }).strict().parse(req.body);
    return invoke(found.id, "start_process", body, shellDefinitions(found.workspace), true);
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
    }, shellDefinitions(found.workspace));
  }));
  router.post("/api/workbench/tasks/:id/processes/:processId/stop", route(async req => {
    const found = await task(req.params.id);
    const force = z.object({ force: z.boolean().default(false) }).strict().parse(req.body || {}).force;
    return invoke(found.id, "stop_process", { id: req.params.processId, force }, shellDefinitions(found.workspace), true);
  }));
  router.get("/api/workbench/tasks/:id/preview", route(async req => {
    const found = await task(req.params.id);
    if (!found.preview) return { configured: false, running: false };
    const status: any = await invoke(found.id, "process_status", {}, shellDefinitions(found.workspace));
    const process = (status.processes || []).find((item: any) => item.id === found.preview?.processId);
    const running = Boolean(process?.running);
    const probe = running ? await probePreviewUrl(found.preview.url) : { reachable: false, status: null, error: null };
    return {
      configured: true,
      command: found.preview.command,
      url: found.preview.url,
      processId: found.preview.processId,
      startedAt: found.preview.startedAt,
      running,
      reachable: probe.reachable,
      httpStatus: probe.status,
      probeError: probe.error,
      exitCode: process?.exit_code ?? null,
      stale: Boolean(found.preview.processId && !process),
    };
  }));
  router.put("/api/workbench/tasks/:id/preview", route(async req => {
    const body = z.object({ command: z.string().min(1).max(4000), url: z.string().min(1).max(2048) }).strict().parse(req.body);
    const found = await task(req.params.id);
    if (found.preview?.processId) {
      const status: any = await invoke(found.id, "process_status", {}, shellDefinitions(found.workspace));
      if ((status.processes || []).some((item: any) => item.id === found.preview?.processId && item.running)) {
        throw new Error("Stop the running preview before changing its configuration.");
      }
    }
    return setTaskPreview(found.id, { command: body.command, url: normalizePreviewUrl(body.url) });
  }));
  router.post("/api/workbench/tasks/:id/preview/start", route(async req => {
    const body = z.object({ command: z.string().min(1).max(4000), url: z.string().min(1).max(2048) }).strict().parse(req.body);
    const found = await task(req.params.id);
    if (found.policy.workspaceOnly) {
      throw new Error("WORKSPACE_EXTERNAL_BLOCKED: Project Preview needs a host-reachable port. The workspace sandbox intentionally uses network=none; switch this task to machine scope to start Preview.");
    }
    const url = normalizePreviewUrl(body.url);
    if (found.preview?.processId) {
      const status: any = await invoke(found.id, "process_status", {}, shellDefinitions(found.workspace));
      if ((status.processes || []).some((item: any) => item.id === found.preview?.processId && item.running)) {
        throw new Error("Preview is already running. Stop it before starting a new preview.");
      }
    }
    const started: any = await invoke(found.id, "start_process", { command: body.command, yield_time_ms: 500 }, shellDefinitions(found.workspace), true);
    await setTaskPreview(found.id, { command: body.command, url, processId: started.id, startedAt: new Date().toISOString() });
    return { ...started, url };
  }));
  router.post("/api/workbench/tasks/:id/preview/stop", route(async req => {
    const found = await task(req.params.id);
    if (!found.preview) return { stopped: false, reason: "not configured" };
    if (found.preview.processId) {
      const status: any = await invoke(found.id, "process_status", {}, shellDefinitions(found.workspace));
      if ((status.processes || []).some((item: any) => item.id === found.preview?.processId && item.running)) {
        await invoke(found.id, "stop_process", { id: found.preview.processId, force: false }, shellDefinitions(found.workspace), true);
      }
    }
    await setTaskPreview(found.id, { command: found.preview.command, url: found.preview.url });
    return { stopped: true };
  }));
  router.get("/api/workbench/tasks/:id/git/status", route(async req => {
    const found = await task(req.params.id);
    return invoke(found.id, "git_status", {}, gitDefinitions(found.workspace));
  }));
  router.get("/api/workbench/tasks/:id/git/overview", route(async req => {
    const found = await task(req.params.id);
    const definitions = gitDefinitions(found.workspace);
    const [status, log, branches] = await Promise.all([
      invoke(found.id, "git_status", {}, definitions),
      invoke(found.id, "git_log", { count: 8 }, definitions),
      invoke(found.id, "git_branch", { action: "list" }, definitions),
    ]);
    const branchOutput = String((branches as any)?.output || "");
    const branchList = branchOutput.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => ({
      current: line.startsWith("*"),
      name: line.replace(/^\*\s*/, "").replace(/^remotes\//, ""),
      remote: line.replace(/^\*\s*/, "").startsWith("remotes/"),
    }));
    return { status, commits: (log as any)?.commits || [], branches: branchList };
  }));
  router.post("/api/workbench/tasks/:id/git", route(async req => {
    const body = z.object({ tool: z.string().startsWith("git_"), args: z.record(z.any()).default({}) }).strict().parse(req.body);
    const task = (await getWorkbench()).tasks.find(t => t.id === req.params.id);
    if (!task) throw new Error("Unknown task");
    const definitions = gitDefinitions(task.workspace);
    const def = definitions.get(body.tool);
    if (!def) throw new Error("Unknown Git action");
    const args = z.object(def.config.inputSchema).strict().parse(body.args);
    return dispatch(task.id, body.tool, args, () => def.handler(args), true);
  }));
  router.post("/api/workbench/tasks/:id/github", route(async req => {
    const input = githubSchema.parse(req.body);
    const task = (await getWorkbench()).tasks.find(t => t.id === req.params.id);
    if (!task) throw new Error("Unknown task");
    return dispatch(task.id, "github", input, () => executeGithub(input, task.workspace), true);
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
