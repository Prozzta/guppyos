'use strict';
require('./tools/own-job.cjs');
/**
 * ELECTRON-RM-EPERM-UNKNOWN-CAUSE-108 (god 6addb8, pin C): once a HiveManager is shut down in the
 * app's order (stopLedgerGuard(), dispose(), await drainReads()) it holds NO directory watcher and
 * NO open file inside its folder.
 *
 * Why it matters: change-home and reset shut the manager down and then copy or delete the folder.
 * Under Electron 45 on Windows a recursive rmSync of a tree with a watcher or a file still open
 * inside it throws ENOTEMPTY, the folder stays delete-pending, and the next rm, mkdir or readdir on
 * it throws EPERM. Runner Node deletes such a tree, so the delete alone proves nothing there:
 * this file counts the handles itself (every fs.watch and fs.openSync under the folder, and its
 * close), which holds on both runtimes, and then deletes the folder as the real consequence.
 * HOME and USERPROFILE are jailed and asserted first.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-dispose-handles-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME, GEMINI_CLI_HOME: process.env.GEMINI_CLI_HOME };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL; process.env.CODEX_HOME = path.join(JAIL, '.codex'); process.env.GEMINI_CLI_HOME = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');

// The count, installed before any product code loads: product code calls fs.watch / fs.openSync /
// fs.closeSync through the module object, so it reaches these.
const open = new Set();
const realWatch = fs.watch; const realOpen = fs.openSync; const realClose = fs.closeSync;
const byFd = new Map();
fs.watch = function (p, ...rest) {
  const w = realWatch.call(this, p, ...rest);
  const rec = { kind: 'watch', path: path.resolve(String(p)) };
  open.add(rec);
  const close = w.close.bind(w);
  w.close = () => { open.delete(rec); return close(); };
  return w;
};
fs.openSync = function (p, ...rest) {
  const fd = realOpen.call(this, p, ...rest);
  const rec = { kind: 'fd', path: path.resolve(String(p)) };
  open.add(rec); byFd.set(fd, rec);
  return fd;
};
fs.closeSync = function (fd) {
  const rec = byFd.get(fd);
  if (rec) { open.delete(rec); byFd.delete(fd); }
  return realClose.call(this, fd);
};
test.after(() => {
  fs.watch = realWatch; fs.openSync = realOpen; fs.closeSync = realClose;
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const { HiveManager } = loadTs('src/main/hive.ts');

/** What is open inside `dir`, as 'kind relative-path' lines. */
const openUnder = (dir) => [...open].filter((r) => r.path === dir || r.path.startsWith(dir + path.sep))
  .map((r) => `${r.kind} ${path.relative(dir, r.path) || '.'}`).sort();

async function floor() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(JAIL, 'floor-')));
  const hive = new HiveManager(() => home, () => true);
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'andy-1', name: 'Andy', provider: 'claude', cwd: home });
  hive.send({ to: 'andy-1', act: 'request', subject: 'Review PR 12', body: 'please' }, 'god-1');
  return { home, hive };
}
/** The app's order at change-home and reset (src/main/index.ts). */
async function shutDown(hive) { hive.stopLedgerGuard(); hive.dispose(); await hive.drainReads(); }
function deletes(home) {
  assert.doesNotThrow(() => fs.rmSync(home, { recursive: true, force: true }), 'the folder deletes once the manager is shut down');
  assert.equal(fs.existsSync(home), false, 'and it is gone (not left delete-pending)');
}

test('a manager that watched and logged holds no watcher and no open file in its folder after stopLedgerGuard(), dispose() and drainReads()', async () => {
  const { home, hive } = await floor();
  hive.startLedgerGuard();
  hive.tasks();
  hive.mailObligations();
  await hive.mailObligationsAsync();
  const used = openUnder(home);
  // Not vacuous: the guard's watcher or an authority watcher, and the kept-open log, are there now.
  assert.ok(used.some((l) => l.startsWith('watch ')), `a live manager watches its folder: ${JSON.stringify(used)}`);
  assert.ok(used.some((l) => l.startsWith('fd ')), `a live manager keeps a file open: ${JSON.stringify(used)}`);
  await shutDown(hive);
  assert.deepEqual(openUnder(home), [], 'nothing of the manager is open in its folder after shutdown');
  deletes(home);
});

test('a second manager over the same folder is closed by its own shutdown, not by the first one\'s', async () => {
  const { home, hive } = await floor();
  const cold = new HiveManager(() => home, () => true);
  await cold.mailObligationsAsync();
  cold.mailObligations();
  await shutDown(hive);
  const left = openUnder(home);
  assert.ok(left.length > 0, 'the second manager still holds its own handles: each manager closes only what it opened');
  await shutDown(cold);
  assert.deepEqual(openUnder(home), [], 'nothing is open once both are shut down');
  deletes(home);
});

/**
 * HIVE-DISPOSE-INFLIGHT-REARM: dispose() closes the authority watchers and the missed-watch timer,
 * but an async roster read already open at that moment finishes afterwards and installs its result.
 * That install used to put the watcher and the timer back on a disposed manager (measured: three
 * floors of mail-channel-recover-189 kept a watcher this way and their delete failed under
 * Electron). The read is held open with a gated fs.promises.readFile, so the order is forced.
 */
