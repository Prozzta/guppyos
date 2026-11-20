'use strict';
/**
 * NODEPTY-CONSOLE-LIST-KILL-SIBLINGS: the process whose terminals are closed, for
 * nodepty-console-list-kill.test.cjs. Not a test file. It runs on a console OF ITS OWN (the test
 * starts it with no window, which gives it a new console), so the console that node-pty's kill
 * lists is this private one and never the runner's.
 *
 * NOTHING IS KILLED BY THE LIST SWEEP HERE: process.kill is a recorder (signal 0, the liveness
 * question, still goes through). What node-pty's kill WOULD have ended is what the cells read.
 *
 * Who is who on the private console:
 *   driver     this process. It stands for the test file in the harness cases and for the app's
 *              main process in the product cases: the one that owns the terminal.
 *   bystander  a plain child of the driver on the same console: a sibling test file, or anything
 *              else that shares the app's console.
 *   root       the terminal's own child.
 *   helper     node-pty's list helper (a fork of the driver, which lists itself).
 *
 * usage: node console-list-kill-driver.cjs <outfile> <pid of the test file>
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
const { nodeEnv } = require('./node-env.cjs');

const [outFile, outerPid] = [process.argv[2], Number(process.argv[3])];
const out = { driver: process.pid, cases: {} };
const save = () => fs.writeFileSync(outFile, JSON.stringify(out, null, 1));

const realKill = process.kill.bind(process);
let named = [];
process.kill = function kill(pid, signal) {
  if (signal === 0) return realKill(pid, 0);
  named.push(pid);
  return true;
};
/** The root of the case that is running, so a driver that fails leaves nothing behind. */
let live = null;
const forks = [];
const realFork = cp.fork;
cp.fork = function fork(...a) { const c = realFork.apply(this, a); forks.push(c.pid); return c; };
// The tree sweep (taskkill) is real, or answered as one that ended nothing: failed, or cut at its cap.
const realSpawn = cp.spawn;
let sweepEndsNothing = false;
let sweeps = 0;
cp.spawn = function spawn(cmd, args, ...rest) {
  if (cmd !== 'taskkill' || !sweepEndsNothing) return realSpawn.call(this, cmd, args, ...rest);
  sweeps += 1;
  const e = new EventEmitter();
  process.nextTick(() => e.emit('close', 1));
  return e;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { realKill(pid, 0); return true; } catch { return false; } };
const IDLE = 'setInterval(() => {}, 1000);';
const up = (marker) => `require('fs').writeFileSync(${JSON.stringify(marker)}, 'up');`;

/** The console processes of `pid`, asked the way node-pty asks (its own helper), with no kill after. */
function consoleOf(pid) {
  return new Promise((resolve) => {
    const agent = realFork.call(cp, require.resolve('node-pty/lib/conpty_console_list_agent'), [String(pid)]);
    forks.push(agent.pid);
    let got = null;
    agent.on('message', (m) => { got = m.consoleProcessList; });
    agent.on('exit', () => resolve(got || []));
    agent.on('error', () => resolve([]));
  });
}

