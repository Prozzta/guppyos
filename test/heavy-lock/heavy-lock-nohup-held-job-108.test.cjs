'use strict';
require('../tools/own-job.cjs');

/**
 * HEAVY-LOCK-NOHUP-DRIVER-UNREGISTERED-108 (2026-11-21T22:55Z): a full suite run under a nohup driver
 * did not show as holding the heavy slot. The chain:
 *   1. the heavy call ran in a job Guppy holds (HeavyJobs 'held'; the lock noted it), and the job
 *      object follows the suite's processes whatever their parent;
 *   2. the nohup broke the parent chain to the agent's PTY root, so the watcher's listing showed the
 *      root (seen) and none of its processes (not busy);
 *   3. scan() counted a miss on each tick (it read only the listing), and after HEAVY_SCAN_MISSES it
 *      released the slot with 'process-exit' while the suite still ran (about 45 s in).
 * releaseHeld (`heavy release`) already counted an unexited held job as running (P7); scan() did not.
 *
 * The fix (Jim agreed the plan):
 *   - one helper, heldJobRunning(h), used by scan() AND releaseHeld, so the two cannot drift: a held
 *     job that has not exited is running, whatever the listing shows;
 *   - HeavyJobs tells the lock when it stops tracking a held job before its exit was seen (onJob
 *     'lost': the helper died or was replaced, the helper holds no such job, it never started, or
 *     HeavyJobs was disposed). The lock's jobLost drops it, loudly ('job-lost'), frees nothing, and the
 *     holder falls back to the listing (misses, then 'process-exit') and the TTL, as before.
 * Not covered, as before: an unwrapped heavy call with no held job still depends on the listing.
 *
 * No process is started: the lock's listing and the helper are fakes, on clocks the test moves.
 * Mutants that must die: MUTANT CENSUS at the bottom.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../load-ts.cjs');
const { readSource } = require('../read-source.cjs');

const HJF = 'src/main/heavyJob.ts';
const CPUF = 'src/main/heavyCpu.ts';
const BASE = { L: loadTs(HJF), C: loadTs(CPUF) };
const H = { heavy: true, kind: 'bench' };
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

/** The lock with dwight's PTY root (pid 10) always listed and, while `s.running`, a process of his
 *  attributed to it (pid 11). The nohup'd suite is NOT in the listing under his root: s.running false
 *  is exactly what the watcher saw. `s.listing` replaces the whole listing; `s.fail` makes it fail. */
function lockRig(L) {
  let now = 1_000_000; const logs = [];
  const s = { running: false, listing: null, fail: false };
  const root = { pid: 10, parentPid: 1, commandLine: 'bash', createdMs: 1 };
  const kid = { pid: 11, parentPid: 10, commandLine: 'bash suite.sh', createdMs: 1_000_100 };
  const probe = async () => (s.fail ? null : s.listing ?? (s.running ? [root, kid] : [root]));
  const l = new L.HeavyJobLock({
    limit: () => 1, now: () => now, setTimer: () => ({}), clearTimer: () => {}, log: (r) => logs.push(r),
    notify: () => {}, notifyLapse: () => {}, alive: () => true,
    roots: () => [{ agentId: 'dwight', pid: 10 }], probe
  });
  const rows = (action) => logs.filter((r) => r.action === action);
  const held = () => l.snapshot().map((h) => h.agentId);
  const scanAfter = async (ms) => { now += ms; await l.scan(); };
  return { l, logs, s, probe, rows, held, scanAfter, tick: (ms) => { now += ms; } };
}
const OTHERS = [{ pid: 20, parentPid: 1, commandLine: 'bash', createdMs: 2 }, { pid: 21, parentPid: 20, commandLine: 'node x.js', createdMs: 1_000_300 }];
const release = (x, agent) => x.l.lease(agent, { op: 'unreserve' });

/** The serve helper as it is (heavycpu-serve-req-timeout-108's fake, cut down): a job table per helper
 *  process; `h.dead` is a helper that is gone (its channel answers null and says dead()). */
function helperWorld() {
  const world = { helpers: [], rowsOf: new Map(), wedged: false };
  world.start = () => {
    const h = { known: new Set(), closed: false, dead: false, reqs: [] };
    world.helpers.push(h);
    return {
      async request(line) {
        h.reqs.push(line);
        if (h.closed || h.dead || world.wedged) return null;
        const [cmd, id] = line.split(' ');
        if (cmd === 'create') { h.known.add(id); return { ok: true }; }
        if (cmd === 'close') { h.known.delete(id); return { ok: true }; }
        if (!h.known.has(id)) return { ok: false, error: `no job ${id}` };
        if (cmd === 'list') return { ok: true, rows: world.rowsOf.get(id) ?? [] };
        return { ok: true };
      },
      close() { h.closed = true; h.known.clear(); },
      onEvent() {},
      dead() { return h.dead; }
    };
  };
  return world;
}

