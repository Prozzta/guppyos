'use strict';
/**
 * LOAD-FLAKES-FOLLOWUPS (1.1.77; Jim's LOAD-FLAKES-176 audit, J-LF1..3, and the RPROF note).
 * Pure driver tests: the host's `call` is stubbed and the hold loops run on an injected clock, so
 * nothing here depends on machine speed.
 *
 *  J-LF1 a stall is now reported ONE bound after the last stub progress (read at every poll), not
 *        1 to 2 bounds late (it was checked only at each window's end).
 *  J-LF2 stubsIdle skips a stub that can do no work: its process is dead (a stale `pending` in
 *        composer.json), or the test hung it (the fake agent now records `hung`).
 *  J-LF3 / RPROF: timing checks are reported always and fail only on a machine declared quiet
 *        (MUNDER_QUIET_TIMING_CHECKS=1); pinned here.
 *
 * Named mutants, each must fail this file:
 *   L1 the old window logic (progress compared only when a window ends)
 *   L2 stubsIdle no longer skips a dead stub
 *   L3 stubsIdle no longer skips a hung stub
 *   L4 the fake agent does not record `hung`
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Rig } = require('./mail-rig/driver.cjs');

/** A Rig on a fake clock (sleep advances it), with a scripted host and a scripted progress count. */
function fakeRig({ busy = true, progressUntil = 0 } = {}) {
  const rig = new Rig(fs.mkdtempSync(path.join(os.tmpdir(), 'lff-')));
  const clock = { t: 0 };
  rig.clock = { now: () => clock.t, sleep: async (ms) => { clock.t += ms; } };
  rig.call = async (cmd) => (cmd === 'busy' ? busy : cmd === 'inFlight' ? false : cmd === 'outcomes' ? [] : true);
  let lastChangeAt = -1; let last = null;
  rig.progress = () => {
    const v = Math.min(clock.t, progressUntil);
    if (v !== last) { last = v; lastChangeAt = clock.t; }   // when the VALUE last changed
    return v;
  };
  return { rig, clock, lastChange: () => lastChangeAt };
}

for (const mode of ['holdWhileBusy', 'holdForStubs']) {
  test(`J-LF1 (${mode}): a stall fails one bound after the LAST progress (plus at most one 80 ms poll), never a second bound later`, async () => {
    const BOUND = 1_000;
    // Progress keeps coming until t = 1 640 ms (more than one bound), then stops.
    const { rig, clock, lastChange } = fakeRig({ progressUntil: 1_640 });
    if (mode === 'holdForStubs') rig.stubsIdle = async () => false;   // the stubs stay busy
    await assert.rejects(
      rig.beatUntil(() => false, { what: 'x', settle: false, [mode]: true, busyTimeoutMs: BOUND, pauseMs: 0 }),
      /never held, and the (agent|stubs) stayed busy for 1000 ms with no stub progress/);
    // Progress really stopped at 1 640 ms (the scripted value is min(t, 1640)). Judged by the
    // absolute clock, not by when the driver happened to read progress().
    const late = clock.t - 1_640;
    assert.ok(late >= BOUND && late <= BOUND + 2 * 80, `failed ${late} ms after the last progress (the old window logic: ${3_000 - 1_640} ms here)`);
    void lastChange;
  });
}

test('J-LF1: steady progress is never a stall, however long the hold lasts', async () => {
  const { rig, clock } = fakeRig({ progressUntil: 60_000 });
  let calls = 0;
  const fn = () => clock.t >= 59_000 || (calls += 1) < 0;
  assert.equal(await rig.beatUntil(fn, { what: 'x', settle: false, holdWhileBusy: true, busyTimeoutMs: 1_000, pauseMs: 0 }), true);
});

/** A stub directory for agent `a1` with a pid file and composer.json. */
function stubWith(rig, { pid, composer }) {
  const dir = rig.stubDir('a1');
  fs.mkdirSync(dir, { recursive: true });
  if (pid !== undefined) fs.writeFileSync(path.join(dir, 'pid'), String(pid));
  fs.writeFileSync(path.join(dir, 'composer.json'), JSON.stringify(composer));
}
/** A pid that is certainly dead: a child that has already exited. */
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', windowsHide: true });
  return Number(r.stdout);
}

test('J-LF2: a KILLED stub (dead pid, stale pending) does not keep stubsIdle false; a live busy one still does', async () => {
  const { rig } = fakeRig();
  rig.agentIds = ['a1'];
  stubWith(rig, { pid: deadPid(), composer: { pending: 2, busy: true } });
  assert.equal(await rig.stubsIdle(), true, 'a dead stub has no work');
  stubWith(rig, { pid: process.pid, composer: { pending: 1, busy: true } });
  assert.equal(await rig.stubsIdle(), false, 'a LIVE stub with a job is busy, as before');
  stubWith(rig, { pid: process.pid, composer: { pending: 0 } });
  assert.equal(await rig.stubsIdle(), true);
});

test('J-LF2: a HUNG stub is skipped; unhung with a job it is busy again', async () => {
  const { rig } = fakeRig();
  rig.agentIds = ['a1'];
  stubWith(rig, { pid: process.pid, composer: { pending: 1, hung: true } });
  assert.equal(await rig.stubsIdle(), true);
  stubWith(rig, { pid: process.pid, composer: { pending: 1, hung: false } });
  assert.equal(await rig.stubsIdle(), false);
});

test('J-LF2: the fake agent records `hung` in composer.json and rewrites it on hang/unhang', () => {
  const src = fs.readFileSync(path.join(__dirname, 'mail-rig', 'fake-agent.cjs'), 'utf8');
  assert.match(src, /pending: this\.pending, shown: this\.shown, hung: this\.hung \}\)/);
  assert.match(src, /case 'hang': this\.hung = true; this\.writeComposer\(\); return;/);
  assert.match(src, /case 'unhang': this\.hung = false; this\.writeComposer\(\); return;/);
});

test('J-LF3 / RPROF: the timing checks are reported always and fail only under MUNDER_QUIET_TIMING_CHECKS=1; the re-run has a hang box', () => {
  const hj = fs.readFileSync(path.join(__dirname, 'heavy-job-lock.test.cjs'), 'utf8');
  assert.match(hj, /const RERUN_BOX_MS = 60_000;/);
  assert.match(hj, /\{ windowsHide: true, timeout: RERUN_BOX_MS, maxBuffer: 16 \* 1024 \* 1024 \}/);
  assert.match(hj, /t\.diagnostic\(`unboxed re-run took \$\{rerunMs\} ms/);
  assert.match(hj, /if \(process\.env\.MUNDER_QUIET_TIMING_CHECKS === '1'\) assert\.ok\(rerunMs < PROBE_BOX_MS/);
  const rp = fs.readFileSync(path.join(__dirname, 'renderer-profile-harness.test.cjs'), 'utf8');
  assert.match(rp, /t\.diagnostic\(`armed busy capture: \$\{b\.profile\.ms\} ms/);
  assert.match(rp, /if \(process\.env\.MUNDER_QUIET_TIMING_CHECKS === '1'\) assert\.ok\(b\.profile\.ms < 5_000/);
});
