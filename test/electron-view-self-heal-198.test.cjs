'use strict';
require('./tools/own-job.cjs');
// MUTANT-JOURNAL-GATE (god 5cc045/ed8032): this suite loads a file a census mutates in place (one load-ts never sees);
// refuse a tree a killed census left mutated, before anything is read.
require('./tools/mutant-runner-helper.cjs').gate(__filename);
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

function withElectronBinStubs(stubs, fn) {
  const Module = require('node:module');
  const target = require.resolve('./electron-harness/electron-bin.cjs');
  const originalLoad = Module._load;
  const prior = require.cache[target];
  delete require.cache[target];
  Module._load = function (request, parent, isMain) {
    if (request === 'node:child_process') return { execFileSync: stubs.execFileSync };
    if (request === 'node:os' && stubs.os) return stubs.os;
    if (request === 'electron') return stubs.electron;
    if (request.endsWith('/tools/shared-temp.cjs')) return { sharedTemp: () => stubs.tmp };
    return originalLoad.call(this, request, parent, isMain);
  };
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try { return fn(require('./electron-harness/electron-bin.cjs')); }
  finally {
    Object.defineProperty(process, 'platform', platform);
    Module._load = originalLoad;
    delete require.cache[target];
    if (prior) require.cache[target] = prior;
  }
}

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

test('every job uses a bounded SwiftShader view, intersected with a non-contiguous outer affinity', () => {
  withTemp((dir) => {
    const src = fakeDist(dir);
    const tmp = join(dir, 'tmp');
    assert.equal(cappedHeavyJob({ GUPPY_HEAVY_CPU_CAP: '1' }), true);
    assert.equal(cappedHeavyJob({ GUPPY_HEAVY_CPU_CAP: '0' }), false);
    const mask = swiftShaderMaskForHeavyJob({ GUPPY_HEAVY_CPU_CAP: '1' }, 8);
    assert.equal(mask, 15n, 'four processors in the capped view');
    assert.equal(swiftShaderMaskForHeavyJob({ GUPPY_HEAVY_CPU_CAP: '0' }, 8), 15n, 'cap-off remains bounded: a plain view can stall');
    assert.equal(swiftShaderMaskForHeavyJob({ HARNESS_CPU_MASK: '170' }, 8), 10n, 'the half view intersects a non-contiguous outer affinity');
    assert.equal(swiftShaderMaskForHeavyJob({ HARNESS_CPU_MASK: '160' }, 8), 160n, 'when the intersection is empty, retain the outer affinity');
    const capped = swiftShaderView(src, mask, tmp);
    assert.match(readFileSync(join(capped, '..', 'SwiftShader.ini'), 'utf8'), /AffinityMask=15/);
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

test('a complete view with the wrong capped affinity ini is rebuilt (M3)', () => {
  withTemp((dir) => {
    const src = fakeDist(dir); const tmp = join(dir, 'tmp');
    const exe = swiftShaderView(src, 0xfn, tmp); const view = join(exe, '..');
    writeFileSync(join(view, 'SwiftShader.ini'), '[Processor]\nAffinityMask=3\n');
    swiftShaderView(src, 0xfn, tmp);
    assert.equal(readFileSync(join(view, 'SwiftShader.ini'), 'utf8'), '[Processor]\nAffinityMask=15\n');
  });
});

test('dead partial and stale plain views are cleaned, but a live partial is retained (Jim NIT)', () => {
  withTemp((dir) => {
    const src = fakeDist(dir); const tmp = join(dir, 'tmp');
    const root = join(tmp, 'guppy-electron-view'); mkdirSync(root, { recursive: true });
    const version = require('electron/package.json').version;
    swiftShaderView(src, 0xffffn, tmp);
    mkdirSync(join(root, `${version}-plain`));
    mkdirSync(join(root, `${version}-ffff.broken-999999`));
    mkdirSync(join(root, `${version}-ffff.part-999999`));
    mkdirSync(join(root, `${version}-ffff.part-${process.pid}`));
    swiftShaderView(src, 0xffffn, tmp);
    assert.ok(!existsSync(join(root, `${version}-plain`)));
    assert.ok(!existsSync(join(root, `${version}-ffff.broken-999999`)), 'a dead broken attempt is cleaned');
    assert.ok(!existsSync(join(root, `${version}-ffff.part-999999`)));
    assert.ok(existsSync(join(root, `${version}-ffff.part-${process.pid}`)));
  });
});

test('a hanging helper is fail-open, and two unoverridden launches use their live affinity (M6/M7)', () => {
  withTemp((dir) => {
    const exe = fakeDist(dir); const tmp = join(dir, 'tmp'); let affinity = '3'; let logical = 8; const calls = [];
    withElectronBinStubs({ electron: exe, tmp, os: { cpus: () => Array(logical) }, execFileSync(command, args, options) {
      calls.push({ command, args, options });
      if (args[0] === 'self-query') { const error = new Error('hung helper'); error.code = 'ETIMEDOUT'; throw error; }
      return `${affinity} 8`;
    } }, ({ cappedHeavyJob: capped, harnessElectron }) => {
      assert.equal(capped({}), false, 'a helper that does not reply cannot cap an unrelated launch');
      assert.equal(calls[0].options.timeout, 15_000, 'the hanging helper has a bounded wait');
      const first = harnessElectron({});
      affinity = '12';
      const second = harnessElectron({});
      assert.notEqual(first, second, 'a changed process affinity creates a new unoverridden view');
      const affinityCalls = calls.filter((c) => c.command === 'powershell.exe');
      assert.equal(affinityCalls.length, 2, 'each unoverridden launch probes affinity again');
      assert.ok(affinityCalls.every((c) => c.options.timeout === 15_000), 'each hanging affinity probe has a bounded wait');
      logical = 8;
      const cachedFirst = harnessElectron({ HARNESS_CPU_MASK: '255' });
      logical = 16;
      const cachedSameOverride = harnessElectron({ HARNESS_CPU_MASK: '255' });
      const cachedOtherOverride = harnessElectron({ HARNESS_CPU_MASK: '127' });
      assert.equal(cachedSameOverride, cachedFirst, 'the same explicit override keeps its original bounded view');
      assert.notEqual(cachedOtherOverride, cachedFirst, 'different explicit overrides do not share a cache entry');
      assert.ok(existsSync(first) && existsSync(second), 'both live-affinity views are materialized');
    });
  });
});
