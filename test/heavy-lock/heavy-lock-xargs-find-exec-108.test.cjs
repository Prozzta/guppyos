'use strict';
require('../tools/own-job.cjs');
/**
 * HEAVY-LOCK-XARGS-FIND-EXEC-LOOP-108: `ls test/*.test.cjs | xargs -n1 node --test` and
 * `find test -name "*.test.cjs" -exec node --test {} \;` (or `{} +`) were classed light. They run
 * node --test once per item of a list the lock cannot count, exactly as a `for` loop over a glob
 * does, and loopPlan classes that loop a suite. So did `xargs -n1 bash -c 'node --test "$0"'` and
 * `xargs bash -c 'run "$0"'` over an `export -f` function (the FUNC-CALL inliner).
 * Fix: xargs's command and each find -exec command are classified with one item of the list
 * written in (LIST_ITEM: in place of -I's / {} 's replace string, or appended). A node --test that
 * item reaches is a suite, and so is a node --test it never reaches (it still runs once per item).
 * sh's `\;` no longer separates segments, so a second -exec stays on its find.
 * Only pure strings are classified here; nothing is run.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../load-ts.cjs');
const { readSource } = require('../read-source.cjs');

const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { Notification: class { show() {} static isSupported() { return false; } } } };

const HJF = 'src/main/heavyJob.ts';
const HJ = loadTs(HJF);
const G = 'test/*.test.cjs';
const LIST = /once per item of a list the lock cannot count/;
const pick = (c) => ({ heavy: c.heavy, kind: c.kind, provisional: c.provisional === true });

/** Held as a suite for what it runs (not only as unreadable), and the reason names the list. */
function suite(M, cmd, tag, ctx = {}) {
  const c = M.classifyCommand(cmd, 0, ctx);
  assert.equal(c.heavy, true, `${tag}: ${JSON.stringify(cmd)} is heavy (classed ${JSON.stringify(c)})`);
  assert.equal(c.kind, 'suite', `${tag}: ${JSON.stringify(cmd)} is a suite (classed ${JSON.stringify(c)})`);
  assert.notEqual(c.provisional, true, `${tag}: ${JSON.stringify(cmd)} is held for what it runs, not only because it is unreadable`);
  assert.match(c.why, LIST, `${tag}: ${JSON.stringify(cmd)}: the reason names the list (got ${JSON.stringify(c.why)})`);
  return c;
}
function light(M, cmd, tag, ctx = {}) {
  const c = M.classifyCommand(cmd, 0, ctx);
  assert.equal(c.heavy, false, `${tag}: ${JSON.stringify(cmd)} stays light (classed ${JSON.stringify(c)})`);
}