const turn = () => new Promise((r) => setImmediate(r));
const disposed = (e) => e?.name === 'HiveDisposedError' && e.code === 'EHIVEDISPOSED';
const watches = (home) => openUnder(home).filter((l) => l.startsWith('watch '));
/**
 * Holds every call that goes through it until release(). `entered` resolves at the first held
 * call, so a test waits for the product to arrive, however long its earlier file work takes.
 */
function gate() {
  let enter;
  const g = {
    open: 0, gated: true, waiting: [],
    entered: new Promise((r) => { enter = r; }),
    async through(run) {
      g.open++; enter();
      try { if (g.gated) await new Promise((go) => { g.waiting.push(go); }); return await run(); } finally { g.open--; }
    },
    release() { g.gated = false; for (const go of g.waiting.splice(0)) go(); }
  };
  return g;
}
/** Waits for the gate's first call. The clock here only words the failure: it decides no pass. */
const reached = (g, what) => new Promise((ok, no) => {
  const late = setTimeout(() => no(new Error(`never reached the gate: ${what}`)), 60_000);
  void g.entered.then(() => { clearTimeout(late); ok(); });
});

test('a roster read open at dispose() finishes without putting the watcher or the fallback timer back; reopen() allows both again', async (t) => {
  const { home, hive } = await floor();
  await shutDown(hive);
  assert.deepEqual(openUnder(home), [], 'control: the floor starts with nothing open');

  // Control: the same ask on a live manager arms both, so "none" below is a real observation.
  const live = new HiveManager(() => home, () => true);
  await live.mailObligationsAsync();
  assert.ok(watches(home).length > 0, 'control: a live roster read arms an authority watcher');
  await live.__revalidateAuthoritiesForTests();
  await shutDown(live);
  assert.deepEqual(openUnder(home), [], 'control: its shutdown closes them');

  const cold = new HiveManager(() => home, () => true);
  const registry = path.join(cold.root(), 'registry.json');
  const real = fs.promises.readFile;
  const g = gate();
  fs.promises.readFile = function gatedRosterRead(p, ...rest) {
    if (path.resolve(String(p)) !== path.resolve(registry)) return real.call(fs.promises, p, ...rest);
    return g.through(() => real.call(fs.promises, p, ...rest));
  };
  t.after(async () => { g.release(); fs.promises.readFile = real; cold.dispose(); await cold.drainReads(); });

  const asked = cold.mailObligationsAsync().then(() => null, (e) => e);
  await reached(g, 'the roster read of registry.json');
  assert.equal(g.open, 1, 'the roster read is open and held');

  cold.dispose();
  g.release();
  await cold.drainReads();
  assert.ok(disposed(await asked), 'the ask that was in flight at dispose() rejects with HiveDisposedError');
  assert.deepEqual(watches(home), [], 'the read that finished after dispose() put a watcher back');
  await assert.rejects(cold.__revalidateAuthoritiesForTests(), /fallback is not armed/, 'the read that finished after dispose() put the fallback timer back');

  // reopen() lifts it: the next authority read arms both again.
  cold.reopen();
  const tasks = path.join(cold.root(), 'tasks.json');
  if (!fs.existsSync(tasks)) fs.writeFileSync(tasks, JSON.stringify({ tasks: [] }) + '\n');
  cold.tasks();
  assert.ok(watches(home).length > 0, 'after reopen() an authority read arms the watcher again');
  await cold.__revalidateAuthoritiesForTests();
  await shutDown(cold);
  assert.deepEqual(openUnder(home), [], 'nothing is open after the last shutdown');
  deletes(home);
});

test('a roster ask after dispose() rejects and does not read the roster synchronously instead', async (t) => {
  const { home, hive } = await floor();
  await shutDown(hive);
  const cold = new HiveManager(() => home, () => true);
  const registry = path.resolve(path.join(cold.root(), 'registry.json'));
  const realRead = fs.readFileSync;
  let syncReads = 0;
  fs.readFileSync = function (p, ...rest) {
    if (typeof p === 'string' && path.resolve(p) === registry) syncReads++;
    return realRead.call(this, p, ...rest);
  };
  t.after(() => { fs.readFileSync = realRead; });

  const live = new HiveManager(() => home, () => true);
  live.mailObligations();
  assert.ok(syncReads >= 1, 'control: a synchronous roster read is counted');
  await shutDown(live);

  cold.dispose();
  syncReads = 0;
  await assert.rejects(cold.mailObligationsAsync(), disposed, 'a roster ask after dispose() must reject with HiveDisposedError');
  assert.equal(syncReads, 0, 'the ask fell back to a synchronous read of the roster in a folder being torn down');
  await cold.drainReads();
  assert.deepEqual(openUnder(home), [], 'and nothing was opened in the folder');
  deletes(home);
});

/**
 * HIVE-DISPOSE-INFLIGHT-REARM, router half: dispose() used to leave the router to its caller, and
 * drainReads() waited only for the manager's counted reads. A route pass in flight goes on between
 * those reads, so "dispose, drain, delete" could delete under a pass that was still running.
 */
