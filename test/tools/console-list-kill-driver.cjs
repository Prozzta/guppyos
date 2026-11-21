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
 * THE DRIVER'S OWN CLEANUP NAMES NO DEAD PID: it ends a root by pid only while its own hold on that
 * root (procIdentity holdRoot, taken at the spawn) says the root runs. A root that is gone is not
 * named at all: its pid number may be another process's by then, anybody's on the machine. With no
 * hold (no addon) no pid is named and the case says so. The bystander is ended through its child
 * handle, never by number.
 *
 * usage: node console-list-kill-driver.cjs <outfile> <pid of the test file>
 */
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
const { nodeEnv } = require('./node-env.cjs');

const [outFile, outerPid] = [process.argv[2], Number(process.argv[3])];
const out = { driver: process.pid, cases: {} };
const save = () => fs.writeFileSync(outFile, JSON.stringify(out, null, 1));

const realKill = process.kill.bind(process);
let named = [];
/**
 * The harness's own by-pid end of its child (pty-child.cjs finish(), inbox host) is REAL: it comes
 * before node-pty's kill is entered and names the child only. From that kill on, all is recorded.
 */
let own = null;
/**
 * FLAKE-NODEPTY-CONSOLE-LIST-KILL-HARNESSALIVE-NOBODY: a kill by pid returns at once, and the child
 * leaves its console only later. On a loaded machine "later" was after node-pty's list helper had
 * attached. `own.slow` fixes that order with no load: the harness's kill is taken, and reaches the
 * child only when node-pty's console list has answered, or after SLOW_KILL_MS if no list was asked
 * for by then (a harness that waits for the exit asks for none while the child lives).
 */
