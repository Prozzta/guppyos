'use strict';
require('./tools/own-job.cjs');
/**
 * PTY-EARLY-KILL-EPIPE-108. An uncaught 'write EPIPE' on the main thread, outside any caller (seen
 * in pty-late-ready-enoent.test.cjs under full-suite load; in the app that is a main-process throw).
 *
 * Chain. node-pty serves a terminal's output from a worker thread (worker/conoutSocketWorker.js):
 * it reads the console's output pipe and, when the data socket connects to the worker's own pipe,
 * pipes what it has to it (`conoutSocket.pipe(workerSocket)`). workerSocket has no 'error' listener.
 * A data socket destroyed between its connect() and its 'connect' event (node-pty's `_cleanUpProcess`
 * 1 s after the root's exit; guardLateReady) is accepted by the worker and written to, with the
 * reader gone: EPIPE, uncaught in the worker. Node ends the worker and emits the error on the Worker
 * object of this thread; node-pty has no listener there, so Node throws it here.
 *
 * Lever (no load needed). The REAL worker file, served by a fake console output pipe that already
 * wrote its output; a client socket that connects and is destroyed in the same turn. That is the
 * socket destroyed before the worker's write, every time (measured 3 of 3 before this file).
 * Each run asserts that the EPIPE did happen, so the guarded run cannot pass by the lever missing.
 * The control runs in a child process (this file, with CONTROL_FLAG): node:test fails the running
 * test on any uncaught exception, so a run that is meant to have one cannot be a test of this process.
 *
 * Named mutants, each must fail this file:
 *   E1 no guard (the code before this card): the control run here is exactly that
 *   E2 the guard takes every worker error
 *   E3 the guard takes an EPIPE while the data socket is still open
 *   E4 PtyManager.spawn does not install it
 */
/** This file run as the control's child: no tests, just the unguarded scenario, its result on stdout. */
const CONTROL_FLAG = '--epipe-108-control';
const CONTROL = process.argv.includes(CONTROL_FLAG);
const test = CONTROL ? () => {} : require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { EventEmitter } = require('node:events');

