'use strict';
/**
 * NATIVE-MEMORY (1.1.54), the parts that run in plain Node: the tokenizer, the chunker, the
 * source allow-list and migration report, the CLI text, request validation, tokens, the main-side
 * client (deadlines, crash, lazy fork), the wiring (native always on; fail closed), the HookServer route and
 * the `memory` command. The store/engine/worker against the real natives are in
 * native-memory-electron.test.cjs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const loadTs = require('./load-ts.cjs');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'native-memory-node-'));
const realEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
test.after(() => { for (const [k, v] of Object.entries(realEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } fs.rmSync(JAIL, { recursive: true, force: true }); });

const { WordPieceTokenizer, wordPieceConfigFromTokenizerJson, basicTokens } = loadTs('src/main/nativeMemory/wordpiece.ts');
const { chunkMarkdown, CHUNK_MAX_TOKENS } = loadTs('src/main/nativeMemory/chunker.ts');
const { discoverSources, safeRelativeMd, MAX_SOURCE_BYTES } = loadTs('src/main/nativeMemory/sources.ts');
const { formatSearch, formatWakeUp } = loadTs('src/main/nativeMemory/format.ts');
const { ftsQuery, rrf, compactionDecision } = loadTs('src/main/nativeMemory/store.ts');
const { validateRequest, MemoryTokens, NativeMemoryClient, EXIT } = loadTs('src/main/nativeMemory/service.ts');
const { NativeMemoryWiring, dbFileFor, toUnpacked } = loadTs('src/main/nativeMemory/mainWiring.ts');
const { HookServer } = loadTs('src/main/hooks.ts');

const REPO = path.resolve(__dirname, '..');
const TOKENIZER = path.join(REPO, 'resources', 'models', 'all-MiniLM-L6-v2', 'tokenizer.json');
const HAVE_TOKENIZER = fs.existsSync(TOKENIZER);
const words = (t) => t.split(/\s+/).filter(Boolean).length;
const dir = () => fs.mkdtempSync(path.join(JAIL, 'd-'));
function hive(files) {
  const root = dir();
  for (const [rel, text] of Object.entries(files)) {
    const p = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  }
  return root;
}

// ── tokenizer ─────────────────────────────────────────────────────────────

test('WORDPIECE: BERT-uncased ids for known text ([CLS] hello world [SEP] = 101 7592 2088 102); accents stripped, punctuation split, [UNK] for an unknown word', { skip: !HAVE_TOKENIZER }, () => {
  const tok = new WordPieceTokenizer(wordPieceConfigFromTokenizerJson(JSON.parse(fs.readFileSync(TOKENIZER, 'utf8'))));
  assert.deepEqual(tok.encode('Hello world'), [101, 7592, 2088, 102]);
  assert.deepEqual(tok.encode('HÉLLO, world!'), [101, 7592, 1010, 2088, 999, 102]);
  assert.deepEqual(basicTokens("don't stop"), ['don', "'", 't', 'stop']);
  assert.equal(tok.encode('a'.repeat(101))[1], 100, 'a word over max_input_chars_per_word is [UNK]');
  assert.equal(tok.encode('x '.repeat(600), 256).length, 256, 'truncated to the window, [SEP] kept last');
  assert.equal(tok.encode('x '.repeat(600), 256).at(-1), 102);
});

test('WORDPIECE: a tokenizer.json of another shape is refused, never silently mis-tokenized', () => {
  assert.throws(() => wordPieceConfigFromTokenizerJson({ normalizer: { type: 'NFC' }, pre_tokenizer: { type: 'BertPreTokenizer' }, model: { type: 'WordPiece', vocab: {} } }), /unsupported normalizer/);
  assert.throws(() => wordPieceConfigFromTokenizerJson({ normalizer: { type: 'BertNormalizer', lowercase: true, handle_chinese_chars: true, clean_text: true }, pre_tokenizer: { type: 'Whitespace' }, model: { type: 'WordPiece', vocab: {} } }), /pre-tokenizer/);
});

// ── chunker ───────────────────────────────────────────────────────────────

test('CHUNKER: deterministic; every chunk within the budget; a section heading rides on each of its chunks; fenced code is not split into sections', () => {
  const md = '# Top\nintro para\n\n## A\n' + 'alpha '.repeat(500) + '\n\n## B\n```\n# not a heading\ncode\n```\nafter\n';
  const a = chunkMarkdown(md, words);
  const b = chunkMarkdown(md, words);
  assert.deepEqual(a, b);
  for (const c of a) assert.ok(words(c.content) <= CHUNK_MAX_TOKENS, `chunk of ${words(c.content)}`);
  assert.ok(a.filter((c) => c.content.startsWith('## A\n')).length >= 3, 'the long section splits, each piece keeps its heading');
  assert.ok(a.some((c) => c.content.startsWith('## B\n```\n# not a heading')), 'a # inside a fence is text');
  assert.deepEqual(a.map((c) => c.ordinal), a.map((_, i) => i));
});

test('CHUNKER: appending an entry to memory.md changes NO existing chunk (the chunk-diff premise)', () => {
  const base = Array.from({ length: 40 }, (_, i) => `## 2026-09-${(i % 28) + 1} e${i}\n- fact ${i} ${'word '.repeat(i % 30)}`).join('\n\n');
  const before = chunkMarkdown(base, words);
  const after = chunkMarkdown(`${base}\n\n## 2026-09-29 new\n- a new fact\n`, words);
  assert.equal(after.length, before.length + 1);
  assert.deepEqual(after.slice(0, before.length).map((c) => c.contentSha), before.map((c) => c.contentSha));
  const edited = chunkMarkdown(base.replace('- fact 3 ', '- fact 3 (edited) '), words);
  const changed = edited.filter((c, i) => c.contentSha !== before[i].contentSha).length;
  assert.equal(changed, 1, 'an edit changes only its own section');
});

// ── sources ───────────────────────────────────────────────────────────────

test('ALLOW-LIST (section 1): memory.md and direct agent .md are eligible; nested, mail, data and top-level notes are not, and every excluded .md is REPORTED by path', () => {
  const root = hive({
    'agents/a1/memory.md': 'm', 'agents/a1/AUDIT.md': 'a', 'agents/a1/data.json': '{}', 'agents/a1/run.txt': 't',
    'agents/a1/sub/NESTED.md': 'n', 'agents/a1/inbox/x.md': 'mail', 'agents/a1/.claude/skills/s/SKILL.md': 's',
    'agents/b2/memory.md': 'm2', 'board.md': 'b', 'NOTE.md': 'n', 'agents/bad id/memory.md': 'x'
  });
  const d = discoverSources(root);
  assert.deepEqual(d.eligible.map((e) => `${e.path}|${e.kind}|${e.wing}|${e.room}`).sort(), [
    'agents/a1/AUDIT.md|deliverable|a1|audit', 'agents/a1/memory.md|memory|a1|memory', 'agents/b2/memory.md|memory|b2|memory'
  ]);
  assert.deepEqual(d.excludedMd, ['NOTE.md', 'agents/a1/.claude/skills/s/SKILL.md', 'agents/a1/sub/NESTED.md', 'board.md']);
  assert.ok(!d.excludedMd.some((p) => p.includes('inbox')), 'mail is never walked');
  assert.equal(d.allowListVersion, 1);
  assert.equal(d.counts.eligible, 3);
});

test('ALLOW-LIST opt-ins (items 3-4): the god-approved top-level list and a per-agent nested include; board.md, path escapes and missing files are REJECTED', () => {
  const root = hive({
    'agents/a1/memory.md': 'm', 'agents/a1/capui-tidy-doc/PROVIDER-CAPACITY-UI-AUDIT.md': 'audit', 'NOTE.md': 'n', 'board.md': 'b',
    'memory-sources.json': JSON.stringify({ topLevel: ['NOTE.md', 'board.md', '../x.md', 'missing.md'], include: { a1: ['capui-tidy-doc/PROVIDER-CAPACITY-UI-AUDIT.md', '../../escape.md', 'C:/abs.md'] } })
  });
  const d = discoverSources(root);
  const paths = d.eligible.map((e) => e.path).sort();
  assert.deepEqual(paths, ['NOTE.md', 'agents/a1/capui-tidy-doc/PROVIDER-CAPACITY-UI-AUDIT.md', 'agents/a1/memory.md']);
  assert.equal(d.eligible.find((e) => e.path === 'NOTE.md').wing, 'hive');
  assert.deepEqual(d.rejectedConfig.sort(), ['../x.md', 'agents/a1/../../escape.md', 'agents/a1/C:/abs.md', 'board.md', 'missing.md']);
  assert.deepEqual(d.excludedMd, ['board.md']);
  assert.equal(safeRelativeMd('a/../b.md'), null);
  assert.equal(safeRelativeMd('a/b.md'), 'a/b.md');
});

test('ALLOW-LIST: a Markdown file over the size cap is excluded by rule (a pasted log is not memory)', () => {
  const root = hive({ 'agents/a1/memory.md': 'm', 'agents/a1/HUGE.md': 'x'.repeat(MAX_SOURCE_BYTES + 1) });
  const d = discoverSources(root);
  assert.deepEqual(d.eligible.map((e) => e.path), ['agents/a1/memory.md']);
  assert.deepEqual(d.excludedMd, ['agents/a1/HUGE.md']);
});

// ── text ──────────────────────────────────────────────────────────────────

test('GOLDEN search text (the hybrid path), including the filter lines and the no-results line', () => {
  const hits = [{ chunkId: 1, wing: 'oscar-mu3300lb', room: 'general', source: 'agents/oscar-mu3300lb/UPSTREAM.md', content: 'line one\nline two\n', cosineSim: 0.4361, bm25: 1.3472, score: 1 }];
  const text = formatSearch('log rotation', { wing: 'oscar-mu3300lb', since: '2026-09-01' }, hits);
  assert.equal(text, [
    '', '='.repeat(60), '  Results for: "log rotation"', '  Wing: oscar-mu3300lb', '  Since: 2026-09-01', '='.repeat(60), '',
    '  [1] oscar-mu3300lb / general', '      Source: UPSTREAM.md', '      Match:  cosine_sim=0.436  bm25=1.347', '',
    '      line one', '      line two', '', `  ${'-'.repeat(56)}`, '', ''
  ].join('\n'));
  assert.equal(formatSearch('nothing', {}, []), '\n  No results found for: "nothing"\n');
  assert.match(formatSearch('q', {}, [{ ...hits[0], cosineSim: null, bm25: 2 }]), /cosine_sim=0\.0 {2}bm25=2\.0/);
});

test('WAKE-UP contract (section 4): L0 identity, then the newest memory entries first; bounded; the legacy frame', () => {
  const t = formatWakeUp('You are X.', [{ wing: 'x', room: 'memory', source: 'agents/x/memory.md', content: '## d\n- newest' }, { wing: 'x', room: 'audit', source: 'agents/x/AUDIT.md', content: 'y'.repeat(900) }]);
  assert.match(t, /^Wake-up text \(~\d+ tokens\):\n={50}\n## L0 — IDENTITY\nYou are X\.\n\n## L1 — ESSENTIAL STORY\n\n\[memory\]\n {2}- ## d - newest {2}\(memory\.md\)\n\n\[audit\]\n {2}- y{397}\.\.\. {2}\(AUDIT\.md\)\n$/);
  assert.match(formatWakeUp(null, []), /No identity file[\s\S]*## L1 — No memories yet\./);
});

test('FTS query + RRF + compaction policy (pure)', () => {
  assert.equal(ftsQuery('   '), null);
  assert.equal(ftsQuery('a "b" c*'), null, 'single letters alone are not a query');
  assert.equal(ftsQuery('log.jsonl rotation'), '"log" OR "jsonl" OR "rotation"');
  assert.deepEqual(rrf([1, 2, 3], [3, 4]).map((r) => r.id), [3, 1, 4, 2], '2 and 4 tie at 1/62: the one with a vector rank goes first');
  assert.deepEqual(rrf([1], [2]).map((r) => r.id), [2, 1], 'a tie goes to the vector rank');
  assert.equal(compactionDecision(20e6, 5e6, 0), 'compact');
  assert.equal(compactionDecision(15e6, 5e6, 0), 'none', 'under 16 MiB the size rule does not fire');
  assert.equal(compactionDecision(2e6, 1.9e6, 0.26), 'compact', 'freelist >= 25%');
  assert.equal(compactionDecision(90e6, 10e6, 0), 'force', 'past 8x live: forced + health row');
});

// ── requests, tokens, client ─────────────────────────────────────────────

test('VALIDATION (section 6): ranges, ISO dates, wing names; wake-up without --wing is the CALLER\'s', () => {
  // NATIVE-WAKEUP (b): `caller` is the token's wing as a backfill hint; `wing` (the filter) stays null.
  assert.deepEqual(validateRequest({ cmd: 'search', args: { query: 'x', results: 3 } }, 'a1'), { op: 'search', args: { query: 'x', wing: null, room: null, results: 3, since: null, before: null, caller: 'a1' } });
  for (const bad of [{ query: '' }, { query: 'x', results: 0 }, { query: 'x', results: 101 }, { query: 'x', results: 2.5 }, { query: 'x', wing: 'a b' }, { query: 'x', since: 'yesterday' }, { query: 'x'.repeat(2001) }]) {
    assert.equal(validateRequest({ cmd: 'search', args: bad }, 'a1').exit, EXIT.usage, JSON.stringify(bad));
  }
  assert.deepEqual(validateRequest({ cmd: 'wake-up', args: {} }, 'andy'), { op: 'wake-up', args: { wing: 'andy' } });
  assert.deepEqual(validateRequest({ cmd: 'wake-up', args: { wing: 'jim' } }, 'andy'), { op: 'wake-up', args: { wing: 'jim' } });
  assert.equal(validateRequest({ cmd: 'mine', args: {} }, 'a').exit, EXIT.usage);
  assert.equal(validateRequest({ cmd: 'shadow', args: { query: 'x' } }, 'a').exit, EXIT.usage, 'the shadow path is gone');
});

test('MEMORY_TOKEN: minted per agent, resolves only its own agent, revoked on exit, re-minting retires the old one', () => {
  const t = new MemoryTokens();
  const a = t.mint('a1');
  const b = t.mint('b2');
  assert.equal(t.resolve(a), 'a1');
  assert.equal(t.resolve(b), 'b2');
  assert.equal(t.resolve('0'.repeat(32)), null);
  assert.equal(t.resolve('nothex'), null);
  const a2 = t.mint('a1');
  assert.equal(t.resolve(a), null, 'a respawn retires the old token');
  assert.equal(t.resolve(a2), 'a1');
  t.revoke('a1');
  assert.equal(t.resolve(a2), null);
});

function fakeWorker() {
  const w = { posted: [], handlers: { message: [], exit: [] }, killed: false };
  w.postMessage = (m) => w.posted.push(m);
  w.on = (ev, fn) => w.handlers[ev].push(fn);
  w.kill = () => { w.killed = true; return true; };
  w.reply = (m) => w.handlers.message.forEach((f) => f(m));
  w.exit = (c) => w.handlers.exit.forEach((f) => f(c));
  return w;
}

test('CLIENT (section 3): no fork until the first request; one init; replies by id; a named degraded reply at the deadline; a crash answers in-flight requests and re-forks, bounded', async () => {
  const workers = [];
  const timers = [];
  let now = 1000;
  const c = new NativeMemoryClient({
    fork: () => { const w = fakeWorker(); workers.push(w); return w; },
    config: () => ({ hiveRoot: 'h' }), now: () => now,
    setTimer: (fn, ms) => { const t = { fn, at: now + ms }; timers.push(t); return t; }, clearTimer: (t) => { t.cleared = true; }
  });
  assert.equal(c.forked, false, 'nothing forked at construction (lazy)');
  const p1 = c.request('search', { query: 'x' });
  assert.equal(workers.length, 1);
  assert.equal(workers[0].posted[0].op, 'init');
  const req = workers[0].posted[1];
  assert.equal(req.op, 'search');
  assert.equal(req.deadline, 1000 + 2000, 'cold deadline 2 s');
  workers[0].reply({ id: req.id, ok: true, exit: 0, text: 'T' });
  assert.deepEqual(await p1, { ok: true, exit: 0, text: 'T', json: undefined, error: undefined });
  const p2 = c.request('search', { query: 'y' });
  assert.equal(workers[0].posted[2].deadline, 1000 + 250, 'warm deadline 250 ms');
  const t = timers.find((x) => !x.cleared && x.at === 1250);
  t.fn();
  assert.equal((await p2).exit, EXIT.degraded, 'the caller is never blocked past the deadline');
  const p3 = c.request('status', {});
  workers[0].exit(1);
  assert.equal((await p3).error, 'memory worker exited');
  for (let i = 0; i < 3; i++) { void c.request('status', {}); workers.at(-1).exit(1); }
  const down = await c.request('status', {});
  assert.equal(down.exit, EXIT.unavailable, 'after too many crashes the worker stays down (exit 3)');
  assert.equal(workers.length, 4);
});

test('CLIENT (Jim N2): after the worker reports an idle model unload, the next request gets the COLD deadline again', async () => {
  const workers = [];
  let now = 0;
  const c = new NativeMemoryClient({ fork: () => { const w = fakeWorker(); workers.push(w); return w; }, config: () => ({ hiveRoot: 'h' }), now: () => now, setTimer: () => ({}), clearTimer: () => {} });
  const p = c.request('search', { query: 'x' });
  const req = workers[0].posted[1];
  workers[0].reply({ id: req.id, ok: true, exit: 0 });
  await p;
  void c.request('search', { query: 'y' });
  assert.equal(workers[0].posted[2].deadline, 250, 'warm');
  workers[0].reply({ event: 'model-unloaded' });
  void c.request('search', { query: 'z' });
  assert.equal(workers[0].posted[3].deadline, 2000, 'cold again after the unload');
});

test('CLIENT: no runtime pieces (no config) = exit 3 and nothing forked', async () => {
  let forks = 0;
  const c = new NativeMemoryClient({ fork: () => { forks++; return fakeWorker(); }, config: () => null });
  assert.equal((await c.request('search', { query: 'x' })).exit, EXIT.unavailable);
  assert.equal(forks, 0);
});

// ── wiring ────────────────────────────────────────────────────────────────

/** A resources dir with the runtime pieces workerConfig() checks for (manifest, model, vec0). */
function runtime(root) {
  const res = path.join(root, 'res');
  const plat = `${process.platform}-${process.arch}`;
  const vec = path.join(root, 'vec0.bin');
  fs.writeFileSync(vec, 'v');
  fs.mkdirSync(path.join(res, 'models', 'm', 'onnx'), { recursive: true });
  fs.writeFileSync(path.join(res, 'models', 'm', 'onnx', 'model.onnx'), 'o');
  fs.writeFileSync(path.join(res, 'models', 'native-memory-manifest.json'), JSON.stringify({ model: { dir: 'm', onnxSha256: 'a', tokenizerSha256: 'b' }, vec0: { [plat]: { package: 'p', file: 'vec0.bin', sha256: 'c' } } }));
  return { resourcesDir: res, vecLoadablePath: () => vec };
}

