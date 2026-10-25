'use strict';

// RELEASE-WORKTREE-PRUNE: the hand-mutant census of scripts/release-worktrees.cjs, committed so the
// audit can re-run it. Each mutant damages ONE source line at a unique anchor and must make
// test/release-worktrees-198.test.cjs fail AT ITS OWN NAMED TEST; a survivor, a kill elsewhere or a
// missing anchor fails the census. A heavy job (bench): run it in a heavy slot.
//   node test/tools/release-worktrees-mutants.cjs [--recover-only]
// Each file is restored in a finally (CRLF kept). MUTANT-JOURNAL-GATE NIT 2 (god 9cb49c): every mutant goes
// through mutant-runner-helper, so a run killed mid-row leaves a journal the gates refuse and the next run
// (or --recover-only) restores.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { recover, mutateFile, restoreFile } = require('./mutant-runner-helper.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
recover(ROOT);
if (process.argv.includes('--recover-only')) process.exit(0);
const TEST = 'test/release-worktrees-198.test.cjs';
const SRC = 'scripts/release-worktrees.cjs';
const REAPER = 'scripts/worktree-reaper.cjs';
const at = (title) => new RegExp(`not ok \\d+ - ${title.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}`);
const HOLDS = at('cutHolds: an install or build holder is a cut; a bench holder only with a cut command');
const FREES = at('cutHolds: release frees, app-start clears, an untouched holder lapses, a reenter refreshes');
const SELF = at("cutHolds: this prune's own hold is not a cut");
const PROCS = at('cutProcesses: npm ci, electron-builder and the cut script are cuts; this process and the prune are not');
const OVERLAY = at('planCutPrune: a reaped tree stays only if verified; kept rows are never verified');
const DIST = at('verifyTree: every setup.exe, blockmap and latest.yml must equal the release digest');
const MODEL = at('verifyModel / seedModel: a bad source is skipped, the copy is verified');
const DRY = at('main dry run: prunes only verified, older cut trees; prints the cache; removes nothing');
const REPOS = at("main: a cut tree of a second --repo (the cuts' clone) is judged only when named");
const GH = at('main: gh that cannot answer keeps every tree (fail closed)');
const HELD = at('main --apply refuses while a cut holds the heavy lock (log or newest rotated log), a cut process runs, or no hive is known');
const LINKS = at('main: every link under --root outside the cut trees protects its target (audit-tree junctions, top-level links, --protect)');
const NOCACHE = at('main --apply refuses when the model cache cannot be verified');
const APPLY = at('main --apply: seeds the cache, removes verified old trees, never through a junction');

