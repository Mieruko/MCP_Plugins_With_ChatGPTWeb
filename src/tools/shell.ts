import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validatePath, getDefaultCwd } from "../lib/path-security.js";
import { requireCommandAllowed } from "../lib/permissions.js";
import { audit } from "../lib/audit.js";
import { toolAnnotations } from "../lib/tool-annotations.js";
import { toolResult } from "../lib/tool-result.js";
import { ProcessLog } from "../lib/process-log.js";
import { executionContext, childEnvironment } from "../lib/workbench-context.js";
import {
  bootstrapShellSession,
  execInShellSession,
  getShellStatus,
  resetShellSession,
} from "../lib/persistent-shell.js";

interface ManagedProcess {
  taskId?: string;
  id: string;
  command: string;
  cwd: string;
  startedAt: string;
  child: ChildProcessWithoutNullStreams;
  stdout: ProcessLog;
  stderr: ProcessLog;
  finished: boolean;
  error?: string;
  listeners: Set<() => void>;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

const processes = new Map<string, ManagedProcess>();
type LogCursor = { stdout: number; stderr: number };

function output(item: ManagedProcess, cursor: LogCursor | undefined, limit: number) {
  const stdout = item.stdout.read(cursor?.stdout, limit);
  const stderr = item.stderr.read(cursor?.stderr, limit);
  return { id: item.id, running: !item.finished, exit_code: item.exitCode, signal: item.signal,
    stdout: stdout.text, stderr: stderr.text, cursor: { stdout: stdout.cursor, stderr: stderr.cursor },
    dropped: stdout.dropped || stderr.dropped, has_more: stdout.has_more || stderr.has_more,
    ...(item.error ? { error: item.error } : {}) };
}

async function waitForProcess(item: ManagedProcess, ms: number, ready: () => boolean, signal?: AbortSignal): Promise<void> {
  if (!ms || ready() || signal?.aborted) return;
  await new Promise<void>(resolve => {
    const finish = () => { clearTimeout(timer); item.listeners.delete(check); signal?.removeEventListener("abort", finish); resolve(); };
    const check = () => { if (ready()) finish(); };
    const timer = setTimeout(finish, ms);
    item.listeners.add(check);
    signal?.addEventListener("abort", finish, { once: true });
    check();
  });
}

export function registerShellTools(server: McpServer, defaultCwd: string, timeoutSec: number): void {
  void bootstrapShellSession(defaultCwd);

  server.registerTool(
    "run_command",
    {
      title: "Run Command",
      description:
        "Run shell commands to verify work (tests, build, lint). Cwd persists across ChatGPT tool calls (saved to disk). Use shell_status to check cwd. Use start_process for long jobs.",
      inputSchema: {
        command: z.string(),
        working_directory: z.string().optional().describe("One-off override; does not reset persistent cwd unless you use shell_reset"),
      },

      annotations: toolAnnotations("command"),
    },
    async ({ command, working_directory }) => {
      requireCommandAllowed(command);
      const cwdOverride = working_directory ? await validatePath(working_directory) : undefined;
      const result = await execInShellSession(command, defaultCwd, timeoutSec * 1000, cwdOverride);
      await audit({
        tool: "run_command",
        action: "command",
        target: result.cwd,
        status: result.exit_code === 0 ? "ok" : "error",
        details: { command, exit_code: result.exit_code },
      });
      return toolResult("run_command", result, {
        ok: result.exit_code === 0,
        summary: `exit ${result.exit_code} in ${result.cwd}`,
      });
    }
  );

  server.registerTool(
    "shell_status",
    {
      title: "Shell Status",
      description: "Show persistent shell session cwd and recent commands.",
      inputSchema: {},

      annotations: toolAnnotations("read"),
    },
    async () => {
      const status = getShellStatus();
      return toolResult("shell_status", status, { summary: `cwd: ${status.cwd}` });
    }
  );

  server.registerTool(
    "shell_reset",
    {
      title: "Shell Reset",
      description: "Reset persistent shell cwd to a directory (default: workspace).",
      inputSchema: { path: z.string().optional() },

      annotations: toolAnnotations("edit"),
    },
    async ({ path: dirPath }) => {
      const cwd = await validatePath(dirPath || getDefaultCwd());
      resetShellSession(cwd);
      return toolResult("shell_reset", { cwd }, { summary: `shell cwd reset to ${cwd}` });
    }
  );

  server.registerTool(
    "start_process",
    {
      title: "Start Background Process",
      description: "Start a command; wait briefly for completion and return initial output plus a cursor. If still running, call process_output with that cursor and wait_ms=10000. Never restart the command just to retrieve output.",
      inputSchema: { command: z.string(), working_directory: z.string().optional(), yield_time_ms: z.number().int().min(0).max(10000).default(1000) },

      annotations: toolAnnotations("command"),
    },
    async ({ command, working_directory, yield_time_ms }, extra) => {
      requireCommandAllowed(command);
      const cwd = working_directory ? await validatePath(working_directory) : getShellStatus().cwd || defaultCwd;
      const shell = process.platform === "win32" ? "powershell.exe" : "bash";
      const args = process.platform === "win32" ? ["-NoProfile", "-Command", command] : ["-lc", command];
      const child = spawn(shell, args, { cwd, windowsHide: true, env: childEnvironment() });
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const item: ManagedProcess = {
        taskId: executionContext.getStore()?.taskId,
        id,
        command,
        cwd,
        startedAt: new Date().toISOString(),
        child,
        stdout: new ProcessLog(),
        stderr: new ProcessLog(),
        finished: false,
        listeners: new Set(),
        exitCode: null,
        signal: null,
      };
      processes.set(id, item);
      const notify = () => { for (const listener of item.listeners) listener(); };
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (d: string) => { item.stdout.append(d); notify(); });
      child.stderr.on("data", (d: string) => { item.stderr.append(d); notify(); });
      child.on("error", (error) => { item.error = error.message; item.finished = true; notify(); });
      child.on("close", (code, signal) => {
        item.exitCode = code;
        item.signal = signal;
        item.finished = true;
        notify();
      });
      await audit({ tool: "start_process", action: "start", target: cwd, status: "ok", details: { id, command } });
      await waitForProcess(item, yield_time_ms, () => item.finished, extra.signal);
      return toolResult("start_process", { pid: child.pid, command, cwd, started_at: item.startedAt, ...output(item, { stdout: 0, stderr: 0 }, 8000) }, {
        ok: !item.finished || item.exitCode === 0,
        summary: item.finished ? `finished ${id}: exit ${item.exitCode}` : `started ${id}`,
      });
    }
  );

