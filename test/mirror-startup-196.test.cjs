'use strict';
/**
 * MIRROR-STARTUP-196 (god P0 1e19d4): on 1.1.95 live the mirror cost guard turned every terminal
 * mirror off 6.0 s after app start (mirror-auto-off event-loop-delay, share 0.02594, eldMs 52.67,
 * window 5), for the whole session, so god's `term read` answered "no screen mirror".
 *
 * Cause (mirrorCost.ts @02d0d50b): the ELD rule had no minimum window and blamed the mirror on ANY
 * tick with a mean ELD over 50 ms while the ESTIMATED share (chars x a cold calibration) was at least
 * 0.5%. Startup itself (6 resumes spawning and repainting) made the lag; the mirror could not explain
 * it. turnOff was permanent and nothing surfaced it.
 *
 * Now: the cost is the mirrors' MEASURED parse; lag blames the mirror only when that parse is most of
 * the loop's active time, in most of a full window; nothing is judged in the startup window or right
 * after a spawn; an off re-arms on a doubling back-off; an off is a digest decision for god, a floor
 * notice and term read's refusal words.
 *
 * HOME IS REDIRECTED AND ASSERTED before anything is built.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const loadTs = require('./load-ts.cjs');

const ROOT = path.join(__dirname, '..');
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'mirror-196-'));
const realEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME redirect failed - aborting before constructing anything');
test.after(() => {
  for (const [k, v] of Object.entries(realEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const M = loadTs('src/main/terminalMirror.ts');
const COST = loadTs('src/main/mirrorCost.ts');
const D = loadTs('src/main/floorDigest.ts');
const T = loadTs('src/main/termControl.ts');
const { PtyManager } = loadTs('src/main/pty.ts');

/** A pure guard rig on a fake clock; `parse` is the measured parse ms of each second. */
function rig(o = {}) {
  const r = { t: 0, bytes: 0, parse: 0, off: [], on: 0, logs: [], spawnAt: 0, eld: o.eld ?? 80, active: o.active ?? 150 };
  r.g = new COST.MirrorCostGuard({
    bytes: () => r.bytes, parseMs: () => (o.untimed ? null : r.parse), msPerChar: o.msPerChar ?? 1e-5,
    eldMs: () => r.eld, eluActiveMs: () => r.active, lastSpawnAt: () => r.spawnAt,
    turnOff: (why) => r.off.push(why), turnOn: () => { r.on += 1; }, log: (row) => r.logs.push(row), now: () => r.t
  });
  r.second = (chars = 0, parse = chars * (o.msPerChar ?? 1e-5)) => { r.t += 1000; r.bytes += chars; r.parse += parse; return r.g.tick(); };
  r.pastStartup = () => { while (r.t + 1000 < COST.MIRROR_STARTUP_GRACE_MS) r.second(0, 0); };
  return r;
}
const HOT = 30;   // ms of measured parse per second: 3% of a core, over the share bar

/** A PtyManager session as the spawn makes it (no node-pty). */
function session(id, mirror) {
  return { id, cwd: '', command: '', owner: null, lastOutputAt: 0, hasOutput: false, humanInputGeneration: 0, tail: '',
    mirror, proc: { write: () => {}, cols: 120, rows: 40 }, spawnedAt: 0 };
}

// ─── 1. the measured parse ─────────────────────────────────────────────────────────────────