const MUTANTS = [
  ['R1 an install/build holder is no cut', SRC, "const CUT_KINDS = new Set(['install', 'build']);", 'const CUT_KINDS = new Set([]);', HOLDS],
  ['R2 a cut command is no cut', SRC, '&& (CUT_KINDS.has(h.kind) || CUT_COMMAND.test(h.command)));', '&& CUT_KINDS.has(h.kind));', HOLDS],
  ['R3 release does not free', SRC, "} else if (r.action === 'release') held.delete(r.agentId);", '}', FREES],
  ['R4 app-start does not clear', SRC, "if (r.kind === 'app-start') { held.clear(); continue; }", "if (r.kind === 'app-start') continue;", FREES],
  ['R5 a holder never lapses', SRC, 'now - h.ts < HEAVY_TTL_MS', 'true', FREES],
  ['R6 a reenter does not refresh', SRC, 'if (h) h.ts = r.ts;', 'if (h) void 0;', FREES],
  ['R7 a reenter alone does not hold', SRC, "if (h) h.ts = r.ts; else held.set(r.agentId, { agentId: r.agentId, kind: r.heavyKind, command: String(r.command || ''), ts: r.ts });", 'if (h) h.ts = r.ts;', FREES],
  ['R8 the prune\'s own hold is a cut', SRC, '!SELF_COMMAND.test(h.command)\n', 'true\n', SELF],
  ['R9 this process is a cut', SRC, 'p.pid !== selfPid && ', '', PROCS],
  ['R11 an unverified tree is reaped', SRC, '    if (!v.ok) return { ...r, action: \'keep\', reason: `unverified: ${v.why}` };\n', '', OVERLAY],
  ['R12 a non-worktree is reaped', SRC, "    if (r.kind !== 'worktree') return { ...r, action: 'keep', reason: 'not-a-worktree' };\n", '', OVERLAY],
  ['R13 the own tree is reaped', SRC, "    if (own.some((p) => inside(p, r.path))) return { ...r, action: 'keep', reason: 'own-tree' };\n", '', OVERLAY],
  ['R14 kept rows are verified', SRC, "    if (r.action !== 'reap') return r;\n", '', OVERLAY],
  ['R15 dist is not hashed', SRC, 'if (sha(p) !== assets[n]) return', 'if (false) return', DIST],
  ['R16 a missing dist file passes', SRC, "    if (!fs.existsSync(p)) return { ok: false, why: `${n}: not in dist` };\n", '', DIST],
  ['R17 a release without setup.exe passes', SRC, "  if (!want.some((n) => /-setup\\.exe$/.test(n))) return { ok: false, why: 'the release has no setup.exe' };\n", '', DIST],
  ['R18 a release without latest.yml passes', SRC, "  if (!want.includes('latest.yml')) return { ok: false, why: 'the release has no latest.yml' };\n", '', DIST],
  ['R19 a missing digest is not named', SRC, "    if (!assets[n]) return { ok: false, why: `${n}: the release gives no sha256 digest` };\n", '', DIST],
  ['R20 the model is not hashed', SRC, 'if (sha(p) !== want) return', 'if (false) return', MODEL],
  ['R21 a seed source is not verified', SRC, '    if (!verifyModel(src, manifest).ok) continue;\n', '', MODEL],
  ['R22 apply ignores a cut in progress', SRC, 'if (blocking.length) refused =', 'if (false) refused =', HELD],
  ['R23 a process list failure does not block', SRC, 'catch (e) { blocking.push(`cannot list processes: ${e.message}`); }', 'catch (e) { }', HELD],
  ['R24 apply ignores the model cache', SRC, 'else if (!cache.ok) refused =', 'else if (false) refused =', NOCACHE],
  ['R25 a dry run seeds the cache', SRC, 'if (!cache.ok && o.seed && !blocking.length)', 'if (!cache.ok && !blocking.length)', DRY],
  ['R26 --apply does not seed', SRC, "else if (a === '--apply') { o.apply = true; o.seed = true; }", "else if (a === '--apply') o.apply = true;", APPLY],
  ['R27 the folder name beats package.json', SRC, 'if (v !== null) e.version = v;', '', DRY],
  ['R28 gh failure verifies', SRC, '    if (g.error) return { ok: false, why: `gh release ${tag}: ${g.error}` };\n', '', GH],
  ['R29 the reaper judges every folder', REAPER, '    if (only && !only(name, p)) continue;\n', '', DRY],
  ['R31 only the last --repo counts', SRC, "o.repos.push(argv[++i]);", 'o.repos = [argv[++i]];', REPOS],
  ['R30 a dry run applies', SRC, '  if (o.apply) {\n', '  if (true) {\n', DRY],
  // Jim's NOT YET 1/2/1 on 00207dfe
  ['R32 links outside the cut trees protect nothing', SRC, 'protect: [...o.protect, ...outside.targets]', 'protect: [...o.protect]', LINKS],
  ['R33 a top-level link is not seen', SRC, 'if (st.isSymbolicLink()) { note(root, p); continue; }', 'if (st.isSymbolicLink()) continue;', LINKS],
  ['R34 a link inside a non-cut folder is not seen', SRC, 'if (s.isSymbolicLink()) note(d, c);', 'if (false) note(d, c);', LINKS],
  ['R35 --protect is ignored', SRC, "o.protect.push(path.resolve(argv[++i]));   // a link INTO root", "void argv[++i];   // a link INTO root", LINKS],
  ['R36 no hive known does not refuse', SRC, "if (!o.hive) blocking.push(", 'if (false) blocking.push(', HELD],
  ['R37 the rotated log is not replayed', SRC, 'if (newest) rotated =', 'if (false) rotated =', HELD],
  ['R38 the oldest rotated log is replayed', SRC, '.sort((a, b) => Number(b[1]) - Number(a[1]))[0]', '.sort((a, b) => Number(a[1]) - Number(b[1]))[0]', HELD],
  ['R39 a refused apply still seeds', SRC, 'if (!cache.ok && o.seed && !blocking.length)', 'if (!cache.ok && o.seed)', HELD]
];

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
