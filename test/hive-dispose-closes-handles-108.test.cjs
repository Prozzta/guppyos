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
