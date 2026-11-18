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
  const w = { home, hive, file, open: 0, calls: 0, gated: false, release: () => {} };
  fs.promises.readFile = async function gatedReadFile(p, ...rest) {
    if (path.resolve(String(p)) !== path.resolve(file)) return real.call(fs.promises, p, ...rest);
    w.calls++; w.open++;
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
const until = async (cond) => { for (let i = 0; i < 200 && !cond(); i++) await turn(); assert.ok(cond(), 'the gated read never started'); };

test('the wait between dispose() and the delete ends only when the open read has closed', async (t) => {
  const w = await world(t);
  w.gated = true;
  const reading = w.hive.mailBodyAsync('god-1', 'm1');
  await until(() => w.open === 1);

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

/** A gate on fs.promises.open for the live log, for the Log panel's async tail (logTailAsync). */
function gateLogOpen(t, hive) {
  const log = path.join(hive.root(), 'log.jsonl');
  const real = fs.promises.open;
  const g = { calls: 0, open: 0, gated: false, release: () => {} };
  fs.promises.open = async function gatedOpen(p, ...rest) {
    if (path.resolve(String(p)) !== path.resolve(log)) return real.call(fs.promises, p, ...rest);
    g.calls++; g.open++;
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
  await until(() => g.open === 1);
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
