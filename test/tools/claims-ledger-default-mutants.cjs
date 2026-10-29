'use strict';

/**
 * Mutant runner for CLAIMS-DEFAULT (god bb3f5b): a new floor starts on the claim ledger (C1-C5). Each mutant injects
 * ONE named regression through the shared helper (mutateFile / restoreFile), runs the ledger-default test, and must
 * turn it RED. A missing or non-unique anchor is INERT and fails the run. Rows (a)-(h) are god's census; C4 and C5
 * rows cover the derived repo and the Settings summary.
 *
 *   node test/tools/claims-ledger-default-mutants.cjs [name-prefix]
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { recover, mutateFile, restoreFile } = require('./mutant-runner-helper.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
recover(ROOT);
if (process.argv.includes('--recover-only')) process.exit(0);
const TESTS = ['test/claims-ledger-default.test.cjs'];
const CLAIMS = 'src/shared/claims.ts';
const SOURCES = 'src/main/nativeMemory/sources.ts';
const SEED = 'src/main/claims/floorSeed.ts';
const HIVE = 'src/main/hive.ts';
const CONFIG = 'src/main/config.ts';
const MAIN = 'src/main/index.ts';
const UI = 'src/main/claims/ledgerUi.ts';

const MUTANTS = [
  ['(a)1 a new hive is not seeded', HIVE, '      try { this.newHiveSeed?.(root); }', '      try { /* none */ }'],
  ['(a)2 the seed has no ledgerDefault', SEED, 'ledgerDefault: NEW_FLOOR_LEDGER_DEFAULT, ', ''],
  ['(a)3 main seeds no new hive', MAIN, '  const wrote = seedFloorSources(root, project);', '  const wrote = false && project;'],
  ['(b)1 ledgerDefault is ignored', CLAIMS, '  if (ledgerDefault !== undefined) return ledgerDefault;\n', ''],
  ['(b)2 the manifest reader drops ledgerDefault', SOURCES, '...(j.ledgerDefault !== undefined ? { ledgerDefault: j.ledgerDefault } : {}), ', ''],
  ['(c) an unlisted agent defaults to writer everywhere', CLAIMS, "return agentId === DERIVED_AGENT_ID ? 'writer' : undefined;", "return 'writer';"],
  ['(d) ledgerDefault beats an explicit entry', CLAIMS, '  if (v !== undefined) return v;\n  if (ledgerDefault', '  if (ledgerDefault !== undefined) return ledgerDefault;\n  if (v !== undefined) return v;\n  if (ledgerDefault'],
  ['(e) the global no longer caps', CLAIMS, '  const requested = Math.min(g, a);', '  const requested = a;'],
  ['(f)1 a fresh config is not writer', CONFIG, "defaultModelCliMigratedV1: true, claimLedger: 'writer' };", 'defaultModelCliMigratedV1: true };'],
  ['(f)2 writer is a read default', CONFIG, '  registeredRepos: [],\n', "  registeredRepos: [],\n  claimLedger: 'writer',\n"],
  ['(g) a seed overwrites an existing manifest', SEED, '  if (existsSync(file)) return false;\n', ''],
  ['(h)1 discovery ignores ledgerDefault', SOURCES, 'manifestEntry(config.ledger, id, config.ledgerDefault)', 'manifestEntry(config.ledger, id)'],
  ['(h)2 main ignores ledgerDefault', MAIN, 'manifestEntry(floor.ledger, agentId, floor.ledgerDefault)', 'manifestEntry(floor.ledger, agentId)'],
  // Jim e7aa07 (a): on the H1 floor inputs the level, discovery and repo() values equal 3aaf0d12.
  ['EQ-a an absent entry takes an absent default', CLAIMS, '  if (ledgerDefault !== undefined) return ledgerDefault;\n', '  if (agentId === DERIVED_AGENT_ID || ledgerDefault !== undefined) return ledgerDefault;\n'],
  ['EQ-b the manifest reader invents a default', SOURCES, '...(j.ledgerDefault !== undefined ? { ledgerDefault: j.ledgerDefault } : {}), ', "ledgerDefault: j.ledgerDefault ?? 'reader', "],
  ['EQ-c repo() drops the config repo', SEED, "  return typeof configRepo === 'string' && configRepo.trim() ? configRepo : null;", '  return null;'],
  ['EQ-e repo() reads the project folder on a floor made before 1.1.103', SEED, "  if (set || !floor || floor.ledgerDefault === undefined) return set;", '  if (set || !floor) return set;'],
  ['EQ-d repo() takes a blank config repo', SEED, "  return typeof configRepo === 'string' && configRepo.trim() ? configRepo : null;", "  return typeof configRepo === 'string' ? configRepo : null;"],
  ['C4-a any project folder is a repo', SEED, "const repo = typeof projectFolder === 'string' && isAbsolute(projectFolder) && isRepo(projectFolder)", "const repo = typeof projectFolder === 'string' && isAbsolute(projectFolder)"],
  ['C4-f a seeded floor takes any project folder as its repo', SEED, "  return typeof projectFolder === 'string' && isAbsolute(projectFolder) && isRepo(projectFolder) ? projectFolder : null;", "  return typeof projectFolder === 'string' && isAbsolute(projectFolder) ? projectFolder : null;"],
  ['C4-g a seeded floor never reads its project folder live', SEED, '  if (set || !floor || floor.ledgerDefault === undefined) return set;', '  return set;'],
  ['C4-h main passes no project folder', MAIN, 'cfg.derivedClaimsRepo, cfg.registeredRepos?.[0] ?? null);', 'cfg.derivedClaimsRepo, null);'],
  ['C4-i Settings shows the floor repo only', MAIN, 'return { ledgerDefault: f?.ledgerDefault, derivedRepo: derivedRepoNow() };', 'return { ledgerDefault: f?.ledgerDefault, derivedRepo: f?.derivedRepo ?? null };'],
  ['C4-b a relative folder can be a repo', SEED, "const repo = typeof projectFolder === 'string' && isAbsolute(projectFolder) &&", "const repo = typeof projectFolder === 'string' &&"],
  ['C4-j a seeded floor reads a relative project folder live', SEED, "  return typeof projectFolder === 'string' && isAbsolute(projectFolder) &&", "  return typeof projectFolder === 'string' &&"],
  ['C4-c config beats the floor repo', SEED, "  if (typeof floorRepo === 'string' && floorRepo.trim()) return floorRepo;\n", ''],
  ['C4-d the manifest reader drops derivedRepo', SOURCES, '...(derivedRepo ? { derivedRepo } : {})', ''],
  ['C4-e the derived writer reads config only', MAIN, 'return floorRepo(root ? readSourcesConfig(root) : null, cfg.derivedClaimsRepo, cfg.registeredRepos?.[0] ?? null);', 'return floorRepo(null, cfg.derivedClaimsRepo, cfg.registeredRepos?.[0] ?? null);'],
  ['C4-f the seed reads no project folder', MAIN, '  const project = readConfig().registeredRepos?.[0] ?? null;', '  const project = null;'],
  ['C5-a the summary has no floor', UI, ', ...(floor ? { floor } : {}) };', ' };'],
  ['C5-b a garbled default shows as set', UI, "typeof f.ledgerDefault === 'string' && (LEDGER_LEVELS as readonly string[]).includes(f.ledgerDefault)", "typeof f.ledgerDefault === 'string'"],
];

