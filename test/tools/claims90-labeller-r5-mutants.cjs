'use strict';
/**
 * CLAIMS-90 labeller R5 census (god 3ba8b6): each mutant of the session-folder guard must be killed by
 * node --test test/claims-90-labeller.test.cjs. The file is restored in a finally; a baseline run first
 * must pass. Usage: node test/tools/claims90-labeller-r5-mutants.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { recover, mutateFile, restoreFile, checkAnchors } = require('./mutant-runner-helper.cjs');

const ROOT = path.join(__dirname, '..', '..');
const LAB = 'test/claims-90/labeller.cjs';
const M = [
  ['L1 the session folder is copied but not deleted', "        fs.rmSync(src, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });\n        session = { folder, created: true,", '        session = { folder, created: true,'],
  ['L2 the leftover check sees nothing', '  const leftovers = names.filter((n) => n.startsWith(leftoverPrefix(out))).sort();', '  const leftovers = [];'],
  ['L3 a session folder problem is not INVALID', '    if (s.problem) reason = ', '    if (false) reason = '],
  ['L4 the session folder is never moved out', "    const s = sessionOut(path.dirname(G.ownOutputsDir(jail)), jail, path.join(runDir, 'session'), o.out);", '    const s = { session: null, leftovers: [], problem: null };'],
  ['L5 a folder holding a link is copied and deleted', '    else if (fs.lstatSync(src).isSymbolicLink() || R.linksUnder(src).length) session = ', '    else if (false) session = '],
  ['L6 another labeller\'s jails are judged', 'const leftoverPrefix = (out) => `${G.projectSlug(path.resolve(out))}-jail-`;', 'const leftoverPrefix = (out) => `${G.projectSlug(path.dirname(path.resolve(out)))}-`;'],
];

const unit = () => spawnSync(process.execPath, ['--test', 'test/claims-90-labeller.test.cjs'], { cwd: ROOT, encoding: 'utf8', env: process.env }).status;
const lf = (s) => s.replace(/\r\n/g, '\n');
const f = path.join(ROOT, LAB);
// INT 1.1.103 (MUTANT-JOURNAL-GATE): recover a killed run, check every anchor (--anchors-only stops there),
// and mutate through the journal.
recover(ROOT);
if (process.argv.includes('--recover-only')) process.exit(0);
checkAnchors(ROOT, M.map(([name, from]) => ({ name, file: LAB, from })));
const orig = fs.readFileSync(f, 'utf8');
const base = unit();
console.log(`baseline unit: exit ${base}`);
if (base !== 0) { console.log('baseline fails: no census'); process.exit(2); }
let killed = 0;
for (const [name, from, to] of M) {
  try {
    let t = lf(orig).replace(from, () => to);
    if (orig.includes('\r\n')) t = t.replace(/\n/g, '\r\n');
    mutateFile(ROOT, f, orig, t);
    const k = unit() !== 0;
    if (k) killed++;
    console.log(`${k ? 'KILLED' : 'SURVIVED'} ${name}`);
  } finally { restoreFile(ROOT, f, orig); }
}
console.log(`TOTAL ${killed}/${M.length}`);
process.exitCode = killed === M.length ? 0 : 1;
