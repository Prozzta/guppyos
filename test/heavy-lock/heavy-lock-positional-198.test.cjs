'use strict';

/**
 * HEAVY-LOCK-POSITIONAL-192 (god 3d0379). In a single-quoted sh -c body the positional arguments
 * ($0-$9, ${N}, $@, $*, "$@") come from the words after the body: `bash -c 'npm "$1"' _ test` runs
 * npm test, `sh -c '$0 --test' node` runs node --test. The body was read with the words joined on and
 * `$1` left as a word, so these were LIGHT. Now a literal argument is put in place; a referenced one
 * that is computed or not a plain word (a `$`, a backtick, a quote, a space, shell syntax) makes the
 * body unknown: a provisional bench. `-lc`, `-ec`, `-ic` (-c with other flags) were not read as -c at
 * all (`bash -lc 'npm test'` was light); now they are, for the sh shells only (`-C` is noclobber).
 * cmd /c is untouched.
 *
 * Jim db7493 (NOT YET 2/1/2), folded:
 * - MUST 1: an sh shell's options end at its first operand, so a script's own option with a `c`
 *   (`bash suite.sh -coverage`) is not -c; `bash -c -e 'npm test'` runs its first operand (NIT 2).
 * - MUST 2: a positional in a single quote of the body is the inner shell's; a body with a backslash
 *   or an inner sh -c that references one is unknown (`bash -c 'bash -c "npm $1" _ test'`).
 * - SHOULD / NIT 1: `${1:-test}` (an operator on a positional) and `x=$1; npm $x` are unknown.
 *
 * Mutants that must die: MUTANT CENSUS at the bottom.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../load-ts.cjs');
const { readSource } = require('../read-source.cjs');

const HJF = 'src/main/heavyJob.ts';
const HJ = loadTs(HJF);

const as = (M, cmd, kind, msg) => {
  const r = M.classifyCommand(cmd, 0, {});
  assert.equal(r.heavy && !r.provisional && r.kind, kind, `${msg}: ${JSON.stringify(cmd)} -> ${JSON.stringify(r)}`);
};
const bench = (M, cmd, msg) => {
  const r = M.classifyCommand(cmd, 0, {});
  assert.ok(r.heavy && r.provisional, `${msg}: ${JSON.stringify(cmd)} -> ${JSON.stringify(r)}`);
};
const light = (M, cmd, msg, c = {}) => {
  const r = M.classifyCommand(cmd, 0, c);
  assert.equal(r.heavy, false, `${msg}: ${JSON.stringify(cmd)} -> ${JSON.stringify(r)}`);
};

const K = {};

K.numbered = (M = HJ) => {
  as(M, `bash -c 'npm "$1"' _ test`, 'suite', 'A $1 IS THE FIRST WORD AFTER THE BODY (bash)');
  as(M, `sh -c 'npm $1' _ test`, 'suite', 'A $1 IS THE FIRST WORD AFTER THE BODY (sh)');
  as(M, `zsh -c 'npm $1' _ test`, 'suite', 'A $1 IS THE FIRST WORD AFTER THE BODY (zsh)');
  as(M, `dash -c 'npm "$1"' _ test`, 'suite', 'A $1 IS THE FIRST WORD AFTER THE BODY (dash)');
  as(M, `bash -c 'npm "$1"' _ install`, 'install', 'A $1 IS THE FIRST WORD AFTER THE BODY (install)');
  as(M, `bash -c 'npm "$2"' _ x test`, 'suite', 'A $2 IS THE SECOND WORD');
  as(M, `bash -c '$1 test' _ npm`, 'suite', 'A $1 CAN BE THE PROGRAM');
  as(M, `bash -c 'npm \${1}' _ test`, 'suite', 'A ${1} IS $1');
  as(M, `bash -c 'npm "$1"' _ test && echo ok`, 'suite', 'A $1 IS THE FIRST WORD AFTER THE BODY (then &&)');
  as(M, `bash -c 'npm "$1"' _ test > log 2>&1`, 'suite', 'A $1 IS THE FIRST WORD AFTER THE BODY (redirected)');
  as(M, `/usr/bin/bash -c 'npm "$1"' _ test`, 'suite', 'A $1 IS THE FIRST WORD AFTER THE BODY (a path)');
};

K.zero = (M = HJ) => {
  as(M, `sh -c '$0 --test' node`, 'suite', 'A $0 IS THE WORD RIGHT AFTER THE BODY');
  as(M, `bash -c '$0 test' npm`, 'suite', 'A $0 IS THE WORD RIGHT AFTER THE BODY (bash)');
};

K.all = (M = HJ) => {
  as(M, `bash -c 'npm "$@"' _ test`, 'suite', 'A "$@" IS THE WORDS AFTER $0');
  as(M, `bash -c '"$@"' _ npm test`, 'suite', 'A "$@" IS ONE WORD PER ARGUMENT');
  as(M, `bash -c 'npm "\${@}"' _ test`, 'suite', 'A "${@}" IS "$@"');
  as(M, `bash -c 'npm $*' _ test`, 'suite', 'A $* IS THE WORDS AFTER $0');
  as(M, `bash -c '$@' _ npm test`, 'suite', 'AN UNQUOTED $@ IS THE WORDS AFTER $0');
};

K.computed = (M = HJ) => {
  bench(M, `bash -c 'npm "$1"' _ "$X"`, 'A COMPUTED ARGUMENT IS UNKNOWN');
  bench(M, `bash -c 'npm "$1"' _ $(echo test)`, 'A COMPUTED ARGUMENT IS UNKNOWN ($( ))');
  bench(M, `bash -c 'npm "$1"' _ 'te st'`, 'AN ARGUMENT THAT IS NOT A PLAIN WORD IS UNKNOWN');
  bench(M, `bash -c 'echo $1' _ 'a;npm test'`, 'AN ARGUMENT THAT IS NOT A PLAIN WORD IS UNKNOWN (;)');
  bench(M, `bash -c '"$@"' _ npm "$T"`, 'A COMPUTED ARGUMENT IS UNKNOWN ("$@")');
};

K.operator = (M = HJ) => {
  bench(M, `bash -c 'npm "\${1:-test}"'`, 'AN OPERATOR ON A POSITIONAL IS UNKNOWN (:-)');
  bench(M, `bash -c 'npm "\${1#x}"' _ xtest`, 'AN OPERATOR ON A POSITIONAL IS UNKNOWN (#)');
  light(M, `bash -c 'npm \${#}' _ test`, 'A ${#} IS NOT A POSITIONAL');
};

K.assigned = (M = HJ) => {
  bench(M, `bash -c 'x=$1; npm $x' _ test`, 'A POSITIONAL ASSIGNED TO A VARIABLE IS UNKNOWN');
};

K.inner = (M = HJ) => {
  bench(M, `bash -c 'bash -c "npm $1" _ test'`, 'A POSITIONAL UNDER AN INNER -c IS UNKNOWN');
  bench(M, `bash -c 'bash -c '\\''npm $1'\\'' _ test'`, 'A POSITIONAL UNDER AN INNER -c IS UNKNOWN (quoted)');
  bench(M, `bash -c 'npm \\"$1\\"' _ test`, 'A POSITIONAL IN A BODY WITH A BACKSLASH IS UNKNOWN');
  // `npm '$1'` in the body: the $1 is quoted there, npm gets the text $1.
  light(M, `bash -c 'npm '"'"'$1'"'"'' _ test`, 'A POSITIONAL IN A SINGLE QUOTE OF THE BODY IS NOT FILLED');
  light(M, `bash -c 'echo \\$1; npm \\$1' _ test`, 'AN ESCAPED $1 IS NOT FILLED');
};

// MUST 1: suite.sh runs npm test; the words after it are its own.
const SUITE = { 'suite.sh': 'npm test\n' };
const scripts = { readScript: (p) => SUITE[p.replace(/\\/g, '/').replace(/^\.\//, '')] ?? null, missingAt: (p) => (SUITE[p.replace(/\\/g, '/').replace(/^\.\//, '')] === undefined ? p : null) };
const script = (M, cmd, msg) => {
  const r = M.classifyCommand(cmd, 0, scripts);
  assert.equal(r.heavy && !r.provisional && r.kind, 'suite', `${msg}: ${JSON.stringify(cmd)} -> ${JSON.stringify(r)}`);
};
K.options = (M = HJ) => {
  script(M, 'bash suite.sh -coverage', "A SCRIPT'S OWN OPTION IS NOT -c");
  script(M, 'bash ./suite.sh -fac', "A SCRIPT'S OWN OPTION IS NOT -c (-fac)");
  script(M, 'sh ./suite.sh -concurrency 4', "A SCRIPT'S OWN OPTION IS NOT -c (sh)");
  script(M, 'bash -x suite.sh -check', "A SCRIPT'S OWN OPTION IS NOT -c (after -x)");
  script(M, 'zsh suite.sh -cv', "A SCRIPT'S OWN OPTION IS NOT -c (zsh)");
  script(M, 'bash suite.sh -c', "A SCRIPT'S OWN OPTION IS NOT -c (-c)");
  as(M, `bash -o pipefail -c 'npm test'`, 'suite', 'AN -o TAKES A VALUE');
  as(M, `bash -c -e 'npm test'`, 'suite', 'THE COMMAND STRING IS THE FIRST OPERAND');
};

K.combined = (M = HJ) => {
  as(M, `bash -lc 'npm test'`, 'suite', 'A -lc IS -c');
  as(M, `bash -ec "npm test"`, 'suite', 'A -ec IS -c');
  as(M, `bash -lc 'npm "$1"' _ test`, 'suite', 'A -lc BODY GETS ITS ARGUMENTS');
  as(M, `zsh -ic 'npm "$1"' _ test`, 'suite', 'A -ic BODY GETS ITS ARGUMENTS (zsh)');
};

K.kept = (M = HJ) => {
  light(M, `bash -c 'echo "$1"' _ test`, 'A LIGHT BODY STAYS LIGHT');
  light(M, `bash -c 'echo hi' npm test`, 'THE WORDS AFTER THE BODY RUN NOTHING');
  light(M, `bash -c 'npm "$1"'`, 'A MISSING ARGUMENT IS EMPTY');
  light(M, `bash -c 'npm "$3"' _ a b`, 'A MISSING ARGUMENT IS EMPTY ($3)');
  light(M, `bash -c 'npm $10' _ a b c d e f g h i test`, 'A $10 IS ${1}0');
  light(M, `bash -c 'npm "$1"' _ T=test`, 'A PLAIN WORD WITH = IS LITERAL');
  light(M, `bash -c 'echo "$#"' _ test`, 'A $# IS NOT AN ARGUMENT');
  light(M, `bash -lc 'echo hi'`, 'A LIGHT -lc BODY STAYS LIGHT');
  // `-C` is noclobber: `bash -lC 'npm test'` runs a script named `npm test` (unreadable here: a bench).
  const r = M.classifyCommand(`bash -lC 'npm test'`, 0, { readScript: () => null, missingAt: (p) => p });
  assert.ok(r.heavy && r.provisional, `A -lC IS NOT -c: ${JSON.stringify(r)}`);
  light(M, 'cmd /c echo %1 test', 'CMD /C IS UNTOUCHED');
  light(M, `node --test a.test.cjs b.test.cjs c.test.cjs`, 'a short file list at a prompt is light');
  light(M, `bash -c 'node --test "$@"' _ a.test.cjs b.test.cjs c.test.cjs`, 'THE SAME FILE LIST AS ARGUMENTS IS THE SAME CALL');
};

test('a $1-$9 / ${N} in a single-quoted -c body is the word after the body (bash, sh, zsh, dash)', () => K.numbered());
test('a $0 is the word right after the body', () => K.zero());
test('"$@", ${@}, $@ and $* are the words after $0', () => K.all());
test('a referenced argument that is computed or not a plain word is a provisional bench', () => K.computed());
test('-lc, -ec, -ic are -c (sh shells)', () => K.combined());
test('unchanged: light bodies, missing arguments, $10, $#, -C, cmd /c', () => K.kept());
test('an operator on a positional (${1:-test}, ${1#x}) is a provisional bench (Jim SHOULD)', () => K.operator());
test('a positional assigned to a variable is a provisional bench (Jim NIT 1)', () => K.assigned());
test('a positional under an inner -c or a backslash is unknown; one in a single quote is not filled (Jim MUST 2)', () => K.inner());
test("sh options end at the first operand: a script's own -c... option is its own (Jim MUST 1, NIT 2)", () => K.options());

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
  { name: 'the arguments are not put in', edits: [["        return nested(filled, depth, { ...ctx, dialect: 'sh' }, `${bin} ${args[k]}`);", "        if (filled !== '') return nested(body, depth, { ...ctx, dialect: 'sh' }, `${bin} ${args[k]}`);"]], killer: 'numbered', dies: /A \$1 IS THE FIRST WORD AFTER THE BODY \(bash\)/ },
  { name: '$0 is not an argument', edits: [["lit(params[Number(r)] ?? '')", "lit(params[Number(r) || -1] ?? '')"]], killer: 'zero', dies: /A \$0 IS THE WORD RIGHT AFTER THE BODY/ },
  { name: 'arguments count from the body ($1 is _)', edits: [["lit(params[Number(r)] ?? '')", "lit(params[Number(r) - 1] ?? '')"]], killer: 'numbered', dies: /A \$1 IS THE FIRST WORD AFTER THE BODY/ },
  { name: '${N} is not read', edits: [['/^\\$(?:\\{([^}]*)\\}|(\\d|[@*]))/.exec', '/^\\$(?:(\\d|[@*]))/.exec']], killer: 'numbered', dies: /A \$\{1\} IS \$1/ },
  { name: '$N reads every digit ($10 is the tenth)', edits: [['|(\\d|[@*]))/.exec', '|(\\d+|[@*]))/.exec']], killer: 'kept', dies: /A \$10 IS \$\{1\}0/ },
  { name: '"$@" is one word', edits: [[`r === '@' && q === '"' ? args.join('" "') : `, '']], killer: 'all', dies: /A "\$@" IS ONE WORD PER ARGUMENT/ },
  { name: '$@ / $* start at $0', edits: [['const args = params.slice(1).map(lit);', 'const args = params.map(lit);']], killer: 'all', dies: /A "\$@" IS THE WORDS AFTER \$0|A \$\* IS THE WORDS AFTER \$0|AN UNQUOTED \$@/ },
  { name: 'a computed argument is taken as written', edits: [["if (filled === null) return { heavy: true, kind: 'bench', why: `${bin} ${args[k]} (positional arguments the lock cannot read)`, provisional: true };", "if (filled === null) return nested(body, depth, { ...ctx, dialect: 'sh' }, `${bin} ${args[k]}`);"]], killer: 'computed', dies: /A COMPUTED ARGUMENT IS UNKNOWN|IS NOT A PLAIN WORD/ },
  { name: 'any argument is a plain word', edits: [["if (!/^[\\w@%+=:,./-]*$/.test(w)) unknown = true;", '']], killer: 'computed', dies: /A COMPUTED ARGUMENT IS UNKNOWN/ },
  { name: 'only $-free arguments are checked (a space passes)', edits: [['/^[\\w@%+=:,./-]*$/', '/^[^$`]*$/']], killer: 'computed', dies: /AN ARGUMENT THAT IS NOT A PLAIN WORD IS UNKNOWN/ },
  { name: 'a -lc is not -c', edits: [['if (c < 0 && SH_DASH_C.test(a)) c = i;', "if (c < 0 && a === '-c') c = i;"]], killer: 'combined', dies: /A -lc IS -c/ },
  { name: 'a -lc body is not single-quoted', edits: [['\\s+-[A-Za-z]*c[A-Za-z]*\\s+\'/.test(segment)', "\\s+-c\\s+'/.test(segment)"]], killer: 'combined', dies: /A -lc BODY GETS ITS ARGUMENTS/ },
  { name: '-C is -c', edits: [['const SH_DASH_C = /^-[A-Za-z]*c[A-Za-z]*$/;', 'const SH_DASH_C = /^-[A-Za-z]*c[A-Za-z]*$/i;']], killer: 'kept', dies: /A -lC IS NOT -c/ },
  // Jim db7493.
  { name: 'options go on after the first operand', edits: [['    if (!/^[-+]./.test(a)) break;\n', '']], killer: 'options', dies: /A SCRIPT'S OWN OPTION IS NOT -c/ },
  { name: 'an -o takes no value', edits: [['    if (/^[-+][oO]$|^--(?:rcfile|init-file)$/.test(a)) { i++; continue; }\n', '']], killer: 'options', dies: /AN -o TAKES A VALUE/ },
  { name: 'the command string is the word after -c', edits: [['const from = sh ? sh.body : k + 1;', 'const from = k + 1;']], killer: 'options', dies: /THE COMMAND STRING IS THE FIRST OPERAND/ },
  { name: 'a single quote in the body does not hide a positional', edits: [[`    if (q === "'") { out += c; if (c === "'") q = null; continue; }\n`, '']], killer: 'inner', dies: /A POSITIONAL IN A SINGLE QUOTE OF THE BODY IS NOT FILLED/ },
  { name: 'an inner -c / backslash body is filled', edits: [['    if (nest) unknown = true;\n', '']], killer: 'inner', dies: /A POSITIONAL UNDER AN INNER -c IS UNKNOWN/ },
  { name: 'an operator on a positional is ignored', edits: [['      if (/^[#!]?[\\d@*]/.test(r)) unknown = true;', '']], killer: 'operator', dies: /AN OPERATOR ON A POSITIONAL IS UNKNOWN/ },
  { name: 'an assigned positional is filled', edits: [['    if (/(?:^|[\\s;&|(){}])[A-Za-z_][A-Za-z0-9_]*=\\S*$/.test(out)) unknown = true;', '']], killer: 'assigned', dies: /A POSITIONAL ASSIGNED TO A VARIABLE IS UNKNOWN/ },
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', { timeout: 60_000 }, async (t) => {
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
