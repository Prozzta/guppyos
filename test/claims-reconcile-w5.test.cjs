'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { ReconcileQueue, ReconcileApi, enqueueR5AfterIndex, shouldRunR5, keyAliasCandidates, reconcileItemId, TAU2, reconcilePromptText } = loadTs(path.join(__dirname, '../src/main/claims/reconcile.ts'));
const { reconcileApiForHive, createReconcileLiveClaims, refreshReconcileQueueForHive } = loadTs(path.join(__dirname, '../src/main/claims/reconcileHive.ts'));
const { handleClaimVerb } = loadTs(path.join(__dirname, '../src/main/claims/endpoint.ts'));

test('W5 main wiring mutants: dropping answer, post-index refresh, or startup refresh is killed', () => {
  const file = path.join(__dirname, '../src/main/index.ts');
  const source = fs.readFileSync(file, 'utf8');
  const answerWired = (text) => text.includes('onReconcile: (agentId, a, b) => reconcileQueueForHive(root).answeredPair(agentId, a, b)');
  const postIndexWired = (text) => /onIndexed: \(agentId\) =>[^\n]*refreshReconcileQueueForHive\(root, agentId, reconcileHiveDeps\(\)\)/.test(text);
  const startupWired = (text) => /W5 startup census[\s\S]{0,260}refreshReconcileQueueForHive\(root, agentId, reconcileHiveDeps\(\)\)/.test(text);
  assert.equal(answerWired(source) && postIndexWired(source) && startupWired(source), true);
  const mutants = [
    ['G1/onReconcile omitted', source.replace(/onReconcile: \(agentId, a, b\) => reconcileQueueForHive\(root\)\.answeredPair\(agentId, a, b\),?/, ''), answerWired],
    ['G2/post-index refresh omitted', source.replace(/onIndexed: \(agentId\) =>[^\n]+/, ''), postIndexWired],
    ['G2/startup refresh omitted', source.replace(/setImmediate\(\(\) => \{ for \(const agentId of claimLedgerAgents\(\)\) \{ try \{ refreshReconcileQueueForHive\(root, agentId, reconcileHiveDeps\(\)\);[^\n]+/, ''), startupWired],
  ];
  for (const [name, mutant, pin] of mutants) {
    assert.equal(pin(mutant), false, `${name} mutant must die`);
    console.log(`# MUTANT KILLED: ${name}`);
  }
});

test('G1 main endpoint answer clears its pair before three-turn completion can supersede it', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-w5-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const queue = new ReconcileQueue(path.join(dir, 'queue.json'));
  queue.refresh('owner', [{ itemId: reconcileItemId('owner', 'conflict', 'a', 'b'), kind: 'conflict', a: 'a', b: 'b', text: 'pair' }]);
  const store = { lookup: () => ({ kind: 'fact' }), appendRecord: async () => ({ ok: true }) };
  const result = await handleClaimVerb({ store, level: () => 'writer', onReconcile: (agentId, a, b) => queue.answeredPair(agentId, a, b) }, 'owner', { cmd: 'reconcile', args: { a: 'a', b: 'b', answer: 'keep-both' } }, 'endpoint');
  assert.equal(result.ok, true);
  assert.equal(queue.items('owner').length, 0);
  let supersedes = 0;
  const api = new ReconcileApi({ queue, countTokens: () => 1, log: () => {}, appendSoftSupersede: async () => { supersedes++; return { ok: true }; }, newestWins: () => ({ loser: 'a', winner: 'b' }), isLiveClaim: () => true, isOwner: () => true });
  for (let i = 0; i < 3; i++) { const turn = api.reconcileForTurn('owner', '2026-10-04'); await api.onTurnCompleted('owner', turn.turn); }
  assert.equal(supersedes, 0, 'an answered keep-both must not be treated as unanswered');
});

test('G2 verified census queues R2-mail and key alias exactly once across refreshes', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-w5-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const queue = new ReconcileQueue(path.join(dir, 'queue.json'));
  const claim = (id, key, source = 'self') => ({ t: 'claim', id, agent: 'owner', at: `2026-10-0${id === 'a' ? 2 : id === 'b' ? 1 : 3}T00:00:00Z`, wt: '2026-10-04T00:00:00Z', mac: id, prev: '', kind: 'fact', key, text: `synthetic ${id}`, source });
  const records = [claim('a', 'fact.name', 'mail:m1'), claim('b', 'fact.name'), claim('c', 'release.name'), claim('d', 'release.na_me')];
  const deps = { endpoint: () => ({ store: { readLedger: () => ({ chain: 'ok', records }) } }), queue: () => queue,
    registry: () => ({ v: 1, namespaces: [{ pattern: 'fact.*', cardinality: 'single' }, { pattern: 'release.*', cardinality: 'single' }], keys: {} }), log: () => {} };
  refreshReconcileQueueForHive(dir, 'owner', deps);
  refreshReconcileQueueForHive(dir, 'owner', deps);
  assert.equal(queue.peek('owner', 10).length, 2);
  assert.deepEqual(queue.peek('owner', 10).map((i) => i.kind).sort(), ['conflict', 'key-alias']);
  assert.equal(queue.peek('owner', 10).find((item) => item.kind === 'conflict').rule, 'R2-mail');
});

test('M1U refresh keeps the R2-mail rule through three completed turns and appends newest-wins', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-w5-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const queue = new ReconcileQueue(path.join(dir, 'queue.json'));
  const records = [
    { t: 'claim', id: 'mail-new', agent: 'owner', at: '2026-10-02T00:00:00Z', wt: '2026-10-02T00:00:00Z', mac: 'mail-new', prev: '', kind: 'fact', key: 'fact.name', text: 'synthetic mail value', source: 'mail:m1' },
    { t: 'claim', id: 'prior', agent: 'owner', at: '2026-10-01T00:00:00Z', wt: '2026-10-01T00:00:00Z', mac: 'prior', prev: '', kind: 'fact', key: 'fact.name', text: 'synthetic prior value', source: 'self' },
  ];
  const appends = [];
  const store = { readLedger: () => ({ chain: 'ok', records }), appendSoftSupersede: async (...args) => { appends.push(args); return { ok: true }; } };
  const deps = {
    endpoint: () => ({ store }), queue: () => queue, countTokens: () => 1, log: () => {},
    registry: () => ({ v: 1, namespaces: [{ pattern: 'fact.*', cardinality: 'single' }], keys: {} }),
    isOwner: () => true,
  };
  refreshReconcileQueueForHive(dir, 'owner', deps);
  const [item] = queue.peek('owner', 10);
  assert.equal(item.rule, 'R2-mail');
  assert.deepEqual([item.a, item.b].sort(), ['mail-new', 'prior']);
  const api = reconcileApiForHive(dir, deps);
  assert.ok(api);
  for (let i = 0; i < 3; i++) {
    const delivery = api.reconcileForTurn('owner', '2026-10-04');
    await api.onTurnCompleted('owner', delivery.turn);
  }
  assert.deepEqual(appends, [['owner', 'prior', 'mail-new', item.itemId]]);
});

test('M-R refresh never resurrects a soft-superseded R2-mail pair or an answered alias', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-w5-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const queue = new ReconcileQueue(path.join(dir, 'queue.json'));
  const claim = (id, key, at, source = 'self') => ({ t: 'claim', id, agent: 'owner', at, wt: at, mac: id, prev: '', kind: 'fact', key, text: `synthetic ${id}`, source });
  const event = (id, ev, targets, answer) => ({ t: 'event', id, agent: 'owner', at: '2026-10-04T01:00:00Z', wt: '2026-10-04T01:00:00Z', mac: id, prev: '', ev, targets, by: 'self', ...(answer ? { answer } : {}) });
  const base = [claim('a', 'fact.name', '2026-10-02T00:00:00Z', 'mail:m1'), claim('b', 'fact.name', '2026-10-01T00:00:00Z'), claim('c', 'release.name', '2026-10-03T00:00:00Z'), claim('d', 'release.na_me', '2026-10-03T00:00:00Z')];
  let records = base;
  const deps = { endpoint: () => ({ store: { readLedger: () => ({ chain: 'ok', records }) } }), queue: () => queue,
    registry: () => ({ v: 1, namespaces: [{ pattern: 'fact.*', cardinality: 'single' }, { pattern: 'release.*', cardinality: 'single' }], keys: {} }), log: () => {} };
  refreshReconcileQueueForHive(dir, 'owner', deps);
  assert.deepEqual(queue.peek('owner', 10).map((i) => i.kind).sort(), ['conflict', 'key-alias']);
  records = [...base, event('soft', 'soft-supersede', ['b', 'a'])];
  queue.answeredPair('owner', 'a', 'b');
  refreshReconcileQueueForHive(dir, 'owner', deps);
  assert.equal(queue.peek('owner', 10).some((i) => i.kind === 'conflict' && [i.a, i.b].includes('a') && [i.a, i.b].includes('b')), false);
  for (const [name, answerEvent] of [
    ['dismiss', event('dismiss', 'dismiss', ['c', 'd'])],
    ['keep-both', event('keep-both', 'reconcile-answer', ['d', 'c'], 'keep-both')],
    ['accept', event('accept', 'accept', ['c', 'd'])],
  ]) {
    records = [...base, answerEvent];
    refreshReconcileQueueForHive(dir, 'owner', deps);
    assert.equal(queue.peek('owner', 10).some((i) => i.kind === 'key-alias' && [i.a, i.b].includes('c') && [i.a, i.b].includes('d')), false, `${name} alias must stay resolved`);
  }
});

