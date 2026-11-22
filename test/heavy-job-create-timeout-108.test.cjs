'use strict';
require('./tools/own-job.cjs');
/**
 * HEAVY-JOB-CREATE-TIMEOUT-UNHELD-108: under load the helper's first `create` came back null after
 * HEAVY_JOB_REQUEST_MS (3 s), the job was never held, and the slot was freed only by the lock's own
 * watcher or the 15 s poll (UHera, HEAVY-LOCK-RELEASE-LAG-197-RECUR-108).
 *
 * The cause: the 3 s budget starts when the request is written, so a helper's cold start (spawn to
 * its first answer) counts against it. Quiet it is 40-49 ms; under load it passed 3 s.
 *
 * The fix (src/main/heavyCpu.ts, src/main/hooks.ts, src/main/index.ts, src/main/mailSurface.ts):
 *   - a START budget: until a helper's first parsed answer a request waits what is left of
 *     HEAVY_JOB_START_MS (12 s) from that helper's spawn, never less than HEAVY_JOB_REQUEST_MS. An
 *     event line or a garbage line is no answer. Each new helper starts the budget again;
 *   - the hook client's own wait bounds a create: the hook's arrival plus mailLatencyLimitFor(its
 *     transport's client timeout). A create cut by that deadline counts toward no replace (the helper
 *     missed nothing). With no time left nothing is sent. A one-way hook is not wrapped at all;
 *   - warm(): the helper is started at boot (setImmediate after hookServer.start(), never awaited),
 *     with one `close guppy-warm` whose answer only proves it is up. Once; a miss counts as any;
 *   - rows: one helper-start {ok, ms, warm} per helper; start-timeout {cause: start|deadline}.
 *
 * Fake cells run on a fake clock: the sim channel moves it by the time an answer takes, or by the
 * whole wait when the answer is later than that. The LIVE cells use the shipped helper source,
 * compiled with the in-box csc.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { spawn, spawnSync } = require('node:child_process');
const { removeDir } = require('./tools/test-temp.cjs');
const { gitBash } = require('./tools/git-bash.cjs');
const { nodeEnv } = require('./tools/node-env.cjs');
const { childrenOf, lookupPids, processTable } = require('./tools/own-procs.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');
const loadTs = require('./load-ts.cjs');

const root = path.join(__dirname, '..');
const CPU_FILE = 'src/main/heavyCpu.ts';
const INDEX_FILE = 'src/main/index.ts';
const HOOKS_FILE = 'src/main/hooks.ts';
const C = loadTs(CPU_FILE);
const MS = loadTs('src/main/mailSurface.ts');
const HJ = loadTs('src/main/heavyJob.ts');
const AGENT = 'agent-a';
const BENCH = { heavy: true, kind: 'bench' };
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

/** A sim helper channel. `script(line, ms, n)` answers each request: {at, r} (answered after `at` ms
 *  if that is within the wait, else the wait runs out and it is null), 'pending' (a deferred the
 *  test resolves) or 'dead' (the helper is gone: null at once, and dead() says so). */
function rig(M, { script = () => ({ at: 1, r: { ok: true } }), exe = 'x.exe', platform = 'win32', wrap = null } = {}) {
  const clock = { t: 1_000_000 };
  const rows = [];
  const told = [];
  const chans = [];
  const mk = () => {
    const c = { reqs: [], closed: false, isDead: false, listener: null, pend: [] };
    c.ch = {
      request(line, ms) {
        c.reqs.push({ line, ms });
        if (c.isDead) return Promise.resolve(null);
        const a = script(line, ms, chans.indexOf(c));
        if (a === 'dead') { c.isDead = true; return Promise.resolve(null); }
        if (a === 'pending') return new Promise((res) => c.pend.push({ line, ms, res }));
        if (a.at <= ms) { clock.t += a.at; return Promise.resolve(a.r); }
        clock.t += ms;
        return Promise.resolve(null);
      },
      close() { c.closed = true; },
      onEvent(fn) { c.listener = fn; },
      dead() { return c.isDead; }
    };
    return c;
  };
  const jobs = new M.HeavyJobs({
    platform, options: () => ({ background: false, cap: false }), exe: () => exe,
    channel: (x) => { const c = mk(); chans.push(c); return wrap ? wrap(c, x) : c.ch; },
    now: () => clock.t, setInterval: () => 1, clearInterval: () => {}, setTimeout: () => 1, clearTimeout: () => {},
    log: (r) => rows.push(r), onJob: (e) => told.push(e)
  });
  const creates = () => chans.flatMap((c) => c.reqs.filter((q) => q.line.startsWith('create ')));
  return { jobs, clock, rows, told, chans, creates };
}

