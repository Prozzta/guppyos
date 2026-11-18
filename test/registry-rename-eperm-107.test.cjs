'use strict';
require('./tools/own-job.cjs');

/**
 * REGISTRY-RENAME-EPERM-107. LAG-SYNC-IO-107's async authority refresh reads registry.json with
 * fs.promises.readFile, which holds the file open across several main-thread turns. A sync
 * atomicWriteJson landing inside that window got EPERM from the plain Windows rename, and
 * renameWithRetry's sleepSync blocked the very thread the reader needed to close, so every retry
 * failed and setArchived swallowed the error: the write was lost (mail-rig-faults F9b).
 *
 *   R1  with a REAL in-flight readFile of the target (proved open: a plain rename over it fails
 *       with EPERM), atomicWriteJson still publishes. The reader gets the old file whole, and the
 *       path has the new one. Without the POSIX rename it throws.
 *   R2  with the POSIX rename unavailable, the fallback fails fast when the holder is this
 *       process's own tracked read; it does not sleep through the retries.
 *   R3  hive's async authority reads are tracked reads (the R2 guard sees them).
 *   R0  the held-open probe never shrinks the target. readFile opens on the libuv pool, so under
 *       load a probe rename can land before the open. A tiny probe body then became the file the
 *       reader opened, the read settled in one chunk, and the probe never saw EPERM (R2 red once
 *       in a full suite: "the reader must be holding the file open"). The probe body is the old
 *       file's own bytes (copied from a kept original), so a probe that lands first leaves the reader
 *       the same big file.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const AJ = loadTs('src/main/atomicJson.ts');
const win = process.platform === 'win32';
const crypto = require('node:crypto');
const turn = () => new Promise((r) => setImmediate(r));

function bigTarget(t, tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `guppy-regeperm-${tag}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'registry.json');
  // Large enough that readFile spans many turns (it reads in 512 KiB chunks).
  const old = Buffer.from(JSON.stringify({ v: 'old', pad: 'x'.repeat(24 << 20) }));
  fs.writeFileSync(target, old);
  // The probe body: the old bytes, copied per probe (one CopyFile call, no 24 MB write from JS).
  const orig = path.join(dir, 'orig.json');
  fs.writeFileSync(orig, old);
  return { dir, target, old, orig };
}

/**
 * Turn the loop until a plain rename over `target` fails with EPERM, i.e. the reader has it open.
 * A probe that lands before the reader's open replaces the target, so its body is the target's own
 * old bytes (a copy of `orig`): the reader then still opens the same big file (R0).
 * `stats.landed` counts those.
 */
async function untilHeldOpen(dir, target, reading, orig, stats = {}) {
  let settled = false;
  reading.then(() => { settled = true; }, () => { settled = true; });
  const probe = path.join(dir, 'probe.tmp');
  stats.landed = 0;
  for (let i = 0; i < 500 && !settled; i++) {
    fs.copyFileSync(orig, probe);
    try { fs.renameSync(probe, target); } catch (e) {
      if (e.code === 'EPERM') { fs.rmSync(probe, { force: true }); return true; }
      throw e;
    }
    stats.landed++;
    await turn();
  }
  return false;
}

/** Occupy every libuv pool thread for about `ms`, so the next fs.promises open queues behind them. */
function busyPool(ms) {
  const n = Number(process.env.UV_THREADPOOL_SIZE) || 4;
  const t0 = process.hrtime.bigint();
  crypto.pbkdf2Sync('k', 's', 20_000, 32, 'sha512');
  const per = Math.max(1, Number(process.hrtime.bigint() - t0) / 1e6);
  const iterations = Math.ceil(20_000 * ms / per);
  return Promise.all(Array.from({ length: n }, () => new Promise((r) => crypto.pbkdf2('k', 's', iterations, 32, 'sha512', r))));
}

