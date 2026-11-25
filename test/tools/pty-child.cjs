'use strict';
/**
 * ONBINARY-DROP-ELECTRON-FILE-NEVER-EXITS-108: one real PTY child that reports the bytes it read.
 *
 * The child prints READY:<its stdout and stdin are TTYs>, echoes the first stdin chunk as BYTES:[...] and exits 0; with no input it
 * prints TIMEOUT and exits 2 after 3 s. childBytes(input) resolves with the byte array, or rejects
 * naming what the child did instead.
 *
 * The program is a parameter. A Windows GUI-subsystem program (electron.exe, also when it runs as
 * Node) is NOT attached to the pseudoconsole: its stdout and stdin are not the console, so no READY
 * comes out and no input goes in. Tests that need the bytes pass consoleNode().file (console-node.cjs).
 *
 * Teardown: the terminal is armed with the app's armEarlyKill, and the promise settles only once the
 * conout worker thread has exited. Without the arm, node-pty never kills a terminal that printed
 * nothing, the worker stays, and the test file never ends (every Electron leg waited out the 30 min
 * file limit). A teardown that does not finish is a named failure.
 *
 * TEST-ONLY. This teardown always ends in an explicit kill, so a green run here says nothing about
 * what the app frees when a terminal exits by itself: PtyManager's exit path calls no kill and leaves
 * the worker and the input socket (PTY-NATURAL-EXIT-NO-KILL-LEAK). A test that claims to cover the
 * app's own teardown must go through PtyManager, not through this helper.
 *
 * FLAKE-ONBINARY-DROP-PTY-CHILD-TIMEOUT-ELECTRON-108, the record. Two clocks end a call that got no
 * bytes: the child's own 3 s (from its start) and this helper's 5 s (from the spawn). A red named
 * only the clock that won. The three errors of those clocks ('timed out', 'did not answer',
 * 'exited N') now carry a record line: when each step was seen in ms since the spawn, when the child
 * says it started, what it had read, and the longest stall of this process. It records only: no
 * clock, bound or order of the call is changed by it.
 * The exit in the record is the terminal's exit event AS THE SEAL SAW IT. The call settles when the
 * conout worker has gone and does not wait for that event: on the inbox host node-pty emits it when
 * its output socket closes, and that close is not ordered against the worker's end. So both
 * 'exit N code N' and 'exit none code none' are legal records (the second was seen on 2026-11-23, an
 * Electron suite leg). The teardown stamps say where the time went then: when the child was ended by
 * its pid, when the terminal's kill was called, and when the conout worker had gone.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const pty = require('node-pty');
const loadTs = require('../load-ts.cjs');
const { armEarlyKill } = loadTs('src/main/pty.ts');
const { holdRoot, rootHandoff } = loadTs('src/main/procIdentity.ts');
// The app's own reader of OpenConsole's start-up query (loaded, not copied: one rule for both).
const { startupHandshake } = loadTs('src/main/openConsoleHandshake.ts');

/**
 * From the kill to the conout worker's exit node-pty takes 1 s (its flush interval). On the inbox
 * conhost the same cap is also given, before that kill, to the wait for a child ended by its pid.
 */
const TEARDOWN_CAP_MS = 8000;

// For the record: both lines carry the child's own start (performance.timeOrigin, wall-clock ms), and
// TIMEOUT says how many stdin bytes the child had read by then (counted by a listener of its own).
const CHILD = [
  "process.stdin.setRawMode?.(true); process.stdin.resume();",
  "let stdinBytes = 0; process.stdin.on('data', (data) => { stdinBytes += data.length; });",
  "process.stdout.write('READY:' + (process.stdout.isTTY === true && process.stdin.isTTY === true) + ' t0=' + performance.timeOrigin + '\\n');",
  "process.stdin.once('data', (data) => { process.stdout.write('BYTES:' + JSON.stringify([...data]) + '\\n'); process.exit(0); });",
  "setTimeout(() => { process.stdout.write('TIMEOUT t0=' + performance.timeOrigin + ' stdin=' + stdinBytes + '\\n'); process.exit(2); }, 3000);"
].join(' ');

