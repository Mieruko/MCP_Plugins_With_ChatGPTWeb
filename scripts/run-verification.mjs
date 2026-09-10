import { spawn } from "node:child_process";
import path from "path";
import { fileURLToPath } from "url";

const scratch = "C:/Users/Dao Nguyen Hoang/AppData/Local/Temp/grok-goal-41c5f05971ba/implementer";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const child = spawn(process.execPath, [path.join(root, "scripts/capture-verification-evidence.mjs")], {
  cwd: root,
  env: { ...process.env, GOAL_SCRATCH: scratch },
  stdio: "inherit",
});

child.on("exit", (code) => process.exit(code ?? 1));