import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { globFiles } from "../dist/lib/glob-search.js";
import { grepSearch } from "../dist/lib/grep-search.js";
import { applyMultiFilePatch, applyUnifiedPatchToText, isMultiFilePatch } from "../dist/lib/patch.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const tmpDir = path.join(root, ".tool-test-tmp");

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

await fs.mkdir(tmpDir, { recursive: true });

await run("glob finds typescript files", async () => {
  const matches = await globFiles(root, "src/**/*.ts", 50);
  if (!matches.some((m) => m.path.endsWith("filesystem.ts"))) throw new Error("filesystem.ts not found");
});

await run("grep content mode", async () => {
  const out = await grepSearch({ pattern: "registerFilesystemTools", path: path.join(root, "src"), glob: "*.ts", headLimit: 10 });
  if (!out.includes("filesystem.ts")) throw new Error("pattern not found");
});

await run("grep files_with_matches mode", async () => {
  const out = await grepSearch({
    pattern: "createMcpServer",
    path: path.join(root, "src"),
    glob: "*.ts",
    outputMode: "files_with_matches",
    headLimit: 10,
  });
  if (!out.includes("server-factory")) throw new Error("file not listed");
});

await run("apply_patch codex style", async () => {
  const file = path.join(tmpDir, "sample.txt");
  await fs.writeFile(file, "hello\nworld\n");
  const next = applyUnifiedPatchToText("hello\nworld\n", "@@\n-hello\n+hi\n world\n");
  if (!next.includes("hi")) throw new Error("patch failed");
});

await run("read offset/limit simulation", async () => {
  const file = path.join(tmpDir, "lines.txt");
  await fs.writeFile(file, "a\nb\nc\nd\n");
  const lines = (await fs.readFile(file, "utf-8")).split("\n");
  const slice = lines.slice(1, 3);
  if (slice.join(",") !== "b,c") throw new Error(`unexpected ${slice}`);
});

await run("edit replace_all simulation", async () => {
  const file = path.join(tmpDir, "repeat.txt");
  await fs.writeFile(file, "foo bar foo");
  const content = await fs.readFile(file, "utf-8");
  const next = content.split("foo").join("baz");
  await fs.writeFile(file, next);
  const result = await fs.readFile(file, "utf-8");
  if (result !== "baz bar baz") throw new Error(result);
});

await run("multi-file patch detection", async () => {
  const patch = `*** Begin Patch
*** Update File: sample.txt
@@
-hello
+hi
*** End Patch`;
  if (!isMultiFilePatch(patch)) throw new Error("should detect multi-file patch");
});

await run("multi-file patch apply", async () => {
  const file = path.join(tmpDir, "multi.txt");
  await fs.writeFile(file, "alpha\nbeta\n");
  const patch = `*** Begin Patch
*** Update File: multi.txt
@@
-alpha
+gamma
 beta
*** End Patch`;
  const results = await applyMultiFilePatch(patch, { base_dir: tmpDir });
  if (results.length !== 1 || !results[0].ok) throw new Error(JSON.stringify(results));
  const text = await fs.readFile(file, "utf-8");
  if (!text.includes("gamma")) throw new Error(text);
});

await run("delete and move file", async () => {
  const src = path.join(tmpDir, "move-me.txt");
  const dest = path.join(tmpDir, "moved.txt");
  await fs.writeFile(src, "payload");
  await fs.rename(src, dest);
  const text = await fs.readFile(dest, "utf-8");
  if (text !== "payload") throw new Error("move failed");
  await fs.unlink(dest);
});

await fs.rm(tmpDir, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);