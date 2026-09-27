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
  // Jim PINNED F1: the seed states the rule (a ## heading ends the section).
  assert.match(M.PINNED_SEED, /^## How I work \(standing lessons\)\n_Your method lessons \(how you work\): bullets or ### subheadings only, a ## heading ends this section; kept at the top, never archived\._\n$/);
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

// ── `memory wake-up`: the L0.5 block ───────────────────────────────────────────────────

const F = loadTs('src/main/nativeMemory/format.ts');
const ENTRIES = [{ wing: 'x', room: 'memory', source: 'agents/x/memory.md', content: '## d\n- newest' }, { wing: 'x', room: 'audit', source: 'agents/x/AUDIT.md', content: 'y'.repeat(900) }];

test('wake-up: the section is printed verbatim as its own L0.5 block between IDENTITY and L1; L1 is unchanged', () => {
  const lessons = '1. Cite only URLs you fetched and opened.\n   - quote the page, with its link\n2. Commit only under the repo identity.';
  const withPin = F.formatWakeUp('You are X.', ENTRIES, `## How I work (standing lessons)\n${lessons}\n\n`);
  const without = F.formatWakeUp('You are X.', ENTRIES);
  assert.ok(withPin.includes(`## L0 — IDENTITY\nYou are X.\n\n## L0.5 — HOW I WORK (standing lessons)\n${lessons}\n\n## L1 — ESSENTIAL STORY\n`), withPin);
  const l1 = (t) => t.slice(t.indexOf('## L1'));
  assert.equal(l1(withPin), l1(without), 'the L1 part is identical');
  assert.equal(F.WAKE_MAX_CHARS, 3200, 'the L1 budget is unchanged');
  assert.doesNotMatch(F.formatWakeUp('You are X.', ENTRIES, M.PINNED_SEED.replace(/\n_.*_\n$/, '\n')), /L0\.5/, 'an empty section prints no block');
  assert.equal(F.formatWakeUp('You are X.', ENTRIES, ''), without);
});

test('wake-up: the block has its own 6 KB budget: the first 6 KB (at a line break) plus a "read the rest in memory.md" note', () => {
  const big = Array.from({ length: 100 }, (_, i) => `${i + 1}. ${'w'.repeat(95)}`).join('\n'); // ~10 KB
  const out = F.formatWakeUp('You are X.', ENTRIES, `## How I work (standing lessons)\n${big}\n`);
  const block = out.slice(out.indexOf('## L0.5'), out.indexOf('## L1'));
  const body = block.split('\n').slice(1).join('\n');
  assert.match(block, /… \(over 6 KB: read the rest in memory\.md\)\n\n$/);
  const shown = body.slice(0, body.indexOf('\n…'));
  assert.ok(big.startsWith(shown + '\n'), 'a verbatim prefix, cut at a line break');
  assert.ok(Buffer.byteLength(shown) <= F.WAKE_PINNED_MAX_BYTES && Buffer.byteLength(shown) > F.WAKE_PINNED_MAX_BYTES - 200);
  assert.match(out, /## L1 — ESSENTIAL STORY\n\n\[memory\]\n {2}- ## d - newest {2}\(memory\.md\)\n\n\[audit\]\n {2}- y{397}\.\.\. {2}\(AUDIT\.md\)\n$/, 'L1 still gets its full budget');
});

test('wake-up (engine): the caller wing\'s memory.md section is read from the file (CRLF too) and printed', async (t) => {
  const { MemoryEngine } = loadTs('src/main/nativeMemory/engine.ts');
  const root = tmp(t, 'pin167-wake-');
  fs.mkdirSync(path.join(root, 'agents', 'ph'), { recursive: true });
  fs.writeFileSync(path.join(root, 'agents', 'ph', 'identity.md'), 'You are Phyllis.');
  fs.writeFileSync(path.join(root, 'agents', 'ph', 'memory.md'), (HEAD + '\n' + PIN + notes(2).slice(1)).replace(/\n/g, '\r\n'));
  const store = { setMeta() {}, sourceShas: () => new Map(), removeSource() {}, planDiff: () => ({ keep: [], add: [], remove: [] }), applyDiff: () => true, wakeUp: () => ENTRIES, search: () => [] };
  const eng = new MemoryEngine({ hiveRoot: root, store, embedder: { loaded: true, embed: async (x) => x.map(() => new Float32Array(384)), unload: async () => {} },
    countTokens: (x) => x.split(/\s+/).length, mode: () => 'native', watch: null, setTimer: (fn, ms) => (ms === 0 ? setImmediate(fn) : { ms }), clearTimer: () => {} });
  const r = await eng.wakeUp('ph');
  assert.ok(r.text.includes('## L0.5 — HOW I WORK (standing lessons)\n1. Cite only URLs you fetched and opened.\n2. Commit only under the repo identity.\n\n## L1'), r.text);
  const none = await eng.wakeUp('nobody');
  assert.doesNotMatch(none.text, /L0\.5/);
});

test('memory status: a memory-pinned line per agent (lessons, bytes; no section / empty / over 6 KB flagged), and in the JSON', async (t) => {
  const { MemoryEngine } = loadTs('src/main/nativeMemory/engine.ts');
  const root = tmp(t, 'pin167-status-');
  const put = (id, text) => { fs.mkdirSync(path.join(root, 'agents', id), { recursive: true }); if (text !== null) fs.writeFileSync(path.join(root, 'agents', id, 'memory.md'), text); };
  put('ph', (HEAD + '\n' + PIN + notes(2).slice(1)).replace(/\n/g, '\r\n')); // 2 lessons, CRLF
  put('dw', HEAD + '\n' + M.PINNED_SEED + '\n## Notes\n- x\n');                // seeded, empty
  put('jm', HEAD + '\n- no section here\n');                                    // not migrated
  put('big', HEAD + '\n## How I work (standing lessons)\n' + ('- ' + 'l'.repeat(98) + '\n').repeat(70)); // ~7 KB
  put('nomem', null);                                                              // no memory.md: not listed
  const store = { setMeta() {}, sourceShas: () => new Map(), removeSource() {}, planDiff: () => ({ keep: [], add: [], remove: [] }), applyDiff: () => true, wakeUp: () => [], search: () => [],
    counts: () => ({ sources: 1, chunks: 2, vectors: 2, generation: 1 }), fileBytes: () => 1024, db: { prepare: () => ({ all: () => [] }) } };
  const eng = new MemoryEngine({ hiveRoot: root, store, embedder: { loaded: true, embed: async (x) => x.map(() => new Float32Array(384)), unload: async () => {} },
    countTokens: (x) => x.split(/\s+/).length, mode: () => 'native', watch: null, setTimer: (fn, ms) => (ms === 0 ? setImmediate(fn) : { ms }), clearTimer: () => {} });
  const r = await eng.status();
  assert.match(r.text, /memory-pinned \(## How I work \(standing lessons\)\):/);
  assert.match(r.text, /\n {2}ph: 2 lesson\(s\), \d+ B\n/);
  assert.match(r.text, /\n {2}dw: 0 lesson\(s\), \d+ B {2}\(empty: move your method lessons here\)\n/);
  assert.match(r.text, /\n {2}jm: no section\n/);
  assert.match(r.text, /\n {2}big: 70 lesson\(s\), \d+ B {2}\(over 6 KB: merge and shorten\)\n/);
  assert.doesNotMatch(r.text, /nomem/);
  const byAgent = Object.fromEntries(r.json.memoryPinned.map((p) => [p.agent, p]));
  assert.deepEqual({ present: byAgent.jm.present, lessons: byAgent.ph.lessons }, { present: false, lessons: 2 });
});

test('Jim F1: protocol line 2 and PROTOCOL.md state the rule (bullets or ### only; a ## heading ends the section)', () => {
  const hive = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'hive.ts'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(hive, /as bullets or \\`###\\` subheadings only \(a \\`##\\` heading ends that section and what follows it gets archived\)/);
  assert.match(hive, /lessons there as bullets or \\`###\\` subheadings, not dated facts \(a \\`##\\` heading ends the section;/);
});

test('Jim F2: a heading quoted inside a code fence is text: not lifted, and it does not end a section', () => {
  const body = [
    '## How I work (standing lessons)', '- lesson 1', '```', '## not a heading', '```', '- lesson 2', '',
    '## Notes', '```md', '## How I work (standing lessons)', '- quoted, not a lesson', '```', '- a note', ''
  ].join('\n');
  const { pinned, rest } = M.liftPinned(body);
  assert.match(pinned, /- lesson 1\n```\n## not a heading\n```\n- lesson 2\n/, 'a fenced ## inside the section does not end it');
  assert.doesNotMatch(pinned, /quoted, not a lesson/, 'a fenced copy of the heading is not lifted');
  assert.match(rest, /```md\n## How I work \(standing lessons\)\n- quoted, not a lesson\n```\n- a note/, 'the fence stays whole in the notes');
});

test('Jim F2: the seed treats a fenced copy of the heading as absent (it seeds a real one)', (t) => {
  const dir = tmp(t, 'pin167-fence-');
  fs.writeFileSync(path.join(dir, 'memory.md'), HEAD + '\n## Notes\n```\n## How I work (standing lessons)\n```\n');
  assert.equal(M.seedPinnedSection(dir).seeded, true);
});

test('Jim F3: an italic lesson counts; only the seed line does not', () => {
  const txt = HEAD + '\n' + M.PINNED_SEED + '- plain\n_an italic lesson_\n\n## Notes\n';
  assert.equal(M.pinnedStatus('a', txt).lessons, 2);
  assert.equal(M.pinnedStatus('b', HEAD + '\n' + M.PINNED_SEED + '\n## Notes\n').lessons, 0);
});

// ── the spawn wiring and the protocol text (a real HiveManager, HOME redirected) ────────

const { HiveManager } = loadTs('src/main/hive.ts');

function sandbox(t, { live = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pin167-home-'));
  const realHome = process.env.HOME; const realProfile = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  t.after(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    if (realProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realProfile;
  });
  assert.equal(os.homedir(), home, 'HOME redirect failed - aborting before constructing any hive');
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'auth.json'), '{"x":1}');
  const hiveHome = path.join(home, 'harness');
  const hive = live ? new HiveManager(() => hiveHome, undefined, {}, () => true) : new HiveManager(() => hiveHome);
  const rows = [];
  const realAppend = hive.appendLog.bind(hive);
  hive.appendLog = (row) => { rows.push(row); return realAppend(row); };
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  return { home, hive, rows, agentDir: (id) => path.join(hiveHome, 'hive', 'agents', id) };
}
const promptOf = (inj) => inj.args[inj.args.indexOf('--append-system-prompt') + 1];
const line = (p, n) => p.split('\n').find((l) => l.startsWith(`${n}. `));
const NAMES_SECTION = /read the `## How I work \(standing lessons\)` section at the top of .*memory\.md/;

test('protocol (Claude, semantic memory and not): line 1 first reads the section; the record steps put METHOD lessons there', async (t) => {
  const s = sandbox(t);
  for (const semanticMemory of [true, false]) {
    const inj = await s.hive.ensureAgent({ id: `jim-${semanticMemory}`, name: 'Jim', provider: 'claude', cwd: s.home }, { semanticMemory });
    const p = promptOf(inj);
    const l1 = line(p, 1);
    assert.match(l1, NAMES_SECTION);
    assert.ok(l1.indexOf('How I work') < l1.indexOf(semanticMemory ? 'memory wake-up' : 'LAST ~40 lines'), 'the section comes first');
    assert.match(line(p, 2), /METHOD lessons .* `## How I work \(standing lessons\)` section .*under ~6 KB.*merging and shortening/);
    assert.match(line(p, 4), /METHOD lessons in its `## How I work \(standing lessons\)` section, facts and decisions appended at the end/);
  }
  const proto = read(path.join(s.home, 'harness', 'hive', 'PROTOCOL.md'));
  assert.match(proto, /`## How I work \(standing lessons\)` section, at the top/);
  assert.match(proto, /under ~6 KB/);
  assert.match(proto, /never archived/);
});

test('protocol (Codex developer_instructions, AGY agent.md): the same line 1 names the section; Codex text is stable across spawns', async (t) => {
  const s = sandbox(t, { live: true });
  const inj = await s.hive.ensureAgent({ id: 'dw-1', name: 'Dwight', provider: 'codex', cwd: s.home }, { semanticMemory: true });
  const cfg = require('toml').parse(read(path.join(inj.env.CODEX_HOME, 'config.toml')));
  assert.match(line(cfg.developer_instructions, 1), NAMES_SECTION);
  // A section edit between spawns does not change developer_instructions (prompt-cache stable).
  fs.appendFileSync(path.join(s.agentDir('dw-1'), 'memory.md'), '\n' + PIN);
  const inj2 = await s.hive.ensureAgent({ id: 'dw-1', name: 'Dwight', provider: 'codex', cwd: s.home }, { semanticMemory: true });
  const cfg2 = require('toml').parse(read(path.join(inj2.env.CODEX_HOME, 'config.toml')));
  assert.equal(cfg2.developer_instructions, cfg.developer_instructions);
  assert.doesNotMatch(cfg2.developer_instructions, /Cite only URLs|_Your method lessons/, 'the section itself is not copied in');

  await s.hive.ensureAgent({ id: 'ph-1', name: 'Phyllis', provider: 'antigravity', cwd: s.home });
  const md = read(path.join(s.home, '.gemini', 'config', 'agents', 'munder-ph-1', 'agent.md'));
  assert.match(line(md, 1), NAMES_SECTION);
});

test('spawn: a new memory.md starts with the seeded section; an old one is seeded once (idempotent across spawns)', async (t) => {
  const s = sandbox(t);
  await s.hive.ensureAgent({ id: 'new-1', name: 'Nia', provider: 'claude', cwd: s.home });
  const fresh = read(path.join(s.agentDir('new-1'), 'memory.md'));
  assert.equal(fresh, '# Memory — Nia (new-1)\n\n_Append durable facts, decisions, and context below._\n\n' + M.PINNED_SEED);

  const dir = s.agentDir('old-1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory.md'), HEAD + notes(3));
  await s.hive.ensureAgent({ id: 'old-1', name: 'Olga', provider: 'claude', cwd: s.home });
  const once = read(path.join(dir, 'memory.md'));
  assert.equal(once, HEAD + '\n' + M.PINNED_SEED + notes(3));
  await s.hive.ensureAgent({ id: 'old-1', name: 'Olga', provider: 'claude', cwd: s.home });
  assert.equal(read(path.join(dir, 'memory.md')), once);
});

test('spawn: an existing heading (Phyllis, after the pointer) is adopted, then moved to the top by the rollover; never archived', async (t) => {
  const s = sandbox(t);
  const dir = s.agentDir('ph-2');
  fs.mkdirSync(dir, { recursive: true });
  const pointer = '_Older notes are archived in memory-archive-2026-09-27.md (and earlier memory-archive-*.md files); `memory search` finds them._\n';
  fs.writeFileSync(path.join(dir, 'memory.md'), HEAD + '\n' + pointer + '\n' + PIN + notes(60).slice(1));
  await s.hive.ensureAgent({ id: 'ph-2', name: 'Phyllis', provider: 'claude', cwd: s.home });
  const kept = read(path.join(dir, 'memory.md'));
  assert.equal(kept.split('## How I work (standing lessons)').length - 1, 1, 'no second heading');
  assert.ok(kept.startsWith(HEAD + '\n' + PIN + '_Older notes are archived in '), kept.slice(0, 300));
  assert.doesNotMatch(archives(dir), /Cite only URLs/);
  assert.ok(s.rows.some((r) => r.kind === 'memory-rollover' && r.agentId === 'ph-2'));
});

test('spawn: over 6 KB logs memory-pinned-over-cap once a day (record in the agent dir), nothing cut; over 24 KB logs memory-pinned-too-large, no rollover', async (t) => {
  const s = sandbox(t);
  const dir = s.agentDir('ov-1');
  fs.mkdirSync(dir, { recursive: true });
  const over6 = '## How I work (standing lessons)\n' + ('- ' + 'm'.repeat(98) + '\n').repeat(80) + '\n';
  fs.writeFileSync(path.join(dir, 'memory.md'), HEAD + '\n' + over6 + notes(3).slice(1));
  await s.hive.ensureAgent({ id: 'ov-1', name: 'Ovid', provider: 'claude', cwd: s.home });
  await s.hive.ensureAgent({ id: 'ov-1', name: 'Ovid', provider: 'claude', cwd: s.home });
  const cap = s.rows.filter((r) => r.kind === 'memory-pinned-over-cap');
  assert.equal(cap.length, 1, 'logged once');
  assert.equal(cap[0].agentId, 'ov-1');
  assert.equal(cap[0].pinnedBytes, Buffer.byteLength(over6));
  assert.ok(fs.existsSync(path.join(dir, M.PINNED_OVER_CAP_DAY_FILE)), 'the day record is in the agent dir');
  assert.ok(read(path.join(dir, 'memory.md')).includes(over6), 'not truncated');

  const dir2 = s.agentDir('ov-2');
  fs.mkdirSync(dir2, { recursive: true });
  const over24 = '## How I work (standing lessons)\n' + ('- ' + 'h'.repeat(98) + '\n').repeat(260) + '\n';
  const text = HEAD + '\n' + over24 + notes(60).slice(1);
  fs.writeFileSync(path.join(dir2, 'memory.md'), text);
  await s.hive.ensureAgent({ id: 'ov-2', name: 'Oona', provider: 'claude', cwd: s.home });
  const big = s.rows.find((r) => r.kind === 'memory-pinned-too-large');
  assert.ok(big && big.agentId === 'ov-2' && big.pinnedBytes > M.PINNED_HARD_CAP_BYTES, JSON.stringify(big));
  assert.ok(!s.rows.some((r) => r.kind === 'memory-rollover' && r.agentId === 'ov-2'), 'no rollover');
  assert.equal(read(path.join(dir2, 'memory.md')), text, 'memory.md untouched');
});
