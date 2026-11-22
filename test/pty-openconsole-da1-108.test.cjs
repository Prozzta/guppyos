'use strict';
require('./tools/own-job.cjs');
/**
 * PTY-CONHOST-ORPHAN-OWNER-DEATH (option A), second pin. Every PTY runs on node-pty's bundled
 * OpenConsole. At start-up OpenConsole sends a DA1 query (ESC[c) and holds ALL of the child's output
 * until it is answered or 3 s pass (measured 2026-11-20: 3.03 s unanswered, 32 ms answered). Main
 * answers it for every PTY (src/main/openConsoleHandshake.ts) and takes it out of the stream, so:
 *   - a PTY with no renderer attached starts without the 3 s wait;
 *   - the renderer never sees the query, so it cannot answer a second time (a second answer reaches
 *     the child as typed input: measured, ESC[?62;4;22c arrived on its stdin).
 * And the install stages the pair (tools/stage-node-pty-openconsole.cjs) and checks it among the closing checks.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { tempDir, removeDir } = require('./tools/test-temp.cjs');
// The PTY child must be ON the pseudoconsole: a console-subsystem node.exe, never electron.exe (a GUI-subsystem
// program that ConPTY does not attach, so it neither prints to nor reads from the console).
const { consoleNode } = require('./tools/console-node.cjs');

const ROOT = path.resolve(__dirname, '..');
const loadTs = require('./load-ts.cjs');
const { startupHandshake, DA1_ANSWER } = loadTs('src/main/openConsoleHandshake.ts');

test('handshake: the start-up query is answered and taken out; the child\'s own output and queries pass', () => {
  // The chunks as OpenConsole 1.23.251008001 sent them (measured).
  assert.deepEqual(startupHandshake('\x1b[1t'), { data: '\x1b[1t', answer: false, pending: true });
  assert.deepEqual(startupHandshake('\x1b[c\x1b[?1004h\x1b[?9001h'), { data: '\x1b[?1004h\x1b[?9001h', answer: true, pending: false });
  assert.deepEqual(startupHandshake('\x1b[0c'), { data: '', answer: true, pending: false });
  // the child printed first: its bytes, and a query after them, are the child's and pass untouched
  assert.deepEqual(startupHandshake('CHILD-UP\r\n'), { data: 'CHILD-UP\r\n', answer: false, pending: false });
  assert.deepEqual(startupHandshake('hi\x1b[c'), { data: 'hi\x1b[c', answer: false, pending: false });
  // a title (OSC) before the query is not child output
  assert.deepEqual(startupHandshake('\x1b]0;t\x07\x1b[c'), { data: '\x1b]0;t\x07', answer: true, pending: false });
  assert.equal(DA1_ANSWER, '\x1b[?1;2c', 'the answer xterm.js itself gives');
});

test('install: the OpenConsole pair is staged after the rebuild and checked at the end, and this tree has it', () => {
  const steps = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts.postinstall.split(' && ');
  const stage = steps.indexOf('node tools/stage-node-pty-openconsole.cjs');
  const check = steps.indexOf('node tools/stage-node-pty-openconsole.cjs --check');
  assert.ok(stage > steps.indexOf('electron-rebuild -f -o node-pty'), 'staged after electron-rebuild (which does not run node-pty\'s own post-install)');
  assert.ok(check > stage && check > steps.indexOf('node tools/record-node-pty-race-fix.cjs'), 'and checked among the closing checks');
  if (process.platform !== 'win32') return;
  const { checkStaged, stagedDir, targetArch } = require('../tools/stage-node-pty-openconsole.cjs');
  const np = path.join(ROOT, 'node_modules', 'node-pty');
  assert.deepEqual(checkStaged(np, targetArch()), [], 'Run `npm run postinstall` in this tree: it stages OpenConsole');
  const pins = require('../tools/node-pty-race-fix-pins.cjs');
  for (const [name, want] of Object.entries(pins.OPENCONSOLE_SHA256[targetArch()])) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(stagedDir(np), name))).digest('hex'), want, name);
  }
});

test('install check: --check fails on a missing or changed binary', { skip: process.platform !== 'win32' }, () => {
  const { checkStaged, stage, targetArch } = require('../tools/stage-node-pty-openconsole.cjs');
  const pins = require('../tools/node-pty-race-fix-pins.cjs');
  const arch = targetArch();
  const jail = tempDir('ocstage-');
  try {
    const src = path.join(ROOT, 'node_modules', 'node-pty', 'third_party', 'conpty', pins.CONPTY_THIRD_PARTY_VERSION, `win10-${arch}`);
    const tp = path.join(jail, 'third_party', 'conpty', pins.CONPTY_THIRD_PARTY_VERSION, `win10-${arch}`);
    fs.mkdirSync(tp, { recursive: true });
    for (const n of ['conpty.dll', 'OpenConsole.exe']) fs.copyFileSync(path.join(src, n), path.join(tp, n));
    assert.equal(checkStaged(jail, arch).length, 2, 'nothing staged: both missing');
    stage(jail, arch);
    assert.deepEqual(checkStaged(jail, arch), []);
    fs.appendFileSync(path.join(jail, 'build', 'Release', 'conpty', 'OpenConsole.exe'), 'x');
    assert.match(checkStaged(jail, arch).join(), /OpenConsole\.exe is [0-9a-f]{12}, not the pinned/);
    fs.appendFileSync(path.join(tp, 'conpty.dll'), 'x');
    assert.throws(() => stage(jail, arch), /conpty\.dll is [0-9a-f]{12}, not the pinned/, 'a changed source is never staged');
  } finally { fs.rmSync(jail, { recursive: true, force: true }); }
});

/** An unanswered DA1 holds the child's LAUNCH: OpenConsole starts the child only after the answer or
 *  its 3 s timeout (measured: spawn -> the child's process start 3060 ms unanswered, 59 ms answered).
 *  The bar is spawn -> performance.timeOrigin (the child's process creation), so node's own runtime
 *  start-up under load does not count against it, and the unanswered case can never pass. */
