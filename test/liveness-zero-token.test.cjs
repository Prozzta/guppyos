'use strict';
/**
 * ZERO-TOKEN-LIVENESS: the zero-token proof (design slice 7, Jim L2) and the CODEX-STOP-MISSING
 * acceptance replay of turn 01a0f363 (fixtures/liveness-01a0f363.json, from the real rollout and
 * hive log).
 *
 * Metering alone is not proof: hidden condense calls write no ledger row (Jim TOKEN-PROOF-VERIFY
 * P3(c)). So every path that could spend a token is TRAPPED while a monitor method runs: the owner's
 * submit, a terminal write, any child_process spawn/exec (a provider CLI), the network (fetch, http,
 * https, net), and every export of hiddenClaude.ts and reflect.ts (the condense path). The WWR's own
 * re-offer goes through the existing owner (the bridge's submit) and is attributed to it, not to the
 * monitor. The monitor's module graph is pinned too: it can only reach the shared type and the wake
 * constants.
 *
 * Scenarios: L1 compaction without Stop (the replay, three ways), L2 a 30-min started rollout, L3
 * PTY traffic, L4 a 10-min stuck turn, L5 the cap of three, L6 an unexpected exit, L7 an expected
 * exit, L8 archive and delete.
 * Named mutant: M21 the monitor invokes condense / hiddenClaude (an import or a call) must die.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const ts = require('typescript');
const loadTs = require('./load-ts.cjs');

// ── The traps: installed BEFORE the monitor module is loaded. ─────────────────────────────────
const trap = { inMonitor: 0, hits: [] };
const hit = (what) => { if (trap.inMonitor > 0) trap.hits.push(what); };
for (const [mod, names, label] of [
  [cp, ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'], 'child_process'],
  [net, ['connect', 'createConnection'], 'net'],
  [http, ['request', 'get'], 'http'],
  [https, ['request', 'get'], 'https']
]) {
  for (const n of names) {
    const real = mod[n];
    mod[n] = function (...args) { hit(`${label}.${n}`); return real.apply(this, args); };
  }
}
const realFetch = globalThis.fetch;
globalThis.fetch = (...args) => { hit('fetch'); return realFetch(...args); };
// The condense path: every exported function of hiddenClaude.ts and reflect.ts.
for (const rel of ['src/main/hiddenClaude.ts', 'src/main/reflect.ts']) {
  const mod = loadTs(rel);
  for (const [k, v] of Object.entries(mod)) {
    if (typeof v === 'function' && !/^[A-Z]/.test(k)) mod[k] = function (...args) { hit(`${path.basename(rel)}:${k}`); return v.apply(this, args); };
  }
}

const { AgentLivenessMonitor } = loadTs('src/main/agentLiveness.ts');
const { WorkerWakeWatchdog, STUCK_ACTIVE_AFTER_MS, STUCK_ACTIVE_MAX_RECOVERIES } = loadTs('src/main/workerWake.ts');
const { InboxWakeBridge } = loadTs('src/main/inboxWakeBridge.ts');
const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'liveness-01a0f363.json'), 'utf8'));
const at = (iso) => Date.parse(iso);
const flush = () => new Promise((r) => setImmediate(r));

/** Every public monitor method runs with the traps armed. */
function armed(mon) {
  for (const k of ['sample', 'sampleAll', 'notePtyEnd', 'noteWakeRefusal', 'clearWakeRefusal', 'noteStuckWake', 'getLiveness', 'all', 'fleetRecords']) {
    const real = mon[k].bind(mon);
    mon[k] = (...args) => { trap.inMonitor += 1; try { return real(...args); } finally { trap.inMonitor -= 1; } };
  }
  return mon;
}

/**
 * A floor of one agent: the real coordinator, bridge (WWR) and monitor; a fake PTY; a scripted
 * Codex rollout; spies on the owner's submit and the terminal.
 */
