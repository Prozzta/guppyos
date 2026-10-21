'use strict';
// @heavy-lock live: it compiles and spawns real CPU-limit helpers (about 26 s in the 1.1.91 FULL). HEAVY-LOCK-LIVE-FILE-192: one run of this file takes the heavy slot.
/**
 * HEAVY-CPU-OPTIONS-191, option 2 (half the logical processors) vs the Electron harness.
 *
 * With --disable-gpu a harness Electron runs WebGL on SwiftShader, whose worker threads ask for every
 * processor of the machine. Inside a heavy job limited to half of them those threads cannot start and
 * the GPU process waits for them forever, so every App scenario stalled (heavycpu/ROOTCAUSE.md). On
 * Windows a test now always starts Electron from a view of its dist folder with a SwiftShader.ini that
 * keeps the workers on the processors option 2 allows (electron-bin.cjs), limit or not, because the
 * limit can be turned on while a suite runs; flags and renderer are unchanged.
 *
 * The RENDERED test runs a real App scenario inside a real job built by the helper Guppy ships
 * (resources/heavyjob/guppy-heavyjob.cs, compiled here with the in-box csc) with the half-processor limit.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, relative } = require('node:path');
const { harnessCpuMask, halfCpuMask, swiftShaderMask, swiftShaderView } = require('./electron-harness/electron-bin.cjs');
const own = require('./tools/own-procs.cjs');

const root = join(__dirname, '..');
const CSC = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

test('the SwiftShader.ini mask: the job\'s processors below bit 31 (SwiftShader reads a 32-bit signed int)', () => {
  assert.equal(swiftShaderMask(0xffffn), 65535, 'half of 32: processors 0-15');
  assert.equal(swiftShaderMask(0xffffffffn), 0x7fffffff, 'half of 64: the 31 lowest, never a negative int');
  assert.equal(swiftShaderMask(0x1n), 1);
  assert.throws(() => swiftShaderMask(0xffff00000000n), /no processor below 31/);
});

test('option 2\'s processors: the lowest floor(n/2), at least 1, counting at most 64', () => {
  assert.equal(halfCpuMask(32), 0xffffn);
  assert.equal(halfCpuMask(3), 1n);
  assert.equal(halfCpuMask(1), 1n);
  assert.equal(halfCpuMask(128), 0xffffffffn, 'the helper counts at most 64');
});

test('HARNESS_CPU_MASK, when the runner set it, is the answer; nothing else is asked', () => {
  assert.equal(harnessCpuMask({ HARNESS_CPU_MASK: '65535' }), 65535n);
  assert.equal(harnessCpuMask({ HARNESS_CPU_MASK: '' }), null);
});

test('the view: every file of the dist folder (hard links where the volume allows) plus SwiftShader.ini; made once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hcpu-view-'));
  try {
    const dist = join(dir, 'dist');
    mkdirSync(join(dist, 'locales'), { recursive: true });
    writeFileSync(join(dist, 'electron.exe'), 'exe');
    writeFileSync(join(dist, 'v8_context_snapshot.bin'), 'snap');
    writeFileSync(join(dist, 'locales', 'en-US.pak'), 'pak');
    const exe = swiftShaderView(join(dist, 'electron.exe'), 0xffffn, join(dir, 'tmp'));
    const view = join(exe, '..');
    assert.equal(readFileSync(join(view, 'SwiftShader.ini'), 'utf8'), '[Processor]\nAffinityMask=65535\n');
    for (const f of ['electron.exe', 'v8_context_snapshot.bin', join('locales', 'en-US.pak')]) {
      assert.equal(readFileSync(join(view, f), 'utf8'), readFileSync(join(dist, f), 'utf8'), f);
    }
    if (process.platform === 'win32') assert.equal(statSync(join(view, 'electron.exe')).nlink, 2, 'a hard link, not a copy');
    assert.equal(swiftShaderView(join(dist, 'electron.exe'), 0xffffn, join(dir, 'tmp')), exe, 'the same view again');
    assert.deepEqual(readdirSync(join(dir, 'tmp', 'guppy-electron-view')).length, 1, 'no part folder left');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the test runner asks once and passes the answer to every test file', () => {
  const { run } = require('./tools/run-tests.cjs');
  const dir = mkdtempSync(join(tmpdir(), 'hcpu-runner-'));
  try {
    writeFileSync(join(dir, 'a.test.cjs'), '');
    for (const [mask, want] of [[0xffffn, '65535'], [null, '']]) {
      let seen = null;
      let asked = 0;
      const saved = process.env.HARNESS_CPU_MASK;
      delete process.env.HARNESS_CPU_MASK;
      try {
        run({ testDir: dir, cwd: dir, spawn: (args, opts) => { seen = opts.env.HARNESS_CPU_MASK; return { status: 0 }; },
          watchdog: () => ({ stop() {} }), log() {}, err() {}, cpuMask: () => { asked += 1; return mask; } });
      } finally {
        if (saved === undefined) delete process.env.HARNESS_CPU_MASK; else process.env.HARNESS_CPU_MASK = saved;
      }
      assert.equal(seen, want);
      assert.equal(asked, 1);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// HALFCORES-SUITE-198: node's availableParallelism ignores affinity on Windows (32 inside a 16-CPU
// job), so a FULL in the half job ran 31 files on 16 processors. The runner sizes from the mask.
test('the test runner sizes its concurrency and start slots from the mask; no mask leaves both unchanged', () => {
  const { run, maskCpus, startSlots } = require('./tools/run-tests.cjs');
  assert.equal(maskCpus('65535'), 16);
  assert.equal(maskCpus('1'), 1);
  assert.equal(maskCpus(String(0xaaaan)), 8);
  assert.equal(maskCpus(String((1n << 64n) - 1n)), 64);
  for (const none of ['', undefined, '0', 'x', '-1', '0x10']) assert.equal(maskCpus(none), null, String(none));
  const dir = mkdtempSync(join(tmpdir(), 'hcpu-size-'));
  const saved = { mask: process.env.HARNESS_CPU_MASK, slots: process.env.GUPPY_START_SLOTS };
  try {
    writeFileSync(join(dir, 'a.test.cjs'), '');
    delete process.env.GUPPY_START_SLOTS;
    for (const [mask, conc, slots] of [[0xffffn, ['--test-concurrency=15'], 4], [1n, ['--test-concurrency=1'], 2], [null, [], startSlots({})]]) {
      delete process.env.HARNESS_CPU_MASK;
      let args = null;
      let gateSlots = null;
      run({ testDir: dir, cwd: dir, spawn: (a) => { args = a; return { status: 0 }; }, startGate: (o) => { gateSlots = o.slots; return null; },
        watchdog: () => ({ stop() {} }), log() {}, err() {}, cpuMask: () => mask });
      assert.deepEqual(args.filter((a) => a.startsWith('--test-concurrency')), conc, `mask ${mask}`);
      assert.equal(gateSlots, slots, `mask ${mask}: start slots`);
    }
  } finally {
    for (const [k, v] of [['HARNESS_CPU_MASK', saved.mask], ['GUPPY_START_SLOTS', saved.slots]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CENSUS: every Electron a test starts comes from harnessElectron, never require(\'electron\') directly', () => {
  const bad = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
      if (!/\.(c|m)?js$/.test(e.name) || p === join(__dirname, 'electron-harness', 'electron-bin.cjs')) continue;
      const src = readFileSync(p, 'utf8');
      // A path to the executable (an assignment or a spawn argument); a destructuring require is an Electron main's own API.
      if (/(?:=|spawn\w*\(|execFile\w*\()\s*require\(\s*['"]electron['"]\s*\)(?!\s*\.)/.test(src.replace(/const\s*\{[^}]*\}\s*=\s*require\(\s*['"]electron['"]\s*\)/g, ''))) bad.push(relative(root, p));
    }
  };
  walk(__dirname);
  assert.deepEqual(bad, [], 'these start Electron without the CPU-limit view: use require(\'./electron-harness/electron-bin.cjs\').harnessElectron()');
});

const CHILD = `
const { join } = require('node:path');
const { runScenario } = require(${JSON.stringify(join(root, 'test', 'electron-harness', 'run.cjs'))});
const { harnessCpuMask } = require(${JSON.stringify(join(root, 'test', 'electron-harness', 'electron-bin.cjs'))});
(async () => {
  const limited = harnessCpuMask() !== null;
  const r = await runScenario(${JSON.stringify(join(root, 'test', 'electron-harness', 'scenarios', 'app-recovery.tsx'))}, { timeoutMs: 90_000 });
  process.stdout.write('HCPU ' + JSON.stringify({ limited, ok: r.ok, error: r.error || null, picker: r.normal && r.normal.picker }) + '\\n');
})().catch((e) => { process.stdout.write('HCPU ' + JSON.stringify({ ok: false, error: String(e && e.message || e).slice(0, 2000) }) + '\\n'); });
`;

/** The helper Guppy ships, compiled here with the in-box csc. */
function buildHelper(dir) {
  const exe = join(dir, 'guppy-heavyjob.exe');
  const c = spawnSync(CSC, ['-nologo', '-O', `-out:${exe}`, join(root, 'resources', 'heavyjob', 'guppy-heavyjob.cs')], { encoding: 'utf8', windowsHide: true });
  assert.equal(c.status, 0, `csc: ${c.stdout}${c.stderr}`);
  return exe;
}