const NO_WAIT_MS = 2_000;

test('an unattached PTY starts with no DA1 wait, the query never reaches the sink, and the child types nothing', { skip: process.platform !== 'win32' }, async () => {
  const dir = tempDir('ocda1-');
  const { PtyManager } = loadTs('src/main/pty.ts');
  const m = new PtyManager();
  const stdinLog = path.join(dir, 'stdin.log');
  fs.writeFileSync(path.join(dir, 'child.cjs'), [
    "'use strict';",
    "const fs = require('fs');",
    'process.stdin.setRawMode(true); process.stdin.resume();',
    `process.stdin.on('data', (b) => fs.appendFileSync(${JSON.stringify(stdinLog)}, b.toString('hex') + '\\n'));`,
    "process.stdout.write('CHILD-UP ' + Math.round(performance.timeOrigin) + ' ' + Date.now() + '\\r\\n');",
    'setTimeout(() => process.exit(0), 1500);'
  ].join('\n'));
  let stream = '';
  let upAt = 0; let stamp = 0; let startedAt = 0; let spawnAt = 0;
  // A sink that never answers anything: no renderer is attached to this terminal.
  const sink = { isDestroyed: () => false, send: (ch, d) => {
    if (typeof d !== 'string') return;
    stream += d;
    const mm = /CHILD-UP (\d+) (\d+)/.exec(stream);
    if (mm && !upAt) { upAt = Date.now(); startedAt = Number(mm[1]); stamp = Number(mm[2]); }
  } };
  const exited = new Promise((r) => { const orig = sink.send; sink.send = (ch, d) => { orig(ch, d); if (ch === 'pty:exit:da1') r(); }; });
  try {
    spawnAt = Date.now();
    const r = await m.spawn({ id: 'da1', cwd: dir, command: consoleNode().file, args: [path.join(dir, 'child.cjs')], cols: 80, rows: 24, env: {} }, sink);
    assert.ok(r.ok, `spawn: ${r.error}`);
    await Promise.race([exited, new Promise((r2) => setTimeout(r2, 15_000))]);
    assert.ok(upAt, `the child's output arrived: ${JSON.stringify(stream.slice(0, 200))}`);
    const waited = startedAt - spawnAt;
    assert.ok(waited < NO_WAIT_MS, `DA1 WAIT: the child process started ${waited} ms after spawn (OpenConsole holds the launch 3 s for an unanswered DA1); it wrote ${stamp - startedAt} ms later, main got it ${upAt - stamp} ms after that`);
    assert.doesNotMatch(stream, /\x1b\[0?c/, 'the start-up query never reaches the renderer, so it is never answered twice');
    assert.equal(fs.existsSync(stdinLog) ? fs.readFileSync(stdinLog, 'utf8') : '', '', 'nothing reached the child as typed input');
  } finally {
    await m.killAllAsync(5_000);
    await removeDir(dir);
  }
});

/** OpenConsole holds an unanswered DA1 for 3 s, then starts the root. A main thread that stays busy
 *  until the root has started AND gone writes the answer to a console that is going away: EAGAIN.
 *  FLAKE-PTY-OPENCONSOLE-DA1-EAGAIN-SAID-108: the wait is on that event, never on a time. A fixed
 *  4.5 s block left the root 1.5 s to start and go; on a loaded bench it was still there, took the
 *  answer without error, and nothing was said. No time decides the result here: ROOT_HANG_MS only
 *  ends a hang, as a failure that names which step never came. */
const ROOT_HANG_MS = 60_000;
const syncNap = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/** Blocks the calling thread until the root has written its pid and that pid is gone; returns the pid. */
function blockUntilRootGone({ readPid, alive, nap = syncNap, now = Date.now, hangMs = ROOT_HANG_MS }) {
  const t0 = now();
  let pid = 0;
  for (;;) {
    if (!pid) pid = readPid();
    if (pid && !alive(pid)) return pid;
    if (now() - t0 >= hangMs) {
      throw new Error(pid ? `HANG: THE ROOT NEVER EXITED (pid ${pid} still alive after ${hangMs} ms)` : `HANG: THE ROOT NEVER STARTED (no pid from it after ${hangMs} ms)`);
    }
    nap(20);
  }
}
/** Alive by the process itself (exit code still pending), synchronously. pty.ts holds the root's handle
 *  until onExit, and onExit cannot run while this thread is blocked, so the pid cannot be reused meanwhile. */
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { if (e.code === 'ESRCH') return false; throw e; } };

