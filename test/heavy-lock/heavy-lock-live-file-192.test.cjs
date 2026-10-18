'use strict';
/**
 * HEAVY-LOCK-LIVE-FILE-192. The lock admitted, while Andy held the slot, a single LIVE test file
 * (about 40 s of real job helpers, probes and holds) and mutant loops run through a variable
 * script path, because both read light. The commands below are the floor's own (2026-10-17).
 *
 * (a) A test file that spawns real CLIs or helpers, or does sustained work, is heavy: it DECLARES
 *     `// @heavy-lock live` near its top, it is on the known live-file list, it loads the Electron
 *     harness runner, it is a wall-clock perf gate, or it spawns `node --test` of a file it computes.
 * (b) A script or program reached through a variable the command did not set to a literal fails
 *     closed: heavy, provisional (as HEAVY-LOCK-WRAPPER-GAP-192 does for cmd/bash). A variable it
 *     did set is expanded and the named script decides; a loop's `do` is not the program.
 *
 * Named mutants, each must fail this file:
 *   M1 the loop keyword stays the program        M2 named() does not expand
 *   M3 unnamed() is light                        M4 the @heavy-lock live tag is not read
 *   M5 electron-harness/run is not a marker      M6 a perf file is not a bench
 *   M7 --test files are not read                 M8 a computed spawned --test is not a marker
 *   M9 a spawned test file's tag is not read     M10 a leading & is a background operator
 *   M11 & of a variable never asks its arguments M12 a directly run .cjs is not node's
 *   M13 PowerShell's $p = '...' is not recorded  M14 $(...) does not see the outer variables
 *   M15 the known live-file list is empty
 *   M16 a spawned --test option's value is read as a file
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../load-ts.cjs');

const { classifyCommand } = loadTs('src/main/heavyJob.ts');

const S = 'C:/w/scratch';
const MUT = `${S}/mutants-pa.cjs`;
const LIVE = 'test/heavy-cpu-agent-job-192.test.cjs';
/** A light runner of a mutant loop (no bench-like name, so only what it does can make it heavy). */
const LOOP_RUNNER = "const { spawnSync } = require('child_process');\nfor (const m of MUTANTS) spawnSync(process.execPath, ['--test', '--test-name-pattern', process.argv[3] || '.', m.test], { cwd: wt });\n";
const files = {
  [MUT]: LOOP_RUNNER,
  [`${S}/pa.cjs`]: LOOP_RUNNER,
  [`${S}/ok.cjs`]: "console.log('ok');\n",
  // The pid-attach file as it merges: it declares itself (Jim's HLF NIT; the name list is gone).
  [LIVE]: "'use strict';\n// @heavy-lock live: spawns real job helpers and holds them for about 40 s\nconst test = require('node:test');\n",
  'test/tagged.test.cjs': "'use strict';\n// @heavy-lock live: spawns real CLIs\nconst test = require('node:test');\n",
  'test/block-tag.test.cjs': "/**\n * The pid-attach box.\n * @heavy-lock live\n */\nconst test = require('node:test');\n",
  'test/mention.test.cjs': "'use strict';\nconst s = '// @heavy-lock live';\nconst t = require('node:test');\n",
  'test/late-tag.test.cjs': `'use strict';\n${'// filler\n'.repeat(500)}// @heavy-lock live\n`,
  'test/harness.test.cjs': "const { runScenario } = require('./electron-harness/run.cjs');\n",
  'test/plain.test.cjs': "const test = require('node:test');\ntest('x', () => {});\n",
  'test/hive-task-mutation.test.cjs': "const test = require('node:test');\n",
  'test/worker-permission-parity.test.cjs': "const test = require('node:test');\n",
  'test/one-run.test.cjs': "const { spawnSync } = require('child_process');\nspawnSync(process.execPath, ['--test', 'test/plain.test.cjs']);\n",
  'test/self-run.test.cjs': "const { spawnSync } = require('child_process');\nspawnSync(process.execPath, ['--test', __filename]);\n",
  'test/runs-live.test.cjs': "const { spawnSync } = require('child_process');\nspawnSync(process.execPath, ['--test', '--test-name-pattern', 'LIVE', 'test/tagged.test.cjs']);\n",
  'test/valued.test.cjs': "const { spawnSync } = require('child_process');\nspawnSync(process.execPath, ['--test', '--test-name-pattern', pat, 'test/plain.test.cjs']);\n",
  'test/perf/claims-derive-w2.perf.cjs': "const test = require('node:test');\n",
};
const ctx = { readScript: (p) => files[p.replace(/\\/g, '/')] ?? null };
const cls = (cmd) => {
  const c = classifyCommand(cmd, 0, ctx);
  return c.heavy ? (c.provisional ? 'provisional' : `heavy:${c.kind}`) : 'light';
};

test('(a)+(b) the floor\'s own escapes take the slot (all four read light before)', () => {
  const cases = [
    [`timeout 250 node --test ${LIVE}`, 'heavy:bench'],
    [`for i in 1 2 3; do node --test --test-name-pattern "^LIVE: x" ${LIVE} > ${S}/l-$i.tap 2>&1; done`, 'heavy:bench'],
    [`S=${MUT}; for m in K3 L; do node "$S" $m "^([a-z]|WIRING)"; done`, 'heavy:bench'],          // M1, M2
    [`S=${S}; for m in A E; do node $S/mutants-pa.cjs $m "^LIVE"; done 2>&1 | cut -c1-260`, 'heavy:bench'],
  ];
  for (const [cmd, want] of cases) assert.equal(cls(cmd), want, cmd);
});

