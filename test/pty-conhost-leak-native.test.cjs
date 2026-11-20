'use strict';
require('./tools/own-job.cjs');

// PTY-CONHOST-LEAK-NATIVE. Every Windows terminal has a console host process (conhost.exe, or
// OpenConsole.exe with the bundled conpty.dll), a child of the process that made the pseudoconsole.
// The host ends when the pseudoconsole is closed. node-pty 1.1.0 closes it only from its kill, and
// only while the terminal's record is still in the native list; its exit thread drops that record
// without closing. So a terminal that ended by itself kept its host, and so did a killed one,
// because PtyManager ends the process tree first and the exit thread wins. Measured 2026-11-19 on
// Node and on Electron as Node: one host per ended terminal, still there 15 s later, until the app
// quits.
//
// Measured here the same way: the host children of THIS process, by pid, before and after one
// terminal. The wait is on the state itself (the terminal's host pid is gone from the list); the
// bound is a count of completed listings after the terminal's exit was reported, not a time, and it
// names the host that stayed.
//
// The close is a call that can wait: on this Windows (before 11 24H2) ClosePseudoConsole returns
// only when the host has ended, and a host with output nobody reads is stuck in its write. The
// exit thread makes that call before it releases its callback, and Node joins the thread when the
// process ends. So the last test runs the manager in a process of its own (this file with
// UNREAD_FLAG) with the terminal's output paused, lets the program print until the host takes no
// more and then end itself from a second thread, and requires all three: the exit is reported, the
// host goes, and the manager process ends BY ITSELF (nothing calls process.exit there).
//
// MEASURED on Windows 10 19045: with the output PAUSED the close returns. With the terminal's
// output socket DESTROYED before the program prints (what an EPIPE leaves behind) it never does.
// Made on the exit thread before the callback was released, that close held the manager's event
// loop for ever. So the close runs on a detached thread after the release, and the second
// manager test (DESTROYED_FLAG) requires: the exit is reported and the manager process ends by
// itself.
//
// WHAT THE HOST WAITS FOR there (measured 2026-11-20, conhost and OpenConsole alike): its own
// write. node-pty's output worker copies the console's output into the data socket, and stops
// reading when that socket is gone; the host then blocks writing output nobody reads, and the
// close waits on the host for ever: one host and one parked thread per such terminal. A second
// reader on the worker's pipe freed the host at once. So the last two tests require of that state
// what the others require: the host is gone and the manager's thread count is back where it was
// before the terminal. Through PtyManager (DESTROYED_FLAG), which used to end the worker one
// second after the socket closed, and through node-pty alone (RAW_FLAG), where nothing ends it.
const UNREAD_FLAG = '--conhost-leak-unread-manager';
const DESTROYED_FLAG = '--conhost-leak-destroyed-manager';
const RAW_FLAG = '--conhost-leak-raw-destroyed-manager';
// The named mutant of the fix, as a manager of its own: node-pty alone, and the manager ends the
// output worker on the terminal's exit event, as PtyManager did before. It must leave the host.
const DISPOSED_FLAG = '--conhost-leak-raw-disposed-manager';
const DISPOSED = process.argv.includes(DISPOSED_FLAG);
// The same two managers with the socket destroyed BEFORE the program's first write (what an
// EPIPE at the start leaves behind), not while it prints.
const EARLY_FLAG = '--conhost-leak-destroyed-early-manager';
const RAW_EARLY_FLAG = '--conhost-leak-raw-destroyed-early-manager';
const EARLY = process.argv.includes(EARLY_FLAG) || process.argv.includes(RAW_EARLY_FLAG);
const RAW = DISPOSED || process.argv.includes(RAW_FLAG) || process.argv.includes(RAW_EARLY_FLAG);
const DESTROYED = RAW || EARLY || process.argv.includes(DESTROYED_FLAG);
// The node-pty-alone managers on the bundled console host (OpenConsole.exe through conpty.dll):
// a second argument, given only where that host is staged next to the binaries.
const DLL_FLAG = '--conhost-leak-bundled-host';
const DLL = process.argv.includes(DLL_FLAG);
// The unread (paused) terminal with node-pty alone: nothing but node-pty reports the exit.
const RAW_UNREAD_FLAG = '--conhost-leak-raw-unread-manager';
const RAW_UNREAD = process.argv.includes(RAW_UNREAD_FLAG);
// The same terminal READ until the program is gone and paused only then: the pause comes in the
// turn in which the native side reports the exit, so the output is still flowing when the exit
// path looks at it. The other half of that path (paused later, not paused now).
const LATE_PAUSE_FLAG = '--conhost-leak-raw-late-pause-manager';
const LATE_PAUSE = process.argv.includes(LATE_PAUSE_FLAG);
// The same terminal with a reader that NEVER pauses: the program prints a stream that ends with a
// marker and ends itself while part of it is still unread. That reader must get all of it.
const FLOWING_FLAG = '--conhost-leak-raw-flowing-manager';
const FLOWING = process.argv.includes(FLOWING_FLAG);
const UNREAD = DESTROYED || RAW_UNREAD || LATE_PAUSE || FLOWING || process.argv.includes(UNREAD_FLAG);
// A manager in which the thread that closes the pseudoconsole cannot be started (the native test
// hook GUPPY_PTY_TEST_CLOSE_THREAD_FAILS throws what std::thread throws when it cannot start).
const THREAD_FAILS_FLAG = '--conhost-leak-close-thread-fails-manager';
const THREAD_FAILS = process.argv.includes(THREAD_FAILS_FLAG);
const MANAGER = UNREAD || THREAD_FAILS;
const RESULT = 'UNREAD-RESULT ';
const test = MANAGER ? () => {} : require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { consoleNode } = require('./tools/console-node.cjs');

