'use strict';
require('./tools/own-job.cjs');
/**
 * HEAVYCPU-SERVE-REQ-TIMEOUT-DROPS-ALL-JOBS-108: one request the serve helper does not answer makes
 * HeavyJobs lose every running job for good.
 *
 * The chain (src/main/heavyCpu.ts, resources/heavyjob/guppy-heavyjob.cs):
 *   1. serveChannel gives up on a request after HEAVY_JOB_REQUEST_MS and resolves null.
 *   2. HeavyJobs.req() reads null as a dead helper and closes the channel. That ends the helper's
 *      stdin; Serve() returns, and with it go the handles of EVERY job that helper held.
 *   3. The next request starts a new helper. Its job table is empty: `list <id>` of a job the old
 *      helper made answers {"ok":false,"error":"no job <id>"}.
 *   4. confirmExit and poll both read a failed list as "says nothing" and count no miss, so the job
 *      is never reported as exited and stays tracked.
 * In the app the heavy lock then waits for its own watcher (the lag HEAVY-LOCK-RELEASE-LAG-197
 * removed); a holder whose only release is the job notice is not freed.
 *
 * The fakes below are the helper as it is today: a job table per helper process, lost when its
 * channel is closed. Nothing here waits on wall time: the unanswered request is the null the real
 * channel resolves, and the confirm runs on a clock the test moves.
 *
 * RED-BEFORE: the two "guarantee" cells fail on the product as it is. The LIVE cell pins steps 2
 * and 3 on the helper Guppy ships and passes today.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { removeDir } = require('./tools/test-temp.cjs');
const loadTs = require('./load-ts.cjs');

const root = path.join(__dirname, '..');
const C = loadTs('src/main/heavyCpu.ts');

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
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    }
  };
}

/** The serve helper as it is: each helper process has its own job table, and closing its channel
 *  ends it. `world.rows(id)` is what Windows holds in the job, whichever helper asks.
 *  `world.unanswered` names one request line the running helper never answers (the real channel
 *  resolves null for it after HEAVY_JOB_REQUEST_MS). */
function helperWorld() {
  const world = { helpers: [], rowsOf: new Map(), unanswered: null, rows: (id) => world.rowsOf.get(id) ?? [] };
  world.start = () => {
    const h = { known: new Set(), closed: false, reqs: [], listener: null };
    world.helpers.push(h);
    h.ch = {
      async request(line) {
        h.reqs.push(line);
        if (h.closed) return null;
        if (world.unanswered !== null && line === world.unanswered) { world.unanswered = null; return null; }
        const [cmd, id] = line.split(' ');
        if (cmd === 'create') { h.known.add(id); return { ok: true }; }
        if (cmd === 'close') { h.known.delete(id); return { ok: true }; }
        if (!h.known.has(id)) return { ok: false, error: `no job ${id}` };
        if (cmd === 'list') return { ok: true, rows: world.rows(id) };
        return { ok: true };
      },
      close() { h.closed = true; h.known.clear(); },
      onEvent(fn) { h.listener = fn; }
    };
    return h.ch;
  };
  /** A notice from the helper that holds the job (a closed helper writes nothing). */
  world.emit = (e) => { for (const h of world.helpers) if (!h.closed && h.known.has(e.job) && h.listener) h.listener(e); };
  return world;
}

function rig() {
  const clock = fakeClock();
  const world = helperWorld();
  const told = [];
  const jobs = new C.HeavyJobs({
    platform: 'win32', options: () => ({ background: false, half: false }), exe: () => 'guppy-heavyjob.exe',
    channel: () => world.start(), now: clock.now, setInterval: () => 1, clearInterval: () => {},
    setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, log: () => {},
    onJob: (e) => told.push(e)
  });
  const exited = () => told.filter((e) => e.state === 'exited').map((e) => e.job);
  return { clock, world, told, jobs, exited };
}

const proc = (clock, pid) => ({ pid, name: 'node.exe', createdMs: clock.now() + 5 });

test('guarantee: a job whose list went unanswered once is still reported when it ends', async () => {
  const r = rig();
  await r.jobs.begin('agent-a', { command: 'npm ci' }, false, 'call-1');
  const id = r.jobs.ids()[0];
  r.world.rowsOf.set(id, [proc(r.clock, 9), proc(r.clock, 10)]);
  await r.jobs.poll();                                   // the call is running in its job
  // One process of the job exits; the confirm's list is the request the helper does not answer.
  r.world.rowsOf.set(id, [proc(r.clock, 10)]);
  r.world.unanswered = `list ${id}`;
  r.world.emit({ event: 'exit', job: id, msg: 7, pid: 9 });
  await r.clock.tick(C.HEAVY_JOB_EXIT_CONFIRM_MS);
  assert.equal(r.world.unanswered, null, 'the confirm sent the list that went unanswered');
  assert.deepEqual(r.exited(), [], 'an unanswered list says nothing');
  // The job ends. Its notices are the helper's to write; the poll is the fallback for a notice that
  // never comes. Neither may be lost because one earlier request went unanswered.
  r.world.rowsOf.set(id, []);
  r.world.emit({ event: 'exit', job: id, msg: 7, pid: 10 });
  r.world.emit({ event: 'exit', job: id, msg: 4, pid: 0 });
  await r.clock.tick(C.HEAVY_JOB_EXIT_CONFIRM_MS);
  for (let i = 0; i < 4; i++) await r.jobs.poll();
  const last = r.world.helpers[r.world.helpers.length - 1].reqs.filter((l) => l.startsWith('list ')).length;
  assert.deepEqual(r.exited(), [id], `A JOB THAT ENDED IS REPORTED EVEN AFTER ONE REQUEST WENT UNANSWERED (not reported after its exit notices and 4 polls; ${r.world.helpers.length} helper(s) were started, the last one was asked to list ${last} time(s) and knows ${r.world.helpers[r.world.helpers.length - 1].known.size} job(s))`);
  assert.deepEqual(r.jobs.ids(), [], 'a job that ended is not tracked for good');
});

test('guarantee: one unanswered request does not lose the other running jobs', async () => {
  const r = rig();
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
  await r.clock.tick(C.HEAVY_JOB_EXIT_CONFIRM_MS);
  for (let i = 0; i < 4; i++) await r.jobs.poll();
  assert.deepEqual(r.exited(), [b], `ANOTHER JOB'S EXIT IS REPORTED AFTER A REQUEST ABOUT A DIFFERENT JOB WENT UNANSWERED (job B not reported after its exit notices and 4 polls; ${r.world.helpers.length} helper(s) were started)`);
  assert.ok(r.jobs.ids().includes(a), 'job A is still running and still tracked');
});

// ─── LIVE: the helper Guppy ships ────────────────────────────────────────────────────────────

const CSC = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const LIVE_SKIP = process.platform !== 'win32' ? 'Windows only (Job Objects)' : !fs.existsSync(CSC) ? 'no in-box csc' : false;
const helperDirs = [];
// Removed once every test is done: a helper's serve process may still be exiting after its test.
test.after(async () => { for (const d of helperDirs) await removeDir(d); });
function helper() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hsrt108-'));
  helperDirs.push(dir);
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
    assert.match(String(r.error), /no job/, 'and says so');
  } finally { second.close(); }
});
