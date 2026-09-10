import fs from "fs";
import path from "path";
import os from "os";
import { executionContext } from "./workbench-context.js";

let defaultCwd = process.cwd();

export function setDefaultCwd(cwd: string): void {
  defaultCwd = path.resolve(cwd);
}

export function getDefaultCwd(): string {
  return executionContext.getStore()?.workspace || defaultCwd;
}

/** @deprecated use getDefaultCwd — kept for compatibility */
export function setAllowedRoots(roots: string[]): void {
  if (roots.length > 0) setDefaultCwd(roots[0]);
}

/** Returns default working directory, not an access boundary */
export function getAllowedRoots(): string[] {
  return [getDefaultCwd()];
}

export function setFullDiskAccess(_enabled: boolean): void {}

export function getFullDiskAccess(): boolean {
  return executionContext.getStore() ? !executionContext.getStore()!.workspaceOnly : false;
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function canonical(target: string): Promise<string> {
  try { return await fs.promises.realpath(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = path.dirname(target);
    if (parent === target) throw error;
    return path.join(await canonical(parent), path.basename(target));
  }
}

export async function validatePath(inputPath: string): Promise<string> {
  const trimmed = inputPath.trim();
  if (!trimmed) throw new Error("Path is empty");

  const resolved = path.resolve(getDefaultCwd(), trimmed);
  const context = executionContext.getStore();
  if (!context) return resolved;
  const target = await canonical(resolved);
  const controlRoot = await canonical(path.resolve(process.env.WORKBENCH_PATH || path.join(os.homedir(), ".chatgpt-local-coder", "workbench")));
  if (inside(controlRoot, target)) throw new Error("Access denied: workbench control state is not a tool-accessible path");
  if (context.workspaceOnly) {
    const root = await canonical(context.workspace);
    if (!inside(root, target)) throw new Error("Access denied: path is outside this task's workspace");
    // Windows alternate streams / device paths are not ordinary project files.
    if (process.platform === "win32" && (resolved.slice(2).includes(":") || /(^|[\\/])(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(resolved))) throw new Error("Access denied: special Windows path");
    try { const stat = await fs.promises.stat(resolved); if (stat.isFile() && stat.nlink > 1) throw new Error("Access denied: hard-linked file"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return target;
}

export function getMachineRoots(): string[] {
  if (process.platform === "win32") {
    const drives: string[] = [];
    for (let code = 65; code <= 90; code++) {
      const letter = String.fromCharCode(code);
      try {
        fs.accessSync(`${letter}:\\`, fs.constants.R_OK);
        drives.push(`${letter}:\\`);
      } catch {}
    }
    return drives.length ? drives : ["C:\\"];
  }
  return ["/", os.homedir()];
}