test('the parse is MEASURED on the installed xterm: the WriteBuffer slice method exists and is timed', async () => {
  const t = M.createHeadless(80, 24);
  assert.equal(typeof t._core?._writeBuffer?._innerWrite, 'function', 'XTERM UPGRADE DROPPED _innerWrite: the mirror cost is no longer measured (terminalMirror.ts timeParse)');
  assert.equal(t._core._writeBuffer._innerWrite.name, 'timed', 'createHeadless wraps it');
  t.dispose();
  const before = M.mirrorParseMs();
  assert.equal(typeof before, 'number', 'every real mirror so far is timed');
  const m = M.createTerminalMirror(120, 40);
  const sample = COST.calibrationSample(400_000);
  const w0 = performance.now();
  m.write(sample);
  await m.read(1);
  const wall = performance.now() - w0;
  const spent = M.mirrorParseMs() - before;
  m.dispose();
  assert.ok(spent > 0, `parse time was measured (${spent.toFixed(1)} ms)`);
  assert.ok(spent <= wall + 1, `the measure is the parse itself, never more than the wall time (${spent.toFixed(1)} <= ${wall.toFixed(1)})`);
});

test('timeParse: only the outermost slice is timed; an xterm without the method is reported, not guessed', () => {
  const calls = [];
  const wb = { n: 0, _innerWrite() { this.n += 1; if (this.n === 1) this._innerWrite(); return 'r'; } };
  assert.equal(M.timeParse({ _core: { _writeBuffer: wb } }, (ms) => calls.push(ms)), true);
  assert.equal(wb._innerWrite(), 'r', 'the result passes through');
  assert.equal(wb.n, 2, 'the nested call still runs');
  assert.equal(calls.length, 1, 'ONE timing for the outer slice (a nested call is not counted twice)');
  const thrower = { _innerWrite() { throw new Error('boom'); } };
  M.timeParse({ _core: { _writeBuffer: thrower } }, (ms) => calls.push(ms));
  assert.throws(() => thrower._innerWrite(), /boom/);
  assert.equal(calls.length, 2, 'a throwing slice is still timed');
  assert.equal(M.timeParse({}, () => {}), false);
  assert.equal(M.timeParse({ _core: { _writeBuffer: {} } }, () => {}), false);
  assert.equal(M.timeParse(null, () => {}), false);
});

// ─── 2. the replay of the 1.1.95 startup ───────────────────────────────────────────────────

test('REPLAY 1.1.95 startup: 6 resume bursts (real mirrors) plus ~50 ms unrelated ELD keep the mirror on; the old rule fired here', async () => {
  // The calibration 1.1.95 logged in the busy app (mirror-auto-off msPerChar), not this process's.
  const msPerChar = 0.001926;
  // log.jsonl after app-start 1792353708480: armed +0.46 s; spawns god +3.9, jim/creed +5.1, andy +5.6,
  // phyllis and dwight by +8.6; each resume repaints about 48k chars over about 3 s.
  const spawns = [3900, 5100, 5100, 5600, 7200, 8600];
  const burst = COST.calibrationSample(48_000);
  const agents = spawns.map((at) => ({ at, mirror: null, fed: 0 }));
  const r = { t: 460, fed: 0, off: [], logs: [] };
  const g = new COST.MirrorCostGuard({
    bytes: () => r.fed, parseMs: () => M.mirrorParseMs(), msPerChar,
    eldMs: () => 52.67,          // the startup's own lag, all session long here
    eluActiveMs: () => 900,      // the loop busy with startup work
    lastSpawnAt: () => Math.max(0, ...agents.filter((a) => a.mirror).map((a) => a.at)),
    turnOff: (why) => r.off.push(why), turnOn: () => {}, log: (row) => r.logs.push(row), now: () => r.t
  });
  // The 1.1.95 rule, replayed beside it: any tick with ELD > 50 and an estimated share >= 0.5%.
  const oldShares = [];
  let oldFiredAt = null;
  let lastFed = 0;
  for (let t = 1460; t <= 90_460; t += 1000) {
    for (const a of agents) if (!a.mirror && a.at <= t) a.mirror = M.createTerminalMirror(160, 40);
    for (const a of agents) {
      if (!a.mirror) continue;
      const chunk = a.fed < burst.length ? burst.slice(a.fed, a.fed + 16_000) : 'idle line\r\n'.repeat(180);
      a.fed += chunk.length;
      r.fed += chunk.length;
      a.mirror.write(chunk);
    }
    await Promise.all(agents.filter((a) => a.mirror).map((a) => a.mirror.read(1)));
    r.t = t;
    g.tick();
    oldShares.push(((r.fed - lastFed) * msPerChar) / 1000);
    if (oldShares.length > COST.MIRROR_COST_WINDOW) oldShares.shift();
    lastFed = r.fed;
    const avg = oldShares.reduce((x, y) => x + y, 0) / oldShares.length;
    if (oldFiredAt === null && 52.67 > 50 && avg >= 0.005) oldFiredAt = t;
  }
  for (const a of agents) a.mirror.dispose();
  assert.ok(oldFiredAt !== null && oldFiredAt <= 10_460, `the replay reproduces 1.1.95: its rule fires at +${oldFiredAt} ms`);
  assert.deepEqual(r.off, [], 'THE MIRROR STAYS ON through the startup and after it');
  assert.equal(r.logs.filter((l) => l.kind === 'mirror-auto-off').length, 0);
});

