'use strict';
/**
 * WARM-MEANS-MODEL-LOADED-189 (Jim S3 on MEMORY-SEARCH-TIMEOUT-DURING-INDEX-189): the client chose the
 * warm 250 ms search budget after ANY ok reply, but the worker loads the embedding model lazily, on
 * its first embed. A status, wake-up, backfill with nothing to embed, or any other reply after an idle
 * unload marked the client warm, and the next search paid the model load on 250 ms: exit 4.
 * Warm now means the model is loaded: set by a search's ok reply (a search always embeds its query)
 * or the worker's 'model-loaded' event; cleared by 'model-unloaded' and by the worker's exit.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'warm-189-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
test.after(() => {
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');
const { NativeMemoryClient, SEARCH_DEADLINE_WARM_MS, SEARCH_DEADLINE_COLD_MS } = loadTs('src/main/nativeMemory/service.ts');
const { MemoryEngine, MODEL_IDLE_UNLOAD_MS } = loadTs('src/main/nativeMemory/engine.ts');

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
  const r = { now: 1000, rows: [], workers: [] };
  r.client = new NativeMemoryClient({
    fork: () => { const w = fakeWorker(); r.workers.push(w); return w; },
    config: () => ({ hiveRoot: 'h' }), now: () => r.now, log: (row) => r.rows.push(row),
    setTimer: () => ({}), clearTimer: () => {}
  });
  r.w = () => r.workers.at(-1);
  r.last = () => r.w().posted.at(-1);
  /** Send `op` and answer it ok. */
  r.answer = async (op, args = {}) => { const p = r.client.request(op, args); r.w().reply({ id: r.last().id, ok: true, exit: 0, text: 'T' }); await p; };
  /** The budget the client gives the next search (its deadline minus now). */
  r.nextSearchBudget = () => { void r.client.request('search', { query: 'q' }); return r.last().deadline - r.now; };
  return r;
}

test('W1 an ok reply that did not embed (status, wake-up, backfill, claims-sync, report, compact) leaves the next search COLD', async () => {
  for (const op of ['status', 'wake-up', 'backfill', 'claims-sync', 'report', 'compact', 'claim-ledger', 'r5-candidates']) {
    const r = rig();
    await r.answer(op);
    assert.equal(r.nextSearchBudget(), SEARCH_DEADLINE_COLD_MS, `${op}: the model may still be unloaded`);
  }
});

test('W2 a search\'s ok reply makes the client warm (it embedded its query); a failed one does not', async () => {
  const r = rig();
  const p = r.client.request('search', { query: 'x' });
  r.w().reply({ id: r.last().id, ok: false, exit: 4, error: 'boom' });
  await p;
  assert.equal(r.nextSearchBudget(), SEARCH_DEADLINE_COLD_MS, 'a failed search proves nothing');
  r.w().reply({ id: r.last().id, ok: true, exit: 0 });
  assert.equal(r.nextSearchBudget(), SEARCH_DEADLINE_WARM_MS);
});

test('W3 the worker\'s model-loaded event makes the client warm (a backfill or an embed op loaded it)', async () => {
  const r = rig();
  await r.answer('status');
  r.w().reply({ event: 'model-loaded' });
  assert.equal(r.nextSearchBudget(), SEARCH_DEADLINE_WARM_MS);
  assert.equal(r.rows.filter((x) => x.event === 'model-loaded').length, 0, 'a state event, not a log row');
});

test('W4 after an idle unload, a status (or any non-search ok reply) does not make the client warm again', async () => {
  const r = rig();
  await r.answer('search', { query: 'x' });
  assert.equal(r.nextSearchBudget(), SEARCH_DEADLINE_WARM_MS);
  r.w().reply({ event: 'model-unloaded' });
  await r.answer('status');
  await r.answer('wake-up');
  assert.equal(r.nextSearchBudget(), SEARCH_DEADLINE_COLD_MS, 'Jim S3: the reload is still ahead');
});

test('W5 the worker\'s exit clears warm (a degraded row after it says warm false)', async () => {
  const r = rig();
  for (let i = 0; i < 4; i++) { await r.answer('search', { query: 'x' }); r.w().exit(1); }
  const res = await r.client.request('search', { query: 'y' });
  assert.equal(res.exit, 3, 'down after repeated crashes');
  const row = r.rows.filter((x) => x.kind === 'native-memory-degraded' && x.reason === 'unavailable').at(-1);
  assert.equal(row.warm, false);
});

