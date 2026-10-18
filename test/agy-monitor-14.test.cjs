'use strict';

/**
 * AGY-MONITOR-1.4 (AGY design 1.4, deferred from 1.1.48; the Human 2026-10-18: "Build them").
 *
 * An Antigravity account has two pools, 3P and Gemini, so the Monitor line's generic 5H /
 * Weekly would be ambiguous. An Antigravity agent chooses budget or one of four family
 * windows (agy3pFiveHour | agy3pWeekly | agyGeminiFiveHour | agyGeminiWeekly), read by the
 * selector as budget, 3P · 5H, 3P · Weekly, Gemini · 5H, Gemini · Weekly. All four exempt
 * the agent from the budget by the same named rule as 5H / Weekly. Main resolves each to
 * the REQUESTED family's pool through the runtime's poolKeyForAgyFamily (never the active
 * one), composes the text, and an AGY row carries the strip's opaque poolId so the line
 * opens the existing provider-details panel on that one family.
 *
 * Section 7.1 bullets covered here:
 *   - detail opens the selected family only;
 *   - all four Monitor modes resolve the requested sibling pool, remain budget-exempt, and
 *     use push rather than per-agent intervals;
 *   - S4 light/dark contrast applies existing tokens to both labels in all states.
 *
 * Design of record: agents/dwight-mu32ztys/agy-1.1.48-DESIGN.md 1.3, 1.4, 7.1.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const { ProviderCapacityTracker, L0_SEM_POLICY } = loadTs('src/main/providerCapacityTracker.ts');
const { CapacityStripPresenter } = loadTs('src/main/capacityStrip.ts');
const { CapacityRuntime } = loadTs('src/main/capacityRuntime.ts');
const { normalizeAgyStatusLine } = loadTs('src/main/capacityNormalize.ts');
const { capacityDetailView } = loadTs('src/main/capacityDetail.ts');
const { validateCapacityDetail } = loadTs('src/shared/capacityDetail.ts');
const { poolKeyOf } = loadTs('src/shared/providerCapacity.ts');
const { agentUsagePushOf, agentUsageViewFor, usagePoolKeyOf, requestedUsageDisplay, AgentUsagePushGate } = loadTs('src/main/capacityAgentUsage.ts');
const usage = loadTs('src/shared/agentUsage.ts');
const { CircuitBreaker } = loadTs('src/main/breaker.ts');
const line = loadTs('src/renderer/src/components/AgentUsageLine.tsx');
const detailSelection = loadTs('src/renderer/src/capacity/detailSelection.ts');
const { STATE_COLOR } = loadTs('src/renderer/src/components/CapacityStrip.tsx');

const T0 = 1_800_000_000_000;
const SCOPE = 'agyscope0001';
const EMAIL = 'someone@example.com';
const GEMINI_HOME = 'C:\\Users\\someone\\.gemini';
const P3 = poolKeyOf('antigravity', SCOPE, '3p');
const PG = poolKeyOf('antigravity', SCOPE, 'gemini');
const AGY = ['agy3pFiveHour', 'agy3pWeekly', 'agyGeminiFiveHour', 'agyGeminiWeekly'];
const fmt = (t) => `@${t - T0}`;
const html = (el) => renderToStaticMarkup(el);

// ─── fixtures: a real runtime + tracker + strip presenter on a test clock ──────────

/** An AGY statusline payload with DISTINCT remainders per family, so a wrong pool shows. */
function payload(at, { threeFive = 0.9, threeWeek = 0.7, gemFive = 0.4, gemWeek = 0.2, model = 'Gemini 3.8 Flash (High)' } = {}) {
  const bucket = (fraction, seconds) => ({ remaining_fraction: fraction, reset_time: new Date(at + seconds * 1000).toISOString(), reset_in_seconds: seconds });
  return {
    version: '1.2.8', product: 'antigravity', agent_state: 'working', session_id: 'sess-1',
    model: { id: model, display_name: model, effort: 'high' },
    quota: { '3p-5h': bucket(threeFive, 18000), '3p-weekly': bucket(threeWeek, 604800), 'gemini-5h': bucket(gemFive, 17000), 'gemini-weekly': bucket(gemWeek, 71000) }
  };
}
const tickAt = (at, over) => ({ ...normalizeAgyStatusLine({ payload: payload(at, over), accountScope: SCOPE, receivedAt: at }), accountScope: SCOPE });

