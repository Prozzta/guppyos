'use strict';
require('./tools/own-job.cjs');
// MUTANT-JOURNAL-GATE (god 5cc045/ed8032): this suite loads a file a census mutates in place (one load-ts never sees);
// refuse a tree a killed census left mutated, before anything is read.
require('./tools/mutant-runner-helper.cjs').gate(__filename);

/**
 * THE HARNESS LEAVES NOTHING BEHIND - and says so loudly when it cannot help it.
 *
 * Every Electron harness child gets a throwaway `userData`. Until this test existed the
 * CHILD deleted it on the way out, inside a swallowed `catch`; on Windows its own Chromium
 * handles were still open, so the delete failed every time and nothing said so. About 1,400
 * directories and 14 GB had built up in %TEMP% when it was noticed (L0 milestone record,
 * item 10, finding F1). The lifecycle now belongs to the PARENT (electron-harness/run.cjs):
 * create, hand to the child, remove after the child has EXITED with a bounded retry, and
 * REJECT the run - naming the path - if the directory is still there.
 *
 * Each real run here is given a PRIVATE temp root, because other harness test files run in
 * parallel with this one and share os.tmpdir(): counting the shared directory would measure
 * them, not us.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const run = require('./electron-harness/run.cjs');
const { readSource } = require('./read-source.cjs');
const { nodeEnv } = require('./tools/node-env.cjs');

const privateRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'l0-leakcheck-'));

test('a scenario run leaves ZERO new directories in its temp root', async () => {
  const root = privateRoot();
  try {
    const r = await run.runScenario(path.join(__dirname, 'electron-harness', 'scenarios', 'render-capabilities.ts'), { tempRoot: root, timeoutMs: 60_000 });
    assert.equal(r.ok, true, `precondition: the scenario really ran: ${r.error ?? ''}`);
    assert.deepEqual(fs.readdirSync(root), [], 'NOTHING is left in the temp root after a harness run');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an IPC-order run - including its real process-crash round - leaves ZERO new directories', async () => {
  const root = privateRoot();
  try {
    const r = await run.runIpcOrder({ phase1: 5, phase2: 5, phase3: 1, tempRoot: root });
    assert.ok(r && typeof r === 'object', 'precondition: the experiment reported');
    assert.deepEqual(fs.readdirSync(root), [], 'NOTHING is left in the temp root after an IPC-order run');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a child that refuses to run without --sandbox: the parent, and only the parent, owns the directory', () => {
  for (const f of ['test/electron-harness/harness-main.cjs', 'test/electron-harness/ipc-order-main.cjs']) {
    const src = readSource(f);
    assert.ok(!/mkdtemp|rmSync|tmpdir/.test(src.replace(/\/\/.*$/gm, '')), `${f} neither creates nor deletes a temp directory`);
    assert.match(src, /const sandboxRoot = argOf\('sandbox', null\);\s*if \(!sandboxRoot\) \{[\s\S]*?process\.exit\(2\);/, `${f} refuses to run without one`);
  }
});

/** Hold a directory so that it CANNOT be removed: on Windows a live process's cwd. */
function holdDirectory(dir) {
  // The child SAYS when it is up, from inside the directory. Waiting for the `spawn` event
  // alone was not enough under a parallel full-suite run: the removal sometimes won the race.
  const child = spawn(process.execPath, ['-e', "process.stdout.write(process.cwd()); setInterval(() => {}, 1000)"], { cwd: dir, env: nodeEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', () => resolve(child));
  });
}
const killed = (child) => new Promise((resolve) => { child.once('exit', resolve); child.kill(); });

const K = {};

K.aSandboxThatCannotBeRemovedFailsLoudly = async (mod) => {
  const root = privateRoot();
  const dir = mod.createSandbox('l0-harness-', root);
  const holder = await holdDirectory(dir);
  try {
    await assert.rejects(mod.removeSandbox(dir, 3, 50), (e) => {
      assert.match(e.message, /HARNESS SANDBOX LEAK/, 'A LEFTOVER SANDBOX IS AN ERROR, NOT A SHRUG');
      assert.ok(e.message.includes(dir), 'and the error names the path, so a person can find it');
      return true;
    }, 'a sandbox that is still on disk after the retries REJECTS - it is never swallowed');
    assert.equal(fs.existsSync(dir), true, 'precondition: the directory really could not be removed');
  } finally {
    await killed(holder);
    await run.removeSandbox(root, 50, 100); // the REAL remover, never the module under test
  }
};