test('M-R refresh re-queues an R2-mail pair after its soft-supersede is reverted', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-w5-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const queue = new ReconcileQueue(path.join(dir, 'queue.json'));
  const claim = (id, at, source = 'self') => ({ t: 'claim', id, agent: 'owner', at, wt: at, mac: id, prev: '', kind: 'fact', key: 'fact.name', text: `synthetic ${id}`, source });
  const event = (id, ev, targets) => ({ t: 'event', id, agent: 'owner', at: '2026-10-04T01:00:00Z', wt: '2026-10-04T01:00:00Z', mac: id, prev: '', ev, targets, by: 'self' });
  const base = [claim('a', '2026-10-02T00:00:00Z', 'mail:m1'), claim('b', '2026-10-01T00:00:00Z')];
  let records = [...base, event('soft', 'soft-supersede', ['b', 'a'])];
  const deps = { endpoint: () => ({ store: { readLedger: () => ({ chain: 'ok', records }) } }), queue: () => queue,
    registry: () => ({ v: 1, namespaces: [{ pattern: 'fact.*', cardinality: 'single' }], keys: {} }), log: () => {} };
  refreshReconcileQueueForHive(dir, 'owner', deps);
  assert.equal(queue.peek('owner', 10).some((i) => i.kind === 'conflict' && [i.a, i.b].includes('a') && [i.a, i.b].includes('b')), false,
    'active soft-supersede should suppress the R2-mail proposal');
  records = [...records, event('revert', 'revert', ['soft'])];
  refreshReconcileQueueForHive(dir, 'owner', deps);
  assert.equal(queue.peek('owner', 10).some((i) => i.kind === 'conflict' && [i.a, i.b].includes('a') && [i.a, i.b].includes('b')), true,
    'reverting the soft-supersede should re-open the R2-mail proposal');
});

