'use strict';
/**
 * AGY-TEARDOWN (Oscar's finding, reproduced on 1.1.101 by Andy 2026-10-24): an explicit PTY kill
 * left a descendant that is not on the pseudo-console alive. On Windows kill() and killByOwner()
 * closed the ConPTY first, which ended the root, and the tree sweep ensureKilled ran 4 s later was
 * `taskkill /T` on a dead pid: it found nothing. agy's inner agy.exe runs on its own conhost, so it
 * lived on. Now the tree is swept while intact and the ConPTY closed after (killAllAsync's order).
 *
 * REAL processes, headless: a PtyManager PTY runs a node root that starts a DETACHED inner node
 * (no console, like agy's inner child: off the pseudo-console). The inner polls for a `go` file and
 * gives up after 60 s, so a failed run never leaks for long; the finally releases it either way.
 *
 * Named mutants, each must fail this file:
 *   M1 kill() closes the ConPTY before the sweep (the 1.1.101 order)
 *   M2 killByOwner() closes the ConPTY before the sweep (the 1.1.101 order)
 *   M3 no re-verify after the sweep: a failed first taskkill is not retried (Jim r1 MINOR 1)
 *   M4 the quit ignores trees still being swept: their close lands after it resolves (MINOR 2)
 *   M5 closePty has no once guard: the quit and the late close both close the ConPTY (MINOR 2)
 *   M6 closeTree never closes the ConPTY (Jim's X1): fails at the close count, never hangs (MINOR 3)
 *   X9 a settled close stays in closingTrees, so a later quit sweeps its (maybe reused) pid (Jim r2)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');
const { tempDir } = require('./tools/test-temp.cjs');

if (process.platform !== 'win32') {
  require('./tools/inert.cjs').announceInert('AGY-TEARDOWN tree sweep order', 'POSIX keeps SIGHUP plus the group sweep; the ConPTY order is Windows only');
  return;
}

const PTYF = 'src/main/pty.ts';
const { PtyManager } = loadTs(PTYF);
const DIR = tempDir('agyt-');
fs.writeFileSync(path.join(DIR, 'root.js'), [
  "const { spawn } = require('child_process'); const fs = require('fs'); const path = require('path');",
  'const dir = process.argv[2];',
  "const c = spawn(process.execPath, [path.join(__dirname, 'inner.js'), dir], { windowsHide: true, stdio: 'ignore', detached: true });",
  "fs.writeFileSync(path.join(dir, 'root.json'), JSON.stringify({ root: process.pid, inner: c.pid }));",
  'setInterval(() => {}, 1000);'
].join('\n'));
fs.writeFileSync(path.join(DIR, 'inner.js'), [
  "const fs = require('fs'); const path = require('path'); const dir = process.argv[2]; const t0 = Date.now();",
  "fs.writeFileSync(path.join(dir, 'inner.json'), JSON.stringify({ pid: process.pid }));",
  "setInterval(() => { if (fs.existsSync(path.join(dir, 'go')) || Date.now() - t0 > 60000) process.exit(0); }, 20);"
].join('\n'));

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Past ensureKilled's 4 s grace plus its taskkill: the old order never ends the inner at ANY time.
const DEADLINE_MS = 7_000;
let seq = 0;

// r2 seam: procKill's taskkill goes through child_process.spawn, read live at each call, so a test
// can make the FIRST taskkill fail (MINOR 1) or start late (MINOR 2). Every other spawn is real.
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');
const realSpawn = cp.spawn;
let firstTaskkill = null;   // (args) => fake child, used once
let taskkillArgs = null;    // when an array, every taskkill's args are recorded in it
cp.spawn = function spawn(cmd, args, ...rest) {
  if (cmd === 'taskkill' && taskkillArgs) taskkillArgs.push([...args]);
  if (cmd === 'taskkill' && firstTaskkill) {
    const f = firstTaskkill; firstTaskkill = null;
    return f(args, rest);
  }
  return realSpawn.call(this, cmd, args, ...rest);
};
/** A taskkill that fails to start (spawn ENOENT, Access denied, ...): kills nothing. */
const failingTaskkill = () => {
  const e = new EventEmitter();
  process.nextTick(() => e.emit('error', new Error('forced first-sweep failure')));
  return e;
};
/** The real taskkill, started `ms` late: a sweep still running when the quit comes. */
const slowTaskkill = (ms) => (args, rest) => {
  const e = new EventEmitter();
  setTimeout(() => { const c = realSpawn('taskkill', args, ...rest); c.once('close', (code) => e.emit('close', code)); c.once('error', (err) => e.emit('error', err)); }, ms);
  return e;
};

