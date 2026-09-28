'use strict';

/**
 * PROBE-REISSUE (1.1.72; god's GO "A" + "B" on Jim's DWIGHT-HOLD chain, relayed to the Human).
 *
 * Live 2026-09-28, Dwight (Codex):
 *   01:06:47Z  the last reading: five_hour 100%, resetsAt 03:02:24Z  -> held (RESERVE_ONLY, then stale)
 *   03:03:18Z  the ONE post-reset probe is granted, typed and CONFIRMED
 *              ...but no turn follows: no hook, so no fresh rate-limit reading
 *   03:04 / 03:09 / 03:14 / 04:33 / 05:00  REFUSED POST_RESET_SINGLE_PROBE_ALREADY_GRANTED - for ever
 *
 * A: a confirmed probe that brought no fresh reading is re-issued after a backoff (10, 20, 40, 80
 *    min, then capped at 2 h), with a capacity-probe-reissue row; a timer re-checks at the boundary.
 * B: a probe whose agent's hooks stay silent for 2 min logs capacity-probe-no-turn with the
 *    terminal's last visible line, so the next occurrence explains itself.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { readSource: read } = require('./read-source.cjs');

const { CapacityRuntime } = loadTs('src/main/capacityRuntime.ts');
const { ADMISSION_REASON, probeReissueBackoffMs, PROBE_REISSUE_CAP_MS } = loadTs('src/main/capacityAdmission.ts');
const { ProviderCapacityTracker, L0_SEM_POLICY } = loadTs('src/main/providerCapacityTracker.ts');
const { CapacityProbeWatch, lastVisibleLine, redactTail, PROBE_NO_TURN_WAIT_MS } = loadTs('src/main/capacityProbeWatch.ts');

const Z = (iso) => Date.parse(iso);
const POOL = 'codex:acct-d:codex';
const MIN = 60_000;

/** Dwight's persisted reading, as capacity-observations.json held it. */
const dwightReading = () => ({
  poolKey: POOL, provider: 'codex', accountScope: 'acct-d', limitId: 'codex',
  source: 'codex-rollout', streamId: 'codex-rollout:/s/d.jsonl', sourceSequence: 1,
  observedAt: Z('2026-09-28T01:06:47.461Z'), receivedAt: Z('2026-09-28T01:06:52.420Z'),
  windows: [
    { windowId: 'five_hour', kind: 'FIVE_HOUR', label: '5h', windowMinutes: 300, usedPercent: 100, remainingPercent: 0, resetsAt: Z('2026-09-28T03:02:24.000Z') },
    { windowId: 'seven_day', kind: 'SEVEN_DAY', label: '7d', windowMinutes: 10080, usedPercent: 60, remainingPercent: 40, resetsAt: Z('2026-10-03T17:10:51.000Z') }
  ],
  providerAttributedLimitingWindowId: null, providerReachedType: null, ordinaryUsageAllowed: null, planType: 'plus'
});

function world() {
  const w = { now: Z('2026-09-28T01:06:52.420Z'), mono: 0, timers: [], seq: 0, logs: [], changes: 0, launched: [] };
  const setTimer = (fn, ms) => { const t = { at: w.now + ms, seq: (w.seq += 1), fn }; w.timers.push(t); return { id: t.seq }; };
  w.tracker = new ProviderCapacityTracker(L0_SEM_POLICY, () => w.now, () => w.mono);
  w.runtime = new CapacityRuntime({
    deliver: () => {}, now: () => w.now, setTimer,
    clearTimer: (h) => { w.timers = w.timers.filter((t) => t.seq !== (h && h.id)); },
    onChange: () => { w.changes += 1; },
    log: (row) => w.logs.push(row),
    onProbeLaunched: (p) => w.launched.push(p)
  }, w.tracker);
  /** Advance the clock to `iso`, firing due timers in order. */
  w.to = (iso) => {
    const until = typeof iso === 'number' ? iso : Z(iso);
    for (;;) {
      w.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      if (!w.timers.length || w.timers[0].at > until) break;
      const t = w.timers.shift(); w.mono += t.at - w.now; w.now = t.at; t.fn();
    }
    w.mono += until - w.now; w.now = until;
  };
  /** One wake: admit, and when granted, the turn is really launched (typed + Enter). */
  w.wake = () => {
    const d = w.runtime.admit('dwight-mu32ztys', 'ORDINARY_TURN');
    if (d.verdict === 'ALLOW' && d.grantId) w.runtime.confirmLaunch(d);
    return d;
  };
  w.reissues = () => w.logs.filter((r) => r.kind === 'capacity-probe-reissue');
  return w;
}

