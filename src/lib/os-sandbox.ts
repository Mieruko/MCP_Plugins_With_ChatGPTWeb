import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { executionContext, childEnvironment } from "./workbench-context.js";

export type SandboxProvider = "none" | "docker";

export interface SandboxStatus {
  provider: SandboxProvider;
  configured: boolean;
  available: boolean;
  image?: string;
  endpoint?: string;
  reason?: string;
  network: "none";
  shell?: "sh";
}

export interface DockerRunSpec {
  bin: string;
  args: string[];
  containerName: string;
  containerCwd: string;
}

export interface SandboxedProcess {
  child: ChildProcessWithoutNullStreams;
  provider: "docker";
  containerName: string;
}

const DEFAULT_IMAGE = "node:22-bookworm";
const STATUS_TTL_MS = 10_000;
let cachedStatus: { at: number; value: SandboxStatus } | undefined;

function providerSetting(): "none" | "docker" {
  return process.env.WORKBENCH_SANDBOX_PROVIDER?.trim().toLowerCase() === "docker" ? "docker" : "none";
}

function dockerBin(): string {
  return process.env.WORKBENCH_SANDBOX_DOCKER_BIN?.trim() || "docker";
}

function sandboxImage(): string {
  return process.env.WORKBENCH_SANDBOX_IMAGE?.trim() || DEFAULT_IMAGE;
}

function positiveInt(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function containerPath(workspace: string, cwd: string): string {
  const root = path.resolve(workspace);
  const target = path.resolve(cwd);
  if (!inside(root, target)) throw new Error("SANDBOX_PATH_ESCAPE: working directory is outside the task workspace");
  const relative = path.relative(root, target).split(path.sep).filter(Boolean).join("/");
  return relative ? `/workspace/${relative}` : "/workspace";
}

function containerUser(): string {
  const configured = process.env.WORKBENCH_SANDBOX_USER?.trim();
  if (configured) {
    const identity = configured.split(":", 1)[0]?.toLowerCase();
    if (identity === "0" || identity === "root") throw new Error("SANDBOX_CONFIG_INVALID: WORKBENCH_SANDBOX_USER must be non-root");
    return configured;
  }
  const getuid = (process as NodeJS.Process & { getuid?: () => number }).getuid;
  const getgid = (process as NodeJS.Process & { getgid?: () => number }).getgid;
  if (typeof getuid === "function" && typeof getgid === "function") {
    const uid = getuid.call(process), gid = getgid.call(process);
    if (uid > 0) return `${uid}:${gid}`;
  }
  // Docker Desktop bind mounts from Windows are writable by a non-root Linux user.
  return "65534:65534";
}

export function buildDockerRunSpec(
  workspace: string,
  cwd: string,
  program: string,
  programArgs: string[],
  env: Record<string, string> = {},
  name = `clc-${randomUUID().slice(0, 12)}`
): DockerRunSpec {
  const image = sandboxImage();
  const memoryMb = positiveInt("WORKBENCH_SANDBOX_MEMORY_MB", 1536, 128, 32768);
  const pids = positiveInt("WORKBENCH_SANDBOX_PIDS", 256, 32, 4096);
  const cpus = Math.max(0.25, Math.min(16, Number(process.env.WORKBENCH_SANDBOX_CPUS) || 2));
  const containerCwd = containerPath(workspace, cwd);
  const volume = `${path.resolve(workspace)}:/workspace:rw`;
  const envArgs = Object.entries({ HOME: "/home/sandbox", CI: "1", NO_COLOR: "1", ...env })
    .flatMap(([key, value]) => ["--env", `${key}=${value}`]);
  const args = [
    "run", "--rm", "--name", name,
    "--network", "none",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges",
    "--pids-limit", String(pids),
    "--memory", `${memoryMb}m`,
    "--cpus", String(cpus),
    "--read-only",
    "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=256m",
    "--tmpfs", "/home/sandbox:rw,nosuid,nodev,size=64m",
    "--user", containerUser(),
    "--volume", volume,
    "--workdir", containerCwd,
    ...envArgs,
    image,
    program,
    ...programArgs,
  ];
  return { bin: dockerBin(), args, containerName: name, containerCwd };
}

function sandboxDockerEnvironment(): NodeJS.ProcessEnv {
  const env = childEnvironment();
  // Workspace sandbox must never be redirected to a remote Docker daemon by inherited shell settings.
  for (const name of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH"]) delete env[name];
  return env;
}

function capture(bin: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    let stdout = "", stderr = "", settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(bin, args, { windowsHide: true, env: sandboxDockerEnvironment() });
    } catch (error) {
      resolve({ code: 1, stdout: "", stderr: String(error) });
      return;
    }
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    };
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish(1); }, timeoutMs);
    child.stdout?.on("data", data => { stdout = (stdout + data.toString()).slice(-32_000); });
    child.stderr?.on("data", data => { stderr = (stderr + data.toString()).slice(-32_000); });
    child.once("error", error => { stderr = error.message; finish(1); });
    child.once("close", code => finish(code ?? 1));
  });
}