test('dispose() stops the router itself: no outbox watcher is left in the folder', async (t) => {
  const { home, hive } = await floor();
  t.after(() => hive.stopRouter());
  hive.startRouter();
  await hive.routerIdle();
  const used = watches(home);
  assert.ok(used.some((l) => /outbox$/.test(l)), `control: a running router watches the outboxes: ${JSON.stringify(used)}`);
  // No stopRouter() here: dispose() is the only call.
  hive.stopLedgerGuard(); hive.dispose(); await hive.drainReads();
  assert.deepEqual(openUnder(home), [], 'dispose() left a router watcher in the folder');
  deletes(home);
});

test('startRouter() on a disposed manager arms nothing (a power resume between dispose() and the delete); after reopen() it starts again', async (t) => {
  const { home, hive } = await floor();
  await shutDown(hive);
  const intervals = [];
  const runtime = { setInterval: (fn, ms) => { const h = setInterval(fn, ms); intervals.push(h); return h; } };
  const cold = new HiveManager(() => home, () => true, runtime);
  t.after(async () => { cold.stopRouter(); cold.dispose(); await cold.drainReads(); for (const h of intervals) clearInterval(h); });

  // Control: a live startRouter() arms the reconcile timer and an outbox watcher.
  cold.startRouter();
  await cold.routerIdle();
  assert.equal(intervals.length, 1, 'control: a live startRouter() arms the reconcile timer');
  assert.ok(watches(home).some((l) => /outbox$/.test(l)), `control: a live startRouter() watches the outboxes: ${JSON.stringify(watches(home))}`);

  cold.stopLedgerGuard(); cold.dispose(); await cold.drainReads();
  assert.deepEqual(openUnder(home), [], 'control: shutdown leaves nothing open');
  // What onSystemResume does (src/main/index.ts): stopRouter(), startRouter(), routeOnce().
  cold.stopRouter();
  cold.startRouter();
  await cold.routerIdle();
  assert.equal(intervals.length, 1, 'startRouter() on a disposed manager armed the reconcile timer');
  assert.deepEqual(openUnder(home), [], 'startRouter() on a disposed manager opened a watcher in the folder');
  assert.deepEqual(cold.watchedOutboxes(), [], 'and it watches no outbox');

  cold.reopen();
  cold.startRouter();
  await cold.routerIdle();
  assert.equal(intervals.length, 2, 'after reopen() the router starts again');
  assert.ok(watches(home).some((l) => /outbox$/.test(l)), 'after reopen() it watches the outboxes again');
  cold.stopLedgerGuard(); cold.dispose(); await cold.drainReads();
  assert.deepEqual(openUnder(home), [], 'nothing is open after the last shutdown');
  deletes(home);
});

test('drainReads() does not resolve while a route pass is in flight, even with none of its reads open', async (t) => {
  const { home, hive } = await floor();
  const outbox = path.resolve(path.join(hive.agentDir('god-1'), 'outbox'));
  fs.mkdirSync(outbox, { recursive: true });
  await hive.routerIdle();
  const real = fs.promises.readdir;
  const g = gate();
  fs.promises.readdir = function gatedOutboxList(p, ...rest) {
    if (path.resolve(String(p)) !== outbox) return real.call(fs.promises, p, ...rest);
    return g.through(() => real.call(fs.promises, p, ...rest));
  };
  t.after(async () => { g.release(); fs.promises.readdir = real; hive.dispose(); await hive.drainReads(); });

  let passSettled = false;
  hive.routeOnce([outbox]).then(() => { passSettled = true; }, () => { passSettled = true; });
  await reached(g, 'the route pass listing the outbox');
  assert.equal(g.open, 1, 'the pass is in flight, held at its listing of the outbox');

  hive.stopLedgerGuard(); hive.dispose();
  let waited = false; let settledWhenWaitEnded = null;
  const wait = hive.drainReads().then(() => { waited = true; settledWhenWaitEnded = passSettled; });
  for (let i = 0; i < 20; i++) await turn();
  assert.equal(waited, false, 'the wait ended with a route pass still in flight: the delete would run under it');
  g.release();
  await wait;
  assert.equal(settledWhenWaitEnded, true, 'the wait ended before the route pass had finished');
  assert.deepEqual(openUnder(home), [], 'nothing is open once the wait has ended');
  deletes(home);
});

test('routeOnce() on a disposed manager runs no pass: neither one asked after dispose() nor one queued before it', async (t) => {
  const { home, hive } = await floor();
  await shutDown(hive);
  const cold = new HiveManager(() => home, () => true);
  const outbox = path.resolve(path.join(cold.agentDir('god-1'), 'outbox'));
  fs.mkdirSync(outbox, { recursive: true });
  const real = fs.promises.readdir;
  let g = gate(); g.release();
  let lists = 0;
  fs.promises.readdir = function countedOutboxList(p, ...rest) {
    if (path.resolve(String(p)) !== outbox) return real.call(fs.promises, p, ...rest);
    lists++;
    return g.through(() => real.call(fs.promises, p, ...rest));
  };
  t.after(async () => { g.release(); fs.promises.readdir = real; cold.dispose(); await cold.drainReads(); });

  // Control: a live pass lists the outbox, so "not listed" below is a real observation.
  await cold.routeOnce([outbox]);
  assert.equal(lists, 1, 'control: a live pass lists the outbox once');

  g = gate(); lists = 0;
  const first = cold.routeOnce([outbox]).then(() => null, (e) => e);
  await reached(g, 'the first pass listing the outbox');
  const queued = cold.routeOnce([outbox]);            // waits behind the held pass
  cold.stopLedgerGuard(); cold.dispose();
  const after = cold.routeOnce([outbox]);             // asked for on a disposed manager
  g.release();
  await cold.drainReads();
  await first;
  assert.equal(await queued, 0, 'the pass queued before dispose() delivers nothing');
  assert.equal(await after, 0, 'the pass asked for after dispose() delivers nothing');
  assert.equal(lists, 1, 'a route pass ran on a disposed manager: it listed the outbox');
  assert.deepEqual(openUnder(home), [], 'nothing is open in the folder');
  await assert.rejects(cold.__revalidateAuthoritiesForTests(), /fallback is not armed/, 'and the fallback timer is off');
  deletes(home);
});

