'use strict';
/**
 * LOAD-FLAKES-178: a hung test file is killed with everything it started, whenever each process was
 * born. The watchdog's tree kill came from a process snapshot taken seconds earlier under load, so a
 * child born between the snapshot and the kill (cmd's ping, with the file's temp folder as its cwd)
 * outlived the kill and kept the folder in use (EBUSY). Each file now joins a kill-on-close job of
 * its own before any test code runs (file-job-preload.cjs, file-job.cs), and the watchdog
 * terminates that job.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const R = require('./tools/run-tests.cjs');
const W = require('./tools/file-watchdog.cjs');
const own = require('./tools/own-procs.cjs');

const CSC = path.join(process.env.WINDIR || 'C:/Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

// ── the runner and the watchdog (fakes) ────────────────────────────────────────────────────

function runWith(fileJob) {
  const calls = []; const errs = []; const dogs = [];
  const code = R.run({ testDir: 'test', readdir: () => ['a.test.cjs'], spawn: (args, opts) => { calls.push({ args, opts }); return { status: 0 }; }, log: () => {}, err: (l) => errs.push(l), timeoutMs: 5000, eventsFile: 'ev', readFile: () => '', removeFile: () => {}, watchdog: (ms, file, jobExe) => { dogs.push(jobExe); return { stop: () => {} }; }, fileJob });
  return { code, calls, errs, dogs };
}

test('with the job tool, every file of the run loads the preload and the watchdog gets the tool', () => {
  const r = runWith(() => ({ exe: 'C:/t/guppy-file-job.exe' }));
  const env = r.calls[0].opts.env;
  assert.match(env.NODE_OPTIONS, /--require "[^"]*file-job-preload\.cjs"/);
  assert.equal(env.GUPPY_FILE_JOB_EXE, 'C:/t/guppy-file-job.exe');
  assert.ok(env.NODE_OPTIONS.includes(env.GUPPY_FILE_JOB_OPT), 'the preload knows the exact text to take back out');
  assert.deepEqual(r.dogs, ['C:/t/guppy-file-job.exe']);
  assert.equal(r.errs.length, 0);
});

test('without the job tool the run says so on stderr, once, and the watchdog falls back to its snapshot kill', () => {
  const r = runWith(() => ({ exe: null, why: 'no in-box csc at X' }));
  const loud = r.errs.filter((l) => /per-file jobs are unavailable \(no in-box csc at X\)/.test(l));
  assert.equal(loud.length, 1, r.errs.join('\n'));
  assert.ok(!String(r.calls[0].opts.env.NODE_OPTIONS || '').includes('file-job-preload'));
  assert.deepEqual(r.dogs, [null]);
});

test('the watchdog kills a due file through its job; the snapshot tree only when it has none; never a recycled pid', () => {
  const procs = [{ pid: 10, ppid: 1, name: 'node.exe', cmd: 'x', startedAt: 5000 }];
  const runs = []; const trees = [];
  const deps = (status) => ({ jobExe: 'J', run: (exe, args) => { runs.push([exe, ...args]); return { status }; }, tree: (p, pid) => { trees.push(pid); return { killed: [] }; } });
  assert.equal(W.killFile(procs, 10, deps(0)).by, 'job');
  assert.deepEqual(runs.at(-1), ['J', 'kill', '10', '5000'], 'with the birth the snapshot saw');
  assert.equal(trees.length, 0);
  assert.equal(W.killFile(procs, 10, deps(3)).by, 'tree', 'no job: the snapshot tree');
  assert.equal(W.killFile(procs, 10, deps(4)).by, 'none', 'another process has the pid: nothing');
  assert.equal(W.killFile(procs, 10, { tree: (p, pid) => { trees.push(pid); return {}; } }).by, 'tree', 'no tool: the snapshot tree');
});

// ── LIVE: the real tool, a file process and what it starts ────────────────────────────────

const LIVE = { skip: process.platform !== 'win32' ? 'Windows only' : false, timeout: 180_000 };

test('LIVE: the in-box csc is on this box and builds the job tool (the fallback is not the normal path here)', LIVE, () => {
  assert.ok(fs.existsSync(CSC), `no in-box csc at ${CSC}`);
  const j = R.prepareFileJob();
  assert.ok(j.exe && fs.existsSync(j.exe), JSON.stringify(j));
});

// A test file's process, as node --test starts it: the preload joins its job; on "go" it starts
// cmd, which starts ping (the libuv shape: node puts cmd in its own job, which lets a child of cmd
// break away silently), and a detached node. It prints the pids it started.
const FILE = `
const { spawn } = require('child_process');
process.stdout.write('up\\n');
process.stdin.on('data', () => {
  const c = spawn('cmd.exe', ['/d', '/c', 'ping -n 60 127.0.0.1 > nul'], { stdio: 'ignore', windowsHide: true });
  const d = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { detached: true, stdio: 'ignore', windowsHide: true });
  d.unref();
  process.stdout.write(JSON.stringify({ cmd: c.pid, detached: d.pid }) + '\\n');
});
setInterval(() => {}, 1000);
`;

// A file that, on "go", runs a program asking Windows for a child outside its job
// (CREATE_BREAKAWAY_FROM_JOB), and prints what the program got: {pid} or {denied: <error>}.
const FILE_BREAKAWAY = `
const { execFileSync } = require('child_process');
process.stdout.write('up\\n');
process.stdin.on('data', () => { process.stdout.write(execFileSync(process.env.LF178_SPAWNER, { encoding: 'utf8', windowsHide: true }).trim() + '\\n'); });
setInterval(() => {}, 1000);
`;

const SPAWNER = `
using System; using System.Runtime.InteropServices; using System.Text;
static class S {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct SI { public int cb; public string r, d, t; public int x, y, xs, ys, xc, yc, fill, flags; public short sw, cb2; public IntPtr r2, i, o, e; }
  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr hp, ht; public int pid, tid; }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref SI si, out PI pi);
  static void Main() {
    SI si = new SI(); si.cb = Marshal.SizeOf(typeof(SI)); PI pi;
    bool ok = CreateProcessW(null, new StringBuilder("ping -n 60 127.0.0.1"), IntPtr.Zero, IntPtr.Zero, false, 0x01000000 | 0x08000000, IntPtr.Zero, null, ref si, out pi);
    Console.WriteLine(ok ? "{\\"pid\\":" + pi.pid + "}" : "{\\"denied\\":" + Marshal.GetLastWin32Error() + "}");
  } }
`;

async function startFile(dir, exe, src = FILE, env = {}) {
  const opt = `--require "${R.FILE_JOB_PRELOAD.split(path.sep).join('/')}"`;
  fs.writeFileSync(path.join(dir, 'f.cjs'), src);
  const f = spawn(process.execPath, [path.join(dir, 'f.cjs')], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, ...env, NODE_TEST_CONTEXT: 'child', NODE_OPTIONS: opt, GUPPY_FILE_JOB_EXE: exe, GUPPY_FILE_JOB_OPT: opt } });
  const bornMs = Date.now();
  let out = ''; let errText = '';
  f.stdout.setEncoding('utf8'); f.stdout.on('data', (d) => { out += d; });
  f.stderr.setEncoding('utf8'); f.stderr.on('data', (d) => { errText += d; });
  await until('file up', () => out.includes('up\n'));
  assert.equal(errText, '', 'the file joined its job');
  return { f, bornMs, started: async () => { f.stdin.write('go\n'); await until('children', () => /\{.*\}/.test(out)); return JSON.parse(/\{.*\}/.exec(out)[0]); } };
}

const until = async (what, ok, ms = 30_000) => { const end = Date.now() + ms; while (!ok()) { if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 50)); } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pingOf = (cmdPid) => own.processTable().find((r) => r.ppid === cmdPid && /^ping/i.test(r.name));

/** Leftovers of a failed run: only what is still the process we saw (pid and birth). */
function sweep(rows) { own.killVerified(rows.filter(Boolean), {}); }

