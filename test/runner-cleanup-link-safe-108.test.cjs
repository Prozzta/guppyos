'use strict';
require('./tools/own-job.cjs');
// MUTANT-JOURNAL-GATE: this suite loads test/tools/run-tests.cjs, a file a census mutates in
// place; refuse a tree a killed census left mutated.
require('./tools/mutant-runner-helper.cjs').gate(__filename);

/**
 * RUNNER-REMOVEJAIL-FOLLOWS-JUNCTIONS-ELECTRON-108: the test runner removes two folders it made
 * itself when a run ends, the temp jail (every test file's temp folder is in it) and the start
 * gate. Both were a recursive fs.rmSync. Under Electron 45 that deletes THROUGH a Windows
 * junction (RUNTIME PIN, test/electron-rmsync-link-safe.test.cjs), so on the Electron leg a test
 * file that left a junction in its temp folder had the run's own cleanup empty the folder the
 * link points at. Plain Node removes the link only, so the defect shows in Electron alone.
 *
 * The same rmSync also cannot REMOVE a folder that holds a junction whose target it walked first:
 * it leaves the link, says nothing, and the folder stays (a real run root was left that way).
 *
 * Each run here is one run of the real runner whose file leaks, in the jail and in the gate, a
 * junction to a folder OUTSIDE them and junctions that stay inside
 * (runner-cleanup-link-safe-108-child.cjs). Every folder, the two victims too, is under one temp
 * folder this file makes. Two cells are read from each run:
 *   CELL 1  no victim outside the run folders is touched
 *   CELL 2  the jail and the gate folder are removed, junctions and all
 *
 * MUTANTS (the runner's line put back to a recursive rmSync; each dies in Electron as Node, in
 * both cells):
 *   M1 jail     removeJail's default                    -> the jail's victim is emptied, the jail stays
 *   M2 gate     the gate's remove in run()              -> the gate's victim is emptied, the gate stays
 *   M3 remover  removeRunDir itself                     -> both, for both
 *   M4 quiet    the gate's refusal is not said (by hand: drop the err call) -> the refusal test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const child = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runCase, MUTANTS, KEEP, KEEP_TEXT } = require('./runner-cleanup-link-safe-108-child.cjs');
const { rmTree } = require('./tools/rm-tree.cjs');
const R = require('./tools/run-tests.cjs');

const jail = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-cleanup-'));
// A cell that fails half way leaves junctions: the link-safe remover takes them as links.
test.after(() => rmTree(jail, { maxRetries: 5, retryDelay: 100 }));

const gone = (p) => !fs.lstatSync(p, { throwIfNoEntry: false });
/** The victims that lost their file, by name, sorted. */
const lost = (res) => Object.entries(res.victims)
  .filter(([, dir]) => !fs.existsSync(path.join(dir, KEEP)) || fs.readFileSync(path.join(dir, KEEP), 'utf8') !== KEEP_TEXT)
  .map(([name]) => name).sort();

/** The run folders that are still there, by name, sorted. */
const left = (res) => [['gate', res.gateDir], ['jail', res.jailRoot]].filter(([, dir]) => !gone(dir)).map(([name]) => name);

const INNER = ['b/lnk', 'to-sibling', 'to-self', 'to-dead'];
/** What every run shows, whatever its remove did: it made both folders and the links were planted in them. */
function ran(base, res) {
  assert.equal(res.planted.length, 2, 'the run got its jail and its gate, and a link to a victim was planted in each');
  assert.deepEqual(res.inner, { jail: INNER, gate: INNER }, 'and each got its inner links (target walked first, sibling, loop, dangling)');
  assert.ok(res.jailRoot.startsWith(path.join(base, 'tmp')) && res.gateDir.startsWith(path.join(base, 'tmp')), 'both folders are under this cell');
  assert.ok(res.errs.some((l) => l.startsWith('[test-runner] TEMP LEAK: ') && l.includes('leaked')), `THE LEAK IS NAMED: ${res.errs.join(' | ')}`);
  assert.equal(res.code, 1, 'a leak fails the run');
  assert.deepEqual(res.errs.filter((l) => l.includes('could not be removed')), [], 'no remove was refused');
}

