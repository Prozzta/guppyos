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
  // Jim 99a1d4 fix 3, bfa9cd: the session's own spill only.
  ['P21 a spill of another session id or a lookalike folder passes', ANS, '  if (!f.toLowerCase().startsWith(dir.toLowerCase())) return false;', "  if (!f.toLowerCase().includes('/tool-results/')) return false;", ['unit']],
  ['P22 a spill path below or through tool-results passes', ANS, "  if (!name || name.includes('/')) return false;", '  if (!name) return false;', ['unit']],
  ['P23 a spill written after the session ended passes', ANS, 'return st.isFile() && st.mtimeMs <= spill.endedMs;', 'return st.isFile();', ['unit']],
  ['P24 the spill session id is the one in the path the agent names', ANS, '!ownSpillRead(u.input?.file_path, spill, init?.session_id)', "!ownSpillRead(u.input?.file_path, spill, fwd(String(u.input?.file_path)).split('/').slice(-3)[0])", ['unit']],
  ['P25 every read outside tool-output counts as a spill', ANS, '&& !ownSpillRead(u.input?.file_path, spill, init?.session_id)) leaks.push', '&& false) leaks.push', ['unit']],
  ['P26 the item audit gets no spill context', ANS, ", { projects: claudeProjectsDir(), cwd: path.join(home, 'cwd'), endedMs: t0 + row.ms });", ');', ['unit']],
  ['P27 the settings do not allow the spill folder', ANS, '        ...(spillDir ? [', '        ...(false ? [', ['unit']],
  // god f884de fix 2: the served state is a real floor's.
  ['P28 no derived ledger passes the preflight', ANS, '  if (!(ledgers?.derived?.records > 0)) return', '  if (false) return', ['unit']],
  ['P29 a served state with no indexed card passes', ANS, "  if (!cardGet) return 'the served state has no mail index", "  if (!cardGet) return null; if (false) return 'the served state has no mail index", ['unit']],
  ['P30 a card get showing no mail index passes', ANS, "  if (/no mail index/.test(cardGet.stdout)) return 'a card get shows no mail index';", "  if (false) return 'a card get shows no mail index';", ['unit']],
  ['P31 the served-state check is not a preflight call', ANS, 'problem: servedStateProblem(connect.ledgers, g) });', 'problem: null });', ['unit']],
  // god b6624e fix 1: the served state is built through the app's startup entry points, then copied into every item.
  ['P32 the mail-card catch-up never runs', CHILD, '    const catchUp = startupMailCardCatchUp(hive, { log, now: () => spec.now });', '    const catchUp = Promise.resolve(null);', ['preflight', 'unit']],
  ['P33 the derived writer starts beside the running catch-up', CHILD, '    await startAfterMailCardCatchUp(catchUp, () => derivedLive.start());', '    derivedLive.start(); await catchUp;', ['unit']],
  ['P34 the child stops the derived writer before it settled', CHILD, "    await derivedLive.run('served-settled', async () => {});", '', ['preflight']],
  ['P35 a failed build does not stop the child', CHILD, '    if (failed.length) { emit(', '    if (false) { emit(', ['unit']],
  ['P36 every write of the preflight child is served', ANS, "  const ours = (rel) => rel.startsWith('state/mail-cards/') || rel.startsWith(`agents/${DERIVED_DIR}/`);", '  const ours = () => true;', ['unit']],
  ['P37 the derived anchor is not copied into the item', ANS, '{ ...(j.hives[hiveIdOfItem] ?? {}), ...served.anchors };', '{ ...(j.hives[hiveIdOfItem] ?? {}) };', ['unit']],
  ['P38 the served sha ignores the file bytes', ANS, "  for (const f of served.files) h.update(`${f.rel}\\0`).update(fs.readFileSync(path.join(hive, f.rel)));", "  for (const f of served.files) h.update(`${f.rel}\\0`);", ['unit']],
  ['P39 an item is not given the served state', ANS, '    row.servedSha256 = applyServed(pre.servedState, hive, userData, hiveId.to);', '    row.servedSha256 = pre.served.sha256;', ['unit']],
  ['P40 an item serving other bytes runs on', ANS, '    if (row.servedSha256 !== pre.served.sha256) throw ', '    if (false) throw ', ['unit']],
  ['P41 the build stage holds no mail', ANS, "v.manifest, home, ['primary-mail']);", 'v.manifest, home, []);', ['unit']],
  ['P42 the child level skips the manifest default (derived off)', CHILD, 'return effectiveLevel(config.claimLedger, manifestEntry(floor.ledger, agentId, floor.ledgerDefault)).level;', 'return effectiveLevel(config.claimLedger, floor.ledger?.[agentId]).level;', ['preflight', 'unit']],
  ['P43 a build with the derived ledger off runs on', ANS, '    if (!built.derivedOn) return { problem: ', '    if (false) return { problem: ', ['unit']],
  ['P44 the changelog is not the newest version tag\'s', ANS, '  const tag = newestVersionTag(', "  const tag = 'v1.1.90' || newestVersionTag(", ['unit']],
  // god ba807e: the preflight's synced index is served to every item.
  ['P45 the index is not served (each item re-embeds)', ANS, '    row.indexServedSha256 = serveIndex(pre.servedState.index, userData, hiveId.to);', '    row.indexServedSha256 = pre.served.index.sha256;', ['unit']],
  ['P46 a sync timeout is ignored', ANS, '    if (!s.reply?.ok) return ', '    if (false) return ', ['unit']],
  ['P47 an item that re-embeds runs on', ANS, '    if (embedNone && j?.embedded !== 0) return ', '    if (false) return ', ['unit']],
  ['P48 the item sync check is out of the INVALID chain', ANS, '    if (!row.invalid && syncBad) row.invalid = ', '    if (false) row.invalid = ', ['unit']],
  ['P49 an item index unlike the served one runs on', ANS, '    else if (!row.invalid && indexKey(row.indexAfter) !== indexKey(pre.served.index.digest)) row.invalid = ', '    else if (false) row.invalid = ', ['unit']],
  ['P50 the preflight skips the index check', ANS, "    calls.push({ cmd: 'index sync', problem: syncProblem(", "    calls.push({ cmd: 'index sync', problem: null && syncProblem(", ['unit']],
  ['P51 a sync that drops runs on', ANS, '    if (j?.dropped !== 0) return ', '    if (false) return ', ['unit']],
  ['P52 an index with WAL bytes is served', ANS, '  if (d.walBytes !== 0) return ', '  if (false) return ', ['unit']],
  ['P53 an index short of vectors is served', ANS, '  if (!(d.chunks > 0) || d.vectors !== d.chunks) return ', '  if (false) return ', ['unit']],
  ['P54 index equality ignores the chunk sha', ANS, 'JSON.stringify({ perWing: d.perWing, vectors: d.vectors, chunkSha256: d.chunkSha256 })', 'JSON.stringify({ perWing: d.perWing, vectors: d.vectors })', ['unit']],
  ['P55 a stale WAL of the staged index is kept', ANS, '  for (const f of [`${p}-wal`, `${p}-shm`]) fs.rmSync(f, { force: true });', '', ['unit']],
  ['P56 the child reads the index before its worker shut down', CHILD, '    await nativeMemory.shutdown().catch(() => {});\n    // god ba807e', '    // god ba807e', ['unit']],
  // god 8c625b: per-search timing rows, and a search exit 4 makes the item INVALID.
  ['P57 search4Of counts nothing', ANS, "  return memCalls.filter((m) => m.cmd === 'search' && m.exit === 4).length;", '  return 0;', ['unit']],
  ['P58 a search exit 4 is out of the INVALID chain', ANS, '    else if (row.search4) row.invalid = ', '    else if (false) row.invalid = ', ['unit']],
  ['P59 search4Of counts every verb', ANS, "memCalls.filter((m) => m.cmd === 'search' && m.exit === 4)", 'memCalls.filter((m) => m.exit === 4)', ['unit']],
  ['P60 the fork gets no tap', CHILD, "ort: treeRequire('onnxruntime-node') }, searchTap),", "ort: treeRequire('onnxruntime-node') }),", ['unit']],
  ['P61 the brief asks are not timed', CHILD, '    cardLead: timedCardLead,', '    cardLead: (ask) => claimsDeps.cardLead(ask),', ['unit']],
  ['P62 a reply past its deadline passes as the worker exit', CHILD, 'exit: late ? 4 : workerExit,', 'exit: workerExit,', ['unit']],
  ['P63 the serve summary drops the search rows', CHILD, 'index: indexDigest(nativeMemory.dbFile()), searches, memLog', 'index: indexDigest(nativeMemory.dbFile()), memLog', ['unit']],
  ['P64 the tap misses main\'s requests', CHILD, '      tap?.toWorker(m);\n', '', ['unit']],
  ['P65 the run total drops the exit-4 items', ANS, 'search4Items: rows.filter((r) => r.search4).length,', 'search4Items: 0,', ['unit']],
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
