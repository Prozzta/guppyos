'use strict';
/**
 * CL-M4-WP step 3 (design §2): the per-agent search-result log (source 2) and the deterministic
 * candidate collection / RRF ranking the note CLI calls. All texts and ids are invented.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const SL = loadTs('src/main/claims/searchLog.ts');
const C = loadTs('src/main/claims/candidates.ts');
const { NativeMemoryWiring } = loadTs('src/main/nativeMemory/mainWiring.ts');

const H = 3600_000;
const T0 = Date.parse('2026-10-04T12:00:00.000Z');
const id = (n) => `c-${String(n).padStart(12, '0')}`;
const jail = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claims-wp-'));
const hit = (n, wing = 'a1', extra = {}) => ({ chunkId: n, wing, room: 'claims', source: 'claim', cosineSim: 0.5, bm25: -1, claimId: id(n), status: 'live', ...extra });

test('search log: ids only, per agent, 6 h retention (pruned on write, ignored on read)', (t) => {
  const root = jail(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let now = T0;
  const log = new SL.SearchResultLog({ hiveRoot: () => root, now: () => new Date(now) });
  // A hit carrying text (as an unredacted one would) logs its id and wing only.
  assert.deepEqual(log.record('a1', [hit(1, 'a1', { content: 'INVENTED-SECRET-TEXT' }), hit(2, 'b9'), { chunkId: 3, wing: 'a1' }, hit(1)]), [{ id: id(1), wing: 'a1' }, { id: id(2), wing: 'b9' }]);
  const raw = fs.readFileSync(log.file('a1'), 'utf8');
  assert.equal(raw.includes('INVENTED-SECRET-TEXT'), false, 'never hit text');
  assert.deepEqual(Object.keys(JSON.parse(raw.trim())).sort(), ['at', 'hits']);
  // Isolation: another agent's log is its own file, and empty.
  assert.deepEqual(log.hitsSince('a2', new Date(now)), []);
  assert.equal(fs.existsSync(log.file('a2')), false);
  assert.deepEqual(log.record('human', [hit(5)]), [], 'the renderer is not logged');
  assert.deepEqual(log.record('../x', [hit(5)]), [], 'a bad agent id is not a path');
  assert.deepEqual(log.record('a1', []), [], 'a search with no claim hit writes nothing');
  now = T0 + 2 * H;
  log.record('a1', [hit(3), hit(1)]);
  // Newest sighting first, each id once.
  assert.deepEqual(log.hitsSince('a1', new Date(now)).map((h) => [h.id, h.at]), [[id(3), new Date(T0 + 2 * H).toISOString()], [id(1), new Date(T0 + 2 * H).toISOString()], [id(2), new Date(T0).toISOString()]]);
  // A read at T0 + 6h + 1 ms no longer sees the first search; a read before the second does not see it.
  assert.deepEqual(log.hitsSince('a1', new Date(T0 + 6 * H + 1)).map((h) => h.id), [id(3), id(1)]);
  assert.deepEqual(log.hitsSince('a1', new Date(T0 + H)).map((h) => h.id), [id(1), id(2)], 'nothing from the future');
  assert.deepEqual(log.hitsSince('a1', new Date(T0 + 6 * H)).map((h) => h.id), [id(3), id(1), id(2)], 'exactly 6 h is inside');
  // A write after the window drops the expired row from the FILE.
  now = T0 + 7 * H;
  log.record('a1', [hit(4)]);
  const rows = fs.readFileSync(log.file('a1'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(rows.map((r) => r.at), [new Date(T0 + 2 * H).toISOString(), new Date(T0 + 7 * H).toISOString()]);
  // A torn line and a foreign row are skipped, not fatal.
  fs.appendFileSync(log.file('a1'), '{"at":\n{"at":"2026-10-04T19:00:00.000Z","hits":[{"id":"nope","wing":"a1"}]}\n');
  assert.deepEqual(log.hitsSince('a1', new Date(now)).map((h) => h.id), [id(4), id(3), id(1)]);
});

test('wiring: an agent\'s search reply is logged under its TOKEN agent; other verbs and failures are not', async (t) => {
  const root = jail(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const w = new NativeMemoryWiring({
    hiveRoot: () => root, enabled: () => true, userData: root, resourcesDir: path.join(root, 'none'), workerEntry: 'none',
    fork: () => { throw new Error('no worker'); }, memoryBaseUrl: () => null, writeCommand: () => null, log: () => undefined, vecLoadablePath: () => null,
    searchLog: { record: (a, j) => { calls.push([a, j]); } }
  });
  let reply = { ok: true, exit: 0, text: 'x', json: [hit(7)] };
  w.run = async () => reply;
  const tok = w.tokens.mint('a1');
  await w.handle(tok, { cmd: 'search', args: { query: 'q', agent: 'a2' } });
  assert.deepEqual(calls, [['a1', [hit(7)]]]);
  await w.handle(tok, { cmd: 'wake-up', args: {} });
  reply = { ok: false, exit: 3, error: 'unavailable' };
  await w.handle(tok, { cmd: 'search', args: { query: 'q' } });
  assert.equal(calls.length, 1, 'only a successful search');
  await w.query('search', { query: 'q' });
  assert.equal(calls.length, 1, 'the renderer\'s internal query is not an agent search');
});

const claim = (n, o = {}) => ({ id: id(n), owner: 'a1', wt: new Date(T0 - n * 60_000).toISOString(), text: `invented note ${n}`, status: 'live', ...o });

test('rankCandidates: RRF k = 60 over the two orders; ties by newest wt, then id; top 3', () => {
  const pool = [claim(1), claim(2), claim(3), claim(4), claim(5)];
  // 3: lex #1 + vec #2; 1: lex #2 + vec #1; 4: vec #3 only; 2, 5: nowhere.
  const r = C.rankCandidates(pool, { lexical: [id(3), id(1), 'c-ffffffffffff', id(3)], vector: [id(1), id(3), id(4)] });
  assert.deepEqual(r.map((c) => c.id), [id(1), id(3), id(4)], '1 and 3 tie on score; 1 is newer');
  assert.equal(r[0].score, 1 / 61 + 1 / 62);
  assert.equal(r[2].score, 1 / 63, 'an id outside the pool and a repeat do not take a rank');
  assert.deepEqual(r.map((c) => c.rank), [1, 2, 3]);
  // Zero scores: newest wt first, then id.
  const same = [claim(9, { wt: new Date(T0).toISOString() }), claim(8, { wt: new Date(T0).toISOString() }), claim(7)];
  assert.deepEqual(C.rankCandidates(same, { lexical: [], vector: [] }).map((c) => c.id), [id(8), id(9), id(7)]);
  assert.equal(C.rankCandidates(pool, { lexical: [], vector: [] }, 2).length, 2);
});

test('bm25Order: FTS5-like (rare terms weigh more, longer docs less, non-matching omitted); cosineOrder', () => {
  const docs = [
    { id: 'a', text: 'the build cache is warm' },
    { id: 'b', text: 'the zebra cache' },
    { id: 'c', text: 'nothing relevant here at all' },
    { id: 'd', text: 'the zebra cache was cold and the zebra left a very long trail behind it today' }
  ];
  assert.deepEqual(C.bm25Order('Zebra caché', docs), ['b', 'd', 'a'], 'zebra is rarer than cache; d is longer');
  assert.deepEqual(C.bm25Order('!! ?', docs), []);
  // IDF from a given corpus: a common term repeated loses to one rare term.
  const corpus = C.bm25Corpus([...Array(20)].map((_, i) => `cache filler ${i}`).concat(['zebra']));
  assert.deepEqual(C.bm25Order('zebra cache', [{ id: 'e', text: 'cache cache cache' }, { id: 'f', text: 'zebra' }], corpus), ['f', 'e']);
  assert.deepEqual(C.queryTerms('a b2 foo_bar Foo'), ['b2', 'foo', 'bar']);
  assert.deepEqual(C.cosineOrder([1, 0], [{ id: 'x', vec: [0, 1] }, { id: 'y', vec: [2, 0.1] }, { id: 'z', vec: [1, 1] }]), ['y', 'z', 'x']);
});

test('collectNoteCandidates: three sources, live only, never self, 6 h window, exclusions named', async () => {
  const at = new Date(T0);
  const all = new Map([
    [id(1), claim(1)],
    [id(2), claim(2, { status: 'superseded' })],
    [id(3), claim(3, { owner: 'b9' })],
    [id(4), claim(4, { status: 'superseded?' })],
    [id(5), claim(5)],
    [id(6), claim(6, { wt: new Date(T0 - 7 * H).toISOString() })],
    [id(10), claim(10, { owner: 'b9', wt: new Date(T0 + 60_000).toISOString() })]
  ]);
  const deps = {
    ownClaims: () => [all.get(id(1)), all.get(id(2)), all.get(id(5)), all.get(id(6))],
    searchHits: () => [{ id: id(3), wing: 'b9' }, { id: id(1), wing: 'a1' }, { id: id(4), wing: 'a1' }, { id: id(10), wing: 'b9' }],
    resolve: (hits) => hits.map((h) => all.get(h.id)).filter(Boolean),
    score: (q, pool) => ({ lexical: pool.map((c) => c.id).sort(), vector: [] })
  };
  const r = await C.collectNoteCandidates(deps, 'a1', 'invented new note', at, { excludeIds: [id(5)] });
  // Jim S1: another agent's claim is a REFERENCE, never a replace candidate.
  assert.deepEqual(r.candidates.map((c) => [c.id, c.sources, c.owner, c.replaceable]), [[id(1), ['own', 'search'], 'a1', true]]);
  assert.deepEqual(r.references.map((c) => [c.id, c.sources, c.owner, c.replaceable]), [[id(3), ['search'], 'b9', false]]);
  assert.equal(r.pool, 2, 'superseded, superseded?, self (5), older than 6 h (6) and later than the write (10) are out');
  assert.deepEqual(r.excluded, [{ source: 'working-set', reason: 'unwired' }]);
  assert.equal(r.ranking, 'rrf');
  // A source that throws is excluded as an error; the others still answer. A failed scorer falls back to recency.
  const r2 = await C.collectNoteCandidates({ ...deps, searchHits: () => { throw new Error('x'); }, workingSetIds: () => [{ id: id(3), wing: 'b9' }], score: () => { throw new Error('y'); } }, 'a1', 'q', at);
  assert.deepEqual(r2.excluded, [{ source: 'search', reason: 'error' }]);
  assert.deepEqual(r2.candidates.map((c) => [c.id, c.sources, c.rank]), [[id(1), ['own'], 1], [id(5), ['own'], 2]]);
  assert.deepEqual(r2.references.map((c) => [c.id, c.sources]), [[id(3), ['working-set']]]);
  // A reference shows only where it ranks inside the overall top: with top 1, id(3) (2nd) does not.
  const r2b = await C.collectNoteCandidates({ ...deps, searchHits: undefined, workingSetIds: () => [{ id: id(3), wing: 'b9' }], score: () => { throw new Error('y'); } }, 'a1', 'q', at, { top: 1 });
  assert.deepEqual([r2b.candidates.map((c) => c.id), r2b.references], [[id(1)], []]);
  assert.equal(r2.ranking, 'recency');
  const r3 = await C.collectNoteCandidates({ ...deps, ownClaims: () => { throw new Error('torn'); }, searchHits: undefined }, 'a1', 'q', at);
  assert.deepEqual([r3.candidates, r3.excluded], [[], [{ source: 'own', reason: 'error' }, { source: 'search', reason: 'unwired' }, { source: 'working-set', reason: 'unwired' }]]);
});

test('display: excerpt one line <= 80 chars, title is the key or the first words', () => {
  const long = 'word '.repeat(40) + '\n second line';
  const e = C.excerptOf(long);
  assert.equal(e.length <= 80, true);
  assert.equal(e.endsWith('…'), true);
  assert.equal(e.includes('\n'), false);
  assert.equal(C.excerptOf('short  text\n x'), 'short text x');
  assert.equal(C.titleOf({ key: 'fact.invented', text: 'x' }), 'fact.invented');
  assert.equal(C.titleOf({ text: long }).length <= 48, true);
});

test('ledgerCandidateDeps: own claims by wt from the verified ledger, search hits resolved in their owner\'s ledger', async () => {
  const views = {
    a1: { claims: [{ id: id(1), agent: 'a1', wt: new Date(T0 - H).toISOString(), key: 'fact.x', text: 'invented one' }, { id: id(2), agent: 'a1', wt: new Date(T0 - 8 * H).toISOString(), text: 'invented old' }], status: (x) => (x === id(1) ? 'live' : 'live') },
    b9: { claims: [{ id: id(3), agent: 'b9', wt: new Date(T0 - 2 * H).toISOString(), text: 'invented other' }], status: () => 'superseded' }
  };
  const d = C.ledgerCandidateDeps({ ledger: (a) => views[a] ?? null, searchLog: { hitsSince: () => [{ id: id(3), wing: 'b9' }, { id: id(9), wing: 'zz' }] }, score: () => ({ lexical: [], vector: [] }) });
  // Jim S3: the window is applied once, by collectNoteCandidates (id(2), 8 h old, is filtered there).
  assert.deepEqual(d.ownClaims('a1', new Date(T0 - 6 * H), new Date(T0)).map((c) => [c.id, c.key, c.status]), [[id(1), 'fact.x', 'live'], [id(2), undefined, 'live']]);
  assert.deepEqual(d.resolve(d.searchHits('a1', new Date(T0))).map((c) => [c.id, c.owner, c.status]), [[id(3), 'b9', 'superseded']]);
  assert.throws(() => d.ownClaims('nobody', new Date(0), new Date(T0)), /not verified/);
  assert.equal(C.ledgerCandidateDeps({ ledger: () => null, score: () => ({ lexical: [], vector: [] }) }).searchHits, undefined, 'no log: unwired');
  const r = await C.collectNoteCandidates(d, 'a1', 'q', new Date(T0));
  assert.deepEqual(r.candidates.map((c) => c.id), [id(1)], 'the 8 h old claim is out of the window');
  assert.deepEqual(r.references, [], 'the superseded search hit is not offered, not even for reference');
});

test('embed: main-internal worker verb with bounds; embedViaWorker batches; a failure falls back to recency, exclusions intact', async (t) => {
  const root = jail(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const M = loadTs('src/main/nativeMemory/mainWiring.ts');
  const w = new NativeMemoryWiring({
    hiveRoot: () => root, enabled: () => true, userData: root, resourcesDir: path.join(root, 'none'), workerEntry: 'none',
    fork: () => { throw new Error('no worker'); }, memoryBaseUrl: () => null, writeCommand: () => null, log: () => undefined, vecLoadablePath: () => null
  });
  const sent = [];
  w.unavailable = () => null;
  w.client.request = async (op, args) => { sent.push([op, args.texts.length]); return { ok: true, exit: 0, json: args.texts.map((x) => [x.length, 1]) }; };
  for (const bad of [[], [7], Array(M.EMBED_MAX_TEXTS + 1).fill('x'), ['y'.repeat(M.EMBED_MAX_CHARS + 1)]]) {
    assert.equal((await w.embed(bad)).ok, false, `refused: ${bad.length}`);
  }
  assert.deepEqual(sent, [], 'nothing invalid reaches the worker');
  assert.deepEqual((await w.embed(['ab', 'c'])).json, [[2, 1], [1, 1]]);
  w.unavailable = () => 'disabled';
  assert.equal((await w.embed(['ab'])).ok, false);
  // The worker answers 'embed' with its MiniLM embedder, vectors as plain arrays.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'nativeMemory', 'worker.ts'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(src, /case 'embed': \{[\s\S]{0,400}guard\(engine\.embedTexts\(texts\), \(vs\) => \(\{ exit: 0, json: vs\.map\(\(v\) => Array\.from\(v\)\) \}\)\);/);
  // embedViaWorker: batches, and any failed or short reply throws.
  const calls = [];
  const e = C.embedViaWorker(async (texts) => { calls.push(texts.length); return { ok: true, json: texts.map(() => [1, 0]) }; }, 2);
  assert.equal((await e(['a', 'b', 'c'])).length, 3);
  assert.deepEqual(calls, [2, 1]);
  await assert.rejects(C.embedViaWorker(async () => ({ ok: false, error: 'down' }))(['a']), /embed failed: down/);
  await assert.rejects(C.embedViaWorker(async () => ({ ok: true, json: [] }))(['a']), /embed failed/);
  // Live scorer with a failing worker: recency ranking, sources and exclusions still reported.
  const deps = { ownClaims: () => [claim(1), claim(2)], resolve: () => [], score: C.makeLocalScorer(C.embedViaWorker(async () => ({ ok: false, error: 'down' }))) };
  const r = await C.collectNoteCandidates(deps, 'a1', 'q', new Date(T0));
  assert.deepEqual([r.ranking, r.candidates.map((c) => c.id), r.excluded.map((x) => x.source)], ['recency', [id(1), id(2)], ['search', 'working-set']]);
  // A working scorer ranks by both orders.
  const ok = C.makeLocalScorer(async (texts) => texts.map((x) => (x.includes('zebra') ? [1, 0] : [0, 1])));
  const s = await ok('zebra', [claim(1, { text: 'plain' }), claim(2, { text: 'a zebra' })]);
  assert.deepEqual([s.lexical, s.vector[0]], [[id(2)], id(2)]);
});

test('Jim M1: the live scorer ranks with HIVE-WIDE document statistics; pool-only statistics would order wrongly', async () => {
  // Hive: 'cache' is in almost every live claim, 'zebra' in one. Pool of 2: e repeats the common
  // term, f has the rare one. In a pool of 2 every idf floors, so tf alone decides: e first (wrong).
  const filler = [...Array(30)].map((_, i) => ({ id: id(100 + i), agent: 'b9', wt: new Date(T0 - 9 * H).toISOString(), text: `cache note ${i}` }));
  const pool = [
    { id: id(1), agent: 'a1', wt: new Date(T0 - H).toISOString(), text: 'cache cache cache' },
    { id: id(2), agent: 'a1', wt: new Date(T0 - 2 * H).toISOString(), text: 'zebra' }
  ];
  const views = {
    a1: { claims: pool, status: () => 'live' },
    b9: { claims: filler.concat([{ id: id(99), agent: 'b9', wt: filler[0].wt, text: 'retired zebra cache', }]), status: (x) => (x === id(99) ? 'superseded' : 'live') }
  };
  const hc = new C.HiveCorpus({ agents: () => ['a1', 'b9'], ledger: (a) => views[a] ?? null });
  const stats = hc.corpus();
  assert.deepEqual([stats.n, stats.df.get('zebra'), stats.df.get('cache')], [32, 1, 31], 'live claims only: the superseded one is not counted');
  // The vector order also prefers f (2). With hive df BM25 agrees: f is first on both orders. With
  // pool df BM25 prefers e (1): one first place each, an RRF tie that recency gives to e.
  const flat = async (texts) => texts.map((x) => (x.includes('zebra') ? [1, 0.1] : [0.1, 1]));
  const asPool = await C.makeLocalScorer(flat)('zebra cache', pool.map((c) => ({ ...c, owner: c.agent, status: 'live' })));
  assert.deepEqual(asPool.lexical, [id(1), id(2)], 'pool-only df: the common term repeated wins (the defect)');
  const deps = C.ledgerCandidateDeps({ ledger: (a) => views[a] ?? null, score: C.makeLocalScorer(flat, () => hc.corpus()) });
  const r = await C.collectNoteCandidates(deps, 'a1', 'zebra cache', new Date(T0));
  assert.deepEqual(r.candidates.map((c) => c.id), [id(2), id(1)], 'hive-wide df: the rare term wins');
  // Cached per agent: an unchanged ledger is not re-counted; a changed one is.
  let reads = 0;
  const hc2 = new C.HiveCorpus({ agents: () => ['a1'], ledger: (a) => { reads++; return views[a]; } });
  const s1 = hc2.corpus(); views.a1 = { claims: pool.concat([{ id: id(3), agent: 'a1', wt: pool[0].wt, text: 'zebra' }]), status: () => 'live' };
  const s2 = hc2.corpus();
  assert.deepEqual([s1.n, s2.n, s2.df.get('zebra'), reads], [2, 3, 2, 2]);
  // A corpus that throws makes the scorer throw: recency ranking, never silent pool statistics.
  const bad = C.ledgerCandidateDeps({ ledger: (a) => views[a] ?? null, score: C.makeLocalScorer(flat, () => { throw new Error('no stats'); }) });
  assert.equal((await C.collectNoteCandidates(bad, 'a1', 'zebra', new Date(T0))).ranking, 'recency');
});

test('Jim S2: the worker embed goes through the engine queue (search priority) and re-arms the idle unload', async (t) => {
  const root = jail(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { MemoryEngine, MODEL_IDLE_UNLOAD_MS, PRIORITY } = loadTs('src/main/nativeMemory/engine.ts');
  const timers = [];
  const emb = { loaded: true, embed: async (ts) => ts.map(() => new Float32Array([1, 2])), unload: async () => {} };
  const e = new MemoryEngine({ hiveRoot: root, store: { search: () => [] }, embedder: emb, countTokens: (x) => x.split(' ').length, mode: () => 'native', watch: null,
    setTimer: (fn, ms) => { const tm = { fn, ms }; timers.push(tm); if (ms === 0) setImmediate(fn); return tm; }, clearTimer: () => {} });
  const prios = [];
  const orig = e.enqueue.bind(e);
  e.enqueue = (p, fn) => { prios.push(p); return orig(p, fn); };
  const vs = await e.embedTexts(['a', 'b']);
  assert.deepEqual([vs.length, prios], [2, [PRIORITY.search]]);
  assert.equal(timers.filter((x) => x.ms === MODEL_IDLE_UNLOAD_MS).length, 1, 'the idle unload is armed');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'nativeMemory', 'worker.ts'), 'utf8');
  assert.match(src, /guard\(engine\.embedTexts\(texts\)/, 'the worker routes embed through the engine');
});
