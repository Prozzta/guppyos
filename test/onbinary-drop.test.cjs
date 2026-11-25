'use strict';
require('./tools/own-job.cjs');

// ONBINARY-DROP: legacy X10 uses xterm.onBinary.  The important boundary is
// node-pty's real child, not merely a mocked proc.write: ConPTY
// interprets input as UTF-8, while POSIX PTYs preserve the raw bytes.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { childBytes, electronExe } = require('./tools/pty-child.cjs');
const { consoleNode, assertConsoleNode, peSubsystem, KEY } = require('./tools/console-node.cjs');

const X10_HIGH_COLUMN = '\x1b[M \x85!';

test('ONBINARY-DROP: binary xterm input is wired to the platform handoff', () => {
  const pool = readSource('src/renderer/src/components/terminalPool.ts');
  assert.match(pool, /term\.onData\(\(data\) => forwardTerminalInput\(data\)\);/);
  assert.match(pool, /term\.onBinary\(\(data\) => forwardTerminalInput\(data, true\)\);/,
    'removing the onBinary listener makes this mutant guard fail');
  assert.match(pool, /writePtyBinary\(ptyId, data, classifyOutbound\(ptyId, data\)\)/,
    'the binary marker must reach main rather than be silently dropped');
  const preload = readSource('src/preload/index.ts');
  assert.match(preload, /writePtyBinary:[\s\S]*?sendPtyWrite\(id, data, origin, true\)/,
    'the binary bridge must retain its true transport flag through preload');
});

test('ONBINARY-DROP: helper keeps a JS string for ConPTY and raw latin-1 bytes for POSIX', () => {
  const { ptyBinaryInput } = loadTs('src/main/ptyBinaryInput.ts');
  assert.equal(ptyBinaryInput(X10_HIGH_COLUMN, 'win32'), X10_HIGH_COLUMN);
  const posix = ptyBinaryInput(X10_HIGH_COLUMN, 'linux');
  assert.ok(Buffer.isBuffer(posix));
  assert.deepEqual([...posix], [0x1b, 0x5b, 0x4d, 0x20, 0x85, 0x21]);
});

// The child must be ON the pseudoconsole: a console-subsystem Node, never electron.exe (see console-node.cjs).
test('ONBINARY-DROP: win32 ConPTY preserves the high coordinate only via string (Buffer mutant is red)', { skip: process.platform !== 'win32' }, async (t) => {
  const { ptyBinaryInput } = loadTs('src/main/ptyBinaryInput.ts');
  const node = consoleNode();
  t.diagnostic(`PTY child: ${node.file} ${node.version} (from ${node.from})`);
  // PTY-X10-MOUSE-ESC-PREFIX-OPENCONSOLE: on the bundled OpenConsole, the host the app runs, the child
  // reads the full report: ESC [ M, then the three bytes, the high one as UTF-8 (c2 85). The inbox
  // conhost consumed the ESC [ M prefix.
  assert.deepEqual(await childBytes(ptyBinaryInput(X10_HIGH_COLUMN, 'win32'), { file: node.file }), [0x1b, 0x5b, 0x4d, 0x20, 0xc2, 0x85, 0x21]);
  assert.deepEqual(await childBytes(Buffer.from(X10_HIGH_COLUMN, 'latin1'), { file: node.file }), [0x1b, 0x5b, 0x4d, 0x20, 0xef, 0xbf, 0xbd, 0x21],
    'the Buffer mutant loses 0x85 at ConPTY UTF-8 decoding: it arrives as U+FFFD');
});