/**
 * RECORD of the answer write (a diagnostic: no assert reads it). The suite red of 2026-11-22 (511b2eb3,
 * Electron leg) had the root gone and nothing said, and could not tell "the answer was never written"
 * from "it was written and the console took it". Each event: what happened, the loop turn it was in
 * (events with the same number had no check phase between them), ms since the record began, and
 * whether the terminal's exit had been reported by then. The write gets a callback only to learn how
 * it ended; node-pty passes none, and the pipe's 'error' event is raised with or without one.
 */
function answerWriteRecord(proc, isExited) {
  const events = [];
  const t0 = Date.now();
  let turn = 0; let armed = false;
  const mark = (what) => {
    events.push({ what, turn, ms: Date.now() - t0, exited: isExited() });
    if (!armed) { armed = true; setImmediate(() => { armed = false; turn += 1; }); }
  };
  const call = proc.write.bind(proc);
  proc.write = (data) => { mark(`proc.write called (${JSON.stringify(data)})`); return call(data); };
  const input = proc._agent && proc._agent._inSocket;
  if (!input || typeof input.write !== 'function') { mark('NO INPUT SOCKET TO RECORD'); return { events, mark }; }
  const write = input.write.bind(input);
  input.write = (data, ...rest) => {
    mark('input write attempted');
    const done = (err) => mark(err ? `input write ended with ${err.code ?? err.message}` : 'input write ended: the console took it');
    try {
      const r = rest.length ? write(data, ...rest) : write(data, done);
      mark(`input write returned ${r}`);
      return r;
    } catch (e) {
      mark(`input write threw ${e && (e.code ?? e.message)}`);
      throw e;
    }
  };
  input.on('error', (e) => mark(`input pipe error ${e && (e.code ?? e.message)}`));
  // A destroyed socket fails a later write with ERR_STREAM_DESTROYED to the write's callback and raises NO
  // 'error', so pty.ts says nothing. node-pty's kill() destroys this socket: record who ends it and when.
  const destroy = input.destroy.bind(input);
  input.destroy = (...a) => { mark('input socket destroy() called'); return destroy(...a); };
  input.on('close', () => mark('input socket closed'));
  if (typeof proc.kill === 'function') {
    const kill = proc.kill.bind(proc);
    proc.kill = (...a) => { mark('proc.kill called'); return kill(...a); };
  }
  return { events, mark };
}