const WIN = process.platform === 'win32';
const HOSTS = new Set(['conhost.exe', 'openconsole.exe']);
const LISTINGS = 12;   // completed process listings after the exit before "it stays" is the verdict
const SETTLE = 8;      // completed listings between the socket's end and the word that lets the program stop
const BUNDLED_HOST = path.join(__dirname, '..', 'node_modules', 'node-pty', 'build', 'Release', 'conpty', 'conpty.dll');
// How a console session that is ended from outside ends its program, as the program's exit code:
// STATUS_CONTROL_C_EXIT, or STATUS_DLL_INIT_FAILED for a program that had not come up yet.
const SESSION_ENDED = [-1073741510, -1073741502];
let seq = 0;

/** pid -> name of the console hosts that are children of this process; `.threads` is this process's thread count. */
function hostChildren() {
  const body = `$ProgressPreference = 'SilentlyContinue'\nGet-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}" | ForEach-Object { "$($_.ProcessId) $($_.Name)" }\n"threads $((Get-Process -Id ${process.pid}).Threads.Count)"`;
  return new Promise((res, rej) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(body, 'utf16le').toString('base64')],
      { encoding: 'utf8', windowsHide: true }, (err, stdout, stderr) => {
        if (err) { rej(new Error(`the process listing failed: ${err.message}\n${stderr}`)); return; }
        const hosts = new Map();
        hosts.threads = null;   // of this process, in the same listing
        for (const line of stdout.split(/\r?\n/)) {
          const m = /^(\d+) (.+)$/.exec(line.trim());
          if (m && HOSTS.has(m[2].toLowerCase())) hosts.set(Number(m[1]), m[2]);
          const th = /^threads (\d+)$/.exec(line.trim());
          if (th) hosts.threads = Number(th[1]);
        }
        res(hosts);
      });
  });
}

/** One terminal through the manager; `end` ends it. Resolves once its host is gone, or fails naming it. */
async function hostGoneAfter(t, script, end, how) {
  const { PtyManager } = loadTs('src/main/pty.ts');
  const node = consoleNode();
  t.diagnostic(`PTY child: ${node.file} ${node.version} (from ${node.from})`);
  const m = new PtyManager();
  const id = `conhost-leak-${process.pid}-${seq += 1}`;
  const before = await hostChildren();
  assert.deepEqual(await m.spawn({ id, cwd: process.cwd(), command: node.file, args: ['-e', script], cols: 80, rows: 24 }), { ok: true });
  const proc = m.sessions.get(id).proc;
  const exited = new Promise((res) => proc.onExit(res));
  const firstOutput = new Promise((res) => { const sub = proc.onData(() => { sub.dispose(); res(); }); });
  const mine = [...(await hostChildren())].filter(([pid]) => !before.has(pid));
  try {
    assert.equal(mine.length, 1, `the listing sees this terminal's console host: exactly one new host child, got ${JSON.stringify(mine)}`);
    await end({ m, id, proc, firstOutput });
    await exited;
    let left = mine;
    for (let n = 0; n < LISTINGS && left.length; n += 1) {
      const now = await hostChildren();
      left = mine.filter(([pid]) => now.has(pid));
    }
    assert.deepEqual(left, [], `THE CONSOLE HOST OUTLIVES ITS TERMINAL: ${how}, and ${LISTINGS} listings after the exit was reported `
      + `${left.map(([pid, name]) => `${name} pid ${pid}`).join(', ')} is still a child of this process (the pseudoconsole was never closed)`);
  } finally {
    if (m.sessions.has(id)) m.kill(id);
    for (const [pid] of mine) { try { process.kill(pid); } catch { /* gone, as it should be */ } }
  }
}

