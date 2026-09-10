import fs from "fs/promises";
import path from "path";
import os from "os";

export type UpstreamTransport = "stdio" | "http";
export type UpstreamExposeMode = "none" | "meta_only" | "allowlist" | "all";

export interface UpstreamServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  transport: UpstreamTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  tool_prefix?: string;
  expose: UpstreamExposeMode;
  tools?: string[];
  idle_timeout_sec?: number;
}

export interface UpstreamConfigFile {
  version: 1;
  servers: UpstreamServerConfig[];
}

const CONFIG_VERSION = 1 as const;

export function defaultUpstreamConfig(): UpstreamConfigFile {
  return { version: CONFIG_VERSION, servers: [] };
}

export function resolveUpstreamConfigPath(): string {
  const configured = process.env.MCP_UPSTREAM_CONFIG?.trim();
  if (configured) return path.resolve(configured);
  return path.resolve(process.cwd(), "profiles", "mcp-upstream.json");
}

function normalizeServer(raw: UpstreamServerConfig): UpstreamServerConfig {
  const id = raw.id.trim();
  if (!id) throw new Error("Upstream server id is required");

  const transport = raw.transport;
  if (transport !== "stdio" && transport !== "http") {
    throw new Error(`Invalid transport for ${id}: ${String(raw.transport)}`);
  }

  if (transport === "stdio" && !raw.command?.trim()) {
    throw new Error(`stdio server ${id} requires command`);
  }
  if (transport === "http" && !raw.url?.trim()) {
    throw new Error(`http server ${id} requires url`);
  }

  return {
    id,
    name: raw.name?.trim() || id,
    enabled: raw.enabled !== false,
    transport,
    command: raw.command?.trim(),
    args: raw.args ?? [],
    env: raw.env ?? {},
    cwd: raw.cwd?.trim(),
    url: raw.url?.trim(),
    tool_prefix: (raw.tool_prefix?.trim() || id).replace(/[^a-zA-Z0-9_-]/g, "_"),
    expose: raw.expose ?? "meta_only",
    tools: raw.tools ?? [],
    idle_timeout_sec: raw.idle_timeout_sec ?? 600,
  };
}

export async function loadUpstreamConfig(configPath = resolveUpstreamConfigPath()): Promise<UpstreamConfigFile> {
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as UpstreamConfigFile;
    if (!Array.isArray(parsed.servers)) throw new Error("servers must be an array");
    return {
      version: CONFIG_VERSION,
      servers: parsed.servers.map(normalizeServer),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      const defaults = defaultUpstreamConfig();
      await saveUpstreamConfig(defaults, configPath);
      return defaults;
    }
    throw err;
  }
}

export async function saveUpstreamConfig(
  config: UpstreamConfigFile,
  configPath = resolveUpstreamConfigPath()
): Promise<void> {
  const normalized: UpstreamConfigFile = {
    version: CONFIG_VERSION,
    servers: config.servers.map(normalizeServer),
  };
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(normalized, null, 2), "utf-8");
}

export type McpImportSource = "cursor" | "claude" | "opencode" | "file";

export interface McpServersEntry {
  command?: string;
  args?: string[] | string;
  env?: Record<string, string>;
  environment?: Record<string, string>;
  cwd?: string;
  url?: string;
  type?: string;
  transport?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface DiscoveredMcpConfig {
  source: McpImportSource;
  path: string;
  label: string;
  server_count: number;
}

const HTTP_TYPES = new Set(["http", "streamable-http", "sse", "remote"]);
const STDIO_TYPES = new Set(["stdio", "local"]);

function stripJsonComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonComments(text));
}

function commandToParts(command: string | string[] | undefined): { command?: string; args: string[] } {
  if (!command) return { args: [] };
  if (Array.isArray(command)) {
    return { command: command[0], args: command.slice(1) };
  }
  return { command, args: [] };
}

