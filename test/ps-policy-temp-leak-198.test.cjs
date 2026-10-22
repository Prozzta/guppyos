'use strict';
/**
 * PS-POLICY-TEMP-LEAK (1.1.98 final sweep, 2026-10-22): a full run failed on one TEMP LEAK,
 * test-runner-glob's temp jail held __PSScriptPolicyTest_5rmjj3ed.am3.ps1. Windows PowerShell 5.1
 * writes __PSScriptPolicyTest_*.ps1/.psm1 to its temp folder (GetTempPath: TMP, then TEMP) at every
 * start-up and deletes them only if it gets that far, so a PowerShell child killed or cut short
 * leaves them in whatever temp folder it inherited: the test file's jail.
 *
 * Fix (test/tools/ps-env.cjs): psEnv also points TEMP/TMP/TMPDIR at psTempDir(), a folder of the
 * process's own under the real temp folder (shared-temp.cjs), outside the jail, removed at exit.
 * run-tests opts out ({ temp: false }) for the env of the whole run: the files' jail sets theirs.
 *
 * ENV: the keys, in any spelling. TEMPDIR: outside the jail, removed at exit (a child process).
 * BEHAVIOUR: the real PowerShell, watched: with psEnv the policy files appear in psTempDir and
 * never in the jail; the control (no psEnv) writes them in the jail. RUNNER: the opt-out is the
 * runner's alone.
 *
 * Andy's audit (9a25ba89): a test process killed before its exit handler (run-tests ending a hung
 * file) left its folder in the real temp folder, unseen. The folder is guppy-pstemp-<pid>-*, and
 * sweepPsTempDirs removes dead pids' folders on the first psTempDir() and at the end of a run-tests
 * run. SWEEP: dead removed, live kept. KILLED: Andy's probe, PowerShell killed on its first policy
 * file and then its test process killed: the jail is clean and the left folder is swept.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { psEnv, psTempDir, sweepPsTempDirs, KEY, TEMP_KEYS } = require('./tools/ps-env.cjs');
const { sharedTemp } = require('./tools/shared-temp.cjs');

const WIN = process.platform === 'win32';
const POLICY = /^__PSScriptPolicyTest_/;
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-policy-'));
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const under = (child, parent) => path.resolve(child).toLowerCase().startsWith(path.resolve(parent).toLowerCase() + path.sep);
const tempKeys = (env) => Object.keys(env).filter((k) => TEMP_KEYS.includes(k.toUpperCase()));

test('ENV: psEnv points TEMP, TMP and TMPDIR at psTempDir, replacing any spelling; temp: false leaves them alone', () => {
  const base = { A: '1', Temp: 'C:\\jail', tmp: 'C:\\jail', TMPDIR: 'C:\\jail' };
  const env = psEnv(base);
  assert.deepEqual(tempKeys(env).sort(), ['TEMP', 'TMP', 'TMPDIR'], 'PS POLICY: one key each, no second spelling');
  for (const k of TEMP_KEYS) assert.equal(env[k], psTempDir(), `PS POLICY: ${k} is the PowerShell temp folder`);
  assert.equal(env.A, '1', 'PS POLICY: the rest of the base env is kept');
  assert.equal(typeof env[KEY], 'string', 'PS POLICY: the module cache path is still added');
  assert.deepEqual(base, { A: '1', Temp: 'C:\\jail', tmp: 'C:\\jail', TMPDIR: 'C:\\jail' }, 'PS POLICY: the base env is not changed');
  assert.equal(psEnv({ [KEY]: 'x' }).TEMP, psTempDir(), 'PS POLICY: a caller\'s own module cache path does not skip the temp folder');
  const runner = psEnv(base, { temp: false });
  assert.deepEqual(tempKeys(runner).sort(), ['TMPDIR', 'Temp', 'tmp'], 'PS POLICY: temp: false keeps the base temp keys as they are');
  assert.equal(runner.Temp, 'C:\\jail');
  assert.equal(typeof runner[KEY], 'string', 'PS POLICY: temp: false still adds the module cache path');
});

test('TEMPDIR: under a temp jail, psTempDir is under the real temp folder, not the jail, and is removed at exit', () => {
  const jail = path.join(tmpRoot, 'jail-dir');
  const shared = path.join(tmpRoot, 'shared-dir');
  fs.mkdirSync(jail);
  fs.mkdirSync(shared);
  const script = `const e = require(${JSON.stringify(path.join(__dirname, 'tools', 'ps-env.cjs'))}).psEnv(); process.stdout.write(JSON.stringify({ dir: e.TEMP, made: require('fs').existsSync(e.TEMP) }));`;
  const r = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8', windowsHide: true, timeout: 60_000,
    env: { ...process.env, TEMP: jail, TMP: jail, TMPDIR: jail, GUPPY_SHARED_TEMP: shared }
  });
  assert.equal(r.status, 0, r.stderr);
  const o = JSON.parse(r.stdout);
  assert.ok(o.made, 'PS POLICY: psTempDir is made on first use');
  assert.ok(under(o.dir, shared), `PS POLICY: psTempDir is under the real temp folder (${o.dir})`);
  assert.ok(!under(o.dir, jail), `PS POLICY: psTempDir is not in the jail (${o.dir})`);
  assert.ok(!fs.existsSync(o.dir), 'PS POLICY: psTempDir is removed when the process exits');
  assert.deepEqual(fs.readdirSync(jail), [], 'PS POLICY: nothing was written in the jail');
  assert.ok(under(psTempDir(), sharedTemp()), 'PS POLICY: in this process too, psTempDir is under sharedTemp()');
});

/** PowerShell with psEnv(base, { temp }), printing its GetTempPath(), while `dirs` are watched. Resolves { out, seen }. */
function psWatched(base, temp, dirs) {
  const seen = Object.fromEntries(Object.keys(dirs).map((k) => [k, new Set()]));
  const watchers = Object.entries(dirs).map(([k, d]) => fs.watch(d, (_e, f) => { if (f) seen[k].add(String(f)); }));
  return new Promise((resolve) => {
    const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[IO.Path]::GetTempPath()'],
      { env: psEnv(base, { temp }), windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    const done = () => setTimeout(() => { for (const w of watchers) w.close(); resolve({ out: out.trim(), seen }); }, 500);
    c.on('error', done);
    c.on('close', done);
  });
}

test('BEHAVIOUR: with psEnv the real PowerShell writes its policy test files in psTempDir and never in the jail; without, in the jail', { skip: !WIN && 'Windows PowerShell only', timeout: 120_000 }, async () => {
  const jail = path.join(tmpRoot, 'jail-ps');
  fs.mkdirSync(jail);
  const jailEnv = { ...process.env, TEMP: jail, TMP: jail, TMPDIR: jail };
  const fixed = await psWatched(jailEnv, true, { jail, ps: psTempDir() });
  const control = await psWatched(jailEnv, false, { jail, ps: psTempDir() }); // the mutant "psEnv leaves the temp alone"
  // The control: proves this machine's PowerShell writes the files in the temp it inherits, so the checks have teeth.
  assert.equal(path.resolve(control.out), path.resolve(jail), 'PS POLICY control: without psEnv PowerShell\'s temp folder is the jail');
  assert.ok([...control.seen.jail].some((f) => POLICY.test(f)), `PS POLICY control: without psEnv the policy files are written in the jail (${[...control.seen.jail]})`);
  assert.equal(path.resolve(fixed.out), path.resolve(psTempDir()), 'PS POLICY: with psEnv PowerShell\'s temp folder is psTempDir');
  assert.ok([...fixed.seen.ps].some((f) => POLICY.test(f)), `PS POLICY: with psEnv the policy files are written in psTempDir (${[...fixed.seen.ps]})`);
  assert.deepEqual([...fixed.seen.jail].filter((f) => POLICY.test(f)), [], 'PS POLICY: with psEnv no policy file is written in the jail');
  assert.deepEqual(fs.readdirSync(jail), [], 'PS POLICY: the jail is empty');
});

/** A dead pid: a node child that has exited (its pid is not reused within the test). */
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  return Number(r.stdout);
}

