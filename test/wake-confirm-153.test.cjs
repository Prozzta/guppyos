'use strict';

/**
 * 1.1.53: ACTIVE NEEDS CONFIRMATION (Jim, WAKE-BUGS-152.md; god's rulings andywake + andyconfirm).
 *
 *  (1) AGY-FALSEACTIVE-STALL. A stale `running` tick after a Stop re-opened the epoch, and the
 *      idle ticks that followed were refused by the confirm grace and never re-read.
 *      (a) Stop is terminal proof: a `running` reading inside STOP_SETTLE_MS of it opens
 *          nothing unless a turn start came after the Stop; PreInvocation is a turn start.
 *      (b) A grace-refused idle is deferred to the next beat after the grace, not dropped.
 *  (2) CODEX-FALSEACTIVE-153. Our COMMITTED opened an epoch Codex never started a turn for.
 *      For a provider that reports turn starts the epoch is provisional; unconfirmed for
 *      SUBMIT_CONFIRM_MS: lifecycle unknown, ids re-pended ONCE, and the next nudge is typed
 *      only after the screen shows the unsent one is not on the prompt (else held).
 *  (3) WAKE-NO-PENDING-IDS hardening, as ZT-I1-MAIL §11.3 (1.1.75) replaced it: an announced id
 *      the ledger still calls delivered when its wake's epoch closes (the Stop) is re-pended
 *      ONCE at that close, then the F4 backoff; the old time-based re-announce is gone.
 *
 * The coordinator, bridge and owner are REAL; the clock is fake. Timings are the live
 * floor's (Phyllis 06:29:54, Dwight 06:27:56 to 06:28:20, 2026-09-26).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const W = loadTs('src/main/workerWake.ts');
const { WorkerWakeWatchdog, inboxWakeRequestId, inboxWakeClaimId, PROVIDER_IDLE_CONFIRM_MS, STOP_SETTLE_MS, SUBMIT_CONFIRM_MS, STUCK_ACTIVE_AFTER_MS, WORKER_WAKE_IDLE_MS, WAKE_RETRY_BASE_MS, WAKE_RETRY_MAX_MS, wakeRetryDelayMs } = W;
const { InboxWakeBridge } = loadTs('src/main/inboxWakeBridge.ts');
const OWN = loadTs('src/main/automaticSubmit.ts');
const { ADMISSION_REASON } = loadTs('src/main/capacityAdmission.ts');
const { inboxNudgeText } = loadTs('src/shared/hiveNudge.ts');

const T = (hms) => Date.parse(`2026-09-26T${hms}Z`);
const fact = (agentId, over = {}) => ({ agentId, ptyId: `pty-${agentId}`, lastOutputAt: 1, autoDeliveryPaused: false, paused: false, halted: false, ...over });

// ─── (1a) Stop is terminal proof ────────────────────────────────────────────────────

test('AGY (1a) Phyllis 06:29:54: Stop, then a stale running tick (+0.12 s) and idle ticks, then silence: idle, and mail is claimed', () => {
  const c = new WorkerWakeWatchdog();
  const STOP = T('06:29:54.071');
  assert.equal(c.noteHook('phyllis', 'Stop', undefined, STOP, true), true);
  assert.equal(c.noteProviderStatus('phyllis', 'running', T('06:29:54.193')), false);
  assert.equal(c.state('phyllis').lifecycle, 'idle', 'a running reading 122 ms after the Stop is about the turn it ended');
  c.noteProviderStatus('phyllis', 'idle', T('06:29:54.488'));
  c.noteProviderStatus('phyllis', 'idle', T('06:29:54.792'));
  assert.equal(c.state('phyllis').lifecycle, 'idle');
  c.noteDelivery('phyllis', 'm1');
  const claim = c.claim(fact('phyllis'), 'delivery', 'event', T('06:30:10'));
  assert.ok(claim, `claimable (was: ${c.whyNoClaim('phyllis')})`);
});

test('AGY (1a) 07:06:38 and 07:07:41: running at +1.7 s, +2.2 s and +2.6 s after a Stop opens nothing; one after STOP_SETTLE_MS does', () => {
  const c = new WorkerWakeWatchdog();
  const STOP = T('07:06:38.000');
  c.noteHook('phyllis', 'Stop', undefined, STOP, true);
  for (const d of [1700, 2200, 2600, STOP_SETTLE_MS - 1]) {
    c.noteProviderStatus('phyllis', 'running', STOP + d);
    assert.equal(c.state('phyllis').lifecycle, 'idle', `+${d} ms`);
  }
  c.noteProviderStatus('phyllis', 'running', STOP + STOP_SETTLE_MS);
  assert.equal(c.state('phyllis').lifecycle, 'active', 'outside the window a running reading is a turn again');
  // A reading dated BEFORE the Stop is stale however late it arrives.
  const c2 = new WorkerWakeWatchdog();
  c2.noteHook('p', 'Stop', undefined, STOP, true);
  c2.noteProviderStatus('p', 'waiting_for_confirmation', STOP - 500);
  assert.equal(c2.state('p').lifecycle, 'idle', 'a pre-Stop reading (running or confirmation) opens nothing');
});

test('AGY (1a) a GENUINE new turn inside the window still opens: PreInvocation, UserPromptSubmit, or our own COMMITTED', () => {
  const STOP = T('07:07:41.000');
  const viaHook = (event) => {
    const c = new WorkerWakeWatchdog();
    c.noteHook('p', 'Stop', undefined, STOP, true);
    c.noteHook('p', event, undefined, STOP + 800);
    c.noteProviderStatus('p', 'running', STOP + 1200);
    return c.state('p').lifecycle;
  };
  assert.equal(viaHook('PreInvocation'), 'active', 'PreInvocation is agy\'s turn start');
  assert.equal(viaHook('UserPromptSubmit'), 'active');
  const c = new WorkerWakeWatchdog();
  c.noteHook('p', 'Stop', undefined, STOP, true);
  c.noteDelivery('p', 'm1');
  const claim = c.claim(fact('p'), 'hook', 'event', STOP + 100);
  c.settle(claim, 'COMMITTED', STOP + 600);
  c.noteProviderStatus('p', 'running', STOP + 1500);
  c.noteProviderStatus('p', 'idle', STOP + 1900);   // inside the confirm grace: refused
  assert.equal(c.state('p').lifecycle, 'active', 'our own submit after the Stop is a turn start');
});

// ─── (1b) Defer, never drop ─────────────────────────────────────────────────────────

test('AGY (1b) a grace-refused idle followed by silence is applied by the first beat after the grace (no new timer)', () => {
  const c = new WorkerWakeWatchdog();
  const at = T('06:40:00.000');
  c.noteHook('p', 'Stop', undefined, at - 60_000, true);
  c.noteDelivery('p', 'm1');
  c.settle(c.claim(fact('p'), 'hook', 'event', at - 10), 'COMMITTED', at);
  assert.equal(c.noteProviderStatus('p', 'idle', at + 1000), false, 'refused inside the grace');
  assert.equal(c.state('p').lifecycle, 'active');
  assert.equal(c.beat('p', at + PROVIDER_IDLE_CONFIRM_MS - 1), null, 'not before the grace is over');
  assert.deepEqual(c.beat('p', at + PROVIDER_IDLE_CONFIRM_MS), { kind: 'deferred-idle' });
  assert.equal(c.state('p').lifecycle, 'idle');
  assert.equal(c.beat('p', at + 20_000), null, 'applied once');
});

test('AGY (1b) a refused idle followed by a GENUINE running reading, or an active hook, stays active', () => {
  const at = T('06:41:00.000');
  const setup = () => {
    const c = new WorkerWakeWatchdog();
    c.noteDelivery('p', 'm1');
    c.noteHook('p', 'Stop', undefined, at - 60_000, true);
    c.settle(c.claim(fact('p'), 'hook', 'event', at - 10), 'COMMITTED', at);
    c.noteProviderStatus('p', 'idle', at + 1000);
    return c;
  };
  const a = setup();
  a.noteProviderStatus('p', 'running', at + 2000);
  assert.equal(a.beat('p', at + 20_000), null);
  assert.equal(a.state('p').lifecycle, 'active', 'a newer running reading overtakes the deferred idle');
  const b = setup();
  b.noteHook('p', 'PreInvocation', undefined, at + 2500);
  assert.equal(b.beat('p', at + 20_000), null);
  assert.equal(b.state('p').lifecycle, 'active', 'so does a turn-start hook');
  // An OLDER running reading received late does not overtake a newer deferred idle.
  const d = setup();
  d.noteProviderStatus('p', 'running', at + 500);
  assert.deepEqual(d.beat('p', at + 20_000), { kind: 'deferred-idle' });
});

// ─── (2) Codex: active needs confirmation ───────────────────────────────────────────

/** The bridge over a real coordinator, with a scripted owner and inbox. */
function floor({ confirms = true, probe = null, decide = () => ({ kind: 'COMMITTED' }) } = {}) {
  const f = { now: 0, inbox: new Map(), reqs: [], diags: [], queue: [], lastOutputAt: new Map() };
  f.coordinator = new WorkerWakeWatchdog();
  f.bridge = new InboxWakeBridge({
    coordinator: f.coordinator,
    inboxIds: (a) => [...(f.inbox.get(a) ?? [])],
    facts: (a) => ({ ptyId: `pty-${a}`, lastOutputAt: f.lastOutputAt.get(a) ?? 1, autoDeliveryPaused: false, paused: false, halted: false }),
    submit: (req) => { f.reqs.push(req); return Promise.resolve(decide(req, f)); },
    text: (ids) => inboxNudgeText([...ids]),
    setImmediate: (fn) => f.queue.push(fn),
    now: () => f.now,
    diag: (stage, fields) => f.diags.push({ stage, ...fields }),
    confirmsTurnStart: () => confirms,
    ...(probe ? { codexTurnProbe: () => probe.current } : {})
  });
  f.flush = async () => { while (f.queue.length) f.queue.shift()(); await new Promise((r) => setImmediate(r)); };
  return f;
}

