'use strict';

// ROSTER-GUARD-GODONLY: the hand-mutant census of the roster empty-guard's worker rule
// (src/main/roster.ts: isGodEntry, workerCount and the refusal shared by RosterStore.write and
// writeAsync, the path the renderer's mirror write takes). Each mutant
// damages ONE source line at a unique anchor and must make test/roster.test.cjs fail AT ITS OWN
// NAMED TEST; a survivor, a kill elsewhere or a missing anchor fails the census.
//   node test/tools/roster-guard-godonly-mutants.cjs
// The file is restored in a finally (CRLF kept).
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const { recover, mutateFile, restoreFile, checkAnchors } = require('./mutant-runner-helper.cjs');
const { runTests, verdict, requireBaseline } = require('./mutant-tap.cjs');
const TEST = 'test/roster.test.cjs';
const SRC = 'src/main/roster.ts';
const at = (title) => new RegExp(`not ok \\d+ - ${title.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`);
const WIPE = at('a god-only first write cannot wipe a team that is already on disk');
const LISTS = at('the god-only guard counts restorable workers and ignores archived ones');
const NO_TEAM = at('a god-only first write is fine when the file holds no workers');
const GOD = at('god is told apart by its flag or by its id, and never counts as a worker');
const ASYNC = at('writeAsync holds the first-write guard: a god-only or empty first write cannot wipe a team on disk');

const IS_GOD = "return a.isGod === true || a.id === 'god';";
const LISTED = 'return [...s.agents, ...s.restorable].filter(';
const DROPPED = 'workerCount(existing) > 0 && workerCount(snap) === 0';
const GUARD = 'if (!this.wrote && (emptied || teamDropped)) {';
const DECLINED = "this.backup(home, p, 'declined');";

const MUTANTS = [
  ['R1 the worker rule is dropped from the guard', GUARD, 'if (!this.wrote && emptied) {', WIPE],
  ['R2 god counts as a worker', IS_GOD, 'return false;', WIPE],
  ['R3 god is known by its id only', IS_GOD, "return a.id === 'god';", GOD],
  ['R4 god is known by its flag only', IS_GOD, 'return a.isGod === true;', GOD],
  ['R5 a malformed entry passes for god', "if (!v || typeof v !== 'object') return false;\n  const a = v as { id?: unknown; isGod?: unknown };",
    "if (!v || typeof v !== 'object') return true;\n  const a = v as { id?: unknown; isGod?: unknown };", GOD],
  ['R6 restorable workers are not counted', LISTED, 'return [...s.agents].filter(', LISTS],
  ['R7 floor workers are not counted', LISTED, 'return [...s.restorable].filter(', WIPE],
  ['R8 archived entries count as a team', LISTED, 'return [...s.agents, ...s.restorable, ...s.archived].filter(', LISTS],
  ['R9 a file with no workers is guarded too', DROPPED, 'workerCount(existing) >= 0 && workerCount(snap) === 0', NO_TEAM],
  ['R10 a smaller team is refused', DROPPED, 'workerCount(existing) > 0 && workerCount(snap) < workerCount(existing)', LISTS],
  ['R11 the refusal disarms the guard', DECLINED, "this.backup(home, p, 'declined'); this.wrote = true;", WIPE],
  ['R12 the refused write keeps no backup', DECLINED, '', WIPE],
  ['R13 the refusal is not reported as skipped', "return { ok: false, skipped: 'empty-first-write' };", 'return { ok: false };', WIPE],
  ['R14 the guard stays armed after a good write', GUARD, 'if (emptied || teamDropped) {', WIPE],
  ['R15 the async path does not ask the guard', 'const declined = this.refusal(existing, snap);', 'const declined = null as RosterWriteResult | null;', ASYNC],
  ['R16 the async path keeps only the empty rule', 'const declined = this.refusal(existing, snap);',
    "const declined = !this.wrote && existing && entryCount(existing) > 0 && entryCount(snap) === 0 ? { ok: false, skipped: 'empty-first-write' } as RosterWriteResult : null;", ASYNC],
  ['R17 the async refusal keeps no backup', "await this.backupAsync(home, p, 'declined');", '', ASYNC],
  ['R18 the async refusal disarms the guard', "await this.backupAsync(home, p, 'declined');", "await this.backupAsync(home, p, 'declined'); this.wrote = true;", ASYNC],
];

const run = () => runTests(ROOT, [TEST], { timeout: 300_000 });
recover(ROOT);
if (process.argv.includes('--recover-only')) process.exit(0);
checkAnchors(ROOT, MUTANTS.map(([name, from]) => ({ name, file: SRC, from })));
requireBaseline(run(), TEST);

let bad = 0;
for (const [name, from, to, dies] of MUTANTS) {
  const abs = path.join(ROOT, SRC);
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
}
console.log(bad ? `${bad} of ${MUTANTS.length} not killed at their named test` : `all ${MUTANTS.length} killed`);
process.exitCode = bad ? 1 : 0;
