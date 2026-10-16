'use strict';

/**
 * AGY-QUOTA-KEYS-190: agy 1.3.6/1.4.0 added a fifth quota bucket, and every tick drifted
 * with `quota-keys`, so the capacity bar lost the Antigravity windows.
 *
 * THE FIXTURE IS A REAL 1.4.0 TICK (agy 1.4.0 TUI, 2026-10-16T18:31:01Z, jailed home,
 * statusLine pointed at a capture script). Its quota block, model, version and every
 * other field are as captured; the email, cwd, transcript path and workspace dirs are
 * fictitious. It was captured during `initializing`: the jailed install stopped at the
 * first-run Terms page, which was left unaccepted on purpose. Where a test needs a
 * lifecycle the tick is given `agent_state: 'idle'`, the only field it changes.
 *
 * Before (004e957b): the idle tick drifts `quota-keys`; after: two observations, the
 * scoped bucket a third window of the Gemini family.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const {
  normalizeAgyStatusLine, classifyAgyStatusLine, AGY_QUOTA_KEYS, AGY_MAX_SCOPED_QUOTA_KEYS
} = loadTs('src/main/capacityNormalize.ts');
const { ProviderCapacityTracker, L0_SEM_POLICY } = loadTs('src/main/providerCapacityTracker.ts');

const FIXTURE = path.join(__dirname, 'fixtures', 'agy-statusline-1.4.0.json');
const OLD_FIXTURE = path.join(__dirname, 'fixtures', 'agy-statusline-1.2.8.json');
/** When the capture script received the fixture's tick. */
const RECEIVED = 1792175461134;
const OLD_RECEIVED = Date.parse('2026-09-22T09:44:03Z');
const SCOPE = 'agyscope0001';
const SCOPED = 'gemini-argon-wtu-weekly';

const real = () => JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const idle = (fn) => { const p = real(); p.agent_state = 'idle'; if (fn) fn(p); return p; };
const run = (payload, receivedAt = RECEIVED) => classifyAgyStatusLine({ payload, accountScope: SCOPE, receivedAt });
const tickOf = (payload, receivedAt = RECEIVED) => normalizeAgyStatusLine({ payload, accountScope: SCOPE, receivedAt });
const ids = (o) => o.windows.map((w) => w.windowId);

test('the real 1.4.0 fixture: four base buckets plus one scoped bucket, and no identifying field', () => {
  const p = real();
  assert.equal(p.version, '1.4.0');
  assert.deepEqual(Object.keys(p.quota).sort(), [...AGY_QUOTA_KEYS, SCOPED].sort());
  assert.equal(p.email, 'fixture.person@example.invalid');
  const text = fs.readFileSync(FIXTURE, 'utf8');
  for (const bad of ['FiercePC', 'Dunder', '@gmail']) assert.ok(!text.includes(bad), bad);
});

test('the captured lifecycle is unchanged: an `initializing` tick is still agent-state drift', () => {
  const c = run(real());
  assert.equal(c.ok, false);
  assert.equal(c.driftCode, 'agent-state');
});

test('1.4.0 idle tick: accepted, the scoped bucket joins the Gemini family after its base windows', () => {
  const c = run(idle());
  assert.equal(c.ok, true, `drift ${c.driftCode}`); // before: quota-keys
  const [p3, gem] = c.tick.observations;
  assert.equal(c.tick.version, '1.4.0');
  assert.equal(c.tick.activeLimitId, 'gemini');
  assert.deepEqual(ids(p3), ['3p-5h', '3p-weekly']);
  assert.deepEqual(ids(gem), ['gemini-5h', 'gemini-weekly', SCOPED]);
  const w = gem.windows[2];
  assert.equal(w.kind, 'SEVEN_DAY');
  assert.equal(w.windowMinutes, 7 * 24 * 60);
  assert.equal(w.applicability, 'APPLICABLE');
  assert.equal(w.label, 'Weekly (argon-wtu)');
  assert.equal(w.remainingPercent, 0.8722944 * 100);
  assert.equal(w.usedPercent + w.remainingPercent, 100);
  assert.equal(w.resetsAt, Date.parse('2026-10-23T18:04:41Z'));
  assert.equal(gem.windows[1].label, 'Weekly');
  assert.equal(p3.windows[1].remainingPercent, 0.4816392 * 100);
});

test('the old four-key shape still normalizes exactly as before (1.2.8 fixture)', () => {
  const t = normalizeAgyStatusLine({
    payload: JSON.parse(fs.readFileSync(OLD_FIXTURE, 'utf8')), accountScope: SCOPE, receivedAt: OLD_RECEIVED
  });
  assert.ok(t);
  assert.deepEqual(t.observations.map(ids), [['3p-5h', '3p-weekly'], ['gemini-5h', 'gemini-weekly']]);
});

