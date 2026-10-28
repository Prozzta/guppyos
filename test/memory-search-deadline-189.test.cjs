'use strict';
/**
 * MEMORY-SEARCH-TIMEOUT-DURING-INDEX-189 (Jim 5b76db): during a 1757-part claims sync, 1 of 84
 * searches got "memory search timed out after <warm> ms" (exit 4; 250 ms then, SEARCH_DEADLINE_WARM_MS now), and nothing logged it.
 *   A  every degraded reply writes one log row (capped), and a late reply says where the time went;
 *   B  while the worker reports indexing, a warm search gets SEARCH_DEADLINE_INDEXING_MS;
 *   C  a search whose deadline passed while it was queued is answered expired, never run.
 * T1 the client (fake worker, fake clock), T2 the engine queue (fakes), T3 the reproduction: the
 * real worker and client, a loaded machine (test/memory-search-deadline/scenario.cjs).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'msd-189-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
test.after(() => {
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const loadTs = require('./load-ts.cjs');
const { NativeMemoryClient, EXIT, SEARCH_DEADLINE_WARM_MS, SEARCH_DEADLINE_COLD_MS, SEARCH_DEADLINE_INDEXING_MS, DEGRADED_LOG_EVERY_MS } = loadTs('src/main/nativeMemory/service.ts');
const { MemoryEngine, QueueExpired } = loadTs('src/main/nativeMemory/engine.ts');
const { askWaitMs } = loadTs('src/main/nativeMemory/worker.ts');

function fakeWorker() {
  const w = { posted: [], handlers: { message: [], exit: [] } };
  w.postMessage = (m) => w.posted.push(m);
  w.on = (ev, fn) => w.handlers[ev].push(fn);
  w.kill = () => true;
  w.reply = (m) => w.handlers.message.forEach((f) => f(m));
  w.exit = (c) => w.handlers.exit.forEach((f) => f(c));
  return w;
}

function rig() {
  const r = { now: 1000, timers: [], rows: [], workers: [] };
  r.client = new NativeMemoryClient({
    fork: () => { const w = fakeWorker(); r.workers.push(w); return w; },
    config: () => ({ hiveRoot: 'h' }), now: () => r.now, log: (row) => r.rows.push(row),
    setTimer: (fn, ms) => { const t = { fn, at: r.now + ms, cleared: false }; r.timers.push(t); return t; }, clearTimer: (t) => { t.cleared = true; }
  });
  r.w = () => r.workers.at(-1);
  r.last = () => r.w().posted.at(-1);
  /** Fire the live timer that is due at `at`. */
  r.fire = (at) => { const t = r.timers.find((x) => !x.cleared && !x.fired && x.at === at); assert.ok(t, `a live timer at ${at}`); t.fired = true; t.fn(); };
  /** One answered request makes the client warm. */
  r.warmUp = async () => { const p = r.client.request('search', { query: 'w' }); r.w().reply({ id: r.last().id, ok: true, exit: 0, text: 'T' }); await p; };
  return r;
}

const degradedRows = (r) => r.rows.filter((x) => x.kind === 'native-memory-degraded');

test('T1 (A): a search that times out writes ONE degraded row; its late reply writes a late-reply row with the worker timing, once', async () => {
  const r = rig();
  await r.warmUp();
  assert.deepEqual(r.rows, [], 'a good reply writes nothing');
  const p = r.client.request('search', { query: 'x' });
  const req = r.last();
  assert.equal(req.deadline, r.now + SEARCH_DEADLINE_WARM_MS, 'quiet worker: the warm budget is unchanged');
  r.now += SEARCH_DEADLINE_WARM_MS;
  r.fire(r.now);
  const got = await p;
  assert.equal(got.exit, EXIT.degraded);
  assert.equal(got.error, `memory search timed out after ${SEARCH_DEADLINE_WARM_MS} ms`);
  assert.deepEqual(degradedRows(r), [{ kind: 'native-memory-degraded', op: 'search', reason: 'deadline', budgetMs: SEARCH_DEADLINE_WARM_MS, warm: true, indexing: false, elapsedMs: SEARCH_DEADLINE_WARM_MS }]);
  r.now += 40;
  r.w().reply({ id: req.id, ok: true, exit: 0, text: 'T', timing: { waitMs: SEARCH_DEADLINE_WARM_MS - 20, runMs: 60, inFlight: 'ingest' } });
  // Past the rate cap (Jim S2): a second late row would be written, so 'once' is the code's doing.
  r.now += DEGRADED_LOG_EVERY_MS;
  r.w().reply({ id: req.id, ok: true, exit: 0, text: 'T' });
  assert.deepEqual(r.rows.filter((x) => x.kind === 'native-memory-late-reply'),
    [{ kind: 'native-memory-late-reply', op: 'search', budgetMs: SEARCH_DEADLINE_WARM_MS, lateByMs: 40, ok: true, waitMs: SEARCH_DEADLINE_WARM_MS - 20, runMs: 60, inFlight: 'ingest' }]);
});

