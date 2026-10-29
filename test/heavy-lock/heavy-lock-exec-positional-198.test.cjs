'use strict';
require('../tools/own-job.cjs');

/**
 * HEAVY-LOCK-EXEC-POSITIONAL (god 0ccbc3). `exec npm test` replaces the shell with npm test, and
 * `sh -c 'exec "$@"' _ npm test` (the most common positional idiom) does the same; both read LIGHT,
 * as did `command npm test`. Now `exec [-cl] [-a NAME]` and `command [-p]` are prefixes that run what
 * follows; `command -v`/`-V` only looks a name up. Jim's two POSITIONAL NITs (d9add3), folded:
 * - NIT 1: the script of an sh shell is its first operand after the options, so `bash -O extglob
 *   suite.sh` runs suite.sh (it read the option value "extglob" as the script: a bench).
 * - NIT 2: the positional assignment check wants NAME= at the start of a word, so
 *   `--test-reporter=$1` is an option filled in, not an assignment (it gave a bench).
 *
 * Mutants that must die: MUTANT CENSUS at the bottom.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../load-ts.cjs');
const { readSource } = require('../read-source.cjs');

const HJF = 'src/main/heavyJob.ts';
const HJ = loadTs(HJF);

const SUITE = { 'suite.sh': 'npm test\n' };
const norm = (p) => p.replace(/\\/g, '/').replace(/^\.\//, '');
const scripts = { readScript: (p) => SUITE[norm(p)] ?? null, missingAt: (p) => (SUITE[norm(p)] === undefined ? p : null) };

const as = (M, cmd, kind, msg, c = {}) => {
  const r = M.classifyCommand(cmd, 0, c);
  assert.equal(r.heavy && !r.provisional && r.kind, kind, `${msg}: ${JSON.stringify(cmd)} -> ${JSON.stringify(r)}`);
};
const bench = (M, cmd, msg) => {
  const r = M.classifyCommand(cmd, 0, {});
  assert.ok(r.heavy && r.provisional, `${msg}: ${JSON.stringify(cmd)} -> ${JSON.stringify(r)}`);
};
const light = (M, cmd, msg) => {
  const r = M.classifyCommand(cmd, 0, {});
  assert.equal(r.heavy, false, `${msg}: ${JSON.stringify(cmd)} -> ${JSON.stringify(r)}`);
};

const K = {};

K.exec = (M = HJ) => {
  as(M, 'exec npm test', 'suite', 'AN exec RUNS WHAT FOLLOWS');
  as(M, `sh -c 'exec "$@"' _ npm test`, 'suite', 'AN exec "$@" RUNS THE ARGUMENTS');
  as(M, `sh -c 'exec "$0" "$@"' npm test`, 'suite', 'AN exec "$0" "$@" RUNS THE ARGUMENTS');
  as(M, `bash -c 'cd x && exec npm "$1"' _ test`, 'suite', 'AN exec RUNS WHAT FOLLOWS (after &&)');
  as(M, 'exec -cl npm test', 'suite', 'AN exec OPTION IS NOT THE PROGRAM');
  as(M, `bash -c 'exec -a x "$@"' _ npm test`, 'suite', 'AN exec -a TAKES A NAME');
  as(M, 'exec -la x npm test', 'suite', 'AN exec -a TAKES A NAME (-la)');
  bench(M, `sh -c 'exec "$@"' _ npm "$T"`, 'A COMPUTED exec ARGUMENT IS UNKNOWN');
  light(M, 'exec >log 2>&1', 'AN exec WITH ONLY REDIRECTS RUNS NOTHING');
  light(M, `sh -c 'exec "$@"' _ echo test`, 'A LIGHT exec STAYS LIGHT');
};

K.command = (M = HJ) => {
  as(M, 'command npm test', 'suite', 'A command RUNS WHAT FOLLOWS');
  as(M, 'command -p npm test', 'suite', 'A command -p RUNS WHAT FOLLOWS');
  light(M, 'command -v npm test', 'A command -v ONLY LOOKS UP');
  light(M, 'command -V npm', 'A command -V ONLY LOOKS UP');
  as(M, 'builtin exec npm test', 'suite', 'A builtin RUNS ITS BUILTIN (exec)');
  as(M, `sh -c 'builtin command "$@"' _ npm test`, 'suite', 'A builtin RUNS ITS BUILTIN (command)');
  light(M, 'builtin echo npm test', 'A builtin echo STAYS LIGHT');
};

K.script = (M = HJ) => {
  as(M, 'bash -O extglob suite.sh', 'suite', 'THE SCRIPT IS THE FIRST OPERAND (-O)', scripts);
  as(M, 'bash -o posix suite.sh', 'suite', 'THE SCRIPT IS THE FIRST OPERAND (-o)', scripts);
  as(M, 'bash +o history suite.sh', 'suite', 'THE SCRIPT IS THE FIRST OPERAND (+o)', scripts);
  as(M, 'bash --rcfile x suite.sh', 'suite', 'THE SCRIPT IS THE FIRST OPERAND (--rcfile)', scripts);
  as(M, 'sh -x ./suite.sh -c', 'suite', 'THE SCRIPT IS THE FIRST OPERAND (-x, own -c)', scripts);
};

K.assign = (M = HJ) => {
  as(M, `bash -c 'npm --x=$1 test' _ y`, 'suite', 'AN OPTION=$1 IS FILLED, NOT AN ASSIGNMENT');
  light(M, `bash -c 'node --test --test-reporter=$1 test/b.test.cjs' _ spec`, 'AN OPTION=$1 IS FILLED (reporter)');
  bench(M, `bash -c 'x=$1; npm $x' _ test`, 'AN ASSIGNMENT FROM A POSITIONAL IS UNKNOWN');
  bench(M, `bash -c 'echo hi;x=$1; npm $x' _ test`, 'AN ASSIGNMENT FROM A POSITIONAL IS UNKNOWN (after ;)');
  bench(M, `bash -c 'export x=$1; npm $x' _ test`, 'AN ASSIGNMENT FROM A POSITIONAL IS UNKNOWN (export)');
};

test('exec runs what follows: exec npm test, sh -c \'exec "$@"\' _ npm test', () => K.exec());
test('command runs what follows; command -v / -V only looks up', () => K.command());
test('an sh shell\'s script is its first operand after the options (Jim NIT 1)', () => K.script());
test('a positional assignment needs NAME= at the start of a word (Jim NIT 2)', () => K.assign());

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

const EXEC = "    if (w === 'exec') { i++; while (i < ws.length && /^-/.test(ws[i])) { if (/^-[cl]*a$/.test(ws[i])) i++; i++; } continue; }\n";
const COMMAND = "    if (w === 'command') { i++; while (i < ws.length && /^-/.test(ws[i])) { if (/[vV]/.test(ws[i])) return []; i++; } continue; }\n";
const MUTANTS = [
  { name: 'exec is not a prefix', edits: [[EXEC, '']], killer: 'exec', dies: /AN exec RUNS WHAT FOLLOWS/ },
  { name: 'exec options are not skipped', edits: [[EXEC, "    if (w === 'exec') { i++; continue; }\n"]], killer: 'exec', dies: /AN exec OPTION IS NOT THE PROGRAM/ },
  { name: 'exec -a takes no name', edits: [['if (/^-[cl]*a$/.test(ws[i])) i++; ', '']], killer: 'exec', dies: /AN exec -a TAKES A NAME/ },
  { name: 'command is not a prefix', edits: [[COMMAND, '']], killer: 'command', dies: /A command RUNS WHAT FOLLOWS/ },
  { name: 'builtin is not a prefix', edits: [["    if (w === 'builtin') { i++; continue; }\n", '']], killer: 'command', dies: /A builtin RUNS ITS BUILTIN \(exec\)/ },
  { name: 'command -v runs the name', edits: [['if (/[vV]/.test(ws[i])) return []; ', '']], killer: 'command', dies: /A command -v ONLY LOOKS UP/ },
  { name: 'the script is the first word without a dash', edits: [['const script = sh ? args[sh.body] : undefined;', "const script = sh ? args.find((a) => !a.startsWith('-')) : undefined;"]], killer: 'script', dies: /THE SCRIPT IS THE FIRST OPERAND \(-O\)/ },
  { name: 'any NAME= before a positional is an assignment', edits: [['/(?:^|[\\s;&|(){}])[A-Za-z_][A-Za-z0-9_]*=\\S*$/', '/[A-Za-z_][A-Za-z0-9_]*=\\S*$/']], killer: 'assign', dies: /AN OPTION=\$1 IS FILLED, NOT AN ASSIGNMENT/ },
  { name: 'NAME= only at the start of the body', edits: [['/(?:^|[\\s;&|(){}])[A-Za-z_][A-Za-z0-9_]*=\\S*$/', '/^[A-Za-z_][A-Za-z0-9_]*=\\S*$/']], killer: 'assign', dies: /AN ASSIGNMENT FROM A POSITIONAL IS UNKNOWN \(after ;\)/ },
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