/** Dwight, 2026-09-26: boot turn done (Stop 06:27:56.140), one message, our reconcile claim
 *  at 06:28:19.902 and COMMITTED at 06:28:20.594, and then nothing from Codex, ever. */
async function dwightCommitted(f) {
  f.coordinator.noteHook('dwight', 'Stop', undefined, T('06:27:56.140'), undefined, '01a0dc65');
  f.inbox.set('dwight', ['god-dwightupstream']);
  f.lastOutputAt.set('dwight', T('06:27:56.300'));
  f.now = T('06:28:19.902');
  f.bridge.requestInboxWake('dwight', 'renderer', 'reconcile');
  f.now = T('06:28:20.594');
  await f.flush();
  assert.equal(f.reqs.length, 1);
  assert.equal(f.coordinator.state('dwight').lifecycle, 'active');
}

test('CODEX (2) Dwight: COMMITTED, no provider turn start: nothing for 60 s, then submit-unconfirmed, lifecycle unknown, ONE re-claim (new request id, prompt check)', async () => {
  const probe = { current: { ok: true, latest: { kind: 'complete', turnId: '01a0dc65', at: T('06:27:56.300') } } };
  const f = floor({ probe });
  await dwightCommitted(f);
  assert.equal(f.coordinator.state('dwight').provisional, true);
  f.now = T('06:28:20.594') + SUBMIT_CONFIRM_MS - 1;
  f.bridge.reconcileAll(['dwight']);
  assert.equal(f.reqs.length, 1, 'the boot turn\'s completion (before our claim) is neither a start nor a close');
  assert.equal(f.coordinator.state('dwight').lifecycle, 'active');
  f.now = T('06:28:20.594') + SUBMIT_CONFIRM_MS;
  f.bridge.reconcileAll(['dwight']);
  assert.ok(f.diags.some((d) => d.stage === 'submit-unconfirmed' && d.agentId === 'dwight' && d.ids === 1), 'logged submit-unconfirmed');
  assert.equal(f.reqs.length, 2, 'one re-claim, on the same beat (unknown + quiescent)');
  const again = f.reqs[1];
  assert.equal(again.requestId, inboxWakeClaimId('dwight', ['god-dwightupstream'], 1), 'not the COMMITTED id the owner would replay without typing (the next generation)');
  assert.equal(again.priorText, inboxNudgeText(['god-dwightupstream']), 'the owner must see the unsent nudge gone first');
  await f.flush();
  // CODEX-WAKE-161 F4: the second one is not confirmed either. It used to be dropped here
  // for good (the mail sat on disk, every claim said no-pending-ids). Now it is logged as
  // exhausted and offered again after a backoff - never in a tight loop, never silently.
  const againAt = f.now;
  f.now = againAt + SUBMIT_CONFIRM_MS;
  f.bridge.reconcileAll(['dwight']);
  await f.flush();
  const ex = f.diags.find((d) => d.stage === 'wake-ids-exhausted' && d.agentId === 'dwight');
  assert.ok(ex, 'logged wake-ids-exhausted');
  assert.deepEqual([ex.idList, ex.attempt, ex.retryInMs], [['god-dwightupstream'], 1, WAKE_RETRY_BASE_MS]);
  assert.equal(f.coordinator.state('dwight').lifecycle, 'unknown');
  for (let t = SUBMIT_CONFIRM_MS; t < WAKE_RETRY_BASE_MS; t += SUBMIT_CONFIRM_MS) {
    f.now = againAt + SUBMIT_CONFIRM_MS + t;
    f.bridge.reconcileAll(['dwight']);
    await f.flush();
  }
  assert.equal(f.reqs.length, 2, 'nothing more inside the backoff: no loop');
  f.now = againAt + SUBMIT_CONFIRM_MS + WAKE_RETRY_BASE_MS;
  f.bridge.reconcileAll(['dwight']);
  await f.flush();
  assert.equal(f.reqs.length, 3, 'offered again once the backoff ends');
  assert.equal(f.reqs[2].requestId, inboxWakeClaimId('dwight', ['god-dwightupstream'], 2), 'a fresh request id per retry (the next generation)');
  assert.equal(f.reqs[2].priorText, inboxNudgeText(['god-dwightupstream']), 'and it still checks the prompt first (F2: never a stacked copy)');
  assert.equal(wakeRetryDelayMs(2), 2 * WAKE_RETRY_BASE_MS);
  assert.equal(wakeRetryDelayMs(9), WAKE_RETRY_MAX_MS, 'capped');
});