/** One EAGAIN cell. `rootLivesMs` is how long the root stays after it starts: 0 is the empty script. */
async function eagainCell(t, id, rootLivesMs) {
  const dir = tempDir('ocin-');
  const { PtyManager } = loadTs('src/main/pty.ts');
  const m = new PtyManager();
  const pidFile = path.join(dir, 'root.pid');
  // The root writes its pid under another name and renames it into place: readPid sees no file or the whole pid, never a part of one.
  fs.writeFileSync(path.join(dir, 'gone.cjs'), `const fs = require('fs'); fs.writeFileSync(${JSON.stringify(`${pidFile}.tmp`)}, String(process.pid)); fs.renameSync(${JSON.stringify(`${pidFile}.tmp`)}, ${JSON.stringify(pidFile)});` + (rootLivesMs ? `setTimeout(() => {}, ${rootLivesMs});` : ''));
  const readPid = () => { try { return Number(fs.readFileSync(pidFile, 'utf8')) || 0; } catch { return 0; } };
  const thrown = [];
  const onUncaught = (e) => thrown.push(`${e && e.code} ${e && e.message}`);
  process.on('uncaughtException', onUncaught);
  const warn = console.warn; const said = [];
  console.warn = (...a) => { said.push(a.join(' ')); };
  let exited = false;
  let rec = { events: [], mark: () => {} };
  const sink = { isDestroyed: () => false, send: (ch) => { if (ch === `pty:exit:${id}`) { exited = true; rec.mark('exit reported'); } } };
  try {
    const r = await m.spawn({ id, cwd: dir, command: consoleNode().file, args: [path.join(dir, 'gone.cjs')], cols: 80, rows: 24, env: {} }, sink);
    assert.ok(r.ok, `spawn: ${r.error}`);
    // The answer goes out from the output handler, in the first turn after this block.
    rec = answerWriteRecord(m.sessions.get(id).proc, () => exited);   // same turn as the spawn's end: nothing has been answered yet
    rec.mark(`block begins (handshake chunks left ${m.sessions.get(id).handshakeChunks}: 8 = no output seen yet, 0 = the handshake was over before this record)`);
    blockUntilRootGone({ readPid, alive: pidAlive });
    rec.mark('block ends: the root\'s pid is gone');
    // CONTROL, still in the blocked turn: what the root was when the answer is about to be written.
    const rootPid = readPid();
    const rootAliveAtWrite = rootPid ? pidAlive(rootPid) : null;
    const t0 = Date.now();
    while (!exited && Date.now() - t0 < 10_000) await new Promise((r2) => setTimeout(r2, 50));
    await new Promise((r2) => setImmediate(r2));
    assert.ok(exited, 'the terminal reported its exit');
    assert.equal(rootAliveAtWrite, false, `THE ROOT HAD STARTED AND GONE BEFORE THE ANSWER WAS WRITTEN (pid ${rootPid}; null = it had not started; the root stays ${rootLivesMs} ms; said ${JSON.stringify(said)})`);
    assert.deepEqual(thrown, [], 'NOTHING IS THROWN OUTSIDE A CALLER: the failed write meets the input pipe\'s error listener');
    assert.ok(said.some((l) => /a write to terminal \d+ failed \(EAGAIN\)/.test(l)), `THE FAILED WRITE IS SAID (the root stays ${rootLivesMs} ms): ${JSON.stringify(said)}; ANSWER WRITE RECORD ${JSON.stringify(rec.events)}`);
  } finally {
    t.diagnostic(`ANSWER WRITE RECORD (${id}) ${JSON.stringify(rec.events)}`);
    process.off('uncaughtException', onUncaught);
    console.warn = warn;
    await m.killAllAsync(5_000);
    await removeDir(dir);
  }
}

