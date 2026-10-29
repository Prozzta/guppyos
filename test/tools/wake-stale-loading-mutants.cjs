'use strict';

// WAKE-LIFECYCLE-UNKNOWN-197: the hand-mutant census of the stale-loading-header rule
// (src/shared/codexScreen.ts codexPastStartup and its automaticSubmit.ts latch wiring). Each mutant
// damages ONE source line at a unique anchor and must make test/wake-stale-loading-header-197.test.cjs
// fail AT ITS OWN NAMED TEST; a survivor, a kill elsewhere or a missing anchor fails the census.
// A heavy job (bench): run it in a heavy slot.
//   node test/tools/wake-stale-loading-mutants.cjs
// Each file is restored in a finally (CRLF kept).
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const { recover, mutateFile, restoreFile, checkAnchors } = require('./mutant-runner-helper.cjs');
recover(ROOT);
if (process.argv.includes('--recover-only')) process.exit(0);
const TEST = 'test/wake-stale-loading-header-197.test.cjs';
const SCREEN = 'src/shared/codexScreen.ts';
const OWNER = 'src/main/automaticSubmit.ts';
const at = (title) => new RegExp(`not ok \\d+ - ${title.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`);
const UNLATCHED = at('UNLATCHED: the same screen without the post-handoff latch is refused, so it never creates the latch');
const NOSTATUS = at('NO STATUS LINE: a latched loading header with only `? for shortcuts` under the composer is refused');
const RESUMING = at('RESUMING: a latched loading header with its Resuming/Forking line is refused, status line or not');
const STALE = at('STALE: a latched resume with a loading header and its own status line is past startup');
const WIRE = at('WIRING: the owner passes its latch for this incarnation at both admission reads, and the startup probe passes none');

const RULE = 'if (latched && !f.startingAfterHeader && f.footer.some((row) => isCodexStatusLine(row, spawnCwd, home))) return';
const MUTANTS = [
  ['S1 the status-line check is dropped', SCREEN, RULE, 'if (latched && !f.startingAfterHeader) return', NOSTATUS],
  ['S2 the latch check is dropped', SCREEN, RULE, 'if (!f.startingAfterHeader && f.footer.some((row) => isCodexStatusLine(row, spawnCwd, home))) return', UNLATCHED],
  ['S3 the Resuming/Forking check is dropped', SCREEN, RULE, 'if (latched && f.footer.some((row) => isCodexStatusLine(row, spawnCwd, home))) return', RESUMING],
  ['S4 the stale header never opens', SCREEN, RULE, 'if (false) return', STALE],
  ['W1 the screen gate claims the latch always', OWNER, 'deps.homeDir?.(), this.postHandoff.get(ptyId) === incarnation)', 'deps.homeDir?.(), true)', WIRE],
  ['W2 the held recheck passes no latch', OWNER, 'deps.homeDir?.(), this.postHandoff.get(ptyId) === held.incarnation)', 'deps.homeDir?.())', WIRE]
];

checkAnchors(ROOT, MUTANTS.map(([name, file, from]) => ({ name, file, from })));
const run = () => spawnSync(process.execPath, ['--test', TEST], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 300_000 });
const base = run();
if (base.status !== 0) {
  console.log(`BASELINE RED: ${TEST} fails unmutated, so no mutant proves anything.`);
  process.exit(1);
}
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
  const named = dies.test(`${r.stdout}${r.stderr}`);
  const killed = r.status !== 0 && named;
  if (!killed) bad += 1;
  console.log(`${killed ? 'KILLED' : r.status !== 0 ? 'KILLED ELSEWHERE' : 'SURVIVED'} ${name}`);
}
console.log(bad ? `${bad} of ${MUTANTS.length} not killed at their named test` : `all ${MUTANTS.length} killed`);
process.exitCode = bad ? 1 : 0;
