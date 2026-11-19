'use strict';
require('./tools/own-job.cjs');

/**
 * AGY-QUOTA-KEYS-190, god's proof (conv-0d4948, option 2): the REAL agy 1.4.0 tick, end to end
 * in process, with no app launch. The tick runs:
 *   real `agy-oneway.cmd` (cmd.exe, the command AGY runs) -> a real pipe -> a real HookServer
 *   (onOneway, handleAgyStatus, classifyAgyStatusLine) -> CapacityRuntime.ingestAgyTick,
 *   wired as index.ts wires it -> ProviderCapacityTracker -> CapacityStripPresenter and
 *   capacityDetailView, each checked by its own shared validator.
 * The ONLY stub is the lease owner token: a dev or test hive holds no lease, by design.
 *
 * The tick is the fixture (test/fixtures/agy-statusline-1.4.0.json) with three changes:
 *   - agent_state is 'idle' (the captured tick was `initializing`);
 *   - every bucket's reset_time is re-stated from its own reset_in_seconds at send time, because
 *     the normaliser checks the two against the RECEIPT clock (5 s tolerance);
 *   - for the first, seeding tick the scoped bucket is 0.965, the value it had live ten minutes
 *     earlier (measured), so the second, real tick MOVES the Gemini pool and its row appears
 *     under the existing lazy-row rule.
 * Before (004e957b): both ticks drift `quota-keys`, no Antigravity pool exists, and the strip
 * has no Antigravity row.
 *
 * FLAKE-AGY-QUOTA-TICK-WAIT. The tick crosses the pipe through two real process starts (cmd.exe,
 * then findstr). Under suite load that took about 12 s once, so the server's receipt clock was
 * more than 5 s past the reset times stated at build time, and the product refused the tick as
 * `reset-disagree`, as it must. A refused tick never reaches the tick callback, so the old wait
 * could only time out. Two changes here, and no change to the rule:
 *   - the HookServer takes the test's RECEIPT CLOCK, and every send sets it from the tick's own
 *     build time, so the time spent in transit cannot age the tick;
 *   - the wait ends on the OUTCOME (the tick callback, or the server's drift tally moving) under
 *     one real deadline, so a refused tick fails at once and names its drift code.
 * The 5 s rule itself is pinned at its exact edges in the last test.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

// The HookServer and the account scope read HOME: jail it before anything is constructed.
const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'agy190-e2e-home-'));
const realEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, GEMINI_CLI_HOME: process.env.GEMINI_CLI_HOME };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL; delete process.env.GEMINI_CLI_HOME;
assert.equal(os.homedir(), JAIL, 'jailed');
test.after(() => {
  for (const [k, v] of Object.entries(realEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const { HookServer } = loadTs('src/main/hooks.ts');
const { agyOnewayCmd } = loadTs('src/main/hive.ts');
const { AGY_RESET_TOLERANCE_MS } = loadTs('src/main/capacityNormalize.ts');
const { CapacityRuntime } = loadTs('src/main/capacityRuntime.ts');
const { CapacityStripPresenter } = loadTs('src/main/capacityStrip.ts');
const { capacityDetailView } = loadTs('src/main/capacityDetail.ts');
const { agyAccountScope } = loadTs('src/main/capacityScope.ts');
const { poolKeyOf } = loadTs('src/shared/providerCapacity.ts');
const { validateCapacityStrip } = loadTs('src/shared/capacityStrip.ts');
const { validateCapacityDetail } = loadTs('src/shared/capacityDetail.ts');

const WIN = process.platform === 'win32';
const TOKEN = 'cd'.repeat(16);
const FIXTURE = path.join(__dirname, 'fixtures', 'agy-statusline-1.4.0.json');
const SCOPED = 'gemini-argon-wtu-weekly';

/**
 * The fixture tick as built at `builtAt` (see the header for the three changes). `builtAt` goes
 * back with the body: it is the instant every reset_time was stated from, and so the instant
 * `sendTick` sets the receipt clock from.
 */
