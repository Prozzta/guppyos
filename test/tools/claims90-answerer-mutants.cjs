'use strict';
/**
 * CLAIMS-90 step 3 runner census (Jim 4370f6 MUST 4): each mutant must be killed by its named killer.
 *   unit       node --test test/claims-90-answerer-get.test.cjs
 *   preflight  the answerer's --preflight-only on the real snapshot (a serve child + the build's CLI)
 * Each mutant is applied, its killers run, and the file is restored in a finally; a baseline run first
 * must pass every killer. Usage: node test/tools/claims90-answerer-mutants.cjs <answerer args for --preflight-only>
 * (the --snapshot/--addendum/--items/--instruction/--build of a real run; --out is made here per run).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const CHILD = 'test/claims-90/answer-child.cjs';
const DEPS = 'test/claims-90/claims-deps.cjs';
const ANS = 'test/claims-90/answerer.cjs';
const M = [
  ['P1 the child serves no claims deps (the step 3 runs)', CHILD, '    claims: () => claimsDeps,', '    claims: () => null,', ['preflight', 'unit']],
  ['P2 get is not wired', DEPS, '    get: (_agentId, args) => claimGetOver(read, args),', '    get: undefined,', ['preflight', 'unit']],
  ['P3 history is not wired', DEPS, '    claimHistory: (agentId, id) => claimHistoryOver(read, agentId, id),', '    claimHistory: undefined,', ['preflight', 'unit']],
  ['P4 the answerer may write', DEPS, "    level: () => 'reader',", "    level: () => 'writer',", ['unit']],
  ['P5 get reads tasks.json without the archive', DEPS, '  return { allTasks: () => hm.allTasks().tasks, dispose: () => hm.dispose() };', '  return { allTasks: () => hm.tasks().tasks, dispose: () => hm.dispose() };', ['unit']],
  ['P6 the preflight passes a non-zero exit', ANS, '  if (r.code !== 0) return `exit ${r.code}`;', '  if (false) return `exit ${r.code}`;', ['unit']],
  ['P7 the preflight passes an unanswered verb', ANS, "  if (UNAVAILABLE_RE.test(`${r.stdout}\\n${r.stderr}`)) return 'the build does not answer it';", "  if (false) return 'the build does not answer it';", ['unit']],
  ['P8 the run guard drops the transcript count', ANS, "    transcript: transcriptCalls.filter((c) => UNAVAILABLE_RE.test(c.result?.text ?? '')).length,", '    transcript: 0,', ['unit']],
  ['P9 the run guard is out of the INVALID chain', ANS, '    else if (row.unavailable.serve || row.unavailable.transcript) row.invalid = ', '    else if (false) row.invalid = ', ['unit']],
  ['P10 a failed preflight does not stop the run', ANS, '  if (!pre.ok) throw new Error(`preflight failed: ', '  if (false) throw new Error(`preflight failed: ', ['unit']],
  ['P11 the preflight skips get', ANS, "[['wake-up'], ['search', p.key], ['get', p.key, '--agent', asker], ['history', p.claimId]]", "[['wake-up'], ['search', p.key], ['history', p.claimId]]", ['unit']],
  ['P12 the ledger taskStatus reads hot-only tasks', CHILD, '    taskStatus: taskStatusFor(hiveTasks.allTasks),', "    taskStatus: (id) => (JSON.parse(fs.readFileSync(path.join(hive, 'tasks.json'), 'utf8')).tasks ?? []).find((t) => t.id === id)?.status ?? null,", ['unit']],
  ['P13 the delivery tasks read hot-only tasks', CHILD, '    tasks: hiveTasks.allTasks,', "    tasks: () => JSON.parse(fs.readFileSync(path.join(hive, 'tasks.json'), 'utf8')).tasks ?? [],", ['unit']],
  ['P15 the session folder is copied but not deleted', ANS, "  fs.rmSync(src, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });\n  return { folder, created: true,", "  return { folder, created: true,", ['unit']],
  ['P16 the leftover check sees nothing', ANS, '  return names.filter((n) => prefixes.some((p) => n.startsWith(p))).sort();', '  return [];', ['unit']],
  ['P17 a leftover does not mark the item', ANS, '    if (guard.problem) row.invalid = ', '    if (false) row.invalid = ', ['unit']],
  ['P18 a leftover does not stop the run', ANS, '    if (row.session?.problem || row.leftovers?.length) throw new Error(', '    if (false) throw new Error(', ['unit']],
  ['P19 the preflight ignores the claude -p probe', ANS, '    if (probe.problem) bad.push(', '    if (false) bad.push(', ['unit']],
  ['P20 the session folder name drops the dashes', ANS, "const projectSlug = (cwd) => path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');", "const projectSlug = (cwd) => path.resolve(cwd).replace(/[^A-Za-z0-9]+/g, '-');", ['unit', 'preflight']],
  ['P14 taskStatusFor misses the archive', DEPS, '  return (id) => (allTasks() ?? []).find((t) => t.id === id)?.status ?? null;', "  return (id) => (allTasks() ?? []).find((t) => t.id === id && t.status !== 'done')?.status ?? null;", ['unit']],
];

const preArgs = process.argv.slice(2);
function killer(k) {
  if (k === 'unit') return spawnSync(process.execPath, ['--test', 'test/claims-90-answerer-get.test.cjs'], { cwd: ROOT, encoding: 'utf8' }).status;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'c90-preflight-'));
  try { return spawnSync(process.execPath, [ANS, ...preArgs, '--out', out, '--preflight-only'], { cwd: ROOT, encoding: 'utf8' }).status; } finally { fs.rmSync(out, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
}

const lf = (s) => s.replace(/\r\n/g, '\n');
for (const [, file, from] of M) {
  const n = lf(fs.readFileSync(path.join(ROOT, file), 'utf8')).split(from).length - 1;
  if (n !== 1) { console.log(`ANCHOR ${file} x${n}: ${from}`); process.exit(2); }
}
const base = {};
for (const k of ['unit', 'preflight']) { base[k] = killer(k); console.log(`baseline ${k}: exit ${base[k]}`); }
if (base.unit !== 0 || base.preflight !== 0) { console.log('baseline fails: no census'); process.exit(2); }
let killed = 0;
for (const [name, file, from, to, killers] of M) {
  const f = path.join(ROOT, file);
  const orig = fs.readFileSync(f, 'utf8');
  const crlf = orig.includes('\r\n');
  const t = lf(orig);
  try {
    let mutated = t.replace(from, () => to);
    if (crlf) mutated = mutated.replace(/\n/g, '\r\n');
    fs.writeFileSync(f, mutated);
    const by = killers.filter((k) => killer(k) !== 0);
    if (by.length) killed++;
    console.log(`${by.length ? 'KILLED' : 'SURVIVED'} ${name}${by.length ? ` by ${by.join(', ')}` : ''}${by.length !== killers.length ? ` (not by ${killers.filter((k) => !by.includes(k)).join(', ')})` : ''}`);
  } finally { fs.writeFileSync(f, orig); }
}
console.log(`TOTAL ${killed}/${M.length}`);
process.exitCode = killed === M.length ? 0 : 1;
