'use strict';
/**
 * TEST-PS-MODCACHE-LEAK (1.1.98): four worktree roots held a stray
 * Microsoft\Windows\PowerShell\ModuleAnalysisCache (2026-10-15/16, each written during a full run
 * whose USERPROFILE pointed at a fake home with no AppData\Local). Windows PowerShell 5.1 saves that
 * cache about 10 s after a module command (Get-CimInstance) autoloads, to
 * GetFolderPath(LocalApplicationData)\Microsoft\Windows\PowerShell; under such a jail the folder path is ''
 * and the save is relative to the child's cwd. A jailed LOCALAPPDATA does not move it;
 * PSModuleAnalysisCachePath does (test/tools/ps-env.cjs).
 *
 * BEHAVIOUR runs the real PowerShell both ways under that jail: without the variable (the leak,
 * which is also the mutant "psEnv adds nothing") and with psEnv (cache in the temp, cwd empty).
 * CENSUS: every PowerShell spawn under test/ goes through psEnv, and the runner gives every file
 * one. ROOT: no Microsoft\ folder in the repo root.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { psEnv, psCacheDir, KEY } = require('./tools/ps-env.cjs');

const ROOT = path.join(__dirname, '..');
const WIN = process.platform === 'win32';
const CACHE_REL = path.join('Microsoft', 'Windows', 'PowerShell', 'ModuleAnalysisCache');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-modcache-'));
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const withoutKey = (env) => Object.fromEntries(Object.entries(env).filter(([k]) => k.toUpperCase() !== KEY.toUpperCase()));

/** PowerShell under a home with no AppData\Local, cwd `cwd`: autoload CimCmdlets, then wait (up to
 *  40 s) for the cache file `want` to be saved. Resolves the exit code. */
function psUnderJail(env, cwd, want) {
  const script = "Get-CimInstance Win32_OperatingSystem | Out-Null; $n = 0; while (-not (Test-Path -LiteralPath $env:WANT) -and $n -lt 400) { Start-Sleep -Milliseconds 100; $n++ }";
  return new Promise((resolve) => {
    const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { cwd, env: { ...env, WANT: want }, windowsHide: true, stdio: 'ignore' });
    c.on('error', () => resolve(-1));
    c.on('exit', (code) => resolve(code));
  });
}

test('psEnv: adds PSModuleAnalysisCachePath inside a temp folder; keeps one already set, in any case', () => {
  const env = psEnv({ A: '1' });
  assert.equal(env.A, '1', 'PS MODCACHE: the base env is kept');
  assert.equal(env[KEY], path.join(psCacheDir(), 'ModuleAnalysisCache'), 'PS MODCACHE: the cache path is in this process\'s temp folder');
  // PS-POLICY-PRODUCT-TEMP: the real temp folder (sharedTemp), not the file's temp jail.
  assert.ok(path.resolve(env[KEY]).startsWith(path.resolve(require('./tools/shared-temp.cjs').sharedTemp()) + path.sep), `PS MODCACHE: under the temp folder: ${env[KEY]}`);
  assert.equal(psEnv({ PSMODULEANALYSISCACHEPATH: 'x' }).PSMODULEANALYSISCACHEPATH, 'x', 'PS MODCACHE: a caller\'s own value is kept');
  assert.equal(Object.keys(psEnv({ PSMODULEANALYSISCACHEPATH: 'x' })).filter((k) => k.toUpperCase() === KEY.toUpperCase()).length, 1, 'PS MODCACHE: no second key beside it');
  const base = { B: '2' };
  psEnv(base);
  assert.deepEqual(base, { B: '2' }, 'PS MODCACHE: the base env is not changed');
});

test('BEHAVIOUR: under a home with no AppData\\Local, PowerShell saves the module cache in its cwd; with psEnv it saves it in the temp and the cwd stays empty', { skip: !WIN && 'Windows PowerShell only', timeout: 120_000 }, async () => {
  const home = path.join(tmpRoot, 'home');
  fs.mkdirSync(path.join(home, 'AppData', 'Roaming'), { recursive: true });
  const jail = withoutKey({ ...process.env, USERPROFILE: home, HOME: home });
  const leakCwd = path.join(tmpRoot, 'cwd-leak');
  const fixedCwd = path.join(tmpRoot, 'cwd-fixed');
  fs.mkdirSync(leakCwd);
  fs.mkdirSync(fixedCwd);
  const fixedEnv = psEnv(jail);
  assert.equal(typeof fixedEnv[KEY], 'string', 'PS MODCACHE: psEnv sets PSModuleAnalysisCachePath');
  const [leakRc, fixedRc] = await Promise.all([
    psUnderJail(jail, leakCwd, path.join(leakCwd, CACHE_REL)),   // the leak, and the mutant "psEnv adds nothing"
    psUnderJail(fixedEnv, fixedCwd, fixedEnv[KEY])
  ]);
  assert.equal(leakRc, 0);
  assert.equal(fixedRc, 0);
  // The control: proves this machine's PowerShell leaks without the variable, so the next check has teeth.
  assert.ok(fs.existsSync(path.join(leakCwd, CACHE_REL)), 'PS MODCACHE control: without PSModuleAnalysisCachePath the cache is saved relative to the cwd');
  assert.ok(fs.existsSync(fixedEnv[KEY]), `PS MODCACHE: with psEnv the cache is saved at ${fixedEnv[KEY]}`);
  assert.deepEqual(fs.readdirSync(fixedCwd), [], 'PS MODCACHE: with psEnv nothing is written in the cwd');
});