/** A spawn stand-in for serveChannel: a child with piped stdin/stdout the test drives. */
function fakeSpawn() {
  const calls = [];
  const kids = [];
  const fn = (exe, args, opts) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.written = [];
    child.stdin.on('data', (d) => child.written.push(String(d)));
    calls.push({ exe, args, opts });
    kids.push(child);
    return child;
  };
  return { fn, calls, kids };
}

/** Resolves 'timeout' if `p` has not settled within `ms` of wall time. */
function race(p, ms) {
  let t;
  return Promise.race([p, new Promise((r) => { t = setTimeout(() => r('timeout'), ms); })]).finally(() => clearTimeout(t));
}

const http = (j, n, clock) => j.begin(AGENT, { command: 'npm ci' }, false, `call-${n}`, 'http', clock.t);

// ─── Killers: each takes the module under test (the real one, or a mutant) ──────────────────

const K = {
  async f1(M) {
    const R = rig(M, { script: (line) => (line.startsWith('create ') && R.creates().length === 1 ? { at: 5_000, r: { ok: true } } : { at: 1, r: { ok: true } }) });
    await http(R.jobs, 1, R.clock);
    assert.equal(R.creates()[0].ms, C.HEAVY_JOB_START_MS, `A COLD HELPER'S FIRST CREATE WAITS THE START BUDGET (got ${R.creates()[0].ms})`);
    assert.equal(R.rows.find((r) => r.action === 'wrap').held, true, 'A CREATE ANSWERED AT 5 S ON A COLD HELPER IS HELD');
    assert.deepEqual(R.told.map((e) => e.state), ['held']);
    await http(R.jobs, 2, R.clock);
    assert.equal(R.creates()[1].ms, C.HEAVY_JOB_REQUEST_MS, `ONCE ANSWERED, A REQUEST WAITS HEAVY_JOB_REQUEST_MS (got ${R.creates()[1].ms})`);
  },
  async f2(M) {
    let n = 0;
    const R = rig(M, { script: (line) => (line.startsWith('create ') && ++n === 2 ? 'dead' : { at: 1, r: { ok: true } }) });
    await http(R.jobs, 1, R.clock);
    await http(R.jobs, 2, R.clock);   // the helper is gone: replaced
    await flush();
    assert.equal(R.chans[0].closed, true, 'the dead helper is replaced');
    await http(R.jobs, 3, R.clock);
    assert.equal(R.chans.length, 2, 'a new helper is started');
    const first = R.chans[1].reqs.find((q) => q.line.startsWith('create '));
    assert.equal(first.ms, C.HEAVY_JOB_START_MS, `A NEW HELPER GETS THE START BUDGET AGAIN (got ${first.ms})`);
  },
  async f3(M) {
    const sp = fakeSpawn();
    const ch = M.serveChannel('x.exe', sp.fn);
    sp.kids[0].emit('exit', 1);
    const r = await race(ch.request('list a', 60_000), 1_000);
    assert.equal(r, null, `A REQUEST TO A HELPER THAT EXITED ANSWERS NULL AT ONCE (got ${JSON.stringify(r)})`);
    assert.equal(ch.dead(), true);
  },
  async f4(M) {
    let n = 0;
    const R = rig(M, { script: (line) => (line.startsWith('create ') && ++n === 1 ? { at: 13_000, r: { ok: true } } : { at: 1, r: { ok: true } }) });
    const out = await http(R.jobs, 1, R.clock);
    assert.ok(out, 'the call is still wrapped (its join line makes the job)');
    assert.equal(R.rows.find((r) => r.action === 'wrap').held, false, 'A CREATE MISSING THE START BUDGET IS NOT HELD');
    assert.deepEqual(R.told, []);
    const st = R.rows.filter((r) => r.action === 'start-timeout');
    assert.equal(st.length, 1);
    assert.equal(st[0].cause, 'start', `a miss on a cold helper is logged as a start timeout (${JSON.stringify(st[0])})`);
    assert.equal(st[0].ms, C.HEAVY_JOB_START_MS);
    await flush();
    assert.equal(R.chans.length, 1, 'ONE MISS REPLACES NOTHING');
    assert.equal(R.chans[0].closed, false);
    await http(R.jobs, 2, R.clock);
    assert.equal(R.creates()[1].ms, C.HEAVY_JOB_REQUEST_MS, `after the start budget ran out a request waits HEAVY_JOB_REQUEST_MS (got ${R.creates()[1].ms})`);
  },
  async f5(M) {
    const sp = fakeSpawn();
    const ch = M.serveChannel('x.exe', sp.fn);
    assert.deepEqual(sp.calls[0].args, ['serve']);
    assert.equal(sp.calls[0].opts.windowsHide, true);
    const r = await race(ch.request('create a 0 0', 50), 1_000);
    assert.equal(r, null, `A REQUEST WAITS THE MS IT IS GIVEN (got ${JSON.stringify(r)})`);
    const p = ch.request('create b 0 0', 5_000);
    // The helper answers in order: its first line is a's late answer (a has already given up), the next is b's.
    sp.kids[0].stdout.write('{"late":"a"}\n{"ok":true}\n');
    assert.deepEqual(await race(p, 1_000), { ok: true }, 'a reply line answers the request; a late answer goes to the request that gave up, not the next one');
    assert.equal(ch.dead(), false, 'a timed-out request leaves the helper alive');
  },
  async f6(M) {
    const R = rig(M, { script: (line) => (line.startsWith('create ') ? { at: 5_000, r: { ok: true } } : { at: 1, r: { ok: true } }) });
    const t0 = R.clock.t;
    await R.jobs.begin(AGENT, { command: 'npm ci' }, false, 'call-1', 'mcp', t0);
    const want = MS.mailLatencyLimitFor(MS.hookClientTimeoutMs('mcp'));
    assert.equal(want, 2_500);
    assert.equal(R.creates()[0].ms, want, `A CREATE WAITS NO LONGER THAN ITS HOOK CLIENT (mcp: got ${R.creates()[0].ms})`);
    const st = R.rows.find((r) => r.action === 'start-timeout');
    assert.equal(st && st.cause, 'deadline', `a cut create is logged as a deadline (${JSON.stringify(st)})`);
    assert.equal(st.transport, 'mcp');
  },
  async f7(M) {
    let n = 0;
    const R = rig(M, { script: (line) => (line.startsWith('create ') && ++n > 1 ? { at: 2_900, r: { ok: true } } : line.startsWith('close ') ? 'pending' : { at: 1, r: { ok: true } }) });
    await http(R.jobs, 1, R.clock);   // the helper has answered: warm
    R.told.length = 0;
    await R.jobs.begin(AGENT, { command: 'npm ci' }, false, 'call-2', 'pipe', R.clock.t);
    const wraps = R.rows.filter((r) => r.action === 'wrap');
    assert.equal(wraps[1].held, false, 'A CREATE PAST THE PIPE CLIENT\'S WAIT IS NOT HELD');
    assert.deepEqual(R.told, [], 'no held tell');
    assert.ok(R.chans[0].reqs.some((q) => q.line === `close ${wraps[1].job}`), 'A CUT CREATE IS FOLLOWED BY A CLOSE OF THAT JOB');
  },
  async f8(M) {
    const sp = fakeSpawn();
    const seen = [];
    const R = rig(M, { wrap: (c, x) => { const base = M.serveChannel(x, sp.fn); const w = Object.create(base); w.request = (line, ms) => { seen.push({ line, ms }); return base.request(line, ms); }; return w; } });
    const p1 = http(R.jobs, 1, R.clock);
    await flush();
    const out = sp.kids[0].stdout;
    out.write('{"event":"noise"}\n');
    out.write('not json\n');
    await p1;   // the garbage line answered the create with null
    await flush();
    const p2 = http(R.jobs, 2, R.clock);
    await flush();
    const c2 = seen.filter((q) => q.line.startsWith('create '))[1];
    assert.equal(c2.ms, C.HEAVY_JOB_START_MS, `AN EVENT OR A GARBAGE LINE IS NO ANSWER: THE START BUDGET HOLDS (got ${c2.ms})`);
    out.write('{"ok":true}\n{"ok":true}\n');
    await race(p2, 1_000);
  },
  async f9(M) {
    let n = 0;
    const R = rig(M, { script: (line) => (line.startsWith('create ') && ++n > 1 ? { at: 2_900, r: { ok: true } } : line.startsWith('close ') ? 'pending' : { at: 1, r: { ok: true } }) });
    await http(R.jobs, 1, R.clock);
    R.told.length = 0;
    for (let i = 2; i <= 4; i++) await R.jobs.begin(AGENT, { command: 'npm ci' }, false, `call-${i}`, 'pipe', R.clock.t);
    await flush();
    const wraps = R.rows.filter((r) => r.action === 'wrap').slice(1);
    assert.deepEqual(wraps.map((w) => w.held), [false, false, false]);
    assert.equal(R.chans[0].closed, false, 'A CUT CREATE COUNTS TOWARD NO REPLACE: the helper is kept');
    assert.equal(R.chans.length, 1, 'A CUT CREATE COUNTS TOWARD NO REPLACE: one helper');
    for (const w of wraps) assert.ok(R.chans[0].reqs.some((q) => q.line === `close ${w.job}`), `close ${w.job} is queued`);
    assert.deepEqual(R.told, []);
  },
  async f10(M) {
    const R = rig(M);
    assert.equal(await R.jobs.begin(AGENT, { command: 'npm ci' }, false, 'call-1', 'pipe-oneway', R.clock.t), null, 'A ONE-WAY HOOK IS NOT WRAPPED');
    assert.equal(R.chans.length, 0, 'A ONE-WAY HOOK IS NOT WRAPPED: no helper is asked');
    assert.equal(await R.jobs.begin(AGENT, { command: 'npm ci' }, false, 'call-2', undefined, R.clock.t - 2_600), null, 'no transport: the pipe wait, already over');
    assert.equal(R.chans.length, 0);
    await R.jobs.begin(AGENT, { command: 'npm ci' }, false, 'call-3', undefined, R.clock.t);
    assert.equal(R.creates()[0].ms, 2_500, 'no transport gets the shortest wait (pipe)');
  },
  async f11(M) {
    for (const back of [2_600, 2_500]) {
      const R = rig(M);
      const r = await R.jobs.begin(AGENT, { command: 'npm ci' }, false, 'call-1', 'pipe', R.clock.t - back);
      assert.equal(R.chans.length, 0, `NO TIME LEFT: NOTHING IS SENT (arrived ${back} ms ago; helpers ${R.chans.length})`);
      assert.equal(r, null, 'no time left: the call is left as it is');
      assert.deepEqual(R.told, []);
      assert.equal(R.rows.filter((x) => x.action === 'wrap').length, 0, 'no job is tracked');
      const st = R.rows.filter((x) => x.action === 'start-timeout');
      assert.equal(st.length, 1);
      assert.equal(st[0].early, true);
      assert.equal(st[0].ms, 0);
      assert.equal(st[0].cause, 'deadline');
    }
  },
  async w1(M) {
    const R = rig(M);
    const ret = R.jobs.warm();
    assert.equal(ret, undefined, `WARM RETURNS NOTHING (IT IS NOT AWAITED) (got ${ret})`);
    await flush();
    const all = R.chans.flatMap((c) => c.reqs);
    assert.equal(all.length, 1, `WARM SENDS ONE REQUEST (sent ${JSON.stringify(all)})`);
    assert.equal(all[0].line, 'close guppy-warm', `THE WARM REQUEST IS A CLOSE OF A JOB NO ONE MADE (sent ${all[0].line})`);
    await http(R.jobs, 1, R.clock);
    assert.equal(R.creates()[0].ms, C.HEAVY_JOB_REQUEST_MS, 'after the warm answer a create waits HEAVY_JOB_REQUEST_MS');
    assert.equal(R.chans.length, 1, 'the warmed helper is the one the call uses');
    const hs = R.rows.filter((r) => r.action === 'helper-start');
    assert.equal(hs.length, 1, 'one helper-start row per helper');
    assert.equal(hs[0].ok, true);
    assert.equal(hs[0].warm, true);
  },
  async w2(M) {
    const a = rig(M, { exe: null });
    a.jobs.warm(); await flush();
    assert.equal(a.chans.length, 0, 'no helper exe: nothing');
    const b = rig(M, { platform: 'linux' });
    b.jobs.warm(); await flush();
    assert.equal(b.chans.length, 0, 'not Windows: nothing');
  },
  async w3(M) {
    const a = rig(M);
    a.jobs.warm(); await flush();
    a.jobs.warm(); await flush();
    assert.equal(a.chans.flatMap((c) => c.reqs).length, 1, 'a second warm sends nothing');
    const b = rig(M);
    await http(b.jobs, 1, b.clock);
    b.jobs.warm(); await flush();
    assert.equal(b.chans.flatMap((c) => c.reqs).filter((q) => q.line === 'close guppy-warm').length, 0, 'a warm after a call sends nothing');
  },
  async w4(M) {
    const a = rig(M);
    a.jobs.dispose();
    a.jobs.warm(); await flush();
    assert.equal(a.chans.length, 0, 'NO HELPER IS STARTED BY A WARM AFTER DISPOSE');
    const b = rig(M, { script: () => 'pending' });
    b.jobs.warm(); await flush();
    b.jobs.dispose();
    b.chans[0].pend[0].res(null);
    await flush();
    assert.equal(b.chans.length, 1, 'a warm answered after dispose starts nothing');
  },
  async w5(M) {
    const R = rig(M, { script: (line) => (line === 'close guppy-warm' ? 'dead' : { at: 1, r: { ok: true } }) });
    R.jobs.warm(); await flush();
    assert.equal(R.chans[0].closed, true, 'a dead helper met by the warm is replaced');
    R.jobs.warm(); await flush();
    await http(R.jobs, 1, R.clock);
    const warms = R.chans.flatMap((c) => c.reqs).filter((q) => q.line === 'close guppy-warm');
    assert.equal(warms.length, 1, `WARM RUNS ONCE (warm requests ${warms.length})`);
    assert.equal(R.chans.length, 2);
  },
  async w6(M) {
    const R = rig(M, { script: (line) => (line === 'close guppy-warm' ? 'pending' : { at: 1, r: { ok: true } }) });
    R.jobs.warm(); await flush();
    R.clock.t += 1_000;
    await http(R.jobs, 1, R.clock);
    assert.equal(R.chans.length, 1, 'the call uses the helper being warmed');
    assert.equal(R.creates()[0].ms, C.HEAVY_JOB_START_MS - 1_000, `A REQUEST QUEUED BEHIND A SLOW START GETS ONLY WHAT IS LEFT (got ${R.creates()[0].ms})`);
  },
  async w7(text) {
    const code = codeOnly(text, 'index.ts');
    const at = code.indexOf('function bootstrapHiveServices(): void {');
    assert.ok(at >= 0, 'bootstrapHiveServices is found');
    const rest = code.slice(at + 1);
    const end = rest.search(/\n(?:export )?(?:async )?function /);
    const body = rest.slice(0, end < 0 ? undefined : end);
    const hs = body.indexOf('hookServer.start();');
    const w = body.indexOf('setImmediate(() => heavyJobs.warm());');
    assert.ok(hs >= 0, 'hookServer.start() is in bootstrapHiveServices');
    assert.ok(w > hs, `WARM IS DEFERRED WITH setImmediate, AFTER hookServer.start() (at ${w}, start at ${hs})`);
    assert.doesNotMatch(code, /await\s+heavyJobs\.warm/, 'WARM IS NEVER AWAITED');
    assert.equal(code.split('heavyJobs.warm(').length - 1, 1, 'one warm call');
    const wr = code.indexOf('app.whenReady().then(() => {');
    assert.ok(wr >= 0);
    const after = code.slice(wr);
    const b = after.indexOf('bootstrapHiveServices();');
    const cw = after.indexOf('createWindow();');
    assert.ok(b >= 0 && cw > b, 'start-up runs bootstrapHiveServices (and so the warm) before the window');
  }
};

