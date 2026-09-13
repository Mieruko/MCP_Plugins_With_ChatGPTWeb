import net from "node:net";

export interface PortLease {
  id: string;
  taskId: string;
  purpose: "preview";
  port: number;
  createdAt: string;
  lastSeenAt: string;
}

export interface PortRange {
  start: number;
  end: number;
}

const DEFAULT_PREVIEW_RANGE: PortRange = { start: 4300, end: 4399 };

export function previewPortRange(raw = process.env.WORKBENCH_PREVIEW_PORT_RANGE): PortRange {
  const value = String(raw || "").trim();
  if (!value) return DEFAULT_PREVIEW_RANGE;
  const match = value.match(/^(\d{1,5})\s*-\s*(\d{1,5})$/);
  if (!match) throw new Error("WORKBENCH_PREVIEW_PORT_RANGE must look like 4300-4399");
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1024 || end > 65535 || start > end || end - start > 5000) {
    throw new Error("WORKBENCH_PREVIEW_PORT_RANGE must be a valid 1024-65535 range with at most 5001 ports");
  }
  return { start, end };
}

export async function isLoopbackPortAvailable(port: number): Promise<boolean> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  return await new Promise<boolean>(resolve => {
    const server = net.createServer();
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      server.removeAllListeners();
      resolve(value);
    };
    server.unref();
    server.once("error", () => finish(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.close(error => finish(!error));
    });
  });
}

export async function waitForLoopbackPortAvailable(port: number, timeoutMs = 1800): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  do {
    if (await isLoopbackPortAvailable(port)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 90));
  } while (true);
}

export async function selectPreviewPort(used: Set<number>, preferred?: number): Promise<number> {
  const range = previewPortRange();
  const candidates: number[] = [];
  if (preferred && preferred >= range.start && preferred <= range.end) candidates.push(preferred);
  for (let port = range.start; port <= range.end; port++) if (port !== preferred) candidates.push(port);
  for (const port of candidates) {
    if (used.has(port)) continue;
    if (await isLoopbackPortAvailable(port)) return port;
  }
  throw new Error(`PREVIEW_PORT_EXHAUSTED: no free preview port is available in ${range.start}-${range.end}`);
}