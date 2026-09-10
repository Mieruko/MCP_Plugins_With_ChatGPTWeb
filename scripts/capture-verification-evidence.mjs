import fs from "fs/promises";
import path from "path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const scratch = process.env.GOAL_SCRATCH || path.join(root, ".tool-test-tmp", "verification");

async function runCommand(cmd, args, logName) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd: root, shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (out += d.toString()));
    proc.on("exit", async (code) => {
      await fs.writeFile(path.join(scratch, logName), out, "utf-8");
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} ${args.join(" ")} exit ${code}`));
    });
  });
}

async function waitFor(url, timeoutMs = 20000) {
  const start = Date.now();
  let lastErr = "unknown";
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      const text = await res.text();
      if (res.ok) return text ? JSON.parse(text) : {};
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timeout ${url} (${lastErr})`);
}

async function captureBoot(label, mcpPort, adminPort) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, "dist/index.js")], {
      cwd: root,
      env: { ...process.env, PORT: String(mcpPort), ADMIN_PORT: String(adminPort), WORKSPACE_PATH: root },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", (d) => (log += d.toString()));
    child.stderr.on("data", (d) => (log += d.toString()));

    (async () => {
      try {
        await waitFor(`http://127.0.0.1:${mcpPort}/health`);
        const adminHealth = await waitFor(`http://127.0.0.1:${adminPort}/health`);
        if (adminHealth.status !== "ok") throw new Error(`admin health not ok: ${JSON.stringify(adminHealth)}`);
        if (!Array.isArray(adminHealth.upstream)) throw new Error("admin health missing upstream array");

        const enriched =
          log +
          `\n[CAPTURED_ADMIN_HEALTH] ${JSON.stringify(adminHealth)}\n` +
          `[CAPTURED_MCP_HEALTH] ${JSON.stringify(await waitFor(`http://127.0.0.1:${mcpPort}/health`))}\n`;

        await fs.writeFile(path.join(scratch, `server-boot-${label}.log`), enriched, "utf-8");
        if (label === "1") {
          await fs.writeFile(path.join(scratch, "admin-health.json"), JSON.stringify(adminHealth, null, 2));
        }
        child.kill("SIGTERM");
        resolve(adminHealth);
      } catch (err) {
        child.kill("SIGTERM");
        reject(err);
      }
    })();
  });
}

await fs.mkdir(scratch, { recursive: true });

console.log("Running npm test (pass 1)...");
await runCommand("npm", ["test"], "npm-test-1.log");
console.log("Running npm test (pass 2)...");
await runCommand("npm", ["test"], "npm-test-2.log");

const mcpPort = 4500 + Math.floor(Math.random() * 100);
const adminPort = mcpPort + 1;

console.log(`Capturing boot evidence mcp=${mcpPort} admin=${adminPort}...`);
await captureBoot("1", mcpPort, adminPort);
await new Promise((r) => setTimeout(r, 800));
await captureBoot("2", mcpPort, adminPort);

console.log("Running bridge integration...");
await new Promise((resolve, reject) => {
  const proc = spawn(process.execPath, [path.join(root, "scripts/test-mcp-bridge-integration.mjs")], {
    cwd: root,
    env: { ...process.env, GOAL_SCRATCH: scratch },
    stdio: "inherit",
  });
  proc.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`integration exit ${code}`))));
});

console.log(`Evidence written to ${scratch}`);