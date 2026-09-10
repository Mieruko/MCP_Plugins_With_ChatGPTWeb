import { executionContext } from "./workbench-context.js";
/** Authorization is enforced by the workbench dispatcher before a tool handler runs. */

export type PermissionProfile = "open" | "workspace";

export function getPermissionProfile(): PermissionProfile {
  return executionContext.getStore()?.workspaceOnly ? "workspace" : "open";
}

export function isReadOnly(): boolean {
  return false;
}

export function canWriteFiles(): boolean {
  return true;
}

export function canRunCommands(): boolean {
  return true;
}

export function canUseAnyAbsolutePath(): boolean {
  return !executionContext.getStore()?.workspaceOnly;
}

export function shouldBlockCommand(_command: string): boolean {
  return !canRunCommands();
}

export function describePermissionProfile(): string {
  return executionContext.getStore()?.workspaceOnly ? "workspace-only: file tools bounded; process tools require the configured OS sandbox" : "Task policy controls approvals and machine access; inspect workbench status";
}

export function requireWriteAllowed(): void {}

export function requireCommandAllowed(_command: string): void {}
