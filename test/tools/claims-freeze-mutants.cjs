'use strict';

// CLAIMS-FREEZE-GUARD: the hand-mutant census of scripts/claims-freeze.cjs, committed so a later
// audit can re-run it. Each mutant damages ONE line at a unique anchor and must make
// test/claims-freeze-guard.test.cjs fail AT ITS OWN NAMED TEST; a survivor, a kill elsewhere or a
// missing anchor fails the census. A heavy job (bench): run it in a heavy slot.
//   node test/tools/claims-freeze-mutants.cjs
// This runner restores the file itself in a finally.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const TEST = 'test/claims-freeze-guard.test.cjs';
const SRC = 'scripts/claims-freeze.cjs';

const MUTANTS = [
  ['C1 no window refuses', "if (!w) return { ok: true, files: [], waived: false, why: 'no measurement window is open' };", "if (!w) return { ok: false, files: [], waived: false, why: 'no measurement window is open' };", /not ok \d+ - no window open/],
  ['C2 cardIds.ts not frozen', 'try { files = frozenDiff(git, w.baseCommit, tip, state.paths); }', 'try { files = frozenDiff(git, w.baseCommit, tip, state.paths.slice(0, 1)); }', /not ok \d+ - window open: src\/shared\/cardIds\.ts is frozen too/],
  ['C3 any waiver waives every version', 'const waiver = Object.hasOwn(w.waivers, version) ? w.waivers[version] : null;', 'const waiver = Object.values(w.waivers)[0] ?? null;', /not ok \d+ - waiver: only the waived version passes/],
  ['C4 record skips the diff', '  if (files.length) throw new Error(`not recorded:', '  if (false) throw new Error(`not recorded:', /not ok \d+ - waiver: only the waived version passes/],
  ['C5 record overwrites a recorded version', 'if (had && had !== commit)', 'if (false && had !== commit)', /not ok \d+ - record: an empty diff appends/],
  ['C6 record takes a short hash', 'if (!HASH.test(commit)) throw new Error(`not recorded:', 'if (false) throw new Error(`not recorded:', /not ok \d+ - record: an empty diff appends/],
  ['C7 a tag name passes as baseCommit', "if (!HASH.test(w.baseCommit ?? '')) throw", 'if (false) throw', /not ok \d+ - fails closed/],
  ['C8 a diff that cannot run passes', 'return { ok: false, files: [], waived: false, why: `cannot verify', 'return { ok: true, files: [], waived: false, why: `cannot verify', /not ok \d+ - fails closed/],
  ['C9 the gate reads the working tree state', "parseState(git(['show', `${tip}:${FILE}`]))", "parseState(fs.readFileSync(path.join(cwd, FILE), 'utf8'))", /not ok \d+ - the gate reads the state and the version from the tip/],
  ['C10 the gate reads the working tree version', "JSON.parse(git(['show', `${tip}:package.json`])).version", "JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')).version", /not ok \d+ - the gate reads the state and the version from the tip/],
  ['C11 record without a window', "if (!w) throw new Error('not recorded: no measurement window is open');", 'if (false) throw new Error();', /not ok \d+ - record: an empty diff appends/],
  ['C12 a refusal exits 0', 'return r.ok ? 0 : 1;', 'return 0;', /not ok \d+ - window open: a release that changes src\/main\/claims is REFUSED/],
  ['C13 frozenVersions unchecked', '!Object.values(s.frozenVersions).every((h) => HASH.test(h))', 'false', /not ok \d+ - fails closed/],
  ['C14 waivers unchecked', '!isObj(w.waivers) || ', '', /not ok \d+ - fails closed/],
  ['C15 record drops the new entry', 'frozenVersions: { ...state.frozenVersions, [version]: commit }', 'frozenVersions: { ...state.frozenVersions }', /not ok \d+ - record: an empty diff appends/],
];

const run = () => spawnSync(process.execPath, ['--test', TEST], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 300_000 });
if (run().status !== 0) {
  console.log(`BASELINE RED: ${TEST} fails unmutated, so no mutant proves anything.`);
  process.exit(2);
}

let bad = 0;
for (const [name, from, to, dies] of MUTANTS) {
  const abs = path.join(ROOT, SRC);
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
    fs.writeFileSync(abs, mutated);
    r = run();
  } finally {
    fs.writeFileSync(abs, original);
  }
  const named = dies.test(`${r.stdout}${r.stderr}`);
  const killed = r.status !== 0 && named;
  if (!killed) bad += 1;
  console.log(`${killed ? 'KILLED' : r.status !== 0 ? 'KILLED ELSEWHERE' : 'SURVIVED'} ${name}`);
}
console.log(bad ? `${bad} of ${MUTANTS.length} not killed at their named test` : `all ${MUTANTS.length} killed`);
process.exitCode = bad ? 1 : 0;
