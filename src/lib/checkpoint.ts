import fs from "fs/promises";
import path from "path";
import { randomUUID, createHash } from "node:crypto";
import { executionContext } from "./workbench-context.js";

export interface CheckpointFileSnapshot {
  path: string;
  existed: boolean;
  is_directory?: boolean;
  encoding?: "utf-8" | "base64";
  content?: string;
  children?: CheckpointFileSnapshot[];
  skipped?: boolean;
  skip_reason?: string;
}

export interface CheckpointSummary {
  id: string;
  created_at: string;
  tool: string;
  summary: string;
  files: string[];
  file_count: number;
}

interface CheckpointManifest {
  version: 1;
  id: string;
  created_at: string;
  tool: string;
  summary: string;
  files: CheckpointFileSnapshot[];
}

interface CheckpointIndex {
  version: 1;
  checkpoints: CheckpointSummary[];
}

const INDEX_VERSION = 1 as const;
const DEFAULT_MAX_COUNT = 500;
const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_DIRECTORY_DEPTH = 32;

function isEnabled(): boolean {
  const raw = (process.env.CHECKPOINT_ENABLED ?? "true").trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(raw);
}

function getStoreRoot(): string {
  return process.env.CHECKPOINT_PATH || path.resolve(process.cwd(), ".mcp-checkpoints");
}

