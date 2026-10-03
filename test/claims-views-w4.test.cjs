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

test('warning markers occupy tier 1; reconcile items are delivered only by the reconcile API', () => {
  const records = [claim('f', 'flagged fact')];
  const item = { itemId: 'r1', agent: 'a', kind: 'conflict', a: 'f', b: 'g', text: 'choose one', turnsUnanswered: 0 };
  const views = V.createClaimViews(records, () => 1, [item]);
  const out = views.buildWorkingSet(stateFor(records), world({ f: ['stale-ref'] }), 300);
  assert.match(out.text, /⚠ f: stale-ref/);
  assert.doesNotMatch(out.text, /reconcile r1/);
  assert.doesNotMatch(out.text, /reconcile r1/);
  assert.equal(out.receipt.included.find(x => x.id === 'f').tier, 2);
});

test('complete output includes every record by default and supports W6 archive-backed exclusion', () => {
  const records = [claim('lesson', 'Remember the rule', { kind: 'lesson', pin: true }), claim('archived', 'archive copy\n- a literal bullet\ncontinued text'),
    { v: 1, id: 'event-1', at: '2026-01-02', wt: '2026-01-02', agent: 'a', prev: '', mac: 'e1', t: 'event', ev: 'sighting', targets: ['archived'] }];
  const views = V.createClaimViews(records, s => s.length);
  const state = stateFor(records);
  const full = views.renderMemoryMd(state, world(), 'complete');
  assert.ok(full.startsWith('<!-- claim-ledger: generated'));
  for (const rec of records) assert.ok(full.includes(rec.id), `missing ${rec.id}`);
  assert.match(full, /  - a literal bullet\n  continued text/);
  const filtered = views.renderMemoryMd(state, world(), 'complete', { exclude: id => id === 'archived' || id === 'lesson' });
  assert.ok(filtered.includes('[c:lesson]'));
  assert.ok(filtered.includes('event-1'));
  assert.ok(!filtered.includes('[c:archived]'));
  assert.equal(views.renderMemoryMd(state, world(), 'view', { exclude: id => id === 'lesson' }),
    views.renderMemoryMd(state, world(), 'view'));
  const ids = [...full.matchAll(/\[c:([^\]\s]+)\]/g)].map(m => m[1]);
  assert.deepEqual(new Set(ids), new Set(['lesson', 'archived']));
});

test('pinned lessons are considered first and over-share loss is explicit in the receipt', () => {
  const records = [claim('lesson1', 'l'.repeat(210), { kind: 'lesson', pin: true }), claim('lesson2', 'm'.repeat(210), { kind: 'lesson', pin: true })];
  const views = V.createClaimViews(records, s => s.length);
  const state = stateFor(records);
  const out = views.buildWorkingSet(state, world(), 1000);
  assert.ok(out.receipt.included.some(x => x.id === 'lesson1' && x.tier === 0));
  assert.ok(out.receipt.excluded.some(x => x.id === 'lesson2' && x.reason === 'tier-share'));
  assert.ok(out.receipt.warnings.some(w => /Pinned\/lesson tier/.test(w)));
});

test('working set stays within the injected tokenizer budget and receipt accounts for every live claim', () => {
  const records = [claim('one', 'alpha beta gamma'), claim('two', 'delta epsilon zeta'), claim('three', 'eta theta iota'),
    claim('gone', 'no longer live')];
  const views = V.createClaimViews(records, text => text.trim().split(/\s+/).filter(Boolean).length);
  const state = stateFor(records);
  state.claims.gone.status = 'superseded';
  const result = views.buildWorkingSet(state, world(), 18);
  assert.ok(result.receipt.used <= result.receipt.budget);
  const accounted = new Set([...result.receipt.included.map(x => x.id), ...result.receipt.excluded.map(x => x.id)]);
  assert.deepEqual(accounted, new Set(['one', 'two', 'three', 'gone']));
  assert.ok(result.receipt.excluded.some(x => x.id === 'gone' && x.reason === 'status'));
});

test('accepted reconcile mail can enter; live overflow is budgeted and marked +N more', () => {
  const mail = claim('m1', 'mail fact', { source: 'mail:sender' });
  const records = [mail, claim('long1', 'x'.repeat(150)), claim('long2', 'y'.repeat(150)),
    { v: 1, id: 'answer', at: '2026-01-02', wt: '2026-01-02', agent: 'a', prev: '', mac: 'ans', t: 'event', ev: 'reconcile-answer', answer: 'keep-both', targets: ['m1', 'owner'] }];
  const views = V.createClaimViews(records, s => s.length);
  const state = stateFor(records);
  const result = views.buildWorkingSet(state, world(), 190);
  assert.ok(result.receipt.included.some(x => x.id === 'm1'));
  assert.ok(result.receipt.excluded.some(x => x.reason === 'budget'));
  assert.match(result.text, /\+\d+ more/);
});
