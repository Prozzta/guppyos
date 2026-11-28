'use strict';
/**
 * RUNNER-REMOVEJAIL-FOLLOWS-JUNCTIONS-ELECTRON-108: one run of the real runner (run-tests.cjs
 * run()) whose only "test file" leaks a junction in each folder the run makes and removes itself:
 *
 *   <base>/tmp/run-tests-temp-*   the temp jail   <pid>-<id>/leaked/link -> <base>/victim-jail
 *   <base>/tmp/run-tests-start-*  the start gate  claim-1/link           -> <base>/victim-gate
 *
 * Each of the two also gets links that stay inside it (plantInner: a link whose target is walked
 * first, and a sibling, a loop and a dangling one): the run must still REMOVE a folder that holds
 * junctions.
 *
 * Both victims are OUTSIDE the two folders, and everything is under <base>, a temp folder the
 * caller made. The spawn is a fake (it plants the links where a leaking test file would and
 * starts nothing); the jail, the gate and the cleanup are the runner's own.
 *
 * It runs in this process and, as a script, in Electron as Node:
 *   <exe> runner-cleanup-link-safe-108-child.cjs <base> [mutant]   -> one JSON line
 *
 * A mutant is the runner's source with one line put back to a recursive rmSync, compiled in
 * memory under the runner's own path. No file in the tree is written.
 */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const RUNNER = path.join(__dirname, 'tools', 'run-tests.cjs');
const OLD_RM = '{ recursive: true, force: true }';
/** name -> [the line as it is, the line with the old remove]. Each must match exactly once. */
const MUTANTS = {
  'M1 jail': ['  removeJail = removeRunDir,', `  removeJail = (root) => fs.rmSync(root, ${OLD_RM}),`],
  'M2 gate': ['    if (gate) { try { removeRunDir(gate.dir); }', `    if (gate) { try { fs.rmSync(gate.dir, ${OLD_RM}); }`],
  'M3 remover': ["  require('./rm-tree.cjs').rmTree(dir);", `  fs.rmSync(dir, ${OLD_RM});`]
};

function loadRunner(mutant) {
  if (!mutant) return require(RUNNER);
  if (!MUTANTS[mutant]) throw new Error(`no such mutant: ${mutant}`);
  const [from, to] = MUTANTS[mutant];
  const src = fs.readFileSync(RUNNER, 'utf8');
  const n = src.split(from).length - 1;
  if (n !== 1) throw new Error(`mutant ${mutant}: its line is in run-tests.cjs ${n} times, not once`);
  const m = new Module(RUNNER, module);
  m.filename = RUNNER;
  m.paths = Module._nodeModulePaths(path.dirname(RUNNER));
  m._compile(src.replace(from, () => to), RUNNER);
  return m.exports;
}

const KEEP = 'keep.txt';
const KEEP_TEXT = 'a file outside the run folders';

/** Build the fixture under `base` (which must not exist yet), run the runner once, say what it did. */
function runCase(base, mutant = '') {
  const R = loadRunner(mutant);
  const tmp = path.join(base, 'tmp');
  const victims = { jail: path.join(base, 'victim-jail'), gate: path.join(base, 'victim-gate') };
  fs.mkdirSync(tmp, { recursive: true });
  for (const v of Object.values(victims)) { fs.mkdirSync(v); fs.writeFileSync(path.join(v, KEEP), KEEP_TEXT); }

  const made = { jailRoot: null, gateDir: null };
  const planted = [];
  const inner = {};
  // Links that stay INSIDE a run folder (a real leaked root had 43 of them and Electron's rmSync
  // could not remove it). The one that counts is b/lnk -> a/tgt: its target is walked, and so
  // removed, BEFORE the link, and Electron 45's recursive rmSync then leaves the link behind,
  // says nothing, and the root stays. With it: a link to a sibling folder, a link to the folder
  // it is in (a loop), and a link whose target is gone by cleanup (dangling).
  const plantInner = (name, own) => {
    const real = path.join(own, 'real');
    const dead = path.join(own, 'dead');
    const tgt = path.join(own, 'a', 'tgt');
    fs.mkdirSync(real, { recursive: true });
    fs.mkdirSync(dead);
    fs.mkdirSync(tgt, { recursive: true });
    fs.mkdirSync(path.join(own, 'b'));
    fs.writeFileSync(path.join(real, 'f.txt'), 'x');
    fs.writeFileSync(path.join(tgt, 'f.txt'), 'x');
    fs.symlinkSync(tgt, path.join(own, 'b', 'lnk'), 'junction');
    fs.symlinkSync(real, path.join(own, 'to-sibling'), 'junction');
    fs.symlinkSync(own, path.join(own, 'to-self'), 'junction');
    fs.symlinkSync(dead, path.join(own, 'to-dead'), 'junction');
    fs.rmdirSync(dead);
    inner[name] = ['b/lnk', 'to-sibling', 'to-self', 'to-dead'];
  };
  const plant =(dir, victim) => {
    fs.mkdirSync(dir, { recursive: true });
    const at = path.join(dir, 'link');
    fs.symlinkSync(victim, at, 'junction');
    // The link works: the victim's file is read through it.
    if (fs.readFileSync(path.join(at, KEEP), 'utf8') !== KEEP_TEXT) throw new Error(`the planted link does not reach ${victim}`);
    planted.push(at);
  };
  const errs = [];
  const code = R.run({
    testDir: 'test',
    readdir: () => ['a.test.cjs'],
    tempJail: () => { const j = R.prepareTempJail({ dir: tmp }); made.jailRoot = j.root; return j; },
    startGate: () => { const g = R.prepareStartGate({ dir: tmp, slots: 2 }); made.gateDir = g.dir; return g; },
    spawn: (args, opts) => {
      if (!planted.length) {
        // As temp-jail-preload.cjs names a file's folder (<pid>-<id>), and file-start-gate.cjs a claim.
        plant(path.join(opts.env.GUPPY_TEMP_JAIL, '4242-leak', 'leaked'), victims.jail);
        plant(path.join(String(opts.env.GUPPY_START_GATE).split('|')[1], 'claim-1'), victims.gate);
        plantInner('jail', path.join(opts.env.GUPPY_TEMP_JAIL, '4243-inner'));
        plantInner('gate', path.join(String(opts.env.GUPPY_START_GATE).split('|')[1], 'claim-2'));
      }
      return { status: 0 };
    },
    log: () => {},
    err: (l) => errs.push(l),
    timeoutMs: 5000,
    eventsFile: path.join(base, 'ev'),
    readFile: (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } },
    removeFile: () => {},
    watchdog: () => ({ stop: () => {} }),
    fileJob: () => ({ exe: null, why: null }),
    cpuMask: () => null
  });
  return { code, errs, planted, inner, ...made, victims, electron: process.versions.electron || null, node: process.versions.node };
}

module.exports = { runCase, MUTANTS, KEEP, KEEP_TEXT };

if (require.main === module) {
  let res;
  try { res = { ok: true, out: runCase(process.argv[2], process.argv[3] || '') }; }
  catch (e) { res = { ok: false, error: String((e && e.stack) || e) }; }
  process.stdout.write(`${JSON.stringify(res)}\n`);
}
