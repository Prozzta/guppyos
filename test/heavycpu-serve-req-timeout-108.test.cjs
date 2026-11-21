'use strict';
require('./tools/own-job.cjs');
/**
 * HEAVYCPU-SERVE-REQ-TIMEOUT-DROPS-ALL-JOBS-108: one request the serve helper does not answer made
 * HeavyJobs lose every running job for good.
 *
 * The chain as it was (src/main/heavyCpu.ts, resources/heavyjob/guppy-heavyjob.cs):
 *   1. serveChannel gives up on a request after HEAVY_JOB_REQUEST_MS and resolves null.
 *   2. HeavyJobs.req() read null as a dead helper and closed the channel. That ends the helper's
 *      stdin; Serve() returns, and with it go the handles of EVERY job that helper held.
 *   3. The next request starts a new helper. Its job table is empty: `list <id>` of a job the old
 *      helper made answers {"ok":false,"error":"no job <id>"}.
 *   4. confirmExit and poll both read a failed list as "says nothing" and count no miss, so the job
 *      was never reported as exited and stayed tracked.
 * In the app the heavy lock then waits for its own watcher (the lag HEAVY-LOCK-RELEASE-LAG-197
 * removed).
 *
 * The fix, all in heavyCpu.ts (the helper is not changed):
 *   - an unanswered request closes nothing. The helper is replaced only when it is gone (the
 *     channel says so), or when HEAVY_JOB_UNANSWERED_DEAD requests in a row got no answer (a helper
 *     that still runs but is wedged; any answer starts the count again). No timer, no retry;
 *   - the jobs of a replaced helper, and a job the helper answers `no job <id>` for, are let go as
 *     'lost'. 'exited' is NOT told for them: processes of the call may still run, and telling it
 *     frees the heavy slot at once. The lock's own watcher frees the slot;
 *   - a create that went unanswered is followed by a `close` of that id, so a helper that carries
 *     the create out late keeps no handle Guppy does not track.
 *
 * The fakes below are the helper as it is: a job table per helper process, lost when its channel is
 * closed. Nothing in the fake cells waits on wall time: the unanswered request is the null the real
 * channel resolves, and the confirm runs on a clock the test moves. The first two cells were the
 * red-before (51c8cd4e).
 *
 * HEAVYJOBS-DISPOSE-RESPAWNS-SERVE-108 (the DISPOSE cells): dispose() closed the helper and forgot
 * it, but nothing said "disposed". Anything that asked the helper afterwards started a NEW one:
 *   1. poll, confirmExit and begin await req() in loops; req() calls channel(); channel() starts a
 *      helper whenever none is held.
 *   2. So a poll in flight at dispose (its next job's list), an exit notice that lands after it, or
 *      a begin after it each started a serve helper nobody closes. Its stdin pipe stays open: the
 *      helper waits on it for good and the open pipe keeps the parent process alive.
 *   3. A begin after dispose also held its job on that helper and armed the poll interval again.
 * The fix: a disposed flag. Once set, channel() returns null (every request then answers null and
 * nothing is started) and arm() does nothing.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { removeDir } = require('./tools/test-temp.cjs');
const loadTs = require('./load-ts.cjs');

const root = path.join(__dirname, '..');
const CPU_FILE = 'src/main/heavyCpu.ts';
const C = loadTs(CPU_FILE);
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\r\n/g, '\n');
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

/** A clock with timers that run only when the test moves it. */
function fakeClock(start = 1_000_000) {
  let now = start, seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    async tick(ms) {
      now += ms;
      for (const [id, t] of [...timers]) if (t.at <= now && timers.has(id)) { timers.delete(id); t.fn(); }
      await settle();
    }
  };
}

/** The serve helper as it is: each helper process has its own job table, and closing its channel
 *  ends it. `world.rows(id)` is what Windows holds in the job, whichever helper asks.
 *  - `world.unanswered` names one request line the running helper never answers (the real channel
 *    resolves null for it after HEAVY_JOB_REQUEST_MS);
 *  - `world.wedged`: the helper runs but answers nothing;
 *  - `h.dead`: that helper process is gone (the real channel then answers null and says dead());
 *  - `world.answer(line, h)`: the answer to this one request, when it returns one (it may be a
 *    promise, for an answer the test holds back). */
function helperWorld() {
  const world = { helpers: [], rowsOf: new Map(), unanswered: null, wedged: false, answer: null, rows: (id) => world.rowsOf.get(id) ?? [] };
  world.start = () => {
    const h = { known: new Set(), closed: false, dead: false, reqs: [], listener: null };
    world.helpers.push(h);
    h.ch = {
      async request(line) {
        h.reqs.push(line);
        if (h.closed || h.dead) return null;
        if (world.wedged) return null;
        if (world.unanswered !== null && line === world.unanswered) { world.unanswered = null; return null; }
        const own = world.answer ? world.answer(line, h) : undefined;
        if (own !== undefined) return await own;
        const [cmd, id] = line.split(' ');
        if (cmd === 'create') { h.known.add(id); return { ok: true }; }
        if (cmd === 'close') { h.known.delete(id); return { ok: true }; }
        if (!h.known.has(id)) return { ok: false, error: `no job ${id}` };
        if (cmd === 'list') return { ok: true, rows: world.rows(id) };
        return { ok: true };
      },
      close() { h.closed = true; h.known.clear(); },
      onEvent(fn) { h.listener = fn; },
      dead() { return h.dead; }
    };
    return h.ch;
  };
  /** A notice from the helper that holds the job (a closed or dead helper writes nothing). */
  world.emit = (e) => { for (const h of world.helpers) if (!h.closed && !h.dead && h.known.has(e.job) && h.listener) h.listener(e); };
  return world;
}

