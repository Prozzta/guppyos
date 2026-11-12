'use strict';
require('./tools/own-job.cjs');
/*
 * ELECTRON-FUSES (1.1.105): the packaged binary's fuses (build/electronFuses.cjs, flipped in afterPack).
 *  - the state per build: a normal build and the layer-(b) seams build differ only in
 *    EnableNodeCliInspectArguments (on only for the seams build, never for a trial build);
 *  - flipping a REAL Electron binary (a copy of node_modules/electron's) and reading it back with
 *    @electron/fuses gives exactly that state, for both variants;
 *  - a built dist/win-unpacked (or GUPPY_FUSES_EXE) is read back the same way when it exists.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const F = require('../build/electronFuses.cjs');
const { getCurrentFuseWire, FuseV1Options } = require('@electron/fuses');
// @electron/fuses 1.8.0 keeps FuseState internal: a fuse byte is '1' (on) or '0' (off).
const ON = 0x31;
const OFF = 0x30;
// Electron 45's wire has 9 fuses; index 8 (WasmTrapHandlers) is newer than @electron/fuses 1.8.0
// (only the ESM-only, Node 22 2.x knows it), so it is never set and keeps Electron's default: on.
const WIRE_LENGTH = 9;
const WASM_TRAP_HANDLERS = 8;

const NORMAL = {
  RunAsNode: true,
  EnableNodeOptionsEnvironmentVariable: true,
  EnableNodeCliInspectArguments: false,
  GrantFileProtocolExtraPrivileges: true,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  LoadBrowserProcessSpecificV8Snapshot: false,
  EnableCookieEncryption: false
};
const SEAMS = { ...NORMAL, EnableNodeCliInspectArguments: true };

/** The fuses of a binary as { name: true|false }, every V1 fuse the binary has. */
async function readFuses(exe) {
  const wire = await getCurrentFuseWire(exe);
  assert.equal(wire.version, '1');
  assert.equal(Object.keys(wire).filter((k) => k !== 'version').length, WIRE_LENGTH, 'an Electron with more fuses: review build/electronFuses.cjs');
  assert.equal(wire[WASM_TRAP_HANDLERS], ON, 'WasmTrapHandlers keeps its default (on)');
  const out = {};
  for (const [name, idx] of Object.entries(FuseV1Options)) {
    if (typeof idx !== 'number') continue;
    assert.ok(wire[idx] === ON || wire[idx] === OFF, `${name} is neither on nor off (${wire[idx]})`);
    out[name] = wire[idx] === ON;
  }
  return out;
}

test('fuse state: a normal build, the layer-(b) seams build, and a trial build', () => {
  assert.deepEqual(F.fuseState({}), NORMAL);
  assert.deepEqual(F.fuseState({ MUNDER_LAYERB_SEAMS: '1' }), SEAMS);
  assert.deepEqual(F.fuseState({ MUNDER_LAYERB_SEAMS: '1', GUPPY_TRIAL_BUILD: '1' }), NORMAL);
  assert.deepEqual(F.fuseState({ MUNDER_LAYERB_SEAMS: 'true' }), NORMAL);
  // Every fuse this @electron/fuses knows is set explicitly, none left at the binary's default.
  const known = Object.keys(FuseV1Options).filter((k) => typeof FuseV1Options[k] === 'number');
  assert.deepEqual(Object.keys(NORMAL).sort(), known.sort());
});

test('the seams rule is the one electron.vite.config.ts compiles the seams in by', () => {
  const vite = fs.readFileSync(path.join(ROOT, 'electron.vite.config.ts'), 'utf8');
  assert.match(vite, /__LAYERB_SEAMS__: JSON\.stringify\(process\.env\.GUPPY_TRIAL_BUILD !== '1' && process\.env\.MUNDER_LAYERB_SEAMS === '1'\)/);
  // ...and layer-(b) still drives the packaged main process over --inspect (why the seams build keeps it).
  assert.match(fs.readFileSync(path.join(ROOT, 'test', 'tools', 'layer-b-core.cjs'), 'utf8'), /`--inspect=127\.0\.0\.1:\$\{inspPort\}`/);
});

test('afterPack flips the fuses, before the prune can return early', () => {
  const src = fs.readFileSync(path.join(ROOT, 'build', 'afterPack-memory-prune.cjs'), 'utf8');
  const call = src.indexOf('await flipElectronFuses(context);');
  assert.ok(call > src.indexOf('exports.default = async function afterPack(context) {'));
  assert.ok(call < src.indexOf('if (!fs.existsSync(bin)) return;'));
  assert.equal(require(path.join(ROOT, 'package.json')).devDependencies['@electron/fuses'], '1.8.0', 'pinned exactly');
});

test('executablePath per platform', () => {
  const ctx = (p) => ({ electronPlatformName: p, appOutDir: 'OUT', packager: { appInfo: { productFilename: 'Guppy' }, executableName: 'guppy' } });
  assert.equal(F.executablePath(ctx('win32')), path.join('OUT', 'Guppy.exe'));
  assert.equal(F.executablePath(ctx('darwin')), path.join('OUT', 'Guppy.app'));
  assert.equal(F.executablePath(ctx('linux')), path.join('OUT', 'guppy'));
});

// A real Electron binary, flipped and read back. On Windows the fuse wire is in electron.exe.
const ELECTRON = require('electron');
for (const [label, env, want] of [['normal build', {}, NORMAL], ['layer-(b) seams build', { MUNDER_LAYERB_SEAMS: '1' }, SEAMS]]) {
  test(`a real Electron binary flipped as a ${label} reads back exactly that state`, { skip: process.platform !== 'win32' && 'the copy below is the Windows layout' }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guppy-fuses-'));
    try {
      fs.copyFileSync(ELECTRON, path.join(dir, 'Guppy.exe'));
      const before = await readFuses(path.join(dir, 'Guppy.exe'));
      assert.equal(before.RunAsNode, true, 'a stock Electron has RunAsNode on');
      assert.equal(before.EnableNodeCliInspectArguments, true, 'a stock Electron has CLI inspect on');
      await F.flipElectronFuses({ electronPlatformName: 'win32', appOutDir: dir, packager: { appInfo: { productFilename: 'Guppy' } } }, env);
      assert.deepEqual(await readFuses(path.join(dir, 'Guppy.exe')), want);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

// The built binary, when there is one: GUPPY_FUSES_EXE, or dist/win-unpacked/Guppy.exe.
const BUILT = process.env.GUPPY_FUSES_EXE || path.join(ROOT, 'dist', 'win-unpacked', 'Guppy.exe');
test('the built binary carries the fuse state of its build', { skip: !fs.existsSync(BUILT) && `no built binary at ${BUILT}` }, async () => {
  const want = process.env.GUPPY_FUSES_SEAMS === '1' ? SEAMS : NORMAL;
  assert.deepEqual(await readFuses(BUILT), want);
});