test('a route pass whose read of a half-written outbox file was open at dispose() arms no retry timer when it finishes', async (t) => {
  const { home, hive } = await floor();
  await shutDown(hive);
  const timers = [];
  const runtime = { setTimeout: (fn, ms) => { timers.push(ms); return null; } };
  const real = fs.promises.readFile;
  let g = gate(); g.release();
  let held = null;
  fs.promises.readFile = function gatedOutboxRead(p, ...rest) {
    if (held === null || path.resolve(String(p)) !== held) return real.call(fs.promises, p, ...rest);
    return g.through(() => real.call(fs.promises, p, ...rest));
  };
  const live = new HiveManager(() => home, () => true, runtime);
  const cold = new HiveManager(() => home, () => true, runtime);
  t.after(async () => { g.release(); fs.promises.readFile = real; for (const m of [live, cold]) { m.dispose(); await m.drainReads(); } });
  const outbox = path.resolve(path.join(live.agentDir('god-1'), 'outbox'));
  fs.mkdirSync(outbox, { recursive: true });
  held = path.join(outbox, 'half-written.json');
  fs.writeFileSync(held, '{"to": "andy-1", "subj');   // a writer still streaming: not JSON yet

  // Control: a live pass that reads the half-written file arms one retry timer.
  await live.routeOnce([outbox]);
  assert.equal(timers.length, 1, `control: a live pass arms a retry for the half-written file: ${JSON.stringify(timers)}`);
  await shutDown(live);

  timers.length = 0; g = gate();
  const pass = cold.routeOnce([outbox]).then(() => null, (e) => e);
  await reached(g, 'the route pass reading the half-written outbox file');
  cold.stopLedgerGuard(); cold.dispose();
  g.release();
  await cold.drainReads();
  await pass;
  assert.deepEqual(timers, [], 'the pass that finished after dispose() armed a retry timer');
  assert.deepEqual(openUnder(home), [], 'nothing is open in the folder');
  await assert.rejects(cold.__revalidateAuthoritiesForTests(), /fallback is not armed/, 'and the fallback timer is off');
  deletes(home);
});

// HIVE-DISPOSE-APPENDLOG-AFTER-DISPOSE-108 (Creed, Electron suite red at the test above): the same
// pass, but the half-written file is OLDER than the fresh-write grace (1 s) when the pass resumes.
// Under a slow suite the file ages by itself; here its write time is set 5 s back, so the age does
// not depend on load. Past the grace the pass takes the parse-retry branch, which logs
// 'outbox-parse-retry'. That log row, written after dispose(), reopens hive/log.jsonl.
test('a route pass whose read of an AGED half-written outbox file was open at dispose() writes no log row and leaves no file open', async (t) => {
  const { home, hive } = await floor();
  await shutDown(hive);
  const timers = [];
  const runtime = { setTimeout: (fn, ms) => { timers.push(ms); return null; } };
  const real = fs.promises.readFile;
  const g = gate();
  let held = null;
  fs.promises.readFile = function gatedOutboxRead(p, ...rest) {
    if (held === null || path.resolve(String(p)) !== held) return real.call(fs.promises, p, ...rest);
    return g.through(() => real.call(fs.promises, p, ...rest));
  };
  const cold = new HiveManager(() => home, () => true, runtime);
  t.after(async () => { g.release(); fs.promises.readFile = real; cold.dispose(); await cold.drainReads(); });
  const outbox = path.resolve(path.join(cold.agentDir('god-1'), 'outbox'));
  fs.mkdirSync(outbox, { recursive: true });
  const file = path.join(outbox, 'half-written.json');
  fs.writeFileSync(file, '{"to": "andy-1", "subj');   // a writer still streaming: not JSON yet
  const aged = new Date(Date.now() - 5000);
  fs.utimesSync(file, aged, aged);
  assert.ok(Date.now() - fs.statSync(file).mtimeMs >= 4000, 'the file is well past the 1 s fresh-write grace');
  const logFile = path.join(home, 'hive', 'log.jsonl');
  const retryRows = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '').split('\n').filter((l) => l.includes('"outbox-parse-retry"')).length;
  const rowsBefore = retryRows();
  held = file;

  const pass = cold.routeOnce([outbox]).then(() => null, (e) => e);
  await reached(g, 'the route pass reading the aged half-written outbox file');
  cold.stopLedgerGuard(); cold.dispose();
  assert.deepEqual(openUnder(home), [], 'dispose() closed everything while the read was still open');
  g.release();
  await cold.drainReads();
  await pass;
  assert.deepEqual(openUnder(home), [], 'the pass that finished after dispose() left a file open in the folder');
  assert.equal(retryRows(), rowsBefore, 'and it wrote no outbox-parse-retry row to the log of a disposed manager');
  assert.deepEqual(timers, [], 'and armed no retry timer');
  deletes(home);
});