test('F1: a cold helper\'s first create waits the start budget and is held at 5 s; the next waits 3 s', () => K.f1(C));
test('F2: a helper replaced as dead: the new one gets the start budget again', () => K.f2(C));
test('F3: serveChannel: a request after the helper exited answers null at once', () => K.f3(C));
test('F4: a create past the start budget: not held, logged cause start, nothing replaced', () => K.f4(C));
test('F5: serveChannel honours the ms it is given; a reply answers; spawned hidden', () => K.f5(C));
test('F6: an mcp create waits only the mcp client\'s limit (2.5 s), logged as deadline', () => K.f6(C));
test('F7: a pipe create answered at 2.9 s is cut: not held, no tell, its job is closed', () => K.f7(C));
test('F8: an event line and a garbage line are no answer: the start budget holds', () => K.f8(C));
test('F9: three cut creates in a row replace nothing', () => K.f9(C));
test('F10: a one-way hook is not wrapped; no transport waits as pipe', () => K.f10(C));
test('F11: no time left (past and exactly at the deadline): nothing is sent, logged early', () => K.f11(C));
test('W1: warm() is fire-and-forget, one close of a job no one made, logs one helper-start warm', () => K.w1(C));
test('W2: warm() does nothing without the helper or off Windows', () => K.w2(C));
test('W3: warm() runs once, and not after a call started the helper', () => K.w3(C));
test('W4: warm() after dispose starts nothing; a warm answered after dispose starts nothing', () => K.w4(C));
test('W5: a warm that met a dead helper is not run again', () => K.w5(C));
test('W6: a call behind a pending warm gets what is left of the start budget', () => K.w6(C));
test('W7: index.ts warms after hookServer.start() with setImmediate, never awaited, before the window', () => K.w7(readSource(INDEX_FILE)));