function floor(agentId, { start, rollout = [], probeOk = true, spawnedAt = start - 3_600_000, provider = 'codex' } = {}) {
  const w = {
    now: start, inbox: [], submits: [], ptyWrites: [], rows: [], immediates: [], registry: { present: true, archived: false, archiveReason: undefined, onHold: false },
    pty: { ptyId: `pty-${agentId}`, incarnation: 1, spawnedAt, lastTrafficAt: 0 }, ptyAlive: true
  };
  const latest = () => {
    const seen = rollout.filter((e) => at(e.ts) <= w.now);
    const e = seen[seen.length - 1];
    return e ? { kind: e.type === 'task_complete' ? 'complete' : 'started', turnId: e.turnId, at: at(e.ts) } : null;
  };
  w.coordinator = new WorkerWakeWatchdog();
  w.monitor = armed(new AgentLivenessMonitor({
    agents: () => (w.registry.present ? [agentId] : []),
    facts: (id) => (id !== agentId || !w.registry.present ? null : {
      agentId,
      registry: { archived: w.registry.archived, ...(w.registry.archiveReason ? { archiveReason: w.registry.archiveReason } : {}), ...(w.registry.archived ? { archivedAt: w.now } : {}), onHold: w.registry.onHold },
      pty: w.ptyAlive ? { ...w.pty } : null,
      wake: w.coordinator.livenessFacts(agentId),
      control: { paused: false, halted: false, autoDeliveryPaused: false },
      mailWaiting: w.inbox.length,
      ...(provider === 'codex' && probeOk && w.ptyAlive ? { rollout: latest() } : {})
    }),
    sink: (row) => w.rows.push(row),
    now: () => w.now
  }));
  w.bridge = new InboxWakeBridge({
    coordinator: w.coordinator,
    inboxIds: () => [...w.inbox],
    facts: () => (w.ptyAlive ? { ptyId: w.pty.ptyId, lastOutputAt: w.pty.lastTrafficAt, autoDeliveryPaused: false, paused: false, halted: false, inhibited: false } : null),
    submit: (req) => { if (trap.inMonitor > 0) trap.hits.push('submit'); w.submits.push({ at: w.now, ids: req.text.split(',') }); return Promise.resolve({ kind: 'COMMITTED' }); },
    text: (ids) => ids.join(','),
    setImmediate: (fn) => w.immediates.push(fn),
    now: () => w.now,
    ...(provider === 'codex' ? { codexTurnProbe: () => (probeOk ? { ok: true, latest: latest() } : { ok: false, why: 'unreadable' }) } : {}),
    confirmsTurnStart: () => provider === 'codex',
    mail: {
      mode: () => 'inject',
      closeTurn: () => {}, abortSince: (id, since, reason) => w.bridge.onMailEpochClosed(id, 'abnormal', reason),
      closeStale: () => [], hasOpenEpoch: () => false, degrade: () => false, log: () => {}
    },
    liveness: { stuckWake: (id, reason) => { w.monitor.noteStuckWake(id, reason); } }
  });
  w.coordinator.noteSpawn(w.pty.ptyId, spawnedAt, agentId);
  w.drain = () => { while (w.immediates.length) w.immediates.shift()(); };
  w.hook = (event, turnId) => { w.bridge.onHook(agentId, event, undefined, undefined, turnId); w.drain(); w.monitor.sample(agentId); };
  w.deliver = (id) => { w.inbox.push(id); w.bridge.onDelivery(agentId, id); w.drain(); };
  w.beat = () => { w.bridge.reconcileAll([agentId]); w.drain(); w.monitor.sampleAll(); };
  w.cls = () => w.monitor.getLiveness(agentId)?.classification;
  return w;
}

/** Replay the fixture timeline with 15-s beats until `until`; returns the classification history. */
function replay(w, { until, hooks = FIX.hooks, beatEvery = 15_000, firstBeat }) {
  const events = [
    ...hooks.map((h) => ({ t: at(h.ts), run: () => w.hook(h.event, h.turnId) })),
    ...FIX.mail.map((m) => ({ t: at(m.ts), run: () => w.deliver(m.id) })),
    { t: at(FIX.ptyLastOutput), run: () => { w.pty.lastTrafficAt = at(FIX.ptyLastOutput); } }
  ];
  for (let t = firstBeat; t <= until; t += beatEvery) events.push({ t, run: () => w.beat() });
  events.sort((a, b) => a.t - b.t);
  const history = [];
  for (const e of events) {
    w.now = e.t;
    e.run();
    const c = w.cls();
    if (c && (!history.length || history[history.length - 1].c !== c)) history.push({ t: new Date(e.t).toISOString().slice(11, 23), c, reason: w.monitor.getLiveness(FIX.agentId).reason });
  }
  return history;
}