/** The main-process routing, word for word (index.ts; pinned below by MAIN_ROUTE). */
const MAIN_ROUTE = "onJob: (e) => { if (e.state === 'held') heavyLock.noteJob(e.agentId, e.callId, e.job); else if (e.state === 'lost') heavyLock.jobLost(e.agentId, e.callId, e.job, e.why); else heavyLock.jobExited(e.agentId, e.callId, e.job); }";

/** HeavyJobs on a fake helper and a moved clock. `lock`: a lockRig to route onJob into as main does. */
function jobsRig(C, lock = null) {
  let now = 5_000_000;
  const world = helperWorld();
  const told = [], logs = [];
  const heavyLock = lock ? lock.l : null;
  const jobs = new C.HeavyJobs({
    platform: 'win32', options: () => ({ background: false, half: false }), exe: () => 'guppy-heavyjob.exe',
    channel: () => world.start(), now: () => now,
    setInterval: () => ({ poll: true }), clearInterval: () => {},
    setTimeout: () => 0, clearTimeout: () => {}, log: (row) => logs.push(row),
    onJob: (e) => {
      told.push(e);
      if (heavyLock) { if (e.state === 'held') heavyLock.noteJob(e.agentId, e.callId, e.job); else if (e.state === 'lost') heavyLock.jobLost(e.agentId, e.callId, e.job, e.why); else heavyLock.jobExited(e.agentId, e.callId, e.job); }
    }
  });
  const lost = () => told.filter((e) => e.state === 'lost').map((e) => [e.callId, e.why]);
  return { world, told, logs, jobs, lost, tick: (ms) => { now += ms; } };
}

/** The ways HeavyJobs stops tracking a held job before its exit is seen. `j`: a jobsRig with one held job. */
const LOSE = {
  'helper-dead': async (j) => { j.world.helpers[0].dead = true; await j.jobs.poll(); },
  'no-job': async (j) => { j.world.helpers[0].known.clear(); await j.jobs.poll(); },
  'never-started': async (j, C) => { j.tick(C.HEAVY_JOB_UNSTARTED_MS); await j.jobs.poll(); },
  dispose: async (j) => { j.jobs.dispose(); await settle(); }
};

const K = {};

K.nohup = async ({ L }) => {
  const x = lockRig(L);
  x.l.acquire('dwight', H, 'nohup bash suite.sh > suite.log 2>&1 &', 'c1', true);
  x.l.noteJob('dwight', 'c1', 'job-1');
  for (let i = 0; i < 3; i++) {
    await x.scanAfter(L.HEAVY_SCAN_MS);
    // Jim's control: the listing is good and shows dwight's root, so a red here is the miss path, not probe-failed.
    const probed = await x.l.heavyAgents({ procs: await x.probe() });
    assert.ok(probed && probed.seen.has('dwight') && !probed.busy.has('dwight'), 'control: the root is seen, no process of his is attributed');
  }
  assert.deepEqual(x.held(), ['dwight'], 'A HELD JOB THAT HAS NOT EXITED KEEPS THE SLOT, WHATEVER THE LISTING SHOWS (the nohup case)');
  assert.deepEqual(x.rows('release'), []);
  // Its exit frees it, as before.
  x.l.jobExited('dwight', 'c1', 'job-1');
  assert.deepEqual(x.rows('release').map((r) => r.reason), ['job-exit'], 'the job exit frees it');
};
test('C1: a nohup\'d suite in a held job keeps the slot over 3 scans of a good listing that shows none of it; its exit frees it', () => K.nohup(BASE));

