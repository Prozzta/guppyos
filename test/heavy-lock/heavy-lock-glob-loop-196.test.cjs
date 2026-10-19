'use strict';

/**
 * HEAVY-LOCK-GLOB-LOOP-196 (god 0f986b). A serial loop over every test file
 * (`for f in test/*.test.cjs; do node --test "$f"; done`) ran light: one process at a time, but it
 * held a core for about 30 min without a slot and skewed other agents' FULLs (Jim's HLO196 INFO).
 *   - a `for` loop whose body runs node --test on its variable, over a glob, a computed list or
 *     SUITE_MANY_FILES words or more: a suite.
 *   - over a short explicit list: each iteration is classified with the variable replaced, so a
 *     per-file loop over named files stays light (Jim's HLO196 MUST 1 shapes).
 *   - nested short lists count by their product (Jim 9a7378: 10 x 10 words are 100 runs).
 *
 * Mutants that must die: MUTANT CENSUS at the bottom.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../load-ts.cjs');
const { readSource } = require('../read-source.cjs');

const HJF = 'src/main/heavyJob.ts';
const HJ = loadTs(HJF);
const many = (n) => Array.from({ length: n }, (_, i) => `t${i}`).join(' ');

const K = {};

K.globLoop = (M = HJ) => {
  const c = M.classifyCommand;
  for (const cmd of ['for f in test/*.test.cjs; do node --test "$f"; done', 'for f in test/heavy-lock/*.test.cjs; do echo $f; node --test $f | tail -3; done',
    'cd /c/x && for f in test/*.test.cjs\ndo\n  node --test "$f" 2>&1 | grep -E "^# (pass|fail)"\ndone']) {
    assert.deepEqual(c(cmd), { heavy: true, kind: 'suite', why: 'a loop of node --test over a glob or a computed list (write the file names out to run it light)' }, `A LOOP OVER A TEST GLOB IS A SUITE: ${cmd}`);
  }
};
test('a for loop of node --test over a test glob is a suite', () => K.globLoop());

K.computedLoop = (M = HJ) => {
  const c = M.classifyCommand;
  for (const cmd of ['files=$(grep -rl x test); for f in $files; do node --test "$f"; done',
    'for f in $(git diff --name-only); do r=$(node --test "$f" | tail -1); echo "$f $r"; done', 'for f in `git ls-files test`; do node --test $f; done',
    'for f in $(cat list.txt); do node --test test/$f.test.cjs; done']) {
    assert.deepEqual(c(cmd), { heavy: true, kind: 'suite', why: 'a loop of node --test over a glob or a computed list (write the file names out to run it light)' }, `A LOOP OVER A COMPUTED LIST IS A SUITE: ${cmd}`);
  }
};
test('a for loop of node --test over a computed list ($(...), $files, backticks) is a suite: it may be the whole suite', () => K.computedLoop());

K.longLoop = (M = HJ) => {
  const c = M.classifyCommand;
  assert.deepEqual(c(`for f in ${many(M.SUITE_MANY_FILES)}; do node --test test/$f.test.cjs; done`), { heavy: true, kind: 'suite', why: `a loop of node --test over ${M.SUITE_MANY_FILES} runs` }, 'A LOOP OVER SUITE_MANY_FILES WORDS IS A SUITE');
  assert.equal(c(`for f in ${many(M.SUITE_MANY_FILES - 1)}; do node --test test/$f.test.cjs; done`).heavy, false, 'one fewer is a short list');
};
test('a for loop of node --test over SUITE_MANY_FILES words or more is a suite; one fewer is not', () => K.longLoop());

K.shortLoop = (M = HJ) => {
  const c = M.classifyCommand;
  for (const cmd of ['for f in a b; do node --test test/$f.test.cjs; done', 'for f in test/a.test.cjs test/b.test.cjs; do node --test "$f"; done',
    'for f in a b; do echo "$f $(timeout 300 node --test test/${f}.test.cjs 2>&1 | grep -E \'^# (pass|fail)\')"; done',
    'for f in a b\ndo\n  node --test test/$f.test.cjs\ndone', 'for f in test/*.json; do echo $f; done']) {
    assert.equal(c(cmd).heavy, false, `A PER-FILE LOOP OVER A SHORT EXPLICIT LIST STAYS LIGHT: ${cmd}`);
  }
  // A name made through the loop variable is not read (as `test/$f.test.cjs` was not): no provisional.
  const read = { readScript: () => null };
  assert.deepEqual(c('for f in a b; do node --test test/$f.test.cjs; done', 0, read), { heavy: false }, 'A LOOP-MADE TEST NAME IS NOT READ');
  assert.equal(c('node --test test/a.test.cjs', 0, read).provisional, true, 'a literal one still is');
  // Each iteration is what it would be alone.
  assert.equal(c('for f in a test/tools/run-tests.cjs; do node "$f"; done').kind, 'suite', 'AN ITERATION IS CLASSIFIED WITH ITS WORD');
};
test('a per-file loop over a short explicit list stays light; each iteration is classified with its word', () => K.shortLoop());

K.nested = (M = HJ) => {
  const c = M.classifyCommand;
  assert.equal(c('for d in a b; do for f in test/$d/*.test.cjs; do node --test "$f"; done; done').kind, 'suite', 'AN INNER LOOP OVER A GLOB IS A SUITE');
  assert.equal(c('for d in a b; do for f in x y; do node --test test/$d/$f.test.cjs; done; done').heavy, false, 'nested short lists stay light');
  assert.equal(c('for f in test/a.test.cjs; do for g in x; do echo $g; done; node --test "$f"; done').heavy, false, 'THE OUTER BODY RUNS PAST THE INNER DONE');
  // Jim 9a7378: nested short lists multiply: the runs are the product of the lengths.
  const n = M.SUITE_MANY_FILES;
  const words = (k, p) => Array.from({ length: k }, (_, i) => `${p}${i}`).join(' ');
  assert.deepEqual(c(`for a in ${words(n / 4, 'a')}; do for b in a b c d; do node --test test/$a$b.test.cjs; done; done`),
    { heavy: true, kind: 'suite', why: `a loop of node --test over ${n} runs (nested lists)` }, 'NESTED SHORT LISTS COUNT BY THEIR PRODUCT');
  assert.equal(c(`for a in ${words(10, 'a')}; do for b in ${words(10, 'b')}; do node --test test/$b.test.cjs; done; done`).kind, 'suite', 'NESTED SHORT LISTS COUNT BY THEIR PRODUCT (outer var unused)');
  assert.equal(c(`for a in ${words(n / 4 - 1, 'a')}; do for b in a b c d; do node --test test/$a$b.test.cjs; done; done`).heavy, false, 'a product under SUITE_MANY_FILES stays light');
};
test('nested loops: an inner loop over a glob is a suite; nested short lists stay light under SUITE_MANY_FILES runs in all', () => K.nested());

K.repeat = (M = HJ) => {
  // Jim 2e2f8a SHOULD 1: the runs count every node --test in the body, $VAR or not (an inner
  // loop's runs are in the outer body, so a glob or computed outer list is a suite over them).
  const c = M.classifyCommand;
  const n = M.SUITE_MANY_FILES;
  assert.equal(c('for i in $(seq 50); do node --test test/a.test.cjs; done').kind, 'suite', 'A REPEAT LOOP OVER A COMPUTED LIST IS A SUITE');
  // Jim 050139 INFO: written out, 50 repeats would still be a suite, so no such hint.
  assert.equal(c('for i in $(seq 50); do node --test test/a.test.cjs; done').why, 'a loop of node --test over a glob or a computed list', 'A REPEAT LOOP GETS NO WRITE-THE-NAMES-OUT HINT');
  assert.deepEqual(c(`for i in ${many(n)}; do node --test test/a.test.cjs; done`), { heavy: true, kind: 'suite', why: `a loop of node --test over ${n} runs` }, 'A REPEAT LOOP OVER SUITE_MANY_FILES WORDS IS A SUITE');
  assert.deepEqual(c(`for i in ${many(n / 2)}; do node --test test/a.test.cjs; node --test test/b.test.cjs; done`), { heavy: true, kind: 'suite', why: `a loop of node --test over ${n} runs` }, 'EVERY NODE --TEST IN THE BODY COUNTS');
  assert.equal(c(`for i in ${many(n / 2 - 1)}; do node --test test/a.test.cjs; node --test test/b.test.cjs; done`).heavy, false, 'under SUITE_MANY_FILES runs stays light');
  for (const cmd of ['for d in test/*/; do cd $d; for f in a b; do node --test $f.test.cjs; done; done', 'for d in $(ls); do for f in a b; do node --test $f.test.cjs; done; done']) {
    assert.equal(c(cmd).kind, 'suite', `A GLOB OR COMPUTED OUTER LIST IS UNBOUNDED INWARD: ${cmd}`);
  }
};
test('a repeat loop counts its runs ($VAR or not); a glob or computed outer list is unbounded inward', () => K.repeat());

