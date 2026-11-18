'use strict';
require('./tools/own-job.cjs');

/**
 * LAG-SYNC-WRITES-107 (god 3dd345; Jim's jailed stall rows on e799c10d): three files Electron main
 * still wrote synchronously, each held the thread for 700-900 ms under disk load:
 *   1. memory-keys.json            the key registry's timer save (writeFileSync + renameSync)
 *   2. state/mail/<agent>.json     the mail ledger's coalesced save, about 6 a minute
 *   3. state/mail-cards/*.jsonl    the mail-card index appends (rows, then _links.jsonl)
 * With write-behind on (the app turns it on at start) each is written off the main thread. These
 * tests count the synchronous fs WRITES under the test's own folder while a path runs (zero), and
 * hold each writer to what it promised before: tmp + rename, order per file, a flush that wins over
 * a write in flight, and a read by the same process that sees the new value at once.
 * The mail delivery file (inbox/<id>.json) is ROUTER-ASYNC-DELIVER-107, not this card.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-lag-sync-writes-107-'));
test.after(() => { fs.rmSync(JAIL, { recursive: true, force: true }); });

const WB = loadTs('src/main/writeBehind.ts');
const REG = loadTs('src/main/claims/registry.ts');
const L = loadTs('src/main/mailLedger.ts');
const MC = loadTs('src/main/mailCards.ts');
const DW = loadTs('src/main/claims/derivedWriter.ts');
WB.enableWriteBehind();
// ASYNC-RENAME-POSIX-107: these cases watch, hold and fail the plain fs/promises rename, which on Windows
// is now the fallback. The addon's rename is switched off here; async-rename-posix-107 covers it.
loadTs('src/main/atomicJson.ts').__setRenameAddonForTest(null);

let seq = 0;
const dirOf = (name) => { const d = path.join(JAIL, `${name}-${++seq}`); fs.mkdirSync(d, { recursive: true }); return d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (cond, what, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await sleep(5);
  }
};
/** A wait that fails instead of hanging the file (a write left in flight by an earlier failed case). */
const bounded = (pending, what, ms = 8_000) => {
  let t;
  return Promise.race([pending, new Promise((_r, rej) => { t = setTimeout(() => rej(new Error(`timed out waiting for ${what}`)), ms); })]).finally(() => clearTimeout(t));
};
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const tmpsIn = (dir) => fs.readdirSync(dir).filter((n) => /\.tmp/.test(n));