const prefix = process.argv[2] || '';
const selected = MUTANTS.filter(([name]) => name.startsWith(prefix));
let killed = 0; let inert = 0;
for (const [name, file, from, to, tests] of selected) {
  const abs = path.join(ROOT, file);
  const original = fs.readFileSync(abs, 'utf8');
  const crlf = original.includes('\r\n');
  const lf = original.replace(/\r\n/g, '\n');
  const at = lf.indexOf(from);
  if (at < 0 || lf.indexOf(from, at + 1) >= 0) {
    inert++;
    console.log(`INERT     ${name}  (anchor ${at < 0 ? 'missing' : 'not unique'} in ${file})`);
    continue;
  }
  let mutated = lf.slice(0, at) + to + lf.slice(at + from.length);
  if (crlf) mutated = mutated.replace(/\n/g, '\r\n');
  try {
    mutateFile(ROOT, abs, original, mutated);
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...(tests ?? TESTS)], { cwd: ROOT, encoding: 'utf8', timeout: 600_000 });
    const fails = (String(r.stdout).match(/^# fail (\d+)/m) || [])[1] ?? '?';
    const dead = r.status !== 0;
    if (dead) killed++;
    console.log(`${dead ? 'KILLED  ' : 'SURVIVED'}  ${name}  (failing tests: ${fails})`);
  } finally {
    restoreFile(ROOT, abs, original);
  }
}
console.log(`\n${killed}/${selected.length} killed${inert ? `, ${inert} INERT` : ''}`);
process.exit(killed === selected.length ? 0 : 1);
