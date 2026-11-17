'use strict';
require('./tools/own-job.cjs');
/**
 * PTY-EARLY-KILL-EPIPE-108. An uncaught 'write EPIPE' on the main thread, outside any caller (seen
 * in pty-late-ready-enoent.test.cjs under full-suite load; in the app that is a main-process throw).
 *
 * Chain. node-pty serves a terminal's output from a worker thread (worker/conoutSocketWorker.js):
 * it reads the console's output pipe and, when the data socket connects to the worker's own pipe,
 * pipes what it has to it (`conoutSocket.pipe(workerSocket)`). In node-pty 1.1.0 neither socket has
 * an 'error' listener. A data socket destroyed between its connect() and its 'connect' event
 * (node-pty's `_cleanUpProcess` 1 s after the root's exit; guardLateReady) is accepted by the worker
 * and written to, with the reader gone: EPIPE, uncaught in the worker. Node ends the worker and
 * emits the error on the Worker object of the main thread; node-pty has no listener there, so Node
 * throws it there.
 *
 * Fix, at the source: tools/patch-node-pty-root-handle.cjs gives both sockets of the worker an error
 * listener (the edits are WORKER_JS_EDITS in tools/node-pty-race-fix-pins.cjs). EPIPE or ECONNRESET
 * on a socket that is destroyed is a reader that has gone: torn down quietly, the worker lives on.
 * Anything else is thrown again, as before.
 *
 * Lever (no load needed). The REAL worker file, served by a fake console output pipe that already
 * wrote its output; a client socket that connects and is destroyed in the same turn. That is the
 * socket destroyed before the worker's write, every time.
 * The controls run in a child process (this file, with CONTROL_FLAG): node:test fails the running
 * test on any uncaught exception, so a run that is meant to have one cannot be a test of this process.
 *
 * What fails this file:
 *   - a missed postinstall (the installed worker is not the pinned patched one): the first test
 *   - W1 the unpatched worker: the control shows its uncaught EPIPE (so the lever is real)
 *   - W2 no error listener on the data socket: the second control shows the same
 *   - M1..M6 below: each is a change to the patched text that the behaviour check must refuse
 */
/** This file run as a control's child: no tests, one unquiet scenario, its result on stdout. */
const CONTROL_FLAG = '--epipe-108-control';
const CONTROL = process.argv.includes(CONTROL_FLAG) ? process.argv[process.argv.indexOf(CONTROL_FLAG) + 1] : null;
const test = CONTROL ? () => {} : require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');

const pins = require('../tools/node-pty-race-fix-pins.cjs');
const NODE_PTY = path.dirname(require.resolve('node-pty/package.json'));
const WORKER_JS = path.join(NODE_PTY, 'lib', 'worker', 'conoutSocketWorker.js');
const CONOUT_JS = path.join(NODE_PTY, 'lib', 'shared', 'conout.js');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const HINT = 'Run `npm run postinstall` in this tree (tools/patch-node-pty-root-handle.cjs patches node-pty).';

const INSTALLED = fs.readFileSync(WORKER_JS, 'utf8');
/** The installed worker with the pinned edits taken back out: node-pty 1.1.0's own file. */
const PRISTINE = pins.WORKER_JS_EDITS.reduce((s, [, before, after]) => s.replace(after, () => before), INSTALLED);
/** One exact replacement; a text that does not have `from` exactly once is a broken test. */
function swap(text, from, to, what) {
  assert.equal(text.split(from).length - 1, 1, `${what}: the text to change is there once`);
  return text.replace(from, () => to);
}
const DATA_EDIT = pins.WORKER_JS_EDITS[1];
/** W2: the patched worker without the data socket's part of the patch. */
const NO_DATA_LISTENER = swap(INSTALLED, DATA_EDIT[2], DATA_EDIT[1], 'W2');
/** The patched worker, reporting what its data socket's listener saw (the listener is otherwise as it is). */
const REPORTING = swap(INSTALLED, "        workerSocket.on('error', function (err) {\n",
  "        workerSocket.on('error', function (err) {\n" +
  '            worker_threads_1.parentPort.postMessage({ saw: err.code, destroyed: workerSocket.destroyed });\n', 'the reporting twin');