/** `Cm`: the heavyCpu module under test (the product, or a mutant of it). */
function rig(Cm) {
  const clock = fakeClock();
  const world = helperWorld();
  const told = [], logs = [];
  const poll = { armed: 0 };   // poll timers set and not cleared
  const jobs = new Cm.HeavyJobs({
    platform: 'win32', options: () => ({ background: false, half: false }), exe: () => 'guppy-heavyjob.exe',
    channel: () => world.start(), now: clock.now,
    setInterval: () => { poll.armed++; return { poll: true }; }, clearInterval: () => { poll.armed--; },
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, log: (row) => logs.push(row),
    onJob: (e) => told.push(e)
  });
  const exited = () => told.filter((e) => e.state === 'exited').map((e) => e.job);
  const held = () => told.filter((e) => e.state === 'held').map((e) => e.callId);
  const lost = () => logs.filter((x) => x.action === 'lost').map((x) => [x.job, x.why]);
  return { clock, world, told, logs, poll, jobs, exited, held, lost };
}

const proc = (clock, pid) => ({ pid, name: 'node.exe', createdMs: clock.now() + 5 });

/** The cells. Each takes the module, so the census below can run it against a mutant. */
const K = {};

K.endsAfterUnanswered = async (Cm) => {
  const r = rig(Cm);
  await r.jobs.begin('agent-a', { command: 'npm ci' }, false, 'call-1');
  const id = r.jobs.ids()[0];
  r.world.rowsOf.set(id, [proc(r.clock, 9), proc(r.clock, 10)]);
  await r.jobs.poll();                                   // the call is running in its job
  // One process of the job exits; the confirm's list is the request the helper does not answer.
  r.world.rowsOf.set(id, [proc(r.clock, 10)]);
  r.world.unanswered = `list ${id}`;
  r.world.emit({ event: 'exit', job: id, msg: 7, pid: 9 });
  await r.clock.tick(Cm.HEAVY_JOB_EXIT_CONFIRM_MS);
  assert.equal(r.world.unanswered, null, 'the confirm sent the list that went unanswered');
  assert.deepEqual(r.exited(), [], 'an unanswered list says nothing');
  // The job ends. Its notices are the helper's to write; the poll is the fallback for a notice that
  // never comes. Neither may be lost because one earlier request went unanswered.
  r.world.rowsOf.set(id, []);
  r.world.emit({ event: 'exit', job: id, msg: 7, pid: 10 });
  r.world.emit({ event: 'exit', job: id, msg: 4, pid: 0 });
  await r.clock.tick(Cm.HEAVY_JOB_EXIT_CONFIRM_MS);
  for (let i = 0; i < 4; i++) await r.jobs.poll();
  const lastHelper = r.world.helpers[r.world.helpers.length - 1];
  const last = lastHelper.reqs.filter((l) => l.startsWith('list ')).length;
  assert.deepEqual(r.exited(), [id], `A JOB THAT ENDED IS REPORTED EVEN AFTER ONE REQUEST WENT UNANSWERED (not reported after its exit notices and 4 polls; ${r.world.helpers.length} helper(s) were started, the last one was asked to list ${last} time(s) and knows ${lastHelper.known.size} job(s))`);
  assert.deepEqual(r.jobs.ids(), [], 'a job that ended is not tracked for good');
  assert.equal(r.world.helpers.length, 1, 'and the helper was never replaced');
};

K.othersKept = async (Cm) => {
  const r = rig(Cm);
  await r.jobs.begin('agent-a', { command: 'npm ci' }, false, 'call-a');
  await r.jobs.begin('agent-b', { command: 'npm test' }, false, 'call-b');
  const [a, b] = r.jobs.ids();
  r.world.rowsOf.set(a, [proc(r.clock, 9)]);
  r.world.rowsOf.set(b, [proc(r.clock, 20)]);
  await r.jobs.poll();
  // Job A's list goes unanswered. Job B had nothing to do with that request.
  r.world.unanswered = `list ${a}`;
  await r.jobs.poll();
  assert.equal(r.world.unanswered, null, 'the poll sent the list that went unanswered');
  // Job B ends.
  r.world.rowsOf.set(b, []);
  r.world.emit({ event: 'exit', job: b, msg: 7, pid: 20 });
  r.world.emit({ event: 'exit', job: b, msg: 4, pid: 0 });
  await r.clock.tick(Cm.HEAVY_JOB_EXIT_CONFIRM_MS);
  for (let i = 0; i < 4; i++) await r.jobs.poll();
  assert.deepEqual(r.exited(), [b], `ANOTHER JOB'S EXIT IS REPORTED AFTER A REQUEST ABOUT A DIFFERENT JOB WENT UNANSWERED (job B not reported after its exit notices and 4 polls; ${r.world.helpers.length} helper(s) were started)`);
  assert.ok(r.jobs.ids().includes(a), 'job A is still running and still tracked');
};