test('THE LIVE SEQUENCE: 01:06 reading -> 03:02 reset -> one probe with no turn -> no longer held for ever', () => {
  const w = world();
  w.runtime.ingest('dwight-mu32ztys', dwightReading());
  assert.equal(w.wake().reason, ADMISSION_REASON.RESERVE_ORDINARY, '01:06: the window is spent: held');
  w.to('2026-09-28T01:40:00Z');
  assert.equal(w.wake().verdict, 'UNKNOWN_NOT_INFERRED_SAFE', 'stale, last known not healthy: held (the wake owner treats it as a hold)');
  w.to('2026-09-28T03:03:18.074Z');
  const probe = w.wake();
  assert.deepEqual([probe.verdict, probe.reason, probe.probeAttempt], ['ALLOW', ADMISSION_REASON.POST_RESET_PROBE_GRANT, 0], '03:03:18 the one post-reset probe');
  assert.deepEqual(w.launched, [{ agentId: 'dwight-mu32ztys', poolKey: POOL, attempt: 0 }], 'main is told a probe turn went out (B watches it)');
  // No turn, no reading. The live refusals:
  for (const at of ['2026-09-28T03:04:29.701Z', '2026-09-28T03:09:37.263Z']) {
    w.to(at);
    assert.equal(w.wake().reason, ADMISSION_REASON.POST_RESET_PROBE_SPENT, `${at}: spent (inside the 10 min backoff)`);
  }
  const changesBefore = w.changes;
  w.to('2026-09-28T03:13:18.075Z');
  assert.ok(w.changes > changesBefore, 'AT THE BOUNDARY a timer re-checks the pool (a capacity change is what re-tries held agents)');
  const again = w.wake();
  assert.deepEqual([again.verdict, again.reason, again.probeAttempt], ['ALLOW', ADMISSION_REASON.POST_RESET_PROBE_GRANT, 1], '03:13:18: RE-ISSUED - no longer held for ever');
  assert.deepEqual(w.reissues().map((r) => [r.agentId, r.poolKey, r.attempt, r.sinceConfirmedMs]), [['dwight-mu32ztys', POOL, 1, 10 * MIN + 1]]);
  assert.equal(w.wake().reason, ADMISSION_REASON.POST_RESET_PROBE_SPENT, 'one probe in flight at a time');
});

test('the backoff doubles and caps at 2 h: 10, 20, 40, 80, 120, 120 min', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map((n) => probeReissueBackoffMs(n) / MIN), [10, 20, 40, 80, 120, 120, 120]);
  assert.equal(PROBE_REISSUE_CAP_MS, 120 * MIN);
  const w = world();
  w.runtime.ingest('dwight-mu32ztys', dwightReading());
  w.to('2026-09-28T03:03:18Z');
  assert.equal(w.wake().probeAttempt, 0);
  let t = Z('2026-09-28T03:03:18Z');
  for (const [attempt, gap] of [[1, 10], [2, 20], [3, 40], [4, 80], [5, 120], [6, 120]]) {
    w.to(t + gap * MIN - 1_000);
    assert.equal(w.wake().reason, ADMISSION_REASON.POST_RESET_PROBE_SPENT, `attempt ${attempt} not before ${gap} min`);
    w.to(t + gap * MIN);
    assert.equal(w.wake().probeAttempt, attempt, `attempt ${attempt} at ${gap} min`);
    t += gap * MIN;
  }
  assert.equal(w.reissues().length, 6, 'about six probes over five hours, never a storm');
});

