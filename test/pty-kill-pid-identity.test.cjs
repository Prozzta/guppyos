'use strict';
require('./tools/own-job.cjs');
/**
 * PTY-KILL-PID-IDENTITY: no kill path may name a pid its root no longer owns.
 *
 * PTY-CLOSETREE-PIDREUSE left three holes (Jim's audit of 057e5ae6, and the card):
 *   (a) THE WINDOW. node-pty closes its handle to a dead root first and reports the exit to JS a
 *       main-loop turn or more later. In between the pid is free and rootState says 'running', so
 *       both of closeTree's sweeps could name it. Now the product holds a handle of its own to the
 *       root (procIdentity.ts holdRoot, the in-repo addon) and asks THAT (pty.ts mayNamePid).
 *   (b) With no hold to ask (addon missing), the old rule is the fallback, and its isAlive half had
 *       no test that could tell it was there (Jim's mutant X2 lived).
 *   (c) killAllAsync (quit) swept every session's pid unasked, and POSIX ensureKilled group-killed
 *       a pid seconds after the leader may have died.
 *
 * THE FIXTURE (Jim's): node-pty's exit report (_agent._$onProcessExit, called from its wait thread
 * AFTER it closed the handle) is held back. From the moment the wrapper is entered until the test
 * lets the report through, the product is inside the window for as long as the scenario needs.
 *
 * NO KILL IN THIS FILE REACHES A PROCESS IT DID NOT START. Every taskkill is recorded and answered
 * by the scenario, never run. The POSIX half runs here under a stated platform with every SIGKILL
 * recorded instead of sent, on pids that are only numbers. A "reused pid" is modelled at the
 * product's own probe (`process.kill(pid, 0)` answers alive), so no stranger exists to be hit.
 *
 * Not run here: the POSIX start-stamp readers against a real /proc or ps (this floor is Windows).
 * Their parsing and the verdict logic are tested with stated inputs.
 *
 * Mutants (each must die at the assertion that names its guarantee): see MUTANTS below.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');
const { tempDir } = require('./tools/test-temp.cjs');

const PTYF = 'src/main/pty.ts';
const KILLF = 'src/main/procKill.ts';
const IDF = 'src/main/procIdentity.ts';
const WIN = process.platform === 'win32';

const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
const realSpawn = cp.spawn;
const sweeps = [];     // the args of every taskkill
let answers = [];      // (emitter) => void, one per sweep; none left: the sweep ends nothing
cp.spawn = function spawn(cmd, args, ...rest) {
  if (cmd !== 'taskkill') return realSpawn.call(this, cmd, args, ...rest);
  sweeps.push([...args]);
  const e = new EventEmitter();
  const answer = answers.shift() || ((em) => process.nextTick(() => em.emit('close', 0)));
  answer(e);
  return e;
};
const sweepsOf = (pid) => sweeps.filter((a) => a.includes(String(pid))).length;

// One stand-in for process.kill:
//   probe (signal 0) of a pid in `reused`: alive (a stranger has the number);
//   probe of a pid in `vacant`: no such process;
//   while `sigkills` is an array: every SIGKILL is RECORDED and never sent (`noGroup`: ESRCH).
const reused = new Set();
const vacant = new Set();
const noGroup = new Set();
let sigkills = null;
const realKill = process.kill;
const esrch = () => Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
process.kill = function kill(pid, signal) {
  if (signal === 0 && reused.has(pid)) return true;
  if (signal === 0 && vacant.has(pid)) throw esrch();
  if (sigkills && signal === 'SIGKILL') {
    sigkills.push(pid);
    if (noGroup.has(pid)) throw esrch();
    return true;
  }
  return realKill.call(process, pid, signal);
};

const CAP_MS = 20_000;   // a failure bound for an event that never comes; no scenario waits it out
const within = (p, what) => {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`TIMED OUT waiting for ${what}`)), CAP_MS); })]).finally(() => clearTimeout(t));
};
const turns = async (n) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); };

/** Run `fn` with the product told it is on `platform`, SIGKILLs recorded and none sent. */
async function onPlatform(platform, fn) {
  const real = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...real, value: platform });
  sigkills = [];
  try { return await fn(sigkills); } finally {
    Object.defineProperty(process, 'platform', real);
    sigkills = null;
    noGroup.clear();
  }
}
/** Resolves once `pid` shows in the recorded SIGKILLs, and everything queued before it has run. */
async function killed(list, pid, what) {
  await within((async () => { while (!list.includes(pid)) await new Promise((r) => setTimeout(r, 20)); })(), what);
  await turns(5);
}

