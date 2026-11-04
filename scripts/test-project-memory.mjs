/**
 * Test instruction context builder (Phase 1+2).
 * Run: node scripts/test-project-memory.mjs
 */
import {
  buildInstructionContext,
  summarizeInstructionContext,
} from "../dist/lib/instruction-context.js";
import { loadProjectMemory } from "../dist/lib/project-memory.js";
import { executionContext } from "../dist/lib/workbench-context.js";
import { validatePath } from "../dist/lib/path-security.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const workspaceRoot = process.env.WORKSPACE_PATH || process.cwd();
let passed = 0;
let failed = 0;

function ok(name) {
  console.log(`OK  ${name}`);
  passed++;
}
function fail(name, err) {
  console.error(`FAIL ${name}: ${err}`);
  failed++;
}

try {
  const ctx = await buildInstructionContext({
    workspaceRoot,
    workspaceRoots: [workspaceRoot],
    pid: process.pid,
    adminPort: 3001,
  });

  if (!ctx.instructionsText.includes("Agent workflow")) {
    throw new Error("missing agent prompt");
  }
  ok("agent prompt in instructions");

  if (!ctx.instructionsText.includes("## Environment")) {
    throw new Error("missing environment block");
  }
  ok("environment block");

  if (!ctx.instructionsText.includes("## Git")) {
    throw new Error("missing git block");
  }
  ok("git block");

  if (!ctx.instructionsText.includes("agent_status")) {
    throw new Error("missing footer quick pointers");
  }
  ok("footer pointers (agent_status not duplicated in body)");

  if (ctx.instructionBytes < 500) {
    throw new Error(`instructions too small: ${ctx.instructionBytes}`);
  }
  ok(`instruction size ${Math.round(ctx.instructionBytes / 1024)}KB`);

  const summary = summarizeInstructionContext(ctx);
  if (!summary.root) throw new Error("summary missing root");
  ok("summarizeInstructionContext");

  console.log("\nGit:", ctx.git.is_repo ? ctx.git.branch : "not a repo");
  console.log("Memory files:", ctx.projectMemory.sections.map((s) => s.path).join(", ") || "(none)");
} catch (err) {
  fail("buildInstructionContext", err.message || err);
}

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "local-coder-global-memory-"));
try {
  const workspace = path.join(fixture, "workspace");
  const homeConfig = path.join(fixture, "global-instructions");
  await fs.mkdir(workspace);
  await fs.mkdir(homeConfig);
  const userFile = path.join(homeConfig, "CLAUDE.md");
  await fs.writeFile(userFile, "global instruction loaded\n@./extra.md\n");
  await fs.writeFile(path.join(homeConfig, "extra.md"), "imported user instructions loaded\n");
  await fs.writeFile(path.join(fixture, "private.txt"), "not allowed through project imports\n");
  await fs.writeFile(path.join(workspace, "CLAUDE.md"), "project instructions\n@../private.txt\n");

  await executionContext.run({
    taskId: "test", workspace, workspaceOnly: true,
    operationId: "test", capture: async () => {},
  }, async () => {
    await assert.rejects(validatePath(userFile), /outside this task's workspace/);
    const result = await loadProjectMemory(workspace, { userMemoryCandidates: [userFile] });
    assert.equal(result.sections[0].kind, "user");
    assert.match(result.sections[0].content, /global instruction loaded/);
    assert.match(result.sections[0].content, /imported user instructions loaded/);
    assert.match(result.sections[1].content, /project instructions/);
    assert.match(result.sections[1].content, /import failed/);
    assert.doesNotMatch(result.sections[1].content, /not allowed through project imports/);
  });
  ok("workspace-only initialization loads global instructions and imports without exposing external project files");
} catch (err) {
  fail("workspace-only global memory", err.message || err);
} finally {
  await fs.rm(fixture, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);