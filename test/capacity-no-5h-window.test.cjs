'use strict';
require('./tools/own-job.cjs');

/**
 * CAP-NO-5H-WINDOW (Human 2026-11-11: "on the Claude ultra plan there's no longer a 5-hour limit,
 * so the strip only ever shows 'Capacity unknown'"). The live source, captured from the Human's own
 * capacity-observations.json: the Claude status line's rate_limits carry seven_day ONLY - the
 * five_hour entry is absent, not null or 0. The tracker already rated that pool AVAILABLE from its
 * weekly figure, but the strip's lead row looked for a five-hour window, found none and said
 * '5h · Capacity unknown'; weekly at 90% stayed hidden, so no figure showed at all.
 *
 * Fixed: a reading with no five-hour window at all leads with Weekly - the strip's lead row, its
 * pie, the details' dot and last-known figure, and the 5h usage line - and the next reading with a
 * five_hour window leads with 5h again. Driven through the REAL normalizer, tracker, presenter,
 * details, usage line, runtime admission and automaticSubmit's admission mapping.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { normalizeClaudeStatusLine } = loadTs('src/main/capacityNormalize.ts');
const { ProviderCapacityTracker, L0_SEM_POLICY } = loadTs('src/main/providerCapacityTracker.ts');
const { CapacityRuntime } = loadTs('src/main/capacityRuntime.ts');
const { CapacityStripPresenter } = loadTs('src/main/capacityStrip.ts');
const { capacityDetailView } = loadTs('src/main/capacityDetail.ts');
const { agentUsageView } = loadTs('src/main/capacityAgentUsage.ts');
const { resolveAdmission, UNKNOWN_POLICY } = loadTs('src/main/automaticSubmit.ts');
const { restoreCapacityStore, CAPACITY_STORE_VERSION } = loadTs('src/main/capacityPersistence.ts');
const { validateCapacityStrip } = loadTs('src/shared/capacityStrip.ts');
const { validateCapacityDetail } = loadTs('src/shared/capacityDetail.ts');
const { presentPool } = loadTs('src/renderer/src/capacity/capacityStrip.ts');
const { leadDotOf, detailDotOf } = loadTs('src/renderer/src/capacity/pieDot.ts');

const T0 = 1_800_000_000_000;
const RESET_5H_S = Math.floor((T0 + 3_600_000) / 1000);
const RESET_7D_S = Math.floor((T0 + 3 * 86_400_000) / 1000);

/** The live shape: what the Human's Claude ultra status line sends (seven_day only). */
const WEEKLY_ONLY = { seven_day: { used_percentage: 10, resets_at: RESET_7D_S } };
const BOTH = { five_hour: { used_percentage: 48, resets_at: RESET_5H_S }, seven_day: { used_percentage: 29, resets_at: RESET_7D_S } };

function rig(start = T0) {
  let now = start;
  let seq = 0;
  const tracker = new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => now - T0);
  const runtime = new CapacityRuntime({
    deliver: () => {}, now: () => now,
    setTimer: () => ({ unref() { return this; } }), clearTimer: () => {}
  }, tracker);
  const presenter = new CapacityStripPresenter({ formatTime: (t) => `@${t - T0}`, idKey: Buffer.alloc(32, 7) });
  const strip = () => {
    const c = presenter.present({
      snapshot: tracker.snapshot(), membersOf: () => ['creed'], membershipKnown: () => true,
      freshUntil: (k) => tracker.freshUntil(k), now
    });
    assert.deepEqual(validateCapacityStrip(c), [], 'main would push this collection');
    return c;
  };
  const pool = () => tracker.snapshot().pools[0];
  const detail = (presentation) => {
    const v = capacityDetailView({ pool: pool(), poolId: strip().pools[0].poolId, poolLabel: 'Claude', presentation, members: ['creed'], membershipKnown: true, statusNote: null, now });
    assert.deepEqual(validateCapacityDetail(v), [], 'main would send this detail view');
    return v;
  };
  return {
    tracker, runtime, strip, pool, detail,
    advance: (ms) => { now += ms; },
    read: (rateLimits) => {
      now += 1000;
      const o = normalizeClaudeStatusLine({ rateLimits, accountScope: 'acct-ultra', receivedAt: now, streamId: 'claude-status:acct-ultra', sourceSequence: ++seq });
      runtime.ingest('creed', o);
      return strip();
    },
    now: () => now
  };
}

