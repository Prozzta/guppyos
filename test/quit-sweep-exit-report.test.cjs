'use strict';
/**
 * QUIT-SWEEP-ELECTRON-SILENT-EXIT: a quit-sweep fixture that ends without a pid file must say HOW it ended.
 *
 * GTC suite, Node leg, 2026-11-20: quit-sweep.electron failed after 7.9 s with 'fixture never wrote the
 * pid file; output:' and nothing else. The exit code and signal were known to the test and not printed
 * (the pid-file assert comes first), the sandbox with any crash dump was removed, and the failed removal
 * of that sandbox was swallowed. A kill from outside (code 1) and a native crash (a large code) could
 * not be told apart, so the fail could not be attributed.
 *
 * The report lives in tools/fixture-exit.cjs so that these cells run it on a real child that is ended
 * from outside, without starting Electron; the source cells pin that quit-sweep.electron uses it in
 * every failure message, with its asserts and their order unchanged.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { nodeEnv } = require('./tools/node-env.cjs');

const tool = () => require('./tools/fixture-exit.cjs');
const QUIT_SWEEP = path.join(__dirname, 'quit-sweep.electron.test.cjs');

/** A stand-in fixture: a real child that says UP and then stays, or exits with `code`. */
function standIn({ code = null, cwd = process.cwd() } = {}) {
  const body = code === null ? "process.stdout.write('UP'); setInterval(() => {}, 1000);" : `process.stdout.write('UP'); process.exit(${code});`;
  const bornMs = Date.now();
  const child = spawn(process.execPath, ['-e', body], { stdio: ['ignore', 'pipe', 'ignore'], env: nodeEnv(), cwd, windowsHide: true });
  const up = new Promise((resolve) => child.stdout.once('data', resolve));
  return { child, bornMs, up };
}

function sandboxDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qs-exit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a fixture ended from outside is reported with its exit code, signal and time', async () => {
  const { seenExit, exitNote } = tool();
  const { child, bornMs, up } = standIn();
  const seen = seenExit(child, bornMs);
  await up;
  process.kill(child.pid);                       // from outside: not child.kill(), which node itself would name
  const x = await seen;
  // What node reports for a process another one ended: code 1 and no signal on win32, the signal elsewhere.
  if (process.platform === 'win32') assert.deepEqual({ code: x.code, signal: x.signal }, { code: 1, signal: null });
  else assert.deepEqual({ code: x.code, signal: x.signal }, { code: null, signal: 'SIGTERM' });
  assert.ok(Number.isInteger(x.ms) && x.ms >= 0, `elapsed ms is a whole number, got ${x.ms}`);
  assert.equal(exitNote(x), `fixture exited code=${x.code}, signal=${x.signal}, after ${x.ms} ms`);
});

test('a fixture that exits by itself is reported with its own code', async () => {
  const { seenExit, exitNote } = tool();
  const { child, bornMs } = standIn({ code: 3 });
  const x = await seenExit(child, bornMs);
  assert.deepEqual({ code: x.code, signal: x.signal }, { code: 3, signal: null });
  assert.match(exitNote(x), /^fixture exited code=3, signal=null, after \d+ ms$/);
});

test('a native crash code is printed in hex as well, so it can be looked up', () => {
  const { exitNote } = tool();
  assert.equal(exitNote({ code: 3221225477, signal: null, ms: 12 }), 'fixture exited code=3221225477 (0xC0000005), signal=null, after 12 ms');
  assert.equal(exitNote({ code: 1, signal: null, ms: 12 }), 'fixture exited code=1, signal=null, after 12 ms');
});

test('a fixture the hang guard ended is not reported as an exit', () => {
  const { exitNote } = tool();
  assert.equal(exitNote('timeout'), 'fixture did not exit (the hang guard ended it)');
});

test('crash dumps in the sandbox are listed with their sizes, at any depth', (t) => {
  const { crashDumpNote } = tool();
  const sandbox = sandboxDir(t);
  assert.equal(crashDumpNote(sandbox), 'crashDumps: no folder');
  fs.mkdirSync(path.join(sandbox, 'crashDumps', 'reports'), { recursive: true });
  assert.equal(crashDumpNote(sandbox), 'crashDumps: no files');
  fs.writeFileSync(path.join(sandbox, 'crashDumps', 'reports', 'a.dmp'), Buffer.alloc(7));
  fs.writeFileSync(path.join(sandbox, 'crashDumps', 'settings.dat'), Buffer.alloc(2));
  assert.equal(crashDumpNote(sandbox), 'crashDumps: reports/a.dmp (7 bytes), settings.dat (2 bytes)');
});