/**
 * REGISTRY-EPERM-R0-PRECOND-108: block the main thread for `ms` (it stays off the event loop; the
 * libuv pool keeps running). Under load the main thread is descheduled like this between starting
 * the read and the first probe; the 24 MB probe copy alone can take that long.
 */
function stallMainThread(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

for (const stallMs of [0, 400]) {
  const name = stallMs
    ? `R0 the race is hit even when the main thread stalls ${stallMs} ms after starting the read (as under load)`
    : 'R0 a probe that lands before the reader opens leaves the reader the same big file';
  test(name, { skip: !win && 'Windows rename semantics' }, async (t) => {
    t.after(() => AJ.__setRenameAddonForTest(undefined));
    AJ.__setRenameAddonForTest(null);
    const { dir, target, old, orig } = bigTarget(t, stallMs ? 'r0s' : 'r0');
    const pool = busyPool(150);
    const reading = AJ.readFileTracked(target, 'utf8');
    if (stallMs) stallMainThread(stallMs);
    const stats = {};
    const held = await untilHeldOpen(dir, target, reading, orig, stats);
    assert.ok(stats.landed >= 1, 'the open was delayed past the first probe (the race was hit)');
    assert.equal(held, true, 'the reader must be holding the file open (plain rename EPERM)');
    const seen = await reading;
    assert.equal(seen.length, old.length, 'the reader read the big file, not a probe body');
    await pool;
  });
}

test('R1 a sync atomic write publishes over a real in-flight readFile', { skip: !win && 'Windows rename semantics' }, async (t) => {
  t.after(() => AJ.__setRenameAddonForTest(undefined));
  AJ.__setRenameAddonForTest(undefined);
  const { dir, target, orig } = bigTarget(t, 'r1');
  const reading = AJ.readFileTracked(target, 'utf8');
  assert.equal(await untilHeldOpen(dir, target, reading, orig), true, 'the reader must be holding the file open (plain rename EPERM)');
  AJ.atomicWriteJson(target, { v: 'new' });
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { v: 'new' }, 'the path has the new file');
  const seen = JSON.parse(await reading);
  assert.equal(seen.v, 'old', 'the in-flight reader still gets the old file, whole');
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.tmp')).length, 0, 'no temp left');
});

test('R2 without the POSIX rename, the fallback fails fast against our own in-flight read', { skip: !win && 'Windows rename semantics' }, async (t) => {
  t.after(() => AJ.__setRenameAddonForTest(undefined));
  AJ.__setRenameAddonForTest(null);
  const { dir, target, orig } = bigTarget(t, 'r2');
  const reading = AJ.readFileTracked(target, 'utf8');
  assert.equal(AJ.hasInflightRead(target), true);
  assert.equal(await untilHeldOpen(dir, target, reading, orig), true, 'the reader must be holding the file open (plain rename EPERM)');
  assert.throws(() => AJ.atomicWriteJson(target, { v: 'new' }), /this process's own async read holds it open/);
  assert.equal(JSON.parse(await reading).v, 'old');
  assert.equal(AJ.hasInflightRead(target), false, 'the tracked read is released when it settles');
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.tmp')).length, 0, 'the temp is removed on failure');
});

test('R3 the hive authority async reads go through readFileTracked', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'hive.ts'), 'utf8').replace(/\r\n/g, '\n');
  const fn = (name) => {
    const i = src.indexOf(name);
    assert.ok(i > 0, `${name} not found`);
    const end = src.indexOf('\n  }\n', i);
    assert.ok(end > i, `${name} has no end`);
    return src.slice(i, end);
  };
  for (const name of ['private async readAuthoritativeJsonAsync<T>(', 'private async loadAuthorityAsync(']) {
    const body = fn(name);
    assert.match(body, /await readFileTracked\(p, 'utf8'\)/, `${name} reads through readFileTracked`);
    assert.doesNotMatch(body, /fsPromises\.readFile\(p,/, `${name} has no untracked read of the authority`);
  }
});
