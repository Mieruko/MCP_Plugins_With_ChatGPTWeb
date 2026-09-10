import { runPostEditHooks } from "./post-edit-hooks.js";
import { executionContext } from "./workbench-context.js";

export async function enrichAfterEdit<T extends Record<string, unknown>>(
  data: T,
  filePaths: string[],
  dryRun?: boolean
): Promise<T> {
  if (dryRun || !filePaths.length) return data;
  // Hooks are arbitrary code, not part of a file-edit approval.
  if (executionContext.getStore()) return { ...data, hooks_skipped: "Run project checks as a separate approved command" };
  const hooks = await runPostEditHooks(filePaths);
  if (!hooks) return data;
  return { ...data, ...hooks };
}
