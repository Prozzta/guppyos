'use strict';
require('./tools/own-job.cjs');
/**
 * BARE-NODE-TEST-NO-OWNER: a test file started by a bare `node --test <file>` (no runner, no
 * NODE_OPTIONS preload) owns a kill-on-close job of its own, so what a failing test spawned is
 * dead when node is gone, exit or hard kill alike. Before: 32 children of failed bare runs lived
 * on for 5.5 days, and the floor rule "single files only via run-tests.cjs" stood in for a fix.
 * Now every test file requires test/tools/own-job.cjs as its first statement (own-job-guard
 * pins that), and that module joins the process to a job before any test code runs.
 *
 * LIVE: a fixture file whose test spawns a detached node and a cmd->ping, writes their pids,
 * then fails; run by a bare node --test with every runner variable stripped from the env.
 * With the helper the children are dead when node has exited; with a hard kill of the node
 * parent too; with a forged or stale GUPPY_FILE_JOB_PID in the env too (Jim r1 MINOR 1: the
 * mark is verified, not trusted). Without the helper (the defect, kept as the control) the
 * detached node lives on, which is what this test failed on before the helper existed. Mutants
 * of the helper are run the same way. The runner's preload is run on its own with a failing join
 * exe (Jim r1 MINOR 2: it must not mark a join that failed). This file passes under the runner
 * AND under a bare node --test (Jim r1 MAJOR 1). Only pids this test spawned are ever killed,
 * each checked by name + CreationDate.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const R = require('./tools/run-tests.cjs');
const own = require('./tools/own-procs.cjs');
const OJ = require('./tools/own-job.cjs');

const HELPER = path.join(__dirname, 'tools', 'own-job.cjs');
const RUNNER = path.join(__dirname, 'tools', 'run-tests.cjs');
const CSC = path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const LIVE = { skip: process.platform !== 'win32' ? 'Windows only' : !fs.existsSync(CSC) ? 'no in-box csc' : false, timeout: 240_000 };

// ── unit: the helper's decisions, with fakes ───────────────────────────────────────────────────

/** A fake job tool: `check` answers as told, `join` succeeds; every call is recorded. */
function fakeTool(calls, { check = 0 } = {}) {
  return (exe, args) => { calls.push([exe, ...args]); return args[0] === 'check' ? { status: check, stderr: check ? `no job Local\\guppy-testfile-${args[1]} (2)\n` : '' } : { status: 0, stderr: '' }; };
}

test('joinOwnJob: joins once and marks the env; a verified mark is a no-op; off win32 silent', () => {
  const calls = []; const warned = [];
  const env = {};
  const r = OJ.joinOwnJob({ env, platform: 'win32', pid: 4242, prepare: () => ({ exe: 'J.exe' }), spawnSync: fakeTool(calls), warn: (s) => warned.push(s) });
  assert.deepEqual(r, { joined: true, why: null, exe: 'J.exe' });
  assert.deepEqual(calls, [['J.exe', 'join', '4242']], 'no mark: file-job join <own pid>, as the runner preload does, and no check');
  assert.equal(env[OJ.JOINED_ENV], '4242', 'the join is marked for the children, and for a second require');
  assert.deepEqual(warned, []);
  // marked (the runner's preload joined, or an ancestor test file did) and the check verifies it: nothing to do
  calls.length = 0;
  const r2 = OJ.joinOwnJob({ env, platform: 'win32', pid: 4343, prepare: () => ({ exe: 'J.exe' }), spawnSync: fakeTool(calls), warn: (s) => warned.push(s) });
  assert.deepEqual(r2, { joined: false, why: 'in the job of 4242 already', exe: 'J.exe' });
  assert.deepEqual(calls, [['J.exe', 'check', '4242', '4343']], 'the mark is checked: that job exists and holds this process');
  assert.equal(env[OJ.JOINED_ENV], '4242', 'the mark names the owner, not this process');
  assert.deepEqual(warned, []);
  // not win32: no jobs, silent, no tool
  const r3 = OJ.joinOwnJob({ env: {}, platform: 'linux', prepare: () => assert.fail('no build off win32'), spawnSync: () => assert.fail('no join off win32'), warn: (s) => warned.push(s) });
  assert.deepEqual(r3, { joined: false, why: 'not win32', exe: null });
  assert.deepEqual(warned, []);
});