test('SWEEP: dead pids\' guppy-pstemp folders are removed, live ones and other names kept; the first psTempDir sweeps', () => {
  const shared = path.join(tmpRoot, 'shared-sweep');
  fs.mkdirSync(shared);
  const dead = deadPid();
  const names = {
    dead: `guppy-pstemp-${dead}-aaaaaa`,
    live: `guppy-pstemp-${process.ppid}-bbbbbb`,
    own: `guppy-pstemp-${process.pid}-cccccc`,
    other: 'guppy-psmac-dddddd',
    // A pid this process may not signal (Windows' System, 4: EPERM) is alive, not swept.
    ...(WIN ? { perm: 'guppy-pstemp-4-eeeeee' } : {})
  };
  const kept = Object.values(names).filter((n) => n !== names.dead).sort();
  const make = () => { for (const n of Object.values(names)) { fs.mkdirSync(path.join(shared, n), { recursive: true }); fs.writeFileSync(path.join(shared, n, '__PSScriptPolicyTest_x.ps1'), ''); } };
  make();
  assert.deepEqual(sweepPsTempDirs(shared), [names.dead], 'PS POLICY sweep: only the dead pid\'s folder is removed');
  assert.deepEqual(fs.readdirSync(shared).sort(), kept, 'PS POLICY sweep: live, own, unsignalable and other folders are kept');
  assert.deepEqual(sweepPsTempDirs(path.join(tmpRoot, 'no-such')), [], 'PS POLICY sweep: a missing root is nothing to do');
  // The first psTempDir() of a process sweeps (a child process: this one's psTempDir is made).
  make();
  const script = `const e = require(${JSON.stringify(path.join(__dirname, 'tools', 'ps-env.cjs'))}).psEnv(); process.stdout.write(require('path').basename(e.TEMP));`;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', windowsHide: true, timeout: 60_000, env: { ...process.env, GUPPY_SHARED_TEMP: shared } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`^guppy-pstemp-${r.pid}-`), 'PS POLICY sweep: the folder carries its process\'s pid');
  assert.deepEqual(fs.readdirSync(shared).sort(), kept, 'PS POLICY sweep: the first psTempDir removed the dead pid\'s folder (and its own went at exit)');
});

