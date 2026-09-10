import { applyUnifiedPatchToText } from "../dist/lib/patch.js";

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`OK  ${name}`);
    passed++;
  } catch (err) {
    console.error(`FAIL ${name}: ${err.message}`);
    failed++;
  }
}

test("codex-style patch without line numbers", () => {
  const original = "def fib(n):\n    if n <= 1:\n        return n\n    return fib(n-1) + fib(n-2)\n";
  const patch = "@@\n-def fib(n):\n+def fibonacci(n):\n     if n <= 1:\n";
  const result = applyUnifiedPatchToText(original, patch);
  if (!result.includes("def fibonacci(n):")) throw new Error("rename not applied");
  if (result.includes("def fib(n):")) throw new Error("old name still present");
});

test("unified diff with line numbers", () => {
  const original = "line1\nline2\nline3\nline4\n";
  const patch = "@@ -2,2 +2,3 @@\n line2\n-old\n+new\n+extra\n line4\n";
  const result = applyUnifiedPatchToText(original, patch);
  if (!result.includes("new")) throw new Error("replacement missing");
  if (result.includes("old")) throw new Error("old line still present");
});

test("crlf preserved", () => {
  const original = "a\r\nb\r\nc\r\n";
  const patch = "@@\n-b\r\n+c2\r\n";
  const result = applyUnifiedPatchToText(original, patch);
  if (!result.includes("c2\r\n")) throw new Error("crlf patch failed");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);