(async () => {
  const { childBytes, electronExe } = require('./pty-child.cjs');
  const { consoleNode } = require('./console-node.cjs');
  const { PtyManager } = require('../load-ts.cjs')('src/main/pty.ts');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clk-driver-'));
  const bystander = realSpawn.call(cp, process.execPath, ['-e', IDLE], { stdio: 'inherit', env: nodeEnv(process.env) }).pid;
  out.bystander = bystander;
  const role = (pid, root) => (pid === process.pid ? 'driver' : pid === root ? 'root' : pid === bystander ? 'bystander'
    : pid === outerPid ? 'TEST FILE' : forks.includes(pid) ? 'helper' : `other(${pid})`);
  const roles = (pids, root) => pids.map((p) => role(p, root));
  /**
   * Waits for node-pty's kill, then for the console list if that kill asked for one (it asks inside
   * the kill call, or never), then for its kills; writes what was named. A fix that never asks for
   * the list is measured the same way: `closed` is the control, `swept` only says which path ran.
   */
  const record = async (c, root, st) => {
    for (let i = 0; i < 800 && !st.closed; i++) await sleep(25);
    c.closed = st.closed;
    c.swept = Boolean(st.sweep);
    if (st.sweep) await st.sweep.catch(() => {});
    await sleep(300);
    c.named = roles(named, root);
    // Outside the terminal's own tree. The helper is node-pty's own and ends by itself: not counted.
    c.strangers = c.named.filter((r) => r !== 'root' && r !== 'helper');
    c.treeSweeps = sweeps;
    // Control that does not depend on the clock: the kills were only recorded, so a root that was
    // alive at the kill still is. Whose console is it on now?
    c.consoleAfter = roles(await consoleOf(root), root);
    save();
    try { realKill(root); } catch { /* gone */ }
    live = null;
  };
  /** `atKill` runs as node-pty's kill is entered, before anything is closed or listed. */
  const watch = (proc, st, atKill) => {
    const agent = proc._agent;
    const list = agent._getConsoleProcessList;
    agent._getConsoleProcessList = function consoleProcessList(...a) { const p = list.apply(this, a); st.sweep = Promise.resolve(p); return p; };
    // The agent's kill, not the terminal's: the terminal defers its own until the terminal is ready.
    const kill = agent.kill;
    agent.kill = function agentKill(...a) { if (!st.closed) atKill(); st.closed = true; return kill.apply(this, a); };
  };

  // ---- (a) the test harness: test/tools/pty-child.cjs childBytes ----
  // `late` pushes the child's own 3 s exit out, so it is ALIVE when childBytes gives up at 5 s: what a
  // loaded machine does to a child that starts slowly.
  const late = 'const st = setTimeout; globalThis.setTimeout = (f) => st(f, 600000);';
  const harness = async (key, prelude) => {
    named = []; sweeps = 0; sweepEndsNothing = false;
    const c = out.cases[key] = {};
    const marker = path.join(tmp, `${key}.up`);
    const st = { closed: false, sweep: null };
    let root = null;
    try {
      await childBytes(Buffer.from('x'), {
        file: electronExe(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, prelude: up(marker) + prelude,
        onSpawn: (proc) => {
          root = live = proc.pid;
          watch(proc, st, () => { c.upAtKill = fs.existsSync(marker); c.aliveAtKill = alive(root); });
        }
      });
      c.result = 'resolved';
    } catch (e) { c.result = String(e && e.message).slice(0, 160); }
    await record(c, root, st);
  };
  await harness('harnessAlive', late);
  // Gone at once, as soon as it has run a line: the pin does not race the child's start against the 5 s.
  await harness('harnessGone', 'process.exit(2);');

  // ---- (b) the product: PtyManager ----
  const product = async (key, { file, env, endsNothing, quit, recycled }) => {
    named = []; sweeps = 0; sweepEndsNothing = endsNothing;
    const c = out.cases[key] = {};
    save();
    const marker = path.join(tmp, `${key}.up`);
    const m = new PtyManager();
    const r = await m.spawn({ id: key, cwd: tmp, command: file, args: ['-e', up(marker) + IDLE], cols: 80, rows: 24, env });
    c.spawn = r.ok ? 'ok' : String(r.error);
    if (!r.ok) { save(); return; }
    const s = m.sessions.get(key);
    const root = live = s.proc.pid;
    c.hold = Boolean(s.hold);
    for (let i = 0; i < 2400 && !fs.existsSync(marker); i++) await sleep(25);
    c.up = fs.existsSync(marker);
    // Control, before any kill: whose console is the root on?
    c.consoleBefore = roles(await consoleOf(root), root);
    const st = { closed: false, sweep: null };
    watch(s.proc, st, () => { c.aliveAtKill = alive(root); });
    if (recycled) {
      // SIMULATED, in one turn with the kill below: the terminal has no hold on its root (as when
      // the addon is missing or the root could not be opened), the root is gone, and its pid number
      // is another process's now, one that lives on another console (here: the bystander's).
      // A pid cannot be recycled to order, so the number node-pty holds is pointed at the stranger.
      if (s.hold) { s.hold.release(); s.hold = null; }
      realKill(root);
      // node-pty keeps the number twice: the terminal's (what PtyManager reads) and the agent's (what its kill lists).
      s.proc._pid = bystander;
      s.proc._agent._innerPid = bystander;
      c.pidNow = s.proc.pid === s.proc._agent._innerPid ? role(s.proc.pid, root) : 'two numbers';
    }
    if (quit) { c.result = 'quit'; void m.killAllAsync(); } else c.result = m.kill(key).ok ? 'ok' : 'kill refused';
    await record(c, root, st);
    sweepEndsNothing = false;
  };
  const gui = { file: electronExe(), env: { ELECTRON_RUN_AS_NODE: '1' } };
  const con = { file: consoleNode().file, env: {} };
  await product('guiKill', { ...gui, endsNothing: false });
  await product('guiKillSweepFailed', { ...gui, endsNothing: true });
  await product('guiQuitSweepFailed', { ...gui, endsNothing: true, quit: true });
  await product('consoleKillSweepFailed', { ...con, endsNothing: true });
  await product('consoleKill', { ...con, endsNothing: false });
  await product('recycledPid', { ...con, endsNothing: true, recycled: true });

  try { realKill(bystander); } catch { /* gone */ }
  out.done = true;
  save();
  process.exit(0);
})().catch((e) => {
  out.failed = String((e && e.stack) || e);
  save();
  for (const pid of [out.bystander, live]) { try { if (pid) realKill(pid); } catch { /* gone */ } }
  process.exit(1);
});
