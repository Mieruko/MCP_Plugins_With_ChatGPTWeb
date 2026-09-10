export type ToolProfileName = "full" | "slim";

/** Core tools for ChatGPT web — smaller tools/list payload, fewer discovery errors. */
export const SLIM_CHATGPT_TOOLS = new Set([
  "workbench",
  "github",
  "git_branch",
  "git_log",
  "git_push",
  "git_pull",
  "git_unstage",
  "git_fetch",
  "git_worktree",
  "inspect_code",
  "read_text_file",
  "write_file",
  "edit_file",
  "multi_edit",
  "apply_patch",
  "glob",
  "grep",
  "list_directory",
  "run_command",
  "shell_status",
  "start_process",
  "process_output",
  "stop_process",
  "git_status",
  "git_diff",
  "git_add",
  "git_commit",
  "git_restore",
  "agent_status",
  "project_context",
  "remember",
  "load_path_rules",
  "rewind",
  "mcp_servers",
]);

export function getChatGptToolProfile(): ToolProfileName {
  const raw = (process.env.CHATGPT_TOOL_PROFILE || "slim").trim().toLowerCase();
  return raw === "full" ? "full" : "slim";
}

export function shouldExposeTool(name: string, profile: ToolProfileName = getChatGptToolProfile()): boolean {
  if (profile === "full") return true;
  return SLIM_CHATGPT_TOOLS.has(name);
}