/** The helper process is gone: it is replaced at once, and its jobs can never be read again. */
K.deadHelper = async (Cm) => {
  const r = rig(Cm);
  await r.jobs.begin('agent-a', { command: 'npm ci' }, false, 'call-a');
  await r.jobs.begin('agent-b', { command: 'npm test' }, false, 'call-b');
  const [a, b] = r.jobs.ids();
  r.world.rowsOf.set(a, [proc(r.clock, 9)]);
  r.world.rowsOf.set(b, [proc(r.clock, 20)]);
  await r.jobs.poll();
  const h0 = r.world.helpers[0];
  h0.dead = true;
  await r.jobs.poll();
  assert.equal(h0.closed, true, 'A DEAD HELPER IS REPLACED AT ONCE (its channel was not closed after one request to it)');
  assert.deepEqual(r.jobs.ids(), [], `THE JOBS OF A DEAD HELPER ARE LET GO (still tracked: ${r.jobs.ids().length}; ${r.world.helpers.length} helper(s) were started)`);
  assert.deepEqual(r.lost(), [[a, 'helper-dead'], [b, 'helper-dead']], 'each is logged once as lost, with the reason');
  // The processes of both calls still run. Nobody can see them end, so nobody may say they did.
  assert.deepEqual(r.exited(), [], 'A JOB LOST WITH ITS HELPER IS NOT TOLD AS EXITED (the lock would free the slot under live processes)');
  assert.equal(r.poll.armed, 0, 'no poll timer is left with nothing to poll');
  assert.equal(r.world.helpers.length, 1, 'no new helper is started while there is nothing to ask');
  // The next heavy call gets a new helper and is held by it.
  await r.jobs.begin('agent-c', { command: 'npm ci' }, false, 'call-c');
  assert.equal(r.world.helpers.length, 2, 'the next request starts a new helper');
  assert.deepEqual(r.held(), ['call-a', 'call-b', 'call-c'], 'and its job is held');
  assert.equal(r.jobs.ids().length, 1);
  assert.equal(r.poll.armed, 1, 'and polled');
};

/** The same, found by a confirm: the poll's own "nothing left: stop the timer" does not run then. */
K.deadInConfirm = async (Cm) => {
  const r = rig(Cm);
  await r.jobs.begin('agent-a', { command: 'npm ci' }, false, 'call-a');
  const a = r.jobs.ids()[0];
  r.world.rowsOf.set(a, [proc(r.clock, 9)]);
  await r.jobs.poll();
  assert.equal(r.poll.armed, 1, 'a tracked job is polled');
  r.world.emit({ event: 'exit', job: a, msg: 7, pid: 9 });   // its last notice, then the helper dies
  r.world.helpers[0].dead = true;
  await r.clock.tick(Cm.HEAVY_JOB_EXIT_CONFIRM_MS);
  assert.deepEqual(r.jobs.ids(), [], 'the confirm found the helper dead and let the job go');
  assert.deepEqual(r.exited(), [], 'without telling an exit');
  assert.equal(r.poll.armed, 0, 'THE POLL TIMER STOPS WHEN A CONFIRM LOSES THE LAST JOB (it would run for good with nothing to poll)');
};

/** The helper answers that it holds no job of that id: the job can never be read, by anyone. */
K.noJob = async (Cm) => {
  const r = rig(Cm);
  await r.jobs.begin('agent-a', { command: 'npm ci' }, false, 'call-a');
  await r.jobs.begin('agent-b', { command: 'npm test' }, false, 'call-b');
  const [a, b] = r.jobs.ids();
  r.world.rowsOf.set(a, [proc(r.clock, 9)]);
  r.world.rowsOf.set(b, [proc(r.clock, 20)]);
  await r.jobs.poll();
  const h = r.world.helpers[0];
  h.known.delete(a);                                        // the helper no longer holds job A
  // Job B's list is answered with an error that names ANOTHER job. That says nothing about B.
  r.world.answer = (line) => (line === `list ${b}` ? { ok: false, error: `no job ${a}` } : undefined);
  await r.jobs.poll();
  assert.ok(!r.jobs.ids().includes(a), 'A JOB THE HELPER SAYS IT DOES NOT HOLD IS LET GO (job A is still tracked after a poll answered "no job" for it)');
  assert.ok(r.jobs.ids().includes(b), "ONLY THE HELPER'S ANSWER ABOUT THIS JOB LETS IT GO (job B was dropped on an error that names job A)");
  assert.deepEqual(r.lost(), [[a, 'no-job']]);
  assert.deepEqual(r.exited(), [], 'no exit is told for it');
  assert.equal(r.world.helpers.length, 1, 'and the helper, which answers, is kept');
  // The same answer to a confirm's list.
  r.world.answer = null;
  r.world.emit({ event: 'exit', job: b, msg: 7, pid: 20 });
  h.known.delete(b);
  await r.clock.tick(Cm.HEAVY_JOB_EXIT_CONFIRM_MS);
  assert.deepEqual(r.jobs.ids(), [], 'A CONFIRM ANSWERED NO JOB LETS THE JOB GO (job B is still tracked)');
  assert.deepEqual(r.exited(), [], 'again with no exit told');
  assert.equal(r.poll.armed, 0, 'and the poll timer is stopped');
};

