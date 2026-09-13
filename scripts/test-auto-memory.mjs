import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadAutoMemory, formatAutoMemoryForInstructions } from '../dist/lib/auto-memory.js';
import { executionContext } from '../dist/lib/workbench-context.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'auto-memory-test-'));
const root = path.join(tmp, 'project');
await fs.mkdir(root, { recursive: true });
const memoryFile = path.join(root, '.local-coder', 'MEMORY.md');

const boundary = { taskId: 'memory-test', sessionId: 'memory-session', workspace: root, workspaceOnly: true,
  operationId: 'memory-test', capture: async () => {} };
const load = () => executionContext.run(boundary, () => loadAutoMemory(root));
const write = async content => {
  await fs.mkdir(path.dirname(memoryFile), { recursive: true });
  await fs.writeFile(memoryFile, content, 'utf8');
};
const formatted = async () => formatAutoMemoryForInstructions(await load());

try {
  await fs.rm(memoryFile, { force: true });
  assert.equal(await load(), null);
  await write('');
  assert.equal(await load(), null);
  console.log('OK empty and missing memory');

  process.env.AUTO_MEMORY_MAX_LINES = '40';
  process.env.AUTO_MEMORY_MAX_BYTES = '25000';
  const many = '# Auto memory (cross-session notes)\n\n' + Array.from({ length: 260 }, (_, i) =>
    `- 2026-09-${String((i % 28) + 1).padStart(2, '0')}: NOTE_${String(i).padStart(3, '0')}`).join('\n') + '\n';
  await write(many);
  const before = await fs.readFile(memoryFile, 'utf8');
  const recent = await formatted();
  assert.match(recent, /NOTE_259/);
  assert.doesNotMatch(recent, /NOTE_000/);
  assert.match(recent, /Older auto-memory notes omitted/);
  assert.ok(recent.split('\n').length <= 40);
  assert.equal(await fs.readFile(memoryFile, 'utf8'), before);
  console.log('OK newest notes win after 200+ lines without changing disk history');

  process.env.AUTO_MEMORY_MAX_LINES = '24';
  process.env.AUTO_MEMORY_MAX_BYTES = '900';
  const unicode = '# Auto memory (cross-session notes)\n\n' +
    Array.from({ length: 20 }, (_, i) => `- 2026-09-12: cũ ${i} — tiếng Việt 🚀 `.repeat(8)).join('\n') +
    '\n- 2026-09-13: MỚI_NHẤT tiếng Việt 🚀\ndòng hai nguyên vẹn ✅\ndòng ba nguyên vẹn 🌏\n';
  await write(unicode);
  const unicodeOut = await formatted();
  assert.ok(Buffer.byteLength(unicodeOut, 'utf8') <= 900, Buffer.byteLength(unicodeOut, 'utf8'));
  assert.ok(unicodeOut.split('\n').length <= 24);
  assert.match(unicodeOut, /MỚI_NHẤT tiếng Việt 🚀/);
  assert.match(unicodeOut, /dòng hai nguyên vẹn ✅/);
  assert.match(unicodeOut, /dòng ba nguyên vẹn 🌏/);
  assert.doesNotMatch(unicodeOut, /�/);
  console.log('OK byte/line budget keeps recent multiline Vietnamese and emoji intact');

  process.env.AUTO_MEMORY_MAX_LINES = '12';
  process.env.AUTO_MEMORY_MAX_BYTES = '520';
  await write('# Auto memory (cross-session notes)\n\n- 2026-09-13: ' + 'ghi chú rất dài 🚀 '.repeat(200) + '\n');
  const longOut = await formatted();
  assert.ok(Buffer.byteLength(longOut, 'utf8') <= 520);
  assert.ok(longOut.split('\n').length <= 12);
  assert.match(longOut, /Newest auto-memory note truncated/);
  assert.doesNotMatch(longOut, /�/);
  console.log('OK one oversized note is safely truncated at a UTF-8 boundary');

  process.env.AUTO_MEMORY_MAX_LINES = '8';
  process.env.AUTO_MEMORY_MAX_BYTES = '520';
  await write(['old free-form memory', 'legacy second line', 'legacy third line', 'LEGACY_NEWEST tiếng Việt 🧠'].join('\n'));
  const legacyOut = await formatted();
  assert.match(legacyOut, /Legacy auto-memory format detected/);
  assert.match(legacyOut, /LEGACY_NEWEST tiếng Việt 🧠/);
  assert.doesNotMatch(legacyOut, /�/);
  console.log('OK legacy format falls back to a marked newest tail');

  process.env.AUTO_MEMORY_MAX_LINES = '-3';
  process.env.AUTO_MEMORY_MAX_BYTES = 'not-a-number';
  await write('# Auto memory (cross-session notes)\n\n- 2026-09-13: INVALID_CONFIG_FALLBACK\n');
  assert.match(await formatted(), /INVALID_CONFIG_FALLBACK/);
  console.log('OK invalid memory limits fall back to defaults');
} finally {
  delete process.env.AUTO_MEMORY_MAX_LINES;
  delete process.env.AUTO_MEMORY_MAX_BYTES;
  await fs.rm(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}