test('W9: a warm miss counts as any unanswered request: the third miss in a row replaces the helper', async () => {
  const R = rig(C, { script: (line) => (line === 'close guppy-warm' ? { at: 13_000, r: { ok: true } } : line.startsWith('close ') ? 'pending' : { at: 4_000, r: { ok: true } }) });
  R.jobs.warm(); await flush();
  await http(R.jobs, 1, R.clock);
  await flush();
  assert.equal(R.chans[0].closed, false, 'two misses: kept');
  await http(R.jobs, 2, R.clock);
  await flush();
  assert.equal(R.chans[0].closed, true, 'the third miss in a row replaces it');
  const hs = R.rows.filter((r) => r.action === 'helper-start');
  assert.equal(hs.length, 1);
  assert.equal(hs[0].ok, false);
  assert.equal(hs[0].warm, true);
});

test('H1: hooks.ts stamps the arrival; the pipe stamps it net of the shim\'s own time; begin gets it', () => {
  const src = codeOnly(readSource(HOOKS_FILE), 'hooks.ts');
  assert.ok(src.includes('    p.arrived_ms = arrivedMs;'), 'stampArrival records the arrival');
  assert.ok(src.includes("this.stampArrival(payload, 'pipe', receivedAt - shimMs)"), 'the pipe arrival is net of the shim\'s own running time');
  assert.ok(src.includes("arrivedMs: typeof p.arrived_ms === 'number' ? p.arrived_ms : null"), 'the heavy wrap carries the arrival');
  assert.ok(src.includes('this.heavyJobs!.begin(wrap.agentId, wrap.toolInput, wrap.cmd, wrap.callId, wrap.transport, wrap.arrivedMs)'), 'begin gets the transport and the arrival');
});

