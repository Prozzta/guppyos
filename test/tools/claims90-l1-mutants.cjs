'use strict';

/**
 * Mutant runner for CLAIMS-90 L1 (god 69bc66: the structured value on every derived field claim, and its
 * backfill onto older claims) and the claims half of L4 (release.<v>.tag, card.<id>.audit). Each mutant
 * injects ONE named regression into ONE source file through the shared helper (mutateFile / restoreFile),
 * runs the derived tests, and must turn them RED. A missing or non-unique anchor is INERT and fails the run.
 * HEAVY: run it in the heavy slot.
 *
 *   node test/tools/claims90-l1-mutants.cjs [name-prefix]
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { recover, mutateFile, restoreFile } = require('./mutant-runner-helper.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
recover(ROOT);
if (process.argv.includes('--recover-only')) process.exit(0);
const TESTS = ['test/claims-derived-m5.test.cjs'];
const FACTS = 'src/main/claims/derivedFacts.ts';
const WRITER = 'src/main/claims/derivedWriter.ts';
const STORE = 'src/main/claims/store.ts';
const ENDPOINT = 'src/main/claims/endpoint.ts';

const MUTANTS = [
  // L1: the writer carries the value and backfills it.
  ['L1-a the writer drops the value from the draft', WRITER, '      ...(f.value !== undefined ? { value: f.value } : {}),\n', ''],
  ['L1-b the writer ignores the value in "the same" (no backfill)', WRITER, 'const sameValue = !!same && same.value === f.value && same.valueAgent === f.valueAgent;', 'const sameValue = !!same;'],
  ['L1-c a backfill is labelled valid time', WRITER, "note: sameValue ? 'valid time' : 'structured value'", "note: 'valid time'"],
  ['L1-d the writer drops the value agent', WRITER, '      ...(f.valueAgent !== undefined ? { valueAgent: f.valueAgent } : {}),\n', ''],
  // L1: the store gate.
  ['L1-e an agent may set a value', STORE, "      if (origin !== 'derived-internal') return { error: `refused: ${f} is set by the derived writer only` };\n", ''],
  ['L1-f a value may span lines', STORE, ' || /[\\r\\n]/.test(v)', ''],
  ['L1-g the store drops the value on write', STORE, '      ...(draft.value !== undefined ? { value: draft.value } : {}),\n', ''],
  ['L1-h a purge keeps the value', STORE, 'value: _v, valueAgent: _a, ...rest } = rec;\n  void _r; void _s; void _d; void _l; void _c; void _v; void _a;', '...rest } = rec;\n  void _r; void _s; void _d; void _l; void _c;'],
  ['L1-i a request may carry a value', ENDPOINT, "'section', 'value', 'valueAgent', 'by',", "'section', 'by',"],
  // L1: each field fact sets its value.
  ['L1-j status has no value', FACTS, 'refs: [task], value: clip(c.status, 40) });', 'refs: [task] });'],
  ['L1-k no assignee has no value (not none)', FACTS, "value: who ?? 'none' });", 'value: who ?? undefined });'],
  ['L1-l lastsha has no value', FACTS, "refs: [task, { type: 'commit', value: best }], value: best });", "refs: [task, { type: 'commit', value: best }] });"],
  ['L1-m gitsha has no value', FACTS, '      value: best,\n', ''],
  ['L1-n the merge value is the tip only (no INT target)', FACTS, '      value: `${tip} into ${x.int.toLowerCase()}`,\n', '      value: tip,\n'],
  ['M-a the merge value is the merge commit', FACTS, '      value: `${tip} into ${x.int.toLowerCase()}`,\n', '      value: `${x.commit} into ${x.int.toLowerCase()}`,\n'],
  ['M-b no int-<v> target', FACTS, '(?:int-|int\\/release-|int\\s+)?(\\d+', '(?:int\\/release-|int\\s+)?(\\d+'],
  ['M-c no int/release-<v> target', FACTS, '(?:int-|int\\/release-|int\\s+)?(\\d+', '(?:int-|int\\s+)?(\\d+'],
  ['M-d no INT <v> target', FACTS, '(?:int-|int\\/release-|int\\s+)?(\\d+', '(?:int-|int\\/release-)?(\\d+'],
  ['M-e no bare-version target', FACTS, '(?:int-|int\\/release-|int\\s+)?(\\d+', '(?:int-|int\\/release-|int\\s+)(\\d+'],
  ['M-f no origin/ before the target', FACTS, "'?(?:origin\\/)?(?:guppy\\/)?(rc\\/)?(?:int-", "'?(?:guppy\\/)?(rc\\/)?(?:int-"],
  ['M-g no guppy/ before the target', FACTS, "'?(?:origin\\/)?(?:guppy\\/)?(rc\\/)?(?:int-", "'?(?:origin\\/)?(rc\\/)?(?:int-"],
  ['M-h origin/ kept on the source ref', FACTS, "m.ref.replace(/^origin\\//i, '')", 'm.ref'],
  ['M-i no line form', FACTS, 'const l = m ? null : MERGE_LINE_RE.exec(subject);', 'const l = null as RegExpExecArray | null;'],
  ['M-j no stage in the line form', FACTS, '(?:\\s+stage\\s+\\S+)?:', ':'],
  ['M-k no free words before into', FACTS, '((?:\\s+(?!into\\s)\\S+)*?)\\s+into', '()\\s+into'],
  ['M-l no guppy word before the ref', FACTS, '(?:guppy\\s+)?', ''],
  ['M-m a free-worded ref names a branch', FACTS, 'const named = m.single && ', 'const named = '],
  ['M-o no rc/ target in the Merge form', FACTS, "(?:guppy\\/)?(rc\\/)?(?:int-", "(?:guppy\\/)?()(?:int-"],
  ['M-p no rc/ target in the line form', FACTS, "/^(rc\\/)?(?:int-|int\\s+)?", "/^()(?:int-|int\\s+)?"],
  ['M-q rc is stored as int', FACTS, "int: `${rc ? 'rc' : 'int'}-${v}`", 'int: `int-${v}`'],
  ['M-n the line form takes no @sha', FACTS, 'const sha = (m ? next : TIP_AT_RE.exec(rest))?.[1];', 'const sha = (m ? next : null)?.[1];'],
  ['L1-o donesha has no value agent', FACTS, 'value: commit, valueAgent: from,', 'value: commit,'],
  ['L1-p the bump has no value', FACTS, "refs: [{ type: 'commit', value: b.commit }], value: b.commit });", "refs: [{ type: 'commit', value: b.commit }] });"],
  // L4: release.<v>.tag and card.<id>.audit.
  ['L4-a no tag field', FACTS, 'if (t && keyOk(tk) && tt) out.push(', 'if (false) out.push('],
  ['L4-b the tag value is the bump', FACTS, "refs: [{ type: 'commit', value: t.commit }], value: t.commit });", "refs: [{ type: 'commit', value: t.commit }], value: b?.commit ?? t.commit });"],
  ['L4-c the audit goes by place, not date', FACTS, 'if (!best || at >= best.at) best =', 'if (true) best ='],
  ['L4-d the first verdict in an entry wins', FACTS, "for (const m of e.matchAll(VERDICT_RE)) if (/[0-9]/.test(m[2])) last = m;", "for (const m of e.matchAll(VERDICT_RE)) if (/[0-9]/.test(m[2]) && !last) last = m;"],
  ['L4-e no audit word needed', FACTS, 'if (!at || !AUDIT_WORD_RE.test(e)) continue;', 'if (!at) continue;'],
  ['L4-f the audit sha is not resolved by git', FACTS, 'const sha = full ?? v.sha;', 'const sha = v.sha;'],
  ['L4-g the audit value is the verdict only', FACTS, 'value: `${v.verdict} ${sha}` });', 'value: v.verdict });'],
  ['L1-q R2 undoes an explicit supersedes on a time tie', 'src/main/claims/derive.ts', 'if (newer && !replaces(older, newer)) setStatus', 'if (newer) setStatus'],
  ['L1-r the R2 exemption is direct only', 'src/main/claims/derive.ts', 'stack.push(next);', ''],
  ['L1-s a blocked mail supersedes earns the exemption', 'src/main/claims/derive.ts', 'if (!next || seen.has(id) || protectedFromMail(source, next)) continue;', 'if (!next || seen.has(id)) continue;'],
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
