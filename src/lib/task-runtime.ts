export type TaskRuntimeProcessRole = "process" | "preview";

interface TaskRuntimeProcessController {
  taskId: string;
  id: string;
  pid?: number;
  command: string;
  cwd: string;
  startedAt: string;
  role: TaskRuntimeProcessRole;
  isRunning: () => boolean;
  stop: (force: boolean) => Promise<void>;
}

export interface TaskRuntimeProcessSnapshot {
  taskId: string;
  id: string;
  pid?: number;
  command: string;
  cwd: string;
  startedAt: string;
  role: TaskRuntimeProcessRole;
  running: boolean;
}

export interface TaskRuntimeSnapshot {
  taskId: string;
  status: "idle" | "running" | "stopping";
  running: number;
  previews: number;
  processes: TaskRuntimeProcessSnapshot[];
}

const controllers = new Map<string, TaskRuntimeProcessController>();
const stoppingTasks = new Set<string>();

export function registerTaskRuntimeProcess(input: Omit<TaskRuntimeProcessController, "role"> & { role?: TaskRuntimeProcessRole }): void {
  controllers.set(input.id, { ...input, role: input.role || "process" });
}

export function setTaskRuntimeProcessRole(taskId: string, processId: string, role: TaskRuntimeProcessRole): boolean {
  const controller = controllers.get(processId);
  if (!controller || controller.taskId !== taskId) return false;
  controller.role = role;
  return true;
}

export function forgetTaskRuntimeProcess(taskId: string, processId: string): boolean {
  const controller = controllers.get(processId);
  if (!controller || controller.taskId !== taskId) return false;
  return controllers.delete(processId);
}

export function getTaskRuntime(taskId: string): TaskRuntimeSnapshot {
  const processes = [...controllers.values()]
    .filter(item => item.taskId === taskId)
    .map(item => ({
      taskId: item.taskId,
      id: item.id,
      ...(item.pid === undefined ? {} : { pid: item.pid }),
      command: item.command,
      cwd: item.cwd,
      startedAt: item.startedAt,
      role: item.role,
      running: item.isRunning(),
    }));
  const running = processes.filter(item => item.running);
  return {
    taskId,
    status: stoppingTasks.has(taskId) ? "stopping" : running.length ? "running" : "idle",
    running: running.length,
    previews: running.filter(item => item.role === "preview").length,
    processes,
  };
}

export async function stopTaskRuntimeProcesses(taskId: string, force = true): Promise<{
  stopped: string[];
  remaining: string[];
  errors: Array<{ id: string; error: string }>;
}> {
  const targets = [...controllers.values()].filter(item => item.taskId === taskId && item.isRunning());
  if (!targets.length) return { stopped: [], remaining: [], errors: [] };
  stoppingTasks.add(taskId);
  const stopped: string[] = [];
  const errors: Array<{ id: string; error: string }> = [];
  try {
    for (const item of targets) {
      try {
        await item.stop(force);
        if (!item.isRunning()) stopped.push(item.id);
      } catch (error) {
        errors.push({ id: item.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
  } finally {
    stoppingTasks.delete(taskId);
  }
  const remaining = targets.filter(item => item.isRunning()).map(item => item.id);
  return { stopped, remaining, errors };
}