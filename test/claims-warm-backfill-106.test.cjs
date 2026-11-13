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