// ---------------------------------------------------------------------------------------------
// POSIX kill path and the identity module: plain logic, run on every platform.
// ---------------------------------------------------------------------------------------------
const E = {
  /** ensureKilled asks the verdict when the grace is over and obeys it. */
  ensure: (mod) => onPlatform('linux', async (list) => {
    noGroup.add(-71002);
    mod.ensureKilled(71001, 1, async () => 'other');
    mod.ensureKilled(71002, 1, async () => 'gone');
    mod.ensureKilled(71003, 1, async () => 'same');
    mod.ensureKilled(71004, 1, async () => 'unknown');
    mod.ensureKilled(71005, 1, () => Promise.reject(new Error('no verdict')));
    mod.ensureKilled(71006, 1);
    mod.ensureKilled(71099, 1);   // the last timer: when its kill is recorded the others have run
    await killed(list, -71099, 'the last grace to end');
    const of = (pid) => list.filter((p) => p === pid || p === -pid);
    assert.deepEqual(of(71001), [], `A PID THAT IS SOMEBODY ELSE'S IS NOT KILLED: verdict 'other', and SIGKILL went to ${of(71001)}`);
    assert.deepEqual(of(71002), [-71002], `A PID WITH NO PROCESS IS NEVER NAMED ITSELF: verdict 'gone' may kill the group only (its group was gone too), and SIGKILL went to ${of(71002)}`);
    assert.ok(list.includes(-71003), "THE ROOT'S OWN GROUP IS STILL KILLED: verdict 'same'");
    assert.ok(list.includes(-71004), "AN UNREADABLE IDENTITY KEEPS THE SWEEP: verdict 'unknown' (a leaked tree is the older bug)");
    assert.ok(list.includes(-71005), 'A VERDICT THAT FAILS KEEPS THE SWEEP');
    assert.ok(list.includes(-71006), 'NO VERDICT GIVEN KEEPS THE SWEEP');
  }),
  /** pty.ts hands each session's own verdict to ensureKilled, from kill() and from the quit. */
  pty: (mod) => onPlatform('linux', async (list) => {
    const m = new mod.PtyManager();
    const fake = (pid, v) => ({ proc: { pid, kill() {} }, owner: null, rootId: { verdict: async () => v } });
    m.sessions.set('pkpi-other', fake(72001, 'other'));
    m.sessions.set('pkpi-same', fake(72002, 'same'));
    assert.ok(m.kill('pkpi-other').ok && m.kill('pkpi-same').ok, 'kill()');
    m.sessions.set('pkpi-quit-other', fake(72003, 'other'));
    m.sessions.set('pkpi-quit-same', fake(72004, 'same'));
    await m.killAllAsync();
    await killed(list, -72004, 'the kill grace (KILL_GRACE_MS) to end');
    const of = (pid) => list.filter((p) => p === pid || p === -pid);
    assert.ok(list.includes(-72002), 'the root that is still itself is group-killed after the grace');
    assert.deepEqual(of(72001), [], `KILL (POSIX) NEVER NAMES A REUSED PID: the session's root was replaced under its pid, and SIGKILL went to ${of(72001)}`);
    assert.deepEqual(of(72003), [], `QUIT (POSIX) NEVER NAMES A REUSED PID: the session's root was replaced under its pid, and SIGKILL went to ${of(72003)}`);
  }),
  /** pidIdentity: the stamp is read at once, and the verdict compares against it. */
  identity: async (mod) => {
    const stamps = new Map([[5, '100']]);
    let reads = 0;
    const read = async (pid) => { reads += 1; return stamps.get(pid); };
    const id = mod.pidIdentity(5, read);
    assert.equal(reads, 1, "THE STAMP IS TAKEN IN THE SPAWN'S OWN TURN, not at the first verdict");
    assert.equal(await id.verdict(), 'same', "IDENTITY: the same start stamp is 'same'");
    stamps.set(5, '200');
    assert.equal(await id.verdict(), 'other', "IDENTITY: another start stamp under the pid is 'other'");
    stamps.set(5, null);
    assert.equal(await id.verdict(), 'gone', "IDENTITY: no process under the pid is 'gone'");
    stamps.set(5, undefined);
    assert.equal(await id.verdict(), 'unknown', "IDENTITY: an unreadable stamp is 'unknown'");
    stamps.set(6, undefined);
    const blind = mod.pidIdentity(6, read);
    stamps.set(6, '300');
    assert.equal(await blind.verdict(), 'unknown', "IDENTITY: with no stamp from spawn nothing can be compared: 'unknown'");
    assert.equal(await mod.pidIdentity(5, null).verdict(), 'unknown', "IDENTITY: no reader on this platform is 'unknown'");
    assert.equal(await mod.pidIdentity(5, () => { throw new Error('boom'); }).verdict(), 'unknown', "IDENTITY: a reader that throws is 'unknown'");
    // /proc/<pid>/stat: field 22 is the start time; the command name may hold ") (" itself.
    const stat = `77 (a) (b c) S ${Array.from({ length: 18 }, (_, i) => i + 1).join(' ')} 424242 99 98`;
    assert.equal(mod.linuxStamp(77, () => stat), '424242', 'LINUX STAMP: field 22 of /proc/<pid>/stat, counted after the LAST ")"');
    assert.equal(mod.linuxStamp(77, () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); }), null, 'LINUX STAMP: no /proc entry is "no such process"');
    assert.equal(mod.linuxStamp(77, () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); }), undefined, 'LINUX STAMP: an unreadable entry is unknown, not "gone"');
    assert.equal(mod.linuxStamp(77, () => 'garbage'), undefined, 'LINUX STAMP: a line that does not parse is unknown');
    assert.equal(mod.holdRoot(process.pid, 'linux'), null, 'holds are Windows only');
  }
};

