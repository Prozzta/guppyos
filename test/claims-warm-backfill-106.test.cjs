'use strict';
require('./tools/own-job.cjs');

/**
 * CLAIMS-WARM-BACKFILL-106 (god 473072; Jim's SHOULD on the A19 10x gate, Andy bf6a15):
 *  - DeriveOffMain reuses an agent's last 'codes' answer while the job's head, count, frozen registry (by identity)
 *    and r4 are the same: a warm backfill's nine passes over an unchanged ledger post one job, not nine. Any change
 *    posts again; an unfrozen registry is never reused; a failed job or a 'chunks' job is not kept; stop() forgets.
 *  - ClaimsIndexSync keeps no snapshot after an in-process (fallback) sync while the worker is enabled, so the next
 *    acked append is a full read for the worker, not a whole-ledger delta derive on main. With the worker off (or
 *    disabled) the snapshot and the main-thread delta stay as before; offMainEnabled absent counts as on.
 *  - The fallback drain (Jim's SHOULD on c9cf16c6): a failed worker's jobs settle null one per turn, never in the
 *    failing turn; a job run meanwhile reaches the fresh worker one turn after the drain; a memo hit does not wait.
 *  - Wiring: index.ts passes offMainEnabled from the DeriveOffMain and spawns the worker with execArgv: [].
 * No real worker, no hive: fakes only.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-warm106-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
test.after(() => {
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const ROOT = path.resolve(__dirname, '..');
const loadTs = require('./load-ts.cjs');
const { DeriveOffMain } = loadTs('src/main/claims/deriveOffMain.ts');
const { ClaimsIndexSync } = loadTs('src/main/claims/indexSync.ts');
const { derive } = loadTs('src/main/claims/derive.ts');

const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); } return o; };
const REG = deepFreeze({ v: 1, namespaces: [], keys: {} });
const JOB = { want: 'codes', agentId: 'a1', files: [], head: 'h', count: 1, registry: REG, r4: false };

/** A fake worker that answers every job ok (or as `answer` says) on the next microtask. */
function offWith(opts = {}) {
  const posted = [];
  let n = 0;
  const handlers = {};
  const w = {
    postMessage(m) {
      posted.push(m);
      const result = opts.answer ? opts.answer(m) : { ok: true, out: `c-${++n}` };
      queueMicrotask(() => handlers.message?.({ id: m.id, result }));
    },
    on(ev, fn) { handlers[ev] = fn; return w; },
    terminate() {},
  };
  const off = new DeriveOffMain({ spawn: () => w, log: () => {}, setTimer: () => 0, clearTimer: () => {} });
  return { off, posted };
}

test('106: the same codes job (head, count, frozen registry, r4) posts once; the answer is reused', async () => {
  const { off, posted } = offWith();
  const first = await off.run(JOB);
  assert.deepEqual(first, { ok: true, out: 'c-1' });
  for (let i = 0; i < 8; i++) assert.equal(await off.run({ ...JOB }), first, `pass ${i + 2} reuses the answer`);
  assert.equal(posted.length, 1, 'nine warm passes, one worker job');
});

test('106: a changed head, count, registry or r4 posts again; another agent has its own answer', async () => {
  const { off, posted } = offWith();
  await off.run(JOB);
  const changes = [
    { head: 'h2' },
    { head: 'h2', count: 2 },
    { head: 'h2', count: 2, registry: deepFreeze({ v: 1, namespaces: [], keys: {} }) },
    { head: 'h2', count: 2, r4: true },
  ];
  let reg = REG;
  for (const [i, c] of changes.entries()) {
    if (c.registry) reg = c.registry;
    await off.run({ ...JOB, registry: reg, ...c });
    assert.equal(posted.length, i + 2, `change ${JSON.stringify(Object.keys(c))} posts`);
  }
  await off.run({ ...JOB, agentId: 'a2' });
  assert.equal(posted.length, 6, 'a2 has no answer yet');
  await off.run({ ...JOB, agentId: 'a2' });
  assert.equal(posted.length, 6, 'a2 reuses its own');
});

test('106: an unfrozen registry is never reused (DEFAULT_KEY_REGISTRY can change in place)', async () => {
  const { off, posted } = offWith();
  const reg = { v: 1, namespaces: [], keys: {} };
  await off.run({ ...JOB, registry: reg });
  await off.run({ ...JOB, registry: reg });
  assert.equal(posted.length, 2);
});