test('PTY-CONHOST-LEAK: a terminal whose program ends by itself releases its console host', { skip: !WIN, timeout: 120_000 }, async (t) => {
  // The child ends when a flag file appears, so the first listing is taken while it is certainly alive.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conhost-leak-'));
  const flag = path.join(dir, 'end');
  try {
    await hostGoneAfter(t, `const fs = require('fs'); setInterval(() => { if (fs.existsSync(${JSON.stringify(flag)})) process.exit(0); }, 50)`,
      async () => { fs.writeFileSync(flag, ''); }, 'the program ended by itself (no kill was sent)');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('PTY-CONHOST-LEAK: a terminal ended by PtyManager.kill releases its console host', { skip: !WIN, timeout: 120_000 }, async (t) => {
  await hostGoneAfter(t, 'setInterval(() => {}, 1000)', async ({ m, id }) => { assert.deepEqual(m.kill(id), { ok: true }); },
    'PtyManager.kill ended it');
});

test('PTY-CONHOST-LEAK: a terminal killed while its program floods output releases its console host', { skip: !WIN, timeout: 120_000 }, async (t) => {
  // The host has output in hand when the close arrives: the close must not wait on it for ever.
  const flood = "const b = 'x'.repeat(4096) + '\\n'; const w = () => { while (process.stdout.write(b)); process.stdout.once('drain', w); }; w();";
  await hostGoneAfter(t, flood, async ({ m, id, firstOutput }) => { await firstOutput; assert.deepEqual(m.kill(id), { ok: true }); },
    'PtyManager.kill ended it while it was printing');
});

// The program of the unread terminal. Its main thread prints without end and counts each write
// that returned; a second thread ends the whole process once that count has stood still for
// STILL polls after it first moved: the main thread is then inside a write the host does not
// take. Ending itself that way needs no kill from the manager, and is what a program does when
// one of its threads calls exit while another prints.
// Where the output IS taken (read and thrown away) the count never stands still: the second thread
// then ends the process when the manager's stop file appears, and the program has printed all the
// while (the host takes about 35 such writes before it blocks).
const STILL = 10;
// The flowing reader's program stops by itself after this many writes (far fewer than the pipes
// hold with nobody taking them: the unread program above gets past 50), says so with END as the
// last thing it prints, and ends with code 0.
const STREAM = 40;
const END = 'GUPPY-CONHOST-LEAK-END-OF-OUTPUT';
const UNREAD_PROGRAM = `'use strict';
const fs = require('fs');
const { Worker } = require('worker_threads');
const [flag, written, stop, stream] = process.argv.slice(2);
const sab = new SharedArrayBuffer(4);
const n = new Int32Array(sab);
new Worker(\`
  const fs = require('fs');
  const { workerData } = require('worker_threads');
  const n = new Int32Array(workerData.sab);
  let last = 0; let still = 0;
  setInterval(() => {
    const now = Atomics.load(n, 0);
    if (now === 0) return;
    still = now === last ? still + 1 : 0;
    last = now;
    if (still >= ${STILL} || (workerData.stop && fs.existsSync(workerData.stop))) { fs.writeFileSync(workerData.written, String(now)); process.kill(process.pid); }
  }, 50);
\`, { eval: true, workerData: { sab, written, stop } });
const block = 'x'.repeat(4096) + '\\n';
const t = setInterval(() => {
  if (!fs.existsSync(flag)) return;
  clearInterval(t);
  for (let k = 0; !stream || k < Number(stream); k += 1) { fs.writeSync(1, block); Atomics.add(n, 0, 1); }
  fs.writeSync(1, '${END}\\n');
  fs.writeFileSync(written, String(Atomics.load(n, 0)));
  process.exit(0);
}, 50);
`;

/** This file as the manager of the unread terminal: one result line, and then NOTHING ends it but its own empty loop. */
async function unreadManager() {
  const { PtyManager } = loadTs('src/main/pty.ts');
  const node = consoleNode();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conhost-leak-unread-'));
  const out = { node: `${node.file} ${node.version} (from ${node.from})`, hosts: [], exit: null, events: [], read: 0, written: null, left: null, threads: null, workerEndedEarly: null };
  const m = new PtyManager();
  const id = `conhost-leak-unread-${process.pid}`;
  try {
    const program = path.join(dir, 'program.cjs');
    const flag = path.join(dir, 'go');
    const written = path.join(dir, 'written');
    const stop = path.join(dir, 'stop');
    fs.writeFileSync(program, UNREAD_PROGRAM);
    await fs.promises.stat(dir);       // the thread pool exists before the count is taken
    const rawOptions = { cols: 80, rows: 24, cwd: process.cwd(), useConptyDll: DLL };
    let before = await hostChildren();
    if (DESTROYED) {
      // The thread baseline is taken AFTER one terminal has come and gone on the same path, so
      // that what a process starts once (and keeps) is not counted against this terminal. It is
      // the LOWEST count of SETTLE listings taken once that first terminal's host is gone: the
      // lowest is the strictest baseline there is.
      const first = before;
      let warm;
      if (RAW) warm = require('node-pty').spawn(node.file, ['-e', ''], rawOptions);
      else { await m.spawn({ id: `${id}-first`, cwd: process.cwd(), command: node.file, args: ['-e', ''], cols: 80, rows: 24 }); warm = m.sessions.get(`${id}-first`).proc; }
      warm.onData(() => {});
      await new Promise((res) => warm.onExit(res));
      const others = (now) => [...now].filter(([pid]) => !first.has(pid));
      before = await hostChildren();
      for (let k = 0; k < LISTINGS && others(before).length; k += 1) before = await hostChildren();
      if (others(before).length) throw new Error(`the first terminal's host stays: ${JSON.stringify(others(before))}`);
      let lowest = before.threads;
      for (let k = 0; k < SETTLE; k += 1) { before = await hostChildren(); lowest = Math.min(lowest, before.threads); }
      before.threads = lowest;
    }
    let proc;
    if (RAW || RAW_UNREAD || LATE_PAUSE || FLOWING) {
      // node-pty alone: no PtyManager, so nothing but node-pty itself ever ends the output worker.
      proc = require('node-pty').spawn(node.file, [program, flag, written, stop].concat(FLOWING ? [String(STREAM)] : []), rawOptions);
    } else {
      out.spawn = await m.spawn({ id, cwd: process.cwd(), command: node.file, args: DESTROYED ? [program, flag, written, stop] : [program, flag, written], cols: 80, rows: 24 });
      proc = m.sessions.get(id).proc;
    }
    const firstOutput = new Promise((res) => proc.onData((d) => { out.read += d.length; res(); }));
    const exited = new Promise((res) => proc.onExit((e) => { out.events.push(e); res(e); }));
    out.bundledHost = proc._agent._useConptyDll === true;
    out.hosts = [...(await hostChildren())].filter(([pid]) => !before.has(pid));
    if (DESTROYED) {
      // The terminal's exit event comes from the socket closing, at once and without a code. The
      // program's own end is the file it writes; the native exit report is the agent's exit code.
      // The program is printing when the socket goes, and keeps printing for SETTLE listings more
      // before it is told it may stop: whatever ends the output worker on the terminal's exit event
      // (node-pty's flush timer does it one second later) has done so by then, under a console
      // that still writes.
      let workerEnded = false;
      proc._agent._conoutSocketWorker._worker.on('exit', () => { workerEnded = true; });
      if (EARLY) {
        proc._agent.outSocket.destroy();
        fs.writeFileSync(flag, '');
      } else {
        fs.writeFileSync(flag, '');
        await firstOutput;
        proc._agent.outSocket.destroy();
      }
      await exited;
      if (DISPOSED) proc._agent._conoutSocketWorker.dispose();   // the mutant: node-pty ends the worker one second later
      for (let k = 0; k < SETTLE; k += 1) await hostChildren();
      out.workerEndedEarly = workerEnded;
      fs.writeFileSync(stop, '');
      // The program ends itself and says so in its file, or it was ended from outside and is
      // gone: every turn of this wait is one completed listing, and it ends with the program.
      const alive = () => { try { process.kill(proc.pid, 0); return true; } catch { return false; } };
      while (!fs.existsSync(written) && alive()) await hostChildren();
      for (let k = 0; k < LISTINGS && (proc._agent._exitCode === undefined || alive()); k += 1) await hostChildren();
      out.exit = { exitCode: proc._agent._exitCode };
      out.programAlive = alive();
    } else {
      if (FLOWING) {
        // Nobody pauses this output, ever. This thread takes nothing from the first output until
        // the program is gone, so part of what it printed is still on its way when the native side
        // reports the exit. What was read by then, and whether END had come when the terminal's
        // exit event was sent, is the result.
        const agent = proc._agent;
        const onProcessExit = agent._$onProcessExit;
        agent._$onProcessExit = function (...args) {
          out.flowingAtExit = agent._outSocket.readableFlowing;
          out.readAtExit = out.read;
          return onProcessExit.apply(this, args);
        };
        let tail = '';
        out.end = false;
        proc.onData((d) => { tail = (tail + d).slice(-(END.length + d.length)); if (tail.includes(END)) out.end = true; });
        proc.onExit(() => { out.endAtExitEvent = out.end; out.readAtExitEvent = out.read; });
        fs.writeFileSync(flag, '');
        await firstOutput;
        const nap = new Int32Array(new SharedArrayBuffer(4));
        const running = () => { try { process.kill(proc.pid, 0); return true; } catch { return false; } };
        while (running()) Atomics.wait(nap, 0, 0, 50);
      } else if (LATE_PAUSE) {
        // The output is read while the program prints. The pause is made in the same turn as the
        // native exit report, right after node-pty's own exit path has run: by then that path has
        // seen a flowing output, and nothing was read in between.
        const agent = proc._agent;
        const onProcessExit = agent._$onProcessExit;
        agent._$onProcessExit = function (...args) {
          out.flowingAtExit = agent._outSocket.readableFlowing;
          const r = onProcessExit.apply(this, args);
          proc.pause();
          out.readAtPause = out.read;
          return r;
        };
        fs.writeFileSync(flag, '');
        await firstOutput;
        // From here this thread takes nothing more until the program is gone: the output stays
        // flowing (nobody pauses it), the pipes fill, the program's writes stand still and it ends
        // itself. So when the exit is reported, more is unread than the stream and the worker can
        // buffer between them, and only a reader could make the host close the output. With a
        // short tail the worker drains the host by itself and the pause costs nothing: that run
        // would pass with or without the exit path this cell is about.
        const nap = new Int32Array(new SharedArrayBuffer(4));
        const running = () => { try { process.kill(proc.pid, 0); return true; } catch { return false; } };
        while (!fs.existsSync(written) && running()) Atomics.wait(nap, 0, 0, 50);
      } else {
        proc.pause();                    // nothing reads this terminal's output from here on
        out.readAtPause = out.read;      // (the bundled host's own first bytes may have come by now)
        fs.writeFileSync(flag, '');      // and only now does the program print
      }
      // The program ends itself once its writes stand still. From then the terminal has LISTINGS
      // completed listings to report the exit: a terminal that never does is a result (null),
      // not a manager that waits for ever.
      const alive = () => { try { process.kill(proc.pid, 0); return true; } catch { return false; } };
      while (alive() && !out.events.length) await hostChildren();
      for (let k = 0; k < LISTINGS && !out.events.length; k += 1) await hostChildren();
      out.exit = out.events[0] || null;
      out.nativeExit = proc._agent._exitCode;
    }
    out.written = fs.existsSync(written) ? Number(fs.readFileSync(written, 'utf8')) : null;   // null: it was ended from outside
    out.left = out.hosts;
    out.threads = { before: before.threads, after: null };
    for (let k = 0; k < LISTINGS && (out.left.length || !(out.threads.after <= before.threads)); k += 1) {
      const now = await hostChildren();
      out.left = out.hosts.filter(([pid]) => now.has(pid));
      out.threads.after = now.threads;
    }
  } catch (e) {
    out.error = String(e && e.stack || e);
  } finally {
    if (m.sessions.has(id)) m.kill(id);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.stdout.write(`${RESULT}${JSON.stringify(out)}\n`);
}
if (UNREAD) unreadManager();

/** This file as the manager of one terminal whose close thread cannot start: one result line, then its own empty loop ends it. */
async function threadFailsManager() {
  process.env.GUPPY_PTY_TEST_CLOSE_THREAD_FAILS = '1';   // read by the exit thread of every terminal of THIS process
  const { PtyManager } = loadTs('src/main/pty.ts');
  const node = consoleNode();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conhost-leak-thread-'));
  const out = { node: `${node.file} ${node.version} (from ${node.from})`, hosts: [], exit: null, left: null };
  const m = new PtyManager();
  const id = `conhost-leak-thread-${process.pid}`;
  try {
    const flag = path.join(dir, 'end');
    const before = await hostChildren();
    out.spawn = await m.spawn({ id, cwd: process.cwd(), command: node.file, cols: 80, rows: 24,
      args: ['-e', `const fs = require('fs'); setInterval(() => { if (fs.existsSync(${JSON.stringify(flag)})) process.exit(0); }, 50)`] });
    const proc = m.sessions.get(id).proc;
    const exited = new Promise((res) => proc.onExit(res));
    out.hosts = [...(await hostChildren())].filter(([pid]) => !before.has(pid));
    fs.writeFileSync(flag, '');
    out.exit = await exited;
    // The close was never started, so the host is what it was before the close existed: it
    // stays for as long as this process lives. LISTINGS completed listings later it is still here.
    out.left = out.hosts;
    for (let k = 0; k < LISTINGS && out.left.length; k += 1) {
      const now = await hostChildren();
      out.left = out.hosts.filter(([pid]) => now.has(pid));
    }
  } catch (e) {
    out.error = String(e && e.stack || e);
  } finally {
    if (m.sessions.has(id)) m.kill(id);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.stdout.write(`${RESULT}${JSON.stringify(out)}
`);
}
if (THREAD_FAILS) threadFailsManager();

/** Runs this file as a manager process; resolves with its result line, and `ended()` says how it ended, waiting LISTINGS listings at most. */
async function managerRun(t, flag) {
  const child = spawn(process.execPath, [__filename].concat(flag), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  let stdout = ''; let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
  const line = () => stdout.split(/\r?\n/).find((l) => l.startsWith(RESULT) && stdout.includes(`${l}\n`));
  const reported = new Promise((res) => { child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; if (line()) res(); }); });
  let end = null;
  const closed = new Promise((res) => { child.on('close', (code, signal) => { end = { code, signal }; res(); }); });
  await Promise.race([reported, closed]);
  assert.ok(line(), `the manager process reports its result before it ends (ended ${JSON.stringify(end)}):\n${stdout}\n${stderr}`);
  const r = JSON.parse(line().slice(RESULT.length));
  assert.equal(r.error, undefined, `the manager ran the scenario:\n${r.error}\n${stderr}`);
  assert.equal(r.hosts.length, 1, `the listing sees this terminal's console host: exactly one new host child, got ${JSON.stringify(r.hosts)}`);
  // The bound is again a count of completed listings, taken after the result was printed.
  const ended = async () => { for (let k = 0; k < LISTINGS && !end; k += 1) await Promise.race([closed, hostChildren()]); return end; };
  return { r, pid: child.pid, ended, stderr: () => stderr };
}

async function unreadTerminal(t, flag) {
    const { r, pid, ended, stderr } = await managerRun(t, flag);
    t.diagnostic(`PTY child: ${r.node}; the program had ${r.written} writes of 4097 bytes returned when it ended itself; the manager read ${r.read} bytes`);
    // The state: the program printed, nothing of it was read, and it ended ITSELF (process.kill of
    // its own pid ends a Windows process with code 1; the manager sent no kill).
    assert.ok(r.written > 0, 'the program printed before it ended');
    // The terminal was paused before the program's first write. The inbox host has written
    // nothing by then; the bundled host has sent its own first bytes (fewer than one write of the
    // program). Either way not one byte is read after the pause.
    assert.equal(r.read, r.readAtPause, `nothing was read after the terminal was paused: ${r.readAtPause} bytes before, ${r.read} in all`);
    assert.ok(r.readAtPause < 4097, `what was read before the pause is not the program's output: ${r.readAtPause} bytes, less than one of its writes`);
    if (!r.bundledHost) assert.equal(r.read, 0, 'on the inbox host nothing at all was read');
    assert.ok(r.exit, `THE EXIT IS NOT REPORTED: the program ended itself with its output unread (the native side has its exit code: ${r.nativeExit}), and ${LISTINGS} listings later the terminal has told nobody. `
      + 'The terminal waits for the console host to close the output, and the host waits for somebody to read it');
    assert.deepEqual(r.exit && r.exit.exitCode, 1, `THE EXIT IS REPORTED, with the program's own end: ${JSON.stringify(r.exit)}`);
    assert.deepEqual(r.left, [], `THE CONSOLE HOST OUTLIVES ITS TERMINAL: the program ended itself with its output unread, and ${LISTINGS} listings after the exit was reported `
      + `${r.left.map(([p, name]) => `${name} pid ${p}`).join(', ')} is still a child of the manager process`);
    const end = await ended();
    assert.ok(end, `THE MANAGER PROCESS DOES NOT END: ${LISTINGS} listings after it reported its result (exit reported, host gone) pid ${pid} is still running. `
      + 'Nothing is left for it to do, so its exit thread is still inside the close and holds the exit callback (quit would wait on that thread)');
    assert.deepEqual(end, { code: 0, signal: null }, `the manager process ended by itself and cleanly:\n${stderr()}`);
    return r;
}

test('PTY-CONHOST-LEAK: a program that ends itself with its output unread: the exit is reported, the host goes, and the manager process ends by itself',
  { skip: !WIN, timeout: 120_000 }, (t) => unreadTerminal(t, UNREAD_FLAG));

/** Ends a console host the manager process `parent` left behind: only a host, and only one whose recorded parent is that process. */
function endLeftHost(pid, parent) {
  const body = `$ProgressPreference = 'SilentlyContinue'\nGet-CimInstance Win32_Process -Filter "ProcessId=${pid} AND ParentProcessId=${parent}" | Where-Object { $_.Name -eq 'conhost.exe' -or $_.Name -eq 'OpenConsole.exe' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
  return new Promise((res) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(body, 'utf16le').toString('base64')], { windowsHide: true }, () => res()));
}

/** The destroyed-socket state, through `flag`'s manager: exit reported, host gone, threads back, manager ends by itself. */
async function destroyedSocket(t, flag, who) {
  const { r, pid, ended, stderr } = await managerRun(t, flag);
  t.after(async () => { for (const [host] of r.left || []) await endLeftHost(host, pid); });
  t.diagnostic(`PTY child: ${r.node}; the program had ${r.written} writes of 4097 bytes returned when it ended itself (on the manager's word, or when they stood still); `
    + `manager threads ${JSON.stringify(r.threads)}; output worker ended while the program printed: ${r.workerEndedEarly}`);
  // HOW THE PROGRAM ENDS is a fact of the path, and each path's own premise is required here.
  // - The session stays (the inbox host; node-pty alone on either host): the program prints on,
  //   is told to stop, and ends ITSELF with code 1 and its count of writes.
  // - PtyManager on the bundled host: the terminal's exit event makes PtyManager release the
  //   terminal, the release closes the console's input, and on this host that ends the session:
  //   the host ends the program (no count is written) and then itself, and the output worker
  //   ends with the console it read.
  // Whichever it is, nothing is left: no program, no host, no thread, and the manager ends.
  const sessionEnded = who === 'PtyManager' && r.bundledHost === true;
  t.diagnostic(`path: ${r.bundledHost ? 'bundled host (conpty.dll)' : 'inbox host'}, ${who}; expected end of the program: ${sessionEnded ? 'by the session\'s end' : 'by itself'}; exit ${JSON.stringify(r.exit)}`);
  assert.equal(typeof r.bundledHost, 'boolean', 'the manager said which console host it ran on');
  assert.ok(r.events.length >= 1, 'the terminal told the manager that it ended');
  assert.equal(r.programAlive, false, `THE PROGRAM OUTLIVES ITS TERMINAL: pid of the program is still running ${LISTINGS} listings after its end was awaited`);
  if (sessionEnded) {
    assert.equal(r.written, null, `on this path the session's end ends the program before it is told to stop: it wrote no count, got ${r.written}`);
    assert.ok(r.exit && SESSION_ENDED.includes(r.exit.exitCode), `THE EXIT IS REPORTED by the native side, with the session's end: ${JSON.stringify(r.exit)} (one of ${SESSION_ENDED.join(', ')})`);
  } else {
    assert.ok(r.written > 0, `the program printed and ended itself: ${r.written}`);
    assert.deepEqual(r.exit, { exitCode: 1 }, `THE EXIT IS REPORTED by the native side, with the program's own end: ${JSON.stringify(r.exit)}`);
  }
  assert.deepEqual(r.left, [], `THE CONSOLE HOST OUTLIVES ITS TERMINAL: the output socket was destroyed, the program printed ${r.written} writes and ended itself, and ${LISTINGS} listings later `
    + `${r.left.map(([p, name]) => `${name} pid ${p}`).join(', ')} is still a child of the manager process: the host is blocked writing output nobody reads, and the close waits on it`);
  if (!sessionEnded) assert.equal(r.workerEndedEarly, false, `THE OUTPUT WORKER IS ENDED WHILE THE CONSOLE STILL WRITES: ${who} ended it within ${SETTLE} listings of the socket's end, while the program was printing; `
    + 'from then on nobody reads the console\'s output, and the host blocks in its write');
  assert.ok(typeof r.threads.before === 'number' && typeof r.threads.after === 'number', `the listing counted the manager's threads: ${JSON.stringify(r.threads)}`);
  assert.ok(r.threads.after <= r.threads.before, `THE TERMINAL LEAVES THREADS BEHIND: the manager had ${r.threads.before} threads before the terminal and ${r.threads.after} ${LISTINGS} listings after it ended `
    + '(the thread parked in the close, and the output worker where nothing ends it)');
  const end = await ended();
  assert.ok(end, `THE MANAGER PROCESS DOES NOT END: ${LISTINGS} listings after it reported its result (exit reported) pid ${pid} is still running. `
    + 'Nothing is left for it to do: the close of the pseudoconsole has not returned and holds the exit callback, on the thread a quit joins');
  assert.deepEqual(end, { code: 0, signal: null }, `the manager process ended by itself and cleanly:\n${stderr()}`);
  return r;
}

test('PTY-CONHOST-LEAK: the same program with the terminal\'s output socket destroyed, through PtyManager: the exit is reported, the host goes, no thread stays, and the manager process ends by itself',
  { skip: !WIN, timeout: 120_000 }, (t) => destroyedSocket(t, DESTROYED_FLAG, 'PtyManager'));

test('PTY-CONHOST-LEAK: the same with node-pty alone (nothing ends its output worker): the exit is reported, the host goes, no thread stays, and the manager process ends by itself',
  { skip: !WIN, timeout: 120_000 }, (t) => destroyedSocket(t, RAW_FLAG, 'node-pty'));

test('PTY-CONHOST-LEAK: the output socket destroyed before the program\'s first write, through PtyManager: the exit is reported, the host goes, no thread stays, and the manager process ends by itself',
  { skip: !WIN, timeout: 120_000 }, (t) => destroyedSocket(t, EARLY_FLAG, 'PtyManager'));

test('PTY-CONHOST-LEAK: the same early end with node-pty alone: the exit is reported, the host goes, no thread stays, and the manager process ends by itself',
  { skip: !WIN, timeout: 120_000 }, (t) => destroyedSocket(t, RAW_EARLY_FLAG, 'node-pty'));

// What this mutant leaves is measured, not assumed: on the inbox console host a terminated worker
// closes its end of the console pipe, the host's blocked write fails, and the host goes. So the
// mutant is not refused for a leftover host here. It is refused for what it does: the reader of
// the console's output is ended while the console still writes.
test('PTY-CONHOST-LEAK mutant: a manager that ends the output worker on the terminal\'s exit, before the close has returned, is refused: the console is left writing with no reader',
  { skip: !WIN, timeout: 120_000 }, async (t) => {
    await assert.rejects(() => destroyedSocket(t, DISPOSED_FLAG, 'the manager'), (e) => {
      assert.ok(e instanceof assert.AssertionError, String(e && e.stack || e));
      assert.match(e.message, /THE OUTPUT WORKER IS ENDED WHILE THE CONSOLE STILL WRITES/, 'the mutant is refused for the reader it ends');
      return true;
    }, 'A WORKER ENDED BEFORE THE CLOSE RETURNED MUST BE REFUSED, and the check must say why');
  });

// node-pty alone on the bundled console host. These two run only where OpenConsole.exe and
// conpty.dll are staged next to the binaries (the tree says so in the skip reason).
const NO_BUNDLED_HOST = !WIN ? true : (fs.existsSync(BUNDLED_HOST) ? false : `the bundled console host is not staged in this tree (${path.relative(path.join(__dirname, '..'), BUNDLED_HOST)})`);
// The bundled host reports an exit only by closing the output, and closes it only once it has
// been read: node-pty alone, so the patched exit path is all there is to report it.
test('PTY-CONHOST-LEAK: node-pty alone on the bundled console host, a program that ends itself with its output unread: the exit is reported, the host goes, and the manager process ends by itself',
  { skip: NO_BUNDLED_HOST, timeout: 120_000 }, async (t) => {
    const r = await unreadTerminal(t, [RAW_UNREAD_FLAG, DLL_FLAG]);
    assert.equal(r.bundledHost, true, 'this cell ran on the bundled host');
  });

test('PTY-CONHOST-LEAK: node-pty alone on the bundled console host, the output socket destroyed while the program prints: the exit is reported, the host goes, no thread stays, and the manager process ends by itself',
  { skip: NO_BUNDLED_HOST, timeout: 120_000 }, async (t) => {
    const r = await destroyedSocket(t, [RAW_FLAG, DLL_FLAG], 'node-pty');
    assert.equal(r.bundledHost, true, 'this cell ran on the bundled host');
  });

test('PTY-CONHOST-LEAK: node-pty alone on the bundled console host, the output socket destroyed before the program\'s first write: the exit is reported, the host goes, no thread stays, and the manager process ends by itself',
  { skip: NO_BUNDLED_HOST, timeout: 120_000 }, async (t) => {
    const r = await destroyedSocket(t, [RAW_EARLY_FLAG, DLL_FLAG], 'node-pty');
    assert.equal(r.bundledHost, true, 'this cell ran on the bundled host');
  });

// The other half of the same exit path: the output is flowing when the process goes, and is
// paused after that. Nothing reads it from then on, so the host would never close it.
test('PTY-CONHOST-LEAK: node-pty alone on the bundled console host, the output read until the program is gone and paused only then: the exit is reported, the host goes, and the manager process ends by itself',
  { skip: NO_BUNDLED_HOST, timeout: 120_000 }, async (t) => {
    const { r, pid, ended, stderr } = await managerRun(t, [LATE_PAUSE_FLAG, DLL_FLAG]);
    t.diagnostic(`PTY child: ${r.node}; the program had ${r.written} writes of 4097 bytes returned when it ended itself; the manager read ${r.readAtPause} bytes before the pause and ${r.read} in all`);
    assert.equal(r.bundledHost, true, 'this cell ran on the bundled host');
    assert.ok(r.written > 0, 'the program printed before it ended itself');
    assert.equal(r.flowingAtExit, true, `the output was flowing when the native side reported the exit (the premise of this cell): ${r.flowingAtExit}`);
    assert.equal(r.read, r.readAtPause, `nothing was read after the pause: ${r.readAtPause} bytes before, ${r.read} in all`);
    assert.ok(r.readAtPause < r.written * 4097, `part of the program's output was still unread at the pause (the premise of this cell): ${r.readAtPause} bytes read of at least ${r.written * 4097} written`);
    assert.ok(r.exit, `THE EXIT IS NOT REPORTED: the program is gone (the native side has its exit code: ${r.nativeExit}), the output was paused after that, and ${LISTINGS} listings later the terminal has told nobody. `
      + 'The terminal waits for the console host to close the output, and the host waits for somebody to read it');
    assert.deepEqual(r.exit && r.exit.exitCode, 1, `THE EXIT IS REPORTED, with the program's own end: ${JSON.stringify(r.exit)}`);
    assert.deepEqual(r.left, [], `THE CONSOLE HOST OUTLIVES ITS TERMINAL: ${LISTINGS} listings after the exit was reported ${r.left.map(([p, name]) => `${name} pid ${p}`).join(', ')} is still a child of the manager process`);
    const end = await ended();
    assert.ok(end, `THE MANAGER PROCESS DOES NOT END: ${LISTINGS} listings after it reported its result pid ${pid} is still running`);
    assert.deepEqual(end, { code: 0, signal: null }, `the manager process ended by itself and cleanly:
${stderr()}`);
  });

// What the exit path above costs, and whom: a reader that has paused loses what it had not taken
// when the program went (that is the design: the host closes the output only once it is read).
// A reader that never pauses must lose nothing, and that is every terminal of the app (see the
// no-pause pin in pty-no-pause-pin.test.cjs).
// This cell is a GUARD for the flowing path, not the red-before of the exit path: it is green before that change too, and its red is the destroy-at-exit mutant.
test('PTY-CONHOST-LEAK: node-pty alone on the bundled console host, a reader that never pauses and a program that ends itself with part of its output still unread: all of it arrives before the exit event, the host goes, and the manager process ends by itself',
  { skip: NO_BUNDLED_HOST, timeout: 120_000 }, async (t) => {
    const { r, pid, ended, stderr } = await managerRun(t, [FLOWING_FLAG, DLL_FLAG]);
    t.diagnostic(`PTY child: ${r.node}; the program made ${r.written} writes of 4097 bytes and ended itself; the manager had read ${r.readAtExit} bytes when the native side reported the exit and ${r.readAtExitEvent} when the exit event came`);
    assert.equal(r.bundledHost, true, 'this cell ran on the bundled host');
    assert.equal(r.written, STREAM, `the program printed its whole stream and ended itself (it is ended from inside when its writes stand still, and then the stream did not fit the pipes): ${r.written} of ${STREAM} writes`);
    assert.equal(r.flowingAtExit, true, `the output was flowing when the native side reported the exit: ${r.flowingAtExit}`);
    assert.ok(r.exit, `THE EXIT IS NOT REPORTED: the program is gone (the native side has its exit code: ${r.nativeExit}) and ${LISTINGS} listings later the terminal has told nobody`);
    // The premise is measured against the program's side, which the code under test cannot change.
    assert.ok(r.readAtExit < STREAM * 4097, `part of the output was still unread when the native side reported the exit (the premise of this cell): ${r.readAtExit} bytes read then, of at least ${STREAM * 4097} the program wrote`);
    assert.equal(r.endAtExitEvent, true, `THE END OF THE OUTPUT IS LOST: the reader never paused, the program printed ${END} last and ended itself, and the exit event came without it (${r.readAtExitEvent} bytes read of at least ${STREAM * 4097} written)`);
    assert.ok(r.readAtExitEvent >= STREAM * 4097, `all of the stream was read before the exit event: ${r.readAtExitEvent} bytes of at least ${STREAM * 4097}`);
    assert.equal(r.read, r.readAtExitEvent, `nothing comes after the exit event: ${r.readAtExitEvent} bytes then, ${r.read} in all`);
    assert.deepEqual(r.exit && r.exit.exitCode, 0, `THE EXIT IS REPORTED, with the program's own end: ${JSON.stringify(r.exit)}`);
    assert.deepEqual(r.left, [], `THE CONSOLE HOST OUTLIVES ITS TERMINAL: ${LISTINGS} listings after the exit was reported ${r.left.map(([p, name]) => `${name} pid ${p}`).join(', ')} is still a child of the manager process`);
    const end = await ended();
    assert.ok(end, `THE MANAGER PROCESS DOES NOT END: ${LISTINGS} listings after it reported its result pid ${pid} is still running`);
    assert.deepEqual(end, { code: 0, signal: null }, `the manager process ended by itself and cleanly:
${stderr()}`);
  });

// The thread that closes the pseudoconsole is started on node-pty's exit thread, where nothing
// catches: a start that throws there is std::terminate, the whole app gone with every terminal in
// it. Caught, it costs what an ended terminal cost before the close existed: its console host
// stays until the app quits.
test('PTY-CONHOST-LEAK: a close thread that cannot be started costs one console host until the app quits, never the app: the exit is reported and the manager process ends by itself',
  { skip: !WIN, timeout: 120_000 }, async (t) => {
    const { r, ended, stderr } = await managerRun(t, THREAD_FAILS_FLAG);
    assert.deepEqual(r.spawn, { ok: true });
    assert.equal(r.exit && r.exit.exitCode, 0, `the terminal's exit is reported with the program's own code: ${JSON.stringify(r.exit)}`);
    // The premise: the start DID fail in that process. Had the hook not been read, the host would be closed and gone.
    assert.deepEqual(r.left, r.hosts, `the close was never started, so the host stays while the manager lives (the leak this card removes, and the price of a failed start): ${JSON.stringify(r.left)}`);
    const end = await ended();
    assert.ok(end, `THE MANAGER PROCESS DOES NOT END: ${LISTINGS} listings after its result it is still alive
${stderr()}`);
    assert.deepEqual(end, { code: 0, signal: null }, `THE APP DIES WHEN A CLOSE THREAD CANNOT START: the manager process ended ${JSON.stringify(end)}
${stderr()}`);
    // The host was the manager's; with the manager gone it goes too.
    const alive = () => { try { process.kill(r.hosts[0][0], 0); return true; } catch { return false; } };
    for (let k = 0; k < LISTINGS && alive(); k += 1) await hostChildren();
    assert.equal(alive(), false, `the host left by the failed start goes with the manager process: pid ${r.hosts[0][0]} is still alive`);
  });