/** The record's stall probe: an interval of this length, whose longest gap between two ticks is kept. */
const RECORD_TICK_MS = 100;
/** childBytes calls of this process so far: the record says which one a red was. */
let calls = 0;
/** The record prints this many bytes of the terminal's first chunk, in hex. */
const FIRST_CHUNK_SHOWN = 64;

/** electron.exe, by name or because this process is one. */
function isElectronExe(file) {
  return /^electron(\.exe)?$/i.test(path.basename(file)) || (file === process.execPath && Boolean(process.versions.electron));
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * Is `child` on the OWNER's console? The owner is this process, the one that runs childBytes and
 * owns the terminal: the console that node-pty's list kill must not reach is this one. It is asked
 * through this process's own pid (console-list-helper.cjs, a fork: a process has one console), so
 * the answer does not depend on whether the child's pid can still be attached to.
 *
 * { listed, list } only for a list that proves it is the owner's: the call did not fail and the
 * list holds the owner itself. Everything else is { why }: no answer, which says nothing about the
 * child. A failed call, an empty list, a list without the owner and a helper that ended without a
 * message are all "no answer". (The list of the CHILD's pid, taken with node-pty's own helper, was
 * read here before: that helper answers [] for any failure, and [] was read as "the child is gone".)
 *
 * Not covered, and safe: a console-subsystem child on this host is on the pseudoconsole, never on
 * the owner's console. The owner's list never holds it, so its terminal is closed as soon as its
 * hold says it has exited, with no wait for the pseudoconsole to drop it. node-pty's list kill
 * then reaches the pseudoconsole's processes only, which are the terminal's own.
 *
 * Not covered: a process the child started (a grandchild). The rule asks about the child's pid
 * only, by its hold and by its place on the owner's list; nothing here waits for a grandchild or
 * looks for one. The one that was measured (electron as node, started by the child) could be
 * attached to through no console: a list asked through its pid gave 'AttachConsole failed'.
 * Whether a grandchild can sit on the owner's console was not looked at. A pid on the owner's list
 * that nobody knows is the sign to look.
 */
function onOwnerConsole(child) {
  return new Promise((resolve) => {
    const agent = cp.fork(path.join(__dirname, 'console-list-helper.cjs'), [String(process.pid)]);
    let got = null;
    agent.on('message', (m) => { got = m; });
    agent.on('exit', () => resolve(ownerAnswer(got, child)));
    agent.on('error', (e) => resolve({ why: `the list helper did not start (${e && e.message})` }));
  });
}
function ownerAnswer(m, child) {
  if (!m) return { why: 'the list helper ended without a message' };
  if (m.error) return { why: m.error };
  const list = m.consoleProcessList;
  if (!Array.isArray(list) || !list.includes(process.pid)) return { why: `the list does not hold the owner itself (${JSON.stringify(list)})` };
  return { listed: list.includes(child), list };
}

/**
 * Does the owner (this process) have a console at all? Asked of Windows directly: the owner opens
 * its own console device and closes it again. No helper, no fork and no list, so this never reads
 * a failed list as an answer.
 *
 * { console: 'none' } only for the one measured code, EBADF: what electron.exe run as Node gets,
 * a GUI-subsystem program that was given no console (the owner of onbinary-drop's terminal under
 * the Electron leg). The device opens, or fails with any other code: { console: 'has' }, and the
 * list of the owner's console is required as before. Asked at each close, never kept: a process
 * can get or lose its console while it runs.
 *
 * `io` is the opener (fs); a test gives its own.
 */
function ownerConsole(io = fs) {
  let fd;
  try { fd = io.openSync('\\\\.\\CONOUT$', 'r+'); } catch (e) {
    const code = String(e && e.code);
    return code === 'EBADF' ? { console: 'none', code } : { console: 'has', code };
  }
  io.closeSync(fd);
  return { console: 'has' };
}

/**
 * Resolves once a child is off the owner's console: first its hold says it has exited, then a list
 * of the owner's console no longer holds it. The second step is not the first again: an exit
 * signals the process handle, and the console drops the process from its list in its own time. So
 * it is asked for every child, also one that exited by itself (`byPid` false: the hold said so at
 * once and no kill was sent). Only a list that is the owner's counts (see onOwnerConsole): no answer
 * is asked again. Both steps share one cap; at the cap it rejects with the step that did not come,
 * and for a list that never came with the reason the last ask gave.
 *
 * `owner` is what ownerConsole() said. With { console: 'none' } the first step stays and the second
 * is left out: there is no owner's console for the child to be on, and no list of it can be taken
 * (the call fails every time, which would refuse every close at the cap). Why that is safe: the
 * child has exited by then, and node-pty's list helper is a fork of an owner with no console, so
 * it fails before it can attach to anything and node-pty gets an empty list from it. What is not
 * claimed: node-pty's own 5 s fallback names the child's pid when its helper does not answer, with
 * or without a console; that path is node-pty's and is not waited for here.
 */
async function offConsole(pid, hold, byPid, owner) {
  const end = Date.now() + TEARDOWN_CAP_MS;
  const since = byPid ? 'after its kill by pid' : 'after its hold first said so';
  while (hold.alive()) {
    if (Date.now() >= end) throw new Error(`the child never exited after its kill by pid (its hold still says it runs, ${TEARDOWN_CAP_MS} ms on), so its terminal is not closed`);
    await sleep(25);
  }
  if (owner.console === 'none') return;
  for (;;) {
    const got = await onOwnerConsole(pid);
    if (got.listed === false) return;
    if (Date.now() >= end) {
      throw new Error(got.listed
        ? `the child has exited and the console of its pid still lists it ${TEARDOWN_CAP_MS} ms ${since} (the owner's console: ${JSON.stringify(got.list)}), so its terminal is not closed`
        : `the owner's own console could not be listed: ${got.why} (the child has exited, ${TEARDOWN_CAP_MS} ms ${since}), so its terminal is not closed`);
    }
    await sleep(25);
  }
}

/** The electron binary of this checkout (the running one under the Electron leg). */
function electronExe() {
  return process.versions.electron ? process.execPath : require('electron');
}

/**
 * @param input what the test writes once the child said READY
 * @param opts.file the child program; opts.env its env; opts.onSpawn(proc) sees the terminal first
 * @param opts.prelude JS run in the child before its script (a test uses it to make a child that is
 *   on the PTY say it is not)
 * @param opts.host Windows only. 'openconsole' (the default): the bundled OpenConsole, the host the
 *   app runs every terminal on. 'inbox': the Windows inbox conhost, which the app no longer uses; a
 *   test that asks for it says why.
 * @param opts.onOwnerCheck inbox host only: called at the close with what ownerConsole() said
 * @param opts.onHandshake called once, when the call ends (green or red), with what the helper saw of
 *   the start-up handshake: { looked, order, query, inputAtReady, firstChunk }. `order` is the steps
 *   in the order they were seen ('query', 'ready', 'write', 'bytes'), with no times
 *   in it; `inputAtReady` is what the terminal's input socket had been given when READY was seen.
 */
function childBytes(input, { file = process.execPath, env = process.env, onSpawn, prelude = '', host = 'openconsole', onOwnerCheck, onHandshake } = {}) {
  // An electron.exe without this key is a real app with a window: never start one from here.
  if (isElectronExe(file)) assert.equal(env.ELECTRON_RUN_AS_NODE, '1', `${file} runs as Node only (ELECTRON_RUN_AS_NODE=1 in its env)`);
  assert.equal(host === 'openconsole' || host === 'inbox', true, `host is 'openconsole' or 'inbox', not ${JSON.stringify(host)}`);
  const inbox = process.platform === 'win32' && host === 'inbox';
  const call = ++calls;
  return new Promise((resolve, reject) => {
    // The record's two zero points, taken just before the spawn: wall clock (to place the child's
    // timeOrigin) and this process's monotonic clock (every stamp is ms since it).
    const spawnWall = Date.now();
    const spawnAt = performance.now();
    const at = () => Math.round(performance.now() - spawnAt);
    const proc = pty.spawn(file, ['-e', `${prelude}${CHILD}`], {
      name: 'xterm-256color', cols: 120, rows: 24, cwd: process.cwd(), env,
      // NODEPTY-CONSOLE-LIST-KILL-SIBLINGS: as the app spawns every terminal (PtyManager.spawn,
      // PTY-CONHOST-ORPHAN option A). On the bundled OpenConsole node-pty's kill asks for no
      // console list.
      useConptyDll: process.platform === 'win32' && !inbox
    });
    // Inbox path only: held in the same turn as the spawn, as the app holds every root
    // (PTY-KILL-PID-IDENTITY). While it is held the pid is this child's and nobody else's. Null
    // with no addon: finish() then names no pid and closes nothing, and fails by name.
    const hold = inbox ? holdRoot(proc.pid, process.platform, rootHandoff(proc)) : null;
    const releaseHold = () => { if (hold) hold.release(); };
    // As the app does for every terminal (PtyManager.spawn): node-pty alone holds kill() back until
    // the terminal's first data chunk, and a child that never prints is then never killed.
    if (process.platform === 'win32') assert.equal(armEarlyKill(proc), true, 'armEarlyKill fits this node-pty');
    if (onSpawn) onSpawn(proc);
    // node-pty frees the conout worker thread only from its kill (1 s after it), never from the exit.
    const worker = proc._agent?._conoutSocketWorker?._worker ?? null;
    if (process.platform === 'win32') assert.ok(worker, 'the terminal has a conout worker (node-pty 1.1.0 internals)');
    const workerGone = worker && new Promise((res) => worker.once('exit', res));
    let output = '';
    let ended = false;
    let wrote = false;
    // ---- the record (see the file header). Stamps are ms since the spawn; null is "not seen". ----
    const stamp = { first: null, ready: null, write: null, flushed: null, timeout: null, bytes: null, exit: null, exitCode: null };
    // The teardown, record only. pidKill stays null on a host where no pid is named (not the inbox).
    const torn = { pidKill: null, termKill: null, workerGone: null };
    // The start-up handshake (see the file header). Looked for on the bundled OpenConsole only: the
    // other hosts send no such query. `order` holds the steps as they were seen, with no times.
    const hs = { looked: process.platform === 'win32' && !inbox, pending: process.platform === 'win32' && !inbox, query: null, inputAtReady: null };
    const order = [];
    let firstChunk = null;
    // node-pty's write takes no callback. Its input socket's queue is read instead: a length of 0
    // after the write says the socket's own write callback has run. Read at each tick and each chunk,
    // so the stamp can be up to one tick late. Windows only (no such socket elsewhere).
    const inSocket = proc._agent?.inSocket ?? null;
    const noteFlushed = () => {
      if (stamp.write !== null && stamp.flushed === null && inSocket && inSocket.writableLength === 0) stamp.flushed = at();
    };
    const gap = { ms: 0, endedAt: null };
    let lastTick = at();
    const noteGap = () => {
      const now = at();
      if (now - lastTick > gap.ms) { gap.ms = now - lastTick; gap.endedAt = now; }
      lastTick = now;
    };
    const ticker = setInterval(() => { noteGap(); noteFlushed(); }, RECORD_TICK_MS);
    const record = () => {
      const show = (v) => (v === null ? 'none' : String(v));
      const ready = /READY:\w+ t0=([\d.]+)/.exec(output);
      const timeout = /TIMEOUT t0=([\d.]+) stdin=(\d+)/.exec(output);
      const origin = timeout ? Number(timeout[1]) : ready ? Number(ready[1]) : null;
      const hex = Buffer.isBuffer(input) ? input.toString('hex') : Buffer.from(String(input), 'latin1').toString('hex');
      return '\n  record, ms since the spawn:'
        + ` call ${call} in this process, input ${Buffer.isBuffer(input) ? 'Buffer' : typeof input} ${hex};`
        + ` first chunk ${show(stamp.first)}; first chunk bytes ${firstChunk === null ? 'none' : `${firstChunk.hex} (${firstChunk.shown} of ${firstChunk.length} B)`};`
        + (hs.looked
          ? ` start-up query seen ${show(hs.query)}; input socket at READY ${hs.inputAtReady === null ? 'none' : `${hs.inputAtReady} B`};`
          : ` start-up query not looked for (host ${inbox ? 'inbox' : process.platform});`)
        + ` READY seen ${show(stamp.ready)}; write issued ${show(stamp.write)};`
        + ` write flushed ${show(stamp.flushed)}${inSocket ? ` (input socket: ${inSocket.bytesWritten} B written, ${inSocket.writableLength} B queued)` : ' (no input socket to read)'};`
        + ` TIMEOUT seen ${show(stamp.timeout)}; BYTES seen ${show(stamp.bytes)}; exit ${show(stamp.exit)} code ${show(stamp.exitCode)};`
        + ` teardown: child ended by pid ${show(torn.pidKill)}; terminal kill ${show(torn.termKill)}; conout worker gone ${show(torn.workerGone)};`
        + ` child start ${origin === null ? 'none (no READY or TIMEOUT line with its timeOrigin)' : `${Math.round(origin - spawnWall)} (its timeOrigin ${origin}, from its ${timeout ? 'TIMEOUT' : 'READY'} line)`};`
        + ` child stdin at its TIMEOUT ${timeout ? `${timeout[2]} B` : 'none (no TIMEOUT line)'};`
        + ` largest gap of the ${RECORD_TICK_MS} ms interval ${gap.ms} ms, ended at ${show(gap.endedAt)}`;
    };
    // An error of one of the two clocks. Its record is added when the call settles (seal), not here:
    // the child's exit and the rest of its TIMEOUT line come after the chunk that names the error.
    const clocked = new WeakSet();
    const named = (text) => { const e = new Error(text); clocked.add(e); return e; };
    const seal = (e) => {
      if (clocked.has(e)) { clocked.delete(e); e.message += record(); }
      return e;
    };
    const timer = setTimeout(() => finish(named('PTY child did not answer')), 5000);
    /** No close: the failure is named, and the worker is ended here so the test file can still end. */
    const refuse = (why, error) => {
      const refused = new Error(`PTY teardown: ${why}${error ? `; after: ${seal(error).message}` : ''}`);
      const done = () => { releaseHold(); reject(refused); };
      worker.terminate().then(done, done);
    };
    function finish(error, value) {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      // The stall still open now counts too: a tick that was due did not run before this.
      noteGap();
      clearInterval(ticker);
      if (onHandshake) onHandshake({ looked: hs.looked, order: [...order], query: hs.query, inputAtReady: hs.inputAtReady, firstChunk: firstChunk && firstChunk.hex });
      if (!inbox) { close(error, value); return; }
      // NODEPTY-CONSOLE-LIST-KILL-SIBLINGS: on the inbox conhost node-pty's kill ends every process
      // on the console of the child's pid. An electron.exe child is on THIS test file's console, the
      // one the runner shares between its files: a child still alive here took the sibling files
      // with it. So the child is ended by its pid first, and the terminal is closed only once a
      // list of this process's own console no longer holds the child.
      // The pid is named only while the hold says the child runs. With no hold nothing says whose
      // the pid is, and nothing can be waited on: no pid is named and no console is listed.
      if (!hold) {
        refuse('no hold on the child (the procIdentity addon is not built), so its terminal on the inbox conhost is not closed:'
          + ' the close ends every process on the console of a pid, and nothing says that pid is still the child\'s', error);
        return;
      }
      const byPid = hold.alive();
      torn.pidKill = byPid ? at() : 'not needed (it had exited)';
      if (byPid) { try { process.kill(proc.pid); } catch { /* gone already */ } }
      // FLAKE-NODEPTY-CONSOLE-LIST-KILL-HARNESSALIVE-NOBODY: that kill returns at once, and the child
      // is on the owner's console until it has gone. The terminal is closed only after that. A child
      // that had exited by itself is waited off the console too: its exit alone does not say so.
      // An owner with no console has no list to wait for (see ownerConsole): asked now, at this close.
      const owner = ownerConsole();
      if (onOwnerCheck) onOwnerCheck(owner);
      offConsole(proc.pid, hold, byPid, owner).then(() => close(error, value), (stuck) => refuse(stuck.message, error));
    }
    function close(error, value) {
      torn.termKill = at();
      try { proc.kill(); } catch { /* child already exited */ }
      // The hold goes after the last kill that names the pid: node-pty's kill lists the console
      // from a helper it forks, so not before the teardown has settled.
      if (!workerGone) { releaseHold(); error ? reject(seal(error)) : resolve(value); return; }
      // Settle only once the terminal is torn down: a kill that did not run fails HERE, by name,
      // instead of leaving a thread that keeps the test file from ending.
      let watchdog;
      Promise.race([workerGone, new Promise((_, rej) => {
        watchdog = setTimeout(() => rej(new Error(
          'PTY teardown: the conout worker of the terminal never exited, so the kill did not run'
          + ' (node-pty holds kill() back until a first data chunk; armEarlyKill runs it at once)'
          + (error ? `; after: ${seal(error).message}` : ''))), TEARDOWN_CAP_MS);
      })]).then(
        () => { torn.workerGone = at(); error ? reject(seal(error)) : resolve(value); },
        (stuck) => worker.terminate().then(() => reject(stuck))   // named red, and the file still ends
      ).finally(() => { clearTimeout(watchdog); releaseHold(); });
    }
    proc.onData((data) => {
      if (stamp.first === null) {
        stamp.first = at();
        const raw = Buffer.from(String(data), 'utf8');
        firstChunk = { hex: raw.subarray(0, FIRST_CHUNK_SHOWN).toString('hex'), shown: Math.min(raw.length, FIRST_CHUNK_SHOWN), length: raw.length };
      }
      if (hs.pending) {
        const step = startupHandshake(String(data));
        hs.pending = step.pending;
        if (step.answer) { hs.query = at(); order.push('query'); }
      }
      output += data;
      if (stamp.ready === null && output.includes('READY')) {
        stamp.ready = at();
        order.push('ready');
        // Read before this call's own write below: what the input socket was given up to READY.
        hs.inputAtReady = inSocket ? inSocket.bytesWritten : null;
      }
      noteFlushed();
      const hit = /BYTES:(\[[^\n]*\])/.exec(output);
      if (hit && stamp.bytes === null) { stamp.bytes = at(); order.push('bytes'); }
      // Asserted, not assumed: the child itself says its stdout and stdin are the console.
      if (hit && !output.includes('READY:true')) finish(new Error(`PTY child is not on the console (its stdout/stdin isTTY is not true): ${output}`));
      if (hit) finish(null, JSON.parse(hit[1]));
      if (output.includes('TIMEOUT')) {
        if (stamp.timeout === null) stamp.timeout = at();
        if (!ended) finish(named('PTY child timed out'));
      }
      if (!wrote && output.includes('READY')) { wrote = true; proc.write(input); stamp.write = at(); order.push('write'); }
    });
    proc.onExit(({ exitCode }) => {
      if (stamp.exit === null) { stamp.exit = at(); stamp.exitCode = exitCode; }
      if (!ended && !/BYTES:/.test(output)) finish(named(`PTY child exited ${exitCode}: ${output}`));
    });
  });
}

module.exports = { childBytes, electronExe, isElectronExe, ownerConsole, CHILD };