export async function getSandboxStatus(refresh = false): Promise<SandboxStatus> {
  if (!refresh && cachedStatus && Date.now() - cachedStatus.at < STATUS_TTL_MS) return cachedStatus.value;
  if (providerSetting() === "none") {
    const value: SandboxStatus = { provider: "none", configured: false, available: false, network: "none", reason: "WORKBENCH_SANDBOX_PROVIDER is not set to docker" };
    cachedStatus = { at: Date.now(), value };
    return value;
  }
  const image = sandboxImage();
  const context = await capture(dockerBin(), ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], 3000);
  const endpoint = context.stdout.trim();
  if (context.code !== 0 || !/^(?:unix|npipe):\/\//i.test(endpoint)) {
    const value: SandboxStatus = {
      provider: "docker", configured: true, available: false, image, network: "none", shell: "sh",
      ...(endpoint ? { endpoint } : {}),
      reason: context.code !== 0 ? (context.stderr || "Unable to inspect the active Docker context") : `Remote Docker endpoint is not allowed for workspace sandboxing: ${endpoint}`,
    };
    cachedStatus = { at: Date.now(), value };
    return value;
  }
  const version = await capture(dockerBin(), ["version", "--format", "{{.Server.Version}}"], 3000);
  if (version.code !== 0) {
    const value: SandboxStatus = { provider: "docker", configured: true, available: false, image, endpoint, network: "none", shell: "sh", reason: version.stderr || "Docker daemon is unavailable" };
    cachedStatus = { at: Date.now(), value };
    return value;
  }
  const inspected = await capture(dockerBin(), ["image", "inspect", image, "--format", "{{.Id}}"], 3000);
  const value: SandboxStatus = inspected.code === 0
    ? { provider: "docker", configured: true, available: true, image, endpoint, network: "none", shell: "sh" }
    : { provider: "docker", configured: true, available: false, image, endpoint, network: "none", shell: "sh", reason: `Sandbox image is not installed: ${image}` };
  cachedStatus = { at: Date.now(), value };
  return value;
}

export function executionNeedsSandbox(): boolean {
  return Boolean(executionContext.getStore()?.workspaceOnly);
}

export async function requireWorkspaceSandbox(): Promise<SandboxStatus> {
  if (!executionNeedsSandbox()) return { provider: "none", configured: false, available: true, network: "none" };
  const status = await getSandboxStatus();
  if (!status.available) throw new Error(`SANDBOX_UNAVAILABLE: ${status.reason || "workspace process sandbox is unavailable"}`);
  return status;
}

export async function spawnSandboxedProgram(
  program: string,
  args: string[],
  cwd: string,
  env: Record<string, string> = {}
): Promise<SandboxedProcess> {
  const context = executionContext.getStore();
  if (!context?.workspaceOnly) throw new Error("Sandboxed execution requires a workspace-only task context");
  await requireWorkspaceSandbox();
  const spec = buildDockerRunSpec(context.workspace, cwd, program, args, env);
  const child = spawn(spec.bin, spec.args, { windowsHide: true, env: sandboxDockerEnvironment() }) as ChildProcessWithoutNullStreams;
  return { child, provider: "docker", containerName: spec.containerName };
}

export async function spawnSandboxedShell(command: string, cwd: string): Promise<SandboxedProcess> {
  return spawnSandboxedProgram("sh", ["-lc", command], cwd);
}

export async function terminateSandboxContainer(containerName: string, force: boolean): Promise<void> {
  const command = force ? ["rm", "-f", containerName] : ["stop", "--time", "1", containerName];
  await capture(dockerBin(), command, force ? 4000 : 2500);
  if (!force) await capture(dockerBin(), ["rm", "-f", containerName], 2500);
}

export function resetSandboxStatusCache(): void {
  cachedStatus = undefined;
}