test('fresh evidence ends it as before: a healthy reading makes the pool AVAILABLE, no more probes or re-issues', () => {
  const w = world();
  w.runtime.ingest('dwight-mu32ztys', dwightReading());
  w.to('2026-09-28T03:03:18Z');
  w.wake();
  w.to('2026-09-28T03:05:00Z');
  w.runtime.ingest('dwight-mu32ztys', { ...dwightReading(), sourceSequence: 2, observedAt: w.now, receivedAt: w.now,
    windows: [{ ...dwightReading().windows[0], usedPercent: 3, remainingPercent: 97, resetsAt: Z('2026-09-28T08:05:00Z') }, dwightReading().windows[1]] });
  assert.equal(w.wake().reason, ADMISSION_REASON.AVAILABLE);
  w.to('2026-09-28T03:20:00Z');
  const later = w.wake().reason;
  assert.ok([ADMISSION_REASON.AVAILABLE, ADMISSION_REASON.STALE_AFTER_HEALTHY].includes(later), `no probe state any more (the healthy reading, fresh or stale): ${later}`);
  assert.equal(w.reissues().length, 0);
});

test('a probe that was never launched is not re-issued on the backoff (only CONFIRMED probes are)', () => {
  const w = world();
  w.runtime.ingest('dwight-mu32ztys', dwightReading());
  w.to('2026-09-28T03:03:18Z');
  const d = w.runtime.admit('dwight-mu32ztys', 'ORDINARY_TURN');
  w.runtime.holdGrant(d); // interfered: a person decides; no TTL, no backoff
  w.to('2026-09-28T05:00:00Z');
  assert.equal(w.runtime.admit('dwight-mu32ztys', 'ORDINARY_TURN').reason, ADMISSION_REASON.POST_RESET_PROBE_SPENT, 'a grant held for a human is never re-issued by a timer');
  assert.equal(w.reissues().length, 0);
  assert.deepEqual(w.launched, [], 'and nothing was reported launched');
});

// ── B: the probe that produced no turn explains itself ────────────────────────────────

function watchRig({ hookAt, tail = '', idle = 5000 } = {}) {
  const r = { now: 1_000_000, timers: [], logs: [], hookAt };
  r.watch = new CapacityProbeWatch({
    now: () => r.now,
    setTimer: (fn, ms) => { r.timers.push({ at: r.now + ms, fn }); return {}; },
    lastHookAt: () => r.hookAt, tailLine: () => lastVisibleLine(tail), idleMs: () => idle,
    log: (row) => r.logs.push(row)
  });
  r.run = () => { for (const t of r.timers.splice(0)) { r.now = t.at; t.fn(); } };
  return r;
}

test('B: no hook within 2 min of the probe -> ONE capacity-probe-no-turn row with the last visible line', () => {
  const r = watchRig({ hookAt: 1_000_000 - 90 * MIN, tail: '\x1b[2K\r\x1b[31m■ You’ve hit your usage limit. Try again at 3:02 AM.\x1b[39m\r\n\x1b[?2026h\x1b[5;1H› \x1b[?2026l' });
  r.watch.launched({ agentId: 'dwight-mu32ztys', poolKey: POOL, attempt: 0 });
  r.run();
  assert.equal(PROBE_NO_TURN_WAIT_MS, 2 * MIN);
  assert.equal(r.logs.length, 1);
  const row = r.logs[0];
  assert.deepEqual([row.kind, row.agentId, row.poolKey, row.attempt, row.waitedMs, row.lastHookAgoMs, row.ptyIdleMs],
    ['capacity-probe-no-turn', 'dwight-mu32ztys', POOL, 0, 2 * MIN, 92 * MIN, 5000]);
  assert.equal(row.tail, '›', 'the last VISIBLE line (the empty composer), escapes stripped');
});