K.cap = (M = HJ) => {
  // Jim 2e2f8a MUST: the plan is capped, so a deep nest of long lists costs a fixed time on main.
  const c = M.classifyCommand;
  const nest = (levels, body) => {
    let s = body;
    for (let l = levels - 1; l >= 0; l--) s = `for v${l} in ${many(19)}; do ${s}; done`;
    return s;
  };
  const vars = Array.from({ length: 6 }, (_, l) => `$v${l}`).join('');
  const t0 = Date.now();
  assert.equal(c(nest(6, `echo ${vars}`)).heavy, false);
  assert.ok(Date.now() - t0 < 100, `A DEEP NEST IS PLANNED IN A FIXED TIME: 6 levels of 19 words took ${Date.now() - t0} ms`);
  assert.equal(c(nest(6, `node --test test/a${vars}.test.cjs`)).kind, 'suite', 'and its node --test runs still count');
};
test('the loop plan is capped: a 6-level nest of 19-word lists classifies in under 100 ms', () => K.cap());

/** The cap itself, by size: a 3-level nest of 19 words would plan 19^3 = 6859 segments uncapped
 *  (milliseconds either way, so the census can kill the uncapped mutant here, never in K.cap). */
K.capSize = (M = HJ) => {
  const n = M.planSize(`for a in ${many(19)}; do for b in ${many(19)}; do for c in ${many(19)}; do echo $a$b$c; done; done; done`);
  assert.ok(n > 0 && n <= M.PLAN_CAP, `THE PLAN NEVER PASSES PLAN_CAP SEGMENTS: ${n} > ${M.PLAN_CAP}`);
  assert.equal(M.planSize(`for a in x y; do echo $a; done`), 4, 'a short loop is planned per word (for, 2 iterations, done)');
};
test('the loop plan never passes PLAN_CAP segments', () => K.capSize());