// ─── LIVE: the shipped helper ───────────────────────────────────────────────────────────────

const CSC = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const LIVE_SKIP = process.platform !== 'win32' ? 'Windows only (Job Objects)' : !fs.existsSync(CSC) ? 'no in-box csc' : false;
const COLD_MS = 4_000;
const dirs = [];
test.after(async () => { for (const d of dirs) await removeDir(d); });

/** The shipped helper, compiled; with `ms` > 0 its `serve` waits that long first (a slow cold start). */
function helperExe(ms) {
  const src = readSource(path.join(root, 'resources', 'heavyjob', 'guppy-heavyjob.cs'));
  const serve = '    static int Serve()\n    {';
  assert.ok(src.includes(serve), 'the helper still has the Serve seam');
  const out = ms > 0 ? src.replace(serve, `${serve}\n        System.Threading.Thread.Sleep(${ms}); // test: a slow cold start`) : src;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hjct108-'));
  dirs.push(dir);
  const exe = path.join(dir, 'guppy-heavyjob.exe');
  const cs = path.join(dir, 'guppy-heavyjob.cs');
  fs.writeFileSync(cs, out);
  const c = spawnSync(CSC, ['-nologo', '-O', `-out:${exe}`, cs], { encoding: 'utf8', windowsHide: true });
  assert.equal(c.status, 0, `csc: ${c.stdout}${c.stderr}`);
  return exe;
}