/** The two cells of the fix: (1) no victim outside is touched, (2) both folders, junctions and all, are gone. */
function linkSafeAndRemoved(base, res) {
  ran(base, res);
  assert.deepEqual(lost(res), [], 'CELL 1: NO VICTIM OUTSIDE THE RUN FOLDERS IS TOUCHED');
  assert.deepEqual(left(res), [], 'CELL 2: THE JAIL AND THE GATE FOLDER, WHICH HOLD JUNCTIONS, ARE REMOVED');
  assert.deepEqual(fs.readdirSync(path.join(base, 'tmp')), [], 'nothing of the run is left');
}

// The runner jails LOCALAPPDATA; the shared helper finds the installed app read-only or gives a skip reason.
const guppy = require('./tools/installed-guppy.cjs').installedGuppy();
/** One case in the installed Guppy.exe as Node; what it returned. */
function inElectron(base, mutant = '') {
  assert.equal(fs.existsSync(guppy.exe), true, `installed Guppy executable missing: ${guppy.exe}`);
  const r = child.spawnSync(guppy.exe, [path.join(__dirname, 'runner-cleanup-link-safe-108-child.cjs'), base, mutant],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 60_000, windowsHide: true });
  assert.equal(r.status, 0, `child exit ${r.status}: ${r.stderr || r.stdout}`);
  const res = JSON.parse(r.stdout);
  assert.equal(res.ok, true, res.error);
  assert.match(String(res.out.electron), /^\d+\./, 'the child really ran in Electron');
  return res.out;
}

test('junctions leaked in the jail and in the gate are removed as links: both victims survive and both folders go (this process)', () => {
  const base = path.join(jail, 'clean-here');
  linkSafeAndRemoved(base, runCase(base));
});

test('the same in the installed Electron as Node: both victims survive and both folders go', { skip: guppy.skip }, () => {
  const base = path.join(jail, 'clean-electron');
  linkSafeAndRemoved(base, inElectron(base));
});

const DIES = { 'M1 jail': ['jail'], 'M2 gate': ['gate'], 'M3 remover': ['gate', 'jail'] };
assert.deepEqual(Object.keys(DIES), Object.keys(MUTANTS));
for (const [i, name] of Object.keys(MUTANTS).entries()) {
  test(`MUTANT ${name}: with the old recursive rmSync, Electron as Node empties the victim of ${DIES[name].join(' and ')} and leaves the folder`, { skip: guppy.skip }, () => {
    const base = path.join(jail, `mutant-${i + 1}`);
    const res = inElectron(base, name);
    ran(base, res); // the run is the same, and the old remove says nothing; the victims and the folders tell
    assert.deepEqual({ lost: lost(res), left: left(res) }, { lost: DIES[name], left: DIES[name] },
      'the old remove went through the link (cell 1) and could not remove a folder that holds junctions (cell 2); if not, this test proves nothing: see the RUNTIME PIN');
  });
}

test('a gate folder that cannot be removed is said, not swallowed; the jail is still removed', () => {
  const base = path.join(jail, 'refused');
  fs.mkdirSync(path.join(base, 'tmp'), { recursive: true });
  // The remover refuses a plain file where the folder should be (rm-tree.cjs: EREFUSED).
  const notAFolder = path.join(base, 'gate-is-a-file');
  fs.writeFileSync(notAFolder, 'x');
  const errs = [];
  let root;
  const code = R.run({
    testDir: 'test', readdir: () => ['a.test.cjs'], spawn: () => ({ status: 0 }),
    tempJail: () => { const j = R.prepareTempJail({ dir: path.join(base, 'tmp') }); root = j.root; return j; },
    startGate: () => ({ slots: 2, dir: notAFolder }),
    log: () => {}, err: (l) => errs.push(l), timeoutMs: 5000, eventsFile: path.join(base, 'ev'), readFile: () => '', removeFile: () => {},
    watchdog: () => ({ stop: () => {} }), fileJob: () => ({ exe: null, why: null }), cpuMask: () => null
  });
  assert.equal(code, 0);
  assert.deepEqual(errs.filter((l) => l.includes('could not be removed')),
    [`[test-runner] the run's start-gate folder could not be removed (EREFUSED): ${notAFolder}`], 'THE REFUSAL IS SAID');
  assert.equal(fs.readFileSync(notAFolder, 'utf8'), 'x', 'and what was refused is kept');
  assert.equal(gone(root), true, 'THE JAIL IS REMOVED ALL THE SAME');
});