test('module graph (M21, import): the monitor can only reach the shared type and the wake constants', () => {
  const seen = new Set();
  const allowed = new Set(['src/main/agentLiveness.ts', 'src/shared/livenessV1.ts', 'src/main/workerWake.ts', 'src/main/wakeStall.ts']);
  const walk = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
    for (const imp of ts.preProcessFile(src, true, true).importedFiles.map((f) => f.fileName)) {
      if (imp.startsWith('.')) {
        const next = path.relative(path.join(__dirname, '..'), path.resolve(path.dirname(path.join(__dirname, '..', rel)), imp)).replace(/\\/g, '/') + '.ts';
        assert.ok(allowed.has(next), `${rel} imports ${imp} (${next}): not on the zero-token allowlist`);
        walk(next);
      } else {
        assert.ok(imp === 'node:crypto', `${rel} imports ${imp}: a package or builtin outside the allowlist`);
      }
    }
  };
  walk('src/main/agentLiveness.ts');
  assert.deepEqual([...seen].sort(), [...allowed].sort());
});

test('L1 (replay 01a0f363, as Codex 0.157.1 sent it): the compaction turn ends at PostCompact; the 17:36:43 mail is claimed at once', () => {
  trap.hits.length = 0;
  const w = floor(FIX.agentId, { start: at('2026-09-30T17:33:00Z'), rollout: FIX.rollout });
  const history = replay(w, { until: at('2026-09-30T17:42:30Z'), firstBeat: at('2026-09-30T17:33:05Z') });
  assert.equal(w.submits.length >= 1, true);
  assert.equal(new Date(w.submits[0].at).toISOString(), FIX.mail[0].ts, 'claimed on the delivery itself (1.1.75: refused as lifecycle-active)');
  assert.deepEqual(w.submits[0].ids, [FIX.mail[0].id]);
  assert.ok(!history.some((h) => h.c === 'STUCK_WAKE' || h.c === 'SUSPECT'), JSON.stringify(history));
  assert.ok(history.some((h) => h.c === 'BUSY_PROGRESSING'), 'busy while compacting');
  assert.deepEqual(trap.hits, [], 'zero provider calls, terminal writes, spawns, network or condense from the monitor');
});

test('L1 (replay 01a0f363, PostCompact LOST as on 1.1.75): the rollout proof closes the turn on the first beat with mail; re-offered long before the 17:41:43 stall row', () => {
  trap.hits.length = 0;
  const w = floor(FIX.agentId, { start: at('2026-09-30T17:33:00Z'), rollout: FIX.rollout });
  const hooks = FIX.hooks.filter((h) => h.event !== 'PostCompact');
  const history = replay(w, { until: at('2026-09-30T17:42:30Z'), hooks, firstBeat: at('2026-09-30T17:33:05Z') });
  assert.equal(w.submits.length >= 1, true, JSON.stringify(history));
  assert.ok(w.submits[0].at > at(FIX.mail[0].ts), 'the delivery itself was refused (lifecycle-active), as on 1.1.75');
  assert.ok(w.submits[0].at <= at(FIX.mail[0].ts) + 15_000, `re-offered by the next beat (${new Date(w.submits[0].at).toISOString()})`);
  assert.ok(w.submits[0].at < at(FIX.observed_1_1_75.stall.ts));
  assert.ok(!history.some((h) => h.c === 'STUCK_WAKE'), 'the provider proof closed it: nothing was stuck');
  assert.deepEqual(trap.hits, []);
});