test("POSIX: ensureKilled obeys the root's identity verdict when the grace is over", () => E.ensure(loadTs(KILLF)));
test('POSIX: kill() and the quit hand each session its own verdict', () => E.pty(loadTs(PTYF)));
test('pidIdentity and the Linux start stamp', () => E.identity(loadTs(IDF)));

function mutateText(rel, edits, tag) {
  let text = readSource(rel);
  for (const [from, to] of edits) {
    const hits = text.split(from).length - 1;
    assert.equal(hits, 1, `mutant ${tag}: edit target must match EXACTLY ONCE, matched ${hits}: ${JSON.stringify(from.slice(0, 80))}`);
    text = text.replace(from, () => to);
  }
  return text;
}

const VERDICT_ARG = ', undefined, s.rootId ? () => s.rootId!.verdict() : undefined);';
const MUTANTS = [
  { file: KILLF, name: "E1 a pid that is somebody else's is swept anyway (the code before this card)", edits: [["      if (v === 'other') return undefined;\n", '']],
    run: (mod) => E.ensure(mod), dies: /A PID THAT IS SOMEBODY ELSE'S IS NOT KILLED/ },
  { file: KILLF, name: "E2 'gone' falls through to the sweep that names the pid", edits: [["      if (v === 'gone') { killGroupOnly(pid); return undefined; }\n", '']],
    run: (mod) => E.ensure(mod), dies: /A PID WITH NO PROCESS IS NEVER NAMED ITSELF/ },
  { file: KILLF, name: 'E3 a verdict that fails means no kill at all', edits: [["verdict().catch((): PidVerdict => 'unknown')", "verdict().catch((): PidVerdict => 'other')"]],
    run: (mod) => E.ensure(mod), dies: /A VERDICT THAT FAILS KEEPS THE SWEEP/ },
  { file: KILLF, name: "E4 'gone' kills nothing, leaving the leader's group", edits: [["{ killGroupOnly(pid); return undefined; }", '{ return undefined; }']],
    run: (mod) => E.ensure(mod), dies: /A PID WITH NO PROCESS IS NEVER NAMED ITSELF/ },
  { file: PTYF, name: 'E5 kill() (POSIX) passes no verdict', edits: [[`ensureKilled(pid${VERDICT_ARG}`, 'ensureKilled(pid);']],
    run: (mod) => E.pty(mod), dies: /KILL \(POSIX\) NEVER NAMES A REUSED PID/ },
  { file: PTYF, name: 'E6 the quit (POSIX) passes no verdict (the code before this card)', edits: [[`ensureKilled(s.proc.pid${VERDICT_ARG}`, 'ensureKilled(s.proc.pid);']],
    run: (mod) => E.pty(mod), dies: /QUIT \(POSIX\) NEVER NAMES A REUSED PID/ },
  { file: IDF, name: 'I1 the verdict reads the comparison backwards', edits: [["return now === was ? 'same' : 'other';", "return now === was ? 'other' : 'same';"]],
    run: (mod) => E.identity(mod), dies: /IDENTITY: the same start stamp/ },
  { file: IDF, name: "I2 no process under the pid is taken for a stranger", edits: [["      if (now === null) return 'gone';\n", '']],
    run: (mod) => E.identity(mod), dies: /IDENTITY: no process under the pid/ },
  { file: IDF, name: 'I3 the Linux stamp reads the wrong field', edits: [['const start = rest[19];', 'const start = rest[18];']],
    run: (mod) => E.identity(mod), dies: /LINUX STAMP: field 22/ },
  { file: IDF, name: 'I4 the Linux stamp counts from the first ")"', edits: [["text.lastIndexOf(')')", "text.indexOf(')')"]],
    run: (mod) => E.identity(mod), dies: /LINUX STAMP: field 22/ },
  { file: IDF, name: 'I5 a missing /proc entry is unknown, so a dead leader is swept by pid', edits: [["return code === 'ENOENT' || code === 'ESRCH' ? null : undefined;", 'return undefined;']],
    run: (mod) => E.identity(mod), dies: /LINUX STAMP: no \/proc entry/ },
  { file: IDF, name: 'I6 the stamp is first read at the first verdict', edits: [['const first: Promise<string | null | undefined> = usable\n    ? (() => {', 'const first: Promise<string | null | undefined> = usable\n    ? Promise.resolve().then(() => {'], ["catch { return Promise.resolve(undefined); } })()", 'catch { return Promise.resolve(undefined); } })']],
    run: (mod) => E.identity(mod), dies: /THE STAMP IS TAKEN IN THE SPAWN'S OWN TURN/ }
];

// ---------------------------------------------------------------------------------------------
// Windows: the hold, the window, the quit.
// ---------------------------------------------------------------------------------------------
if (!WIN) {
  require('./tools/inert.cjs').announceInert('PTY-KILL-PID-IDENTITY (Windows half)', 'process holds, taskkill sweeps and the ConPTY exit report are Windows only');
} else {
  const REAL = loadTs(PTYF);
  const DIR = tempDir('pkpi-');
  fs.writeFileSync(path.join(DIR, 'root.js'), "process.stdout.write('pkpi-root-up'); setInterval(() => {}, 1000);\n");
  let seq = 0;

  /**
   * A real terminal whose root idles. `holdBack`: node-pty's exit report is kept from the product
   * until letReport() (the window). Gives the scenario:
   *   dead      resolves when node-pty's wait thread has delivered the exit (its handle is closed);
   *   reported  resolves when the report has RUN in JS (the product can know);
   *   exited    resolves on node-pty's 'exit' event (after the product's own handler);
   *   closed    resolves when the ConPTY is closed.
   */
  async function withTerminal(Pty, opts, scenario) {
    const m = new Pty();
    const owner = { isDestroyed: () => false, send: () => {} };
    const id = `pkpi-${++seq}`;
    sweeps.length = 0; answers = [];
    let rawClose = null;
    let closes = 0;
    let root = 0;
    let letReport = () => {};
    try {
      const r = await m.spawn({ id, cwd: DIR, command: process.execPath, args: [path.join(DIR, 'root.js')], cols: 80, rows: 24, env: {} }, owner);
      assert.ok(r.ok, `spawn: ${r.error}`);
      const session = m.sessions.get(id);
      const proc = session.proc;
      root = proc.pid;
      // Start once the root has spoken (a ConPTY closed in its first milliseconds can throw
      // node-pty's "stream.push() after EOF" outside any test).
      let seen = '';
      await within(new Promise((resolve) => { const sub = proc.onData((d) => { seen += d; if (seen.includes('pkpi-root-up')) { sub.dispose(); resolve(); } }); }), "the root's first output");
      let onDead = null; let onReport = null; let onExit = null; let onClose = null;
      const dead = new Promise((resolve) => { onDead = resolve; });
      const reported = new Promise((resolve) => { onReport = resolve; });
      const exited = new Promise((resolve) => { onExit = resolve; });
      const closed = new Promise((resolve) => { onClose = resolve; });
      proc.onExit(() => onExit());
      const agent = proc._agent;
      const report = agent._$onProcessExit;
      const hooks = [];
      let holding = opts.holdBack === true;
      let pending = null;
      const deliver = (self, code) => {
        const out = report.call(self, code);
        for (const h of hooks) h();   // in the same turn as the report
        onReport();
        return out;
      };
      agent._$onProcessExit = function onProcessExit(code) {
        onDead();
        if (holding) { pending = () => deliver(this, code); return undefined; }
        return deliver(this, code);
      };
      letReport = () => { holding = false; const p = pending; pending = null; if (p) p(); };
      rawClose = proc.kill.bind(proc);
      proc.kill = (...a) => { closes += 1; onClose(); return rawClose(...a); };
      let releases = 0;
      if (session.hold) { const release = session.hold.release; session.hold.release = () => { releases += 1; release(); }; }
      /** End the root for real. It is running, so the pid is its own. */
      const endRoot = () => { assert.equal(REAL.rootState(proc), 'running', 'the root is running when the scenario ends it'); realKill.call(process, root); };
      return await scenario({ m, id, root, proc, session, dead, reported, exited, closed, endRoot, letReport, atReport: (h) => hooks.push(h), closes: () => closes, releases: () => releases });
    } finally {
      reused.delete(root); vacant.delete(root);
      answers = [];
      letReport();
      await m.killAllAsync(2_000).catch(() => {});
      if (rawClose && closes === 0) { try { rawClose(); } catch { /* gone */ } }
    }
  }

  const exitedAgent = { _useConpty: true, _$onProcessExit() {}, _exitCode: 0 };
  const runningAgent = { _useConpty: true, _$onProcessExit() {}, _exitCode: undefined };

  const W = {
    /** (a) THE CARD. The root is dead, node-pty has closed its handle, the exit report has not run,
     *  and something is alive under the root's old pid. kill() arrives now. */
    window: (Pty) => withTerminal(Pty, { holdBack: true }, async ({ m, id, root, proc, dead, closed, endRoot, letReport }) => {
      endRoot();
      await within(dead, "node-pty's wait thread to see the root dead");
      assert.equal(REAL.rootState(proc), 'running', "the window is real: the root is dead and node-pty's report still reads 'running'");
      reused.add(root);
      assert.ok(m.kill(id).ok, 'kill()');
      await within(closed, 'the ConPTY close');
      await turns(3);
      assert.equal(sweepsOf(root), 0, `IN THE WINDOW NO SWEEP NAMES THE PID: the root was dead, its exit not yet reported, another process alive under pid ${root}, and taskkill /T /F was pointed at it (${sweepsOf(root)} sweep(s))`);
      letReport();
    }),
    /** (b) No hold to ask: the PTY-CLOSETREE-PIDREUSE rule. The first sweep ends the root, the
     *  report is held back, and NOTHING is alive under the pid: a second sweep has no one to name. */
    fallback: (Pty) => withTerminal(Pty, { holdBack: true }, async ({ m, id, root, session, dead, closed, endRoot, letReport }) => {
      if (session.hold) session.hold.release();
      session.hold = null;
      answers = [(e) => { endRoot(); void dead.then(() => { vacant.add(root); e.emit('close', 0); }); }];
      assert.ok(m.kill(id).ok, 'kill()');
      await within(closed, 'the ConPTY close after the sweep');
      assert.equal(sweepsOf(root), 1, `WITHOUT A HOLD A SECOND SWEEP NEEDS SOMETHING ALIVE UNDER THE PID: nothing was, the exit report was still on its way, and ${sweepsOf(root)} sweeps named pid ${root}`);
      letReport();
    }),
    /** (c) Quit in the same turn as the exit report of a root that died on its own. */
    quitExited: (Pty) => withTerminal(Pty, {}, async ({ m, root, reported, endRoot, atReport, closes }) => {
      let quit = null;
      atReport(() => { reused.add(root); quit = m.killAllAsync(2_000); });
      endRoot();
      await within(reported, "node-pty's exit report");
      await within(quit, 'the quit');
      assert.equal(sweepsOf(root), 0, `QUIT NEVER NAMES A PID ITS ROOT NO LONGER OWNS: the root had exited, another process was alive under pid ${root}, and the quit's taskkill /T /F named it`);
      assert.equal(closes(), 1, 'THE CONPTY IS STILL CLOSED ONCE by the quit');
    }),
    /** (c) Quit inside the window. */
    quitWindow: (Pty) => withTerminal(Pty, { holdBack: true }, async ({ m, root, dead, endRoot, letReport }) => {
      endRoot();
      await within(dead, "node-pty's wait thread to see the root dead");
      reused.add(root);
      const quit = m.killAllAsync(2_000);
      letReport();
      await within(quit, 'the quit');
      assert.equal(sweepsOf(root), 0, `QUIT IN THE WINDOW NEVER NAMES THE PID: the root was dead, its exit not yet reported, and the quit's taskkill /T /F named pid ${root}`);
    }),
    /** (c) The quit still sweeps a live root, once, and the hold outlives that sweep. */
    quitLive: (Pty) => withTerminal(Pty, {}, async ({ m, root, session, exited, endRoot, releases }) => {
      assert.ok(session.hold, 'the session holds its root');
      let atExit = -1;
      answers = [(e) => { endRoot(); void exited.then(() => { atExit = releases(); e.emit('close', 0); }); }];
      await within(m.killAllAsync(5_000), 'the quit');
      assert.equal(sweepsOf(root), 1, `QUIT STILL SWEEPS A LIVE ROOT ONCE: ${sweepsOf(root)} sweep(s) of a running root`);
      assert.equal(atExit, 0, "THE HOLD OUTLIVES THE QUIT'S SWEEP: the root exited while taskkill was still running, and the hold was released under it (the pid was free while taskkill named it)");
      assert.ok(releases() >= 1, 'THE HOLD IS RELEASED WHEN THE QUIT IS DONE WITH THE PID');
    }),
    /** The hold reserves the pid until closeTree's last sweep is over, and not longer. */
    holdLife: (Pty) => withTerminal(Pty, {}, async ({ m, id, session, exited, closed, endRoot, releases }) => {
      assert.ok(session.hold, 'the session holds its root');
      let atExit = -1;
      answers = [(e) => { endRoot(); void exited.then(() => { atExit = releases(); e.emit('close', 0); }); }];
      assert.ok(m.kill(id).ok, 'kill()');
      await within(closed, 'the ConPTY close after the sweep');
      await turns(3);
      assert.equal(atExit, 0, 'THE HOLD OUTLIVES THE SWEEP: the root exited while taskkill was still running, and the hold was released under it (the pid was free while taskkill named it)');
      assert.ok(releases() >= 1, 'THE HOLD IS RELEASED AFTER THE LAST KILL: a hold kept for ever keeps a dead process object for ever');
    }),
    /** A root that exits on its own, with no kill in sight, is let go at its exit. */
    natural: (Pty) => withTerminal(Pty, {}, async ({ session, exited, endRoot, releases }) => {
      assert.ok(session.hold, 'the session holds its root');
      endRoot();
      await within(exited, "node-pty's exit event");
      await turns(3);
      assert.ok(releases() >= 1, 'A ROOT THAT EXITED ON ITS OWN IS NOT HELD ANY LONGER');
    }),
    /** mayNamePid against stated shapes. */
    pin: async (Pty, mod) => {
      const { mayNamePid } = mod;
      const yes = { alive: () => true, release() {} };
      const no = { alive: () => false, release() {} };
      const me = process.pid;   // alive throughout; nothing here kills anything
      assert.equal(mayNamePid({ proc: { pid: me, _agent: exitedAgent }, hold: yes }, false), false, 'MAY NAME PID: A REPORTED EXIT WINS OVER A HOLD that still says alive (a hold opened on the wrong process)');
      assert.equal(mayNamePid({ proc: { pid: me, _agent: runningAgent }, hold: no }, false), false, 'MAY NAME PID: a hold that says dead forbids the first sweep');
      assert.equal(mayNamePid({ proc: { pid: me, _agent: runningAgent }, hold: no }, true), false, 'MAY NAME PID: a hold that says dead forbids the repeat, whatever is alive under the pid');
      assert.equal(mayNamePid({ proc: { pid: me, _agent: runningAgent }, hold: yes }, false), true, 'MAY NAME PID: a hold that says alive allows the first sweep');
      assert.equal(mayNamePid({ proc: { pid: me, _agent: runningAgent }, hold: yes }, true), true, 'MAY NAME PID: a hold that says alive allows the repeat');
      assert.equal(mayNamePid({ proc: { pid: me }, hold: yes }, true), true, 'MAY NAME PID: a hold speaks for a terminal node-pty cannot report on');
      assert.equal(mayNamePid({ proc: { pid: me, _agent: runningAgent }, hold: null }, false), true, 'MAY NAME PID: no hold, first sweep allowed');
      assert.equal(mayNamePid({ proc: { pid: me, _agent: runningAgent }, hold: null }, true), true, 'MAY NAME PID: no hold, running and alive: repeat allowed');
      assert.equal(mayNamePid({ proc: { pid: me } }, true), false, 'MAY NAME PID: no hold and no report to trust: no repeat');
    }
  };

  // J1 (Jim): release() is the end of a hold in the product's own code, not only in the addon. The
  // addon here is a recording fake that would say alive for ever, so only holdRoot's own latch can
  // make a released hold say dead, and a released hold must not hand the closed handle back to it.
  W.released = async (id) => {
    const calls = [];
    const dlopen = process.dlopen;
    process.dlopen = (mod) => { mod.exports = { procOpen: () => ({}), procAlive: () => { calls.push('alive'); return true; }, procClose: () => { calls.push('close'); } }; };
    try {
      const hold = id.holdRoot(4242, 'win32');
      assert.ok(hold && hold.alive(), 'the fake addon says alive while the hold is open');
      hold.release();
      const asked = calls.length;
      assert.equal(hold.alive(), false, 'A RELEASED HOLD SAYS DEAD ON ITS OWN: the addon would still say alive');
      assert.equal(calls.length, asked, 'A RELEASED HOLD DOES NOT ASK THE ADDON ABOUT A CLOSED HANDLE');
      hold.release();
      assert.deepEqual(calls.filter((c) => c === 'close'), ['close'], 'the handle is closed once');
    } finally { process.dlopen = dlopen; }
  };
  // A fresh instance of the real source: the shared one has the real addon loaded already.
  test('J1: a released hold says dead by itself and never asks the addon again', () => W.released(loadTs.fromText(IDF, readSource(IDF) + '\n// fresh instance: J1\n')));
  test('THE ADDON: a hold opens only on a live child of this process and follows its death', async () => {
    const { holdRoot } = loadTs(IDF);
    const child = realSpawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      await within(new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }), 'the child to start');
      const hold = holdRoot(child.pid);
      assert.ok(hold, 'NO PROCESS HOLD: resources/fs-handle/bin/guppy_fs_handle.node is missing or was built before PTY-KILL-PID-IDENTITY. Run `node tools/build-fs-handle.cjs` in this tree (npm install does).');
      assert.equal(hold.alive(), true, 'a running child reads alive');
      assert.equal(holdRoot(process.ppid), null, 'A PROCESS THAT IS NOT OUR CHILD IS NOT HELD (a stranger that took the pid before the open)');
      const spare = holdRoot(child.pid);
      spare.release();
      assert.equal(spare.alive(), false, 'a hold released while its child still runs says dead (J1)');
      const gone = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await within(gone, 'the child to exit');
      assert.equal(hold.alive(), false, 'THE HOLD FOLLOWS THE PROCESS, NOT THE PID: dead once the child exited');
      assert.equal(holdRoot(child.pid), null, 'a process that already exited is not held');
      hold.release();
      hold.release();
      assert.equal(hold.alive(), false, 'a released hold never says alive');
    } finally { try { child.kill(); } catch { /* gone */ } }
  });
  test('spawn holds the root of every terminal', () => withTerminal(REAL.PtyManager, {}, async ({ session }) => {
    assert.ok(session.hold && session.hold.alive(), 'a spawned terminal holds its running root');
  }));
  test('THE WINDOW: root dead, exit not yet reported, pid reused: kill() sweeps nothing', () => W.window(REAL.PtyManager));
  test('NO HOLD: the fallback repeats a sweep only for something alive under the pid', () => W.fallback(REAL.PtyManager));
  test('QUIT: a root that already exited is not named', () => W.quitExited(REAL.PtyManager));
  test('QUIT in the window: the dead root is not named', () => W.quitWindow(REAL.PtyManager));
  test('QUIT: a live root is swept once and held until the sweep is over', () => W.quitLive(REAL.PtyManager));
  test('the hold outlives the last sweep of kill() and is then released', () => W.holdLife(REAL.PtyManager));
  test('a root that exits on its own is released at its exit', () => W.natural(REAL.PtyManager));
  test('mayNamePid: the one rule every Windows kill path asks', () => W.pin(REAL.PtyManager, REAL));

  const HOLD_RULE = '  if (s.hold) return s.hold.alive();\n';
  MUTANTS.push(
    { file: PTYF, name: 'K1 the sweeps do not ask the hold (closeTree as it was at 057e5ae6)', edits: [[HOLD_RULE, '']],
      run: (mod) => W.window(mod.PtyManager), dies: /IN THE WINDOW NO SWEEP NAMES THE PID/ },
    { file: PTYF, name: 'K2 spawn takes no hold', edits: [['const hold = holdRoot(proc.pid, process.platform, rootHandoff(proc));', 'const hold = null;']],
      run: (mod) => W.window(mod.PtyManager), dies: /IN THE WINDOW NO SWEEP NAMES THE PID/ },
    { file: PTYF, name: 'K3 the quit names every session (killAllAsync as it was at 057e5ae6)', edits: [['sessions.filter((s) => mayNamePid(s, false)).map((s) => s.proc.pid)', 'sessions.map((s) => s.proc.pid)']],
      run: (mod) => W.quitExited(mod.PtyManager), dies: /QUIT NEVER NAMES A PID ITS ROOT NO LONGER OWNS/ },
    { file: PTYF, name: 'K4 the quit asks only the exit report, not the hold', edits: [['sessions.filter((s) => mayNamePid(s, false))', "sessions.filter((s) => rootState(s.proc) !== 'exited')"]],
      run: (mod) => W.quitWindow(mod.PtyManager), dies: /QUIT IN THE WINDOW NEVER NAMES THE PID/ },
    { file: PTYF, name: 'K5 the quit names nobody', edits: [['sessions.filter((s) => mayNamePid(s, false))', 'sessions.filter(() => false)']],
      run: (mod) => W.quitLive(mod.PtyManager), dies: /QUIT STILL SWEEPS A LIVE ROOT ONCE/ },
    { file: PTYF, name: 'K6 a hold outvotes the exit report', edits: [["  if (state === 'exited') return false;\n  if (s.hold)", '  if (s.hold)']],
      run: (mod) => W.pin(mod.PtyManager, mod), dies: /A REPORTED EXIT WINS OVER A HOLD/ },
    { file: PTYF, name: "X2 (Jim) the fallback's repeat drops isAlive", edits: [["return repeat ? state === 'running' && isAlive(s.proc.pid) : true;", "return repeat ? state === 'running' : true;"]],
      run: (mod) => W.fallback(mod.PtyManager), dies: /WITHOUT A HOLD A SECOND SWEEP NEEDS SOMETHING ALIVE UNDER THE PID/ },
    { file: PTYF, name: 'H1 the exit releases the hold under a sweep still running', edits: [['if (!session.holdUsers) session.hold?.release();', 'session.hold?.release();']],
      run: (mod) => W.holdLife(mod.PtyManager), dies: /THE HOLD OUTLIVES THE SWEEP/ },
    { file: PTYF, name: 'H2 the last kill never releases the hold', edits: [['    if (s.holdUsers === 0) s.hold?.release();\n', '']],
      run: (mod) => W.holdLife(mod.PtyManager), dies: /THE HOLD IS RELEASED AFTER THE LAST KILL/ },
    { file: PTYF, name: 'H3 a root that exits on its own stays held', edits: [['        if (!session.holdUsers) session.hold?.release();\n', '']],
      run: (mod) => W.natural(mod.PtyManager), dies: /A ROOT THAT EXITED ON ITS OWN IS NOT HELD ANY LONGER/ },
    { file: PTYF, name: 'H4 the quit does not count itself as a user of the hold', edits: [['    for (const s of sessions) s.holdUsers = (s.holdUsers ?? 0) + 1;\n', '']],
      run: (mod) => W.quitLive(mod.PtyManager), dies: /THE HOLD OUTLIVES THE QUIT'S SWEEP/ },
    { file: PTYF, name: 'H5 kill() does not count itself as a user of the hold', edits: [['    s.holdUsers = (s.holdUsers ?? 0) + 1;\n    const close', '    const close']],
      run: (mod) => W.holdLife(mod.PtyManager), dies: /THE HOLD OUTLIVES THE SWEEP/ },
    { file: IDF, name: 'J1 (Jim) alive() after release() asks the addon', edits: [['      if (!open) return false;\n', '']],
      run: (mod) => W.released(mod), dies: /A RELEASED HOLD SAYS DEAD ON ITS OWN/ }
  );
}

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  for (const mu of MUTANTS) {
    await t.test(`mutant: ${mu.name}`, async () => {
      const mod = loadTs.fromText(mu.file, mutateText(mu.file, mu.edits, mu.name));
      await assert.rejects(() => mu.run(mod), (e) => {
        assert.match(String(e && e.message), mu.dies, `${mu.name}: died for the wrong reason: ${e && e.message}`);
        return true;
      }, `${mu.name}: MUST DIE`);
    });
  }
});