test('CODEX (2) the re-claim is typed only after a clean prompt; the unsent nudge still there is HELD (never double-typed)', async () => {
  const decide = (req) => (req.priorText ? { kind: 'INTERFERED', reason: 'PRIOR_TEXT_ON_PROMPT' } : { kind: 'COMMITTED' });
  const f = floor({ decide });
  await dwightCommitted(f);
  f.now += SUBMIT_CONFIRM_MS;
  f.bridge.reconcileAll(['dwight']);
  await f.flush();
  assert.ok(f.coordinator.state('dwight').held, 'held for a person');
  f.now += SUBMIT_CONFIRM_MS;
  f.bridge.reconcileAll(['dwight']);
  assert.equal(f.reqs.length, 2, 'and nothing more is attempted while held');
});

test('CODEX (2) a confirmed turn stays active until its Stop: UserPromptSubmit hook, or the rollout\'s task_started after the claim', async () => {
  const hook = floor();
  await dwightCommitted(hook);
  hook.bridge.onHook('dwight', 'UserPromptSubmit', undefined);
  assert.equal(hook.coordinator.state('dwight').provisional, false);
  // WAKE-WATCHDOG-RECOVERY (1.1.76) amends D3: silence never closes a confirmed turn INSIDE the
  // watchdog window. After STUCK_ACTIVE_AFTER_MS with no hook and no PTY output the watchdog
  // recovers it to `unknown` (never `idle`), with a durable row; see wake-watchdog-recovery.test.cjs.
  hook.now += STUCK_ACTIVE_AFTER_MS - 1_000;
  hook.bridge.reconcileAll(['dwight']);
  assert.equal(hook.coordinator.state('dwight').lifecycle, 'active', 'D3: silence never closes a confirmed turn (inside the window)');
  assert.equal(hook.reqs.length, 1);
  hook.now += 1_000;
  hook.bridge.reconcileAll(['dwight']);
  assert.equal(hook.coordinator.state('dwight').lifecycle, 'unknown', 'after the window: the watchdog, to unknown (never idle)');
  assert.ok(hook.diags.some((d) => d.stage === 'stuck-active' && d.recovered === true && d.basis === 'quiet'));

  const probe = { current: { ok: true, latest: { kind: 'complete', turnId: '01a0dc65', at: T('06:27:56.300') } } };
  const roll = floor({ probe });
  await dwightCommitted(roll);
  probe.current = { ok: true, latest: { kind: 'started', turnId: 'n1', at: T('06:28:21.000') } };
  roll.now = T('06:28:30');
  roll.bridge.reconcileAll(['dwight']);
  assert.equal(roll.coordinator.state('dwight').provisional, false, 'task_started after our claim confirms');
  assert.ok(roll.diags.some((d) => d.stage === 'codex-rollout' && d.confirmed === true));
  roll.now += 10 * SUBMIT_CONFIRM_MS;
  roll.bridge.reconcileAll(['dwight']);
  assert.equal(roll.coordinator.state('dwight').lifecycle, 'active');
  assert.equal(roll.reqs.length, 1);
  // WAKE-WATCHDOG-RECOVERY: while the rollout says a turn is RUNNING, not even its quiet rule acts.
  roll.now += 2 * STUCK_ACTIVE_AFTER_MS;
  roll.bridge.reconcileAll(['dwight']);
  assert.equal(roll.coordinator.state('dwight').lifecycle, 'active');
  assert.ok(!roll.diags.some((d) => d.stage === 'stuck-active'));
});