/** A helper that runs but answers nothing: kept for K - 1 unanswered requests in a row, replaced on
 *  the K-th. No timer is involved: only requests that were made are counted. */
K.wedged = async (Cm) => {
  const k = Cm.HEAVY_JOB_UNANSWERED_DEAD;
  assert.equal(k, 3, 'K is 3');
  const r = rig(Cm);
  await r.jobs.begin('agent-a', { command: 'npm ci' }, false, 'call-a');
  const a = r.jobs.ids()[0];
  r.world.rowsOf.set(a, [proc(r.clock, 9)]);
  await r.jobs.poll();
  const h0 = r.world.helpers[0];
  r.world.wedged = true;
  for (let i = 0; i < k - 1; i++) await r.jobs.poll();
  assert.equal(h0.closed, false, `${k - 1} unanswered requests in a row close nothing`);
  r.world.wedged = false;
  await r.jobs.poll();                                      // one answer
  r.world.wedged = true;
  for (let i = 0; i < k - 1; i++) await r.jobs.poll();
  assert.equal(h0.closed, false, `ANY ANSWER STARTS THE COUNT AGAIN (the helper was closed after ${k - 1} unanswered, 1 answered and ${k - 1} more unanswered requests)`);
  assert.deepEqual(r.jobs.ids(), [a], 'and its job is still tracked');
  await r.jobs.poll();                                      // the K-th in a row
  assert.equal(h0.closed, true, `A HELPER THAT LEAVES K REQUESTS IN A ROW UNANSWERED IS REPLACED (K = ${k}; it was kept)`);
  assert.deepEqual(r.jobs.ids(), [], 'its jobs are let go');
  assert.deepEqual(r.lost(), [[a, 'helper-unanswered']]);
  assert.deepEqual(r.exited(), [], 'with no exit told');
  r.world.wedged = false;
  await r.jobs.begin('agent-b', { command: 'npm test' }, false, 'call-b');
  assert.equal(r.world.helpers.length, 2, 'the next call gets a new helper');
  assert.deepEqual(r.held(), ['call-a', 'call-b'], 'which holds its job: the early release is back');
};

/** A create nobody answered may still be carried out by the helper, late. */
K.nullCreate = async (Cm) => {
  const r = rig(Cm);
  let first = true;
  // The helper makes the job but its answer does not come in time.
  r.world.answer = (line, h) => { if (!first || !line.startsWith('create ')) return undefined; first = false; h.known.add(line.split(' ')[1]); return null; };
  const wrapped = await r.jobs.begin('agent-a', { command: 'npm ci' }, false, 'call-a');
  await settle();
  const h = r.world.helpers[0];
  const id = h.reqs[0].split(' ')[1];
  assert.ok(wrapped && wrapped.command.includes(id), 'the call is still wrapped: its join line makes the job itself');
  assert.deepEqual(r.jobs.ids(), [], 'a job whose create went unanswered is not tracked');
  assert.deepEqual(r.held(), [], 'and not told as held');
  assert.ok(h.reqs.includes(`close ${id}`), `AN UNANSWERED CREATE IS FOLLOWED BY A CLOSE OF THAT JOB (requests sent: ${JSON.stringify(h.reqs)})`);
  assert.equal(h.known.size, 0, 'so the helper keeps no handle nobody tracks');
  assert.equal(h.closed, false, 'and the helper itself is kept');
};

/** A create answered after its helper was replaced: that helper is closed, so it holds nothing. */
K.replacedCreate = async (Cm) => {
  const r = rig(Cm);
  await r.jobs.begin('agent-a', { command: 'npm ci' }, false, 'call-a');
  const a = r.jobs.ids()[0];
  r.world.rowsOf.set(a, [proc(r.clock, 9)]);
  await r.jobs.poll();
  let answer;
  const late = new Promise((res) => { answer = res; });
  r.world.answer = (line) => (line.startsWith('create ') ? late : undefined);
  const pending = r.jobs.begin('agent-b', { command: 'npm test' }, false, 'call-b');   // its create is out
  await settle();
  r.world.helpers[0].dead = true;
  await r.jobs.poll();                                      // finds the helper dead and replaces it
  assert.equal(r.world.helpers[0].closed, true, 'the helper was replaced while the create was out');
  answer({ ok: true });
  await pending;
  assert.deepEqual(r.held(), ['call-a'], 'A CREATE ANSWERED AFTER ITS HELPER WAS REPLACED IS NOT HELD (call-b was told as held by a helper that is closed)');
  assert.deepEqual(r.jobs.ids(), [], 'and not tracked');
};

