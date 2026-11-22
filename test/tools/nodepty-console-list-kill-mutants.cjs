'use strict';

// FLAKE-CLK-EXITED-BY-ITSELF-ROOTEXITED-RACE-108: the hand-mutant census of the cell "a child that
// exited by itself and is still on its console is waited off the console before the close"
// (test/nodepty-console-list-kill.test.cjs). Each mutant damages ONE line at a unique anchor and must
// make the file fail AT THE NAMED ASSERT of that cell; a survivor, a kill elsewhere, a run that never
// reported or a missing anchor fails the census. A heavy job (bench): run it in a heavy slot.
//   node test/tools/nodepty-console-list-kill-mutants.cjs
// Each file is restored in a finally (CRLF kept).
//
// M1 and M2 are in the harness: its close is entered while the child is on the owner's console. The
// cell's first guarantee must name it. M3 is in the driver and tells the two events apart: it brings
// back the kill by pid at the tell, so the cell would again measure an exit and not a console
// leave. Its first red is one of two controls (Jim 7bf2e7): "the first list without the child ... while
// the child still ran" fails only when the exit wins the race; a child that is ended never writes its
// .freed, so the "freed" control fails in every other run.
//
// NOT COVERED: no mutant kills the second guarantee (the last list before the close is the owner's
// console with the owner and without the child) by itself. A harness that closes after the tell and
// before the leave needs a timing that a one-line mutant can not hold. That guarantee is pinned by the
// design of the fixture, not by this census.
//
// The expressions match the assert MESSAGES in TAP's failure text. An apostrophe is matched with `.+?`
// since the reporter may escape it.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const { recover, mutateFile, restoreFile, checkAnchors } = require('./mutant-runner-helper.cjs');
const { runTests, verdict, requireBaseline } = require('./mutant-tap.cjs');
recover(ROOT);
if (process.argv.includes('--recover-only')) process.exit(0);
const TEST = 'test/nodepty-console-list-kill.test.cjs';
const HARNESS = 'test/tools/pty-child.cjs';
const DRIVER = 'test/tools/console-list-kill-driver.cjs';

const CLOSED_ON_CONSOLE = /THE CLOSE WAITS UNTIL THE CHILD IS OFF THE CONSOLE: node-pty.+?s kill was entered while the child was still on the owner/;
const EXIT_NOT_LEAVE = /control: the first list without the child came after the tell|control: the child.+?s own list call freed/;

const MUTANTS = [
  ['M1 the harness closes on any real list, also one with the child on it', HARNESS,
    '    if (got.listed === false) return;\n', '    if (got.listed !== undefined) return;\n', CLOSED_ON_CONSOLE],
  ['M2 the harness skips the list wait once the hold says "exited"', HARNESS,
    "  if (owner.console === 'none') return;\n", '  if (owner) return;\n', CLOSED_ON_CONSOLE],
  // The tell is still written after the kill; an ended child does not read it. (The anchor is the line before
  // the write, so that this file names no direct file write: the no-bypass pin in test-runner-glob reads it.)
  ['M3 the driver ends the child by pid at the tell (the exit, not the console leave)', DRIVER,
    '        c.leftConsole = LEFT_LATE;\n', '        c.leftConsole = LEFT_LATE; try { realKill(root); } catch { /* gone */ }\n', EXIT_NOT_LEAVE]
];

checkAnchors(ROOT, MUTANTS.map(([name, file, from]) => ({ name, file, from })));
const run = () => runTests(ROOT, [TEST], { timeout: 600_000 });
requireBaseline(run(), TEST);
let bad = 0;
for (const [name, rel, from, to, dies] of MUTANTS) {
  const abs = path.join(ROOT, rel);
  const original = fs.readFileSync(abs, 'utf8');
  const source = original.replace(/\r\n/g, '\n');
  const pos = source.indexOf(from);
  if (pos < 0 || source.indexOf(from, pos + 1) >= 0) {
    console.log(`INERT ${name} (anchor ${pos < 0 ? 'missing' : 'not unique'})`);
    bad += 1;
    continue;
  }
  let mutated = source.slice(0, pos) + to + source.slice(pos + from.length);
  if (original.includes('\r\n')) mutated = mutated.replace(/\n/g, '\r\n');
  let r;
  try {
    mutateFile(ROOT, abs, original, mutated);
    r = run();
  } finally {
    restoreFile(ROOT, abs, original);
  }
  const v = verdict(r, dies); // NO-RESULT (the run never reported) is loud, never a kill
  if (v !== 'KILLED') bad += 1;
  console.log(`${v} ${name}${v === 'NO-RESULT' ? ` (${r.why})` : ''}`);
  // What failed, for the reader of a kill elsewhere: the failing titles, in order.
  if (v !== 'KILLED' && r.failed.length) console.log(`  failed: ${r.failed.join(' | ')}`);
}
console.log(bad ? `${bad} of ${MUTANTS.length} not killed at their named assert` : `all ${MUTANTS.length} killed`);
process.exitCode = bad ? 1 : 0;