test('a scoped bucket of the 3P family joins the 3P observation; scoped keys are ordered', () => {
  const t = tickOf(idle((p) => {
    p.quota['3p-zeta-5h'] = { ...p.quota['3p-5h'] };
    p.quota['3p-alpha-weekly'] = { ...p.quota['3p-weekly'] };
  }));
  assert.deepEqual(ids(t.observations[0]), ['3p-5h', '3p-weekly', '3p-alpha-weekly', '3p-zeta-5h']);
  assert.equal(t.observations[0].windows[3].kind, 'FIVE_HOUR');
  assert.equal(t.observations[0].windows[3].label, '5h (zeta)');
});

test('still strict: keys outside the grammar, a missing base bucket, too many scoped buckets', () => {
  const b = () => ({ ...real().quota['3p-5h'] });
  const cases = [
    ['an unknown duration', (p) => { p.quota['3p-monthly'] = b(); }],
    ['an unknown duration with a scope', (p) => { p.quota['gemini-argon-monthly'] = b(); }],
    ['a third family', (p) => { p.quota['claude-x-weekly'] = b(); }],
    ['an empty scope', (p) => { p.quota['gemini--weekly'] = b(); }],
    ['an uppercase scope', (p) => { p.quota['gemini-Argon-weekly'] = b(); }],
    ['a trailing dash', (p) => { p.quota['gemini-argon--weekly'] = b(); }],
    ['a base bucket missing beside a scoped one', (p) => { delete p.quota['gemini-weekly']; }],
    // Jim NIT 1: literal counts, so the cap's VALUE is pinned (a cap of 99 used to pass).
    ['9 scoped buckets (the real one plus 8)', (p) => {
      for (let i = 0; i < 8; i++) p.quota[`gemini-s${i}-weekly`] = b();
    }],
    // Jim NIT 2: a duration is never a scope ("Weekly (5h)" would be nonsense).
    ['5h as the scope', (p) => { p.quota['gemini-5h-weekly'] = b(); }],
    ['weekly as the scope', (p) => { p.quota['gemini-weekly-5h'] = b(); }],
    ['5h as one scope segment', (p) => { p.quota['3p-argon-5h-weekly'] = b(); }],
    ['weekly as the first scope segment', (p) => { p.quota['3p-weekly-argon-5h'] = b(); }]
  ];
  for (const [name, fn] of cases) {
    const c = run(idle(fn));
    assert.equal(c.ok, false, `${name}: must refuse`);
    assert.equal(c.driftCode, 'quota-keys', name);
  }
  // The cap itself is allowed: 8 scoped buckets, the real one plus seven more.
  assert.equal(AGY_MAX_SCOPED_QUOTA_KEYS, 8);
  const atCap = run(idle((p) => {
    for (let i = 0; i < 7; i++) p.quota[`gemini-s${i}-weekly`] = b();
  }));
  assert.equal(atCap.ok, true);
  assert.equal(atCap.tick.observations[1].windows.length, 2 + 8, 'the two Gemini base windows and 8 scoped ones');
  // A scope that merely CONTAINS a duration's letters is a scope (only whole segments are refused).
  const near = run(idle((p) => { p.quota['gemini-weekly5h-weekly'] = b(); p.quota['3p-x5h-5h'] = b(); }));
  assert.equal(near.ok, true);
});

test('a scoped bucket is checked like the base ones: one fault refuses the whole tick', () => {
  const cases = [
    ['gains a field', (q) => { q.extra = 1; }, 'bucket-keys'],
    ['fraction above 1', (q) => { q.remaining_fraction = 1.5; }, 'fraction'],
    ['reset_time not a date', (q) => { q.reset_time = 'soon'; }, 'reset-time'],
    ['reset seconds negative', (q) => { q.reset_in_seconds = -1; }, 'reset-seconds'],
    ['the two resets disagree', (q) => { q.reset_in_seconds += 60; }, 'reset-disagree']
  ];
  for (const [name, fn, code] of cases) {
    const c = run(idle((p) => fn(p.quota[SCOPED])));
    assert.equal(c.ok, false, name);
    assert.equal(c.driftCode, code, name);
  }
});

test('a scoped bucket at zero holds the Gemini pool (RESERVE_ONLY), never the 3P one', () => {
  const t = tickOf(idle((p) => { p.quota[SCOPED].remaining_fraction = 0; }));
  const tracker = new ProviderCapacityTracker(L0_SEM_POLICY, () => RECEIVED, () => 0);
  for (const o of t.observations) tracker.ingest(o);
  const gem = tracker.pool(`antigravity:${SCOPE}:gemini`);
  assert.equal(gem.state, 'RESERVE_ONLY');
  assert.deepEqual(gem.numericallyExhaustedWindowIds, [SCOPED]);
  assert.equal(tracker.pool(`antigravity:${SCOPE}:3p`).state, 'AVAILABLE');
  // And the real values leave both pools available.
  const live = new ProviderCapacityTracker(L0_SEM_POLICY, () => RECEIVED, () => 0);
  for (const o of tickOf(idle()).observations) live.ingest(o);
  assert.equal(live.pool(`antigravity:${SCOPE}:gemini`).state, 'AVAILABLE');
  assert.equal(live.pool(`antigravity:${SCOPE}:3p`).state, 'AVAILABLE');
});