test('a sandbox that is removed gives no note', (t) => {
  const { removeSandbox } = tool();
  const sandbox = sandboxDir(t);
  fs.writeFileSync(path.join(sandbox, 'pids.json'), '{}');
  assert.equal(removeSandbox(sandbox), '');
  assert.equal(fs.existsSync(sandbox), false);
});

test('a sandbox that cannot be removed is named with the error and what is left in it', { skip: process.platform !== 'win32' && 'a folder in use can be removed off win32' }, async (t) => {
  const { removeSandbox } = tool();
  const sandbox = sandboxDir(t);
  const held = path.join(sandbox, 'local');
  fs.mkdirSync(held);
  // A live process whose working folder is inside the sandbox: what a surviving Electron child does.
  const { child, up } = standIn({ cwd: held });
  const gone = new Promise((resolve) => child.once('exit', resolve));
  try {
    await up;
    const note = removeSandbox(sandbox);
    assert.match(note, /^sandbox not removed \((EBUSY|EPERM|ENOTEMPTY)\); left in it: local$/, note);
    assert.equal(fs.existsSync(held), true);
  } finally {
    // Ended here, not in a t.after: the holder must be gone before sandboxDir's own removal runs.
    try { process.kill(child.pid); } catch { /* already gone */ }
    await gone;
  }
});

// ---- source cells: quit-sweep.electron prints the report, with its asserts and their order unchanged ----

const src = () => fs.readFileSync(QUIT_SWEEP, 'utf8');
/** The asserts of the verdict, in the order the file runs them. */
const VERDICT = [
  'assert.notStrictEqual(exitCode, \'timeout\', `electron fixture hung; ',
  'assert.ok(fs.existsSync(pidFile), `fixture never wrote the pid file; ',
  'assert.ok(!recorded.error, `fixture bailed: ${recorded.error}; ',
  'assert.strictEqual(exitCode, 0, `electron exited ${exitCode}; ',
  'assert.ok(recorded.pids.length >= 2, `expected root+descendant, saw: ${recorded.pids.join(\',\')}',
  'assert.fail(`process tree survived Electron quit'
];

test('quit-sweep.electron keeps its six asserts, in their order', () => {
  const text = src();
  let at = -1;
  for (const head of VERDICT) {
    const i = text.indexOf(head);
    assert.ok(i > at, `'${head}' is present and after the assert before it`);
    assert.equal(text.indexOf(head, i + 1), -1, `'${head}' is there once`);
    at = i;
  }
  assert.equal((text.match(/\bassert\.(ok|strictEqual|notStrictEqual|fail)\(/g) || []).length, VERDICT.length + 1,
    'the six verdict asserts plus the electron-binary check, and no other');
});

test('every failure message of quit-sweep.electron carries how the fixture ended', () => {
  const lines = src().split(/\r?\n/);
  for (const head of VERDICT) {
    const line = lines.find((l) => l.includes(head));
    assert.ok(line, `'${head}' is on one line`);
    assert.ok(line.includes('${exitNote(seen)}'), `the message names the exit: ${line.trim()}`);
  }
  assert.match(src(), /const seen = await Promise\.race\(\[\s*seenExit\(child, childRec\.bornMs\),/, 'the exit is taken by seenExit, raced with the hang guard');
});

test('a failed quit-sweep.electron lists the crash dumps before the sandbox is removed, and names a failed removal', () => {
  const text = src();
  const fail = text.indexOf('console.error(`FAIL  ${e.message}; ${crashDumpNote(sandbox)}`);');
  const remove = text.indexOf('const left = removeSandbox(sandbox);');
  assert.ok(fail > 0, 'the FAIL line carries the crash dump list');
  assert.ok(remove > fail, 'the sandbox is removed after the FAIL line is written');
  assert.ok(text.indexOf('if (left) console.error(`NOTE  ${left}`);') > remove, 'a failed removal is printed');
  assert.equal(/fs\.rmSync\(sandbox/.test(text), false, 'no second, silent removal of the sandbox');
});