test('WAKE-155 C2: a genuine task_started between claim and async settle confirms the committed wake', async () => {
  const probe = { current: { ok: true, latest: { kind: 'complete', turnId: '01a0dc65', at: T('06:27:56.300') } } };
  const f = floor({ probe });
  await dwightCommitted(f);
  // claim is 06:28:19.902 and the owner settles at 06:28:20.594. Codex can start
  // in that window; rollout may not observe it until the next reconcile.
  probe.current = { ok: true, latest: { kind: 'started', turnId: 'n-between', at: T('06:28:20.100') } };
  f.now = T('06:28:30.000');
  f.bridge.reconcileAll(['dwight']);
  assert.equal(f.coordinator.state('dwight').provisional, false);
  assert.ok(f.diags.some((d) => d.stage === 'codex-rollout' && d.confirmed === true));
});

test('WAKE-155 C2: a start after claim but before settle confirms even though activeSince is later', () => {
  const c = new WorkerWakeWatchdog();
  c.noteHook('a', 'Stop', undefined, 1000, true);
  c.noteDelivery('a', 'm1');
  const claim = c.claim(fact('a'), 'hook', 'event', 2000);
  c.settle(claim, 'COMMITTED', 2200, true);
  // The rollout timestamp and the local active epoch use independent observation paths.
  // Model the delayed-settle/skew shape that made `at > activeSince` an invalid boundary.
  c.agents.get('a').activeSince = 2200;
  assert.ok(c.turnFacts('a').activeSince > 2100, 'the start timestamp is genuinely before settle/activeSince');
  assert.equal(c.noteProviderTurnStarted('a', 'between-claim-and-settle', 2100), true);
  assert.equal(c.state('a').provisional, false);
});

test('WAKE-155 C2: a replayed start for a closed turn cannot confirm a later provisional wake', () => {
  const c = new WorkerWakeWatchdog();
  c.noteHook('a', 'Stop', undefined, 1000, true);
  c.noteDelivery('a', 'm1');
  c.settle(c.claim(fact('a'), 'hook', 'event', 2000), 'COMMITTED', 2100, true);
  assert.equal(c.noteProviderTurnStarted('a', 'old-turn', 2200), true);
  assert.equal(c.noteProviderTurnEnded('a', 'old-turn', 2300), true);
  c.noteDelivery('a', 'm2');
  c.settle(c.claim(fact('a'), 'hook', 'event', 2400), 'COMMITTED', 2500, true);
  assert.equal(c.noteProviderTurnStarted('a', 'old-turn', 2600), false, 'closed turn id is a replay, not confirmation');
  assert.equal(c.state('a').provisional, true);
});

test('WAKE-155 CODEX: a previous task_complete that arrives after the claim is NOT a new turn start or a confirmation', async () => {
  const probe = { current: { ok: true, latest: { kind: 'complete', turnId: 'old-turn', at: T('06:27:56.300') } } };
  const f = floor({ probe });
  await dwightCommitted(f);
  // This is the field failure: a late read of the PREVIOUS turn's task_complete has a
  // timestamp after claim(), but it is still a completion, not evidence that our Enter
  // opened a turn. 1.1.53 treated any boundary as task_started and stranded the agent.
  probe.current = { ok: true, latest: { kind: 'complete', turnId: 'old-turn', at: T('06:28:20.100') } };
  f.now = T('06:28:30');
  f.bridge.reconcileAll(['dwight']);
  assert.equal(f.coordinator.state('dwight').provisional, true, 'only a NEW task_started after the submit can confirm');
  assert.ok(!f.diags.some((d) => d.stage === 'codex-rollout' && d.confirmed === true), 'the old completion is never logged as a confirmation');
});

test('WAKE-155 CODEX: a legacy false-confirmed active epoch is made provisional and re-pended once', async () => {
  const probe = { current: { ok: true, latest: { kind: 'complete', turnId: 'old-turn', at: T('06:28:20.100') } } };
  const f = floor({ probe });
  await dwightCommitted(f);
  // Model the persisted in-memory state made by the 1.1.53 bug: task_complete was treated
  // as a start, so the epoch became active/non-provisional even though the completion is
  // older than the submit epoch. The detector must make the existing bounded retry path run.
  const legacy = f.coordinator.agents.get('dwight');
  legacy.provisional = false;
  legacy.turnStartAt = probe.current.latest.at;
  legacy.openTurnId = null;
  f.now = T('06:28:20.594') + SUBMIT_CONFIRM_MS;
  f.bridge.reconcileAll(['dwight']);
  assert.equal(f.coordinator.state('dwight').lifecycle, 'unknown');
  assert.ok(f.diags.some((d) => d.stage === 'submit-unconfirmed' && d.ids === 1), 'the old claim is re-pended once');
  assert.equal(f.reqs.length, 2, 'the bridge immediately makes the one permitted :again claim');
  assert.ok(f.diags.some((d) => d.stage === 'codex-stuck-active' && d.recovered === true));
});

test('CODEX (2) a provider with no turn-start signal keeps "COMMITTED is active until Stop or the watchdog window" (never provisional)', async () => {
  const f = floor({ confirms: false });
  await dwightCommitted(f);
  assert.equal(f.coordinator.state('dwight').provisional, false);
  f.now += STUCK_ACTIVE_AFTER_MS - 1_000;   // WAKE-WATCHDOG-RECOVERY: its window is the limit now
  f.bridge.reconcileAll(['dwight']);
  assert.equal(f.coordinator.state('dwight').lifecycle, 'active');
  assert.equal(f.reqs.length, 1);
});

