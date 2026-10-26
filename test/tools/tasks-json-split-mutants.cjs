'use strict';

// TASKS-JSON-SPLIT: the hand-mutant census of the hot/cold task ledger, committed so the audit can
// re-run it. Each mutant damages ONE source line at a unique anchor and must make
// test/tasks-json-split-198.test.cjs fail AT ITS OWN NAMED TEST; a survivor, a kill elsewhere or a
// missing anchor fails the census. A heavy job (bench): run it in a heavy slot.
//   node test/tools/tasks-json-split-mutants.cjs
// Each file is restored in a finally (CRLF kept).
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const { recover, mutateFile, restoreFile, checkAnchors } = require('./mutant-runner-helper.cjs');
recover(ROOT);
if (process.argv.includes('--recover-only')) process.exit(0);
const TEST = 'test/tasks-json-split-198.test.cjs';
const ARCH = 'src/main/taskArchive.ts';
const HIVE = 'src/main/hive.ts';
const INDEX = 'src/main/index.ts';
const CLI = 'resources/tasks-cli.cjs';
const LEDGER = 'src/shared/taskLedger.ts';
const at = (title) => new RegExp(`not ok \\d+ - ${title.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`);

const MUTANTS = [
  ['A1 a done card younger than 48 h moves', ARCH, 'if (at === null || now - at < keepMs) continue;', 'if (at === null) continue;', at('planArchive')],
  ['A2 a doing/blocked card with doneAt moves', ARCH, "    if (card.status !== 'done') continue;\n", '', at('planArchive')],
  ['A3 a waitingFor/parked card moves', ARCH, '    if (isSet(card.waitingFor) || isSet(card.parked)) continue;\n', '', at('planArchive')],
  ['A4 a done card with an open ask moves', ARCH, '    if (hasOpenAsk(card)) continue;\n', '', at('planArchive')],
  ['A5 a duplicate id moves', ARCH, 'if (!id || count.get(id) !== 1) continue;', 'if (!id) continue;', at('planArchive')],
  ['A6 hot is rewritten before the archive append', HIVE,
    "    appendArchived(root, moving, now);\n",
    "    this.writeTasks(tasks.filter((t) => !ids.has(t.id)), 'archive');\n    appendArchived(root, moving, now);\n",
    at('a failed archive append')],
  ['A7 the migration backup is skipped', HIVE, "      copyFileSync(join(root, 'tasks.json'), join(root, backup));\n", '', at('the archive pass:')],
  ['A8 addTask ignores the archive', HIVE, '    if (root && this.archived(root).has(task.id)) return false;\n', '', at('a patch of an archived card')],
  ['A9 an archived patch does not revive', HIVE, 'if (!root || !old) return false;', 'return false;', at('a patch of an archived card')],
  ['A10 the tombstone is written before hot', HIVE,
    '      this.writeTasks([...tasks, { ...(old as unknown as HiveTask), revivedAt: new Date(now).toISOString(), ...patch, id }], source);\n      appendRevived(root, id, now);\n',
    '      appendRevived(root, id, now);\n      this.writeTasks([...tasks, { ...(old as unknown as HiveTask), revivedAt: new Date(now).toISOString(), ...patch, id }], source);\n',
    at('a failed tombstone append')],
  ['A11 allTasks lets the archive copy win', ARCH,
    'const out: unknown[] = hot.slice();\n  for (const [id, card] of archived) if (!inHot.has(id)) out.push(card);\n',
    'const out: unknown[] = [...archived.values(), ...hot];\n',
    at('crash between')],
  ['A12 a tombstone is ignored on read', ARCH, "if (typeof r.revived === 'string') { out.delete(r.revived); continue; }", "if (typeof r.revived === 'string') continue;", at('a patch of an archived card')],
  ['A13 the ledger route reads hot only', INDEX, 'const t = hive.allTasks().tasks;', 'const t = (hive.tasks() as { tasks: unknown[] }).tasks;', at('readers that need')],
  ['A14 statusSince of a non-done status counts', ARCH, "if (at === null && meta && meta.status === 'done' && typeof meta.statusSince", 'if (at === null && meta && typeof meta.statusSince', at('planArchive')],
  ['A15 a torn archive line is fatal', ARCH, 'try { row = JSON.parse(line); } catch { continue; }', 'row = JSON.parse(line);', at('a torn last archive line')],
  ['A16 the reader cache ignores a new archive file', HIVE, ' && this.archiveCache.stamp === stamp)', ')', at('a torn last archive line')],
  ['A17 a torn tail is not ended before an append', ARCH, "writeSync(fd, (torn ? '\\n' : '') + lines", 'writeSync(fd, lines', at('Jim MUST: a torn archive tail')],
  ['A18 the pass drops cards that never read back', HIVE,
    'const landed = new Set(moving.filter((t) => JSON.stringify(back.get(t.id)) === JSON.stringify(t)).map((t) => t.id));',
    'const landed = new Set(moving.map((t) => t.id));',
    at('Jim MUST: the pass drops from hot only')],
  ['A19 doneTime ignores revivedAt', ARCH, 'return Number.isFinite(r) && r > at ? r : at;', 'return at;', at('a patch of an archived card')],
  ['A20 a revive stamps no revivedAt', HIVE, 'revivedAt: new Date(now).toISOString(), ', '', at('a patch of an archived card')],
  ['A21 unsplit runs while Guppy is live', CLI, '    if (live) {', '    if (false) {', at('tasks-all prints hot')],
  ['A22 a dependency on an archived card warns', LEDGER, ' && !archivedIds?.has(dep)', '', at('Jim NIT:')]
];

checkAnchors(ROOT, MUTANTS.map(([name, file, from]) => ({ name, file, from })));
const run = () => spawnSync(process.execPath, ['--test', TEST], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 300_000 });
if (run().status !== 0) {
  console.log(`BASELINE RED: ${TEST} fails unmutated, so no mutant proves anything.`);
  process.exit(2);
}

let bad = 0;
for (const [name, rel, from, to, dies] of MUTANTS) {
  const abs = path.join(ROOT, rel);
  const original = fs.readFileSync(abs, 'utf8');
  const source = original.replace(/\r\n/g, '\n');
  const at = source.indexOf(from);
  if (at < 0 || source.indexOf(from, at + 1) >= 0) {
    console.log(`INERT ${name} (anchor ${at < 0 ? 'missing' : 'not unique'})`);
    bad += 1;
    continue;
  }
  let mutated = source.slice(0, at) + to + source.slice(at + from.length);
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
