'use strict';
/**
 * ZT-I1-MAIL 1.1.75 layer (b), TEST INFRASTRUCTURE ONLY: the two dev-only seams the hidden
 * full-app run needs (INBOX-DESIGN §11.18 #48, the Human's option A), and the marker that they
 * are INERT in a packaged/Stable run.
 *
 *  - MUNDER_DEV_ROOT: the ONE explicit, validated relocation of the whole dev-isolation root
 *    (userData, hive, harness home, single-instance lock, pipe). Honoured only under MUNDER_DEV=1.
 *    Absolute, never equal to / inside / containing C:\Dunder\hive (or any Stable literal), the
 *    live userData or the fixed C:\Dunder\MunderDevData. A refused value exits the app (97).
 *  - MUNDER_HIDDEN=1: no window is ever shown, focused or restored; no toast, dialog, browser or
 *    Explorer window. Honoured only under MUNDER_DEV=1.
 *
 * INERT MARKER. Without MUNDER_DEV=1 neither variable is even READ (a throwing env proves it), a
 * fresh process that carries both but not MUNDER_DEV resolves the fixed root and not-hidden, no
 * other src/ file reads either name, and — when out/ is built — the shipped main bundle keeps the
 * MUNDER_DEV gate in front of both reads. No app, window or CLI is started by this file.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const REPO = path.resolve(__dirname, '..');
const iso = loadTs(path.join(REPO, 'src/main/devIsolation.ts'));

const WIN = 'win32';
const FIXED = 'C:\\Dunder\\MunderDevData';
const STABLE_USERDATA = 'C:\\Users\\FiercePC\\AppData\\Roaming\\munder-difflin';
const SANDBOX = 'D:\\md-layerb\\run-1';

const resolve = (value, extra = {}) =>
  iso.resolveDevDataRoot({ env: { MUNDER_DEV_ROOT: value }, dev: true, platform: WIN, liveUserData: STABLE_USERDATA, ...extra });

// ─────────────────────────────────────────────────────────────── the override: validation

test('override: a valid absolute path under MUNDER_DEV relocates the root (normalised)', () => {
  assert.deepEqual(resolve(SANDBOX), { ok: true, root: SANDBOX, override: true });
  assert.deepEqual(resolve(`${SANDBOX}\\`), { ok: true, root: SANDBOX, override: true });
  assert.deepEqual(resolve('D:/md-layerb/run-1'), { ok: true, root: SANDBOX, override: true });
});

test('override: unset or blank under MUNDER_DEV is the FIXED root (the mission contract)', () => {
  assert.deepEqual(iso.resolveDevDataRoot({ env: {}, dev: true, platform: WIN }), { ok: true, root: FIXED, override: false });
  assert.deepEqual(resolve('   '), { ok: true, root: FIXED, override: false });
});

test('override: not absolute is REFUSED (relative, drive-relative, rooted without a drive, UNC)', () => {
  for (const bad of ['sandbox', '.\\sandbox', '..\\x', 'C:sandbox', '\\md-layerb\\x', '\\\\server\\share\\x', '//server/share/x']) {
    const r = resolve(bad);
    assert.equal(r.ok, false, `${bad} must be refused`);
    assert.match(r.reason, /not an absolute path/);
  }
  assert.equal(resolve('D:\\x\0y').ok, false, 'NUL refused');
});

test('override: the live hive, MunderDevData and the live userData are REFUSED (equal, inside, containing; any spelling)', () => {
  const refused = [
    'C:\\Dunder\\hive', 'c:/dunder/HIVE/', 'C:\\Dunder\\hive\\agents\\x', 'C:\\Dunder\\.\\hive\\sub',
    FIXED, 'c:\\dunder\\munderdevdata\\', 'C:/Dunder/MunderDevData/sandbox', 'C:\\Dunder\\MunderDevData\\..\\MunderDevData\\x',
    STABLE_USERDATA, `${STABLE_USERDATA}\\sandbox`,
    'C:\\Dunder', 'C:\\', 'C:\\Users\\FiercePC\\AppData\\Roaming',
    'C:\\Dunder\\palace\\x', 'C:\\Dunder\\worktrees\\x'
  ];
  for (const bad of refused) {
    const r = resolve(bad);
    assert.equal(r.ok, false, `${bad} must be refused`);
    assert.match(r.reason, /equals or lies inside|contains/, bad);
  }
});

test('override: the pipe and the single-instance lock DERIVE from the root, so a sandbox never collides with the live app or MunderDevData', () => {
  const r = resolve(SANDBOX);
  assert.equal(r.ok, true);
  const p = iso.devPaths(r.root, WIN);
  const fixed = iso.devPaths(FIXED, WIN);
  assert.equal(p.userData, `${SANDBOX}\\userData`, 'the lock is keyed on userData, which is under the sandbox');
  assert.equal(p.hiveRoot, `${SANDBOX}\\hive`);
  assert.notEqual(p.userData.toLowerCase(), fixed.userData.toLowerCase());
  assert.notEqual(p.userData.toLowerCase(), STABLE_USERDATA.toLowerCase());
  assert.equal(p.pipeName, iso.hookPipeName(p.hiveRoot, true, WIN), 'pipe = f(hive root)');
  assert.notEqual(p.pipeName.toLowerCase(), fixed.pipeName.toLowerCase(), 'not the MunderDevData pipe');
  assert.notEqual(p.pipeName.toLowerCase(), iso.hookPipeName('C:\\Dunder\\hive', false, WIN).toLowerCase(), 'not the live pipe');
  const forbidden = [...iso.stableForbiddenPaths({ defaultUserData: STABLE_USERDATA, stableHarnessHome: 'C:\\Dunder', platform: WIN }), FIXED];
  assert.deepEqual(iso.checkIsolation(p, forbidden, WIN), [], 'the bootstrap guard accepts the sandbox');
  assert.deepEqual(iso.devRootOverrideViolations(p, WIN), []);
  // And the guard would catch the fixed root's pipe/data if an override ever produced them.
  assert.ok(iso.devRootOverrideViolations(fixed, WIN).length >= 2);
  assert.ok(iso.checkIsolation(fixed, forbidden, WIN).length > 0);
});

test('override: devDataRoot THROWS on a refused value (never falls back to the fixed root)', () => {
  assert.throws(() => iso.devDataRoot(WIN, { MUNDER_DEV_ROOT: 'C:\\Dunder\\MunderDevData\\x' }, true), /refusing MUNDER_DEV_ROOT/);
  assert.equal(iso.devDataRoot(WIN, { MUNDER_DEV_ROOT: SANDBOX }, true), SANDBOX);
});

// ─────────────────────────────────────────────────────────────── INERT without MUNDER_DEV

test('INERT: without MUNDER_DEV the environment is NOT READ (a throwing env) — fixed root, not hidden', () => {
  const trap = new Proxy({}, { get() { throw new Error('env read without MUNDER_DEV'); }, has() { throw new Error('env probed without MUNDER_DEV'); } });
  assert.deepEqual(iso.resolveDevDataRoot({ env: trap, dev: false, platform: WIN }), { ok: true, root: FIXED, override: false });
  assert.equal(iso.devDataRoot(WIN, trap, false), FIXED);
  assert.equal(iso.hiddenRun(trap, false), false);
  // And values that WOULD be honoured under MUNDER_DEV change nothing without it.
  const both = { MUNDER_DEV_ROOT: SANDBOX, MUNDER_HIDDEN: '1' };
  assert.equal(iso.devDataRoot(WIN, both, false), FIXED);
  assert.equal(iso.hiddenRun(both, false), false);
  assert.equal(iso.hiddenRun(both, true), true);
  assert.equal(iso.hiddenRun({ MUNDER_HIDDEN: 'true' }, true), false, 'only the exact value 1');
});

/** A fresh process loads devIsolation.ts with exactly `extra` on top of a scrubbed env. */
function freshLoad(extra) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hidden-root-'));
  try {
    const env = {};
    for (const k of ['SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'PATH', 'Path']) if (process.env[k] !== undefined) env[k] = process.env[k];
    Object.assign(env, { HOME: home, USERPROFILE: home, TEMP: home, TMP: home, CODEX_HOME: path.join(home, '.codex'), GEMINI_CLI_HOME: home }, extra);
    const script = `const iso = require(${JSON.stringify(path.join(__dirname, 'load-ts.cjs'))})(${JSON.stringify(path.join(REPO, 'src/main/devIsolation.ts'))});
      process.stdout.write(JSON.stringify({ dev: iso.DEV_ISOLATION, hidden: iso.DEV_HIDDEN, root: iso.devDataRoot() }));`;
    const r = spawnSync(process.execPath, ['-e', script], { cwd: REPO, env, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

test('INERT (fresh process, the packaged situation): MUNDER_DEV_ROOT + MUNDER_HIDDEN without MUNDER_DEV change nothing', () => {
  const sandbox = path.join(os.tmpdir(), 'md-layerb-inert-probe');
  const r = freshLoad({ MUNDER_DEV_ROOT: sandbox, MUNDER_HIDDEN: '1' });
  assert.equal(r.dev, false);
  assert.equal(r.hidden, false);
  assert.equal(r.root, iso.fixedDevDataRoot(), 'the fixed root, not the sandbox');
  assert.equal(fs.existsSync(sandbox), false, 'nothing was created');
});

test('ACTIVE (fresh process): under MUNDER_DEV=1 both seams take effect', () => {
  const sandbox = path.join(os.tmpdir(), 'md-layerb-active-probe');
  const r = freshLoad({ MUNDER_DEV: '1', MUNDER_DEV_ROOT: sandbox, MUNDER_HIDDEN: '1' });
  assert.equal(r.dev, true);
  assert.equal(r.hidden, true);
  assert.equal(r.root.toLowerCase(), path.resolve(sandbox).toLowerCase());
});

// ─────────────────────────────────────────────────────────────── source pins

test('SOURCE: no src/ file other than devIsolation.ts names either variable (one gated reader)', () => {
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|cjs|js|mjs)$/.test(e.name) && /MUNDER_DEV_ROOT|MUNDER_HIDDEN/.test(codeOnly(readSource(p)))) hits.push(path.relative(REPO, p));
    }
  };
  walk(path.join(REPO, 'src'));
  assert.deepEqual(hits.map((h) => h.replace(/\\/g, '/')), ['src/main/devIsolation.ts']);
  const src = codeOnly(readSource('src/main/devIsolation.ts'));
  // Both readers return BEFORE touching the env when isolation is off.
  assert.match(src, /function resolveDevDataRoot[\s\S]*?if \(!\(opts\.dev \?\? DEV_ISOLATION\)\) return \{ ok: true, root: fixed, override: false \};[\s\S]*?const env = opts\.env \?\? process\.env;/);
  assert.match(src, /function hiddenRun[^{]*\{\s*if \(!dev\) return false;\s*return env\[DEV_HIDDEN_ENV\] === '1';/);
  assert.match(src, /export const DEV_ISOLATION: boolean = process\.env\.MUNDER_DEV === '1';/);
});

test('SOURCE: every window-surfacing call in main is behind DEV_HIDDEN; the window is built hidden and unthrottled', () => {
  const surfacing = /\.show\(\)|\.focus\(\)|\.restore\(\)|showInactive|moveTop|flashFrame|dialog\.show\w+\(|shell\.(openExternal|openPath|showItemInFolder)\(|new Notification\(/;
  const unguarded = [];
  for (const f of ['src/main/index.ts', 'src/main/hooks.ts', 'src/main/updater.ts']) {
    const lines = codeOnly(readSource(f)).split('\n');
    lines.forEach((line, i) => {
      if (!surfacing.test(line) || /capacityStore\.restore\(\)/.test(line)) return;
      const window = lines.slice(Math.max(0, i - 12), i + 1).join('\n');
      if (!/DEV_HIDDEN/.test(window)) unguarded.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(unguarded, [], 'a surfacing call with no DEV_HIDDEN gate');
  const idx = codeOnly(readSource('src/main/index.ts'));
  assert.match(idx, /win\.once\('ready-to-show', \(\) => \{ if \(!DEV_HIDDEN\) win\.show\(\); \}\);/);
  const ctor = idx.slice(idx.indexOf('const win = new BrowserWindow({'), idx.indexOf("win.once('ready-to-show'"));
  assert.match(ctor, /show: false,/, 'built hidden');
  assert.match(ctor, /backgroundThrottling: false,/, 'hidden timers are not throttled');
  assert.equal((idx.match(/new BrowserWindow\(/g) || []).length, 1, 'one window constructor, the gated one');
  // The refusal is loud and exits before anything else runs.
  assert.match(idx, /const rootRes = resolveDevDataRoot\(\{ liveUserData: stableUserData \}\);\s*if \(!rootRes\.ok\) \{\s*console\.error\(`\[dev-isolation\] REFUSING TO START[^`]*`\);\s*process\.exit\(97\);/);
  assert.match(idx, /if \(rootRes\.override\) devStableForbidden\.push\(fixedDevDataRoot\(\)\);/);
  // The interactive dev launcher never passes the seams on.
  const launcher = codeOnly(readSource('tools/dev-isolated.cjs'));
  assert.match(launcher, /delete env\.MUNDER_DEV_ROOT;\s*delete env\.MUNDER_HIDDEN;/);
});

// ─────────────────────────────────────────────────────────────── the BUILT bundle (static)

const BUNDLE = path.join(REPO, 'out', 'main', 'index.js');
if (!fs.existsSync(BUNDLE)) {
  require('./tools/inert.cjs').announceInert(
    'BUILT: the main bundle keeps both seams behind MUNDER_DEV (did not run)',
    'out/main/index.js not built — run npm run build'
  );
} else {
  test('BUILT: the shipped main bundle keeps both seams behind MUNDER_DEV, and the window hidden under MUNDER_HIDDEN', () => {
    const b = readSource(BUNDLE);
    const at = (needle) => { const i = b.indexOf(needle); assert.ok(i >= 0, `missing from out/main/index.js: ${needle}`); return i; };
    at('process.env.MUNDER_DEV === "1"');
    const resolveAt = at('function resolveDevDataRoot(');
    const gate = b.indexOf('override: false', resolveAt);
    const envRead = b.indexOf('process.env', resolveAt);
    assert.ok(gate > resolveAt && envRead > gate, 'resolveDevDataRoot returns the fixed root before it reads the env');
    const hiddenAt = at('function hiddenRun(');
    const body = b.slice(hiddenAt, b.indexOf('}', b.indexOf('return false', hiddenAt)) + 200);
    assert.match(body, /if \(!dev\) return false;[\s\S]*=== "1"/, 'hiddenRun reads MUNDER_HIDDEN only under MUNDER_DEV');
    assert.match(b, /ready-to-show", \(\) => \{\s*if \(!DEV_HIDDEN\) win\.show\(\);/);
    assert.equal((b.match(/MUNDER_DEV_ROOT/g) || []).length >= 1, true);
  });
}
