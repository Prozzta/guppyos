'use strict';
require('./tools/own-job.cjs');
// Loads test-temp.cjs, which a mutant census mutates: the journal check runs before anything else.
require('./tools/mutant-runner-helper.cjs').gate(__filename);
/**
 * DRILL-TREE-SELF-BUILD-108: the 1.1.83 drill tree is a fixture test/tools/drill-tree-183.cjs builds.
 * This file checks the parts that need no build: where the tree lives, that a tree which is absent or
 * not usable is a FAILURE WITH THE REASON (never a skip, never an unverified path), and that the three
 * files which run the tree get it from the builder. The build itself is proved by the drill files
 * (claims-drill-g36, claims-drill-g63), which run the tree it made.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('./tools/test-temp.cjs');
const D = require('./tools/drill-tree-183.cjs');

const TOOL = path.join(__dirname, 'tools', 'drill-tree-183-build.cjs');
const jail = tempDir('drill-tree-183-');
const quiet = () => {};

test('the location: an own tree, then the fixture root, then the hive cache, then local app data', () => {
  const all = { CLAIMS_DRILL_TREE_183: path.join(jail, 'own'), GUPPY_FIXTURE_ROOT: path.join(jail, 'fx'), HIVE_ROOT: path.join(jail, 'hive'), LOCALAPPDATA: path.join(jail, 'lad') };
  assert.deepEqual(D.treeLocation(all), { tree: path.join(jail, 'own'), managed: false, from: 'CLAIMS_DRILL_TREE_183' });
  delete all.CLAIMS_DRILL_TREE_183;
  assert.deepEqual(D.treeLocation(all), { tree: path.join(jail, 'fx', 'guppy-v1.1.83'), managed: true, from: 'GUPPY_FIXTURE_ROOT' });
  delete all.GUPPY_FIXTURE_ROOT;
  assert.deepEqual(D.treeLocation(all), { tree: path.join(jail, 'hive', 'cache', 'fixtures', 'guppy-v1.1.83'), managed: true, from: 'HIVE_ROOT' });
  delete all.HIVE_ROOT;
  assert.deepEqual(D.treeLocation(all), { tree: path.join(jail, 'lad', 'guppy-test-fixtures', 'guppy-v1.1.83'), managed: true, from: 'LOCALAPPDATA' });
  // the suite's temp jail moves LOCALAPPDATA per file: the real one wins, so every file shares one tree
  assert.equal(D.treeLocation({ ...all, GUPPY_SHARED_LOCALAPPDATA: path.join(jail, 'real') }).tree, path.join(jail, 'real', 'guppy-test-fixtures', 'guppy-v1.1.83'));
  assert.throws(() => D.treeLocation({}), /has no location: set GUPPY_FIXTURE_ROOT/);
});

test('the fixture is never a direct child of _work (the scratch reaper manages those)', () => {
  const { tree } = D.treeLocation({ HIVE_ROOT: 'C:\\Dunder\\hive' });
  assert.equal(path.basename(path.dirname(path.dirname(tree))), 'cache');
  assert.ok(!/[\\/]_work[\\/]/.test(tree), tree);
});

test('an absent tree, asked not to build: a failure that names the tree, the reason and the command', () => {
  const env = { GUPPY_FIXTURE_ROOT: path.join(jail, 'absent-root') };
  assert.throws(() => D.ensureTree({ env, log: quiet, build: false }), (e) => {
    assert.match(e.message, /is not ready: the tree is absent\. Build it: node test\/tools\/drill-tree-183-build\.cjs/);
    assert.ok(e.message.includes(path.join(jail, 'absent-root', 'guppy-v1.1.83')));
    return true;
  });
  assert.equal(fs.existsSync(path.join(jail, 'absent-root')), false, 'a check builds nothing');
});

test('a tree with no stamp is not trusted: a half-built or hand-made folder at the fixture path is a fault', () => {
  const root = path.join(jail, 'unstamped-root');
  const tree = path.join(root, 'guppy-v1.1.83');
  fs.mkdirSync(tree, { recursive: true });
  fs.writeFileSync(path.join(tree, 'package.json'), JSON.stringify({ version: '1.1.83' }));
  assert.match(D.treeFault(tree), /^no \.guppy-fixture\.json/);
  fs.writeFileSync(path.join(tree, D.STAMP), JSON.stringify({ commit: 'f'.repeat(40), recipe: D.RECIPE }));
  assert.match(D.treeFault(tree), /not 6355a8d5d3c2372ddbd31073823f30df6ee3dd81 recipe/);
  fs.writeFileSync(path.join(tree, D.STAMP), JSON.stringify({ commit: D.COMMIT, recipe: D.RECIPE + 1 }));
  assert.match(D.treeFault(tree), /recipe/);
  // the right stamp on the wrong contents is still a fault: the stamp is not the verification
  fs.writeFileSync(path.join(tree, D.STAMP), JSON.stringify({ commit: D.COMMIT, recipe: D.RECIPE }));
  assert.equal(D.treeFault(tree), 'missing electron (node_modules/electron)');
  fs.writeFileSync(path.join(tree, 'package.json'), JSON.stringify({ version: '1.1.84' }));
  assert.equal(D.treeFault(tree), 'package.json is version 1.1.84, not 1.1.83');
});

test("the caller's own tree (CLAIMS_DRILL_TREE_183) is verified and never built or repaired", () => {
  const own = path.join(jail, 'own-tree');
  fs.mkdirSync(own, { recursive: true });
  const before = fs.readdirSync(jail).sort();
  assert.throws(() => D.ensureTree({ env: { CLAIMS_DRILL_TREE_183: own }, log: quiet }), /is not a usable 1\.1\.83 tree: missing or unreadable package\.json\. It is the caller's own tree and is not built here/);
  assert.deepEqual(fs.readdirSync(own), []);
  assert.deepEqual(fs.readdirSync(jail).sort(), before, 'no lock, no build folder beside it');
});

test('drillTree gives the same failure every time in one process: one build attempt, not one per test', () => {
  const env = { CLAIMS_DRILL_TREE_183: path.join(jail, 'never') };
  let first;
  try { D.drillTree({ env, log: quiet }); } catch (e) { first = e; }
  assert.match(first.message, /the tree is absent/);
  assert.throws(() => D.drillTree({ env, log: quiet }), (e) => e === first);
});

test('the command line: --check on an absent tree exits 1 with the reason; an unknown flag exits 2 and does nothing', () => {
  const env = { ...D.baseEnv(process.env), GUPPY_FIXTURE_ROOT: path.join(jail, 'cli-root') };
  delete env.CLAIMS_DRILL_TREE_183;
  const run = (...a) => spawnSync(process.execPath, [TOOL, ...a], { env, encoding: 'utf8', windowsHide: true });
  const check = run('--check');
  assert.equal(check.status, 1);
  assert.match(check.stderr, /drill-tree-183: .*is not ready: the tree is absent/);
  const where = run('--path');
  assert.equal(where.status, 0);
  assert.equal(where.stdout.trim(), path.join(jail, 'cli-root', 'guppy-v1.1.83'));
  for (const bad of [['--force'], ['--check', '--path'], ['--help']]) {
    const r = run(...bad);
    assert.equal(r.status, 2, bad.join(' '));
    assert.match(r.stderr, /^usage: /);
  }
  assert.equal(fs.existsSync(path.join(jail, 'cli-root')), false);
});

test('the files that run the tree take it from the builder: no fixed path, no skip', () => {
  for (const rel of ['claims-drill-g36.test.cjs', 'claims-drill-g63.test.cjs', path.join('claims-gates', 'g32.test.cjs')]) {
    const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
    assert.match(src, /drill-tree-183\.cjs'\)/, rel);
    assert.match(src, /drillTree\(/, rel);
    assert.ok(!/drill-trees/.test(src), `${rel} still names the hand-built folder`);
    assert.ok(!/\bskip\s*[(:]|\.skip\b|\btodo\s*:/.test(src), `${rel} can skip`);
  }
  // one run of a file that may build takes the heavy slot; the library has no tag, so this file stays light
  const TAGGED = new RegExp('^// @heavy-' + 'lock live: ', 'm');
  assert.ok(!TAGGED.test(fs.readFileSync(path.join(__dirname, 'tools', 'drill-tree-183.cjs'), 'utf8')));
  for (const rel of ['claims-drill-g36.test.cjs', 'claims-drill-g63.test.cjs', path.join('claims-gates', 'g32.test.cjs'), path.join('tools', 'drill-tree-183-build.cjs')]) {
    assert.match(fs.readFileSync(path.join(__dirname, rel), 'utf8').slice(0, 4096), TAGGED, rel);
  }
});
