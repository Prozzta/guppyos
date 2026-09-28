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
 * INERT MARKER. Both seams are read only when BOTH hold: the bundle was built with
 * MUNDER_LAYERB_SEAMS=1 (electron.vite.config.ts defines __LAYERB_SEAMS__; every normal build, the
 * release included, compiles them to false), AND the process runs with MUNDER_DEV=1. Otherwise
 * neither variable is even READ (a throwing env proves it); a fresh process that carries both but
 * not MUNDER_DEV resolves the fixed root and not-hidden; no other src/ file reads either name; and,
 * when out/ is built, the bundle's LAYERB_SEAMS_BUILT is evaluated (false for a normal build) and
 * its gates are checked. No app, window or CLI is started by this file.
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

test('INERT: a bundle built WITHOUT the layer-b seams ignores both, even under MUNDER_DEV=1 (a throwing env)', () => {
  const trap = new Proxy({}, { get() { throw new Error('env read in a seamless build'); }, has() { throw new Error('env probed in a seamless build'); } });
  assert.deepEqual(iso.resolveDevDataRoot({ env: trap, dev: true, seams: false, platform: WIN }), { ok: true, root: FIXED, override: false });
  assert.equal(iso.hiddenRun(trap, true, false), false);
  assert.equal(iso.LAYERB_SEAMS_BUILT, true, 'unbundled source (no define) counts as carrying them: the unit tests');
  const cfg = codeOnly(readSource('electron.vite.config.ts'), 'x.ts');
  assert.match(cfg, /__LAYERB_SEAMS__: JSON\.stringify\(process\.env\.MUNDER_LAYERB_SEAMS === '1'\)/, 'the define: true only for a MUNDER_LAYERB_SEAMS=1 build');
  const defineMain = cfg.slice(cfg.indexOf('const defineMain'), cfg.indexOf('};', cfg.indexOf('const defineMain')));
  assert.ok(defineMain.includes('__LAYERB_SEAMS__'), 'on the MAIN bundle');
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

test('INERT (fresh process): MUNDER_DEV_ROOT + MUNDER_HIDDEN without MUNDER_DEV change nothing, packaged or not', () => {
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
  assert.match(src, /function resolveDevDataRoot[\s\S]*?if \(!\(opts\.dev \?\? DEV_ISOLATION\) \|\| !\(opts\.seams \?\? LAYERB_SEAMS_BUILT\)\) return \{ ok: true, root: fixed, override: false \};[\s\S]*?const env = opts\.env \?\? process\.env;/);
  assert.match(src, /function hiddenRun[^{]*\{\s*if \(!dev \|\| !seams\) return false;\s*return env\[DEV_HIDDEN_ENV\] === '1';/);
  assert.match(src, /export const LAYERB_SEAMS_BUILT: boolean = typeof __LAYERB_SEAMS__ === 'undefined' \? true : __LAYERB_SEAMS__ === true;/);
  assert.match(src, /export const DEV_ISOLATION: boolean = process\.env\.MUNDER_DEV === '1';/);
});

/**
 * H6 (Jim): the gate check is STRUCTURAL, not a line window, so a multi-line guard is understood and
 * an unguarded call anywhere is caught. A call is guarded when, walking up to its enclosing function:
 *  - it sits in the THEN branch of an `if` whose condition contains `!DEV_HIDDEN`, or in the ELSE
 *    branch of one whose condition is `DEV_HIDDEN ...`;
 *  - it is the right side of `&&` whose left side contains `!DEV_HIDDEN`;
 *  - an EARLIER statement of an enclosing block is `if (DEV_HIDDEN ...) return ...`.
 */
const SURFACING = /^(show|focus|restore|showInactive|moveTop|flashFrame|showMessageBox|showMessageBoxSync|showErrorBox|showOpenDialog|showOpenDialogSync|showSaveDialog|showSaveDialogSync|openExternal|openPath|showItemInFolder)$/;
function unguardedSurfacing(text, fileName) {
  const ts = require('typescript');
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const out = [];
  const isFn = (n) => ts.isFunctionLike(n);
  const guardIf = (st) => ts.isIfStatement(st) && /^\(?\s*DEV_HIDDEN\b/.test(st.expression.getText(sf))
    && (ts.isReturnStatement(st.thenStatement) || (ts.isBlock(st.thenStatement) && st.thenStatement.statements.length === 1 && ts.isReturnStatement(st.thenStatement.statements[0])));
  const guarded = (call) => {
    let node = call;
    while (node.parent && !isFn(node)) {
      const par = node.parent;
      if (ts.isIfStatement(par)) {
        const cond = par.expression.getText(sf);
        if (node === par.thenStatement && /!DEV_HIDDEN\b/.test(cond)) return true;
        if (node === par.elseStatement && /^\(?\s*DEV_HIDDEN\b/.test(cond)) return true;
      }
      if (ts.isBinaryExpression(par) && par.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && node === par.right && /!DEV_HIDDEN\b/.test(par.left.getText(sf))) return true;
      if ((ts.isBlock(par) || ts.isSourceFile(par)) && par.statements) {
        const idx = par.statements.indexOf(node);
        if (par.statements.slice(0, Math.max(0, idx)).some(guardIf)) return true;
      }
      node = par;
    }
    return false;
  };
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && SURFACING.test(n.expression.name.text)) {
      const recv = n.expression.expression.getText(sf);
      const benign = /^capacityStore$/.test(recv);
      if (!benign && !guarded(n)) out.push(`${fileName}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}: ${n.getText(sf).slice(0, 80)}`);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

test('SOURCE: every window-surfacing call in main is behind DEV_HIDDEN (structural check); the window is built hidden and unthrottled', () => {
  const files = ['src/main/index.ts', 'src/main/hooks.ts', 'src/main/updater.ts'];   // capacityToast.ts only calls its injected deps.show (index.ts's gated one)
  const unguarded = files.flatMap((f) => unguardedSurfacing(readSource(f), f));
  assert.deepEqual(unguarded, [], 'a surfacing call with no DEV_HIDDEN gate');
  const idx = codeOnly(readSource('src/main/index.ts'), 'index.ts');
  // Window show/restore/focus happen ONLY inside surfaceWindow, whose first statement is the gate.
  const helper = /function surfaceWindow\([^)]*\)[^{]*\{\s*if \(DEV_HIDDEN\) return;/;
  assert.match(idx, helper);
  const winCalls = idx.match(/\b\w+\.(show|restore|focus)\(\)/g) || [];
  assert.deepEqual(winCalls.filter((c) => !/^capacityStore\./.test(c) && !/\bNotification\b/.test(c)).sort(), ['w.focus()', 'w.restore()', 'w.show()'], 'only surfaceWindow touches a window');
  assert.match(idx, /win\.once\('ready-to-show', \(\) => surfaceWindow\(win, \{ show: true \}\)\);/);
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

test('SOURCE: the structural check CATCHES an unguarded call, a multi-line guard removed (H6), and the helper gate removed', () => {
  const idx = readSource('src/main/index.ts');
  const hooks = readSource('src/main/hooks.ts');
  const mutants = [
    ['surfaceWindow gate removed', idx.replace(/(function surfaceWindow\([^)]*\)[^{]*\{\s*)if \(DEV_HIDDEN\) return;/, '$1'), 'index.ts'],
    ['H6: a multi-line guard removed (the old hire-import shape)', idx.replace('function deliverHire(manifest: HireManifest): void {', 'function deliverHire(manifest: HireManifest): void {\n  if (mainWindow) {\n    mainWindow.show();\n  }'), 'index.ts'],
    ['a dialog handler gate removed', idx.replace(/(ipcMain\.handle\('dialog:chooseFolder'[\s\S]*?)if \(DEV_HIDDEN\) return \{ ok: false as const, error: 'cancelled' \};[^\n]*\n/, '$1'), 'index.ts'],
    ['the hooks toast gate removed', hooks.replace('if (DEV_HIDDEN || !this.getConfig().notifications) return;', 'if (!this.getConfig().notifications) return;'), 'hooks.ts'],
    ['a gate that guards nothing (an unrelated earlier DEV_HIDDEN)', 'function f() { const x = DEV_HIDDEN; dialog.showErrorBox("a", "b"); }', 'm.ts']
  ];
  for (const [name, text, file] of mutants) {
    assert.notEqual(text, file === 'hooks.ts' ? hooks : idx, `mutant "${name}" did not apply`);
    assert.ok(unguardedSurfacing(text, file).length > 0, `mutant "${name}" SURVIVED the structural check`);
  }
  // And a well-formed multi-line guard passes.
  assert.deepEqual(unguardedSurfacing('function f() {\n  if (a &&\n      !DEV_HIDDEN) {\n    w.show();\n  }\n}', 'ok.ts'), []);
});

// ─────────────────────────────────────────────────────────────── the BUILT bundle (static)

const BUNDLE = path.join(REPO, 'out', 'main', 'index.js');
if (!fs.existsSync(BUNDLE)) {
  require('./tools/inert.cjs').announceInert(
    'BUILT: the main bundle keeps both seams behind MUNDER_DEV (did not run)',
    'out/main/index.js not built — run npm run build'
  );
} else {
  test('BUILT: the main bundle gates both seams on the build define AND MUNDER_DEV; a normal build compiles them out', () => {
    const b = readSource(BUNDLE);
    const at = (needle) => { const i = b.indexOf(needle); assert.ok(i >= 0, `missing from out/main/index.js: ${needle}`); return i; };
    at('process.env.MUNDER_DEV === "1"');
    // The define was applied: no bare identifier is left, and the constant EVALUATES.
    assert.ok(!/__LAYERB_SEAMS__/.test(b), 'the __LAYERB_SEAMS__ define was substituted');
    const m = /const LAYERB_SEAMS_BUILT = ([^;\n]+);/.exec(b);
    assert.ok(m, 'LAYERB_SEAMS_BUILT is in the bundle');
    assert.match(m[1], /^[\w\s"'=!?:()]+$/, 'a constant expression');
    const built = Function(`"use strict"; return (${m[1]});`)();
    const seamsBuild = process.env.MUNDER_LAYERB_SEAMS === '1';
    // A bundle built by the layer-b runner (MUNDER_LAYERB_SEAMS=1) carries them; every other does not.
    assert.equal(typeof built, 'boolean');
    // STRICT: out/ must never hold a seams build unless this run is one (the layer-b runner rebuilds out/
    // WITHOUT the seams when it finishes, so a stale test bundle can never be packaged by accident).
    assert.equal(built, seamsBuild, 'LAYERB_SEAMS_BUILT in out/main matches the build flag (false for every normal build)');
    const resolveAt = at('function resolveDevDataRoot(');
    const gate = b.indexOf('override: false', resolveAt);
    const envRead = b.indexOf('process.env', resolveAt);
    assert.ok(gate > resolveAt && envRead > gate, 'resolveDevDataRoot returns the fixed root before it reads the env');
    assert.match(b.slice(resolveAt, gate), /LAYERB_SEAMS_BUILT/, 'and that return is gated on the build define too');
    const hiddenAt = at('function hiddenRun(');
    const body = b.slice(hiddenAt, b.indexOf('}', b.indexOf('return false', hiddenAt)) + 200);
    assert.match(body, /if \(!dev \|\| !seams\) return false;[\s\S]*=== "1"/, 'hiddenRun reads MUNDER_HIDDEN only under MUNDER_DEV in a seams build');
    assert.match(b, /ready-to-show", \(\) => surfaceWindow\(win, \{ show: true \}\)\)/);
    assert.match(b, /function surfaceWindow\([^)]*\) \{\s*if \(DEV_HIDDEN\) return;/);
  });
}
