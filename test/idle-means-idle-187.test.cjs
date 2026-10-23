'use strict';

/**
 * IDLE-MEANS-IDLE-187 (1.1.87): an agent that started a suite in the background, waits in the
 * heavy-job lock's queue or holds a reservation has closed its TURN, so liveness says IDLE and every
 * display said plain "idle" (Jim's diagnosis, 2026-10-15). The lock knows those facts; the displays
 * now overlay them: background reads working (at the desk), queued and reserved read waiting.
 *
 * Display only. The wake lifecycle and the liveness classes never see the overlay (a queued agent
 * stays wakeable for "HEAVY SLOT FREE"), and the composer's send-now keeps the turn status.
 *
 * T1 precedence + the lock never has one agent in two states; T2 onChange once per change;
 * T3 the wake path is untouched; T4 the LIVE ROSTER and fleet.json; T5 the office floor;
 * T6 composer send-now; T7 a replay of the lock's log, 2026-10-15 05:52-06:35Z.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');

// hooks.ts (via hive.ts) pulls Notification from electron; outside Electron seed the surface it touches.
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { Notification: class { show() {} static isSupported() { return false; } } }
};

const ACT = loadTs('src/shared/activityView.ts');
const { HeavyJobLock, HEAVY_RESERVE_MS, HEAVY_TTL_MS, heavySlotFreeNotice } = loadTs('src/main/heavyJob.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const NOW = Date.parse('2026-10-15T06:30:00.000Z');
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
const lv = (classification, extra = {}) => ({
  v: 1, agentId: 'andy', incarnation: 3, lifecycle: 'LIVE', classification, classifiedSince: NOW - 9 * MIN,
  reason: classification === 'BUSY_PROGRESSING' ? 'turn-started' : 'quiescent', evidence: { sampledAt: NOW }, ...extra
});
const SUITE = { heavy: true, kind: 'suite' };
const view = (lock) => ({ holders: lock.snapshot(), ...lock.queueSnapshot() });
/** A lock on a fake clock, limit 1, no watcher timer, logging into `rows`. */
function fakeLock(opts = {}) {
  const clock = { t: opts.t ?? NOW };
  const rows = [];
  const notified = [];
  const lock = new HeavyJobLock({
    limit: () => opts.limit ?? 1, now: () => clock.t,
    setTimer: () => ({}), clearTimer: () => {},
    log: (r) => rows.push(r), notify: (a, k, u) => notified.push([a, k, u]),
    ...(opts.alive ? { alive: opts.alive } : {})
  });
  return { lock, clock, rows, notified };
}

// ─── T1: the helper's precedence, and one place per agent in the lock ───────────────────

test('T1 heavyActivity: a background holder, then a waiter, then a reservation; a foreground holder is not overlaid', () => {
  const lock = {
    holders: [{ agentId: 'bg', kind: 'suite', since: iso(NOW - 3 * MIN), background: true }, { agentId: 'fg', kind: 'build', since: iso(NOW), background: false }],
    waiters: [{ agentId: 'q', kind: 'suite', since: iso(NOW - 4 * MIN), position: 2 }],
    reserved: [{ agentId: 'r', kind: 'install', until: iso(NOW + 5 * MIN) }]
  };
  assert.deepEqual(ACT.heavyActivity('bg', lock), { state: 'background', kind: 'suite', since: NOW - 3 * MIN });
  assert.equal(ACT.heavyActivity('fg', lock), null, 'a foreground holder already shows working (its turn is open)');
  assert.deepEqual(ACT.heavyActivity('q', lock), { state: 'queued', kind: 'suite', position: 2, since: NOW - 4 * MIN });
  assert.deepEqual(ACT.heavyActivity('r', lock), { state: 'reserved', kind: 'install', until: NOW + 5 * MIN });
  assert.equal(ACT.heavyActivity('nobody', lock), null);
  assert.equal(ACT.heavyActivity('bg', null), null);
  assert.equal(ACT.heavyActivity(undefined, lock), null);
  // A malformed snapshot (a stale fleet.json) is read as "no place in the lock".
  assert.equal(ACT.heavyActivity('bg', {}), null);
  // Should one agent ever appear twice, holder > waiter > reservation.
  const both = { holders: [{ agentId: 'x', kind: 'suite', since: iso(NOW), background: true }], waiters: [{ agentId: 'x', kind: 'suite', since: iso(NOW), position: 1 }], reserved: [{ agentId: 'x', kind: 'suite', until: iso(NOW) }] };
  assert.equal(ACT.heavyActivity('x', both).state, 'background');
  assert.equal(ACT.heavyActivity('x', { waiters: both.waiters, reserved: both.reserved }).state, 'queued');
});

