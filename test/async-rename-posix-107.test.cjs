'use strict';
require('./tools/own-job.cjs');

/**
 * ASYNC-RENAME-POSIX-107. The async writers (writeBehind -> atomicWriteTextAsync) published with a
 * plain rename. Windows refuses that while a reader holds the target open (EPERM), so the write
 * retried for about 200 ms and was then lost. They now go through the fs-handle addon's
 * posixRenameAsync first: the POSIX rename of REGISTRY-RENAME-EPERM-107, run on a libuv pool thread.
 *
 *   A1  a reader holds the target open (proved: a plain rename over it fails with EPERM).
 *       atomicWriteTextAsync publishes with no plain rename at all; the reader keeps the old bytes.
 *   A2  the same write with the addon switched off is lost after the retries (the old behaviour).
 *   A3  writeFileBehind publishes under the same held reader.
 *   A4  the rename runs on the pool, not on the main thread: with every pool thread blocked the
 *       call returns a pending promise, the target is unchanged and the loop keeps turning; the
 *       rename lands once the pool is released.
 *   A5  fallback: a rejected or missing posixRenameAsync falls back to the plain rename, and the
 *       sync posixRename is never called on the async path.
 *   A6  `commit` is asked before the addon rename, and again before the fallback.
 *   A7  the addon rejects with the Win32 code as `errno`; bad arguments throw at the call.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const AJ = loadTs('src/main/atomicJson.ts');
const WB = loadTs('src/main/writeBehind.ts');
const win = process.platform === 'win32';
const winOnly = { skip: !win && 'Windows rename semantics' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function scratch(t, tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `guppy-asyncrename-${tag}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'state.json');
  fs.writeFileSync(target, 'old');
  return { dir, target };
}

/** Open `target` for reading and prove the handle blocks a plain rename over it. */
async function heldReader(t, dir, target) {
  const reader = await fsp.open(target, 'r');
  t.after(() => reader.close().catch(() => {}));
  const probe = path.join(dir, 'probe');
  fs.writeFileSync(probe, 'probe');
  assert.throws(() => fs.renameSync(probe, target), { code: 'EPERM' }, 'THE READER HOLDS THE TARGET: a plain rename over it is refused');
  fs.rmSync(probe);
  return reader;
}

/** Count the plain fs/promises renames while the test runs. */
function plainRenames(t) {
  const real = fsp.rename;
  const seen = [];
  fsp.rename = (...args) => { seen.push(path.basename(String(args[1]))); return real(...args); };
  t.after(() => { fsp.rename = real; });
  return seen;
}

function useAddon(t, addon) {
  AJ.__setRenameAddonForTest(addon);
  t.after(() => AJ.__setRenameAddonForTest(undefined));
}

function realAddon() {
  const mod = { exports: {} };
  process.dlopen(mod, path.join(__dirname, '..', 'resources', 'fs-handle', 'bin', 'guppy_fs_handle.node'));
  return mod.exports;
}

test('A1 a reader holds the target open: atomicWriteTextAsync publishes through the pool rename, with no plain rename', winOnly, async (t) => {
  useAddon(t, undefined);
  const { dir, target } = scratch(t, 'a1');
  const reader = await heldReader(t, dir, target);
  const plain = plainRenames(t);
  const tmps = [];
  assert.equal(await AJ.atomicWriteTextAsync(target, 'new', undefined, (tmp) => tmps.push(tmp)), true, 'PUBLISHED WHILE THE READER HOLDS THE TARGET');
  assert.deepEqual(plain, [], 'NO PLAIN RENAME: nothing was refused and nothing was retried');
  assert.equal(fs.readFileSync(target, 'utf8'), 'new', 'the path has the new text');
  assert.equal(await reader.readFile('utf8'), 'old', 'the reader keeps the old file, whole');
  assert.equal(tmps.length, 1, 'onTmp was told the temp file once');
  assert.match(path.basename(tmps[0]), /^state\.json\.tmp-[0-9a-f]{6}$/);
  assert.deepEqual(fs.readdirSync(dir), ['state.json'], 'no temp file is left');
});

test('A2 the same write with the addon switched off is lost after the plain retries', winOnly, async (t) => {
  useAddon(t, null);
  const { dir, target } = scratch(t, 'a2');
  await heldReader(t, dir, target);
  const plain = plainRenames(t);
  await assert.rejects(AJ.atomicWriteTextAsync(target, 'new'), /Could not atomically publish state\.json after Windows rename retries/);
  assert.equal(plain.length, 5, 'five plain renames, all refused');
  assert.equal(fs.readFileSync(target, 'utf8'), 'old', 'the write is lost');
  assert.deepEqual(fs.readdirSync(dir), ['state.json'], 'the temp file is removed');
});

