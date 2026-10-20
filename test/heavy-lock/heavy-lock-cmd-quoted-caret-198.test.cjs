'use strict';

/**
 * HEAVY-LOCK-CMD-QUOTED-CARET-198 (Creed f47f59, god 3994c2; Jim's hidden .bat proof). cmd reads a
 * script line by line, and a `"` still open at the end of a line ends there. Inside the quote a `^`
 * is literal, so `echo "abc^` does not continue onto the next line: real cmd runs the next line
 * (`npm test`). segments() kept the quote open across the newline, so the next line was read as part
 * of the echo's argument and the call was LIGHT; the caret was only the visible case, and an open
 * quote with no caret was missed the same way. Now, in cmd, a newline inside an open quote closes it
 * and separates. In sh a quote still spans lines (bash's rule), and a `^` outside quotes is still a
 * continuation read conservatively (the next line is classified on its own).
 *
 * Mutants that must die: MUTANT CENSUS at the bottom.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../load-ts.cjs');
const { readSource } = require('../read-source.cjs');

const HJF = 'src/main/heavyJob.ts';
const HJ = loadTs(HJF);

const files = {
  'caret.bat': '@echo off\r\necho "abc^\r\nnpm test\r\n',           // the card
  'open.bat': '@echo off\r\necho "abc\r\nnpm test\r\n',              // no caret
  'lf.bat': '@echo off\necho "abc^\nnpm test\n',                     // LF line ends
  'later.bat': '@echo off\r\necho "abc\r\necho x & npm test\r\n',    // the next line has its own separator
  'outside.bat': '@echo off\r\necho abc^\r\nnpm test\r\n',           // a caret outside quotes
  'closed.bat': '@echo off\r\necho "abc^"\r\nnpm test\r\n',          // the quote closes on its line
};
const norm = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');
const ctx = { readScript: (p) => files[norm(p)] ?? null, missingAt: (p) => (files[norm(p)] === undefined ? p : null) };
const suite = (M, cmd, msg, c = ctx) => {
  const r = M.classifyCommand(cmd, 0, c);
  assert.equal(r.heavy && !r.provisional && r.kind, 'suite', `${msg}: ${JSON.stringify(cmd)} -> ${JSON.stringify(r)}`);
};
const light = (M, cmd, msg, c = ctx) => {
  const r = M.classifyCommand(cmd, 0, c);
  assert.equal(r.heavy, false, `${msg}: ${JSON.stringify(cmd)} -> ${JSON.stringify(r)}`);
};
const CMD = { dialect: 'cmd' };

const K = {};

K.caret = (M = HJ) => {
  suite(M, 'caret.bat', 'A CARET IN AN OPEN QUOTE CONTINUES NOTHING: THE NEXT LINE RUNS');
  suite(M, 'cmd /c caret.bat', 'A CARET IN AN OPEN QUOTE CONTINUES NOTHING (CMD /C)');
  suite(M, 'lf.bat', 'A CARET IN AN OPEN QUOTE CONTINUES NOTHING (LF LINE ENDS)');
  suite(M, 'echo "abc^\r\nnpm test', 'A CARET IN AN OPEN QUOTE CONTINUES NOTHING (A CMD BODY)', CMD);
};

K.open = (M = HJ) => {
  suite(M, 'open.bat', 'A QUOTE OPEN AT THE END OF A LINE ENDS THERE');
  suite(M, 'later.bat', 'THE NEXT LINE IS READ OUTSIDE ANY QUOTE');
};

K.kept = (M = HJ) => {
  light(M, 'echo "abc\nnpm test"', 'IN SH A QUOTE SPANS LINES', {});
  light(M, 'echo "abc & npm test', 'A QUOTED & ON ITS OWN LINE IS STILL QUOTED', CMD);
  light(M, 'echo "npm test"', 'A CLOSED QUOTE IS ONE ARGUMENT', CMD);
  suite(M, 'outside.bat', 'A CARET OUTSIDE QUOTES STILL READS THE NEXT LINE');
  suite(M, 'closed.bat', 'A QUOTE CLOSED ON ITS LINE CHANGES NOTHING');
};

// Jim's delta (b59e06): FOLLOWUPS' caretJoin runs on IF/FOR text before segments(); it must not join a
// `^` inside a quote opened on its line, or the body swallows the next line again.
K.body = (M = HJ) => {
  suite(M, 'if exist x echo "abc^\nnpm test', 'AN IF BODY: A QUOTED CARET JOINS NOTHING', CMD);
  suite(M, 'if exist x echo "abc^\r\nnpm test', 'AN IF BODY: A QUOTED CARET JOINS NOTHING (CRLF)', CMD);
  suite(M, 'for %f in (b) do echo "abc^\nnpm test', 'A FOR BODY: A QUOTED CARET JOINS NOTHING', CMD);
  suite(M, 'for /l %i in (1,1,20) do echo "x^\nnpm test', 'A /L BODY: A QUOTED CARET JOINS NOTHING', CMD);
  suite(M, 'if exist x (echo "abc^\nnpm test\n)', 'AN IF BLOCK: A QUOTED CARET JOINS NOTHING', CMD);
  suite(M, 'cmd /c "if exist x echo \\"abc^\nnpm test"', 'AN IF BODY: A QUOTED CARET JOINS NOTHING (CMD /C)');
};

K.join = (M = HJ) => {
  // The line after the loop runs once: one test file there is light, as at a prompt.
  light(M, 'for /l %i in (1,1,20) do echo "x^\nnode --test test/a.test.cjs', 'THE NEXT LINE RUNS ONCE, AFTER THE LOOP', CMD);
  light(M, 'if exist x echo abc ^\nnpm test', 'AN UNQUOTED CARET STILL JOINS', CMD);
  // The quote left open on line 1 ends there, so line 2's `"` opens a new one and its caret is literal.
  suite(M, 'if exist x (\necho "abc\necho "a^\nnpm test\n)', 'A QUOTE ENDS WITH ITS LINE: THE NEXT QUOTE OPENS AGAIN', CMD);
  suite(M, 'if exist x echo ^^\nnpm test', 'AN ESCAPED ^^ JOINS NOTHING', CMD);
  // CONSERVATIVE, not cmd's behaviour (Jim 6cde8c): a ^ + newline also escapes the next line's first
  // character, so real cmd prints `& npm test` as text. Reading it heavy is the safe direction; do not
  // "fix" it to light without teaching caretJoin that escape.
  suite(M, 'if exist x echo "a^^" ^\n& npm test', 'A CARET AFTER A CLOSED QUOTE STILL JOINS', CMD);
};

test('a ^ at the end of a line inside an open quote continues nothing: the next line is classified', () => K.caret());
test('in IF and FOR bodies too: caretJoin does not join a quoted caret', () => K.body());
test('caretJoin still joins an unquoted caret, after a quote closed or ended on an earlier line, and not after ^^', () => K.join());
test('any quote open at the end of a line ends there, and the next line is read outside it', () => K.open());
test('unchanged: sh quotes span lines, a quoted & on one line, a closed quote, a caret outside quotes', () => K.kept());

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

const FIX = "if (q && d === 'cmd' && c === '\\n') { q = null; out.push(cur); cur = ''; continue; }";
const MUTANTS = [
  { name: 'the fix is off', edits: [[FIX, '']], killer: 'caret', dies: /A CARET IN AN OPEN QUOTE CONTINUES NOTHING/ },
  { name: 'every dialect ends a quote at a newline', edits: [[FIX, FIX.replace("d === 'cmd' && ", '')]], killer: 'kept', dies: /IN SH A QUOTE SPANS LINES/ },
  { name: 'the quote ends but the newline does not separate', edits: [[FIX, "if (q && d === 'cmd' && c === '\\n') { q = null; cur += c; continue; }"]], killer: 'caret', dies: /A CARET IN AN OPEN QUOTE CONTINUES NOTHING/ },
  { name: 'the newline separates but the quote stays open', edits: [[FIX, "if (q && d === 'cmd' && c === '\\n') { out.push(cur); cur = ''; continue; }"]], killer: 'open', dies: /THE NEXT LINE IS READ OUTSIDE ANY QUOTE/ },
  { name: 'only a caret before the newline ends the quote', edits: [[FIX, FIX.replace("c === '\\n')", "c === '\\n' && /\\^\\r?$/.test(cur))")]], killer: 'open', dies: /A QUOTE OPEN AT THE END OF A LINE ENDS THERE/ },
  { name: 'caretJoin is the FOLLOWUPS regex (not quote-aware)', edits: [["function caretJoin(s: string): string {", "const caretJoin = (s: string): string => s.replace(/(^|[^^])((?:\\^\\^)*)\\^\\r?\\n/g, '$1$2');\nfunction caretJoinOld(s: string): string {"]], killer: 'body', dies: /A QUOTED CARET JOINS NOTHING/ },
  { name: 'caretJoin joins a ^ inside a quote', edits: [["if (c === '^' && !q) {", "if (c === '^') {"]], killer: 'body', dies: /A QUOTED CARET JOINS NOTHING/ },
  { name: 'caretJoin keeps a quote open across a line end', edits: [["if (c === '\\n') { q = false; out += c; continue; }", "if (c === '\\n') { out += c; continue; }"]], killer: 'join', dies: /A QUOTE ENDS WITH ITS LINE: THE NEXT QUOTE OPENS AGAIN/ },
  { name: 'caretJoin reads ^^ as two carets', edits: [["out += c + (s[i + 1] ?? ''); i++; continue;", 'out += c; continue;']], killer: 'join', dies: /AN ESCAPED \^\^ JOINS NOTHING/ },
  { name: 'caretJoin joins nothing', edits: [["if (nl) { i += nl; continue; }", 'if (nl) { out += c; continue; }']], killer: 'join', dies: /AN UNQUOTED CARET STILL JOINS/ },
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