test('a write the console can no longer take is said, not thrown outside any caller (EAGAIN)', { skip: process.platform !== 'win32' }, (t) => eagainCell(t, 'ocin', 0));

/** FLAKE-PTY-OPENCONSOLE-DA1-EAGAIN-SAID-108: the cell above needs the answer to be written AFTER the
 *  root has gone. A root that is slow to start or to exit (a loaded bench; here, one that stays 3 s)
 *  must not change the result: the write still comes after it has gone. */
const SLOW_ROOT_LIVES_MS = 3_000;

test('EAGAIN, slow root: the answer is still written after the root has gone, however long the root takes', { skip: process.platform !== 'win32' }, (t) => eagainCell(t, 'ocinslow', SLOW_ROOT_LIVES_MS));

/**
 * FLAKE-PTY-OPENCONSOLE-DA1-EAGAIN-SAID-108, the contract without the console's timing: a write to a
 * REAL terminal's input pipe that fails is said once and never thrown outside a caller. The failure is
 * certain, not raced: this terminal's input socket is made to end every write with EAGAIN, through the
 * stream's own error path (so the 'error' event is raised by Node, a tick after the write, as for a real
 * failed write). Not destroy(): a destroyed socket fails writes with no 'error' event at all. The root
 * stays alive throughout, so no exit is involved. INPUT_HANG_MS only ends a hang, as a named failure.
 */
const INPUT_HANG_MS = 60_000;

test('a failed write on a real terminal\'s input pipe is said once, not thrown outside any caller (injected EAGAIN)', { skip: process.platform !== 'win32' }, async () => {
  const dir = tempDir('ocinj-');
  const { PtyManager } = loadTs('src/main/pty.ts');
  const m = new PtyManager();
  fs.writeFileSync(path.join(dir, 'stay.cjs'), 'setInterval(() => {}, 1000);');
  const thrown = [];
  const onUncaught = (e) => thrown.push(`${e && e.code} ${e && e.message}`);
  process.on('uncaughtException', onUncaught);
  const warn = console.warn; const said = [];
  console.warn = (...a) => { said.push(a.join(' ')); };
  const sink = { isDestroyed: () => false, send: () => {} };
  let hang;
  try {
    const r = await m.spawn({ id: 'ocinj', cwd: dir, command: consoleNode().file, args: [path.join(dir, 'stay.cjs')], cols: 80, rows: 24, env: {} }, sink);
    assert.ok(r.ok, `spawn: ${r.error}`);
    const proc = m.sessions.get('ocinj').proc;
    const input = proc._agent && proc._agent._inSocket;
    assert.ok(input && typeof input._write === 'function', 'this node-pty has the agent\'s input socket');
    let failed = 0;
    const fail = (cb) => { failed += 1; cb(Object.assign(new Error('write EAGAIN'), { code: 'EAGAIN', syscall: 'write' })); };
    input._write = (_data, _enc, cb) => fail(cb);
    input._writev = (_chunks, cb) => fail(cb);
    // The stream ends itself after a failed write. Its close is the event to wait on; an 'error' listener
    // of this cell's own would hide the very thing under test.
    const closed = new Promise((res) => input.once('close', res));
    const hung = new Promise((_res, rej) => { hang = setTimeout(() => rej(new Error(failed ? `HANG: THE INPUT SOCKET NEVER CLOSED after ${failed} failed write(s) (${INPUT_HANG_MS} ms)` : `HANG: NO WRITE REACHED THE INPUT SOCKET (${INPUT_HANG_MS} ms)`)), INPUT_HANG_MS); });
    assert.deepEqual(m.write('ocinj', 'x', 'PROGRAMMATIC'), { ok: true }, 'the caller\'s write returns: the failure comes later, outside it');
    await Promise.race([closed, hung]);
    await new Promise((r2) => setImmediate(r2));
    assert.ok(failed >= 1, 'the write reached the input socket and was failed there');
    assert.deepEqual(thrown, [], 'NOTHING IS THROWN OUTSIDE A CALLER: the failed write meets the input pipe\'s error listener');
    assert.deepEqual(said.filter((l) => /a write to terminal/.test(l)), [`[pty] a write to terminal ${proc.pid} failed (EAGAIN): its console is gone or going; the input is dropped`], `THE FAILED WRITE IS SAID, ONCE: ${JSON.stringify(said)}`);
  } finally {
    clearTimeout(hang);
    process.off('uncaughtException', onUncaught);
    console.warn = warn;
    await m.killAllAsync(5_000);
    await removeDir(dir);
  }
});