test('A3 writeFileBehind publishes while a reader holds the target open', winOnly, async (t) => {
  useAddon(t, undefined);
  const { dir, target } = scratch(t, 'a3');
  const reader = await heldReader(t, dir, target);
  const plain = plainRenames(t);
  assert.equal(await WB.writeFileBehind(target, 'behind'), 'published');
  assert.deepEqual(plain, [], 'no plain rename');
  assert.equal(fs.readFileSync(target, 'utf8'), 'behind');
  assert.equal(await reader.readFile('utf8'), 'old');
  assert.deepEqual(fs.readdirSync(dir), ['state.json']);
});

/**
 * Block every libuv pool thread on a pipe read that only this thread can end. Returns release().
 * A stat queued behind them proves the pool is full: it cannot finish until release.
 */
async function blockPool(t) {
  const size = Number(process.env.UV_THREADPOOL_SIZE) || 4;
  const name = `\\\\.\\pipe\\guppy-asyncrename-${process.pid}-${Date.now()}`;
  const socks = [];
  const server = net.createServer((s) => socks.push(s));
  await new Promise((r) => server.listen(name, r));
  const ends = [];
  for (let i = 0; i < size; i++) ends.push(await fsp.open(name, 'r+'));
  for (let i = 0; i < 400 && socks.length < size; i++) await sleep(5);
  assert.equal(socks.length, size, 'one pipe per pool thread');
  const reads = ends.map((fh) => fh.read(Buffer.alloc(1), 0, 1, null));
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    for (const s of socks) s.write('x');
    await Promise.all(reads);
    for (const fh of ends) await fh.close();
    for (const s of socks) s.destroy();
    await new Promise((r) => server.close(r));
  };
  t.after(release);
  let statDone = false;
  const stat = fsp.stat(__filename).then(() => { statDone = true; });
  await sleep(150);
  assert.equal(statDone, false, 'THE POOL IS FULL: a stat queued behind the blocked reads has not run');
  return { release, stat, statDone: () => statDone };
}

test('A4 the rename runs on a pool thread: the call returns at once, and nothing happens on the main thread', winOnly, async (t) => {
  const addon = realAddon();
  assert.equal(typeof addon.posixRenameAsync, 'function', 'the addon exports posixRenameAsync');
  const { dir, target } = scratch(t, 'a4');
  const src = path.join(dir, 'state.json.tmp-aaaaaa');
  fs.writeFileSync(src, 'new');
  const pool = await blockPool(t);

  let settled = false;
  const pending = addon.posixRenameAsync(src, target).then(() => { settled = true; });
  assert.ok(pending instanceof Promise, 'a promise comes back');
  assert.equal(fs.readFileSync(target, 'utf8'), 'old', 'NOT RENAMED IN THE CALL: the target is unchanged when the call returns');
  let turns = 0;
  const ticker = setInterval(() => { turns++; }, 10);
  await sleep(300);
  clearInterval(ticker);
  assert.equal(settled, false, 'the rename waits for a pool thread');
  assert.equal(fs.readFileSync(target, 'utf8'), 'old', 'and still has not run on the main thread');
  assert.ok(fs.existsSync(src), 'the source is still in place');
  assert.ok(turns >= 10, `THE MAIN THREAD KEEPS TURNING while the rename waits (${turns} timer turns in 300 ms)`);

  await pool.release();
  await pending;
  await pool.stat;
  assert.equal(fs.readFileSync(target, 'utf8'), 'new', 'released: the rename lands');
  assert.deepEqual(fs.readdirSync(dir), ['state.json']);
});

test('A5 fallback: a rejected posixRenameAsync falls back to the plain rename, and the sync posixRename is never called', async (t) => {
  const calls = { sync: 0, async: [] };
  useAddon(t, {
    posixRename() { calls.sync++; },
    posixRenameAsync(src, dst) { calls.async.push([src, dst]); return Promise.reject(Object.assign(new Error('refused'), { errno: 1 })); }
  });
  const { dir, target } = scratch(t, 'a5');
  const plain = plainRenames(t);
  assert.equal(await AJ.atomicWriteTextAsync(target, 'new'), true);
  assert.equal(calls.async.length, 1, 'the addon rename was tried once');
  assert.match(calls.async[0][0], /state\.json\.tmp-[0-9a-f]{6}$/);
  assert.equal(calls.async[0][1], path.resolve(target), 'with absolute paths');
  assert.ok(path.isAbsolute(calls.async[0][0]));
  assert.deepEqual(plain, ['state.json'], 'THE PLAIN RENAME IS THE FALLBACK');
  assert.equal(calls.sync, 0, 'THE SYNC RENAME IS NEVER CALLED ON THE ASYNC PATH');
  assert.equal(fs.readFileSync(target, 'utf8'), 'new');
  assert.deepEqual(fs.readdirSync(dir), ['state.json']);
});

