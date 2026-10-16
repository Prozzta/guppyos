'use strict';

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

/** The fixture tick as it is sent now (see the header for the three changes). */
function tickNow(scopedFraction) {
  const p = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  p.agent_state = 'idle';
  const now = Date.now();
  for (const b of Object.values(p.quota)) {
    b.reset_time = new Date(Math.round((now + b.reset_in_seconds * 1000) / 1000) * 1000).toISOString().replace('.000Z', 'Z');
  }
  if (scopedFraction !== undefined) p.quota[SCOPED].remaining_fraction = scopedFraction;
  return JSON.stringify(p);
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
  const s = new HookServer(hive, () => null, () => ({}), undefined, undefined, undefined, () => {}, () => {},
    (agentId, tick) => {
      ticks.push(tick);
      runtime.ingestAgyTick(agentId, { accountScope: tick.observations[0].accountScope, activeLimitId: tick.activeLimitId, observations: tick.observations });
    });
  s.start(); t.after(() => { s.stop(); runtime.stop(); });
  for (let i = 0; i < 200 && s.hookBrokerPort() === null; i++) await new Promise((r) => setTimeout(r, 5));
  const cmdFile = path.join(fs.mkdtempSync(path.join(JAIL, 'bin-')), 'agy-oneway.cmd');
  fs.writeFileSync(cmdFile, agyOnewayCmd(sock));
  const strip = new CapacityStripPresenter({ formatTime: () => '@', idKey: Buffer.alloc(32, 9) });
  present = () => strip.present({
    snapshot: runtime.snapshot(), membersOf: (k) => runtime.membersOf(k), membershipKnown: () => true,
    freshUntil: (k) => runtime.tracker.freshUntil(k), now: Date.now()
  });
  return { logs, ticks, runtime, strip, present, cmdFile };
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
async function until(fn, what) {
  for (let i = 0; i < 400; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 25)); }
  assert.fail(`timed out waiting for ${what}`);
}

test('the real 1.4.0 tick, through agy-oneway.cmd and the real HookServer, reaches the tracker, the strip and the details', { skip: !WIN }, async (t) => {
  const f = await floor(t);
  const scope = agyAccountScope();
  const PG = poolKeyOf('antigravity', scope, 'gemini');
  const P3 = poolKeyOf('antigravity', scope, '3p');

  // Seed: the scoped bucket as it was ten minutes before the capture.
  let r = await send(f.cmdFile, tickNow(0.965));
  assert.equal(r.code, 0); assert.equal(r.out, '');
  await until(() => f.ticks.length === 1, 'the seeding tick');
  // The real tick.
  r = await send(f.cmdFile, tickNow());
  assert.equal(r.code, 0);
  await until(() => f.ticks.length === 2, 'the real tick');

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
  await send(f.cmdFile, tickNow(0));
  await until(() => f.ticks.length === 1, 'the tick');
  const gem = f.runtime.tracker.pool(PG);
  assert.equal(gem.state, 'RESERVE_ONLY');
  assert.deepEqual(gem.numericallyExhaustedWindowIds, [SCOPED]);
  const coll = f.present();
  assert.deepEqual(validateCapacityStrip(coll), []);
});