test('WARM-500 (the Human, via Jim 06b032): the warm budget is 500 ms; a card-lead ask main answers after 300 ms is printed WITH its brief, exit 0, no row', async () => {
  assert.equal(SEARCH_DEADLINE_WARM_MS, 500, 'MUTANT: the warm budget is the ruled 0.5 s');
  const r = rig();
  await r.warmUp();
  const p = r.client.request('search', { query: 'foo-7 status' });
  const req = r.last();
  assert.equal(req.deadline, r.now + 500, 'the warm search carries a 500 ms deadline');
  assert.equal(askWaitMs(req.deadline, r.now), 500, 'the card-lead ask waits the whole 500 ms (askWaitMs follows the search deadline)');
  r.now += 300;
  const BRIEF = 'foo-7\n  status: doing\n[1] hit';
  r.w().reply({ id: req.id, ok: true, exit: 0, text: BRIEF, timing: { waitMs: 300, runMs: 10 } });
  const got = await p;
  assert.deepEqual([got.exit, got.text], [EXIT.ok, BRIEF], 'printed with its brief, exit 0 (under 250 ms this was exit 4)');
  assert.deepEqual(r.rows, [], 'no degraded or late row');
  assert.ok(r.timers.find((t) => t.at === req.deadline).cleared, 'the deadline timer is cleared by the reply');
});

test('T1 (B): while the worker reports indexing, a warm search gets SEARCH_DEADLINE_INDEXING_MS; after it, the warm budget again; cold stays cold; the event is state, not a row', async () => {
  assert.equal(SEARCH_DEADLINE_INDEXING_MS, 1_000);
  assert.ok(SEARCH_DEADLINE_INDEXING_MS > SEARCH_DEADLINE_WARM_MS && SEARCH_DEADLINE_INDEXING_MS < SEARCH_DEADLINE_COLD_MS);
  const r = rig();
  void r.client.request('status', {}, 2_000);
  r.w().reply({ event: 'indexing', on: true, kind: 'backfill' });
  void r.client.request('search', { query: 'c' });
  assert.equal(r.last().deadline, r.now + SEARCH_DEADLINE_COLD_MS, 'a cold worker keeps the cold budget even while indexing');
  r.w().reply({ id: r.last().id, ok: true, exit: 0, text: 'T' });
  void r.client.request('search', { query: 'i' });
  assert.equal(r.last().deadline, r.now + SEARCH_DEADLINE_INDEXING_MS, 'warm and indexing: 1000 ms');
  void r.client.request('wake-up', {}, 8_000);
  assert.equal(r.last().deadline, r.now + 8_000, 'an explicit deadline is never changed');
  r.w().reply({ event: 'indexing', on: false, kind: 'backfill' });
  void r.client.request('search', { query: 'q' });
  assert.equal(r.last().deadline, r.now + SEARCH_DEADLINE_WARM_MS, 'indexing over: the warm budget');
  // Main sent a claims sync (or a backfill, or a level change): indexing from the send, before the
  // worker's event can arrive; and no longer once it is answered.
  for (const op of ['claims-sync', 'backfill', 'claim-ledger']) {
    void r.client.request(op, {}, 120_000);
    const idx = r.last().id;
    void r.client.request('search', { query: op });
    assert.equal(r.last().deadline, r.now + SEARCH_DEADLINE_INDEXING_MS, `${op} outstanding: 1000 ms`);
    r.w().reply({ id: idx, ok: true, exit: 0 });
    void r.client.request('search', { query: op });
    assert.equal(r.last().deadline, r.now + SEARCH_DEADLINE_WARM_MS, `${op} answered: the warm budget`);
  }
  assert.deepEqual(r.rows, [], 'indexing events are not log rows');
});

