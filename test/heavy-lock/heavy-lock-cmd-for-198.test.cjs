'use strict';
require('../tools/own-job.cjs');

/**
 * HEAVY-LOCK-CMD-FOR-198 (Jim 74a22b, god a370c8). cmd FOR loops were never classified:
 * `cmd /c "for %f in (a) do npm test"` was LIGHT while `cmd /c "npm test"` is a suite, and a .bat/.cmd
 * FOR (`%%f`) got through the same way (SHELL-KEYWORD-196 keeps cmd's first word as the program, so
 * the FOR's body was never read). Now a cmd FOR is planned as loopPlan plans a bash for:
 *   - the body runs to the end of the line (`&`, `&&`, `|`, `||` included) or, after `do (`, to the
 *     block's `)`; what follows (`) & npm test`, the next lines of a .bat) is classified as it stands;
 *   - a glob, /r, /f or %VAR% set is open; an explicit list counts its values, /l its range; nested
 *     loops multiply; a body that runs node --test over an open set or SUITE_MANY_FILES runs is a suite;
 *   - otherwise each value is classified with %f / %%f / %~f replaced (the live tag is read), as one
 *     iteration of a loop: a loop-made name the lock cannot read stays light (LIVE-FILE (B));
 *   - a /f set's `'command'` runs, so it is classified too.
 * FOLLOWUPS-198 (Jim 87d044): an IF runs its body or its else, not its condition; a %NAME% is not the
 * loop's %n; %~$PATH:n names the value; a line ending in an unescaped ^ goes on to the next one.
 *
 * Mutants that must die: MUTANT CENSUS at the bottom.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../load-ts.cjs');
const { readSource } = require('../read-source.cjs');

const HJF = 'src/main/heavyJob.ts';
const HJ = loadTs(HJF);

// The files the lock can read (a plain test, a live one); anything else is "no such file".
const T = "const t = require('node:test'); t('x', () => {});";
const files = {
  'test/a.test.cjs': T,
  'test/b.test.cjs': T,
  'test/live.test.cjs': `// @heavy-lock live\n${T}`,
  'npm.bat': '@echo off\r\nfor %%f in (a) do npm test\r\n',
  'suite.bat': '@echo off\r\nfor %%f in (test\\*.test.cjs) do node --test %%f\r\n',
  'block.bat': '@echo off\r\nfor %%f in (live) do (\r\n  echo (%%f)\r\n  node --test test\\%%f.test.cjs\r\n)\r\necho done\r\n',
  'after.bat': '@echo off\r\nfor %%f in (a b) do echo %%f\r\nnpm test\r\n',
  'light.bat': '@echo off\r\nfor %%f in (a b) do (\r\n  echo %%f\r\n  node --test test\\%%f.test.cjs\r\n)\r\necho done\r\n',
  // HEAVY-LOCK-CMD-FOR-FOLLOWUPS-198
  'if.bat': '@echo off\r\nif exist test (\r\n  echo found\r\n) else (\r\n  npm test\r\n)\r\n',
  'path.bat': '@echo off\r\nfor %%n in (node) do %%~$PATH:n --test test\\live.test.cjs\r\n',
  'caret.bat': '@echo off\r\nfor /l %%i in (1,1,20) do ^\r\n  node --test test\\a.test.cjs\r\n',
  'carets.bat': '@echo off\r\nfor /l %%i in (1,1,20) do echo ^^\r\n  node --test test\\a.test.cjs\r\n',
};
const norm = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');
const ctx = { readScript: (p) => files[norm(p)] ?? null, missingAt: (p) => (files[norm(p)] === undefined ? p : null) };
const heavyAs = (M, cmd, kind, msg) => {
  const r = M.classifyCommand(cmd, 0, ctx);
  assert.equal(r.heavy && !r.provisional && r.kind, kind, `${msg}: ${cmd} -> ${JSON.stringify(r)}`);
};
const light = (M, cmd, msg) => {
  const r = M.classifyCommand(cmd, 0, ctx);
  assert.equal(r.heavy, false, `${msg}: ${cmd} -> ${JSON.stringify(r)}`);
};
const provisional = (M, cmd, msg) => {
  const r = M.classifyCommand(cmd, 0, ctx);
  assert.equal(r.heavy && r.provisional === true, true, `${msg}: ${cmd} -> ${JSON.stringify(r)}`);
};

const K = {};

K.percentF = (M = HJ) => {
  heavyAs(M, 'cmd /c "for %f in (a) do npm test"', 'suite', 'A CMD FOR RUNS ITS BODY');
  heavyAs(M, 'cmd /c "FOR %F IN (a) DO npm test"', 'suite', 'A CMD FOR RUNS ITS BODY (ANY CASE)');
  heavyAs(M, 'cmd /c "for %f in (live) do node --test test\\%f.test.cjs"', 'bench', 'EACH VALUE IS READ (THE LIVE TAG)');
  heavyAs(M, 'cmd /c "for %f in ("live") do node --test test\\%~f.test.cjs"', 'bench', 'A %~ REF IS REPLACED BY THE VALUE');
};

K.bat = (M = HJ) => {
  heavyAs(M, 'cmd /c npm.bat', 'suite', 'A .BAT FOR (%%f) RUNS ITS BODY');
  heavyAs(M, 'cmd /c suite.bat', 'suite', 'A .BAT FOR OVER A TEST GLOB IS A SUITE');
  heavyAs(M, 'cmd /c block.bat', 'bench', 'A BLOCK BODY RUNS TO ITS OWN )');
  heavyAs(M, 'cmd /c after.bat', 'suite', 'THE LINES AFTER A FOR ARE CLASSIFIED');
  heavyAs(M, 'cmd /c "for %f in (a) do (echo %f) & npm test"', 'suite', 'WHAT FOLLOWS A BLOCK IS CLASSIFIED');
  light(M, 'cmd /c light.bat', 'A .BAT LOOP OVER NAMED LIGHT FILES STAYS LIGHT');
};

K.nested = (M = HJ) => {
  heavyAs(M, 'cmd /c "for %a in (a b c d e) do for %b in (1 2 3 4) do node --test test\\%a.test.cjs"', 'suite', 'NESTED LISTS MULTIPLY (5 x 4 = SUITE_MANY_FILES)');
  heavyAs(M, 'cmd /c "for %a in (l) do for %b in (ive) do node --test test\\%a%b.test.cjs"', 'bench', 'A NESTED LOOP READS BOTH VALUES');
  light(M, 'cmd /c "for %a in (a b c d) do for %b in (1 2 3 4) do node --test test\\a.test.cjs"', 'BELOW SUITE_MANY_FILES A NEST STAYS LIGHT');
};

K.andPipe = (M = HJ) => {
  heavyAs(M, 'cmd /c "for %f in (live) do echo %f && node --test test\\%f.test.cjs"', 'bench', 'A BARE BODY RUNS TO THE END OF THE LINE (&&)');
  heavyAs(M, 'cmd /c "for %f in (live) do echo %f | node --test test\\%f.test.cjs"', 'bench', 'A BARE BODY RUNS TO THE END OF THE LINE (|)');
  light(M, 'cmd /c "for %f in (a b) do echo %f && echo done | more"', 'A LIGHT BODY WITH && AND | STAYS LIGHT');
};

K.openSets = (M = HJ) => {
  heavyAs(M, 'cmd /c "for %f in (test\\*.test.cjs) do node --test test\\a.test.cjs"', 'suite', 'A GLOB SET IS OPEN (A REPEAT LOOP OVER IT)');
  heavyAs(M, 'cmd /c "for /r test %f in (x.test.cjs) do node --test %f"', 'suite', 'A /R WALK IS OPEN');
  heavyAs(M, 'cmd /c "for %f in (%LIST%) do node --test test\\%f.test.cjs"', 'suite', 'A VARIABLE SET IS OPEN');
  heavyAs(M, 'cmd /c "for /f %a in (list.txt) do node --test test\\%a.test.cjs"', 'suite', 'A /F SET IS OPEN');
  heavyAs(M, 'cmd /c "for /f %a in (\'npm test\') do echo %a"', 'suite', 'A /F COMMAND RUNS');
  light(M, 'cmd /c "for /f %a in (\'echo hi\') do echo %a"', 'A LIGHT /F COMMAND STAYS LIGHT');
};

K.counts = (M = HJ) => {
  heavyAs(M, 'cmd /c "for /l %i in (1,1,20) do node --test test\\a.test.cjs"', 'suite', 'A /L RANGE COUNTS ITS RUNS (20)');
  light(M, 'cmd /c "for /l %i in (1,1,19) do node --test test\\a.test.cjs"', 'A /L RANGE BELOW SUITE_MANY_FILES STAYS LIGHT');
  heavyAs(M, 'cmd /c "for /l %i in (1,1,10) do node --test test\\a.test.cjs & node --test test\\b.test.cjs"', 'suite', 'EVERY NODE --TEST OF THE BODY COUNTS');
  heavyAs(M, `cmd /c "for %f in (${Array.from({ length: 20 }, (_, i) => `t${i}`).join(' ')}) do node --test test\\a.test.cjs"`, 'suite', 'AN EXPLICIT LIST OF SUITE_MANY_FILES IS A SUITE');
};

K.light = (M = HJ) => {
  light(M, 'cmd /c "for %f in (a b) do node --test test\\%f.test.cjs"', 'NAMED LIGHT FILES STAY LIGHT');
  light(M, 'cmd /c "for %f in (x y) do node --test test\\%f.test.cjs"', 'A LOOP-MADE NAME IT CANNOT READ STAYS LIGHT');
  light(M, 'cmd /c "for %f in (a b) do echo %f"', 'AN ECHO LOOP STAYS LIGHT');
  light(M, 'cmd /c "for /l %i in (1,1,3) do node --test test\\a.test.cjs"', 'A SHORT /L RANGE STAYS LIGHT');
  assert.equal(M.classifyCommand('do npm test', 0, { dialect: 'cmd' }).heavy, false, 'CMD KEEPS ITS FIRST WORD AS THE PROGRAM (SHELL-KEYWORD-196)');
};

// HEAVY-LOCK-CMD-FOR-FOLLOWUPS-198 (Jim 87d044 NITs): IF bodies, %f against %foo%, %~$PATH:f, ^ continuation.
K.ifBodies = (M = HJ) => {
  heavyAs(M, 'cmd /c "if exist x npm test"', 'suite', 'AN IF RUNS ITS BODY');
  heavyAs(M, 'cmd /c "IF /I NOT %A%==b npm test"', 'suite', 'AN IF RUNS ITS BODY (/I NOT a==b)');
  heavyAs(M, 'cmd /c "if %N% GEQ 3 node --test test\\live.test.cjs"', 'bench', 'AN IF RUNS ITS BODY (a OP b)');
  heavyAs(M, 'cmd /c if.bat', 'suite', 'THE ELSE BODY IS CLASSIFIED');
  heavyAs(M, 'cmd /c "if exist x (echo a) & npm test"', 'suite', 'WHAT FOLLOWS AN IF BLOCK IS CLASSIFIED');
  heavyAs(M, 'cmd /c "for /l %i in (1,1,20) do if exist x node --test test\\a.test.cjs"', 'suite', 'AN IF IN A FOR BODY COUNTS ITS RUNS');
  light(M, 'cmd /c "if exist x echo npm test"', 'THE CONDITION RUNS NOTHING (A LIGHT BODY STAYS LIGHT)');
  light(M, 'cmd /c "if exist x echo a else npm test"', 'A BARE BODY RUNS TO THE END OF ITS LINE (ELSE IS JUST WORDS)');
};

K.names = (M = HJ) => {
  provisional(M, 'cmd /c "for %f in (a) do node --test test\\%foo%.test.cjs"', 'A %NAME% VARIABLE IS NOT THE LOOP VARIABLE');
  provisional(M, 'cmd /c "for %f in (b) do node --test test\\%x%.test.cjs"', 'A ONE-LETTER %x% THAT IS NOT THE LOOP LETTER IS A VARIABLE');
  provisional(M, "cmd /c 'for %f in (b) do node --test test\\!x!.test.cjs'", 'A !x! OF ANY LENGTH IS A VARIABLE');
  provisional(M, 'cmd /c "for %f in (b) do node --test test\\%f%.test.cjs"', 'AT A PROMPT %f% MAY BE AN ENVIRONMENT VARIABLE');
  heavyAs(M, 'cmd /c "for %f in (live) do echo %foo% & node --test test\\%f.test.cjs"', 'bench', 'THE LOOP VARIABLE BESIDE A %NAME% IS STILL REPLACED');
  heavyAs(M, 'cmd /c path.bat', 'bench', 'A %~$PATH: REF NAMES THE VALUE');
};

K.caret = (M = HJ) => {
  heavyAs(M, 'cmd /c caret.bat', 'suite', 'A CARET CONTINUES THE LINE (do ^)');
  light(M, 'cmd /c carets.bat', 'AN ESCAPED CARET (^^) ENDS THE LINE');
};

test('%f: a cmd FOR runs its body; each value is read (the live tag, %~f)', () => K.percentF());
test('%%f in a .bat: the body, a block to its ), and the lines after the loop are classified', () => K.bat());
test('nested FOR loops multiply their lists and read both values', () => K.nested());
test('a bare body with && and | runs to the end of the line', () => K.andPipe());
test('open sets (a glob, /r, %VAR%, /f) are suites when the body runs node --test; a /f command runs', () => K.openSets());
test('/l ranges, explicit lists and every node --test of the body count toward SUITE_MANY_FILES', () => K.counts());
test('what stays light: named light files, a loop-made name it cannot read, echo, a short range, cmd `do`', () => K.light());
test('an IF runs its body (or its else), not its condition; what follows a block is classified', () => K.ifBodies());
test('a %NAME% variable is not the loop variable; %~$PATH:v names the value', () => K.names());
test('a ^ at the end of a line continues it; an escaped ^^ does not', () => K.caret());

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
  { name: 'the FOR is not read', edits: [['if (/^@?(?:for|if)$/i.test(head)) {', 'if (/^@?(?:if)$/i.test(head)) {']], killer: 'percentF', dies: /A CMD FOR RUNS ITS BODY/ },
  { name: 'FOR is read in lower case only', edits: [['if (/^@?(?:for|if)$/i.test(head)) {', 'if (/^@?(?:for|if)$/.test(head)) {']], killer: 'percentF', dies: /ANY CASE/ },
  { name: "a .bat's %%f is not a FOR variable", edits: [['(%%?)([A-Za-z])\\s+in', '(%)([A-Za-z])\\s+in']], killer: 'bat', dies: /A \.BAT FOR \(%%f\) RUNS ITS BODY/ },
  { name: 'a bare body stops at the first & or |', edits: [["const nl = s.indexOf('\\n');", 'const nl = s.search(/[&|\\n]/);']], killer: 'andPipe', dies: /A BARE BODY RUNS TO THE END OF THE LINE/ },
  { name: 'a block ends at the first )', edits: [["if (c === ')' && --n === 0) break;", "if (c === ')') break;"]], killer: 'bat', dies: /A BLOCK BODY RUNS TO ITS OWN \)/ },
  { name: 'what follows the loop is dropped', edits: [['if (loop.rest.trim()) {', 'if (false) {']], killer: 'bat', dies: /THE LINES AFTER A FOR ARE CLASSIFIED/ },
  { name: 'a glob set is counted', edits: [['/[*?%!]/.test(v)', '/[%!]/.test(v)']], killer: 'openSets', dies: /A GLOB SET IS OPEN/ },
  { name: 'a /r walk is counted', edits: [['} else if (!f && !r && !values', '} else if (!f && !values']], killer: 'openSets', dies: /A \/R WALK IS OPEN/ },
  { name: 'a %VAR% set is counted', edits: [['/[*?%!]/.test(v)', '/[*?]/.test(v)']], killer: 'openSets', dies: /A VARIABLE SET IS OPEN/ },
  { name: 'a /f set is counted', edits: [['} else if (!f && !r && !values', '} else if (!r && !values']], killer: 'openSets', dies: /A \/F SET IS OPEN/ },
  { name: "a /f set's command is not classified", edits: [['  if (ran) {', '  if (false) {']], killer: 'openSets', dies: /A \/F COMMAND RUNS/ },
  { name: 'a /l range is one run', edits: [['count = Math.max(0, Math.floor((n[2] - n[0]) / n[1]) + 1);', 'count = 1;']], killer: 'counts', dies: /A \/L RANGE COUNTS ITS RUNS/ },
  { name: 'a /l range is off by one', edits: [['Math.floor((n[2] - n[0]) / n[1]) + 1)', 'Math.floor((n[2] - n[0]) / n[1]))']], killer: 'counts', dies: /A \/L RANGE COUNTS ITS RUNS/ },
  { name: 'more than SUITE_MANY_FILES runs (off by one)', edits: [['runs * tests >= SUITE_MANY_FILES)) {', 'runs * tests > SUITE_MANY_FILES)) {']], killer: 'counts', dies: /A \/L RANGE COUNTS ITS RUNS/ },
  { name: 'one run per body (its node --test segments are not counted)', edits: [["const tests = segments(body, 'cmd').filter(NODE_TEST).length;", "const tests = segments(body, 'cmd').some(NODE_TEST) ? 1 : 0;"]], killer: 'counts', dies: /EVERY NODE --TEST OF THE BODY COUNTS/ },
  { name: 'nested lists do not multiply', edits: [['const runs = count * (ctx.loopMult ?? 1);', 'const runs = count;']], killer: 'nested', dies: /NESTED LISTS MULTIPLY/ },
  { name: 'the variable is not replaced per value', edits: [['  const each = runs !== Infinity && !l && values.length && runs <= PLAN_CAP', '  const each = false']], killer: 'percentF', dies: /EACH VALUE IS READ/ },
  { name: 'a %~ ref is not replaced', edits: [['${m[2]}(?:~[A-Za-z]*', '${m[2]}(?:~~[A-Za-z]*']], killer: 'percentF', dies: /A %~ REF IS REPLACED BY THE VALUE/ },
  { name: 'a lone & in the body hides the FOR (the segment is not found)', edits: [["const own = seg.replace(/\\s+&$/, '');", 'const own = seg;']], killer: 'counts', dies: /EVERY NODE --TEST OF THE BODY COUNTS/ },
  { name: 'the body is not one iteration of a loop (a loop-made name goes provisional)', edits: [['loopWord: !envLetter && !unmade.test(b),', 'loopWord: false,']], killer: 'light', dies: /A LOOP-MADE NAME IT CANNOT READ STAYS LIGHT/ },
  { name: 'any FOR with node --test is a suite (the count is not checked)', edits: [['if (tests && (runs === Infinity || runs * tests >= SUITE_MANY_FILES)) {', 'if (tests) {']], killer: 'light', dies: /NAMED LIGHT FILES STAY LIGHT/ },
  // HEAVY-LOCK-CMD-FOR-FOLLOWUPS-198
  { name: 'the IF is not read', edits: [['if (/^@?(?:for|if)$/i.test(head)) {', 'if (/^@?(?:for)$/i.test(head)) {']], killer: 'ifBodies', dies: /AN IF RUNS ITS BODY/ },
  { name: 'IF /I and NOT are not read', edits: [['/^@?if\\s+(?:\\/i\\s+)?(?:not\\s+)?', '/^@?if\\s+']], killer: 'ifBodies', dies: /\/I NOT a==b/ },
  { name: 'the a OP b condition is not read', edits: [['\\s+(?:equ|neq|lss|leq|gtr|geq)\\s+', '\\s+(?:equ|neq)\\s+']], killer: 'ifBodies', dies: /a OP b/ },
  { name: 'the else body is dropped', edits: [['    bodies.push(other.body);\n', '']], killer: 'ifBodies', dies: /THE ELSE BODY IS CLASSIFIED/ },
  { name: 'what follows an IF block is dropped', edits: [['  let rest = then.after;', "  let rest = '';"]], killer: 'ifBodies', dies: /WHAT FOLLOWS AN IF BLOCK IS CLASSIFIED/ },
  { name: "the condition's operand is read as the program", edits: [['(?:exist|defined)\\s+(?:"[^"]*"|\\S+)|', '(?:exist|defined)|']], killer: 'ifBodies', dies: /^AN IF RUNS ITS BODY:/ },
  { name: 'a bare IF body is split at else', edits: [["  const e = s.startsWith('(') ? /^\\s*else\\s+/i.exec(then.after) : null;", "  const e = s.startsWith('(') ? /^\\s*else\\s+/i.exec(then.after) : null;\n  if (!s.startsWith('(') && / else /i.test(then.body)) bodies.push(then.body.split(/ else /i)[1]);"]], killer: 'ifBodies', dies: /ELSE IS JUST WORDS/ },
  { name: 'a %NAME% variable is replaced as the loop variable', edits: [['(x, name?: string) => name ? x : v', '() => v']], killer: 'names', dies: /A %NAME% VARIABLE IS NOT THE LOOP VARIABLE/ },
  { name: 'a body holding a %NAME% is still all loop-made', edits: [['loopWord: !envLetter && !unmade.test(b),', 'loopWord: true,']], killer: 'names', dies: /A %NAME% VARIABLE IS NOT THE LOOP VARIABLE/ },
  { name: 'a one-letter %x% is not a variable', edits: [['const unmade = /%[A-Za-z_][A-Za-z0-9_]*%|', 'const unmade = /%[A-Za-z_][A-Za-z0-9_]+%|']], killer: 'names', dies: /A ONE-LETTER %x% THAT IS NOT THE LOOP LETTER IS A VARIABLE/ },
  { name: 'a raw %<loop letter>% is loop-made', edits: [['loopWord: !envLetter && !unmade.test(b),', 'loopWord: !unmade.test(b),']], killer: 'names', dies: /AT A PROMPT %f% MAY BE AN ENVIRONMENT VARIABLE/ },
  { name: 'a !x! needs two letters', edits: [['|![^!\\r\\n]+!/;', '|![A-Za-z_][A-Za-z0-9_]+!/;']], killer: 'names', dies: /A !x! OF ANY LENGTH IS A VARIABLE/ },
  { name: 'a one-letter %a% is read as a %NAME% variable', edits: [['(%[A-Za-z_][A-Za-z0-9_]+%)|', '(%[A-Za-z_][A-Za-z0-9_]*%)|']], killer: 'nested', dies: /A NESTED LOOP READS BOTH VALUES/ },
  { name: 'a %~$PATH: ref is not replaced', edits: [['(?:\\\\$[A-Za-z_][A-Za-z0-9_]*:)?', '']], killer: 'names', dies: /A %~\$PATH: REF NAMES THE VALUE/ },
  { name: 'a ^ does not continue the line', edits: [['if (nl) { i += nl; continue; }', 'if (false) { i += nl; continue; }']], killer: 'caret', dies: /A CARET CONTINUES THE LINE/ },
  { name: 'an escaped ^^ continues the line', edits: [["out += c + (s[i + 1] ?? ''); i++; continue;", 'out += c; continue;']], killer: 'caret', dies: /AN ESCAPED CARET \(\^\^\) ENDS THE LINE/ },
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
