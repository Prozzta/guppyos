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
// itself. In that state the host itself still stays; the test prints it and does not judge it yet.
const UNREAD_FLAG = '--conhost-leak-unread-manager';
const DESTROYED_FLAG = '--conhost-leak-destroyed-manager';
const DESTROYED = process.argv.includes(DESTROYED_FLAG);
const UNREAD = DESTROYED || process.argv.includes(UNREAD_FLAG);
const RESULT = 'UNREAD-RESULT ';
const test = UNREAD ? () => {} : require('node:test');
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
let seq = 0;

/** pid -> name of the console hosts that are children of this process. */
function hostChildren() {
  const body = `$ProgressPreference = 'SilentlyContinue'\nGet-CimInstance Win32_Process -Filter "ParentProcessId=${process.pid}" | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`;
  return new Promise((res, rej) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(body, 'utf16le').toString('base64')],
      { encoding: 'utf8', windowsHide: true }, (err, stdout, stderr) => {
        if (err) { rej(new Error(`the process listing failed: ${err.message}\n${stderr}`)); return; }
        const hosts = new Map();
        for (const line of stdout.split(/\r?\n/)) {
          const m = /^(\d+) (.+)$/.exec(line.trim());
          if (m && HOSTS.has(m[2].toLowerCase())) hosts.set(Number(m[1]), m[2]);
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
const STILL = 10;
const UNREAD_PROGRAM = `'use strict';
const fs = require('fs');
const { Worker } = require('worker_threads');
const [flag, written] = process.argv.slice(2);
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
    if (still >= ${STILL}) { fs.writeFileSync(workerData.written, String(now)); process.kill(process.pid); }
  }, 50);
\`, { eval: true, workerData: { sab, written } });
const block = 'x'.repeat(4096) + '\\n';
const t = setInterval(() => {
  if (!fs.existsSync(flag)) return;
  clearInterval(t);
  for (;;) { fs.writeSync(1, block); Atomics.add(n, 0, 1); }
}, 50);
`;

/** This file as the manager of the unread terminal: one result line, and then NOTHING ends it but its own empty loop. */
async function unreadManager() {
  const { PtyManager } = loadTs('src/main/pty.ts');
  const node = consoleNode();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conhost-leak-unread-'));
  const out = { node: `${node.file} ${node.version} (from ${node.from})`, hosts: [], exit: null, events: [], read: 0, written: null, left: null };
  const m = new PtyManager();
  const id = `conhost-leak-unread-${process.pid}`;
  try {
    const program = path.join(dir, 'program.cjs');
    const flag = path.join(dir, 'go');
    const written = path.join(dir, 'written');
    fs.writeFileSync(program, UNREAD_PROGRAM);
    const before = await hostChildren();
    out.spawn = await m.spawn({ id, cwd: process.cwd(), command: node.file, args: [program, flag, written], cols: 80, rows: 24 });
    const proc = m.sessions.get(id).proc;
    proc.onData((d) => { out.read += d.length; });
    const exited = new Promise((res) => proc.onExit((e) => { out.events.push(e); res(e); }));
    out.hosts = [...(await hostChildren())].filter(([pid]) => !before.has(pid));
    if (DESTROYED) {
      // The terminal's exit event comes from the socket closing, at once and without a code. The
      // program's own end is the file it writes; the native exit report is the agent's exit code.
      proc._agent.outSocket.destroy();
      fs.writeFileSync(flag, '');
      await exited;
      while (!fs.existsSync(written)) await hostChildren();
      for (let k = 0; k < LISTINGS && proc._agent._exitCode === undefined; k += 1) await hostChildren();
      out.exit = { exitCode: proc._agent._exitCode };
    } else {
      proc.pause();                    // nothing reads this terminal's output from here on
      fs.writeFileSync(flag, '');      // and only now does the program print
      out.exit = await exited;
    }
    out.written = Number(fs.readFileSync(written, 'utf8'));
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
  process.stdout.write(`${RESULT}${JSON.stringify(out)}\n`);
}
if (UNREAD) unreadManager();

/** Runs this file as a manager process; resolves with its result line, and `ended()` says how it ended, waiting LISTINGS listings at most. */
async function managerRun(t, flag) {
  const child = spawn(process.execPath, [__filename, flag], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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

test('PTY-CONHOST-LEAK: a program that ends itself with its output unread: the exit is reported, the host goes, and the manager process ends by itself',
  { skip: !WIN, timeout: 120_000 }, async (t) => {
    const { r, pid, ended, stderr } = await managerRun(t, UNREAD_FLAG);
    t.diagnostic(`PTY child: ${r.node}; the program had ${r.written} writes of 4097 bytes returned when it ended itself; the manager read ${r.read} bytes`);
    // The state: the program printed, nothing of it was read, and it ended ITSELF (process.kill of
    // its own pid ends a Windows process with code 1; the manager sent no kill).
    assert.ok(r.written > 0, 'the program printed before it ended');
    assert.equal(r.read, 0, 'nothing of the output was read: the terminal was paused before the first write');
    assert.deepEqual(r.exit && r.exit.exitCode, 1, `THE EXIT IS REPORTED, with the program's own end: ${JSON.stringify(r.exit)}`);
    assert.deepEqual(r.left, [], `THE CONSOLE HOST OUTLIVES ITS TERMINAL: the program ended itself with its output unread, and ${LISTINGS} listings after the exit was reported `
      + `${r.left.map(([p, name]) => `${name} pid ${p}`).join(', ')} is still a child of the manager process`);
    const end = await ended();
    assert.ok(end, `THE MANAGER PROCESS DOES NOT END: ${LISTINGS} listings after it reported its result (exit reported, host gone) pid ${pid} is still running. `
      + 'Nothing is left for it to do, so its exit thread is still inside the close and holds the exit callback (quit would wait on that thread)');
    assert.deepEqual(end, { code: 0, signal: null }, `the manager process ended by itself and cleanly:\n${stderr()}`);
  });

/** Ends a console host the manager process `parent` left behind: only a host, and only one whose recorded parent is that process. */
function endLeftHost(pid, parent) {
  const body = `$ProgressPreference = 'SilentlyContinue'\nGet-CimInstance Win32_Process -Filter "ProcessId=${pid} AND ParentProcessId=${parent}" | Where-Object { $_.Name -eq 'conhost.exe' -or $_.Name -eq 'OpenConsole.exe' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
  return new Promise((res) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(body, 'utf16le').toString('base64')], { windowsHide: true }, () => res()));
}

test('PTY-CONHOST-LEAK: the same program with the terminal\'s output socket destroyed: the exit is reported and the manager process ends by itself (the close never returns there)',
  { skip: !WIN, timeout: 120_000 }, async (t) => {
    const { r, pid, ended, stderr } = await managerRun(t, DESTROYED_FLAG);
    t.after(async () => { for (const [host] of r.left || []) await endLeftHost(host, pid); });
    t.diagnostic(`PTY child: ${r.node}; the program had ${r.written} writes returned when it ended itself; host still a child ${LISTINGS} listings later: ${JSON.stringify(r.left)} (not judged here yet)`);
    assert.ok(r.written > 0, 'the program printed before it ended');
    assert.ok(r.events.length >= 1, 'the terminal told the manager that it ended');
    assert.deepEqual(r.exit, { exitCode: 1 }, `THE EXIT IS REPORTED by the native side, with the program's own end: ${JSON.stringify(r.exit)}`);
    const end = await ended();
    assert.ok(end, `THE MANAGER PROCESS DOES NOT END: ${LISTINGS} listings after it reported its result (exit reported) pid ${pid} is still running. `
      + 'Nothing is left for it to do: the close of the pseudoconsole has not returned and holds the exit callback, on the thread a quit joins');
    assert.deepEqual(end, { code: 0, signal: null }, `the manager process ended by itself and cleanly:\n${stderr()}`);
  });
