import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { workbenchRoot } from "./workbench.js";
import { getOAuthProvider } from "./oauth-provider.js";

let credentials: { admin: string; mcp: string };
let adminBootstrapToken = "";
const adminSessions = new Set<string>();

function adminSessionCookieName(): string {
  const port = String(process.env.ADMIN_PORT || "local").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `workbench_session_${port}`;
}

function cookieValue(req: Request, name: string): string {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return "";
}

export async function initializeLocalAuth(): Promise<void> {
  const file = path.join(workbenchRoot(), "credentials.json");
  await fs.mkdir(workbenchRoot(), { recursive: true });
  try { credentials = JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    credentials = { admin: randomBytes(32).toString("hex"), mcp: randomBytes(32).toString("hex") };
    await fs.writeFile(file, JSON.stringify(credentials, null, 2), { mode: 0o600, flag: "wx" });
  }
  if (!credentials.admin || !credentials.mcp) throw new Error("Invalid local credentials file");
  credentials = { admin: process.env.ADMIN_TOKEN?.trim() || credentials.admin, mcp: process.env.MCP_AUTH_TOKEN?.trim() || credentials.mcp };
  adminBootstrapToken = process.env.WORKBENCH_BOOTSTRAP_TOKEN?.trim() || "";
  console.log(`[MCP] Authentication required. Local credentials: ${file}`);
}
export function getMcpAuthToken(): string { return credentials?.mcp || process.env.MCP_AUTH_TOKEN || ""; }
export function checkToken(provided: unknown, expected: string): boolean {
  if (typeof provided !== "string" || !expected) return false;
  const a = Buffer.from(provided), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export async function requireMcpAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = req.headers.authorization?.replace(/^Bearer /, "") || "";
  if (checkToken(token, getMcpAuthToken())) {
    res.locals.mcpAuth = { kind: "local", chatgpt: false };
    next();
    return;
  }
  const provider = getOAuthProvider();
  if (provider && token) {
    try {
      const verified = await provider.verifyAccessToken(token);
      res.locals.mcpAuth = { kind: "oauth", clientId: verified.clientId, chatgpt: provider.isChatGptClient(verified.clientId) };
      next();
      return;
    } catch {}
  }
  if (provider) res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${new URL("/.well-known/oauth-protected-resource/mcp", provider.issuer).href}"`);
  res.status(401).json({ error: "MCP authorization required" });
}

export function createAdminBrowserSession(providedBootstrapToken: unknown, res: Response): boolean {
  if (!adminBootstrapToken || !checkToken(providedBootstrapToken, adminBootstrapToken)) return false;
  adminBootstrapToken = "";
  const session = randomBytes(32).toString("hex");
  adminSessions.add(session);
  res.setHeader("Set-Cookie", `${adminSessionCookieName()}=${encodeURIComponent(session)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`);
  return true;
}

export function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  const provided = req.headers.authorization?.replace(/^Bearer /, "") || req.headers["x-admin-token"];
  const bearerOk = checkToken(provided, credentials?.admin || process.env.ADMIN_TOKEN || "");
  const browserSession = cookieValue(req, adminSessionCookieName());
  const browserOk = Boolean(browserSession && adminSessions.has(browserSession));
  if (!bearerOk && !browserOk) { res.status(401).json({ error: "Workbench authentication required" }); return; }
  next();
}
