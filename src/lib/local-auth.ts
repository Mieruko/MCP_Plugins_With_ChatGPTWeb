import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { workbenchRoot } from "./workbench.js";
import { getOAuthProvider } from "./oauth-provider.js";

let credentials: { admin: string; mcp: string };
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
  if (checkToken(token, getMcpAuthToken())) { next(); return; }
  const provider = getOAuthProvider();
  if (provider && token) {
    try { await provider.verifyAccessToken(token); next(); return; } catch {}
  }
  if (provider) res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${new URL("/.well-known/oauth-protected-resource/mcp", provider.issuer).href}"`);
  res.status(401).json({ error: "MCP authorization required" });
}
export function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  if (!checkToken(req.headers.authorization?.replace(/^Bearer /, "") || req.headers["x-admin-token"], credentials?.admin || process.env.ADMIN_TOKEN || "")) {
    res.status(401).json({ error: "Admin bearer token required" }); return;
  }
  next();
}
