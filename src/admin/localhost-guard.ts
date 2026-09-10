import type { Request, Response, NextFunction } from "express";
import { requireAdminAuth } from "../lib/local-auth.js";

function isLocalAddress(ip: string | undefined): boolean {
  if (!ip) return false;
  const normalized = ip.replace(/^::ffff:/i, "").toLowerCase();
  if (normalized === "127.0.0.1" || normalized === "::1") return true;
  // IPv4-mapped and unspecified bind addresses when connecting locally
  if (normalized === "0.0.0.0" || normalized === "::") return true;
  return false;
}

export function localhostOnly(req: Request, res: Response, next: NextFunction): void {
  const remote = req.socket.remoteAddress;
  if (!isLocalAddress(remote)) {
    res.status(403).json({ ok: false, error: "Admin API is localhost-only" });
    return;
  }
  const host = (req.headers.host || "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) { res.status(403).json({ error: "Invalid local Host" }); return; }
  const origin = req.headers.origin;
  if (origin) {
    try { if (new URL(origin).host !== req.headers.host) throw new Error(); }
    catch { res.status(403).json({ error: "Cross-origin admin access denied" }); return; }
  }
  next();
}

export function adminAuth(req: Request, res: Response, next: NextFunction): void {
  requireAdminAuth(req, res, next);
}