function tickNow(scopedFraction, builtAt = Date.now()) {
  const p = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  p.agent_state = 'idle';
  for (const b of Object.values(p.quota)) {
    b.reset_time = new Date(Math.round((builtAt + b.reset_in_seconds * 1000) / 1000) * 1000).toISOString().replace('.000Z', 'Z');
  }
  if (scopedFraction !== undefined) p.quota[SCOPED].remaining_fraction = scopedFraction;
  return { body: JSON.stringify(p), builtAt, quota: p.quota };
}

/** The product's wiring (index.ts), minus Electron: HookServer -> runtime; strip + detail on demand. */
async function floor(t) {
  const logs = [];
  const sock = `\\\\.\\pipe\\agy190-e2e-${process.pid}-${Math.random().toString(36).slice(2)}`;
  const hive = {
    sockPath: () => sock, codexHomeFor: () => null, recordSession: () => {}, appendLog: (row) => { logs.push(row); },
    registry: () => ({ agents: {} }), isGod: () => false, rosterContext: () => '', recordModel: () => {}, appendCostLedger: () => {},
    agyStatuslineOwnerToken: () => TOKEN   // THE stub: the lease a packaged Stable run holds
  };
  // onChange re-presents, as index.ts does (pushCapacityStrip): the lazy-row rule observes at
  // present() time, so a harness that never presented between ticks would see no movement.
  let present = () => null;
  const runtime = new CapacityRuntime({ deliver: () => {}, onChange: () => { present(); } });
  const ticks = [];
  // The receipt clock. It starts at 0 on purpose: a send that did not go through `sendTick` is
  // refused as `reset-disagree` and says so, it does not fall back to the wall clock.
  const receipt = { at: 0 };
  const s = new HookServer(hive, () => null, () => ({}), undefined, undefined, undefined, () => {}, () => {},
    (agentId, tick) => {
      ticks.push(tick);
      runtime.ingestAgyTick(agentId, { accountScope: tick.observations[0].accountScope, activeLimitId: tick.activeLimitId, observations: tick.observations });
    },
    () => receipt.at);
  s.start(); t.after(() => { s.stop(); runtime.stop(); });
  for (let i = 0; i < 200 && s.hookBrokerPort() === null; i++) await new Promise((r) => setTimeout(r, 5));
  const cmdFile = path.join(fs.mkdtempSync(path.join(JAIL, 'bin-')), 'agy-oneway.cmd');
  fs.writeFileSync(cmdFile, agyOnewayCmd(sock));
  const strip = new CapacityStripPresenter({ formatTime: () => '@', idKey: Buffer.alloc(32, 9) });
  present = () => strip.present({
    snapshot: runtime.snapshot(), membersOf: (k) => runtime.membersOf(k), membershipKnown: () => true,
    freshUntil: (k) => runtime.tracker.freshUntil(k), now: Date.now()
  });
  return { logs, ticks, runtime, strip, present, cmdFile, receipt, server: s };
}