test('CODEX (2) a turn start that beat our settle still counts; a handled message is not re-pended', async () => {
  const c = new WorkerWakeWatchdog();
  c.noteHook('a', 'Stop', undefined, 1000, true);
  c.noteDelivery('a', 'm1');
  const claim = c.claim(fact('a'), 'hook', 'event', 2000);
  c.noteHook('a', 'UserPromptSubmit', undefined, 2100);
  c.settle(claim, 'COMMITTED', 2150, true);
  assert.equal(c.state('a').provisional, false);
  const d = new WorkerWakeWatchdog();
  d.noteHook('a', 'Stop', undefined, 1000, true);
  d.noteDelivery('a', 'm1');
  d.settle(d.claim(fact('a'), 'hook', 'event', 2000), 'COMMITTED', 2150, true);
  d.reconcile('a', []);                     // the agent moved it to .done
  const edge = d.beat('a', 2150 + SUBMIT_CONFIRM_MS);
  assert.deepEqual(edge, { kind: 'submit-unconfirmed', ids: [] });
  assert.deepEqual(d.state('a').pending, []);
});

// ─── (2) the owner's prompt check, REAL owner ───────────────────────────────────────

function world(over = {}) {
  const w = { vt: 0, timers: [], seq: 0, writes: [], gen: 0, inc: { n: 1 }, prompt: '', scrollback: [], screen: 'answers', cancelled: [], held: [], confirmed: [], ...over };
  w.deps = {
    resolvePty: (a) => `pty-${a}`,
    incarnation: () => w.inc,
    humanGeneration: () => w.gen,
    write: (ptyId, data) => { w.writes.push(data); if (data === '\r') { w.scrollback.push(w.prompt); w.prompt = ''; } else w.prompt += data; return { ok: true }; },
    terminalReady: () => 'READY',
    eligibility: () => ({ eligible: true }),
    promptBlock: () => null,
    lastHumanInputAt: () => undefined,
    abortCapability: () => ({ kind: 'VERIFIED', clearControl: '\x15', settleMs: 300 }),
    readScreen: over.readScreen ?? ((ptyId, needle, expectedTail) => {
      if (w.screen === 'silent') return new Promise(() => {});
      const row = w.promptRow ? w.promptRow(w.prompt) : w.prompt;
      return Promise.resolve({ onPromptRow: row.includes(needle), screenCount: [...w.scrollback, w.prompt].filter((r) => r.includes(needle)).length,
        ...(expectedTail ? { promptTailMatches: w.prompt.endsWith(expectedTail) } : {}) });
    }),
    capacity: {
      admit: (agentId, workClass) => ({ verdict: 'ALLOW', reason: ADMISSION_REASON.AVAILABLE, poolKey: 'pool', state: null, workClass, limitEpochAt: null, grantId: null }),
      revalidate: () => ({ verdict: 'ALLOW', reason: ADMISSION_REASON.AVAILABLE }),
      confirmLaunch: (d) => w.confirmed.push(d), cancelGrant: (d) => w.cancelled.push(d), holdGrant: (d) => w.held.push(d)
    },
    now: () => w.vt,
    setTimer: (fn, ms) => { w.timers.push({ at: w.vt + ms, seq: (w.seq += 1), fn }); return w.seq; }
  };
  return w;
}
async function run(w, promise) {
  let done = false, value;
  promise.then((v) => { done = true; value = v; });
  for (let i = 0; i < 2000; i++) {
    await new Promise((r) => setImmediate(r));
    if (done) return value;
    w.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
    const next = w.timers.shift();
    if (!next) throw new Error('stuck');
    w.vt = Math.max(w.vt, next.at);
    next.fn();
  }
  throw new Error('did not settle');
}
const PRIOR = inboxNudgeText(['god-dwightupstream']);
const NEXT = inboxNudgeText(['god-dwightupstream', 'jim-x']);
const sub = (over = {}) => ({ requestId: 'inbox-wake:dwight:x:again', agentId: 'dwight', admissionClass: 'CAPACITY_GATED', text: NEXT, priorText: PRIOR, ...over });

test('OWNER (2) the unsent nudge still on the prompt: INTERFERED PRIOR_TEXT_ON_PROMPT, NOTHING typed, the PTY inhibited', async () => {
  const w = world({ prompt: PRIOR });
  const o = new OWN.AutomaticSubmitOwner(w.deps);
  assert.deepEqual(await run(w, o.submit(sub())), { kind: 'INTERFERED', reason: 'PRIOR_TEXT_ON_PROMPT' });
  assert.deepEqual(w.writes, [], 'not a byte');
  assert.ok(o.inhibition('pty-dwight'), 'held for a person');
});

test('WAKE-155 OWNER: a matching, untouched automatic draft is our own unsent prompt, so retry presses Enter once instead of holding it', async () => {
  const w = world({
    prompt: '',
    readScreen: () => Promise.resolve({ onPromptRow: true, screenCount: 1, promptTailMatches: true })
  });
  const o = new OWN.AutomaticSubmitOwner(w.deps);
  // Record that this exact automatic text was staged by this owner. The first Enter was
  // accepted by the PTY but the TUI left the text in its composer (the observed Claude case).
  assert.deepEqual(await run(w, o.submit(sub({ requestId: 'first', text: PRIOR, priorText: undefined }))), { kind: 'COMMITTED' });
  w.prompt = PRIOR;
  w.scrollback.length = 0;
  w.writes.length = 0;
  assert.deepEqual(await run(w, o.submit(sub({ requestId: 'retry' }))), { kind: 'COMMITTED' });
  assert.deepEqual(w.writes, ['\r'], 'no duplicate prompt: re-press only Enter on the proven self draft');
  assert.equal(o.inhibition('pty-dwight'), null, 'self recovery never creates a human-interference hold');
});

test('OWNER (2) WRAPPED: a long unsent nudge whose cursor row holds only its tail is still seen', async () => {
  for (const width of [40, 57, 80, 97, 120, 163, 200]) {
    // The cursor's row is the LAST wrapped row of the text in the composer.
    const promptRow = (p) => (p.length <= width ? p : p.slice(p.length - (p.length % width || width)));
    if (promptRow(PRIOR).length < 4) continue;   // the documented residual
    const w = world({ prompt: PRIOR, promptRow });
    const o = new OWN.AutomaticSubmitOwner(w.deps);
    const out = await run(w, o.submit(sub()));
    assert.equal(out.kind, 'INTERFERED', `width ${width}`);
    assert.deepEqual(w.writes, []);
  }
});