test('joinOwnJob: a mark that does not verify (forged, stale, or set by a failed join) is said and the file joins anyway', () => {
  for (const [mark, status] of [['1', 3], ['99999', 3], ['4242', 6]]) {
    const calls = []; const warned = [];
    const env = { [OJ.JOINED_ENV]: mark };
    const r = OJ.joinOwnJob({ env, platform: 'win32', pid: 5151, argv1: 'x.test.cjs', prepare: () => ({ exe: 'J.exe' }), spawnSync: fakeTool(calls, { check: status }), warn: (s) => warned.push(s) });
    assert.deepEqual(r, { joined: true, why: null, exe: 'J.exe' }, `mark ${mark}: joined`);
    assert.deepEqual(calls, [['J.exe', 'check', mark, '5151'], ['J.exe', 'join', '5151']], `mark ${mark}: checked, then joined`);
    assert.equal(env[OJ.JOINED_ENV], '5151', `mark ${mark}: the mark now names this process, the real owner`);
    assert.equal(warned.length, 1);
    assert.match(warned[0], new RegExp(`^\\[own-job\\] x\\.test\\.cjs: GUPPY_FILE_JOB_PID=${mark} names no job holding this process \\(.*\\): joining a job of its own$`));
  }
});

test('joinOwnJob: no job tool or a failed join is said once on stderr and never throws; the env stays unmarked', () => {
  const warned = [];
  const env = {};
  const r = OJ.joinOwnJob({ env, platform: 'win32', pid: 1, argv1: 'x.test.cjs', prepare: () => ({ exe: null, why: 'no in-box csc at C:/nope' }), spawnSync: () => assert.fail('no join without a tool'), warn: (s) => warned.push(s) });
  assert.deepEqual(r, { joined: false, why: 'no in-box csc at C:/nope', exe: null });
  assert.equal(env[OJ.JOINED_ENV], undefined);
  const r2 = OJ.joinOwnJob({ env, platform: 'win32', pid: 1, argv1: 'x.test.cjs', prepare: () => { throw new Error('csc exploded'); }, spawnSync: () => assert.fail('no join'), warn: (s) => warned.push(s) });
  assert.equal(r2.why, 'csc exploded');
  const r3 = OJ.joinOwnJob({ env, platform: 'win32', pid: 1, argv1: 'x.test.cjs', prepare: () => ({ exe: 'J.exe' }), spawnSync: () => ({ status: 1, stderr: 'file-job: a job for 1 is there already\n' }), warn: (s) => warned.push(s) });
  assert.deepEqual(r3, { joined: false, why: 'file-job: a job for 1 is there already', exe: 'J.exe' });
  assert.equal(env[OJ.JOINED_ENV], undefined, 'a failed join leaves no mark (a child would be told it is owned)');
  assert.equal(warned.length, 3);
  for (const w of warned) assert.match(w, /^\[own-job\] x\.test\.cjs .*what a failing test starts can outlive it$/);
  assert.match(warned[0], /no in-box csc/); assert.match(warned[1], /csc exploded/); assert.match(warned[2], /there already/);
});

test('this process is owned either way: under the runner the preload joined and the helper verified its mark; bare, the helper joined', { skip: process.platform !== 'win32' ? 'Windows only' : !fs.existsSync(CSC) ? 'no in-box csc' : false }, () => {
  assert.equal(process.env.GUPPY_FILE_JOB_PID, String(process.pid), 'the mark names this process: set by file-job-preload.cjs under the runner, by own-job.cjs in a bare run');
  if (OJ.result.joined) {
    // Jim r1 MAJOR 1: a bare node --test of this very file (no NODE_OPTIONS preload): the helper joined
    assert.equal(OJ.result.why, null);
  } else {
    assert.equal(OJ.result.why, `in the job of ${process.pid} already`, 'the preload\'s mark verified (file-job check), so the helper did nothing');
  }
  assert.match(OJ.result.exe || '', /guppy-file-job-[0-9a-f]+\.exe$/i, 'the job tool was found (or built) either way');
});

// ── LIVE: a bare node --test of a file that spawns and fails ───────────────────────────────────

