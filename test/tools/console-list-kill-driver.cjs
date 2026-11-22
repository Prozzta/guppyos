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
 * usage: node console-list-kill-driver.cjs <outfile> <pid of the test file> [owner-with-no-console]
 *
 * FLAKE-NODEPTY-CONSOLE-LIST-KILL-HARNESSALIVE-NOBODY, the third argument: the test starts a second
 * driver as electron.exe run as Node, which has NO console (a GUI-subsystem program; that is the
 * owner of onbinary-drop's terminal under the Electron leg). That driver runs one harness case,
 * harnessOwnerNoConsole, and nothing else: with no console there is no bystander to share one.
 * Every fork of such a driver is electron.exe again, so none of them gets a console or a window.
 * What the driver is, it measures itself and writes to out.owner (see ownerFacts).
 */
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
const { nodeEnv } = require('./node-env.cjs');

const [outFile, outerPid] = [process.argv[2], Number(process.argv[3])];
const NO_CONSOLE = 'owner-with-no-console';
const mode = process.argv[4] || null;
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
const LEFT_LATE = `left its console ${SLOW_KILL_MS} ms after the harness first asked its hold (told by the driver to take itself off; it runs on)`;
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
/**
 * FLAKE-NODEPTY-CONSOLE-LIST-KILL-HARNESSALIVE-NOBODY: the console lists that the HARNESS asks for
 * before its close (node-pty's own, asked inside its kill, are not touched: `st.closed` is set by
 * then). Every answer is written down. A case can script the first asks, or all of them: the driver
 * then starts console-list-stub.cjs in place of the helper, which answers as a helper does that
 * could not list the console. No load and no clock: the answer is the seam.
 *   first   the answers of asks 1..n ('fails', 'empty', 'strangers', 'silent'); later asks are real
 *   always  the answer of every ask
 *   answered(n, mode, message)  called when the helper of ask n has ended, before the harness reads it
 */
let listSeam = null;
const STUB = path.join(__dirname, 'console-list-stub.cjs');
// node-pty's helper (what the harness asked before the fix) and the harness's own (after it).
const isListHelper = (file) => ['conpty_console_list_agent', 'console-list-helper'].includes(path.basename(String(file)).replace(/\.c?js$/, ''));
cp.fork = function fork(...a) {
  const seam = listSeam && !listSeam.st.closed && isListHelper(a[0]) ? listSeam : null;
  let mode = null;
  if (seam) {
    seam.asked += 1;
    mode = seam.first[seam.asked - 1] || seam.always || null;
    if (mode) { a[0] = STUB; a[1] = [mode]; }
  }
  const c = realFork.apply(this, a);
  forks.push(c.pid);
  if (seam) {
    const n = seam.asked;
    let got = null;
    c.on('message', (m) => { got = m; });
    // Registered before the harness's own listener, so it runs first: the case acts on an answer before the harness reads it.
    c.on('exit', () => seam.answered(n, mode, got));
  }
  return c;
};
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
/**
 * The env of a harness terminal's child: the same in every case. ELECTRON_NO_ATTACH_CONSOLE is the
 * key of the owner with no console (the test file sets it on that driver), and it stays the owner's.
 */
const childEnv = () => {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  return env;
};
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
 * What this driver is, measured by itself with nothing of the harness in between: its program, what
 * opening its own console device said ('opened', or the error code), and what the real list helper
 * said of the console of the driver's own pid. A cell that is about an owner with a console, or
 * with none, reads its control here.
 */
async function ownerFacts() {
  let conout = 'opened';
  try { fs.closeSync(fs.openSync('\\\\.\\CONOUT$', 'r+')); } catch (e) { conout = String(e && e.code); }
  const ownList = await new Promise((resolve) => {
    const agent = realFork.call(cp, path.join(__dirname, 'console-list-helper.cjs'), [String(process.pid)]);
    forks.push(agent.pid);
    let got = null;
    agent.on('message', (m) => { got = m; });
    agent.on('exit', () => resolve(!got ? 'no message' : got.error ? String(got.error)
      : Array.isArray(got.consoleProcessList) && got.consoleProcessList.includes(process.pid) ? 'a list that holds the owner' : 'a list without the owner'));
    agent.on('error', (e) => resolve(`the helper did not start (${e && e.message})`));
  });
  return { exe: path.basename(process.execPath), electron: process.versions.electron || null, conout, ownList };
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
  if (mode !== null && mode !== NO_CONSOLE) throw new Error(`the third argument is ${NO_CONSOLE} or nothing, not ${JSON.stringify(mode)}`);
  // No visible window, ever: a console program (node.exe) with no console gives each of its forks a
  // NEW console with a window, and node-pty forks its list helper with no windowsHide.
  if (mode === NO_CONSOLE && !process.versions.electron) throw new Error(`${NO_CONSOLE} runs as electron.exe only (ELECTRON_RUN_AS_NODE=1): this is ${process.execPath}`);
  out.owner = await ownerFacts();
  // No bystander for an owner with no console: there is no console for the two to share.
  bystanderProc = mode === NO_CONSOLE ? null : realSpawn.call(cp, process.execPath, ['-e', IDLE], { stdio: 'inherit', env: nodeEnv(process.env) });
  const bystander = bystanderProc ? bystanderProc.pid : null;
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
   * SLOW_KILL_MS later, with nothing sent by the harness. With says 'gone' that is a child that has
   * exited by itself and that its console still lists for a while.
   *
   * FLAKE-CLK-EXITED-BY-ITSELF-ROOTEXITED-RACE-108: the driver ended the child by pid at that point.
   * A process that is being ended goes off its console first and its exit is signalled later, so a
   * list of the harness could land between the two (seen 2026-11-22 under suite load: the close was
   * right by the rule, and the driver's own hold still said the child ran). The driver now makes
   * that order exact and holds it: it TELLS the child to leave (the file <case>.leave, see
   * leavesWhenTold), the child takes itself off its console and runs on, and the driver ends it
   * only after the case (record's endRoot). So the two events are apart in every run: the console
   * leave comes before the close, the exit after it. `order` writes down what was seen at each.
   */
  const harness = async (key, prelude, { says = null, slow = false, leaves = false, lists = null } = {}) => {
    named = []; sweeps = 0; sweepEndsNothing = false;
    const c = out.cases[key] = {};
    const marker = path.join(tmp, `${key}.up`);
    const st = { closed: false, sweep: null, onSweep: null };
    let root = null;
    /**
     * `lists` (see listSeam): { first, always, thenLeaves }. With thenLeaves the child is on its
     * console until the first answer that is not scripted has come (a real list, which holds it),
     * and the driver ends it right then, under its own hold, before the harness reads that answer.
     * So "was the terminal closed before the child was ended" has one right answer, whatever the load.
     */
    const script = lists || {};
    const endAfterScript = () => {
      const mine = holds.get(root);
      c.closedBeforeDriverKill = st.closed;
      if (!mine || !mine.alive()) { c.driverKill = `not sent: ${mine ? "the driver's own hold says the child has exited" : 'no hold'}`; return; }
      c.driverKill = 'sent at the first list answer that was not scripted';
      try { realKill(root); } catch { /* gone */ }
    };
    c.harnessLists = [];
    c.harnessListsAsked = 0;
    listSeam = {
      st, asked: 0, first: script.first || [], always: script.always || null,
      answered: (n, mode, m) => {
        const list = m && Array.isArray(m.consoleProcessList) ? m.consoleProcessList : null;
        const empty = m && 'error' in m ? 'EMPTY, and the call did not fail' : 'EMPTY, or a failure that the helper hides';
        // What the harness is about to read. Booleans, not names: a scripted list holds pids of nobody.
        const line = {
          n, by: mode ? `the driver's stub: ${mode}` : 'the real helper',
          answer: !m ? 'NO MESSAGE' : m.error ? `FAILED: ${m.error}` : list && list.length === 0 ? empty : list ? 'a list' : 'not a list',
          owner: Boolean(list && list.includes(process.pid)), child: Boolean(list && list.includes(root))
        };
        c.harnessListsAsked = n;
        if (c.harnessLists.length < 8) c.harnessLists.push(line);
        c.lastHarnessList = line;
        // `leaves` only: the first list of the owner's console that lacks the child, and what the
        // driver's own hold said of the child's exit right then.
        if (c.order && !c.order.firstListWithoutChild && line.answer === 'a list' && line.owner && !line.child) {
          const mine = holds.get(root);
          c.order.firstListWithoutChild = { ask: n, ms: Date.now() - c.order.t0, toldByThen: c.leftConsole !== undefined, exitSignalled: mine ? !mine.alive() : null };
        }
        if (!mode && script.thenLeaves && c.driverKill === undefined) endAfterScript();
      }
    };
    // FLAKE-NODEPTY-...: what the child's own list call said, where its prelude made one (see `freed`).
    const freedFile = path.join(tmp, `${key}.freed`);
    const leaveLate = () => {
      c.leavesArmed = true;
      // Times are written down for the reader of a red cell. No assert reads a time.
      c.order = { t0: Date.now() };
      setTimeout(() => {
        // Was node-pty's kill entered while the child was still on the console? Read before the tell, and
        // before the early return: a close that came first may itself have ended the child.
        c.closedBeforeLeave = st.closed;
        const mine = holds.get(root);
        if (!mine || !mine.alive()) return;
        c.order.toldMs = Date.now() - c.order.t0;
        c.leftConsole = LEFT_LATE;
        fs.writeFileSync(path.join(tmp, `${key}.leave`), 'leave');
      }, SLOW_KILL_MS);
    };
    holdSeen = { c, st, says, onFirstAsk: leaves ? leaveLate : null };
    try {
      await childBytes(Buffer.from('x'), {
        file: electronExe(), env: childEnv(), prelude: up(marker) + prelude, host: 'inbox',
        // What the harness itself found when it asked whether its owner has a console, as it gave it.
        onOwnerCheck: (answer) => { c.ownerConsole = answer; },
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
            if (c.order) c.order.closeMs = Date.now() - c.order.t0;
          });
        }
      });
      c.result = 'resolved';
    } catch (e) { c.result = String(e && e.message).slice(0, 160); }
    listSeam = null;
    if (script.thenLeaves && c.driverKill === undefined) {
      // The harness settled and never asked a list past the scripted ones: the child was never ended.
      c.driverKill = 'not sent: the harness asked for no list after the scripted ones';
      c.closedBeforeDriverKill = st.closed;
    }
    try { c.freed = fs.readFileSync(freedFile, 'utf8'); } catch { /* this case's child made no list call of its own */ }
    try { c.past = fs.readFileSync(path.join(tmp, `${key}.past`), 'utf8'); } catch { /* no such child, or it ended before that */ }
    await record(c, root, st);
    own = null;
    holdSeen = null;
  };
  /**
   * A child that takes ITSELF off its console and goes on running: it makes the native list call on
   * its own pid, which frees the console it is on and then cannot attach to a console of a process
   * that has none. What the call said is written to <case>.freed. This is the order a process that
   * is being ended goes through (off the console first, the exit signalled later), held for good.
   *
   * Measured (2026-11-22, both legs): with its console gone the child's std handles are dead, and the
   * 'READY' write of the harness's child script threw EBADF from writeSync, uncaught: exit code 1 two
   * ms after the call. A throw inside write() is not an 'error' event, so the child's stdout and
   * stderr write nothing from then on. It answers by files only: <case>.freed, and <case>.past once
   * it has run past the harness's own script.
   */
  /**
   * The same, when the driver says so and not before: the child watches the case's folder and takes
   * itself off its console once <case>.leave is there (see `leaves` at harness()). No clock in the
   * child: the tell is the seam. Until then it is the plain `late` child, on the owner's console.
   */
  const leavesWhenTold = (key) => `{ const fs = require('fs'); let left = false; const leave = () => { if (left || !fs.existsSync(${JSON.stringify(path.join(tmp, `${key}.leave`))})) return; left = true; ${freed(key)} };`
    + ` fs.watch(${JSON.stringify(tmp)}, leave); leave(); }`;
  const freed = (key) => `for (const s of [process.stdout, process.stderr]) s.on('error', () => {}); let said; try { require(${JSON.stringify(require.resolve('node-pty/lib/utils'))}).loadNativeModule('conpty_console_list').module.getConsoleProcessList(process.pid);`
    + ` said = 'the call returned a list'; } catch (e) { said = String(e && e.message); } require('fs').writeFileSync(${JSON.stringify(path.join(tmp, `${key}.freed`))}, said);`
    + ` process.stdout.write = process.stderr.write = () => true; process.stdin.on('error', () => {});`
    + ` setImmediate(() => require('fs').writeFileSync(${JSON.stringify(path.join(tmp, `${key}.past`))}, 'ran past the harness script'));`;
  if (mode === NO_CONSOLE) {
    // The owner has no console (out.owner says so). The child is alive when childBytes gives up, and
    // the harness's kill by pid reaches it SLOW_KILL_MS late: a harness that closes without waiting
    // for the exit closes while the child still runs, and rootExitedAtClose says so.
    await harness('harnessOwnerNoConsole', late, { slow: true });
    out.done = true;
    save();
    process.exit(0);
  }
  await harness('harnessAlive', late);
  // The same live child, but the hold answers "exited": the harness must then name no pid itself.
  // (The child stays on the owner's console for good, so a harness that reads the console list of
  // the pid before it closes never closes this terminal.)
  await harness('harnessHoldSaysGone', late, { says: 'gone' });
  // Gone at once, as soon as it has run a line: the pin does not race the child's start against the 5 s.
  await harness('harnessGone', 'process.exit(2);');
  // The live child again, and the harness's kill by pid takes effect late (see deliverLate).
  await harness('harnessDiesSlowly', late, { slow: true });
  // The same, and the hold says "exited" as soon as the kill is sent, while the child is still on
  // the console: what a console that is slow to drop an exited process looks like to the harness.
  await harness('harnessExitedStillOnConsole', late, { slow: true, says: 'goneOnceEnded' });
  // No kill by pid at all: the hold says "exited" at the first ask (a child that ended by itself),
  // and the child is on the console for 2 s more. Then it takes itself off the console, told by the
  // driver, and runs on to the end of the case: off the console first, the exit later, in every run.
  await harness('harnessExitedByItselfStillOnConsole', late + leavesWhenTold('harnessExitedByItselfStillOnConsole'), { says: 'gone', leaves: true });
  // The kill by pid is real, and the hold goes on saying the child runs.
  await harness('harnessNeverExits', late, { says: 'runs' });
  // Nothing can hold the child (no addon).
  await harness('harnessNoHold', late, { says: 'none' });
  // FLAKE-NODEPTY-CONSOLE-LIST-KILL-HARNESSALIVE-NOBODY, the list the harness reads before its close.
  // In each of these the hold says "exited" at the first ask, so no kill by pid is sent, and the
  // child is alive and on the owner's console: only the list can say that it is.
  // The first list call fails. A failed call says nothing about who is on the console.
  await harness('harnessListFailsOnce', late, { says: 'gone', lists: { first: ['fails'], thenLeaves: true } });
  // Three more answers that list nothing of the owner's console. One case each: a harness that closes
  // on one of them ends its case there, and the other two must still be asked.
  await harness('harnessListSaysEmpty', late, { says: 'gone', lists: { first: ['empty'], thenLeaves: true } });
  await harness('harnessListSaysStrangers', late, { says: 'gone', lists: { first: ['strangers'], thenLeaves: true } });
  await harness('harnessListSaysSilent', late, { says: 'gone', lists: { first: ['silent'], thenLeaves: true } });
  // The list call fails every time, and the child stays on the console for good.
  await harness('harnessListAlwaysFails', late, { says: 'gone', lists: { always: 'fails' } });
  // The child is alive and has taken itself off the console: a real list of the owner's console
  // then lacks it, and the terminal can be closed while the child still runs.
  await harness('harnessChildOffConsole', late + freed('harnessChildOffConsole'), { says: 'gone' });

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