const SLOW_KILL_MS = 2000;
const LATE_AFTER_LIST = "late: after node-pty's console list had answered";
const LATE_NO_LIST = `late: ${SLOW_KILL_MS} ms after it was sent, and node-pty had asked for no console list by then`;
const LEFT_LATE = `left its console ${SLOW_KILL_MS} ms after the harness first asked its hold (ended by the driver)`;
const deliverLate = (o, pid, signal) => {
  const send = (when) => {
    if (o.c.killDelivered) return;
    o.c.killDelivered = when;
    try { realKill(pid, signal); } catch { /* gone */ }
  };
  const timer = setTimeout(() => send(LATE_NO_LIST), SLOW_KILL_MS);
  o.st.onSweep = (listed) => listed.then(() => {}, () => {}).then(() => { clearTimeout(timer); send(LATE_AFTER_LIST); });
};
process.kill = function kill(pid, signal) {
  if (signal === 0) return realKill(pid, 0);
  if (own && pid === own.root && !own.st.closed) {
    own.c.endedByPid = true;
    if (!own.slow) return realKill(pid, signal);
    deliverLate(own, pid, signal);
    return true;
  }
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

/**
 * The harness's hold on its child (procIdentity holdRoot), seen from outside: was one taken, was it
 * asked before the kill, when was it released. Off (null) outside the harness cases: the app's own
 * holds pass through untouched. `says` makes the hold answer for one case:
 *   'gone'           alive() is false: a child that the hold says has exited.
 *   'runs'           alive() is true for good: a child that never exits, whatever is sent to it.
 *   'goneOnceEnded'  alive() is false from the harness's kill by pid on, while the child is in fact
 *                    still on its console: an exit that the console has not yet taken note of.
 *   'none'           no hold can be taken (no addon): holdRoot answers null.
 * onFirstAsk, if set, runs once, at the first answer (see `leaves` at harness()).
 * holdAskedBeforeKill is the FIRST answer, the one that decides whether the pid is named: a harness
 * that then waits for the exit asks again, and those answers are not the decision.
 */
let holdSeen = null;
const ident = require('../load-ts.cjs')('src/main/procIdentity.ts');
const realHoldRoot = ident.holdRoot;
ident.holdRoot = function holdRoot(...a) {
  const seen = holdSeen;
  if (seen && seen.says === 'none') { seen.c.holdTaken = false; return null; }
  const h = realHoldRoot.apply(this, a);
  if (!seen) return h;
  seen.c.holdTaken = Boolean(h);
  if (!h) return h;
  return {
    alive: () => {
      const v = seen.says === 'gone' ? false : seen.says === 'runs' ? true
        : seen.says === 'goneOnceEnded' && seen.c.endedByPid ? false : h.alive();
      if (!seen.st.closed && seen.c.holdAskedBeforeKill === undefined) {
        seen.c.holdAskedBeforeKill = v;
        if (seen.onFirstAsk) seen.onFirstAsk();
      }
      return v;
    },
    release: () => {
      if (seen.c.holdReleasedAfterKill === undefined) {
        seen.c.holdReleasedAfterKill = seen.st.closed;
        // The terminal's conout worker ends from node-pty's kill, or the harness ends it when it refuses the close.
        seen.c.holdReleasedAfterWorkerExit = seen.c.workerExited === true;
      }
      h.release();
    }
  };
};

/**
 * The driver's own holds, one per root, taken with the real holdRoot (a duplicate of node-pty's
 * handle: the harness's and the app's holds are not touched). Null where nothing can hold.
 */
const holds = new Map();
const holdOwn = (proc) => { holds.set(proc.pid, realHoldRoot(proc.pid, process.platform, ident.rootHandoff(proc))); };
/** The one place a cleanup kill is sent. What the hold says AT the kill is written down, apart from the guard. */
const realEnd = (c, pid, hold) => {
  c.cleanupKills = (c.cleanupKills || []).concat(hold.alive() ? 'held, running' : 'DEAD PID');
  try { realKill(pid); } catch { /* gone */ }
};
/** Ends a root the driver started, only while the driver's hold says it runs. `keep`: more kills follow. */
const endRoot = (c, root, keep = false) => {
  const hold = holds.get(root);
  if (!hold) { c.cleanup = 'no hold: no pid named'; return; }
  if (hold.alive()) { realEnd(c, root, hold); c.cleanup = 'ended while held'; } else if (!c.cleanup) c.cleanup = 'gone: no pid named';
  if (!keep) { hold.release(); holds.delete(root); }
};
let bystanderProc = null;

(async () => {
  // After the wrap above: pty-child.cjs takes holdRoot from the module when it loads.
  const { childBytes, electronExe } = require('./pty-child.cjs');
  const { consoleNode } = require('./console-node.cjs');
  const { PtyManager } = require('../load-ts.cjs')('src/main/pty.ts');
  // The folder of the result file: the test file made it and removes it when it ends, after this
  // process. The driver makes no folder of its own, so it leaves nothing in the temp folder.
  const tmp = path.dirname(path.resolve(outFile));
  bystanderProc = realSpawn.call(cp, process.execPath, ['-e', IDLE], { stdio: 'inherit', env: nodeEnv(process.env) });
  const bystander = bystanderProc.pid;
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
    // A harness that refused to close its terminal has said so, and no kill will come: not waited for.
    const refused = /^PTY teardown: /.test(c.result || '') && !st.closed;
    for (let i = 0; i < 800 && !st.closed && !refused; i++) await sleep(25);
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
    endRoot(c, root);
    save();
    live = null;
  };
  /** `atKill` runs as node-pty's kill is entered, before anything is closed or listed. */
  const watch = (proc, st, atKill) => {
    const agent = proc._agent;
    const list = agent._getConsoleProcessList;
    agent._getConsoleProcessList = function consoleProcessList(...a) {
      const p = list.apply(this, a);
      st.sweep = Promise.resolve(p);
      if (st.onSweep) st.onSweep(st.sweep);
      return p;
    };
    // The agent's kill, not the terminal's: the terminal defers its own until the terminal is ready.
    const kill = agent.kill;
    agent.kill = function agentKill(...a) { if (!st.closed) atKill(); st.closed = true; return kill.apply(this, a); };
  };

  // ---- (a) the test harness: test/tools/pty-child.cjs childBytes ----
  // On the inbox conhost, the one host where node-pty's kill asks for the console list.
  // `late` pushes the child's own 3 s exit out, so it is ALIVE when childBytes gives up at 5 s: what a
  // loaded machine does to a child that starts slowly.
  const late = 'const st = setTimeout; globalThis.setTimeout = (f) => st(f, 600000);';
  /**
   * `leaves`: the child is on its console when the harness first asks its hold, and leaves it
   * SLOW_KILL_MS later, with nothing sent by the harness: the driver ends it then, under its own
   * hold. With says 'gone' that is a child that has exited by itself and that its console still
   * lists for a while.
   */
  const harness = async (key, prelude, { says = null, slow = false, leaves = false } = {}) => {
    named = []; sweeps = 0; sweepEndsNothing = false;
    const c = out.cases[key] = {};
    const marker = path.join(tmp, `${key}.up`);
    const st = { closed: false, sweep: null, onSweep: null };
    let root = null;
    const leaveLate = () => {
      c.leavesArmed = true;
      setTimeout(() => {
        const mine = holds.get(root);
        if (!mine || !mine.alive()) return;
        c.leftConsole = LEFT_LATE;
        try { realKill(root); } catch { /* gone */ }
      }, SLOW_KILL_MS);
    };
    holdSeen = { c, st, says, onFirstAsk: leaves ? leaveLate : null };
    try {
      await childBytes(Buffer.from('x'), {
        file: electronExe(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, prelude: up(marker) + prelude, host: 'inbox',
        onSpawn: (proc) => {
          root = live = proc.pid;
          own = { root, st, c, slow };
          holdOwn(proc);
          // The file can end only once this thread has: node-pty frees it from its kill, or the harness ends it.
          proc._agent._conoutSocketWorker._worker.once('exit', () => { c.workerExited = true; });
          watch(proc, st, () => {
            c.upAtKill = fs.existsSync(marker);
            c.aliveAtKill = alive(root);
            // The driver's own hold, a second handle on the root: had the root exited when node-pty's
            // kill was entered? (aliveAtKill asks the pid number, which a dying process still answers.)
            const mine = holds.get(root);
            if (mine) c.rootExitedAtClose = !mine.alive();
          });
        }
      });
      c.result = 'resolved';
    } catch (e) { c.result = String(e && e.message).slice(0, 160); }
    await record(c, root, st);
    own = null;
    holdSeen = null;
  };
  await harness('harnessAlive', late);
  // The same live child, but the hold answers "exited": the harness must then name no pid itself.
  // (node-pty's kill then lists the console, which is only recorded here.)
  await harness('harnessHoldSaysGone', late, { says: 'gone' });
  // Gone at once, as soon as it has run a line: the pin does not race the child's start against the 5 s.
  await harness('harnessGone', 'process.exit(2);');
  // The live child again, and the harness's kill by pid takes effect late (see deliverLate).
  await harness('harnessDiesSlowly', late, { slow: true });
  // The same, and the hold says "exited" as soon as the kill is sent, while the child is still on
  // the console: what a console that is slow to drop an exited process looks like to the harness.
  await harness('harnessExitedStillOnConsole', late, { slow: true, says: 'goneOnceEnded' });
  // No kill by pid at all: the hold says "exited" at the first ask (a child that ended by itself),
  // and the child is on the console for 2 s more.
  await harness('harnessExitedByItselfStillOnConsole', late, { says: 'gone', leaves: true });
  // The kill by pid is real, and the hold goes on saying the child runs.
  await harness('harnessNeverExits', late, { says: 'runs' });
  // Nothing can hold the child (no addon).
  await harness('harnessNoHold', late, { says: 'none' });

  // ---- (b) the product: PtyManager ----
  const product = async (key, { file, env, endsNothing, recycled }) => {
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
    holdOwn(s.proc);
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
      endRoot(c, root, true);
      // node-pty keeps the number twice: the terminal's (what PtyManager reads) and the agent's (what its kill lists).
      s.proc._pid = bystander;
      s.proc._agent._innerPid = bystander;
      c.pidNow = s.proc.pid === s.proc._agent._innerPid ? role(s.proc.pid, root) : 'two numbers';
    }
    const k = m.kill(key);
    c.result = k.ok ? 'ok' : `kill refused: ${k.error}`;
    await record(c, root, st);
    sweepEndsNothing = false;
  };
  const gui = { file: electronExe(), env: { ELECTRON_RUN_AS_NODE: '1' } };
  const con = { file: consoleNode().file, env: {} };
  /**
   * The mechanism only: whose console is a GUI-subsystem root on? No kill is measured. On the bundled
   * OpenConsole such a terminal reports its exit while the root is still alive, so the session is
   * gone before any kill could reach it (PTY-GUI-ROOT-EXIT-EARLY-UNTRACKED, not this card's).
   */
  const probe = async (key, { file, env }) => {
    const c = out.cases[key] = {};
    const marker = path.join(tmp, `${key}.up`);
    const m = new PtyManager();
    const r = await m.spawn({ id: key, cwd: tmp, command: file, args: ['-e', up(marker) + IDLE], cols: 80, rows: 24, env });
    c.spawn = r.ok ? 'ok' : String(r.error);
    if (!r.ok) { save(); return; }
    const root = live = m.sessions.get(key).proc.pid;
    holdOwn(m.sessions.get(key).proc);
    for (let i = 0; i < 2400 && !fs.existsSync(marker); i++) await sleep(25);
    c.up = fs.existsSync(marker);
    c.consoleBefore = roles(await consoleOf(root), root);
    m.kill(key);
    endRoot(c, root);
    save();
    live = null;
  };
  await probe('guiProbe', gui);
  await product('consoleKillSweepFailed', { ...con, endsNothing: true });
  await product('consoleKill', { ...con, endsNothing: false });
  await product('recycledPid', { ...con, endsNothing: true, recycled: true });

  bystanderProc.kill();
  out.done = true;
  save();
  process.exit(0);
})().catch((e) => {
  out.failed = String((e && e.stack) || e);
  // By handle and by hold only, as everywhere in this file: a pid number alone is never named.
  try { if (bystanderProc) bystanderProc.kill(); } catch { /* gone */ }
  try { if (live) endRoot(out.failedCleanup = {}, live); } catch { /* nothing to hold with */ }
  save();
  process.exit(1);
});