/**
 * HIVE-DISPOSE-APPENDLOG-AFTER-DISPOSE-108, the whole defect (Jim's audit of the test above): a
 * route pass awaits file work at several places, and dispose() can land during any of them. When
 * the awaited call returns or fails, the pass carries on: it rejects a valid mail, delivers a
 * notice, archives, and logs, which reopens hive/log.jsonl in a folder that is about to be deleted.
 * One test per await below. Each holds that one call open across dispose(), then lets it finish.
 * No clock decides anything: the order is forced by the gate.
 */
const logRows = (home) => {
  const f = path.join(home, 'hive', 'log.jsonl');
  return (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '').split('\n').filter(Boolean);
};
const rowKind = (line) => { try { const r = JSON.parse(line); return [r.kind, r.stage ?? r.action].filter(Boolean).join('/'); } catch { return line; } };

/** A shut-down floor, a second manager over it, and one file in god-1's outbox. */
async function passRig(t, payload) {
  const { home, hive } = await floor();
  await shutDown(hive);
  const timers = [];
  const cold = new HiveManager(() => home, () => true, { setTimeout: (fn, ms) => { timers.push(ms); return null; } });
  const undo = [];
  // newest first: two holds on one fs call unwind to the real one
  t.after(async () => { for (const u of undo.reverse()) u(); cold.dispose(); await cold.drainReads(); });
  const outbox = path.resolve(path.join(cold.agentDir('god-1'), 'outbox'));
  fs.mkdirSync(path.join(outbox, '.sent'), { recursive: true });
  const file = path.join(outbox, 'note.json');
  fs.writeFileSync(file, JSON.stringify(payload));
  const inboxOf = (id) => path.resolve(path.join(cold.agentDir(id), 'inbox'));
  const inboxes = () => ['god-1', 'andy-1'].flatMap((id) => {
    try { return fs.readdirSync(inboxOf(id)).filter((f) => f.endsWith('.json')).map((f) => `${id}/${f}`); } catch { return []; }
  }).sort();
  /**
   * Replaces fs.promises[name] for the paths `match` picks, once arm() is called. The call waits at
   * the gate. With `failWith` the first held call then fails with that code (a locked file)
   * instead of running.
   */
  const hold = (name, match, failWith) => {
    const real = fs.promises[name];
    const g = gate();
    let armed = false; let failed = false;
    fs.promises[name] = function heldCall(p, ...rest) {
      if (!armed || !match(path.resolve(String(p)))) return real.call(fs.promises, p, ...rest);
      return g.through(() => {
        if (failWith && !failed) { failed = true; throw Object.assign(new Error(`${failWith}: locked by the test`), { code: failWith }); }
        return real.call(fs.promises, p, ...rest);
      });
    };
    undo.push(() => { g.release(); fs.promises[name] = real; });
    return { g, arm() { armed = true; } };
  };
  /** Starts a pass, waits for it at the gate, disposes, then lets the held call finish. */
  const disposeWhileHeld = async (h, what) => {
    h.arm();
    const pass = cold.routeOnce([outbox]).then(() => null, (e) => e);
    await reached(h.g, what);
    cold.stopLedgerGuard(); cold.dispose();
    assert.deepEqual(openUnder(home), [], 'dispose() closed everything while the pass was held');
    const before = { rows: logRows(home), inboxes: inboxes() };
    h.g.release();
    await cold.drainReads();
    const ended = await pass;
    assert.ok(ended === null || disposed(ended), `the pass ends quietly or with HiveDisposedError: ${ended}`);
    return { before, after: { rows: logRows(home), inboxes: inboxes() } };
  };
  /** What every cell asks: after dispose() the pass wrote no row, opened nothing, armed nothing. */
  const quiet = (r) => {
    assert.deepEqual(r.after.rows.slice(r.before.rows.length).map(rowKind), [], 'the pass that resumed after dispose() wrote log rows');
    assert.deepEqual(openUnder(home), [], 'the pass that resumed after dispose() left a file open in the folder');
    assert.deepEqual(timers, [], 'and it armed no timer');
  };
  /** The subjects of every mail an agent holds (inbox/ and inbox/.done/). */
  const subjects = (id) => [inboxOf(id), path.join(inboxOf(id), '.done')].flatMap((dir) => {
    try { return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => String(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).subject)); } catch { return []; }
  });
  /**
   * The end state when a call that COMMITS (the inbox write, the delivery record, the archive
   * rename) lands after dispose(): the next start, a new manager over the same folder, leaves the
   * mail delivered exactly once, tells the sender nothing, and has the file in outbox/.sent/.
   */
  const deliveredOnceAfterRestart = async () => {
    const next = new HiveManager(() => home, () => true, { setTimeout: () => null });
    try { await next.routeOnce([outbox]); } finally { await shutDown(next); }
    assert.equal(subjects('andy-1').filter((s) => s.includes(MAIL.subject)).length, 1, 'after the next start the mail is in the inbox exactly once');
    assert.deepEqual(subjects('god-1').filter((s) => s.startsWith('[')), [], 'and the sender was sent no notice about a mail that was delivered once');
    assert.equal(fs.existsSync(file), false, 'and the file has left outbox/');
    assert.equal(fs.existsSync(path.join(outbox, '.sent', path.basename(file))), true, 'for outbox/.sent/, under its own name');
  };
  /**
   * For a held rename of `target`: `match` picks it, and `started()` counts the checks of the
   * sender's inbox made after the rename was asked for. The rename is held until dispose(), so
   * each one is a notice to the sender that was started on a disposed manager.
   */
  const noticeAfter = (target) => {
    let asked = false; let n = 0;
    hold('stat', (p) => { if (asked && p === inboxOf('god-1')) n++; return false; }).arm();
    return { match: (p) => { if (p === target) asked = true; return p === target; }, started: () => n };
  };
  return { home, cold, outbox, file, inboxOf, hold, disposeWhileHeld, quiet, deliveredOnceAfterRestart, noticeAfter };
}
const MAIL = { to: 'andy-1', act: 'inform', subject: 'Build is green', body: 'all 12 checks passed' };