test('M-R census exclusion mutants are killed for both conflict and alias arms', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/main/claims/reconcileHive.ts'), 'utf8');
  const conflictFilter = (text) => /state\.conflicts\.filter\(\(item\) => item\.rule === 'R2-mail' && !resolved\.has\(pairKey\(item\.a, item\.b\)\)\)/.test(text);
  const aliasFilter = (text) => /keyAliasCandidates\(agentId, claims, state, registry\)\.filter\(\(item\) => !resolved\.has\(pairKey\(item\.a, item\.b\)\)\)/.test(text);
  assert.equal(conflictFilter(source) && aliasFilter(source), true);
  assert.equal(conflictFilter(source.replace(' && !resolved.has(pairKey(item.a, item.b))', '')), false, 'mutant reintroducing resolved conflicts');
  assert.equal(aliasFilter(source.replace('keyAliasCandidates(agentId, claims, state, registry).filter((item) => !resolved.has(pairKey(item.a, item.b)))', 'keyAliasCandidates(agentId, claims, state, registry)')), false, 'mutant reintroducing answered aliases');
  console.log('# MUTANT KILLED: M-R resolved conflict exclusion reverted');
  console.log('# MUTANT KILLED: M-R answered alias exclusion reverted');
});

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

test('R5 never queries candidates or enqueues when index is absent, unsent, failed, or throws', async () => {
  for (const syncIndex of [
    async () => null,
    async () => ({ sent: false }),
    async () => ({ sent: true, reply: { ok: false } }),
    async () => { throw new Error('index threw'); },
  ]) {
    let queried = 0, enqueued = 0;
    await enqueueR5AfterIndex('owner', 'fresh', {
      syncIndex,
      candidates: async () => { queried++; return []; },
      enqueue: () => { enqueued++; }, log: () => {},
    });
    assert.equal(queried, 0); assert.equal(enqueued, 0);
  }
});