K.theRetryOutlastsAHandleThatIsReleasedLate = async (mod) => {
  const root = privateRoot();
  const dir = mod.createSandbox('l0-harness-', root);
  const holder = await holdDirectory(dir);
  try {
    setTimeout(() => holder.kill(), 400); // the way Windows releases a dead child's handles: a moment AFTER `close`
    await mod.removeSandbox(dir, 50, 100);
    assert.equal(fs.existsSync(dir), false, 'THE BOUNDED RETRY removes a directory whose handle is released late - which is the real Windows case');
  } finally {
    // Clean up with the REAL remover, never the module under test: a mutant must not be able
    // to turn this test's own tidy-up into the error that gets reported.
    if (holder.exitCode === null && holder.signalCode === null) await killed(holder);
    await run.removeSandbox(root, 50, 100);
  }
};

for (const [name, killer] of Object.entries(K)) {
  test(`sandbox removal: ${name}`, (t) => {
    if (process.platform !== 'win32') { t.skip('holding a directory open by cwd is a Windows behaviour'); return undefined; }
    return killer(run);
  });
}

const MUTANTS = [
  { name: 'the leak swallowed again (the original defect)',
    edits: [['  throw new Error(`HARNESS SANDBOX LEAK:', '  return; throw new Error(`HARNESS SANDBOX LEAK:']],
    killer: 'aSandboxThatCannotBeRemovedFailsLoudly', dies: /REJECTS - it is never swallowed/ },
  { name: 'one attempt, no retry',
    edits: [['  for (let i = 0; i < attempts; i += 1) {', '  for (let i = 0; i < 1; i += 1) {']],
    killer: 'theRetryOutlastsAHandleThatIsReleasedLate', dies: /HARNESS SANDBOX LEAK/, byError: true }
];

test('MUTANT CENSUS (run.cjs): every mutant applies exactly once and is killed', async (t) => {
  if (process.platform !== 'win32') { t.skip('the killers are Windows-only'); return; }
  const source = readSource('test/electron-harness/run.cjs');
  for (const [i, mutant] of MUTANTS.entries()) {
    await t.test(`mutant: ${mutant.name}`, async () => {
      let text = source;
      for (const [from, to] of mutant.edits) {
        assert.equal(text.split(from).length - 1, 1, `mutant "${mutant.name}": edit target must match EXACTLY ONCE`);
        text = text.replace(from, () => to);
      }
      const file = path.join(__dirname, 'electron-harness', `.mutant-run-${i}.cjs`);
      fs.writeFileSync(file, text, 'utf8');
      let died = null;
      try { await K[mutant.killer](require(file)); } catch (e) { died = e; } finally { fs.rmSync(file, { force: true }); }
      assert.ok(died, `SURVIVED: "${mutant.name}" was not killed by ${mutant.killer}`);
      if (!mutant.byError) assert.ok(died instanceof assert.AssertionError, `"${mutant.name}" must die by ASSERTION, got: ${died && died.stack}`);
      assert.match(died.message, mutant.dies, `"${mutant.name}" died at the wrong place`);
    });
  }
});

/**
 * HARNESS-RUN-AS-NODE-ENV-LEAK-108: a harness child is a REAL Electron app, whatever runs the test.
 *
 * The suite's Electron leg runs each test file as 'ELECTRON_RUN_AS_NODE=1 electron.exe --test'.
 * The launchers spread process.env into the child, so the child started as plain Node, had no
 * 'app', and died at isolate-paths.cjs (app.setPath) with 'harness produced no result (exit 1)'.
 * These cells set the key in THIS process for one run, so plain node shows the defect too.
 */
const RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE';
const { appEnv } = require('./electron-harness/electron-bin.cjs');

/** Run fn with process.env[RUN_AS_NODE] = '1', then put back exactly what was there. */
async function withRunAsNodeSet(fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, RUN_AS_NODE);
  const was = process.env[RUN_AS_NODE];
  process.env[RUN_AS_NODE] = '1';
  try { return await fn(); } finally {
    if (had) process.env[RUN_AS_NODE] = was; else delete process.env[RUN_AS_NODE];
  }
}

test('appEnv: a copy of the env without ELECTRON_RUN_AS_NODE; the caller\'s object is left alone', () => {
  const given = { PATH: 'p', [RUN_AS_NODE]: '1', MUNDER_DEV: '' };
  const out = appEnv(given);
  assert.deepEqual(out, { PATH: 'p', MUNDER_DEV: '' });
  assert.deepEqual(given, { PATH: 'p', [RUN_AS_NODE]: '1', MUNDER_DEV: '' }, 'the input is not edited');
  assert.equal(RUN_AS_NODE in appEnv({ PATH: 'p' }), false, 'nothing is added when the key is absent');
  const mine = withRunAsNodeSet(() => appEnv());
  return mine.then((env) => {
    assert.equal(RUN_AS_NODE in env, false, 'the default is process.env, without the key');
    assert.equal(env.PATH, process.env.PATH);
  });
});