/** The synchronous fs functions that write. */
const WRITE_FNS = ['writeFileSync', 'appendFileSync', 'renameSync', 'copyFileSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'openSync', 'truncateSync'];
const under = (dir, p) => { const s = path.resolve(String(p)).toLowerCase(); const d = path.resolve(dir).toLowerCase(); return s === d || s.startsWith(d + path.sep); };
/** Run fn and return the synchronous fs writes it made on paths under `dir`. */
async function syncWrites(dir, fn) {
  const orig = {};
  const calls = [];
  for (const k of WRITE_FNS) {
    orig[k] = fs[k];
    fs[k] = function (p, ...rest) {
      if (typeof p === 'string' && under(dir, p)) calls.push(`${k}:${path.basename(p)}`);
      return orig[k].call(this, p, ...rest);
    };
  }
  let result;
  try { result = await fn(); } finally { for (const k of WRITE_FNS) fs[k] = orig[k]; }
  return { calls, result };
}

/**
 * Replace one fs/promises function while fn runs. `hook(args, real)` returns the call's promise.
 * `seen` lists every call's first argument (base name).
 */
async function withAsync(name, hook, fn) {
  const real = fsp[name];
  const seen = [];
  fsp[name] = (...args) => { seen.push(path.basename(String(args[0]))); return hook(args, (...a) => real(...(a.length ? a : args))); };
  try { return await fn(seen); } finally { fsp[name] = real; }
}
/** Replace one fs sync function while fn runs. */
async function withSync(name, hook, fn) {
  const real = fs[name];
  fs[name] = (...args) => hook(args, (...a) => real(...(a.length ? a : args)));
  try { return await fn(); } finally { fs[name] = real; }
}
/** Capture timers so a retry sequence can be advanced without waiting for wall-clock time. */
async function withTimers(fn) {
  const realSet = global.setTimeout;
  const realClear = global.clearTimeout;
  const timers = [];
  global.setTimeout = (run, ms, ...args) => {
    const timer = { cleared: false, unref() {} };
    timers.push({ run: () => run(...args), ms, timer });
    return timer;
  };
  timers.wait = () => new Promise((resolve) => realSet(resolve, 1));
  global.clearTimeout = (timer) => { timer.cleared = true; };
  try { return await fn(timers); } finally { global.setTimeout = realSet; global.clearTimeout = realClear; }
}
/** A gate: `wait()` resolves once `open()` was called. `reached` is true once something waits. */
function gate() {
  let open; let reached = false;
  const p = new Promise((r) => { open = r; });
  const g = { wait: () => { reached = true; return p; }, open: () => open(), get reached() { return reached; } };
  gates.push(g);
  return g;
}
// A case that fails before it opens its gate would leave a write held for good, and every later
// settleWrites would then wait its whole cap (minutes for the file). So each case ends with its gates open.
const gates = [];
test.afterEach(async () => { for (const g of gates.splice(0)) g.open(); await WB.settleWrites(5_000); });

// ───────────────────────────────────────────────────────── writeBehind: whole files

test('writeFileBehind: tmp + rename off the main thread, no synchronous write, no tmp left', async () => {
  const dir = dirOf('wf');
  const p = path.join(dir, 'a.json');
  fs.writeFileSync(p, 'old');
  const renames = [];
  const { calls, result } = await syncWrites(dir, () => withAsync('rename', (args, real) => { renames.push(args.map((a) => path.basename(a))); return real(); },
    () => WB.writeFileBehind(p, 'new')));
  assert.equal(result, 'published');
  assert.deepEqual(calls, [], 'no synchronous write');
  assert.equal(fs.readFileSync(p, 'utf8'), 'new');
  assert.equal(renames.length, 1);
  assert.match(renames[0][0], /^a\.json\.tmp-[0-9a-f]{6}$/, 'written to a sibling tmp file');
  assert.equal(renames[0][1], 'a.json', 'then renamed over the file');
  assert.deepEqual(tmpsIn(dir), []);
  assert.equal(WB.writeInFlight(p), false);
});

test('writeFileBehind: one write per path at a time', async () => {
  const dir = dirOf('wf');
  const p = path.join(dir, 'a.json');
  const first = WB.writeFileBehind(p, '1');
  assert.equal(WB.writeInFlight(p), true);
  await assert.rejects(WB.writeFileBehind(p, '2'), /already being written/);
  assert.equal(await first, 'published');
  assert.equal(await WB.writeFileBehind(p, '3'), 'published', 'the next one starts once the first ended');
  assert.equal(fs.readFileSync(p, 'utf8'), '3');
});

test('writeFileBehind: the guard is asked before the rename; false withdraws and leaves no tmp', async () => {
  const dir = dirOf('wf');
  const p = path.join(dir, 'a.json');
  fs.writeFileSync(p, 'old');
  assert.equal(await WB.writeFileBehind(p, 'new', () => false), 'withdrawn');
  assert.equal(fs.readFileSync(p, 'utf8'), 'old');
  assert.deepEqual(tmpsIn(dir), []);
});

test('writeFileBehind: a synchronous write before the rename wins (the write in flight gives way)', async () => {
  const dir = dirOf('wf');
  const p = path.join(dir, 'a.json');
  const g = gate();
  const result = await withAsync('writeFile', async (_a, real) => { await real(); await g.wait(); }, async () => {
    const flight = WB.writeFileBehind(p, 'async-older');
    await until(() => g.reached, 'the tmp write');
    fs.writeFileSync(p, 'sync-newer');
    WB.noteSyncWrite(p, 'sync-newer');
    assert.equal(WB.overtakenText(p), 'sync-newer');
    g.open();
    return flight;
  });
  assert.equal(result, 'overtaken');
  assert.equal(fs.readFileSync(p, 'utf8'), 'sync-newer');
  assert.equal(WB.overtakenText(p), null, 'the disk is the truth again');
  assert.deepEqual(tmpsIn(dir), []);
});

// Jim J6 (audit of ec6a36a4): the older text must never be on disk after the synchronous write, not even briefly.
test('writeFileBehind: after a synchronous write the write in flight does not rename at all (no other process reads the older text)', async () => {
  const dir = dirOf('wf');
  const p = path.join(dir, 'a.json');
  const g = gate();
  await withAsync('rename', async (_a, real) => real(), async (renames) => {
    const result = await withAsync('writeFile', async (_a, real) => { await real(); await g.wait(); }, async () => {
      const flight = WB.writeFileBehind(p, 'async-older');
      await until(() => g.reached, 'the tmp write');
      fs.writeFileSync(p, 'sync-newer');
      WB.noteSyncWrite(p, 'sync-newer');
      g.open();
      return flight;
    });
    assert.equal(result, 'overtaken');
    assert.deepEqual(renames, [], 'THE OLDER TEXT IS NEVER RENAMED OVER THE SYNCHRONOUS WRITE');
  });
  assert.equal(fs.readFileSync(p, 'utf8'), 'sync-newer');
  assert.deepEqual(tmpsIn(dir), []);
});

test('writeFileBehind: a synchronous write while the rename is on its way is put back, and read from memory meanwhile', async () => {
  const dir = dirOf('wf');
  const p = path.join(dir, 'a.json');
  const g = gate();
  const result = await withAsync('rename', async (_a, real) => { await g.wait(); return real(); }, async () => {
    const flight = WB.writeFileBehind(p, 'async-older');
    await until(() => g.reached, 'the rename');
    fs.writeFileSync(p, 'sync-newer');
    WB.noteSyncWrite(p, () => 'sync-newer');
    g.open();
    await until(() => fs.readFileSync(p, 'utf8') === 'async-older' || !WB.writeInFlight(p), 'the rename to land');
    if (WB.writeInFlight(p)) assert.equal(WB.overtakenText(p), 'sync-newer', 'a reader takes the newer text, not the disk');
    return flight;
  });
  assert.equal(result, 'overtaken');
  assert.equal(fs.readFileSync(p, 'utf8'), 'sync-newer', 'the last word on disk is the newest write');
  assert.deepEqual(tmpsIn(dir), []);
});

test('writeFileBehind: a failed write rejects and ends the flight', async () => {
  const dir = dirOf('wf');
  const p = path.join(dir, 'missing-dir', 'a.json');
  await assert.rejects(WB.writeFileBehind(p, 'x'));
  assert.equal(WB.writeInFlight(p), false);
});

// ───────────────────────────────────────────────────────── writeBehind: appends

test('appendBehind: every row lands once, in the order queued, with no synchronous write', async () => {
  const dir = dirOf('ap');
  const a = path.join(dir, 'sub', 'a.jsonl');
  const b = path.join(dir, 'sub', 'b.jsonl');
  const { calls } = await syncWrites(dir, async () => {
    for (let i = 0; i < 120; i++) WB.appendBehind([{ file: i % 3 ? a : b, text: `r${i}\n` }, { file: a, text: `l${i}\n` }]);
    // read-after-write: all of it is readable at once, nothing is on disk yet
    assert.equal(fs.existsSync(a), false);
    const all = WB.withPendingAppends(a, null).split('\n').filter(Boolean);
    assert.equal(all.length, 120 + 80);
    assert.deepEqual(WB.pendingAppendNames(path.join(dir, 'sub')).sort(), ['a.jsonl', 'b.jsonl']);
    await WB.settleWrites(20_000);
  });
  assert.deepEqual(calls, []);
  assert.equal(WB.pendingAppendCount(), 0);
  const want = { a: [], b: [] };
  for (let i = 0; i < 120; i++) { (i % 3 ? want.a : want.b).push(`r${i}`); want.a.push(`l${i}`); }
  assert.deepEqual(fs.readFileSync(a, 'utf8').split('\n').filter(Boolean), want.a);
  assert.deepEqual(fs.readFileSync(b, 'utf8').split('\n').filter(Boolean), want.b);
  assert.equal(WB.withPendingAppends(a, 'disk'), 'disk', 'nothing queued: the disk text as it is');
  assert.deepEqual(WB.pendingAppendNames(path.join(dir, 'sub')), []);
});

test('appendBehind: the row in flight is not shown twice once it is on disk', async () => {
  const dir = dirOf('ap');
  const a = path.join(dir, 'a.jsonl');
  const g = gate();
  await withAsync('appendFile', async (_a, real) => { await real(); await g.wait(); }, async () => {
    WB.appendBehind([{ file: a, text: 'one\n' }]);
    WB.appendBehind([{ file: a, text: 'two\n' }]);
    await until(() => g.reached && fs.existsSync(a), 'the first append');
    assert.equal(WB.withPendingAppends(a, fs.readFileSync(a, 'utf8')), 'one\ntwo\n');
    assert.equal(WB.withPendingAppends(a, null), 'one\ntwo\n', 'read before it landed: still whole');
    g.open();
    await WB.settleWrites(10_000);
  });
  assert.equal(fs.readFileSync(a, 'utf8'), 'one\ntwo\n');
});

test('appendBehind: a part that fails drops the rest of its job, tells the owner, and the lane goes on', async () => {
  const dir = dirOf('ap');
  const bad = path.join(dir, 'is-a-dir');
  fs.mkdirSync(bad);
  const links = path.join(dir, '_links.jsonl');
  const failed = [];
  WB.appendBehind([{ file: bad, text: 'row\n' }, { file: links, text: 'link-1\n' }], (e) => failed.push(e));
  WB.appendBehind([{ file: path.join(dir, 'ok.jsonl'), text: 'row\n' }, { file: links, text: 'link-2\n' }], (e) => failed.push(e));
  await WB.settleWrites(10_000);
  assert.equal(failed.length, 1);
  assert.equal(fs.readFileSync(links, 'utf8'), 'link-2\n', 'a link never lands without its rows');
  assert.equal(WB.pendingAppendCount(), 0);
});

test('flushAppendsSync: everything queued lands, in order; the row in flight may land twice, never zero times', async () => {
  const dir = dirOf('ap');
  const a = path.join(dir, 'a.jsonl');
  const g = gate();
  await withAsync('appendFile', async (_a, real) => { await g.wait(); return real(); }, async () => {
    for (let i = 0; i < 5; i++) WB.appendBehind([{ file: a, text: `r${i}\n` }]);
    await until(() => g.reached, 'the first append to start');
    WB.flushAppendsSync();
    assert.deepEqual(fs.readFileSync(a, 'utf8').split('\n').filter(Boolean), ['r0', 'r1', 'r2', 'r3', 'r4'], 'on disk when the flush returns');
    assert.equal(WB.pendingAppendCount(), 0);
    g.open();
    await WB.settleWrites(10_000);
  });
  const rows = fs.readFileSync(a, 'utf8').split('\n').filter(Boolean);
  assert.deepEqual([...new Set(rows)], ['r0', 'r1', 'r2', 'r3', 'r4'], 'first copies in order');
  assert.ok(rows.length === 5 || (rows.length === 6 && rows[5] === 'r0'), `only the row in flight may repeat: ${rows}`);
});

test('flushAppendsSync after a hive was removed: the append in flight does not re-create the folder', async () => {
  const dir = dirOf('ap');
  const sub = path.join(dir, 'gone');
  const g = gate();
  await withAsync('appendFile', async (_a, real) => { await g.wait(); return real(); }, async () => {
    WB.appendBehind([{ file: path.join(sub, 'a.jsonl'), text: 'r\n' }]);
    await until(() => g.reached, 'the append to start');
    WB.flushAppendsSync();           // writes it (and makes the folder)
    fs.rmSync(sub, { recursive: true, force: true });   // the reset erases the hive
    g.open();
    await WB.settleWrites(10_000);
  });
  assert.equal(fs.existsSync(sub), false);
});

test('settleWrites waits for the writes in flight, and no longer than its cap', async () => {
  const dir = dirOf('st');
  const p = path.join(dir, 'a.json');
  const g = gate();
  await withAsync('writeFile', async (_a, real) => { await g.wait(); return real(); }, async () => {
    const flight = WB.writeFileBehind(p, 'x');
    const t0 = Date.now();
    await WB.settleWrites(60);
    assert.ok(Date.now() - t0 >= 50, 'waited for the cap');
    assert.equal(WB.writeInFlight(p), true, 'the cap ran out first');
    g.open();
    await WB.settleWrites(10_000);
    assert.equal(WB.writeInFlight(p), false);
    assert.equal(await flight, 'published');
  });
});

// ───────────────────────────────────────────────────────── 1. memory-keys.json

const regRoot = () => dirOf('reg');
const regKeys = (root) => { try { return Object.keys(readJson(REG.registryPath(root)).keys).filter((k) => k.startsWith('agent.')).sort(); } catch { return []; } };
const addKey = (w, key, at = '2026-11-17T10:00:00Z') => { const c = w.check(key, 'andy', at); assert.equal(c.ok && c.added, true, `${key} is new`); w.commit(key, c.entry); return c.entry; };

test('registry: the timer save writes memory-keys.json with no synchronous write (tmp + rename)', async () => {
  const root = regRoot();
  const w = new REG.KeyRegistryWriter(root, () => assert.fail('save failed'), 5);
  const renames = [];
  const { calls } = await syncWrites(root, () => withAsync('rename', (args, real) => { renames.push(args.map((a) => path.basename(a))); return real(); }, async () => {
    addKey(w, 'agent.andy.a');
    await until(() => regKeys(root).includes('agent.andy.a'), 'the save');
    await WB.settleWrites(10_000);
  }));
  assert.deepEqual(calls, [], 'no synchronous write under the hive');
  const file = path.basename(REG.registryPath(root));
  assert.equal(renames.length, 1);
  assert.match(renames[0][0], new RegExp(`^${file.replace(/\./g, '\\.')}\\.tmp-[0-9a-f]{6}$`));
  assert.equal(renames[0][1], file);
  assert.deepEqual(tmpsIn(path.dirname(REG.registryPath(root))), []);
});

test('registry: a reader sees an acked key at once, without forcing the save', async () => {
  const root = regRoot();
  // a registry file old enough for the shared reader to cache it (a fresh mtime is never trusted)
  REG.saveRegistry(root, structuredClone(REG.DEFAULT_KEY_REGISTRY));
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(REG.registryPath(root), old, old);
  const w = new REG.KeyRegistryWriter(root, () => assert.fail('save failed'), 60_000);
  const before = REG.registryText(root);
  const sharedBefore = REG.loadRegistryShared(root);
  const { calls } = await syncWrites(root, () => {
    addKey(w, 'agent.andy.seen');
    assert.ok(REG.loadRegistry(root).keys['agent.andy.seen'], 'loadRegistry');
    const shared = REG.loadRegistryShared(root);
    assert.ok(shared.keys['agent.andy.seen'], 'loadRegistryShared');
    assert.ok(Object.isFrozen(shared) && Object.isFrozen(shared.keys), 'still frozen');
    assert.equal(REG.loadRegistryShared(root), shared, 'one object while nothing changes');
    assert.notEqual(shared, sharedBefore);
    assert.notEqual(REG.registryText(root), before, 'the text a reader compares has changed');
    const c = w.check('agent.andy.seen', 'andy', '2026-11-17T10:00:01Z');
    assert.equal(c.ok && c.added, false, 'known to the writer');
  });
  assert.deepEqual(calls, [], 'no reader forced a synchronous save');
  assert.deepEqual(regKeys(root), [], 'the file does not have it yet');
  w.flush();   // quit
  assert.deepEqual(regKeys(root), ['agent.andy.seen']);
  assert.equal(REG.loadRegistry(root).keys['agent.andy.seen'].addedBy, 'andy');
  assert.equal(REG.registryText(root), fs.readFileSync(REG.registryPath(root), 'utf8'), 'saved: the plain file text');
});

test('registry: a key acked during a save stays held and goes out with the next one', async () => {
  const root = regRoot();
  const w = new REG.KeyRegistryWriter(root, () => assert.fail('save failed'), 5);
  const g = gate();
  await withAsync('writeFile', async (_a, real) => { await real(); if (!g.reached) await g.wait(); }, async () => {
    addKey(w, 'agent.andy.first');
    await until(() => g.reached, 'the first save');
    addKey(w, 'agent.andy.second');
    assert.ok(REG.loadRegistry(root).keys['agent.andy.first'] && REG.loadRegistry(root).keys['agent.andy.second']);
    g.open();
    await until(() => regKeys(root).length === 2, 'both keys saved');
  });
  assert.deepEqual(regKeys(root), ['agent.andy.first', 'agent.andy.second']);
  await WB.settleWrites(10_000);
  assert.equal(REG.registryText(root), fs.readFileSync(REG.registryPath(root), 'utf8'), 'nothing held any more');
});

test('registry: flush() during a save wins, whichever lands first (quit)', async () => {
  for (const hold of ['writeFile', 'rename']) {
    const root = regRoot();
    const w = new REG.KeyRegistryWriter(root, () => assert.fail('save failed'), 5);
    const g = gate();
    await withAsync(hold, async (_a, real) => { await g.wait(); return real(); }, async () => {
      addKey(w, 'agent.andy.first');
      await until(() => g.reached, `the save's ${hold}`);
      addKey(w, 'agent.andy.second');
      w.flush();
      assert.deepEqual(regKeys(root), ['agent.andy.first', 'agent.andy.second'], 'on disk when flush returns');
      g.open();
      await WB.settleWrites(10_000);
    });
    assert.deepEqual(regKeys(root), ['agent.andy.first', 'agent.andy.second'], `${hold}: the older save did not land over the flush`);
    assert.deepEqual(Object.keys(REG.loadRegistry(root).keys).filter((k) => k.startsWith('agent.')).sort(), ['agent.andy.first', 'agent.andy.second']);
    assert.deepEqual(tmpsIn(path.dirname(REG.registryPath(root))), []);
  }
});

test('registry: another writer\'s change during a save is kept (the save withdraws, the next goes on top)', async () => {
  const root = regRoot();
  const w = new REG.KeyRegistryWriter(root, () => assert.fail('save failed'), 5);
  const g = gate();
  await withAsync('writeFile', async (_a, real) => { await real(); if (!g.reached) await g.wait(); }, async () => {
    addKey(w, 'agent.andy.mine');
    await until(() => g.reached, 'the save');
    // a foreign process: it does not report its write
    const theirs = structuredClone(REG.DEFAULT_KEY_REGISTRY);
    theirs.keys['agent.pam.theirs'] = { cardinality: 'single', addedAt: '2026-11-17T10:00:05Z', addedBy: 'pam' };
    fs.mkdirSync(path.dirname(REG.registryPath(root)), { recursive: true });
    fs.writeFileSync(REG.registryPath(root), JSON.stringify(theirs, null, 2) + '\n');
    g.open();
    await until(() => regKeys(root).length === 2, 'mine saved on top of theirs');
  });
  assert.deepEqual(regKeys(root), ['agent.andy.mine', 'agent.pam.theirs']);
});

test('registry: a write-behind publish retry backs off to a cap and reports one failure streak', async () => {
  const root = regRoot();
  const failed = [];
  let attempts = 0;
  let wakeAttempt = null;
  const waitForAttempt = async (n) => {
    while (attempts < n) await new Promise((resolve) => { wakeAttempt = resolve; });
  };
  await withTimers((timers) => withAsync('rename', async () => {
    attempts++;
    wakeAttempt?.();
    throw Object.assign(new Error('injected publish failure'), { code: 'EIO' });
  }, async () => {
    const w = new REG.KeyRegistryWriter(root, (keys) => failed.push(keys), 5);
    addKey(w, 'agent.andy.lost');
    const delays = [];
    const waitForRearm = async () => {
      for (let i = 0; i < 500 && timers.length === 0; i++) await timers.wait();
      assert.ok(timers.length, 'the failed save re-arms itself');
    };
    const fireNext = () => {
      const timer = timers.shift();
      assert.ok(timer, 'the failed save re-arms itself');
      delays.push(timer.ms);
      timer.run();
    };
    const expected = [5];
    while (expected.at(-1) < REG.REGISTRY_SAVE_RETRY_MAX_MS) expected.push(Math.min(expected.at(-1) * 2, REG.REGISTRY_SAVE_RETRY_MAX_MS));
    expected.push(REG.REGISTRY_SAVE_RETRY_MAX_MS);
    for (let i = 0; i < expected.length; i++) {
      fireNext();
      await waitForAttempt(i + 1);
      await waitForRearm();
    }
    assert.deepEqual(delays, expected, 'each failed async publish doubles its retry delay only to the cap');
  }));
  assert.deepEqual(failed, [['agent.andy.lost']], 'one callback covers the whole failed publish streak');
  assert.ok(REG.loadRegistry(root).keys['agent.andy.lost'], 'readers retain the failed key');
});

test('registry: a synchronous publish failure re-arms, reports once, and resets after success', async () => {
  WB.enableWriteBehind(false);
  try {
    const root = regRoot();
    const failed = [];
    let fail = true;
    await withTimers((timers) => withSync('renameSync', (args, real) => {
      if (fail && path.basename(String(args[1])) === 'memory-keys.json') throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      return real();
    }, async () => {
      const w = new REG.KeyRegistryWriter(root, (keys) => failed.push(keys), 5);
      const delays = [];
      const fireNext = () => {
        const timer = timers.shift();
        assert.ok(timer, 'the failed synchronous save re-arms itself');
        delays.push(timer.ms);
        timer.run();
      };
      addKey(w, 'agent.andy.sync');
      fireNext();
      fireNext();
      assert.deepEqual(failed, [['agent.andy.sync']], 'repeated synchronous failures do not duplicate the report');
      fail = false;
      fireNext();
      addKey(w, 'agent.andy.next');
      fail = true;
      fireNext();
      fireNext();
      assert.deepEqual(delays, [5, 10, 20, 5, 10], 'the next failure after a successful publish starts at saveMs and then backs off');
      assert.deepEqual(failed, [['agent.andy.sync'], ['agent.andy.next']], 'the next failure after a success starts a new report streak');
    }));
    assert.ok(REG.loadRegistry(root).keys['agent.andy.sync']);
  } finally { WB.enableWriteBehind(); }
});

test('registry: with write-behind off (a bare class) the timer save is the synchronous one', async () => {
  WB.enableWriteBehind(false);
  try {
    const root = regRoot();
    const w = new REG.KeyRegistryWriter(root, () => assert.fail('save failed'), 5);
    const { calls } = await syncWrites(root, async () => {
      addKey(w, 'agent.andy.a');
      await until(() => regKeys(root).includes('agent.andy.a'), 'the save');
    });
    assert.ok(calls.some((c) => c.startsWith('renameSync:')), `synchronous: ${calls}`);
  } finally { WB.enableWriteBehind(); }
});

test('LAG-SYNC-FS-TAIL-108: registryTextChunks is saveRegistry\'s text byte for byte, at every piece size, and is the registry as it was when asked', () => {
  const sizes = [1, 97, 4096, 64 * 1024];
  const entry = (i) => ({ cardinality: i % 3 ? 'single' : 'multi', addedAt: `2026-11-17T10:00:${String(i % 60).padStart(2, '0')}Z`, addedBy: `andy "${i}" é中\n\t\\` });
  const same = (reg, what) => {
    const want = JSON.stringify(reg, null, 2) + '\n';
    for (const size of sizes) assert.equal([...REG.registryTextChunks(reg, size)].join(''), want, `${what} (pieces of ${size})`);
  };
  same(structuredClone(REG.DEFAULT_KEY_REGISTRY), 'the default registry (no keys)');
  const big = structuredClone(REG.DEFAULT_KEY_REGISTRY);
  for (let i = 0; i < 500; i++) big.keys[`list.bulk.k${i}`] = entry(i);
  same(big, '500 keys');
  same({ keys: { 'list.a.b': entry(1) }, v: 1, namespaces: [] }, 'keys first');
  same({ v: 1, gone: undefined, namespaces: [], extra: { a: [1, { b: 'x\ny' }], c: [] }, keys: { 'list.a.b': entry(2), 'list.a.none': undefined } }, 'undefined and nested values');
  same({ v: 1, namespaces: [], keys: [] }, 'keys that are not a map');
  same({}, 'an empty object');
  // The text is the registry at the call, whatever happens to it before the pieces are read.
  const want = JSON.stringify(big, null, 2) + '\n';
  const pieces = REG.registryTextChunks(big, 4096);
  big.keys['list.bulk.late'] = entry(7);
  delete big.keys['list.bulk.k3'];
  big.v = 2;
  assert.equal([...pieces].join(''), want, 'a key added, a key removed and a value changed after the call are not in the text');
});

test('LAG-SYNC-FS-TAIL-108: the timer save writes a large registry in pieces, main runs between them, and a key acked between two pieces goes out with the next save', async () => {
  const root = regRoot();
  const seeded = structuredClone(REG.DEFAULT_KEY_REGISTRY);
  for (let i = 0; i < 3000; i++) seeded.keys[`list.bulk.k${String(i).padStart(5, '0')}`] = { cardinality: 'multi', addedAt: '2026-11-17T09:00:00Z', addedBy: 'x'.repeat(40) };
  fs.mkdirSync(path.dirname(REG.registryPath(root)), { recursive: true });
  fs.writeFileSync(REG.registryPath(root), JSON.stringify(seeded, null, 2) + '\n');
  const w = new REG.KeyRegistryWriter(root, () => assert.fail('save failed'), 5);
  const file = path.basename(REG.registryPath(root));
  const pieces = [];
  const landed = [];
  let turns = 0;
  let spin = true;
  let firstEntry;
  const tick = () => { turns++; if (spin) setImmediate(tick); };
  setImmediate(tick);
  let calls;
  try {
    ({ calls } = await syncWrites(root, () => withAsync('rename', async (args, real) => {
      const r = await real();
      if (path.basename(String(args[1])) === file) landed.push(fs.readFileSync(REG.registryPath(root), 'utf8'));
      return r;
    }, () => withAsync('writeFile', (args, real) => {
      if (!String(args[0]).includes(`${file}.tmp-`)) return real();
      assert.equal(typeof args[1], 'object', 'the registry is not handed to writeFile as one string');
      const it = args[1];
      const first = pieces.length === 0;
      const watched = (function* () {
        let n = 0;
        for (const s of it) {
          if (first && n++ === 1) addKey(w, 'agent.andy.late');   // acked while the save is being written
          pieces.push({ len: s.length, turn: turns, first });
          yield s;
        }
      })();
      return real(args[0], watched, ...args.slice(2));
    }, async () => {
      firstEntry = addKey(w, 'agent.andy.first');
      await until(() => regKeys(root).length === 2, 'both keys saved');
      await WB.settleWrites(10_000);
    }))));
  } finally { spin = false; }
  assert.deepEqual(calls, [], 'no synchronous write under the hive');
  const atStart = structuredClone(seeded);
  atStart.keys['agent.andy.first'] = firstEntry;
  assert.equal(landed.length, 2, 'two saves');
  assert.equal(landed[0], JSON.stringify(atStart, null, 2) + '\n', 'the first save is the registry as it was when the save started, byte for byte');
  const text = fs.readFileSync(REG.registryPath(root), 'utf8');
  assert.equal(text, JSON.stringify(REG.loadRegistry(root), null, 2) + '\n', 'the file is saveRegistry\'s text, byte for byte');
  assert.deepEqual(regKeys(root), ['agent.andy.first', 'agent.andy.late']);
  const one = pieces.filter((p) => p.first);
  assert.ok(text.length > 3 * 64 * 1024, `fixture: a registry of several pieces (${text.length} chars)`);
  assert.ok(one.length >= 3, `written in pieces (${one.length})`);
  assert.ok(pieces.every((p) => p.len < 64 * 1024 + 4096), `no piece much over 64 KiB (${pieces.map((p) => p.len)})`);
  for (let i = 1; i < one.length; i++) assert.ok(one[i].turn > one[i - 1].turn, `main ran between piece ${i - 1} and piece ${i}`);
  assert.equal(REG.registryText(root), text, 'nothing held any more');
  assert.deepEqual(tmpsIn(path.dirname(REG.registryPath(root))), []);
});

// ───────────────────────────────────────────────────────── 2. state/mail/<agent>.json

const AGENT = 'jim-1';
function ledgerHive() {
  const root = dirOf('led');
  fs.mkdirSync(path.join(root, 'agents', AGENT, 'inbox'), { recursive: true });
  return root;
}
const mkLedger = (root, logs = []) => new L.MailLedger({ root: () => root, appendLog: (r) => logs.push(r), readLogRows: () => [], writeDelayMs: 5 });
const msg = (id, extra = {}) => ({ id, from: 'god-1', to: AGENT, act: 'inform', subject: `s-${id}`, body: `body of ${id}`, ...extra });
const deliver = (ml, root, id) => {
  fs.writeFileSync(path.join(root, 'agents', AGENT, 'inbox', `${id}.json`), JSON.stringify(msg(id)));
  ml.markDelivered(AGENT, msg(id));
};
const ledgerPath = (root) => path.join(root, 'state', 'mail', `${AGENT}.json`);
const diskIds = (root) => { try { return Object.keys(readJson(ledgerPath(root)).entries).sort(); } catch { return []; } };

test('ledger: the coalesced save writes <agent>.json with no synchronous write (tmp + rename)', async () => {
  const root = ledgerHive();
  const ml = mkLedger(root);
  ml.ledger(AGENT);   // loaded
  fs.mkdirSync(path.join(root, 'state', 'mail'), { recursive: true });
  const stateDir = path.join(root, 'state');
  const renames = [];
  const { calls } = await syncWrites(stateDir, () => withAsync('rename', (args, real) => { renames.push(args.map((a) => path.basename(a))); return real(); }, async () => {
    ml.markDelivered(AGENT, msg('m-1'));
    assert.ok(ml.ledger(AGENT).entries['m-1'], 'read-after-write: in the ledger at once');
    await until(() => diskIds(root).includes('m-1'), 'the save');
    await WB.settleWrites(10_000);
  }));
  // LAG-ROUTE-WRITES-108: the state/mail mkdir runs in the flight too, so nothing here is synchronous
  assert.deepEqual(calls, [], 'no synchronous file write or mkdir');
  assert.ok(renames.some((r) => /^jim-1\.json\.tmp-[0-9a-f]{6}$/.test(r[0]) && r[1] === 'jim-1.json'), `tmp + rename: ${JSON.stringify(renames)}`);
  assert.deepEqual(tmpsIn(path.join(root, 'state', 'mail')), []);
  ml.dispose();
});

test('ledger: after the first save not even the mkdir is synchronous', async () => {
  const root = ledgerHive();
  const ml = mkLedger(root);
  ml.markDelivered(AGENT, msg('m-1'));
  await until(() => diskIds(root).includes('m-1'), 'the first save');
  await WB.settleWrites(10_000);
  const { calls } = await syncWrites(path.join(root, 'state'), async () => {
    for (let i = 2; i <= 4; i++) {
      ml.markDelivered(AGENT, msg(`m-${i}`));
      await until(() => diskIds(root).includes(`m-${i}`), `save ${i}`);
    }
    await WB.settleWrites(10_000);
  });
  assert.deepEqual(calls, []);
  ml.dispose();
});

test('ledger: changes during a save are not lost, and saves of one ledger never overlap', async () => {
  const root = ledgerHive();
  const ml = mkLedger(root);
  ml.ledger(AGENT);
  const g = gate();
  let open = 0; let most = 0;
  await withAsync('writeFile', async (args, real) => {
    const mine = path.basename(String(args[0])).startsWith(`${AGENT}.json.tmp-`);
    if (mine) { open++; most = Math.max(most, open); }
    try { await real(); if (mine && !g.reached) await g.wait(); else if (mine) await sleep(3); } finally { if (mine) open--; }
  }, async () => {
    ml.markDelivered(AGENT, msg('m-1'));
    await until(() => g.reached, 'the first save');
    for (let i = 2; i <= 30; i++) ml.markDelivered(AGENT, msg(`m-${i}`));
    assert.equal(Object.keys(ml.ledger(AGENT).entries).length, 30);
    g.open();
    await until(() => diskIds(root).length === 30, 'the last state on disk');
    await WB.settleWrites(10_000);
  });
  assert.equal(most, 1, 'one save at a time');
  assert.deepEqual(readJson(ledgerPath(root)), JSON.parse(JSON.stringify(ml.ledger(AGENT))), 'the file is the ledger');
  ml.dispose();
});

test('ledger: flushAll during a save wins, whichever lands first (quit)', async () => {
  for (const hold of ['writeFile', 'rename']) {
    const root = ledgerHive();
    const ml = mkLedger(root);
    ml.ledger(AGENT);
    const g = gate();
    await withAsync(hold, async (_a, real) => { await g.wait(); return real(); }, async () => {
      ml.markDelivered(AGENT, msg('m-1'));
      await until(() => g.reached, `the save's ${hold}`);
      ml.markDelivered(AGENT, msg('m-2'));
      ml.flushAll();
      assert.deepEqual(diskIds(root), ['m-1', 'm-2'], 'on disk when the flush returns');
      g.open();
      await WB.settleWrites(10_000);
    });
    assert.deepEqual(diskIds(root), ['m-1', 'm-2'], `${hold}: the older save did not land over the flush`);
    assert.deepEqual(tmpsIn(path.join(root, 'state', 'mail')), []);
    ml.dispose();
  }
});

test('ledger: dispose during a save, then a reload, reads the flushed ledger and not the older file', async () => {
  const root = ledgerHive();
  const ml = mkLedger(root);
  ml.ledger(AGENT);
  const g = gate();
  let landed = false;
  await withAsync('rename', async (_a, real) => { await g.wait(); const r = await real(); landed = true; await sleep(30); return r; }, async () => {
    deliver(ml, root, 'm-1');
    await until(() => g.reached, 'the rename');
    deliver(ml, root, 'm-2');
    ml.dispose();
    g.open();
    await until(() => landed, 'the older rename to land');
    // the disk may hold the older save for a moment: a new ledger must still load the flushed one
    const again = mkLedger(root);
    assert.deepEqual(Object.keys(again.ledger(AGENT).entries).sort(), ['m-1', 'm-2']);
    await WB.settleWrites(10_000);
    again.dispose();
  });
  assert.deepEqual(diskIds(root), ['m-1', 'm-2']);
});

test('MAIL-LEDGER-FLUSH-LAG-108: a timer save that finds another write of the file in flight waits for it, never writing the whole file on main', async () => {
  const root = ledgerHive();
  fs.mkdirSync(path.join(root, 'state', 'mail'), { recursive: true });
  const T0 = Date.now();
  const logs = [];
  const waits = [];   // every arm's wait, so a re-arm that spins (wait 0) shows
  const ml = new L.MailLedger({
    // A clock that moves only when the test moves it (it never does here), so each re-arm's wait is
    // exactly lastWriteAt + 5 - now = 5, with no ms tick between the two reads.
    root: () => root, appendLog: (r) => logs.push(r), readLogRows: () => [], writeDelayMs: 5, clock: () => T0,
    setTimer: (fn, ms) => { waits.push(ms); const t = setTimeout(fn, ms); t.unref(); return t; }
  });
  ml.ledger(AGENT);
  const g = gate();
  let timerSaves = 0;
  const { calls } = await syncWrites(path.join(root, 'state'), () => withAsync('writeFile', async (args, real) => {
    if (path.basename(String(args[0])).startsWith(`${AGENT}.json.tmp-`) && !g.reached) await g.wait();
    else timerSaves++;
    return real();
  }, async () => {
    // A disposed ledger's last save of the same file, held in its tmp write.
    const older = WB.writeFileBehind(ledgerPath(root), JSON.stringify({ older: true }));
    await until(() => g.reached, 'the other write in flight');
    ml.markDelivered(AGENT, msg('m-1'));
    await sleep(60);   // the 5 ms coalesce timer has fired several times meanwhile
    assert.equal(timerSaves, 0, 'no save of ours started while the other one is in flight');
    assert.ok(WB.writeInFlight(ledgerPath(root)), 'the other write is still in flight');
    // Jim SHOULD 1: the timer never tried to start a second flight (that is rejected, and would log a
    // false write failure and set writeFailLogged, hiding a real one).
    assert.deepEqual(logs.filter((r) => /fail/.test(String(r.kind))), [], 'no write-failed row while it waits');
    // Jim SHOULD 2: each re-arm waits a whole coalesce period, so the wait is no busy loop on main.
    const rearms = waits.slice(1);
    assert.ok(rearms.length >= 2, `the timer re-armed while it waited (${waits.join(',')})`);
    assert.ok(rearms.every((ms) => ms === 5), `every re-arm waits the coalesce period: ${waits.join(',')}`);
    g.open();
    assert.equal(await bounded(older, 'the other write'), 'published', 'the other write was not overtaken');
    await until(() => diskIds(root).includes('m-1'), 'our save, after it');
    await WB.settleWrites(10_000);
  }));
  assert.deepEqual(calls, [], 'no synchronous write or rename of the ledger on main');
  assert.deepEqual(readJson(ledgerPath(root)), JSON.parse(JSON.stringify(ml.ledger(AGENT))), 'the newest ledger is the file');
  assert.deepEqual(tmpsIn(path.join(root, 'state', 'mail')), []);
  ml.dispose();
});

test('ledger: an inbox file moves to .done only after the save that records it has landed', async () => {
  const root = ledgerHive();
  const ml = mkLedger(root);
  const inbox = path.join(root, 'agents', AGENT, 'inbox');
  deliver(ml, root, 'm-1');
  ml.claimSurfacing(AGENT, ['m-1'], 'turn-1', 'UserPromptSubmit');
  ml.confirmSurfaced(AGENT, ['m-1'], 'turn-1', 'evidence');
  await until(() => diskIds(root).includes('m-1'), 'the first save');
  await WB.settleWrites(10_000);
  const g = gate();
  await withAsync('rename', async (_a, real) => { await g.wait(); return real(); }, async () => {
    ml.markActed(AGENT, ['m-1'], 'turn-1');
    assert.equal(ml.ledger(AGENT).entries['m-1'].state, 'acted');
    await until(() => g.reached, 'the save that records acted');
    assert.equal(fs.existsSync(path.join(inbox, 'm-1.json')), true, 'not moved before the ledger is durable');
    assert.notEqual(readJson(ledgerPath(root)).entries['m-1'].state, 'acted');
    g.open();
    await until(() => fs.existsSync(path.join(inbox, '.done', 'm-1.json')), 'the .done rename');
  });
  assert.equal(readJson(ledgerPath(root)).entries['m-1'].state, 'acted');
  assert.equal(fs.existsSync(path.join(inbox, 'm-1.json')), false);
  ml.dispose();
});

// Jim J2 (audit of ec6a36a4): the save's own set of acted ids is what runArchives may move.
test('ledger: a mail acted on DURING a save stays in the inbox until the next save, which records it, has landed', async () => {
  const root = ledgerHive();
  const ml = mkLedger(root);
  const inbox = path.join(root, 'agents', AGENT, 'inbox');
  for (const id of ['m-a', 'm-b']) deliver(ml, root, id);
  ml.claimSurfacing(AGENT, ['m-a', 'm-b'], 'turn-1', 'UserPromptSubmit');
  ml.confirmSurfaced(AGENT, ['m-a', 'm-b'], 'turn-1', 'evidence');
  await until(() => diskIds(root).length === 2, 'the first save');
  await WB.settleWrites(10_000);
  const gates = [gate(), gate()];
  let n = 0;
  await withAsync('rename', async (_a, real) => { const g = gates[n++]; if (g) await g.wait(); return real(); }, async () => {
    ml.markActed(AGENT, ['m-a'], 'turn-1');
    await until(() => gates[0].reached, 'the save that records A');
    ml.markActed(AGENT, ['m-b'], 'turn-1');   // B is acted while A's save is in flight
    gates[0].open();
    await until(() => fs.existsSync(path.join(inbox, '.done', 'm-a.json')), 'A moves once its save landed');
    await until(() => gates[1].reached, 'the save that records B');
    assert.equal(readJson(ledgerPath(root)).entries['m-a'].state, 'acted');
    assert.notEqual(readJson(ledgerPath(root)).entries['m-b'].state, 'acted', 'B is not durable yet');
    assert.equal(fs.existsSync(path.join(inbox, 'm-b.json')), true, 'B STAYS IN THE INBOX UNTIL ITS OWN SAVE HAS LANDED');
    assert.equal(fs.existsSync(path.join(inbox, '.done', 'm-b.json')), false);
    gates[1].open();
    await until(() => fs.existsSync(path.join(inbox, '.done', 'm-b.json')), 'B moves after the next save');
  }).finally(() => { for (const g of gates) g.open(); });
  assert.equal(readJson(ledgerPath(root)).entries['m-b'].state, 'acted');
  assert.equal(fs.existsSync(path.join(inbox, 'm-b.json')), false);
  ml.dispose();
});

test('ledger: a failed save is logged once and tried again', async () => {
  const root = ledgerHive();
  const logs = [];
  const ml = mkLedger(root, logs);
  ml.ledger(AGENT);
  let fails = 2;
  await withAsync('rename', async (_a, real) => { if (fails-- > 0) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return real(); }, async () => {
    ml.markDelivered(AGENT, msg('m-1'));
    await until(() => diskIds(root).includes('m-1'), 'the retry to land');
  });
  assert.equal(logs.filter((r) => r.kind === 'mail-ledger-write-failed').length, 1);
  assert.deepEqual(tmpsIn(path.join(root, 'state', 'mail')), []);
  ml.dispose();
});

// ───────────────────────────────────────────────────────── 3. state/mail-cards

const link = (id, card) => ({ v: 1, mailId: id, cards: [card], method: 'field', at: '2026-11-17T10:00:00.000Z', trust: 'delivery', from: 'god-1', conversation: `conv-${card}` });
const row = (id, card, extra = {}) => ({ v: 1, id, card, cards: [card], cardFrom: 'field', from: 'god-1', to: AGENT, act: 'inform', subject: `s-${id}`, at: '2026-11-17T10:00:00.000Z', ...extra });
const cardsDir = (root) => path.join(root, 'state', 'mail-cards');
const lines = (p) => { try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

// ───────────────────────────────────────────────────────── LAG-ROUTE-WRITES-108: the ledger save off main
// Jim's undrained jail (god's ledger 3.5 MB, 4209 entries): flushBehind held main for a whole
// JSON.stringify and its utf8 encode, plus existsSync and mkdirSync. Now main only prunes and takes the
// snapshot; the text is made and written in pieces, one per turn, and the folder checks run in the flight.

test('LAG-ROUTE-WRITES-108: ledgerTextChunks is JSON.stringify(doc, null, 2) byte for byte, at every piece size, across transitions', () => {
  let seed = 108;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const sizes = [1, 97, 4096, 64 * 1024];
  const same = (doc, what) => {
    const want = JSON.stringify(doc, null, 2);
    for (const size of sizes) assert.equal([...L.ledgerTextChunks(doc, size)].join(''), want, `${what} (pieces of ${size})`);
  };
  same(L.emptyLedger(AGENT), 'an empty ledger');
  same({ ...L.emptyLedger(AGENT), lastActivityAt: undefined, extra: { a: [1, { b: 'x\ny' }], c: [] } }, 'undefined, nested and odd top-level values');
  let doc = L.emptyLedger(AGENT);
  let now = 1_700_000_000_000;
  const ids = [];
  const some = () => ids.filter(() => rnd(3) === 0);
  for (let step = 0; step < 400; step++) {
    now += 1 + rnd(5_000);
    const op = rnd(8);
    let next;
    if (op < 3 || !ids.length) {
      const id = `m-${step}`;
      ids.push(id);
      next = L.applyDelivered(doc, msg(id, { subject: `s "${step}" é中\n\t\\`, act: ['inform', 'request', 'query'][rnd(3)], supersedes: rnd(4) ? undefined : ['a', 'b'], card: rnd(2) ? 'CARD-1' : undefined }), now);
    } else if (op === 3) next = L.applyClaimSurfacing(doc, some(), `e-${step}`, 'UserPromptSubmit', now);
    else if (op === 4) next = L.applyConfirmSurfaced(doc, some(), `e-${step - 1}`, 'evidence', now);
    else if (op === 5) next = L.applyMarkActed(doc, some(), `e-${step - 2}`, now);
    else if (op === 6) next = L.applySetAside(doc, some(), rnd(2) === 0, now);
    else next = L.applyPrune(doc, now, rnd(2) ? 60_000 : 0);
    doc = next.doc;
    same(doc, `after step ${step} (op ${op})`);   // later saves reuse the entry texts the earlier ones made
  }
  assert.ok(Object.keys(doc.entries).length > 20, 'the walk built a real ledger');
  same(JSON.parse(JSON.stringify(doc)), 'a fresh copy (no entry text kept yet)');
});

test('LAG-ROUTE-WRITES-108: the save writes a large ledger in pieces, and main runs between them', async () => {
  const root = ledgerHive();
  const ml = mkLedger(root);
  ml.ledger(AGENT);
  const pieces = [];
  let turns = 0;
  let spin = true;
  const tick = () => { turns++; if (spin) setImmediate(tick); };
  setImmediate(tick);
  try {
    await withAsync('writeFile', (args, real) => {
      if (!String(args[0]).includes(`${AGENT}.json.tmp-`)) return real();
      assert.equal(typeof args[1], 'object', 'the ledger is not handed to writeFile as one string');
      const it = args[1];
      const watched = (function* () { for (const s of it) { pieces.push({ len: s.length, turn: turns }); yield s; } })();
      return real(args[0], watched, ...args.slice(2));
    }, async () => {
      for (let i = 0; i < 300; i++) ml.markDelivered(AGENT, msg(`m-${i}`, { body: 'x'.repeat(10), subject: 'y'.repeat(150) }));
      await until(() => diskIds(root).length === 300, 'the save of 300 entries');
      await WB.settleWrites(10_000);
    });
  } finally { spin = false; }
  const text = fs.readFileSync(ledgerPath(root), 'utf8');
  assert.equal(text, JSON.stringify(ml.ledger(AGENT), null, 2), 'the file is the synchronous text, byte for byte');
  assert.ok(text.length > 3 * 64 * 1024, `fixture: a ledger of several pieces (${text.length} chars)`);
  assert.ok(pieces.length >= 3, `written in pieces (${pieces.length})`);
  assert.ok(pieces.every((p) => p.len < 64 * 1024 + 4096), `no piece much over 64 KiB (${pieces.map((p) => p.len)})`);
  for (let i = 1; i < pieces.length; i++) assert.ok(pieces[i].turn > pieces[i - 1].turn, `main ran between piece ${i - 1} and piece ${i}`);
  ml.dispose();
});

test('LAG-ROUTE-WRITES-108: a hive removed while the save checks its folders is never re-created, and the ledger stops trying', async () => {
  const root = ledgerHive();
  const logs = [];
  const ml = mkLedger(root, logs);
  ml.ledger(AGENT);
  const g = gate();
  const opts = [];
  let asked = 0;
  await withAsync('mkdir', async (args, real) => { asked++; opts.push(args[1]); await g.wait(); return real(); }, async () => {
    const { calls } = await syncWrites(root, async () => {
      ml.markDelivered(AGENT, msg('m-1'));
      await until(() => g.reached, 'the save\'s folder check');
    });
    assert.deepEqual(calls, [], 'not even the folder check is synchronous');
    fs.rmSync(root, { recursive: true, force: true });
    g.open();
    await WB.settleWrites(10_000);
    const settled = asked;
    await new Promise((r) => setTimeout(r, 50));   // 10 write delays: a save re-armed by mistake asks again within this
    assert.equal(asked, settled, 'the ledger stopped saving into the removed hive');
  });
  assert.equal(fs.existsSync(root), false, 'the hive root was not re-created');
  assert.ok(opts.every((o) => !(o && o.recursive)), `no recursive mkdir from the timer (${JSON.stringify(opts)})`);
  assert.deepEqual(logs.filter((r) => r.kind === 'mail-ledger-write-failed'), [], 'a removed hive is not a failed write');
  ml.dispose();
});

test('LAG-ROUTE-WRITES-108: flushAll during the save\'s folder check wins; the save never lands', async () => {
  const root = ledgerHive();
  const ml = mkLedger(root);
  ml.ledger(AGENT);
  const g = gate();
  let wrote = 0;
  await withAsync('writeFile', (args, real) => { if (String(args[0]).includes(`${AGENT}.json.tmp-`)) wrote++; return real(); }, () =>
    withAsync('mkdir', async (_a, real) => { await g.wait(); return real(); }, async () => {
      ml.markDelivered(AGENT, msg('m-1'));
      await until(() => g.reached, 'the save\'s folder check');
      ml.markDelivered(AGENT, msg('m-2'));
      ml.flushAll();
      assert.deepEqual(diskIds(root), ['m-1', 'm-2'], 'on disk when the flush returns');
      g.open();
      await WB.settleWrites(10_000);
    }));
  assert.equal(wrote, 0, 'the save gave way before writing its tmp');
  assert.deepEqual(diskIds(root), ['m-1', 'm-2']);
  assert.deepEqual(tmpsIn(path.join(root, 'state', 'mail')), []);
  ml.dispose();
});

test('mail-cards: record() appends with no synchronous write, and the record is known at once', async () => {
  const root = dirOf('mc');
  const index = new MC.MailCardIndex(root);
  const { calls } = await syncWrites(root, async () => {
    assert.equal(index.record(link('m-1', 'CARD-A'), [row('m-1', 'CARD-A')]), true);
    assert.equal(index.has('m-1'), true);
    assert.deepEqual(index.conversationCards('conv-CARD-A'), ['CARD-A']);
    assert.equal(index.record(link('m-1', 'CARD-A'), [row('m-1', 'CARD-A')]), false, 'an id is recorded once');
    await WB.settleWrites(10_000);
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(lines(path.join(cardsDir(root), 'CARD-A.jsonl')).map((r) => r.id), ['m-1']);
  assert.deepEqual(lines(path.join(cardsDir(root), '_links.jsonl')).map((r) => r.mailId), ['m-1']);
});

test('mail-cards: rows keep their order per card, and every link lands after its rows', async () => {
  const root = dirOf('mc');
  const index = new MC.MailCardIndex(root);
  const order = [];
  await withAsync('appendFile', (args, real) => { order.push({ file: path.basename(String(args[0])), text: String(args[1]) }); return real(); }, async () => {
    for (let i = 0; i < 60; i++) {
      const card = i % 2 ? 'CARD-A' : 'CARD-B';
      index.record(link(`m-${i}`, card), [row(`m-${i}`, card), row(`m-${i}`, card, { to: 'pam-1' })]);
    }
    await WB.settleWrites(20_000);
  });
  for (const card of ['CARD-A', 'CARD-B']) {
    const ids = lines(path.join(cardsDir(root), `${card}.jsonl`)).map((r) => `${r.id}>${r.to}`);
    const want = [];
    for (let i = 0; i < 60; i++) if ((i % 2 ? 'CARD-A' : 'CARD-B') === card) want.push(`m-${i}>${AGENT}`, `m-${i}>pam-1`);
    assert.deepEqual(ids, want, `${card}: no row lost or reordered`);
  }
  assert.deepEqual(lines(path.join(cardsDir(root), '_links.jsonl')).map((r) => r.mailId), Array.from({ length: 60 }, (_, i) => `m-${i}`));
  const rowsSeen = new Set();
  for (const o of order) {
    if (o.file === '_links.jsonl') assert.ok(rowsSeen.has(JSON.parse(o.text).mailId), 'a link was appended before its rows');
    else for (const l of o.text.split('\n').filter(Boolean)) rowsSeen.add(JSON.parse(l).id);
  }
});

test('mail-cards: every reader in the process sees a record while its appends are still queued', async () => {
  const root = dirOf('mc');
  const index = new MC.MailCardIndex(root);
  const g = gate();
  await withAsync('appendFile', async (_a, real) => { await g.wait(); return real(); }, async () => {
    index.record(link('m-1', 'CARD-A'), [row('m-1', 'CARD-A', { act: 'done' })]);
    await until(() => g.reached, 'the append to start');
    assert.equal(fs.existsSync(cardsDir(root)), false, 'nothing on disk yet');
    // a second index over the same hive (a new HiveManager root, the startup catch-up's prime)
    const other = new MC.MailCardIndex(root);
    assert.equal(other.has('m-1'), true, 'load()');
    const primed = new MC.MailCardIndex(root);
    const steps = primed.primeSteps();
    let s = steps.next();
    while (!s.done) s = steps.next(s.value && s.value.read ? null : undefined);   // the driver read found no file
    assert.equal(primed.has('m-1'), true, 'primeSteps()');
    // the derived writer's index readers
    assert.deepEqual(DW.readIndexDoneMails(root).map((m) => m.id), ['m-1'], 'readIndexDoneMails');
    assert.deepEqual((await DW.readIndexDoneMailsAsync(root)).map((m) => m.id), ['m-1'], 'readIndexDoneMailsAsync');
    g.open();
    await WB.settleWrites(10_000);
  });
  assert.deepEqual(DW.readIndexDoneMails(root).map((m) => m.id), ['m-1'], 'and once, not twice, when on disk');
});

test('mail-cards: a failed append forgets the record again and tells the owner', async () => {
  const root = dirOf('mc');
  const index = new MC.MailCardIndex(root);
  const failed = [];
  index.onWriteFailed = (id) => failed.push(id);
  let fail = true;
  await withAsync('appendFile', async (_a, real) => { if (fail) throw Object.assign(new Error('EIO'), { code: 'EIO' }); return real(); }, async () => {
    index.record(link('m-0', 'CARD-A'), [row('m-0', 'CARD-A')]);
    await WB.settleWrites(10_000);
    assert.deepEqual(failed, ['m-0']);
    assert.equal(index.has('m-0'), false);
    assert.deepEqual(index.conversationCards('conv-CARD-A'), []);
    fail = false;
    assert.equal(index.record(link('m-0', 'CARD-A'), [row('m-0', 'CARD-A')]), true, 'it can be recorded again');
    await WB.settleWrites(10_000);
  });
  assert.deepEqual(lines(path.join(cardsDir(root), '_links.jsonl')).map((r) => r.mailId), ['m-0']);
});

test('mail-cards: with write-behind off (a bare class) record() is the synchronous append', async () => {
  WB.enableWriteBehind(false);
  try {
    const root = dirOf('mc');
    const index = new MC.MailCardIndex(root);
    const { calls } = await syncWrites(root, () => { index.record(link('m-1', 'CARD-A'), [row('m-1', 'CARD-A')]); });
    assert.deepEqual(calls.filter((c) => c.startsWith('appendFileSync:')), ['appendFileSync:card-a.jsonl', 'appendFileSync:_links.jsonl']);
  } finally { WB.enableWriteBehind(); }
});

// ───────────────────────────────────────────────────────── quit: no rename outlives the exit (Jim's residual)

test('closeWrites: a rename already under way at the cap is waited for, so the quit flush goes after it', async () => {
  const dir = dirOf('cw');
  const p = path.join(dir, 'a.json');
  const g = gate();
  try {
    await withAsync('rename', async (_a, real) => { await g.wait(); return real(); }, async () => {
      const flight = WB.writeFileBehind(p, 'async-older');
      await until(() => g.reached, 'the rename');
      let closedAt = 0;
      const closing = WB.closeWrites(40, 5_000).then(() => { closedAt = Date.now(); });
      await sleep(200);
      assert.equal(closedAt, 0, 'THE CAP DOES NOT CUT OFF A RENAME UNDER WAY');
      g.open();
      await bounded(closing, 'closeWrites after the rename landed');
      assert.equal(WB.writeInFlight(p), false, 'no write in flight once it is closed');
      assert.equal(await flight, 'published');
    });
    // what finish does next: the synchronous write. Nothing older is left to land over it.
    fs.writeFileSync(p, 'sync-newer');
    WB.noteSyncWrite(p, 'sync-newer');
    await sleep(30);
    assert.equal(fs.readFileSync(p, 'utf8'), 'sync-newer');
    assert.deepEqual(tmpsIn(dir), [], 'no tmp file left behind');
  } finally { g.open(); WB.enableWriteBehind(); }
});

// god 621026: a rename that never settles (a filter driver, a dead network home) must not hold the quit,
// and must not land older text over the quit flush afterwards.
test('closeWrites: a rename that never settles does not hold the quit, and what it lands later is the quit flush', async () => {
  const dir = dirOf('cw');
  const p = path.join(dir, 'a.json');
  const g = gate();
  let carried = null;
  try {
    await withAsync('rename', async (a, real) => { await g.wait(); carried = fs.readFileSync(String(a[0]), 'utf8'); return real(); }, async () => {
      const flight = WB.writeFileBehind(p, 'async-older');
      await until(() => g.reached, 'the rename');
      const t0 = Date.now();
      await bounded(WB.closeWrites(40, 80), 'closeWrites with a rename that never settles', 3_000);
      const took = Date.now() - t0;
      assert.ok(took >= 100 && took < 2_000, `THE RENAME WAIT IS BOUNDED (${took} ms)`);
      assert.equal(WB.writeInFlight(p), true, 'the rename is still out');
      // what finish does next: the owner's synchronous write
      fs.writeFileSync(p, 'sync-newer, and longer than the older text');
      WB.noteSyncWrite(p, 'sync-newer, and longer than the older text');
      fs.writeFileSync(p, 'sync');
      WB.noteSyncWrite(p, 'sync');
      g.open();
      assert.equal(await flight, 'overtaken');
    });
    assert.equal(carried, 'sync', 'THE LATE RENAME CARRIES THE NEWEST TEXT, NOT THE OLDER ONE');
    assert.equal(fs.readFileSync(p, 'utf8'), 'sync');
    assert.deepEqual(tmpsIn(dir), []);
  } finally { g.open(); WB.enableWriteBehind(); }
});

test('closeWrites: a late rename that landed over the quit flush is put right at once, not when the write ends', async () => {
  const dir = dirOf('cw');
  const p = path.join(dir, 'a.json');
  const g = gate();
  const after = gate();
  try {
    await withAsync('rename', async (_a, real) => { await g.wait(); await real(); await after.wait(); }, async () => {
      const flight = WB.writeFileBehind(p, 'async-older');
      await until(() => g.reached, 'the rename');
      await bounded(WB.closeWrites(40, 80), 'closeWrites with a rename that never settles', 3_000);
      fs.writeFileSync(p, 'sync-newer');
      g.open();                                   // the rename lands between the owner's write and its report
      await until(() => after.reached, 'the rename to land');
      assert.equal(fs.readFileSync(p, 'utf8'), 'async-older');
      WB.noteSyncWrite(p, 'sync-newer');
      assert.equal(fs.readFileSync(p, 'utf8'), 'sync-newer', 'PUT RIGHT BEFORE THE APP EXITS: THE WRITE IN FLIGHT HAS NOT ENDED');
      assert.equal(WB.writeInFlight(p), true);
      after.open();
      assert.equal(await flight, 'overtaken');
    });
    assert.equal(fs.readFileSync(p, 'utf8'), 'sync-newer');
    assert.deepEqual(tmpsIn(dir), []);
  } finally { g.open(); after.open(); WB.enableWriteBehind(); }
});

test('closeWrites: bounded for a write still in its tmp phase, which then never renames; whole files go synchronous', async () => {
  const dir = dirOf('cw');
  const p = path.join(dir, 'a.json');
  const g = gate();
  try {
    await withAsync('rename', async (_a, real) => real(), async (renames) => {
      await withAsync('writeFile', async (_a, real) => { await real(); await g.wait(); }, async () => {
        const flight = WB.writeFileBehind(p, 'async-older');
        await until(() => g.reached, 'the tmp write');
        assert.equal(WB.fileWriteBehindOn(), true);
        const t0 = Date.now();
        await bounded(WB.closeWrites(60), 'closeWrites at its cap');
        const took = Date.now() - t0;
        assert.ok(took >= 50 && took < 2_000, `bounded by the cap (${took} ms)`);
        assert.equal(WB.fileWriteBehindOn(), false, 'CLOSED: THE TIMERS SAVE SYNCHRONOUSLY FROM HERE');
        assert.equal(WB.writeBehindOn(), true, 'the append lane keeps its order');
        g.open();
        assert.equal(await flight, 'withdrawn');
      });
      assert.deepEqual(renames, [], 'A WRITE CUT OFF AT THE CAP NEVER RENAMES AFTER IT');
    });
    assert.equal(fs.existsSync(p), false);
    assert.deepEqual(tmpsIn(dir), []);
  } finally { g.open(); WB.enableWriteBehind(); }
  assert.equal(WB.fileWriteBehindOn(), true, 'enableWriteBehind opens it again (tests)');
});

test('closeWrites: after it the ledger and the key registry save synchronously from their timers', async () => {
  const root = ledgerHive();
  const ml = mkLedger(root);
  try {
    await bounded(WB.closeWrites(1_000), 'closeWrites with nothing of its own in flight');
    deliver(ml, root, 'm-c');
    const { calls } = await syncWrites(root, async () => {
      ml.claimSurfacing(AGENT, ['m-c'], 'turn-1', 'UserPromptSubmit');
      await until(() => diskIds(root).includes('m-c'), 'the save after close');
    });
    // REGISTRY-RENAME-EPERM-107 renames through the fs-handle addon (no fs.renameSync), so the
    // synchronous save shows as its synchronous tmp write.
    assert.ok(calls.some((c) => /^writeFileSync:jim-1\.json\.tmp-[0-9a-f]{6}$/.test(c)), `THE LEDGER TIMER SAVES SYNCHRONOUSLY ONCE CLOSED (${calls.join(', ')})`);
  } finally { WB.enableWriteBehind(); ml.dispose(); }
  assert.match(codeOnly(readSource('src/main/claims/registry.ts')), /if \(fileWriteBehindOn\(\)\) this\.flushBehind\(\); else this\.flush\(\);/);
});

// ───────────────────────────────────────────────────────── LAG-MAIN-PERSIST-OFFMAIN: one settle for every store

test('settleWrites waits for a joined store, is bounded by its cap, and survives a joiner that throws or rejects', async () => {
  let open; let calls = 0;
  const gate = new Promise((r) => { open = r; });
  const off = [WB.joinOnSettle(() => { calls += 1; return gate; })];
  off.push(WB.joinOnSettle(() => { throw new Error('a broken joiner'); }));
  off.push(WB.joinOnSettle(() => Promise.reject(new Error('a failed write'))));
  let done = false;
  const settled = WB.settleWrites(5_000).then(() => { done = true; });
  await sleep(60);
  assert.equal(done, false, 'SETTLE WAITS FOR THE JOINED STORE');
  open();
  await settled;
  assert.equal(calls, 1);
  // the cap: a store that never settles does not hold quit
  off.push(WB.joinOnSettle(() => new Promise(() => {})));
  const t0 = Date.now();
  await WB.settleWrites(80);
  const took = Date.now() - t0;
  assert.ok(took >= 60 && took < 2_000, `bounded by the cap (${took} ms)`);
  for (const f of off) f();
  const t1 = Date.now();
  await WB.settleWrites(5_000);
  assert.ok(Date.now() - t1 < 1_000, 'a store that left is no longer waited for');
});

test('the roster and the spawned-folder list: async writes in order, each joined to the one settle, no second quit path', async () => {
  const { RosterStore } = loadTs('src/main/roster.ts');
  const { SpawnedCwds } = loadTs('src/main/spawnedCwds.ts');
  const home = dirOf('roster');
  const store = new RosterStore(() => home);
  const snap = (note) => ({ version: 1, savedAt: '', agents: [{ id: 'a', note }], archived: [], restorable: [], queues: {}, selectedId: null });
  const sync = [];
  const names = ['writeFileSync', 'renameSync', 'copyFileSync', 'mkdirSync'];
  const real = names.map((n) => fs[n]);
  names.forEach((n, i) => { fs[n] = (...a) => { if (String(a[0]).startsWith(home) || String(a[1]).startsWith(home)) sync.push(n); return real[i](...a); }; });
  try {
    void store.writeAsync(snap('older'));
    void store.writeAsync(snap('newest'));
    const file = path.join(home, 'cwds.json');
    const cwds = new SpawnedCwds(() => file);
    void cwds.add(path.join(home, 'p1'));
    void cwds.add(path.join(home, 'p2'));
    assert.deepEqual(cwds.list(), [path.join(home, 'p1'), path.join(home, 'p2')], 'the trust list is in memory at once');
    assert.equal(fs.existsSync(file), false, 'nothing written in the caller\'s turn');
    await Promise.all([store.settleAsyncWrite(), cwds.settle()]);
    assert.equal(store.read().agents[0].note, 'newest');
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).cwds, [path.join(home, 'p1'), path.join(home, 'p2')]);
    assert.deepEqual(sync, [], 'NO SYNCHRONOUS WRITE ON EITHER PATH');
  } finally { names.forEach((n, i) => { fs[n] = real[i]; }); }

  const index = codeOnly(readSource('src/main/index.ts'));
  assert.match(index, /const roster = new RosterStore\([^\n]*\n\s*joinOnSettle\(\(\) => roster\.settleAsyncWrite\(\)\);/);
  assert.match(index, /const fsSpawnedCwds = new SpawnedCwds\([^\n]*\n\s*joinOnSettle\(\(\) => fsSpawnedCwds\.settle\(\)\);/);
  assert.match(index, /ipcMain\.handle\('roster:write', \(_evt, snap: unknown\) => roster\.writeAsync\(snap\)\);/);
  assert.equal(index.split('roster.settleAsyncWrite()').length - 1, 1, 'ONE QUIT PATH: the roster is joined through settleWrites only');
  assert.equal(index.split('roster.write(').length - 1, 0, 'no synchronous roster write left in the app');
});

// ───────────────────────────────────────────────────────── the app's wiring (index.ts cannot be loaded here)

test('the app turns write-behind on before the hive exists, and quit, reset and a home change settle then flush', () => {
  const index = codeOnly(readSource('src/main/index.ts'));
  const on = index.indexOf('enableWriteBehind();');
  assert.ok(on > 0 && on < index.indexOf('const hive = new HiveManager('), 'enableWriteBehind() before the HiveManager');
  // quit: wait for the writes in flight, then finish (flushKeyRegistry + hive.dispose) writes the rest
  const join = index.slice(index.indexOf('let analyticsFlushed = false;'), index.indexOf(']).then(finish, finish);'));
  assert.match(join, /Promise\.all\(\[[\s\S]*\n\s*closeWrites\(WRITE_BEHIND_SETTLE_MS\)\.catch\(\(\) => undefined\),/, 'will-quit joins the writes in flight and closes write-behind');
  assert.equal(join.includes('settleWrites('), false, 'quit never uses the wait that a rename can outlive');
  const finish = index.slice(index.indexOf('const finish = (): void => {'));
  assert.ok(finish.indexOf('flushKeyRegistry()') > 0 && finish.indexOf('flushKeyRegistry()') < finish.indexOf('hive.dispose()'));
  // reset and home change: no write lands in the old hive after it was closed
  assert.equal(index.split('await settleWrites(WRITE_BEHIND_SETTLE_MS);').length - 1, 2);
  for (const part of index.split('await settleWrites(WRITE_BEHIND_SETTLE_MS);').slice(1)) assert.match(part.slice(0, 200), /^\s*try \{ hive\.dispose\(\); \}/);

  const hive = codeOnly(readSource('src/main/hive.ts'));
  const dispose = hive.slice(hive.indexOf('  dispose(): void {'));
  const a = dispose.indexOf('this.mail.dispose()'); const b = dispose.indexOf('flushAppendsSync()'); const c = dispose.indexOf('this.closeAppendFiles()');
  assert.ok(a > 0 && a < b && b < c, 'dispose: the ledgers, then the queued index appends, then the log closes');
  assert.match(hive, /this\.mailCardIndex\.onWriteFailed = /);
});

test('every main-process reader of the three files goes through the write-behind view', () => {
  const wiring = codeOnly(readSource('src/main/claims/readWiring.ts'));
  assert.match(wiring, /registryText\(root\)/);
  assert.match(wiring, /withPendingAppends\(file, disk\)/);
  assert.doesNotMatch(wiring, /flushRegistryWrites/, 'get no longer forces a synchronous registry save');
  const dw = codeOnly(readSource('src/main/claims/derivedWriter.ts'));
  assert.equal(dw.split('withPendingAppends(').length - 1, 2, 'eachIndexRow and eachIndexRowAsync');
  assert.match(dw, /pendingAppendNames\(dir\)/);
  // the only synchronous writers left for the three files are the flush paths, and each reports its write
  const reg = codeOnly(readSource('src/main/claims/registry.ts'));
  assert.equal(reg.split('writeFileSync(').length - 1, 1, 'registry.ts: one synchronous writer (saveRegistry)');
  assert.match(reg, /renameSync\(tmp, p\);\s*noteSyncWrite\(p, text\);/);
  const led = codeOnly(readSource('src/main/mailLedger.ts'));
  assert.equal(led.split('atomicWriteJson(st.file').length - 1, 1, 'mailLedger.ts: one synchronous ledger writer (flushState)');
  assert.match(led, /atomicWriteJson\(st\.file, st\.doc\);\s*noteSyncWrite\(st\.file, /);
  const mc = codeOnly(readSource('src/main/mailCards.ts'));
  assert.equal(mc.split('appendFileSync(').length - 1, 2, 'mailCards.ts: the two appends of the synchronous record()');
});