const only = (c) => { assert.equal(c.pools.length, 1); return c.pools[0]; };

test('no 5h window (the live Claude ultra reading): the strip leads with Weekly, no "unknown" anywhere', () => {
  const r = rig();
  const p = only(r.read(WEEKLY_ONLY));
  assert.equal(r.pool().windows.map((w) => w.kind).join(), 'SEVEN_DAY', 'the normalizer keeps the reading as sent: weekly only');
  assert.equal(r.pool().state, 'AVAILABLE');
  assert.equal(p.presentation, 'NORMAL');
  assert.deepEqual(p.fiveHour, { label: 'Weekly', text: 'Weekly · 90% remaining', meter: { remainingPercent: 90, displayPercent: 90 } });
  assert.equal('weekly' in p, false, 'no second weekly row repeating the lead');
  // (freshness.expired is main's projection of what the pool becomes once this reading ages.)
  const { expired: _later, ...freshness } = p.freshness;
  assert.doesNotMatch(JSON.stringify({ ...p, freshness }), /unknown/i, 'nothing the pool shows now says unknown');
  // The pie: the renderer draws the lead figure.
  assert.deepEqual(leadDotOf(presentPool(p, r.now())), { kind: 'PIE', percent: 90 });
  // The details: the weekly row carries the figure and the header dot is its pie.
  const d = r.detail(p.presentation);
  assert.deepEqual(d.windows.map((w) => w.text), ['Weekly · 90% remaining']);
  assert.deepEqual(detailDotOf(d), { kind: 'PIE', percent: 90 });
  // The usage line: an agent showing "5h" gets the weekly figure, not "5h · not reported".
  const u = agentUsageView(r.pool(), r.now());
  assert.equal(u.fiveHour.text, 'Weekly · 10% used');
  assert.equal(u.weekly.text, 'Weekly · 10% used');
});

test('no 5h window: automaticSubmit\'s capacity gate follows Weekly (proceeds; holds when weekly is spent)', () => {
  const r = rig();
  r.read(WEEKLY_ONLY);
  const ok = r.runtime.admit('creed', 'ORDINARY_TURN');
  assert.equal(ok.verdict, 'ALLOW', JSON.stringify(ok));
  assert.equal(resolveAdmission(ok, UNKNOWN_POLICY).action, 'PROCEED');

  const p = only(r.read({ seven_day: { used_percentage: 100, resets_at: RESET_7D_S } }));
  assert.equal(r.pool().state, 'RESERVE_ONLY', 'a spent weekly with no 5h window is a spent pool');
  assert.deepEqual(p.fiveHour, { label: 'Weekly', text: 'Weekly · 0% remaining', meter: { remainingPercent: 0, displayPercent: 0 },
    resetText: `reset expected ~@${RESET_7D_S * 1000 - T0}`, resetExpectedAt: RESET_7D_S * 1000 });
  assert.deepEqual(leadDotOf(presentPool(p, r.now())), { kind: 'PIE', percent: 0 });
  const held = r.runtime.admit('creed', 'ORDINARY_TURN');
  assert.equal(held.verdict, 'REFUSE');
  assert.notEqual(resolveAdmission(held, UNKNOWN_POLICY).action, 'PROCEED', 'an automatic submit is held');
  assert.equal(r.runtime.admit('creed', 'CLOSURE_TURN').verdict, 'ALLOW', 'finishing safely is not');

  const lim = only(r.read({ seven_day: { used_percentage: 100, resets_at: RESET_7D_S } }));
  assert.equal(lim.fiveHour.label, 'Weekly');
});