K.wiring = (src = readSource(HJF)) => {
  assert.match(src, /const plan: Array<\{ seg: string; op: number; looped\?: boolean \}> \| HeavyClass = d === 'cmd' \? segs\.map\(\(seg, si\) => \(\{ seg, op: ops\[si\] \}\)\) : loopPlan\(segs, ops, d\);\n  if \(!Array\.isArray\(plan\)\) return plan;/, 'THE LOOP PLAN DECIDES BEFORE ANY SEGMENT');
};
test('wiring: classifyCommand plans loops before it classifies segments', () => K.wiring());

// ─── MUTANT CENSUS ──────────────────────────────────────────────────────────────────────────

function mutateText(rel, edits, tag) {
  let text = readSource(rel);
  for (const [from, to] of edits) {
    const hits = text.split(from).length - 1;
    assert.equal(hits, 1, `mutant ${tag}: edit target must match EXACTLY ONCE, matched ${hits}: ${JSON.stringify(from.slice(0, 80))}`);
    text = text.replace(from, () => to);
  }
  return text;
}

const MUTANTS = [
  { name: 'a glob list is not big', edits: [["list.some((w) => /[*?[$`]/.test(w))", "list.some((w) => /[$`]/.test(w))"]], killer: 'globLoop', dies: /A LOOP OVER A TEST GLOB IS A SUITE/ },
  { name: 'a computed list is not big', edits: [["list.some((w) => /[*?[$`]/.test(w))", "list.some((w) => /[*?[]/.test(w))"]], killer: 'computedLoop', dies: /A LOOP OVER A COMPUTED LIST IS A SUITE/ },
  { name: 'the word count is ignored', edits: [[': runs * tests >= SUITE_MANY_FILES ?', ': false ?']], killer: 'longLoop', dies: /A LOOP OVER SUITE_MANY_FILES WORDS IS A SUITE/ },
  { name: 'off by one: more than SUITE_MANY_FILES', edits: [[': runs * tests >= SUITE_MANY_FILES ?', ': runs * tests > SUITE_MANY_FILES ?']], killer: 'longLoop', dies: /A LOOP OVER SUITE_MANY_FILES WORDS IS A SUITE/ },
  { name: 'any loop is a suite (the body is not checked)', edits: [['    if (tests && big) return', '    if (big) return']], killer: 'shortLoop', dies: /A PER-FILE LOOP OVER A SHORT EXPLICIT LIST STAYS LIGHT: for f in test\/\*\.json/ },
  { name: 'the variable is not replaced per word', edits: [['    else for (const w of list) for (const p of inner) out.push({ seg: p.seg.replace(ref, () => w), op: 0, looped: true });', '    else out.push(...inner);']], killer: 'shortLoop', dies: /A PER-FILE LOOP OVER A SHORT EXPLICIT LIST STAYS LIGHT|AN ITERATION IS CLASSIFIED WITH ITS WORD/ },
  { name: 'a loop-made test name is read (a per-file loop goes provisional)', edits: [['      if (ctx.readScript && !ctx.loopWord) {', '      if (ctx.readScript) {']], killer: 'shortLoop', dies: /A LOOP-MADE TEST NAME IS NOT READ/ },
  { name: 'the loop plan is not used', edits: [['  if (!Array.isArray(plan)) return plan;', '  if (!Array.isArray(plan)) { /* ignored */ }']], killer: 'globLoop', dies: /A LOOP OVER A TEST GLOB IS A SUITE|plan is not iterable/ },
  { name: 'nested loops are not counted (the outer body ends at the inner done)', edits: [["      if (opener === 'for' || opener === 'while' || opener === 'until') depth++;\n", '']], killer: 'nested', dies: /THE OUTER BODY RUNS PAST THE INNER DONE/ },
  { name: 'the plan is not capped', edits: [[' || out.length + list.length * inner.length > PLAN_CAP) out.push(...inner);', ') out.push(...inner);']], killer: 'capSize', dies: /THE PLAN NEVER PASSES PLAN_CAP SEGMENTS/ },
  { name: 'a repeat loop gets the write-the-names-out hint', edits: [['const hint = uses && open ?', 'const hint = open ?']], killer: 'repeat', dies: /A REPEAT LOOP GETS NO WRITE-THE-NAMES-OUT HINT/ },
  { name: 'only $VAR runs count (a repeat loop is light)', edits: [['    const tests = body.filter(NODE_TEST).length;', "    const tests = body.filter((s) => NODE_TEST(s) && new RegExp(at).test(s)).length;"]], killer: 'repeat', dies: /A REPEAT LOOP OVER (A COMPUTED LIST|SUITE_MANY_FILES WORDS) IS A SUITE/ },
  { name: 'one run per body (the segments are not counted)', edits: [['    const tests = body.filter(NODE_TEST).length;', '    const tests = body.some(NODE_TEST) ? 1 : 0;']], killer: 'repeat', dies: /EVERY NODE --TEST IN THE BODY COUNTS/ },
  { name: 'nested lists do not multiply', edits: [['? Infinity : list.length * mult;', '? Infinity : list.length;']], killer: 'nested', dies: /NESTED SHORT LISTS COUNT BY THEIR PRODUCT/ },
  { name: "an inner loop's suite is dropped", edits: [['    if (!Array.isArray(inner)) return inner;', '    if (!Array.isArray(inner)) continue;']], killer: 'nested', dies: /NESTED SHORT LISTS COUNT BY THEIR PRODUCT/ }
];

// Jim 050139: the census never runs an uncapped deep nest (a 19^6 plan held a core for minutes); the
// whole file finishes in seconds, and this bound says so.
test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', { timeout: 30_000 }, async (t) => {
  for (const m of MUTANTS) {
    await t.test(`mutant: ${m.name}`, () => {
      const M = loadTs.fromText(HJF, mutateText(HJF, m.edits, m.name));
      assert.throws(() => K[m.killer](M), (e) => {
        assert.match(String(e && e.message), m.dies, `${m.name}: died for the wrong reason: ${e && e.message}`);
        return true;
      });
    });
  }
});
