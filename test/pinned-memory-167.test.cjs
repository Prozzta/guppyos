'use strict';
/**
 * PINNED-MEMORY (57f3cc): an agent's `## How I work (standing lessons)` section holds its METHOD
 * lessons. 1.1.65's rollover archived them with the dated notes, and protocol line 1 no longer
 * read them (Phyllis: 30 citations before, 0 after). The section is lifted out before the cut,
 * kept at the top, never archived, seeded at spawn, named in protocol line 1, and printed
 * verbatim by `memory wake-up`.
 *
 * HOME IS REDIRECTED AND ASSERTED before any hive is built.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const M = loadTs('src/main/memoryRollover.ts');

function tmp(t, prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

const HEAD = '# Memory — Phyllis (phyllis-x)\n\n_Append durable facts, decisions, and context below._\n';
const PIN = '## How I work (standing lessons)\n1. Cite only URLs you fetched and opened.\n2. Commit only under the repo identity.\n\n';
function notes(n, from = 0, per = 900, tag = 'fact') {
  let s = '';
  for (let i = from; i < from + n; i++) s += `\n## 2026-09-${String(1 + (i % 28)).padStart(2, '0')} note ${i}\n- ${'x'.repeat(per)} ${tag}-${i}\n`;
  return s;
}
const read = (f) => fs.readFileSync(f, 'utf8');
const archives = (dir) => fs.readdirSync(dir).filter((n) => n.startsWith('memory-archive-')).map((n) => read(path.join(dir, n))).join('');
const NOW = new Date(2026, 8, 28, 12, 0, 0).getTime();

// ── split and rollover ──────────────────────────────────────────────────────────────────

test('the pinned section survives repeated rollovers: verbatim, at the top (under the header, above the pointer), never archived', (t) => {
  const dir = tmp(t, 'pin167-');
  const file = path.join(dir, 'memory.md');
  fs.writeFileSync(file, HEAD + '\n' + PIN + notes(60).slice(1));
  for (let round = 0; round < 4; round++) {
    const r = M.rolloverMemory(dir, NOW + round * 1000);
    assert.equal(r.rotated, true, `round ${round}`);
    assert.equal(r.pinnedBytes, Buffer.byteLength(PIN));
    const kept = read(file);
    assert.ok(kept.startsWith(HEAD + '\n' + PIN + '_Older notes are archived in '), `round ${round}: header, pinned, pointer:\n${kept.slice(0, 400)}`);
    assert.equal(kept.split('## How I work (standing lessons)').length - 1, 1, 'one heading');
    assert.equal(kept.split('_Older notes are archived in').length - 1, 1, 'one pointer');
    fs.appendFileSync(file, notes(40, 100 + round * 40, 900, `r${round}`));
  }
  const arch = archives(dir);
  assert.doesNotMatch(arch, /How I work|Cite only URLs|repo identity/, 'the lessons never reach the archive');
  assert.match(arch, /fact-0\n/);
});

test('a section in the middle of the file (Phyllis: right after the pointer) moves to the top at the next rollover', (t) => {
  const dir = tmp(t, 'pin167-');
  const file = path.join(dir, 'memory.md');
  const text = HEAD + '\n_Older notes are archived in memory-archive-2026-09-27.md (and earlier memory-archive-*.md files); `memory search` finds them._\n\n' + notes(20).slice(1) + '\n' + PIN + notes(40, 20).slice(1);
  fs.writeFileSync(file, text);
  const r = M.rolloverMemory(dir, NOW);
  assert.equal(r.rotated, true);
  const kept = read(file);
  assert.ok(kept.startsWith(HEAD + '\n' + PIN + '_Older notes are archived in memory-archive-2026-09-28.md'), kept.slice(0, 400));
  assert.doesNotMatch(archives(dir), /Cite only URLs/);
  // Also mid-file with no pointer at all, and at EOF.
  const sp = M.splitMemory(HEAD + notes(5) + '\n' + PIN + notes(5, 5).slice(1));
  assert.equal(sp.pinned, PIN);
  const eof = M.splitMemory(HEAD + notes(5) + '\n' + PIN.trimEnd());
  assert.equal(eof.pinned, PIN.trimEnd());
});

test('duplicate sections are merged in order (every lesson line kept, the heading once)', () => {
  const a = '## How I work (standing lessons)\n1. alpha\n\n';
  const b = '## How I work (standing lessons)\n2. beta\n3. gamma\n\n';
  const sp = M.splitMemory(HEAD + '\n' + a + notes(3).slice(1) + '\n' + b + notes(3, 3).slice(1));
  assert.equal(sp.pinned, '## How I work (standing lessons)\n1. alpha\n\n2. beta\n3. gamma\n\n');
  assert.doesNotMatch(sp.older + sp.tail, /alpha|beta|gamma|How I work/);
});

test('reassembly: header + older + tail == the input without the pinned lines, byte for byte; pinned == those lines in order', () => {
  const pinA = '## How I work (standing lessons)\n1. a lesson ✓ with UTF-8\n### sub-heading stays inside\n- detail\n\n';
  const pinB = '## How I work (standing lessons)\n2. later lesson\n';
  const parts = [HEAD, notes(15), '\n', pinA, notes(20, 15).slice(1), '\n', pinB, notes(30, 35).slice(1)];
  const text = parts.join('');
  for (const keep of [M.MEMORY_KEEP_TAIL_BYTES, 4000, 1e9]) {
    const sp = M.splitMemory(text, keep);
    const without = text.replace(pinA, '').replace(pinB, '');
    assert.equal(sp.header + sp.older + sp.tail, without, `keep ${keep}`);
    assert.equal(sp.pinned, pinA + pinB.replace('## How I work (standing lessons)\n', ''));
  }
});

test('the 12 KB tail budget excludes the pinned section (a large section does not shrink the kept notes)', () => {
  const bigPin = '## How I work (standing lessons)\n' + ('- ' + 'L'.repeat(98) + '\n').repeat(50) + '\n'; // ~5 KB
  const body = notes(60);
  const withPin = M.splitMemory(HEAD + '\n' + bigPin + body.slice(1));
  const without = M.splitMemory(HEAD + body);
  assert.equal(withPin.tail, without.tail, 'the same tail with and without the section');
  assert.equal(withPin.older, without.older.replace(/^\n/, ''), 'the same older text (the pinned lines lifted)');
  assert.ok(Buffer.byteLength(withPin.tail) >= M.MEMORY_KEEP_TAIL_BYTES);
});

test('a section over 6 KB is not truncated (pinnedBytes reported); over 24 KB the rollover leaves memory.md untouched with a flag', (t) => {
  const dir = tmp(t, 'pin167-');
  const file = path.join(dir, 'memory.md');
  const over6 = '## How I work (standing lessons)\n' + ('- ' + 'm'.repeat(98) + '\n').repeat(80) + '\n'; // ~8 KB
  fs.writeFileSync(file, HEAD + '\n' + over6 + notes(60).slice(1));
  const r = M.rolloverMemory(dir, NOW);
  assert.equal(r.rotated, true);
  assert.ok(r.pinnedBytes > M.PINNED_SOFT_CAP_BYTES && !r.pinnedTooLarge);
  assert.ok(read(file).includes(over6), 'the whole section is kept');

  const dir2 = tmp(t, 'pin167-');
  const file2 = path.join(dir2, 'memory.md');
  const over24 = '## How I work (standing lessons)\n' + ('- ' + 'h'.repeat(98) + '\n').repeat(260) + '\n'; // ~26 KB
  const text = HEAD + '\n' + over24 + notes(60).slice(1);
  fs.writeFileSync(file2, text);
  const r2 = M.rolloverMemory(dir2, NOW);
  assert.equal(r2.rotated, false);
  assert.equal(r2.pinnedTooLarge, true);
  assert.ok(r2.pinnedBytes > M.PINNED_HARD_CAP_BYTES);
  assert.equal(read(file2), text, 'memory.md untouched');
  assert.deepEqual(fs.readdirSync(dir2), ['memory.md'], 'no archive');
});

test('pinnedOverCapDue: true once per agent per day (recorded in the agent dir), again the next day', (t) => {
  const dir = tmp(t, 'pin167-');
  assert.equal(M.pinnedOverCapDue(dir, NOW), true);
  assert.equal(M.pinnedOverCapDue(dir, NOW + 3600e3), false);
  assert.equal(read(path.join(dir, M.PINNED_OVER_CAP_DAY_FILE)).trim(), '2026-09-28');
  assert.equal(M.pinnedOverCapDue(dir, NOW + 86400e3), true);
});

test('CRLF: the section survives a rollover in a CRLF file, which stays CRLF', (t) => {
  const dir = tmp(t, 'pin167-');
  const file = path.join(dir, 'memory.md');
  fs.writeFileSync(file, (HEAD + '\n' + PIN + notes(60).slice(1)).replace(/\n/g, '\r\n'));
  const r = M.rolloverMemory(dir, NOW);
  assert.equal(r.rotated, true);
  const kept = read(file);
  assert.equal(/[^\r]\n/.test(kept), false);
  assert.ok(kept.startsWith((HEAD + '\n' + PIN).replace(/\n/g, '\r\n') + '_Older notes'));
  assert.equal(M.pinnedSection(kept), PIN);
  assert.doesNotMatch(archives(dir), /Cite only URLs/);
});

// ── the seed (migration) ────────────────────────────────────────────────────────────────

test('seed: an empty section goes under the generated header (before the notes); idempotent', (t) => {
  const dir = tmp(t, 'pin167-');
  const file = path.join(dir, 'memory.md');
  fs.writeFileSync(file, HEAD + notes(3));
  const r = M.seedPinnedSection(dir);
  assert.equal(r.seeded, true);
  const once = read(file);
  assert.equal(once, HEAD + '\n' + M.PINNED_SEED + notes(3));
  assert.match(M.PINNED_SEED, /^## How I work \(standing lessons\)\n_Your method lessons \(how you work\); kept at the top, never archived\._\n$/);
  assert.equal(M.seedPinnedSection(dir).seeded, false);
  assert.equal(read(file), once, 'a second seed changes nothing');
  assert.equal(M.splitMemory(once).pinned, M.PINNED_SEED + '\n');
});

test('seed: before the pointer line; an existing heading anywhere is adopted (no second one); CRLF kept', (t) => {
  const dir = tmp(t, 'pin167-');
  const file = path.join(dir, 'memory.md');
  const pointer = '_Older notes are archived in memory-archive-2026-09-27.md (and earlier memory-archive-*.md files); `memory search` finds them._\n';
  fs.writeFileSync(file, (HEAD + '\n' + pointer + notes(2)).replace(/\n/g, '\r\n'));
  assert.equal(M.seedPinnedSection(dir).seeded, true);
  assert.equal(read(file), (HEAD + '\n' + M.PINNED_SEED + '\n' + pointer + notes(2)).replace(/\n/g, '\r\n'));

  const dir2 = tmp(t, 'pin167-');
  const phyllis = HEAD + '\n' + pointer + '\n' + PIN + notes(2).slice(1);
  fs.writeFileSync(path.join(dir2, 'memory.md'), phyllis);
  const r = M.seedPinnedSection(dir2);
  assert.equal(r.seeded, false);
  assert.equal(r.pinnedBytes, Buffer.byteLength(PIN));
  assert.equal(read(path.join(dir2, 'memory.md')), phyllis, 'adopted as-is');
});

test('seed: notes that do not start with a heading get a `## Notes` heading, so they are not read as lessons', (t) => {
  const dir = tmp(t, 'pin167-');
  const file = path.join(dir, 'memory.md');
  fs.writeFileSync(file, HEAD + '- loose fact\n');
  M.seedPinnedSection(dir);
  assert.equal(read(file), HEAD + '\n' + M.PINNED_SEED + '\n## Notes\n- loose fact\n');
  assert.equal(M.pinnedSection(read(file)), M.PINNED_SEED + '\n');
});

test('seed: an append racing the seed aborts it (memory.md keeps the append, no tmp left)', (t) => {
  const dir = tmp(t, 'pin167-');
  const file = path.join(dir, 'memory.md');
  fs.writeFileSync(file, HEAD + notes(2));
  M.rolloverTestHooks.beforeSeedReplace = (f) => fs.appendFileSync(f, '- LATE\n');
  t.after(() => { M.rolloverTestHooks.beforeSeedReplace = undefined; });
  const r = M.seedPinnedSection(dir);
  assert.equal(r.raced, true);
  assert.equal(read(file), HEAD + notes(2) + '- LATE\n');
  assert.deepEqual(fs.readdirSync(dir), ['memory.md']);
});