// ─── DISPOSE: nothing is started once disposed (HEAVYJOBS-DISPOSE-RESPAWNS-SERVE-108) ────────

/** A poll is asking about job A when dispose runs. Whatever A's answer is, the poll goes on to
 *  job B, and that request must not start a helper. */
K.disposePollInFlight = async (Cm) => {
  const r = rig(Cm);
  await r.jobs.begin('agent-a', { command: 'npm ci' }, false, 'call-a');
  await r.jobs.begin('agent-b', { command: 'npm test' }, false, 'call-b');
  assert.equal(r.jobs.ids().length, 2, 'both jobs are tracked');
  const polling = r.jobs.poll();                            // `list A` is out
  r.jobs.dispose();
  await polling;
  assert.equal(r.world.helpers[0].closed, true, 'dispose closed the helper');
  assert.equal(r.world.helpers.length, 1, `NO SERVE HELPER IS STARTED BY A POLL IN FLIGHT AT DISPOSE (${r.world.helpers.length - 1} started after it; it was asked ${JSON.stringify(r.world.helpers[r.world.helpers.length - 1].reqs)})`);
  assert.equal(r.poll.armed, 0, 'and no poll timer is left');
};

/** An exit notice the closed helper had already written lands after dispose: its confirm asks. */
K.disposeThenNotice = async (Cm) => {
  const r = rig(Cm);
  await r.jobs.begin('agent-a', { command: 'npm ci' }, false, 'call-a');
  const id = r.jobs.ids()[0];
  r.world.rowsOf.set(id, [proc(r.clock, 9)]);
  await r.jobs.poll();
  const h = r.world.helpers[0];
  r.jobs.dispose();
  h.listener({ event: 'exit', job: id, msg: 7, pid: 9 });
  await r.clock.tick(Cm.HEAVY_JOB_EXIT_CONFIRM_MS);
  h.listener({ event: 'exit', job: id, msg: 4, pid: 0 });
  await settle();
  assert.equal(r.world.helpers.length, 1, `NO SERVE HELPER IS STARTED BY AN EXIT NOTICE AFTER DISPOSE (${r.world.helpers.length - 1} started after it)`);
};

/** A heavy call that begins after dispose: nothing is started, held or armed. */
K.disposeThenBegin = async (Cm) => {
  const r = rig(Cm);
  r.jobs.dispose();
  await r.jobs.begin('agent-a', { command: 'npm ci' }, false, 'call-a');
  assert.equal(r.world.helpers.length, 0, `NO SERVE HELPER IS STARTED BY A BEGIN AFTER DISPOSE (${r.world.helpers.length} started)`);
  assert.deepEqual(r.jobs.ids(), [], 'its job is not tracked');
  assert.deepEqual(r.held(), [], 'and not told as held');
  assert.equal(r.poll.armed, 0, 'and no poll timer is armed');
};

/** arm() itself. With channel() closed off no public call reaches arm() after dispose (a job is
 *  held only by a live helper), so the private method is called directly: the pin holds whatever
 *  a later change does to the held check. Jobs tracked at dispose stay in the map. */
K.disposeThenArm = async (Cm) => {
  const r = rig(Cm);
  await r.jobs.begin('agent-a', { command: 'npm ci' }, false, 'call-a');
  assert.equal(r.poll.armed, 1, 'a held job arms the poll timer');
  r.jobs.dispose();
  assert.equal(r.poll.armed, 0, 'dispose stops it');
  assert.equal(r.jobs.ids().length, 1, 'the job is still in the map, so only the flag can stop arm()');
  r.jobs.arm();
  assert.equal(r.poll.armed, 0, 'THE POLL TIMER IS NOT ARMED AGAIN AFTER DISPOSE');
};

test('DISPOSE: a poll in flight at dispose starts no serve helper', () => K.disposePollInFlight(C));
test('DISPOSE: an exit notice that lands after dispose starts no serve helper', () => K.disposeThenNotice(C));
test('DISPOSE: a begin after dispose starts no serve helper, holds nothing and arms nothing', () => K.disposeThenBegin(C));
test('DISPOSE: arm() does nothing once disposed', () => K.disposeThenArm(C));

test('guarantee: a job whose list went unanswered once is still reported when it ends', () => K.endsAfterUnanswered(C));
test('guarantee: one unanswered request does not lose the other running jobs', () => K.othersKept(C));
test('a dead helper is replaced at once; its jobs are let go as lost and no exit is told', () => K.deadHelper(C));
test('a confirm that finds the helper dead stops the poll timer with the last job', () => K.deadInConfirm(C));
test("a list answered 'no job <id>' lets that job go, in the poll and in the confirm; another id's error does not", () => K.noJob(C));
test('a wedged helper is replaced after K unanswered requests in a row; any answer starts the count again', () => K.wedged(C));
test('an unanswered create is followed by a close of that job', () => K.nullCreate(C));
test('a create answered after its helper was replaced is not held', () => K.replacedCreate(C));