test('R5 predicate excludes one-time imports but includes reader notes carrying legacy provenance', () => {
  const claim = { t: 'claim', source: 'self', id: 'x' };
  assert.equal(shouldRunR5({ ...claim, source: 'legacy' }), false);
  assert.equal(shouldRunR5({ ...claim, legacy: { file: 'memory.md', line: 1, sha256: 'a'.repeat(64) } }), true);
  assert.equal(shouldRunR5({ t: 'event', ev: 'pin' }), false);
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

test('S1 reconcileApiForHive builds an API and its live-claim state stays isolated', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-w5-hive-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const records = {
    alpha: [
      { v: 1, t: 'claim', id: 'alpha-old', agent: 'alpha', at: '2026-01-01T00:00:00Z', wt: '2026-01-01T00:00:00Z', mac: 'a1', prev: '', kind: 'fact', text: 'old', source: 'self' },
      { v: 1, t: 'claim', id: 'alpha-new', agent: 'alpha', at: '2026-01-02T00:00:00Z', wt: '2026-01-02T00:00:00Z', mac: 'a2', prev: 'a1', kind: 'fact', text: 'new', source: 'self' },
    ],
    beta: [
      { v: 1, t: 'claim', id: 'beta-old', agent: 'beta', at: '2026-01-01T00:00:00Z', wt: '2026-01-01T00:00:00Z', mac: 'b1', prev: '', kind: 'fact', text: 'old', source: 'self' },
      { v: 1, t: 'claim', id: 'beta-new', agent: 'beta', at: '2026-01-02T00:00:00Z', wt: '2026-01-02T00:00:00Z', mac: 'b2', prev: 'b1', kind: 'fact', text: 'new', source: 'self' },
    ],
  };
  const queue = new ReconcileQueue(path.join(dir, 'queue.json'));
  const log = [];
  const api = reconcileApiForHive(dir, {
    endpoint: () => ({ store: { readLedger: (agent) => ({ chain: 'ok', records: records[agent] || [] }), appendSoftSupersede: async (...args) => ({ ok: true, args }) } }),
    queue: () => queue, countTokens: () => 1, log: (row) => log.push(row), registry: () => ({ v: 1, namespaces: [], keys: {} }), isOwner: () => true,
  });
  assert.ok(api instanceof ReconcileApi);
  assert.deepEqual(api.peekForTurn('alpha', '2026-10-04'), []);

  const alpha = createReconcileLiveClaims(() => ({ live: new Set(['alpha-old', 'alpha-new']), direction: { loser: 'alpha-old', winner: 'alpha-new' } }));
  const beta = createReconcileLiveClaims(() => ({ live: new Set(['beta-old', 'beta-new']), direction: { loser: 'beta-old', winner: 'beta-new' } }));
  alpha.newestWins({ agent: 'alpha', a: 'alpha-old', b: 'alpha-new' });
  beta.newestWins({ agent: 'beta', a: 'beta-old', b: 'beta-new' });
  assert.equal(alpha.isLiveClaim('alpha-new'), true);
  assert.equal(alpha.isLiveClaim('beta-new'), false);
  assert.equal(beta.isLiveClaim('beta-new'), true);
  assert.equal(beta.isLiveClaim('alpha-new'), false);
});

test('S-b reconcileApiForHive never soft-supersedes a conflict with a non-live loser', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-w5-hivelive-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const records = [
    { v: 1, t: 'claim', id: 'old', agent: 'alpha', at: '2026-01-01T00:00:00Z', wt: '2026-01-01T00:00:00Z', mac: 'm1', prev: '', kind: 'fact', key: 'fact.name', text: 'old', source: 'self' },
    { v: 1, t: 'claim', id: 'new', agent: 'alpha', at: '2026-01-02T00:00:00Z', wt: '2026-01-02T00:00:00Z', mac: 'm2', prev: 'm1', kind: 'fact', key: 'fact.name', text: 'new', source: 'self' },
  ];
  const queue = new ReconcileQueue(path.join(dir, 'queue.json'));
  queue.refresh('alpha', [{ itemId: 'conflict:nonlive-loser', kind: 'conflict', a: 'old', b: 'new', text: 'candidate' }]);
  let appends = 0;
  const api = reconcileApiForHive(dir, {
    endpoint: () => ({ store: { readLedger: () => ({ chain: 'ok', records }), appendSoftSupersede: async () => { appends++; return { ok: true }; } } }),
    queue: () => queue, countTokens: () => 1, log: () => {}, registry: () => ({ v: 1, namespaces: [{ pattern: 'fact.*', cardinality: 'single' }], keys: {} }), isOwner: () => true,
  });
  for (let n = 0; n < 3; n++) {
    const delivery = api.reconcileForTurn('alpha', '2026-10-04');
    await api.onTurnCompleted('alpha', delivery.turn);
  }
  assert.equal(appends, 0, 'a superseded conflict side cannot be a soft-supersede target');
  assert.equal(queue.items('alpha').length, 0, 'the answered/non-actionable pair is removed after the third turn');
});