test('a scenario run still reports when this process has ELECTRON_RUN_AS_NODE=1 (the Electron leg)', async () => {
  const root = privateRoot();
  try {
    const r = await withRunAsNodeSet(() => run.runScenario(
      path.join(__dirname, 'electron-harness', 'scenarios', 'render-capabilities.ts'), { tempRoot: root, timeoutMs: 60_000 }));
    assert.equal(r.ok, true, `the child ran the scenario as an Electron app: ${r.error ?? ''}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a test\'s own opts.env cannot put ELECTRON_RUN_AS_NODE back into the harness child', async () => {
  const root = privateRoot();
  try {
    const r = await run.runScenario(
      path.join(__dirname, 'electron-harness', 'scenarios', 'render-capabilities.ts'),
      { tempRoot: root, timeoutMs: 60_000, env: { [RUN_AS_NODE]: '1' } });
    assert.equal(r.ok, true, `the child ran the scenario as an Electron app: ${r.error ?? ''}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an IPC-order run still reports when this process has ELECTRON_RUN_AS_NODE=1 (run.cjs\'s second launcher)', async () => {
  const root = privateRoot();
  try {
    const r = await withRunAsNodeSet(() => run.runIpcOrder({ phase1: 5, phase2: 5, phase3: 1, tempRoot: root }));
    assert.equal(typeof r, 'object', 'the child ran the experiment as an Electron app and printed its result');
    assert.notEqual(r, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** Files that take the harness binary's path but never start a child with it. */
const TAKES_THE_PATH_ONLY = ['test/electron-fuses.test.cjs', 'test/electron-view-self-heal-198.test.cjs', 'test/tools/claims90-search.cjs'];
/** What a launcher must show: appEnv (a real app), an explicit delete (a real app), or the key set to '1' (Node on purpose). */
const SAYS_WHICH = /\bappEnv\(|delete env\.ELECTRON_RUN_AS_NODE\b|ELECTRON_RUN_AS_NODE: '1'/;

test('THE TREE: every file that launches the harness Electron binary says whether its child is an app or Node', () => {
  const testDir = __dirname;
  const users = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.cjs') && /\bharnessElectron\(/.test(fs.readFileSync(full, 'utf8'))) {
        users.push(`test/${path.relative(testDir, full).split(path.sep).join('/')}`);
      }
    }
  };
  walk(testDir);
  const self = 'test/electron-harness-sandbox.test.cjs';
  const definesIt = 'test/electron-harness/electron-bin.cjs';
  for (const exempt of TAKES_THE_PATH_ONLY) assert.ok(users.includes(exempt), `${exempt} no longer names harnessElectron: drop it from TAKES_THE_PATH_ONLY`);
  const launchers = users.filter((f) => f !== self && f !== definesIt && !TAKES_THE_PATH_ONLY.includes(f));
  assert.ok(launchers.includes('test/electron-harness/run.cjs') && launchers.length >= 5,`the walk found the launchers: ${launchers.join(', ')}`);
  // PER LAUNCH, not per file (Jim): run.cjs has two launchers, and one wrapped site must not
  // cover for the other. Each harnessElectron( call must be matched by one statement of intent.
  // The count is a FLOOR, not a pairing (Jim): it proves a file says which at least as often as
  // it launches, not that each statement sits on its own launch. The live cells bind run.cjs's two.
  const count = (text, re) => (text.match(new RegExp(re.source, 'g')) || []).length;
  const silent = launchers
    .map((f) => ({ f, launches: count(readSource(f), /\bharnessElectron\(/), says: count(readSource(f), SAYS_WHICH) }))
    .filter((x) => x.says < x.launches)
    .map((x) => `${x.f}: ${x.launches} launch(es), ${x.says} say which`);
  assert.deepEqual(silent, [],
    'A LAUNCHER OF THE HARNESS ELECTRON BINARY THAT MAY HAND ITS CHILD ELECTRON_RUN_AS_NODE: under the Electron leg the child starts as plain Node and never reports. '
    + 'Wrap the child env in appEnv() (test/electron-harness/electron-bin.cjs), or set the key to \'1\' when Node is meant.');
});
