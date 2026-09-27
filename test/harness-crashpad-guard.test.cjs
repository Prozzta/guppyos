'use strict';
/**
 * HARNESS-CRASHPAD guard. Every Electron MAIN a test launches must keep userData, sessionData,
 * crashDumps (and appData, logs) inside its own sandbox, through
 * test/electron-harness/isolate-paths.cjs, BEFORE anything can resolve or use a default path.
 *
 * Why: from 1.1.65 to 1.1.67 the harness mains that crash a renderer on purpose left their Crashpad
 * dumps in the LIVE app's %APPDATA%/munder-difflin/Crashpad (recovery-main set no crashDumps;
 * quit-sweep-main set no path at all), and the app's startup prune (3 kept) then deleted real
 * crash evidence to make room for test dumps.
 *
 * A new Electron main that does not call isolateAppPaths fails here, by name.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TEST_DIR = __dirname;
const { isolateAppPaths, inside } = require('./electron-harness/isolate-paths.cjs');

/** Every .cjs under test/ (node_modules and fixtures' output skipped). */
function allCjs(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) allCjs(p, out);
    else if (e.name.endsWith('.cjs')) out.push(p);
  }
  return out;
}

/** An Electron MAIN: it takes `app` from require('electron'). (A test runner gets only the binary
 *  path from require('electron'); a preload or renderer never gets `app`.) */
const ELECTRON_APP = /const\s*\{[^}]*\bapp\b[^}]*\}\s*=\s*require\(\s*['"]electron['"]\s*\)/;
const mains = allCjs(TEST_DIR).filter((f) => ELECTRON_APP.test(fs.readFileSync(f, 'utf8')));
const rel = (f) => path.relative(TEST_DIR, f).replace(/\\/g, '/');

/** Uses that need the paths already isolated (the first one must come after isolateAppPaths). */
const FIRST_USES = [/app\.whenReady\(/, /app\.on\(\s*['"]ready['"]/, /crashReporter\.start\(/, /new BrowserWindow\(/, /app\.getPath\(/, /app\.requestSingleInstanceLock\(/];

test('the Electron test mains are found (the guard is not vacuous)', () => {
  const names = mains.map(rel).sort();
  for (const known of ['electron-harness/recovery-main.cjs', 'electron-harness/memory-recovery-main.cjs', 'electron-harness/crash-dump-main.cjs',
    'electron-harness/pty-quit-main.cjs', 'electron-harness/harness-main.cjs', 'electron-harness/ipc-order-main.cjs', 'fixtures/quit-sweep-main.cjs']) {
    assert.ok(names.includes(known), `${known} is an Electron main and must be checked (found: ${names.join(', ')})`);
  }
});

for (const f of mains) {
  test(`${rel(f)}: isolates every app path in its sandbox before first use (HARNESS-CRASHPAD)`, () => {
    const src = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
    assert.match(src, /require\(\s*['"][./]*(electron-harness\/)?isolate-paths\.cjs['"]\s*\)/, 'requires isolate-paths.cjs');
    const call = src.search(/\bisolateAppPaths\(\s*app\s*,/);
    assert.ok(call >= 0, 'calls isolateAppPaths(app, <sandbox>)');
    for (const re of FIRST_USES) {
      const at = src.search(re);
      if (at >= 0) assert.ok(call < at, `isolateAppPaths must come before ${re} (a default path could be resolved first)`);
    }
    // setPath('crashDumps') alone does not redirect a running Crashpad: the reporter must be started
    // on it, by the helper (the default) or by the main itself when it opts out.
    if (/isolateAppPaths\([^)]*reporter:\s*false/.test(src)) {
      assert.match(src, /crashReporter\.start\(|startLocalCrashReporter\(/, 'reporter: false, but the main never starts its own reporter');
    }
    // No path is set around the helper: a later setPath could point outside the sandbox again.
    assert.doesNotMatch(src, /app\.setPath\(\s*['"](userData|sessionData|crashDumps|appData|logs)['"]/, 'no direct app.setPath of a sandboxed path');
  });
}

// ── the helper itself (a fake app; no Electron) ─────────────────────────────────────────────────

function fakeApp(override = {}) {
  const set = {};
  return { set, setPath: (k, v) => { set[k] = v; }, getPath: (k) => override[k] ?? set[k] };
}
function withExitTrap(fn) {
  const real = process.exit; const realErr = process.stderr.write;
  let code = null;
  process.exit = (c) => { code = c; throw new Error(`exit ${c}`); };
  process.stderr.write = () => true;
  try { fn(); } catch (e) { if (!/^exit /.test(e.message)) throw e; } finally { process.exit = real; process.stderr.write = realErr; }
  return code;
}

test('isolateAppPaths points userData, sessionData, crashDumps, appData and logs inside the sandbox', (t) => {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-guard-'));
  t.after(() => fs.rmSync(sb, { recursive: true, force: true }));
  const app = fakeApp();
  const paths = isolateAppPaths(app, sb, { reporter: false });
  assert.deepEqual(Object.keys(app.set).sort(), ['appData', 'crashDumps', 'logs', 'sessionData', 'userData']);
  for (const [k, v] of Object.entries(app.set)) assert.ok(inside(v, sb), `${k}=${v} inside ${sb}`);
  assert.ok(fs.existsSync(paths.crashDumps), 'the crashDumps folder exists (Crashpad writes into it)');
});

test('isolateAppPaths refuses to run (exit 2) without a sandbox, or when a path resolves outside it', (t) => {
  assert.equal(withExitTrap(() => isolateAppPaths(fakeApp(), undefined, { reporter: false })), 2, 'no sandbox');
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-guard-'));
  t.after(() => fs.rmSync(sb, { recursive: true, force: true }));
  const live = path.join(os.tmpdir(), 'munder-difflin', 'Crashpad');
  assert.equal(withExitTrap(() => isolateAppPaths(fakeApp({ crashDumps: live }), sb, { reporter: false })), 2, 'crashDumps outside');
});

test('inside(): a sibling with the same prefix is not inside', () => {
  assert.equal(inside('/a/sandbox/x', '/a/sandbox'), true);
  assert.equal(inside('/a/sandbox', '/a/sandbox'), true);
  assert.equal(inside('/a/sandbox-other/x', '/a/sandbox'), false);
  assert.equal(inside('/a/other', '/a/sandbox'), false);
});