// FLAKE-ONBINARY-PTY-CHILD-NO-ANSWER-RECUR-108. The bundled OpenConsole asks a start-up query and holds
// the child's start until it is answered, or 3 s pass. The app answers it for every terminal. The helper
// did not, so about 3 s of its 5 s were gone before the child existed, and under suite load the cell
// above went red with 'PTY child did not answer' and no READY. The helper now answers as the app does.
// What is pinned is the order of the steps and what the input socket was given, never a duration.
test("ONBINARY-DROP: the helper answers OpenConsole's start-up query as the app does, before the child says READY", { skip: process.platform !== 'win32' }, async (t) => {
  const { ptyBinaryInput } = loadTs('src/main/ptyBinaryInput.ts');
  const { DA1_ANSWER } = loadTs('src/main/openConsoleHandshake.ts');
  const node = consoleNode();
  t.diagnostic(`PTY child: ${node.file} ${node.version} (from ${node.from})`);
  let seen;
  const bytes = await childBytes(ptyBinaryInput(X10_HIGH_COLUMN, 'win32'), { file: node.file, onHandshake: (h) => { seen = h; } });
  assert.ok(seen, 'childBytes reports what it saw of the start-up handshake');
  t.diagnostic(`handshake: ${JSON.stringify(seen)}`);
  assert.equal(seen.looked, true, 'the default host is the bundled OpenConsole, where the query is looked for');
  assert.deepEqual(seen.order, ['query', 'answer', 'ready', 'write', 'bytes'],
    "the query is seen, the answer is written, then the child says READY, then the test's bytes go in and come back");
  assert.equal(seen.inputAtReady, Buffer.byteLength(DA1_ANSWER),
    "THE START-UP QUERY IS ANSWERED: when READY came the terminal's input socket had been given the answer and nothing else");
  assert.deepEqual(bytes, [0x1b, 0x5b, 0x4d, 0x20, 0xc2, 0x85, 0x21], "the child's first stdin bytes are the test's, not the answer's");
});

test('ONBINARY-DROP: POSIX real PTY receives the raw X10 bytes',{ skip: process.platform === 'win32' }, async (t) => {
  const { ptyBinaryInput } = loadTs('src/main/ptyBinaryInput.ts');
  const node = consoleNode();
  t.diagnostic(`PTY child: ${node.file} ${node.version} (from ${node.from})`);
  assert.deepEqual(await childBytes(ptyBinaryInput(X10_HIGH_COLUMN, process.platform), { file: node.file }),
    [0x1b, 0x5b, 0x4d, 0x20, 0x85, 0x21]);
});

test('ONBINARY-DROP: consoleNode() rejects electron.exe and any GUI-subsystem exe by name, and never falls back', (t) => {
  const electron = electronExe();
  const asElectron = { versions: { ...process.versions, electron: '0.0.0' }, execPath: electron };
  // The env key is used first, and a bad one is a named failure (not passed over for PATH).
  assert.throws(() => consoleNode({ ...asElectron, env: { [KEY]: electron, PATH: process.env.PATH } }),
    (e) => e.message.startsWith(`no console node.exe: ${KEY} is electron.exe (${electron})`));
  // None found under Electron: fail by name; process.execPath is not a fallback.
  assert.throws(() => consoleNode({ ...asElectron, env: { PATH: '' } }),
    { message: `no console node.exe: set ${KEY} or put node on PATH` });
  if (process.platform !== 'win32') return;
  assert.equal(peSubsystem(electron), 2, 'electron.exe is a GUI-subsystem program');
  // The subsystem is read from the file: a GUI exe is refused under any name, before it is run.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guppy-console-node-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fake = path.join(dir, 'node.exe');
  const head = Buffer.alloc(0x40 + 24 + 70);
  head.write('MZ', 0, 'latin1'); head.writeUInt32LE(0x40, 0x3c);
  head.write('PE\0\0', 0x40, 'latin1'); head.writeUInt16LE(2, 0x40 + 24 + 68);
  fs.writeFileSync(fake, head);
  const ran = [];
  assert.throws(() => consoleNode({ ...asElectron, env: { [KEY]: fake }, run: (...a) => { ran.push(a); return 'v1.2.3'; } }),
    (e) => e.message.startsWith(`no console node.exe: ${KEY} (${fake}) has PE subsystem 2 (GUI), not 3 (console)`));
  assert.deepEqual(ran, [], 'a refused exe is never started');
  // What it does accept on this machine is a console exe that answers --version.
  const real = consoleNode();
  assert.equal(peSubsystem(real.file), 3);
  assert.match(real.version, /^v\d+\.\d+\.\d+/);
  assert.doesNotMatch(path.basename(real.file), /^electron/i);
});

