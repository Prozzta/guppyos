'use strict';

/**
 * HEAVY-LOCK-LOOP-BODY-198 (narrowed to subshells at CARD-TRIAGE-191; loops were fixed in d80b2561;
 * god 9b057d). A heavy command inside a bash subshell must classify heavy. A plain `( npm test )`,
 * `( cd x && npm test )` and `( ... ) &` already did: segments() splits at the operators and
 * stripKeywords() drops a standalone `(` and one `(` / `)` glued to the first / last word. Nested
 * subshells glue several, `((cd x && npm test) )` and `(cd x && (npm test))`, and those read LIGHT
 * (the program was `((cd` or the last word `test))`). Now every glued `(` and `)` is stripped, and a
 * `)` standing alone after the last word is dropped, so `( node --test a.test.cjs )` is one file
 * (light, as at a prompt) and not a second path `)` (a false suite).
 * `$( )` is out of scope (a command substitution is opaque here, HEAVY-JOB-LOCK-FAILOPEN); cmd is
 * untouched (stripKeywords returns early for it).
 *
 * Mutants that must die: MUTANT CENSUS at the bottom.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../load-ts.cjs');
const { readSource } = require('../read-source.cjs');

const HJF = 'src/main/heavyJob.ts';
const HJ = loadTs(HJF);

const suite = (M, cmd, msg, c = {}) => {
  const r = M.classifyCommand(cmd, 0, c);
  assert.equal(r.heavy && !r.provisional && r.kind, 'suite', `${msg}: ${JSON.stringify(cmd)} -> ${JSON.stringify(r)}`);
};
const light = (M, cmd, msg, c = {}) => {
  const r = M.classifyCommand(cmd, 0, c);
  assert.equal(r.heavy, false, `${msg}: ${JSON.stringify(cmd)} -> ${JSON.stringify(r)}`);
};

const K = {};

K.plain = (M = HJ) => {
  for (const cmd of ['( npm test )', '(npm test)', '( cd x && npm test )', '(cd x; npm test)', '( npm test ) &', '(npm test)&', '( npm test ) & wait', '(npm test) | tee log', '(\nnpm test\n)', 'cd x && (npm test)', '! ( npm test )', 'time ( npm test )']) {
    suite(M, cmd, 'A SUBSHELL IS CLASSIFIED BY WHAT IT RUNS');
  }
};

K.nested = (M = HJ) => {
  suite(M, '( ( npm test ) )', 'A NESTED SUBSHELL IS CLASSIFIED (spaced)');
  suite(M, '((npm test) )', 'A NESTED SUBSHELL IS CLASSIFIED (( GLUED)');
  suite(M, '((cd x && npm test) )', 'A NESTED SUBSHELL IS CLASSIFIED (( GLUED, cd)');
  suite(M, '((npm test); echo)', 'A NESTED SUBSHELL IS CLASSIFIED (( GLUED, ;)');
  suite(M, '( (npm test))', 'A NESTED SUBSHELL IS CLASSIFIED )) GLUED');
  suite(M, '(cd x && (npm test))', 'A NESTED SUBSHELL IS CLASSIFIED )) GLUED, cd');
  suite(M, '(cd x && (npm test) &)', 'A NESTED SUBSHELL IS CLASSIFIED (background)');
};

K.alone = (M = HJ) => {
  light(M, '( node --test a.test.cjs )', 'A ) STANDING ALONE IS NOT A PATH: ONE FILE STAYS LIGHT');
  light(M, '( node --test a.test.cjs ) &', 'A ) STANDING ALONE IS NOT A PATH: ONE FILE STAYS LIGHT (background)');
  light(M, '(node --test a.test.cjs)', 'one file in a glued subshell stays light');
};

K.kept = (M = HJ) => {
  for (const cmd of ['( echo hi )', '(echo hi)', '((echo hi) )', 'echo "(npm test)"', "echo '( npm test )'", 'echo \\( npm test \\)', '(( x = 1 ))', '((x=1))', 'echo a(b)']) {
    light(M, cmd, 'A LIGHT SUBSHELL, A QUOTED ( AND ARITHMETIC STAY LIGHT');
  }
  light(M, '(npm test)', 'CMD IS UNTOUCHED', { dialect: 'cmd' });
};

test('a plain subshell is classified by what it runs: ( ), (cd && ), ( ) &, a pipe, a newline', () => K.plain());
test('a nested subshell is classified, its ( and ) glued or spaced', () => K.nested());
test('a ) standing alone after the last word is not a path', () => K.alone());
test('unchanged: light subshells, quoted parens, arithmetic, cmd', () => K.kept());

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

const LEAD = "  if (out.length > 1 && /^\\(+[^()'\"$`]+$/.test(out[0])) out = [out[0].replace(/^\\(+/, ''), ...out.slice(1)];";
const ALONE = "  while (out.length > 1 && out[out.length - 1] === ')') out = out.slice(0, -1);";
const TAIL = "  return out.length > 1 && /^[^()'\"$`]+\\)+$/.test(last) ? [...out.slice(0, -1), last.replace(/\\)+$/, '')] : out;";
const MUTANTS = [
  { name: 'one glued ( only (the old rule)', edits: [[LEAD, "  if (out.length > 1 && /^\\([^()'\"$`]+$/.test(out[0])) out = [out[0].slice(1), ...out.slice(1)];"]], killer: 'nested', dies: /A NESTED SUBSHELL IS CLASSIFIED \(\( GLUED/ },
  { name: 'only the first glued ( is stripped', edits: [[LEAD, LEAD.replace("out[0].replace(/^\\(+/, '')", 'out[0].slice(1)')]], killer: 'nested', dies: /A NESTED SUBSHELL IS CLASSIFIED \(\( GLUED/ },
  { name: 'one glued ) only (the old rule)', edits: [[TAIL, "  return out.length > 1 && /^[^()'\"$`]+\\)$/.test(last) ? [...out.slice(0, -1), last.slice(0, -1)] : out;"]], killer: 'nested', dies: /A NESTED SUBSHELL IS CLASSIFIED \)\) GLUED/ },
  { name: 'only the last glued ) is stripped', edits: [[TAIL, TAIL.replace("last.replace(/\\)+$/, '')", 'last.slice(0, -1)')]], killer: 'nested', dies: /A NESTED SUBSHELL IS CLASSIFIED \)\) GLUED/ },
  { name: 'a ) standing alone stays a word', edits: [[ALONE, '']], killer: 'alone', dies: /A \) STANDING ALONE IS NOT A PATH/ },
];

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
