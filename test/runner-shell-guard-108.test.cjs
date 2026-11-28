'use strict';
require('./tools/own-job.cjs');
// MUTANT-JOURNAL-GATE (god 5cc045/ed8032): this suite loads run-tests.cjs, a file a census mutates in place;
// refuse a tree a killed census left mutated, before anything is read.
require('./tools/mutant-runner-helper.cjs').gate(__filename);
/**
 * ELECTRON-LEG-RUNNER-SHELL-GUARD-108: the test runner does not depend on how the caller's shell
 * started it.
 *
 *  1  An Electron that would start as an app (process.versions.electron set, ELECTRON_RUN_AS_NODE not
 *     '1') is refused: exit 2 and a named message, before anything else runs.
 *     A  the pure check.
 *     B  LIVE, without launching Electron: a plain console node is started on the runner with a
 *        preload that sets process.versions.electron, and no ELECTRON_RUN_AS_NODE. It exits 2 with the
 *        name. The control (the same launch with ELECTRON_RUN_AS_NODE=1) reaches run() and exits 1 on
 *        its unmatched filter, so B bites on the env key and nothing else.
 *  2  The env handed to node --test has exactly one path key on Windows, spelled PATH (a caller with
 *     Path, or with both, still hands on PATH). Other platforms are left alone.
 *  3  The env handed to node --test names a plain console Node in GUPPY_TEST_CONSOLE_NODE: the runner's
 *     own exe on plain node, node on PATH under Electron. A caller's own value is kept.
 *  4  The colour env is covered by RUNNER-NOCOLOR-FORCECOLOR-STDERR (test/colour-env.test.cjs C);
 *     it is not repeated here.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const R = require('./tools/run-tests.cjs');
const { consoleNode } = require('./tools/console-node.cjs');

const RUNNER = path.join(__dirname, 'tools', 'run-tests.cjs');
const NAME = /ELECTRON-LEG-RUNNER-SHELL-GUARD/;
const rmDir = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
const pathKeys = (env) => Object.keys(env).filter((k) => k.toUpperCase() === 'PATH');

/** run() with a fake spawn; returns the exit code, the envs handed to node --test, and the err lines. */
function fakeRun(dir, extra) {
  const handed = [];
  const errs = [];
  const code = R.run({ testDir: 'test', filters: ['a'], readdir: () => ['a.test.cjs'], jobRate: () => 0, eventsFile: path.join(dir, 'ev'),
    spawn: (args, opts) => { handed.push({ ...opts.env }); return { status: 0 }; },
    log: () => {}, err: (l) => errs.push(l), timeoutMs: 5000, watchdog: () => ({ stop: () => {} }), fileJob: () => ({ exe: path.join(dir, 'gone.exe') }), ...extra });
  return { code, handed, errs };
}
/** A caller env with no path key and no console-node key. */
function bareEnv(extra) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.toUpperCase() === 'PATH' || k === 'GUPPY_TEST_CONSOLE_NODE') delete env[k];
  return Object.assign(env, extra);
}

// ── 1: refuse an Electron that would start as an app ──────────────────────────────────────────

test('1A electronLegRefusal: Electron without ELECTRON_RUN_AS_NODE=1 is refused by name; Node, or Electron as Node, is not', () => {
  assert.equal(typeof R.electronLegRefusal, 'function', 'run-tests.cjs exports electronLegRefusal');
  for (const env of [{}, { ELECTRON_RUN_AS_NODE: '' }, { ELECTRON_RUN_AS_NODE: '0' }]) {
    const msg = R.electronLegRefusal({ versions: { node: '24.0.0', electron: '39.0.0' }, env });
    assert.match(String(msg), NAME, `refused for env ${JSON.stringify(env)}`);
    assert.match(String(msg), /ELECTRON_RUN_AS_NODE=1/, 'the message says what to set');
  }
  assert.equal(R.electronLegRefusal({ versions: { node: '24.0.0', electron: '39.0.0' }, env: { ELECTRON_RUN_AS_NODE: '1' } }), null, 'Electron as Node runs');
  assert.equal(R.electronLegRefusal({ versions: { node: '26.0.0' }, env: {} }), null, 'plain node runs');
  assert.equal(R.REFUSAL_EXIT, 2);
});