// The fixture: one test that spawns a detached node (libuv puts a non-detached child in node's own
// job; a detached one escapes it, the orphan shape) and a cmd -> ping, writes {detached, cmd, bornMs},
// then fails (FAIL) or hangs (HANG, for the hard kill of its node parent).
const fixture = (helperLine, mode) => `'use strict';
${helperLine}
const test = require('node:test');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
test('spawns, then ${mode}', async () => {
  const d = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore', windowsHide: true });
  d.unref();
  const c = spawn('cmd.exe', ['/d', '/c', 'ping -n 90 127.0.0.1 > nul'], { stdio: 'ignore', windowsHide: true });
  c.unref();
  fs.writeFileSync(process.env.BNTO_PIDS, JSON.stringify({ detached: d.pid, cmd: c.pid, bornMs: Date.now() }));
  ${mode === 'HANG' ? 'setInterval(() => {}, 1000); await new Promise(() => {});' : "throw new Error('the test fails, its children still running');"}
});
`;
const req = (file) => `require(${JSON.stringify(file.split(path.sep).join('/'))});`;

/** A bare environment: no runner preload, no job tool, no mark, no test context; then `extra` on top. */
function bareEnv(extra) {
  const env = { ...process.env };
  for (const k of ['NODE_OPTIONS', 'GUPPY_FILE_JOB_EXE', 'GUPPY_FILE_JOB_OPT', 'GUPPY_FILE_JOB_PID', 'NODE_TEST_CONTEXT']) delete env[k];
  return Object.assign(env, extra);
}
const rowOf = (pid, bornMs) => { const r = own.lookupPids([pid])[0]; return r && Math.abs(r.created - bornMs) <= own.BIRTH_SLACK_MS ? r : undefined; };
const until = async (what, ok, ms = 30_000) => {
  const t0 = Date.now(); let last = null;
  for (;;) {
    try { const v = ok(); if (v) return v; last = null; } catch (e) { last = e; }
    if (Date.now() - t0 > ms) throw new Error(`timed out: phase "${what}" after ${Date.now() - t0} ms${last ? `; last check failed: ${String(last.message).split('\n')[0]}` : ''}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};
const readPids = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
/** The children the fixture reported, as rows now (pid + birth), and the ping under cmd. */
function childRows(pids) {
  const d = rowOf(pids.detached, pids.bornMs);
  const c = rowOf(pids.cmd, pids.bornMs);
  const ping = c ? own.childrenOf(own.processTable(`ParentProcessId = ${c.pid}`), c).find((r) => /^ping/i.test(r.name)) : undefined;
  return { detached: d, cmd: c, ping };
}
/**
 * The fixture dir, removed with retries: a child the job just killed (ping, cwd there) is out of the process
 * table before its handles are closed (file-job.cs, EBUSY-195), and a first rmdir can meet ENOTEMPTY/EBUSY.
 * Jim's r2 bare runs left such dirs in %TEMP%; the fixture's node --test also no longer runs with cwd = dir.
 */
const rmDir = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
/** Kill what is left of the fixture's children (and the node parent), each verified by pid + CreationDate. */
function sweep(rows) { return own.killVerified(rows.filter(Boolean), {}); }

async function bareRun(dir, name, helperLine, { mode = 'FAIL', env: extra = {} } = {}) {
  const file = path.join(dir, `${name}.test.cjs`);
  fs.writeFileSync(file, fixture(helperLine, mode));
  const pidsFile = path.join(dir, `${name}.pids.json`);
  const env = bareEnv({ BNTO_PIDS: pidsFile, ...extra });
  if (mode === 'FAIL') {
    const r = spawnSync(process.execPath, ['--test', file], { cwd: os.tmpdir(), env, encoding: 'utf8', windowsHide: true, timeout: 180_000 });
    const pids = readPids(pidsFile);
    assert.ok(pids, `${name}: the fixture spawned and wrote its pids (exit ${r.status}, stderr ${JSON.stringify((r.stderr || '').slice(-400))})`);
    assert.equal(r.status, 1, `${name}: the bare node --test failed, as the fixture's test does`);
    return { pids, stderr: r.stderr || '', stdout: r.stdout || '' };
  }
  // HANG: node --test runs on; hand back the parent to kill
  const p = spawn(process.execPath, ['--test', file], { cwd: os.tmpdir(), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const parentBornMs = Date.now();
  let errText = ''; p.stderr.setEncoding('utf8'); p.stderr.on('data', (d) => { errText += d; }); p.stdout.setEncoding('utf8'); p.stdout.on('data', (d) => { errText += d; });
  let exit = null; p.once('exit', (code, signal) => { exit = { code, signal }; });
  const pids = await until('fixture pids', () => readPids(pidsFile) || (exit && assert.fail(`node --test exited early: ${JSON.stringify(exit)} ${errText.slice(-300)}`)), 120_000);
  return { pids, parent: { pid: p.pid, bornMs: parentBornMs }, stderr: () => errText, exited: () => exit };
}

test('LIVE: with the helper, a bare node --test of a failing, spawning file leaves no child behind (control without it: the detached node lives on)', LIVE, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bnto-'));
  const leftovers = [];
  try {
    // the helper, exactly as every test file has it (own-job-guard), by absolute path from the temp dir
    const fixed = await bareRun(dir, 'fixed', req(HELPER));
    const after = childRows(fixed.pids);
    leftovers.push(after.detached, after.cmd, after.ping);
    assert.equal((fixed.stderr + fixed.stdout).includes('[own-job]'), false, `the helper joined without a word: ${(fixed.stderr + fixed.stdout).slice(-600)}`);
    assert.equal(after.detached, undefined, `THE DETACHED NODE ${fixed.pids.detached} IS DEAD WHEN THE BARE node --test HAS EXITED`);
    assert.equal(after.cmd, undefined, `cmd ${fixed.pids.cmd} is dead`);
    assert.equal(after.ping, undefined, 'cmd\'s ping is dead');

    // the defect, as a control: the same file without the helper line
    const bare = await bareRun(dir, 'control', '// (no own-job: the shape before BARE-NODE-TEST-NO-OWNER)');
    const left = childRows(bare.pids);
    leftovers.push(left.detached, left.cmd, left.ping);
    assert.ok(left.detached, `control: without the helper the detached node ${bare.pids.detached} outlives node --test (the orphan this card is about)`);
    const swept = sweep([left.detached, left.cmd, left.ping]);
    assert.ok(swept.killed.length >= 1, 'the control\'s orphan is killed, verified by pid + CreationDate');
    assert.equal(swept.skipped.length, 0, 'nothing of ours changed identity');
    await until('control swept', () => !rowOf(bare.pids.detached, bare.pids.bornMs), 20_000);
  } finally {
    sweep(leftovers);
    rmDir(dir);
  }
});

test('LIVE: a forged, stale or foreign GUPPY_FILE_JOB_PID does not disable the owner: the mark fails its check, the file joins, the orphan is reaped', LIVE, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bnto-'));
  const leftovers = [];
  let holder = null;
  try {
    // a pid that was a process and is gone: a cmd that exited (its job name, if ever there, is gone with it)
    const dead = spawnSync('cmd.exe', ['/d', '/c', 'exit 0'], { windowsHide: true, stdio: 'ignore' });
    assert.equal(dead.status, 0);
    assert.ok(dead.pid, 'the dead pid is known');
    await until('dead pid gone', () => own.lookupPids([dead.pid]).length === 0, 20_000);
    // a LIVE job that does not hold us (Jim r2 K2: the check must read IsProcessInJob, not just find the
    // job): a bare node that requires own-job.cjs (so it owns Local\guppy-testfile-<its pid>) and waits
    const { exe } = R.prepareFileJob();
    assert.ok(exe);
    holder = spawn(process.execPath, ['-e', `require(${JSON.stringify(HELPER.split(path.sep).join('/'))}); setInterval(() => {}, 1000)`], { env: bareEnv({}), stdio: 'ignore', windowsHide: true });
    holder.bornMs = Date.now();
    await until('holder joined its job', () => spawnSync(exe, ['check', String(holder.pid), String(holder.pid)], { windowsHide: true, stdio: 'ignore' }).status === 0, 60_000);
    const notInIt = spawnSync(exe, ['check', String(holder.pid), String(process.pid)], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
    assert.equal(notInIt.status, 6, `file-job check: the holder's job is there but does not hold this process: ${notInIt.stderr}`);
    for (const [label, mark, reason] of [['forged', '1', 'no job Local\\\\+guppy-testfile-1 \\(\\d+\\)'], ['stale', String(dead.pid), `no job Local\\\\+guppy-testfile-${dead.pid} \\(\\d+\\)`], ['foreign (a live job of another file)', String(holder.pid), `process \\d+ is not in the job of ${holder.pid}`]]) {
      const r = await bareRun(dir, `mark-${label}`, req(HELPER), { env: { GUPPY_FILE_JOB_PID: mark } });
      const now = childRows(r.pids);
      leftovers.push(now.detached, now.cmd, now.ping);
      // node --test reports the file's stderr through its reporter (stdout) in some versions: look in both
      assert.match(r.stderr + r.stdout, new RegExp(`\\[own-job\\] .*GUPPY_FILE_JOB_PID=${mark} names no job holding this process \\(${reason}\\): joining a job of its own`), `${label} mark ${mark}: said with the tool's reason (TAP doubles the backslash)`);
      assert.equal(now.detached, undefined, `${label} mark ${mark}: the detached node ${r.pids.detached} is dead when the bare node --test has exited`);
      assert.equal(now.cmd, undefined, `${label} mark ${mark}: cmd is dead`);
      assert.equal(now.ping, undefined, `${label} mark ${mark}: ping is dead`);
    }
  } finally {
    if (holder) sweep([rowOf(holder.pid, holder.bornMs)]);
    sweep(leftovers);
    rmDir(dir);
  }
});

test('LIVE: a hard kill of the bare node --test parent takes the file\'s children with it', LIVE, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bnto-'));
  let run = null;
  try {
    run = await bareRun(dir, 'hardkill', req(HELPER), { mode: 'HANG' });
    await new Promise((r) => setTimeout(r, 1500));
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code; } };
    const diag = () => `exit ${JSON.stringify(run.exited())}, stderr ${JSON.stringify(run.stderr().slice(-300))}, kill0 parent ${alive(run.parent.pid)} detached ${alive(run.pids.detached)} cmd ${alive(run.pids.cmd)}`;
    const before = childRows(run.pids);
    assert.ok(before.detached && before.cmd, `the fixture's children are up: ${JSON.stringify(run.pids)}; rows now ${JSON.stringify(own.lookupPids([run.pids.detached, run.pids.cmd]))}; parent ${JSON.stringify(own.lookupPids([run.parent.pid]))} born ${run.parent.bornMs}; ${diag()}`);
    // the node parent, verified by pid + CreationDate before Stop-Process -Force (own-procs checks again)
    const parent = rowOf(run.parent.pid, run.parent.bornMs);
    assert.ok(parent && /^node/i.test(parent.name), `the node --test parent ${run.parent.pid} is ours (${parent && parent.name})`);
    const k = own.killVerified([parent], {});
    assert.deepEqual(k.skipped, [], 'the parent still had our name and birth');
    await until('parent gone', () => run.exited() || !rowOf(run.parent.pid, run.parent.bornMs), 30_000);
    await until('children gone', () => { const now = childRows(run.pids); return !now.detached && !now.cmd && !now.ping; }, 30_000)
      .catch((e) => { const now = childRows(run.pids); assert.fail(`${e.message}: still alive ${JSON.stringify({ detached: !!now.detached, cmd: !!now.cmd, ping: !!now.ping })}`); });
  } finally {
    if (run) sweep([rowOf(run.parent.pid, run.parent.bornMs), ...Object.values(childRows(run.pids))]);
    rmDir(dir);
  }
});