const FLIP_CHILD = `
const fs = require('node:fs');
const { runScenario } = require(${JSON.stringify(join(root, 'test', 'electron-harness', 'run.cjs'))});
const { harnessCpuMask } = require(${JSON.stringify(join(root, 'test', 'electron-harness', 'electron-bin.cjs'))});
(async () => {
  // As the test runner does: the mask is asked once, at the start, before any limit.
  process.env.HARNESS_CPU_MASK = String(harnessCpuMask() ?? '');
  const atStart = process.env.HARNESS_CPU_MASK;
  fs.writeFileSync(process.argv[2], 'ready');
  while (!fs.existsSync(process.argv[3])) await new Promise((r) => setTimeout(r, 100));
  const after = String(harnessCpuMask({}) ?? '');
  const r = await runScenario(${JSON.stringify(join(root, 'test', 'electron-harness', 'scenarios', 'app-recovery.tsx'))}, { timeoutMs: 90_000 });
  process.stdout.write('HCPU ' + JSON.stringify({ atStart, after, ok: r.ok, error: r.error || null, picker: r.normal && r.normal.picker }) + '\\n');
})().catch((e) => { process.stdout.write('HCPU ' + JSON.stringify({ ok: false, error: String(e && e.message || e).slice(0, 2000) }) + '\\n'); });
`;

