import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import type { Server } from "http";
import type { McpUpstreamManager } from "../lib/mcp-upstream-manager.js";
import type { McpSessionSummary } from "../lib/mcp-session-manager.js";
import { createAdminRouter } from "./routes.js";
import { adminAuth, localhostOnly } from "./localhost-guard.js";
import { createWorkbenchRouter } from "./workbench-routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface AdminServerOptions {
  host?: string;
  port: number;
  mcpPort: number;
  pid: number;
  manager: McpUpstreamManager;
  sessionCount: () => number;
  sessionList?: () => McpSessionSummary[];
  instructionSummary?: () => Record<string, unknown>;
  instructionsPreview?: () => string;
}

export function startAdminServer(options: AdminServerOptions): Server {
  const host = options.host ?? "127.0.0.1";
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  app.use(localhostOnly);

  const uiDir = path.resolve(__dirname, "../../public/ui");
  const monacoDir = path.resolve(__dirname, "../../node_modules/monaco-editor/min");
  app.get("/", (_req, res) => res.redirect("/ui/workbench.html"));
  app.get("/ui", (_req, res) => res.redirect("/ui/workbench.html"));
  app.get("/ui/", (_req, res) => res.redirect("/ui/workbench.html"));
  app.use("/ui", express.static(uiDir));
  app.use("/vendor/monaco", express.static(monacoDir));
  app.use(adminAuth);
  app.use(createWorkbenchRouter());

  app.use(createAdminRouter(options.manager, {
    mcpPort: options.mcpPort,
    pid: options.pid,
    sessionCount: options.sessionCount,
    sessionList: options.sessionList,
    instructionSummary: options.instructionSummary,
    instructionsPreview: options.instructionsPreview,
  }));

  return app.listen(options.port, host, () => {
    console.log(`  Workbench: http://${host}:${options.port}/ui/workbench.html`);
    console.log(`  Admin API: http://${host}:${options.port}/health`);
  });
}
