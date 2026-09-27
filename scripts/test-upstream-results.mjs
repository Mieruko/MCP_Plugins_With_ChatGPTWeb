import assert from 'node:assert/strict';
import { toolResult } from '../dist/lib/tool-result.js';
import { upstreamToolResult, UPSTREAM_RESULT_LIMITS } from '../dist/lib/upstream-result.js';
import { OperationMediaCache } from '../dist/lib/operation-media.js';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const image = { type: 'image', data: png, mimeType: 'image/png', annotations: { audience: ['assistant'] } };
const text = { type: 'text', text: 'Ảnh thử nghiệm' };
const identity = { server_id: 'fixture', tool: 'observe' };
const raw = { content: [text, image], structuredContent: { state: 'ready' } };
let passed = 0;
function test(name, run) { run(); passed++; console.log(`OK ${name}`); }

test('existing text envelope stays compatible', () => {
  const result = toolResult('old', { value: 42 });
  assert.deepEqual(result.content, [{ type: 'text', text: JSON.stringify(result.structuredContent, null, 2) }]);
  assert.equal(result.isError, undefined);
});
test('mixed structured, text and image results survive without binary in summary', () => {
  for (const key of ['output', 'result']) {
    const result = upstreamToolResult('observe', raw, identity, key);
    assert.equal(result.isError, false);
    assert.deepEqual(result.content.slice(1), raw.content);
    assert.deepEqual(result.structuredContent.data[key], { state: 'ready' });
    assert.ok(!result.content[0].text.includes(png));
    assert.ok(!JSON.stringify(result.structuredContent).includes(png));
    assert.equal(result.structuredContent.data.content[1].data_omitted, true);
    assert.equal(raw.content[1].data, png, 'input is not mutated');
  }
});
test('image-only, text-only, primitive and structured-only outputs remain usable', () => {
  assert.deepEqual(upstreamToolResult('x', { content: [image] }, {}).content[1], image);
  assert.equal(upstreamToolResult('x', { content: [text] }, {}).structuredContent.data.output, text.text);
  assert.equal(upstreamToolResult('x', 3, {}).structuredContent.data.output, 3);
  assert.deepEqual(upstreamToolResult('x', { structuredContent: { a: 1 } }, {}).structuredContent.data.output, { a: 1 });
});
test('upstream errors preserve native content and both error signals', () => {
  const result = upstreamToolResult('x', { ...raw, isError: true }, {});
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.ok, false);
  assert.deepEqual(result.content.slice(1), raw.content);
  assert.equal(upstreamToolResult('x', { isError: true, content: [] }, {}).structuredContent.summary, 'Upstream tool failed');
});
test('typed binary copies in structured content are omitted from JSON', () => {
  const resource = { type: 'resource', resource: { uri: 'fixture://media', mimeType: 'application/octet-stream', blob: png } };
  const result = upstreamToolResult('x', { content: [image, resource], structuredContent: { nested: [image, resource] } }, {});
  assert.ok(!JSON.stringify(result.structuredContent).includes(png));
  assert.deepEqual(result.content.slice(1), [image, resource]);
});
test('oversized and malformed observations fail explicitly, never silently truncate', () => {
  const samples = [
    { content: 'invalid' }, { content: [{ ...image, data: 'bad' }] }, { content: [{ type: 'image' }] },
    { content: Array(UPSTREAM_RESULT_LIMITS.images + 1).fill(image) },
    { content: Array(UPSTREAM_RESULT_LIMITS.blocks + 1).fill(text) },
    { content: [{ type: 'text', text: 'x'.repeat(UPSTREAM_RESULT_LIMITS.textBytes + 1) }] },
    { content: [{ ...image, data: 'A'.repeat(UPSTREAM_RESULT_LIMITS.wireBytes + 4) }] },
  ];
  for (const value of samples) {
    const result = upstreamToolResult('x', value, {});
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.data.error, 'UPSTREAM_RESULT_INVALID');
    assert.equal(result.structuredContent.data.action_may_have_completed, true);
    assert.equal(result.content.length, 1);
  }
  const large = { ...image, data: Buffer.alloc(1024 * 1024, 19).toString('base64') };
  assert.deepEqual(upstreamToolResult('x', { content: [large] }, {}).content[1], large, 'large base64 does not overflow validation stack');
});
test('operation media is bounded, isolated by task, cloned and expires', () => {
  let now = 1000;
  const size = Buffer.byteLength(JSON.stringify([image]));
  const cache = new OperationMediaCache(size, 100, () => now);
  const result = upstreamToolResult('x', raw, {});
  const stored = cache.store('task-a', 'op1', result);
  assert.ok(!JSON.stringify(stored).includes(png));
  assert.equal(stored.media.storage, 'memory_only');
  assert.deepEqual(cache.read('task-a', 'op1'), [image]);
  assert.deepEqual(cache.read('task-b', 'op1'), []);
  const copy = cache.read('task-a', 'op1'); copy[0].data = 'changed';
  assert.equal(cache.read('task-a', 'op1')[0].data, png);
  cache.store('task-a', 'op2', result);
  assert.deepEqual(cache.read('task-a', 'op1'), [], 'oldest evicted at byte limit');
  now = 1100;
  assert.deepEqual(cache.read('task-a', 'op2'), []);
  assert.deepEqual(new OperationMediaCache().read('task-a', 'op2'), [], 'restart has no stale observations');
  const tiny = new OperationMediaCache(1);
  assert.ok(!JSON.stringify(tiny.store('task-a', 'big', result)).includes(png));
  assert.deepEqual(tiny.read('task-a', 'big'), []);
  const entryLimit = new OperationMediaCache(100000, 1000, () => now, 1);
  entryLimit.store('a', '1', result); entryLimit.store('a', '2', result);
  assert.deepEqual(entryLimit.read('a', '1'), []);
  assert.deepEqual(entryLimit.read('a', '2'), [image]);
});
console.log(`${passed} upstream result checks passed`);