test('OWNER (2) the earlier nudge was SENT (echoed above an empty prompt): the next one is typed', async () => {
  const w = world({ prompt: '', scrollback: [PRIOR] });
  const o = new OWN.AutomaticSubmitOwner(w.deps);
  assert.deepEqual(await run(w, o.submit(sub())), { kind: 'COMMITTED' });
  assert.deepEqual(w.writes, [NEXT, '\r']);
});

test('OWNER (2) no screen reading: REFUSED PRIOR_TEXT_UNVERIFIED, nothing typed, nothing held; no priorText = no read at all', async () => {
  const w = world({ screen: 'silent' });
  const o = new OWN.AutomaticSubmitOwner(w.deps);
  const out = await run(w, o.submit(sub()));
  assert.equal(out.kind, 'REFUSED');
  assert.equal(out.reason, 'PRIOR_TEXT_UNVERIFIED');
  assert.deepEqual(w.writes, []);
  assert.equal(o.inhibition('pty-dwight'), null);
  const w2 = world({ screen: 'silent' });
  const o2 = new OWN.AutomaticSubmitOwner(w2.deps);
  assert.deepEqual(await run(w2, o2.submit(sub({ priorText: undefined, requestId: 'plain' }))), { kind: 'COMMITTED' }, 'an ordinary submit never waits on the screen');
});

// ─── (3) re-announce ────────────────────────────────────────────────────────────────

test('RE-PEND (3, §11.3) an announced id still delivered at the Stop that closes its wake\'s epoch: ONE re-claim at that Stop (never by time), then the F4 backoff', async () => {
  const f = floor({ confirms: false });
  f.inbox.set('jim', ['m1']);          // the ledger's delivered ids
  f.coordinator.noteHook('jim', 'Stop', undefined, 0, true);
  f.now = 1000;
  f.bridge.onDelivery('jim', 'm1');
  await f.flush();
  assert.equal(f.reqs.length, 1);
  // Time alone re-offers nothing (the 3-minute re-announce is gone).
  f.now = 60 * 60_000;
  f.bridge.reconcileAll(['jim']);
  await f.flush();
  assert.equal(f.reqs.length, 1, 'no time-based re-offer');
  assert.ok(!f.diags.some((d) => d.stage === 'reannounce'));
  // The wake's turn ends with m1 still delivered (a text-only turn whose block overflowed): the
  // epoch close (HookServer calls it before the Stop is reported) re-pends it, and the Stop's
  // own retry edge claims it.
  f.bridge.onMailEpochClosed('jim', 'normal', 'stop');
  f.bridge.onHook('jim', 'Stop', undefined);
  await f.flush();
  assert.ok(f.diags.some((d) => d.stage === 'wake-repend' && d.requeued === 1));
  assert.equal(f.reqs.length, 2, 'one more announcement');
  assert.equal(f.reqs[1].requestId, inboxWakeClaimId('jim', ['m1'], 1));
  assert.equal(f.reqs[1].priorText, undefined, 'that nudge was a real turn: no prompt check');
  // Still delivered at the next close: not burned, not looped: the F4 backoff.
  f.now += 1000;
  f.bridge.onMailEpochClosed('jim', 'normal', 'stop');
  f.bridge.onHook('jim', 'Stop', undefined);
  await f.flush();
  assert.equal(f.reqs.length, 2, 'once per id');
  assert.ok(f.diags.some((d) => d.stage === 'wake-ids-exhausted' && d.attempt === 1));
  f.now += WAKE_RETRY_BASE_MS;
  f.bridge.reconcileAll(['jim']);
  await f.flush();
  assert.equal(f.reqs.length, 3, 'offered again after the backoff');
  assert.equal(f.reqs[2].requestId, inboxWakeClaimId('jim', ['m1'], 2));
});

test('RE-PEND (3, §11.3) keyed to the ledger: only ids still delivered, never over our own unconfirmed nudge, never while merely waiting', () => {
  const c = new WorkerWakeWatchdog();
  c.noteHook('a', 'Stop', undefined, 0, true);
  c.noteDelivery('a', 'm1'); c.noteDelivery('a', 'm2');
  c.settle(c.claim(fact('a'), 'hook', 'event', 10), 'COMMITTED', 10, true);
  assert.equal(c.state('a').provisional, true);
  assert.deepEqual(c.repend('a', ['m1', 'm2'], 20).requeued, [], 'the nudge may still sit unsent in the composer');
  c.noteHook('a', 'UserPromptSubmit', undefined, 30);   // the provider confirmed the turn
  assert.equal(c.beat('a', 10 + 60 * 60_000), null, 'active and an hour old: nothing is re-offered by time');
  const r = c.repend('a', ['m1'], 40);                     // m2 was surfaced (no longer delivered)
  assert.deepEqual(r.requeued, ['m1']);
  assert.deepEqual(c.state('a').pending, ['m1']);
  assert.deepEqual(c.state('a').announced, ['m2']);
  assert.deepEqual(c.repend('a', ['m1'], 50).requeued, [], 'not announced any more: nothing to do');
});

