'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const V = loadTs('src/main/claims/views.ts');

const claim = (id, text, extra = {}) => ({ v: 1, id, at: '2026-01-01', wt: '2026-01-01', agent: 'a', prev: '', mac: id,
  t: 'claim', kind: 'fact', text, source: 'self', ...extra });
const stateFor = (records) => ({ v: 1, agent: 'a', registryHash: '', ledgerHead: '', conflicts: [], claims: Object.fromEntries(
  records.filter(r => r.t === 'claim').map(r => [r.id, { id: r.id, status: 'live', sightings: 1, firstAt: r.at, lastAt: r.at, pinned: r.pin === true, reasons: [] }])) });
const world = (flags = {}) => ({ flags, counters: {} });

test('B8 shares are pinned and working-set bytes, receipt, and marker-first memory are deterministic', () => {
  assert.deepEqual(V.WORKING_SET_TIER_SHARES, [0.4, 0.1, 0.5]);
  const records = [claim('a', 'alpha'), claim('b', 'beta')];
  const views = V.createClaimViews(records, s => s.length);
  const state = stateFor(records);
  const x = views.buildWorkingSet(state, world(), 1000);
  const y = views.buildWorkingSet(state, world(), 1000);
  assert.deepEqual(x, y);
  assert.equal(x.receipt.included.length, 2);
  assert.equal(x.receipt.used, x.text.length);
  assert.ok(views.renderMemoryMd(state, world(), 'view').startsWith('<!-- claim-ledger: generated'));
  assert.match(views.renderMemoryMd(state, world(), 'complete'), /\[c:a\]/);
});

test('tier 0 overflow is explicit and not promoted; mail remains excluded until answered; expired/status reasons persist', () => {
  const records = [claim('pin1', 'p'.repeat(230), { pin: true }), claim('pin2', 'q'.repeat(230), { pin: true }),
    claim('mail', 'private mail', { source: 'mail:sender' }), claim('old', 'old'), claim('expired', 'gone')];
  const views = V.createClaimViews(records, s => s.length);
  const state = stateFor(records);
  state.claims.old.status = 'superseded';
  const out = views.buildWorkingSet(state, world({ expired: ['expired'] }), 1000);
  assert.ok(out.receipt.excluded.some(x => x.id === 'pin2' && x.reason === 'tier-share'));
  assert.ok(out.receipt.excluded.some(x => x.id === 'mail' && x.reason === 'status'));
  assert.ok(out.receipt.excluded.some(x => x.id === 'old' && x.reason === 'status'));
  assert.ok(out.receipt.excluded.some(x => x.id === 'expired' && x.reason === 'expired'));
  assert.ok(!out.receipt.included.some(x => x.id === 'pin2'));
});

test('warning and reconcile markers occupy tier 1, not claim inclusion slots', () => {
  const records = [claim('f', 'flagged fact')];
  const item = { itemId: 'r1', agent: 'a', kind: 'conflict', a: 'f', b: 'g', text: 'choose one', turnsUnanswered: 0 };
  const views = V.createClaimViews(records, () => 1, [item]);
  const out = views.buildWorkingSet(stateFor(records), world({ f: ['stale-ref'] }), 300);
  assert.match(out.text, /⚠ f: stale-ref/);
  assert.match(out.text, /⚠ reconcile r1: choose one/);
  assert.equal(out.receipt.included.find(x => x.id === 'f').tier, 2);
});