K.ttl = async ({ L }) => {
  const x = lockRig(L);
  x.l.acquire('dwight', H, 'nohup bash suite.sh &', 'c1', true);
  x.l.noteJob('dwight', 'c1', 'job-1');
  const n = Math.ceil(L.HEAVY_TTL_MS / L.HEAVY_SCAN_MS) + 3;
  for (let i = 0; i < n; i++) await x.scanAfter(L.HEAVY_SCAN_MS);
  assert.deepEqual(x.held(), ['dwight'], 'A TRACKED JOB RENEWS THE TTL: still held past HEAVY_TTL_MS');
  const renewed = x.rows('ttl-renewed').length;
  assert.ok(renewed >= 1, 'A TRACKED JOB RENEWS THE TTL: renewed and logged');
  // Lost, with the root out of the listing (no miss can free it): the renewal stops and the TTL frees it.
  x.l.jobLost('dwight', 'c1', 'job-1', 'helper-dead');
  x.s.listing = OTHERS;
  for (let i = 0; i < 2 * n; i++) await x.scanAfter(L.HEAVY_SCAN_MS);   // the owed renewal, then one blind TTL
  // Jim HHR MINOR 3 as it is: the last sighting (just before the loss) is owed its one renewal; after
  // that the hold is blind, logged 'ttl-blind', and expires.
  assert.equal(x.rows('ttl-renewed').length, renewed + 1, 'A LOST JOB RENEWS NOTHING (only the last sighting\'s one renewal)');
  assert.equal(x.rows('ttl-blind').length, 1, 'the blind expiry is logged');
  assert.deepEqual(x.rows('release').map((r) => r.reason), ['ttl'], 'a lost job, never seen again: the TTL frees it');
};
test('C2: the TTL is renewed past HEAVY_TTL_MS only while the job is tracked; once it is lost the renewal stops', () => K.ttl(BASE));

// Jim MUST ddba39: the listing fails (probe-failed) for more than 2 x HEAVY_TTL_MS while the job is tracked.
K.blind = async ({ L }) => {
  const x = lockRig(L);
  x.l.acquire('dwight', H, 'nohup bash suite.sh &', 'c1', true);
  x.l.noteJob('dwight', 'c1', 'job-1');
  x.s.fail = true;
  const n = Math.ceil(2 * L.HEAVY_TTL_MS / L.HEAVY_SCAN_MS) + 3;
  for (let i = 0; i < n; i++) await x.scanAfter(L.HEAVY_SCAN_MS);
  assert.deepEqual(x.held(), ['dwight'], 'A TRACKED JOB IS SIGHTED ON A FAILED LISTING: still held past 2 x HEAVY_TTL_MS');
  assert.deepEqual(x.rows('release'), [], 'A TRACKED JOB IS SIGHTED ON A FAILED LISTING: no release');
  assert.equal(x.rows('ttl-blind').length, 0, 'A TRACKED JOB IS SIGHTED ON A FAILED LISTING: no ttl-blind');
  assert.equal(x.rows('ttl-renewed').length, 2, 'A TRACKED JOB IS SIGHTED ON A FAILED LISTING: the TTL renewed each hour');
  assert.equal(x.rows('probe-failed').length, n, 'control: every listing failed (one probe-failed row per scan)');
  x.l.jobExited('dwight', 'c1', 'job-1');
  assert.deepEqual(x.rows('release').map((r) => r.reason), ['job-exit'], 'the job exit frees it');
};
test('C8: a listing that fails for 2 x HEAVY_TTL_MS: a tracked job is still a sighting (renewed each hour, no ttl-blind); its exit frees it', () => K.blind(BASE));

K.exited = async ({ L }) => {
  const x = lockRig(L);
  x.l.acquire('dwight', H, 'bash suite.sh', 'c1', false);
  x.l.noteJob('dwight', 'c1', 'job-1');
  x.l.acquire('dwight', H, 'bash bench.sh', 'c2', false);   // a second window with no job
  x.l.jobExited('dwight', 'c1', 'job-1');
  assert.deepEqual(x.held(), ['dwight'], 'one window had no job: not freed on the job exit');
  await x.scanAfter(L.HEAVY_SCAN_MS);
  await x.scanAfter(L.HEAVY_SCAN_MS);
  assert.deepEqual(x.rows('release').map((r) => r.reason), ['process-exit'], 'AN EXITED JOB IS NOT RUNNING: nothing listed, released after the misses');
};
test('C3: an exited job and a window with no job, nothing listed: still released \'process-exit\' after HEAVY_SCAN_MISSES', () => K.exited(BASE));

K.agree = async ({ L }) => {
  const x = lockRig(L);
  x.l.acquire('dwight', H, 'nohup bash suite.sh &', 'c1', true);
  x.l.noteJob('dwight', 'c1', 'job-1');
  const a = await release(x, 'dwight');
  assert.equal(a.held.dropped, false, 'RELEASE AND SCAN AGREE: heavy release refuses while the held job runs');
  for (let i = 0; i < 3; i++) await x.scanAfter(L.HEAVY_SCAN_MS);
  assert.deepEqual(x.held(), ['dwight'], 'RELEASE AND SCAN AGREE: the watcher keeps it too');
  x.l.jobLost('dwight', 'c1', 'job-1', 'no-job');
  const b = await release(x, 'dwight');
  assert.equal(b.held.dropped, true, 'RELEASE AND SCAN AGREE: lost, and nothing listed: heavy release frees it');
};
test('C4: releaseHeld and scan() agree on a held job (one helper): both keep it while it runs; lost, release frees it', () => K.agree(BASE));

