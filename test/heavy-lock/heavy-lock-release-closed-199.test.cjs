'use strict';
require('../tools/own-job.cjs');

/**
 * HEAVY-HANDOFF-RACE, Jim's audit of 59c87898 (god, conv-9594bd, 2026-10-23): a holder's `heavy release` (e)
 * was less conservative than the watcher.
 *  MINOR 1 (P5): the holder's PTY root absent from an otherwise good listing is UNKNOWN to the watcher (no
 *      miss), but releaseHeld read only probed.busy, reported checked 'ok' and dropped the hold. (P7): a job
 *      Guppy itself holds (HeavyJobs 'held', not exited) with nothing in the listing was dropped too.
 *      Now: no PTY root in the listing is 'unseen' (refused, kept); an unexited held job is running.
 *  MINOR 2 (P6): a heavy call of the holder that began while the listing was awaited (two tool calls in one
 *      response: the re-entry was allowed) was cleared with the rest and its job ran unheld. Now the hold is
 *      kept and the call is named (`arrived`).
 * Mutants that must die: MUTANT CENSUS at the bottom.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../load-ts.cjs');
const { readSource } = require('../read-source.cjs');

const HJF = 'src/main/heavyJob.ts';
const HJ = loadTs(HJF);
const CLI = require('../../resources/heavy-cli.cjs');
const H = { heavy: true, kind: 'bench' };

function rig(M = HJ, extra = {}) {
  let now = 1_000_000; const logs = []; const notes = [];
  const l = new M.HeavyJobLock({
    limit: () => 1, now: () => now, setTimer: () => ({}), clearTimer: () => {}, log: (r) => logs.push(r),
    notify: (a) => notes.push(a), notifyLapse: () => {}, alive: () => true, ...extra
  });
  return { l, logs, notes, tick: (ms) => { now += ms; }, rows: (action) => logs.filter((r) => r.action === action), held: () => l.snapshot().map((h) => h.agentId) };
}
const reservedFor = (x) => x.l.queueSnapshot().reserved.map((r) => r.agentId);

/** A watcher rig: dwight's PTY root (pid 10) and, while `s.running`, his bench process (pid 11); `s.listing`
 *  replaces the whole listing (an otherwise good one that lacks his root: another agent's processes only). */
function watched(M = HJ) {
  const s = { running: true, listing: null };
  const root = { pid: 10, parentPid: 1, commandLine: 'bash', createdMs: 1 };
  const kid = { pid: 11, parentPid: 10, commandLine: 'bash bench.sh', createdMs: 1_000_100 };
  const x = rig(M, { roots: () => [{ agentId: 'dwight', pid: 10 }], probe: async () => s.listing ?? (s.running ? [root, kid] : [root]) });
  return { ...x, s };
}
const OTHERS = [{ pid: 20, parentPid: 1, commandLine: 'bash', createdMs: 2 }, { pid: 21, parentPid: 20, commandLine: 'node x.js', createdMs: 1_000_300 }];
const release = (x, agent, to) => x.l.lease(agent, to ? { op: 'unreserve', to } : { op: 'unreserve' });

const K = {};