test('W6 a search pending when the worker exits gets a worker-exit row that says the warm budget it had (Jim S1)', async () => {
  const r = rig();
  await r.answer('search', { query: 'x' });
  const p = r.client.request('search', { query: 'y' });
  assert.equal(r.last().deadline - r.now, SEARCH_DEADLINE_WARM_MS);
  r.w().exit(1);
  await p;
  const row = r.rows.find((x) => x.kind === 'native-memory-degraded' && x.reason === 'worker-exit');
  assert.ok(row, 'the pending search is logged as degraded by the exit');
  assert.equal(row.warm, true, 'the row is written before the exit clears warm');
  assert.equal(row.budgetMs, SEARCH_DEADLINE_WARM_MS);
  assert.equal(r.nextSearchBudget(), SEARCH_DEADLINE_COLD_MS, 'and the next worker starts cold');
});

/** A fake embedder whose model loads on the first non-empty embed, like OnnxEmbedder (an empty list returns early). */
function lazyEmbedder() {
  const e = { loaded: false, loads: 0, embed: async (t) => { if (t.length === 0) return []; if (!e.loaded) { e.loaded = true; e.loads++; } return t.map(() => new Float32Array(384)); }, unload: async () => { e.loaded = false; } };
  return e;
}
function engineRig(emb = lazyEmbedder()) {
  const timers = [];
  const told = [];
  const e = new MemoryEngine({
    hiveRoot: fs.mkdtempSync(path.join(JAIL, 'h-')), store: { search: () => [], counts: () => ({ chunks: 0 }), fileBytes: () => 0, db: { prepare: () => ({ all: () => [] }) } }, embedder: emb, countTokens: (t) => t.split(/\s+/).length, mode: () => 'native', watch: null,
    onModelLoaded: () => told.push('loaded'), onModelUnload: () => told.push('unloaded'),
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); if (ms === 0) setImmediate(fn); return t; }, clearTimer: (t) => { t.cleared = true; }
  });
  return { e, emb, told, timers };
}

test('E1 the engine says model-loaded once per load: at the first embed, again only after an idle unload', async () => {
  const { e, told, timers } = engineRig();
  await e.search({ query: 'a' });
  assert.deepEqual(told, ['loaded']);
  await e.search({ query: 'b' });
  await e.embedTexts(['c']);
  assert.deepEqual(told, ['loaded'], 'once per load');
  const t = timers.filter((x) => x.ms === MODEL_IDLE_UNLOAD_MS && !x.cleared).at(-1);
  t.fn();
  await new Promise((res) => setImmediate(res));
  assert.deepEqual(told, ['loaded', 'unloaded']);
  await e.embedTexts(['d']);
  assert.deepEqual(told, ['loaded', 'unloaded', 'loaded'], 'the reload is announced');
});

test('E2 a status with nothing embedded says nothing (the model is still unloaded)', async () => {
  const { e, emb, told } = engineRig();
  await e.status();
  assert.equal(emb.loaded, false);
  assert.deepEqual(told, []);
});

test('E3 a model load that fails announces nothing; the next good load does (Jim N2)', async () => {
  const emb = lazyEmbedder();
  const good = emb.embed;
  emb.embed = async () => { emb.embed = good; throw new Error('load failed'); };
  const { e, told } = engineRig(emb);
  await assert.rejects(e.embedTexts(['a']), /load failed/);
  assert.deepEqual(told, [], 'announced only after the embed returns');
  await e.embedTexts(['b']);
  assert.deepEqual(told, ['loaded']);
});

test('E4 embedding an empty list loads no model, so it announces nothing (Jim N3)', async () => {
  const { e, emb, told } = engineRig();
  await e.embedTexts([]);
  assert.equal(emb.loaded, false);
  assert.deepEqual(told, []);
  await e.embedTexts(['a']);
  assert.deepEqual(told, ['loaded']);
});

test('worker.ts posts model-loaded from the engine hook; service.ts no longer warms on any ok reply', () => {
  const worker = codeOnly(readSource('src/main/nativeMemory/worker.ts'), 'worker.ts');
  assert.match(worker, /onModelLoaded: \(\) => port\.postMessage\(\{ event: 'model-loaded' \}\)/);
  const service = codeOnly(readSource('src/main/nativeMemory/service.ts'), 'service.ts');
  assert.doesNotMatch(service, /if \(m\.ok\) this\.warm = true/);
});