/** Spawn a root plus its off-console inner in a PTY, end it with `await end(m, id, owner)`, and
 *  return whether root and inner were gone within the deadline, plus how often the ConPTY was
 *  closed (proc.kill calls). The finally ends the root and the PTY whatever the outcome, so a
 *  mutant that never closes the ConPTY fails instead of hanging the runner (Jim MINOR 3). */
async function run(Pty, end, { after } = {}) {
  const dir = fs.mkdtempSync(path.join(DIR, 'run-'));
  const m = new Pty();
  const owner = { isDestroyed: () => false, send: () => {} };
  const id = `agyt-${++seq}`;
  let inner = 0;
  let root = 0;
  const closes = { n: 0 };
  let rawClose = null;
  try {
    const r = await m.spawn({ id, cwd: dir, command: process.execPath, args: [path.join(DIR, 'root.js'), dir], cols: 80, rows: 24, env: {} }, owner);
    assert.ok(r.ok, `spawn: ${r.error}`);
    for (let i = 0; i < 200 && !fs.existsSync(path.join(dir, 'inner.json')); i++) await sleep(25);
    inner = JSON.parse(fs.readFileSync(path.join(dir, 'inner.json'), 'utf8')).pid;
    root = JSON.parse(fs.readFileSync(path.join(dir, 'root.json'), 'utf8')).root;
    assert.equal(m.list()[0].pid, root, 'the node root is the PTY process');
    assert.ok(alive(inner), 'the inner child is running before the kill');
    const proc = m.sessions.get(id).proc;
    rawClose = proc.kill.bind(proc);
    proc.kill = (...a) => { closes.n += 1; return rawClose(...a); };
    const extra = await end(m, id, owner, closes);
    const t0 = Date.now();
    while ((alive(inner) || alive(root)) && Date.now() - t0 < DEADLINE_MS) await sleep(100);
    const out = { ...extra, innerGone: !alive(inner), rootGone: !alive(root) };
    if (after) Object.assign(out, await after(closes, out, m, root));
    return { ...out, closes: closes.n };
  } finally {
    firstTaskkill = null;
    taskkillArgs = null;
    fs.writeFileSync(path.join(dir, 'go'), '');   // release a leaked inner at once
    if (root && alive(root)) { try { process.kill(root); } catch { /* gone */ } }
    await m.killAllAsync(2_000).catch(() => {});
    // A mutant that drops the close everywhere (X1 under M4) would hold the ConPTY's pipes open.
    if (rawClose && closes.n === 0) { try { rawClose(); } catch { /* gone */ } }
    for (let i = 0; inner && i < 40 && alive(inner); i++) await sleep(25);
  }
}

/** Jim's X9: once a kill's close has run, the session leaves closingTrees, so a later quit sweeps
 *  nothing for it (its pid may already belong to another process). Settled = the close ran and
 *  the ConPTY's exit removed the session (killByOwner leaves that to onExit). Then records what a
 *  killAllAsync hands taskkill. The close count is taken BEFORE that quit, which would otherwise
 *  close a pending ConPTY itself and hide M6. */