test('A5 fallback: a posixRenameAsync that throws at the call also falls back', async (t) => {
  useAddon(t, { posixRename() { assert.fail('the sync rename was called'); }, posixRenameAsync() { throw new Error('bad arguments'); } });
  const { target } = scratch(t, 'a5t');
  const plain = plainRenames(t);
  assert.equal(await AJ.atomicWriteTextAsync(target, 'new'), true);
  assert.deepEqual(plain, ['state.json']);
  assert.equal(fs.readFileSync(target, 'utf8'), 'new');
});

test('A5 fallback: an addon without posixRenameAsync (or no addon) uses the plain rename only', async (t) => {
  let sync = 0;
  useAddon(t, { posixRename() { sync++; } });
  const { target } = scratch(t, 'a5n');
  const plain = plainRenames(t);
  assert.equal(await AJ.atomicWriteTextAsync(target, 'one'), true);
  AJ.__setRenameAddonForTest(null);
  assert.equal(await AJ.atomicWriteTextAsync(target, 'two'), true);
  assert.deepEqual(plain, ['state.json', 'state.json']);
  assert.equal(sync, 0, 'the sync rename is never called on the async path');
  assert.equal(fs.readFileSync(target, 'utf8'), 'two');
});

test('A5 a resolved posixRenameAsync is the whole publish: no plain rename follows', async (t) => {
  const real = fsp.rename;
  let viaAddon = 0;
  useAddon(t, { posixRename() { assert.fail('the sync rename was called'); }, posixRenameAsync(src, dst) { viaAddon++; return real(src, dst); } });
  const { dir, target } = scratch(t, 'a5r');
  const plain = plainRenames(t);
  assert.equal(await AJ.atomicWriteTextAsync(target, 'new'), true);
  assert.equal(viaAddon, 1);
  assert.deepEqual(plain, [], 'no plain rename after the addon rename');
  assert.equal(fs.readFileSync(target, 'utf8'), 'new');
  assert.deepEqual(fs.readdirSync(dir), ['state.json']);
});

test('A6 commit false withdraws before the addon rename is called', async (t) => {
  let viaAddon = 0;
  useAddon(t, { posixRename() {}, posixRenameAsync() { viaAddon++; return Promise.resolve(); } });
  const { dir, target } = scratch(t, 'a6');
  const plain = plainRenames(t);
  assert.equal(await AJ.atomicWriteTextAsync(target, 'new', () => false), false, 'withdrawn');
  assert.equal(viaAddon, 0, 'THE COMMIT IS ASKED BEFORE THE ADDON RENAME');
  assert.deepEqual(plain, []);
  assert.equal(fs.readFileSync(target, 'utf8'), 'old');
  assert.deepEqual(fs.readdirSync(dir), ['state.json'], 'the temp file is removed');
});

test('A6 commit is asked again before the fallback: a newer write during the failed addon rename wins', async (t) => {
  let newest = true;
  let asked = 0;
  const { dir, target } = scratch(t, 'a6b');
  useAddon(t, {
    posixRename() {},
    posixRenameAsync() { fs.writeFileSync(target, 'quit'); newest = false; return Promise.reject(new Error('refused')); }
  });
  const plain = plainRenames(t);
  assert.equal(await AJ.atomicWriteTextAsync(target, 'older', () => { asked++; return newest; }), false, 'withdrawn');
  assert.equal(asked, 2, 'asked before the addon rename and before the fallback');
  assert.deepEqual(plain, [], 'THE FALLBACK DOES NOT PUBLISH THE OLDER TEXT');
  assert.equal(fs.readFileSync(target, 'utf8'), 'quit');
  assert.deepEqual(fs.readdirSync(dir), ['state.json']);
});

test('A7 the addon rejects with the Win32 code as errno, and bad arguments throw at the call', winOnly, async (t) => {
  const addon = realAddon();
  const { dir, target } = scratch(t, 'a7');
  await assert.rejects(addon.posixRenameAsync(path.join(dir, 'missing.tmp'), target), (e) => {
    assert.match(e.message, /posixRename: the source could not be opened/);
    assert.equal(e.errno, 2, 'ERROR_FILE_NOT_FOUND');
    return true;
  });
  assert.equal(fs.readFileSync(target, 'utf8'), 'old');
  assert.throws(() => addon.posixRenameAsync(target), /both paths required/);
  assert.throws(() => addon.posixRenameAsync('', target), /paths must be non-empty strings/);
  // The sync call keeps its errors.
  assert.throws(() => addon.posixRename(path.join(dir, 'missing.tmp'), target), (e) => e.errno === 2 && /the source could not be opened/.test(e.message));
});
