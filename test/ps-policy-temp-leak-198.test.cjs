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
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { psEnv, psTempDir, KEY, TEMP_KEYS } = require('./tools/ps-env.cjs');
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
