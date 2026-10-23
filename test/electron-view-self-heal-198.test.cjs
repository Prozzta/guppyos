'use strict';
/**
 * ELECTRON-VIEW-SELF-HEAL: the shared Electron view (electron-bin.cjs swiftShaderView) is ready only when
 * its .complete marker AND every top-level name of its dist are there. On 2026-10-21 the view lost
 * electron.exe alone, kept .complete, and was never rebuilt: every Electron test on the machine failed
 * ENOENT. A view missing any of them is rebuilt into a fresh part folder and swapped in; a ready view is
 * used as it is.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { cappedHeavyJob, halfCpuMask, swiftShaderMaskForHeavyJob, swiftShaderView } = require('./electron-harness/electron-bin.cjs');

function fakeDist(dir) {
  const dist = join(dir, 'dist');
  mkdirSync(join(dist, 'locales'), { recursive: true });
  writeFileSync(join(dist, 'electron.exe'), 'exe');
  writeFileSync(join(dist, 'v8_context_snapshot.bin'), 'snap');
  writeFileSync(join(dist, 'locales', 'en-US.pak'), 'pak');
  return join(dist, 'electron.exe');
}

function withTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'evsh-'));
  try { fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('a view that lost its executable but kept .complete is rebuilt, at the same path, with nothing left beside it', () => {
  withTemp((dir) => {
    const src = fakeDist(dir);
    const tmp = join(dir, 'tmp');
    const exe = swiftShaderView(src, 0xffffn, tmp);
    const view = join(exe, '..');
    unlinkSync(exe);
    assert.ok(existsSync(join(view, '.complete')), 'the 2026-10-21 shape: marker kept, exe gone');
    assert.equal(swiftShaderView(src, 0xffffn, tmp), exe, 'the same view path');
    assert.equal(readFileSync(exe, 'utf8'), 'exe', 'the executable is back');
    if (process.platform === 'win32') assert.equal(statSync(exe).nlink, 2, 'a hard link to the dist, not a copy');
    assert.equal(existsSync(join(view, 'SwiftShader.ini')), true, 'the supplied capped mask writes an affinity view');
    assert.equal(readFileSync(join(view, 'locales', 'en-US.pak'), 'utf8'), 'pak');
    assert.deepEqual(readdirSync(join(tmp, 'guppy-electron-view')), [view.split(/[\\/]/).pop()], 'no part or stale folder left');
  });
});

test('a capped job uses a SwiftShader view no wider than its CPU share; an uncapped job remains plain', () => {
  withTemp((dir) => {
    const src = fakeDist(dir);
    const tmp = join(dir, 'tmp');
    assert.equal(cappedHeavyJob({ GUPPY_HEAVY_CPU_CAP: '1' }), true);
    assert.equal(cappedHeavyJob({ GUPPY_HEAVY_CPU_CAP: '0' }), false);
    const mask = swiftShaderMaskForHeavyJob({ GUPPY_HEAVY_CPU_CAP: '1' }, 8);
    assert.equal(mask, 15n, 'four processors in the capped view');
    assert.equal(swiftShaderMaskForHeavyJob({ GUPPY_HEAVY_CPU_CAP: '0' }, 8), null, 'uncapped is c1e8c5e7 plain behavior');
    const capped = swiftShaderView(src, mask, tmp);
    assert.match(readFileSync(join(capped, '..', 'SwiftShader.ini'), 'utf8'), /AffinityMask=15/);
    const plain = swiftShaderView(src, null, tmp);
    assert.equal(existsSync(join(plain, '..', 'SwiftShader.ini')), false);
  });
});

test('a view that lost another top-level file of the dist (a DLL, a .pak, the snapshot) is rebuilt too (Jim NIT 1)', () => {
  withTemp((dir) => {
    const src = fakeDist(dir);
    const tmp = join(dir, 'tmp');
    const exe = swiftShaderView(src, 0xffffn, tmp);
    const view = join(exe, '..');
    unlinkSync(join(view, 'v8_context_snapshot.bin'));
    assert.equal(swiftShaderView(src, 0xffffn, tmp), exe);
    assert.equal(readFileSync(join(view, 'v8_context_snapshot.bin'), 'utf8'), 'snap', 'the lost file is back');
    assert.deepEqual(readdirSync(join(tmp, 'guppy-electron-view')), [view.split(/[\\/]/).pop()], 'no part or stale folder left');
  });
});

test('a view without its .complete marker is rebuilt too', () => {
  withTemp((dir) => {
    const src = fakeDist(dir);
    const tmp = join(dir, 'tmp');
    const exe = swiftShaderView(src, 0xffffn, tmp);
    const view = join(exe, '..');
    unlinkSync(join(view, '.complete'));
    writeFileSync(join(view, 'half-built'), '');
    assert.equal(swiftShaderView(src, 0xffffn, tmp), exe);
    assert.ok(existsSync(join(view, '.complete')));
    assert.ok(!existsSync(join(view, 'half-built')), 'the old folder was replaced, not patched');
  });
});

test('a ready view (marker and executable) is used as it is, not rebuilt', () => {
  withTemp((dir) => {
    const src = fakeDist(dir);
    const tmp = join(dir, 'tmp');
    const exe = swiftShaderView(src, 0xffffn, tmp);
    const view = join(exe, '..');
    writeFileSync(join(view, 'sentinel'), '');
    assert.equal(swiftShaderView(src, 0xffffn, tmp), exe);
    assert.ok(existsSync(join(view, 'sentinel')), 'the view was kept');
  });
});
