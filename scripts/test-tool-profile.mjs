/**
 * Verify slim tool profile exposes expected tools only.
 */
import { SLIM_CHATGPT_TOOLS, shouldExposeTool } from "../dist/lib/tool-profile.js";
import { registerComputerTools } from "../dist/tools/computer-use.js";

const ALL_KNOWN = [
  "read_text_file", "write_file", "apply_patch", "glob", "grep", "run_command",
  "git_status", "mcp_call", "delete_directory", "read_file_base64",
];

let passed = 0;
let failed = 0;
function ok(m) { console.log(`OK  ${m}`); passed++; }
function fail(m, e) { console.error(`FAIL ${m}: ${e}`); failed++; }

try {
  if (SLIM_CHATGPT_TOOLS.size < 18) throw new Error(`slim set too small: ${SLIM_CHATGPT_TOOLS.size}`);
  ok(`slim profile has ${SLIM_CHATGPT_TOOLS.size} tools`);

  for (const t of ["apply_patch", "glob", "remember", "load_path_rules", "inspect_code", "stop_process", "task_handoff", "workbench_control"]) {
    if (!shouldExposeTool(t, "slim")) throw new Error(`${t} missing from slim`);
  }
  ok("core tools exposed in slim");

  if (shouldExposeTool("mcp_call", "slim")) throw new Error("mcp_call should be hidden in slim");
  if (shouldExposeTool("delete_directory", "slim")) throw new Error("delete_directory hidden");
  ok("heavy tools hidden in slim");

  if (!shouldExposeTool("mcp_call", "full")) throw new Error("full should expose all");
  ok("full profile exposes all");
  const before = process.env.COMPUTER_USE_ENABLED;
  try {
    delete process.env.COMPUTER_USE_ENABLED;
    const names = [];
    registerComputerTools({ registerTool: name => names.push(name) });
    if (names.length || shouldExposeTool('computer_session', 'slim')) throw new Error('CU must be off by default');
    process.env.COMPUTER_USE_ENABLED = 'true';
    registerComputerTools({ registerTool: name => names.push(name) });
    if (names.length !== 5 || !names.every(name => shouldExposeTool(name, 'slim'))) throw new Error('enabled CU discovery mismatch');
    ok('CU opt-in registration and slim discovery');
  } finally {
    if (before === undefined) delete process.env.COMPUTER_USE_ENABLED;
    else process.env.COMPUTER_USE_ENABLED = before;
  }
} catch (e) {
  fail("tool profile", e.message || e);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