test('T1 precedence: CRASHED/EXITED/STUCK/SUSPECT > WORKING > background > queued > reserved > idle', () => {
  const bg = { state: 'background', kind: 'suite', since: NOW - MIN };
  const q = { state: 'queued', kind: 'suite', position: 1, since: NOW - MIN };
  const r = { state: 'reserved', kind: 'suite', until: NOW + MIN };
  // The richer and the bad states are never overlaid.
  for (const cls of ['SUSPECT', 'STUCK_WAKE', 'CRASHED', 'EXITED']) {
    for (const h of [bg, q, r]) assert.equal(ACT.activityStatus('idle', lv(cls), h), 'idle', `${cls} + ${h.state}: the liveness line owns it`);
  }
  for (const h of [bg, q, r]) {
    assert.equal(ACT.activityStatus('idle', lv('IDLE', { lifecycle: 'EXITED' }), h), 'idle', `not LIVE + ${h.state}`);
    assert.equal(ACT.activityStatus('idle', lv('BUSY_PROGRESSING'), h), 'working', `WORKING beats ${h.state}`);
    assert.equal(ACT.activityStatus('thinking', lv('BUSY_PROGRESSING'), h), 'thinking');
    for (const rich of ['blocked', 'waiting', 'compacting', 'looping', 'ghost']) assert.equal(ACT.activityStatus(rich, lv('IDLE'), h), rich, `${rich} is kept`);
  }
  // Then the lock, over idle (and over 'success', the turn that just closed).
  assert.equal(ACT.activityStatus('idle', lv('IDLE'), bg), 'working');
  assert.equal(ACT.activityStatus('success', lv('IDLE'), bg), 'working');
  assert.equal(ACT.activityStatus('idle', lv('IDLE'), q), 'waiting');
  assert.equal(ACT.activityStatus('idle', lv('IDLE'), r), 'waiting');
  assert.equal(ACT.activityStatus('idle', undefined, q), 'waiting', 'no liveness record yet: the hook status, overlaid');
  assert.equal(ACT.activityStatus('working', undefined, q), 'working', 'an open turn is never overlaid');
  // And nothing in the lock is today's idle.
  assert.equal(ACT.activityStatus('idle', lv('IDLE'), null), 'idle');
  assert.equal(ACT.activityStatus('idle', lv('IDLE')), 'idle');
  assert.equal(ACT.activityStatus('success', lv('IDLE')), 'success');
});

test('T1 the card line and the roster word for each place in the lock', () => {
  const bg = { state: 'background', kind: 'suite', since: NOW - 3 * MIN };
  const q = { state: 'queued', kind: 'suite', position: 2, since: NOW - 4 * MIN };
  const r = { state: 'reserved', kind: 'suite', until: Date.parse('2026-10-15T06:26:00Z') };
  assert.equal(ACT.heavyText(bg, NOW), 'suite in background 3m');
  assert.equal(ACT.heavyText(q, NOW), 'queued for heavy slot #2 (4m)');
  assert.equal(ACT.heavyText(r, NOW), 'heavy slot reserved until 06:26Z');
  assert.equal(ACT.heavyText(bg), 'suite in background', 'no clock: the floor\'s thought has no age');
  assert.equal(ACT.heavyText(q), 'queued for heavy slot #2');
  assert.equal(ACT.heavyText(null, NOW), null);
  assert.equal(ACT.rosterActivity(lv('IDLE'), NOW, null, bg), 'BACKGROUND suite 3m');
  assert.equal(ACT.rosterActivity(lv('IDLE'), NOW, null, q), 'QUEUED heavy #2 4m');
  assert.equal(ACT.rosterActivity(lv('IDLE'), NOW, null, r), 'RESERVED to 06:26Z');
  assert.equal(ACT.rosterActivity(lv('IDLE'), NOW, null, null), 'idle 9m');
  assert.equal(ACT.rosterActivity(lv('BUSY_PROGRESSING'), NOW, null, q), 'WORKING 9m', 'WORKING beats the lock');
  assert.equal(ACT.rosterActivity(lv('CRASHED'), NOW, null, bg), 'crashed 9m');
  assert.equal(ACT.rosterActivity(lv('SUSPECT'), NOW, null, q), 'suspect 9m');
});

test('T1 fuzz: the lock never has one agent as holder and waiter, or holder and reserved, or waiter and reserved', () => {
  let seed = 187;
  const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const agents = ['a', 'b', 'c', 'd'];
  for (let run = 0; run < 40; run++) {
    const limit = 1 + (run % 2);
    const { lock, clock } = fakeLock({ limit, alive: () => rand() > 0.05 });
    let call = 0;
    for (let step = 0; step < 120; step++) {
      const a = agents[Math.floor(rand() * agents.length)];
      const op = rand();
      clock.t += Math.floor(rand() * 2 * MIN);
      if (op < 0.45) lock.acquire(a, SUITE, 'npm test', `c${call++}`, rand() < 0.5);
      else if (op < 0.65) lock.callDone(a, `c${call - 1}`);
      else if (op < 0.85) lock.release(a, 'process-exit');
      else if (op < 0.92) lock.agentGone(a);
      else clock.t += HEAVY_RESERVE_MS;
      const v = view(lock);
      const h = new Set(v.holders.map((x) => x.agentId));
      const w = new Set(v.waiters.map((x) => x.agentId));
      const r = new Set(v.reserved.map((x) => x.agentId));
      for (const id of agents) {
        const n = (h.has(id) ? 1 : 0) + (w.has(id) ? 1 : 0) + (r.has(id) ? 1 : 0);
        assert.ok(n <= 1, `run ${run} step ${step}: ${id} is in ${n} places: ${JSON.stringify(v)}`);
      }
      assert.equal(w.size, v.waiters.length, 'a waiter is queued once');
      assert.ok(v.holders.length <= limit);
    }
  }
});

// ─── T2: onChange, once per change ──────────────────────────────────────────────────────

