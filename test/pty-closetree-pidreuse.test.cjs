'use strict';
require('./tools/own-job.cjs');
/**
 * PTY-CLOSETREE-PIDREUSE: closeTree named the root by pid for a SECOND `taskkill /T /F` whenever
 * "something is alive under that pid" after the first. The first sweep normally ends the root, and
 * Windows hands a dead process's pid to the next process created (147 ms seen on this machine), so
 * that second sweep could end an unrelated process and its whole tree.
 *
 * The sweep now runs only while node-pty, which holds the root's process HANDLE until it exits,
 * has not reported that exit (rootState in src/main/pty.ts).
 *
 * NO taskkill in this file is real: each one is recorded and answered by the scenario. The reused
 * pid is modelled where the product looks for it: the liveness probe (`process.kill(pid, 0)`)
 * answers "alive" for the root's old pid once the root is gone, which is exactly what the product
 * sees when a stranger has taken the number. No stranger exists, so nothing can be hit if the
 * guard fails.
 *
 * Mutants (each must die at the assertion that names its guarantee):
 *   P1 the second sweep trusts the pid alone (the code before this card)
 *   P2 the second sweep runs when the root's state is unknown
 *   P3 a root that already exited is swept anyway
 *   P4 rootState reads the exit report backwards
 *   P5 rootState trusts an agent that is not the ConPTY one
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');
const { tempDir } = require('./tools/test-temp.cjs');

if (process.platform !== 'win32') {
  require('./tools/inert.cjs').announceInert('PTY-CLOSETREE-PIDREUSE', 'the pid-named tree sweep (taskkill) and the ConPTY exit report are Windows only');
  return;
}

const PTYF = 'src/main/pty.ts';
const REAL = loadTs(PTYF);
const DIR = tempDir('ptpr-');
fs.writeFileSync(path.join(DIR, 'root.js'), "process.stdout.write('ptpr-root-up'); setInterval(() => {}, 1000);\n");

// Every taskkill is answered here. `answers` is consumed one per sweep; with none left the sweep
// "finishes" having ended nothing.
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
const realSpawn = cp.spawn;
const sweeps = [];     // the args of every taskkill
let answers = [];      // (emitter) => void, one per sweep
cp.spawn = function spawn(cmd, args, ...rest) {
  if (cmd !== 'taskkill') return realSpawn.call(this, cmd, args, ...rest);
  sweeps.push([...args]);
  const e = new EventEmitter();
  const answer = answers.shift() || ((em) => process.nextTick(() => em.emit('close', 0)));
  answer(e);
  return e;
};
const sweepsOf = (pid) => sweeps.filter((a) => a.includes(String(pid))).length;

// The liveness probe of a pid in `reused` says "alive": a stranger has the number now.
const reused = new Set();
const realKill = process.kill;
process.kill = function kill(pid, signal) {
  if (signal === 0 && reused.has(pid)) return true;
  return realKill.call(process, pid, signal);
};

const CAP_MS = 20_000;   // a failure bound for an event that never comes; no scenario waits it out
const within = (p, what) => {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`TIMED OUT waiting for ${what}`)), CAP_MS); })]).finally(() => clearTimeout(t));
};
let seq = 0;

/** A real terminal whose root idles. Gives the scenario its manager, id, root pid, the promise of
 *  node-pty's exit REPORT (the moment the product can know the root is gone) and of the ConPTY
 *  close; ends everything afterwards whatever happened. */