test('both windows (a plan with a 5h limit): unchanged - 5h leads, weekly hidden above the threshold', () => {
  const r = rig();
  const p = only(r.read(BOTH));
  assert.equal(p.presentation, 'NORMAL');
  assert.equal(p.fiveHour.label, '5h');
  assert.equal(p.fiveHour.text, '5h · 52% remaining');
  assert.deepEqual(p.fiveHour.meter, { remainingPercent: 52, displayPercent: 52 });
  assert.equal('weekly' in p, false);
  assert.deepEqual(leadDotOf(presentPool(p, r.now())), { kind: 'PIE', percent: 52 });
  const d = r.detail(p.presentation);
  assert.deepEqual(d.windows.map((w) => w.text), ['5h · 52% remaining', 'Weekly · 71% remaining']);
  assert.deepEqual(detailDotOf(d), { kind: 'PIE', percent: 52 });
  assert.equal(agentUsageView(r.pool(), r.now()).fiveHour.text, '5h · 48% used');
});

test('the lead follows the reading: 5h appears -> 5h leads; it goes again -> Weekly leads', () => {
  const r = rig();
  assert.equal(only(r.read(WEEKLY_ONLY)).fiveHour.label, 'Weekly');
  const both = only(r.read(BOTH));
  assert.equal(both.fiveHour.text, '5h · 52% remaining');
  assert.equal(only(r.read(WEEKLY_ONLY)).fiveHour.text, 'Weekly · 90% remaining');
});

test('no reading yet still says unknown: an empty strip, and a restored weekly-only pool before any live reading', () => {
  // Cold start: no pool at all - the strip's own empty state, nothing invented.
  const cold = rig();
  assert.equal(cold.strip().pools.length, 0);
  // Restart: the weekly-only pool comes back from the store, but this run has not seen a reading.
  const before = rig();
  before.read(WEEKLY_ONLY);
  const wire = JSON.parse(JSON.stringify({ version: CAPACITY_STORE_VERSION, savedAt: before.now(), pools: before.tracker.persistable() }));
  const after = rig(before.now() + 5000);
  assert.equal(restoreCapacityStore(after.tracker, wire.pools), 1);
  const p = only(after.strip());
  assert.equal(p.presentation, 'UNKNOWN', 'restored evidence is not a reading');
  assert.match(p.fiveHour.text, /Capacity unknown · no live reading since restart$/);
  assert.equal(p.fiveHour.meter, undefined);
  assert.notEqual(leadDotOf(presentPool(p, after.now())).kind, 'PIE');
  // ...until a live reading arrives.
  assert.equal(only(after.read(WEEKLY_ONLY)).fiveHour.text, 'Weekly · 90% remaining');
});

test('a weekly-only reading that ages keeps its last-known Weekly figure (STALE-RETAIN), in the details too', () => {
  const r = rig();
  r.read(WEEKLY_ONLY);
  r.advance(L0_SEM_POLICY.liveTtlMs + 10);
  r.tracker.evaluate();
  assert.equal(r.pool().freshness, 'STALE');
  const p = only(r.strip());
  assert.equal(p.freshness.verdict, 'STALE');
  assert.equal(p.fiveHour.label, 'Weekly');
  assert.equal(p.fiveHour.text, 'Weekly · 90% remaining');
  const d = r.detail(p.presentation);
  assert.equal(d.windows[0].lastKnownPercent, 90);
  assert.deepEqual(detailDotOf(d), { kind: 'PIE', percent: 90 });
});

