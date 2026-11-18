'use strict';
require('./tools/own-job.cjs');

/**
 * QUOTA-BACKOFF (A11). Done-test (ROADMAP-108-SCOPE): a quota-hit agent shows "waiting until
 * <reset>", is not woken, and resumes by itself.
 *
 * The live case is Dwight, 10-24. His Codex rollout ended with these 3 lines (copied from the
 * real rollout; only the token_count `info` usage block is trimmed):
 *   ordinal 9324  token_count, `codex` rate_limits: primary 100% (300 min), resets_at 07:51:10Z,
 *                 rate_limit_reached_type null
 *   ordinal 9325  token_count, `premium` rate_limits with no windows
 *   ordinal 9326  task_complete, last_agent_message null, error usage_limit_exceeded
 *                 ("... or try again at 9:51 AM")
 * Codex sends no Stop for that turn (no assistant message), and capacity was read from the
 * rollout only on hooks, so nothing ingested it. The turn stayed active with no mail waiting,
 * so it was never closed, and the floor showed WORKING and then SILENT.
 *
 *   Q1 (a) the usage_limit_exceeded completion is hard evidence: the pool is LIMITED (not
 *          RESERVE_ONLY), and its reset is the exhausted window's resets_at (07:51:10Z).
 *   Q2 (b) capacity is followed on the beat without hooks: an async follower that reads only
 *          the bytes appended since its stored offset, and the bridge beat polls it for an
 *          active Codex agent.
 *   Q3 (c) an active Codex agent whose pool refuses, with no mail waiting, has its turn closed
 *          by the rollout's task_complete (so it is not WORKING / SILENT).
 *   Q4 (c) the impact text says "waiting until <reset>".
 *   Q5 (d) it is not woken before the reset, and it resumes by itself after it. The re-offer on a
 *          capacity change is the existing path (inbox-wake-bridge C3, and its index wiring pin).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { CodexRolloutCapacitySource } = loadTs('src/main/codexRolloutCapacity.ts');
const { ProviderCapacityTracker, L0_SEM_POLICY } = loadTs('src/main/providerCapacityTracker.ts');
const { CapacityAdmission } = loadTs('src/main/capacityAdmission.ts');
const { WorkerWakeWatchdog, WORKER_WAKE_IDLE_MS } = loadTs('src/main/workerWake.ts');
const { InboxWakeBridge } = loadTs('src/main/inboxWakeBridge.ts');
const { agentImpactOf } = loadTs('src/shared/deliveryHold.ts');

/** The follower module is new with this card; until then every Q2 test reports why. */
function loadFollower() {
  try { return loadTs('src/main/codexCapacityFollower.ts'); } catch (e) { return { missing: String(e && e.message || e) }; }
}

const A = 'dwight';
const TURN = '01a16cca-cd2d-76e0-88bd-cb1300f5b51e';
const RESET = Date.parse('2026-10-24T07:51:10Z');          // resets_at 1792828270
const HIT = Date.parse('2026-10-24T07:23:42.835Z');
const SNAPSHOT_AT = Date.parse('2026-10-24T07:23:42.680Z');

const L_CODEX = JSON.stringify({
  timestamp: '2026-10-24T07:23:42.680Z', ordinal: 9324, type: 'event_msg',
  payload: {
    type: 'token_count', info: null,
    rate_limits: {
      limit_id: 'codex', limit_name: null,
      primary: { used_percent: 100.0, window_minutes: 300, resets_at: 1792828270 },
      secondary: { used_percent: 22.0, window_minutes: 10080, resets_at: 1793384985 },
      credits: { has_credits: false, unlimited: false, balance: '0' },
      individual_limit: null, spend_control_reached: null, plan_type: 'plus', rate_limit_reached_type: null
    }
  }
});
const L_PREMIUM = JSON.stringify({
  timestamp: '2026-10-24T07:23:42.831Z', ordinal: 9325, type: 'event_msg',
  payload: {
    type: 'token_count', info: null,
    rate_limits: {
      limit_id: 'premium', limit_name: null, primary: null, secondary: null, credits: null,
      individual_limit: null, spend_control_reached: null, plan_type: 'plus', rate_limit_reached_type: null
    }
  }
});
const L_HIT = JSON.stringify({
  timestamp: '2026-10-24T07:23:42.835Z', ordinal: 9326, type: 'event_msg',
  payload: {
    type: 'task_complete', turn_id: TURN, last_agent_message: null,
    error: {
      message: 'You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 9:51 AM.',
      codex_error_info: 'usage_limit_exceeded'
    },
    started_at: 1792826592, completed_at: 1792826622, duration_ms: 30273, time_to_first_token_ms: 2699
  }
});
const DWIGHT_TAIL = [L_CODEX, L_PREMIUM, L_HIT];

