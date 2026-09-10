import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import {
  checkpointBefore,
  clearCheckpoints,
  listCheckpoints,
  previewRestore,
  restoreToCheckpoint,
} from "../dist/lib/checkpoint.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const tmpDir = path.join(root, ".tool-test-tmp", "checkpoints");
const storeDir = path.join(tmpDir, "store");

process.env.CHECKPOINT_PATH = storeDir;
process.env.CHECKPOINT_ENABLED = "true";
process.env.CHECKPOINT_MAX_COUNT = "50";

let passed = 0;
let failed = 0;

function ok(name) {
  console.log(`OK  ${name}`);
  passed++;
}

function fail(name, err) {
  console.error(`FAIL ${name}: ${err.message || err}`);
  failed++;
}

async function run(name, fn) {
  try {
    await fn();
    ok(name);
  } catch (err) {
    fail(name, err);
  }
}

await fs.rm(tmpDir, { recursive: true, force: true });
await fs.mkdir(tmpDir, { recursive: true });
await clearCheckpoints();

await run("captures checkpoint before edit", async () => {
  const file = path.join(tmpDir, "alpha.txt");
  await fs.writeFile(file, "v1\n");
  const id = await checkpointBefore("write_file", [file]);
  if (!id) throw new Error("checkpoint id missing");
  await fs.writeFile(file, "v2\n");
  const text = await fs.readFile(file, "utf-8");
  if (text !== "v2\n") throw new Error("edit failed");
});

await run("lists checkpoints newest first", async () => {
  const list = await listCheckpoints(10);
  if (list.length < 1) throw new Error("expected checkpoints");
  if (!list[0].id.startsWith("cp_")) throw new Error(`bad id ${list[0].id}`);
});

await run("preview restore shows planned changes", async () => {
  const list = await listCheckpoints(1);
  const plan = await previewRestore(list[0].id);
  if (!plan.changes.some((c) => c.action === "restore")) throw new Error("no restore action");
});

await run("restore reverts file content", async () => {
  const file = path.join(tmpDir, "alpha.txt");
  const list = await listCheckpoints(1);
  const targetId = list[0].id;
  const result = await restoreToCheckpoint(targetId);
  const text = await fs.readFile(file, "utf-8");
  if (text !== "v1\n") throw new Error(`expected v1, got ${JSON.stringify(text)}`);
  if (!result.restored.includes(file)) throw new Error("file not in restored list");
});

await run("removes checkpoints at and after restore point", async () => {
  const list = await listCheckpoints(10);
  if (list.length !== 0) throw new Error(`expected 0 checkpoints after restore, got ${list.length}`);
});

await run("restores deleted file", async () => {
  const file = path.join(tmpDir, "gone.txt");
  await fs.writeFile(file, "keep-me\n");
  const id = await checkpointBefore("delete_file", [file]);
  await fs.unlink(file);
  let missing = false;
  try {
    await fs.access(file);
  } catch {
    missing = true;
  }
  if (!missing) throw new Error("file should be deleted");
  await restoreToCheckpoint(id);
  const text = await fs.readFile(file, "utf-8");
  if (text !== "keep-me\n") throw new Error(text);
});

await run("restores move by snapshotting source and destination", async () => {
  const src = path.join(tmpDir, "src.txt");
  const dest = path.join(tmpDir, "dest.txt");
  await fs.writeFile(src, "from-src\n");
  await fs.writeFile(dest, "old-dest\n");
  const id = await checkpointBefore("move_file", [src, dest]);
  await fs.rename(src, dest);
  await restoreToCheckpoint(id);
  const srcText = await fs.readFile(src, "utf-8");
  const destText = await fs.readFile(dest, "utf-8");
  if (srcText !== "from-src\n") throw new Error(`src: ${srcText}`);
  if (destText !== "old-dest\n") throw new Error(`dest: ${destText}`);
});

await fs.rm(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);