const CAP_MS = 10_000;
/** How long the fake console's output is given to reach the worker's buffer before the connect. */
const BUFFERED_MS = 250;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
function within(p, what) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timed out: ${what}`)), CAP_MS); })])
    .finally(() => clearTimeout(t));
}

const loadTs = require('./load-ts.cjs');
const PTYF = 'src/main/pty.ts';
const { guardConoutWorker } = loadTs(PTYF);

/** A terminal with only the internals the guard reads. */
const terminal = (sock, worker) => ({ _socket: sock, _agent: { _conoutSocketWorker: { _worker: worker } } });

test('the guard takes the worker\'s EPIPE for a destroyed data socket, and nothing else', () => {
  const err = (code) => Object.assign(new Error(`write ${code}`), { code });
  const sock = { destroyed: false };
  const worker = new EventEmitter();
  assert.equal(guardConoutWorker(terminal(sock, worker)), true, 'installed');
  assert.equal(worker.listenerCount('error'), 1, 'one listener');
  assert.throws(() => worker.emit('error', err('EPIPE')), /write EPIPE/, 'AN EPIPE WHILE THE DATA SOCKET IS OPEN IS THROWN AGAIN (E3)');
  sock.destroyed = true;
  assert.equal(worker.emit('error', err('EPIPE')), true, 'EPIPE for a destroyed data socket is taken');
  assert.throws(() => worker.emit('error', err('ENOENT')), /write ENOENT/, 'ANOTHER ERROR IS THROWN AGAIN, destroyed socket or not (E2)');
  assert.throws(() => worker.emit('error', new Error('no code')), /no code/, 'an error with no code is thrown again');
  assert.throws(() => worker.emit('error', null), (e) => e === null, 'whatever the worker threw is thrown again as it is');
});

test('a terminal without the internals is left alone', () => {
  assert.equal(guardConoutWorker({}), false);
  assert.equal(guardConoutWorker({ _socket: {}, _agent: {} }), false);
  assert.equal(guardConoutWorker({ _socket: {}, _agent: { _conoutSocketWorker: { _worker: {} } } }), false, 'a worker that is no emitter');
  const worker = new EventEmitter();
  assert.equal(guardConoutWorker({ _agent: { _conoutSocketWorker: { _worker: worker } } }), false, 'no data socket');
  assert.equal(worker.listenerCount('error'), 0, 'nothing installed');
});

test('PtyManager.spawn installs it on every terminal (E4)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', PTYF), 'utf8').replace(/\r\n/g, '\n');
  const spawnAt = src.indexOf('const proc = pty.spawn(');
  const sessionAt = src.indexOf('// Capture THIS session object', spawnAt);
  assert.ok(spawnAt > 0 && sessionAt > spawnAt, 'the spawn and what follows it are where they were');
  const between = src.slice(spawnAt, sessionAt);
  assert.match(between, /\n {6}guardConoutWorker\(proc\);\n/, 'called in the spawn\'s own turn, unconditionally');
  assert.equal(src.split('guardConoutWorker(proc)').length - 1, 1, 'once');
});

if (process.platform !== 'win32') {
  test('PTY-EARLY-KILL-EPIPE-108 is a Windows ConPTY defect (the worker scenario is inert here)', () => {});
} else {
  const { Worker } = require('node:worker_threads');
  const NODE_PTY = path.dirname(require.resolve('node-pty/package.json'));
  const WORKER_JS = path.join(NODE_PTY, 'lib', 'worker', 'conoutSocketWorker.js');
  const { getWorkerPipeName } = require(path.join(NODE_PTY, 'lib', 'shared', 'conout.js'));

  test('the lever matches node-pty: the worker pipes to a socket with no error listener, and nobody listens on the worker', () => {
    const w = fs.readFileSync(WORKER_JS, 'utf8');
    assert.match(w, /createServer\(function \(workerSocket\) \{\s*conoutSocket\.pipe\(workerSocket\);\s*\}\);/, 'the write this card is about');
    assert.doesNotMatch(w, /\.on\('error'/, 'node-pty\'s worker handles no socket error (if it does now, this guard can go)');
    const c = fs.readFileSync(path.join(NODE_PTY, 'lib', 'windowsConoutConnection.js'), 'utf8');
    assert.match(c, /this\._worker = new worker_threads_1\.Worker\(/, 'the worker the guard listens on');
    assert.doesNotMatch(c, /_worker\.on\('error'/, 'node-pty does not listen for the worker\'s error');
  });

  test('on a real terminal the guard finds node-pty\'s worker', async () => {
    const pty = require('node-pty');
    const proc = pty.spawn(process.execPath, ['-e', "process.stdout.write('epipe-108-up'); setInterval(() => {}, 1000);"], {});
    try {
      const gone = new Promise((res) => proc.onExit(res));
      let out = '';
      const up = new Promise((res) => proc.onData((d) => { out += d; if (out.includes('epipe-108-up')) res(); }));
      assert.equal(guardConoutWorker(proc), true, 'THE INTERNALS THE GUARD READS ARE THERE (a node-pty that moved them leaves it off)');
      assert.equal(proc._agent._conoutSocketWorker._worker.listenerCount('error'), 1, 'on the worker itself');
      await within(up, 'the root\'s marker');   // a ConPTY closed in its first ms throws on its own
      proc.kill();
      await within(gone, 'the terminal\'s exit');
    } finally {
      try { proc.kill(); } catch { /* already gone */ }
    }
  });

  let seq = 0;
  /**
   * The real worker, with output already buffered, and a data socket destroyed in the turn of its
   * connect(). `guarded`: the product's guard is on the worker. Returns what this thread saw.
   */
  async function destroyedBeforeTheWrite(guarded) {
    const conoutPipeName = `\\\\.\\pipe\\guppy-epipe-108-${process.pid}-${++seq}`;
    const uncaught = [];
    const onUncaught = (e) => { uncaught.push(`${(e && e.code) || ''} ${e && e.message}`); };
    process.on('uncaughtException', onUncaught);
    let peer;
    const conout = net.createServer((s) => { peer = s; s.on('error', () => {}); });
    await new Promise((res) => conout.listen(conoutPipeName, res));
    const worker = new Worker(WORKER_JS, { workerData: { conoutPipeName } });
    const client = new net.Socket();
    const seen = { connectEvents: 0, clientErrors: [], workerErrors: [] };
    client.on('connect', () => { seen.connectEvents++; });
    client.on('error', (e) => { seen.clientErrors.push(e.message); });
    try {
      const ended = new Promise((res) => worker.once('exit', res));
      await within(new Promise((res) => worker.once('message', res)), 'the worker\'s READY');
      if (guarded) {
        assert.equal(guardConoutWorker(terminal(client, worker)), true, 'the guard is installed');
        // After the guard, so the guard decides first: this only records what came.
        worker.on('error', (e) => { seen.workerErrors.push(`${(e && e.code) || ''} ${e && e.message}`); });
      }
      await within(new Promise((res) => peer.write('output the console wrote before the data socket connected', res)), 'the fake console\'s write');
      await sleep(BUFFERED_MS);
      client.connect(getWorkerPipeName(conoutPipeName));
      client.destroy();   // same turn: before the worker accepts, and so before it writes
      seen.exitCode = await within(ended, 'the worker\'s end (its write to the destroyed socket fails)');
      await sleep(50);    // an error event that follows the exit would land here
      return { ...seen, uncaught };
    } finally {
      process.removeListener('uncaughtException', onUncaught);
      await worker.terminate();
      client.destroy();
      if (peer) peer.destroy();
      await new Promise((res) => conout.close(res));
    }
  }

  if (CONTROL) {
    destroyedBeforeTheWrite(false).then(
      (r) => { process.stdout.write(JSON.stringify(r)); },
      (e) => { process.stderr.write(String((e && e.stack) || e)); process.exitCode = 2; });
  }

  test('control (E1): with no guard, the worker\'s EPIPE is thrown on this thread outside any caller', async () => {
    const out = await within(new Promise((res, rej) => {
      execFile(process.execPath, [__filename, CONTROL_FLAG], { timeout: CAP_MS, windowsHide: true },
        (err, stdout, stderr) => (err ? rej(new Error(`the control's child failed: ${err.message}\n${stderr}`)) : res(stdout)));
    }), 'the control\'s child');
    const r = JSON.parse(out);
    assert.equal(r.exitCode, 1, 'the worker ended on its own error');
    assert.deepEqual(r.uncaught, ['EPIPE write EPIPE'], 'THE LEVER HOLDS: the socket destroyed before the write gives the uncaught EPIPE');
    assert.equal(r.connectEvents, 0, 'the socket was destroyed before its connect event');
    assert.deepEqual(r.clientErrors, [], 'the data socket itself reports nothing');
  });

  test('data socket destroyed before the worker\'s write: the EPIPE is taken, nothing is thrown', async () => {
    const r = await destroyedBeforeTheWrite(true);
    assert.deepEqual(r.workerErrors, ['EPIPE write EPIPE'], 'the EPIPE did happen (the lever held in this run too)');
    assert.deepEqual(r.uncaught, [], 'NOTHING THROWN OUTSIDE A CALLER');
    assert.equal(r.connectEvents, 0, 'the socket was destroyed before its connect event');
    assert.deepEqual(r.clientErrors, [], 'the data socket itself reports nothing');
    assert.equal(r.exitCode, 1, 'the worker ended on its own error');
  });
}
