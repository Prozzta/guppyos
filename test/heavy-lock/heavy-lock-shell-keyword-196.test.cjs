'use strict';

/**
 * HEAVY-LOCK-SHELL-KEYWORD-196 (god 86030e, split from HEAVY-LOCK-GLOB-LOOP-196). A segment opened
 * by a shell keyword was never classified: its program read as `do` or `then`, so
 * `if true; then npm test; fi` and `while true; do npm ci; done` took no slot. The leading keywords
 * (SHELL_KEYWORDS: do/then/else/if/!/time/...) are not the program now (not in cmd).
 *
 * Mutants that must die: MUTANT CENSUS at the bottom.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../load-ts.cjs');
const { readSource } = require('../read-source.cjs');

const HJF = 'src/main/heavyJob.ts';
const HJ = loadTs(HJF);

const K = {};

K.keywords = (M = HJ) => {
  const c = M.classifyCommand;
  assert.equal(c('if true; then npm test; fi').kind, 'suite', 'A SEGMENT OPENED BY A KEYWORD IS CLASSIFIED (then)');
  assert.equal(c('while true; do npm ci; done').kind, 'install', 'A SEGMENT OPENED BY A KEYWORD IS CLASSIFIED (do)');
  assert.equal(c('for x in 1; do node test/tools/run-tests.cjs; done').kind, 'suite', 'A SEGMENT OPENED BY A KEYWORD IS CLASSIFIED (for ... do)');
  assert.equal(c('if [ -f x ]; then echo y; else npm run build; fi').kind, 'build', 'A SEGMENT OPENED BY A KEYWORD IS CLASSIFIED (else)');
  assert.equal(c('for f in a b; do echo $f; done; npm test').kind, 'suite', 'a segment after the loop is still classified');
};
test('a segment opened by a shell keyword (do, then, else) is classified by its program', () => K.keywords());

K.stacked = (M = HJ) => {
  const c = M.classifyCommand;
  assert.equal(c('if ! npm test; then echo bad; fi').kind, 'suite', 'STACKED KEYWORDS ARE ALL STRIPPED (if !)');
  assert.equal(c('until ! npm run build; do sleep 1; done').kind, 'build', 'STACKED KEYWORDS ARE ALL STRIPPED (until !)');
};
test('stacked keywords (if !, until !) are all stripped', () => K.stacked());

K.light = (M = HJ) => {
  const c = M.classifyCommand;
  for (const cmd of ['if true; then echo hi; fi', 'while read l; do echo "$l"; done < f.txt', 'for f in a b; do echo $f; done', 'if [ -f x ]; then { cat x; }; fi', 'do']) {
    assert.equal(c(cmd).heavy, false, `A KEYWORD-LED LIGHT SEGMENT STAYS LIGHT: ${cmd}`);
  }
};
test('keyword-led light segments stay light (a bare keyword too)', () => K.light());

K.cmdDialect = (M = HJ) => {
  // cmd has no such keywords: `do` there is a program name like any other.
  const c = M.classifyCommand;
  assert.equal(c('do npm test', 0, { dialect: 'cmd' }).heavy, false, 'CMD KEEPS ITS FIRST WORD AS THE PROGRAM');
  assert.equal(c('do npm test').kind, 'suite', 'bash strips it');
};
test('the cmd dialect keeps its first word as the program', () => K.cmdDialect());

K.wiring = (src = readSource(HJF)) => {
  assert.match(src, /const raw = words\(seg\.replace\(\/\\s&\$\/, ''\), d\);\r?\n\s*\/\/ HEAVY-LOCK-SHELL-KEYWORD-196:[^\n]*\n\s*const ws = stripKeywords\(stripRedirects\(raw\), d\);/, 'EVERY SEGMENT IS KEYWORD-STRIPPED BEFORE CLASSIFICATION');
};
test('wiring: every segment strips its leading keywords after its redirects', () => K.wiring());

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
  { name: 'keywords are the program again', edits: [['    const ws = stripKeywords(stripRedirects(raw), d);', '    const ws = stripRedirects(raw);']], killer: 'keywords', dies: /A SEGMENT OPENED BY A KEYWORD IS CLASSIFIED/ },
  { name: 'only one keyword is stripped', edits: [['  while (i < ws.length && SHELL_KEYWORDS.has(ws[i])) i++;', '  if (i < ws.length && SHELL_KEYWORDS.has(ws[i])) i++;']], killer: 'stacked', dies: /STACKED KEYWORDS ARE ALL STRIPPED/ },
  { name: '`do` is not a keyword', edits: [["new Set(['do', 'then',", "new Set(['then',"]], killer: 'keywords', dies: /A SEGMENT OPENED BY A KEYWORD IS CLASSIFIED \(do\)/ },
  { name: '`else` is not a keyword', edits: [["'then', 'else', 'elif',", "'then', 'elif',"]], killer: 'keywords', dies: /A SEGMENT OPENED BY A KEYWORD IS CLASSIFIED \(else\)/ },
  { name: 'cmd strips keywords too', edits: [["  if (d === 'cmd') return ws;\n", '']], killer: 'cmdDialect', dies: /CMD KEEPS ITS FIRST WORD AS THE PROGRAM/ }
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
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