// ── the runner's preload on its own: it marks a join only after that join succeeded ──────────────

/** Run the preload as the runner does (--require, a child test context, the exe and opt in the env) and read the mark back. */
function preloadRun(exe) {
  const opt = `--require "${R.FILE_JOB_PRELOAD.split(path.sep).join('/')}"`;
  const env = bareEnv({ NODE_TEST_CONTEXT: 'child', NODE_OPTIONS: opt, GUPPY_FILE_JOB_EXE: exe, GUPPY_FILE_JOB_OPT: opt });
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({ mark: process.env.GUPPY_FILE_JOB_PID || null, pid: process.pid, opts: process.env.NODE_OPTIONS || null }))'], { env, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  assert.equal(r.status, 0, `the preloaded node ran: ${r.stderr}`);
  return { ...JSON.parse(r.stdout), stderr: r.stderr || '' };
}

test('file-job-preload.cjs: a failed join leaves GUPPY_FILE_JOB_PID unset (Jim J7: marking anyway would make own-job skip its own join)', { skip: process.platform !== 'win32' ? 'Windows only' : false }, () => {
  // node itself as the "job tool": `node join <pid>` finds no module "join" and exits 1 with a message
  const failed = preloadRun(process.execPath);
  assert.equal(failed.mark, null, 'no mark after a failed join');
  assert.match(failed.stderr, /\[test-runner\] .* is not in a job of its own \(.*Cannot find module.*join.*\): a hung run of it is killed from a snapshot/s, 'the failure is said with the tool\'s message');
  assert.equal(failed.opts, null, 'the preload took itself back out of NODE_OPTIONS even so');
  // and the mark is set only by that else branch: a tool that does not exist fails the same way
  const missing = preloadRun(path.join(os.tmpdir(), `bnto-no-such-tool-${process.pid}.exe`));
  assert.equal(missing.mark, null);
  assert.match(missing.stderr, /\[test-runner\] .* is not in a job of its own \(.*ENOENT.*\)/);
});