/** A Codex home with one rollout, as the rollout tests build it. */
function makeHome(t, lines) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'guppy-quota108-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, 'sessions', '2026', '10', '23');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-10-23T13-56-14-${'01a1689e-6aa4-7af2-b7ad-abcce2319dc2'}.jsonl`);
  fs.writeFileSync(file, lines.map((l) => l + '\n').join(''));
  return { home, file };
}

function capacityRig(start) {
  let now = start;
  let mono = 0;
  const tracker = new ProviderCapacityTracker(L0_SEM_POLICY, () => now, () => mono);
  const keys = {};
  const seam = new CapacityAdmission({ poolKeyForAgent: (id) => keys[id] ?? null, poolState: (key) => tracker.pool(key), now: () => now });
  return { tracker, seam, keys, set: (v) => { mono += Math.max(0, v - now); now = v; } };
}

/** Dwight's 3 lines, through the real rollout source, into the real tracker. */
function ingestDwight(t) {
  const { home } = makeHome(t, DWIGHT_TAIL);
  const source = new CodexRolloutCapacitySource(() => 'scope-x');
  const obs = source.observe(home, { now: HIT + 1_000 });
  assert.ok(obs, 'the rollout yields a capacity observation');
  const r = capacityRig(HIT + 1_000);
  r.keys[A] = obs.poolKey;
  r.tracker.ingest(obs);
  return { ...r, obs };
}

test('Q1 (a) Dwight\'s usage_limit_exceeded completion makes the pool LIMITED, reset 07:51:10Z', (t) => {
  const r = ingestDwight(t);
  const pool = r.tracker.pool(r.obs.poolKey);
  assert.equal(pool.state, 'LIMITED', `the provider refused the turn; got ${pool.state} (${pool.stateReason})`);
  assert.ok(r.obs.ordinaryUsageAllowed === false || r.obs.providerReachedType !== null,
    'the observation carries hard evidence (the usage_limit_exceeded error)');
  assert.equal(typeof r.tracker.limitedUntil, 'function', 'the tracker names the reset a LIMITED pool waits for');
  assert.equal(r.tracker.limitedUntil(r.obs.poolKey), RESET, 'the reset is the exhausted window\'s resets_at');
});

test('Q1b (a) a completion error is not evidence once a newer turn has started', (t) => {
  const started = JSON.stringify({ timestamp: '2026-10-24T07:52:00.000Z', ordinal: 9327, type: 'event_msg', payload: { type: 'task_started', turn_id: 'next', started_at: 1 } });
  const { home } = makeHome(t, [...DWIGHT_TAIL, started]);
  const obs = new CodexRolloutCapacitySource(() => 'scope-x').observe(home, { now: RESET + 60_000 });
  assert.ok(obs);
  assert.equal(obs.providerReachedType, null, 'a later task_started means the provider took a new turn');
  assert.notEqual(obs.ordinaryUsageAllowed, false);
});