function floor() {
  let now = T0;
  let intervals = 0;
  const r = new CapacityRuntime({
    deliver: () => {}, now: () => now, onChange: () => {},
    setTimer: () => 0, clearTimer: () => {}
  }, new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => now));
  const strip = new CapacityStripPresenter({ formatTime: fmt, idKey: Buffer.alloc(32, 7) });
  // main's usagePoolSource (index.ts), on the real runtime, tracker and presenter
  const src = {
    poolKeyOf: (id) => r.poolKeyOf(id),
    poolKeyForAgyFamily: (id, family) => r.poolKeyForAgyFamily(id, family),
    pool: (key) => r.tracker.pool(key),
    poolIdOf: (key) => strip.poolIdOf(key)
  };
  return { r, strip, src, get now() { return now; }, advance: (ms) => { now += ms; r.tracker.evaluate(); }, intervals: () => intervals };
}

/** A Gemini-bound AGY agent (its model draws on Gemini), both families read. */
function geminiBound() {
  const f = floor();
  f.r.ingestAgyTick('phyllis-1', tickAt(T0));
  assert.equal(f.r.poolKeyOf('phyllis-1'), PG, 'fixture: the ACTIVE family is Gemini');
  return f;
}

// ─── the four values and the exemption rule ────────────────────────────────────────

test('the four AGY values exist, are valid displays, and Claude/Codex keep exactly their three', () => {
  assert.deepEqual([...usage.AGY_USAGE_DISPLAYS], AGY);
  for (const v of AGY) assert.equal(usage.isAgentUsageDisplay(v), true, v);
  assert.deepEqual([...usage.usageDisplaysFor('claude')], ['budget', 'fiveHour', 'weekly']);
  assert.deepEqual([...usage.usageDisplaysFor('codex')], ['budget', 'fiveHour', 'weekly']);
  assert.deepEqual([...usage.usageDisplaysFor('antigravity')], ['budget', ...AGY], 'no generic 5H / Weekly for Antigravity');
  assert.deepEqual([...usage.usageDisplaysFor('gemini')], ['budget'], 'any other provider: budget only');
  for (const bad of ['AGY3PFIVEHOUR', 'agy3p', 'agyGemini', 'agy3pMonthly', '__proto__', 'toString']) {
    assert.equal(usage.isAgentUsageDisplay(bad), false, bad);
    assert.equal(usage.usageWindowOf(bad), null, bad);
    assert.equal(usage.agyFamilyOf(bad), null, bad);
  }
});

test('each AGY value names one family and one window; the generic values name no family', () => {
  assert.deepEqual(AGY.map((v) => [usage.agyFamilyOf(v), usage.usageWindowOf(v)]),
    [['3p', 'fiveHour'], ['3p', 'weekly'], ['gemini', 'fiveHour'], ['gemini', 'weekly']]);
  assert.deepEqual(['fiveHour', 'weekly'].map((v) => [usage.agyFamilyOf(v), usage.usageWindowOf(v)]), [[null, 'fiveHour'], [null, 'weekly']]);
  assert.equal(usage.usageWindowOf('budget'), null);
});

test('all four AGY modes are budget-exempt by the SAME named rule; budget/absent/malformed are not', () => {
  for (const v of AGY) assert.equal(usage.isBudgetExempt(v), true, v);
  for (const v of ['fiveHour', 'weekly']) assert.equal(usage.isBudgetExempt(v), true, v);
  for (const v of ['budget', undefined, null, '', 'agy3pMonthly', 7]) assert.equal(usage.isBudgetExempt(v), false, String(v));
  const src = codeOnly(readSource('src/shared/agentUsage.ts'), 'agentUsage.ts');
  assert.match(src, /export function isBudgetExempt\(display: unknown\): boolean \{\s*return usageWindowOf\(display\) !== null;\s*\}/,
    'one rule: a provider-window display exempts');
});