test('1B LIVE: the runner started as an Electron app (faked: no Electron is launched) exits 2 by name; control with ELECTRON_RUN_AS_NODE=1 reaches run()', { timeout: 240_000 }, () => {
  const node = consoleNode().file;   // a plain console node on both legs: never electron.exe
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-guard-1b-'));
  try {
    const preload = path.join(dir, 'fake-electron.cjs');
    fs.writeFileSync(preload, "Object.defineProperty(process, 'versions', { value: Object.freeze({ ...process.versions, electron: '39.0.0' }) });\n");
    const launch = (extra) => {
      const env = { ...process.env };
      for (const k of ['NODE_OPTIONS', 'NODE_TEST_CONTEXT', 'ELECTRON_RUN_AS_NODE', 'GUPPY_FILE_JOB_EXE', 'GUPPY_FILE_JOB_OPT', 'GUPPY_FILE_JOB_PID']) delete env[k];
      return spawnSync(node, ['--require', preload, RUNNER, 'zz-runner-shell-guard-no-such-file'], { cwd: path.dirname(__dirname), env: Object.assign(env, extra), encoding: 'utf8', windowsHide: true, timeout: 180_000 });
    };
    const refused = launch({});
    assert.equal(refused.error, undefined, `the fixture started (${refused.error})`);
    assert.equal(refused.status, 2, `THE RUNNER REFUSES WITH EXIT 2 (got ${refused.status}, stderr ${JSON.stringify((refused.stderr || '').slice(-400))})`);
    assert.match(refused.stderr, NAME, 'THE REFUSAL IS NAMED ON STDERR');
    assert.doesNotMatch(refused.stdout + refused.stderr, /running \d+|no test file matches/, 'nothing past the refusal ran');
    const control = launch({ ELECTRON_RUN_AS_NODE: '1' });
    assert.equal(control.status, 1, `control: run() ran and refused the unmatched filter (stderr ${JSON.stringify((control.stderr || '').slice(-400))})`);
    assert.match(control.stderr, /no test file matches: zz-runner-shell-guard-no-such-file/, 'control: it is the filter that ended it');
    assert.doesNotMatch(control.stderr, NAME, 'control: no refusal');
  } finally { rmDir(dir); }
});

// ── 2: exactly PATH ───────────────────────────────────────────────────────────────────────────

test('2 runner (win32): a caller env with Path, or with Path and PATH, hands node --test exactly PATH; other platforms are untouched', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-guard-2-'));
  try {
    for (const [label, extra, want] of [
      ['Path only', { Path: 'C:\\a;C:\\b' }, 'C:\\a;C:\\b'],
      ['path only', { path: 'C:\\c' }, 'C:\\c'],
      ['PATH and Path', { Path: 'C:\\second', PATH: 'C:\\first' }, 'C:\\first'],
    ]) {
      const processEnv = bareEnv(extra);
      const r = fakeRun(dir, { processEnv, platform: 'win32' });
      assert.equal(r.code, 0, label);
      assert.ok(r.handed.length >= 1, `${label}: the runner started node --test`);
      for (const env of r.handed) {
        assert.deepEqual(pathKeys(env), ['PATH'], `${label}: THE CHILD ENV HAS EXACTLY ONE PATH KEY, SPELLED PATH`);
        assert.equal(env.PATH, want, `${label}: its value is the caller's (PATH first, when both)`);
      }
      assert.deepEqual(pathKeys(processEnv).sort(), Object.keys(extra).sort(), `${label}: the caller's object is not touched`);
    }
    const r = fakeRun(dir, { processEnv: bareEnv({ Path: '/x', PATH: '/y' }), platform: 'linux' });
    for (const env of r.handed) assert.deepEqual([env.Path, env.PATH], ['/x', '/y'], 'linux: two different variables, both kept');
  } finally { rmDir(dir); }
});

// ── 3: GUPPY_TEST_CONSOLE_NODE ────────────────────────────────────────────────────────────────

test('3 runner: node --test is told which plain Node to use (own exe on node, node on PATH under Electron; a caller value is kept)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-guard-3-'));
  try {
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    const onPath = path.join(bin, 'node.exe');
    fs.writeFileSync(onPath, '');
    const exe = path.join(dir, 'own', 'node.exe');
    const electron = path.join(dir, 'e', 'electron.exe');
    const nodeV = { node: '26.0.0' };
    const electronV = { node: '24.0.0', electron: '39.0.0' };
    for (const [label, extra, want] of [
      ['plain node', { processEnv: bareEnv({ PATH: bin }), versions: nodeV, execPath: exe }, exe],
      ['Electron leg', { processEnv: bareEnv({ PATH: `${path.join(dir, 'none')};${bin}`, ELECTRON_RUN_AS_NODE: '1' }), versions: electronV, execPath: electron }, onPath],
      ['caller value', { processEnv: bareEnv({ PATH: bin, GUPPY_TEST_CONSOLE_NODE: 'K:\\mine\\node.exe' }), versions: electronV, execPath: electron }, 'K:\\mine\\node.exe'],
    ]) {
      const r = fakeRun(dir, { platform: 'win32', ...extra });
      assert.equal(r.code, 0, label);
      assert.ok(r.handed.length >= 1, `${label}: the runner started node --test`);
      for (const env of r.handed) assert.equal(env.GUPPY_TEST_CONSOLE_NODE, want, `${label}: THE CHILD ENV NAMES THE PLAIN NODE`);
      assert.equal(extra.processEnv.GUPPY_TEST_CONSOLE_NODE, label === 'caller value' ? 'K:\\mine\\node.exe' : undefined, `${label}: the caller's object is not touched`);
    }
    const none = fakeRun(dir, { platform: 'win32', processEnv: bareEnv({ PATH: path.join(dir, 'none'), ELECTRON_RUN_AS_NODE: '1' }), versions: electronV, execPath: electron });
    assert.equal(none.code, 0, 'no node on PATH does not stop the run: a test that needs one fails by name (console-node.cjs)');
    for (const env of none.handed) assert.equal(env.GUPPY_TEST_CONSOLE_NODE, undefined, 'never electron.exe');
    assert.ok(none.errs.some((l) => /GUPPY_TEST_CONSOLE_NODE/.test(l) && NAME.test(l)), 'the runner says by name that it found no plain node');
  } finally { rmDir(dir); }
});
