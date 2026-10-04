'use strict';
/**
 * HEAVY-LOCK-PRELOAD-ESCAPE (Jim's APOSTROPHE audit, god a2c1b5). Three classifier escapes:
 *  1. node's value flags: `node --require x test/tools/run-tests.cjs` read `x` as the script, so the
 *     suite ran light. Measured (node 20): `node --require ./pre.cjs s.cjs`, `-r` and `--import`
 *     all run the preload THEN s.cjs.
 *  2. A-S2: a `"` after an EVEN run of backslashes closes sh's double quote. Measured in bash:
 *     `echo "a\\"; echo RAN` prints a\ and RAN.
 *  3. Jim's S5 row: in a cmd body `\"` reaches the program as a literal quote (the C runtime).
 * All commands are invented; nothing here runs a process.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { classifyCommand } = loadTs('src/main/heavyJob.ts');

const RUNNER = 'test/tools/run-tests.cjs';
const SUITE = `node ${RUNNER}`;
const heavy = (c) => classifyCommand(c).heavy;

test("node's value flags: the value is not the script", () => {
  for (const c of [
    `node --require x ${RUNNER}`,
    `node -r ./pre.cjs ${RUNNER}`,
    `node --import ./pre.mjs ${RUNNER}`,
    `node --require=x ${RUNNER}`,
    `node -r a -r b --import c ${RUNNER}`,
    `node /c/Dunder/_work/andy-scratch/clean-run.cjs node --require x ${RUNNER}`,
    `node -r x zz-gate-stress.cjs`,
    `node -r x wrap.cjs node ${RUNNER}`,
  ]) assert.equal(heavy(c), true, `SUITE OR BENCH RUNS: ${c}`);
  // A filter after the runner still makes it a filtered run, preload or not.
  assert.equal(heavy(`node --require x ${RUNNER} heavy-lock`), false);
  // -e code is the program: a later word is its argv, not a script.
  assert.equal(heavy(`node -e "1" ${RUNNER}`), false);
  assert.equal(heavy(`node -r x -e "1" ${RUNNER}`), false);
  assert.equal(heavy(`node --eval="1" zz-stress.cjs`), false, 'after --eval= code, a bench name is argv');
  // The script's POSITION decides what follows it, even when a preload has the same text.
  assert.equal(heavy(`node -r ${RUNNER} ${RUNNER}`), true, 'no filter after the script');
  assert.equal(heavy(`node -r wrap.cjs wrap.cjs node ${RUNNER}`), true, 'the wrapped command after the script');
});

test('A-S2: an even run of backslashes does not escape the closing double quote', () => {
  assert.equal(heavy(String.raw`echo "a\\"; ${SUITE}`), true, String.raw`"a\\" closes`);
  assert.equal(heavy(String.raw`echo "a\\\\" && ${SUITE}`), true, 'four backslashes: closed');
  assert.equal(heavy(String.raw`echo "a\\\"; ${SUITE}`), false, 'three: the quote is escaped, still open');
  // The heredoc scan agrees: after "a\\" the <<EOF is real, so its body is data.
  assert.equal(heavy(`echo "a\\\\"; cat <<EOF\n${SUITE}\nEOF`), false, 'heredoc body after "a\\\\"');
  assert.equal(heavy(`echo "a\\\\"; cat <<EOF\nx\nEOF\n${SUITE}`), true, 'and the line after it runs');
});

test("Jim's S5 row: a cmd body's \\\" is a literal quote in the program's argv", () => {
  // cmd gives node `"x` and the runner: `"x` is the script, the runner its argv.
  assert.equal(heavy(String.raw`cmd /c 'node \"x ${RUNNER}'`), false);
  assert.equal(heavy(String.raw`cmd /c 'node "\"" ${RUNNER}'`), false);
});