test('T2 onChange fires exactly once per acquire, background re-entry, deny, reserve, release, reserve-expired and drop', () => {
  const { lock, clock, rows } = fakeLock();
  let n = 0;
  const off = lock.onChange(() => { n++; });
  const step = (fn, want, what) => { const before = n; fn(); assert.equal(n - before, want, what); };
  step(() => lock.acquire('a', { heavy: false }, 'ls', 'x0', false), 0, 'a light call is no change');
  step(() => lock.acquire('a', SUITE, 'npm test', 'c1', false), 1, 'acquire');
  step(() => lock.acquire('a', SUITE, 'npm test', 'c2', false), 0, 'a foreground re-entry changes nothing shown');
  step(() => lock.acquire('a', SUITE, 'npm test &', 'c3', true), 1, 're-entry that makes the job a background one');
  step(() => lock.acquire('a', SUITE, 'npm test &', 'c4', true), 0, 'a second background re-entry');
  step(() => lock.acquire('b', SUITE, 'npm test', 'c5', false), 1, 'deny (queued #1)');
  step(() => lock.acquire('b', SUITE, 'npm test', 'c6', false), 1, 're-deny (the queued since restarts)');
  step(() => lock.release('a', 'process-exit'), 2, 'release, then the reserve it grants: one each');
  assert.deepEqual(rows.slice(-2).map((r) => r.action), ['release', 'reserve']);
  clock.t += HEAVY_RESERVE_MS;
  // HEAVY-HANDOFF-RACE (c): the lapsed owner is queued again (once) and, the slot being free, reserved again: three changes.
  step(() => lock.queueSnapshot(), 3, 'reserve-expired, queue-again, reserve');
  assert.deepEqual(rows.slice(-3).map((r) => r.action), ['reserve-expired', 'queue-again', 'reserve']);
  clock.t += HEAVY_RESERVE_MS;
  step(() => lock.queueSnapshot(), 1, 'the second lapse drops it: one change');
  assert.equal(rows.at(-1).action, 'reserve-expired');
  // A waiter an hour old when the slot frees keeps its place and is reserved (HEAVY-QUEUE-WAIT-DROPS: no drop by age).
  step(() => lock.acquire('a', SUITE, 'npm test', 'c7', false), 1, 'acquire');
  step(() => lock.acquire('c', SUITE, 'npm test', 'c8', false), 1, 'deny');
  clock.t += HEAVY_TTL_MS - 1;
  lock.acquire('a', SUITE, 'npm test', 'c9', false); // a re-entry keeps the holder fresh
  clock.t += 1;
  step(() => lock.callDone('a', 'c7'), 0, 'one of two calls done');
  step(() => lock.callDone('a', 'c9'), 2, 'release, then the hour-old waiter reserved');
  assert.deepEqual(rows.slice(-2).map((r) => [r.action, r.reason]), [['release', 'posttool'], ['reserve', undefined]]);
  assert.ok(!rows.some((r) => r.action === 'queue-dropped'), 'no waiter dropped by age');
  step(() => lock.acquire('c', SUITE, 'npm test', 'c8b', false), 1, 'c takes its reservation');
  step(() => lock.callDone('c', 'c8b'), 1, 'release');
  // A gone agent: its queue place, its reservation.
  step(() => lock.acquire('a', SUITE, 'npm test', 'c10', false), 1, 'acquire');
  step(() => lock.acquire('d', SUITE, 'npm test', 'c11', false), 1, 'deny');
  step(() => lock.agentGone('d'), 1, 'a gone waiter leaves the queue');
  step(() => lock.agentGone('d'), 0, 'gone twice is no change');
  step(() => lock.acquire('e', SUITE, 'npm test', 'c12', false), 1, 'deny');
  step(() => lock.callDone('a', 'c10'), 2, 'release + reserve');
  step(() => lock.agentGone('e'), 1, 'a gone agent drops its reservation');
  off();
  step(() => lock.acquire('a', SUITE, 'npm test', 'c13', false), 0, 'unsubscribed');
});

test('T2 onChange: an orphaned or unprobed job turning into a background holder is a change; a listener that throws never breaks the lock', async () => {
  for (const [probe, action] of [[async () => null, 'probe-failed-kept']]) {
    const lock = new HeavyJobLock({ limit: () => 1, now: () => NOW, setTimer: () => ({}), clearTimer: () => {}, roots: () => [{ agentId: 'a', pid: 1 }], probe, log: () => {} });
    let n = 0;
    lock.onChange(() => { throw new Error('display'); });
    lock.onChange(() => { n++; });
    lock.acquire('a', SUITE, 'npm test', 'c1', false);
    assert.equal(n, 1);
    lock.callDone('a', 'c1');
    await new Promise((r) => setImmediate(r));
    assert.equal(n, 2, action);
    assert.equal(lock.snapshot()[0].background, true);
  }
});

test('T2 onChange: switching the limit off clears the queue and the reservations once', () => {
  let limit = 1;
  const lock = new HeavyJobLock({ limit: () => limit, now: () => NOW, setTimer: () => ({}), clearTimer: () => {}, log: () => {} });
  let n = 0;
  lock.acquire('a', SUITE, 'npm test', 'c1', true);
  lock.acquire('b', SUITE, 'npm test', 'c2', false);
  lock.onChange(() => { n++; });
  limit = 'off';
  lock.release('a', 'process-exit');
  assert.equal(n, 2, 'release + the off clear');
  assert.deepEqual(lock.queueSnapshot(), { waiters: [], reserved: [] });
});