// HALFCORES-SUITE-198: the suite itself may run inside a heavy job (the shipped half-processors option
// on a FULL), and Windows ANDs the affinity of every job a process is nested in. So the child starts
// with this file's own mask (not necessarily none), the flip ends at that mask AND half, and the
// flip of THIS job is proven on the job's own limits (the helper's query), which no outer job hides.
test('RENDERED (real App), live flip: a suite started with its own job unlimited, half then turned on for that job, then a scenario starts: it does not stall (Jim MUST-1)',
  { skip: process.platform !== 'win32' ? 'heavy jobs are Windows-only' : !existsSync(CSC) ? `no in-box csc at ${CSC}` : false, timeout: 600_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hcpu-flip-'));
    let serve = null;
    let child = null;
    let bornMs = 0;
    try {
      const exe = buildHelper(dir);
      const script = join(dir, 'child.cjs');
      writeFileSync(script, FLIP_CHILD);
      const ready = join(dir, 'ready');
      const go = join(dir, 'go');
      const env = { ...process.env };
      delete env.HARNESS_CPU_MASK;
      const id = `hcpu-flip-${process.pid}-${Date.now().toString(36)}`;
      // Guppy's side: the job is made with no limit and held by serve, as begin() does.
      serve = spawn(exe, ['serve'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      const ask = (line) => new Promise((r) => { serve.stdout.once('data', (d) => r(String(d))); serve.stdin.write(`${line}\n`); });
      const json = async (line) => { const j = JSON.parse(await ask(line)); assert.equal(j.ok, true, `${line}: ${JSON.stringify(j)}`); return j; };
      const { logical } = await json('cpus');
      const ambient = harnessCpuMask({}); // this file's own processors, fresh (null = all of them)
      const all = logical >= 64 ? (1n << 64n) - 1n : (1n << BigInt(logical)) - 1n;
      assert.match(await ask(`create ${id} 0 0`), /"ok":true/);
      assert.deepEqual(await json(`query ${id}`), { ok: true, background: false, half: false, mask: null }, 'the job starts with no limit of its own');
      child = spawn(exe, ['join', id, '0', '0;', process.execPath, script, ready, go], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      bornMs = Date.now();
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      const closed = new Promise((r) => child.on('close', r));
      const until = Date.now() + 60_000;
      while (!existsSync(ready) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
      assert.ok(existsSync(ready), `the child never got ready.\n${out}\n${err}`);
      // Settings, option 2 turned on while the suite runs: the job the child is in gets the half limit.
      assert.match(await ask(`set ${id} 0 1`), /"ok":true/);
      assert.deepEqual(await json(`query ${id}`), { ok: true, background: false, half: true, mask: String(halfCpuMask(logical)) }, 'the flip set THIS job\'s half limit');
      const started = Date.now();
      writeFileSync(go, '');
      const code = await closed;
      const at = out.lastIndexOf('HCPU ');
      assert.ok(at >= 0, `no result (exit ${code}).\n${out}\n${err}`);
      const r = JSON.parse(out.slice(at + 5).split('\n')[0]);
      assert.equal(r.atStart, String(ambient ?? ''), 'the child started with this file\'s own processors: its job added no limit');
      assert.equal(r.after, String((ambient ?? all) & halfCpuMask(logical)), 'after the flip: this file\'s processors AND half');
      assert.equal(r.ok, true, r.error);
      assert.equal(r.picker, true, 'the App rendered its launch picker');
      assert.ok(Date.now() - started < 90_000, `took ${Date.now() - started} ms`);
    } finally {
      // A failed step must not leave the child waiting for its go file.
      // Only what this child started (pid + birth, own-procs), never a ParentProcessId walk.
      if (child && child.exitCode === null) own.killOwnTree({ pid: child.pid, bornMs, name: 'guppy-heavyjob.exe' });
      // The helper .exe in the folder stays locked until serve has exited: wait for it before removing.
      if (serve && serve.exitCode === null && serve.signalCode === null) {
        const gone = new Promise((r) => serve.once('exit', r));
        serve.kill();
        await gone;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

test('RENDERED (real App) inside a heavy job limited to half the processors: the scenario runs, it does not stall',
  { skip: process.platform !== 'win32' ? 'heavy jobs are Windows-only' : !existsSync(CSC) ? `no in-box csc at ${CSC}` : false, timeout: 600_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hcpu-harness-'));
    try {
      const exe = buildHelper(dir);
      const script = join(dir, 'child.cjs');
      writeFileSync(script, CHILD);
      const env = { ...process.env };
      delete env.HARNESS_CPU_MASK; // the child must find the limit itself, as a real heavy call does
      const id = `hcpu-test-${process.pid}-${Date.now().toString(36)}`;
      // The cmd form of the join line: the helper joins itself to the job and runs the rest inside it.
      const child = spawn(exe, ['join', id, '0', '1;', process.execPath, script], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      const started = Date.now();
      // Without the view the scenario's own 90 s guard fires (the GPU process never answers); a
      // healthy run takes a few seconds.
      const code = await new Promise((r) => child.on('close', r));
      const at = out.lastIndexOf('HCPU ');
      assert.ok(at >= 0, `no result (exit ${code}).\n${out}\n${err}`);
      const r = JSON.parse(out.slice(at + 5).split('\n')[0]);
      assert.doesNotMatch(err, /limits not applied/, err);
      assert.equal(r.limited, true, 'the child is inside the half-processor limit');
      assert.equal(r.ok, true, r.error);
      assert.equal(r.picker, true, 'the App rendered its launch picker');
      assert.ok(Date.now() - started < 90_000, `took ${Date.now() - started} ms`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