test('RE-PEND (§11.18 #41, Q38) at a TURN END the provisional guard does not apply: an unsurfaced id is re-pended whether or not the start was confirmed', () => {
  const c = new WorkerWakeWatchdog();
  c.noteHook('a', 'Stop', undefined, 0, true);
  c.noteDelivery('a', 'm1'); c.noteDelivery('a', 'm2');
  c.settle(c.claim(fact('a'), 'hook', 'event', 10), 'COMMITTED', 10, true);
  assert.equal(c.state('a').provisional, true);
  // Any other close (interrupt, next turn, ...) still leaves our own unconfirmed nudge alone.
  const r0 = c.repend('a', ['m1', 'm2'], 20);
  assert.deepEqual([r0.requeued, r0.unconfirmedStart], [[], false]);
  // A Stop / StopFailure: the provider says a turn ran and ended. m2 was surfaced in it; m1 not.
  const r = c.repend('a', ['m1'], 30, { turnEnded: true });
  assert.deepEqual(r.requeued, ['m1']);
  assert.equal(r.unconfirmedStart, true);
  assert.deepEqual(c.state('a').pending, ['m1']);
  // A confirmed turn end is the ordinary path (unconfirmedStart false).
  const c2 = new WorkerWakeWatchdog();
  c2.noteHook('b', 'Stop', undefined, 0, true);
  c2.noteDelivery('b', 'm1');
  c2.settle(c2.claim(fact('b'), 'hook', 'event', 10), 'COMMITTED', 10, true);
  c2.noteHook('b', 'UserPromptSubmit', undefined, 20);
  const r2 = c2.repend('b', ['m1'], 30, { turnEnded: true });
  assert.deepEqual([r2.requeued, r2.unconfirmedStart], [['m1'], false]);
});

test('RE-PEND (§11.18 #41, Q38) the Codex case at the bridge: no UserPromptSubmit, the Stop before the 15 s beat: re-offered at that Stop, one mail-repend row with unconfirmedStart:true', async () => {
  const rows = [];
  const f = floor({ confirms: true });
  f.bridge = new InboxWakeBridge({ ...f.bridge.deps, mail: { mode: () => 'inject', closeTurn() {}, abortSince() {}, closeStale: () => [], hasOpenEpoch: () => false, degrade: () => false, log: (row) => rows.push(row) } });
  f.coordinator.noteHook('cx', 'Stop', undefined, 0, true, 'T0');
  f.inbox.set('cx', ['m1']);
  f.now = 1000;
  f.bridge.onDelivery('cx', 'm1');
  await f.flush();
  assert.equal(f.reqs.length, 1);
  assert.equal(f.coordinator.state('cx').provisional, true, 'the start was never confirmed (its UserPromptSubmit is silent)');
  // 5 s later, before any beat, the turn ends: HookServer closes the epoch, then reports the Stop.
  f.now = 6000;
  f.bridge.onMailEpochClosed('cx', 'normal', 'stop');
  f.bridge.onHook('cx', 'Stop', undefined, undefined, 'T1');
  await f.flush();
  assert.equal(f.reqs.length, 2, 're-offered at that Stop');
  assert.equal(f.reqs[1].requestId, inboxWakeClaimId('cx', ['m1'], 1));
  assert.deepEqual(rows, [{ kind: 'mail-repend', agentId: 'cx', reason: 'stop', outcome: 'normal', unconfirmedStart: true, requeued: ['m1'] }]);
  // A confirmed turn's re-pend writes no such row (the wake-repend diag covers it).
  f.now = 7000;
  f.coordinator.noteHook('cx', 'UserPromptSubmit', undefined, 7000, undefined, 'T2');
  f.bridge.onMailEpochClosed('cx', 'normal', 'stop');
  assert.equal(rows.length, 1);
});

test('Q40 (§11.18 #43): StopFailure ends the turn in noteHook, exactly as Stop: lifecycle idle, a retry edge, and a re-pended wake goes out without waiting for the idle Notification', async () => {
  const c = new WorkerWakeWatchdog();
  c.noteHook('a', 'UserPromptSubmit', undefined, 10);
  assert.equal(c.state('a').lifecycle, 'active');
  assert.equal(c.noteHook('a', 'StopFailure', undefined, 20), true, 'a retry edge');
  assert.equal(c.state('a').lifecycle, 'idle');
  // AGY's non-terminal qualifier is honoured the same way.
  c.noteHook('a', 'UserPromptSubmit', undefined, 30);
  assert.equal(c.noteHook('a', 'StopFailure', undefined, 40, false), false);
  assert.equal(c.state('a').lifecycle, 'active');
  // At the bridge: a surfaced id back to delivered at the StopFailure is woken again at once.
  const f = floor({ confirms: true });
  f.coordinator.noteHook('cl', 'Stop', undefined, 0, true);
  f.inbox.set('cl', ['m1']);
  f.now = 1000;
  f.bridge.onDelivery('cl', 'm1');
  await f.flush();
  f.coordinator.noteHook('cl', 'UserPromptSubmit', undefined, 1500);
  f.now = 2000;
  f.bridge.onMailEpochClosed('cl', 'abnormal', 'stop-failure', ['m1']);
  f.bridge.onHook('cl', 'StopFailure', undefined);
  await f.flush();
  assert.equal(f.reqs.length, 2, 'no lifecycle-active refusal after the API error');
});

test('WIRING: main says which providers confirm turn starts (claude, codex, antigravity), by the agent\'s live PTY', () => {
  const { readSource, codeOnly } = require('./read-source.cjs');
  const index = codeOnly(readSource('src/main/index.ts'));
  assert.match(index, /confirmsTurnStart: \(agentId\) => \{\s*const ptyId = ptyForAgent\(agentId\);\s*const provider = ptyId \? ptyProvider\.get\(ptyId\) : undefined;\s*return provider === 'claude' \|\| provider === 'codex' \|\| provider === 'antigravity';\s*\}/);
});

test('AGY (2) a stale running tick inside the Stop-settle window never CONFIRMS our submit; one after the window does', () => {
  const STOP = T('07:07:41.000');
  const setup = () => {
    const c = new WorkerWakeWatchdog();
    c.noteHook('p', 'Stop', undefined, STOP, true);
    c.noteDelivery('p', 'm1');
    c.settle(c.claim(fact('p'), 'hook', 'event', STOP + 100), 'COMMITTED', STOP + 600, true);
    return c;
  };
  const stale = setup();
  stale.noteProviderStatus('p', 'running', STOP + 2600);
  assert.equal(stale.state('p').provisional, true, 'the ended turn\'s last render is not our turn starting');
  assert.equal(stale.beat('p', STOP + 600 + SUBMIT_CONFIRM_MS).kind, 'submit-unconfirmed');
  const real = setup();
  real.noteProviderStatus('p', 'running', STOP + STOP_SETTLE_MS + 100);
  assert.equal(real.state('p').provisional, false);
  assert.equal(real.beat('p', STOP + 600 + SUBMIT_CONFIRM_MS), null);
});