test('L1 + L4 (replay 01a0f363, PostCompact lost AND the rollout unreadable): SUSPECT at 5 min, STUCK_WAKE recorded BEFORE the WWR recovers at 10 min, then re-offered', () => {
  trap.hits.length = 0;
  const w = floor(FIX.agentId, { start: at('2026-09-30T17:33:00Z'), rollout: FIX.rollout, probeOk: false });
  const lifecycleAtStuck = [];
  const realNote = w.monitor.noteStuckWake;
  w.monitor.noteStuckWake = (id, reason) => { lifecycleAtStuck.push(w.coordinator.state(id).lifecycle); return realNote(id, reason); };
  const hooks = FIX.hooks.filter((h) => h.event !== 'PostCompact');
  const history = replay(w, { until: at('2026-09-30T17:47:30Z'), hooks, firstBeat: at('2026-09-30T17:33:05Z') });
  const lastOut = at(FIX.ptyLastOutput);
  const suspect = history.find((h) => h.c === 'SUSPECT');
  const stuck = history.find((h) => h.c === 'STUCK_WAKE');
  assert.ok(suspect && stuck, JSON.stringify(history));
  assert.equal(suspect.reason, 'no-progress');
  assert.ok(at(`2026-09-30T${suspect.t}Z`) >= lastOut + 5 * 60_000 && at(`2026-09-30T${suspect.t}Z`) < lastOut + 5 * 60_000 + 15_000, `SUSPECT one beat after 5 quiet minutes (${suspect.t})`);
  assert.ok(at(`2026-09-30T${stuck.t}Z`) >= lastOut + STUCK_ACTIVE_AFTER_MS, `STUCK at the WWR window (${stuck.t})`);
  assert.deepEqual(lifecycleAtStuck, ['active'], 'recorded while the epoch was still active: before the recovery');
  const stuckRow = w.rows.findIndex((r) => r.classification === 'STUCK_WAKE');
  assert.ok(stuckRow >= 0 && w.rows[stuckRow].reason === 'wwr-recovering');
  assert.ok(w.submits.some((s) => s.at >= at(`2026-09-30T${stuck.t}Z`)), 'the WWR (the existing owner) re-offered the mail');
  assert.deepEqual(trap.hits, []);
});

test('L2: a 30-minute Codex turn whose rollout says task_started stays BUSY, never recovered, never stuck', () => {
  trap.hits.length = 0;
  const start = at('2026-10-01T10:00:00Z');
  const w = floor('codex-long', { start, rollout: [{ ts: '2026-10-01T10:00:01.000Z', type: 'task_started', turnId: 'long' }] });
  w.now = start + 1000; w.hook('UserPromptSubmit', 'long');
  w.now = start + 2000; w.pty.lastTrafficAt = w.now; w.deliver('m1');
  for (let i = 1; i <= 120; i++) { w.now = start + 2000 + i * 15_000; w.beat(); }
  assert.equal(w.cls(), 'BUSY_PROGRESSING');
  assert.equal(w.monitor.getLiveness('codex-long').reason, 'rollout-started');
  assert.equal(w.coordinator.state('codex-long').lifecycle, 'active');
  assert.equal(w.submits.length, 0);
  assert.ok(!w.rows.some((r) => r.classification === 'STUCK_WAKE' || r.classification === 'SUSPECT'));
  assert.deepEqual(trap.hits, []);
});

test('L3: live PTY output keeps a long Claude turn BUSY; SUSPECT only after 5 silent minutes, and that changes nothing', () => {
  trap.hits.length = 0;
  const start = at('2026-10-01T11:00:00Z');
  const w = floor('claude-a', { start, provider: 'claude' });
  w.now = start + 1000; w.hook('UserPromptSubmit');
  for (let i = 1; i <= 80; i++) { w.now = start + 1000 + i * 15_000; w.pty.lastTrafficAt = w.now - 3000; w.beat(); }
  assert.equal(w.cls(), 'BUSY_PROGRESSING');
  const quietFrom = w.now;
  for (let i = 1; i <= 21; i++) { w.now = quietFrom + i * 15_000; w.beat(); }
  assert.equal(w.cls(), 'SUSPECT');
  assert.equal(w.coordinator.state('claude-a').lifecycle, 'active', 'SUSPECT is diagnostic only');
  assert.equal(w.submits.length, 0);
  assert.deepEqual(trap.hits, []);
});

