import { Router } from "express";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createTask, decideOperation, dispatch, getWorkbench, operationDetail, selectTask, setTaskPolicy, subscribeWorkbench, undoOperation } from "../lib/workbench.js";
import { registerGitTools } from "../tools/git.js";
import { executeGithub, githubSchema } from "../tools/github.js";
import { getOAuthProvider } from "../lib/oauth-provider.js";

export function createWorkbenchRouter(): Router {
  const router = Router();
  const route = (handler: (req: any) => Promise<unknown>) => async (req: any, res: any) => {
    try { res.json({ ok: true, data: await handler(req) }); }
    catch (error) { res.status(400).json({ ok: false, error: String(error) }); }
  };
  router.get("/api/workbench", route(() => getWorkbench()));
  router.get("/api/workbench/connections", route(async () => getOAuthProvider()?.listPending() || []));
  router.post("/api/workbench/connections/:id", route(async req => {
    const { approve } = z.object({ approve: z.boolean() }).strict().parse(req.body);
    const provider = getOAuthProvider(); if (!provider) throw new Error("OAuth unavailable");
    provider.decide(req.params.id, approve); return { decided: true };
  }));
  router.post("/api/workbench/tasks", route(req => {
    const body = z.object({ title: z.string().min(1).max(200), workspace: z.string().min(1) }).strict().parse(req.body);
    return createTask(body.title, body.workspace);
  }));
  router.post("/api/workbench/tasks/:id/select", route(req => selectTask(req.params.id)));
  router.put("/api/workbench/tasks/:id/policy", route(req => {
    const body = z.object({ mode: z.enum(["ask", "auto", "full"]), workspaceOnly: z.boolean() }).strict().parse(req.body);
    return setTaskPolicy(req.params.id, body.mode, body.workspaceOnly);
  }));
  router.get("/api/workbench/operations/:id", route(req => operationDetail(req.params.id)));
  router.post("/api/workbench/operations/:id/decision", route(req => {
    const { approve } = z.object({ approve: z.boolean() }).strict().parse(req.body);
    return decideOperation(req.params.id, approve);
  }));
  router.post("/api/workbench/operations/:id/undo", route(req => {
    const body = z.object({ redo: z.boolean().default(false), file: z.string().optional() }).strict().parse(req.body);
    return undoOperation(req.params.id, body.redo, body.file);
  }));
  router.post("/api/workbench/tasks/:id/git", route(async req => {
    const body = z.object({ tool: z.string().startsWith("git_"), args: z.record(z.any()).default({}) }).strict().parse(req.body);
    const task = (await getWorkbench()).tasks.find(t => t.id === req.params.id);
    if (!task) throw new Error("Unknown task");
    const definitions = new Map<string, { config: any; handler: any }>();
    registerGitTools({ registerTool: (name: string, config: any, handler: any) => { definitions.set(name, { config, handler }); } } as unknown as McpServer, task.workspace);
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
    res.write("event: change\ndata: {}\n\n");
    const unsubscribe = subscribeWorkbench(() => res.write("event: change\ndata: {}\n\n"));
    const timer = setInterval(() => res.write(": keepalive\n\n"), 15000);
    res.on("close", () => { unsubscribe(); clearInterval(timer); });
  });
  return router;
}