test('106: chunks jobs and failed answers are not kept; stop() forgets', async () => {
  let bad = true;
  const { off, posted } = offWith({ answer: (m) => (m.job.want === 'codes' && bad ? { ok: false, why: 'stale' } : { ok: true, out: 'x' }) });
  assert.equal(await off.run(JOB), null);
  bad = false;
  assert.ok(await off.run(JOB));
  assert.equal(posted.length, 2, 'a stale answer is not reused');
  await off.run({ ...JOB, want: 'chunks' });
  await off.run({ ...JOB, want: 'chunks' });
  assert.equal(posted.length, 4, 'chunks jobs always post');
  await off.run(JOB);
  assert.equal(posted.length, 4, 'and do not clobber the codes answer');
  off.stop();
  await off.run(JOB);
  assert.equal(posted.length, 5, 'stop() forgets the answers');
});

const rec = (id, text) => ({ t: 'claim', id, agent: 'a1', wt: '2026-10-03T10:00:00Z', at: '2026-10-03T10:00:00Z', kind: 'fact', text, prev: '', mac: `m-${id}` });
const r1 = rec('c-000000000001', 'a'), r2 = rec('c-000000000002', 'b');

function syncWith(extra) {
  const sent = []; const asked = []; let reads = 0;
  const st = { read: { records: [r1], torn: null, chain: 'ok' }, answer: null };
  const s = new ClaimsIndexSync({
    readLedger: () => { reads++; return st.read; }, derive: () => derive, registry: () => ({ v: 1, namespaces: [], keys: {} }), ruleConfig: () => ({ r4: false }),
    level: () => 'reader', agents: () => ['a1'], send: async (a) => { sent.push(a); return { ok: true }; },
    setTimer: () => 0, clearTimer: () => {},
    ...extra(asked, st),
  });
  return { s, sent, asked, st, reads: () => reads };
}
const offMain = (asked, st) => async (agentId, r) => { asked.push(r); return st.answer; };

test('106: after a fallback sync with the worker enabled, no snapshot: the next append is a full read for the worker', async () => {
  const { s, sent, asked, st, reads } = syncWith((asked, st) => ({ offMain: offMain(asked, st), offMainEnabled: () => true }));
  await s.syncNow('a1');                         // the worker answered null: an in-process fallback
  assert.equal(asked.length, 1);
  assert.equal(s.snapshots.has('a1'), false, 'no snapshot while the worker is on');
  st.answer = { head: 'H', chunksJson: '[]', count: 0 };
  st.read = { records: [r1, r2], torn: null, chain: 'ok' };
  await s.syncNow('a1', r2);
  assert.equal(asked.length, 2, 'the append goes to the worker');
  assert.equal(asked[1], st.read);
  assert.equal(reads(), 2, 'as a full read');
  assert.equal(sent[1].delta, undefined, 'not a delta');
  assert.equal(sent[1].chunksJson, '[]');
});

test('106: offMainEnabled absent with an offMain counts as on', async () => {
  const { s, asked } = syncWith((asked, st) => ({ offMain: offMain(asked, st) }));
  await s.syncNow('a1');
  assert.equal(asked.length, 1);
  assert.equal(s.snapshots.has('a1'), false);
});

test('106: the worker off (disabled, or no offMain) keeps the snapshot and the delta on main', async () => {
  for (const [name, extra] of [
    ['disabled', (asked, st) => ({ offMain: offMain(asked, st), offMainEnabled: () => false })],
    ['no offMain', () => ({})],
  ]) {
    const { s, sent, asked, st, reads } = syncWith(extra);
    await s.syncNow('a1');
    assert.equal(s.snapshots.has('a1'), true, `${name}: snapshot kept`);
    st.read = { records: [r1, r2], torn: null, chain: 'ok' };
    await s.syncNow('a1', r2);
    assert.equal(sent[1].delta, true, `${name}: the append is a delta`);
    assert.equal(reads(), 1, `${name}: the delta read nothing`);
    assert.ok(asked.length <= 1, `${name}: the delta never asked the worker`);
  }
});

test('106 wiring: index.ts passes offMainEnabled and spawns the worker with execArgv: []', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.ts'), 'utf8');
  assert.match(src, /offMainEnabled: \(\) => claimsDeriveOffMain\.enabled,/);
  assert.match(src, /new ThreadWorker\(join\(__dirname, 'claimsDeriveWorker\.js'\), \{ execArgv: \[\] \}\)/);
});

// ---------------------------------------------------------------- the fallback drain (Jim's SHOULD on c9cf16c6, god go)