async function withTerminal(Pty, scenario) {
  const m = new Pty();
  const owner = { isDestroyed: () => false, send: () => {} };
  const id = `ptpr-${++seq}`;
  sweeps.length = 0; answers = [];
  let rawClose = null;
  let closes = 0;
  let root = 0;
  try {
    const r = await m.spawn({ id, cwd: DIR, command: process.execPath, args: [path.join(DIR, 'root.js')], cols: 80, rows: 24, env: {} }, owner);
    assert.ok(r.ok, `spawn: ${r.error}`);
    const proc = m.sessions.get(id).proc;
    root = proc.pid;
    // The scenario starts once the root has spoken. A ConPTY closed in its first milliseconds can
    // still deliver its start-up output after node-pty has ended the socket ("stream.push() after
    // EOF", thrown outside any test). That is node-pty's, and not what this file is about.
    let seen = '';
    await within(new Promise((resolve) => { const sub = proc.onData((d) => { seen += d; if (seen.includes('ptpr-root-up')) { sub.dispose(); resolve(); } }); }), "the root's first output");
    let onReport = null;
    const reported = new Promise((resolve) => { onReport = resolve; });
    const agent = proc._agent;
    const report = agent._$onProcessExit;
    const hooks = [];
    agent._$onProcessExit = function onProcessExit(code) {
      const out = report.call(this, code);
      for (const h of hooks) h();   // in the same turn as the report, before anything else can run
      onReport();
      return out;
    };
    let onClose = null;
    const closed = new Promise((resolve) => { onClose = resolve; });
    rawClose = proc.kill.bind(proc);
    proc.kill = (...a) => { closes += 1; onClose(); return rawClose(...a); };
    /** End the root for real. It is running, so node-pty holds its handle and the pid is its own. */
    const endRoot = () => { assert.equal(REAL.rootState(proc), 'running', 'the root is running when the scenario ends it'); realKill.call(process, root); };
    return await scenario({ m, id, root, proc, reported, closed, endRoot, atReport: (h) => hooks.push(h), closes: () => closes });
  } finally {
    reused.delete(root);
    answers = [];
    await m.killAllAsync(2_000).catch(() => {});
    if (rawClose && closes === 0) { try { rawClose(); } catch { /* gone */ } }
  }
}

const K = {
  /** THE CARD. The first sweep ends the root; by the time it finishes, the exit is reported and
   *  another process is alive under the root's old pid. */
  reuse: (Pty) => withTerminal(Pty, async ({ m, id, root, reported, closed, endRoot }) => {
    answers = [(e) => { endRoot(); void reported.then(() => { reused.add(root); e.emit('close', 0); }); }];
    assert.ok(m.kill(id).ok, 'kill()');
    await within(closed, 'the ConPTY close after the sweep');
    assert.equal(sweepsOf(root), 1, `A SWEEP NEVER NAMES A PID THE ROOT NO LONGER OWNS: the root had exited and another process was alive under pid ${root}, and taskkill /T /F was pointed at it (${sweepsOf(root)} sweeps)`);
  }),
  /** The reason the second sweep exists (Jim MINOR 1) still holds: the first sweep ended nothing. */
  survivor: (Pty) => withTerminal(Pty, async ({ m, id, root, closed }) => {
    assert.ok(m.kill(id).ok, 'kill()');
    await within(closed, 'the ConPTY close after the sweeps');
    assert.equal(sweepsOf(root), 2, `A ROOT THAT SURVIVED THE FIRST SWEEP IS SWEPT AGAIN: ${sweepsOf(root)} sweep(s) of a root that is still running`);
  }),
  /** The root died on its own; kill() arrives in the same turn as the exit report, before node-pty's
   *  delayed 'exit' event has removed the session. Its pid is free for anyone. */
  exited: (Pty) => withTerminal(Pty, async ({ m, id, root, reported, closed, endRoot, atReport, closes }) => {
    let killed = null;
    atReport(() => { reused.add(root); killed = m.kill(id); });
    endRoot();
    await within(reported, "node-pty's exit report");
    assert.ok(killed && killed.ok, `kill() of a session whose root just exited: ${killed && killed.error}`);
    await within(closed, 'the ConPTY close');
    assert.equal(sweepsOf(root), 0, `A ROOT THAT ALREADY EXITED IS NOT SWEPT: its pid ${root} was free for any process, and taskkill /T /F was pointed at it`);
    assert.equal(closes(), 1, 'THE CONPTY IS STILL CLOSED ONCE when the sweep is skipped');
    assert.equal(m.closingTrees.size, 0, 'nothing is left waiting on a sweep that never ran');
  }),
  /** A terminal object that is not node-pty's ConPTY one: nothing binds its pid to its root. The
   *  first sweep is the kill itself and stays; a second one would rest on the pid alone. */
  unknown: async (Pty) => {
    const m = new Pty();
    sweeps.length = 0; answers = [];
    let closes = 0;
    let onClose = null;
    const closed = new Promise((resolve) => { onClose = resolve; });
    // This process's own pid: alive throughout and never reusable. No taskkill here is real.
    m.sessions.set('ptpr-unknown', { proc: { pid: process.pid, kill: () => { closes += 1; onClose(); } }, owner: null });
    assert.ok(m.kill('ptpr-unknown').ok, 'kill()');
    await within(closed, 'the close after the sweep');
    assert.equal(sweepsOf(process.pid), 1, `NO SECOND SWEEP WITHOUT PROOF THE PID IS THE ROOT'S: ${sweepsOf(process.pid)} sweeps of a pid whose owner is unknown`);
    assert.equal(closes, 1, 'closed once');
  },
  /** rootState against the real node-pty, and against shapes it must not trust. */
  pin: (Pty, mod) => withTerminal(Pty, async ({ proc, reported, endRoot }) => {
    const { rootState } = mod;
    assert.equal(rootState(proc), 'running', "ROOT STATE PIN: a live ConPTY terminal reads 'running' (node-pty's agent no longer has _useConpty / _exitCode / _$onProcessExit as pinned?)");
    assert.equal(rootState({}), 'unknown', 'ROOT STATE PIN: no agent is unknown');
    assert.equal(rootState({ _agent: { _useConpty: false, _$onProcessExit() {} } }), 'unknown', 'ROOT STATE PIN: a winpty agent never receives the exit report, so it is unknown, not running');
    assert.equal(rootState({ _agent: { _useConpty: true } }), 'unknown', 'ROOT STATE PIN: an agent without the exit report hook is unknown');
    endRoot();
    await within(reported, "node-pty's exit report");
    assert.equal(rootState(proc), 'exited', "ROOT STATE PIN: once node-pty reports the exit the terminal reads 'exited'");
  })
};