const K = {
  xargs(M) {
    const T = 'XARGS NODE --TEST OVER A LIST IS A SUITE';
    suite(M, `ls ${G} | xargs -n1 node --test`, T);
    suite(M, `ls ${G} | xargs node --test`, `${T} (all items at once)`);
    suite(M, `ls ${G} | xargs -0 -P4 -n 1 node --test`, `${T} (-n 1: a separate value)`);
    suite(M, `ls ${G} | xargs -r -t -- node --test`, `${T} (flags, then --)`);
    suite(M, `ls ${G} | env -u X timeout 400 xargs -n1 env -u Y node --test`, `${T} (prefixes on xargs and on its command)`);
    suite(M, `bash -c 'ls ${G} | xargs -n1 node --test'`, `${T} (inside bash -c)`);
    suite(M, 'xargs -a list.txt node --test', `${T} (-a FILE: a short option with a value)`);
    suite(M, 'xargs --max-args 1 node --test < list.txt', `${T} (--max-args N: a long option with a separate value)`);
    suite(M, 'xargs --max-args=1 node --test < list.txt', `${T} (--max-args=N)`);
  },
  replace(M) {
    const T = 'THE REPLACE STRING IS THE ITEM';
    suite(M, `ls ${G} | xargs -I{} node --test {}`, T);
    suite(M, `ls ${G} | xargs -I {} node --test {}`, `${T} (-I R)`);
    suite(M, `ls ${G} | xargs -I F node --test F`, `${T} (another replace string)`);
    suite(M, `ls ${G} | xargs -I{} bash -c 'node --test {}'`, `${T} (in a bash -c body)`);
    suite(M, `ls ${G} | xargs -I{} sh -c 'node --test "$1"' _ {}`, `${T} (a positional of a bash -c)`);
    suite(M, `ls ${G} | xargs --replace sh -c 'node --test "$1"' _ {}`, `${T} (--replace)`);
    suite(M, `ls ${G} | xargs -i sh -c 'node --test "$1"' _ {}`, `${T} (-i)`);
  },
  unplaced(M) {
    const T = 'A NODE --TEST THE ITEM NEVER REACHES STILL RUNS ONCE PER ITEM';
    suite(M, `ls ${G} | xargs -I{} node --test a.test.cjs`, T);
    suite(M, 'find test -name "*.test.cjs" -exec node --test a.test.cjs \\;', `${T} (find -exec)`);
  },
  findSemi(M) {
    const T = 'FIND -EXEC NODE --TEST {} \\; IS A SUITE';
    suite(M, 'find test -name "*.test.cjs" -exec node --test {} \\;', T);
    suite(M, "find test -name '*.test.cjs' -exec node --test {} ';'", `${T} (a quoted ;)`);
    suite(M, 'find test -name "*.test.cjs" -execdir node --test {} \\;', `${T} (-execdir)`);
    suite(M, 'find test -name "*.test.cjs" -ok node --test {} \\;', `${T} (-ok)`);
    suite(M, 'find test -name "*.test.cjs" -exec env -u X timeout 400 node --test {} \\;', `${T} (prefixes on the command)`);
    suite(M, 'find test -name "*.test.cjs" -exec node --test {} \\; -print', `${T} (an action after it)`);
    suite(M, 'find test -name "*.test.cjs" -exec bash -c \'node --test "$0"\' {} \\;', `${T} (a positional of a bash -c)`);
  },
  secondExec(M) {
    const T = 'A SECOND -EXEC AFTER \\; STAYS ON ITS FIND';
    suite(M, 'find test -name "*.test.cjs" -exec grep -l x {} \\; -exec node --test {} \\;', T);
    suite(M, "find test -name '*.test.cjs' -exec grep -l x {} ';' -exec node --test {} ';'", `${T} (a quoted ;)`);
  },
  findPlus(M) {
    const T = 'FIND -EXEC NODE --TEST {} + IS A SUITE';
    suite(M, 'find test -name "*.test.cjs" -exec node --test {} +', T);
    suite(M, 'find test -name "*.test.cjs" -exec grep -l x {} + -exec node --test {} +', `${T} (after a {} + clause)`);
  },
  xargsBash(M) {
    const T = 'XARGS BASH -C OVER A NODE --TEST FUNCTION IS A SUITE';
    suite(M, `run(){ node --test "$1"; }; export -f run; ls ${G} | xargs -n1 bash -c 'run "$0"'`, T);
    suite(M, `run(){ env -u X timeout 400 node --test "$1"; }; export -f run; ls ${G} | xargs -n1 bash -c 'run "$0"'`, `${T} (the card's body)`);
    suite(M, `ls ${G} | xargs -n1 bash -c 'node --test "$0"'`, `${T} (written inline)`);
    suite(M, `run(){ node --test "$1"; }; export -f run; find test -name "*.test.cjs" -exec bash -c 'run "$0"' {} \\;`, `${T} (find -exec)`);
  },
  escapes(M) {
    // Jim MUST 1: `\\` is one escaped backslash, so the `;` after it separates (int held these too).
    const T = 'AN ESCAPED BACKSLASH DOES NOT ESCAPE THE ; AFTER IT';
    for (const [cmd, kind] of [
      [String.raw`echo \\; npm test`, 'suite'],
      [String.raw`echo a\\; npm test`, 'suite'],
      [String.raw`echo \\\\; npm test`, 'suite'],
      [String.raw`echo \\;npm test`, 'suite'],
      [String.raw`echo x \\; node --test`, 'suite'],
      [String.raw`printf '%s' \\; npm ci`, 'install'],
      [String.raw`find . -name x -exec rm {} \\; npm test`, 'suite'],
      [String.raw`echo \;; npm test`, 'suite'],
    ]) {
      const c = M.classifyCommand(cmd, 0, {});
      assert.deepEqual({ heavy: c.heavy, kind: c.kind }, { heavy: true, kind }, `${T}: ${JSON.stringify(cmd)} is held as ${kind} (classed ${JSON.stringify(c)})`);
    }
    light(M, String.raw`echo \; npm test`, `${T}: but one backslash does (the ; is echo's argument)`);
  },
  light(M) {
    const T = 'NOT WIDENED';
    light(M, `ls ${G} | xargs rm`, `${T}: xargs of a command that runs no test`);
    light(M, `ls ${G} | xargs`, `${T}: xargs with no command (echo)`);
    light(M, `ls ${G} | xargs -0 -P4 -n 1 echo`, `${T}: xargs echo`);
    light(M, `ls ${G} | xargs -n1 bash -c 'echo "$0"'`, `${T}: xargs bash -c that runs no test`);
    light(M, 'find test -name "*.log" -delete', `${T}: find with no -exec`);
    light(M, 'find test -name "*.test.cjs" -exec grep -l "x" {} \\;', `${T}: find -exec of a command that runs no test`);
    light(M, 'find test -name "*.test.cjs" -exec grep -l x {} +', `${T}: find -exec {} + of a command that runs no test`);
    light(M, 'node --test test/a.test.cjs', `${T}: one node --test file`);
    // Only `export -f` functions reach the bash xargs starts: an unexported one is as unknown as on int.
    const c = M.classifyCommand(`run(){ node --test "$1"; }; ls ${G} | xargs -n1 bash -c 'run "$0"'`, 0, {});
    assert.deepEqual(pick(c), { heavy: true, kind: 'bench', provisional: true }, `${T}: AN UNEXPORTED FUNCTION DOES NOT REACH XARGS BASH -C (got ${JSON.stringify(c)})`);
  },
};

