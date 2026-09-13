import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import type { Request, Response } from "express";
import type { OAuthServerProvider, AuthorizationParams } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from "@modelcontextprotocol/sdk/shared/auth.js";
import { InvalidGrantError, InvalidRequestError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { workbenchRoot, notifyWorkbench } from "./workbench.js";

type Grant = { clientId: string; scopes: string[]; expiresAt: number; type: "access" | "refresh" };
type Pending = { id: string; browserSecret: string; client: OAuthClientInformationFull; params: AuthorizationParams; expires: number; decision?: boolean };
type Code = { clientId: string; params: AuthorizationParams; expires: number };
const secret = () => randomBytes(32).toString("base64url");
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

/** Single-owner OAuth provider. Account linking requires an authenticated local
 * dashboard decision; remote registration alone never grants machine access. */
export class LocalOAuthProvider implements OAuthServerProvider {
  private clients = new Map<string, OAuthClientInformationFull>();
  private grants = new Map<string, Grant>();
  private pending = new Map<string, Pending>();
  private codes = new Map<string, Code>();
  private writes = Promise.resolve();
  constructor(readonly issuer: URL, readonly resource: URL) {}
  async initialize() {
    try {
      const saved = JSON.parse(await fs.readFile(path.join(workbenchRoot(), "oauth.json"), "utf8"));
      if (saved.issuer === this.issuer.href) {
        this.clients = new Map(saved.clients);
        this.grants = new Map(saved.grants.filter(([, grant]: [string, Grant]) => grant.expiresAt > Date.now()));
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  private save() {
    const json = JSON.stringify({ issuer: this.issuer.href, clients: [...this.clients], grants: [...this.grants] });
    this.writes = this.writes.catch(() => {}).then(async () => {
      const file = path.join(workbenchRoot(), "oauth.json"), temp = `${file}.${randomUUID()}.tmp`;
      await fs.writeFile(temp, json, { mode: 0o600 }); await fs.rename(temp, file);
    });
    return this.writes;
  }
  private allowedRedirect(uri: string): boolean {
    const configured = (process.env.OAUTH_REDIRECT_URIS || "").split(";").filter(Boolean);
    return configured.includes(uri) || /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(uri)
      || uri === "https://chatgpt.com/connector_platform_oauth_redirect";
  }
  private isChatGptRedirect(uri: string): boolean {
    return /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(uri)
      || uri === "https://chatgpt.com/connector_platform_oauth_redirect";
  }
  isChatGptClient(clientId: string): boolean {
    const client = this.clients.get(clientId);
    return Boolean(client?.redirect_uris?.some(uri => this.isChatGptRedirect(uri)));
  }
  clientsStore = {
    getClient: async (id: string) => this.clients.get(id),
    registerClient: async (input: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">): Promise<OAuthClientInformationFull> => {
      if (!input.redirect_uris.length || !input.redirect_uris.every(uri => this.allowedRedirect(uri))) throw new InvalidRequestError("Redirect URI must be a ChatGPT callback or explicitly listed in OAUTH_REDIRECT_URIS");
      if (this.clients.size >= 100) throw new InvalidRequestError("Client registration limit reached");
      const client = { ...input, client_id: randomUUID(), client_id_issued_at: Math.floor(Date.now() / 1000) };
      this.clients.set(client.client_id, client); await this.save(); return client;
    },
  };
  private checkResource(resource?: URL) {
    if (resource && resource.href !== this.resource.href) throw new InvalidRequestError("Invalid resource audience");
  }
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.checkResource(params.resource);
    if ((params.scopes || []).some(s => s !== "mcp")) throw new InvalidRequestError("Unsupported scope");
    if (!client.redirect_uris.includes(params.redirectUri) || !this.allowedRedirect(params.redirectUri)) throw new InvalidRequestError("Invalid redirect URI");
    for (const [id, p] of this.pending) if (p.expires < Date.now()) this.pending.delete(id);
    for (const [id, code] of this.codes) if (code.expires < Date.now()) this.codes.delete(id);
    if (this.pending.size >= 50) throw new InvalidRequestError("Too many pending connections");
    const id = randomUUID(), browserSecret = secret();
    this.pending.set(id, { id, browserSecret: digest(browserSecret), client, params, expires: Date.now() + 10 * 60_000 });
    notifyWorkbench();
    res.cookie(`oauth_${id}`, browserSecret, { httpOnly: true, secure: this.issuer.protocol === "https:", sameSite: "lax", path: `/oauth/pending/${id}`, maxAge: 600000 });
    res.redirect(`/oauth/pending/${id}`);
  }
  listPending() {
    return [...this.pending.values()].filter(p => p.expires > Date.now() && p.decision === undefined).map(p => ({ id: p.id,
      clientName: p.client.client_name || "OAuth client", redirectUri: p.params.redirectUri, expiresAt: p.expires,
      chatgpt: this.isChatGptRedirect(p.params.redirectUri) }));
  }
  decide(id: string, approve: boolean) {
    const p = this.pending.get(id);
    if (!p || p.expires < Date.now() || p.decision !== undefined) throw new Error("Connection request expired or already decided");
    p.decision = approve;
    notifyWorkbench();
  }
  async renderPending(req: Request, res: Response) {
    const id = String(req.params.id), p = this.pending.get(id);
    const cookie = req.headers.cookie?.split(";").map(s => s.trim()).find(s => s.startsWith(`oauth_${id}=`))?.slice(`oauth_${id}=`.length);
    res.setHeader("Cache-Control", "no-store"); res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    if (!p || p.expires < Date.now() || !cookie || digest(cookie) !== p.browserSecret) { res.status(400).send("Connection request expired or invalid. Start connecting again."); return; }
    if (p.decision !== undefined) {
      this.pending.delete(id);
      const redirect = new URL(p.params.redirectUri);
      if (p.params.state !== undefined) redirect.searchParams.set("state", p.params.state);
      redirect.searchParams.set("iss", this.issuer.href);
      if (p.decision) { const code = secret(); this.codes.set(digest(code), { clientId: p.client.client_id, params: p.params, expires: Date.now() + 60000 }); redirect.searchParams.set("code", code); }
      else redirect.searchParams.set("error", "access_denied");
      res.clearCookie(`oauth_${id}`, { path: `/oauth/pending/${id}` }); res.redirect(redirect.href); return;
    }
    res.type("html").send(`<!doctype html><html lang="vi"><meta charset="utf-8"><meta http-equiv="refresh" content="3"><title>Kết nối Local Coder</title><h1>Duyệt kết nối trên máy của bạn</h1><p>Mở Workbench local, chọn yêu cầu kết nối có mã <strong>${id}</strong> rồi bấm Duyệt.</p><p>Ứng dụng: ${escapeHtml(p.client.client_name || "OAuth client")}</p><p>Callback: ${escapeHtml(p.params.redirectUri)}</p><p>Trang này sẽ tự tiếp tục sau khi bạn duyệt. Không nhập admin token vào cuộc trò chuyện.</p></html>`);
  }
  private code(client: OAuthClientInformationFull, value: string): Code {
    const code = this.codes.get(digest(value));
    if (!code || code.clientId !== client.client_id || code.expires < Date.now()) throw new InvalidGrantError("Invalid or expired authorization code");
    return code;
  }
  async challengeForAuthorizationCode(client: OAuthClientInformationFull, value: string) { return this.code(client, value).params.codeChallenge; }
  private async issue(clientId: string, scopes: string[]): Promise<OAuthTokens> {
    for (const [key, grant] of this.grants) if (grant.expiresAt < Date.now()) this.grants.delete(key);
    if (this.grants.size >= 10000) throw new InvalidGrantError("Token capacity exceeded");
    const access = secret(), refresh = secret();
    this.grants.set(digest(access), { clientId, scopes, expiresAt: Date.now() + 3600000, type: "access" });
    this.grants.set(digest(refresh), { clientId, scopes, expiresAt: Date.now() + 30 * 86400000, type: "refresh" });
    await this.save();
    return { access_token: access, refresh_token: refresh, token_type: "Bearer", expires_in: 3600, scope: scopes.join(" ") };
  }
  async exchangeAuthorizationCode(client: OAuthClientInformationFull, value: string, _verifier?: string, redirectUri?: string, resource?: URL) {
    const code = this.code(client, value); this.checkResource(resource);
    if (redirectUri !== code.params.redirectUri) throw new InvalidGrantError("redirect_uri mismatch");
    this.codes.delete(digest(value));
    return this.issue(client.client_id, code.params.scopes?.length ? code.params.scopes : ["mcp"]);
  }
  async exchangeRefreshToken(client: OAuthClientInformationFull, value: string, scopes?: string[], resource?: URL) {
    this.checkResource(resource);
    const grant = this.grants.get(digest(value));
    if (!grant || grant.type !== "refresh" || grant.clientId !== client.client_id || grant.expiresAt < Date.now()) throw new InvalidGrantError("Invalid refresh token");
    if (scopes?.some(s => !grant.scopes.includes(s))) throw new InvalidGrantError("Scope escalation denied");
    this.grants.delete(digest(value));
    return this.issue(client.client_id, scopes || grant.scopes);
  }
  async verifyAccessToken(token: string) {
    const grant = this.grants.get(digest(token));
    if (!grant || grant.type !== "access" || grant.expiresAt < Date.now()) throw new InvalidTokenError("Invalid access token");
    return { token, clientId: grant.clientId, scopes: grant.scopes, expiresAt: Math.floor(grant.expiresAt / 1000), resource: this.resource };
  }
  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest) {
    const key = digest(request.token), grant = this.grants.get(key);
    if (grant?.clientId === client.client_id) {
      for (const [id, entry] of this.grants) if (entry.clientId === client.client_id) this.grants.delete(id);
      await this.save();
    }
  }
}
let provider: LocalOAuthProvider | undefined;
export function setOAuthProvider(value: LocalOAuthProvider) { provider = value; }
export function getOAuthProvider() { return provider; }