test('CODEX (2) a provisional agent is probed even with an empty inbox (it moved the mail to .done): its task_started still confirms', async () => {
  const probe = { current: { ok: true, latest: { kind: 'complete', turnId: '01a0dc65', at: T('06:27:56.300') } } };
  const f = floor({ probe });
  await dwightCommitted(f);
  f.inbox.set('dwight', []);
  probe.current = { ok: true, latest: { kind: 'started', turnId: 'n1', at: T('06:28:21.000') } };
  f.now = T('06:28:40');
  f.bridge.reconcileAll(['dwight']);
  f.now = T('06:28:20.594') + SUBMIT_CONFIRM_MS;
  f.bridge.reconcileAll(['dwight']);
  assert.equal(f.coordinator.state('dwight').lifecycle, 'active', 'confirmed, so no submit-unconfirmed');
  assert.ok(!f.diags.some((d) => d.stage === 'submit-unconfirmed'));
});

test('HARDENING (1): a deferred idle is NOT applied while AGY is mid-invocation (PreInvocation without its PostInvocation); PostInvocation or Stop releases it', () => {
  const at = T('06:50:00.000');
  const setup = () => {
    const c = new WorkerWakeWatchdog();
    c.noteHook('p', 'Stop', undefined, at - 60_000, true);
    c.noteDelivery('p', 'm1');
    c.settle(c.claim(fact('p'), 'hook', 'event', at - 10), 'COMMITTED', at);
    c.noteHook('p', 'PreInvocation', undefined, at + 300);
    c.noteProviderStatus('p', 'idle', at + 1000);   // grace-refused, and older than nothing newer
    return c;
  };
  // The idle reading is NEWER than the PreInvocation, so the pending idle is kept; only the
  // open invocation holds it back.
  const mid = setup();
  assert.equal(mid.beat('p', at + 20_000), null, 'a model call is running: no idle mid-turn');
  assert.equal(mid.state('p').lifecycle, 'active');
  mid.noteHook('p', 'PostInvocation', undefined, at + 21_000);
  assert.deepEqual(mid.beat('p', at + 30_000), { kind: 'deferred-idle' }, 'released by PostInvocation');
});

test('HARDENING (2): PRIOR_TEXT_UNVERIFIED is bounded: the 5th consecutive unreadable check (or 10 min) is INTERFERED PRIOR_TEXT_UNREADABLE (held, visible), nothing typed', async () => {
  assert.equal(OWN.PRIOR_TEXT_UNREADABLE_MAX, 5);
  assert.equal(OWN.PRIOR_TEXT_UNREADABLE_HOLD_MS, 10 * 60_000);
  const w = world({ screen: 'silent' });
  const o = new OWN.AutomaticSubmitOwner(w.deps);
  for (let k = 1; k < OWN.PRIOR_TEXT_UNREADABLE_MAX; k++) {
    const out = await run(w, o.submit(sub({ requestId: `r${k}` })));
    assert.equal(out.reason, 'PRIOR_TEXT_UNVERIFIED', `check ${k}: refused, retried later`);
  }
  const held = await run(w, o.submit(sub({ requestId: 'r5' })));
  assert.equal(held.kind, 'INTERFERED');
  assert.equal(held.reason, 'PRIOR_TEXT_UNREADABLE');
  assert.ok(o.inhibition('pty-dwight'), 'held for a person, not refused forever');
  assert.deepEqual(w.writes, []);
  // By time: two unreadable checks 10 minutes apart.
  const w2 = world({ screen: 'silent' });
  const o2 = new OWN.AutomaticSubmitOwner(w2.deps);
  assert.equal((await run(w2, o2.submit(sub({ requestId: 't1' })))).kind, 'REFUSED');
  w2.vt += OWN.PRIOR_TEXT_UNREADABLE_HOLD_MS;
  assert.equal((await run(w2, o2.submit(sub({ requestId: 't2' })))).reason, 'PRIOR_TEXT_UNREADABLE');
  // A readable check in between resets the count.
  const w3 = world({ screen: 'silent' });
  const o3 = new OWN.AutomaticSubmitOwner(w3.deps);
  for (let k = 1; k < OWN.PRIOR_TEXT_UNREADABLE_MAX; k++) await run(w3, o3.submit(sub({ requestId: `u${k}` })));
  w3.screen = 'answers';
  assert.equal((await run(w3, o3.submit(sub({ requestId: 'u-read' })))).kind, 'COMMITTED', 'a readable, clear prompt');
  w3.screen = 'silent';
  for (let k = 1; k < OWN.PRIOR_TEXT_UNREADABLE_MAX; k++) {
    assert.equal((await run(w3, o3.submit(sub({ requestId: `v${k}` })))).reason, 'PRIOR_TEXT_UNVERIFIED', `the count restarted (${k})`);
  }
});

test('HARDENING (2): the settle row names the owner\'s reason, so a held or refused wake says why in log.jsonl', async () => {
  const decide = (req) => (req.priorText ? { kind: 'INTERFERED', reason: 'PRIOR_TEXT_UNREADABLE' } : { kind: 'COMMITTED' });
  const f = floor({ decide });
  await dwightCommitted(f);
  f.now += SUBMIT_CONFIRM_MS;
  f.bridge.reconcileAll(['dwight']);
  await f.flush();
  assert.ok(f.diags.some((d) => d.stage === 'settle' && d.outcome === 'INTERFERED' && d.reason === 'PRIOR_TEXT_UNREADABLE'));
});