test('LIVE: a child born between the watchdog\'s snapshot and its kill dies with the file (node -> cmd -> ping, and a detached node)', LIVE, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf178-'));
  let file = null; let rows = [];
  try {
    const { exe } = R.prepareFileJob();
    assert.ok(exe, 'the job tool');
    file = await startFile(dir, exe);
    const procs = W.snapshot();                // the watchdog's snapshot: the file, none of its children yet
    assert.ok(procs.some((p) => p.pid === file.f.pid));
    const kids = await file.started();         // born after the snapshot, before the kill
    let ping = null;
    await until('ping', () => (ping = pingOf(kids.cmd)) != null);
    assert.ok(!procs.some((p) => p.pid === ping.pid || p.pid === kids.cmd), 'not in the snapshot');
    rows = own.processTable().filter((r) => [kids.cmd, kids.detached, ping.pid].includes(r.pid));
    const r = W.killFile(procs, file.f.pid, { jobExe: exe });
    assert.equal(r.by, 'job');
    for (const [name, pid] of [['file', file.f.pid], ['cmd', kids.cmd], ['ping', ping.pid], ['detached node', kids.detached]]) {
      assert.ok(!alive(pid), `${name} ${pid} is gone when the kill returns`);
    }
    fs.rmSync(dir, { recursive: true }); // nothing holds the folder (the EBUSY of LOAD-FLAKES-178)
  } finally {
    sweep(rows);
    if (file && file.f.exitCode === null && file.f.signalCode === null) { const g = new Promise((res) => file.f.once('exit', res)); file.f.kill(); await g; }
    for (let i = 0; i < 100 && fs.existsSync(dir); i++) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { await new Promise((res) => setTimeout(res, 100)); } }
  }
});