test('the detail schema: a last-known figure sits on the lead row only (Weekly only when there is no 5h row)', () => {
  const r = rig();
  r.read(BOTH);
  r.advance(L0_SEM_POLICY.liveTtlMs + 10);
  r.tracker.evaluate();
  const d = r.detail(only(r.strip()).presentation);
  assert.equal(d.windows[0].lastKnownPercent, 52, 'with a 5h row, the 5h row keeps the figure');
  assert.equal('lastKnownPercent' in d.windows[1], false);
  const moved = d.windows.map((w, i) => {
    const { lastKnownPercent: _k, ...row } = w;
    return i === 1 ? { ...row, lastKnownPercent: 71 } : row;
  });
  assert.ok(validateCapacityDetail({ ...d, windows: moved }).some((e) => /lead row only/.test(e)), 'a weekly last-known figure beside a 5h row is refused');
});

test('a reading with neither a 5h nor a weekly window keeps the 5h lead and stays unknown', () => {
  const r = rig();
  const p = only(r.read({ seven_day_opus: { used_percentage: 10, resets_at: RESET_7D_S } }));
  assert.equal(r.pool().windows.map((w) => w.kind).join(), 'OTHER');
  assert.equal(p.fiveHour.label, '5h');
  assert.match(p.fiveHour.text, /^5h · Capacity unknown/);
  assert.match(agentUsageView(r.pool(), r.now()).fiveHour.text, /^5h · /);
});

test('the strip schema: a lead row opens with its own label, and a Weekly lead has no second weekly row', () => {
  const r = rig();
  const c = r.read(WEEKLY_ONLY);
  const bad = (edit) => { const x = JSON.parse(JSON.stringify(c)); edit(x.pools[0]); return validateCapacityStrip(x); };
  assert.ok(bad((p) => { p.fiveHour.text = '5h · 90% remaining'; }).some((e) => /must open with its label/.test(e)), 'a Weekly row worded as 5h');
  assert.ok(bad((p) => { p.fiveHour.label = '5h'; }).some((e) => /must open with its label/.test(e)), 'a 5h label on the weekly figure');
  assert.ok(bad((p) => { p.weekly = { reason: 'BELOW_DISPLAY_THRESHOLD', text: 'Weekly · 90% remaining', attribution: 'display-policy' }; })
    .some((e) => /no separate weekly row/.test(e)), 'the weekly figure shown twice');
});

test('a 5h row stated INAPPLICABLE is not a 5h window: Weekly leads, and the strip and the details dot agree (Jim nit)', () => {
  const r = rig();
  const at = r.now() + 1000;
  r.advance(1000);
  const w = (id, kind, remaining, applicability) => ({ windowId: id, kind, label: kind === 'FIVE_HOUR' ? '5h' : 'Weekly',
    windowMinutes: kind === 'FIVE_HOUR' ? 300 : 10080, usedPercent: 100 - remaining, remainingPercent: remaining,
    resetsAt: RESET_7D_S * 1000, applicability });
  r.runtime.ingest('creed', { poolKey: 'claude:acct-x:subscription', provider: 'claude', accountScope: 'acct-x', limitId: 'subscription',
    streamId: 'claude-status:acct-x', sourceSequence: 1, source: 'claude-status-line', observedAt: at, receivedAt: at,
    windows: [w('five_hour', 'FIVE_HOUR', 40, 'INAPPLICABLE'), w('seven_day', 'SEVEN_DAY', 90, 'APPLICABLE')],
    providerAttributedLimitingWindowId: null, providerReachedType: null, ordinaryUsageAllowed: null, planType: null });
  const p = only(r.strip());
  assert.deepEqual([p.fiveHour.label, p.fiveHour.text], ['Weekly', 'Weekly · 90% remaining']);
  const d = r.detail(p.presentation);
  assert.deepEqual(d.windows.map((x) => x.kind), ['SEVEN_DAY'], 'the details drop the inapplicable row');
  assert.deepEqual(detailDotOf(d), { kind: 'PIE', percent: 90 });
  assert.deepEqual(leadDotOf(presentPool(p, r.now())), detailDotOf(d), 'one mark for the pool everywhere');
});