test('T1 (A): expired, error, worker-exit and unavailable each write a row with their reason; a usage reply writes none', async () => {
  const r = rig();
  await r.warmUp();
  let p = r.client.request('search', { query: 'e' });
  r.w().reply({ id: r.last().id, ok: false, exit: 4, error: 'expired', timing: { waitMs: 300, runMs: 0, inFlight: 'claims' } });
  assert.equal((await p).exit, EXIT.degraded);
  r.now += DEGRADED_LOG_EVERY_MS;
  p = r.client.request('search', { query: 'f' });
  r.w().reply({ id: r.last().id, ok: false, exit: 4, error: 'SQLITE_BUSY' });
  await p;
  // Past the rate cap (Jim S2): an 'error' row for the usage reply would be written.
  r.now += DEGRADED_LOG_EVERY_MS;
  p = r.client.request('nope', {}, 2_000);
  r.w().reply({ id: r.last().id, ok: false, exit: 2, error: 'unknown op nope' });
  assert.equal((await p).exit, 2);
  p = r.client.request('status', {}, 2_000);
  r.w().exit(1);
  assert.equal((await p).error, 'memory worker exited');
  const none = new NativeMemoryClient({ fork: () => fakeWorker(), config: () => null, log: (row) => r.rows.push(row), now: () => r.now });
  assert.equal((await none.request('search', { query: 'u' })).exit, EXIT.unavailable);
  assert.deepEqual(degradedRows(r).map((x) => [x.reason, x.op, x.error ?? null, x.waitMs ?? null]), [
    ['expired', 'search', 'expired', 300], ['error', 'search', 'SQLITE_BUSY', null], ['worker-exit', 'status', null, null], ['unavailable', 'search', 'native memory is not configured', null]]);
});

test('T1 (A): at most one row per reason per DEGRADED_LOG_EVERY_MS; the next row counts the suppressed ones', async () => {
  const r = rig();
  await r.warmUp();
  const timeOut = async () => { const p = r.client.request('search', { query: 'x' }); r.fire(r.now + SEARCH_DEADLINE_WARM_MS); await p; };
  await timeOut(); await timeOut(); await timeOut();
  assert.equal(degradedRows(r).length, 1, 'a burst writes one row');
  r.now += DEGRADED_LOG_EVERY_MS;
  await timeOut();
  assert.deepEqual(degradedRows(r).map((x) => x.suppressed ?? 0), [0, 2]);
});

test('T1 (B, Jim N2): a worker that exits while indexing leaves no indexing behind (its worker-exit row says indexing false)', async () => {
  const r = rig();
  await r.warmUp();
  r.w().reply({ event: 'indexing', on: true, kind: 'backfill' });
  const p = r.client.request('status', {}, 2_000);
  r.w().exit(1);
  assert.equal((await p).error, 'memory worker exited');
  assert.deepEqual(degradedRows(r).map((x) => [x.reason, x.op, x.indexing]), [['worker-exit', 'status', false]]);
});

test('T1 (A, Jim N3): main remembers at most 64 timed-out requests for late-reply rows; the oldest is forgotten first', async () => {
  const r = rig();
  await r.warmUp();
  const ids = [];
  for (let i = 0; i < 65; i++) {
    const p = r.client.request('search', { query: `t${i}` });
    ids.push(r.last().id);
    r.fire(r.now + SEARCH_DEADLINE_WARM_MS);
    await p;
  }
  const late = () => r.rows.filter((x) => x.kind === 'native-memory-late-reply').length;
  r.now += DEGRADED_LOG_EVERY_MS;
  r.w().reply({ id: ids[0], ok: true, exit: 0, text: 'T' });
  assert.equal(late(), 0, 'the 65th timeout dropped the first one');
  r.w().reply({ id: ids[1], ok: true, exit: 0, text: 'T' });
  assert.equal(late(), 1, 'the second one is still remembered');
});

// ── T2: the engine queue ────────────────────────────────────────────────────────────

const words = (t) => t.split(/\s+/).filter(Boolean).length;
function engineRig(extra = {}) {
  const e = { now: 1000, events: [], embedded: [], gates: [] };
  const embedder = { loaded: true, unload: async () => {},
    embed: (texts) => { e.embedded.push(...texts); return new Promise((res) => e.gates.push(() => res(texts.map(() => new Float32Array(384))))); } };
  e.dir = fs.mkdtempSync(path.join(JAIL, 'eng-'));
  e.engine = new MemoryEngine({ hiveRoot: e.dir, store: { search: () => [], setMeta() {}, sourceShas: () => new Map() }, embedder, countTokens: words, watch: null,
    now: () => e.now, onIndexing: (on, kind) => e.events.push(`${on ? 'on' : 'off'}:${kind}`),
    setTimer: (fn, ms) => { if (ms === 0) setImmediate(fn); return {}; }, clearTimer: () => {}, ...extra });
  e.tick = () => new Promise((r) => setImmediate(r));
  return e;
}

