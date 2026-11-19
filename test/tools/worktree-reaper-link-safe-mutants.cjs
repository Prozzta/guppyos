'use strict';
/**
 * ELECTRON-RMSYNC-REAPER-108 census (god 315e29): each mutant of the reaper's link-safe delete in
 * scripts/worktree-reaper.cjs must be killed by node --test test/worktree-reaper-link-safe.test.cjs,
 * at the tests named for it. The file is restored in a finally; a baseline run first must pass.
 *
 *   R1 the addon's removeTree -> a recursive rmSync
 *        must fail the Electron 'real' test and the SOURCE pin. The suite's first failing assertion
 *        does not show what was lost, so R1 is also PROBED: one fixture (a tree holding a junction at
 *        its top and one nested, each to a folder of two files outside it) is reaped by the mutated
 *        script in the installed Guppy.exe as Node, and both folders must come back EMPTIED. The same
 *        probe on the script as it is must leave both whole (a baseline, checked first).
 *   R2 the no-addon refusal in applyReap -> if (false)
 *        must fail both 'no-addon' tests (this process and Electron).
 *   R3 removeEntry judges the entry with stat, not lstat
 *        must fail the SOURCE pin.
 *
 * Usage: node test/tools/worktree-reaper-link-safe-mutants.cjs [--anchors-only]
 * Windows only (junctions), and it needs the installed Guppy as the suite does: without it the
 * Electron tests skip and R1 and R2 are reported NO-RESULT, never a kill.
 */
const child = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { recover, mutateFile, restoreFile, checkAnchors } = require('./mutant-runner-helper.cjs');
const { runTests, verdict, requireBaseline } = require('./mutant-tap.cjs');

const ROOT = path.join(__dirname, '..', '..');
const REAPER = 'scripts/worktree-reaper.cjs';
const UNIT = 'test/worktree-reaper-link-safe.test.cjs';
const CHILD = path.join(__dirname, '..', 'worktree-reaper-link-safe-child.cjs');

const REAL = "real: the reaped tree's links are removed as links, their targets survive";
const NO_ADDON = 'no-addon: the tree is refused and kept as it was, links and targets untouched';
const SOURCE = 'SOURCE: the reaper has no recursive rm, no rmSync and no tree walk of its own; a folder goes to the addon';
const HERE = ' (this process)';
const ELECTRON = ', in the installed Electron as Node';
const all = (...titles) => (failed) => titles.every((t) => failed.includes(t));

const M = [
  ['R1 the addon removeTree is a recursive rmSync', 'links += rm.removeTree(p);', 'links += ops.rmSync(p, { recursive: true, force: true });', all(REAL + ELECTRON, SOURCE), true],
  ['R2 a tree is not refused without the addon', "      if (!rm.removeTree) { results.push({ name: e.name, result: 'refused', error: `addon unavailable: ${rm.reason}` }); continue; }", '      if (false) { continue; }', all(NO_ADDON + HERE, NO_ADDON + ELECTRON), false],
  ['R3 removeEntry judges the entry with stat', '  const st = ops.lstatSync(p);', '  const st = ops.statSync(p);', all(SOURCE), false],
];

const lf = (s) => s.replace(/\r\n/g, '\n');
const f = path.join(ROOT, REAPER);
recover(ROOT);
if (process.argv.includes('--recover-only')) process.exit(0);
checkAnchors(ROOT, M.map(([name, from]) => ({ name, file: REAPER, from })));

const VICTIMS = ['top', 'nested'];
const VICTIM_FILES = ['precious.txt', 'sub/b.txt'];
const guppy = require('./installed-guppy.cjs').installedGuppy();

/**
 * Reap one fixture with the reaper as it is on disk now, in the installed Guppy.exe as Node, and
 * count the files left in each folder a junction pointed at. Everything is under one fresh temp
 * folder, which is removed link by link afterwards. Returns { left: { top, nested }, out } or { why }.
 */