// ─── T3: the wake path never sees the overlay ───────────────────────────────────────────

test('T3 a queued agent is still woken by HEAVY SLOT FREE, and the overlay never reaches the wake lifecycle', () => {
  const { lock, notified } = fakeLock();
  lock.acquire('a', SUITE, 'npm test &', 'c1', true);
  lock.acquire('q', SUITE, 'npm test', 'c2', false);
  assert.equal(ACT.activityStatus('idle', lv('IDLE', { agentId: 'q' }), ACT.heavyActivity('q', view(lock))), 'waiting', 'shown waiting while queued');
  lock.release('a', 'process-exit');
  assert.equal(notified.length, 1);
  assert.equal(notified[0][0], 'q');
  const n = heavySlotFreeNotice(...notified[0]);
  assert.equal(n.message.wake, 'now');
  assert.equal(n.from, 'system');
  // The wake owner reads its own lifecycle; nothing of the lock or the display reaches it.
  const wake = readSource('src/main/workerWake.ts');
  assert.doesNotMatch(wake, /activityView|heavyActivity|heavyLock|HeavyLockView|activityStatus/);
  // GTC M4: the one bypass is `atStop`, the Stop hook in hand (the provider's own turn end), set
  // only by claimAtStop; it is no lock or display input either.
  assert.match(wake, /if \(mode === 'event'\) \{\s*(?:\/\/[^\n]*\n\s*)*if \(!atStop && r\.lifecycle !== 'idle'\) return no\(`lifecycle-\$\{r\.lifecycle\}`\);/);
  assert.match(wake, /claim\(f: WorkerWakeFacts, cause: WakeCause, mode: WakeMode, now = Date\.now\(\), atStop = false\): WakeClaim \| null \{/);
  assert.deepEqual(wake.match(/this\.claim\([^)]*\)/g).filter((c) => /,\s*true\)$/.test(c)), ["this.claim(f, 'hook', 'event', now, true)"], 'atStop is set only by claimAtStop');
  assert.match(wake, /claimAtStop\(f: WorkerWakeFacts, now = Date\.now\(\)\): WakeClaim \| null \{\s*(?:\/\/[^\n]*\n\s*)*return this\.claim\(f, 'hook', 'event', now, true\);/);
  assert.match(readSource('src/main/inboxWakeBridge.ts'), /const claim = coordinator\.claim\(\s*f \? [^\n]*\n\s*cause, mode, now\);/, 'the typed wake never passes atStop');
  assert.match(wake, /if \(!\(r\.lifecycle === 'idle' \|\| \(r\.lifecycle === 'unknown' && quiescent\)\)\) \{/);
  // Nor the liveness classifier (LIVENESS-V1 is frozen).
  for (const f of ['src/shared/livenessV1.ts', 'src/main/agentLiveness.ts']) {
    if (!fs.existsSync(path.join(__dirname, '..', f))) continue;
    assert.doesNotMatch(readSource(f), /heavyActivity|HeavyLockView|heavy-lock:changed/, f);
  }
  // Main pushes the view to the renderer only; the notify path is the lock's own.
  const idx = readSource('src/main/index.ts');
  assert.match(idx, /notify: \(agentId, kind, until\) => notifyHeavySlotFree\(agentId, kind, until\)/);
  assert.match(idx, /heavyLock\.onChange\(\(\) => \{\s*if \(heavyLockPush\) return;\s*heavyLockPush = setTimeout\(\(\) => \{\s*heavyLockPush = null;\s*try \{ liveWebContents\(\)\?\.send\('heavy-lock:changed', heavyLockView\(\)\); \}/);
  assert.match(idx, /ipcMain\.handle\('heavy-lock:snapshot', \(\) => heavyLockView\(\)\);/);
});

// ─── T4: the LIVE ROSTER line and fleet.json ────────────────────────────────────────────

async function rosterWith(heavyLock) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-idle-187-'));
  const hive = new HiveManager(() => home);
  try {
    for (const id of ['andy', 'jim', 'creed', 'dwight']) await hive.ensureAgent({ id, name: id, provider: 'claude', cwd: home });
    const now = Date.now();
    hive.writeFleetSnapshot({
      ts: now,
      agents: ['andy', 'jim', 'creed', 'dwight'].map((id) => ({ id, name: id, role: 'agent', lastActiveSecAgo: 60 })),
      ...(heavyLock ? { heavyLock: heavyLock(now) } : {}),
      liveness: ['andy', 'jim', 'creed', 'dwight'].map((id) => ({ ...lv('IDLE'), agentId: id, classifiedSince: now - 9 * MIN, evidence: { sampledAt: now } }))
    });
    return hive.rosterContext();
  } finally { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); }
}

test('T4 the LIVE ROSTER says BACKGROUND / QUEUED #n / RESERVED from fleet.json\'s heavyLock, and idle without it', async () => {
  const lock = (now) => ({
    limit: 1,
    holders: [{ agentId: 'andy', kind: 'suite', command: 'npm test', since: iso(now - 3 * MIN), heldMs: 3 * MIN, background: true, openCalls: 0, seenRunning: true, lastProbe: 'ok' }],
    waiters: [{ agentId: 'jim', kind: 'suite', since: iso(now - 4 * MIN), position: 1 }],
    reserved: [{ agentId: 'creed', kind: 'suite', until: '2026-10-15T06:26:19.494Z' }]
  });
  const line = await rosterWith(lock);
  assert.match(line, /andy "andy" \(agent, BACKGROUND suite 3m, active/);
  assert.match(line, /jim "jim" \(agent, QUEUED heavy #1 4m, active/);
  assert.match(line, /creed "creed" \(agent, RESERVED to 06:26Z, active/);
  assert.match(line, /dwight "dwight" \(agent, idle 9m, active/);
  const plain = await rosterWith(null);
  for (const id of ['andy', 'jim', 'creed', 'dwight']) assert.match(plain, new RegExp(`${id} "${id}" \\(agent, idle 9m, active`), 'no heavyLock: today\'s line');
  // A foreground holder is WORKING by its own liveness; the lock adds nothing.
  const fg = await rosterWith((now) => ({ limit: 1, holders: [{ agentId: 'andy', kind: 'suite', since: iso(now), background: false }], waiters: [], reserved: [] }));
  assert.match(fg, /andy "andy" \(agent, idle 9m, active/);
});

test('T4 fleet.json gives each agent its place in the lock (the per-agent heavy field)', () => {
  assert.deepEqual(ACT.heavyFleetField({ state: 'background', kind: 'suite', since: NOW }), { state: 'background', kind: 'suite', since: iso(NOW) });
  assert.deepEqual(ACT.heavyFleetField({ state: 'queued', kind: 'suite', position: 2, since: NOW }), { state: 'queued', kind: 'suite', position: 2, since: iso(NOW) });
  assert.deepEqual(ACT.heavyFleetField({ state: 'reserved', kind: 'build', until: NOW }), { state: 'reserved', kind: 'build', until: iso(NOW) });
  assert.equal(ACT.heavyFleetField(null), null);
  const idx = readSource('src/main/index.ts');
  assert.match(idx, /const lockView = heavyLockView\(\);/);
  assert.match(idx, /heavy: heavyFleetField\(heavyActivity\(id, lockView\)\),/);
  assert.match(idx, /function heavyLockView\(\): HeavyLockView \{\s*return \{ holders: heavyLock\.snapshot\(\), \.\.\.heavyLock\.queueSnapshot\(\) \};\s*\}/);
  const hive = readSource('src/main/hive.ts');
  assert.match(hive, /const state = rosterActivity\(lvById\.get\(a\.id\), nowMs, a\.runningTool, heavyActivity\(a\.id, snap\.heavyLock\)\);/);
});

// ─── T5: the office floor and the cards ─────────────────────────────────────────────────

test('T5 the office floor: background at the desk working, queued at the desk waiting (no coffee run), a lock-only change resyncs', () => {
  const floor = readSource('src/renderer/src/scene/office/OfficeFloor.tsx');
  assert.match(floor, /const \{ liveness, heavyLock \} = useStore\.getState\(\);\s*const rec = liveness\[agent\.id\];\s*const turn = activityStatus\(agent\.status, rec\);\s*const heavy = heavyActivity\(agent\.id, heavyLock\);\s*const status = activityStatus\(agent\.status, rec, heavy\);\s*if \(status !== turn\) return \{ \.\.\.agent, status, action: heavyText\(heavy\) \?\? agent\.action \};/);
  assert.match(floor, /if \(s\.agents !== prev\.agents \|\| s\.liveness !== prev\.liveness \|\| s\.heavyLock !== prev\.heavyLock\) syncAgents\(\);/, 'a lock-only change repaints the floor');
  assert.match(floor, /if \(rt && cafeEligible\(shownAgent\(agent\), rt\)\) candidates\.push/, 'the café picks by the shown status');
  assert.match(floor, /if \(r && breakEligible\(shownAgent\(a\), r\)\) candidates\.push/, 'errands too');
  assert.match(floor, /const god = godHook \? shownAgent\(godHook\) : undefined;/, 'and the boss\'s errands');
  // 'working' sits at the desk focused; 'waiting' sits at the desk, not focused, not at the door.
  assert.match(floor, /case 'working':\s*case 'thinking':\s*c\.setStatusGlyph\('none'\);\s*c\.sitAtDesk\(true\);/);
  assert.match(floor, /case 'waiting':[\s\S]{0,300}?c\.sitAtDesk\(false\);\s*c\.showThought\(liveActivity\(agent, 'waiting'\), agent\.carrying\);/);
  // The eligibility rule itself: a shown 'working'/'waiting' agent is never picked for a break.
  const { breakEligible, cafeEligible } = loadTs('src/renderer/src/scene/office/coffeeGap.ts');
  const rt = { character: { isSitting: () => false } };
  for (const status of ['working', 'waiting']) {
    assert.equal(breakEligible({ status }, rt), false, status);
    assert.equal(cafeEligible({ status }, rt), false, status);
  }
  assert.equal(cafeEligible({ status: 'idle' }, rt), true);
});

// The real useActivity hook, run outside a renderer: 'react' and '@/store/store' point at two tiny
// stubs (Jim's audit probe, adopted), so its logic runs on a settable store state. react-dom/server
// does not do here: zustand's server snapshot is the INITIAL state, so no overlay would ever show.
function loadUseActivity() {
  const rel = 'src/renderer/src/components/useActivity.ts';
  const src = readSource(rel)
    .replace("from 'react'", `from ${JSON.stringify(path.join(__dirname, 'idle-187-fake-react.cjs'))}`)
    .replace("from '@/store/store'", `from ${JSON.stringify(path.join(__dirname, 'idle-187-fake-store.cjs'))}`);
  return loadTs.fromText(rel, src).useActivity;
}
const fakeStore = require('./idle-187-fake-store.cjs');

test('T5 the cards: the real useActivity overlays the lock on a LIVE IDLE agent and gives the lock line as its tool text', () => {
  const useActivity = loadUseActivity();
  const now = Date.now();
  const idleRec = (id) => ({ ...lv('IDLE'), agentId: id, classifiedSince: now - MIN });
  fakeStore.setState({
    agents: [{ id: 'tool', runningTools: [{ name: 'Bash', since: now - 2 * MIN }] }],
    liveness: { bg: idleRec('bg'), q: idleRec('q'), r: idleRec('r'), plain: idleRec('plain'), busy: { ...lv('BUSY_PROGRESSING'), agentId: 'busy' }, tool: { ...lv('BUSY_PROGRESSING'), agentId: 'tool' }, crashed: { ...lv('CRASHED'), agentId: 'crashed' } },
    heavyLock: {
      holders: [{ agentId: 'bg', kind: 'suite', since: iso(now - 3 * MIN), background: true }],
      waiters: [
        { agentId: 'q', kind: 'suite', since: iso(now - 4 * MIN), position: 2 },
        { agentId: 'busy', kind: 'suite', since: iso(now), position: 3 },
        { agentId: 'tool', kind: 'suite', since: iso(now), position: 4 },
        { agentId: 'crashed', kind: 'suite', since: iso(now), position: 5 }
      ],
      reserved: [{ agentId: 'r', kind: 'suite', until: '2026-10-15T06:26:00.000Z' }]
    }
  });
  const bg = useActivity('bg', 'idle'), q = useActivity('q', 'idle'), r = useActivity('r', 'idle'), p = useActivity('plain', 'idle');
  assert.deepEqual([bg.status, bg.turnStatus], ['working', 'idle']);
  assert.match(bg.toolText, /^suite in background 3m/);
  assert.deepEqual([q.status, q.turnStatus], ['waiting', 'idle']);
  assert.match(q.toolText, /^queued for heavy slot #2 \(4m\)/);
  assert.deepEqual([r.status, r.turnStatus, r.toolText], ['waiting', 'idle', 'heavy slot reserved until 06:26Z']);
  assert.deepEqual([p.status, p.turnStatus, p.toolText], ['idle', 'idle', null]);
  // WORKING beats the lock, and its running tool is the line; a crashed agent is never overlaid.
  assert.deepEqual([useActivity('busy', 'idle').status, useActivity('busy', 'idle').toolText], ['working', null]);
  assert.match(useActivity('tool', 'working').toolText, /^using Bash for 2m/);
  assert.deepEqual([useActivity('crashed', 'idle').status, useActivity('crashed', 'idle').toolText], ['idle', null]);
  // A tool still listed as running on an overlaid agent is named first (the hook's own fact), as for any busy card.
  fakeStore.setState({ agents: [{ id: 'bg', runningTools: [{ name: 'Bash', since: now - MIN }] }] });
  assert.match(useActivity('bg', 'idle').toolText, /^using Bash for 1m/);
  fakeStore.setState({ agents: [] });
  fakeStore.setState({ heavyLock: null });
  assert.deepEqual([useActivity('bg', 'idle').status, useActivity('bg', 'idle').toolText], ['idle', null], 'no lock view: plain idle again');
  // The hook's age refresh cannot run outside a renderer (useEffect is stubbed): this one stays a pin.
  assert.match(readSource('src/renderer/src/components/useActivity.ts'), /const ticking = !!tool \|\| !!heavy;/, 'the age ticks while a lock line shows');
});

test('T5 the store takes the pushed view; a boot snapshot that lands after a push is dropped (applySnapshotUnlessPushed)', () => {
  const { applySnapshotUnlessPushed } = loadTs('src/shared/snapshotSync.ts');
  const run = (steps) => {
    const shown = [];
    const sync = applySnapshotUnlessPushed((v) => shown.push(v));
    for (const [op, v] of steps) sync[op](v);
    return shown;
  };
  assert.deepEqual(run([['snapshot', 'boot'], ['push', 'p1'], ['push', 'p2']]), ['boot', 'p1', 'p2'], 'the snapshot first, then every push');
  assert.deepEqual(run([['push', 'p1'], ['snapshot', 'stale boot']]), ['p1'], 'a reply that lands after a push is older: dropped');
  assert.deepEqual(run([['push', 'p1'], ['snapshot', 'stale boot'], ['push', 'p2']]), ['p1', 'p2']);
  assert.deepEqual(run([['dispose'], ['snapshot', 'boot']]), [], 'a reply after unmount is dropped');
  assert.deepEqual(run([]), []);
  const hive = readSource('src/renderer/src/hooks/useHive.ts');
  assert.match(hive, /const sync = applySnapshotUnlessPushed<HeavyLockView>\(\(view\) => useStore\.getState\(\)\.applyHeavyLock\(view\)\);\s*void window\.cth\.heavyLockSnapshot\(\)\s*\.then\(sync\.snapshot\)/);
  assert.match(hive, /const off = window\.cth\.onHeavyLockChange\(sync\.push\);\s*return \(\) => \{ sync\.dispose\(\); off\(\); \};/);
  const store = readSource('src/renderer/src/store/store.ts');
  assert.match(store, /applyHeavyLock: \(view\) => set\(\{ heavyLock: view && typeof view === 'object' \? view : null \}\),/);
  const pre = readSource('src/preload/index.ts');
  assert.match(pre, /heavyLockSnapshot: \(\): Promise<HeavyLockView> => ipcRenderer\.invoke\('heavy-lock:snapshot'\),/);
  assert.match(pre, /ipcRenderer\.on\('heavy-lock:changed', listener\);\s*return \(\) => ipcRenderer\.removeListener\('heavy-lock:changed', listener\);/);
});

// ─── T6: the composer's send-now is unchanged ───────────────────────────────────────────

test('T6 composer send-now follows the turn, not the overlay: a background or queued agent still takes a message at once', () => {
  const composer = readSource('src/renderer/src/components/MessageQueueComposer.tsx');
  assert.match(composer, /const shownIdle = useActivity\(agent\.id, agent\.status\)\.turnStatus === 'idle';/);
  assert.doesNotMatch(composer, /useActivity\([^)]*\)\.status === 'idle'/);
  // By value, from the real hook: what the composer reads is idle for each place in the lock.
  const useActivity = loadUseActivity();
  const now = Date.now();
  fakeStore.setState({
    agents: [],
    liveness: Object.fromEntries(['bg', 'q', 'r'].map((id) => [id, { ...lv('IDLE'), agentId: id }])),
    heavyLock: {
      holders: [{ agentId: 'bg', kind: 'suite', since: iso(now), background: true }],
      waiters: [{ agentId: 'q', kind: 'suite', since: iso(now), position: 1 }],
      reserved: [{ agentId: 'r', kind: 'suite', until: iso(now + MIN) }]
    }
  });
  for (const id of ['bg', 'q', 'r']) {
    const a = useActivity(id, 'idle');
    assert.equal(a.turnStatus, 'idle', `${id}: send-now`);
    assert.notEqual(a.status, 'idle', `${id}: the card is overlaid`);
  }
  fakeStore.setState({ liveness: { bg: { ...lv('BUSY_PROGRESSING'), agentId: 'bg' } } });
  assert.equal(useActivity('bg', 'working').turnStatus, 'working', 'an open turn queues, as before');
});

// ─── T7: a replay of the lock's log, 2026-10-15 05:52-06:35Z ────────────────────────────

/** The INPUTS behind the log's heavy-lock rows (hive log.jsonl; the reserves are the lock's own
 *  output and are checked, not fed). acquire = a heavy PreToolUse (fg/bg), deny = a heavy
 *  PreToolUse that was denied, reenter = another heavy call, release = the job ended. */
const REPLAY = [
  ['05:52:56.125', 'acquire', 'jim', 'fg'], ['05:53:01.773', 'release', 'jim'],
  ['05:54:12.456', 'acquire', 'dwight', 'bg'],
  ['05:56:34.467', 'deny', 'andy'], ['05:56:38.509', 'deny', 'andy'], ['05:57:27.913', 'deny', 'jim'],
  ['05:58:03.684', 'release', 'dwight'],
  ['05:58:06.791', 'acquire', 'andy', 'bg'],
  ['05:59:31.205', 'deny', 'creed'], ['06:01:49.122', 'deny', 'dwight'],
  ['06:01:56.859', 'release', 'andy'],
  ['06:02:01.442', 'acquire', 'jim', 'bg'],
  ['06:05:50.540', 'release', 'jim'],
  ['06:05:53.765', 'acquire', 'creed', 'fg'],
  ['06:07:28.180', 'deny', 'andy'], ['06:07:32.794', 'deny', 'andy'],
  ['06:09:03.345', 'release', 'creed'],
  ['06:10:04.831', 'acquire', 'dwight', 'bg'],
  ['06:10:45.539', 'deny', 'jim'], ['06:13:02.727', 'deny', 'creed'], ['06:13:43.461', 'deny', 'jim'],
  ['06:13:52.962', 'release', 'dwight'],
  ['06:14:08.440', 'acquire', 'andy', 'bg'], ['06:17:41.066', 'reenter', 'andy'],
  ['06:21:23.849', 'release', 'andy'],
  ['06:21:28.328', 'acquire', 'jim', 'bg'],
  ['06:22:14.089', 'deny', 'andy'], ['06:24:45.630', 'deny', 'dwight'],
  ['06:25:19.494', 'release', 'jim'],
  ['06:28:31.070', 'acquire', 'creed', 'fg'],
  ['06:31:41.982', 'release', 'creed'],
  ['06:31:45.681', 'acquire', 'andy', 'bg'], ['06:35:03.497', 'reenter', 'andy']
];
/** The log's own rows for that window, in order (degraded rows left out): what the replay must produce. */
const LOGGED = [
  'acquire jim', 'release jim', 'acquire dwight', 'deny andy 1', 'deny andy 1', 'deny jim 2', 'release dwight', 'reserve andy',
  'acquire andy', 'deny creed 2', 'deny dwight 3', 'release andy', 'reserve jim', 'acquire jim', 'release jim', 'reserve creed',
  'acquire creed', 'deny andy 2', 'deny andy 2', 'release creed', 'reserve dwight', 'acquire dwight', 'deny jim 2', 'deny creed 3',
  'deny jim 2', 'release dwight', 'reserve andy', 'acquire andy', 'reenter andy', 'release andy', 'reserve jim', 'acquire jim',
  'deny andy 2', 'deny dwight 3', 'release jim', 'reserve creed', 'acquire creed', 'release creed', 'reserve andy', 'acquire andy',
  'reenter andy'
];

test('T7 replaying 05:52-06:35Z: no plain-idle stretch between a background acquire and its release, or between a deny and its slot', () => {
  const at = (hms) => Date.parse(`2026-10-15T${hms}Z`);
  const { lock, clock, rows } = fakeLock({ t: at('05:52:00.000') });
  const pushes = [];
  lock.onChange(() => pushes.push(clock.t));
  const AGENTS = ['andy', 'jim', 'creed', 'dwight'];
  const idleRec = (id) => ({ ...lv('IDLE'), agentId: id, classifiedSince: at('05:52:00.000') });
  // Every agent's turn is closed between its own heavy calls (liveness IDLE): the case that read
  // as plain idle. Sample each agent after every event; a sample stands for the stretch up to the next.
  const before = { idle: 0, overlaid: 0 };
  const spans = [];   // [agent, from, to, want]
  const open = new Map();
  const shownAt = [];
  let call = 0;
  const calls = new Map();
  for (const [hms, op, id, mode] of REPLAY) {
    clock.t = at(hms);
    if (op === 'acquire' || op === 'reenter') {
      const c = `c${call++}`;
      const d = lock.acquire(id, SUITE, 'npm test', c, mode === 'bg' || (op === 'reenter'));
      assert.equal(d.allow, true, `${hms} ${op} ${id}`);
      if (!calls.has(id)) calls.set(id, []);
      calls.get(id).push(c);
      // An acquire ends the agent's wait (deny .. reserve .. acquire); a re-entry continues its job.
      if (open.get(id)?.want === 'waiting') { spans.push([id, open.get(id).from, clock.t, 'waiting']); open.delete(id); }
      if (op === 'acquire' && mode === 'bg') open.set(id, { from: clock.t, want: 'working' });
    } else if (op === 'deny') {
      assert.equal(lock.acquire(id, SUITE, 'npm test', `d${call++}`, false).allow, false, `${hms} deny ${id}`);
      if (!open.has(id)) open.set(id, { from: clock.t, want: 'waiting' });
    } else {
      const h = lock.snapshot().find((x) => x.agentId === id);
      assert.ok(h, `${hms} release ${id}: it holds`);
      if (h.background) lock.release(id, 'process-exit');
      else for (const c of calls.get(id)) lock.callDone(id, c);
      calls.delete(id);
      if (open.has(id)) { const o = open.get(id); spans.push([id, o.from, clock.t, o.want]); open.delete(id); }
    }
    const v = view(lock);
    for (const id of AGENTS) {
      const shown = ACT.activityStatus('idle', idleRec(id), ACT.heavyActivity(id, v));
      shownAt.push([id, clock.t, shown]);
      if (ACT.activityStatus('idle', idleRec(id)) === 'idle' && shown !== 'idle') before.overlaid++;
    }
  }
  // The replay is the log: same actions, same agents, same queue positions.
  const got = rows.map((r) => [r.action, r.agentId, r.action === 'deny' ? r.position : null].filter((x) => x != null).join(' '));
  assert.deepEqual(got, LOGGED);
  // 6 background jobs that ended in the window, 8 waits that reached their slot.
  assert.equal(spans.filter((s) => s[3] === 'working').length, 6);
  assert.equal(spans.filter((s) => s[3] === 'waiting').length, 8);
  // Within each span every sample is the span's state (never plain idle).
  let plainIdle = 0;
  for (const [id, from, to, want] of spans) {
    for (const [sid, t, shown] of shownAt) {
      if (sid !== id || t < from || t >= to) continue;
      if (shown === 'idle') plainIdle++;
      // A deny's span runs through its reservation; a background span is 'working'.
      assert.equal(shown, want === 'working' ? 'working' : 'waiting', `${id} at ${iso(t)} in its ${want} span`);
    }
  }
  assert.equal(plainIdle, 0, 'zero plain-idle intervals');
  assert.ok(before.overlaid > 40, `without the overlay, ${before.overlaid} of these samples read plain idle`);
  // The open background job at 06:35 (andy) is shown working, with its roster word.
  const v = view(lock);
  assert.equal(ACT.rosterActivity(idleRec('andy'), at('06:35:30.000'), null, ACT.heavyActivity('andy', v)), 'BACKGROUND suite 3m');
  // And main heard of every change: one push per acquire/deny/reserve/release (the reenters are
  // background-to-background and add none).
  assert.equal(pushes.length, rows.filter((r) => r.action !== 'reenter').length);
});
