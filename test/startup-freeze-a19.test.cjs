'use strict';
require('./tools/own-job.cjs');

/**
 * STARTUP-FREEZE-104 A19 (god 424399): derive and chunksFor run in a worker thread; main keeps the MAC verify and the
 * single writer, and falls back to the in-process derive on any worker problem.
 *  - The worker reads the segment files itself and uses exactly the verified prefix (the sha256 prev chain up to the
 *    verified head and count): anything else is 'stale'.
 *  - Seeded ledgers: every answer (the per-record status codes, chunks and head) equals the main-thread derive, in-process and
 *    through a real worker thread.
 *  - A crash, an exit, a hang (timeout), a spawn failure, a post failure or a non-ok answer resolves null, is logged
 *    (claims-derive-fallback), never wedges; after maxFailures the worker is off.
 *  - The callers: the index sync sends the worker's JSON; the derived writer takes the codes and primes the view
 *    before its first append; the store's primeView installs statuses equal to a fresh derive, and only for the view
 *    it posted; each falls back to the A18 path.
 * Temp hives in a jailed HOME only.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-sf104-a19-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
const STORES = [];
const WORKERS = [];
test.after(async () => {
  for (const w of WORKERS) w.stop();
  for (const s of STORES) s.close();
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const ROOT = path.resolve(__dirname, '..');
const loadTs = require('./load-ts.cjs');
const { ClaimStore } = loadTs('src/main/claims/store.ts');
const { SandboxKeyProvider, FileLedgerKeyRecord, KEY_RECORD_FILE } = loadTs('src/main/claims/keyProvider.ts');
const { derive } = loadTs('src/main/claims/derive.ts');
const { chunksFor, withParts } = loadTs('src/main/claims/chunks.ts');
const REG = loadTs('src/main/claims/registry.ts');
const J = loadTs('src/main/claims/deriveJob.ts');
const { DeriveOffMain } = loadTs('src/main/claims/deriveOffMain.ts');
const { ClaimsIndexSync } = loadTs('src/main/claims/indexSync.ts');
const W = loadTs('src/main/claims/derivedWriter.ts');
const { claimsSyncArgsOf } = loadTs('src/main/nativeMemory/worker.ts');
const { DERIVED_AGENT_ID } = loadTs('src/shared/claims.ts');

const crypto = require('node:crypto');
const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };

let n = 0;
function hiveDir() {
  const root = path.join(JAIL, `hive-${++n}`);
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  return root;
}
function storeAt(root, extra = {}) {
  const logs = [];
  let t = Date.parse('2026-10-03T10:00:00Z');
  const store = new ClaimStore({ hiveRoot: root, keys: new SandboxKeyProvider(), keyRecord: new FileLedgerKeyRecord(path.join(`${root}-ud`, KEY_RECORD_FILE)), now: () => new Date(t += 1000), log: (r) => logs.push(r), alert: () => {}, ...extra });
  STORES.push(store);
  return { store, logs };
}
function diskRecords(store, agent) {
  const out = [];
  for (const f of store.segments(agent)) for (const line of fs.readFileSync(f, 'utf8').split('\n')) if (line) out.push(JSON.parse(line));
  return out;
}
function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 0x100000000; };
}
/** A seeded ledger: keyed and unkeyed claims, duplicates, supersedes, retracts and events (refused drafts skipped). */
async function seeded(store, agent, seed, steps = 120) {
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const KEYS = ['project.northwind', 'project.quartz', 'card.marble', 'card.lantern'];
  const drafts = [];
  for (let step = 0; step < steps; step++) {
    const ids = diskRecords(store, agent).filter((x) => x.t === 'claim').map((x) => x.id);
    const op = ids.length < 4 ? 'single' : pick(['dup', 'single', 'single', 'multi', 'none', 'supersede', 'retract', 'event', 'long']);
    let draft;
    if (op === 'dup' && drafts.length) draft = pick(drafts);
    else if (op === 'multi') draft = { t: 'claim', kind: 'fact', text: `m ${step}`, key: pick(KEYS.slice(2)) };
    else if (op === 'none') draft = { t: 'claim', kind: 'decision', text: `n ${step}` };
    else if (op === 'long') draft = { t: 'claim', kind: 'fact', text: `long ${step} ` + 'word '.repeat(300), key: pick(KEYS) };
    else if (op === 'supersede') draft = { t: 'claim', kind: 'fact', text: `r ${step}`, key: pick(KEYS), supersedes: [pick(ids)], supersedesReason: { category: 'changed' } };
    else if (op === 'retract') draft = { t: 'claim', kind: 'fact', text: `x ${step}`, retracts: [pick(ids)] };
    else if (op === 'event') { const ev = pick(['pin', 'unpin', 'accept', 'dismiss']); draft = ev === 'pin' || ev === 'unpin' ? { t: 'event', ev, targets: [pick(ids)] } : { t: 'event', ev, targets: [pick(ids), pick(ids)] }; }
    else draft = { t: 'claim', kind: 'fact', text: `s ${step % 7}`, key: pick(KEYS.slice(0, 2)) };
    const res = await store.appendRecord(agent, draft, 'endpoint');
    if (res.ok && draft.t === 'claim') drafts.push(draft);
  }
}
/** What main's in-process derive gives, encoded as the worker encodes it. */
function onMain(records, registry, want) {
  const state = derive(records, registry, { r4: false });
  // The letters spelled out here, not taken from J.STATUS_CODE: the test pins the encoding.
  const L = { live: 'L', superseded: 'S', 'superseded?': 'Q', retracted: 'R', purged: 'P' };
  if (want === 'codes') return { out: records.map((r) => (r.t === 'claim' && state.claims[r.id] ? L[state.claims[r.id].status] : '-')).join(''), count: records.length };
  return { out: JSON.stringify(withParts(chunksFor(records, state))), head: state.ledgerHead || records[records.length - 1].mac, count: withParts(chunksFor(records, state)).length };
}
function realWorker(logs) {
  const off = new DeriveOffMain({ spawn: () => new Worker(path.join(__dirname, 'tools', 'derive-worker-ts.cjs')), log: (r) => logs.push(r) });
  WORKERS.push(off);
  return off;
}