test('startup window and spawn grace: nothing is judged in them, however hot; judged once both have passed', () => {
  const r = rig();
  while (r.t + 1000 < COST.MIRROR_STARTUP_GRACE_MS) assert.equal(r.second(0, HOT), null, `t=${r.t + 1000}: the startup window`);
  assert.deepEqual(r.off, []);
  r.spawnAt = r.t;   // a resume, just after the startup window
  while (r.t + 1000 < r.spawnAt + COST.MIRROR_SPAWN_GRACE_MS) assert.equal(r.second(0, HOT), null, 'a fresh spawn is still repainting');
  assert.deepEqual(r.off, [], 'none of those seconds counted');
  for (let i = 0; i < COST.MIRROR_COST_WINDOW - 1; i++) assert.equal(r.second(0, HOT), null, 'the window refills from empty');
  assert.equal(r.second(0, HOT), 'share', 'a real overload after the grace still turns it off');
});

test('lag the mirror does not explain never turns it off (unrelated ELD, light mirror, or no measured parse)', () => {
  const unrelated = rig({ eld: 52.67, active: 900 });
  unrelated.pastStartup();
  for (let i = 0; i < 60; i++) unrelated.second(0, 15);   // 1.5%: under the share bar, 1/60 of the busy time
  assert.deepEqual(unrelated.off, [], 'ELD from other work, with a real but small mirror cost');
  const untimed = rig({ untimed: true, eld: 200, active: 10, msPerChar: 1e-5 });
  untimed.pastStartup();
  for (let i = 0; i < 60; i++) untimed.second(1_000_000);   // an estimated 10 ms/s: 1%, all of the 10 ms busy time
  assert.deepEqual(untimed.off, [], 'with no measured parse the mirror is never blamed for lag');
  const fallback = rig({ untimed: true, msPerChar: 1e-5 });
  fallback.pastStartup();
  for (let i = 0; i < COST.MIRROR_COST_WINDOW - 1; i++) fallback.second(3_000_000);   // 30 ms/s estimated
  assert.equal(fallback.second(3_000_000), 'share', 'with no measured parse the share bar still holds, on the calibrated estimate');
});

test('the ELD rule needs most of a full window: 5 lagged seconds of 10 are not enough, 6 are', () => {
  const r = rig({ eld: 80, active: 15 });
  r.pastStartup();
  // 10 ms of parse per second (1%): explained when the loop is active 15 ms, not when active 900 ms.
  const tickWith = (explained) => { r.active = explained ? 15 : 900; return r.second(0, 10); };
  for (let i = 0; i < 20; i++) assert.equal(tickWith(i % 2 === 0), null, '5 of every 10 explained');
  assert.deepEqual(r.off, []);
  const s = rig({ eld: 80, active: 15 });
  s.pastStartup();
  const pattern = [true, true, true, true, true, true, false, false, false, false];
  let got = null;
  for (const e of pattern) { s.active = e ? 15 : 900; got = s.second(0, 10); }
  assert.equal(got, 'event-loop-delay', '6 of 10');
  const row = s.logs.find((l) => l.kind === 'mirror-auto-off');
  assert.equal(row.laggedTicks, 6);
  assert.equal(row.window, 10);
  assert.equal(row.measured, true);
});

