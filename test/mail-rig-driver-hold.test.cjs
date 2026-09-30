'use strict';
/**
 * MAIL-RIG-C1-FLAKE: Rig.beatUntil({ holdWhileBusy }) never moves the simulated clock while the
 * host reports a wake in flight or a turn running; it waits for the EVENT (the condition, or the
 * agent going quiet). A pure driver test: the host's `call` is stubbed, no process is started.
 *
 * Why it matters (C1/C1b): the re-wake after a Stop is a REAL process turn. Moving the clock under
 * it raced the product's simulated-time rules (SUBMIT_CONFIRM_MS, the one-time re-announce, the
 * retry backoff) against real process timing, so the test's outcome depended on machine load.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { Rig } = require('./mail-rig/driver.cjs');

/** A Rig whose host calls are scripted: `busyFor` busy readings, then quiet. */
function scripted({ busyFor = 0, holdsAfterBusy = Infinity } = {}) {
  const rig = new Rig('unused');
  const calls = [];
  let busyReads = 0;
  rig.call = async (cmd, args) => {
    calls.push({ cmd, args, busyReads });
    if (cmd === 'busy') { busyReads += 1; return busyReads <= busyFor; }
    return true;
  };
  const fn = () => busyReads >= holdsAfterBusy;
  return { rig, calls, fn };
}

test('holdWhileBusy: while the agent is busy the clock never moves; the condition arriving mid-turn ends it with no advance', async () => {
  const { rig, calls, fn } = scripted({ busyFor: 25, holdsAfterBusy: 20 });
  assert.equal(await rig.beatUntil(fn, { what: 'x', settle: false, holdWhileBusy: true, stepMs: 15_000, pauseMs: 0 }), true);
  assert.equal(calls.filter((c) => c.cmd === 'advance').length, 0, 'no advance under a busy agent');
  assert.equal(calls.filter((c) => c.cmd === 'beat').length, 0);
});

test('holdWhileBusy: once quiet, the clock moves (one step per beat), never while busy', async () => {
  const { rig, calls, fn } = scripted({ busyFor: 5, holdsAfterBusy: Infinity });
  let checks = 0;
  const cond = () => { checks += 1; return checks > 12; };
  assert.equal(await rig.beatUntil(cond, { what: 'x', settle: false, holdWhileBusy: true, stepMs: 15_000, pauseMs: 0 }), true);
  for (const c of calls.filter((x) => x.cmd === 'advance')) assert.ok(c.busyReads > 5, 'every advance came after the last busy reading');
  assert.ok(calls.some((c) => c.cmd === 'advance'), 'the clock does move once the agent is quiet');
  void fn;
});

test('holdWhileBusy: an agent that stays busy fails with that reason after busyTimeoutMs, having never moved the clock', async () => {
  const { rig, calls } = scripted({ busyFor: Infinity });
  await assert.rejects(rig.beatUntil(() => false, { what: 're-surfaced', settle: false, holdWhileBusy: true, busyTimeoutMs: 300, pauseMs: 0 }), /re-surfaced never held, and the agent stayed busy for 300 ms \(the clock was not moved under it\)/);
  assert.equal(calls.filter((c) => c.cmd === 'advance').length, 0);
});

test('without holdWhileBusy (the old settle:false) the clock moves under a busy agent: the behaviour C1 no longer uses', async () => {
  const { rig, calls } = scripted({ busyFor: Infinity });
  let n = 0;
  await rig.beatUntil(() => (n += 1) > 3, { what: 'x', settle: false, stepMs: 15_000, pauseMs: 0 });
  assert.equal(calls.filter((c) => c.cmd === 'advance').length, 3);
});

test('C1 and C1b use holdWhileBusy for their re-surface step', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, 'mail-rig-checks.test.cjs'), 'utf8');
  assert.equal((src.match(/\{ what: 're-surfaced', settle: false, holdWhileBusy: true, stepMs: 15_000 \}/g) || []).length, 2);
});