test('EAGAIN wait: it ends on the root\'s exit and on nothing else; a hang fails and names its step', () => {
  // A fake clock that only the nap moves: no real time passes.
  const world = (goneAtMs, pidAtMs) => {
    let t = 0; let naps = 0;
    return { now: () => t, nap: (ms) => { t += ms; naps++; }, readPid: () => (t >= pidAtMs ? 4242 : 0), alive: () => t < goneAtMs, naps: () => naps, t: () => t };
  };
  // the root starts at 3 s and goes at 3.1 s: the wait ends there
  let w = world(3_100, 3_000);
  assert.equal(blockUntilRootGone(w), 4242);
  assert.equal(w.t(), 3_100);
  // a root that takes 40 s to go (a loaded bench): the wait is still on it, well past any fixed block
  w = world(40_000, 3_000);
  assert.equal(blockUntilRootGone(w), 4242);
  assert.equal(w.t(), 40_000, 'THE WAIT ENDS AT THE ROOT\'S EXIT, NOT AT A TIME');
  // a pid that is already gone when first read
  w = world(0, 0);
  assert.equal(blockUntilRootGone(w), 4242);
  assert.equal(w.naps(), 0);
  // hangs fail, each with its own cause; they never return
  assert.throws(() => blockUntilRootGone(world(Infinity, 3_000)), /HANG: THE ROOT NEVER EXITED \(pid 4242 still alive after 60000 ms\)/);
  assert.throws(() => blockUntilRootGone(world(Infinity, Infinity)), /HANG: THE ROOT NEVER STARTED \(no pid from it after 60000 ms\)/);
  // a liveness check that fails for another reason is not read as 'gone'
  assert.throws(() => pidAlive(-7.5), (e) => e.code !== 'ESRCH');
});

test('the input-pipe guard: one listener per terminal, said once; a node-pty without the socket is left alone', () => {
  const { guardInputErrors } = loadTs('src/main/pty.ts');
  const { EventEmitter } = require('node:events');
  const sock = new EventEmitter();
  const proc = { pid: 7, _agent: { _inSocket: sock } };
  const warn = console.warn; const said = [];
  console.warn = (...a) => { said.push(a.join(' ')); };
  try {
    assert.equal(guardInputErrors(proc, 'linux'), false, 'unix: nothing to guard');
    assert.equal(sock.listenerCount('error'), 0);
    assert.equal(guardInputErrors(proc, 'win32'), true);
    assert.equal(sock.listenerCount('error'), 1);
    sock.emit('error', Object.assign(new Error('write EAGAIN'), { code: 'EAGAIN' }));
    sock.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    assert.deepEqual(said, ['[pty] a write to terminal 7 failed (EAGAIN): its console is gone or going; the input is dropped']);
    assert.equal(guardInputErrors({ pid: 8, _agent: {} }, 'win32'), false, 'no input socket: left as it was');
    assert.match(said[1], /input-pipe error guard not installed/);
  } finally { console.warn = warn; }
  assert.match(fs.readFileSync(path.join(ROOT, 'src', 'main', 'pty.ts'), 'utf8'), /rootHandoff\(proc\)\);\r?\n(?: *\/\/[^\n]*\n)* *guardInputErrors\(proc\);/, 'every spawn installs it, in the spawn\'s own turn');
});