function getMaxCount(): number {
  const n = parseInt(process.env.CHECKPOINT_MAX_COUNT || String(DEFAULT_MAX_COUNT), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_COUNT;
}

function getRetentionDays(): number {
  const n = parseInt(process.env.CHECKPOINT_RETENTION_DAYS || String(DEFAULT_RETENTION_DAYS), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION_DAYS;
}

function getMaxFileBytes(): number {
  const n = parseInt(process.env.CHECKPOINT_MAX_FILE_BYTES || String(DEFAULT_MAX_FILE_BYTES), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_FILE_BYTES;
}

function checkpointDir(id: string): string {
  return path.join(getStoreRoot(), "data", id);
}

function indexPath(): string {
  return path.join(getStoreRoot(), "index.json");
}

function manifestPath(id: string): string {
  return path.join(checkpointDir(id), "manifest.json");
}

function isUtf8(buffer: Buffer): boolean {
  try {
    const text = buffer.toString("utf-8");
    return Buffer.from(text, "utf-8").equals(buffer);
  } catch {
    return false;
  }
}

async function readIndex(): Promise<CheckpointIndex> {
  try {
    const raw = await fs.readFile(indexPath(), "utf-8");
    const parsed = JSON.parse(raw) as CheckpointIndex;
    if (parsed.version === INDEX_VERSION && Array.isArray(parsed.checkpoints)) {
      return parsed;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return { version: INDEX_VERSION, checkpoints: [] };
}

async function writeIndex(index: CheckpointIndex): Promise<void> {
  const root = getStoreRoot();
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(indexPath(), JSON.stringify(index, null, 2), "utf-8");
}

async function readManifest(id: string): Promise<CheckpointManifest | null> {
  try {
    const raw = await fs.readFile(manifestPath(id), "utf-8");
    return JSON.parse(raw) as CheckpointManifest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

async function snapshotFile(filePath: string): Promise<CheckpointFileSnapshot> {
  const resolved = path.resolve(filePath);
  try {
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      return snapshotDirectory(resolved, 0);
    }
    if (stat.size > getMaxFileBytes()) {
      return {
        path: resolved,
        existed: true,
        skipped: true,
        skip_reason: `file exceeds CHECKPOINT_MAX_FILE_BYTES (${stat.size} bytes)`,
      };
    }
    const buffer = await fs.readFile(resolved);
    if (isUtf8(buffer)) {
      return { path: resolved, existed: true, encoding: "utf-8", content: buffer.toString("utf-8") };
    }
    return { path: resolved, existed: true, encoding: "base64", content: buffer.toString("base64") };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { path: resolved, existed: false };
    }
    throw err;
  }
}

async function snapshotDirectory(dirPath: string, depth: number): Promise<CheckpointFileSnapshot> {
  if (depth > MAX_DIRECTORY_DEPTH) {
    return {
      path: dirPath,
      existed: true,
      is_directory: true,
      skipped: true,
      skip_reason: `directory depth exceeds ${MAX_DIRECTORY_DEPTH}`,
      children: [],
    };
  }

  const children: CheckpointFileSnapshot[] = [];
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      children.push(await snapshotDirectory(full, depth + 1));
    } else if (entry.isFile()) {
      children.push(await snapshotFile(full));
    }
  }

  return { path: dirPath, existed: true, is_directory: true, children };
}

async function restoreSnapshot(snapshot: CheckpointFileSnapshot): Promise<void> {
  const target = snapshot.path;

  if (!snapshot.existed) {
    try {
      const stat = await fs.stat(target);
      if (stat.isDirectory()) {
        await fs.rm(target, { recursive: true, force: true });
      } else {
        await fs.unlink(target);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return;
  }

  if (snapshot.skipped) {
    throw new Error(`Cannot restore skipped snapshot for ${target}: ${snapshot.skip_reason || "unknown"}`);
  }

  if (snapshot.is_directory) {
    await fs.mkdir(target, { recursive: true });
    for (const child of snapshot.children || []) {
      await restoreSnapshot(child);
    }
    return;
  }

  await fs.mkdir(path.dirname(target), { recursive: true });
  const buffer =
    snapshot.encoding === "base64"
      ? Buffer.from(snapshot.content || "", "base64")
      : Buffer.from(snapshot.content || "", "utf-8");
  await fs.writeFile(target, buffer);
}

async function removeCheckpointData(id: string): Promise<void> {
  await fs.rm(checkpointDir(id), { recursive: true, force: true });
}

async function pruneCheckpoints(index: CheckpointIndex): Promise<CheckpointIndex> {
  const maxCount = getMaxCount();
  const retentionMs = getRetentionDays() * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - retentionMs;

  let checkpoints = [...index.checkpoints];
  const toDelete: string[] = [];

  checkpoints = checkpoints.filter((cp) => {
    const created = Date.parse(cp.created_at);
    if (Number.isFinite(created) && created < cutoff) {
      toDelete.push(cp.id);
      return false;
    }
    return true;
  });

  while (checkpoints.length > maxCount) {
    const removed = checkpoints.shift();
    if (removed) toDelete.push(removed.id);
  }

  for (const id of toDelete) {
    await removeCheckpointData(id);
  }

  return { version: INDEX_VERSION, checkpoints };
}

function buildSummary(manifest: CheckpointManifest): CheckpointSummary {
  return {
    id: manifest.id,
    created_at: manifest.created_at,
    tool: manifest.tool,
    summary: manifest.summary,
    files: manifest.files.map((f) => f.path),
    file_count: manifest.files.length,
  };
}

export function getCheckpointConfig(): Record<string, unknown> {
  return {
    enabled: isEnabled(),
    store_path: getStoreRoot(),
    max_count: getMaxCount(),
    retention_days: getRetentionDays(),
    max_file_bytes: getMaxFileBytes(),
    note: "Only file-editing MCP tools are tracked. Shell/bash file changes are not captured.",
  };
}

export async function checkpointBefore(
  tool: string,
  paths: string[],
  options?: { summary?: string; dry_run?: boolean }
): Promise<string | null> {
  const workbenchContext = executionContext.getStore();
  if (!options?.dry_run) await workbenchContext?.capture(paths);
  // Workbench's task journal is the canonical checkpoint source for normal MCP
  // sessions. Keep the legacy snapshot store only for direct/non-Workbench
  // callers so older tests and integrations remain compatible.
  if (workbenchContext) return null;
  if (!isEnabled() || options?.dry_run) return null;

  const uniquePaths = [...new Set(paths.map((p) => path.resolve(p)))];
  if (uniquePaths.length === 0) return null;

  const snapshots: CheckpointFileSnapshot[] = [];
  for (const filePath of uniquePaths) {
    snapshots.push(await snapshotFile(filePath));
  }

  const id = `cp_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const createdAt = new Date().toISOString();
  const summary =
    options?.summary ||
    `${tool}: ${uniquePaths.length} path(s) — ${uniquePaths.map((p) => path.basename(p)).join(", ")}`;

  const manifest: CheckpointManifest = {
    version: INDEX_VERSION,
    id,
    created_at: createdAt,
    tool,
    summary,
    files: snapshots,
  };

  const dir = checkpointDir(id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(manifestPath(id), JSON.stringify(manifest, null, 2), "utf-8");

  const index = await readIndex();
  index.checkpoints.push(buildSummary(manifest));
  const pruned = await pruneCheckpoints(index);
  await writeIndex(pruned);

  return id;
}

export async function listCheckpoints(limit = 50): Promise<CheckpointSummary[]> {
  const index = await readIndex();
  return [...index.checkpoints].reverse().slice(0, Math.max(1, limit));
}

export async function getCheckpoint(id: string): Promise<CheckpointSummary | null> {
  const index = await readIndex();
  return index.checkpoints.find((cp) => cp.id === id) ?? null;
}

function findCheckpointIndex(checkpoints: CheckpointSummary[], id: string): number {
  return checkpoints.findIndex((cp) => cp.id === id);
}

async function collectRestorePlan(targetId: string): Promise<{
  target: CheckpointSummary;
  files: Map<string, CheckpointFileSnapshot>;
  skipped: CheckpointFileSnapshot[];
}> {
  const index = await readIndex();
  const targetIndex = findCheckpointIndex(index.checkpoints, targetId);
  if (targetIndex < 0) {
    throw new Error(`Checkpoint not found: ${targetId}`);
  }

  const target = index.checkpoints[targetIndex];
  const affected = index.checkpoints.slice(targetIndex);
  const files = new Map<string, CheckpointFileSnapshot>();
  const skipped: CheckpointFileSnapshot[] = [];

  for (let i = 0; i < affected.length; i++) {
    const manifest = await readManifest(affected[i].id);
    if (!manifest) continue;
    for (const snapshot of manifest.files) {
      if (!files.has(snapshot.path)) {
        files.set(snapshot.path, snapshot);
        if (snapshot.skipped) skipped.push(snapshot);
      }
    }
  }

  return { target, files, skipped };
}

export async function previewRestore(targetId: string): Promise<{
  checkpoint: CheckpointSummary;
  changes: Array<{
    path: string;
    action: "restore" | "delete" | "skip";
    existed_before_edit: boolean;
    reason?: string;
  }>;
  skipped_snapshots: Array<{ path: string; reason?: string }>;
}> {
  const { target, files, skipped } = await collectRestorePlan(targetId);
  const changes: Array<{
    path: string;
    action: "restore" | "delete" | "skip";
    existed_before_edit: boolean;
    reason?: string;
  }> = [];

  for (const [filePath, snapshot] of files) {
    if (snapshot.skipped) {
      changes.push({
        path: filePath,
        action: "skip",
        existed_before_edit: snapshot.existed,
        reason: snapshot.skip_reason,
      });
      continue;
    }

    let existsNow = false;
    try {
      await fs.access(filePath);
      existsNow = true;
    } catch {}

    if (!snapshot.existed) {
      changes.push({
        path: filePath,
        action: existsNow ? "delete" : "skip",
        existed_before_edit: false,
        reason: existsNow ? "file was created after checkpoint" : "already absent",
      });
      continue;
    }

    changes.push({
      path: filePath,
      action: "restore",
      existed_before_edit: true,
    });
  }

  return {
    checkpoint: target,
    changes,
    skipped_snapshots: skipped.map((s) => ({ path: s.path, reason: s.skip_reason })),
  };
}

export async function restoreToCheckpoint(targetId: string): Promise<{
  checkpoint: CheckpointSummary;
  restored: string[];
  deleted: string[];
  skipped: Array<{ path: string; reason?: string }>;
}> {
  const { target, files } = await collectRestorePlan(targetId);
  const restored: string[] = [];
  const deleted: string[] = [];
  const skipped: Array<{ path: string; reason?: string }> = [];

  // Apply in reverse path order so nested directory restores stay consistent.
  const ordered = [...files.entries()].sort((a, b) => b[0].length - a[0].length);

  for (const [filePath, snapshot] of ordered) {
    if (snapshot.skipped) {
      skipped.push({ path: filePath, reason: snapshot.skip_reason });
      continue;
    }

    if (!snapshot.existed) {
      try {
        await fs.rm(filePath, { recursive: true, force: true });
        deleted.push(filePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      continue;
    }

    await restoreSnapshot(snapshot);
    restored.push(filePath);
  }

  // Remove checkpoints after the restore point (they are now stale).
  const index = await readIndex();
  const targetIndex = findCheckpointIndex(index.checkpoints, targetId);
  const removed = index.checkpoints.splice(targetIndex);
  for (const cp of removed) {
    await removeCheckpointData(cp.id);
  }
  await writeIndex(index);

  return { checkpoint: target, restored, deleted, skipped };
}

export async function clearCheckpoints(): Promise<number> {
  const index = await readIndex();
  const count = index.checkpoints.length;
  for (const cp of index.checkpoints) {
    await removeCheckpointData(cp.id);
  }
  await writeIndex({ version: INDEX_VERSION, checkpoints: [] });
  return count;
}

export function checkpointFingerprint(paths: string[]): string {
  const normalized = [...new Set(paths.map((p) => path.resolve(p)))].sort();
  return createHash("sha256").update(normalized.join("\n")).digest("hex").slice(0, 12);
}