test('T2 (C): a search whose deadline passed while it was queued is answered QueueExpired with its timing and is never run; the one that ran reports its timing', async () => {
  const e = engineRig();
  const t1 = [];
  const s1 = e.engine.search({ query: 'first' }, { deadline: 5000, timing: (t) => t1.push(t) });
  await e.tick();
  const s2 = e.engine.search({ query: 'second' }, { deadline: 1100 });
  // Two expired in a row (Jim N3): every expired task at the head is skipped, not only the first.
  const s2b = e.engine.search({ query: 'second-b' }, { deadline: 1150 });
  const s3 = e.engine.search({ query: 'third' }, { deadline: 5000 });
  e.now = 1200;
  e.gates.shift()();
  assert.equal((await s1).exit, 0);
  assert.deepEqual(t1, [{ waitMs: 0, runMs: 200, inFlight: null }]);
  await assert.rejects(s2, (err) => err instanceof QueueExpired && err.message === 'expired' && err.timing.waitMs === 200 && err.timing.runMs === 0 && err.timing.inFlight === 'search');
  const s2bOut = await Promise.race([s2b.then(() => 'ran', (err) => err), e.tick().then(() => 'still queued or running')]);
  assert.ok(s2bOut instanceof QueueExpired && s2bOut.timing.runMs === 0, `the second expired search too: ${s2bOut}`);
  for (let i = 0; i < 5 && !e.gates.length; i++) await e.tick();
  e.gates.shift()();
  assert.equal((await s3).exit, 0, 'the queue goes on after an expired request');
  assert.deepEqual(e.embedded, ['first', 'third'], 'the expired search was never embedded');
});

test('T2 (C, Jim N1): an expired search reports runMs 0 even when the clock ticks between reads', async () => {
  let clock = 1000;
  const e = engineRig({ now: () => clock++ });
  const s1 = e.engine.search({ query: 'first' }, { deadline: 1e9 });
  await e.tick();
  const s2 = e.engine.search({ query: 'second' }, { deadline: clock + 1 });
  clock += 100;
  e.gates.shift()();
  assert.equal((await s1).exit, 0);
  await assert.rejects(s2, (err) => err instanceof QueueExpired && err.timing.runMs === 0 && err.timing.waitMs > 0);
  assert.deepEqual(e.embedded, ['first']);
});

test('T2 (B): the engine reports indexing on and off around a backfill, a claims sync and a changed-source ingest, also when they throw; nested jobs give one pair', async () => {
  const e = engineRig();
  await e.engine.backfill();
  assert.deepEqual(e.events, ['on:backfill', 'off:backfill']);
  e.events.length = 0;
  await assert.rejects(e.engine.syncClaims({ wing: 'w1', path: 'agents/w1/memory/claims', head: 'h', chunks: [] }), /claims are not indexed for w1/);
  assert.deepEqual(e.events, ['on:claims-sync', 'off:claims-sync'], 'off after a throw');

  // A backfill that is embedding: on until its last step, then off. A sync meanwhile adds no pair.
  fs.mkdirSync(path.join(e.dir, 'agents', 'a1'), { recursive: true });
  fs.writeFileSync(path.join(e.dir, 'agents', 'a1', 'memory.md'), '# Memory\n\n- the zeppelin hangar code is twelve\n');
  const shas = new Map();
  const store = { search: () => [], setMeta() {}, sourceShas: () => shas, removeSource() {}, planDiff: (p, chunks) => ({ path: p, keep: [], add: chunks, remove: [] }), applyDiff: (meta) => { shas.set(meta.path, meta.sha256); return true; } };
  const g = engineRig({ store });
  g.dir = e.dir;
  const g2 = new MemoryEngine({ hiveRoot: e.dir, store, embedder: { loaded: true, unload: async () => {}, embed: (t) => new Promise((res) => g.gates.push(() => res(t.map(() => new Float32Array(384))))) },
    countTokens: words, watch: null, onIndexing: (on, kind) => g.events.push(`${on ? 'on' : 'off'}:${kind}`), setTimer: (fn, ms) => { if (ms === 0) setImmediate(fn); return {}; }, clearTimer: () => {} });
  const bf = g2.backfill();
  for (let i = 0; i < 10 && !g.gates.length; i++) await g.tick();
  const sync = g2.syncClaims({ wing: 'zz', path: 'agents/zz/memory/claims', head: 'h', chunks: [] }).catch(() => 'refused');
  assert.equal(await sync, 'refused');
  assert.deepEqual(g.events, ['on:backfill'], 'still indexing while a step is pending');
  while (g.gates.length) { g.gates.shift()(); await g.tick(); await g.tick(); }
  await bf;
  assert.deepEqual(g.events, ['on:backfill', 'off:backfill']);

  // A changed source (the watcher's debounce fired): the ingest is indexing too.
  fs.writeFileSync(path.join(e.dir, 'agents', 'a1', 'memory.md'), '# Memory\n\n- the zeppelin hangar code is thirteen\n');
  let debounced = null;
  const g3 = new MemoryEngine({ hiveRoot: e.dir, store, embedder: { loaded: true, unload: async () => {}, embed: async (t) => t.map(() => new Float32Array(384)) },
    countTokens: words, watch: null, onIndexing: (on, kind) => g.events.push(`${on ? 'on' : 'off'}:${kind}`),
    setTimer: (fn, ms) => { if (ms === 0) setImmediate(fn); else debounced = fn; return {}; }, clearTimer: () => {} });
  g.events.length = 0;
  g3.sourceChanged(path.join(e.dir, 'agents', 'a1', 'memory.md'));
  debounced();
  for (let i = 0; i < 20 && g.events.length < 2; i++) await g.tick();
  assert.deepEqual(g.events, ['on:ingest', 'off:ingest']);
});