K.unseen = async (M = HJ) => {
  const x = watched(M);
  x.l.acquire('dwight', H, 'bash bench.sh', 'c1', false);
  x.l.acquire('creed', H, 'bash cut.sh', 'k1', false);
  await x.l.scan();
  x.s.listing = OTHERS;                     // P5: a good listing, but dwight's own terminal is not in it (so pid 11 is forgotten too)
  const a = await release(x, 'dwight');
  assert.deepEqual(a, { state: 'unreserved', reserved: false, queued: false, next: null, held: { kind: 'bench', calls: ['c1'], pids: [], dropped: false, checked: 'unseen' } }, 'PTY ROOT ABSENT FROM THE LISTING: REFUSED AS UNSEEN (unknown, not idle)');
  assert.deepEqual(x.held(), ['dwight'], 'PTY ROOT ABSENT: THE SLOT STAYS HELD');
  assert.deepEqual(reservedFor(x), []);
  assert.deepEqual(x.rows('release-refused'), [{ kind: 'heavy-lock', action: 'release-refused', agentId: 'dwight', heavyKind: 'bench', calls: ['c1'], pids: [], checked: 'unseen' }], 'THE UNSEEN REFUSAL IS LOGGED');
  assert.deepEqual(x.rows('release'), []);
  // The same as the watcher: no miss is counted for it either.
  x.tick(M.HEAVY_SCAN_MS); await x.l.scan(); x.tick(M.HEAVY_SCAN_MS); await x.l.scan();
  assert.deepEqual(x.held(), ['dwight'], 'the watcher keeps it too (no miss without the PTY root)');
  // The listing shows the terminal again, idle: the same command releases.
  x.s.listing = null; x.s.running = false;
  assert.equal((await release(x, 'dwight')).held.dropped, true, 'SEEN IDLE AGAIN: RELEASED');
  assert.deepEqual(reservedFor(x), ['creed']);
};
test('MINOR 1 (P5): the holder\'s PTY root absent from an otherwise good listing is unknown, not idle: refused as unseen, kept', () => K.unseen());

K.heldJob = async (M = HJ) => {
  // P7: dwight's bench runs in a job Guppy holds (HeavyJobs 'held'); the listing shows nothing of it.
  const x = watched(M);
  x.l.acquire('dwight', H, 'bash bench.sh &', 'c1', true);
  x.l.noteJob('dwight', 'c1', 'job-1');
  x.l.acquire('creed', H, 'bash cut.sh', 'k1', false);
  x.s.running = false;
  const a = await release(x, 'dwight');
  assert.deepEqual(a.held, { kind: 'bench', calls: ['c1'], pids: [], dropped: false, checked: 'ok' }, 'AN UNEXITED HELD JOB RUNS: REFUSED, WHATEVER THE LISTING SHOWS');
  assert.deepEqual(x.held(), ['dwight'], 'AN UNEXITED HELD JOB: THE SLOT STAYS HELD');
  assert.deepEqual(x.rows('release-refused').map((r) => r.checked), ['ok']);
  // The job exits: freed by itself, as before.
  x.l.jobExited('dwight', 'c1', 'job-1');
  assert.deepEqual(x.rows('release').map((r) => r.reason), ['job-exit']);
  assert.deepEqual(reservedFor(x), ['creed']);
  // No watcher on the build: the held job still counts.
  const y = rig(M);
  y.l.acquire('dwight', H, 'bash bench.sh &', 'c1', true);
  y.l.noteJob('dwight', 'c1', 'job-1');
  const b = await release(y, 'dwight');
  assert.deepEqual(b.held, { kind: 'bench', calls: ['c1'], pids: [], dropped: false, checked: 'none' }, 'NO WATCHER: AN UNEXITED HELD JOB STILL REFUSES');
  assert.deepEqual(y.held(), ['dwight']);
  y.l.jobExited('dwight', 'c1', 'job-1');
  assert.deepEqual(y.held(), []);
  // One of two windows exited (the other job still runs): refused; both exited: released.
  const z = watched(M);
  z.l.acquire('dwight', H, 'bash bench.sh', 'c1', false);
  z.l.noteJob('dwight', 'c1', 'job-1');
  z.l.acquire('dwight', H, 'bash bench.sh', 'c2', false);
  z.l.noteJob('dwight', 'c2', 'job-2');
  z.s.running = false;
  z.l.jobExited('dwight', 'c1', 'job-1');
  assert.deepEqual(z.held(), ['dwight']);
  assert.equal((await release(z, 'dwight')).held.dropped, false, 'ONE JOB OF TWO STILL RUNS: REFUSED');
  z.l.jobExited('dwight', 'c2', 'job-2');
  assert.deepEqual(z.held(), []);
};
test('MINOR 1 (P7): a job Guppy holds that has not exited is running, whatever the listing shows (and with no watcher)', () => K.heldJob());

