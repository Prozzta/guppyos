'use strict';
require('./tools/own-job.cjs');
// MUTANT-JOURNAL-GATE (god 5cc045/ed8032): this suite loads run-tests.cjs, a file a census mutates in place;
// refuse a tree a killed census left mutated, before anything is read.
require('./tools/mutant-runner-helper.cjs').gate(__filename);
/**
 * RUNNER-NOCOLOR-FORCECOLOR-STDERR: a test result does not depend on the colour variables of the
 * caller's shell.
 *
 * Node prints "Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set." on
 * stderr when both are set. Guppy gives every agent terminal FORCE_COLOR=1; a caller that also had
 * NO_COLOR made each node child of a test print that line, and 15 tests that expect an empty
 * stderr failed on the Electron leg. The fix removes the three variables in two places
 * (test/tools/colour-env.cjs), and each place has its own pin here:
 *
 *  A  the pure function.
 *  B  own-job.cjs applies it on load. LIVE: a fixture that requires own-job as its first statement
 *     is started directly (plain `node <file>`: no runner, no `node --test`, so it never queues on
 *     a heavy slot) with FORCE_COLOR=1 and NO_COLOR=1, and starts a node child with NO env option,
 *     the shape of the 15 failing tests. The child asks about colour (Node 26 warns only then;
 *     Electron's Node 24 warns at process start). Its stderr is empty and the names are gone. The
 *     control (the same fixture without the helper) must print the warning, or B proves nothing.
 *  C  run-tests.cjs applies it to the env it hands to `node --test`: run() with an injected
 *     processEnv that carries the names and a fake spawn.
 *
 * Not asserted, and stated in CONTRIBUTING.md: the fixture's OWN stderr. Under Electron's Node 24 a
 * directly started file prints the warning once before its first line runs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { nodeEnv } = require('./tools/node-env.cjs');
const R = require('./tools/run-tests.cjs');
const { scrubColourEnv, COLOUR_KEYS } = require('./tools/colour-env.cjs');

const HELPER = path.join(__dirname, 'tools', 'own-job.cjs');
const WARNING = /'(NO_COLOR|NODE_DISABLE_COLORS)' env is ignored due to the 'FORCE_COLOR' env being set/;
const colourKeys = (env) => Object.keys(env).filter((k) => COLOUR_KEYS.includes(k.toUpperCase())).sort();

// ── A: the pure function ───────────────────────────────────────────────────────────────────────

test('A scrubColourEnv: deletes the three names in place, in any letter case, and nothing else', () => {
  assert.deepEqual(COLOUR_KEYS, ['FORCE_COLOR', 'NO_COLOR', 'NODE_DISABLE_COLORS']);
  const env = { FORCE_COLOR: '1', no_color: '1', Node_Disable_Colors: '1', NO_COLOR: '', PATH: 'p', FORCE_COLOR_X: 'kept', COLORTERM: 'truecolor', TERM: 'xterm' };
  const out = scrubColourEnv(env);
  assert.equal(out, env, 'in place: the same object comes back, so it works on process.env');
  assert.deepEqual(env, { PATH: 'p', FORCE_COLOR_X: 'kept', COLORTERM: 'truecolor', TERM: 'xterm' });
  assert.deepEqual(scrubColourEnv({}), {});
});

test('A this file: own-job.cjs ran first, so its own env has none of the three names', () => {
  assert.deepEqual(colourKeys(process.env), []);
});

// ── B: own-job.cjs, live ───────────────────────────────────────────────────────────────────────

const req = (file) => `require(${JSON.stringify(file.split(path.sep).join('/'))});`;
// The child: asks about colour the way a pipe-backed stream can (process.stderr.hasColors does not exist on a
// pipe), then reports the colour names it sees.
const CHILD = 'require("node:tty").WriteStream.prototype.getColorDepth.call({});'
  + 'process.stdout.write(JSON.stringify(Object.keys(process.env).filter((k) => /^(FORCE_COLOR|NO_COLOR|NODE_DISABLE_COLORS)$/i.test(k)).sort()));';
const fixture = (helperLine) => `'use strict';
${helperLine}
const { spawnSync } = require('node:child_process');
const own = Object.keys(process.env).filter((k) => /^(FORCE_COLOR|NO_COLOR|NODE_DISABLE_COLORS)$/i.test(k)).sort();
// NO env option: the child inherits this process's env, as the children of the 15 failing tests did
const r = spawnSync(process.execPath, ['-e', ${JSON.stringify(CHILD)}], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
process.stdout.write(JSON.stringify({ own, status: r.status, error: r.error ? String(r.error) : null, childStdout: r.stdout, childStderr: r.stderr }));
`;

/** The caller's shell as it was on the failing leg: no runner variables, FORCE_COLOR and NO_COLOR both set. */
function shellEnv(extra) {
  const env = { ...process.env };
  for (const k of ['NODE_OPTIONS', 'GUPPY_FILE_JOB_EXE', 'GUPPY_FILE_JOB_OPT', 'GUPPY_FILE_JOB_PID', 'NODE_TEST_CONTEXT']) delete env[k];
  return nodeEnv(Object.assign(scrubColourEnv(env), extra));
}
/** As bare-node-test-owner: a child the job just ended can hold the dir for a moment. */
const rmDir = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });

