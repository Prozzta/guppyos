'use strict';
require('./tools/own-job.cjs');
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
const { nodeEnv } = require('./tools/node-env.cjs');
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

/** PowerShell with psEnv(base, { temp }), running `command` (default: print its GetTempPath()), while
 *  `dirs` are watched. Resolves { out, seen } plus how the PowerShell ended: { error, code, signal, err }
 *  (the spawn error's code, the exit code, the signal, its stderr). */
function psWatched(base, temp, dirs, command = '[IO.Path]::GetTempPath()') {
  const seen = Object.fromEntries(Object.keys(dirs).map((k) => [k, new Set()]));
  const watchers = Object.entries(dirs).map(([k, d]) => fs.watch(d, (_e, f) => { if (f) seen[k].add(String(f)); }));
  return new Promise((resolve) => {
    const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
      { env: psEnv(base, { temp }), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const end = { error: null, code: null, signal: null };
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    const done = () => setTimeout(() => { for (const w of watchers) w.close(); resolve({ out: out.trim(), seen, ...end, err: err.trim() }); }, 500);
    c.on('error', (e) => { end.error = e.code || e.message; done(); });
    c.on('close', (code, signal) => { end.code = code; end.signal = signal; done(); });
  });
}

/** FLAKE-PS-POLICY-TEMP-LEAK-198-L164 (the 2026-11-20 Electron red): the control PowerShell printed
 *  nothing, and path.resolve('') is the cwd, so the cell failed as "its temp folder is <the work tree>".
 *  psWatched kept neither the exit code, the signal, the spawn error nor stderr, so the cause was lost.
 *  A PowerShell that did not start, print and exit 0 now fails here, by what it did. */
function ranToEnd(r, what) {
  assert.deepEqual({ error: r.error, code: r.code, signal: r.signal, printed: r.out !== '' }, { error: null, code: 0, signal: null, printed: true },
    `PS POLICY${what}: the PowerShell started, printed its temp folder and exited 0 (stderr: ${r.err || 'none'})`);
}

test('BEHAVIOUR: with psEnv the real PowerShell writes its policy test files in psTempDir and never in the jail; without, in the jail', { skip: !WIN && 'Windows PowerShell only', timeout: 120_000 }, async () => {
  const jail = path.join(tmpRoot, 'jail-ps');
  fs.mkdirSync(jail);
  const jailEnv = { ...process.env, TEMP: jail, TMP: jail, TMPDIR: jail };
  const fixed = await psWatched(jailEnv, true, { jail, ps: psTempDir() });
  const control = await psWatched(jailEnv, false, { jail, ps: psTempDir() }); // the mutant "psEnv leaves the temp alone"
  ranToEnd(fixed, '');
  ranToEnd(control, ' control');
  // The control: proves this machine's PowerShell writes the files in the temp it inherits, so the checks have teeth.
  assert.equal(path.resolve(control.out), path.resolve(jail), 'PS POLICY control: without psEnv PowerShell\'s temp folder is the jail');
  assert.ok([...control.seen.jail].some((f) => POLICY.test(f)), `PS POLICY control: without psEnv the policy files are written in the jail (${[...control.seen.jail]})`);
  assert.equal(path.resolve(fixed.out), path.resolve(psTempDir()), 'PS POLICY: with psEnv PowerShell\'s temp folder is psTempDir');
  assert.ok([...fixed.seen.ps].some((f) => POLICY.test(f)), `PS POLICY: with psEnv the policy files are written in psTempDir (${[...fixed.seen.ps]})`);
  assert.deepEqual([...fixed.seen.jail].filter((f) => POLICY.test(f)), [], 'PS POLICY: with psEnv no policy file is written in the jail');
  assert.deepEqual(fs.readdirSync(jail), [], 'PS POLICY: the jail is empty');
});

test('BEHAVIOUR teeth: a PowerShell that prints nothing fails by its exit code, not as a wrong temp folder', { skip: !WIN && 'Windows PowerShell only', timeout: 120_000 }, async () => {
  const jail = path.join(tmpRoot, 'jail-silent');
  fs.mkdirSync(jail);
  const silent = await psWatched({ ...process.env, TEMP: jail, TMP: jail, TMPDIR: jail }, false, { jail }, 'exit 7');
  assert.equal(silent.out, '', 'PS POLICY teeth: the PowerShell printed nothing');
  // What the 2026-11-20 red reported: an empty output read as a folder is the cwd.
  assert.equal(path.resolve(silent.out), process.cwd(), 'PS POLICY teeth: an empty output resolves to the cwd');
  assert.throws(() => ranToEnd(silent, ' control'), (e) => {
    assert.equal(e.code, 'ERR_ASSERTION');
    assert.deepEqual(e.actual, { error: null, code: 7, signal: null, printed: false }, 'PS POLICY teeth: the failure carries the exit code');
    assert.match(e.message, /PS POLICY control: the PowerShell started, printed its temp folder and exited 0/);
    return true;
  });
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
function killedOnFirstFile(jail, shared, temp, open = (pid) => procHold().procOpen(pid), signal, stallMs = 0) {
  const inner = path.join(tmpRoot, 'killed-inner.cjs');
  fs.writeFileSync(inner, `
const fs = require('fs'), { spawn } = require('child_process');
const { psEnv } = require(${JSON.stringify(path.join(__dirname, 'tools', 'ps-env.cjs'))});
const temp = process.argv[2] === 'on';
// FLAKE-PS-POLICY-CONTROL-KILL-RACE-172: a late kill, modelled. The watcher's callback is held for this
// long before it kills, as a starved event loop holds it; PowerShell deletes its policy files ~6 ms
// after it made them.
const stall = Number(process.argv[3]);
const dir = psEnv(process.env, { temp }).TEMP;
const c = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 20'], { env: psEnv(process.env, { temp }), windowsHide: true, stdio: 'ignore' });
let killed = false;
// The kill only starts the PowerShell's end: say 'killed' (and be killed) once it has exited. Its process
// object is signalled only after its threads have ended and its handles are closed, so by then it holds
// nothing in the folder the sweep removes (FLAKE-PS-POLICY-TEMP-LEAK-198-L164).
const afterExit = (say) => { if (c.exitCode !== null || c.signalCode !== null) say(); else { c.kill(); c.once('exit', say); } };
fs.watch(dir, (_e, f) => { if (!killed && /^__PSScriptPolicyTest_/.test(String(f))) { killed = true; if (stall) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stall); afterExit(() => process.stdout.write('killed ' + f + '\\n')); } });
setTimeout(() => afterExit(() => process.stdout.write('timer\\n')), 30000);
`);
  return new Promise((resolve, reject) => {
    const env = { ...process.env, TEMP: jail, TMP: jail, TMPDIR: jail, GUPPY_SHARED_TEMP: shared, PSModuleAnalysisCachePath: path.join(tmpRoot, 'modcache', 'ModuleAnalysisCache') };
    const p = spawn(process.execPath, [inner, temp ? 'on' : 'off', String(stallMs)], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    // FLAKE-PS-POLICY-TEMP-LEAK-198-L164: the test process is held by handle from its spawn, BEFORE the
    // kill, until the caller has swept. While the hold is open Windows cannot give its pid to another
    // process, so the sweep's kill(pid, 0) answers for this process (exited: ESRCH), not a stranger.
    // procOpen takes only a running child of ours: opened later, it would throw "already exited".
    // FLAKE-PS-POLICY-KILLED-CELL-HANG-108: from here the process runs, and only this helper ends it.
    // If the hold cannot be opened, end it and report once it has gone: left alone it never ends.
    let hold;
    try { hold = open(p.pid); } catch (e) { p.once('close', () => reject(e)); p.kill('SIGKILL'); return; }
    // (b) The same when the cell is ended while the process runs (its timeout aborts its signal).
    let ended = null;
    const onEnd = () => { ended = { why: signal.reason }; p.kill('SIGKILL'); };
    if (signal) { if (signal.aborted) onEnd(); else signal.addEventListener('abort', onEnd, { once: true }); }
    let out = '';
    p.stdout.on('data', (d) => { out += d; if (/killed|timer/.test(out)) p.kill('SIGKILL'); });
    p.on('close', () => {
      if (signal) signal.removeEventListener('abort', onEnd);
      if (ended) { procHold().procClose(hold); reject(ended.why); return; }
      // The exit itself, read through the hold (no timer): 'close' comes after the process has ended.
      try { assert.equal(procHold().procAlive(hold), false, 'PS POLICY: the killed test process has exited (read through its hold)'); } catch (e) { procHold().procClose(hold); reject(e); return; }
      resolve({ out, pid: p.pid, hold });
    });
  });
}

/** The fs-handle addon's process holds (PTY-KILL-PID-IDENTITY), loaded on first use (Windows only). */
let holdAddon;
function procHold() {
  if (!holdAddon) {
    const mod = { exports: {} };
    process.dlopen(mod, path.join(__dirname, '..', 'resources', 'fs-handle', 'bin', 'guppy_fs_handle.node'));
    holdAddon = mod.exports;
  }
  return holdAddon;
}

/** Why the sweep kept the killed process's folder: the two ways sweepPsTempDirs returns less. Its pid
 *  answered alive (EPERM counts as alive), or rmSync threw and the sweep swallowed it ("in use: next
 *  sweep"). Removes what it can, so call it only when the sweep already fell short. */
function whyKept(shared, left, pid) {
  let alive;
  try { process.kill(pid, 0); alive = 'alive'; } catch (e) { alive = e.code; }
  const rm = left.filter((n) => fs.existsSync(path.join(shared, n))).map((n) => {
    try { fs.rmSync(path.join(shared, n), { recursive: true, force: true }); return `${n}: removed on a second try`; } catch (e) { return `${n}: rmSync ${e.code} ${e.path || ''}`; }
  });
  return `kill(${pid}, 0) said ${alive}; direct rmSync: ${rm.join('; ') || 'nothing left to remove'}`;
}

test('KILLED: PowerShell killed on its first policy file, then its test process killed: the jail stays clean, the left folder is swept', { skip: !WIN && 'Windows PowerShell only', timeout: 120_000 }, async (t) => {
  const jail = path.join(tmpRoot, 'jail-killed');
  const shared = path.join(tmpRoot, 'shared-killed');
  fs.mkdirSync(jail);
  fs.mkdirSync(shared);
  // The control (the mutant "psEnv leaves the temp alone"): the cut-short PowerShell leaves its policy file in the jail.
  // Both runs have the same no-delete jail (FLAKE-PS-POLICY-CONTROL-KILL-RACE-172), so they differ in psEnv alone.
  const control = await withNoDelete(jail, () => killedOnFirstFile(jail, shared, false, undefined, t.signal));
  procHold().procClose(control.hold);
  assert.match(control.out, /^killed __PSScriptPolicyTest_/, 'PS POLICY control: the PowerShell was killed on its first policy file');
  assert.ok(fs.readdirSync(jail).some((f) => POLICY.test(f)), `PS POLICY control: without psEnv the killed PowerShell leaves its policy file in the jail (${fs.readdirSync(jail)})`);
  for (const f of fs.readdirSync(jail)) fs.rmSync(path.join(jail, f), { recursive: true, force: true });
  const fixed = await withNoDelete(jail, () => killedOnFirstFile(jail, shared, true, undefined, t.signal));
  try {
    assert.match(fixed.out, /^killed __PSScriptPolicyTest_/, 'PS POLICY: the PowerShell was killed on its first policy file');
    assert.deepEqual(fs.readdirSync(jail), [], 'PS POLICY: with psEnv the killed PowerShell leaves nothing in the jail');
    const left = fs.readdirSync(shared);
    assert.deepEqual(left.map((n) => n.replace(/-[^-]+$/, '')), [`guppy-pstemp-${fixed.pid}`], `PS POLICY: the killed test process left its own folder in the real temp folder (${left})`);
    const removed = sweepPsTempDirs(shared);
    // The pid was still reserved through the sweep: the hold was open (procAlive throws on a closed one).
    assert.equal(procHold().procAlive(fixed.hold), false, 'PS POLICY: the killed test process stays held through the sweep, so its pid is not reused');
    assert.deepEqual(removed, left, `PS POLICY: the sweep removes the dead test process's folder${removed.length === left.length ? '' : ` (kept: ${whyKept(shared, left, fixed.pid)})`}`);
    assert.deepEqual(fs.readdirSync(shared), [], 'PS POLICY: the real temp folder is clean after the sweep');
  } finally {
    procHold().procClose(fixed.hold);
  }
});

// FLAKE-PS-POLICY-CONTROL-KILL-RACE-172: the control's kill and PowerShell's own delete of its policy
// files were not ordered. PowerShell makes the two files, checks them and deletes them within ~6 ms; the
// kill is sent from a folder watcher's callback in another process. A callback that ran later than that
// (a loaded machine) killed a PowerShell that had already deleted them, and the control found an empty
// jail (two suite reds). Here the callback is held for KILL_STALL_MS, far past the delete, every time.
//
// The order is now fixed by the jail, not by speed: while a KILLED run is going, nothing can be deleted
// from its jail (two deny entries for Everyone: "delete child" on the folder, and "delete" inherited by
// its files). PowerShell's own delete is refused, it carries on (measured: exit 0, FullLanguage), and
// the file is there whenever the kill lands. So the control no longer shows that the KILL is what left
// the file. It shows what it is there for: without psEnv the policy files are written in the jail, and
// with psEnv (the same jail, the same deny) they are not. Creating, listing and reading stay allowed.
// The entries are removed before the cell reads or clears the jail; a file that is hard-killed between
// the two leaves a jail that only `icacls <jail> /remove:d *S-1-1-0` unlocks.
const EVERYONE = '*S-1-1-0';
function noDelete(dir) {
  const icacls = (args) => spawnSync('icacls.exe', [dir, ...args], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  const set = icacls(['/deny', `${EVERYONE}:(DC)`, '/deny', `${EVERYONE}:(OI)(IO)(D)`]);
  assert.equal(set.status, 0, `PS POLICY: the jail was made no-delete (${set.stdout}${set.stderr})`);
  return () => {
    const undo = icacls(['/remove:d', EVERYONE]);
    assert.equal(undo.status, 0, `PS POLICY: the jail's no-delete entries were removed (${undo.stdout}${undo.stderr})`);
  };
}
async function withNoDelete(dir, run) {
  const undo = noDelete(dir);
  try { return await run(); } finally { undo(); }
}
const KILL_STALL_MS = 1_000;
test('KILLED control: a kill that lands late still finds the policy file in the jail (stalled watcher modelled)', { skip: !WIN && 'Windows PowerShell only', timeout: 120_000 }, async (t) => {
  const jail = path.join(tmpRoot, 'jail-late');
  const shared = path.join(tmpRoot, 'shared-late');
  fs.mkdirSync(jail);
  fs.mkdirSync(shared);
  const control = await withNoDelete(jail, () => killedOnFirstFile(jail, shared, false, undefined, t.signal, KILL_STALL_MS));
  procHold().procClose(control.hold);
  assert.match(control.out, /^killed __PSScriptPolicyTest_/, 'PS POLICY control: the PowerShell was killed on its first policy file');
  assert.ok(fs.readdirSync(jail).some((f) => POLICY.test(f)), `PS POLICY control: without psEnv the killed PowerShell leaves its policy file in the jail, however late the kill (${fs.readdirSync(jail)})`);
  // The same late kill with psEnv: the same no-delete jail holds nothing, so the file above is psEnv's absence, not the deny.
  for (const f of fs.readdirSync(jail)) fs.rmSync(path.join(jail, f), { recursive: true, force: true });
  const fixed = await withNoDelete(jail, () => killedOnFirstFile(jail, shared, true, undefined, t.signal, KILL_STALL_MS));
  procHold().procClose(fixed.hold);
  assert.match(fixed.out, /^killed __PSScriptPolicyTest_/, 'PS POLICY: the PowerShell was killed on its first policy file');
  assert.deepEqual(fs.readdirSync(jail), [], 'PS POLICY: with psEnv the late-killed PowerShell leaves nothing in the jail');
});

// FLAKE-PS-POLICY-KILLED-CELL-HANG-108: the hold is opened after the test process is started. When it
// cannot be opened (a tree where the fs-handle addon is not built: the load throws), the helper must not
// leave that process behind: nothing would ever kill it, it never ends by itself (it watches a folder),
// and the test file then never ends either.
test('KILLED helper: when the hold cannot be opened the test process it started is ended, not left running', { skip: !WIN && 'Windows PowerShell only', timeout: 120_000 }, async () => {
  const jail = path.join(tmpRoot, 'jail-nohold');
  const shared = path.join(tmpRoot, 'shared-nohold');
  fs.mkdirSync(jail);
  fs.mkdirSync(shared);
  // This cell's own hold on the started process (so its pid cannot be given to another), then the failure.
  let own, pid;
  const noHold = (p) => { pid = p; own = procHold().procOpen(p); throw new Error('no hold for this cell'); };
  try {
    await assert.rejects(killedOnFirstFile(jail, shared, false, noHold), /no hold for this cell/, 'PS POLICY helper: the failure to open the hold is what the helper reports');
    assert.equal(procHold().procAlive(own), false, `PS POLICY helper: THE TEST PROCESS IS LEFT RUNNING: the helper has given its result and pid ${pid} (killed-inner.cjs) is still alive; nothing will end it and the test file cannot end`);
  } finally {
    // Whatever the helper did, this cell leaves no process: the pid is ours while the hold is open.
    if (own !== undefined) { if (procHold().procAlive(own)) process.kill(pid, 'SIGKILL'); procHold().procClose(own); }
  }
});

// FLAKE-PS-POLICY-KILLED-CELL-HANG-108 (b): a cell that is ended while its test process runs (by its own
// timeout: node:test then aborts the cell's signal, t.signal) must not leave that process behind either.
// The trigger is measured, not timed: the signal is aborted as soon as the hold is open, with the
// process running and nothing reported yet.
test('KILLED helper: when the cell is ended while its test process runs, the process is ended with it', { skip: !WIN && 'Windows PowerShell only', timeout: 120_000 }, async () => {
  const jail = path.join(tmpRoot, 'jail-ended');
  const shared = path.join(tmpRoot, 'shared-ended');
  fs.mkdirSync(jail);
  fs.mkdirSync(shared);
  const ended = new AbortController();
  const reason = new Error('the cell was ended');
  // This cell's own hold as well as the helper's, and the end of the cell one loop turn after both are open.
  let own, pid, aliveThen;
  const open = (p) => {
    pid = p;
    own = procHold().procOpen(p);
    setImmediate(() => { aliveThen = procHold().procAlive(own); ended.abort(reason); });
    return procHold().procOpen(p);
  };
  try {
    const got = await killedOnFirstFile(jail, shared, false, open, ended.signal).then((r) => ({ r }), (e) => ({ e }));
    if (got.r) procHold().procClose(got.r.hold);
    assert.equal(aliveThen, true, 'PS POLICY helper: the test process was running when the cell was ended (the premise of this cell)');
    assert.ok(got.e, `PS POLICY helper: THE TEST PROCESS OUTLIVES ITS CELL: the cell was ended with pid ${pid} (killed-inner.cjs) running, and the helper let it run on (it went on to report ${JSON.stringify(got.r && got.r.out)})`);
    assert.equal(got.e, reason, 'PS POLICY helper: the end of the cell is what the helper reports');
    assert.equal(procHold().procAlive(own), false, `PS POLICY helper: THE TEST PROCESS IS LEFT RUNNING: the helper has given its result and pid ${pid} (killed-inner.cjs) is still alive`);
  } finally {
    // Whatever the helper did, this cell leaves no process: the pid is ours while the hold is open.
    if (own !== undefined) { if (procHold().procAlive(own)) process.kill(pid, 'SIGKILL'); procHold().procClose(own); }
  }
});

test('RUNNER: run-tests sweeps dead pids\' folders at the end of a run', () => {
  const src = fs.readFileSync(path.join(__dirname, 'tools', 'run-tests.cjs'), 'utf8');
  assert.match(src, /const code = run\(\{[\s\S]*?\}\);\s*(?:\/\/[^\n]*\n\s*)*require\('\.\/ps-env\.cjs'\)\.sweepPsTempDirs\(\);\s*process\.exit\(code\);/, 'PS POLICY runner: the sweep runs after run() and before the exit');
});

test('RUNNER: only run-tests opts out of the PowerShell temp folder, and its files keep their temp jail', () => {
  const src = fs.readFileSync(path.join(__dirname, 'tools', 'run-tests.cjs'), 'utf8');
  // INT 1.1.102: cap-199 injects the env (processEnv, defaulting to process.env) for its jobRate tests.
  assert.match(src, /\bprocessEnv = process\.env,/, 'PS POLICY runner: the injected env defaults to process.env');
  assert.match(src, /psEnv\(processEnv, \{ temp: false \}\)/, 'PS POLICY runner: the env for the whole run opts out');
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

// ── PS-POLICY-PRODUCT-TEMP (UHera's audit of 9a25ba89: minor 1, nits 1 and 2) ──────────────────────
// The product's own PowerShell (heavyJob probeProcesses) inherited the test file's jail as TEMP, and
// psCacheDir (guppy-psmac-*) was made in os.tmpdir(), the jail. Now probeProcesses takes the env for
// its PowerShell (tests pass psEnv), and psCacheDir is pid-named under the real temp folder, swept
// with the pstemp folders. Each killer below takes the code under test, so the census can mutate it.
const loadTs = require('./load-ts.cjs');
const HJ_FILE = 'src/main/heavyJob.ts';
const PS_ENV = path.join(__dirname, 'tools', 'ps-env.cjs');

/** `env` without any spelling of the cache key. Under run-tests this file's own env carries the
 *  RUNNER's PSModuleAnalysisCachePath (psEnv(process.env, { temp: false })), and psEnv keeps an
 *  inherited key by design, so a child checking its own psCacheDir must not inherit one (UHera,
 *  MAJOR 1 on 8a8937df: 12/13 under the runner, 13/13 alone). */
function withoutCacheKey(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (k.toUpperCase() !== 'PSMODULEANALYSISCACHEPATH') out[k] = v;
  return out;
}

/** A copy of ps-env.cjs (with `text`) beside a copy of shared-temp.cjs, so a mutant can be required. */
function psEnvCopy(text) {
  const d = fs.mkdtempSync(path.join(tmpRoot, 'psenv-'));
  fs.writeFileSync(path.join(d, 'ps-env.cjs'), text);
  fs.copyFileSync(path.join(__dirname, 'tools', 'shared-temp.cjs'), path.join(d, 'shared-temp.cjs'));
  return path.join(d, 'ps-env.cjs');
}

/** Test code that hands the product's process listing a PowerShell without psEnv: a call with no
 *  psEnv argument, or the bare function as a probe. */
function unguardedProbes(src) {
  const out = [];
  for (const raw of src.split(/\r?\n/)) {
    if (/^\s*(\/\/|\*|\/\*)/.test(raw)) continue;                                  // comments
    const line = raw.replace(/'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g, "''")         // strings: a pin's text
      .replace(/\/(?:\\.|[^/\n\\])*probeProcesses(?:\\.|[^/\n\\])*\//g, '//');     // a regex pin
    if (/^\s*const \{[^}]*\} = /.test(line)) continue;                              // an import
    for (const m of line.matchAll(/\bprobeProcesses\b/g)) {
      if (/^\s*\(\s*(?:require\(''\)\.)?psEnv\(/.test(line.slice(m.index + 'probeProcesses'.length))) continue;
      out.push(raw.trim());
    }
  }
  return out;
}

const PK = {
  /** The product passes its env to the PowerShell: the policy files go to the temp psEnv gave it. */
  async product(M) {
    const dir = psTempDir();
    const seen = new Set();
    const w = fs.watch(dir, (_e, f) => { if (f) seen.add(String(f)); });
    try {
      await M.probeProcesses(psEnv());
      await new Promise((r) => setTimeout(r, 500));
    } finally { w.close(); }
    assert.ok([...seen].some((f) => POLICY.test(f)), `PS POLICY PRODUCT: probeProcesses' PowerShell writes its policy files in the temp it is given (${[...seen]})`);
  },

  /** psCacheDir is pid-named under the real temp folder, never in the jail, and removed at exit. */
  psmac(envPath = PS_ENV) {
    const jail = fs.mkdtempSync(path.join(tmpRoot, 'jail-mac-'));
    const shared = fs.mkdtempSync(path.join(tmpRoot, 'shared-mac-'));
    const script = `const m = require(${JSON.stringify(envPath)}); const e = m.psEnv(); process.stdout.write(JSON.stringify({ dir: m.psCacheDir(), key: e[m.KEY], made: require('fs').existsSync(m.psCacheDir()) }));`;
    const r = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8', windowsHide: true, timeout: 60_000,
      env: nodeEnv({ ...withoutCacheKey(process.env), TEMP: jail, TMP: jail, TMPDIR: jail, GUPPY_SHARED_TEMP: shared })
    });
    assert.equal(r.status, 0, r.stderr);
    const o = JSON.parse(r.stdout);
    assert.ok(o.made, 'PS POLICY PSMAC: psCacheDir is made on first use');
    assert.ok(!under(o.dir, jail), `PS POLICY PSMAC: psCacheDir is not in the jail (${o.dir})`);
    assert.ok(under(o.dir, shared), `PS POLICY PSMAC: psCacheDir is under the real temp folder (${o.dir})`);
    assert.match(path.basename(o.dir), new RegExp(`^guppy-psmac-${r.pid}-`), 'PS POLICY PSMAC: the folder carries its process\'s pid');
    assert.equal(o.key, path.join(o.dir, 'ModuleAnalysisCache'));
    assert.ok(!fs.existsSync(o.dir), 'PS POLICY PSMAC: psCacheDir is removed when the process exits');
    assert.deepEqual(fs.readdirSync(jail), [], 'PS POLICY PSMAC: nothing was written in the jail');
  },

  /** A dead pid's guppy-psmac folder is swept like its guppy-pstemp folder; a live or unnamed one is kept. */
  sweepMac(envPath = PS_ENV) {
    const m = require(envPath);
    const shared = fs.mkdtempSync(path.join(tmpRoot, 'shared-sweep-mac-'));
    const dead = deadPid();
    const names = { dead: `guppy-psmac-${dead}-aaaaaa`, live: `guppy-psmac-${process.ppid}-bbbbbb`, legacy: 'guppy-psmac-cccccc' };
    for (const n of Object.values(names)) fs.mkdirSync(path.join(shared, n, 'ModuleAnalysisCache'), { recursive: true });
    assert.deepEqual(m.sweepPsTempDirs(shared), [names.dead], 'PS POLICY PSMAC SWEEP: the dead pid\'s guppy-psmac folder is removed');
    assert.deepEqual(fs.readdirSync(shared).sort(), [names.legacy, names.live].sort(), 'PS POLICY PSMAC SWEEP: live and fresh unnamed folders are kept');
  },

  /** Older than a day goes, whatever the name says: the legacy unnamed folders (UHera minor 1) and a
   *  folder whose pid a live process reuses (nit 1). A fresh one of each, and other names, stay. */
  sweepStale(envPath = PS_ENV) {
    const m = require(envPath);
    const shared = fs.mkdtempSync(path.join(tmpRoot, 'shared-sweep-stale-'));
    const old = (Date.now() - m.PS_STALE_MS - 60_000) / 1000;
    const names = {
      oldMac: 'guppy-psmac-AbC123', oldTemp: 'guppy-pstemp-x9y8z7', oldReused: `guppy-pstemp-${process.ppid}-oldold`,
      freshMac: 'guppy-psmac-dEf456', freshReused: `guppy-psmac-${process.ppid}-newnew`, oldOther: 'guppy-psmacs-AbC123', oldOwn: `guppy-psmac-${process.pid}-ownown`
    };
    for (const n of Object.values(names)) fs.mkdirSync(path.join(shared, n, 'x'), { recursive: true });
    for (const n of [names.oldMac, names.oldTemp, names.oldReused, names.oldOther, names.oldOwn]) fs.utimesSync(path.join(shared, n), old, old);
    assert.deepEqual(m.sweepPsTempDirs(shared).sort(), [names.oldMac, names.oldTemp, names.oldReused].sort(), 'PS POLICY STALE SWEEP: legacy and pid-reused folders older than a day are removed');
    assert.deepEqual(fs.readdirSync(shared).sort(), [names.freshMac, names.freshReused, names.oldOther, names.oldOwn].sort(), 'PS POLICY STALE SWEEP: fresh, own and other names are kept');
  },

  /** The child that checks its own psCacheDir never inherits a cache key, in any spelling. */
  strip() {
    const env = withoutCacheKey({ PSModuleAnalysisCachePath: 'a', psmoduleanalysiscachepath: 'b', PSMODULEANALYSISCACHEPATH: 'c', KEEP: 'k' });
    assert.deepEqual(env, { KEEP: 'k' }, 'PS POLICY PSMAC ENV: every spelling of the cache key is dropped');
    // And psEnv still keeps an inherited key (by design): which is why the child must not get one.
    const m = require(PS_ENV);
    assert.equal(m.psEnv({ psmoduleanalysiscachepath: 'C:/x' }, { temp: false }).psmoduleanalysiscachepath, 'C:/x', 'PS POLICY PSMAC ENV: psEnv keeps an inherited key');
  },

  /** Every test call of the product listing passes psEnv (heavy-job-lock MF4 LIVE, opaque-196 E2E: its shared helper, HEAVY-LOCK-OPAQUE-196-MUSTC-REALPROBE-108). */
  census() {
    const files = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules' && !e.name.startsWith('.')) walk(p); continue; }
        if (/\.cjs$/.test(e.name) && e.name !== 'ps-policy-temp-leak-198.test.cjs') files.push(p);
      }
    };
    walk(__dirname);
    const callers = [];
    const bad = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      if (!/probeProcesses/.test(src)) continue;
      callers.push(path.relative(__dirname, f).split(path.sep).join('/'));
      for (const u of unguardedProbes(src)) bad.push(`${path.basename(f)}: ${u}`);
    }
    assert.ok(callers.includes('heavy-job-lock.test.cjs') && callers.includes('heavy-lock/opaque-196-e2e.cjs'), `the census sees the callers (${callers})`);
    assert.deepEqual(bad, [], 'PS POLICY PRODUCT CENSUS: every test call of probeProcesses passes psEnv');
  }
};

test('PRODUCT: probeProcesses gives its PowerShell the env it is passed (tests pass psEnv)', { skip: !WIN && 'Windows PowerShell only', timeout: 120_000 }, () => PK.product(loadTs(HJ_FILE)));
test('PRODUCT: probeProcesses defaults to the app\'s own env; index.ts passes no env', () => {
  const hj = fs.readFileSync(path.join(__dirname, '..', HJ_FILE), 'utf8');
  assert.match(hj, /export function probeProcesses\(env: NodeJS\.ProcessEnv = process\.env\): Promise<ProcRow\[\] \| null>/);
  const idx = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  assert.match(idx, /probe: probeProcesses,/);
  assert.match(idx, /listProcesses: probeProcesses,/);
});
test('PSMAC: psCacheDir is pid-named under the real temp folder, not the jail, and removed at exit', () => PK.psmac());
test('PSMAC: a dead pid\'s guppy-psmac folder is swept with the pstemp folders', () => PK.sweepMac());
test('PSMAC: the psCacheDir child gets no inherited cache key (green under run-tests, not only alone)', () => {
  PK.strip();
  // Under the runner this file inherits a key; alone it may not. Either way the killer must pass:
  // run it once more with a decoy key in this process's env, as run-tests gives one.
  const had = Object.prototype.hasOwnProperty.call(process.env, 'PSModuleAnalysisCachePath');
  const prev = process.env.PSModuleAnalysisCachePath;
  process.env.PSModuleAnalysisCachePath = path.join(tmpRoot, 'decoy-runner-cache', 'ModuleAnalysisCache');
  try { PK.psmac(); } finally { if (had) process.env.PSModuleAnalysisCachePath = prev; else delete process.env.PSModuleAnalysisCachePath; }
});
test('SWEEP: folders older than a day go (legacy unnamed, pid reused); fresh, own and other names stay', () => PK.sweepStale());
test('CENSUS: every test call of probeProcesses passes psEnv', () => {
  PK.census();
  const sample = [
    'let rows = await probeProcesses();',                                             // unguarded
    'const b = await broker(t, M, { probe: M.probeProcesses, roots: () => [] });',     // unguarded
    'let ok = await probeProcesses(psEnv());',
    "const c = { probe: () => M.probeProcesses(require('../tools/ps-env.cjs').psEnv()) };",
    "const { parseProcessListing, probeProcesses } = loadTs('src/main/heavyJob.ts');",
    'assert.match(idx, /probe: probeProcesses,/);',
    "for (const t of ['listProcesses: probeProcesses']) {}",
    '  // the product\'s own 10 s box (probeProcesses) can fire'
  ].join('\n');
  assert.deepEqual(unguardedProbes(sample), ['let rows = await probeProcesses();', 'const b = await broker(t, M, { probe: M.probeProcesses, roots: () => [] });'], 'PS POLICY PRODUCT CENSUS: calls and bare probes are caught; guarded calls, imports, pins and comments are not');
});

const PS_MUTANTS = [
  { name: 'P1 the product drops the env', file: HJ_FILE, from: 'maxBuffer: 16 * 1024 * 1024, env }', to: 'maxBuffer: 16 * 1024 * 1024 }', k: (src) => PK.product(loadTs.fromText(HJ_FILE, src)), win: true },
  { name: 'P2 psCacheDir in the jail', file: PS_ENV, from: 'path.join(root, `guppy-psmac-', to: "path.join(require('os').tmpdir(), `guppy-psmac-", k: (src) => PK.psmac(psEnvCopy(src)) },
  { name: 'P3 the sweep skips guppy-psmac', file: PS_ENV, from: '/^guppy-ps(?:temp|mac)-(\\d+)-/', to: '/^guppy-pstemp-(\\d+)-/', k: (src) => PK.sweepMac(psEnvCopy(src)) },
  { name: 'P6 legacy unnamed folders are never swept', file: PS_ENV, from: "} else if (!PS_LEGACY_RE.test(n) || !stale(n)) continue;", to: '} else continue;', k: (src) => PK.sweepStale(psEnvCopy(src)) },
  { name: 'P7 a live pid keeps its folder however old', file: PS_ENV, from: '(alive(Number(m[1])) && !stale(n))', to: 'alive(Number(m[1]))', k: (src) => PK.sweepStale(psEnvCopy(src)) },
  { name: 'P8 the legacy name matches any guppy-ps folder', file: PS_ENV, from: 'const PS_LEGACY_RE = /^guppy-ps(?:temp|mac)-[^-]{6}$/;', to: 'const PS_LEGACY_RE = /^guppy-ps/;', k: (src) => PK.sweepStale(psEnvCopy(src)) },
  { name: 'P4 a test probes without psEnv', file: path.join(__dirname, 'heavy-job-lock.test.cjs'), from: "probeProcesses(require('./tools/ps-env.cjs').psEnv())", to: 'probeProcesses()', k: (src) => assert.equal(unguardedProbes(src).length, 1, 'PS POLICY PRODUCT CENSUS mutant: the census catches it'), census: true },
  { name: 'P5 a test passes the bare listing as its probe', file: path.join(__dirname, 'heavy-lock', 'opaque-196-e2e.cjs'), from: "probe: () => M.probeProcesses(require('../tools/ps-env.cjs').psEnv()),", to: 'probe: M.probeProcesses,', k: (src) => assert.equal(unguardedProbes(src).length, 1, 'PS POLICY PRODUCT CENSUS mutant: the census catches it'), census: true }
];

test('MUTANT CENSUS PS-POLICY-PRODUCT-TEMP: each mutant applies once and dies', { timeout: 300_000 }, async () => {
  for (const m of PS_MUTANTS) {
    if (m.win && !WIN) continue;
    const abs = path.isAbsolute(m.file) ? m.file : path.join(__dirname, '..', m.file);
    const src = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
    assert.equal(src.split(m.from).length, 2, `${m.name}: the anchor is in the source exactly once`);
    const mutated = src.replace(m.from, m.to);
    if (m.census) { m.k(mutated); continue; }
    let died = null;
    try { await m.k(mutated); } catch (e) { died = e; }
    assert.ok(died, `${m.name}: the mutant SURVIVED`);
    assert.match(String(died.message), /PS POLICY/, `${m.name}: died, but not by a named check: ${died.message}`);
  }
});