// ─── The real channel: reply order after an unanswered request ───────────────────────────────

const scratchDirs = [];
// Removed once every test is done: a helper's serve process may still be exiting after its test.
test.after(async () => { for (const d of scratchDirs) await removeDir(d); });
function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsrt108-'));
  scratchDirs.push(dir);
  return dir;
}

// A stand-in helper: one reply per line, in order, as Serve() writes them. It holds its reply to
// `slow` back until it has READ the line `next`, so the late reply arrives after the next request
// was written, and the two replies come in the order of their requests.
const STUB = `
const rl = require('node:readline').createInterface({ input: process.stdin });
let slow = false;
rl.on('line', (l) => {
  if (l === 'slow') { slow = true; return; }
  if (l === 'next' && slow) { slow = false; process.stdout.write('{"ok":true,"for":"slow"}\\n{"ok":true,"for":"next"}\\n'); return; }
  process.stdout.write(JSON.stringify({ ok: true, for: l }) + '\\n');
});
rl.on('close', () => process.exit(0));
process.stdout.write('{"event":"ready"}\\n');
`;

test('the real channel: a reply that comes after its request was given up is not taken as the next answer', { timeout: 60_000 }, async () => {
  // Keeping the helper after an unanswered request is safe only if a late reply cannot shift every
  // later answer by one. serveChannel keeps the given-up request in its queue, so the late reply is
  // eaten by the request it answers. (A line that is neither JSON nor an event also takes one slot
  // of the queue. That is so with or without this card, and the helper writes no such line.)
  //
  // serveChannel starts `<exe> serve`. The stand-in is this runtime running a script named `serve`
  // in the folder it is started from; the folder is switched back before anything else runs.
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'serve'), STUB);
  const cwd = process.cwd();
  let ch;
  process.chdir(dir);
  try { ch = C.serveChannel(process.execPath); } finally { process.chdir(cwd); }
  try {
    // No request is sent before the stand-in says it runs: a slow start must not be read as an
    // unanswered request. Its first line is an event, which answers nothing.
    const up = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 30_000);
      ch.onEvent((e) => { if (e.event === 'ready') { clearTimeout(t); resolve(true); } });
    });
    assert.equal(up, true, 'the stand-in helper did not start within 30 s (the machine, not the channel)');
    assert.deepEqual(await ch.request('ready'), { ok: true, for: 'ready' }, 'the stand-in helper answers');
    const gaveUp = await ch.request('slow');                // resolves after HEAVY_JOB_REQUEST_MS
    assert.equal(gaveUp, null, 'the request the helper did not answer in time resolves null');
    assert.equal(ch.dead(), false, 'AN UNANSWERED REQUEST DOES NOT MARK THE HELPER DEAD');
    const next = await ch.request('next');                  // the helper now writes both replies
    assert.deepEqual(next, { ok: true, for: 'next' }, `A LATE REPLY IS NOT TAKEN AS THE ANSWER TO THE NEXT REQUEST (it got ${JSON.stringify(next)})`);
    assert.deepEqual(await ch.request('after'), { ok: true, for: 'after' }, 'and the order holds from there on');
  } finally { ch.close(); }
  // Its stdin is ended: the helper exits, and only then does the channel say dead.
  const gone = await new Promise((resolve) => {
    const started = Date.now();
    const look = () => { if (ch.dead()) resolve(true); else if (Date.now() - started > 20_000) resolve(false); else setTimeout(look, 20); };
    look();
  });
  assert.equal(gone, true, 'THE CHANNEL SAYS DEAD ONCE ITS HELPER HAS EXITED (not within 20 s of closing it)');
  assert.equal(await ch.request('late'), null, 'and answers null from then on');
});

// ─── DISPOSE with the real channel: the process can exit ─────────────────────────────────────

// A stand-in helper that answers every line as an empty job and ends when its stdin ends.
const DISPOSE_STUB = `
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', () => { process.stdout.write('{"ok":true,"rows":[]}\\n'); });
rl.on('close', () => process.exit(0));
process.stdout.write('{"event":"ready"}\\n');
`;

// The process that owns the HeavyJobs. It counts every helper the product starts, disposes while a
// poll is asking about the first of two jobs, says what it counted, and then does NOTHING more: it
// ends by itself only if no pipe to a helper is left open. The first helper is started before the
// jobs are made and has said it runs, so a slow start is not read as an unanswered create.
const DISPOSE_CHILD = `
const [loadTsPath, cpuFile] = process.argv.slice(2);
const C = require(loadTsPath)(cpuFile);
const say = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
(async () => {
  const first = C.serveChannel(process.execPath);
  await new Promise((resolve) => first.onEvent((e) => { if (e.event === 'ready') resolve(); }));
  say({ phase: 'ready' });
  let starts = 0;
  const jobs = new C.HeavyJobs({
    platform: 'win32', options: () => ({ background: false, half: false }), exe: () => process.execPath,
    channel: (exe) => (++starts === 1 ? first : C.serveChannel(exe))
  });
  await jobs.begin('agent-a', { command: 'npm ci' }, false, 'call-a');
  await jobs.begin('agent-b', { command: 'npm test' }, false, 'call-b');
  const tracked = jobs.ids().length;
  const polling = jobs.poll();
  jobs.dispose();
  await polling;
  say({ phase: 'disposed', tracked, starts });
})();
`;