test('LIVE file-job-preload.cjs: a successful join is marked with the file\'s own pid, and own-job then verifies it', LIVE, () => {
  const job = R.prepareFileJob();
  assert.ok(job.exe, job.why);
  const ok = preloadRun(job.exe);
  assert.equal(ok.mark, String(ok.pid), 'the mark names the joined process');
  assert.equal(ok.stderr, '');
  // the same env, now with the helper required as a test file does: the mark verifies and the helper does nothing
  const opt = `--require "${R.FILE_JOB_PRELOAD.split(path.sep).join('/')}"`;
  const env = bareEnv({ NODE_TEST_CONTEXT: 'child', NODE_OPTIONS: opt, GUPPY_FILE_JOB_EXE: job.exe, GUPPY_FILE_JOB_OPT: opt });
  const r = spawnSync(process.execPath, ['-e', `const OJ = require(${JSON.stringify(HELPER.split(path.sep).join('/'))}); process.stdout.write(JSON.stringify({ result: OJ.result, mark: process.env.GUPPY_FILE_JOB_PID, pid: process.pid }))`], { env, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  assert.equal(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout);
  assert.equal(got.mark, String(got.pid));
  assert.equal(got.result.joined, false);
  assert.equal(got.result.why, `in the job of ${got.pid} already`, 'file-job check verified the preload\'s mark');
  assert.equal(r.stderr, '', 'no [own-job] word');
});

// ── mutants of the helper: each one lets the orphan live, and the dead-child check catches it ──

const MUTANTS = [
  ['never joins (platform check always true)', "if (platform !== 'win32') return", 'if (true) return'],
  ['asks the tool to kill instead of join', "['join', String(pid)]", "['kill', String(pid), '0']"],
  ['does not run the join on require', 'const result = joinOwnJob();', 'const result = { joined: false, why: "never called", exe: null };'],
  ['trusts a mark without the check', 'if (c.status === 0) return', 'if (true) return', { GUPPY_FILE_JOB_PID: '1' }],
  ['reads a failed check as verified', 'if (c.status === 0) return', 'if (c.status !== 0) return', { GUPPY_FILE_JOB_PID: '1' }],
  // (a check against the wrong process dies in the unit test: the fake tool records ['check', mark, own pid])
];

test('LIVE: mutants of own-job.cjs are caught: without a real join the detached node survives the bare run', LIVE, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bnto-'));
  const src = fs.readFileSync(HELPER, 'utf8');
  const leftovers = [];
  const survivors = [];
  try {
    for (const [i, [name, from, to, env = {}]] of MUTANTS.entries()) {
      assert.equal(src.split(from).length, 2, `mutant "${name}": anchor found once`);
      const mutated = src.replace(from, to).replace("require('./run-tests.cjs')", `require(${JSON.stringify(RUNNER.split(path.sep).join('/'))})`);
      const mfile = path.join(dir, `own-job-m${i}.cjs`);
      fs.writeFileSync(mfile, mutated);
      const r = await bareRun(dir, `mutant${i}`, req(mfile), { env });
      const now = childRows(r.pids);
      leftovers.push(now.detached, now.cmd, now.ping);
      if (!now.detached) survivors.push(name);
      sweep([now.detached, now.cmd, now.ping]);
    }
    assert.deepEqual(survivors, [], 'every mutant is killed (its orphan is seen alive)');
  } finally {
    sweep(leftovers);
    rmDir(dir);
  }
});