// ---------------------------------------------------------------- the verified prefix

test('A19: the worker reads exactly the verified prefix: the prev chain to the verified head and count, else stale', async () => {
  const { store } = storeAt(hiveDir());
  await seeded(store, 'a1', 5, 40);
  const read = store.readLedger('a1');
  assert.equal(read.chain, 'ok');
  const job = store.verifiedJobFor('a1', read);
  assert.ok(job, 'the kept verified read has a job');
  assert.equal(job.count, read.records.length);
  assert.deepEqual(J.verifiedRecordsFromFiles(job.files, job.head, job.count), read.records);
  // Lines appended after the verified read: still exactly the verified prefix.
  assert.equal((await store.appendRecord('a1', { t: 'claim', kind: 'fact', text: 'after the read' }, 'endpoint')).ok, true);
  assert.deepEqual(J.verifiedRecordsFromFiles(job.files, job.head, job.count), read.records);
  // A wrong head, a count that does not end at the head, a count past the end: stale.
  assert.equal(J.verifiedRecordsFromFiles(job.files, 'f'.repeat(64), job.count), null);
  assert.equal(J.verifiedRecordsFromFiles(job.files, job.head, job.count - 1), null);
  assert.equal(J.verifiedRecordsFromFiles(job.files, job.head, job.count + 50), null);
  assert.equal(J.verifiedRecordsFromFiles(job.files, '', job.count), null);
  // An earlier line changed on disk (same length): the chain no longer reaches the head.
  const f = job.files[0];
  const text = fs.readFileSync(f, 'utf8');
  const lines = text.split('\n');
  lines[1] = lines[1].replace(/"text":"(.)/, (m, c) => `"text":"${c === 'Q' ? 'R' : 'Q'}`);
  assert.equal(J.verifiedRecordsFromFiles(job.files, job.head, job.count, (p) => (p === f ? lines.join('\n') : fs.readFileSync(p, 'utf8'))), null);
  // A different read object (not the kept one) gets no job; so does a read with a chain break.
  assert.equal(store.verifiedJobFor('a1', { ...read }), null);
  assert.equal(store.verifiedJobFor('a1', { records: read.records, torn: null, chain: { brokenAt: read.records[2].id, reason: 'mac' } }), null);
});

// ---------------------------------------------------------------- identical to the main-thread derive

for (const seed of [1, 2, 3, 42]) {
  test(`A19: every worker answer equals the main-thread derive (seed ${seed}, in-process job)`, async () => {
    const root = hiveDir();
    const { store } = storeAt(root);
    await seeded(store, 'a1', seed);
    store.flushKeyRegistry();
    const registry = REG.loadRegistry(root);
    const read = store.readLedger('a1');
    const job = store.verifiedJobFor('a1', read);
    for (const want of ['codes', 'chunks']) {
      const got = J.runDeriveJob({ want, agentId: 'a1', ...job, registry, r4: false }, null);
      assert.equal(got.ok, true);
      const ref = onMain(read.records, registry, want);
      assert.equal(got.out, ref.out, `${want} seed ${seed}`);
      assert.equal(got.count, ref.count);
      if (want === 'chunks') assert.equal(got.head, ref.head);
    }
    const st = derive(read.records, registry, { r4: false });
    // Read back by index, the codes give every claim derive knows its status (and no other id).
    const codes = J.runDeriveJob({ want: 'codes', agentId: 'a1', ...job, registry, r4: false }, null).out;
    assert.equal(codes.length, read.records.length);
    const back = new Map(); read.records.forEach((r, i) => { const x = J.statusOfCode(codes[i]); if (x) back.set(r.id, x); });
    assert.deepEqual(new Map([...back].sort()), new Map(Object.keys(st.claims).map((id) => [id, st.claims[id].status]).sort()));
    assert.equal(J.statusOfCode('-'), undefined);
    assert.ok(Object.values(st.claims).some((c) => c.status !== 'live'), 'the seeded ledger has non-live claims');
    assert.ok(read.records.some((r) => r.t !== 'claim'), 'and records that are not claims');
    // A job's own registry wins over the kept one (the two derive differently here).
    const bare = deepFreeze({ v: 1, namespaces: [], keys: {} });
    assert.notEqual(onMain(read.records, bare, 'codes').out, onMain(read.records, registry, 'codes').out, 'precondition: the registry matters');
    assert.equal(J.runDeriveJob({ want: 'codes', agentId: 'a1', ...job, registry, r4: false }, bare).out, onMain(read.records, registry, 'codes').out);
    // A kept registry: a job with registry null uses the previous one; with none kept, it says so.
    assert.equal(J.runDeriveJob({ want: 'codes', agentId: 'a1', ...job, registry: null, r4: false }, registry).out, onMain(read.records, registry, 'codes').out);
    assert.deepEqual(J.runDeriveJob({ want: 'codes', agentId: 'a1', ...job, registry: null, r4: false }, null), { ok: false, why: 'no-registry' });
  });
}

test('A19: through a real worker thread, the answers equal the main-thread derive and the registry is posted once', async () => {
  const root = hiveDir();
  const { store } = storeAt(root);
  await seeded(store, 'a1', 9);
  await seeded(store, 'a2', 10, 60);
  store.flushKeyRegistry();
  const registry = REG.loadRegistry(root);
  const logs = [];
  const off = realWorker(logs);
  let posts = 0; let withRegistry = 0;
  const realRun = off.run.bind(off);
  for (const agent of ['a1', 'a2']) {
    const read = store.readLedger(agent);
    const job = store.verifiedJobFor(agent, read);
    for (const want of ['codes', 'chunks']) {
      const got = await realRun({ want, agentId: agent, ...job, registry, r4: false });
      assert.ok(got, `${agent} ${want}: ${JSON.stringify(logs)}`);
      const ref = onMain(read.records, registry, want);
      assert.equal(got.out, ref.out, `${agent} ${want}`);
      assert.equal(got.count, ref.count);
      if (want === 'chunks') assert.equal(got.head, ref.head);
    }
  }
  assert.deepEqual(logs, [], 'no fallback');
  // The registry crosses once per worker: spy on the next worker's posts.
  const off2 = new DeriveOffMain({ spawn: () => { const w = new Worker(path.join(__dirname, 'tools', 'derive-worker-ts.cjs')); const post = w.postMessage.bind(w); w.postMessage = (m) => { posts++; if (m.job.registry) withRegistry++; return post(m); }; return w; }, log: (r) => logs.push(r) });
  WORKERS.push(off2);
  const read = store.readLedger('a1');
  const job = store.verifiedJobFor('a1', read);
  for (let i = 0; i < 3; i++) assert.ok(await off2.run({ want: 'codes', agentId: 'a1', ...job, registry, r4: false }));
  assert.equal(posts, 3);
  assert.equal(withRegistry, 1, 'the same registry object is posted only with the first job');
  // A stale job (the head of no line) falls back with its reason.
  assert.equal(await off2.run({ want: 'codes', agentId: 'a1', ...job, head: 'e'.repeat(64), registry, r4: false }), null);
  assert.ok(logs.some((l) => l.kind === 'claims-derive-fallback' && l.why === 'stale' && l.agentId === 'a1'), JSON.stringify(logs));
});

test('A19: the worker derives with r4 off, as every main-thread caller does', () => {
  const dir = hiveDir(); fs.mkdirSync(dir, { recursive: true });
  const c = (id, text) => ({ t: 'claim', id, agent: 'a1', wt: '2026-10-03T10:00:00Z', at: '2026-10-03T10:00:00Z', kind: 'fact', text, source: 'agent', mac: `m-${id}` });
  const recs = [c('c-000000000001', 'old'), c('c-000000000002', 'new'), { t: 'event', id: 'e-000000000003', agent: 'a1', at: '2026-10-03T10:00:01Z', ev: 'inferred-supersede', targets: ['c-000000000001', 'c-000000000002'], rule: 'R4', mac: 'm-e3' }];
  let prev = ''; const lines = [];
  for (const r of recs) { r.prev = prev; const line = JSON.stringify(r); lines.push(line); prev = crypto.createHash('sha256').update(line).digest('hex'); }
  const f = path.join(dir, '2026-10.jsonl'); fs.writeFileSync(f, lines.join('\n') + '\n');
  const reg = deepFreeze({ v: 1, namespaces: [], keys: {} });
  const parsed = lines.map((l) => JSON.parse(l));
  assert.notEqual(derive(parsed, reg, { r4: true }).claims['c-000000000001'].status, derive(parsed, reg, { r4: false }).claims['c-000000000001'].status, 'precondition: r4 matters here');
  const got = J.runDeriveJob({ want: 'codes', agentId: 'a1', files: [f], head: prev, count: 3, registry: reg, r4: false }, null);
  assert.equal(got.ok, true, JSON.stringify(got));
  assert.equal(got.out, onMain(parsed, reg, 'codes').out);
  assert.equal(got.out, 'LL-');
});

// ---------------------------------------------------------------- failures never wedge

function fakeWorker(behave) {
  const handlers = {};
  const w = {
    posted: [], terminated: 0,
    postMessage(m) { if (behave.postThrows?.()) throw new Error('DataCloneError'); w.posted.push(m); behave.onPost?.(m, w); },
    on(ev, fn) { handlers[ev] = fn; return w; },
    terminate() { w.terminated++; },
    emit(ev, arg) { handlers[ev]?.(arg); },
  };
  return w;
}
/** A job that must settle: 'held' after 2 s, so a missing settle fails the assert instead of the test timeout. */
const within = (p, ms = 2000) => Promise.race([p, new Promise((r) => setTimeout(() => r('held'), ms).unref())]);
// CLAIMS-WARM-BACKFILL-106: 'chunks', which is never memoized, so every run of these failure tests reaches the worker.
const JOB = { want: 'chunks', agentId: 'a1', files: [], head: 'h', count: 1, registry: deepFreeze({ v: 1, namespaces: [], keys: {} }), r4: false };

test('A19: a crash, an exit, a hang, a failed spawn or post, or a non-ok answer resolves null, is logged, and the next job starts a fresh worker', async () => {
  const logs = []; const timers = [];
  let spawned = 0; let mode = 'answer'; let last;
  const off = new DeriveOffMain({
    spawn: () => { spawned++; if (mode === 'spawn-throws') throw new Error('no worker file'); last = fakeWorker({
      postThrows: () => mode === 'post-throws',
      onPost: (m, w) => {
        if (mode === 'answer') queueMicrotask(() => w.emit('message', { id: m.id, result: { ok: true, out: 'c-1' } }));
        if (mode === 'stale') queueMicrotask(() => w.emit('message', { id: m.id, result: { ok: false, why: 'stale' } }));
        if (mode === 'crash') queueMicrotask(() => w.emit('error', new Error('boom')));
        if (mode === 'exit') queueMicrotask(() => w.emit('exit', 1));
      } }); return last; },
    log: (r) => logs.push(r), maxFailures: 99,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: (t) => { timers[t - 1] = null; },
  });
  assert.deepEqual(await off.run(JOB), { ok: true, out: 'c-1' });
  assert.equal(spawned, 1);
  mode = 'stale';
  assert.equal(await off.run(JOB), null);
  assert.equal(spawned, 1, 'a stale answer keeps the worker');
  for (const m of ['crash', 'exit']) {
    mode = m;
    const before = spawned;
    const w = await within(off.run(JOB));
    assert.equal(w, null, m);
    assert.equal(last.terminated, 1, `${m}: the worker is terminated`);
    mode = 'answer';
    assert.deepEqual(await off.run(JOB), { ok: true, out: 'c-1' }, `${m}: the next job works`);
    assert.equal(spawned, before + 1, `${m}: on a fresh worker`);
  }
  // A hang: the job's timer fires; every job the worker held resolves null.
  mode = 'hang';
  const a = off.run(JOB); const b = off.run(JOB);
  const live = timers.filter(Boolean);
  assert.equal(live.length, 2);
  assert.equal(live[0].ms, 30_000);
  live[0].fn();
  assert.deepEqual(await Promise.race([Promise.all([a, b]), new Promise((r) => setTimeout(() => r('held'), 2000))]), [null, null], 'a failed worker settles every job it held');
  assert.equal(last.terminated, 1);
  // The registry goes again to the fresh worker.
  mode = 'answer';
  assert.ok(await off.run(JOB));
  assert.ok(last.posted[0].job.registry, 'a fresh worker gets the registry');
  const reg2 = deepFreeze({ v: 1, namespaces: [], keys: {} });
  assert.ok(await off.run({ ...JOB, registry: reg2 }));
  assert.equal(last.posted[1].job.registry, reg2, 'a changed registry is posted again');
  assert.ok(await off.run({ ...JOB, registry: reg2 }));
  assert.equal(last.posted[2].job.registry, null, 'the same one is not');
  mode = 'post-throws';
  assert.equal(await off.run(JOB), null);
  mode = 'spawn-throws';
  assert.equal(await off.run(JOB), null);
  const why = logs.filter((l) => l.kind === 'claims-derive-fallback').map((l) => l.why);
  assert.deepEqual(why, ['stale', 'error', 'exit', 'timeout', 'post', 'spawn']);
  assert.ok(off.enabled);
});

test('A19: after maxFailures the worker is off for the run: every job resolves null at once, logged once', async () => {
  const logs = []; let spawned = 0;
  const off = new DeriveOffMain({ spawn: () => { spawned++; const w = fakeWorker({ onPost: () => queueMicrotask(() => w.emit('exit', 1)) }); return w; }, log: (r) => logs.push(r), maxFailures: 3 });
  for (let i = 0; i < 3; i++) assert.equal(await within(off.run(JOB)), null);
  assert.equal(off.enabled, false);
  assert.equal(await off.run(JOB), null);
  assert.equal(spawned, 3, 'no fourth worker');
  assert.equal(logs.filter((l) => l.kind === 'claims-derive-worker-disabled').length, 1);
  // stop() with jobs held: they resolve null; a stopped worker's late events change nothing.
  let held; const l2 = [];
  const off2 = new DeriveOffMain({ spawn: () => (held = fakeWorker({})), log: (r) => l2.push(r), maxFailures: 1 });
  const p = off2.run(JOB);
  off2.stop();
  assert.equal(await Promise.race([p, new Promise((r) => setTimeout(() => r('held'), 2000))]), null, 'stop settles the held job');
  held.emit('exit', 0);
  held.emit('error', new Error('late'));
  assert.deepEqual(l2, [], 'a stopped worker\'s late events are not failures');
  assert.equal(off2.enabled, true);
});

// ---------------------------------------------------------------- the callers

test('A19: the index sync sends the worker\'s chunk JSON; a fallback or a chain break sends objects as before', async () => {
  const rec = (id, text) => ({ t: 'claim', id, agent: 'a1', wt: '2026-10-03T10:00:00Z', at: '2026-10-03T10:00:00Z', kind: 'fact', text, prev: '', mac: `m-${id}`, source: 'agent' });
  const records = [rec('c-000000000001', 'a'), rec('c-000000000002', 'b')];
  const sent = []; const asked = [];
  let answer = { head: 'H', chunksJson: '[{"x":1}]', count: 1 };
  let read = { records, torn: null, chain: 'ok' };
  const s = new ClaimsIndexSync({
    readLedger: () => read, derive: () => derive, registry: () => ({ v: 1, namespaces: [], keys: {} }), ruleConfig: () => ({ r4: false }),
    level: () => 'reader', agents: () => ['a1'], send: async (a) => { sent.push(a); return { ok: true }; },
    offMain: async (agentId, r) => { asked.push([agentId, r]); return answer; },
  });
  let out = await s.syncNow('a1');
  assert.deepEqual(asked, [['a1', read]], 'the very read goes to the worker');
  assert.deepEqual(sent[0], { wing: 'a1', path: sent[0].path, head: 'H', chunksJson: '[{"x":1}]', chunkCount: 1 });
  assert.equal(out.chunks, 1);
  assert.equal(out.records, 2);
  answer = null;
  out = await s.syncNow('a1');
  assert.ok(Array.isArray(sent[1].chunks) && sent[1].chunks.length === 2 && sent[1].chunksJson === undefined, 'fallback: objects, as before');
  read = { records, torn: null, chain: { brokenAt: 'c-000000000002', reason: 'mac' } };
  asked.length = 0;
  out = await s.syncNow('a1');
  assert.equal(asked.length, 0, 'a verified prefix (chain break) never goes to the worker');
  assert.equal(out.truncatedAt, 'c-000000000002');
  // The memory worker parses the JSON; plain chunk objects pass as they are.
  assert.deepEqual(claimsSyncArgsOf({ wing: 'a1', path: 'p', head: 'H', chunksJson: '[{"x":1}]', chunkCount: 1, claimLedger: 'reader' }), { wing: 'a1', path: 'p', head: 'H', chunks: [{ x: 1 }], claimLedger: 'reader' });
  const plain = { wing: 'a1', path: 'p', head: 'H', chunks: [{ x: 2 }] };
  assert.equal(claimsSyncArgsOf(plain), plain);
  assert.throws(() => claimsSyncArgsOf({ chunksJson: '{"x":1}' }), /not an array/);
});

test('A19 on int 67732ccc: a delta stays on main; a worker send clears the snapshot and the sent appends, and keeps a later one', async () => {
  const rec = (id, text) => ({ t: 'claim', id, agent: 'a1', wt: '2026-10-03T10:00:00Z', at: '2026-10-03T10:00:00Z', kind: 'fact', text, prev: '', mac: `m-${id}`, source: 'agent' });
  const r1 = rec('c-000000000001', 'a'), r2 = rec('c-000000000002', 'b'), r3 = rec('c-000000000003', 'c'), r4 = rec('c-000000000004', 'd');
  const sent = []; const asked = []; let reads = 0;
  let answer = null; let during = null;
  let read = { records: [r1], torn: null, chain: 'ok' };
  // CLAIMS-WARM-BACKFILL-106: only a run with the worker OFF keeps a snapshot after an in-process sync (see the 106 suite).
  let workerOn = false;
  const s = new ClaimsIndexSync({
    readLedger: () => { reads++; return read; }, derive: () => derive, registry: () => ({ v: 1, namespaces: [], keys: {} }), ruleConfig: () => ({ r4: false }),
    level: () => 'reader', agents: () => ['a1'], send: async (a) => { sent.push(a); return { ok: true }; },
    offMain: async (agentId, r) => { asked.push(r); if (during) { during(); during = null; } return answer; },
    offMainEnabled: () => workerOn,
    setTimer: () => 0, clearTimer: () => {},
  });
  // With the worker off, an in-process full sync keeps a snapshot, so an acked append is a delta: it never goes to the worker.
  await s.syncNow('a1');
  assert.equal(asked.length, 1);
  answer = { head: 'H', chunksJson: '[]', count: 0 };
  read = { records: [r1, r2], torn: null, chain: 'ok' };
  await s.syncNow('a1', r2);
  assert.equal(asked.length, 1, 'a delta is not the store\'s kept read: it derives on main');
  assert.equal(sent[1].delta, true);
  assert.equal(reads, 1, 'the delta read nothing');
  // A worker send: the snapshot goes (no chunk objects on main), the sent appends leave the queue, one queued meanwhile stays.
  workerOn = true;
  s.deltasSinceVerify.set('a1', 99);
  read = { records: [r1, r2, r3], torn: null, chain: 'ok' };
  during = () => s.schedule('a1', r4);
  const out = await s.syncNow('a1');
  assert.equal(out.chunks, 0);
  assert.equal(sent[2].chunksJson, '[]');
  assert.equal(s.snapshots.has('a1'), false, 'no snapshot after a worker send');
  assert.equal(s.deltasSinceVerify.get('a1'), 0);
  assert.deepEqual(s.pending.get('a1'), [r4], 'the append queued during the worker job is kept');
  // So the next acked append reads again and goes to the worker, and the queue empties.
  read = { records: [r1, r2, r3, r4], torn: null, chain: 'ok' };
  await s.syncNow('a1');
  assert.equal(asked.at(-1), read, 'the full read goes to the worker');
  assert.equal(sent[3].delta, undefined);
  assert.equal(s.pending.has('a1'), false, 'the sent append left the queue');
});

test('A19: the store primes its view off main: statuses equal a fresh derive, the next append derives nothing on main; an append meanwhile keeps the view unprimed', async () => {
  const root = hiveDir();
  const logs = [];
  const off = realWorker(logs);
  const { store, logs: slog } = storeAt(root, { offMain: off });
  await seeded(store, 'a1', 21, 80);
  store.flushKeyRegistry();
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(REG.registryPath(root), old, old);
  const read = store.readLedger('a1');
  assert.equal(read.chain, 'ok');
  await store.primeView('a1');
  const primeRow = slog.find((l) => l.kind === 'claims-view-derive' && l.reason === 'prime');
  assert.ok(primeRow && primeRow.offMain === true, JSON.stringify(slog.filter((l) => l.kind === 'claims-view-derive')));
  const registry = REG.loadRegistryShared(root);
  const fresh = derive(diskRecords(store, 'a1'), registry, { r4: false });
  const ids = Object.keys(fresh.claims);
  const before = slog.filter((l) => l.kind === 'claims-view-derive').length;
  const got = store.statusesOf('a1', store.current('a1'), ids, registry);
  for (const id of ids) assert.equal(got.get(id), fresh.claims[id].status, id);
  assert.equal(slog.filter((l) => l.kind === 'claims-view-derive').length, before, 'the primed view answers without a derive');
  // An append that lands while the worker derives: the answer is for an older view, so it is not installed.
  const root2 = hiveDir();
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = { run: async (job) => { const r = J.runDeriveJob(job, null); await gate; return r.ok ? r : null; } };
  const { store: s2, logs: l2 } = storeAt(root2, { offMain: slow });
  await seeded(s2, 'a1', 22, 30);
  s2.readLedger('a1');
  const p = s2.primeView('a1');
  assert.equal((await s2.appendRecord('a1', { t: 'claim', kind: 'fact', text: 'meanwhile' }, 'endpoint')).ok, true);
  release();
  await p;
  assert.equal(l2.some((l) => l.reason === 'prime'), false, 'not installed over a moved view');
  // A worker fallback (null) leaves the view as it was; no offMain: primeView does nothing.
  const { store: s3, logs: l3 } = storeAt(hiveDir(), { offMain: { run: async () => null } });
  await seeded(s3, 'a1', 23, 10);
  s3.readLedger('a1');
  await s3.primeView('a1');
  assert.equal(l3.some((l) => l.reason === 'prime'), false);
  const { store: s4 } = storeAt(hiveDir());
  await seeded(s4, 'a1', 24, 5);
  await s4.primeView('a1');
  // Sliced (primeSlice 3, a turn between slices): the map equals a fresh derive across the slice edges.
  const r5 = hiveDir();
  const { store: s5, logs: l5 } = storeAt(r5, { offMain: { run: async (job) => J.runDeriveJob(job, null) }, primeSlice: 3 });
  await seeded(s5, 'a1', 25, 40);
  s5.flushKeyRegistry();
  fs.utimesSync(REG.registryPath(r5), old, old);
  s5.readLedger('a1');
  await s5.primeView('a1');
  assert.ok(l5.some((l) => l.reason === 'prime'), 'sliced prime installed');
  const reg5 = REG.loadRegistryShared(r5);
  const fresh5 = derive(diskRecords(s5, 'a1'), reg5, { r4: false });
  const n5 = l5.filter((l) => l.kind === 'claims-view-derive').length;
  const got5 = s5.statusesOf('a1', s5.current('a1'), Object.keys(fresh5.claims), reg5);
  for (const id of Object.keys(fresh5.claims)) assert.equal(got5.get(id), fresh5.claims[id].status, id);
  assert.equal(l5.filter((l) => l.kind === 'claims-view-derive').length, n5, 'the sliced view answers without a derive');
  // Its linked ids are every id a supersede, retract or non-sighting event names, across the slice edges.
  const want5 = new Set();
  for (const r of diskRecords(s5, 'a1')) { if (r.t === 'claim') { for (const id of r.supersedes ?? []) want5.add(id); for (const id of r.retracts ?? []) want5.add(id); } else if (r.t === 'event' && r.ev !== 'sighting') for (const id of r.targets) want5.add(id); }
  assert.ok(want5.size > 0, 'precondition: the seeded ledger links ids');
  assert.deepEqual([...s5.views.get('a1').derived.linked].sort(), [...want5].sort());
  // The view moves between two slices (dropped, as a reread drops it): nothing is installed.
  let dropped = false;
  const { store: s6, logs: l6 } = storeAt(hiveDir(), { offMain: { run: async (job) => { const r = J.runDeriveJob(job, null); setImmediate(() => { dropped = s6.views.delete('a1'); }); return r; } }, primeSlice: 3 });
  await seeded(s6, 'a1', 26, 40);
  s6.readLedger('a1');
  await s6.primeView('a1');
  assert.equal(dropped, true, 'the view was dropped during the prime');
  assert.equal(l6.some((l) => l.reason === 'prime'), false, 'not installed over a view that moved between slices');
  // Codes that are not one per record are never installed.
  const { store: s7, logs: l7 } = storeAt(hiveDir(), { offMain: { run: async () => ({ ok: true, out: 'L' }) } });
  await seeded(s7, 'a1', 27, 10);
  s7.readLedger('a1');
  await s7.primeView('a1');
  assert.equal(l7.some((l) => l.reason === 'prime'), false, 'wrong-length codes');
});

test('A19: the derived writer takes the live ids from the worker, primes the view before its first append, and lands the same claims as the in-process derive', async () => {
  const facts = (tag) => [
    { slot: 'card.alpha.status', key: 'card.alpha.status', kind: 'fact', text: `alpha ${tag}`, refs: [], at: '2026-10-03T09:00:00.000Z' },
    { slot: 'card.beta.status', key: 'card.beta.status', kind: 'fact', text: 'beta same', refs: [], at: '2026-10-03T09:00:00.000Z' },
  ];
  const run = async (useWorker) => {
    const root = hiveDir();
    const { store } = storeAt(root);
    const primes = []; const lives = [];
    const realPrime = store.primeView.bind(store);
    store.primeView = async (a) => { primes.push(a); return realPrime(a); };
    const reg = () => REG.loadRegistryShared(root);
    const deps = { store, derive: (records) => derive(records, reg(), { r4: false }), log: () => {} };
    if (useWorker === 'short') deps.codesOffMain = async (read) => { lives.push(read); return 'L'; };
    else if (useWorker) deps.codesOffMain = async (read) => { lives.push(read); const job = store.verifiedJobFor(DERIVED_AGENT_ID, read); if (!job) return null; const r = J.runDeriveJob({ want: 'codes', agentId: DERIVED_AGENT_ID, ...job, registry: reg(), r4: false }, null); return r.ok ? r.out : null; };
    const c1 = await W.syncDerived(deps, facts('one'));
    const c2 = await W.syncDerived(deps, facts('two'));
    const c3 = await W.syncDerived(deps, facts('two'));
    const c4 = await W.syncDerived(deps, facts('one'));
    const shape = diskRecords(store, DERIVED_AGENT_ID).map((r) => [r.t, r.key, r.text, r.supersedes?.length ?? 0]);
    return { counts: [c1, c2, c3, c4], shape, primes, lives };
  };
  const a = await run(true);
  const b = await run(false);
  const c = await run('short');   // codes that are not one per record: the in-process derive
  assert.deepEqual(c.counts, b.counts);
  assert.deepEqual(c.shape, b.shape);
  assert.deepEqual(a.counts, b.counts);
  assert.deepEqual(a.shape, b.shape);
  assert.ok(a.counts[1].appended >= 1, 'the changed slot is written');
  assert.equal(a.counts[2].appended, 0, 'a rerun writes nothing');
  assert.ok(a.counts[1].superseded >= 1, 'it superseded the live claim of its slot');
  assert.equal(a.counts[2].unchanged, 2);
  assert.ok(a.counts[3].appended >= 1, 'a superseded value is not live: writing it again appends');
  assert.equal(a.lives.length, 4, 'every pass asked the worker');
  assert.equal(a.primes.length, 3, 'primed once per pass that appends, none for an unchanged pass');
});

test('A19 wiring: main uses the worker for the store, the index sync, the derived writer and the warm; the build has the entry', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.ts'), 'utf8');
  assert.match(src, /new ThreadWorker\(join\(__dirname, 'claimsDeriveWorker\.js'\), \{ execArgv: \[\] \}\)/);
  assert.match(src, /offMain: claimsDeriveOffMain,/, 'the store');
  assert.match(src, /offMain: \(agentId, read\) => claimsDeriveJob\('chunks', agentId, read\)/, 'the index sync');
  assert.match(src, /codesOffMain: \(read\) => claimsDeriveJob\('codes', DERIVED_AGENT_ID, read\)/, 'the derived writer');
  assert.match(src, /const off = read \? await claimsDeriveJob\('codes', agentId, read\) : null;/, 'the warm');
  assert.match(src, /if \(read && off && off\.out\.length === read\.records\.length\) \{/, 'the warm reads the codes only when one per record');
  assert.match(src, /store\.verifiedJobFor\(agentId, read\)/, 'only a kept verified read goes to the worker');
  const vite = fs.readFileSync(path.join(ROOT, 'electron.vite.config.ts'), 'utf8');
  assert.match(vite, /claimsDeriveWorker: resolve\(__dirname, 'src\/main\/claims\/deriveWorker\.ts'\)/);
});
