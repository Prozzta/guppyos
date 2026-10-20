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

test('a ^ at the end of a line inside an open quote continues nothing: the next line is classified', () => K.caret());
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