function wiring(root, over = {}) {
  const logs = [];
  const workers = [];
  const w = new NativeMemoryWiring({
    hiveRoot: () => root, enabled: () => true, userData: path.join(root, 'ud'), resourcesDir: path.join(root, 'res'),
    workerEntry: 'w.js', fork: () => { const x = fakeWorker(); workers.push(x); return x; }, memoryBaseUrl: () => 'http://127.0.0.1:5555/memory',
    writeCommand: () => path.join(root, 'bin', 'memory'), log: (r) => logs.push(r), vecLoadablePath: () => null, ...over
  });
  return { w, logs, workers };
}

test('WIRING: every install (no mode file) gives an agent MEMORY_TOKEN, the endpoint, its hive and the memory command dir, nothing else; a bad token is 403/exit 5', async () => {
  const root = hive({ 'agents/a1/memory.md': 'm' });
  const { w } = wiring(root, runtime(root));
  const m = w.spawnEnv('a1');
  assert.ok(m, 'memory is on by default');
  assert.equal(m.commandDir, path.join(root, 'bin', 'memory'));
  assert.match(m.env.MEMORY_TOKEN, /^[0-9a-f]{32}$/);
  assert.equal(m.env.MUNDER_MEMORY_URL, 'http://127.0.0.1:5555/memory');
  assert.equal(m.env.MUNDER_HIVE_ROOT, root);
  assert.deepEqual(Object.keys(m.env).sort(), ['MEMORY_TOKEN', 'MUNDER_HIVE_ROOT', 'MUNDER_MEMORY_URL'], 'only these three');
  assert.equal((await w.handle('f'.repeat(32), { cmd: 'status' })).status, 403);
  assert.equal(w.tokens.resolve(m.env.MEMORY_TOKEN), 'a1');
  w.agentExited('a1');
  assert.equal(w.tokens.resolve(m.env.MEMORY_TOKEN), null, 'revoked with the agent');
});