function probe() {
  if (guppy.skip) return { why: guppy.skip };
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reaper-mutant-probe-'));
  const tree = path.join(base, 'work', 'old-tree');
  const links = [path.join(tree, 'node_modules'), path.join(tree, 'src', 'deep', 'assets')];
  try {
    VICTIMS.forEach((name, i) => {
      const d = path.join(base, 'live', name);
      fs.mkdirSync(path.join(d, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(d, 'precious.txt'), `live ${name}`); fs.writeFileSync(path.join(d, 'sub', 'b.txt'), 'b');
      fs.mkdirSync(path.dirname(links[i]), { recursive: true });
      fs.symlinkSync(d, links[i], 'junction');
    });
    fs.writeFileSync(path.join(tree, 'a.txt'), 'a');
    const r = child.spawnSync(guppy.exe, [CHILD, 'real', base], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 60_000, windowsHide: true });
    if (r.status !== 0) return { why: `probe child exit ${r.status}: ${String(r.stderr || r.stdout || r.error).trim().slice(0, 300)}` };
    const left = {};
    for (const name of VICTIMS) left[name] = VICTIM_FILES.filter((rel) => fs.existsSync(path.join(base, 'live', name, rel))).length;
    return { left, out: String(r.stdout).trim().slice(0, 300) };
  } finally {
    // Links first, each as a link, wherever the reap left the tree (in place or as a tombstone).
    const work = path.join(base, 'work');
    for (const top of fs.existsSync(work) ? fs.readdirSync(work) : []) {
      for (const rel of [['node_modules'], ['src', 'deep', 'assets']]) {
        const p = path.join(work, top, ...rel);
        let st = null; try { st = fs.lstatSync(p); } catch { /* gone */ }
        if (st && st.isSymbolicLink()) { try { fs.rmdirSync(p); } catch { fs.unlinkSync(p); } }
      }
    }
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
const probeLine = (p) => (p.why ? `no result (${p.why})` : VICTIMS.map((n) => `live/${n} ${p.left[n]} of ${VICTIM_FILES.length} files left`).join(', '));

const unit = () => runTests(ROOT, [UNIT], { timeout: 0 });
const orig = fs.readFileSync(f, 'utf8');
const base = requireBaseline(unit(), UNIT);
console.log(`baseline unit: exit ${base.status} (${base.pass} passing)`);
const stop = (line) => { fs.writeSync(1, `${line}\n`); process.exit(2); };
// A skipped Electron test proves nothing about Electron: the census needs the installed app.
if (guppy.skip) stop(`BASELINE NO-RESULT: the Electron tests skip (${guppy.skip}), so R1 and R2 prove nothing.`);
const whole = probe();
console.log(`baseline probe: ${probeLine(whole)}`);
if (whole.why || VICTIMS.some((n) => whole.left[n] !== VICTIM_FILES.length)) stop('BASELINE RED: the probe loses a file with the reaper as it is, so R1 proves nothing.');

let killed = 0;
for (const [name, from, to, dies, probed] of M) {
  try {
    let t = lf(orig).replace(from, () => to);
    if (orig.includes('\r\n')) t = t.replace(/\n/g, '\r\n');
    mutateFile(ROOT, f, orig, t);
    const r = unit();
    let v = verdict(r, dies); // NO-RESULT (the run never reported) is loud: neither a kill nor a survivor
    let extra = '';
    if (probed) {
      const p = probe();
      extra = `\n  probe: ${probeLine(p)}`;
      if (p.why) v = 'NO-RESULT';
      else if (v === 'KILLED' && VICTIMS.some((n) => p.left[n] !== 0)) v = 'KILLED, BUT THE PROBE KEPT A FILE';
    }
    if (v === 'KILLED') killed++;
    console.log(`${v} ${name}${v === 'NO-RESULT' && r.why ? ` (${r.why})` : ''}\n  failing: ${r.failed.length ? r.failed.join(' | ') : 'none'}${extra}`);
  } finally { restoreFile(ROOT, f, orig); }
}
console.log(`TOTAL ${killed}/${M.length}`);
process.exitCode = killed === M.length ? 0 : 1;
