'use strict';
require('./tools/own-job.cjs');
/**
 * WAKE-OWNER-HOLD-ORPHAN (1.1.91): Jim (2026-10-17 22:30Z) and Andy (21:41Z) sat `owner-inhibited`
 * for hours on 1.1.90, and nobody was told.
 *
 * An automatic wake settled INTERFERED (PRIOR_TEXT_ON_PROMPT on a wake retry). Two holds were made:
 * the coordinator's held claim and the submit owner's hold on the terminal. A turn then surfaced the
 * held ids by hook, so the ids left the inbox and reconcile() dropped the coordinator's claim. The
 * owner's hold stayed (only a person or a positive recheck ends it), and it refused every later
 * wake. The held-wake watch read its holds from the coordinator's claims, so this one had no
 * recheck, its notice was lifted and it got no floor item. The stall watch wrote one
 * `owner-inhibited` row, which reaches nobody.
 *
 * Fix: (1) the watch reads the owner's holds (heldWakesOf), so an orphan keeps its recheck, notice
 * and floor item. (2) Every announced wake stall, whatever guard refuses, is a floor-digest decision.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const HELD = loadTs('src/main/heldInterference.ts');
const { WakeStallWatch, WAKE_STALL_AFTER_MS } = loadTs('src/main/wakeStall.ts');
const { decisionItems } = loadTs('src/main/floorDigest.ts');
const { WorkerWakeWatchdog } = loadTs('src/main/workerWake.ts');
const ROOT = path.join(__dirname, '..');

const facts = (agentId, now) => ({ agentId, ptyId: `p-${agentId}`, paused: false, halted: false, autoDeliveryPaused: false, inhibited: false, lastOutputAt: now - 60_000 });

test('the Jim/Andy shape: the coordinator drops its held claim when the ids leave the inbox; the owner hold is still a held wake', () => {
  const c = new WorkerWakeWatchdog();
  const t0 = 50_000_000;
  c.reconcile('jim', ['m1']);
  const claim = c.claim(facts('jim', t0), 'reconcile', 'reconcile', t0);
  assert.ok(claim);
  c.settle(claim, 'INTERFERED', t0 + 1000);
  assert.equal(c.state('jim').held?.requestId, claim.requestId, 'held by the coordinator');
  // The owner's hold on the terminal (AutomaticSubmitOwner.inhibition) for the same request.
  const owner = new Map([['p-jim', { requestId: claim.requestId, reason: 'PRIOR_TEXT_ON_PROMPT', at: t0 + 1000 }]]);
  const read = () => HELD.heldWakesOf([['p-jim', 'jim']], (p) => owner.get(p) ?? null,
    (a) => c.state(a).held, (a) => c.state(a).pending.length);
  assert.deepEqual(read().map((h) => h.messages), [1]);
  // A turn surfaced m1 by hook; then new mail m2 arrives and waits behind the hold.
  c.reconcile('jim', []);
  c.reconcile('jim', ['m2']);
  assert.equal(c.state('jim').held, null, 'the coordinator forgot its hold');
  assert.deepEqual(read(), [{ agentId: 'jim', requestId: claim.requestId, ptyId: 'p-jim', messages: 1, since: t0 + 1000, reason: 'PRIOR_TEXT_ON_PROMPT' }],
    'the owner\'s hold is still seen, with the mail it keeps waiting');
  // And the coordinator refuses as in the log: owner-inhibited.
  assert.equal(c.claim({ ...facts('jim', t0 + 600_000), inhibited: true }, 'reconcile', 'reconcile', t0 + 600_000), null);
  assert.equal(c.whyNoClaim('jim'), 'owner-inhibited');
});

test('heldWakesOf: only this agent\'s automatic wake; a person\'s or another agent\'s request is never a held wake', () => {
  const holds = new Map([
    ['p1', { requestId: 'inbox-wake:a:abc:2', reason: 'R', at: 5 }],
    ['p2', { requestId: 'user-message-7', reason: 'R', at: 5 }],
    ['p3', { requestId: 'inbox-wake:a:abc', reason: 'R', at: 5 }],
    ['p4', null]
  ]);
  const got = HELD.heldWakesOf([['p1', 'a'], ['p2', 'b'], ['p3', 'c'], ['p4', 'd']], (p) => holds.get(p) ?? null, () => null, () => 3);
  assert.deepEqual(got.map((h) => [h.agentId, h.messages]), [['a', 3]]);
  const withClaim = HELD.heldWakesOf([['p1', 'a']], (p) => holds.get(p) ?? null, () => ({ requestId: 'inbox-wake:a:abc:2', ids: ['x', 'y'] }), () => 9);
  assert.equal(withClaim[0].messages, 2, 'the held claim\'s own ids while it lasts');
  const otherClaim = HELD.heldWakesOf([['p1', 'a']], (p) => holds.get(p) ?? null, () => ({ requestId: 'inbox-wake:a:zzz', ids: ['x'] }), () => 4);
  assert.equal(otherClaim[0].messages, 4);
});

test('an orphaned owner hold keeps its recheck and its notice (the watch, fed by heldWakesOf)', async () => {
  const w = { now: 0, rechecks: [], raised: [], cleared: [] };
  const owner = new Map([['p1', { requestId: 'inbox-wake:jim:abc:2', reason: 'PRIOR_TEXT_ON_PROMPT', at: 0 }]]);
  const watch = new HELD.HeldInterferenceWatch({
    heldWakes: () => HELD.heldWakesOf([['p1', 'jim']], (p) => owner.get(p) ?? null, () => null, () => 1),
    recheck: (h) => { w.rechecks.push(h.requestId); return Promise.resolve({ kind: 'HELD', why: 'x', screen: null }); },
    released: () => {},
    notice: { raise: (h) => w.raised.push([w.now, h.agentId]), clear: (a) => w.cleared.push(a) },
    log: () => {},
    now: () => w.now
  });
  for (let t = 0; t <= HELD.HELD_NOTICE_AFTER_MS; t += HELD.HELD_TICK_MS) { w.now = t; watch.tick(t); await new Promise((r) => setImmediate(r)); }
  assert.ok(w.rechecks.length >= 4, `looked at again about once a minute (${w.rechecks.length})`);
  assert.deepEqual(w.raised, [[HELD.HELD_NOTICE_AFTER_MS, 'jim']], 'the Human is told');
  assert.deepEqual(watch.noticed().map((h) => h.agentId), ['jim'], 'and god\'s digest lists it');
  assert.deepEqual(w.cleared, []);
});

test('every announced wake stall is listed for the digest (owner-inhibited included), until it ends', () => {
  const s = new WakeStallWatch();
  s.note('jim', 'owner-inhibited', 1, 0);
  assert.deepEqual(s.stalls(), [], 'not before it is a stall');
  assert.ok(s.note('jim', 'owner-inhibited', 2, WAKE_STALL_AFTER_MS));
  assert.deepEqual(s.stalls(), [{ agentId: 'jim', why: 'owner-inhibited', since: 0, inboxIds: 2 }]);
  s.note('jim', 'owner-inhibited', 3, WAKE_STALL_AFTER_MS + 60_000);
  assert.equal(s.stalls()[0].inboxIds, 3, 'the latest count');
  s.clear('jim');
  assert.deepEqual(s.stalls(), []);
});

test('the floor digest: a wake stall is a decision; one per agent when a hold or a never-quiet run already says it', () => {
  const now = 10 * 60_000;
  const st = { agentId: 'jim', name: 'Jim', why: 'owner-inhibited', inboxIds: 1, since: 0 };
  const items = decisionItems([], [], now, [], [], [], [st]);
  assert.deepEqual(items.map((i) => i.id), ['wake-stall:jim:0']);
  assert.match(items[0].line, /^Jim: 1 message\(s\) undrained for .*refused as "owner-inhibited"/);
  assert.deepEqual(decisionItems([], [], now, [{ agentId: 'jim', messages: 1, since: 0 }], [], [], [st]).map((i) => i.id), ['held-interfered:jim:0']);
  assert.deepEqual(decisionItems([], [], now, [], [], [{ agentId: 'jim', count: 5, since: 0 }], [st]).map((i) => i.id), ['wake-not-quiet:jim:0']);
  assert.deepEqual(decisionItems([], [], now, [], [], [], [{ ...st, why: 'held-interfered' }]), [], 'the hold has its own item once noticed');
});

test('wiring: main feeds the watch from the owner\'s holds and the digest from the stall watch', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.ts'), 'utf8');
  assert.match(src, /heldWakes: \(\) => heldWakesOf\(ptyToAgent, \(ptyId\) => automaticSubmit\.inhibition\(ptyId\),/);
  assert.match(src, /wakeStalls: \(\) => wakeStalls\.stalls\(\)\.map\(/);
  const dig = fs.readFileSync(path.join(ROOT, 'src', 'main', 'floorDigest.ts'), 'utf8');
  assert.match(dig, /wakeStalls: \(\(\) => \{ try \{ return this\.host\.wakeStalls\?\.\(\) \?\? \[\]; \} catch \{ return \[\]; \} \}\)\(\),/);
  // WAKE-STUCK-REFUSAL-ESCALATE added the last argument.
  assert.match(dig, /input\.quietStalls \?\? \[\], input\.wakeStalls \?\? \[\], input\.refusedSettles \?\? \[\]\)/);
});