/** Andy's probe: a test process (TEMP = jail) runs PowerShell through psEnv(..., { temp }), kills it the
 *  moment a policy file shows in the temp it gave it, and is then itself killed (no exit handler). */
function killedOnFirstFile(jail, shared, temp) {
  const inner = path.join(tmpRoot, 'killed-inner.cjs');
  fs.writeFileSync(inner, `
const fs = require('fs'), { spawn } = require('child_process');
const { psEnv } = require(${JSON.stringify(path.join(__dirname, 'tools', 'ps-env.cjs'))});
const temp = process.argv[2] === 'on';
const dir = psEnv(process.env, { temp }).TEMP;
const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 20'], { env: psEnv(process.env, { temp }), windowsHide: true, stdio: 'ignore' });
let killed = false;
fs.watch(dir, (_e, f) => { if (!killed && /^__PSScriptPolicyTest_/.test(String(f))) { killed = true; c.kill(); process.stdout.write('killed ' + f + '\\n'); } });
setTimeout(() => { c.kill(); process.stdout.write('timer\\n'); }, 30000);
`);
  return new Promise((resolve) => {
    const env = { ...process.env, TEMP: jail, TMP: jail, TMPDIR: jail, GUPPY_SHARED_TEMP: shared, PSModuleAnalysisCachePath: path.join(tmpRoot, 'modcache', 'ModuleAnalysisCache') };
    const p = spawn(process.execPath, [inner, temp ? 'on' : 'off'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; if (/killed|timer/.test(out)) p.kill('SIGKILL'); });
    p.on('close', () => setTimeout(() => resolve({ out, pid: p.pid }), 1000));
  });
}