test('(a) a live test file is heavy as a single node --test run: tag, list, harness, perf, a computed re-run', () => {
  assert.equal(cls('node --test test/tagged.test.cjs'), 'heavy:bench', 'the declared tag (M4)');
  assert.match(classifyCommand('node --test test/tagged.test.cjs', 0, ctx).why, /declares @heavy-lock live/);
  assert.equal(cls('node --test test/block-tag.test.cjs'), 'heavy:bench', 'the tag as a block-comment line');
  assert.equal(cls(`node --test ${LIVE}`), 'heavy:bench', 'the pid-attach file, by its own tag');
  assert.match(classifyCommand(`node --test ${LIVE}`, 0, ctx).why, /declares @heavy-lock live/);
  assert.equal(cls('node --test test/harness.test.cjs'), 'heavy:bench', 'the Electron harness runner (M5)');
  assert.equal(cls('node --test test/perf/claims-derive-w2.perf.cjs'), 'heavy:bench', 'a wall-clock perf gate (M6)');
  assert.equal(cls('node --test test/plain.test.cjs test/tagged.test.cjs'), 'heavy:bench', 'one live file among several (M7)');
  assert.equal(cls(`node --test ${S}/pa.cjs`), 'heavy:bench', 'it spawns node --test of a file it computes (M8)');
  assert.match(classifyCommand(`node ${S}/pa.cjs`, 0, ctx).why, /spawns node --test of a computed file/);
  assert.equal(cls('node test/runs-live.test.cjs'), 'heavy:bench', 'it re-runs a tagged file by name (M9)');
});

test('(a) what stays light: a plain file, a mention of the tag, a late tag, a named or self re-run, bench-like names', () => {
  assert.equal(cls('node --test test/plain.test.cjs'), 'light');
  assert.equal(cls('node --test test/mention.test.cjs'), 'light', 'a string holding the words is not a declaration');
  assert.equal(cls('node --test test/late-tag.test.cjs'), 'light', 'a tag past the top of the file is not read');
  assert.equal(cls('node --test test/one-run.test.cjs'), 'light', 'a named plain file re-run is read, not feared');
  assert.equal(cls('node --test test/self-run.test.cjs'), 'light', '__filename is this file');
  assert.equal(cls('node --test test/valued.test.cjs'), 'light', 'an option\'s computed value is not a file (M16)');
  // The bench-name rule is for scripts: these are ordinary test files.
  assert.equal(cls('node --test test/hive-task-mutation.test.cjs'), 'light');
  assert.equal(cls('node --test test/worker-permission-parity.test.cjs'), 'light');
});

test('(b) a path the lock cannot name fails closed; one this command named is expanded', () => {
  for (const cmd of ['node "$S" K3', 'node $S/x.cjs', 'node --test $P', 'node --test "$P"', 'node --test test/$f.test.cjs',
    'for m in a b; do node "$S" $m; done', '& $exe', '& "$p" K3', '& (Join-Path $d x.cjs)']) {
    assert.equal(cls(cmd), 'provisional', cmd);   // M3 (and M10 for `& "$p" K3`)
  }
  assert.match(classifyCommand('node "$S" K3', 0, ctx).why, /a path the lock cannot name/);
  // Named by this command: the script it names decides (light here, heavy above).
  assert.equal(cls(`S=${S}/ok.cjs; node "$S"`), 'light');
  assert.equal(cls(`P=${S}/pa.cjs; node --test $P`), 'heavy:bench');
  assert.equal(cls(`J=${S}; for f in a b; do echo $(node $J/ok.cjs); done`), 'light', 'M14');
  assert.equal(cls(`J=${S}; for f in a b; do echo $(node $J/pa.cjs); done`), 'heavy:bench', 'M14');
});

test('(b) PowerShell: $p = \'...\' then node $p / & $p, the call operator, a JS file run directly', () => {
  assert.equal(cls(`$p = '${MUT}'; node $p K3`), 'heavy:bench', 'M13');
  assert.equal(cls(`$p='${S}/ok.cjs'; node $p`), 'light', 'M13');
  assert.equal(cls(`$p = '${S}/pa.cjs'; & $p K3`), 'heavy:bench', 'M12, M13');
  assert.equal(cls(`$p = '${S}/ok.cjs'; & $p`), 'light');
  assert.equal(cls(`& "${S}/pa.cjs" K3`), 'heavy:bench', 'M10, M12');
  assert.equal(cls('& $node test/tools/run-tests.cjs'), 'heavy:suite', 'the arguments still name the runner (M11)');
  assert.equal(cls('$p = $(Get-Item x).FullName; & $p'), 'provisional', 'a computed value is never recorded');
  // A lone `&` after a command is still bash's background operator.
  assert.equal(cls('npm test &'), 'heavy:suite');
  assert.equal(cls('sleep 1 & echo hi'), 'light');
  assert.equal(cls('cat x.cjs'), 'light', 'a .cjs as an argument is not run');
});