function resolveTransport(entry: McpServersEntry): UpstreamTransport | null {
  const type = (entry.type || entry.transport || "").toLowerCase();
  const hasUrl = Boolean(entry.url?.trim());
  const cmdParts = commandToParts(entry.command as string | string[] | undefined);
  const hasCommand = Boolean(cmdParts.command?.trim());

  if (HTTP_TYPES.has(type) || hasUrl) return "http";
  if (STDIO_TYPES.has(type) || hasCommand) return "stdio";
  if (type === "ws") return null;
  if (hasUrl) return "http";
  if (hasCommand) return "stdio";
  return null;
}

function entryToServer(id: string, entry: McpServersEntry, enabledDefault = false): UpstreamServerConfig | null {
  const transport = resolveTransport(entry);
  if (!transport) return null;

  const cmdParts = commandToParts(entry.command as string | string[] | undefined);
  const args = Array.isArray(entry.args) ? entry.args : entry.args ? [entry.args] : cmdParts.args;
  const env = { ...(entry.env ?? {}), ...(entry.environment ?? {}) };

  return normalizeServer({
    id,
    name: id,
    enabled: entry.enabled ?? enabledDefault,
    transport,
    command: cmdParts.command,
    args,
    env: Object.keys(env).length ? env : undefined,
    cwd: entry.cwd,
    url: entry.url,
    expose: "meta_only",
    tools: [],
  });
}

export function parseMcpServersRecord(
  servers: Record<string, McpServersEntry>,
  enabledDefault = false
): UpstreamServerConfig[] {
  const imported: UpstreamServerConfig[] = [];
  for (const [id, entry] of Object.entries(servers)) {
    const server = entryToServer(id, entry, enabledDefault);
    if (server) imported.push(server);
  }
  return imported;
}

export interface McpServersFile {
  mcpServers?: Record<string, McpServersEntry>;
}

export function parseMcpServersFile(raw: McpServersFile, enabledDefault = false): UpstreamServerConfig[] {
  return parseMcpServersRecord(raw.mcpServers ?? {}, enabledDefault);
}

export interface ClaudeCodeConfigFile {
  mcpServers?: Record<string, McpServersEntry>;
  projects?: Record<string, { mcpServers?: Record<string, McpServersEntry> }>;
}

export function parseClaudeCodeConfig(raw: ClaudeCodeConfigFile, enabledDefault = false): UpstreamServerConfig[] {
  const merged: Record<string, McpServersEntry> = { ...(raw.mcpServers ?? {}) };
  for (const project of Object.values(raw.projects ?? {})) {
    if (project?.mcpServers) Object.assign(merged, project.mcpServers);
  }
  return parseMcpServersRecord(merged, enabledDefault);
}