function directRun(dir, name, helperLine, extra) {
  const file = path.join(dir, `${name}.cjs`);
  fs.writeFileSync(file, fixture(helperLine));
  // spawnSync: the fixture has exited (or was killed at the timeout) before anything is read or removed
  const r = spawnSync(process.execPath, [file], { cwd: os.tmpdir(), env: shellEnv(extra), encoding: 'utf8', windowsHide: true, timeout: 180_000 });
  assert.equal(r.status, 0, `${name}: the fixture ran (error ${r.error}, stderr ${JSON.stringify((r.stderr || '').slice(-400))})`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.status, 0, `${name}: its child ran (${out.error}, stderr ${JSON.stringify(out.childStderr)})`);
  return out;
}

test('B LIVE: a file that requires own-job.cjs first starts children with a clean colour env, whatever its own shell had (control: without it the child warns)', { timeout: 240_000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colour-env-'));
  try {
    for (const [name, extra, names] of [
      ['pair', { FORCE_COLOR: '1', NO_COLOR: '1' }, ['FORCE_COLOR', 'NO_COLOR']],
      ['disable', { FORCE_COLOR: '1', NODE_DISABLE_COLORS: '1' }, ['FORCE_COLOR', 'NODE_DISABLE_COLORS']],
    ]) {
      // control: no helper. The child inherits the pair and warns; this is what the 15 tests met.
      const control = directRun(dir, `${name}-control`, '', extra);
      assert.deepEqual(control.own, names, `${name} control: the fixture was started with the names set`);
      assert.deepEqual(JSON.parse(control.childStdout), names, `${name} control: its child inherited them`);
      assert.match(control.childStderr, WARNING, `${name} control: THE CHILD PRINTS THE WARNING (if not, this test cannot bite on this runtime)`);
      // the helper, exactly as every test file has it (own-job-guard), by absolute path from the temp dir
      const fixed = directRun(dir, `${name}-fixed`, req(HELPER), extra);
      assert.deepEqual(fixed.own, [], `${name}: OWN-JOB REMOVED THE COLOUR NAMES FROM THE FILE'S ENV`);
      assert.deepEqual(JSON.parse(fixed.childStdout), [], `${name}: THE CHILD STARTED WITH NO ENV OPTION SEES NONE OF THEM`);
      assert.equal(fixed.childStderr, '', `${name}: THE CHILD'S STDERR IS EMPTY`);
    }
  } finally { rmDir(dir); }
});

// ── C: the runner ──────────────────────────────────────────────────────────────────────────────

test('C runner: the env handed to node --test has none of the three names; the caller\'s env object is not touched', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'colour-env-c-'));
  try {
    const processEnv = { ...process.env, FORCE_COLOR: '1', NO_COLOR: '1', NODE_DISABLE_COLORS: '1', COLOUR_ENV_MARK: 'kept' };
    const handed = [];
    const code = R.run({ testDir: 'test', filters: ['a'], readdir: () => ['a.test.cjs'], processEnv, jobRate: () => 0, eventsFile: path.join(dir, 'ev'),
      spawn: (args, opts) => { handed.push({ ...opts.env }); return { status: 0 }; },
      log: () => {}, err: () => {}, timeoutMs: 5000, watchdog: () => ({ stop: () => {} }), fileJob: () => ({ exe: path.join(dir, 'gone.exe') }) });
    assert.equal(code, 0);
    assert.ok(handed.length >= 1, 'the runner started node --test');
    for (const env of handed) {
      assert.equal(env.COLOUR_ENV_MARK, 'kept', 'it is the injected env that was handed on');
      assert.deepEqual(colourKeys(env), [], 'THE RUN ENV HAS NO COLOUR VARIABLE');
    }
    assert.deepEqual(colourKeys(processEnv), ['FORCE_COLOR', 'NODE_DISABLE_COLORS', 'NO_COLOR'], 'the caller\'s object keeps its own (the runner cleans a copy)');
  } finally { rmDir(dir); }
});
