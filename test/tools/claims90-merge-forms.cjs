#!/usr/bin/env node
'use strict';
/**
 * CLAIMS-90 merge class (god 0b71e3): every merge commit in a repository against the derived writer's
 * merge pattern. Prints how many each INT target form matches, the source refs with origin/, and every
 * unmatched merge subject grouped by its target, with the reason it is not a merge into an INT line.
 * Usage: node test/tools/claims90-merge-forms.cjs [repo] (default: this checkout; all refs and tags).
 */
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('../load-ts.cjs');

const { mergeSubject } = loadTs('src/main/claims/derivedFacts.ts');
const repo = process.argv[2] || path.resolve(__dirname, '..', '..');
const rows = execFileSync('git', ['log', '--merges', '--all', '--format=%H%x09%s'], { cwd: repo, encoding: 'utf8', maxBuffer: 64 << 20 })
  .split('\n').filter(Boolean).map((l) => { const i = l.indexOf('\t'); return { commit: l.slice(0, i), subject: l.slice(i + 1).trim() }; });

const form = (s) => {
  const line = /^(?:rc\/|int-|int\s+)?\d+(?:\.\d+)+(?:\s+stage\s+\S+)?:\s+merge\s/i.test(s);
  const target = line ? s.split(':')[0] : (/\binto\s+(.*)$/i.exec(s)?.[1] ?? '');
  const t = target.replace(/^'/, '');
  const pre = `${/^origin\//i.test(t) ? 'origin/' : ''}${/^(?:origin\/)?guppy\//i.test(t) ? 'guppy/' : ''}`;
  const bare = t.replace(/^(?:origin\/)?(?:guppy\/)?/i, '');
  const kind = /^rc\//i.test(bare) ? 'rc/<v> (stored rc-<v>)' : /^int\/release-/i.test(bare) ? 'int/release-<v>' : /^int-/i.test(bare) ? 'int-<v>' : /^int\s/i.test(bare) ? 'INT <v>' : 'bare <v>';
  return `${line ? '<target>: merge' : 'Merge … into'} ${pre}${kind}`;
};
const reason = (s) => {
  const into = /\binto\s+(.*)$/i.exec(s)?.[1];
  if (!into) return /^merge\b/i.test(s) ? 'no target named (a plain git merge subject)' : 'not a merge subject (a free-text message on a merge commit)';
  const t = into.replace(/^'/, '');
  if (/^(?:local\s+)?main\b/i.test(t)) return 'main';
  if (/^int:/i.test(t)) return 'an INT target with no version ("into int:")';
  if (/^(?:release[-/]|integration\/|integrate\/|try\/|v\d)/i.test(t)) return 'a release-/integration/v0.x branch, not an INT line';
  if (/^the\s+\d/i.test(t)) return 'prose target "the <v> line", not a ref';
  return 'a feature or work branch';
};

const matched = new Map(); const unmatched = new Map(); let origin = 0;
for (const r of rows) {
  const m = mergeSubject(r.subject);
  if (m) {
    const k = form(r.subject);
    matched.set(k, (matched.get(k) ?? 0) + 1);
    if (/^origin\//i.test(m.ref)) origin++;
  } else {
    const k = reason(r.subject);
    unmatched.set(k, [...(unmatched.get(k) ?? []), r]);
  }
}
const total = [...matched.values()].reduce((a, b) => a + b, 0);
console.log(`merge commits: ${rows.length}; matched as a merge into an INT: ${total}; unmatched: ${rows.length - total}`);
for (const [k, n] of [...matched].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${k}`);
console.log(`  (source ref with origin/: ${origin})`);
for (const [k, list] of [...unmatched].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`unmatched ${list.length}: ${k}`);
  if (process.argv.includes('--list')) for (const r of list) console.log(`    ${r.commit.slice(0, 8)} ${r.subject.slice(0, 110)}`);
}