test('DISPOSE, real channel: a poll in flight at dispose starts no helper and the process ends by itself', { timeout: 180_000 }, async () => {
  // serveChannel starts `<exe> serve`: the stand-in is this runtime running the script named
  // `serve` in the folder the child is started in.
  const dir = scratch();
  fs.writeFileSync(path.join(dir, 'serve'), DISPOSE_STUB);
  const script = path.join(dir, 'dispose-child.cjs');
  fs.writeFileSync(script, DISPOSE_CHILD);
  const child = spawn(process.execPath, [script, path.join(__dirname, 'load-ts.cjs'), CPU_FILE], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let out = '', err = '', exit = null;
  const said = [];
  let onSaid = () => {};
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    out += d;
    let i;
    while ((i = out.indexOf('\n')) >= 0) { const line = out.slice(0, i); out = out.slice(i + 1); try { said.push(JSON.parse(line)); } catch { /* not ours */ } }
    onSaid();
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => { exit = { code, signal }; resolve(true); onSaid(); }));
  const report = () => said.find((s) => s.phase === 'disposed');
  try {
    // The report, or the child ending without one. The watchdog only names a child that hangs
    // before it reports (a machine that cannot start the stand-in); it decides nothing else.
    const got = await new Promise((resolve) => {
      const t = setTimeout(() => resolve('watchdog'), 90_000);
      onSaid = () => { if (report() || exit) { clearTimeout(t); resolve('event'); } };
      onSaid();
    });
    const rep = report();
    assert.ok(rep, `the child did not report (${got}; it said ${JSON.stringify(said)}; exit ${JSON.stringify(exit)}; stderr: ${err.slice(-600)})`);
    assert.equal(rep.tracked, 2, 'both jobs were held by the first helper before dispose (else the poll asks nothing)');
    assert.equal(rep.starts, 1, `NO SERVE HELPER IS STARTED AFTER DISPOSE, REAL CHANNEL (the product started ${rep.starts - 1} more)`);
    // Nothing is left for the child to do. It ends by itself unless a helper pipe is still open.
    const ended = await Promise.race([exited, new Promise((resolve) => { const t = setTimeout(() => resolve(false), 60_000); exited.then(() => clearTimeout(t)); })]);
    assert.equal(ended, true, 'THE PROCESS ENDS BY ITSELF AFTER DISPOSE (still running 60 s after its last line)');
    assert.equal(exit.code, 0, `and ends clean (stderr: ${err.slice(-600)})`);
  } finally {
    // Ours only: a child that is still there is ended; its helpers end when their stdin closes.
    if (!exit) { child.kill(); await exited; }
  }
});

// ─── LIVE: the helper Guppy ships ────────────────────────────────────────────────────────────

const CSC = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const LIVE_SKIP = process.platform !== 'win32' ? 'Windows only (Job Objects)' : !fs.existsSync(CSC) ? 'no in-box csc' : false;
function helper() {
  const dir = scratch();
  const exe = path.join(dir, 'guppy-heavyjob.exe');
  const cs = path.join(dir, 'guppy-heavyjob.cs');
  fs.writeFileSync(cs, fs.readFileSync(path.join(root, 'resources', 'heavyjob', 'guppy-heavyjob.cs')));
  const c = spawnSync(CSC, ['-nologo', '-O', `-out:${exe}`, cs], { encoding: 'utf8', windowsHide: true });
  assert.equal(c.status, 0, `csc: ${c.stdout}${c.stderr}`);
  return exe;
}

test('LIVE: a job made by one serve helper is unknown to the next one (what the fake helper models)', { skip: LIVE_SKIP, timeout: 60_000 }, async () => {
  const exe = helper();
  const id = `hsrt108-${process.pid}-${Date.now().toString(36)}`;
  const first = C.serveChannel(exe);
  assert.deepEqual(await first.request(`create ${id} 0 0`), { ok: true }, 'the first helper makes the job');
  const held = await first.request(`list ${id}`);
  assert.equal(held && held.ok, true, 'the helper that made the job lists it');
  first.close();
  const second = C.serveChannel(exe);
  try {
    const r = await second.request(`list ${id}`);
    assert.ok(r, 'the second helper answers');
    assert.equal(r.ok, false, `A NEW HELPER DOES NOT KNOW A JOB THE CLOSED ONE MADE (it answered ${JSON.stringify(r)})`);
    assert.equal(r.error, `no job ${id}`, 'in the words HeavyJobs matches to let a job go');
  } finally { second.close(); }
});