test('WIRING: a leftover mode file from an older build changes nothing: memory stays on', async () => {
  for (const mode of ['legacy', 'fallback-legacy', 'shadow', 'native']) {
    const root = hive({ 'agents/a1/memory.md': 'm', 'memory-engine.json': JSON.stringify({ mode }) });
    const { w } = wiring(root, runtime(root));
    assert.ok(w.spawnEnv('a1'), mode);
  }
});

test('WIRING (Jim M2, fail closed): semantic memory off, no runtime, or a failed command write = null (no memory env, so no prompt line); one log row per reason', async () => {
  const root = hive({ 'agents/a1/memory.md': 'm' });
  const off = wiring(root, { ...runtime(root), enabled: () => false });
  assert.equal(off.w.spawnEnv('a1'), null);
  assert.equal(off.logs.length, 0, 'turned off is a choice, not a fault: no row');
  assert.equal((await off.w.query('status')).exit, EXIT.unavailable);
  const noRt = wiring(root);   // vecLoadablePath null: the runtime is missing
  assert.equal(noRt.w.spawnEnv('a1'), null);
  assert.equal(noRt.w.spawnEnv('a2'), null);
  assert.deepEqual(noRt.logs.map((r) => [r.kind, r.reason]), [['native-memory-unavailable', 'no-runtime']], 'one row, not one per spawn');
  const noCmd = wiring(root, { ...runtime(root), writeCommand: () => null });
  assert.equal(noCmd.w.spawnEnv('a1'), null, 'no memory command on PATH -> no memory');
  assert.deepEqual(noCmd.logs.map((r) => [r.kind, r.reason, r.agentId]), [['native-memory-unavailable', 'command-failed', 'a1']]);
  assert.equal(noCmd.w.tokens.resolve('0'.repeat(32)), null);
});