/** C5/C6: HeavyJobs and the lock wired as main wires them; `why`: how the job is lost. */
async function lostFallsBack({ L, C }, why) {
  const x = lockRig(L);
  const j = jobsRig(C, x);
  x.l.acquire('dwight', H, 'nohup bash suite.sh &', 'c1', true);
  await j.jobs.begin('dwight', { command: 'nohup bash suite.sh &' }, false, 'c1');
  const id = j.jobs.ids()[0];
  assert.ok(id, `${why}: the job is held`);
  j.world.rowsOf.set(id, [{ pid: 30, name: 'bash.exe', createdMs: 5_000_100 }]);
  if (why !== 'never-started') await j.jobs.poll();   // the suite runs in it
  await x.scanAfter(L.HEAVY_SCAN_MS);
  await x.scanAfter(L.HEAVY_SCAN_MS);
  assert.deepEqual(x.held(), ['dwight'], `${why}: held while the job is tracked`);
  if (why === 'never-started') j.world.rowsOf.set(id, []);
  await LOSE[why](j, C);
  assert.deepEqual(j.lost(), [['c1', why]], `HEAVYJOBS TELLS THE LOCK THE JOB IS LOST (${why})`);
  const row = x.rows('job-lost');
  assert.deepEqual(row.map((r) => [r.agentId, r.job, r.why, r.heavyKind]), [['dwight', id, why, 'bench']], `THE LOCK DROPS THE LOST JOB, LOGGED (${why})`);
  assert.deepEqual(x.rows('release'), [], `${why}: a lost job frees nothing by itself`);
  await x.scanAfter(L.HEAVY_SCAN_MS);
  await x.scanAfter(L.HEAVY_SCAN_MS);
  assert.deepEqual(x.rows('release').map((r) => r.reason), ['process-exit'], `A LOST JOB FALLS BACK TO THE LISTING (${why}): released after the misses`);
  assert.deepEqual(x.rows('ttl-renewed'), [], `${why}: no renewal`);
}
K.lost = async (M) => { for (const why of ['helper-dead', 'no-job']) await lostFallsBack(M, why); };
test('C5: a held job lost with its helper (dead, or no such job): the lock is told, logs job-lost and falls back to the listing', () => K.lost(BASE));
K.lostOther = async (M) => { for (const why of ['never-started', 'dispose']) await lostFallsBack(M, why); };
test('C6: never-started and dispose give the same fallback', () => K.lostOther(BASE));

K.tells = async ({ C }) => {
  for (const why of Object.keys(LOSE)) {
    const j = jobsRig(C);
    await j.jobs.begin('dwight', { command: 'npm test' }, false, 'c1');
    await j.jobs.begin('dwight', { command: 'npm test' }, false, null);   // no call id: nothing to tell
    if (why !== 'never-started') { for (const id of j.jobs.ids()) j.world.rowsOf.set(id, [{ pid: 30, name: 'node.exe', createdMs: 5_000_100 }]); await j.jobs.poll(); }
    await LOSE[why](j, C);
    assert.deepEqual(j.told.filter((e) => e.state === 'lost'), [{ agentId: 'dwight', callId: 'c1', job: j.told[0].job, state: 'lost', why }], `HEAVYJOBS EMITS onJob 'lost' ONCE, WITH WHY (${why})`);
  }
  // A wedged helper replaced after HEAVY_JOB_UNANSWERED_DEAD unanswered requests: the same notice.
  const w = jobsRig(C);
  await w.jobs.begin('dwight', { command: 'npm test' }, false, 'c1');
  w.world.wedged = true;
  for (let i = 0; i < C.HEAVY_JOB_UNANSWERED_DEAD; i++) await w.jobs.poll();
  assert.deepEqual(w.lost(), [['c1', 'helper-unanswered']], "HEAVYJOBS EMITS onJob 'lost' ONCE, WITH WHY (helper-unanswered)");
  // A job whose exit was told is not lost afterwards.
  const e = jobsRig(C);
  await e.jobs.begin('dwight', { command: 'npm test' }, false, 'c1');
  const id = e.jobs.ids()[0];
  e.world.rowsOf.set(id, [{ pid: 30, name: 'node.exe', createdMs: 5_000_100 }]);
  await e.jobs.poll();
  e.world.rowsOf.set(id, []);
  for (let i = 0; i < 4; i++) await e.jobs.poll();
  e.jobs.dispose();
  assert.deepEqual(e.told.map((t) => t.state), ['held', 'exited'], 'an exited job is never told lost');
};
test('C7: HeavyJobs emits onJob \'lost\' (with why) from lose(), never-started and dispose(); never for an exited job', () => K.tells(BASE));