test('LIVE: the kill takes nothing when the pid is no longer the process the snapshot saw (a recycled pid)', LIVE, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf178-'));
  let file = null;
  try {
    const { exe } = R.prepareFileJob();
    file = await startFile(dir, exe);
    const row = W.snapshot().find((p) => p.pid === file.f.pid);
    const r = W.killFile([{ ...row, startedAt: row.startedAt - 5000 }], file.f.pid, { jobExe: exe, tree: () => ({ killed: [] }) });
    assert.equal(r.by, 'none');
    assert.ok(alive(file.f.pid), 'the file still runs');
  } finally {
    if (file && file.f.exitCode === null && file.f.signalCode === null) { const g = new Promise((res) => file.f.once('exit', res)); file.f.kill(); await g; }
    for (let i = 0; i < 100 && fs.existsSync(dir); i++) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { await new Promise((res) => setTimeout(res, 100)); } }
  }
});

test('LIVE: a child that asks to leave the file\'s job (CREATE_BREAKAWAY_FROM_JOB) is refused, or dies with the file', LIVE, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf178-'));
  let file = null; let rows = [];
  try {
    const { exe } = R.prepareFileJob();
    const spawner = path.join(dir, 'spawner.exe');
    fs.writeFileSync(path.join(dir, 'spawner.cs'), SPAWNER);
    const c = require('node:child_process').spawnSync(CSC, ['-nologo', `-out:${spawner}`, path.join(dir, 'spawner.cs')], { encoding: 'utf8', windowsHide: true });
    assert.equal(c.status, 0, `csc: ${c.stdout}${c.stderr}`);
    file = await startFile(dir, exe, FILE_BREAKAWAY, { LF178_SPAWNER: spawner });
    const procs = W.snapshot();
    const got = await file.started();
    if (got.pid) {
      rows = own.processTable().filter((r) => r.pid === got.pid);
      assert.equal(W.killFile(procs, file.f.pid, { jobExe: exe }).by, 'job');
      assert.ok(!alive(got.pid), `the child ${got.pid} that asked to break away is gone when the kill returns`);
    } else {
      assert.equal(got.denied, 5, 'refused: the job does not allow breakaway (ERROR_ACCESS_DENIED)');
    }
  } finally {
    sweep(rows);
    if (file && file.f.exitCode === null && file.f.signalCode === null) { const g = new Promise((res) => file.f.once('exit', res)); file.f.kill(); await g; }
    for (let i = 0; i < 100 && fs.existsSync(dir); i++) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { await new Promise((res) => setTimeout(res, 100)); } }
  }
});

test('LIVE: a file killed alone (node\'s own --test-timeout backstop) takes what it started with it', LIVE, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lf178-'));
  let file = null; let rows = [];
  try {
    const { exe } = R.prepareFileJob();
    file = await startFile(dir, exe);
    const kids = await file.started();
    let ping = null;
    await until('ping', () => (ping = pingOf(kids.cmd)) != null);
    rows = own.processTable().filter((r) => [kids.cmd, kids.detached, ping.pid].includes(r.pid));
    const gone = new Promise((res) => file.f.once('exit', res));
    file.f.kill();
    await gone;
    await until('the file\'s tree goes with it', () => ![kids.cmd, ping.pid, kids.detached].some(alive), 10_000);
  } finally {
    sweep(rows);
    for (let i = 0; i < 100 && fs.existsSync(dir); i++) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { await new Promise((res) => setTimeout(res, 100)); } }
  }
});