/** What AGY runs for the statusline: `<agy-oneway.cmd> agy-status <token>`, the tick on stdin. */
function send(cmdFile, stdin) {
  return new Promise((resolve) => {
    // AGENT_ID empty: the user's own agy session (capacity only, agent_id null).
    const p = spawn('cmd.exe', ['/d', '/c', cmdFile, 'agy-status', TOKEN], { env: { ...process.env, AGENT_ID: '' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = ''; p.stdout.on('data', (d) => { out += d; });
    const guard = setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, 60_000);   // a hang guard only
    p.stdin.on('error', () => {}); p.stdin.end(stdin);
    p.on('close', (code) => { clearTimeout(guard); resolve({ code, out }); });
  });
}
const refusals = (f) => Object.values(f.server.agyDriftCounts()).reduce((a, n) => a + n, 0);
/** The same 10 s the old wait meant (400 x 25 ms), as a real deadline: sleeps that stretch under load cannot extend it. */
const OUTCOME_DEADLINE_MS = 10_000;

/**
 * Send one tick and wait for what the server did with it. `receivedAfterMs` is where the receipt
 * clock stands relative to the tick's build time: 0 for a tick read the instant it was built.
 * Resolves `{ code, out, accepted, drift }`: `accepted` when the tick callback fired, otherwise
 * `drift` is the tally row that moved. One tick is in flight at a time, so the outcome is this tick's.
 */
async function sendTick(f, tick, what, receivedAfterMs = 0) {
  const before = { ticks: f.ticks.length, refused: refusals(f), tally: f.server.agyDriftCounts() };
  f.receipt.at = tick.builtAt + receivedAfterMs;
  const r = await send(f.cmdFile, tick.body);
  const deadline = Date.now() + OUTCOME_DEADLINE_MS;
  for (;;) {
    if (f.ticks.length > before.ticks) return { ...r, accepted: true, drift: null };
    if (refusals(f) > before.refused) {
      const now = f.server.agyDriftCounts();
      return { ...r, accepted: false, drift: Object.keys(now).filter((k) => now[k] !== (before.tally[k] ?? 0)) };
    }
    if (Date.now() >= deadline) assert.fail(`${what}: the server neither accepted nor refused it within ${OUTCOME_DEADLINE_MS} ms of the send ending (exit ${r.code})`);
    await new Promise((res) => setTimeout(res, 25));
  }
}
/** A tick that must be accepted: a refusal fails here, with its drift code. */
async function accepted(f, tick, what, receivedAfterMs = 0) {
  const r = await sendTick(f, tick, what, receivedAfterMs);
  assert.ok(r.accepted, `${what}: refused as ${JSON.stringify(r.drift)}`);
  return r;
}

test('the real 1.4.0 tick, through agy-oneway.cmd and the real HookServer, reaches the tracker, the strip and the details', { skip: !WIN }, async (t) => {
  const f = await floor(t);
  const scope = agyAccountScope();
  const PG = poolKeyOf('antigravity', scope, 'gemini');
  const P3 = poolKeyOf('antigravity', scope, '3p');

  // Seed: the scoped bucket as it was ten minutes before the capture.
  let r = await accepted(f, tickNow(0.965), 'the seeding tick');
  assert.equal(r.code, 0); assert.equal(r.out, '');
  assert.equal(f.ticks.length, 1);
  // The real tick.
  r = await accepted(f, tickNow(), 'the real tick');
  assert.equal(r.code, 0);
  assert.equal(f.ticks.length, 2);

  assert.deepEqual(f.logs.filter((l) => l.kind === 'agy-statusline-drift'), [], 'no drift row (before: quota-keys)');

  // Tracker: both pools, the scoped window in the Gemini pool with the others.
  const gem = f.runtime.tracker.pool(PG);
  assert.ok(gem, 'the Gemini pool exists (before: none)');
  assert.equal(gem.state, 'AVAILABLE');
  assert.deepEqual(gem.windows.map((w) => w.windowId), ['gemini-5h', 'gemini-weekly', SCOPED]);
  assert.equal(gem.windows[2].remainingPercent, 0.8722944 * 100);
  assert.deepEqual(f.runtime.tracker.pool(P3).windows.map((w) => w.windowId), ['3p-5h', '3p-weekly']);

  // Strip: the Gemini row (it moved), under the existing rules - the first 5h and weekly window
  // of the pool; the base weekly at 100% stays below the fold at the default threshold.
  const coll = f.present();
  assert.deepEqual(validateCapacityStrip(coll), [], 'the strip passes its own schema');
  const row = coll.pools.find((p) => p.poolLabel === 'Antigravity · Gemini');
  assert.ok(row, 'the Gemini row is on the strip (before: no Antigravity row)');
  assert.equal(row.presentation, 'NORMAL');
  assert.equal(row.fiveHour.text, '5h · 100% remaining');
  assert.equal(row.weekly, undefined, 'weekly hidden above the threshold, as for every pool');
  assert.ok(!coll.pools.some((p) => p.poolLabel === 'Antigravity · 3P'), '3P did not move: no row (lazy-row rule)');

  // Details: every window of the pool, by kind, each with its own label.
  const detail = capacityDetailView({
    pool: gem, poolId: row.poolId, poolLabel: f.strip.labelOf(gem), presentation: row.presentation,
    members: [], membershipKnown: true, statusNote: null, now: Date.now(), formatTime: () => '@'
  });
  assert.deepEqual(validateCapacityDetail(detail), [], 'the details pass their own schema');
  assert.deepEqual(detail.windows.map((w) => w.text), [
    '5h · 100% remaining', 'Weekly · 100% remaining', 'Weekly (argon-wtu) · 87% remaining'
  ]);
});

test('the same path: the scoped bucket at zero makes the Gemini pool RESERVE_ONLY, by the existing numeric rule', { skip: !WIN }, async (t) => {
  const f = await floor(t);
  const PG = poolKeyOf('antigravity', agyAccountScope(), 'gemini');
  await accepted(f, tickNow(0), 'the tick');
  assert.equal(f.ticks.length, 1);
  const gem = f.runtime.tracker.pool(PG);
  assert.equal(gem.state, 'RESERVE_ONLY');
  assert.deepEqual(gem.numericallyExhaustedWindowIds, [SCOPED]);
  const coll = f.present();
  assert.deepEqual(validateCapacityStrip(coll), []);
});

test('the receipt rule, at its edges: a tick received 5 s from its build time is accepted, one millisecond further is refused as reset-disagree and changes nothing', { skip: !WIN }, async (t) => {
  const f = await floor(t);
  const PG = poolKeyOf('antigravity', agyAccountScope(), 'gemini');
  const LIMIT = 5_000;
  assert.equal(AGY_RESET_TOLERANCE_MS, LIMIT, 'the limit is 5 s');
  const ROW = '1.4.0|reset-disagree';
  // A whole-second build time and whole reset seconds: every reset_time is then exact, so the
  // only distance the rule can see is the receipt offset itself.
  const builtAt = Math.floor(Date.now() / 1000) * 1000;
  const tick = (fraction) => {
    const k = tickNow(fraction, builtAt);
    for (const b of Object.values(k.quota)) {
      assert.ok(Number.isInteger(b.reset_in_seconds), 'whole reset seconds');
      assert.equal(Date.parse(b.reset_time), builtAt + b.reset_in_seconds * 1000, 'reset_time is exact');
    }
    return k;
  };

  // At the limit, early and late: accepted. Early first, so the receipt clock only moves forward
  // (the tracker keeps the reading with the later receipt time).
  await accepted(f, tick(0.5), 'received 5000 ms before the build', -LIMIT);
  await accepted(f, tick(0.4), 'received 5000 ms after the build', LIMIT);
  assert.equal(f.ticks.length, 2);
  assert.deepEqual(f.server.agyDriftCounts(), {}, 'nothing refused at the limit');
  const kept = f.runtime.tracker.pool(PG);
  assert.equal(kept.state, 'AVAILABLE');
  assert.equal(kept.windows[2].remainingPercent, 0.4 * 100);

  // One millisecond past it, late and early: refused. The refused ticks say the scoped bucket
  // is at zero, so an accepted one would turn the pool RESERVE_ONLY.
  let r = await sendTick(f, tick(0), 'received 5001 ms after the build', LIMIT + 1);
  assert.equal(r.code, 0, 'the command still exits 0 for a refused tick');
  assert.deepEqual({ accepted: r.accepted, drift: r.drift }, { accepted: false, drift: [ROW] });
  r = await sendTick(f, tick(0), 'received 5001 ms before the build', -(LIMIT + 1));
  assert.deepEqual({ accepted: r.accepted, drift: r.drift }, { accepted: false, drift: [ROW] });

  assert.deepEqual(f.server.agyDriftCounts(), { [ROW]: 2 });
  assert.deepEqual(f.logs.filter((l) => l.kind === 'agy-statusline-drift'),
    [{ kind: 'agy-statusline-drift', version: '1.4.0', driftCode: 'reset-disagree' }], 'logged once, on the first sighting');
  assert.equal(f.ticks.length, 2, 'a refused tick never reaches the tick callback');
  const after = f.runtime.tracker.pool(PG);
  assert.equal(after.state, 'AVAILABLE', 'the last good pool is unchanged');
  assert.equal(after.windows[2].remainingPercent, 0.4 * 100);
  assert.deepEqual(after.numericallyExhaustedWindowIds, []);
});
