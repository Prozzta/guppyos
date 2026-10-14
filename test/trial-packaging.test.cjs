'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('trial packaging is cross-shell, portable-only, and cannot inherit release identities', () => {
  const pkg = JSON.parse(read('package.json'));
  const builder = read('electron-builder.trial.yml');
  const launcher = read('tools/build-trial.cjs');
  assert.equal(pkg.scripts['dist:trial'], 'node tools/build-trial.cjs');
  assert.match(launcher, /GUPPY_TRIAL_BUILD:\s*'1'/);
  assert.doesNotMatch(launcher, /\bset\s+GUPPY_TRIAL_BUILD/i);
  assert.match(builder, /^beforePack: build\/assert-trial-bundle\.cjs$/m);
  assert.match(builder, /^afterAllArtifactBuild: null$/m);
  assert.match(builder, /^executableName: Guppy-1\.1\.85-Trial$/m);
  assert.match(builder, /^artifactName: Guppy-1\.1\.85-Trial-\$\{version\}-win-\$\{arch\}-portable\.\$\{ext\}$/m);
  assert.match(builder, /^\s+- target: portable$/m);
  assert.doesNotMatch(builder, /^\s+- target: nsis$/m);
  assert.match(builder, /^nsis:\s*\r?\n\s+include: null\s*\r?\n\s+shortcutName: Guppy 1\.1\.85 Trial$/m);
  assert.match(builder, /^portable:\s*\r?\n\s+artifactName: Guppy-1\.1\.85-Trial-\$\{version\}-win-\$\{arch\}-portable\.\$\{ext\}$/m);
});

test('trial launcher never spawns a .cmd without a shell', () => {
  const { buildTrial } = require(path.join(ROOT, 'tools', 'build-trial.cjs'));
  const calls = [];
  buildTrial({
    env: { npm_execpath: path.join(ROOT, 'node_modules', 'npm', 'bin', 'npm-cli.js') },
    spawn(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0 };
    }
  });
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.doesNotMatch(call.command, /\.cmd$/i, 'a Windows .cmd must not be spawned without shell:true');
    assert.equal(call.options.shell, undefined);
  }
  assert.equal(calls[0].command, process.execPath);
  assert.match(calls[0].args[0], /npm-cli\.js$/i);
  assert.deepEqual(calls[0].args.slice(1), ['run', 'build']);
  assert.deepEqual(calls[1].args.slice(-2), ['--publish', 'never']);
});

test('trial bundle assertion refuses a release-shaped or missing main bundle', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guppy-trial-assert-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const main = path.join(root, 'out', 'main');
  const trialAssert = require(path.join(ROOT, 'build', 'assert-trial-bundle.cjs'));
  const { assertTrialBundle, default: beforePack } = trialAssert;
  assert.throws(() => assertTrialBundle(root), /main bundle is missing/);
  assert.throws(() => beforePack({ packager: { info: { projectDir: root } } }), /main bundle is missing/, 'beforePack default export must enforce the assertion');
  fs.mkdirSync(main, { recursive: true });
  const bundle = path.join(main, 'index.js');
  fs.writeFileSync(bundle, 'const FORCE_DEV_BUILD = false; // GuppyTrialData');
  assert.throws(() => assertTrialBundle(root), /does not prove __FORCE_DEV__ compiled true/);
  fs.writeFileSync(bundle, 'const FORCE_DEV_BUILD = __FORCE_DEV__; // GuppyTrialData');
  assert.throws(() => assertTrialBundle(root), /does not prove __FORCE_DEV__ compiled true/, 'an unsubstituted define is not proof');
  fs.writeFileSync(bundle, "const FORCE_DEV_BUILD = typeof true !== 'undefined' && true === true;");
  assert.throws(() => assertTrialBundle(root), /lacks the fixed GuppyTrialData root/, 'the trial root is mandatory');
  fs.writeFileSync(bundle, "const FORCE_DEV_BUILD = typeof true !== 'undefined' && true === true; const root = 'GuppyTrialData';");
  assert.doesNotThrow(() => assertTrialBundle(root));
  assert.doesNotThrow(() => beforePack({ packager: { info: { projectDir: root } } }));
});

test('G2 and G4 behave as refusals when DEV is forced under an Electron stub', () => {
  const oldDev = process.env.MUNDER_DEV;
  process.env.MUNDER_DEV = '1';
  const electron = require.resolve('electron');
  const updaterPackage = require.resolve('electron-updater');
  const savedElectron = require.cache[electron];
  const savedUpdater = require.cache[updaterPackage];
  const handlers = new Map();
  let updaterTouches = 0;
  let loginWrites = 0;
  try {
    require.cache[electron] = {
      id: electron,
      filename: electron,
      loaded: true,
      exports: {
        app: {
          isPackaged: true,
          getPath: () => os.tmpdir(),
          getVersion: () => '1.1.85',
          setLoginItemSettings: () => { loginWrites += 1; },
          getLoginItemSettings: () => ({ openAtLogin: true })
        },
        ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
        shell: { openExternal: () => { throw new Error('openExternal must not run under DEV'); } }
      }
    };
    const updaterExports = {};
    Object.defineProperty(updaterExports, 'autoUpdater', { get: () => { updaterTouches += 1; throw new Error('native updater must not load'); } });
    require.cache[updaterPackage] = { id: updaterPackage, filename: updaterPackage, loaded: true, exports: updaterExports };
    const updater = loadTs('src/main/updater.ts');
    const loginItem = loadTs('src/main/loginItem.ts');
    updater.initAutoUpdater(() => { throw new Error('web contents must not be queried under DEV'); });
    for (const name of ['update:restartAndInstall', 'update:checkNow', 'update:download', 'update:simulate', 'update:openRelease']) {
      assert.deepEqual(handlers.get(name)(), { ok: false, error: 'dev isolation — updates are disabled' }, name);
    }
    assert.deepEqual(handlers.get('update:current')(), { state: 'idle' });
    assert.equal(updaterTouches, 0, 'DEV must not load electron-updater');
    assert.equal(loginItem.setLoginItem(true), false);
    assert.equal(loginWrites, 0, 'DEV must not write a login item');
  } finally {
    if (oldDev === undefined) delete process.env.MUNDER_DEV; else process.env.MUNDER_DEV = oldDev;
    if (savedElectron === undefined) delete require.cache[electron]; else require.cache[electron] = savedElectron;
    if (savedUpdater === undefined) delete require.cache[updaterPackage]; else require.cache[updaterPackage] = savedUpdater;
  }
});