test('XARGS: xargs node --test over a list is a suite', () => K.xargs(HJ));
test('XARGS -I: the replace string is the item', () => K.replace(HJ));
test('UNPLACED: a node --test the item never reaches still runs once per item', () => K.unplaced(HJ));
test('FIND -EXEC ... \\;: a suite', () => K.findSemi(HJ));
test('FIND: a second -exec after \\; stays on its find', () => K.secondExec(HJ));
test('FIND -EXEC ... {} +: a suite', () => K.findPlus(HJ));
test('XARGS BASH -C: through the FUNC-CALL inliner', () => K.xargsBash(HJ));
test('ESCAPES: an escaped backslash does not escape the ; after it', () => K.escapes(HJ));
test('NOT WIDENED: xargs / find -exec that run no test stay light', () => K.light(HJ));

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
const SH_ESCAPE = String.raw`    if (d === 'sh' && c === '\\' && i + 1 < cmd.length && cmd[i + 1] !== '\n') { cur += c + cmd[i + 1]; i++; continue; }`;
const MUTANTS = [
  { name: 'xargs runs nothing (int)',
    edits: [["  if (bin === 'xargs') {", '  if (false) {']],
    killer: 'xargs', dies: /XARGS NODE --TEST OVER A LIST IS A SUITE: "ls test\/\*\.test\.cjs \| xargs -n1 node --test" is heavy/ },
  { name: 'find -exec runs nothing (int)',
    edits: [["  if (bin === 'find') {", '  if (false) {']],
    killer: 'findSemi', dies: /FIND -EXEC NODE --TEST \{\} \\; IS A SUITE: "find test -name \\"\*\.test\.cjs\\" -exec node --test \{\} \\\\;" is heavy/ },
  { name: 'find -exec {} + runs nothing',
    edits: [["  if (bin === 'find') {", "  if (bin === 'find' && !args.includes('+')) {"]],
    killer: 'findPlus', dies: /FIND -EXEC NODE --TEST \{\} \+ IS A SUITE: "find test -name \\"\*\.test\.cjs\\" -exec node --test \{\} \+" is heavy/ },
  { name: 'a node --test of the item is not named as the list',
    edits: [['      if (files.includes(LIST_ITEM)) return listSuite();\n', '']],
    killer: 'xargsBash', dies: /XARGS BASH -C OVER A NODE --TEST FUNCTION IS A SUITE: .*: the reason names the list/ },
  { name: 'a node --test the item never reaches is light',
    edits: [["  if (c.kind !== 'suite' && prog === 'node' && lead.includes('--test')) return listSuite();", '']],
    killer: 'unplaced', dies: /A NODE --TEST THE ITEM NEVER REACHES STILL RUNS ONCE PER ITEM: .* is heavy/ },
  { name: 'the replace string is not replaced (the item is appended)',
    edits: [['  return replace ? cmd.map((w) => w.split(replace!).join(LIST_ITEM)) : [...cmd, LIST_ITEM];', '  return [...cmd, LIST_ITEM];']],
    killer: 'replace', dies: /THE REPLACE STRING IS THE ITEM \(in a bash -c body\): .*: the reason names the list/ },
  { name: '-I takes no value (its R reads as the command)',
    edits: [["const XARGS_VALUE = 'adEILnPs';", "const XARGS_VALUE = 'adELnPs';"]],
    killer: 'replace', dies: /THE REPLACE STRING IS THE ITEM \(-I R\): .* is heavy/ },
  { name: '-a takes no value (its FILE reads as the command)',
    edits: [["const XARGS_VALUE = 'adEILnPs';", "const XARGS_VALUE = 'dEILnPs';"]],
    killer: 'xargs', dies: /\(-a FILE: a short option with a value\): .* is heavy/ },
  { name: 'a long option does not take the next word as its value',
    edits: [['      if (m && m[2] === undefined && XARGS_LONG_VALUE.has(m[1])) i++;\n', '']],
    killer: 'xargs', dies: /\(--max-args N: a long option with a separate value\): .* is heavy/ },
  { name: "-exec does not end at ;",
    edits: [["      if (w === ';' || w === '\\\\;') break;", "      if (w === '\\\\;') break;"]],
    killer: 'secondExec', dies: /A SECOND -EXEC AFTER \\; STAYS ON ITS FIND \(a quoted ;\): .* is heavy/ },
  { name: '-exec does not end at {} +',
    edits: [["      if (w === '+' && clause[clause.length - 1] === '{}') break;\n", '']],
    killer: 'findPlus', dies: /FIND -EXEC NODE --TEST \{\} \+ IS A SUITE \(after a \{\} \+ clause\): .* is heavy/ },
  { name: "sh's \\; separates segments again (int)",
    edits: [[SH_ESCAPE + '\n', '']],
    killer: 'secondExec', dies: /A SECOND -EXEC AFTER \\; STAYS ON ITS FIND: .* is heavy/ },
  { name: "only `\\;` is an escape (an escaped backslash escapes the ; after it: Jim MUST 1)",
    edits: [[SH_ESCAPE, String.raw`    if (d === 'sh' && c === '\\' && cmd[i + 1] === ';') { cur += '\\;'; i++; continue; }`]],
    killer: 'escapes', dies: /AN ESCAPED BACKSLASH DOES NOT ESCAPE THE ; AFTER IT: "echo \\\\\\\\; npm test" is held as suite/ },
  { name: "xargs's command keeps the outer segment (its bash -c body reads as computed)",
    edits: [['  return at < 0 ? undefined : rest.slice(at).trimStart();', '  return undefined;']],
    killer: 'xargsBash', dies: /XARGS BASH -C OVER A NODE --TEST FUNCTION IS A SUITE: .* is a suite/ },
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