const CAP_MS = 10_000;
/** How long the fake console's output is given to reach the worker's buffer before the connect. */
const BUFFERED_MS = 250;
/** How long a worker that must NOT end is watched after the failed write (the unpatched one ends in a few ms). */
const STAYS_MS = 500;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
function within(p, what) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timed out: ${what}`)), CAP_MS); })])
    .finally(() => clearTimeout(t));
}

test('A MISSED POSTINSTALL FAILS HERE: the installed worker is the pinned patched one, and without the edits it is node-pty 1.1.0\'s', () => {
  assert.equal(sha(INSTALLED), pins.WORKER_JS_QUIET_SHA256,
    `node_modules/node-pty/lib/worker/conoutSocketWorker.js is not the patched worker (an unpatched one throws EPIPE in the main process). ${HINT}`);
  assert.equal(sha(PRISTINE), pins.WORKER_JS_PRISTINE_SHA256, 'the control\'s worker is the published file, byte for byte');
  assert.notEqual(PRISTINE, INSTALLED);
  assert.doesNotMatch(PRISTINE, /\.on\('error'/, 'node-pty\'s own worker handles no socket error');
  assert.equal(INSTALLED.split(".on('error'").length - 1, 2, 'the patched one: the console pipe and the data socket');
});

test('the main thread still has no listener for the worker\'s error (so a worker error is a main-process throw)', () => {
  const c = fs.readFileSync(path.join(NODE_PTY, 'lib', 'windowsConoutConnection.js'), 'utf8');
  assert.match(c, /this\._worker = new worker_threads_1\.Worker\(path_1\.join\(scriptPath, 'worker\/conoutSocketWorker\.js'\)/, 'the file this card patches is the one node-pty runs');
  assert.doesNotMatch(c, /_worker\.on\('error'/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'pty.ts'), 'utf8'), /guardConoutWorker|worker\??\.on\(/,
    'and the product does not filter it on the main side: the fix is in the worker');
});

/** The worker text run against stand-in sockets: what it does with an error on either of them. */
function load(text) {
  const made = [];
  class Sock extends EventEmitter {
    constructor() { super(); this.destroyed = false; this.piped = []; this.unpiped = []; this.ended = 0; made.push(this); }
    setEncoding() {}
    connect(_name, cb) { this.connected = cb; }
    pipe(dest) { this.piped.push(dest); return dest; }
    unpipe(dest) { this.unpiped.push(dest); }
    end() { this.ended++; }
  }
  let accept;
  const mods = {
    worker_threads: { workerData: { conoutPipeName: 'p' }, parentPort: { postMessage() {} } },
    net: { Socket: Sock, createServer: (fn) => { accept = fn; return { listen() {} }; } },
    '../shared/conout': { getWorkerPipeName: (n) => `${n}-worker` }
  };
  // eslint-disable-next-line no-new-func
  new Function('require', 'exports', text)((n) => { if (!mods[n]) throw new Error(`unexpected require ${n}`); return mods[n]; }, {});
  const conout = made[0];
  conout.connected();
  return { conout, data: () => { const s = new Sock(); accept(s); return s; } };
}
const err = (code) => Object.assign(new Error(`write ${code}`), code ? { code } : {});

/** Throws unless `text` is quiet for a reader that has gone, and for nothing else. */
function quietOnlyForAPeerThatHasGone(text) {
  const { conout, data } = load(text);
  const a = data();
  assert.deepEqual(conout.piped, [a], 'the data socket is piped to');
  assert.equal(a.listenerCount('error'), 1, 'THE DATA SOCKET HAS AN ERROR LISTENER');
  assert.throws(() => a.emit('error', err('EPIPE')), /write EPIPE/, 'AN EPIPE ON A SOCKET THAT IS NOT DESTROYED IS THROWN AGAIN');
  a.destroyed = true;
  conout.unpiped.length = 0;
  assert.equal(a.emit('error', err('EPIPE')), true, 'EPIPE on a destroyed data socket is taken');
  assert.deepEqual(conout.unpiped, [a], 'AND THE CONSOLE PIPE NO LONGER WRITES TO IT');
  assert.equal(a.emit('error', err('ECONNRESET')), true, 'ECONNRESET on a destroyed data socket is taken');
  assert.throws(() => a.emit('error', err('ENOENT')), /write ENOENT/, 'ANOTHER ERROR IS THROWN AGAIN, destroyed socket or not');
  assert.throws(() => a.emit('error', err('')), /write /, 'an error with no code is thrown again');
  a.emit('close');
  const b = data();
  assert.equal(conout.listenerCount('error'), 1, 'THE CONSOLE PIPE HAS AN ERROR LISTENER');
  assert.throws(() => conout.emit('error', err('ECONNRESET')), /write ECONNRESET/, 'a console pipe that is not destroyed: thrown again');
  conout.destroyed = true;
  assert.throws(() => conout.emit('error', err('EACCES')), /write EACCES/, 'another error on the console pipe: thrown again');
  assert.equal(b.ended, 0, 'nothing ended yet');
  assert.equal(conout.emit('error', err('ECONNRESET')), true, 'a console that has gone is taken');
  assert.equal(b.ended, 1, 'THE OPEN DATA SOCKET IS ENDED (the terminal sees its output end)');
  assert.equal(a.ended, 0, 'A DATA SOCKET THAT CLOSED IS NOT TOUCHED AGAIN');
}

test('the patched worker is quiet for a reader that has gone, and for nothing else', () => {
  quietOnlyForAPeerThatHasGone(INSTALLED);
});

const GONE = "    return !!err && (err.code === 'EPIPE' || err.code === 'ECONNRESET') && socket.destroyed === true;\n";
const MUTANTS = [
  ['M1 every error is taken', (t) => swap(t, GONE, '    return true;\n', 'M1')],
  ['M2 a socket that is still open counts as gone', (t) => swap(t, ' && socket.destroyed === true;\n', ';\n', 'M2')],
  ['M3 the console pipe keeps writing to the dead socket', (t) => swap(t, '            conoutSocket.unpipe(workerSocket);\n', '', 'M3')],
  ['M4 closed data sockets are kept', (t) => swap(t, '            guppyDataSockets.splice(guppyDataSockets.indexOf(workerSocket), 1);\n', '', 'M4')],
  ['M5 a console that has gone leaves the data sockets open', (t) => swap(t, '    guppyDataSockets.slice().forEach(function (dataSocket) { dataSocket.end(); });\n', '', 'M5')],
  ['M6 no listener on the data socket (W2)', () => NO_DATA_LISTENER],
  ['M7 the unpatched worker (W1)', () => PRISTINE]
];
test('each named change to the patched worker is refused by that check', () => {
  for (const [name, change] of MUTANTS) {
    assert.throws(() => quietOnlyForAPeerThatHasGone(change(INSTALLED)), assert.AssertionError, `${name} MUST FAIL the behaviour check`);
  }
});

if (process.platform !== 'win32') {
  test('PTY-EARLY-KILL-EPIPE-108 is a Windows ConPTY defect (the real-worker scenario is inert here)', () => {});
} else {
  const { Worker } = require('node:worker_threads');
  const { getWorkerPipeName } = require(CONOUT_JS);

  /** A worker text as a file that can run outside node-pty's lib folder. Returns [file, remove]. */
  function asFile(text) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'epipe108-'));
    const file = path.join(dir, 'worker.js');
    fs.writeFileSync(file, swap(text, 'require("../shared/conout")', `require(${JSON.stringify(CONOUT_JS)})`, 'the worker\'s one relative require'));
    return [file, () => fs.rmSync(dir, { recursive: true, force: true })];
  }

  let seq = 0;
  /**
   * A real worker (`file`), with output already buffered, and a data socket destroyed in the turn
   * of its connect(). `mustEnd`: wait for the worker's end; otherwise watch it for STAYS_MS and, if
   * it lives, connect a second data socket and read later console output through it.
   * Nothing here listens for the worker's 'error': an error from it is thrown on this thread.
   */
  async function destroyedBeforeTheWrite(file, mustEnd) {
    const conoutPipeName = `\\\\.\\pipe\\guppy-epipe-108-${process.pid}-${++seq}`;
    const uncaught = [];
    const onUncaught = (e) => { uncaught.push(`${(e && e.code) || ''} ${e && e.message}`); };
    process.on('uncaughtException', onUncaught);
    let peer;
    const conout = net.createServer((s) => { peer = s; s.on('error', () => {}); });
    await new Promise((res) => conout.listen(conoutPipeName, res));
    const worker = new Worker(file, { workerData: { conoutPipeName } });
    const client = new net.Socket();
    const second = new net.Socket();
    const seen = { connectEvents: 0, clientErrors: [], reports: [], exitCode: null, later: '' };
    client.on('connect', () => { seen.connectEvents++; });
    client.on('error', (e) => { seen.clientErrors.push(e.message); });
    second.on('error', (e) => { seen.clientErrors.push(`second: ${e.message}`); });
    try {
      const ended = new Promise((res) => worker.once('exit', res));
      await within(new Promise((res) => worker.once('message', res)), 'the worker\'s READY');
      worker.on('message', (m) => { seen.reports.push(m); });
      await within(new Promise((res) => peer.write('output the console wrote before the data socket connected', res)), 'the fake console\'s write');
      await sleep(BUFFERED_MS);
      client.connect(getWorkerPipeName(conoutPipeName));
      client.destroy();   // same turn: before the worker accepts, and so before it writes
      if (mustEnd) {
        seen.exitCode = await within(ended, 'the worker\'s end (its write to the destroyed socket fails)');
        await sleep(50);  // an error event that follows the exit would land here
      } else {
        seen.exitCode = await Promise.race([ended, sleep(STAYS_MS).then(() => null)]);
        if (seen.exitCode === null) {
          second.setEncoding('utf8');
          const got = new Promise((res) => second.on('data', (d) => { seen.later += d; if (seen.later.includes('later output')) res(); }));
          await within(new Promise((res) => second.connect(getWorkerPipeName(conoutPipeName), res)), 'the second data socket\'s connect');
          peer.write('later output');
          await within(got, 'later console output on the second data socket');
        }
      }
      return { ...seen, uncaught };
    } finally {
      process.removeListener('uncaughtException', onUncaught);
      await worker.terminate();
      client.destroy();
      second.destroy();
      if (peer) peer.destroy();
      await new Promise((res) => conout.close(res));
    }
  }
  async function withText(text, mustEnd) {
    const [file, remove] = asFile(text);
    try { return await destroyedBeforeTheWrite(file, mustEnd); } finally { remove(); }
  }

  const CONTROLS = { pristine: PRISTINE, 'no-data-listener': NO_DATA_LISTENER };
  if (CONTROL) {
    withText(CONTROLS[CONTROL], true).then(
      (r) => { process.stdout.write(JSON.stringify(r)); },
      (e) => { process.stderr.write(String((e && e.stack) || e)); process.exitCode = 2; });
  }
  const control = (which) => within(new Promise((res, rej) => {
    execFile(process.execPath, [__filename, CONTROL_FLAG, which], { timeout: CAP_MS, windowsHide: true },
      (e, stdout, stderr) => (e ? rej(new Error(`the control's child failed: ${e.message}\n${stderr}`)) : res(JSON.parse(stdout))));
  }), `the ${which} control's child`);
  const UNQUIET = [
    ['control (W1): node-pty 1.1.0\'s own worker throws the EPIPE on the main thread, outside any caller', 'pristine'],
    ['W2: the patched worker WITHOUT the data socket\'s error listener throws it just the same', 'no-data-listener']
  ];
  for (const [name, which] of UNQUIET) {
    test(name, async () => {
      const r = await control(which);
      assert.equal(r.exitCode, 1, 'the worker ended on its own error');
      assert.deepEqual(r.uncaught, ['EPIPE write EPIPE'], 'THE LEVER HOLDS: the socket destroyed before the write gives the uncaught EPIPE');
      assert.equal(r.connectEvents, 0, 'the socket was destroyed before its connect event');
      assert.deepEqual(r.clientErrors, [], 'the data socket itself reports nothing');
    });
  }

  const quiet = (r) => {
    assert.deepEqual(r.uncaught, [], 'NOTHING THROWN OUTSIDE A CALLER');
    assert.equal(r.exitCode, null, 'THE WORKER LIVES ON (it did not end on the error)');
    assert.equal(r.connectEvents, 0, 'the socket was destroyed before its connect event');
    assert.deepEqual(r.clientErrors, [], 'neither data socket reports an error');
    assert.equal(r.later, 'later output', 'A SECOND DATA SOCKET GETS THE CONSOLE\'S LATER OUTPUT, and none of what went to the dead one');
  };

  test('the patched worker, reporting: the same lever gives its listener EPIPE on a destroyed socket, and it stays quiet', async () => {
    const r = await withText(REPORTING, false);
    assert.deepEqual(r.reports, [{ saw: 'EPIPE', destroyed: true }], 'the EPIPE did happen, once, and the socket was destroyed by then');
    quiet(r);
  });

  test('THE INSTALLED WORKER, as node-pty runs it: data socket destroyed before the write, nothing is thrown, the worker serves the next socket', async () => {
    const r = await destroyedBeforeTheWrite(WORKER_JS, false);
    assert.deepEqual(r.reports, [], 'the installed file reports nothing (it is not the twin)');
    quiet(r);
  });
}