test('WIRING: query() serves the Memory panel / Command Center as caller `human` through the same validation; there is no token and no HTTP route for it', async () => {
  const root = hive({ 'agents/a1/memory.md': 'm' });
  const { w } = wiring(root, runtime(root));
  const seen = [];
  w.client.request = async (op, args) => { seen.push({ op, args }); return { ok: true, exit: 0, text: 'T\n' }; };
  assert.equal((await w.query('search', { query: 'log rotation', wing: 'jim' })).text, 'T\n');
  assert.deepEqual(seen[0], { op: 'search', args: { query: 'log rotation', wing: 'jim', room: null, results: 5, since: null, before: null, caller: 'human' } });
  assert.equal((await w.query('search', { query: '' })).exit, EXIT.usage);
  await w.query('wake-up', { wing: 'andy' });
  assert.deepEqual(seen[1], { op: 'wake-up', args: { wing: 'andy' } });
  const hooks = fs.readFileSync(path.join(REPO, 'src', 'main', 'hooks.ts'), 'utf8');
  assert.doesNotMatch(hooks, /\.query\(/, 'the HookServer never calls query()');
});

test('WIRING: the vec0 path maps from inside app.asar to app.asar.unpacked (the installed layout nests it under sqlite-vec)', () => {
  assert.equal(toUnpacked('C:\\P\\resources\\app.asar\\node_modules\\sqlite-vec\\node_modules\\sqlite-vec-windows-x64\\vec0.dll'), 'C:\\P\\resources\\app.asar.unpacked\\node_modules\\sqlite-vec\\node_modules\\sqlite-vec-windows-x64\\vec0.dll');
  assert.equal(toUnpacked('/a/app.asar/x.dll'), '/a/app.asar.unpacked/x.dll');
  assert.equal(toUnpacked('C:/dev/node_modules/sqlite-vec-windows-x64/vec0.dll'), 'C:/dev/node_modules/sqlite-vec-windows-x64/vec0.dll', 'dev: unchanged');
});

test('WIRING: the index file is keyed by the hive root (two hives / dev and stable never share one)', () => {
  assert.equal(dbFileFor('U', 'C:\\Dunder\\hive'), dbFileFor('U', 'c:/dunder/hive'));
  assert.notEqual(dbFileFor('U', 'C:/Dunder/hive'), dbFileFor('U', 'C:/Dunder/hive-dev'));
  assert.match(dbFileFor('U', 'C:/x'), /memory[\\/][0-9a-f]{16}\.sqlite$/);
});

// ── HTTP route ────────────────────────────────────────────────────────────

async function server(t) {
  const sock = process.platform === 'win32' ? `\\\\.\\pipe\\nm-${process.pid}-${Math.random().toString(36).slice(2)}` : path.join(dir(), 's.sock');
  const hiveStub = { sockPath: () => sock, codexHomeFor: () => null, recordSession: () => {}, appendLog: () => {}, registry: () => ({ agents: {} }), isGod: () => false, rosterContext: () => '', recordModel: () => {}, appendCostLedger: () => {} };
  const s = new HookServer(hiveStub, () => null, () => ({}), undefined, undefined, undefined, () => {});
  s.start(); t.after(() => s.stop());
  for (let i = 0; i < 200 && s.hookBrokerPort() === null; i++) await new Promise((r) => setTimeout(r, 5));
  return s;
}
function post(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: u.port, path: u.pathname, method: 'POST', headers: { 'content-length': data.length } }, (res) => {
      let o = ''; res.on('data', (d) => { o += d; }); res.on('end', () => resolve({ status: res.statusCode, body: o }));
    });
    req.on('error', reject); req.end(data);
  });
}