export interface OpenCodeMcpEntry {
  type?: "local" | "remote" | string;
  command?: string | string[];
  url?: string;
  cwd?: string;
  environment?: Record<string, string>;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface OpenCodeConfigFile {
  mcp?: Record<string, OpenCodeMcpEntry>;
}

export function parseOpenCodeConfig(raw: OpenCodeConfigFile, enabledDefault = false): UpstreamServerConfig[] {
  const imported: UpstreamServerConfig[] = [];
  for (const [id, entry] of Object.entries(raw.mcp ?? {})) {
    const cmdParts = commandToParts(entry.command);
    const mapped: McpServersEntry = {
      type: entry.type === "remote" ? "http" : entry.type === "local" ? "stdio" : entry.type,
      command: cmdParts.command,
      args: cmdParts.args,
      url: entry.url,
      cwd: entry.cwd,
      environment: entry.environment,
      enabled: entry.enabled,
    };
    const server = entryToServer(id, mapped, enabledDefault);
    if (server) imported.push(server);
  }
  return imported;
}

async function mergeImportedServers(
  incoming: UpstreamServerConfig[],
  options?: { merge?: boolean; enableImported?: boolean }
): Promise<{ imported: string[]; config: UpstreamConfigFile }> {
  const configPath = resolveUpstreamConfigPath();
  const existing = await loadUpstreamConfig(configPath);
  const merge = options?.merge !== false;
  const byId = new Map(existing.servers.map((s) => [s.id, s]));
  const imported: string[] = [];

  for (const server of incoming) {
    if (options?.enableImported) server.enabled = true;
    if (merge && byId.has(server.id)) continue;
    byId.set(server.id, server);
    imported.push(server.id);
  }

  const merged: UpstreamConfigFile = { version: CONFIG_VERSION, servers: [...byId.values()] };
  await saveUpstreamConfig(merged, configPath);
  return { imported, config: merged };
}

export async function importMcpConfigFromFile(
  filePath: string,
  source: McpImportSource,
  options?: { merge?: boolean; enableImported?: boolean }
): Promise<{ imported: string[]; config: UpstreamConfigFile; source: McpImportSource; path: string }> {
  const rawText = await fs.readFile(filePath, "utf-8");
  const parsed = parseJsonc(rawText);
  let incoming: UpstreamServerConfig[] = [];

  if (source === "opencode") {
    incoming = parseOpenCodeConfig(parsed as OpenCodeConfigFile, false);
  } else if (source === "claude") {
    incoming = parseClaudeCodeConfig(parsed as ClaudeCodeConfigFile, false);
  } else {
    incoming = parseMcpServersFile(parsed as McpServersFile, false);
  }

  const result = await mergeImportedServers(incoming, options);
  return { ...result, source, path: filePath };
}

export async function importCursorMcpConfig(
  cursorConfigPath: string,
  options?: { merge?: boolean; enableImported?: boolean }
) {
  return importMcpConfigFromFile(cursorConfigPath, "cursor", options);
}

function homePaths(...segments: string[]): string {
  return path.join(os.homedir(), ...segments);
}

export function discoveryCandidates(): Array<{ source: McpImportSource; path: string; label: string }> {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const programData = process.env.ProgramData || "C:\\ProgramData";
  const cwd = process.cwd();

  return [
    { source: "cursor", path: path.join(home, ".cursor", "mcp.json"), label: "Cursor (~/.cursor/mcp.json)" },
    { source: "cursor", path: path.join(appData, "Cursor", "User", "mcp.json"), label: "Cursor (AppData)" },
    { source: "claude", path: homePaths(".claude.json"), label: "Claude Code (~/.claude.json)" },
    { source: "claude", path: path.join(cwd, ".mcp.json"), label: "Claude Code (project .mcp.json)" },
    { source: "claude", path: path.join(appData, "Claude", "claude_desktop_config.json"), label: "Claude Desktop" },
    { source: "opencode", path: homePaths(".config", "opencode", "opencode.json"), label: "OpenCode (global)" },
    { source: "opencode", path: homePaths(".config", "opencode", "opencode.jsonc"), label: "OpenCode (global jsonc)" },
    { source: "opencode", path: path.join(cwd, "opencode.json"), label: "OpenCode (project)" },
    { source: "opencode", path: path.join(cwd, "opencode.jsonc"), label: "OpenCode (project jsonc)" },
    { source: "opencode", path: path.join(programData, "opencode", "opencode.json"), label: "OpenCode (managed)" },
  ];
}

export async function discoverMcpConfigs(): Promise<DiscoveredMcpConfig[]> {
  const found: DiscoveredMcpConfig[] = [];
  const seen = new Set<string>();

  for (const candidate of discoveryCandidates()) {
    if (seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    try {
      await fs.access(candidate.path);
      const rawText = await fs.readFile(candidate.path, "utf-8");
      const parsed = parseJsonc(rawText);
      let count = 0;
      if (candidate.source === "opencode") count = Object.keys((parsed as OpenCodeConfigFile).mcp ?? {}).length;
      else if (candidate.source === "claude") count = parseClaudeCodeConfig(parsed as ClaudeCodeConfigFile).length;
      else count = Object.keys((parsed as McpServersFile).mcpServers ?? {}).length;
      if (count > 0) found.push({ source: candidate.source, path: candidate.path, label: candidate.label, server_count: count });
    } catch {}
  }
  return found;
}

export async function findMcpConfigForSource(source: McpImportSource): Promise<string | null> {
  const configs = await discoverMcpConfigs();
  return configs.find((c) => c.source === source)?.path ?? null;
}

export async function findCursorMcpConfig(): Promise<string | null> {
  return findMcpConfigForSource("cursor");
}