  server.registerTool(
    "process_status",
    {
      title: "Process Status",
      description: "Show status of background process(es).",
      inputSchema: { id: z.string().optional() },

      annotations: toolAnnotations("read"),
    },
    async ({ id }) => {
      const processes_list = [...processes.values()]
        .filter(p => p.taskId === executionContext.getStore()?.taskId)
        .filter((p) => !id || p.id === id)
        .map((p) => ({
          id: p.id,
          pid: p.child.pid,
          command: p.command,
          cwd: p.cwd,
          started_at: p.startedAt,
          running: !p.finished,
          exit_code: p.exitCode,
          signal: p.signal,
        }));
      return toolResult("process_status", { processes: processes_list }, { summary: `${processes_list.length} process(es)` });
    }
  );

  server.registerTool(
    "process_output",
    {
      title: "Process Output",
      description: "Read new background output using the cursor returned by start_process/process_output. Set wait_ms=10000 to wait for new output or completion instead of repeatedly polling. Without cursor, returns the latest tail. dropped=true means old log was evicted; has_more=true means read again with the returned cursor.",
      inputSchema: {
        id: z.string(),
        tail_chars: z.number().int().positive().max(200000).optional().default(8000),
        cursor: z.object({ stdout: z.number().int().nonnegative(), stderr: z.number().int().nonnegative() }).optional(),
        wait_ms: z.number().int().min(0).max(10000).default(0),
      },

      annotations: toolAnnotations("read"),
    },
    async ({ id, tail_chars, cursor, wait_ms }, extra) => {
      const item = processes.get(id);
      if (!item || item.taskId !== executionContext.getStore()?.taskId) throw new Error(`Unknown process id for this task: ${id}`);
      // Validate cursor before waiting; do not delay invalid requests.
      output(item, cursor, tail_chars);
      const since = cursor ?? { stdout: item.stdout.end, stderr: item.stderr.end };
      await waitForProcess(item, wait_ms, () => item.finished || item.stdout.end > since.stdout || item.stderr.end > since.stderr, extra.signal);
      const data = output(item, cursor, tail_chars);
      return toolResult("process_output", data, { summary: `output for ${id}` });
    }
  );

  server.registerTool(
    "stop_process",
    {
      title: "Stop Process",
      description: "Stop a background process by id.",
      inputSchema: { id: z.string(), force: z.boolean().optional().default(false) },

      annotations: toolAnnotations("edit"),
    },
    async ({ id, force }) => {
      const item = processes.get(id);
      if (!item || item.taskId !== executionContext.getStore()?.taskId) throw new Error(`Unknown process id for this task: ${id}`);
      if (item.finished) {
        return toolResult("stop_process", { id, already_exited: true }, { summary: `${id} already exited` });
      }
      item.child.kill(force ? "SIGKILL" : "SIGTERM");
      await audit({ tool: "stop_process", action: "stop", target: item.cwd, status: "ok", details: { id, force } });
      return toolResult("stop_process", { id, force }, { summary: `stop sent to ${id}` });
    }
  );

  server.registerTool(
    "clear_processes",
    {
      title: "Clear Finished Processes",
      description: "Remove finished process records from memory.",
      inputSchema: {},

      annotations: toolAnnotations("edit"),
    },
    async () => {
      let cleared = 0;
      for (const [id, item] of processes) {
        if (item.finished && item.taskId === executionContext.getStore()?.taskId) {
          processes.delete(id);
          cleared++;
        }
      }
      return toolResult("clear_processes", { cleared }, { summary: `cleared ${cleared}` });
    }
  );
}