test('a route pass whose read of a COMPLETE outbox file was open at dispose() does not reject the mail: it stays in outbox/, no notice, no log row, nothing open', async (t) => {
  const rig = await passRig(t, MAIL);
  const r = await rig.disposeWhileHeld(rig.hold('readFile', (p) => p === rig.file), 'the route pass reading the complete outbox file');
  assert.equal(fs.existsSync(path.join(rig.outbox, '.sent', 'bad-note.json')), false, 'a valid mail was rejected (archived as bad-) by a disposed manager');
  assert.equal(fs.existsSync(rig.file), true, 'the mail is still in outbox/, to be read again on the next start');
  assert.deepEqual(r.after.inboxes, r.before.inboxes, 'a disposed manager delivered a notice into an inbox');
  rig.quiet(r);
  deletes(rig.home);
});

test('a route pass held at its listing of the outbox across dispose() does no archive work when the listing returns', async (t) => {
  const rig = await passRig(t, MAIL);
  // A first, live pass delivers the mail but finds the file locked, so it is left in outbox/ with
  // its archive owed. The next pass owes only that rename, with no read in front of it.
  const lock = rig.hold('rename', (p) => p === rig.file, 'EBUSY');
  lock.g.release(); lock.arm();
  await rig.cold.routeOnce([rig.outbox]);
  assert.equal(fs.existsSync(rig.file), true, 'control: the delivered file is still in outbox/, its archive owed');
  assert.ok(logRows(rig.home).some((l) => rowKind(l) === 'outbox-archive-failed'), 'control: the live pass reported the held archive');
  const r = await rig.disposeWhileHeld(rig.hold('readdir', (p) => p === rig.outbox), 'the route pass listing the outbox');
  assert.equal(fs.existsSync(rig.file), true, 'a disposed manager archived the file it found in the listing');
  rig.quiet(r);
  deletes(rig.home);
});

test('a route pass held at an inbox write across dispose() does no delivery bookkeeping when the write lands', async (t) => {
  const rig = await passRig(t, MAIL);
  const inbox = rig.inboxOf('andy-1') + path.sep;
  const r = await rig.disposeWhileHeld(rig.hold('writeFile', (p) => p.startsWith(inbox)), 'the route pass writing the mail into the inbox');
  rig.quiet(r);
  // The write was under way at dispose(), so the mail is in the inbox. Nothing after it was started.
  assert.equal(fs.existsSync(rig.file), true, 'a disposed manager archived the file after its inbox write landed');
  await rig.deliveredOnceAfterRestart();
  deletes(rig.home);
});

test('a route pass held at its delivery-record append across dispose() logs nothing when the append fails', async (t) => {
  const rig = await passRig(t, MAIL);
  const r = await rig.disposeWhileHeld(rig.hold('appendFile', (p) => path.basename(p) === 'outbox-dedup.jsonl', 'EBUSY'), 'the route pass appending its delivery record');
  rig.quiet(r);
  deletes(rig.home);
});

test('a route pass held at the archive rename of a delivered file across dispose() logs nothing when the rename fails', async (t) => {
  const rig = await passRig(t, MAIL);
  const r = await rig.disposeWhileHeld(rig.hold('rename', (p) => p === rig.file, 'EBUSY'), 'the route pass archiving the delivered file');
  rig.quiet(r);
  deletes(rig.home);
});

test('a route pass held at the bad- rename of a rejected file across dispose() sends no reject notice and logs nothing', async (t) => {
  const rig = await passRig(t, { ...MAIL, act: 'shout' });   // parses, but no such act: rejected as unroutable
  const notice = rig.noticeAfter(rig.file);
  const r = await rig.disposeWhileHeld(rig.hold('rename', notice.match), 'the route pass moving the rejected file aside');
  assert.equal(notice.started(), 0, 'a disposed manager started the reject notice (it checked the sender inbox) after dispose()');
  assert.deepEqual(r.after.inboxes, r.before.inboxes, 'a disposed manager delivered a reject notice into an inbox');
  rig.quiet(r);
  deletes(rig.home);
});

