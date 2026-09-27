'use strict';
/**
 * CODEX-BLOAT-165 fix 3: protocol line 1 no longer tells every agent (Claude, Codex, AGY - the
 * same injectedPrompt feeds all of them) to read memory.md whole at every task start, and the
 * app caps memory.md by rolling its older part into memory-archive-<date>.md at spawn.
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
const { discoverSources } = loadTs('src/main/nativeMemory/sources.ts');

function tmp(t, prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

const HEAD = '# Memory — Dwight (dwight-x)\n\n_Append durable facts, decisions, and context below._\n';
function bigMemory(sections, perSection = 900) {
  let s = HEAD;
  for (let i = 0; i < sections; i++) s += `\n## 2026-09-${String(1 + (i % 28)).padStart(2, '0')} note ${i}\n- ${'x'.repeat(perSection)} fact-${i}\n`;
  return s;
}

// ── the rollover (pure-ish, temp dirs only) ──────────────────────────────────────────────

test('constants: roll over above 32 KB, keep ~12 KB, archive files stay under the indexer 2 MB cap', () => {
  assert.equal(M.MEMORY_ROLLOVER_BYTES, 32 * 1024);
  assert.equal(M.MEMORY_KEEP_TAIL_BYTES, 12 * 1024);
  assert.ok(M.MEMORY_ARCHIVE_MAX_BYTES < 2 * 1024 * 1024);
});

test('a memory.md at or under the cap is left alone', (t) => {
  const dir = tmp(t, 'cb165-mem-');
  fs.writeFileSync(path.join(dir, 'memory.md'), bigMemory(10));
  const before = fs.readFileSync(path.join(dir, 'memory.md'), 'utf8');
  assert.equal(M.rolloverMemory(dir).rotated, false);
  assert.equal(fs.readFileSync(path.join(dir, 'memory.md'), 'utf8'), before);
  assert.deepEqual(fs.readdirSync(dir), ['memory.md']);
});

test('above the cap: header + pointer + newest ~12 KB stay, the older text moves to memory-archive-<date>.md, nothing is lost', (t) => {
  const dir = tmp(t, 'cb165-mem-');
  const text = bigMemory(90); // ~86 KB, Dwight-sized
  fs.writeFileSync(path.join(dir, 'memory.md'), text);
  const now = new Date(2026, 8, 27, 18, 0, 0).getTime();
  const r = M.rolloverMemory(dir, now);
  assert.equal(r.rotated, true);
  assert.equal(path.basename(r.archive), 'memory-archive-2026-09-27.md');
  const kept = fs.readFileSync(path.join(dir, 'memory.md'), 'utf8');
  const arch = fs.readFileSync(r.archive, 'utf8');
  assert.ok(kept.startsWith(HEAD), 'the generated header stays');
  assert.match(kept, /_Older notes are archived in memory-archive-2026-09-27\.md/);
  assert.ok(Buffer.byteLength(kept) < 16 * 1024 && Buffer.byteLength(kept) > 11 * 1024, `kept ${Buffer.byteLength(kept)}`);
  assert.match(kept, /fact-89\n$/, 'the newest note is kept');
  assert.match(kept.split(/\n(?=## )/)[1] ?? '', /^## /, 'the cut is at a section heading');
  for (let i = 0; i < 90; i++) assert.ok(kept.includes(`fact-${i}\n`) !== arch.includes(`fact-${i}\n`), `fact-${i} is in exactly one file`);
  assert.equal(r.bytesAfter, Buffer.byteLength(kept));
});

test('a second rollover appends to the same day archive and keeps ONE pointer line', (t) => {
  const dir = tmp(t, 'cb165-mem-');
  const now = new Date(2026, 8, 27, 18, 0, 0).getTime();
  fs.writeFileSync(path.join(dir, 'memory.md'), bigMemory(60));
  M.rolloverMemory(dir, now);
  fs.appendFileSync(path.join(dir, 'memory.md'), bigMemory(60).slice(HEAD.length).replace(/fact-/g, 'later-'));
  const r = M.rolloverMemory(dir, now + 1000);
  assert.equal(r.rotated, true);
  const kept = fs.readFileSync(path.join(dir, 'memory.md'), 'utf8');
  assert.equal(kept.split('_Older notes are archived in').length - 1, 1, 'one pointer');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['memory-archive-2026-09-27.md', 'memory.md']);
  assert.match(fs.readFileSync(r.archive, 'utf8'), /later-0\n/);
});

test('CRLF memory files stay CRLF', (t) => {
  const dir = tmp(t, 'cb165-mem-');
  fs.writeFileSync(path.join(dir, 'memory.md'), bigMemory(60).replace(/\n/g, '\r\n'));
  const r = M.rolloverMemory(dir);
  const kept = fs.readFileSync(path.join(dir, 'memory.md'), 'utf8');
  assert.equal(/[^\r]\n/.test(kept), false);
  assert.equal(/[^\r]\n/.test(fs.readFileSync(r.archive, 'utf8')), false);
});

// ── CB-165 audit F1-F3 ──────────────────────────────────────────────────────────────────

test('F1: a long newest section never leaves memory.md nearly empty (the cut is at the LAST heading at or before the mark)', (t) => {
  // Jim's case: many small old sections, then one ~11 KB section just inside the 12 KB mark,
  // then small ones. Cutting at the first heading AFTER the mark kept only ~1.8 KB.
  let text = HEAD;
  for (let i = 0; i < 40; i++) text += `\n## old ${i}\n- ${'o'.repeat(900)} fact-${i}\n`;
  text += `\n## big\n${('- ' + 'b'.repeat(98) + '\n').repeat(110)}`; // ~11 KB, no headings inside
  text += `\n## last\n- the newest fact\n`;
  const sp = M.splitMemory(text);
  const keptBytes = Buffer.byteLength(sp.tail);
  assert.ok(keptBytes >= M.MEMORY_KEEP_TAIL_BYTES, `kept ${keptBytes} >= 12 KB`);
  assert.ok(keptBytes <= M.MEMORY_KEEP_TAIL_BYTES * M.MEMORY_KEEP_MAX_FACTOR, `kept ${keptBytes} <= 24 KB`);
  assert.match(sp.tail, /^## /, 'the cut is at a section heading');
  assert.equal(sp.header + sp.older + sp.tail, text, 'nothing lost');
});

test('F1: with no heading in range, the cut falls back to a line break and still keeps >= 12 KB', () => {
  const body = ('- ' + 'z'.repeat(98) + '\n').repeat(400); // ~40 KB, no headings at all
  const text = HEAD + body;
  const sp = M.splitMemory(text);
  const keptBytes = Buffer.byteLength(sp.tail);
  assert.ok(keptBytes >= M.MEMORY_KEEP_TAIL_BYTES && keptBytes < M.MEMORY_KEEP_TAIL_BYTES + 200, `kept ${keptBytes}`);
  assert.ok(sp.older.endsWith('\n'), 'the cut is at a line start');
  assert.equal(sp.header + sp.older + sp.tail, text);
});

test('F1: a heading further back than 2 x 12 KB is not used (line-break fallback instead)', () => {
  const text = HEAD + '- lead line\n\n## only\n' + ('- ' + 'q'.repeat(98) + '\n').repeat(400);
  assert.ok(M.splitMemory(text, 1e9).tail.includes('\n## only'), 'the heading is matchable (preceded by a line break)');
  const sp = M.splitMemory(text);
  const keptBytes = Buffer.byteLength(sp.tail);
  assert.ok(keptBytes <= M.MEMORY_KEEP_TAIL_BYTES * M.MEMORY_KEEP_MAX_FACTOR, `kept ${keptBytes}`);
  assert.doesNotMatch(sp.tail, /## only/);
});

test('nit 1: a heading between 24 KB and the 12 KB mark is NOT used: the cut is a line break near 12 KB', () => {
  // ~30 KB before the heading, ~20 KB after it: the heading sits ~20 KB from the end, inside
  // 2 x 12 KB, so it is used; move it to ~30 KB from the end and it must not be.
  const filler = (n, c) => ('- ' + c.repeat(98) + '\n').repeat(n);
  const inRange = M.splitMemory(HEAD + filler(300, 'a') + '\n## mid\n' + filler(200, 'b'));
  assert.match(inRange.tail, /^## mid/, 'a heading ~20 KB from the end is used');
  const outOfRange = M.splitMemory(HEAD + filler(300, 'a') + '\n## mid\n' + filler(300, 'b'));
  assert.doesNotMatch(outOfRange.tail, /## mid/, 'a heading ~30 KB from the end is not used');
  const kept = Buffer.byteLength(outOfRange.tail);
  assert.ok(kept >= M.MEMORY_KEEP_TAIL_BYTES && kept < M.MEMORY_KEEP_TAIL_BYTES + 200, `kept ${kept}`);
});

test('nit 2: emoji-heavy text still keeps at least 12 KB (bytes, not UTF-16 units)', () => {
  const line = '- ' + '\u{1F600}'.repeat(24) + ' fact\n'; // 4-byte chars, 2 UTF-16 units each
  const text = HEAD + ('\n## e\n' + line.repeat(5)).repeat(120);
  const sp = M.splitMemory(text);
  const kept = Buffer.byteLength(sp.tail);
  assert.ok(kept >= M.MEMORY_KEEP_TAIL_BYTES, `kept ${kept} >= 12 KB`);
  assert.ok(kept <= M.MEMORY_KEEP_TAIL_BYTES * M.MEMORY_KEEP_MAX_FACTOR);
  assert.equal(sp.header + sp.older + sp.tail, text, 'nothing lost, no broken characters');
  // No newline at all: the cut must not split a 4-byte character.
  const flat = M.splitMemory(HEAD + '\u{1F600}'.repeat(5000), 1001); // 1001: the mark falls mid-character
  assert.equal(flat.older + flat.tail, '\u{1F600}'.repeat(5000));
  assert.ok(!flat.tail.startsWith('\uDE00') && !flat.tail.includes('\uFFFD'));
});

test('F2: an append that races the rollover aborts the replace, so memory.md keeps it', (t) => {
  const dir = tmp(t, 'cb165-mem-');
  const file = path.join(dir, 'memory.md');
  fs.writeFileSync(file, bigMemory(90));
  M.rolloverTestHooks.beforeReplace = (f) => fs.appendFileSync(f, '\n## late\n- LATE-APPEND\n');
  t.after(() => { M.rolloverTestHooks.beforeReplace = undefined; });
  const r = M.rolloverMemory(dir);
  assert.equal(r.rotated, false);
  assert.equal(r.raced, true);
  const kept = fs.readFileSync(file, 'utf8');
  assert.match(kept, /LATE-APPEND/, 'the late append survives');
  assert.match(kept, /fact-0\n/, 'memory.md was not replaced');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), [], 'no tmp file left');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith('memory-archive-')), [], 'nit 3: the new archive was undone');
  M.rolloverTestHooks.beforeReplace = undefined;
  const r2 = M.rolloverMemory(dir);
  assert.equal(r2.rotated, true, 'the next rollover (next spawn) succeeds');
  const arch = fs.readFileSync(r2.archive, 'utf8');
  assert.equal(arch.split('<!-- rolled ').length - 1, 1, 'nit 3: one rolled block, not two');
  assert.equal(arch.split('fact-0\n').length - 1, 1, 'nit 3: fact-0 archived once');
});

test('nit 3: a raced abort restores an EXISTING archive to its previous size', (t) => {
  const dir = tmp(t, 'cb165-mem-');
  const now = new Date(2026, 8, 27, 18, 0, 0).getTime();
  const archive = path.join(dir, 'memory-archive-2026-09-27.md');
  fs.writeFileSync(archive, '# Memory archive - earlier\n\nold stuff\n');
  const before = fs.readFileSync(archive, 'utf8');
  fs.writeFileSync(path.join(dir, 'memory.md'), bigMemory(90));
  M.rolloverTestHooks.beforeReplace = (f) => fs.appendFileSync(f, '- late\n');
  t.after(() => { M.rolloverTestHooks.beforeReplace = undefined; });
  assert.equal(M.rolloverMemory(dir, now).raced, true);
  assert.equal(fs.readFileSync(archive, 'utf8'), before);
});

test('nit 2 (F2 mtime half): a same-size rewrite during the rollover is also caught', (t) => {
  const dir = tmp(t, 'cb165-mem-');
  const file = path.join(dir, 'memory.md');
  fs.writeFileSync(file, bigMemory(90));
  M.rolloverTestHooks.beforeReplace = (f) => {
    const st = fs.statSync(f);
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('fact-89', 'FACT-89')); // same size
    fs.utimesSync(f, st.atime, new Date(st.mtimeMs + 5000));
  };
  t.after(() => { M.rolloverTestHooks.beforeReplace = undefined; });
  const r = M.rolloverMemory(dir);
  assert.equal(r.raced, true);
  assert.match(fs.readFileSync(file, 'utf8'), /FACT-89/, 'the rewrite survives');
});

test('F3: a full day archive (~1 MB) makes the rollover start memory-archive-<date>-2.md', (t) => {
  const dir = tmp(t, 'cb165-mem-');
  const now = new Date(2026, 8, 27, 18, 0, 0).getTime();
  const first = path.join(dir, 'memory-archive-2026-09-27.md');
  fs.writeFileSync(first, 'x'.repeat(M.MEMORY_ARCHIVE_MAX_BYTES - 1000));
  fs.writeFileSync(path.join(dir, 'memory.md'), bigMemory(90));
  const r = M.rolloverMemory(dir, now);
  assert.equal(r.rotated, true);
  assert.equal(path.basename(r.archive), 'memory-archive-2026-09-27-2.md');
  assert.equal(fs.statSync(first).size, M.MEMORY_ARCHIVE_MAX_BYTES - 1000, 'the full archive is untouched');
  assert.equal(M.archivePathFor(dir, now, 10), first, 'a small add still fits the first file');
});

test('the archive is picked up by the memory indexer (a direct agents/<id>/*.md), so memory search still finds it', (t) => {
  const root = tmp(t, 'cb165-hive-');
  const dir = path.join(root, 'agents', 'dwight-x');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory.md'), bigMemory(90));
  const r = M.rolloverMemory(dir);
  const d = discoverSources(root, { topLevel: [], include: {} });
  const paths = d.eligible.map((e) => e.path);
  assert.ok(paths.includes('agents/dwight-x/memory.md'));
  assert.ok(paths.includes(`agents/dwight-x/${path.basename(r.archive)}`), JSON.stringify(paths));
});

// ── the protocol text and the spawn wiring (a real HiveManager, HOME redirected) ──────────

const { HiveManager } = loadTs('src/main/hive.ts');

function sandbox(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cb165-home-'));
  const realHome = process.env.HOME; const realProfile = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  t.after(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    if (realProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realProfile;
  });
  assert.equal(os.homedir(), home, 'HOME redirect failed - aborting before constructing any hive');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{"x":1}');
  const hive = new HiveManager(() => path.join(home, 'harness'));
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  return { home, hive };
}
const promptOf = (inj) => inj.args[inj.args.indexOf('--append-system-prompt') + 1];
const line1 = (p) => p.split('\n').find((l) => l.startsWith('1. '));

test('Claude + semantic memory: line 1 says memory wake-up / memory search, not "read memory.md", and still reads every inbox file', async (t) => {
  const s = sandbox(t);
  const inj = await s.hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: s.home }, { semanticMemory: true });
  const l1 = line1(promptOf(inj));
  assert.match(l1, /run `memory wake-up`/);
  assert.match(l1, /`memory search "<query>"`/);
  assert.match(l1, /do NOT read .*memory\.md whole/);
  assert.match(l1, /read EVERY file in .*inbox/);
  assert.doesNotMatch(l1, /At the START of a task, read [^ ]*memory\.md and/);
});

test('Claude without semantic memory: line 1 reads only the TAIL of memory.md (no memory command it cannot run)', async (t) => {
  const s = sandbox(t);
  const inj = await s.hive.ensureAgent({ id: 'jim-2', name: 'Jim', provider: 'claude', cwd: s.home }, { semanticMemory: false });
  const l1 = line1(promptOf(inj));
  assert.doesNotMatch(l1, /memory wake-up|memory search/);
  assert.match(l1, /LAST ~40 lines of .*memory\.md/);
  assert.match(l1, /EVERY file in .*inbox/);
});

test('Codex gets the same line 1 in its developer_instructions', async (t) => {
  const s = sandbox(t);
  const inj = await s.hive.ensureAgent({ id: 'dw-1', name: 'Dwight', provider: 'codex', cwd: s.home }, { semanticMemory: true });
  const cfg = require('toml').parse(fs.readFileSync(path.join(inj.env.CODEX_HOME, 'config.toml'), 'utf8'));
  assert.match(line1(cfg.developer_instructions), /run `memory wake-up`/);
});

test('ensureAgent rolls an oversized memory.md over at spawn, and PROTOCOL.md states the policy', async (t) => {
  const s = sandbox(t);
  const dir = path.join(s.home, 'harness', 'hive', 'agents', 'dw-2');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory.md'), bigMemory(90));
  await s.hive.ensureAgent({ id: 'dw-2', name: 'Dwight', provider: 'claude', cwd: s.home });
  assert.ok(fs.statSync(path.join(dir, 'memory.md')).size < 16 * 1024);
  assert.ok(fs.readdirSync(dir).some((f) => /^memory-archive-\d{4}-\d{2}-\d{2}\.md$/.test(f)));
  const proto = fs.readFileSync(path.join(s.home, 'harness', 'hive', 'PROTOCOL.md'), 'utf8');
  assert.match(proto, /never print it whole/);
  assert.match(proto, /memory-archive-<date>\.md/);
});

test('nit 4: a raced rollover at spawn is logged (memory-rollover-raced) and memory.md is kept', async (t) => {
  const s = sandbox(t);
  const dir = path.join(s.home, 'harness', 'hive', 'agents', 'dw-3');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory.md'), bigMemory(90));
  const rows = [];
  const realAppend = s.hive.appendLog.bind(s.hive);
  s.hive.appendLog = (row) => { rows.push(row); return realAppend(row); };
  M.rolloverTestHooks.beforeReplace = (f) => fs.appendFileSync(f, '- late\n');
  t.after(() => { M.rolloverTestHooks.beforeReplace = undefined; });
  await s.hive.ensureAgent({ id: 'dw-3', name: 'Dwight', provider: 'claude', cwd: s.home });
  const row = rows.find((r) => r.kind === 'memory-rollover-raced');
  assert.ok(row, 'a memory-rollover-raced row');
  assert.equal(row.agentId, 'dw-3');
  assert.ok(!rows.some((r) => r.kind === 'memory-rollover'), 'no rollover row');
  assert.match(fs.readFileSync(path.join(dir, 'memory.md'), 'utf8'), /- late\n$/);
});
