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
 * parent too. Without the helper (the defect, kept as the control) the detached node lives on,
 * which is what this test failed on before the helper existed. Mutants of the helper are run
 * the same way. Only pids this test spawned are ever killed, each checked by name + CreationDate.
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

test('joinOwnJob: joins once, marks the env, and is a no-op where a job already owns the process', () => {
  const calls = []; const warned = [];
  const spawnOk = (exe, args) => { calls.push([exe, ...args]); return { status: 0, stderr: '' }; };
  const env = {};
  const r = OJ.joinOwnJob({ env, platform: 'win32', pid: 4242, prepare: () => ({ exe: 'J.exe' }), spawnSync: spawnOk, warn: (s) => warned.push(s) });
  assert.deepEqual(r, { joined: true, why: null, exe: 'J.exe' });
  assert.deepEqual(calls, [['J.exe', 'join', '4242']], 'file-job join <own pid>, as the runner preload does');
  assert.equal(env[OJ.JOINED_ENV], '4242', 'the join is marked for the children, and for a second require');
  assert.deepEqual(warned, []);
  // marked already (the runner's preload joined, or an ancestor test file did): nothing to do
  const r2 = OJ.joinOwnJob({ env, platform: 'win32', pid: 4343, prepare: () => assert.fail('no build when marked'), spawnSync: () => assert.fail('no join when marked'), warn: (s) => warned.push(s) });
  assert.equal(r2.joined, false);
  assert.match(r2.why, /in the job of 4242 already/);
  assert.equal(env[OJ.JOINED_ENV], '4242', 'the mark names the owner, not this process');
  // not win32: no jobs, silent
  const r3 = OJ.joinOwnJob({ env: {}, platform: 'linux', prepare: () => assert.fail('no build off win32'), spawnSync: () => assert.fail('no join off win32'), warn: (s) => warned.push(s) });
  assert.deepEqual(r3, { joined: false, why: 'not win32', exe: null });
  assert.deepEqual(warned, []);
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

test('under the runner: the preload joined and marked this process, so the helper did nothing here', { skip: process.platform !== 'win32' ? 'Windows only' : !process.env.GUPPY_FILE_JOB_PID ? 'not under run-tests.cjs (bare run: the helper joined instead)' : false }, () => {
  assert.equal(process.env.GUPPY_FILE_JOB_PID, String(process.pid), 'file-job-preload.cjs marks its own join');
  assert.equal(OJ.result.joined, false);
  assert.match(OJ.result.why, new RegExp(`in the job of ${process.pid} already`));
  const src = fs.readFileSync(R.FILE_JOB_PRELOAD, 'utf8');
  assert.match(src, /process\.env\.GUPPY_FILE_JOB_PID = String\(process\.pid\)/, 'the preload sets the mark after a successful join');
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

/** A bare environment: no runner preload, no job tool, no mark, no test context. */
function bareEnv(extra) {
  const env = { ...process.env, ...extra };
  for (const k of ['NODE_OPTIONS', 'GUPPY_FILE_JOB_EXE', 'GUPPY_FILE_JOB_OPT', 'GUPPY_FILE_JOB_PID', 'NODE_TEST_CONTEXT']) delete env[k];
  return env;
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
/** Kill what is left of the fixture's children (and the node parent), each verified by pid + CreationDate. */
function sweep(rows) { return own.killVerified(rows.filter(Boolean), {}); }

async function bareRun(dir, name, helperLine, { mode = 'FAIL' } = {}) {
  const file = path.join(dir, `${name}.test.cjs`);
  fs.writeFileSync(file, fixture(helperLine, mode));
  const pidsFile = path.join(dir, `${name}.pids.json`);
  const env = bareEnv({ BNTO_PIDS: pidsFile });
  if (mode === 'FAIL') {
    const r = spawnSync(process.execPath, ['--test', file], { cwd: dir, env, encoding: 'utf8', windowsHide: true, timeout: 180_000 });
    const pids = readPids(pidsFile);
    assert.ok(pids, `${name}: the fixture spawned and wrote its pids (exit ${r.status}, stderr ${JSON.stringify((r.stderr || '').slice(-400))})`);
    assert.equal(r.status, 1, `${name}: the bare node --test failed, as the fixture's test does`);
    return { pids, stderr: r.stderr || '', stdout: r.stdout || '' };
  }
  // HANG: node --test runs on; hand back the parent to kill
  const p = spawn(process.execPath, ['--test', file], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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
    assert.equal(fixed.stderr.includes('[own-job]'), false, `the helper joined without a word: ${fixed.stderr.slice(-300)}`);
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
    fs.rmSync(dir, { recursive: true, force: true });
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
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── mutants of the helper: each one lets the orphan live, and the dead-child check catches it ──

const MUTANTS = [
  ['never joins (platform check always true)', "if (platform !== 'win32') return", 'if (true) return'],
  ['treats an unmarked env as marked', 'if (env[JOINED_ENV]) return', 'if (!env[JOINED_ENV]) return'],
  ['asks the tool to kill instead of join', "['join', String(pid)]", "['kill', String(pid), '0']"],
  ['does not run the join on require', 'const result = joinOwnJob();', 'const result = { joined: false, why: "never called", exe: null };'],
];

test('LIVE: mutants of own-job.cjs are caught: without a real join the detached node survives the bare run', LIVE, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bnto-'));
  const src = fs.readFileSync(HELPER, 'utf8');
  const leftovers = [];
  const survivors = [];
  try {
    for (const [i, [name, from, to]] of MUTANTS.entries()) {
      assert.equal(src.split(from).length, 2, `mutant "${name}": anchor found once`);
      const mutated = src.replace(from, to).replace("require('./run-tests.cjs')", `require(${JSON.stringify(RUNNER.split(path.sep).join('/'))})`);
      const mfile = path.join(dir, `own-job-m${i}.cjs`);
      fs.writeFileSync(mfile, mutated);
      const r = await bareRun(dir, `mutant${i}`, req(mfile));
      const now = childRows(r.pids);
      leftovers.push(now.detached, now.cmd, now.ping);
      if (!now.detached) survivors.push(name);
      sweep([now.detached, now.cmd, now.ping]);
    }
    assert.deepEqual(survivors, [], 'every mutant is killed (its orphan is seen alive)');
  } finally {
    sweep(leftovers);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