test('G5.5 daily token accounting prunes entries older than seven days', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-w5-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const q = new ReconcileQueue(path.join(dir, 'queue.json'));
  assert.equal(q.chargeDailyTokens('2026-09-25', 20), true);
  assert.equal(q.chargeDailyTokens('2026-10-03', 5), true);
  assert.equal(q.dailyTokens('2026-09-25'), 0);
  assert.equal(q.dailyTokens('2026-10-03'), 5);
});

test('G5.3 owner-only delivery with queued foreign work and G5.5 count only injected text', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-w5-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const q = new ReconcileQueue(path.join(dir, 'queue.json'));
  q.refresh('wing', [{ itemId: 'foreign', kind: 'conflict', a: 'fa', b: 'fb', text: 'private pair' }]);
  q.refresh('owner', [{ itemId: 'i', kind: 'conflict', a: 'a', b: 'b', text: 'duplicate facts' }]);
  const log = [];
  const api = new ReconcileApi({ queue: q, countTokens: (s) => s.split(/\s+/).length, log: (r) => log.push(r),
    appendSoftSupersede: async () => ({ ok: true }), newestWins: () => null, isLiveClaim: () => true, isOwner: (a) => a === 'owner' });
  const wing = api.reconcileForTurn('wing', '2026-10-03');
  assert.deepEqual(wing.itemIds, []); assert.equal(log.length, 0);
  assert.deepEqual(q.items('wing'), [], 'the non-owner queue was not leased');
  const owner = api.reconcileForTurn('owner', '2026-10-03');
  assert.deepEqual(owner.itemIds, ['i']);
  assert.equal(owner.tokens, api.d.countTokens(reconcilePromptText(q.items('owner')[0])));
  assert.equal(log[0].tokens, owner.tokens);
});

