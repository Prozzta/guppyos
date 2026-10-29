'use strict';
require('./tools/own-job.cjs');
/**
 * CLAIMS-KEYFIND-FOLLOWUPS (god 8ee714): three side defects Andy found while fixing keyfind, each a product mechanism:
 *  (a) the claims-sync deadline grows with the chunk count (a fixed 120 s let the derived wing's first sync time out on
 *      main every time while the worker went on embedding, so searches saw no derived claim and the fill was logged failed);
 *  (b) the worker's card-lead ask is bounded by the SEARCH's deadline, never a shorter fixed wait, and a timeout is logged;
 *  (c) a key-alias proposal never joins keys that differ in a number, and get's union of OPEN (unanswered) pairs applies
 *      the same rule and never joins the keys of two cards tasks.json both knows; an answered alias joins as before.
 *      Its tests live beside the mechanisms they pin: test/claims90-get.test.cjs ((c) get) and
 *      test/claims-reconcile-w5.test.cjs ((c) keysMayAlias / keyAliasCandidates), which run as single files.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const REPO = path.resolve(__dirname, '..');
const { NativeMemoryWiring, claimsSyncDeadlineMs, CLAIMS_SYNC_BASE_MS, CLAIMS_SYNC_PER_CHUNK_MS } = loadTs('src/main/nativeMemory/mainWiring.ts');
const { askWaitMs, ASK_TIMEOUT_MS } = loadTs('src/main/nativeMemory/worker.ts');
const { SEARCH_DEADLINE_WARM_MS } = loadTs('src/main/nativeMemory/service.ts');
const { cardLeadsFor } = loadTs('src/main/nativeMemory/engine.ts');

const dirs = [];
const dir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'keyfind-fu-')); dirs.push(d); return d; };
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tick = () => new Promise((r) => setImmediate(r));

function fakeWorker() {
  const w = { posted: [], handlers: { message: [], exit: [] } };
  w.postMessage = (m) => w.posted.push(m);
  w.on = (ev, fn) => w.handlers[ev].push(fn);
  w.kill = () => true;
  w.reply = (m) => w.handlers.message.forEach((f) => f(m));
  return w;
}
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

test('(a) the claims-sync deadline grows with the chunk count: base 120 s for an empty sync, 150 ms per chunk on top; the derived wing on the on-1 floor (11,639 chunks) gets ~29 min, not 120 s', () => {
  assert.equal(CLAIMS_SYNC_BASE_MS, 120_000);
  assert.equal(CLAIMS_SYNC_PER_CHUNK_MS, 150);
  assert.equal(claimsSyncDeadlineMs(0), 120_000, 'a sync of no parts keeps the old budget');
  assert.equal(claimsSyncDeadlineMs(1), 120_150);
  assert.equal(claimsSyncDeadlineMs(11_639), 120_000 + 11_639 * 150);
  assert.ok(claimsSyncDeadlineMs(11_639) > 25 * 60_000, 'the on-1 derived sync no longer dies at 120 s');
  assert.equal(claimsSyncDeadlineMs(-5), 120_000, 'never below the base');
  assert.equal(claimsSyncDeadlineMs(2.9), 120_300, 'whole chunks');
});

test('(a) wiring: NativeMemoryWiring.syncClaims posts the request with deadline = now + claimsSyncDeadlineMs(chunks) (the worker drops a request past that deadline, so main and worker agree on it)', async () => {
  const root = dir();
  fs.mkdirSync(path.join(root, 'agents', 'a1'), { recursive: true });
  fs.writeFileSync(path.join(root, 'agents', 'a1', 'memory.md'), 'm');
  const workers = [];
  const w = new NativeMemoryWiring({
    hiveRoot: () => root, enabled: () => true, userData: path.join(root, 'ud'), resourcesDir: path.join(root, 'res'),
    workerEntry: 'w.js', fork: () => { const x = fakeWorker(); workers.push(x); return x; }, memoryBaseUrl: () => 'http://127.0.0.1:5555/memory',
    writeCommand: () => path.join(root, 'bin', 'memory'), log: () => {}, ...runtime(root), claimLedger: () => 'reader'
  });
  const chunks = Array.from({ length: 7 }, (_, i) => ({ id: `c-${i}`, content: `claim ${i}` }));
  const before = Date.now();
  const p = w.syncClaims({ wing: 'a1', path: 'agents/a1/memory/claims', head: 'h', chunks });
  await tick(); await tick();
  const wk = workers[0];
  wk.reply({ event: 'ready' });
  await tick(); await tick();
  const sync = wk.posted.find((m) => m.op === 'claims-sync');
  assert.ok(sync, `a claims-sync was posted: ${wk.posted.map((m) => m.op).join(',')}`);
  assert.equal(sync.args.chunks.length, 7);
  // The wiring uses the client's real clock: the posted deadline is now + the scaled budget (121,050 ms for 7 chunks),
  // which a fixed 120,000 ms budget can never reach.
  const left = sync.deadline - before;
  assert.ok(left <= claimsSyncDeadlineMs(7) + 50 && left > 120_000 + 500, `deadline ${left} ms ahead: the scaled budget, not the fixed 120 s`);
  wk.reply({ id: sync.id, ok: true, exit: 0, json: { embedded: 7 } });
  assert.equal((await p).ok, true);
  await w.shutdown?.();
});

test('(b) askWaitMs: an ask for a request with a deadline waits exactly until that deadline (never negative); one without keeps ASK_TIMEOUT_MS', () => {
  assert.equal(ASK_TIMEOUT_MS, 1_500);
  assert.equal(askWaitMs(undefined, 10_000), 1_500);
  assert.equal(askWaitMs(12_000, 10_000), 2_000, 'a cold search (2 s) lets main take the whole 2 s for the brief');
  assert.equal(askWaitMs(10_000 + SEARCH_DEADLINE_WARM_MS, 10_000), SEARCH_DEADLINE_WARM_MS, 'a warm search never waits past its own deadline');
  assert.ok(askWaitMs(10_000 + SEARCH_DEADLINE_WARM_MS, 10_000) >= 300, 'warm 500 ms: a brief main answers after 300 ms is still waited for');
  assert.equal(askWaitMs(9_000, 10_000), 0, 'a deadline already past waits nothing');
});

test('(b) the search deadline travels with the card-lead ask: cardLeadsFor passes it to the dep (and none when the search had none); the worker hands it to ask() and logs a timeout', async () => {
  const seen = [];
  const dep = async (ask) => { seen.push(ask); return { briefs: { 'foo-7': ['status: doing'] }, named: [], pointed: [] }; };
  const hits = [{ claim: { key: 'card.foo-7.status' }, content: 'FOO-7 status doing' }];
  const r = await cardLeadsFor(hits, 'q', dep, 123_456);
  assert.deepEqual(r.briefs, { 'foo-7': ['status: doing'] });
  assert.equal(seen[0].deadline, 123_456, 'the deadline rides along');
  await cardLeadsFor(hits, 'q', dep);
  assert.ok(!('deadline' in seen[1]), 'no deadline, no field');
  const engine = fs.readFileSync(path.join(REPO, 'src', 'main', 'nativeMemory', 'engine.ts'), 'utf8');
  assert.equal((engine.match(/this\.cardLeads\((?:all|hits), a\.query, o\.deadline\)/g) || []).length, 2, 'both search paths (exact and embedded) pass the request deadline');
  const worker = fs.readFileSync(path.join(REPO, 'src', 'main', 'nativeMemory', 'worker.ts'), 'utf8');
  assert.match(worker, /const r = await ask\('card-lead', \{ cards: lead\.cards, texts: lead\.texts \}, lead\.deadline\);/, 'the worker asks with the search deadline');
  assert.match(worker, /const waitMs = askWaitMs\(deadline, Date\.now\(\)\);/, 'the ask waits askWaitMs');
  assert.match(worker, /kind: 'native-memory-ask-timeout', op, waitMs/, 'a timed-out ask is logged, never silent');
  assert.doesNotMatch(worker, /\}, ASK_TIMEOUT_MS\);/, 'MUTANT: the old fixed wait is gone');
});
