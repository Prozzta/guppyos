'use strict';
/**
 * CLAIMS-90 M1: `memory search` and `memory wake-up` print a compact, current-first text that fits
 * UNDER the tool-output condenser's 1500-character default cap BY CONSTRUCTION, so an agent reads
 * the whole answer (current values first) instead of a head/tail cut. `--full` restores the verbose
 * text; `--results`, `--history`, `--format json` and the `#full` marker keep working.
 * Mutant census: test/tools/claims90-m1-mutants.cjs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const REPO = path.resolve(__dirname, '..');
const F = loadTs('src/main/nativeMemory/format.ts');
const { TOOL_OUTPUT_CAP_DEFAULT, shouldCondense } = loadTs('src/main/toolOutputCondense.ts');
const CONDENSE_SRC = fs.readFileSync(path.join(path.resolve(__dirname, '..'), 'src', 'main', 'toolOutputCondense.ts'), 'utf8');
const LINE_MAX = Number(/^const LINE_MAX = (\d+);$/m.exec(CONDENSE_SRC)[1]);
const { validateRequest } = loadTs('src/main/nativeMemory/service.ts');
const { NativeMemoryWiring } = loadTs('src/main/nativeMemory/mainWiring.ts');
const { MemoryEngine } = loadTs('src/main/nativeMemory/engine.ts');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'claims90-m1-'));
test.after(() => fs.rmSync(JAIL, { recursive: true, force: true }));
const lorem = (n, seed) => Array.from({ length: n }, (_, i) => `synthetic-${seed}-w${i}`).join(' ');
const claim = (i, status, key, date, content, extra = {}) => ({ chunkId: i, wing: 'wing-x', room: 'memory', source: 'claim', content, cosineSim: 0.5, bm25: -1, score: 1,
  claim: { id: `c-synth${String(i).padStart(8, '0')}`, status, kind: 'fact', key, at: `${date}T00:00:00.000Z` }, ...extra });
const chunk = (i, content) => ({ chunkId: i, wing: 'wing-x', room: 'general', source: 'agents/wing-x/NOTES.md', content, cosineSim: 0.4, bm25: 0.9, score: 0.9 });
const lines = (t) => t.replace(/\n$/, '').split('\n');
const condensed = (cmd, text) => shouldCondense('Bash', { command: cmd }, { stdout: text }, TOOL_OUTPUT_CAP_DEFAULT);

test('M1 caps: the compact budget is under the condenser cap, a compact line under its line max, the wake-up share at most half', () => {
  assert.ok(F.COMPACT_MAX_CHARS + F.COMPACT_GET_MAX < TOOL_OUTPUT_CAP_DEFAULT, `${F.COMPACT_MAX_CHARS} + ${F.COMPACT_GET_MAX} < ${TOOL_OUTPUT_CAP_DEFAULT}`);
  assert.ok(F.COMPACT_LINE_MAX < LINE_MAX, `${F.COMPACT_LINE_MAX} < ${LINE_MAX}`);
  assert.ok(F.WAKE_COMPACT_MAX_CHARS * 2 <= F.COMPACT_MAX_CHARS, 'the claims working set gets at least half of a compact wake-up');
});

test('M1 search (default): current first, then plain chunks, then prior / prior?; one meta + one content line per hit; the query line survives for the drill gates', () => {
  const hits = [
    claim(1, 'superseded', 'synthetic.port', '2026-09-01', 'port 1111 (old) ' + lorem(40, 'a')),
    chunk(2, '## 2026-09-20\n- synthetic note about ports ' + lorem(40, 'b')),
    claim(3, 'live', 'synthetic.port', '2026-10-10', 'port 2222 (current) ' + lorem(40, 'c')),
    claim(4, 'superseded?', 'synthetic.host', '2026-09-15', 'host alpha (maybe old) ' + lorem(40, 'd')),
    claim(5, 'live', 'synthetic.host', '2026-10-12', 'host beta (current) ' + lorem(40, 'e')),
  ];
  const text = F.formatSearch('synthetic port', { wing: 'wing-x' }, hits);
  const L = lines(text);
  assert.match(L[0], /^Results for: "synthetic port" — 5 hits, current first \[wing=wing-x\] \(--full: whole chunks\)$/);
  const metas = L.filter((l) => /^\[\d\] /.test(l));
  assert.deepEqual(metas.map((l) => l.split(' · ')[0]), ['[1] current', '[2] current', '[3] wing-x/general', '[4] prior', '[5] prior?'], 'MUTANT: priors never come before current values');
  // CLAIMS-90 R2 (C90-GET; step 2): the meta line ends at the wing/room; the ready `memory get` is one footer line after the hits.
  assert.match(metas[0], /^\[1\] current · fact · synthetic\.port · 2026-10-10 · c-synth00000003 · wing-x\/memory$/);
  assert.equal(L[L.length - 1], 'get: memory get synthetic.port · memory get synthetic.host');
  assert.match(metas[2], /^\[3\] wing-x\/general · NOTES\.md$/);
  assert.match(L[L.indexOf(metas[0]) + 1], /^ {4}\| port 2222 \(current\) synthetic-c-w0/);
  assert.match(L[L.indexOf(metas[2]) + 1], /^ {4}\| ## 2026-09-20 - synthetic note about ports/, 'a chunk\'s lines are joined into one');
  assert.doesNotMatch(text, /\[5\] prior · /, 'MUTANT: an unconfirmed supersession (superseded?) is prior?, never shown as a certain prior');
  assert.ok(text.length <= F.COMPACT_MAX_CHARS + F.COMPACT_GET_MAX, `${text.length}`);
  assert.equal(condensed('memory search synthetic port', text), false, 'the condenser leaves the compact text alone');
  assert.equal(F.formatSearch('nothing', {}, []), '\n  No results found for: "nothing"\n', 'the no-results line is unchanged');
});

test('M1 search budget BY CONSTRUCTION: adversarial hits (100 hits, 5 KB chunks, long keys / wings / query) stay under the cap with no line over the line max; the rest go behind a pointer', () => {
  const big = Array.from({ length: 100 }, (_, i) => (i % 2
    ? claim(i + 1, i % 4 === 1 ? 'live' : 'superseded', `synthetic.${'k'.repeat(110)}`, '2026-10-01', lorem(700, `x${i}`), { wing: 'w'.repeat(120), room: 'r'.repeat(60) })
    : chunk(i + 1, lorem(700, `y${i}`) + '\n' + lorem(700, `z${i}`))));
  for (const [n, hits] of [[1, big.slice(0, 1)], [2, big.slice(0, 2)], [5, big.slice(0, 5)], [10, big.slice(0, 10)], [100, big]]) {
    const text = F.formatSearch('q '.repeat(1000), { wing: 'w'.repeat(120), room: 'r'.repeat(120), since: '2026-01-01', before: '2026-12-31' }, hits);
    assert.ok(text.length <= F.COMPACT_MAX_CHARS + F.COMPACT_GET_MAX, `${n} hits: ${text.length} > ${F.COMPACT_MAX_CHARS}`);
    assert.ok(lines(text).every((l) => l.length <= F.COMPACT_LINE_MAX), `${n} hits: a line over ${F.COMPACT_LINE_MAX}`);
    assert.equal(condensed('memory search q', text), false, `${n} hits: condensed`);
    const shown = lines(text).filter((l) => /^\[\d+\] /.test(l)).length;
    const more = /… (\d+) more hits? not shown \(fewer --results, or --full\)/.exec(text);
    assert.equal(shown + (more ? Number(more[1]) : 0), n, `${n} hits: shown + pointer = all`);
    if (n <= 5) assert.equal(more, null, `${n} hits all fit`);
    if (n === 100) assert.ok(shown >= 8, `at least 8 of 100 shown, got ${shown}`);
  }
});

test('M1 search --full: the verbose whole-chunk text, unchanged (the GOLDEN layout, the prior / prior? wording, the Version lines)', () => {
  const hits = [claim(1, 'superseded?', 'synthetic.host', '2026-09-15', 'line one\nline two'), chunk(2, 'plain')];
  const full = F.formatSearch('q', { full: true, wing: 'wing-x' }, hits);
  assert.equal(full, F.formatSearchFull('q', { full: true, wing: 'wing-x' }, hits));
  assert.match(full, /^\n={60}\n {2}Results for: "q"\n {2}Wing: wing-x\n={60}\n\n {2}\[1\] wing-x \/ memory\n {6}Source: claim\n {6}Claim: {2}\[prior\? · fact · synthetic\.host · 2026-09-15 · c-synth00000001\]\n {6}Get:    memory get synthetic\.host\n {6}Version: possibly replaced/);
  assert.match(full, /\n {6}\| line one\n {6}\| line two\n/, 'M3: the body under the prefix');
  assert.notEqual(F.formatSearch('q', {}, hits), full, 'MUTANT: the default is the compact text, not the verbose one');
});

test('M1 wake-up (default): identity in one line, a pointer to the standing lessons (count, bytes), the newest entries one per line, under its share of the cap', () => {
  const entries = Array.from({ length: 24 }, (_, i) => ({ wing: 'x', room: i % 3 ? 'general' : 'memory', source: `agents/x/${i % 3 ? 'NOTES' : 'memory'}.md`, content: `## 2026-10-${String(24 - i).padStart(2, '0')}\n- synthetic entry ${i} ` + lorem(60, `w${i}`) }));
  const pinned = '## How I work (standing lessons)\n' + Array.from({ length: 12 }, (_, i) => `- synthetic lesson ${i}: ${lorem(20, `l${i}`)}`).join('\n') + '\n';
  const text = F.formatWakeUp('You are X.\nA synthetic wing.\n', entries, pinned);
  const L = lines(text);
  assert.equal(L[0], 'Wake-up (compact; --full: the whole text):');
  assert.equal(L[1], 'L0 identity: You are X. A synthetic wing.');
  assert.match(L[2], /^L0\.5 standing lessons: 12 in memory\.md "## How I work" \(\d+ B; read the section, or --full\)$/);
  assert.equal(L[3], 'L1 newest first:');
  assert.match(L[4], /^- \[memory\] ## 2026-10-24 - synthetic entry 0 .*  \(memory\.md\)$/, 'the newest entry first, its lines joined');
  const shown = L.filter((l) => l.startsWith('- [')).length;
  const more = /… (\d+) more \(--full\)/.exec(text);
  assert.ok(shown >= 4 && more && shown + Number(more[1]) === 24, `${shown} shown + ${more && more[1]} more`);
  assert.ok(text.length <= F.WAKE_COMPACT_MAX_CHARS, `${text.length}`);
  assert.ok(L.every((l) => l.length <= F.COMPACT_LINE_MAX));
  assert.equal(condensed('memory wake-up', text), false);
  // Adversarial: a 10 KB identity, a 20 KB pinned section, 200 huge entries.
  const huge = F.formatWakeUp('I'.repeat(10_000), Array.from({ length: 200 }, (_, i) => ({ wing: 'x', room: 'memory', source: 'agents/x/memory.md', content: lorem(900, `h${i}`) })), '## How I work\n' + '- l\n'.repeat(5_000));
  assert.ok(huge.length <= F.WAKE_COMPACT_MAX_CHARS, `${huge.length}`);
  assert.ok(lines(huge).every((l) => l.length <= F.COMPACT_LINE_MAX));
  assert.match(F.formatWakeUp(null, []), /^Wake-up \(compact; --full: the whole text\):\nL0 identity: none \(agents\/<id>\/identity\.md\)\nL1: no memories yet\.\n$/);
  // --full: the section-4 frame, unchanged.
  const full = F.formatWakeUp('You are X.', entries.slice(0, 1), pinned, { full: true });
  assert.equal(full, F.formatWakeUpFull('You are X.', entries.slice(0, 1), pinned));
  assert.match(full, /^Wake-up text \(~\d+ tokens\):\n={50}\n## L0 — IDENTITY\nYou are X\.\n\n## L0\.5 — HOW I WORK \(standing lessons\)\n- synthetic lesson 0:[\s\S]*## L1 — ESSENTIAL STORY\n\n\[memory\]\n {2}- ## 2026-10-24 - synthetic entry 0/);
});

test('M1 fitLines: a block under the budget is unchanged; over it, whole lines are kept in order and a pointer counts the rest; never over the budget', () => {
  const block = Array.from({ length: 30 }, (_, i) => `- synthetic current value ${i} [c:c-synth${i}]`).join('\n');
  assert.equal(F.fitLines(block, block.length), block);
  assert.equal(F.fitLines(block, 10_000), block, 'MUTANT: under the budget nothing is cut');
  for (const max of [0, 10, 60, 100, 400, 700, block.length - 1]) {
    const out = F.fitLines(block, max);
    assert.ok(out.length <= max, `max ${max}: ${out.length}`);
    const kept = lines(out).filter((l) => l.startsWith('- '));
    assert.deepEqual(kept, block.split('\n').slice(0, kept.length), `max ${max}: whole lines, in order`);
    const more = /… (\d+) more lines? \(--full\)$/.exec(out);
    if (kept.length < 30 && max >= 25) assert.ok(more && Number(more[1]) === 30 - kept.length, `max ${max}: the pointer counts the rest (${out})`);
  }
  assert.ok(lines(F.fitLines('x'.repeat(2000) + '\ny', 1000)).every((l) => l.length <= F.COMPACT_LINE_MAX), 'a long line is clipped to the line max');
});

function wiring(root) {
  const res = path.join(root, 'res');
  const plat = `${process.platform}-${process.arch}`;
  fs.mkdirSync(path.join(res, 'models', 'm', 'onnx'), { recursive: true });
  fs.writeFileSync(path.join(root, 'vec0.bin'), 'v');
  fs.writeFileSync(path.join(res, 'models', 'm', 'onnx', 'model.onnx'), 'o');
  fs.writeFileSync(path.join(res, 'models', 'native-memory-manifest.json'), JSON.stringify({ model: { dir: 'm', onnxSha256: 'a', tokenizerSha256: 'b' }, vec0: { [plat]: { package: 'p', file: 'vec0.bin', sha256: 'c' } } }));
  const fake = { postMessage() {}, on() {}, kill() { return true; } };
  return new NativeMemoryWiring({
    hiveRoot: () => root, enabled: () => true, userData: path.join(root, 'ud'), resourcesDir: res, workerEntry: 'w.js', fork: () => fake,
    memoryBaseUrl: () => 'http://127.0.0.1:5555/memory', writeCommand: () => path.join(root, 'bin', 'memory'), log: () => {}, vecLoadablePath: () => path.join(root, 'vec0.bin')
  });
}

test('M1 wiring: the compact wake-up leads with the claims working set (current values), fitted so claims + native text stay under the cap; --full keeps the verbose order and the whole claims block', async () => {
  const root = fs.mkdtempSync(path.join(JAIL, 'w-'));
  fs.mkdirSync(path.join(root, 'agents', 'a1'), { recursive: true });
  fs.writeFileSync(path.join(root, 'agents', 'a1', 'memory.md'), 'm');
  const w = wiring(root);
  const tok = w.spawnEnv('a1').env.MEMORY_TOKEN;
  const native = F.formatWakeUp('You are a1.', Array.from({ length: 12 }, (_, i) => ({ wing: 'a1', room: 'memory', source: 'agents/a1/memory.md', content: `synthetic entry ${i} ` + lorem(40, `n${i}`) })), null);
  const claims = '# Memory working set\n' + Array.from({ length: 40 }, (_, i) => `- synthetic current value ${i}: ${lorem(8, `v${i}`)} [status:current] [c:c-synthv${i}]`).join('\n');
  w.run = async (body) => ({ ok: true, exit: 0, text: body.args && body.args.full ? 'VERBOSE-NATIVE' : native });
  const forWing = (id) => claims.replace('# Memory working set', `# Memory working set — ${id}`);
  w.setClaimWakeupProvider(forWing);
  const r = await w.handle(tok, { cmd: 'wake-up' });
  assert.ok(r.body.text.startsWith('# Memory working set — a1\n- synthetic current value 0:'), 'MUTANT: claims (current values) come first');
  assert.ok(r.body.text.endsWith(native), 'then the compact native text, whole');
  assert.ok(r.body.text.length <= F.COMPACT_MAX_CHARS + F.COMPACT_GET_MAX, `${r.body.text.length} > ${F.COMPACT_MAX_CHARS}`);
  assert.match(r.body.text, /… \d+ more lines \(--full\)\n\nWake-up \(compact/, 'MUTANT: the claims block is fitted with a pointer');
  assert.equal(condensed('memory wake-up', r.body.text), false);
  const full = await w.handle(tok, { cmd: 'wake-up', args: { full: true } });
  assert.equal(full.body.text, `VERBOSE-NATIVE\n\n${forWing('a1')}`, '--full: the native text first, the whole claims block after it');
  const other = await w.handle(tok, { cmd: 'wake-up', args: { wing: 'a2' } });
  assert.match(other.body.text, /^# Memory working set — a2\n/, 'the named wing\'s claims');
  assert.doesNotMatch(other.body.text, /— a1/);
  // A search is never touched by the claims provider.
  w.run = async () => ({ ok: true, exit: 0, text: 'search-text' });
  assert.equal((await w.handle(tok, { cmd: 'search', args: { query: 'x' } })).body.text, 'search-text');
});

test('M1 engine: wakeUp(wing) is compact, wakeUp(wing, true) the section-4 frame; both read the same identity, pinned section and entries', async () => {
  const root = fs.mkdtempSync(path.join(JAIL, 'e-'));
  fs.mkdirSync(path.join(root, 'agents', 'ph'), { recursive: true });
  fs.writeFileSync(path.join(root, 'agents', 'ph', 'identity.md'), 'You are Phyllis.');
  fs.writeFileSync(path.join(root, 'agents', 'ph', 'memory.md'), '# Phyllis\n\n## How I work (standing lessons)\n- Cite only URLs you fetched.\n- Commit only under the repo identity.\n\n## Log\n- entry\n');
  const ENTRIES = [{ wing: 'ph', room: 'memory', source: 'agents/ph/memory.md', content: '## 2026-10-24\n- synthetic newest' }];
  const store = { setMeta() {}, sourceShas: () => new Map(), removeSource() {}, planDiff: () => ({ keep: [], add: [], remove: [] }), applyDiff: () => true, wakeUp: () => ENTRIES, search: () => [] };
  const eng = new MemoryEngine({ hiveRoot: root, store, embedder: { loaded: true, embed: async (x) => x.map(() => new Float32Array(384)), unload: async () => {} },
    countTokens: (x) => x.split(/\s+/).length, mode: () => 'native', watch: null, setTimer: (fn, ms) => (ms === 0 ? setImmediate(fn) : { ms }), clearTimer: () => {} });
  const compact = (await eng.wakeUp('ph')).text;
  assert.match(compact, /^Wake-up \(compact; --full: the whole text\):\nL0 identity: You are Phyllis\.\nL0\.5 standing lessons: 2 in memory\.md "## How I work" \(\d+ B; read the section, or --full\)\nL1 newest first:\n- \[memory\] ## 2026-10-24 - synthetic newest {2}\(memory\.md\)\n$/);
  const full = (await eng.wakeUp('ph', true)).text;
  assert.match(full, /^Wake-up text \(~\d+ tokens\):\n={50}\n## L0 — IDENTITY\nYou are Phyllis\.\n\n## L0\.5 — HOW I WORK \(standing lessons\)\n- Cite only URLs you fetched\.\n- Commit only under the repo identity\.\n\n## L1 — ESSENTIAL STORY\n\n\[memory\]\n {2}- ## 2026-10-24 - synthetic newest {2}\(memory\.md\)\n$/);
});

test('M1 request validation: `full` is a boolean on search and wake-up (false unless exactly true); every other search argument is unchanged', () => {
  const s = validateRequest({ cmd: 'search', args: { query: 'x', results: 7, history: true, full: true } }, 'a1');
  assert.deepEqual(s, { op: 'search', args: { query: 'x', wing: null, room: null, results: 7, since: null, before: null, caller: 'a1', mode: 'history', kind: null, key: null, full: true, exact: false, newest: false } });
  assert.equal(validateRequest({ cmd: 'search', args: { query: 'x', full: 'yes' } }, 'a1').args.full, false, 'MUTANT: only the boolean true');
  assert.equal(validateRequest({ cmd: 'search', args: { query: 'x' } }, 'a1').args.full, false);
  assert.deepEqual(validateRequest({ cmd: 'wake-up', args: { full: true } }, 'a1'), { op: 'wake-up', args: { wing: 'a1', full: true } });
  assert.deepEqual(validateRequest({ cmd: 'wake-up', args: { wing: 'jim' } }, 'a1'), { op: 'wake-up', args: { wing: 'jim', full: false } });
});

test('M1 CLI: --full on search and wake-up (anywhere among the options); --results / --history / --all / --format json still parse; --full is not a status option; USAGE names it', () => {
  const CLI = path.join(REPO, 'resources', 'memory-cli.cjs');
  const cp = require('node:child_process');
  const real = cp.spawnSync;
  cp.spawnSync = () => ({});
  delete require.cache[require.resolve(CLI)];
  let cli;
  try { cli = require(CLI); } finally { cp.spawnSync = real; }
  const { parseArgs } = cli;
  const USAGE = fs.readFileSync(CLI, 'utf8');
  assert.deepEqual(parseArgs(['search', 'log', 'rotation', '--full', '--results=3', '--history']).args, { full: true, results: 3, history: true, query: 'log rotation' });
  assert.deepEqual(parseArgs(['search', '--wing', 'w', 'x', '--full']).args, { wing: 'w', full: true, query: 'x' });
  assert.deepEqual(parseArgs(['wake-up', '--full', '--wing', 'andy']).args, { full: true, wing: 'andy' });
  assert.equal(parseArgs(['wake-up']).args.full, undefined, 'MUTANT: compact is the default');
  assert.equal(parseArgs(['search', 'x', '--all', '--format', 'json']).format, 'json');
  const st = parseArgs(['status', '--full']);
  assert.equal(st.args.full, undefined); assert.deepEqual(st.rest, ['--full']);
  assert.match(USAGE, /search QUERY \[--wing W\][^\n]*\[--full\] \| wake-up \[--wing W\] \[--full\] \| status/);
  assert.match(USAGE, /compact, current-first text[^\n]*--full prints the whole chunks/);
});

test('M1 static: the worker passes `full` to search and wake-up; the condenser\'s #full marker and caps are untouched by this change', () => {
  const worker = fs.readFileSync(path.join(REPO, 'src', 'main', 'nativeMemory', 'worker.ts'), 'utf8');
  assert.match(worker, /key: \(a\.key as string\) \?\? null, full: a\.full === true \}/, 'search: full');
  assert.match(worker, /engine\.wakeUp\(\(a\.wing as string\) \?\? null, a\.full === true\)/, 'wake-up: full');
  const cond = CONDENSE_SRC;
  assert.match(cond, /export const TOOL_OUTPUT_CAP_DEFAULT = 1500;/);
  assert.match(cond, /export const FULL_MARKER_RE = \/#full\\s\*\$\/;/);
});

// — Jim's M1 audit (NO-GO @c83b23fa): the value must survive the cap —

test('M1 MUST 1: a value past char 154 of a live claim is shown at 1 hit and at 5 hits: the whole content, wrapped on lines under the line max, nothing lost', () => {
  const value = 'sha 9f8e7d6c5b4a';
  const long = `${lorem(15, 'p')} ${value} ${lorem(10, 'q')}`;
  assert.ok(long.indexOf(value) > 200, `the value sits at ${long.indexOf(value)}`);
  const live = claim(1, 'live', 'synthetic.sha', '2026-10-10', long);
  const one = F.formatSearch('synthetic sha', {}, [live]);
  assert.match(one, /9f8e7d6c5b4a/, 'MUTANT: 1 hit: the value past the old 154-char cut is shown');
  assert.doesNotMatch(one, /clipped|…/, '1 hit: nothing is cut');
  const content = lines(one).filter((l) => /^ {4}/.test(l));
  assert.ok(content.length >= 2, 'the content is wrapped on several lines');
  assert.equal(content.map((l) => l.slice(6)).join(' '), long, 'the whole content, in order (M3: under the `| ` prefix)');
  const five = F.formatSearch('synthetic sha', {}, [
    claim(2, 'superseded', 'synthetic.sha', '2026-09-01', `${lorem(13, 'a')} sha 00000000dead ${lorem(10, 'b')}`),
    live,
    claim(3, 'superseded', 'synthetic.sha', '2026-09-05', `${lorem(13, 'c')} sha 00000001dead ${lorem(10, 'd')}`),
    claim(4, 'superseded?', 'synthetic.host', '2026-09-15', `${lorem(13, 'e')} host gamma ${lorem(10, 'f')}`),
    chunk(5, lorem(24, 'z')),
  ]);
  assert.match(five, /9f8e7d6c5b4a/, 'MUTANT: 5 hits: the current value is whole (current first, up to three shares)');
  assert.match(lines(five)[1], /^\[1\] current · fact · synthetic\.sha/);
  for (const t of [one, five]) {
    assert.ok(t.length <= F.COMPACT_MAX_CHARS + F.COMPACT_GET_MAX, `${t.length}`);
    assert.ok(lines(t).every((l) => l.length <= F.COMPACT_LINE_MAX), 'no line over the line max');
    assert.equal(condensed('memory search synthetic sha', t), false);
  }
  const shown = lines(five).filter((l) => /^\[\d\] /.test(l)).length;
  const more = /… (\d+) more hits? not shown/.exec(five);
  assert.equal(shown + (more ? Number(more[1]) : 0), 5, 'shown + pointer = all');
});

test('M1 MUST 1: a clipped chunk shows a window around the matched term (not the head), marked …, and the footer counts the clipped hits', () => {
  const big = `${lorem(60, 'h')} the zebrafinch relay port 4471 ${lorem(60, 't')}`;
  const hits = Array.from({ length: 5 }, (_, i) => chunk(i + 1, big));
  const text = F.formatSearch('zebrafinch relay', {}, hits);
  assert.match(text, /zebrafinch relay port 4471/, 'MUTANT: the matched text is inside the window');
  assert.match(text, /^ {4}\| …/m, 'the window says it starts inside the chunk');
  assert.match(text, /^… \d hits? clipped \(--full shows whole chunks\)$/m, 'MUTANT: the clipped hits are counted');
  assert.ok(text.length <= F.COMPACT_MAX_CHARS + F.COMPACT_GET_MAX, `${text.length}`);
  assert.ok(lines(text).every((l) => l.length <= F.COMPACT_LINE_MAX));
  const shown = lines(text).filter((l) => /^\[\d\] /.test(l)).length;
  const more = /… (\d+) more hits? not shown/.exec(text);
  assert.equal(shown + (more ? Number(more[1]) : 0), 5, 'shown + pointer = all');
  assert.equal(Number(/… (\d) hits? clipped/.exec(text)[1]), shown, 'every shown hit of this size is clipped');
  // windowContent and wrap on their own
  const w = F.windowContent(`${'a'.repeat(300)} needle here ${'b'.repeat(300)}`, 'needle', 100);
  assert.equal(w.clipped, true);
  assert.match(w.text, /needle here/);
  assert.ok(w.text.length <= 100 && w.text.startsWith('…') && w.text.endsWith('…'), w.text);
  assert.deepEqual(F.windowContent('short text', 'needle', 100), { text: 'short text', clipped: false });
  const head = F.windowContent(`needle first ${'c'.repeat(300)}`, 'needle', 60);
  assert.ok(head.text.startsWith('needle first') && head.clipped && head.text.length <= 60, 'a term inside the head keeps the head');
  const none = F.windowContent('d'.repeat(300), 'needle', 60);
  assert.ok(none.text.startsWith('dddd') && none.text.length <= 60, 'no term: the head');
  const tail = F.windowContent(`${'e'.repeat(300)} needle end`, 'needle', 60);
  assert.ok(tail.text.endsWith('needle end') && tail.text.startsWith('…') && tail.text.length <= 60, 'a term near the end: the window runs to the end');
  assert.deepEqual(F.wrap('aa bb cc dd', 5), ['aa bb', 'cc dd']);
  assert.deepEqual(F.wrap('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
  assert.deepEqual(F.wrap('', 4), []);
});

test('M1 MUST 3: the UI callers (hive:searchMemory, hive:memoryWakeUp: Memory panel, Command Center, voice tools) ask for the full text: no condenser applies there', () => {
  const src = fs.readFileSync(path.join(REPO, 'src', 'main', 'index.ts'), 'utf8');
  assert.match(src, /nativeMemory\.query\('search', \{ query, full: true,/, 'MUTANT: the UI search is verbose');
  assert.match(src, /nativeMemory\.query\('wake-up', \{ full: true,/, 'MUTANT: the UI wake-up is verbose');
});

test('M1 S1 (Jim re-audit): a term near the end of the head survives the wrap cost (window after wrapping, not before)', () => {
  // Long words waste most of every wrapped line, so the head (chosen on raw chars) costs more lines than its
  // budget and the closing lines are popped; the term sitting in them must come back through the window.
  // Jim's example: 1 hit, ~1360 chars, the term around char 1120-1200. Only BODY lines count: the header
  // echoes the query, so a match anywhere in the text proves nothing.
  const word = (i) => `w${String(i).padStart(3, '0')}${'x'.repeat(76)}`;
  const body = (text) => lines(text).filter((l) => l.startsWith('    ')).join(' ');
  let windowed = 0;
  for (let head = 12; head <= 14; head++) {
    for (let pad = 0; pad <= 90; pad += 10) {
      const content = `${Array.from({ length: head }, (_, i) => word(i)).join(' ')} ${'p'.repeat(pad)} the token is f00dcafe1234 ${word(901)} ${word(902)} ${word(903)}`;
      const at = content.indexOf('f00dcafe1234');
      const text = F.formatSearch('f00dcafe1234', {}, [chunk(1, content)]);
      assert.match(body(text), /f00dcafe1234/, `MUTANT: the matched term at char ${at} of ${content.length} is shown in the body (1 hit)`);
      assert.ok(text.length <= F.COMPACT_MAX_CHARS + F.COMPACT_GET_MAX && lines(text).every((l) => l.length <= F.COMPACT_LINE_MAX), 'cap and line max hold');
      if (/^ {4}\| …/m.test(text)) windowed++;
    }
  }
  assert.ok(windowed >= 1, `the window branch was taken after wrapping at least once (${windowed})`);
  // windowContent in window mode never returns the head
  const w = F.windowContent(`${'a'.repeat(100)} needle ${'b'.repeat(300)}`, 'needle', 300, 'window');
  assert.ok(w.text.startsWith('…') && /needle/.test(w.text));
  assert.equal(F.hasTerm('A Needle here', 'needle'), true);
  assert.equal(F.hasTerm('nothing', 'needle'), false);
});