test('G5.5 three queued items charge only two that fit; the third lease is released', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-w5-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const q = new ReconcileQueue(path.join(dir, 'queue.json'));
  q.refresh('owner', Array.from({ length: 3 }, (_, i) => ({ itemId: `i${i}`, kind: 'conflict', a: `a${i}`, b: `b${i}`, text: `pair ${i}` })));
  const api = new ReconcileApi({ queue: q, countTokens: () => 5, log: () => {}, appendSoftSupersede: async () => ({ ok: true }),
    newestWins: () => null, isLiveClaim: () => true, isOwner: () => true });
  q.chargeDailyTokens('2026-10-03', 9990);
  const delivery = api.reconcileForTurn('owner', '2026-10-03');
  assert.deepEqual(delivery.itemIds, ['i0', 'i1']);
  assert.equal(delivery.tokens, 10);
  assert.deepEqual(q.items('owner').map((i) => i.itemId), ['i0', 'i1']);
  assert.equal(q.dailyTokens('2026-10-03'), 10_000);
});

test('key-alias proposals never soft-supersede after repeated completed turns', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-w5-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const q = new ReconcileQueue(path.join(dir, 'queue.json'));
  q.refresh('owner', [{ itemId: 'alias', kind: 'key-alias', a: 'a', b: 'b', text: 'near keys' }]);
  let appends = 0;
  const api = new ReconcileApi({ queue: q, countTokens: () => 1, log: () => {}, isOwner: () => true, isLiveClaim: () => true,
    newestWins: () => ({ loser: 'a', winner: 'b' }), appendSoftSupersede: async () => { appends++; return { ok: true }; } });
  for (let i = 0; i < 4; i++) {
    const delivery = api.reconcileForTurn('owner', '2026-10-03');
    await api.onTurnCompleted('owner', delivery.turn);
  }
  assert.equal(appends, 0);
});

test('G5.2 API applies newest-wins only after three completed unanswered turns', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-w5-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const q = new ReconcileQueue(path.join(dir, 'queue.json'));
  q.refresh('owner', [{ itemId: reconcileItemId('owner', 'conflict', 'old', 'new'), kind: 'conflict', rule: 'R2-mail', a: 'old', b: 'new', text: 'synthetic owner mail conflict' }]);
  const appended = [];
  const api = new ReconcileApi({ queue: q, countTokens: () => 1, log: () => {}, isOwner: () => true,
    isLiveClaim: () => true,
    newestWins: (item) => item.a === 'old' && item.b === 'new' ? ({ loser: 'old', winner: 'new' }) : null,
    appendSoftSupersede: async (...args) => { appended.push(args); return { ok: true }; } });
  for (let n = 0; n < 2; n++) {
    const delivery = api.reconcileForTurn('owner', '2026-10-03');
    await api.onTurnCompleted('owner', delivery.turn);
    assert.equal(appended.length, 0);
  }
  const third = api.reconcileForTurn('owner', '2026-10-03');
  await api.onTurnCompleted('owner', third.turn);
  const resolvedItemId = reconcileItemId('owner', 'conflict', 'old', 'new');
  assert.deepEqual(appended, [['owner', 'old', 'new', resolvedItemId]]);
  assert.deepEqual(q.items('owner'), []);
  assert.deepEqual(q.r5Candidates('owner'), []);
  q.enqueueR5('owner', [{ a: 'other', b: 'pair', cosine: 0.95, tau2: TAU2 }]);
  const next = api.reconcileForTurn('owner', '2026-10-03');
  assert.deepEqual(next.itemIds, [reconcileItemId('owner', 'conflict', 'other', 'pair')], 'the resolved R5 pair is never offered again');
  assert.deepEqual(q.r5Candidates('owner').map((c) => [c.a, c.b]), [['other', 'pair']]);
  assert.equal(appended.filter((args) => args[1] === 'old' && args[2] === 'new').length, 1,
    'the resolved pair cannot recur through later refresh/turns');
});