test('ROUTE: /memory/<token> reaches the handler with the token and body; no handler = 404; oversize = 413; not a hook route', async (t) => {
  const s = await server(t);
  const base = s.memoryBaseUrl();
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+\/memory$/);
  const tok = 'ab'.repeat(16);
  assert.equal((await post(`${base}/${tok}`, {})).status, 404, 'no handler: the route does not exist');
  const seen = [];
  s.setMemoryHandler(async (token, body) => { seen.push({ token, body }); return { status: 200, body: { exit: 0, text: 'ok' } }; });
  const r = await post(`${base}/${tok}`, { cmd: 'status' });
  assert.deepEqual(JSON.parse(r.body), { exit: 0, text: 'ok' });
  assert.deepEqual(seen, [{ token: tok, body: { cmd: 'status' } }]);
  assert.equal((await post(`${base}/${tok}`, 'x'.repeat(70 * 1024))).status, 413);
  assert.equal((await post(`${base}/nothex`, {})).status, 404);
});

// ── the `memory` command ────────────────────────────────────────────────────

const CLI = path.join(REPO, 'resources', 'memory-cli.cjs');
function loadCli(spawnSyncImpl) {
  const cp = require('node:child_process');
  const real = cp.spawnSync;
  cp.spawnSync = spawnSyncImpl;
  delete require.cache[require.resolve(CLI)];
  try { return require(CLI); } finally { cp.spawnSync = real; }
}
/** Run cli.main with its output captured through the injectable writers (never by patching
 *  process.stdout, which the test runner itself is writing to). */