/** A DeriveOffMain whose worker never answers (a hang), with a manual turn queue and timers. */
function drainRig() {
  const turns = []; const timers = []; const workers = [];
  const off = new DeriveOffMain({
    spawn: () => {
      const handlers = {};
      const w = { posted: [], terminated: 0, postMessage(m) { w.posted.push(m); }, on(ev, fn) { handlers[ev] = fn; return w; }, terminate() { w.terminated++; }, emit(ev, a) { handlers[ev]?.(a); } };
      workers.push(w); return w;
    },
    log: () => {}, maxFailures: 99,
    setTimer: (fn) => { timers.push(fn); return timers.length; }, clearTimer: (t) => { timers[t - 1] = null; },
    yieldTurn: (fn) => { turns.push(fn); },
  });
  /** Run one queued turn, then let its microtasks finish. */
  const turn = async () => { const fn = turns.shift(); assert.ok(fn, 'a turn is queued'); fn(); for (let i = 0; i < 5; i++) await null; };
  return { off, turns, timers, workers, turn };
}
const flush = async () => { for (let i = 0; i < 5; i++) await null; };
/** A promise that must settle: 'held' after 2 s, so a mutant that never settles it fails the assert instead of hanging the file. */
const within = (p, ms = 2000) => Promise.race([p, new Promise((r) => setTimeout(() => r('held'), ms))]);

test('106 drain: a failed worker\'s jobs settle one per turn, in order, never in the failing turn', async () => {
  const { off, workers, turn } = drainRig();
  const settled = [];
  const jobs = [0, 1, 2].map((i) => off.run({ ...JOB, want: 'chunks', head: `h${i}` }).then((r) => { settled.push([i, r]); }));
  assert.equal(workers[0].posted.length, 3);
  workers[0].emit('error', new Error('boom'));
  await flush();
  assert.deepEqual(settled, [], 'nothing settles in the failing turn');
  for (let k = 1; k <= 3; k++) {
    await turn();
    assert.deepEqual(settled.map(([i]) => i), [0, 1, 2].slice(0, k), `turn ${k} settles job ${k - 1} only`);
  }
  assert.ok(settled.every(([, r]) => r === null));
  await Promise.all(jobs);
});

test('106 drain: a job run during the drain reaches the fresh worker only one turn after the last held job settled', async () => {
  const { off, workers, turn, timers } = drainRig();
  const held = [0, 1].map((i) => off.run({ ...JOB, want: 'chunks', head: `h${i}` }));
  timers[0]();                                    // a hang: the timeout fails the worker
  assert.equal(workers[0].terminated, 1);
  const late = off.run({ ...JOB, want: 'chunks', head: 'late' });
  await flush();
  assert.equal(workers.length, 1, 'no fresh worker while the drain runs');
  await turn(); await turn();                     // both held jobs settle
  assert.deepEqual(await within(Promise.all(held)), [null, null]);
  assert.equal(workers.length, 1, 'not in the turn of the last settle either');
  await turn();                                   // the drain ends: the late job is posted
  assert.equal(workers.length, 2);
  assert.equal(workers[1].posted.length, 1);
  assert.equal(workers[1].posted[0].job.head, 'late');
  workers[1].emit('message', { id: workers[1].posted[0].id, result: { ok: true, out: 'x' } });
  assert.deepEqual(await within(late), { ok: true, out: 'x' });
});

test('106 drain: stop() drains the same way; a memo hit does not wait for the drain', async () => {
  const { off, workers, turn } = drainRig();
  const codes = off.run(JOB);
  workers[0].emit('message', { id: workers[0].posted[0].id, result: { ok: true, out: 'c' } });
  const answer = await codes;
  const held = off.run({ ...JOB, want: 'chunks' });
  workers[0].emit('exit', 1);
  assert.equal(await within(off.run(JOB)), answer, 'the memo answers at once during the drain');
  let done = false; held.then(() => { done = true; });
  await flush();
  assert.equal(done, false);
  await turn();
  assert.equal(done, true);
  // stop(): the same one-per-turn drain.
  const a = off.run({ ...JOB, want: 'chunks', head: 'a' });
  await turn();                                    // the earlier drain ends; a is posted to a fresh worker
  assert.equal(workers.length, 2);
  let aDone = false; a.then(() => { aDone = true; });
  off.stop();
  await flush();
  assert.equal(aDone, false, 'stop settles nothing in its own turn');
  await turn();
  assert.equal(aDone, true);
  assert.equal(await within(a), null);
});

test('106 drain wiring: the default turn is setImmediate', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'claims', 'deriveOffMain.ts'), 'utf8');
  assert.match(src, /this\.yieldTurn = d\.yieldTurn \?\? \(\(fn\) => \{ setImmediate\(fn\); \}\);/);
});