// FLAKE-RIG-ELECTRON-LEG-CONSOLE-NODE-VERSION-FAIL-108. A console node that was started and then ended
// badly on `--version` was reported with Node's "Command failed: <cmd>" alone: the exit code, the signal
// and the child's output were dropped, so a suite red could not say whether the child was killed, could
// not set up its console, or failed by itself. The failure names all of them.
test('FLAKE-RIG-ELECTRON-LEG-CONSOLE-NODE-VERSION-FAIL-108: a console node that fails --version is reported with its exit code, signal, stderr, stdout and elapsed time', () => {
  const file = consoleNode().file;
  const failing = (fields) => () => { throw Object.assign(new Error(`Command failed: ${file} --version`), fields); };
  const message = (fields) => {
    try { assertConsoleNode(file, 'UNIT', { run: failing(fields) }); } catch (e) { return e.message; }
    return assert.fail('a failing --version must throw');
  };
  // the old text stays, so a reader (and any matcher) still finds the same start
  const start = `no console node.exe: UNIT (${file}) did not run --version: Command failed: ${file} --version`;
  // an exit code with nothing written: decimal and hex, since Windows status codes are read in hex
  const quiet = message({ status: 3221225794, signal: null, stderr: '', stdout: '' });
  assert.ok(quiet.startsWith(start), quiet);
  assert.match(quiet, /exit code 3221225794 \(0xC0000142\)/);
  assert.match(quiet, /signal none/);
  assert.match(quiet, /stderr ""/);
  assert.match(quiet, /stdout ""/);
  assert.match(quiet, /after \d+ ms/);
  // -1 arrives as 4294967295 or as -1: one spelling in hex
  assert.match(message({ status: -1, signal: null, stderr: '', stdout: '' }), /exit code -1 \(0xFFFFFFFF\)/);
  // ended by a signal, with output: the signal, and the output as written (Buffers too)
  const killed = message({ status: null, signal: 'SIGTERM', stderr: Buffer.from('boom\r\n'), stdout: 'v1' });
  assert.match(killed, /exit code none/);
  assert.match(killed, /signal SIGTERM/);
  assert.match(killed, /stderr "boom\\r\\n"/);
  assert.match(killed, /stdout "v1"/);
  // never started: the system error code is named, and absent fields say so instead of 'undefined'
  const notStarted = message({ code: 'EPERM' });
  assert.match(notStarted, /error code EPERM/);
  assert.match(notStarted, /exit code none/);
  assert.match(notStarted, /stderr none/);
  assert.doesNotMatch(notStarted, /undefined/);
  // a long output is cut, and says so
  const long = message({ status: 1, signal: null, stderr: 'x'.repeat(5000), stdout: '' });
  assert.ok(long.length < 2000, `the message stays readable, got ${long.length} chars`);
  assert.match(long, /\(5000 chars, first 400\)/);
});