const afterSettled = async (closes, _out, m, root) => {
  for (let i = 0; i < 120 && (closes.n === 0 || m.sessions.size > 0); i++) await sleep(25);
  const closesAtSettle = closes.n;
  const pendingAfterClose = m.closingTrees.size;
  taskkillArgs = [];
  await m.killAllAsync(2_000);
  const quitSwept = taskkillArgs.some((a) => a.includes(String(root)));
  taskkillArgs = null;
  return { closesAtSettle, pendingAfterClose, quitSwept };
};
const settledChecks = (r, who) => {
  assert.equal(r.pendingAfterClose, 0, `${who}: A SETTLED CLOSE LEAVES closingTrees: ${r.pendingAfterClose} session(s) still pending after the close ran`);
  assert.equal(r.quitSwept, false, `${who}: A LATER QUIT SWEEPS NO PID OF A SETTLED SESSION`);
};

const K = {};
K.kill = async (Pty) => {
  const r = await run(Pty, (m, id) => assert.equal(m.kill(id).ok, true), { after: afterSettled });
  assert.ok(r.rootGone, 'KILL: the PTY root is gone');
  assert.ok(r.innerGone, `KILL ENDS THE WHOLE TREE: a descendant off the pseudo-console is still alive ${DEADLINE_MS} ms after kill()`);
  assert.equal(r.closesAtSettle, 1, `KILL CLOSES THE CONPTY ONCE: closed ${r.closesAtSettle} times (the sweep alone ends the processes, not the pseudo-console)`);
  assert.equal(r.closes, 1, `KILL CLOSES THE CONPTY ONCE: closed ${r.closes} times (the sweep alone ends the processes, not the pseudo-console)`);
  settledChecks(r, 'KILL');
};
K.owner = async (Pty) => {
  const r = await run(Pty, (m, _id, owner) => m.killByOwner(owner), { after: afterSettled });
  assert.ok(r.rootGone, 'OWNER: the PTY root is gone');
  assert.ok(r.innerGone, `KILLBYOWNER ENDS THE WHOLE TREE: a descendant off the pseudo-console is still alive ${DEADLINE_MS} ms after killByOwner()`);
  assert.equal(r.closesAtSettle, 1, `KILLBYOWNER CLOSES THE CONPTY ONCE: closed ${r.closesAtSettle} times`);
  assert.equal(r.closes, 1, `KILLBYOWNER CLOSES THE CONPTY ONCE: closed ${r.closes} times`);
  settledChecks(r, 'KILLBYOWNER');
};

K.retry = async (Pty) => {
  const r = await run(Pty, (m, id) => { firstTaskkill = failingTaskkill; assert.equal(m.kill(id).ok, true); });
  assert.ok(r.rootGone, 'RETRY: the PTY root is gone');
  assert.ok(r.innerGone, `A FAILED FIRST SWEEP IS RETRIED: the first taskkill failed and a descendant off the pseudo-console is still alive ${DEADLINE_MS} ms after kill()`);
  assert.equal(r.closes, 1, `RETRY CLOSES THE CONPTY ONCE: closed ${r.closes} times`);
};
/** A quit (killAllAsync) while a kill's sweep is still running: the quit takes the close over (it
 *  has run when the quit resolves) and the kill's own late close then does nothing. */
const quitDuringSweep = (endOne) => async (Pty) => {
  const r = await run(Pty, async (m, id, owner, closes) => {
    firstTaskkill = slowTaskkill(1_500);
    endOne(m, id, owner);
    await m.killAllAsync(5_000);
    return { closesAtQuit: closes.n };
  }, { after: () => sleep(2_500) });   // past the slow sweep and its late close
  assert.equal(r.closesAtQuit, 1, `QUIT TAKES OVER A PENDING CLOSE: the ConPTY was closed ${r.closesAtQuit} times when killAllAsync resolved`);
  assert.equal(r.closes, 1, `NO DOUBLE CLOSE: the ConPTY was closed ${r.closes} times once the late sweep finished`);
  assert.ok(r.rootGone && r.innerGone, 'QUIT: the root and its descendant are gone');
};
K.quitKill = quitDuringSweep((m, id) => assert.equal(m.kill(id).ok, true));
K.quitOwner = quitDuringSweep((m, _id, owner) => m.killByOwner(owner));

