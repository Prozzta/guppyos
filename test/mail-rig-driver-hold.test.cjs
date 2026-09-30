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

test('every settle:false step in the rig tests holds (holdWhileBusy or holdForStubs), except the deliberate old form in the A1 proof', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const offenders = [];
  for (const f of ['mail-rig-checks.test.cjs', 'mail-rig-faults.test.cjs', 'mail-rig-scenarios.test.cjs']) {
    const src = fs.readFileSync(path.join(__dirname, f), 'utf8').split(/\r?\n/);
    src.forEach((line, n) => {
      if (!/beatUntil\(/.test(line) || !/settle: false/.test(line)) return;
      if (/holdWhileBusy: true|holdForStubs: true/.test(line)) return;
      if (/'re-surfaced \(old form\)'/.test(line)) return;
      offenders.push(`${f}:${n + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
  const checks = fs.readFileSync(path.join(__dirname, 'mail-rig-checks.test.cjs'), 'utf8');
  assert.equal((checks.match(/\{ what: 're-surfaced', settle: false, holdWhileBusy: true, stepMs: 15_000 \}/g) || []).length, 3, 'C1, C1b and the A1 proof');
});

/** A Rig whose stubsIdle is scripted: `busyFor` not-idle readings, then idle. */
function stubScripted({ busyFor = 0, quiet = true } = {}) {
  const rig = new Rig('unused');
  const calls = [];
  let reads = 0;
  rig.call = async (cmd, args) => { calls.push({ cmd, args, reads }); if (cmd === 'busy') return !quiet; return true; };
  rig.stubsIdle = async () => { reads += 1; return reads > busyFor; };
  rig.quiet = async () => quiet;
  return { rig, calls, reads: () => reads };
}

test('holdForStubs: the clock moves only once the stubs are idle; the condition arriving meanwhile ends it with no advance', async () => {
  const a = stubScripted({ busyFor: 6 });
  let k = 0;
  await a.rig.beatUntil(() => (k += 1) > 3, { what: 'x', settle: false, holdForStubs: true, pauseMs: 0 });
  assert.equal(a.calls.filter((c) => c.cmd === 'advance').length, 0, 'it held while the stubs were busy');
  const b = stubScripted({ busyFor: 4 });
  let j = 0;
  await b.rig.beatUntil(() => (j += 1) > 8, { what: 'x', settle: false, holdForStubs: true, pauseMs: 0 });
  for (const c of b.calls.filter((x) => x.cmd === 'advance')) assert.ok(c.reads > 4, 'every advance came after the stubs went idle');
  assert.ok(b.calls.some((c) => c.cmd === 'advance'));
});

test('settle: when quiet() runs out, the step holds for the stubs instead of moving the clock anyway', async () => {
  const a = stubScripted({ busyFor: 5, quiet: false });
  let k = 0;
  await a.rig.beatUntil(() => (k += 1) > 10, { what: 'x', pauseMs: 0 });
  for (const c of a.calls.filter((x) => x.cmd === 'advance')) assert.ok(c.reads > 5, 'no advance while the stubs were busy');
  const b = stubScripted({ busyFor: Infinity, quiet: false });
  await assert.rejects(b.rig.beatUntil(() => false, { what: 'y', pauseMs: 0, busyTimeoutMs: 200, diag: async () => 'D' }), /y never held, and the stubs stayed busy for 200 ms \(the clock was not moved under them\)\nD/);
  assert.equal(b.calls.filter((c) => c.cmd === 'advance').length, 0);
});

test('stubsIdle: not idle while a wake is in flight, while a COMMITTED prompt is unread, or while a stub has a pending job', async () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const box = fs.mkdtempSync(path.join(os.tmpdir(), 'stubs-idle-'));
  const rig = new Rig(box);
  rig.agentIds = ['a-1'];
  let inFlight = false; let committed = 1; let read = 1; let pending = 0;
  rig.call = async (cmd) => {
    if (cmd === 'inFlight') return inFlight;
    if (cmd === 'outcomes') return Array.from({ length: committed }, () => ({ agentId: 'a-1', outcome: { kind: 'COMMITTED' } }));
    return true;
  };
  rig.prompts = () => Array.from({ length: read }, () => ({ kind: 'prompt' }));
  const setPending = () => { fs.mkdirSync(rig.stubDir('a-1'), { recursive: true }); fs.writeFileSync(path.join(rig.stubDir('a-1'), 'composer.json'), JSON.stringify({ pending })); };
  try {
    setPending();
    assert.equal(await rig.stubsIdle(), true, 'idle: nothing in flight, every prompt read, no job');
    inFlight = true; assert.equal(await rig.stubsIdle(), false, 'a wake in flight'); inFlight = false;
    committed = 2; assert.equal(await rig.stubsIdle(), false, 'a COMMITTED prompt the stub has not read yet'); committed = 1;
    pending = 1; setPending(); assert.equal(await rig.stubsIdle(), false, 'a queued or running job in the stub'); pending = 0; setPending();
    assert.equal(await rig.stubsIdle(), true);
  } finally { fs.rmSync(box, { recursive: true, force: true }); }
});