test('the breaker skips an AGY-mode agent\'s per-agent cap and floor share, exactly like 5H / Weekly', () => {
  const T = 1_000_000_000_000;
  const sample = (agentId, tokens) => ({ agentId, sessionId: 's', ts: T, input: tokens, output: 0, cacheRead: 0, cacheCreation: 0, model: 'm', usd: 0 });
  const run = (cfg, rows) => {
    const b = new CircuitBreaker(() => ({ enabled: true, hardStop: false, repeatedToolLimit: 8, errorStormLimit: 5, tokenVelocityPerMin: 1e12, ...cfg }));
    return Object.fromEntries(b.tick(rows.map(([id, tok]) => ({ agentId: id, sample: sample(id, tok), progressing: true })), T).map((d) => [d.state.agentId, d.state]));
  };
  for (const v of AGY) {
    assert.equal(run({ agentTokenCaps: { phyllis: 100 }, agentUsageDisplay: { phyllis: v } }, [['phyllis', 500]]).phyllis.level, 'healthy', `${v}: per-agent cap skipped`);
    const out = run({ costCapTokens: 500, agentUsageDisplay: { phyllis: v } }, [['phyllis', 900], ['pam', 200]]);
    assert.equal(out.phyllis.level, 'healthy', `${v}: never blamed`);
    assert.equal(out.pam.level, 'healthy', `${v}: the floor total excludes the exempt agent`);
  }
  assert.notEqual(run({ agentTokenCaps: { phyllis: 100 }, agentUsageDisplay: { phyllis: 'budget' } }, [['phyllis', 500]]).phyllis.level, 'healthy', 'control: budget still trips');
});