K.arrived = async (M = HJ) => {
  const x = watched(M);
  x.l.acquire('dwight', H, 'bash bench.sh', 'c1', false);
  x.l.acquire('creed', H, 'bash cut.sh', 'k1', false);
  await x.l.scan();
  x.s.running = false;                      // the bench was stopped...
  const slow = release(x, 'dwight');        // ...the release lists the processes (awaited)...
  const re = x.l.acquire('dwight', H, 'bash bench2.sh', 'a2', false);   // ...and a second heavy call of his re-enters meanwhile (P6)
  assert.equal(re.allow, true, 'the re-entry is allowed (its own slot)');
  const a = await slow;
  assert.deepEqual(a, { state: 'unreserved', reserved: false, queued: false, next: null, held: { kind: 'bench', calls: ['c1', 'a2'], pids: [], dropped: false, checked: 'ok', arrived: ['a2'] } }, 'A CALL THAT BEGAN DURING THE LISTING: REFUSED, THE ARRIVED CALL IS NAMED');
  assert.deepEqual(x.held(), ['dwight'], 'A CALL THAT BEGAN DURING THE LISTING: THE SLOT STAYS HELD');
  assert.deepEqual(reservedFor(x), [], 'nothing passed on');
  assert.deepEqual(x.rows('release-refused'), [{ kind: 'heavy-lock', action: 'release-refused', agentId: 'dwight', heavyKind: 'bench', calls: ['c1', 'a2'], pids: [], checked: 'ok', arrived: ['a2'] }], 'THE ARRIVED CALL IS LOGGED');
  assert.deepEqual(x.rows('release'), []);
  assert.equal(x.l.snapshot()[0].openCalls, 2, 'both calls stay open');
  // The new call ends (its PostToolUse): the hold stays for c1 (never settled); the same command now releases it.
  x.l.callDone('dwight', 'a2');
  assert.deepEqual(x.held(), ['dwight']);
  const b = await release(x, 'dwight');
  assert.deepEqual(b.held, { kind: 'bench', calls: ['c1'], pids: [], dropped: true, checked: 'ok' }, 'ONCE THAT CALL IS OVER, THE SAME COMMAND RELEASES');
  assert.deepEqual(reservedFor(x), ['creed']);
  // A call that ended during the listing (c1's PostToolUse came) is not "arrived": nothing is refused for it.
  const y = watched(M);
  y.l.acquire('dwight', H, 'bash bench.sh', 'c1', false);
  y.l.acquire('dwight', H, 'bash bench.sh', 'c2', false);
  y.s.running = false;
  const s2 = release(y, 'dwight');
  y.l.callDone('dwight', 'c2');
  const c = await s2;
  assert.equal(c.held.dropped, true, 'a call that ENDED during the listing is no reason to refuse');
  assert.deepEqual(c.held.calls, ['c1', 'c2']);
};
test('MINOR 2 (P6): a heavy call of the holder that began while the listing was awaited keeps the hold and is named', () => K.arrived());

test('the heavy CLI says what was not known: unseen terminal, a call that began during the check', () => {
  const base = { state: 'unreserved', reserved: false, queued: false, next: null };
  assert.equal(CLI.describe({ ...base, held: { kind: 'bench', calls: ['c1'], pids: [11], dropped: false, checked: 'unseen' } }),
    'heavy: refused: you hold the bench slot and the process listing did not show your terminal, so its job may still run (call c1); it frees when the job ends, or run heavy release again\n', 'THE CLI SAYS UNSEEN');
  assert.equal(CLI.describe({ ...base, held: { kind: 'bench', calls: ['c1', 'a2'], pids: [], dropped: false, checked: 'ok', arrived: ['a2'] } }),
    'heavy: refused: you hold the bench slot and a heavy call of yours began during the check (call a2); it frees when your job ends, or run heavy release again once that call is over\n', 'THE CLI NAMES THE ARRIVED CALL');
  assert.equal(CLI.describe({ ...base, held: { kind: 'bench', calls: ['c1'], pids: [], dropped: false, checked: 'ok' } }),
    'heavy: refused: you hold the bench slot and its job still runs (call c1); stop the job first, or it frees when the job ends\n', 'a held job with no listed pid: still "runs"');
});