// ─── 3. a real overload: off, re-arm, off again ────────────────────────────────────────────

test('a sustained REAL mirror overload turns it off; it re-arms after the back-off with the screen seeded from the tail, then the doubled back-off', async () => {
  const pm = new PtyManager();
  const factory = (c, rw) => M.createTerminalMirror(c, rw);
  pm.setMirrorFactory(factory);
  const s = session('p1', factory(120, 40));
  pm.sessions.set('p1', s);
  const r = { t: 0, off: [], on: 0, logs: [], active: 0 };
  const g = new COST.MirrorCostGuard({
    bytes: () => pm.mirrorBytes(), parseMs: () => M.mirrorParseMs(), msPerChar: 1e-9,
    eldMs: () => 80, eluActiveMs: () => r.active, lastSpawnAt: () => pm.lastSpawnAt(),
    turnOff: (why) => { r.off.push(why); pm.setMirrorFactory(null); pm.disposeMirrors(); },
    turnOn: () => { r.on += 1; pm.rearmMirrors(factory); },
    log: (row) => r.logs.push(row), now: () => r.t
  });
  while (r.t + 1000 < COST.MIRROR_STARTUP_GRACE_MS) { r.t += 1000; g.tick(); }
  const flood = COST.calibrationSample(400_000);
  const second = async (data) => {
    const p0 = M.mirrorParseMs();
    pm.deliverData('p1', s, data);
    if (s.mirror) await pm.readScreen('p1');
    r.active = M.mirrorParseMs() - p0 + 10;
    r.t += 1000;
    return g.tick();
  };
  let why = null;
  for (let i = 0; i < 30 && !why; i++) why = await second(flood);
  assert.ok(why, 'A REAL OVERLOAD TURNS THE MIRROR OFF');
  const off1 = r.logs.find((l) => l.kind === 'mirror-auto-off');
  assert.equal(off1.measured, true, 'judged on the measured parse');
  assert.equal(off1.offs, 1);
  assert.equal(off1.rearmInMs, COST.MIRROR_REARM_BASE_MS);
  assert.equal(await pm.readScreen('p1'), null, 'every mirror dropped');
  const since = g.status().since;
  while (r.t + 1000 < since + COST.MIRROR_REARM_BASE_MS) {
    assert.equal(await second('quiet\r\n'), null);
    assert.equal(r.on, 0, 'not before the back-off');
  }
  pm.deliverData('p1', s, '\x1b[2J\x1b[HREADY-MARK\r\n');
  assert.equal(await second(''), null);
  assert.equal(r.on, 1, 'RE-ARMED after the back-off');
  assert.equal(g.isOff(), false);
  const rearm = r.logs.find((l) => l.kind === 'mirror-rearm');
  assert.equal(rearm.offs, 1);
  assert.equal(rearm.offMs, COST.MIRROR_REARM_BASE_MS);
  const screen = await pm.readScreen('p1');
  assert.ok(screen && screen.lines.some((l) => l.includes('READY-MARK')), 'the live session has a mirror again, seeded from its output tail');
  assert.equal(pm.mirrorFactory, factory, 'new sessions get a mirror again');
  for (let i = 0; i < 3; i++) assert.equal(await second('quiet\r\n'), null);
  assert.equal(g.isOff(), false, 'the window starts empty after a re-arm: the old hot seconds never count again');
  why = null;
  for (let i = 0; i < 30 && !why; i++) why = await second(flood);
  assert.ok(why, 'still overloaded: off again');
  const off2 = r.logs.filter((l) => l.kind === 'mirror-auto-off')[1];
  assert.equal(off2.offs, 2);
  assert.equal(off2.rearmInMs, 2 * COST.MIRROR_REARM_BASE_MS, 'the back-off doubles');
  pm.disposeMirrors();
});