// ── T3: the reproduction ────────────────────────────────────────────────────────────

const { runDrill } = require('./claims-drill/runner.cjs');
const TREE = path.join(__dirname, '..');
let n = 0;
async function drill(leg) {
  const dir = path.join(JAIL, `drill-${++n}`);
  const hive = path.join(dir, 'hive');
  fs.mkdirSync(hive, { recursive: true });
  const res = await runDrill({ tree: TREE, hive, home: path.join(dir, 'home'), script: path.join(__dirname, 'memory-search-deadline', 'scenario.cjs'), needModel: false, args: { leg }, timeoutMs: 180_000 });
  assert.equal(res.ok, true, JSON.stringify(res, null, 2).slice(0, 3000));
  return res;
}

// T3, the sync reproduction against the real 1000 ms indexing budget, is a wall-clock gate: it runs
// serially in the perf lane, test/perf/memory-search-deadline-189-t3.perf.cjs.

test('T3 (C, worker wiring): the worker passes each search deadline to the engine: one that expires behind a held step is answered expired with timing and never run; ok replies carry timing', async () => {
  const r = await drill('queue');
  assert.equal(r.cold.exit, 0, JSON.stringify(r.cold));
  const half = r.holdMs / 2;
  assert.deepEqual([r.held.ok, r.held.exit], [true, 0], JSON.stringify(r.held));
  assert.ok(r.held.hits > 0);
  assert.ok(r.held.timing && r.held.timing.runMs >= half && r.held.timing.inFlight === null, `an ok reply carries its timing: ${JSON.stringify(r.held.timing)}`);
  assert.deepEqual([r.expired.ok, r.expired.exit, r.expired.error], [false, EXIT.degraded, 'expired'], JSON.stringify(r.expired));
  assert.ok(r.expired.timing, 'the expired reply carries its timing');
  assert.deepEqual([r.expired.timing.runMs, r.expired.timing.inFlight], [0, 'search'], JSON.stringify(r.expired.timing));
  assert.ok(r.expired.timing.waitMs >= half, JSON.stringify(r.expired.timing));
  assert.deepEqual([r.after.ok, r.after.exit], [true, 0], JSON.stringify(r.after));
  assert.ok(r.after.timing && r.after.timing.waitMs >= half, `the one behind it waited and says so: ${JSON.stringify(r.after.timing)}`);
  assert.equal(r.stepRuns, 2, 'the model ran for the held search and the last one, never for the expired one');
});

test('T3: a wedged worker during a claims sync: each timed-out search writes a degraded row (deadline, indexing, 1000 ms)', async () => {
  const r = await drill('hang');
  assert.equal(r.cold.exit, 0, JSON.stringify(r.cold));
  assert.deepEqual(r.timedOut.map((s) => [s.exit, s.error]), Array.from({ length: 3 }, () => [EXIT.degraded, 'memory search timed out after 1000 ms']));
  const rows = r.rows.filter((x) => x.kind === 'native-memory-degraded');
  assert.equal(rows.length, 3, JSON.stringify(r.rows));
  for (const x of rows) assert.deepEqual([x.op, x.reason, x.budgetMs, x.warm, x.indexing], ['search', 'deadline', 1000, true, true]);
});