test('kill(): an explicit kill ends the PTY root AND its descendant off the pseudo-console', () => K.kill(PtyManager));
test('killByOwner() (a floor window closing): ends the root AND its descendant off the pseudo-console', () => K.owner(PtyManager));
test('kill(): a first sweep that fails is re-verified and swept again before the close (Jim MINOR 1)', () => K.retry(PtyManager));
test('quit during a kill() sweep: killAllAsync closes that ConPTY itself, once (Jim MINOR 2)', () => K.quitKill(PtyManager));
test('quit during a killByOwner() sweep: one close, not two (Jim MINOR 2)', () => K.quitOwner(PtyManager));

// ─── MUTANT CENSUS ───────────────────────────────────────────────────────────────────────────

function mutateText(rel, edits, tag) {
  let text = readSource(rel);
  for (const [from, to] of edits) {
    const hits = text.split(from).length - 1;
    assert.equal(hits, 1, `mutant ${tag}: edit target must match EXACTLY ONCE, matched ${hits}: ${JSON.stringify(from.slice(0, 80))}`);
    text = text.replace(from, () => to);
  }
  return text;
}

// The 1.1.101 body of each kill site: close the ConPTY, then the late sweep of the (dead) root.
const OLD_ORDER = 'const pid = s.proc.pid; s.proc.kill(); ensureKilled(pid);';
const MUTANTS = [
  { name: 'M1 kill() closes the ConPTY before the sweep', edits: [['      this.closeTree(s);\n      // kill() deletes', `      ${OLD_ORDER}\n      // kill() deletes`]],
    killer: 'kill', dies: /KILL ENDS THE WHOLE TREE/ },
  { name: 'M2 killByOwner() closes the ConPTY before the sweep', edits: [['        try { this.closeTree(s); } catch', `        try { ${OLD_ORDER} } catch`]],
    killer: 'owner', dies: /KILLBYOWNER ENDS THE WHOLE TREE/ },
  { name: 'M3 no re-verify: one sweep, then the close', edits: [['.then(() => (isAlive(pid) ? killTreesAsync([pid]) : undefined)).then(close, close)', '.then(close, close)']],
    killer: 'retry', dies: /A FAILED FIRST SWEEP IS RETRIED/ },
  { name: 'M4 the quit ignores trees still being swept', edits: [['[...new Set([...this.sessions.values(), ...this.closingTrees])]', '[...this.sessions.values()]']],
    killer: 'quitKill', dies: /QUIT TAKES OVER A PENDING CLOSE/ },
  { name: 'M5 closePty closes every time it is reached', edits: [['    if (s.ptyClosed) return;\n', '']],
    killer: 'quitOwner', dies: /NO DOUBLE CLOSE/ },
  { name: "M6 closeTree never closes the ConPTY (Jim's X1): must fail, not hang", edits: [[': undefined)).then(close, close);', ': undefined)).then(() => {}, () => {});']],
    killer: 'kill', dies: /KILL CLOSES THE CONPTY ONCE/ },
  { name: "X9 a settled close stays in closingTrees (Jim's X9)", edits: [['const close = (): void => { this.closingTrees.delete(s); this.closePty(s); };', 'const close = (): void => { this.closePty(s); };']],
    killer: 'kill', dies: /A SETTLED CLOSE LEAVES closingTrees/ },
  { name: "X9 under killByOwner()", edits: [['const close = (): void => { this.closingTrees.delete(s); this.closePty(s); };', 'const close = (): void => { this.closePty(s); };']],
    killer: 'owner', dies: /A SETTLED CLOSE LEAVES closingTrees/ },
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  for (const m of MUTANTS) {
    await t.test(`mutant: ${m.name}`, async () => {
      const { PtyManager: P } = loadTs.fromText(PTYF, mutateText(PTYF, m.edits, m.name));
      await assert.rejects(() => K[m.killer](P), (e) => {
        assert.match(String(e && e.message), m.dies, `${m.name}: died for the wrong reason: ${e && e.message}`);
        return true;
      }, `${m.name}: MUST DIE`);
    });
  }
});