test('B: a hook after the launch (a turn started) logs nothing; a hook from BEFORE the launch does not count', () => {
  const r = watchRig({ hookAt: undefined });
  r.watch.launched({ agentId: 'a', poolKey: POOL, attempt: 1 });
  r.hookAt = r.now + 30_000; // the turn's first hook
  r.run();
  assert.deepEqual(r.logs, []);
  const q = watchRig({ hookAt: 999_000 });
  q.watch.launched({ agentId: 'a', poolKey: POOL, attempt: 1 });
  q.run();
  assert.equal(q.logs.length, 1, 'an old hook is not this turn');
  assert.equal(q.logs[0].tail, null, 'no output at all: tail null');
});

test('lastVisibleLine: CSI/OSC stripped, CR and cursor moves split lines, capped length', () => {
  assert.equal(lastVisibleLine('a\r\nb\r\n'), 'b');
  assert.equal(lastVisibleLine('\x1b]0;title\x07hello\x1b[K'), 'hello');
  assert.equal(lastVisibleLine('first\x1b[3;1Hsecond'), 'second');
  assert.equal(lastVisibleLine('x'.repeat(500)).length, 200);
  assert.equal(lastVisibleLine('\x1b[2J\x1b[H'), null);
});

test('WIRING: hooks stamp hookSeenAt; the runtime reports launches to the watch; each PTY keeps a bounded tail', () => {
  const idx = read('src/main/index.ts');
  assert.match(idx, /\(agentId, event, message, fullyIdle, turnId, source\) => \{ if \(agentId\) hookSeenAt\.set\(agentId, Date\.now\(\)\); inboxWake\?\.onHook\(/);
  assert.match(idx, /onProbeLaunched: \(probe\) => capacityProbeWatch\.launched\(probe\)/);
  assert.match(idx, /tailLine: \(agentId\) => \{ const id = ptyForAgent\(agentId\); const raw = id \? ptyManager\.tail\(id\) : undefined; return raw \? lastVisibleLine\(raw\) : null; \}/);
  const pty = read('src/main/pty.ts');
  assert.match(pty, /session\.tail = \(session\.tail \+ data\)\.slice\(-PTY_TAIL_CHARS\);/);
  assert.match(pty, /export const PTY_TAIL_CHARS = 4096;/);
});

test('B / NIT 1: the logged tail line is REDACTED (log.jsonl is read by every agent)', () => {
  const r = watchRig({ hookAt: undefined, tail: '\x1b[2K\r\u203a export OPENAI_API_KEY=sk-proj-AbCdEf0123456789xyzXYZ and Bearer abcdefgh12345678 ghp_0123456789abcdefghij0123 then c2VjcmV0LXRva2VuLXRoYXQtaXMtbG9uZy1lbm91Z2gtdG8tbWF0dGVy' });
  r.watch.launched({ agentId: 'a', poolKey: POOL, attempt: 0 });
  r.run();
  const tail = r.logs[0].tail;
  for (const secret of ['sk-proj-AbCdEf0123456789xyzXYZ', 'abcdefgh12345678', 'ghp_0123456789abcdefghij0123', 'c2VjcmV0LXRva2VuLXRoYXQtaXMtbG9uZy1lbm91Z2gtdG8tbWF0dGVy']) {
    assert.ok(!tail.includes(secret), `leaked ${secret}: ${tail}`);
  }
  assert.match(tail, /\[redacted\]/);
  assert.equal(redactTail('\u203a Working (12s \u2022 esc to interrupt)'), '\u203a Working (12s \u2022 esc to interrupt)', 'ordinary text survives');
  assert.equal(redactTail(null), null);
});

test('NIT 3: a repeated confirm of the same grant does NOT restart its backoff', () => {
  const w = world();
  w.runtime.ingest('dwight-mu32ztys', dwightReading());
  w.to('2026-09-28T03:03:18Z');
  const d = w.wake(); // granted and confirmed at 03:03:18
  w.to('2026-09-28T03:08:00Z');
  w.runtime.confirmLaunch(d); // e.g. "already handled" after the launch was confirmed
  w.to('2026-09-28T03:13:18Z');
  assert.equal(w.wake().probeAttempt, 1, 'the backoff counts from the FIRST confirmation');
});
