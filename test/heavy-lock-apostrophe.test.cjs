'use strict';
/**
 * HEAVY-LOCK-APOSTROPHE-SWALLOW (Creed's VAR-RUNNER re-audit; god 7acffb). The quote scanner now
 * follows each shell's REAL quoting rules, measured on this machine (bash 5, Windows PowerShell 5.1,
 * cmd.exe) with harmless echo commands:
 *  - bash / PowerShell: a mid-word apostrophe DOES open a quote. `echo don't; X` is a parse error
 *    (nothing runs; rc 2 / 1); `echo don't; X; echo it's` runs only the echo. So the card's headline
 *    case stays light: classifying it heavy would hold a slot for a command that never runs.
 *  - The real misses were (1) a `cmd /c` body read with POSIX quoting (in cmd `'` is an ordinary
 *    character, so `cmd /c "echo don't & npm test"` RUNS npm test), and (2) an ESCAPED quote outside
 *    quotes (`\'` bash, `` `' `` PowerShell, `^"` cmd) read as an opener, swallowing what follows.
 * All commands are invented; nothing here runs a process.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { classifyCommand } = loadTs('src/main/heavyJob.ts');

const SUITE = 'node test/tools/run-tests.cjs';
const heavy = (c) => classifyCommand(c).heavy;

test('cmd /c bodies use cmd quoting: an apostrophe is a plain character there', () => {
  for (const c of [
    `cmd /c "echo don't & ${SUITE}"`,
    `cmd /d /s /c "echo don't && npm test"`,
    `cmd.exe /c "echo it's here || npm ci"`,
    `cmd //c "echo don't & ${SUITE}"`,
  ]) assert.equal(heavy(c), true, `THE SUITE RUNS IN CMD: ${c}`);
  // cmd's own rules: ^ escapes a separator, ; separates nothing, # is not a comment.
  assert.equal(heavy(`cmd.exe /c echo don't ^& ${SUITE}`), false, '^& is a literal &');
  assert.equal(heavy(`cmd /c "echo a; ${SUITE}"`), false, 'in cmd `;` is an argument, not a separator');
  assert.equal(heavy(`cmd /c "echo # & ${SUITE}"`), true, 'no # comments in cmd');
  // A word starting with ' is not quoted in cmd: `'npm' test` runs a program named 'npm' (not found).
  assert.equal(classifyCommand(`'npm' test`, 1, { dialect: 'cmd' }).heavy, false, "cmd: 'npm' is not npm");
  assert.equal(classifyCommand(`'npm' test`).heavy, true, 'sh: it is');
  // A quoted cmd argument still groups.
  assert.equal(classifyCommand(`echo "x & ${SUITE}"`, 1, { dialect: 'cmd' }).heavy, false, 'inside cmd double quotes & is text');
  // Typed in bash, `cmd /c "echo "x & ...""` closes bash's quote before the &: bash itself runs
  // the suite in the background (VAR's mid-word quote reading sees it).
  assert.equal(heavy(`cmd /c "echo "x & ${SUITE}""`), true, 'bash splits on the & first');
});

test('an escaped quote outside quotes is a literal character: what follows runs', () => {
  for (const c of [
    String.raw`echo don\'t; ${SUITE}`,          // bash
    'echo don`\'t; ' + SUITE,                    // PowerShell backtick
    String.raw`echo \"; ${SUITE}`,              // bash escaped double quote
    'echo `"; ' + SUITE,                         // PowerShell escaped double quote
  ]) assert.equal(heavy(c), true, `ESCAPED QUOTE, SUITE RUNS: ${c}`);
  // cmd (a body, read in the cmd dialect): ^" is a literal quote, so the & after it separates.
  assert.equal(classifyCommand(`echo ^"x & ${SUITE}`, 1, { dialect: 'cmd' }).heavy, true, 'cmd ^" escapes the quote');
  assert.equal(classifyCommand(`echo "x & ${SUITE}`, 1, { dialect: 'cmd' }).heavy, false, 'an unescaped " opens (cmd: to the end)');
  // The heredoc scan uses the same rule: after an escaped quote, `<<EOF` is still a heredoc (its body is data).
  assert.equal(heavy(`echo don\\'t; cat <<EOF\n${SUITE}\nEOF`), false, 'a heredoc body after an escaped quote is data');
  // An EVEN run of escapes escapes itself: the quote opens again (bash `\\'` = a backslash, then a quote).
  assert.equal(heavy(String.raw`echo a\\'b; ${SUITE}`), false, '\\\\\' opens a quote (unbalanced: a parse error)');
});

test("A-S1: inside '...' a backslash escapes nothing; cmd has no backslash escape at all", () => {
  // bash: `'a\'` is the string a\ and the quote is closed, so the suite runs.
  assert.equal(heavy(String.raw`echo 'a\'; ${SUITE}`), true, String.raw`'a\' closes`);
  assert.equal(heavy(String.raw`echo 'a\' && ${SUITE}`), true);
  // The heredoc scan agrees: after 'a\' the <<EOF is a real heredoc, so its body is data.
  assert.equal(heavy(`echo 'a\\'; cat <<EOF\n${SUITE}\nEOF`), false, 'heredoc body after a closed single quote');
  assert.equal(heavy(`echo 'a\\'; cat <<EOF\nx\nEOF\n${SUITE}`), true, 'and the line after the terminator runs');
  // cmd: \" is a backslash and a closing quote, so the & after it separates.
  assert.equal(classifyCommand(String.raw`echo "a\" & ${SUITE}`, 1, { dialect: 'cmd' }).heavy, true, 'cmd: no backslash escape');
  // Inside sh's "..." the backslash still escapes the quote: unclosed, a parse error, nothing runs.
  assert.equal(heavy(String.raw`echo "a\"; ${SUITE}`), false, String.raw`sh "a\" stays open`);
  // Words too: 'C:\h\' is one closed word, so the runner after it is the script.
  assert.equal(heavy(String.raw`X='C:\h\' ${SUITE}`), true, String.raw`sh words: 'C:\h\' closes`);
});

test('a cmd body: cmd splits the separators, the C runtime splits each argv (measured)', () => {
  const cmdHeavy = (c) => classifyCommand(c, 1, { dialect: 'cmd' }).heavy;
  // Measured through cmd.exe: `"p\" q r` reaches the program as ONE argument (p" q r), and
  // `a^"b c" d` as `ab c`, `d` (cmd drops the caret; the runtime then sees an opening quote).
  // So bash receives `echo "a"; npm test` and `ab; npm test`: both run npm test. (A direct check of
  // the cmd word reader at depth 0; the classifier opens one wrapper level only.)
  const cmdWords = (c) => classifyCommand(c, 0, { dialect: 'cmd' }).heavy;
  assert.equal(cmdWords(String.raw`bash -c "echo \"a\"; npm test"`), true, String.raw`argv: \" escapes`);
  assert.equal(cmdWords(`bash -c a^"b; npm test"`), true, 'argv: ^" opens a quote');
  // The doubled-quote form (`cmd /s /c ""exe" args"`) reads its body with cmd rules too.
  assert.equal(heavy(`cmd /d /s /c ""C:\\Program Files\\nodejs\\npm.cmd" run x don't & npm test"`), true, 'doubled cmd body: the & separates');
});

test('bash/PowerShell rules kept: a mid-word apostrophe opens a quote, as the shells do', () => {
  // Unbalanced: a parse error in bash (rc 2) and PowerShell (rc 1): nothing runs.
  assert.equal(heavy(`echo don't; ${SUITE}`), false);
  // Balanced: the middle is one quoted string (measured: bash prints "dont; ... its done").
  assert.equal(heavy(`echo don't; ${SUITE}; echo it's done`), false);
  // The usual safe forms stay heavy.
  for (const c of [`git commit -m "it's" && ${SUITE}`, `echo "don't"; ${SUITE}`, `echo 'don''t'; ${SUITE}`, `# don't\n${SUITE}`]) {
    assert.equal(heavy(c), true, c);
  }
  // POSIX forms are unchanged: backslash paths, -e scripts, quoted substitutions.
  assert.equal(heavy(String.raw`cd C:\Dunder\work\ && node test\tools\run-tests.cjs`), true);
  assert.equal(heavy(`node -e "require('x')"`), false);
  assert.equal(heavy(`X="$(${SUITE})"`), true);
});
