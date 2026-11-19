'use strict';
require('./tools/own-job.cjs');
/**
 * MAIL-EPOCHS-TEARDOWN-RACE-108. Under Electron 45 a recursive delete of the hive fails
 * (ENOTEMPTY) while one of HiveManager's own async file reads is still open in it; plain Node
 * lets the delete through, so the defect only showed on the Electron leg. The rule pinned here
 * holds on both runtimes: after dispose() no new async read starts, and drainReads() resolves
 * only once the reads already open have closed. Reset, home change and the test teardowns that
 * delete the home await it between dispose() and the delete.
 *
 * The read is held open with a gated fs.promises.readFile, so nothing here depends on timing.
 * HOME is jailed first.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-read-drain-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME, GEMINI_CLI_HOME: process.env.GEMINI_CLI_HOME };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL; process.env.CODEX_HOME = path.join(JAIL, '.codex'); process.env.GEMINI_CLI_HOME = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
test.after(() => {
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { Notification: class { show() {} static isSupported() { return false; } } } };

const { HiveManager } = loadTs('src/main/hive.ts');
const { readSource, codeOnly } = require('./read-source.cjs');

/** A floor with one agent and one inbox message, and a gate on fs.promises.readFile for that message. */
async function world(t) {
  const home = fs.mkdtempSync(path.join(JAIL, 'floor-'));
  const hive = new HiveManager(() => home, () => true);
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  const file = path.join(hive.agentDir('god-1'), 'inbox', 'm1.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ id: 'm1', from: 'x', to: 'god-1', body: 'hello' }));
  const real = fs.promises.readFile;
  const w = { home, hive, file, open: 0, calls: 0, gated: false, release: () => {}, entered: () => {} };
  fs.promises.readFile = async function gatedReadFile(p, ...rest) {
    if (path.resolve(String(p)) !== path.resolve(file)) return real.call(fs.promises, p, ...rest);
    w.calls++; w.open++; w.entered();
    try {
      if (w.gated) await new Promise((go) => { w.release = go; });
      return await real.call(fs.promises, p, ...rest);
    } finally { w.open--; }
  };
  t.after(async () => {
    w.release(); fs.promises.readFile = real;
    hive.dispose(); await hive.drainReads?.();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return w;
}

/** Runs every pending promise job and one timer turn, so "still pending" is a real observation. */
const turn = () => new Promise((r) => setImmediate(r));
/**
 * FLAKE-HIVE-READ-DRAIN-LOG-TAIL. Waits until the read `op` has reached its gate. The product does
 * real file work before each gated call (a stat before the mail read, a folder listing before the
 * log open), and that work takes as long as the disk and the thread pool take. So this waits for
 * the gate's own signal, not for a number of turns: the gate calls `entered` each time a read
 * reaches it. If `op` settles without ever reaching the gate, the read never started, and that is
 * the failure. Nothing here is a timer or a count.
 */
const started = (gate, cond, op) => new Promise((resolve, reject) => {
  if (cond()) { resolve(); return; }
  gate.entered = () => { if (cond()) resolve(); };
  const never = () => { try { assert.ok(cond(), 'the gated read never started'); resolve(); } catch (e) { reject(e); } };
  op.then(never, never);
});

test('the wait between dispose() and the delete ends only when the open read has closed', async (t) => {
  const w = await world(t);
  w.gated = true;
  const reading = w.hive.mailBodyAsync('god-1', 'm1');
  await started(w, () => w.open === 1, reading);

  w.hive.dispose();
  // What reset, home change and the teardowns do next. The gate opens later, on its own turn.
  let waited = false;
  const wait = Promise.resolve(w.hive.drainReads?.()).then(() => { waited = true; });
  for (let i = 0; i < 20; i++) await turn();
  const openWhenWaitEnded = waited ? w.open : null;
  w.release();
  await wait;
  assert.equal(openWhenWaitEnded, null, 'the wait ended with a read of the hive still open: the delete would run under it');
  assert.equal(w.open, 0, 'no read is open once the wait has ended');
  const body = await reading;
  assert.equal(body.ok, true, 'the read that was already open still completes with the message');
});

test('after dispose() no new async read reaches the file system, and reopen() allows them again', async (t) => {
  const w = await world(t);
  assert.equal((await w.hive.mailBodyAsync('god-1', 'm1')).ok, true);
  assert.equal(w.calls, 1, 'control: the read goes through the gated readFile');

  w.hive.dispose();
  const refused = await w.hive.mailBodyAsync('god-1', 'm1');
  assert.equal(w.calls, 1, 'a read asked for after dispose() opened the file');
  assert.deepEqual({ ok: refused.ok, reason: refused.reason }, { ok: false, reason: 'transient' },
    'a refused read is a transient miss: the message is neither missing nor set aside');
  await w.hive.drainReads();   // nothing open: resolves at once

  w.hive.reopen();
  assert.equal((await w.hive.mailBodyAsync('god-1', 'm1')).ok, true, 'reads work again after reopen()');
  assert.equal(w.calls, 2);
});

/**
 * The authority reads (registry.json, tasks.json) go through readAuthoritativeJsonAsync, a
 * different path from the mail reads above. Here tasks.json is gated, and rewritten with a new
 * size before each ask so the cache cannot answer without a read of the file.
 */
test('an authority read is one of the reads: the wait covers it, and after dispose() it rejects without touching the file', async (t) => {
  // The missed-watch fallback: every 2 s the hive stats its cached authority files and re-reads a
  // changed one, on its own timer, outside any call this test awaits. This handle lets the test
  // stop new ticks and wait for one already running (see the control below). Until it is stopped,
  // every tick runs the real method.
  const proto = HiveManager.prototype, realFallback = proto.revalidateAuthoritiesAsync;
  assert.equal(typeof realFallback, 'function', 'the missed-watch fallback is still HiveManager.revalidateAuthoritiesAsync');
  const fallback = { stopped: false, flying: Promise.resolve() };
  proto.revalidateAuthoritiesAsync = function () {
    return fallback.stopped ? Promise.resolve() : (fallback.flying = realFallback.call(this));
  };
  t.after(() => { proto.revalidateAuthoritiesAsync = realFallback; });
  const w = await world(t);
  const tasks = path.join(w.hive.root(), 'tasks.json');
  const real = fs.promises.readFile;   // world()'s gate: every other path passes through it
  const g = { calls: 0, open: 0, gated: false, releases: [], entered: () => {} };
  const releaseAll = () => { for (const go of g.releases.splice(0)) go(); };
  fs.promises.readFile = async function gatedAuthorityRead(p, ...rest) {
    if (path.resolve(String(p)) !== path.resolve(tasks)) return real.call(fs.promises, p, ...rest);
    g.calls++; g.open++; g.entered();
    try {
      if (g.gated) await new Promise((go) => { g.releases.push(go); });
      return await real.call(fs.promises, p, ...rest);
    } finally { g.open--; }
  };
  t.after(() => { g.gated = false; releaseAll(); fs.promises.readFile = real; });
  let pad = 0;
  const rewrite = () => fs.writeFileSync(tasks, JSON.stringify({ tasks: [] }) + ' '.repeat(++pad) + '\n');

  rewrite();
  await w.hive.integrityIssuesAsync();
  assert.ok(g.calls >= 1, 'control: the authority read goes through the gated readFile');
  // FLAKE-HIVE-READ-DRAIN-LOG-TAIL: settle on signals, not on a number of turns. The load above
  // put a watcher on the hive folder, and a watcher event refreshes tasks.json with a read of its
  // own, outside any call this test awaits. Left alone, such a read can be the one that reaches
  // the gate below, and dispose() then refuses the read this test is about. So: drop the
  // watchers (no new refresh), wait for a refresh already in flight, then for every counted read.
  // The missed-watch fallback is the same kind of read on a 2 s timer: the rewrite below changes
  // the file's key, so a tick that lands before the integrity read reaches the gate would re-read
  // tasks.json and reach the gate first. So no new tick from here on, and a tick already running
  // is awaited to its end (it awaits the refresh it starts).
  fallback.stopped = true;
  w.hive.__dropAuthorityWatchersForTests();
  await fallback.flying;
  await Promise.all([...w.hive.authorityRefreshes.values()]);
  await w.hive.drainReads();
  assert.equal(g.open, 0, 'control: no authority read is left open');

  g.gated = true;
  rewrite();
  const reading = w.hive.integrityIssuesAsync();
  await started(g, () => g.open >= 1, reading);

  w.hive.dispose();
  let waited = false;
  const wait = Promise.resolve(w.hive.drainReads?.()).then(() => { waited = true; });
  for (let i = 0; i < 20; i++) await turn();
  const openWhenWaitEnded = waited ? g.open : null;
  g.gated = false;
  releaseAll();
  await wait;
  assert.equal(openWhenWaitEnded, null, 'the wait ended with an authority read still open: the delete would run under it');
  assert.equal(g.open, 0, 'no authority read is open once the wait has ended');
  assert.ok(Array.isArray(await reading), 'the read that was already open still completes');

  const before = g.calls;
  rewrite();
  await assert.rejects(w.hive.integrityIssuesAsync(), (e) => e?.name === 'HiveDisposedError' && e.code === 'EHIVEDISPOSED',
    'an authority read asked for after dispose() must reject with HiveDisposedError');
  for (let i = 0; i < 20; i++) await turn();
  assert.equal(g.calls, before, 'an authority read asked for after dispose() opened the file');
});

test('the outbox dedup load passes HiveDisposedError on from both of its reads', () => {
  const src = codeOnly(readSource('src/main/hive.ts'), 'hive.ts');
  const from = src.indexOf('private async outboxDedupEntries(');
  assert.ok(from >= 0, 'outboxDedupEntries not found');
  const body = src.slice(from, src.indexOf('const now = outboxDedupClock.now();', from));
  assert.equal(body.split('this.readTextAsync(').length - 1, 2, 'control: the load makes two reads');
  // A swallowed HiveDisposedError here reads as "no dedup log": the pass would go on and deliver.
  assert.equal(body.split(/catch \(e\) \{\s+if \(e instanceof HiveDisposedError\) throw e;/).length - 1, 2,
    'each catch around a dedup read must rethrow HiveDisposedError first');
});

/** A gate on fs.promises.open for the live log, for the Log panel's async tail (logTailAsync). */
function gateLogOpen(t, hive) {
  const log = path.join(hive.root(), 'log.jsonl');
  const real = fs.promises.open;
  const g = { calls: 0, open: 0, gated: false, release: () => {}, entered: () => {} };
  fs.promises.open = async function gatedOpen(p, ...rest) {
    if (path.resolve(String(p)) !== path.resolve(log)) return real.call(fs.promises, p, ...rest);
    g.calls++; g.open++; g.entered();
    if (g.gated) await new Promise((go) => { g.release = go; });
    const fh = await real.call(fs.promises, p, ...rest);
    const close = fh.close.bind(fh);
    fh.close = async () => { try { return await close(); } finally { g.open--; } };
    return fh;
  };
  t.after(() => { g.release(); fs.promises.open = real; });
  return g;
}

test('the async log tail is one of the reads: the wait covers its open handle, and dispose() refuses a new one', async (t) => {
  const w = await world(t);
  const g = gateLogOpen(t, w.hive);
  const rows = await w.hive.logTailAsync(5);
  assert.ok(rows.length > 0, 'control: the floor has log rows');
  assert.equal(g.calls, 1, 'control: the tail goes through the gated open');
  assert.equal(g.open, 0, 'control: the tail closed its handle');

  g.gated = true;
  const tailing = w.hive.logTailAsync(5);
  await started(g, () => g.open === 1, tailing);
  w.hive.dispose();
  let waited = false;
  const wait = Promise.resolve(w.hive.drainReads?.()).then(() => { waited = true; });
  for (let i = 0; i < 20; i++) await turn();
  const openWhenWaitEnded = waited ? g.open : null;
  g.release();
  await wait;
  assert.equal(openWhenWaitEnded, null, 'the wait ended with the log tail still open: the delete would run under it');
  assert.equal(g.open, 0, 'the log handle is closed once the wait has ended');
  assert.ok((await tailing).length > 0, 'the tail that was already open still returns rows');

  g.gated = false;
  assert.deepEqual(await w.hive.logTailAsync(5), [], 'a disposed manager has no log to show');
  assert.equal(g.calls, 2, 'a log tail asked for after dispose() opened the log');
});

test('reset and home change wait for the open reads between dispose() and touching the folder', () => {
  const src = codeOnly(readSource('src/main/index.ts'), 'index.ts');
  const order = (label, from, marks) => {
    let at = src.indexOf(from);
    assert.ok(at >= 0, `${label}: ${from} not found`);
    for (const m of marks) {
      const next = src.indexOf(m, at);
      assert.ok(next >= 0, `${label}: ${m} does not follow in order`);
      at = next + m.length;
    }
  };
  order('reset', "console.error('[reset] hive.dispose:'", ['await hive.drainReads();', 'await removePathLinkSafe(hiveDir)']);
  order('home change', "console.error('[changeHome] hive.dispose:'", ['await hive.drainReads();', 'cpSync(src,', 'hive.reopen();', 'bootstrapHiveServices();']);
  // Between each dispose and its drain there is no other statement that could touch the folder.
  for (const tag of ['reset', 'changeHome']) {
    const a = src.indexOf(`console.error('[${tag}] hive.dispose:'`);
    const gap = src.slice(src.indexOf('\n', a), src.indexOf('await hive.drainReads();', a));
    assert.equal(gap.trim(), '', `${tag}: something runs between dispose() and the drain: ${gap.trim()}`);
  }
});