/**
 * Jim's re-audit (a5bd243a): the awaits the cells above do not reach, and the same awaits when the
 * held call SUCCEEDS. Each cell below is the only one that fails when its own stop is missing.
 */
test('a route pass held at its read of the delivery record across dispose() starts no delivery when the read returns', async (t) => {
  const rig = await passRig(t, MAIL);
  const r = await rig.disposeWhileHeld(rig.hold('readFile', (p) => path.basename(p) === 'outbox-dedup.jsonl'), 'the route pass reading its delivery record');
  assert.deepEqual(r.after.inboxes, r.before.inboxes, 'a disposed manager started an inbox write after dispose()');
  assert.equal(fs.existsSync(rig.file), true, 'the mail is still in outbox/, to be delivered on the next start');
  rig.quiet(r);
  deletes(rig.home);
});

test('a route pass held at its read of the OLD delivery record across dispose() does not reject the mail when the next read is refused', async (t) => {
  const rig = await passRig(t, MAIL);
  // The old-format record is read first. The read after it is refused by the disposed manager, and
  // that refusal reaches the place that turns any routing error into a rejected file.
  const r = await rig.disposeWhileHeld(rig.hold('readFile', (p) => path.basename(p) === 'outbox-dedup.json'), 'the route pass reading the old delivery record');
  assert.equal(fs.existsSync(path.join(rig.outbox, '.sent', 'bad-note.json')), false, 'a valid mail was rejected (archived as bad-) because a disposed manager refused a read');
  assert.equal(fs.existsSync(rig.file), true, 'the mail is still in outbox/');
  assert.deepEqual(r.after.inboxes, r.before.inboxes, 'a disposed manager delivered a notice into an inbox');
  rig.quiet(r);
  deletes(rig.home);
});

test('a route pass whose read of an UNROUTABLE outbox file was open at dispose() does not move the file aside', async (t) => {
  const rig = await passRig(t, { ...MAIL, act: 'shout' });
  const r = await rig.disposeWhileHeld(rig.hold('readFile', (p) => p === rig.file), 'the route pass reading the unroutable outbox file');
  assert.equal(fs.existsSync(path.join(rig.outbox, '.sent', 'bad-note.json')), false, 'a disposed manager moved the file to bad- (its sender is never told)');
  assert.equal(fs.existsSync(rig.file), true, 'the file is still in outbox/, to be rejected with its notice on the next start');
  assert.deepEqual(r.after.inboxes, r.before.inboxes, 'a disposed manager delivered a reject notice into an inbox');
  rig.quiet(r);
  deletes(rig.home);
});

test('a route pass whose read of an AGED outbox file was open at dispose() logs nothing when the read FAILS', async (t) => {
  const rig = await passRig(t, MAIL);
  const aged = new Date(Date.now() - 5000);
  fs.utimesSync(rig.file, aged, aged);
  assert.ok(Date.now() - fs.statSync(rig.file).mtimeMs >= 4000, 'the file is well past the 1 s fresh-write grace');
  const r = await rig.disposeWhileHeld(rig.hold('readFile', (p) => p === rig.file, 'EBUSY'), 'the route pass reading the locked outbox file');
  assert.equal(fs.existsSync(rig.file), true, 'the mail is still in outbox/');
  rig.quiet(r);
  deletes(rig.home);
});

test('a route pass held at its check that the inbox exists across dispose() starts no delivery when the check returns', async (t) => {
  const rig = await passRig(t, MAIL);
  const inbox = rig.inboxOf('andy-1');
  // The pass also stats this inbox at its start, to load the ledger. The check held here is the
  // delivery's own, which comes after the delivery record was read. This watcher holds nothing.
  let recordRead = false;
  rig.hold('readFile', (p) => { if (path.basename(p) === 'outbox-dedup.jsonl') recordRead = true; return false; }).arm();
  const r = await rig.disposeWhileHeld(rig.hold('stat', (p) => recordRead && p === inbox), 'the route pass checking that the inbox exists');
  assert.deepEqual(r.after.inboxes, r.before.inboxes, 'a disposed manager started an inbox write after dispose()');
  assert.equal(fs.existsSync(rig.file), true, 'the mail is still in outbox/, to be delivered on the next start');
  rig.quiet(r);
  deletes(rig.home);
});

test('a route pass held at its delivery-record append across dispose() stops when the append LANDS, and the next start delivers nothing twice', async (t) => {
  const rig = await passRig(t, MAIL);
  const r = await rig.disposeWhileHeld(rig.hold('appendFile', (p) => path.basename(p) === 'outbox-dedup.jsonl'), 'the route pass appending its delivery record');
  assert.equal(fs.existsSync(rig.file), true, 'a disposed manager archived the file after its delivery record landed');
  rig.quiet(r);
  // The record names this very mail. The next start must not take the file for a repeat of it.
  await rig.deliveredOnceAfterRestart();
  deletes(rig.home);
});