test('main routes onJob \'lost\' to the lock\'s jobLost (the routing the C5/C6 rig mirrors)', () => {
  assert.ok(readSource('src/main/index.ts').includes(MAIN_ROUTE), 'MAIN ROUTES LOST TO jobLost');
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

const SCAN_LINE = '      if (busy.has(h.agentId) || this.heldJobRunning(h)) { h.misses = 0; h.seenRunning = true; h.seenAt = t; continue; }';
const PRE_LINE = '    for (const h of held) if (this.holders.has(h.agentId) && this.heldJobRunning(h)) { h.misses = 0; h.seenRunning = true; h.seenAt = tj; }\n';
const MUTANTS = [
  { name: 'M1: scan() reads only the listing (the bug)', file: HJF, edits: [[PRE_LINE, ''], [SCAN_LINE, '      if (busy.has(h.agentId)) { h.misses = 0; h.seenRunning = true; h.seenAt = t; continue; }']],
    killer: 'nohup', dies: /A HELD JOB THAT HAS NOT EXITED KEEPS THE SLOT/ },
  { name: 'M2: the helper counts exited jobs as running', file: HJF, edits: [['[...js.values()].some((exited) => !exited));\n  }', '[...js.values()].some((exited) => exited));\n  }']],
    killer: 'exited', dies: /AN EXITED JOB IS NOT RUNNING/ },
  { name: 'M3: a held job keeps the slot but is not a sighting (seenAt unset)', file: HJF, edits: [[PRE_LINE, PRE_LINE.replace(' h.seenAt = tj;', '')], [SCAN_LINE, '      if (busy.has(h.agentId)) { h.misses = 0; h.seenRunning = true; h.seenAt = t; continue; }\n      if (this.heldJobRunning(h)) { h.misses = 0; h.seenRunning = true; continue; }']],
    killer: 'ttl', dies: /A TRACKED JOB RENEWS THE TTL/ },
  { name: 'M4: releaseHeld stops using the helper', file: HJF, edits: [['    if (this.heldJobRunning(cur)) running = true;\n', '']],
    killer: 'agree', dies: /RELEASE AND SCAN AGREE: heavy release refuses/ },
  { name: 'M5: lose() sends no \'lost\' notice', file: CPUF, edits: [["    if (j.callId && !j.exited) this.tell(j.agentId, j.callId, j.id, 'lost', why);\n", '']],
    killer: 'lost', dies: /HEAVYJOBS TELLS THE LOCK THE JOB IS LOST \(helper-dead\)/ },
  { name: 'M5b: lose() sends no \'lost\' notice (the HeavyJobs side alone)', file: CPUF, edits: [["    if (j.callId && !j.exited) this.tell(j.agentId, j.callId, j.id, 'lost', why);\n", '']],
    killer: 'tells', dies: /HEAVYJOBS EMITS onJob 'lost' ONCE, WITH WHY \(helper-dead\)/ },
  { name: 'M6: the lock ignores \'lost\'', file: HJF, edits: [['    if (!h || !js || js.get(job) !== false) return;\n    js.delete(job);', '    if (!h || !js || js.get(job) !== false) return;\n    return;']],
    killer: 'lost', dies: /THE LOCK DROPS THE LOST JOB, LOGGED \(helper-dead\)/ },
  { name: 'M7: the held-job sighting only after the probe-failed return (2262d076)', file: HJF, edits: [[PRE_LINE, '']],
    killer: 'blind', dies: /A TRACKED JOB IS SIGHTED ON A FAILED LISTING/ },
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  for (const m of MUTANTS) {
    await t.test(`mutant: ${m.name}`, async () => {
      const mods = { ...BASE, [m.file === HJF ? 'L' : 'C']: loadTs.fromText(m.file, mutateText(m.file, m.edits, m.name)) };
      await assert.rejects(async () => K[m.killer](mods), (e) => {
        assert.match(String(e && e.message), m.dies, `${m.name}: died for the wrong reason: ${e && e.message}`);
        return true;
      }, `${m.name}: MUST DIE`);
    });
  }
});
