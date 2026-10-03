'use strict';
/**
 * CLAIM-LEDGER W6, gate G6.6: a GENERATED memory.md (a view rendered from the claims ledger, first
 * line = GENERATED_MEMORY_MARKER) is never touched by the 1.1.83 janitors:
 *   - the rollover (rolloverMemory) leaves it byte for byte, however large, and reports generated;
 *   - the pinned-section seed (seedPinnedSection) leaves it byte for byte;
 *   - the Haiku condense (reflect.ts) never runs on it, not even on demand, and never calls the model.
 * And an ordinary memory.md is still handled as before (the skip keys on the marker only).
 * The marker is an HTML comment, so the import's split never turns it into a claim.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const ROOT = path.join(__dirname, '..');
const G = loadTs(path.join(ROOT, 'src', 'main', 'claims', 'generated.ts'));
const R = loadTs(path.join(ROOT, 'src', 'main', 'memoryRollover.ts'));
const M = loadTs(path.join(ROOT, 'src', 'main', 'claims', 'migrate.ts'));
const { MemoryReflector } = loadTs(path.join(ROOT, 'src', 'main', 'reflect.ts'));

function generatedView(bytes) {
  const lines = [G.GENERATED_MEMORY_MARKER, '# Memory: andy', '', '## How I work (standing lessons)', '- a lesson [c:c1]', '', '## Working set'];
  let i = 0;
  while (lines.join('\n').length < bytes) lines.push(`- 2026-10-0${1 + (i % 3)} fact ${i++} ${'v'.repeat(70)} [c:c${i + 1}]`);
  return lines.join('\n') + '\n';
}

test('marker: recognised with or without a BOM; ordinary text is not', () => {
  assert.ok(G.isGeneratedMemory(G.GENERATED_MEMORY_MARKER + '\n# x'));
  assert.ok(G.isGeneratedMemory('﻿' + G.GENERATED_MEMORY_MARKER + '\r\n# x'));
  assert.ok(!G.isGeneratedMemory('# Memory\n' + G.GENERATED_MEMORY_MARKER));
  assert.ok(G.GENERATED_MEMORY_MARKER.startsWith(G.GENERATED_MEMORY_PREFIX));
});

test('G6.6 rollover: a generated memory.md far over the limit is left byte for byte, and no archive appears', () => {
  for (const eol of ['\n', '\r\n']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-gen-'));
    const text = generatedView(R.MEMORY_ROLLOVER_BYTES * 3).replace(/\n/g, eol);
    fs.writeFileSync(path.join(dir, 'memory.md'), text);
    const r = R.rolloverMemory(dir, Date.parse('2026-10-03T12:00:00Z'));
    assert.equal(r.rotated, false);
    assert.equal(r.generated, true);
    assert.equal(fs.readFileSync(path.join(dir, 'memory.md'), 'utf8'), text);
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith('memory-archive')), []);
  }
});

test('G6.6 rollover: an ordinary memory.md over the limit still rolls (the skip keys on the marker only)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-gen-'));
  const text = generatedView(R.MEMORY_ROLLOVER_BYTES * 3).split('\n').slice(1).join('\n');   // no marker
  fs.writeFileSync(path.join(dir, 'memory.md'), text);
  const r = R.rolloverMemory(dir, Date.parse('2026-10-03T12:00:00Z'));
  assert.equal(r.rotated, true);
  assert.ok(!r.generated);
});

test('G6.6 seed: nothing is seeded into a generated memory.md, even one with no pinned heading', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-gen-'));
  const text = `${G.GENERATED_MEMORY_MARKER}\n# Memory: x\n\n## Working set\n- a fact [c:c1]\n`;
  fs.writeFileSync(path.join(dir, 'memory.md'), text);
  const r = R.seedPinnedSection(dir);
  assert.equal(r.seeded, false);
  assert.equal(r.generated, true);
  assert.equal(fs.readFileSync(path.join(dir, 'memory.md'), 'utf8'), text);
});

test('G6.6 condense: the reflector skips a generated memory.md, on demand too, and never calls the model', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-gen-'));
  const dir = path.join(home, 'hive', 'agents', 'andy');
  fs.mkdirSync(dir, { recursive: true });
  const text = generatedView(200 * 1024);
  fs.writeFileSync(path.join(dir, 'memory.md'), text);
  let calls = 0;
  const reflector = new MemoryReflector(
    () => home, () => 'claude', () => ({}),
    () => ({ enabled: true, intervalMs: 60_000, byteTriggerPct: 1, sectionTrigger: 1, recentKeep: 5, minBytes: 1 }),
    () => {}, async () => { calls++; return { ok: false }; }
  );
  assert.deepEqual(await reflector.reflectNow('andy'), []);
  assert.deepEqual(await reflector.reflectNow(), []);
  assert.equal(calls, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'memory.md'), 'utf8'), text);
});

test('the marker never becomes a claim: the import split skips it as a comment', () => {
  const { entries } = M.splitEntries(`${G.GENERATED_MEMORY_MARKER}\n# Memory: x\n\n- a fact\n`, 'memory.md');
  assert.deepEqual(entries.map((e) => e.text), ['- a fact']);
});
