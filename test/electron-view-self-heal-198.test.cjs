'use strict';
/**
 * ELECTRON-VIEW-SELF-HEAL: the shared Electron view (electron-bin.cjs swiftShaderView) is ready only when
 * its .complete marker AND its executable are there. On 2026-10-21 the view lost electron.exe alone, kept
 * .complete, and was never rebuilt: every Electron test on the machine failed ENOENT. A view missing either
 * is rebuilt into a fresh part folder and swapped in; a ready view is used as it is.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { swiftShaderView } = require('./electron-harness/electron-bin.cjs');

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
    assert.equal(readFileSync(join(view, 'SwiftShader.ini'), 'utf8'), '[Processor]\nAffinityMask=65535\n');
    assert.equal(readFileSync(join(view, 'locales', 'en-US.pak'), 'utf8'), 'pak');
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