// ─── MUTANT CENSUS ──────────────────────────────────────────────────────────────────────────

function mutatedText(file, edits, tag) {
  let text = read(file);
  for (const [from, to] of edits) {
    const hits = text.split(from).length - 1;
    assert.equal(hits, 1, `mutant ${tag}: edit target must match EXACTLY ONCE, matched ${hits}: ${JSON.stringify(from.slice(0, 80))}`);
    text = text.replace(from, () => to);
  }
  return text;
}

const KEEP_ON_NULL = '    if (!gone && ++this.unanswered < HEAVY_JOB_UNANSWERED_DEAD) return null;\n';
const LOST_ROW = "    this.log({ action: 'lost', job: j.id, agentId: j.agentId, why });\n";
const MUTANTS = [
  // The defect itself, put back: one unanswered request closes the helper.
  { name: 'one unanswered request closes the helper (the job that ends)', edits: [[KEEP_ON_NULL, '']], killer: 'endsAfterUnanswered', dies: /A JOB THAT ENDED IS REPORTED EVEN AFTER ONE REQUEST WENT UNANSWERED/ },
  { name: 'one unanswered request closes the helper (the other jobs)', edits: [[KEEP_ON_NULL, '']], killer: 'othersKept', dies: /ANOTHER JOB'S EXIT IS REPORTED AFTER A REQUEST ABOUT A DIFFERENT JOB WENT UNANSWERED/ },
  { name: 'K is never reached: a wedged helper is kept for good', edits: [['++this.unanswered < HEAVY_JOB_UNANSWERED_DEAD) return null;', '++this.unanswered < Infinity) return null;']], killer: 'wedged', dies: /A HELPER THAT LEAVES K REQUESTS IN A ROW UNANSWERED IS REPLACED/ },
  { name: 'an answer does not start the count again', edits: [['    if (r !== null) { this.unanswered = 0; return r; }', '    if (r !== null) return r;']], killer: 'wedged', dies: /ANY ANSWER STARTS THE COUNT AGAIN/ },
  { name: 'a dead helper is counted like a slow one', edits: [['    const gone = ch.dead?.() === true;', '    const gone = false;']], killer: 'deadHelper', dies: /A DEAD HELPER IS REPLACED AT ONCE/ },
  { name: 'the jobs of a replaced helper stay tracked', edits: [['    for (const j of [...this.jobs.values()]) if (j.ch === ch) this.lose(j, why);\n', '']], killer: 'deadHelper', dies: /THE JOBS OF A DEAD HELPER ARE LET GO/ },
  { name: 'a lost job is told as exited', edits: [[LOST_ROW, LOST_ROW + "    if (j.callId) this.tell(j.agentId, j.callId, j.id, 'exited');\n"]], killer: 'deadHelper', dies: /A JOB LOST WITH ITS HELPER IS NOT TOLD AS EXITED/ },
  { name: 'losing the last job leaves the poll timer armed', edits: [[LOST_ROW + '    if (!this.jobs.size) this.disarm();\n', LOST_ROW]], killer: 'deadInConfirm', dies: /THE POLL TIMER STOPS WHEN A CONFIRM LOSES THE LAST JOB/ },
  { name: "the poll reads 'no job' as says nothing", edits: [["      if (this.noJob(r, j.id)) { this.lose(j, 'no-job'); continue; }", '']], killer: 'noJob', dies: /A JOB THE HELPER SAYS IT DOES NOT HOLD IS LET GO/ },
  { name: "the confirm reads 'no job' as says nothing", edits: [["    if (this.noJob(r, j.id)) { this.lose(j, 'no-job'); return; }\n", '']], killer: 'noJob', dies: /A CONFIRM ANSWERED NO JOB LETS THE JOB GO/ },
  { name: "any 'no job' error drops the job asked about", edits: [['r.error === `no job ${id}`;', "String(r.error).startsWith('no job ');"]], killer: 'noJob', dies: /ONLY THE HELPER'S ANSWER ABOUT THIS JOB LETS IT GO/ },
  { name: 'an unanswered create is not followed by a close', edits: [['    if (r === null && ch !== null && this.ch === ch) void this.req(`close ${id}`);\n', '']], killer: 'nullCreate', dies: /AN UNANSWERED CREATE IS FOLLOWED BY A CLOSE OF THAT JOB/ },
  { name: 'a create answered by a replaced helper is held', edits: [['    const held = r?.ok === true && ch !== null && this.ch === ch;', '    const held = r?.ok === true && ch !== null;']], killer: 'replacedCreate', dies: /A CREATE ANSWERED AFTER ITS HELPER WAS REPLACED IS NOT HELD/ }
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  for (const m of MUTANTS) {
    await t.test(`mutant: ${m.name}`, async () => {
      const M = loadTs.fromText(CPU_FILE, mutatedText(CPU_FILE, m.edits, m.name));
      await assert.rejects(() => K[m.killer](M), (e) => {
        assert.match(String(e && e.message), m.dies, `${m.name}: died for the wrong reason: ${e && e.message}`);
        return true;
      });
    });
  }
});