test('a route pass held at an owed archive rename across dispose() logs nothing when the rename LANDS, and the next start delivers nothing twice', async (t) => {
  const rig = await passRig(t, MAIL);
  const lock = rig.hold('rename', (p) => p === rig.file, 'EBUSY');
  lock.g.release(); lock.arm();
  await rig.cold.routeOnce([rig.outbox]);
  assert.equal(fs.existsSync(rig.file), true, 'control: the delivered file is still in outbox/, its archive owed');
  const r = await rig.disposeWhileHeld(rig.hold('rename', (p) => p === rig.file), 'the route pass archiving the delivered file');
  assert.equal(fs.existsSync(path.join(rig.outbox, '.sent', 'note.json')), true, 'control: the rename that was under way landed');
  rig.quiet(r);
  await rig.deliveredOnceAfterRestart();
  deletes(rig.home);
});

/** A live pass delivers the mail, then the same text arrives again under another file name. */
async function repeatRig(t) {
  const rig = await passRig(t, MAIL);
  await rig.cold.routeOnce([rig.outbox]);
  assert.equal(fs.existsSync(path.join(rig.outbox, '.sent', 'note.json')), true, 'control: the first copy was delivered and archived');
  const again = path.join(rig.outbox, 'again.json');
  fs.writeFileSync(again, JSON.stringify(MAIL));
  return { rig, again };
}

test('a route pass held at the rename of an exact repeat across dispose() sends no notice and logs nothing when the rename lands', async (t) => {
  const { rig, again } = await repeatRig(t);
  const notice = rig.noticeAfter(again);
  const r = await rig.disposeWhileHeld(rig.hold('rename', notice.match), 'the route pass moving the repeat aside');
  assert.equal(notice.started(), 0, 'a disposed manager started the duplicate notice (it checked the sender inbox) after dispose()');
  assert.deepEqual(r.after.inboxes, r.before.inboxes, 'a disposed manager delivered a duplicate notice into an inbox');
  rig.quiet(r);
  deletes(rig.home);
});

test('a route pass held at the rename of an exact repeat across dispose() sends no notice and logs nothing when the rename FAILS', async (t) => {
  const { rig, again } = await repeatRig(t);
  const r = await rig.disposeWhileHeld(rig.hold('rename', (p) => p === again, 'EBUSY'), 'the route pass moving the repeat aside');
  assert.deepEqual(r.after.inboxes, r.before.inboxes, 'a disposed manager delivered a duplicate notice into an inbox');
  rig.quiet(r);
  deletes(rig.home);
});

test('a route pass held at its read of the delivery record across dispose() does not move an exact repeat aside when the read returns', async (t) => {
  const rig = await passRig(t, MAIL);
  // Another manager over the same folder delivers the first copy and writes the record.
  const first = new HiveManager(() => rig.home, () => true, { setTimeout: () => null });
  try { await first.routeOnce([rig.outbox]); } finally { await shutDown(first); }
  assert.equal(fs.existsSync(path.join(rig.outbox, '.sent', 'note.json')), true, 'control: the first copy was delivered and archived');
  const again = path.join(rig.outbox, 'again.json');
  fs.writeFileSync(again, JSON.stringify(MAIL));
  const r = await rig.disposeWhileHeld(rig.hold('readFile', (p) => path.basename(p) === 'outbox-dedup.jsonl'), 'the route pass reading its delivery record');
  assert.equal(fs.existsSync(again), true, 'a disposed manager started a rename after dispose(): the repeat left outbox/ and its sender is never told');
  assert.deepEqual(r.after.inboxes, r.before.inboxes, 'a disposed manager delivered into an inbox');
  rig.quiet(r);
  deletes(rig.home);
});

/** The end-of-pass rewrite of the delivery record runs when the old-format record is still there. */
async function compactRig(t) {
  const rig = await passRig(t, MAIL);
  const legacy = path.join(rig.home, 'hive', 'outbox-dedup.json');
  fs.writeFileSync(legacy, JSON.stringify({ entries: [] }));
  const isRewrite = (p) => path.dirname(p) === path.join(rig.home, 'hive') && path.basename(p).startsWith('outbox-dedup.jsonl');
  return { rig, legacy, isRewrite };
}

test('a route pass held at the rewrite of its delivery record across dispose() does not go on to remove the old record', async (t) => {
  const { rig, legacy, isRewrite } = await compactRig(t);
  const r = await rig.disposeWhileHeld(rig.hold('writeFile', isRewrite), 'the route pass rewriting its delivery record');
  assert.equal(fs.existsSync(legacy), true, 'a disposed manager removed the old record after dispose()');
  rig.quiet(r);
  deletes(rig.home);
});

test('a route pass held at the rewrite of its delivery record across dispose() logs nothing when the rewrite FAILS', async (t) => {
  const { rig, isRewrite } = await compactRig(t);
  const r = await rig.disposeWhileHeld(rig.hold('writeFile', isRewrite, 'EBUSY'), 'the route pass rewriting its delivery record');
  rig.quiet(r);
  deletes(rig.home);
});

test('a route pass held at the removal of the old delivery record across dispose() logs nothing when the removal lands', async (t) => {
  const { rig, legacy } = await compactRig(t);
  const r = await rig.disposeWhileHeld(rig.hold('rm', (p) => p === legacy), 'the route pass removing the old delivery record');
  rig.quiet(r);
  deletes(rig.home);
});