// FLAKE-RIG-ELECTRON-LEG-CONSOLE-NODE-VERSION-FAIL-108, step 2. An exit code says how the child ended, not
// who ended it: without the child's pid the line could not be set beside the run's stops journal (own-procs
// stop scripts) or its kills journal (a run file's process.kill / taskkill). The failure names the pid and
// its spawn time, and the rows of both journals that carry that pid since the spawn, or that none does.
// The journals here are made-up files put on this process under the key file-backstop-preload.cjs uses.
test('FLAKE-RIG-ELECTRON-LEG-CONSOLE-NODE-VERSION-FAIL-108: a console node that fails --version is reported with its pid and the stops and kills journal rows that name it', (t) => {
  const file = consoleNode().file;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'console-node-journal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stops = path.join(dir, 'starts.stops');
  const kills = path.join(dir, 'starts.kills');
  const KEYSYM = Symbol.for('guppy.file-backstop');
  // the rows are written while the child "runs", as a neighbour's would be: after the spawn time
  const failing = (fields) => () => {
    const row = (o) => `${JSON.stringify(o)}\n`;
    fs.writeFileSync(stops,
      row({ t: Date.now(), pid: 1, ppid: 0, name: 'other.exe', created: 1, rule: 'other', file: 'other.test.cjs', by: 1 })
      + row({ t: Date.now(), pid: 4242, ppid: 7, name: 'node.exe', created: 11, rule: 'CONSOLE-NODE-UNIT-RULE', file: 'console-node-neighbour.test.cjs', by: 5151 }));
    fs.writeFileSync(kills,
      row({ pid: 6161, file: 'older-owner.test.cjs', via: 'process.kill', targets: [4242], t: 1 })   // before the spawn: an older owner of the number
      + row({ pid: 6262, file: 'console-node-killer.test.cjs', via: 'taskkill', targets: [9, 4242], t: Date.now() }));
    throw Object.assign(new Error(`Command failed: ${file} --version`), fields);
  };
  const message = (fields, journal = true) => {
    const had = Object.prototype.hasOwnProperty.call(process, KEYSYM);
    const prev = process[KEYSYM];
    if (journal) process[KEYSYM] = { stops, file: 'onbinary-drop.test.cjs' }; else delete process[KEYSYM];
    try { assertConsoleNode(file, 'UNIT', { run: failing(fields) }); } catch (e) { return e.message; } finally {
      if (had) process[KEYSYM] = prev; else delete process[KEYSYM];
    }
    return assert.fail('a failing --version must throw');
  };
  // a pid with a row in each journal: the pid, its spawn time, and both rows
  const named = message({ pid: 4242, status: 1, signal: null, stderr: '', stdout: '' });
  assert.match(named, /\[pid 4242, started \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z, exit code 1 \(0x00000001\), /, named);
  assert.ok(named.includes(' [own-procs stops: pid 4242 was handed to a stop script (handed, not proven stopped): node.exe created=11 ppid=7 rule=CONSOLE-NODE-UNIT-RULE by console-node-neighbour.test.cjs (pid 5151)'), `THE STOPS ROW IS NAMED: ${named}`);
  assert.ok(named.includes(' [kills: pid 4242 was named by a kill (taskkill) from console-node-killer.test.cjs (pid 6262)'), `THE KILLS ROW IS NAMED: ${named}`);
  assert.ok(!named.includes('older-owner.test.cjs'), `a kills row from before the spawn names an older owner of the number: ${named}`);
  // control: a pid no row carries says so for both journals, and names no file
  const unnamed = message({ pid: 4343, status: 4294967295, signal: null, stderr: '', stdout: '' });
  assert.match(unnamed, /\[pid 4343, started /);
  assert.ok(unnamed.includes(' [own-procs stops: none of 2 rows names pid 4343; a row means handed to a stop script, not stopped]'), `NO STOPS ROW IS SAID: ${unnamed}`);
  assert.ok(unnamed.includes(' [kills: none of 2 rows names pid 4343 since its spawn;'), `NO KILLS ROW IS SAID: ${unnamed}`);
  assert.ok(!unnamed.includes('console-node-neighbour.test.cjs') && !unnamed.includes('console-node-killer.test.cjs'), unnamed);
  // never started: no pid, and no journal is asked about a pid that does not exist
  const notStarted = message({ code: 'EPERM' });
  assert.match(notStarted, /\[pid none, started /);
  assert.ok(!notStarted.includes('own-procs stops') && !notStarted.includes('[kills:'), notStarted);
  // outside a run there is no journal: the pid is still named, and nothing is said about rows
  const alone = message({ pid: 4242, status: 1, signal: null, stderr: '', stdout: '' }, false);
  assert.match(alone, /\[pid 4242, started /);
  assert.ok(!alone.includes('own-procs stops') && !alone.includes('[kills:'), alone);
});

// ONBINARY-DROP-ELECTRON-FILE-NEVER-EXITS-108. electron.exe is a GUI-subsystem program: Windows does not
// attach it to the pseudoconsole, so (also as Node) it prints nothing to the PTY and reads nothing from it.
// node-pty holds kill() back until a terminal's first data chunk, and its exit path frees only the output
// socket: after such a child the conout worker thread stayed for good and the test file never ended (every
// Electron leg waited out the 30 min file limit). The same child, on both runtimes: the helper must name
// the failure AND leave no worker behind.
test('ONBINARY-DROP: a PTY child that is not on the console fails by name and leaves no conout worker', { skip: process.platform !== 'win32' }, async () => {
  let worker;
  let exited;
  // host 'inbox': on the bundled OpenConsole a terminal whose child is a GUI-subsystem program reports
  // its exit, with no code, while that child is still alive (PTY-GUI-ROOT-EXIT-EARLY-UNTRACKED). Until
  // that card has ruled what is right there, this cell stays on the host its two names were measured on.
  const run = childBytes(X10_HIGH_COLUMN, {
    file: electronExe(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, host: 'inbox',
    onSpawn: (proc) => { worker = proc._agent._conoutSocketWorker._worker; exited = new Promise((res) => worker.once('exit', res)); }
  });
  try {
    // Two names for the one failure, whichever clock is first: the child's own 3 s timer (counted from
    // its start, which is slow on a loaded machine) or the helper's 5 s wait for an answer.
    // Each name is still the whole first line (after 'exited 2: ' comes the child's output, which is
    // empty). The line after it is the helper's record, which both clocks' errors carry.
    await assert.rejects(run, { message: /^PTY child (exited 2: |did not answer)\n {2}record, ms since the spawn: / }, 'no READY reached the PTY');
    let t;
    await Promise.race([exited, new Promise((_, rej) => {
      t = setTimeout(() => rej(new Error('the conout worker of the terminal never exited: the kill did not run (node-pty waits for a first data chunk, and this child sends none)')), 8000);
    })]).finally(() => clearTimeout(t));
  } finally {
    await worker.terminate();   // a red run must still let this file end
  }
});

// The child reports isTTY itself and the helper asserts it. A console node on the PTY always says true,
// so this child is made to say false: it answers with its bytes, and the helper must still refuse it by
// name (Jim 393e0b MUST 1: without this case nothing reached that assertion).
test('ONBINARY-DROP: a child that answers but says its stdout is no TTY is refused by name, and leaves no conout worker', { skip: process.platform !== 'win32' }, async (t) => {
  const { ptyBinaryInput } = loadTs('src/main/ptyBinaryInput.ts');
  const node = consoleNode();
  t.diagnostic(`PTY child: ${node.file} ${node.version} (from ${node.from})`);
  let worker;
  let exited;
  const run = childBytes(ptyBinaryInput(X10_HIGH_COLUMN, 'win32'), {
    file: node.file,
    prelude: "Object.defineProperty(process.stdout, 'isTTY', { value: false });",
    onSpawn: (proc) => { worker = proc._agent._conoutSocketWorker._worker; exited = new Promise((res) => worker.once('exit', res)); }
  });
  try {
    await assert.rejects(run, { message: /^PTY child is not on the console \(its stdout\/stdin isTTY is not true\): [\s\S]*READY:false[\s\S]*BYTES:/ });
    let timer;
    await Promise.race([exited, new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error('the conout worker of the refused terminal never exited')), 8000);
    })]).finally(() => clearTimeout(timer));
  } finally {
    await worker.terminate();
  }
});

// FLAKE-ONBINARY-DROP-PTY-CHILD-TIMEOUT-ELECTRON-108. A 'PTY child timed out' red said only that the
// child's own clock had won, not where the time went. The helper's error now carries a record, and
// this cell pins every field of it on a real child that times out.
// How the child is made to time out, in this cell only: its prelude drops the script's one-shot stdin
// listener (the byte counter of the record still reads), and makes the child's own timer 250 ms.
// host 'inbox': the host this record was measured on, and the one where no start-up query is looked
// for. (Until FLAKE-ONBINARY-PTY-CHILD-NO-ANSWER-RECUR-108 the helper's child on the bundled OpenConsole
// started about 3 s after the spawn, so a cell on that host could pin only one of the two clocks' names.)
const TIMES_OUT = "{ const once = process.stdin.once; process.stdin.once = function (name, ...rest) { return name === 'data' ? this : once.call(this, name, ...rest); };"
  + ' const real = setTimeout; globalThis.setTimeout = (fn) => real(fn, 250); }';
// The exit in the record is the terminal's exit event as the helper's seal saw it. The helper settles
// when the conout worker has gone and does not wait for that event, so both forms are legal. A mixed
// form (a stamp with no code, a code with no stamp) is not: the two are set together.
const EXIT_FIELD = /; exit (?:\d+ code \d+|none code none); /;
// What the record cell demanded until 2026-11-23. It pinned an order the helper never promised, and
// went red on an Electron suite leg whose record said 'exit none code none'.
const EXIT_SEEN_ONLY = /; exit \d+ code \d+; /;
const TEARDOWN_FIELD = /; teardown: child ended by pid (\d+|not needed \(it had exited\)); terminal kill (\d+); conout worker gone (\d+); /;

/** One real child that times out, on the inbox host. Returns the rejection and its record line. */
async function timedOut(t, onSpawn) {
  const node = consoleNode();
  t.diagnostic(`PTY child: ${node.file} ${node.version} (from ${node.from})`);
  let error;
  await assert.rejects(childBytes(X10_HIGH_COLUMN, { file: node.file, host: 'inbox', prelude: TIMES_OUT, onSpawn }), (e) => { error = e; return true; });
  t.diagnostic(error.message);
  const lines = error.message.split('\n');
  assert.equal(lines[0], 'PTY child timed out', 'the name is unchanged, and alone on the first line');
  assert.equal(lines.length, 2, 'the record is one line after the name');
  return { error, record: lines[1] };
}

/**
 * Puts the terminal's exit event in the test's hands: the helper subscribes through this wrap (it
 * calls proc.onExit after onSpawn), the real event never reaches it, and the cell passes one in when
 * it chooses. So the order of the exit against the helper's settle is set by the cell, not by timing.
 */
function holdExit(proc) {
  const held = { listener: null };
  Object.defineProperty(proc, 'onExit', { configurable: true, value: (listener) => { held.listener = listener; return { dispose() {} }; } });
  return held;
}

test("ONBINARY-DROP: a 'PTY child timed out' red carries the record of where the time went", { skip: process.platform !== 'win32' }, async (t) => {
  const { record } = await timedOut(t);
  const FIELDS = [
    ['the head, and which call it was (the input says which terminal of a cell)', /^ {2}record, ms since the spawn: call \d+ in this process, input string 1b5b4d208521; /],
    ['the first chunk', /; first chunk \d+; /],
    ['the first chunk in hex, and how much of it is shown', /; first chunk bytes [0-9a-f]+ \(\d+ of \d+ B\); /],
    ['the start-up query: not looked for on the inbox host', /; start-up query not looked for \(host inbox\); /],
    ['READY seen', /; READY seen \d+; /],
    ['the write issued', /; write issued \d+; /],
    ['the write flushed, with the input socket counts', /; write flushed (\d+|none) \(input socket: \d+ B written, \d+ B queued\); /],
    ['TIMEOUT seen, and no BYTES', /; TIMEOUT seen \d+; BYTES seen none; /],
    ['the exit as the seal saw it: with its code, or not seen', EXIT_FIELD],
    ['the three teardown steps', TEARDOWN_FIELD],
    ["the child's start, from the timeOrigin in its TIMEOUT line", /; child start \d+ \(its timeOrigin \d+(\.\d+)?, from its TIMEOUT line\); /],
    ["the child's stdin bytes at its TIMEOUT", /; child stdin at its TIMEOUT \d+ B; /],
    ['the largest gap of the 100 ms interval', /; largest gap of the 100 ms interval \d+ ms, ended at \d+$/]
  ];
  for (const [field, re] of FIELDS) assert.match(record, re, `the record carries ${field}`);
  // The stamps are in the order the call ran: nothing is written before READY, and TIMEOUT is not
  // before READY. (The write is not compared with TIMEOUT: one chunk can hold both lines.)
  const ms = (name) => Number(new RegExp(`; ${name} (\\d+); `).exec(record)[1]);
  assert.ok(ms('first chunk') <= ms('READY seen') && ms('READY seen') <= ms('write issued') && ms('READY seen') <= ms('TIMEOUT seen'),
    `first chunk, READY, then the write and TIMEOUT (${record})`);
  // The teardown is after TIMEOUT and in its own order: the child by pid (if it still ran), then the
  // terminal's kill, then the worker's end. Order only: no step is given a bound here.
  const [, byPid, termKill, workerGone] = TEARDOWN_FIELD.exec(record);
  if (/^\d+$/.test(byPid)) assert.ok(ms('TIMEOUT seen') <= Number(byPid) && Number(byPid) <= Number(termKill), `TIMEOUT, the child by pid, then the terminal kill (${record})`);
  assert.ok(ms('TIMEOUT seen') <= Number(termKill) && Number(termKill) <= Number(workerGone), `TIMEOUT, the terminal kill, then the worker gone (${record})`);
});

// The two legal orders of the exit against the settle, each set by the cell (holdExit), not by timing.
test("ONBINARY-DROP: an exit that comes after the settle leaves 'exit none code none' in the record, and the red keeps its name", { skip: process.platform !== 'win32' }, async (t) => {
  let held;
  const { error, record } = await timedOut(t, (proc) => { held = holdExit(proc); });
  assert.equal(typeof held.listener, 'function', 'the helper took its exit event through the wrap (or this cell holds nothing back)');
  assert.match(record, /; exit none code none; /, 'no exit was seen by the seal, and the record says so');
  assert.match(record, EXIT_FIELD, 'which the record cell accepts');
  assert.doesNotMatch(record, EXIT_SEEN_ONLY, 'and which the pin of before 2026-11-23 did not: this is the order that was red');
  assert.match(record, TEARDOWN_FIELD, 'the teardown steps are there to say where the time went');
  // The exit now comes, after the settle: it changes nothing that was reported.
  const before = error.message;
  held.listener({ exitCode: 1 });
  assert.equal(error.message, before, 'a late exit does not rewrite the sealed record');
});

test("ONBINARY-DROP: an exit that comes before the settle is in the record with its stamp and its code", { skip: process.platform !== 'win32' }, async (t) => {
  let held;
  let passed = 0;
  const { record } = await timedOut(t, (proc) => {
    held = holdExit(proc);
    // Passed in at the helper's own terminal kill: after TIMEOUT, before the worker can have gone.
    const kill = proc.kill.bind(proc);
    proc.kill = (...args) => { passed += 1; if (passed === 1) held.listener({ exitCode: 7 }); return kill(...args); };
  });
  assert.equal(passed, 1, 'the helper called the terminal kill once, and the exit was passed in there');
  const exit = /; exit (\d+) code 7; /.exec(record);
  assert.ok(exit, `the record carries the exit with the code the cell passed in (${record})`);
  assert.match(record, EXIT_FIELD);
  const [, , termKill, workerGone] = TEARDOWN_FIELD.exec(record);
  assert.ok(Number(termKill) <= Number(exit[1]) && Number(exit[1]) <= Number(workerGone), `the exit is stamped between the terminal kill and the worker gone (${record})`);
});

test('ONBINARY-DROP: the exit field of the record has two legal forms, and a mixed one is red', () => {
  for (const legal of ['; exit 812 code 1; ', '; exit 0 code 0; ', '; exit none code none; ']) assert.match(legal, EXIT_FIELD);
  for (const mixed of ['; exit none code 1; ', '; exit 812 code none; ', '; exit  code ; ', '; exit none code none ', '; exit 812 code -1; ']) assert.doesNotMatch(mixed, EXIT_FIELD);
});