// A spawn/execFile of PowerShell; not one quoted as data (a pin's expected text starts with a quote).
const PS_CALL = /(?<!['"`])\b(spawn|spawnSync|execFile|execFileSync)\(\s*('powershell(?:\.exe)?'|"powershell(?:\.exe)?"|PS\b)/;

/** Every spawn/execFile of PowerShell in `src` (text) whose call does not pass psEnv: [line, text]. */
function unguardedPsCalls(src) {
  const out = [];
  const re = new RegExp(PS_CALL.source, 'g');
  for (let m; (m = re.exec(src));) {
    // The call: from the name to its closing parenthesis (strings and nesting counted).
    let depth = 0, i = m.index + m[1].length, q = null;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (q) { if (ch === '\\') i++; else if (ch === q) q = null; continue; }
      if (ch === '\'' || ch === '"' || ch === '`') q = ch;
      else if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) break;
    }
    const call = src.slice(m.index, i + 1);
    if (!/\bpsEnv\(/.test(call)) out.push([src.slice(0, m.index).split('\n').length, call.slice(0, 120)]);
  }
  return out;
}

function testFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' || e.name.startsWith('.') ? [] : testFiles(p);
    return /\.c?js$/.test(e.name) ? [p] : [];
  });
}

// The PowerShell spawns of 2026-10-20 (file: count). A new one must be added here AND pass psEnv.
// Not seen here: test/fixtures/quit-sweep-main.cjs starts one through the product PtyManager (a path
// variable) with cwd os.tmpdir(), and gets the runner's env in suite runs.
const KNOWN = {
  'electron-harness/electron-bin.cjs': 1,
  'heavy-cpu-options-191.test.cjs': 2, // INT 1.1.102: + cap-199's known-folder query (B1)
  'heavy-job-lock.test.cjs': 1,
  'ps-policy-temp-leak-198.test.cjs': 2,
  'rebrand-a-182.test.cjs': 1,
  'rebrand-updater-base-183.test.cjs': 1,
  'test-runner-glob.test.cjs': 1,
  'tools/codex-exit-repro.cjs': 1,
  'tools/file-watchdog.cjs': 1,
  'tools/layer-b-core.cjs': 4,
  'tools/mutant-runner-helper.cjs': 1,
  'tools/own-procs.cjs': 1
};

test('CENSUS: every PowerShell spawn under test/ passes psEnv (the census itself catches one that does not)', () => {
  const self = path.basename(__filename);
  const found = {};
  const bad = [];
  for (const f of testFiles(__dirname)) {
    if (path.basename(f) === self) continue;
    const src = fs.readFileSync(f, 'utf8');
    const rel = path.relative(__dirname, f).split(path.sep).join('/');
    const calls = (src.match(new RegExp(PS_CALL.source, 'g')) || []).length;
    if (calls) found[rel] = calls;
    for (const [line, call] of unguardedPsCalls(src)) bad.push(`${rel}:${line} ${call}`);
  }
  assert.deepEqual(bad, [], 'PS MODCACHE census: a PowerShell spawn without psEnv');
  assert.deepEqual(found, KNOWN, 'PS MODCACHE census: the PowerShell spawn sites changed; add the new one to KNOWN (with psEnv)');
  // Teeth: the census flags the own-procs spawn with psEnv taken out, and a PS-constant spawn too.
  const own = fs.readFileSync(path.join(__dirname, 'tools', 'own-procs.cjs'), 'utf8');
  assert.equal(unguardedPsCalls(own.replace(', env: psEnv()', '')).length, 1, 'PS MODCACHE census mutant: own-procs without psEnv is caught');
  assert.equal(unguardedPsCalls("spawnSync(PS, psArgs(x), { windowsHide: true })").length, 1, 'PS MODCACHE census mutant: a PS-constant spawn is caught');
  assert.equal(unguardedPsCalls("execFileSync('powershell.exe', ['-Command', 'a)b'], { env: psEnv() })").length, 0, 'PS MODCACHE census: a ) inside a string does not end the call');
  assert.equal(unguardedPsCalls(`assert.deepEqual(m, ["execFile('powershell.exe'"]);`).length, 0, 'PS MODCACHE census: a call quoted as data is not a call');
});

test('RUNNER: run-tests gives every test file a PSModuleAnalysisCachePath (also for PowerShell the product under test starts)', () => {
  const src = fs.readFileSync(path.join(__dirname, 'tools', 'run-tests.cjs'), 'utf8');
  // INT 1.1.102: cap-199 injects the env (processEnv, defaulting to process.env) for its jobRate tests.
  assert.match(src, /\bprocessEnv = process\.env,/, 'PS MODCACHE runner: the injected env defaults to process.env');
  assert.match(src, /const env = require\('\.\/ps-env\.cjs'\)\.psEnv\(processEnv, \{ temp: false \}\);\r?\n\s*delete env\.NODE_TEST_CONTEXT;/, 'PS MODCACHE runner: the children env goes through psEnv');
});

test('ROOT: no PowerShell module cache folder in the repo root', () => {
  assert.equal(fs.existsSync(path.join(ROOT, 'Microsoft')), false, `PS MODCACHE: ${path.join(ROOT, 'Microsoft')} exists (a PowerShell saved its module cache relative to the repo root)`);
});