test('LIVE: a helper slow to start (past the request timeout) still holds the job and frees the slot within 5 s of its exit, on one helper', { skip: LIVE_SKIP, timeout: 60_000 }, async (t) => {
  assert.ok(COLD_MS > C.HEAVY_JOB_REQUEST_MS && COLD_MS < C.HEAVY_JOB_START_MS, 'the cold start is past the request timeout, within the start budget');
  const exe = helperExe(COLD_MS);
  const rows = [];
  let helpers = 0;
  const lock = new HJ.HeavyJobLock({ limit: () => 1, log: (r) => rows.push({ ...r, ts: Date.now() }) });
  const jobs = new C.HeavyJobs({
    platform: 'win32', options: () => ({ background: false, cap: false }), exe: () => exe,
    channel: (x) => {
      helpers++;
      const base = C.serveChannel(x);
      // Every answer and event is logged, so a red names what came back and when.
      const w = Object.create(base);
      w.request = async (...a) => { const r = await base.request(...a); rows.push({ kind: 'heavy-cpu', action: `req ${String(a[0]).split(' ')[0]}=${r ? r.ok : 'null'}`, ts: Date.now() }); return r; };
      w.onEvent = (fn) => base.onEvent((e) => { rows.push({ kind: 'heavy-cpu', action: `event ${e.event}`, what: String(e.msg ?? e.action ?? ''), ts: Date.now() }); fn(e); });
      return w;
    },
    log: (r) => rows.push({ ...r, ts: Date.now() }),
    onJob: (e) => { if (e.state === 'held') lock.noteJob(e.agentId, e.callId, e.job); else lock.jobExited(e.agentId, e.callId, e.job); }
  });
  t.after(() => jobs.dispose());
  assert.equal(lock.acquire(AGENT, BENCH, 'bash cut.sh', 'call-1', true).acquired, true);
  const body = 'sleep 2';
  // As the agent's CLI does: the wrapped command starts once begin has returned it.
  assert.ok(await jobs.begin(AGENT, { command: body }, false, 'call-1', 'http', Date.now()), 'the call is wrapped');
  const id = rows.find((r) => r.action === 'wrap').job;
  const local = fs.mkdtempSync(path.join(os.tmpdir(), 'hjct108-local-'));
  dirs.push(local);
  const sh = spawn(gitBash(), ['-c', `"${exe.replace(/\\/g, '/')}" join ${id} 0 0; ${body}`], { stdio: 'ignore', windowsHide: true, env: { ...process.env, LOCALAPPDATA: local } });
  const exitAt = await new Promise((r) => sh.on('exit', () => r(Date.now())));
  const deadline = exitAt + 6_000;
  while (lock.snapshot().length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  const rel = rows.find((r) => r.kind === 'heavy-lock' && r.action === 'release');
  const lag = rel ? rel.ts - exitAt : null;
  const trail = rows.filter((x) => x.kind === 'heavy-cpu').map((x) => `${x.ts - exitAt}ms ${x.action}${x.what ? ' ' + x.what : ''}${x.held !== undefined ? ' held=' + x.held : ''}`).join(', ');
  assert.equal(rows.find((r) => r.action === 'wrap').held, true, `A COLD START IS NOT A FAILED CREATE: THE JOB IS HELD (${trail})`);
  // The same bar as the sister cell heavy-lock-release-lag-197 (lagMs < 5 s).
  assert.ok(lag !== null && lag >= 0 && lag < 5_000,
    `THE SLOT IS FREED WITHIN 5 S OF THE JOB'S EXIT (${lag === null ? 'not freed 6 s after it' : `freed ${lag} ms after`}; ${trail})`);
  assert.equal(rel.reason, 'job-exit');
  assert.equal(helpers, 1, 'ONE HELPER: a slow start does not start another');
});

test('W8 LIVE: a warmed helper ends with the process that started it (no orphan)', { skip: LIVE_SKIP, timeout: 60_000 }, async (t) => {
  const exe = helperExe(0);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hjct108-home-'));
  dirs.push(home);
  const script = path.join(home, 'warm-child.cjs');
  fs.writeFileSync(script, [
    "'use strict';",
    `if (process.env.HOME !== ${JSON.stringify(home)} || process.env.USERPROFILE !== ${JSON.stringify(home)}) { console.error('home not redirected'); process.exit(3); }`,
    `const loadTs = require(${JSON.stringify(path.join(__dirname, 'load-ts.cjs'))});`,
    `const C = loadTs(${JSON.stringify(CPU_FILE)});`,
    `const jobs = new C.HeavyJobs({ platform: 'win32', options: () => ({ background: false, cap: false }), exe: () => ${JSON.stringify(exe)}, log: (r) => console.log(JSON.stringify(r)) });`,
    'jobs.warm();',
    'setInterval(() => {}, 1000);'
  ].join('\n'));
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(HIVE|AGENT|MEMORY|MUNDER)_/.test(k) && !['NODE_OPTIONS', 'NO_COLOR', 'FORCE_COLOR'].includes(k)) env[k] = v;
  env.HOME = home;
  env.USERPROFILE = home;
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: nodeEnv(env) });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const gone = new Promise((r) => child.on('exit', r));
  t.after(async () => { try { child.kill(); } catch { /* gone */ } await race(gone, 5_000); });
  const until = Date.now() + 20_000;
  let hs = null;
  while (!hs && Date.now() < until && child.exitCode === null) {
    hs = out.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((r) => r && r.action === 'helper-start') ?? null;
    if (!hs) await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(hs, `the warm logged its helper-start (out ${out}; err ${err})`);
  assert.equal(hs.ok, true, `the warmed helper answered (${JSON.stringify(hs)})`);
  assert.equal(hs.warm, true);
  const [me] = lookupPids([child.pid]);
  assert.ok(me, 'the node child is found');
  const kids = childrenOf(processTable(`ParentProcessId=${child.pid}`), me).filter((r) => /guppy-heavyjob/i.test(r.name));
  assert.equal(kids.length, 1, `one helper under the child (${JSON.stringify(kids)})`);
  const helper = kids[0];
  child.kill();
  await race(gone, 5_000);
  const end = Date.now() + 5_000;
  let still = true;
  while (still && Date.now() < end) {
    still = lookupPids([helper.pid]).some((r) => r.created === helper.created);
    if (still) await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(still, false, `THE WARMED HELPER ENDS WITHIN 5 S OF ITS PARENT (pid ${helper.pid})`);
});

