'use strict';
/**
 * ELECTRON-RMSYNC-REAPER-108 census (god 315e29, bd022f): each mutant of the reaper's link-safe delete
 * in scripts/worktree-reaper.cjs must be killed by node --test test/worktree-reaper-link-safe.test.cjs,
 * at the tests named for it. The file is restored in a finally; a baseline run first must pass.
 *
 *   R1 the addon's removeTree -> a recursive rmSync
 *        must fail the Electron 'real' test, the Electron 'nested' test and the SOURCE pin, and the
 *        two Electron failures must themselves name the harm:
 *          'real'    at least one link target emptied ('live/top: 0 of 2 files left' or the same
 *                    for live/nested). Which one depends on where the recursive rm stops in that
 *                    fixture, so the rule is not tied to the walk order;
 *          'nested'  the nested junction's target emptied ('live/inner: 0 of 2 files left'). That
 *                    fixture has nothing that can stop the rm before the junction.
 *        The suite checks the targets first and names the files left; this runner only reads those
 *        failures. It builds no fixture and writes no file (Jim f18e1d).
 *   R2 the no-addon refusal in applyReap -> if (false)
 *        must fail both 'no-addon' tests (this process and Electron).
 *   R3 removeEntry judges the entry with stat, not lstat
 *        must fail the SOURCE pin.
 *
 * Usage: node test/tools/worktree-reaper-link-safe-mutants.cjs [--anchors-only]
 * Windows only (junctions), and it needs the installed Guppy as the suite does: without it the
 * Electron tests skip and the census stops as NO-RESULT, never a kill.
 */
const fs = require('node:fs');
const path = require('node:path');
const { recover, mutateFile, restoreFile, checkAnchors } = require('./mutant-runner-helper.cjs');
const { runTests, verdict, requireBaseline } = require('./mutant-tap.cjs');

const ROOT = path.join(__dirname, '..', '..');
const REAPER = 'scripts/worktree-reaper.cjs';
const UNIT = 'test/worktree-reaper-link-safe.test.cjs';

const REAL = "real: the reaped tree's links are removed as links, their targets survive";
const NESTED = 'nested: a junction in a subfolder of the reaped tree is removed as a link, its target survives';
const NO_ADDON = 'no-addon: the tree is refused and kept as it was, links and targets untouched';
const SOURCE = 'SOURCE: the reaper has no recursive rm, no rmSync and no tree walk of its own; a folder goes to the addon';
const HERE = ' (this process)';
const ELECTRON = ', in the installed Electron as Node';
const all = (...titles) => (failed) => titles.every((t) => failed.includes(t));
// What a suite failure prints about the files left in the link targets, and what it must say per case.
const LEFT = /live\/\w+: \d+ of \d+ files left(?:, live\/\w+: \d+ of \d+ files left)*/;
const R1_SAYS = [
  [REAL + ELECTRON, /live\/(?:top|nested): 0 of 2 files left/, "THE 'real' FAILURE NAMES NO EMPTIED TARGET"],
  [NESTED + ELECTRON, /live\/inner: 0 of 2 files left/, "THE 'nested' FAILURE DOES NOT NAME ITS TARGET EMPTIED"],
];

const M = [
  ['R1 the addon removeTree is a recursive rmSync', 'links += rm.removeTree(p);', 'links += ops.rmSync(p, { recursive: true, force: true });', all(REAL + ELECTRON, NESTED + ELECTRON, SOURCE), R1_SAYS],
  ['R2 a tree is not refused without the addon', "      if (!rm.removeTree) { results.push({ name: e.name, result: 'refused', error: `addon unavailable: ${rm.reason}` }); continue; }", '      if (false) { continue; }', all(NO_ADDON + HERE, NO_ADDON + ELECTRON), null],
  ['R3 removeEntry judges the entry with stat', '  const st = ops.lstatSync(p);', '  const st = ops.statSync(p);', all(SOURCE), null],
];

const lf = (s) => s.replace(/\r\n/g, '\n');
const f = path.join(ROOT, REAPER);
recover(ROOT);
if (process.argv.includes('--recover-only')) process.exit(0);
checkAnchors(ROOT, M.map(([name, from]) => ({ name, file: REAPER, from })));

/** One failing test's own TAP rows (its 'not ok' line and diagnostic block), by exact title; '' if it did not fail. */
function failureOf(res, title) {
  for (const block of res.failures.split(/^(?=not ok \d+ - )/m)) {
    const head = /^not ok \d+ - (.*)$/m.exec(block);
    if (head && head[1].replace(/\s+#\s.*$/, '').trim() === title) return block;
  }
  return '';
}

const guppy = require('./installed-guppy.cjs').installedGuppy();
const unit = () => runTests(ROOT, [UNIT], { timeout: 0 });
const orig = fs.readFileSync(f, 'utf8');
const base = requireBaseline(unit(), UNIT);
console.log(`baseline unit: exit ${base.status} (${base.pass} passing)`);
// A skipped Electron test proves nothing about Electron: the census needs the installed app.
if (guppy.skip) { fs.writeSync(1, `BASELINE NO-RESULT: the Electron tests skip (${guppy.skip}), so R1 and R2 prove nothing.\n`); process.exit(2); }

let killed = 0;
for (const [name, from, to, dies, says] of M) {
  try {
    let t = lf(orig).replace(from, () => to);
    if (orig.includes('\r\n')) t = t.replace(/\n/g, '\r\n');
    mutateFile(ROOT, f, orig, t);
    const r = unit();
    let v = verdict(r, dies); // NO-RESULT (the run never reported) is loud: neither a kill nor a survivor
    let extra = '';
    for (const [title, must, miss] of says || []) {
      const block = failureOf(r, title);
      const said = LEFT.exec(block);
      extra += `\n  ${title.split(':')[0]}${ELECTRON} says: ${said ? said[0] : 'nothing about the files left'}`;
      if (v === 'KILLED' && !must.test(block)) v = `KILLED, BUT ${miss}`;
    }
    if (v === 'KILLED') killed++;
    console.log(`${v} ${name}${v === 'NO-RESULT' && r.why ? ` (${r.why})` : ''}\n  failing: ${r.failed.length ? r.failed.join(' | ') : 'none'}${extra}`);
  } finally { restoreFile(ROOT, f, orig); }
}
console.log(`TOTAL ${killed}/${M.length}`);
process.exitCode = killed === M.length ? 0 : 1;