test('Q2 (b) the follower is async and reads only the bytes appended since its offset', async (t) => {
  const F = loadFollower();
  assert.equal(F.missing, undefined, `src/main/codexCapacityFollower.ts: ${F.missing}`);
  const pad = JSON.stringify({ timestamp: '2026-10-24T07:00:00.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'x'.repeat(900) } });
  const lines = [];
  while (lines.length * (pad.length + 1) < 2 * 1024 * 1024) lines.push(pad);
  const { home, file } = makeHome(t, lines);
  const reads = [];
  const follower = new F.CodexCapacityFollower({
    scopeOf: () => 'scope-x',
    findRollout: () => file,
    stat: async (f) => { const s = await fs.promises.stat(f); return { size: s.size, mtimeMs: s.mtimeMs }; },
    read: async (f, position, length) => {
      reads.push({ position, length });
      const h = await fs.promises.open(f, 'r');
      try { const b = Buffer.alloc(length); const { bytesRead } = await h.read(b, 0, length, position); return b.subarray(0, bytesRead); } finally { await h.close(); }
    }
  });
  const sizeBefore = fs.statSync(file).size;
  const first = follower.poll(home);
  assert.ok(first && typeof first.then === 'function', 'poll is async (no synchronous read on the beat)');
  await first;
  const firstBytes = reads.reduce((n, r) => n + r.length, 0);
  assert.ok(firstBytes > 0 && firstBytes <= 256 * 1024, `the first poll reads a bounded tail, not the 2 MB file (read ${firstBytes})`);

  reads.length = 0;
  assert.equal(await follower.poll(home), null, 'nothing new: nothing to report');
  assert.equal(reads.reduce((n, r) => n + r.length, 0), 0, 'an unchanged file is not read');

  // The snapshot lands first, the error completion on a later beat: each poll reads only its own bytes.
  fs.appendFileSync(file, L_CODEX + '\n' + L_PREMIUM + '\n');
  const sizeMid = fs.statSync(file).size;
  reads.length = 0;
  await follower.poll(home);
  assert.deepEqual(reads.map((r) => r.position), [sizeBefore], 'read from the stored offset');
  assert.equal(reads.reduce((n, r) => n + r.length, 0), sizeMid - sizeBefore, 'exactly the appended bytes');

  fs.appendFileSync(file, L_HIT + '\n');
  reads.length = 0;
  const obs = await follower.poll(home);
  assert.equal(reads.reduce((n, r) => n + r.length, 0), fs.statSync(file).size - sizeMid, 'exactly the appended bytes');
  assert.ok(obs, 'the error completion is reported');
  assert.equal(obs.ordinaryUsageAllowed === false || obs.providerReachedType !== null, true, 'as hard evidence');
  assert.ok(obs.windows.some((w) => w.resetsAt === RESET), 'with the snapshot read on the earlier poll');
});

test('Q2b (b) a partial last line is not lost: the follower resumes at its start', async (t) => {
  const F = loadFollower();
  assert.equal(F.missing, undefined, `src/main/codexCapacityFollower.ts: ${F.missing}`);
  const { home, file } = makeHome(t, [L_CODEX, L_PREMIUM]);
  const follower = new F.CodexCapacityFollower({
    scopeOf: () => 'scope-x', findRollout: () => file,
    stat: async (f) => { const s = await fs.promises.stat(f); return { size: s.size, mtimeMs: s.mtimeMs }; },
    read: async (f, position, length) => { const b = fs.readFileSync(f); return b.subarray(position, position + length); }
  });
  await follower.poll(home);
  fs.appendFileSync(file, L_HIT.slice(0, 100));
  const mid = await follower.poll(home);
  assert.ok(mid === null || mid.providerReachedType === null, 'half a line is not evidence');
  fs.appendFileSync(file, L_HIT.slice(100) + '\n');
  const obs = await follower.poll(home);
  assert.ok(obs && (obs.ordinaryUsageAllowed === false || obs.providerReachedType !== null), 'the completed line is read whole');
});

const statOf = async (f) => { const s = await fs.promises.stat(f); return { size: s.size, mtimeMs: s.mtimeMs }; };
const readOf = (reads) => async (f, position, length) => { reads?.push({ position, length }); const b = fs.readFileSync(f); return b.subarray(position, position + length); };

test('Q2d (b) a rollout lookup that misses is not repeated every beat (Jim MUST 2: the walk is sync)', async () => {
  const F = loadFollower();
  assert.equal(F.missing, undefined, `src/main/codexCapacityFollower.ts: ${F.missing}`);
  const clock = { t: HIT };
  let finds = 0;
  const follower = new F.CodexCapacityFollower({
    scopeOf: () => 'scope-x', findRollout: () => { finds++; return null; },
    stat: statOf, read: readOf(), now: () => clock.t
  });
  await follower.poll('home-a', { sessionId: 's1' });
  await follower.poll('home-a', { sessionId: 's1' });
  assert.equal(finds, 1, 'two polls on a miss make one lookup');
  clock.t += F.FOLLOWER_MISS_RETRY_MS - 1;
  await follower.poll('home-a', { sessionId: 's1' });
  assert.equal(finds, 1, 'still inside the retry window');
  await follower.poll('home-a', { sessionId: 's2' });
  assert.equal(finds, 2, 'a new session is looked up at once');
  clock.t += F.FOLLOWER_MISS_RETRY_MS;
  await follower.poll('home-a', { sessionId: 's2' });
  assert.equal(finds, 3, 'after the window the lookup is retried');
});

test('Q2e (b) the account scope is resolved once per binding, not per poll (Jim SHOULD 1)', async (t) => {
  const F = loadFollower();
  assert.equal(F.missing, undefined, `src/main/codexCapacityFollower.ts: ${F.missing}`);
  const { home, file } = makeHome(t, [L_PREMIUM]);
  let scopes = 0;
  const follower = new F.CodexCapacityFollower({
    scopeOf: () => { scopes++; return 'scope-x'; }, findRollout: () => file, stat: statOf, read: readOf()
  });
  await follower.poll(home);
  fs.appendFileSync(file, L_CODEX + '\n');
  assert.ok(await follower.poll(home), 'the new snapshot is reported');
  fs.appendFileSync(file, L_HIT + '\n');
  assert.ok(await follower.poll(home), 'the hit is reported');
  assert.equal(scopes, 1);
});

test('Q2f (b) a gap longer than the read cap falls back to the bounded tail (Jim NIT 1)', async (t) => {
  const F = loadFollower();
  assert.equal(F.missing, undefined, `src/main/codexCapacityFollower.ts: ${F.missing}`);
  const { home, file } = makeHome(t, [L_PREMIUM]);
  const reads = [];
  const follower = new F.CodexCapacityFollower({ scopeOf: () => 'scope-x', findRollout: () => file, stat: statOf, read: readOf(reads) });
  await follower.poll(home);
  const pad = JSON.stringify({ timestamp: '2026-10-24T07:00:00.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'x'.repeat(900) } });
  const big = [];
  while (big.length * (pad.length + 1) < 2 * F.FOLLOWER_MAX_READ_BYTES) big.push(pad);
  fs.appendFileSync(file, big.join('\n') + '\n' + L_CODEX + '\n' + L_PREMIUM + '\n' + L_HIT + '\n');
  reads.length = 0;
  const obs = await follower.poll(home);
  const n = reads.reduce((s, r) => s + r.length, 0);
  assert.ok(n > 0 && n <= F.FOLLOWER_MAX_READ_BYTES, `one poll reads at most the cap (read ${n})`);
  assert.ok(obs && obs.providerReachedType !== null && obs.windows.some((w) => w.resetsAt === RESET), 'the tail still carries the hit and its snapshot');
});

/** The real coordinator + bridge, as falseactive-rollout builds it. */
function floor({ probe, refused = () => false }) {
  const coordinator = new WorkerWakeWatchdog();
  const submits = [];
  const polls = [];
  const now = { t: HIT + 60_000 };
  const bridge = new InboxWakeBridge({
    coordinator,
    inboxIds: () => [],
    facts: () => ({ ptyId: 'pty-dwight', lastOutputAt: now.t - WORKER_WAKE_IDLE_MS * 10, autoDeliveryPaused: false, paused: false, halted: false, inhibited: false }),
    submit: (req) => { submits.push(req); return Promise.resolve({ kind: 'COMMITTED' }); },
    text: (ids) => ids.join(','),
    setImmediate: (fn) => fn(),
    now: () => now.t,
    codexTurnProbe: () => probe.current,
    codexCapacityPoll: (agentId) => { polls.push(agentId); },
    capacityRefused: (agentId) => refused(agentId)
  });
  return { coordinator, bridge, submits, polls, now };
}

test('Q2c (b) the beat polls Codex capacity for an active agent that sends no hooks', () => {
  const f = floor({ probe: { current: { ok: true, latest: { kind: 'started', turnId: TURN, at: HIT - 30_000 } } } });
  f.bridge.onHook(A, 'UserPromptSubmit', undefined, undefined, TURN);
  // (the turn's Stop never comes: Codex sends none for a turn with no assistant message)
  f.bridge.reconcileAll([A]);
  assert.deepEqual(f.polls, [A], 'one capacity poll for the active agent on the beat');
});

test('Q3 (c) a quota-refused agent\'s turn is closed by its task_complete with no mail waiting', () => {
  const f = floor({ probe: { current: { ok: true, latest: { kind: 'complete', turnId: TURN, at: HIT } } }, refused: () => true });
  f.bridge.onHook(A, 'UserPromptSubmit', undefined, undefined, TURN);
  assert.equal(f.coordinator.state(A).lifecycle, 'active');
  f.bridge.reconcileAll([A]);
  assert.notEqual(f.coordinator.state(A).lifecycle, 'active', 'the provider ended the turn: it is not WORKING (and so not SILENT)');
  assert.equal(f.submits.length, 0, 'nothing is typed (no mail, and the pool refuses)');
});

test('Q3b (c) without a refusal, an active agent with no mail is still not probed (the cost guardrail)', () => {
  let calls = 0;
  const f = floor({ probe: { get current() { calls += 1; return { ok: true, latest: { kind: 'complete', turnId: TURN, at: HIT } }; } } });
  f.bridge.onHook(A, 'UserPromptSubmit', undefined, undefined, TURN);
  f.bridge.reconcileAll([A]);
  assert.equal(calls, 0);
  assert.equal(f.coordinator.state(A).lifecycle, 'active');
});

test('Q4 (c) the impact says "waiting until <reset>" for a LIMITED pool with a known reset', () => {
  const imp = agentImpactOf({
    interfered: false, autoDeliveryPaused: false, capacityHold: true, capacityEvidence: null,
    poolState: 'LIMITED', poolLabel: 'Codex', resetAt: RESET
  });
  assert.ok(imp);
  assert.equal(imp.kind, 'CAPACITY_LIMITED');
  assert.match(imp.text, /waiting until \d{1,2}:\d{2}/, `got "${imp.text}"`);
  const hh = new Date(RESET);
  const local = `${hh.getHours() % 12 || 12}:${String(hh.getMinutes()).padStart(2, '0')}`;
  assert.ok(imp.text.includes(local) || imp.text.includes(`${String(hh.getHours()).padStart(2, '0')}:${String(hh.getMinutes()).padStart(2, '0')}`),
    `the local reset time (${local}) is named: "${imp.text}"`);
});

test('Q5 (d) not woken before the reset; after it the pool recovers and the wake is admitted', (t) => {
  const r = ingestDwight(t);
  assert.equal(r.seam.admit(A, 'ORDINARY_TURN').verdict, 'REFUSE', 'not woken while LIMITED');
  r.set(RESET - 60_000);
  r.tracker.evaluate();
  assert.equal(r.seam.admit(A, 'ORDINARY_TURN').verdict, 'REFUSE', 'still not woken a minute before the reset');
  r.set(RESET + 1_000);
  r.tracker.evaluate();
  assert.equal(r.tracker.pool(r.obs.poolKey).state, 'RECOVERING', 'the reset passed: the pool recovers by itself');
  assert.equal(r.seam.admit(A, 'ORDINARY_TURN').verdict, 'ALLOW', 'the wake is admitted (one recovering grant)');
});

assert.ok(SNAPSHOT_AT < HIT);