test('L5: the cap of three: the fourth stuck epoch is wwr-max-recoveries, Human-offered, never retried automatically', async () => {
  trap.hits.length = 0;
  const start = at('2026-10-01T12:00:00Z');
  const w = floor('claude-b', { start, provider: 'claude' });
  w.now = start + 1000; w.hook('UserPromptSubmit'); w.pty.lastTrafficAt = w.now; w.deliver('m1');
  for (let n = 0; n <= STUCK_ACTIVE_MAX_RECOVERIES; n++) {
    w.now += STUCK_ACTIVE_AFTER_MS; w.beat();
    await flush();
    if (n < STUCK_ACTIVE_MAX_RECOVERIES) { w.now += 15_000; w.beat(); await flush(); w.now += 1000; w.hook('UserPromptSubmit'); }
  }
  const rec = w.monitor.getLiveness('claude-b');
  assert.deepEqual([rec.classification, rec.reason], ['STUCK_WAKE', 'wwr-max-recoveries']);
  const submits = w.submits.length;
  for (let i = 0; i < 8; i++) { w.now += STUCK_ACTIVE_AFTER_MS; w.beat(); await flush(); }
  assert.equal(w.submits.length, submits, 'no automatic retry after the cap');
  assert.equal(w.monitor.getLiveness('claude-b').classification, 'STUCK_WAKE');
  assert.deepEqual(trap.hits, []);
});

test('L6 / L7: an unexpected exit is CRASHED, a requested one EXITED; nothing is restarted', () => {
  trap.hits.length = 0;
  for (const [explicit, want] of [[false, 'CRASHED'], [true, 'EXITED']]) {
    const start = at('2026-10-01T13:00:00Z');
    const w = floor(`exit-${want}`, { start, provider: 'claude' });
    w.now = start; w.monitor.sampleAll();
    w.now += 1000;
    w.monitor.notePtyEnd(`exit-${want}`, { ptyId: w.pty.ptyId, incarnation: 1, explicit, exitCode: explicit ? 1 : 0, at: w.now });
    w.ptyAlive = false; w.registry.archived = true; w.registry.archiveReason = explicit ? 'explicit' : 'pty-exit';
    w.now += 1000; w.monitor.sampleAll();
    const rec = w.monitor.getLiveness(`exit-${want}`);
    assert.deepEqual([rec.classification, rec.lifecycle, rec.archiveReason], [want, 'ARCHIVED', explicit ? 'explicit' : 'pty-exit']);
    assert.equal(w.submits.length, 0);
  }
  assert.deepEqual(trap.hits, []);
});

test('L8: archive (explicit, orphan) and delete are lifecycle edges only: no wake, no submit', () => {
  trap.hits.length = 0;
  const start = at('2026-10-01T14:00:00Z');
  const w = floor('arch', { start, provider: 'claude' });
  w.now = start; w.monitor.sampleAll();
  for (const reason of ['orphan', 'explicit']) {
    w.ptyAlive = false; w.registry.archived = true; w.registry.archiveReason = reason;
    w.now += 1000; w.monitor.sampleAll();
    assert.deepEqual([w.monitor.getLiveness('arch').lifecycle, w.monitor.getLiveness('arch').archiveReason], ['ARCHIVED', reason]);
  }
  w.registry.present = false;
  w.now += 1000; w.monitor.sampleAll();
  assert.equal(w.monitor.getLiveness('arch').lifecycle, 'DELETED');
  assert.equal(w.submits.length, 0);
  assert.deepEqual(trap.hits, []);
});

test('the traps work: a trapped call made inside a monitor method is recorded (the proof can fail)', () => {
  trap.hits.length = 0;
  const w = floor('t', { start: at('2026-10-01T15:00:00Z'), provider: 'claude' });
  w.monitor.onLivenessChange(() => { loadTs('src/main/hiddenClaude.ts').readEnvelope('', 's'); });
  w.monitor.sampleAll();
  assert.deepEqual(trap.hits, ['hiddenClaude.ts:readEnvelope']);
  trap.hits.length = 0;
});