test('a choice the agent\'s provider does not offer reads as budget in main too: never exempt while the line says budget (audit SHOULD-1)', () => {
  const providers = { oscar: 'codex', phyllis: 'antigravity', pam: 'claude', kim: 'kimi' };
  const providerOf = (id) => providers[id];
  const stored = { oscar: 'agyGeminiFiveHour', phyllis: 'agy3pWeekly', pam: 'weekly', kim: 'fiveHour', ghost: 'weekly', bad: 7 };
  const offered = usage.offeredUsageDisplays(stored, providerOf);
  assert.deepEqual(offered, { phyllis: 'agy3pWeekly', pam: 'weekly' }, 'kept only where the provider offers it; an unknown agent keeps nothing');
  assert.deepEqual(usage.offeredUsageDisplays({ phyllis: 'fiveHour' }, providerOf), {}, 'the generic 5H on an AGY agent is ambiguous: budget');
  assert.deepEqual(usage.offeredUsageDisplays(undefined, providerOf), {});
  for (const [id, v] of Object.entries(stored)) {
    const shown = providers[id] ? line.shownUsageDisplay(providers[id], v) : 'budget';
    assert.equal(usage.isBudgetExempt(offered[id]), shown !== 'budget', `${id}: main agrees with the selector`);
  }

  // The breaker fed the filtered map: the Codex agent with an AGY value is held to its cap again.
  const T = 1_000_000_000_000;
  const sample = (agentId, tokens) => ({ agentId, sessionId: 's', ts: T, input: tokens, output: 0, cacheRead: 0, cacheCreation: 0, model: 'm', usd: 0 });
  const b = new CircuitBreaker(() => ({ enabled: true, hardStop: false, repeatedToolLimit: 8, errorStormLimit: 5, tokenVelocityPerMin: 1e12,
    agentTokenCaps: { oscar: 100, phyllis: 100 }, agentUsageDisplay: usage.offeredUsageDisplays(stored, providerOf) }));
  const out = Object.fromEntries(b.tick([['oscar', 500], ['phyllis', 500]].map(([id, tok]) => ({ agentId: id, sample: sample(id, tok), progressing: true })), T).map((d) => [d.state.agentId, d.state.level]));
  assert.notEqual(out.oscar, 'healthy', 'the not-offered value no longer switches the cap off');
  assert.equal(out.phyllis, 'healthy', 'an offered AGY value still exempts');

  // The push leaves the not-offered row out too.
  const rows = agentUsagePushOf(offered, () => null, T).rows.map((r) => r.agentId);
  assert.deepEqual(rows, ['pam', 'phyllis']);

  // Main feeds both readers through the filter, with the registry provider (legacy = claude).
  const main = codeOnly(readSource('src/main/index.ts'), 'index.ts');
  assert.match(main, /function usageProviderOf\(agentId: string\): string \| undefined \{\s*const a = hive\.registry\(\)\.agents\[agentId\];\s*return a \? \(a\.provider \?\? 'claude'\) : undefined;\s*\}/);
  assert.match(main, /agentUsageDisplay: offeredUsageDisplays\(c\.agentUsageDisplay, usageProviderOf\)/, 'the breaker');
  assert.match(main, /agentUsagePushOf\(offeredUsageDisplays\(readConfig\(\)\.agentUsageDisplay, usageProviderOf\),/, 'the push');
  assert.equal((main.match(/\.agentUsageDisplay\b/g) ?? []).length, 3, 'no other unfiltered reader of the stored map in main (breaker, push, the invoke fallback)');
});

test('config: the setter persists each AGY value (and still refuses anything else)', () => {
  const src = codeOnly(readSource('src/main/config.ts'), 'config.ts');
  assert.match(src, /setAgentUsageDisplay\(agentId: unknown, display: unknown\): HarnessConfig \{\s*if \(typeof agentId !== 'string' \|\| agentId\.trim\(\)\.length === 0 \|\| !isAgentUsageDisplay\(display\)\)/,
    'the setter is gated on the shared validator, which now names the four AGY values');
  assert.match(src, /agentUsageDisplay\?: Record<string, AgentUsageDisplay>;/);
  assert.match(readSource('src/preload/index.ts'), /setAgentUsageDisplay: \(agentId: string, display: AgentUsageDisplay\): Promise<HarnessConfig>/);
});

// ─── main resolves the REQUESTED family ─────────────────────────────────────────────

test('all four modes resolve the REQUESTED sibling pool - the inactive family too - and never the active one by default', () => {
  const f = geminiBound();
  assert.equal(usagePoolKeyOf(f.src, 'phyllis-1', 'agy3pFiveHour'), P3, 'the INACTIVE family (3P) is resolved when asked');
  assert.equal(usagePoolKeyOf(f.src, 'phyllis-1', 'agy3pWeekly'), P3);
  assert.equal(usagePoolKeyOf(f.src, 'phyllis-1', 'agyGeminiFiveHour'), PG);
  assert.equal(usagePoolKeyOf(f.src, 'phyllis-1', 'agyGeminiWeekly'), PG);
  assert.equal(usagePoolKeyOf(f.src, 'phyllis-1', 'fiveHour'), PG, 'a generic value keeps the agent\'s own (active) pool');
  assert.deepEqual(f.r.membersOf(P3), [], 'resolving the sibling for Monitor does not join it');
  assert.equal(f.r.poolKeyOf('phyllis-1'), PG, 'and admission still uses the active family');
});

test('each mode draws ITS family\'s window: distinct numbers per family, the family named in main-composed text', () => {
  const f = geminiBound();
  const want = {
    agy3pFiveHour: '3P · 5h · 10% used', agy3pWeekly: '3P · Weekly · 30% used',
    agyGeminiFiveHour: 'Gemini · 5h · 60% used', agyGeminiWeekly: 'Gemini · Weekly · 80% used'
  };
  for (const v of AGY) {
    const view = agentUsageViewFor(f.src, 'phyllis-1', v, f.now, fmt);
    assert.deepEqual(usage.validateAgentUsageView(view), [], v);
    const drawn = view[usage.usageWindowOf(v)];
    assert.equal(drawn.kind, 'USAGE', v);
    assert.equal(drawn.text, want[v], v);
  }
  const generic = agentUsageViewFor(f.src, 'phyllis-1', 'fiveHour', f.now, fmt);
  assert.equal(generic.fiveHour.text, '5h · 60% used', 'generic: the plain v1.1.45 text on the active pool');
  assert.equal(generic.poolId, undefined, 'and no poolId: only AGY family rows carry one');
});

test('an AGY row carries the strip\'s OPAQUE poolId of that family; an unread agent gets text and no id', () => {
  const f = geminiBound();
  const p3 = agentUsageViewFor(f.src, 'phyllis-1', 'agy3pWeekly', f.now, fmt).poolId;
  const pg = agentUsageViewFor(f.src, 'phyllis-1', 'agyGeminiFiveHour', f.now, fmt).poolId;
  assert.equal(p3, f.strip.poolIdOf(P3));
  assert.equal(pg, f.strip.poolIdOf(PG));
  assert.notEqual(p3, pg);
  for (const id of [p3, pg]) assert.match(id, usage.OPAQUE_POOL_ID);
  const ghost = agentUsageViewFor(f.src, 'never-seen', 'agy3pFiveHour', f.now, fmt);
  assert.deepEqual(ghost, { fiveHour: { kind: 'TEXT', text: '3P · 5h · no reading yet' }, weekly: { kind: 'TEXT', text: '3P · Weekly · no reading yet' } },
    'no accepted tick: no invented pool, no id, no figure');
});

test('a STALE family stays stale on its own row: its text never borrows the sibling\'s freshness', () => {
  const f = geminiBound();
  f.advance(30 * 60_000);
  for (const v of AGY) {
    const w = agentUsageViewFor(f.src, 'phyllis-1', v, f.now, fmt)[usage.usageWindowOf(v)];
    assert.equal(w.kind, 'TEXT', `${v}: a stale reading is no figure`);
    assert.match(w.text, new RegExp(`^${usage.agyFamilyOf(v) === '3p' ? '3P' : 'Gemini'} · (5h|Weekly) · usage unknown · last update @`), v);
  }
});

test('the mount-time invoke names the display being drawn; main validates it and falls back to the persisted one', () => {
  assert.equal(requestedUsageDisplay('agyGeminiWeekly', 'agy3pFiveHour'), 'agyGeminiWeekly', 'the renderer\'s choice can be ahead of the write');
  assert.equal(requestedUsageDisplay('bogus', 'agy3pFiveHour'), 'agy3pFiveHour', 'an invalid ask: the persisted value');
  assert.equal(requestedUsageDisplay(undefined, undefined), 'budget');
  assert.equal(requestedUsageDisplay(undefined, 'nonsense'), 'budget');
  const main = codeOnly(readSource('src/main/index.ts'), 'index.ts');
  const start = main.indexOf('ipcMain.handle(CAPACITY_AGENT_USAGE');
  const handler = main.slice(start, main.indexOf('});', start));
  assert.match(handler, /requestedUsageDisplay\(display, readConfig\(\)\.agentUsageDisplay\?\.\[agentId\]\)/);
  assert.match(handler, /agentUsageViewFor\(usagePoolSource, agentId, asked, Date\.now\(\)\)/);
  assert.match(handler, /validateAgentUsageView\(view\)/);
  assert.match(main, /poolKeyForAgyFamily: \(agentId, family\) => providerCapacity\.poolKeyForAgyFamily\(agentId, family\)/, 'main resolves via the runtime\'s family lookup');
  assert.match(main, /poolIdOf: \(poolKey\) => capacityStrip\.poolIdOf\(poolKey\)/, 'the strip\'s own opaque id');
  assert.match(readSource('src/preload/index.ts'), /ipcRenderer\.invoke\('capacity:agentUsage', agentId, display\)/);
});

// ─── push, not per-agent intervals ──────────────────────────────────────────────────

test('push: AGY-mode agents get rows through the SHARED gate (the same view the invoke answers); budget has none', () => {
  const f = geminiBound();
  const displays = { phyllis: 'agy3pWeekly', 'phyllis-1': 'agyGeminiFiveHour', bob: 'budget' };
  const push = agentUsagePushOf(displays, f.src, f.now);
  assert.deepEqual(push.rows.map((r) => r.agentId), ['phyllis', 'phyllis-1']);
  assert.deepEqual(usage.validateAgentUsagePush(push), []);
  const row = push.rows.find((r) => r.agentId === 'phyllis-1');
  assert.equal(row.view.fiveHour.text, agentUsageViewFor(f.src, 'phyllis-1', 'agyGeminiFiveHour', Date.now()).fiveHour.text);
  assert.equal(row.view.poolId, f.strip.poolIdOf(PG));
  const gate = new AgentUsagePushGate();
  assert.ok(gate.next(push), 'the first push is sent');
  assert.equal(gate.next(agentUsagePushOf(displays, f.src, f.now)), null, 'unchanged rows are not re-sent');
  assert.ok(gate.next(agentUsagePushOf({ ...displays, 'phyllis-1': 'agy3pFiveHour' }, f.src, f.now)), 'switching family changes the row: sent');
});

test('push carries no pool KEY or account identity: only agent ids, composed text and the opaque id', () => {
  const f = geminiBound();
  const json = JSON.stringify(agentUsagePushOf({ 'phyllis-1': 'agy3pFiveHour', w: 'agyGeminiWeekly' }, f.src, f.now));
  for (const secret of [SCOPE, 'antigravity:', 'poolKey', 'accountScope', 'limitId', EMAIL, GEMINI_HOME, '3p-5h', 'remaining_fraction']) {
    assert.ok(!json.includes(secret), secret);
  }
});

test('the view validator: poolId is optional and only the strip\'s opaque form', () => {
  const v = { fiveHour: { kind: 'TEXT', text: '3P · 5h · no reading yet' }, weekly: { kind: 'TEXT', text: '3P · Weekly · no reading yet' } };
  assert.deepEqual(usage.validateAgentUsageView(v), []);
  assert.deepEqual(usage.validateAgentUsageView({ ...v, poolId: 'pool-0123456789abcdef' }), []);
  for (const bad of [P3, 'pool-', 'pool-0123456789ABCDEF', 'pool-0123456789abcdef0', 7, null]) {
    assert.deepEqual(usage.validateAgentUsageView({ ...v, poolId: bad }), ['$.poolId: not an opaque pool id'], String(bad));
  }
});

test('no per-agent interval: main pushes from the shared event-driven gate; the line has no timer', () => {
  const main = codeOnly(readSource('src/main/index.ts'), 'index.ts');
  const fnStart = main.indexOf('function pushAgentUsage(');
  const fn = main.slice(fnStart, main.indexOf('\n}\n', fnStart));
  assert.match(fn, /agentUsagePushGate\.next\(agentUsagePushOf\(offeredUsageDisplays\(readConfig\(\)\.agentUsageDisplay, usageProviderOf\), usagePoolSource, Date\.now\(\)\)\)/);
  for (const m of main.matchAll(/setInterval\(([\s\S]{0,200})/g)) assert.ok(!/pushAgentUsage|agentUsage/i.test(m[1]), 'no interval drives the usage line');
  const src = codeOnly(readSource('src/renderer/src/components/AgentUsageLine.tsx'), 'AgentUsageLine.tsx');
  assert.ok(!/\bsetInterval\b|\bsetTimeout\b|requestAnimationFrame|USAGE_POLL_MS/.test(src), 'no poll, no timer');
});

test('the hook for an AGY mode: one mount-time invoke naming the display, then pushes; its window and poolId; no timer', async () => {
  const listeners = new Set();
  const calls = [];
  let resolveInvoke;
  const bridge = {
    capacityAgentUsage: (...a) => { calls.push(a); return new Promise((res) => { resolveInvoke = res; }); },
    onAgentUsage: (cb) => { listeners.add(cb); return () => listeners.delete(cb); }
  };
  const states = [];
  const cleanups = [];
  const timers = [];
  const saved = { useEffect: React.useEffect, useState: React.useState, window: global.window, setInterval: global.setInterval, setTimeout: global.setTimeout };
  React.useEffect = (fn) => { const c = fn(); if (typeof c === 'function') cleanups.push(c); };
  React.useState = (init) => [init, (v) => states.push(v)];
  global.window = { cth: bridge };
  global.setInterval = (...a) => { timers.push(a[1]); return 0; };
  global.setTimeout = (...a) => { timers.push(a[1]); return 0; };
  try { line.useAgentUsageLine('phyllis-1', 'agy3pWeekly'); } finally {
    React.useEffect = saved.useEffect; React.useState = saved.useState; global.window = saved.window;
    global.setInterval = saved.setInterval; global.setTimeout = saved.setTimeout;
  }
  assert.deepEqual(timers, [], 'no timer');
  assert.deepEqual(calls, [['phyllis-1', 'agy3pWeekly']], 'one invoke, naming the display');
  const view = { fiveHour: { kind: 'TEXT', text: '3P · 5h' }, weekly: { kind: 'TEXT', text: '3P · Weekly · pushed' }, poolId: 'pool-00000000000000aa' };
  for (const cb of listeners) cb({ rows: [{ agentId: 'phyllis-1', view }] });
  assert.deepEqual(states, [{ window: view.weekly, poolId: 'pool-00000000000000aa' }], 'the WEEKLY window of the family main resolved, and its id');
  resolveInvoke({ ...view, weekly: { kind: 'TEXT', text: 'late' } });
  await new Promise((res) => setImmediate(res));
  assert.equal(states.length, 1, 'a push beats a late mount answer');
  cleanups.forEach((c) => c());
  assert.equal(listeners.size, 0);
});

// ─── the selector ───────────────────────────────────────────────────────────────────

test('the selector: Antigravity reads budget, 3P · 5H, 3P · Weekly, Gemini · 5H, Gemini · Weekly; Claude/Codex unchanged', () => {
  const opts = line.usageDisplayOptions('antigravity');
  assert.deepEqual(opts.map((o) => o.label), ['budget', '3P · 5H', '3P · Weekly', 'Gemini · 5H', 'Gemini · Weekly']);
  assert.deepEqual(opts.map((o) => o.value), ['budget', ...AGY]);
  assert.deepEqual(line.USAGE_DISPLAY_OPTIONS.map((o) => [o.value, o.label]), [['budget', 'budget'], ['fiveHour', '5H'], ['weekly', 'Weekly']]);
  const out = html(React.createElement(line.AgentUsageSelect, { value: 'agyGeminiWeekly', onChange: () => {}, options: opts }));
  assert.match(out, /<option value="agy3pFiveHour">3P · 5H<\/option><option value="agy3pWeekly">3P · Weekly<\/option><option value="agyGeminiFiveHour">Gemini · 5H<\/option><option value="agyGeminiWeekly" selected="">Gemini · Weekly<\/option>/);
  assert.ok(!/value="fiveHour"|value="weekly"/.test(out), 'no generic 5H / Weekly for Antigravity');
  const panel = codeOnly(readSource('src/renderer/src/components/CommandCenterPanel.tsx'), 'CommandCenterPanel.tsx');
  assert.match(panel, /const usageOptions = usageDisplayOptions\(agentProvider\);/);
  assert.match(panel, /const usageDisplay: AgentUsageDisplay = shownUsageDisplay\(agentProvider, agentUsageDisplay\[a\.id\]\);/);
  assert.match(panel, /<AgentUsageSelect value=\{usageDisplay\} options=\{usageOptions\} onChange=/);
});

test('the selector shows a persisted value only where its provider offers it; otherwise budget, never written back', () => {
  assert.equal(line.shownUsageDisplay('antigravity', 'agy3pWeekly'), 'agy3pWeekly');
  assert.equal(line.shownUsageDisplay('antigravity', 'fiveHour'), 'budget', 'a generic 5H on an AGY agent cannot name one family');
  assert.equal(line.shownUsageDisplay('codex', 'agyGeminiFiveHour'), 'budget', 'an AGY value on a Codex agent');
  assert.equal(line.shownUsageDisplay('codex', 'weekly'), 'weekly');
  assert.equal(line.shownUsageDisplay('gemini', 'weekly'), 'budget');
  assert.equal(line.shownUsageDisplay('antigravity', undefined), 'budget');
  const src = codeOnly(readSource('src/renderer/src/components/AgentUsageLine.tsx'), 'AgentUsageLine.tsx');
  const fn = src.slice(src.indexOf('export function shownUsageDisplay('), src.indexOf('\n}\n', src.indexOf('export function shownUsageDisplay(')));
  assert.ok(!/setAgentUsageDisplay|window\.cth/.test(fn), 'display only: it never writes config');
});

// ─── detail opens the selected family only ──────────────────────────────────────────

test('DETAIL: clicking an AGY figure opens the provider-details panel on THAT family\'s opaque poolId', () => {
  const f = geminiBound();
  const view = agentUsageViewFor(f.src, 'phyllis-1', 'agy3pFiveHour', f.now, fmt);
  const el = line.UsageLineFigure({ line: { window: view.fiveHour, poolId: view.poolId } });
  assert.equal(el.props['data-usage-detail'], f.strip.poolIdOf(P3));
  assert.equal(el.props.role, 'button');
  detailSelection.closeCapacityDetail();
  el.props.onClick();
  assert.equal(detailSelection.getOpenCapacityDetail(), f.strip.poolIdOf(P3), 'the 3P family, though the agent is Gemini-bound');
  detailSelection.closeCapacityDetail();
  let prevented = false;
  el.props.onKeyDown({ key: 'Enter', preventDefault: () => { prevented = true; } });
  assert.equal(detailSelection.getOpenCapacityDetail(), f.strip.poolIdOf(P3), 'keyboard opens it too');
  assert.ok(prevented);
  detailSelection.closeCapacityDetail();
  const out = html(React.createElement(line.UsageLineFigure, { line: { window: view.fiveHour, poolId: view.poolId } }));
  assert.ok(out.includes('3P · 5h · 10% used'));
  const plain = html(React.createElement(line.UsageLineFigure, { line: { window: view.fiveHour, poolId: null } }));
  assert.ok(!/role="button"|data-usage-detail/.test(plain), 'a Claude/Codex row (no id) is not a link');
});

test('DETAIL: the panel for that poolId shows ONLY the selected family\'s two windows, and nothing of scope, home, email or payload', () => {
  const f = geminiBound();
  for (const [display, key, label, texts] of [
    ['agy3pWeekly', P3, 'Antigravity · 3P', ['5h · 90% remaining', 'Weekly · 70% remaining']],
    ['agyGeminiFiveHour', PG, 'Antigravity · Gemini', ['5h · 40% remaining', 'Weekly · 20% remaining']]
  ]) {
    const poolId = agentUsageViewFor(f.src, 'phyllis-1', display, f.now, fmt).poolId;
    // main's capacityDetailViewOf(poolId): the snapshot pool whose strip id matches
    const pool = f.r.snapshot().pools.find((p) => f.strip.poolIdOf(p.poolKey) === poolId);
    assert.equal(pool.poolKey, key, `${display}: the id resolves back to the selected family only`);
    const detail = capacityDetailView({
      pool, poolId, poolLabel: f.strip.labelOf(pool), presentation: null,
      members: f.r.membersOf(pool.poolKey), membershipKnown: true, statusNote: null, now: f.now, formatTime: fmt
    });
    assert.deepEqual(validateCapacityDetail(detail), [], display);
    assert.equal(detail.poolLabel, label);
    assert.equal(detail.poolId, poolId);
    assert.deepEqual(detail.windows.map((w) => w.text), texts, `${display}: that family's complete two-window observation, no sibling numbers`);
    assert.equal(detail.freshness.verdict, 'FRESH');
    assert.equal(detail.sourceText, 'Antigravity status line');
    const json = JSON.stringify(detail);
    for (const secret of [SCOPE, EMAIL, GEMINI_HOME, 'remaining_fraction', 'agy_status', '3p-5h', 'gemini-5h', 'sess-1']) {
      assert.ok(!json.includes(secret), `${display}: ${secret}`);
    }
  }
});

// ─── S4: existing tokens, both labels, all states, light and dark ───────────────────

const tokensOf = () => {
  const css = readSource('src/renderer/src/design/tokens.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const block = (selector) => { const at = css.indexOf(`${selector} {`); assert.ok(at >= 0, selector); return css.slice(at, css.indexOf('}', at)); };
  const read = (body) => (name) => { const m = new RegExp(`--${name}:\\s*(#[0-9a-f]{6})\\s*;`, 'i').exec(body); assert.ok(m, `--${name}`); return m[1]; };
  return { light: read(block(':root')), dark: read(block(":root[data-cth-theme='dark']")) };
};
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
const STATES = ['UNKNOWN', 'AVAILABLE', 'APPROACHING', 'RESERVE_ONLY', 'LIMITED', 'RECOVERING'];

test('S4: both AGY labels, every state - the meter fill is the EXISTING state token (the same one Claude/Codex use), no AGY colour', () => {
  for (const family of ['3P', 'Gemini']) {
    for (const state of STATES) {
      const view = { kind: 'USAGE', usedPercent: 42, displayPercent: 42, text: `${family} · 5h · 42% used`, state };
      const out = html(React.createElement(line.UsageLineFigure, { line: { window: view, poolId: 'pool-00000000000000aa' } }));
      const generic = html(React.createElement(line.UsageWindowFigure, { view: { ...view, text: '5h · 42% used' } }));
      assert.ok(out.includes(`background:${STATE_COLOR[state]}`), `${family}/${state}: ${STATE_COLOR[state]}`);
      assert.match(STATE_COLOR[state], /^var\(--cth-[a-z0-9-]+\)$/, 'an existing design token');
      assert.equal(out.match(/background:var\(--cth-[a-z0-9-]+\)/g).join(), generic.match(/background:var\(--cth-[a-z0-9-]+\)/g).join(), `${family}/${state}: identical tokens to the generic line`);
      assert.ok(out.includes('color:var(--cth-ink-900)'), 'the figure text token');
    }
  }
  const src = codeOnly(readSource('src/renderer/src/components/AgentUsageLine.tsx'), 'AgentUsageLine.tsx');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b|hsl\(|rgb\(/.test(src), 'no literal colour: tokens only');
});

test('S4: in light AND dark, every token both AGY labels use meets the existing text thresholds on the panel', () => {
  const t = tokensOf();
  for (const [theme, tok] of Object.entries(t)) {
    for (const bg of ['cth-paper-100', 'cth-cream-100']) {
      // USAGE figure text, TEXT-kind text, and the selector text (all labels, all states use these)
      for (const fg of ['cth-ink-900', 'cth-ink-700', 'cth-ink-500']) {
        assert.ok(contrast(tok(fg), tok(bg)) >= 4.5, `${theme}: ${fg} on ${bg} = ${contrast(tok(fg), tok(bg)).toFixed(2)}`);
      }
    }
    // every state token the fill can take is defined in BOTH themes (a theme without it would draw nothing)
    for (const state of STATES) tok(STATE_COLOR[state].slice(6, -1));
  }
});