// ─── MUTANT CENSUS ──────────────────────────────────────────────────────────────────────────

function mutateText(rel, edits, tag) {
  let text = readSource(rel);
  for (const [from, to] of edits) {
    const hits = text.split(from).length - 1;
    assert.equal(hits, 1, `mutant ${tag}: edit target must match EXACTLY ONCE, matched ${hits}: ${JSON.stringify(from.slice(0, 80))}`);
    text = text.replace(from, () => to);
  }
  return text;
}

const MUTANTS = [
  { name: 'a listing without the PTY root counts as idle (P5, as before)', edits: [["      else if (!probed.seen.has(agentId)) checked = 'unseen';\n", '']],
    killer: 'unseen', dies: /PTY ROOT ABSENT FROM THE LISTING: REFUSED AS UNSEEN/ },
  { name: 'unseen is refused as "still runs"', edits: [["      else if (!probed.seen.has(agentId)) checked = 'unseen';", "      else if (!probed.seen.has(agentId)) { checked = 'ok'; running = true; }"]],
    killer: 'unseen', dies: /PTY ROOT ABSENT FROM THE LISTING: REFUSED AS UNSEEN/ },
  { name: 'unseen refuses but is not refused by the gate', edits: [["    if (running || checked === 'failed' || checked === 'unseen' || arrived.length) {", "    if (running || checked === 'failed' || arrived.length) {"]],
    killer: 'unseen', dies: /PTY ROOT ABSENT FROM THE LISTING: REFUSED AS UNSEEN/ },
  { name: 'an unexited held job is idle (P7, as before)', edits: [['    if ([...cur.jobs.values()].some((js) => [...js.values()].some((exited) => !exited))) running = true;\n', '']],
    killer: 'heldJob', dies: /AN UNEXITED HELD JOB RUNS: REFUSED/ },
  { name: 'only a watched build counts the held job', edits: [['    if ([...cur.jobs.values()].some((js) => [...js.values()].some((exited) => !exited))) running = true;', "    if (checked !== 'none' && [...cur.jobs.values()].some((js) => [...js.values()].some((exited) => !exited))) running = true;"]],
    killer: 'heldJob', dies: /NO WATCHER: AN UNEXITED HELD JOB STILL REFUSES/ },
  { name: 'a call that began during the listing is dropped with the rest (P6, as before)', edits: [['    const arrived = [...cur.calls].filter((c) => !calls.includes(c));', '    const arrived: string[] = [];']],
    killer: 'arrived', dies: /A CALL THAT BEGAN DURING THE LISTING: REFUSED/ },
  { name: 'the arrived call is not named', edits: [["      return { state: 'unreserved', reserved: false, queued: false, next: null, held: { kind: cur.kind, calls: open, pids, dropped: false, checked, ...(arrived.length ? { arrived } : {}) } };", "      return { state: 'unreserved', reserved: false, queued: false, next: null, held: { kind: cur.kind, calls: open, pids, dropped: false, checked } };"]],
    killer: 'arrived', dies: /THE ARRIVED CALL IS NAMED/ },
  { name: 'the refusal names the snapshot\'s calls, not the open ones', edits: [['      const open = [...cur.calls];', '      const open = calls;']],
    killer: 'arrived', dies: /THE ARRIVED CALL IS NAMED/ },
  { name: 'the arrived call is not logged', edits: [["calls: open, pids, checked, ...(arrived.length ? { arrived } : {}) });", 'calls: open, pids, checked });']],
    killer: 'arrived', dies: /THE ARRIVED CALL IS LOGGED/ },
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  for (const m of MUTANTS) {
    await t.test(`mutant: ${m.name}`, async () => {
      const mutated = loadTs.fromText(HJF, mutateText(HJF, m.edits, m.name));
      await assert.rejects(async () => K[m.killer](mutated), (e) => {
        assert.match(String(e && e.message), m.dies, `${m.name}: died for the wrong reason: ${e && e.message}`);
        return true;
      }, `${m.name}: MUST DIE`);
    });
  }
});