test('KILLED: PowerShell killed on its first policy file, then its test process killed: the jail stays clean, the left folder is swept', { skip: !WIN && 'Windows PowerShell only', timeout: 120_000 }, async () => {
  const jail = path.join(tmpRoot, 'jail-killed');
  const shared = path.join(tmpRoot, 'shared-killed');
  fs.mkdirSync(jail);
  fs.mkdirSync(shared);
  // The control (the mutant "psEnv leaves the temp alone"): the cut-short PowerShell leaves its policy file in the jail.
  const control = await killedOnFirstFile(jail, shared, false);
  assert.match(control.out, /^killed __PSScriptPolicyTest_/, 'PS POLICY control: the PowerShell was killed on its first policy file');
  assert.ok(fs.readdirSync(jail).some((f) => POLICY.test(f)), `PS POLICY control: without psEnv the killed PowerShell leaves its policy file in the jail (${fs.readdirSync(jail)})`);
  for (const f of fs.readdirSync(jail)) fs.rmSync(path.join(jail, f), { recursive: true, force: true });
  const fixed = await killedOnFirstFile(jail, shared, true);
  assert.match(fixed.out, /^killed __PSScriptPolicyTest_/, 'PS POLICY: the PowerShell was killed on its first policy file');
  assert.deepEqual(fs.readdirSync(jail), [], 'PS POLICY: with psEnv the killed PowerShell leaves nothing in the jail');
  const left = fs.readdirSync(shared);
  assert.deepEqual(left.map((n) => n.replace(/-[^-]+$/, '')), [`guppy-pstemp-${fixed.pid}`], `PS POLICY: the killed test process left its own folder in the real temp folder (${left})`);
  assert.deepEqual(sweepPsTempDirs(shared), left, 'PS POLICY: the sweep removes the dead test process\'s folder');
  assert.deepEqual(fs.readdirSync(shared), [], 'PS POLICY: the real temp folder is clean after the sweep');
});

test('RUNNER: run-tests sweeps dead pids\' folders at the end of a run', () => {
  const src = fs.readFileSync(path.join(__dirname, 'tools', 'run-tests.cjs'), 'utf8');
  assert.match(src, /const code = run\(\{[\s\S]*?\}\);\s*(?:\/\/[^\n]*\n\s*)*require\('\.\/ps-env\.cjs'\)\.sweepPsTempDirs\(\);\s*process\.exit\(code\);/, 'PS POLICY runner: the sweep runs after run() and before the exit');
});

test('RUNNER: only run-tests opts out of the PowerShell temp folder, and its files keep their temp jail', () => {
  const src = fs.readFileSync(path.join(__dirname, 'tools', 'run-tests.cjs'), 'utf8');
  assert.match(src, /psEnv\(process\.env, \{ temp: false \}\)/, 'PS POLICY runner: the env for the whole run opts out');
  const roots = [__dirname, path.join(__dirname, '..', 'scripts'), path.join(__dirname, '..', 'src')];
  const optOuts = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
      if (!/\.(c?js|ts)$/.test(e.name) || /\.test\.cjs$/.test(e.name)) continue; // code, not the pins
      if (/temp:\s*false/.test(fs.readFileSync(p, 'utf8'))) optOuts.push(path.relative(path.join(__dirname, '..'), p).split(path.sep).join('/'));
    }
  };
  for (const r of roots) if (fs.existsSync(r)) walk(r);
  assert.deepEqual(optOuts.sort(), ['test/tools/ps-env.cjs', 'test/tools/run-tests.cjs'], 'PS POLICY: no other file opts out of the PowerShell temp folder');
  const jail = /process\.env\.TEMP = dir;/;
  assert.match(fs.readFileSync(path.join(__dirname, 'tools', 'temp-jail-preload.cjs'), 'utf8'), jail, 'PS POLICY runner: the preload still gives each file its own temp');
});
