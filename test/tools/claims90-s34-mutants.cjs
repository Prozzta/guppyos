'use strict';

/**
 * Mutant runner for CLAIMS-90 search S3/S4 (god 33b32e), the data side: searchTargets.ts, which maps a card id, a
 * card-owned branch or a release version named in a query or hit to its card or release. Each mutant injects ONE
 * named regression through the shared helper (mutateFile / restoreFile), runs the targets test, and must turn it
 * RED. A missing or non-unique anchor is INERT and fails the run.
 *
 *   node test/tools/claims90-s34-mutants.cjs [name-prefix]
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { recover, mutateFile, restoreFile } = require('./mutant-runner-helper.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
recover(ROOT);
if (process.argv.includes('--recover-only')) process.exit(0);
const TESTS = ['test/claims-search-targets.test.cjs'];
const T = 'src/main/claims/searchTargets.ts';

const MUTANTS = [
  // S3: a card id, card key or card-owned branch names its card.
  ['S3-a a card id matches in its written case only', T, ".replace(/^guppy\\//i, '').toLowerCase();", ".replace(/^guppy\\//i, '');"],
  ['S3-b a guppy/ branch names no card', T, ".replace(/^guppy\\//i, '')", ''],
  ['S3-c an origin/ branch names no card', T, "token.replace(/^origin\\//i, '')", 'token'],
  ['S3-d card.<id>.<field> keeps the field', T, ".replace(CARD_FIELD_RE, '')", ''],
  ['S3-m card.<id>.merge.rc keeps the rc field', T, 'merge(?:\\.rc)?|', 'merge|'],
  ['S3-e card.<id>.decision.<x> keeps the decision', T, ".replace(/\\.decision\\..*$/i, '')", ''],
  ['S3-f no short names', T, ' ?? short.get(name)', ''],
  ['S3-g a shared short name names a card', T, 'out.has(s) ? null : id', 'id'],
  ['S3-k one id word is a short name', T, 'for (let j = i + 2;', 'for (let j = i + 1;'],
  ['S3-l a <stem>-<n> stem is no short name', T, '    if (stem) mine.add(stem[1]);\n', ''],
  ['S3-h a claim key overrides the tasks.json spelling', T, 'if (c && !cards.has(c.toLowerCase())) cards.set', 'if (c) cards.set'],
  ['S3-i a card key returns the key spelling', T, 'if (key) return ix.cards.get(key.toLowerCase()) ?? null;', 'if (key) return key;'],
  ['S3-j trailing punctuation stays on the token', T, "raw.replace(/[._/-]+$/, '')", 'raw'],
  // S4: a release version names release.<v>; order, dedupe and cap.
  ['S4-a a version names a release with no release key', T, 'VERSION_RE.test(v) && ix.releases.has(v)', 'VERSION_RE.test(v)'],
  ['S4-b release-/rc- forms name no release', T, 'int-|int\\/release-|release-|rc-|rc\\/)', 'int-|int\\/release-)'],
  ['S4-c a release key with a field is not indexed', T, '(?:\\.[a-z0-9]+)*$`', '$`'],
  ['S4-d a release reading beats a card id', T,
    "const v = card ? null : releaseOfToken(token, ix);\n      const t: SearchTarget | null = card ? { kind: 'card', term: card } : v ? { kind: 'release', term: `release.${v}` } : null;",
    "const v = releaseOfToken(token, ix);\n      const t: SearchTarget | null = v ? { kind: 'release', term: `release.${v}` } : card ? { kind: 'card', term: card } : null;"],
  ['S4-e no dedupe', T, 'if (!seen.has(k)) { seen.add(k); out.push(t); }', 'out.push(t);'],
  ['S4-f no cap', T, 'if (out.length >= max) return out;', ''],
  ['S4-g hits before the query', T, 'for (const text of texts) {', 'for (const text of [...texts].reverse()) {'],
];

const prefix = process.argv[2] || '';
const selected = MUTANTS.filter(([name]) => name.startsWith(prefix));
let killed = 0; let inert = 0;
for (const [name, file, from, to] of selected) {
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
    const r = spawnSync(process.execPath, ['--test', ...TESTS], { cwd: ROOT, encoding: 'utf8', timeout: 600_000 });
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