test('M1U: unanswered non-mail suggestions expire keep-both at 3 turns and newest-wins mutants are rejected', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-w5-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const q = new ReconcileQueue(path.join(dir, 'queue.json'));
  q.enqueueR5('owner', [{ a: 'new', b: 'old', cosine: 0.9, tau2: TAU2 }]);
  const logs = []; let newestWinsCalls = 0; let appends = 0;
  const api = new ReconcileApi({ queue: q, countTokens: () => 1, log: (row) => logs.push(row), isOwner: () => true,
    isLiveClaim: () => true, newestWins: () => { newestWinsCalls++; return ({ loser: 'old', winner: 'new' }); },
    appendSoftSupersede: async () => { appends++; return { ok: true }; } });
  for (let i = 0; i < 3; i++) {
    const delivery = api.reconcileForTurn('owner', '2026-10-03');
    await api.onTurnCompleted('owner', delivery.turn);
  }
  assert.equal(appends, 0);
  assert.equal(newestWinsCalls, 0);
  assert.deepEqual(q.items('owner'), []);
  assert.deepEqual(q.r5Candidates('owner'), []);
  assert.deepEqual(logs.filter(row => row.kind === 'claims-reconcile-expired').map(({ a, b, rule, turnsUnanswered, resolution }) => ({ a, b, rule, turnsUnanswered, resolution })),
    [{ a: 'new', b: 'old', rule: 'R5', turnsUnanswered: 3, resolution: 'keep-both' }]);
  q.refresh('owner', []);
  assert.deepEqual(q.items('owner'), [], 'expired R5 suggestion cannot recur on refresh');
});

test('R2-mail newest-wins remains gated by a live winner', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-w5-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const q = new ReconcileQueue(path.join(dir, 'queue.json'));
  q.refresh('owner', [{ itemId: reconcileItemId('owner', 'conflict', 'old', 'new'), kind: 'conflict', rule: 'R2-mail', a: 'old', b: 'new', text: 'synthetic owner mail conflict' }]);
  let appends = 0;
  const api = new ReconcileApi({ queue: q, countTokens: () => 1, log: () => {}, isOwner: () => true,
    isLiveClaim: () => false, newestWins: () => ({ loser: 'old', winner: 'new' }),
    appendSoftSupersede: async () => { appends++; return { ok: true }; } });
  for (let i = 0; i < 3; i++) {
    const delivery = api.reconcileForTurn('owner', '2026-10-03');
    await api.onTurnCompleted('owner', delivery.turn);
  }
  assert.equal(appends, 0);
  const remains = api.reconcileForTurn('owner', '2026-10-03');
  assert.equal(remains.items[0].rule, 'R2-mail');
});

test('R5 append hook gates on the extracted one-time-import predicate', () => {
  const index = fs.readFileSync(path.join(__dirname, '../src/main/index.ts'), 'utf8');
  assert.match(index, /onAppend:\s*\(agentId,\s*id,\s*rec\)\s*=>\s*\{[\s\S]{0,160}if\s*\(!shouldRunR5\(rec\)\)/);
});