async function capture(fn) {
  const out = []; const err = [];
  const io = { out: (d) => { out.push(String(d)); return true; }, err: (d) => { err.push(String(d)); return true; } };
  const code = await fn(io);
  return { code, out: out.join(''), err: err.join('') };
}

test('CLI parseArgs: --flag value and --flag=value, a multi-word query; unknown global options are refused', () => {
  const { parseArgs } = loadCli(() => ({}));
  assert.deepEqual(parseArgs(['search', 'log', 'rotation', '--wing', 'w', '--results=3']).args, { wing: 'w', results: 3, query: 'log rotation' });
  assert.equal(parseArgs(['wake-up', '--wing', 'andy']).args.wing, 'andy');
  assert.equal(parseArgs(['status', '--format', 'json']).format, 'json');
  assert.throws(() => parseArgs(['--bogus']), /unknown option/);
  assert.throws(() => parseArgs(['--palace', 'P', 'search', 'x']), /unknown option --palace/, 'no palace option any more');
  assert.throws(() => parseArgs(['search', 'x', '--wing']), /needs a value/);
});

test('CLI: posts to the endpoint and prints its text with its exit; never spawns anything; an unknown command is a named refusal', async (t) => {
  const calls = [];
  const cli = loadCli((bin, argv) => { calls.push({ bin, argv }); return { status: 7 }; });
  const root = hive({});
  const seen = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => {
      seen.push({ url: req.url, body: JSON.parse(b) });
      if (req.url.endsWith('/' + 'cd'.repeat(16))) { res.writeHead(403); res.end('{}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ exit: 0, text: 'NATIVE TEXT\n' }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); t.after(() => srv.close());
  const url = `http://127.0.0.1:${srv.address().port}/memory`;
  const env = (extra = {}) => ({ MUNDER_HIVE_ROOT: root, MUNDER_MEMORY_URL: url, MEMORY_TOKEN: 'ab'.repeat(16), ...extra });
  const n = await capture((io) => cli.main(['search', 'log', 'rotation', '--wing', 'jim'], env(), io));
  assert.deepEqual(n, { code: 0, out: 'NATIVE TEXT\n', err: '' });
  assert.deepEqual(seen[0], { url: `/memory/${'ab'.repeat(16)}`, body: { cmd: 'search', args: { wing: 'jim', query: 'log rotation' } } });
  assert.equal((await capture((io) => cli.main(['wake-up'], env(), io))).code, 0);
  assert.equal((await capture((io) => cli.main(['status'], env({ MEMORY_TOKEN: 'cd'.repeat(16) }), io))).code, 5, '403 -> exit 5');
  const mine = await capture((io) => cli.main(['mine', 'x'], env(), io));
  assert.equal(mine.code, 2);
  assert.match(mine.err, /^memory: unknown command "mine"; use search, wake-up or status/);
  const help = await capture((io) => cli.main(['--help'], env(), io));
  assert.equal(help.code, 0);
  assert.match(help.out, /^usage: memory \{search QUERY/);
  assert.equal(calls.length, 0, 'the command never spawns a process');
  assert.doesNotMatch(fs.readFileSync(CLI, 'utf8'), /child_process|spawnSync|memory-engine\.json|palace/i);
});

test('CLI: app not running = exit 3 with one line of guidance; no endpoint env = exit 3', async () => {
  const cli = loadCli(() => ({}));
  const root = hive({});
  const down = await capture((io) => cli.main(['search', 'q'], { MUNDER_HIVE_ROOT: root, MUNDER_MEMORY_URL: 'http://127.0.0.1:1/memory', MEMORY_TOKEN: 'ab'.repeat(16) }, io));
  assert.equal(down.code, 3);
  assert.equal(down.err.trim().split('\n').length, 1);
  assert.doesNotMatch(down.err, /fallback-legacy/);
  assert.equal((await capture((io) => cli.main(['search', 'q'], { MUNDER_HIVE_ROOT: root }, io))).code, 3);
});

test('CLI on PATH (section 6): the generated wrappers run the command on Electron-as-Node, are rewritten only when changed, and nothing else stays in the dir', () => {
  const { HiveManager } = loadTs('src/main/hive.ts');
  const home = dir();
  const h = new HiveManager(() => home);
  fs.mkdirSync(path.join(home, 'hive', 'bin', 'memory'), { recursive: true });
  // Wrappers an older build left in the dir: removed, so only `memory` resolves from it.
  for (const stale of ['oldcmd', 'oldcmd.cmd']) fs.writeFileSync(path.join(home, 'hive', 'bin', 'memory', stale), 'x');
  const d = h.writeMemoryCommand('C:\\app\\resources\\memory-cli.cjs');
  assert.equal(d, path.join(home, 'hive', 'bin', 'memory'));
  assert.deepEqual(fs.readdirSync(d).sort(), process.platform === 'win32' ? ['memory', 'memory.cmd'] : ['memory']);
  if (process.platform === 'win32') {
    assert.equal(fs.readFileSync(path.join(d, 'memory.cmd'), 'utf8'), `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "C:\\app\\resources\\memory-cli.cjs" %*\r\n`);
    assert.equal(fs.readFileSync(path.join(d, 'memory'), 'utf8'), `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath.replace(/\\/g, '/')}" "C:/app/resources/memory-cli.cjs" "$@"\n`);
  }
  const m0 = fs.statSync(path.join(d, 'memory')).mtimeMs;
  h.writeMemoryCommand('C:\\app\\resources\\memory-cli.cjs');
  assert.equal(fs.statSync(path.join(d, 'memory')).mtimeMs, m0, 'unchanged content is not rewritten');
  h.dispose();
});

// ── parity statistics (gate 4) ────────────────────────────────────────────

test('ZERO PYTHON (and zero child processes) on the native path: the built worker bundle never requires child_process', () => {
  const bundle = path.join(REPO, 'out', 'main', 'memoryWorker.js');
  if (!fs.existsSync(bundle)) return;   // built by `npm run build`; the gate runs after it
  const src = fs.readFileSync(bundle, 'utf8');
  assert.doesNotMatch(src, /require\("(node:)?child_process"\)/);
  assert.doesNotMatch(src, /\bpython\b|\buv tool\b/i);
});

test('MAIN BUDGET (section 3): the synchronous part of a memory request in main (token, mode, validation, post) stays well under 2 ms p95', async () => {
  const root = hive({ 'agents/a1/memory.md': 'm', 'memory-engine.json': '{"mode":"native"}' });
  const { w } = wiring(root);
  w.client.request = () => new Promise(() => {});   // the worker's time is not main's
  const tok = w.tokens.mint('a1');
  const times = [];
  for (let i = 0; i < 400; i++) {
    const t0 = process.hrtime.bigint();
    void w.handle(tok, { cmd: 'search', args: { query: `query ${i}`, results: 5 } });
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  assert.ok(times[Math.floor(times.length * 0.95)] < 2, `p95 ${times[Math.floor(times.length * 0.95)].toFixed(3)} ms`);
});

test('IDLE UNLOAD (Jim R2): every embed re-arms ONE unload timer of MODEL_IDLE_UNLOAD_MS; firing it unloads the model', async () => {
  const { MemoryEngine, MODEL_IDLE_UNLOAD_MS } = loadTs('src/main/nativeMemory/engine.ts');
  const timers = [];
  let unloaded = 0;
  const emb = { loaded: true, embed: async (t) => t.map(() => new Float32Array(384)), unload: async () => { unloaded++; } };
  const store = { search: () => [] };
  let told = 0;
  const e = new MemoryEngine({ hiveRoot: dir(), store, embedder: emb, countTokens: words, mode: () => 'native', watch: null, onModelUnload: () => { told++; },
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); if (ms === 0) setImmediate(fn); return t; }, clearTimer: (t) => { t.cleared = true; } });
  await e.search({ query: 'a' });
  await e.search({ query: 'b' });
  const unloadTimers = timers.filter((t) => t.ms === MODEL_IDLE_UNLOAD_MS);
  assert.equal(unloadTimers.length, 2);
  assert.equal(unloadTimers[0].cleared, true, 're-armed, not stacked');
  unloadTimers[1].fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(unloaded, 1);
  assert.equal(told, 1, 'main is told (N2)');
});

test('ALLOW-LIST: a DIRECTORY named like a Markdown file is not a source', () => {
  const root = hive({ 'agents/a1/memory.md': 'm', 'agents/a1/notes.md/inner.txt': 'x' });
  assert.deepEqual(discoverSources(root).eligible.map((e) => e.path), ['agents/a1/memory.md']);
});

test('SMOKE / BENCH FLAGS are inert unless passed: no flag -> null; index.ts redirects userData and branches ONLY when one is present', () => {
  const { smokeTarget } = loadTs('src/main/nativeMemory/smoke.ts');
  const { benchTarget } = loadTs('src/main/nativeMemory/bench.ts');
  for (const argv of [[], ['app.exe'], ['app.exe', '--native-memory-smoke'], ['app.exe', '--native-memory-bench'], ['app.exe', '--other=1']]) {
    assert.equal(smokeTarget(argv), null, JSON.stringify(argv));
    assert.equal(benchTarget(argv), null, JSON.stringify(argv));
  }
  assert.equal(smokeTarget(['x', '--native-memory-smoke=C:/t/r.json']), 'C:/t/r.json');
  assert.equal(benchTarget(['x', '--native-memory-bench=C:/t/b']), 'C:/t/b');
  const idx = fs.readFileSync(path.join(REPO, 'src', 'main', 'index.ts'), 'utf8');
  assert.match(idx, /const memorySmokeOut = smokeTarget\(process\.argv\);/);
  assert.match(idx, /const memoryBenchDir = benchTarget\(process\.argv\);\r?\nif \(memorySmokeOut \|\| memoryBenchDir\) \{/, 'userData is redirected only when a flag is present');
  assert.match(idx, /app\.whenReady\(\)\.then\(\(\) => \{\r?\n  if \(memoryBenchDir\) \{/, 'the bench branch runs only with the flag');
});

test('CLI parseArgs: a dash-led token with whitespace is query text; `--` ends options; an unknown bare option is unsupported (exit 2)', () => {
  const { parseArgs } = loadCli(() => ({}));
  assert.equal(parseArgs(['search', '--format json --session-id <uuid>']).args.query, '--format json --session-id <uuid>');
  assert.deepEqual(parseArgs(['search', '--format json --session-id <uuid>']).rest, []);
  assert.equal(parseArgs(['search', '--', '--wing']).args.query, '--wing');
  assert.equal(parseArgs(['search', '--', '--wing']).args.wing, undefined);
  assert.deepEqual(parseArgs(['search', '--native-memory-smoke=']).rest, ['--native-memory-smoke='], 'unknown option: rejected');
});
