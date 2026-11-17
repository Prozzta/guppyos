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
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const AJ = loadTs('src/main/atomicJson.ts');
const win = process.platform === 'win32';
const turn = () => new Promise((r) => setImmediate(r));

function bigTarget(t, tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `guppy-regeperm-${tag}-`));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'registry.json');
  // Large enough that readFile spans many turns (it reads in 512 KiB chunks).
  const old = JSON.stringify({ v: 'old', pad: 'x'.repeat(24 << 20) });
  fs.writeFileSync(target, old);
  return { dir, target, old };
}

/** Turn the loop until a plain rename over `target` fails with EPERM, i.e. the reader has it open. */
async function untilHeldOpen(dir, target, reading) {
  let settled = false;
  reading.then(() => { settled = true; }, () => { settled = true; });
  const probe = path.join(dir, 'probe.tmp');
  for (let i = 0; i < 500 && !settled; i++) {
    fs.writeFileSync(probe, JSON.stringify({ v: 'old', pad: '' }));
    try { fs.renameSync(probe, target); } catch (e) {
      if (e.code === 'EPERM') { fs.rmSync(probe, { force: true }); return true; }
      throw e;
    }
    await turn();
  }
  return false;
}

test('R1 a sync atomic write publishes over a real in-flight readFile', { skip: !win && 'Windows rename semantics' }, async (t) => {
  t.after(() => AJ.__setRenameAddonForTest(undefined));
  AJ.__setRenameAddonForTest(undefined);
  const { dir, target } = bigTarget(t, 'r1');
  const reading = AJ.readFileTracked(target, 'utf8');
  assert.equal(await untilHeldOpen(dir, target, reading), true, 'the reader must be holding the file open (plain rename EPERM)');
  AJ.atomicWriteJson(target, { v: 'new' });
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { v: 'new' }, 'the path has the new file');
  const seen = JSON.parse(await reading);
  assert.equal(seen.v, 'old', 'the in-flight reader still gets the old file, whole');
  assert.equal(fs.readdirSync(dir).filter((f) => f.includes('.tmp')).length, 0, 'no temp left');
});

test('R2 without the POSIX rename, the fallback fails fast against our own in-flight read', { skip: !win && 'Windows rename semantics' }, async (t) => {
  t.after(() => AJ.__setRenameAddonForTest(undefined));
  AJ.__setRenameAddonForTest(null);
  const { dir, target } = bigTarget(t, 'r2');
  const reading = AJ.readFileTracked(target, 'utf8');
  assert.equal(AJ.hasInflightRead(target), true);
  assert.equal(await untilHeldOpen(dir, target, reading), true, 'the reader must be holding the file open (plain rename EPERM)');
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
