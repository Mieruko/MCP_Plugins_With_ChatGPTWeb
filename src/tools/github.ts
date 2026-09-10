import { spawn } from "node:child_process";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { validatePath, getDefaultCwd } from "../lib/path-security.js";
import { requireUnrestrictedExecution, childEnvironment } from "../lib/workbench-context.js";
import { toolResult } from "../lib/tool-result.js";

export const githubSchema = z.object({
  action: z.enum(["pr_list", "pr_view", "pr_checks", "pr_create_draft", "pr_merge", "issue_list", "issue_view"]),
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "Use owner/repository"),
  number: z.number().int().positive().optional(),
  title: z.string().min(1).max(256).optional(), body: z.string().max(60000).optional(),
  base: z.string().regex(/^[\w][\w./-]*$/).optional(), head: z.string().regex(/^[\w][\w./:-]*$/).optional(),
  expected_head: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  merge_method: z.enum(["squash", "merge", "rebase"]).default("squash"),
  path: z.string().optional(),
});

export function githubArguments(input: z.infer<typeof githubSchema>): string[] {
  const { action, repo, number } = input;
  const target = ["--repo", repo];
  if (action === "pr_list") return ["pr", "list", ...target, "--json", "number,title,state,headRefName,baseRefName,url,isDraft", "--limit", "30"];
  if (action === "issue_list") return ["issue", "list", ...target, "--json", "number,title,state,url", "--limit", "30"];
  if (action === "pr_create_draft") {
    if (!input.title || input.body === undefined || !input.base || !input.head?.includes(":")) throw new Error("title, body, base and explicit owner:remote-branch head are required; push separately first");
    return ["pr", "create", ...target, "--draft", "--title", input.title, "--body", input.body, "--base", input.base, "--head", input.head];
  }
  if (!number) throw new Error("PR or issue number is required");
  if (action === "pr_view") return ["pr", "view", String(number), ...target, "--json", "number,title,body,url,state,headRefOid,headRefName,baseRefName,reviewDecision,statusCheckRollup,files"];
  if (action === "pr_checks") return ["pr", "checks", String(number), ...target, "--json", "name,state,link,bucket"];
  if (action === "issue_view") return ["issue", "view", String(number), ...target, "--json", "number,title,body,state,url,comments"];
  if (!input.expected_head) throw new Error("expected_head is required so a different PR revision cannot be merged after review");
  return ["pr", "merge", String(number), ...target, `--${input.merge_method}`, "--match-head-commit", input.expected_head];
}
export async function executeGithub(raw: unknown, workspace: string) {
  requireUnrestrictedExecution();
  const input = githubSchema.parse(raw);
  const args = githubArguments(input);
  const cwd = await validatePath(input.path || getDefaultCwd());
  const result = await new Promise<{ stdout: string; stderr: string; exit_code: number }>((resolve, reject) => {
    const child = spawn("gh", args, { cwd, windowsHide: true, env: { ...childEnvironment(), GH_PROMPT_DISABLED: "1", GH_PAGER: "cat", NO_COLOR: "1" } });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("GitHub request timed out; check remote state before retrying a write")); }, 60_000);
    child.stdout.on("data", d => { stdout = (stdout + d).slice(-200000); });
    child.stderr.on("data", d => { stderr = (stderr + d).slice(-200000); });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => { clearTimeout(timer); resolve({ stdout, stderr, exit_code: code ?? 1 }); });
  });
  return toolResult("github", result, { ok: result.exit_code === 0 });
}
export function registerGithubTools(server: McpServer, workspace: string): void {
  server.registerTool("github", { title: "GitHub PRs and issues", description: "Read issues/PRs/checks, create an explicit draft PR, or merge a reviewed SHA. Requires local gh authentication. Creating a PR does not implicitly authorize pushing code.",
    inputSchema: githubSchema.shape, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } }, args => executeGithub(args, workspace));
}
