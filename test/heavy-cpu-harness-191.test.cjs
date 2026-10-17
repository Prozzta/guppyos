'use strict';
/**
 * HEAVY-CPU-OPTIONS-191, option 2 (half the logical processors) vs the Electron harness.
 *
 * With --disable-gpu a harness Electron runs WebGL on SwiftShader, whose worker threads ask for every
 * processor of the machine. Inside a heavy job limited to half of them those threads cannot start and
 * the GPU process waits for them forever, so every App scenario stalled (heavycpu/ROOTCAUSE.md). Inside
 * such a job a test now starts Electron from a view of its dist folder with a SwiftShader.ini that
 * keeps the workers on processors the job allows (electron-bin.cjs); flags and renderer are unchanged.
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
const { harnessCpuMask, swiftShaderMask, swiftShaderView } = require('./electron-harness/electron-bin.cjs');

const root = join(__dirname, '..');
const CSC = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

test('the SwiftShader.ini mask: the job\'s processors below bit 31 (SwiftShader reads a 32-bit signed int)', () => {
  assert.equal(swiftShaderMask(0xffffn), 65535, 'half of 32: processors 0-15');
  assert.equal(swiftShaderMask(0xffffffffn), 0x7fffffff, 'half of 64: the 31 lowest, never a negative int');
  assert.equal(swiftShaderMask(0x1n), 1);
  assert.throws(() => swiftShaderMask(0xffff00000000n), /no processor below 31/);
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

test('RENDERED (real App) inside a heavy job limited to half the processors: the scenario runs, it does not stall',
  { skip: process.platform !== 'win32' ? 'heavy jobs are Windows-only' : !existsSync(CSC) ? `no in-box csc at ${CSC}` : false, timeout: 600_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hcpu-harness-'));
    try {
      const exe = join(dir, 'guppy-heavyjob.exe');
      const c = spawnSync(CSC, ['-nologo', '-O', `-out:${exe}`, join(root, 'resources', 'heavyjob', 'guppy-heavyjob.cs')], { encoding: 'utf8', windowsHide: true });
      assert.equal(c.status, 0, `csc: ${c.stdout}${c.stderr}`);
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