test('REUSED PID: after the first sweep ends the root, a process alive under its old pid is never swept', () => K.reuse(REAL.PtyManager));
test('a root still running after the first sweep is swept once more before the close', () => K.survivor(REAL.PtyManager));
test('a root that exited on its own is not swept at all, and its ConPTY is still closed once', () => K.exited(REAL.PtyManager));
test('a terminal whose root cannot be told from its pid gets the one sweep and no second', () => K.unknown(REAL.PtyManager));
test("rootState follows node-pty's exit report and trusts only the ConPTY agent", () => K.pin(REAL.PtyManager, REAL));

function mutateText(rel, edits, tag) {
  let text = readSource(rel);
  for (const [from, to] of edits) {
    const hits = text.split(from).length - 1;
    assert.equal(hits, 1, `mutant ${tag}: edit target must match EXACTLY ONCE, matched ${hits}: ${JSON.stringify(from.slice(0, 80))}`);
    text = text.replace(from, () => to);
  }
  return text;
}

const SECOND = "(rootState(s.proc) === 'running' && isAlive(pid) ? killTreesAsync([pid]) : undefined)";
const MUTANTS = [
  { name: 'P1 the second sweep trusts the pid alone (the code before this card)', edits: [[SECOND, '(isAlive(pid) ? killTreesAsync([pid]) : undefined)']],
    killer: 'reuse', dies: /A SWEEP NEVER NAMES A PID THE ROOT NO LONGER OWNS/ },
  { name: 'P2 the second sweep runs when the root state is unknown', edits: [[SECOND, "(rootState(s.proc) !== 'exited' && isAlive(pid) ? killTreesAsync([pid]) : undefined)"]],
    killer: 'unknown', dies: /NO SECOND SWEEP WITHOUT PROOF/ },
  { name: 'P3 a root that already exited is swept anyway', edits: [["    if (rootState(s.proc) === 'exited') { close(); return; }\n", '']],
    killer: 'exited', dies: /A ROOT THAT ALREADY EXITED IS NOT SWEPT/ },
  { name: 'P4 rootState reads the exit report backwards', edits: [["return agent._exitCode === undefined ? 'running' : 'exited';", "return agent._exitCode === undefined ? 'exited' : 'running';"]],
    killer: 'pin', dies: /ROOT STATE PIN: a live ConPTY terminal/ },
  { name: 'P5 rootState trusts an agent that is not the ConPTY one', edits: [['agent._useConpty !== true || ', '']],
    killer: 'pin', dies: /ROOT STATE PIN: a winpty agent/ }
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  for (const mu of MUTANTS) {
    await t.test(`mutant: ${mu.name}`, async () => {
      const mod = loadTs.fromText(PTYF, mutateText(PTYF, mu.edits, mu.name));
      await assert.rejects(() => K[mu.killer](mod.PtyManager, mod), (e) => {
        assert.match(String(e && e.message), mu.dies, `${mu.name}: died for the wrong reason: ${e && e.message}`);
        return true;
      }, `${mu.name}: MUST DIE`);
    });
  }
});
