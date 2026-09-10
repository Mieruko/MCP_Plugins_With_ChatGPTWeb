import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { childEnvironment } from "./workbench-context.js";

// Read-only fingerprint: prevents approval of one index/HEAD from committing or
// pushing a different revision after another client changes the repository.
export async function gitApprovalFingerprint(cwd: string, branch?: string): Promise<string> {
  const commands = [
    ["rev-parse", "HEAD"], ["symbolic-ref", "-q", "HEAD"],
    ["status", "--porcelain=v1", "-z", "--untracked-files=no"],
    ["diff", "--no-ext-diff", "--no-textconv", "--binary"],
    ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--binary"],
    ["config", "--local", "--list"],
    ...(branch ? [["rev-parse", `refs/heads/${branch}`]] : []),
  ];
  const hash = createHash("sha256");
  for (const args of commands) {
    const result = await new Promise<Buffer>((resolve, reject) => {
      const child = spawn("git", ["--no-pager", "-c", "core.fsmonitor=false", ...args], {
        cwd, windowsHide: true, env: { ...childEnvironment(), GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      });
      const chunks: Buffer[] = [];
      let size = 0;
      const timer = setTimeout(() => { child.kill(); reject(new Error("Git approval snapshot timed out")); }, 10000);
      const capture = (d: Buffer) => {
        size += d.length;
        if (size > 4 * 1024 * 1024) { child.kill(); reject(new Error("Git diff exceeds approval budget; split the change")); }
        else chunks.push(d);
      };
      child.stdout.on("data", capture); child.stderr.on("data", capture);
      child.once("error", e => { clearTimeout(timer); reject(e); });
      child.once("close", code => { clearTimeout(timer); resolve(Buffer.concat([Buffer.from(`${code}:`), ...chunks])); });
    });
    hash.update(JSON.stringify(args)).update(result);
  }
  return hash.digest("hex");
}
