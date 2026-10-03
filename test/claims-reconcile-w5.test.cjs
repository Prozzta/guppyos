'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { ReconcileQueue, ReconcileApi, enqueueR5AfterIndex, keyAliasCandidates, TAU2, reconcilePromptText } = loadTs(path.join(__dirname, '../src/main/claims/reconcile.ts'));

test('G5.1 offers at most three leased items and assigns a persisted monotonic agent turn', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-w5-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'queue.json');
  const q = new ReconcileQueue(file, () => new Date('2026-10-03T20:00:00Z'));
  q.refresh('owner', Array.from({ length: 5 }, (_, i) => ({ itemId: `x${i}`, kind: 'conflict', a: `a${i}`, b: `b${i}`, text: `pair ${i}` })));
  const first = q.beginTurn('owner', 99);
  assert.equal(first.turn, 'owner:1'); assert.equal(first.items.length, 3);
  assert.ok(first.items.every((i) => i.leaseTurn === first.turn));
  assert.deepEqual(q.items('owner', 3).map((i) => i.itemId), first.items.map((i) => i.itemId));
  const restarted = new ReconcileQueue(file);
  const second = restarted.beginTurn('owner');
  assert.equal(second.turn, 'owner:2'); assert.equal(second.items.length, 3);
  assert.ok(second.items.every((i) => i.turnsUnanswered === 0), 'a crash-orphaned lease is reclaimed without penalty');
});

test('G5.2 counts only explicitly completed leased turns and repeated completion is idempotent', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-w5-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const q = new ReconcileQueue(path.join(dir, 'queue.json'));
  q.refresh('owner', [{ itemId: 'i', kind: 'conflict', a: 'a', b: 'b', text: 'pair' }]);
  const turn = q.beginTurn('owner').turn;
  assert.equal(q.completeTurn('owner', turn)[0].turnsUnanswered, 1);
  assert.deepEqual(q.completeTurn('owner', turn), []);
  assert.deepEqual(q.items('owner'), []);
  assert.equal(q.beginTurn('owner').items[0].turnsUnanswered, 1);
});

test('G5.5 key aliases are pure, same-namespace, live-claim proposals only', () => {
  const reg = { v: 1, namespaces: [{ pattern: 'release.*', cardinality: 'single' }], keys: {} };
  const claim = (id, key) => ({ id, agent: 'owner', key, t: 'claim', kind: 'fact' });
  const state = { claims: { a: { status: 'live' }, b: { status: 'live' }, c: { status: 'live' }, d: { status: 'superseded' } } };
  const found = keyAliasCandidates('owner', [claim('a', 'release.name'), claim('b', 'release.na_me'), claim('c', 'project.name'), claim('d', 'release.nam')], state, reg);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, 'key-alias');
  assert.deepEqual([found[0].a, found[0].b], ['a', 'b']);
});

test('R5 uses the pinned tau2 and persists candidates for the next owner turn', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-w5-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'queue.json');
  const q = new ReconcileQueue(file);
  assert.equal(TAU2, 0.8);
  q.enqueueR5('owner', [{ a: 'new', b: 'near', cosine: 0.81, tau2: TAU2 }, { a: 'new', b: 'weak', cosine: 0.79, tau2: TAU2 }]);
  const restarted = new ReconcileQueue(file);
  const [candidate] = restarted.r5Candidates('owner');
  assert.equal(candidate.kind, 'conflict');
  assert.match(candidate.text, /0\.810/);
  assert.match(reconcilePromptText({ ...candidate, agent: 'owner', turnsUnanswered: 0 }), /memory reconcile/);
});

test('R5 runs only after a successful index, uses tau2 and logs each enqueued cosine', async () => {
  const order = []; const logs = []; let saved;
  await enqueueR5AfterIndex('owner', 'fresh', {
    syncIndex: async () => { order.push('index'); return { sent: true, reply: { ok: true } }; },
    candidates: async (_agent, id, tau2) => { order.push('candidates'); assert.equal(id, 'fresh'); assert.equal(tau2, TAU2); return [{ a: id, b: 'near', cosine: 0.91, tau2 }, { a: id, b: 'weak', cosine: 0.79, tau2 }]; },
    enqueue: (_agent, pairs) => { order.push('enqueue'); saved = pairs; }, log: (row) => logs.push(row),
  });
  assert.deepEqual(order, ['index', 'candidates', 'enqueue']);
  assert.equal(saved.length, 1); assert.equal(logs.length, 1);
  assert.equal(logs[0].cosine, 0.91); assert.equal(logs[0].tau2, 0.8);
});

test('G5.5 daily reconcile token budget is global across agents and survives restart', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-w5-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'queue.json'); const q = new ReconcileQueue(file);
  assert.equal(q.chargeDailyTokens('2026-10-03', 6000), true);
  assert.equal(q.chargeDailyTokens('2026-10-03', 4001), false);
  const restarted = new ReconcileQueue(file);
  assert.equal(restarted.dailyTokens('2026-10-03'), 6000);
  assert.equal(restarted.chargeDailyTokens('2026-10-03', 4000), true);
});

test('G5.3 owner-only delivery and G5.5 count only injected item text plus answer ask', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-w5-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const q = new ReconcileQueue(path.join(dir, 'queue.json'));
  q.refresh('owner', [{ itemId: 'i', kind: 'conflict', a: 'a', b: 'b', text: 'duplicate facts' }]);
  const log = [];
  const api = new ReconcileApi({ queue: q, countTokens: (s) => s.split(/\s+/).length, log: (r) => log.push(r),
    appendSoftSupersede: async () => ({ ok: true }), newestWins: () => null, isOwner: (a) => a === 'owner' });
  const wing = api.reconcileForTurn('wing', '2026-10-03');
  assert.deepEqual(wing.itemIds, []); assert.equal(log.length, 0);
  const owner = api.reconcileForTurn('owner', '2026-10-03');
  assert.deepEqual(owner.itemIds, ['i']);
  assert.equal(owner.tokens, api.d.countTokens(reconcilePromptText(q.items('owner')[0])));
  assert.equal(log[0].tokens, owner.tokens);
});

test('G5.2/G5.4 W5 API applies newest-wins only after three completed unanswered turns', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-w5-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const q = new ReconcileQueue(path.join(dir, 'queue.json'));
  q.refresh('owner', [{ itemId: 'conflict', kind: 'conflict', a: 'old', b: 'new', text: 'same slot' }]);
  const appended = [];
  const api = new ReconcileApi({ queue: q, countTokens: () => 1, log: () => {}, isOwner: () => true,
    newestWins: () => ({ loser: 'old', winner: 'new' }),
    appendSoftSupersede: async (...args) => { appended.push(args); return { ok: true }; } });
  for (let n = 0; n < 2; n++) {
    const delivery = api.reconcileForTurn('owner', '2026-10-03');
    await api.onTurnCompleted('owner', delivery.turn);
    assert.equal(appended.length, 0);
  }
  const third = api.reconcileForTurn('owner', '2026-10-03');
  await api.onTurnCompleted('owner', third.turn);
  assert.deepEqual(appended, [['owner', 'old', 'new', 'conflict']]);
  assert.deepEqual(q.items('owner'), []);
});