// ─── MUTANT CENSUS ──────────────────────────────────────────────────────────────────────────

function mutatedText(file, edits, tag) {
  let text = readSource(file);
  for (const [from, to] of edits) {
    const hits = text.split(from).length - 1;
    assert.equal(hits, 1, `mutant ${tag}: edit target must match EXACTLY ONCE, matched ${hits}: ${JSON.stringify(from.slice(0, 80))}`);
    text = text.replace(from, () => to);
  }
  return text;
}

const BUDGET = '    return Math.max(this.chSpawnAt + HEAVY_JOB_START_MS - this.now(), HEAVY_JOB_REQUEST_MS);';
const WAIT = '    const wait = deadline === null ? full : Math.max(0, Math.min(full, deadline - this.now()));';
const WARM_SEND = "    void this.send('close guppy-warm', null).then(() => undefined, () => undefined);\n";
const WARM_GUARD = "    if (this.d.platform !== 'win32' || this.disposed || this.warmed || this.ch !== null || !this.d.exe()) return;";
const WARM_CALL = 'setImmediate(() => heavyJobs.warm());';
const MUTANTS = [
  { name: 'no start budget: every request waits 3 s', edits: [[BUDGET, '    return HEAVY_JOB_REQUEST_MS;']], killer: 'f1', dies: /START BUDGET/ },
  { name: 'an answer does not end the start budget', edits: [['this.unanswered = 0; this.answered = true;', 'this.unanswered = 0;']], killer: 'f1', dies: /ONCE ANSWERED/ },
  { name: 'a new helper does not start the budget again', edits: [['    this.answered = false;\n', '']], killer: 'f2', dies: /A NEW HELPER GETS THE START BUDGET AGAIN/ },
  { name: 'serveChannel ignores the ms it is given', edits: [['}, ms);\n        t.unref?.();', '}, HEAVY_JOB_REQUEST_MS);\n        t.unref?.();']], killer: 'f5', dies: /A REQUEST WAITS THE MS IT IS GIVEN/ },
  { name: 'serveChannel waits on a helper that exited', edits: [['      if (dead) return Promise.resolve(null);\n', '']], killer: 'f3', dies: /A REQUEST TO A HELPER THAT EXITED ANSWERS NULL AT ONCE/ },
  { name: 'the hook client\'s deadline does not bound the wait', edits: [[WAIT, '    const wait = full;']], killer: 'f6', dies: /A CREATE WAITS NO LONGER THAN ITS HOOK CLIENT/ },
  { name: 'the start budget is not counted from the spawn', edits: [[BUDGET, '    return HEAVY_JOB_START_MS;']], killer: 'w6', dies: /A REQUEST QUEUED BEHIND A SLOW START GETS ONLY WHAT IS LEFT/ },
  { name: 'mcp gets the http client\'s wait', edits: [['hookClientTimeoutMs(transport))', "hookClientTimeoutMs(transport === 'mcp' ? 'http' : transport))"]], killer: 'f6', dies: /A CREATE WAITS NO LONGER THAN ITS HOOK CLIENT/ },
  { name: 'a cut create counts toward a replace', edits: [['    if (cut) return { r, cut, cold, ms };\n', '']], killer: 'f9', dies: /A CUT CREATE COUNTS TOWARD NO REPLACE/ },
  { name: 'a one-way hook is wrapped', edits: [["    if (transport === 'pipe-oneway') return null;\n", '']], killer: 'f10', dies: /A ONE-WAY HOOK IS NOT WRAPPED/ },
  { name: 'a create is sent with no time left', edits: [['    if (deadline - this.now() <= HEAVY_JOB_DEADLINE_FLOOR_MS) {', '    if (false) {']], killer: 'f11', dies: /NO TIME LEFT: NOTHING IS SENT/ },
  { name: 'warm starts the helper but sends nothing', edits: [[WARM_SEND, '']], killer: 'w1', dies: /WARM SENDS ONE REQUEST/ },
  { name: 'warm runs again after its helper was replaced', edits: [[WARM_GUARD, WARM_GUARD.replace(' || this.warmed', '')]], killer: 'w5', dies: /WARM RUNS ONCE/ },
  { name: 'warm starts a helper after dispose', edits: [[WARM_GUARD, WARM_GUARD.replace(' || this.disposed', '')], ['    if (this.disposed) return null;\n    if (this.ch) return this.ch;', '    if (this.ch) return this.ch;']], killer: 'w4', dies: /NO HELPER IS STARTED BY A WARM AFTER DISPOSE/ },
  { name: 'warm is async and awaits its request', edits: [['  warm(): void {', '  async warm(): Promise<void> {'], [WARM_SEND, "    await this.send('close guppy-warm', null);\n"]], killer: 'w1', dies: /WARM RETURNS NOTHING/ },
  { name: 'the warm request makes a job', edits: [["this.send('close guppy-warm', null)", "this.send('create guppy-warm 0 0', null)"]], killer: 'w1', dies: /THE WARM REQUEST IS A CLOSE OF A JOB NO ONE MADE/ },
  { name: 'index.ts awaits the warm', file: INDEX_FILE, edits: [[WARM_CALL, 'await heavyJobs.warm();']], killer: 'w7', dies: /WARM IS DEFERRED WITH setImmediate/ },
  { name: 'index.ts warms inline, not deferred', file: INDEX_FILE, edits: [[WARM_CALL, 'heavyJobs.warm();']], killer: 'w7', dies: /WARM IS DEFERRED WITH setImmediate/ }
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  for (const m of MUTANTS) {
    await t.test(`mutant: ${m.name}`, async () => {
      const file = m.file ?? CPU_FILE;
      const text = mutatedText(file, m.edits, m.name);
      const arg = file === CPU_FILE ? loadTs.fromText(CPU_FILE, text) : text;
      await assert.rejects(() => K[m.killer](arg), (e) => {
        assert.match(String(e && e.message), m.dies, `${m.name}: died for the wrong reason: ${e && e.message}`);
        return true;
      });
    });
  }
});