test('PtyManager.lastSpawnAt: the newest live session\'s spawn time (0 with none)', () => {
  const pm = new PtyManager();
  assert.equal(pm.lastSpawnAt(), 0);
  pm.sessions.set('a', { ...session('a'), spawnedAt: 5_000 });
  pm.sessions.set('b', { ...session('b'), spawnedAt: 9_000 });
  pm.sessions.set('c', { ...session('c'), spawnedAt: 7_000 });
  assert.equal(pm.lastSpawnAt(), 9_000);
  pm.sessions.delete('b');
  assert.equal(pm.lastSpawnAt(), 7_000, 'an ended session no longer holds the grace open');
});

test('back-off: doubles per off up to the cap; an hour back on forgets the earlier offs', () => {
  const r = rig();
  r.pastStartup();
  const offs = [];
  // Bounded: a guard that never goes off (or never re-arms) fails here, it never hangs.
  const hotUntilOff = () => { for (let i = 0; i < 100; i++) if (r.second(0, HOT)) return; assert.fail('a sustained overload never turned it off'); };
  const quietUntilOn = () => { for (let i = 0; i < 2 * COST.MIRROR_REARM_MAX_MS / 1000 && r.g.isOff(); i++) r.second(0, 0); assert.equal(r.g.isOff(), false, 'never re-armed'); };
  for (let n = 0; n < 8; n++) {
    hotUntilOff();
    offs.push(r.logs.filter((l) => l.kind === 'mirror-auto-off').at(-1).rearmInMs);
    quietUntilOn();
  }
  assert.deepEqual(offs, [1, 2, 4, 8, 16, 30, 30, 30].map((m) => m * 60_000));
  assert.equal(r.on, 8, 'every off re-armed');
  assert.equal(r.logs.filter((l) => l.kind === 'mirror-rearm').length, 8, 'every re-arm is a row');
  for (let i = 0; i < COST.MIRROR_OFFS_RESET_MS / 1000; i++) r.second(0, 0);
  hotUntilOff();
  assert.equal(r.logs.filter((l) => l.kind === 'mirror-auto-off').at(-1).offs, 1, 'an hour on: the next off is the first again');
  assert.equal(r.logs.filter((l) => l.kind === 'mirror-auto-off').at(-1).rearmInMs, COST.MIRROR_REARM_BASE_MS);
});

// ─── 4. visible: god's digest, the floor's banner, term read ───────────────────────────────

