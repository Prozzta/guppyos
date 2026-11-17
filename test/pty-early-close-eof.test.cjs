'use strict';
require('./tools/own-job.cjs');
/**
 * PTY-EARLY-CLOSE-EOF (int-1.1.106). A ConPTY killed right after spawn could throw node-pty's
 * 'stream.push() after EOF' (ERR_STREAM_PUSH_AFTER_EOF) as an uncaught exception (Creed, mutant P4
 * of pty-closetree-pidreuse, 5 of 10 lone runs on a loaded machine).
 *
 * Root cause, in Guppy's close path: armEarlyKill's early close (`_close()`, `_agent.kill()`) sets the
 * data socket `readable = false`. node-pty's own kill only runs after the data pipe connected, but
 * the early one can run BEFORE the conout worker's READY, while the socket has no handle yet. The
 * worker's READY then calls socket.connect(); Node's initSocketHandle runs `_undestroy()`, which sets
 * `ended = (readable === false)`, so the socket connects already ENDED. node-pty registers its error
 * handler on 'ready_datapipe', and the first start-up chunk (Pipe.onStreamRead -> push) is
 * ERR_STREAM_PUSH_AFTER_EOF, which that handler rethrows outside any caller.
 *
 * The lever: the conout worker's messages reach the main thread READY_DELAY_MS late (worker_threads
 * patched BEFORE node-pty loads), as when the worker starts slowly under load, so the kill always
 * lands before the connect. Real ConPTYs, through PtyManager.spawn (which arms every terminal).
 *
 * Named mutants, each must fail this file:
 *   E1 no restore: the unconnected socket keeps readable = false (the pre-fix code)
 *   E2 the restore ignores the connect state (a connected socket is made readable again)
 *   E3 the restore runs before _close()/_agent.kill() (they clear it again)
 *   E5 (Jim) the early close waits for the socket connect (sock.once('connect', close + agent.kill)):
 *      the pseudoconsole is no longer closed at the kill (the PTY-EARLY-KILL-LEAK guarantee)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const READY_DELAY_MS = 300;
const CAP_MS = 8000;

/** Settle within CAP_MS or fail: a mutant must never hang this file. */
function within(p, what) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timed out: ${what}`)), CAP_MS); })])
    .finally(() => clearTimeout(t));
}

if (process.platform !== 'win32') {
  test('PTY-EARLY-CLOSE-EOF is a Windows ConPTY defect (inert here)', () => {});
} else {
  const wt = require('node:worker_threads');
  const on0 = wt.Worker.prototype.on;
  wt.Worker.prototype.on = function (name, fn) {
    if (name === 'message') return on0.call(this, name, (m) => setTimeout(() => fn(m), READY_DELAY_MS));
    return on0.call(this, name, fn);
  };

  const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'pty-eof-'));
  process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
  assert.equal(os.homedir(), JAIL, 'home is redirected before any hive object is built');
  const loadTs = require('./load-ts.cjs');
  const { armEarlyKill, PtyManager } = loadTs('src/main/pty.ts');
  const { holdRoot, rootHandoff } = loadTs('src/main/procIdentity.ts');
  const { awaitHeldExit } = require('./tools/await-exit.cjs');
  const NODE_PTY = path.dirname(require.resolve('node-pty/package.json'));
  const { WindowsTerminal } = require(path.join(NODE_PTY, 'lib', 'windowsTerminal.js'));
  const ROOT = path.join(JAIL, 'root.js');
  fs.writeFileSync(ROOT, 'setInterval(() => {}, 1000);\n');

  const uncaught = [];
  process.on('uncaughtException', (e) => { uncaught.push(e); });
  const owner = { isDestroyed: () => false, send: () => {} };
  const m = new PtyManager();
  let seq = 0;

  // TEST-TEMP-LEAK-UNDER-LOAD: each root is held by handle from its spawn (its pid stays its own, so
  // the kill below can never reach a stranger), and the jail is removed only once every root has
  // EXITED: killAllAsync waits for node-pty's exit report, not the process, and a root still exiting
  // under suite load held the jail (EPERM, swallowed: TEMP LEAK). A root that will not exit, or a jail
  // that still will not go, fails this hook, naming it.
  const holds = [];
  test.after(async () => {
    await m.killAllAsync(2000).catch(() => {});
    for (const { pid } of holds) { try { process.kill(pid); } catch { /* gone */ } }
    try { await awaitHeldExit(holds); } finally { for (const h of holds) h.hold.release(); }
    fs.rmSync(JAIL, { recursive: true, force: true });
  });

  async function spawnSilent() {
    const id = `eof-${++seq}`;
    const r = await m.spawn({ id, cwd: JAIL, command: process.execPath, args: [ROOT], cols: 80, rows: 24, env: {} }, owner);
    assert.equal(r.ok, true, `spawn: ${r.error}`);
    const proc = m.sessions.get(id).proc;
    const hold = holdRoot(proc.pid, 'win32', rootHandoff(proc));
    assert.ok(hold, 'the root is held by handle (resources/fs-handle built)');
    holds.push({ pid: proc.pid, hold });
    return proc;
  }

  test('a kill before the data pipe connects: the pipe connects NOT ended, the first chunk is data, the terminal exits', async () => {
    const proc = await spawnSilent();
    const sock = proc._socket;
    const connected = new Promise((res) => sock.once('ready_datapipe', res));
    const exited = new Promise((res) => proc.onExit(res));
    // PTY-EARLY-KILL-LEAK: the pseudoconsole closes AT the kill, not when the pipe connects.
    let agentKills = 0;
    const agentKill = proc._agent.kill;
    proc._agent.kill = function (...a) { agentKills++; return agentKill.apply(this, a); };
    proc.kill();   // the armed early kill (what closePty/killAllAsync run)
    assert.equal(agentKills, 1, 'the agent kill (ClosePseudoConsole) ran synchronously inside kill()');
    assert.equal(proc._writable, false, '_close() ran synchronously inside kill()');
    assert.equal(sock._handle, null, 'the lever holds: the kill ran before the connect');
    assert.equal(proc._isReady, true, 'the early close ran (node-pty would have queued it)');
    await within(connected, 'ready_datapipe');
    assert.equal(sock._readableState.ended, false, 'the socket connected already ENDED (push after EOF next)');
    // The first start-up chunk, exactly as Pipe.onStreamRead delivers it.
    const got = [];
    sock.on('data', (d) => got.push(String(d)));
    sock.push(Buffer.from('\x1b[?25l'));
    await new Promise((res) => setImmediate(res));
    assert.equal(sock.errored, null, `the chunk errored the socket: ${sock.errored && sock.errored.code}`);
    assert.ok(got.includes('\x1b[?25l'), 'the chunk is ordinary data');
    await within(exited, 'the terminal exit (the drained pipe closes)');
    assert.deepEqual(uncaught.map((e) => e.code || e.message), [], 'nothing thrown outside a caller');
  });

  test('real start-up output after an early kill throws nothing (several terminals)', async () => {
    const exits = [];
    for (let i = 0; i < 4; i++) {
      const proc = await spawnSilent();
      exits.push(new Promise((res) => proc.onExit(res)));
      proc.kill();
    }
    await within(Promise.all(exits), 'every terminal exits');
    await new Promise((res) => setTimeout(res, 200));
    assert.deepEqual(uncaught.map((e) => e.code || e.message), [], 'no ERR_STREAM_PUSH_AFTER_EOF / ENOENT');
  });

  /** A WindowsTerminal from the REAL prototype, with a recording agent, as in pty-early-kill. */
  function terminal({ handle }) {
    const t = Object.create(WindowsTerminal.prototype);
    t._isReady = false;
    t._deferreds = [];
    t._socket = { readable: true, _handle: handle };
    const agentSock = t._socket;
    t._agent = { kill: () => { agentSock.readable = false; } };   // as WindowsPtyAgent.kill does
    return t;
  }

  test('only a socket whose connect is still to come is made readable again; a connected one stays closed', () => {
    const pending = terminal({ handle: null });
    assert.equal(armEarlyKill(pending, 'win32'), true);
    pending.kill();
    assert.equal(pending._socket.readable, true, 'unconnected: left readable for its connect');
    assert.equal(pending._writable, false, 'node-pty\'s own _close still ran');
    const up = terminal({ handle: {} });
    armEarlyKill(up, 'win32');
    up.kill();
    assert.equal(up._socket.readable, false, 'connected: closed exactly as node-pty closes it');
  });
}