test('surfaces: a digest decision for god per off, the floor notice, and term read\'s refusal words', async () => {
  const off = { reason: 'share', since: Date.UTC(2026, 9, 18, 20, 1, 54), offs: 2, rearmAt: Date.UTC(2026, 9, 18, 20, 3, 54) };
  const now = off.since + 30_000;
  const item = D.mirrorOffItem(off, now);
  assert.equal(item.id, `mirror-off:${off.since}`, 'one decision per off (a new off is a new id)');
  assert.match(item.line, /terminal mirrors auto-off .*\(share, off #2\).*term read is refused.*re-arms in/);
  const { markdown, decisionItems } = D.buildFloorDigest({ tasks: { tasks: [] }, meta: {}, flags: [], ledgerIssues: [], agents: [], now, mirrorOff: off });
  assert.equal(decisionItems[0].id, item.id);
  assert.match(markdown, /## Decisions needed\n\n- \[mirror-off:/);
  assert.equal(D.buildFloorDigest({ tasks: { tasks: [] }, meta: {}, flags: [], ledgerIssues: [], agents: [], now }).decisionItems.length, 0, 'no off, no item');
  // The scheduler passes the host's status through (and a throwing host is no item).
  const root = fs.mkdtempSync(path.join(JAIL, 'digest-'));
  const host = { root: () => root, tasks: () => ({ tasks: [] }), taskMeta: () => ({}), flags: () => [], ledgerIssues: () => [], mirrorOff: () => off, send: () => {}, appendLog: () => {} };
  new D.FloorDigest(host, undefined, () => now).run();
  assert.match(fs.readFileSync(path.join(root, D.FLOOR_DIGEST_FILE), 'utf8'), /mirror-off:/);
  const notice = COST.mirrorOffNotice(off, now);
  assert.equal(notice.error, 'mirror-auto-off');
  assert.equal(notice.raisedAt, off.since, 'dismissal covers this off only');
  assert.equal(typeof notice.notice, 'string');
  assert.equal(notice.quarantine, null);
  assert.match(COST.mirrorOffWords(off, now), /auto-turned-off at 20:01:54Z \(share, off #2\); they re-arm in 90 s/);
  const tc = new T.TermControl({ godId: () => 'god', ptyOf: () => 'p1', providerOf: () => 'claude', readScreen: async () => null,
    mirrorOff: () => COST.mirrorOffWords(off, now), write: () => ({ ok: true }), outputGeneration: () => 0, log: () => {}, now: () => now, sleep: async () => {} });
  const res = await tc.handle('god', { action: 'read', agent: 'a1' });
  assert.equal(res.status, 503);
  assert.match(res.body.line, /no screen mirror for a1 \(the mirrors were auto-turned-off at 20:01:54Z/);
});

test('WIRING: measured parse, ELU, spawn grace, re-arm, and the off surfaced to the digest, the banner and term', () => {
  const idx = src('src/main/index.ts');
  const arm = idx.slice(idx.indexOf('async function armMirrorCostGuard('), idx.indexOf('function mirrorSurfaced('));
  assert.match(arm, /parseMs: \(\) => mirrorParseMs\(\),/);
  assert.match(arm, /eluActiveMs: \(\) => \{ const next = performance\.eventLoopUtilization\(\); const d = performance\.eventLoopUtilization\(next, elu\); elu = next;/);
  assert.match(arm, /lastSpawnAt: \(\) => ptyManager\.lastSpawnAt\(\),/);
  assert.match(arm, /turnOff: \(\) => \{ ptyManager\.setMirrorFactory\(null\); ptyManager\.disposeMirrors\(\); mirrorSurfaced\(\); \},/);
  assert.match(arm, /turnOn: \(\) => \{ ptyManager\.rearmMirrors\(\(cols, rows\) => createTerminalMirror\(cols, rows\)\); mirrorSurfaced\(\); \},/);
  assert.doesNotMatch(arm, /clearInterval\(timer\)|eld\.disable\(\)/, 'an off never stops the sampler: it must be able to re-arm');
  assert.match(arm, /mirrorGuard = guard;/);
  assert.match(idx, /function mirrorSurfaced\(\): void \{\n  try \{ floorDigest\.run\(\); \}/);
  assert.ok(idx.indexOf('let mirrorGuard: MirrorCostGuard | null = null;') < idx.indexOf('const floorDigest = new FloorDigest({'), 'declared before the digest that reads it');
  assert.match(idx, /mirrorOff: \(\) => mirrorGuard\?\.status\(\) \?\? null,\n  send: \(msg, from\)/, 'the digest host');
  assert.match(idx, /ipcMain\.handle\('hive:integrity', \(\) => \{\n  const off = mirrorGuard\?\.status\(\) \?\? null;\n  return off \? \[\.\.\.hive\.integrityIssues\(\), mirrorOffNotice\(off, Date\.now\(\)\)\] : hive\.integrityIssues\(\);/, 'the floor banner');
  assert.match(idx, /mirrorOff: \(\) => \{ const off = mirrorGuard\?\.status\(\) \?\? null; return off \? mirrorOffWords\(off, Date\.now\(\)\) : null; \},/, 'term read');
});
