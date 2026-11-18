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
  // baseEnv takes ELECTRON_RUN_AS_NODE out. When this file itself runs on Electron as Node, the child is
  // that same Electron and must get the flag back, or it opens an Electron app instead of the script.
  const env = { ...D.baseEnv(process.env), ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}), GUPPY_FIXTURE_ROOT: path.join(jail, 'cli-root') };
  delete env.CLAIMS_DRILL_TREE_183;
  // A regression that opens an Electron app here must fail this file, not hang it (Jim NIT c).
  const run = (...a) => spawnSync(process.execPath, [TOOL, ...a], { env, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  const check = run('--check');
  assert.equal(check.status, 1);
  assert.match(check.stderr, /drill-tree-183: .*is not ready: the tree is absent/);
  const where = run('--path');
  assert.equal(where.status, 0);
  assert.equal(where.stdout.trim(), path.join(jail, 'cli-root', 'guppy-v1.1.83'));
  for (const bad of [['--force'], ['--check', '--path'], ['--rebuild', '--check'], ['--help']]) {
    const r = run(...bad);
    assert.equal(r.status, 2, bad.join(' '));
    assert.match(r.stderr, /^usage: .*\[--check \| --path \| --rebuild\]/);
  }
  assert.equal(fs.existsSync(path.join(jail, 'cli-root')), false);
  // --rebuild is the by-hand command the native-fault error names; a caller's own tree is never rebuilt
  const own = path.join(jail, 'cli-own');
  fs.mkdirSync(own);
  const r = spawnSync(process.execPath, [TOOL, '--rebuild'], { env: { ...env, CLAIMS_DRILL_TREE_183: own }, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /is the caller's own tree and is not built here/);
  assert.deepEqual(fs.readdirSync(own), []);
});

test('the build is refused on Electron as Node, before anything is written; node is not refused', () => {
  assert.match(D.hostFault({ electron: '32.0.0' }), /built on node, not on Electron as Node\. Build it first: node test\/tools\/drill-tree-183-build\.cjs/);
  assert.equal(D.hostFault({ node: '26.0.0' }), null);
  const src = fs.readFileSync(path.join(__dirname, 'tools', 'drill-tree-183.cjs'), 'utf8');
  assert.match(src, /function build\(tree, env, log\) \{\r?\n  const host = hostFault\(\);\r?\n  if \(host\) throw new Error\(host\);/, 'the check is the first thing the build does');
});

// ---- Jim's audit of af1e95de: SHOULD 1 and NIT 1-4 ----

/** A folder that holds everything a 1.1.83 tree must hold (structuralFault passes), with nothing real in it. */
function fakeTree(dir, { stamp = true, mark = 'first' } = {}) {
  const w = (rel, text) => { const f = path.join(dir, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
  const sha = (s) => require('node:crypto').createHash('sha256').update(s).digest('hex');
  w('package.json', JSON.stringify({ version: D.VERSION }));
  w('node_modules/electron/index.js', "module.exports = require('path').join(__dirname, 'electron.bin');");
  w('node_modules/electron/electron.bin', 'not an executable');
  w('test/load-ts.cjs', '');
  const files = { 'onnx/model.onnx': 'model bytes', 'tokenizer.json': '{}' };
  w('resources/models/native-memory-manifest.json', JSON.stringify({ model: { dir: 'm', files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sha(v)])) } }));
  for (const [rel, text] of Object.entries(files)) w(`resources/models/m/${rel}`, text);
  for (const m of ['better-sqlite3', 'sqlite-vec', 'onnxruntime-node', 'typescript']) w(`node_modules/${m}/package.json`, '{}');
  w('MARK', mark);
  if (stamp) w(D.STAMP, JSON.stringify({ commit: D.COMMIT, recipe: D.RECIPE }));
  return dir;
}
const noBuild = () => { throw new Error('the builder was called'); };
const noPause = () => {};
const loads = () => null;
// The host the build is allowed on. This file also runs on Electron as Node, where the real answer is no.
const NODE = { node: '26.0.0' };
const ELECTRON = { node: '24.0.0', electron: '45.0.0' };

test('SHOULD 1: a stamped tree whose native probe fails is probed once more, then a clear error; it is never rebuilt and is still there', () => {
  const root = path.join(jail, 's1-root');
  const tree = fakeTree(path.join(root, D.NAME));
  assert.equal(D.structuralFault(tree), null, 'the fixture of this test is a structurally whole tree');
  const env = { GUPPY_FIXTURE_ROOT: root };
  let probes = 0;
  const logs = [];
  assert.throws(() => D.ensureTree({ env, log: (m) => logs.push(m), nativeProbe: () => { probes++; return 'exit null, spawnSync ETIMEDOUT'; }, builder: noBuild, pause: noPause }), (e) => {
    assert.match(e.message, /is stamped but its native modules do not load: exit null, spawnSync ETIMEDOUT\. Nothing was deleted/);
    assert.match(e.message, /rebuild it by hand: node test\/tools\/drill-tree-183-build\.cjs --rebuild$/);
    assert.ok(e.message.includes(tree));
    return true;
  });
  assert.equal(probes, 2, 'one retry, no more');
  assert.equal(fs.readFileSync(path.join(tree, 'MARK'), 'utf8'), 'first', 'the tree another test may be running from is untouched');
  assert.equal(D.structuralFault(tree), null);
  assert.deepEqual(fs.readdirSync(root), [D.NAME], 'no lock, no build folder: the build path was never entered');
  assert.ok(logs.some((l) => /native probe failed .*trying once more/.test(l)), logs.join('\n'));

  // one failed probe (a slow spawn on a loaded machine) and then a good one: the tree is used as it is
  probes = 0;
  assert.equal(D.ensureTree({ env, log: quiet, nativeProbe: () => (++probes === 1 ? 'slow' : null), builder: noBuild, pause: noPause }), tree);
  assert.equal(probes, 2);
  // a check (build: false) gives the same answer and deletes nothing either
  assert.throws(() => D.ensureTree({ env, log: quiet, build: false, nativeProbe: () => 'still no', builder: noBuild, pause: noPause }), /stamped but its native modules do not load: still no/);
  assert.equal(fs.readFileSync(path.join(tree, 'MARK'), 'utf8'), 'first');
});

test('SHOULD 1 + NIT 3: a structural fault is what builds, and the build says which path it chose and why', () => {
  const root = path.join(jail, 's1b-root');
  const tree = fakeTree(path.join(root, D.NAME), { stamp: false });
  const logs = [];
  let built = 0;
  const builder = (t) => { built++; assert.equal(t, tree); fs.writeFileSync(path.join(t, D.STAMP), JSON.stringify({ commit: D.COMMIT, recipe: D.RECIPE })); };
  assert.equal(D.ensureTree({ env: { GUPPY_FIXTURE_ROOT: root }, log: (m) => logs.push(m), nativeProbe: loads, builder, pause: noPause, versions: NODE }), tree);
  assert.equal(built, 1);
  assert.ok(logs.includes(`building the ${D.VERSION} tree at ${tree} (location from GUPPY_FIXTURE_ROOT): no ${D.STAMP} (the build did not finish, or this file did not build the tree)`), logs.join('\n'));
  assert.deepEqual(fs.readdirSync(root), [D.NAME], 'the lock is released');
  // a model file that no longer matches its digest is structural too
  fs.writeFileSync(path.join(tree, 'resources', 'models', 'm', 'tokenizer.json'), '{"changed":1}');
  assert.match(D.structuralFault(tree), /^model file tokenizer\.json is /);
  assert.throws(() => D.ensureTree({ env: { GUPPY_FIXTURE_ROOT: root }, log: quiet, nativeProbe: loads, builder: () => { built++; }, pause: noPause, versions: NODE }), /was built at .* and does not verify: model file tokenizer\.json/);
  assert.equal(built, 2);
});

test('NIT 1: a location that would put the tree under a _work folder is refused, by name and through a link', () => {
  for (const env of [
    { GUPPY_FIXTURE_ROOT: 'C:\\Dunder\\_work' },
    { GUPPY_FIXTURE_ROOT: path.join(jail, '_WORK', 'deeper') },
    { HIVE_ROOT: path.join(jail, '_work', 'hive') },
    { LOCALAPPDATA: path.join(jail, '_work', 'lad') },
  ]) {
    assert.throws(() => D.treeLocation(env), /is under a _work folder\. The scratch reaper manages _work and would delete the fixture: point (GUPPY_FIXTURE_ROOT|HIVE_ROOT) at a folder outside _work/, JSON.stringify(env));
    assert.throws(() => D.ensureTree({ env, log: quiet, builder: noBuild }), /under a _work folder/);
  }
  assert.equal(fs.existsSync(path.join(jail, '_work')), false, 'a refusal makes nothing');
  // a name that only contains the word is fine
  assert.equal(D.treeLocation({ GUPPY_FIXTURE_ROOT: path.join(jail, 'my_work') }).managed, true);
  // a root that is a link into a _work folder is seen through
  const real = path.join(jail, 'linked', '_work', 'fx');
  fs.mkdirSync(real, { recursive: true });
  const link = path.join(jail, 'fx-link');
  fs.symlinkSync(real, link, 'junction');
  try {
    assert.throws(() => D.treeLocation({ GUPPY_FIXTURE_ROOT: link }), /under a _work folder/);
  } finally { fs.unlinkSync(link); }
  // the caller's own tree is the caller's business: it is never built, so the reaper rule is not ours to apply
  assert.equal(D.treeLocation({ CLAIMS_DRILL_TREE_183: 'C:\\Dunder\\_work\\x' }).managed, false);
});

test('NIT 2: a lock older than the limit is taken over though its pid is alive; a younger one is waited for', () => {
  const root = path.join(jail, 'lock-root');
  const tree = path.join(root, D.NAME);
  const lock = path.join(root, `.lock-${D.NAME}`);
  const hold = (startedMs) => { fs.mkdirSync(lock, { recursive: true }); fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'someone-else', startedMs })); };
  assert.ok(D.LOCK_STALE_MS >= 40 * 60_000 && D.LOCK_WAIT_MS > D.LOCK_STALE_MS, 'a waiter outlasts a stale lock');

  // this process's own pid stands in for a reused one: alive, and not the builder
  hold(Date.now() - D.LOCK_STALE_MS - 60_000);
  const logs = [];
  let ran = 0;
  assert.equal(D.withLock(tree, (m) => logs.push(m), () => {
    ran++;
    const o = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
    assert.equal(o.pid, process.pid);
    assert.ok(Math.abs(Date.now() - o.startedMs) < 60_000, 'owner.json records when this run started');
    return 'done';
  }, { pause: noPause }), 'done');
  assert.equal(ran, 1);
  assert.match(logs.join('\n'), /build lock of pid \d+ is 41 minutes old, over the 40 minute limit: taking it over/);
  assert.equal(fs.existsSync(lock), false, 'released');

  // a lock that started a minute ago and whose pid is alive is not taken: the waiter gives up at its own limit
  hold(Date.now() - 60_000);
  assert.throws(() => D.withLock(tree, quiet, () => { ran++; }, { waitMs: 30, pause: () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20) }), /another process \(pid \d+\) has been building/);
  assert.equal(ran, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')).token, 'someone-else', 'the live lock is untouched');
  fs.rmSync(lock, { recursive: true, force: true });

  // a run whose lock was taken over while it worked does not remove the new owner's lock when it ends
  D.withLock(tree, quiet, () => { fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'the-one-that-took-over', startedMs: Date.now() })); }, { pause: noPause });
  assert.equal(fs.existsSync(lock), true);
  fs.rmSync(lock, { recursive: true, force: true });
});

test('NIT 4: an old tree that is in use keeps the finished build, the error names it, and the next run adopts it', () => {
  const root = path.join(jail, 'n4-root');
  const tree = fakeTree(path.join(root, D.NAME), { mark: 'old' });
  fs.writeFileSync(path.join(tree, D.STAMP), JSON.stringify({ commit: D.COMMIT, recipe: D.RECIPE + 1 })); // another recipe's tree: structural
  const work = fakeTree(path.join(root, `.building-${D.NAME}-4194300`), { mark: 'new' }); // the finished build of a run that has gone
  const busy = (code) => (from, to) => { if (from === tree) throw Object.assign(new Error(`${code}: resource busy or locked, rename`), { code }); fs.renameSync(from, to); };
  for (const code of ['EBUSY', 'EPERM']) {
    assert.throws(() => D.replaceTree(work, tree, { rename: busy(code), pause: noPause }), (e) => {
      assert.equal(e.keptBuild, work);
      assert.ok(e.message.includes(`could not be replaced (${code}`) && e.message.includes(`The finished build is kept at ${work}`), e.message);
      return true;
    });
    assert.equal(fs.readFileSync(path.join(tree, 'MARK'), 'utf8'), 'old', 'the tree in use is whole');
    assert.equal(fs.readFileSync(path.join(work, 'MARK'), 'utf8'), 'new', 'the build is kept');
  }
  // any other failure of that rename is not swallowed and is not a kept build
  assert.throws(() => D.replaceTree(work, tree, { rename: () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); }, pause: noPause }), (e) => e.code === 'EIO' && !e.keptBuild);

  // the next run, the tree now free: the kept build is adopted; nothing is built again
  fs.mkdirSync(path.join(root, `.tmp-${D.NAME}-4194300`));
  const logs = [];
  assert.equal(D.ensureTree({ env: { GUPPY_FIXTURE_ROOT: root }, log: (m) => logs.push(m), nativeProbe: loads, builder: noBuild, pause: noPause, versions: NODE }), tree);
  assert.equal(fs.readFileSync(path.join(tree, 'MARK'), 'utf8'), 'new');
  assert.ok(logs.includes(`adopting the finished build an earlier run kept: ${work}`), logs.join('\n'));
  assert.deepEqual(fs.readdirSync(root), [D.NAME], 'the kept build, the replaced tree, the dead run\'s temp folder and the lock are gone');

  // a .building-* folder that is not a finished build (no stamp) is never adopted: it is cleared and the build runs
  fs.rmSync(path.join(tree, D.STAMP));
  fakeTree(path.join(root, `.building-${D.NAME}-4194301`), { stamp: false, mark: 'half' });
  let built = 0;
  D.ensureTree({ env: { GUPPY_FIXTURE_ROOT: root }, log: quiet, nativeProbe: loads, pause: noPause, versions: NODE, builder: (t) => { built++; fs.writeFileSync(path.join(t, D.STAMP), JSON.stringify({ commit: D.COMMIT, recipe: D.RECIPE })); } });
  assert.equal(built, 1);
  assert.equal(fs.readFileSync(path.join(tree, 'MARK'), 'utf8'), 'new');
  assert.deepEqual(fs.readdirSync(root), [D.NAME]);
});

// A folder outside the fixture root with one file in it, and a junction to it at `link`.
function plant(link, name) {
  const victim = path.join(jail, name);
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, 'keep.txt'), 'not ours');
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(victim, link, 'junction');
  return victim;
}
const kept = (victim) => fs.readdirSync(victim).join() === 'keep.txt' && fs.readFileSync(path.join(victim, 'keep.txt'), 'utf8') === 'not ours';

test('Jim SHOULD: on Electron as Node a tree that needs a build is refused before the lock and before any delete', () => {
  const root = path.join(jail, 'host-root');
  const tree = fakeTree(path.join(root, D.NAME), { stamp: false });
  const old = path.join(root, `.old-${D.NAME}-4194300`);
  const victim = plant(path.join(old, 'inner', 'link'), 'host-victim');
  const work = fakeTree(path.join(root, `.building-${D.NAME}-4194301`), { mark: 'new' }); // would be adopted
  const before = fs.readdirSync(root).sort();
  const env = { GUPPY_FIXTURE_ROOT: root };
  for (const rebuild of [false, true]) {
    assert.throws(() => D.ensureTree({ env, log: quiet, rebuild, nativeProbe: loads, builder: noBuild, pause: noPause, versions: ELECTRON }), (e) => {
      assert.match(e.message, /^the 1\.1\.83 tree is built on node, not on Electron as Node\. Build it first: node test\/tools\/drill-tree-183-build\.cjs \(/);
      assert.match(e.message, /nothing was written or deleted\)$/);
      assert.ok(e.message.includes(tree));
      return true;
    });
    assert.deepEqual(fs.readdirSync(root).sort(), before, 'no lock was taken, no leftover cleared, no kept build moved in');
    assert.equal(fs.readFileSync(path.join(tree, 'MARK'), 'utf8'), 'first');
    assert.equal(fs.readFileSync(path.join(work, 'MARK'), 'utf8'), 'new');
    assert.ok(fs.lstatSync(path.join(old, 'inner', 'link')).isSymbolicLink(), 'the planted link is still there');
    assert.ok(kept(victim), 'the folder the link points at is whole');
  }
  // the order in the source: the host is asked before the lock is taken
  const src = fs.readFileSync(path.join(__dirname, 'tools', 'drill-tree-183.cjs'), 'utf8');
  const body = src.slice(src.indexOf('\nfunction ensureTree('));
  const refusal = body.indexOf('if (host) throw new Error(');
  assert.ok(refusal > 0 && refusal < body.indexOf('return withLock('), 'the refusal precedes the lock');
  assert.ok(!/\bfs\.rmSync\(/.test(src), 'no recursive fs.rmSync in the library: it follows junctions on Electron');

  // on node the same root builds: the kept build is adopted, and clearing the leftover does not go through its link
  assert.equal(D.ensureTree({ env, log: quiet, nativeProbe: loads, builder: noBuild, pause: noPause, versions: NODE }), tree);
  assert.equal(fs.readFileSync(path.join(tree, 'MARK'), 'utf8'), 'new');
  assert.deepEqual(fs.readdirSync(root), [D.NAME]);
  assert.ok(kept(victim), 'the leftover is removed, the folder its link pointed at is not emptied');
});

test('Jim SHOULD: rmTree unlinks a link and never enters it; an .asar file is a file', () => {
  const dir = path.join(jail, 'rm-dir');
  const victim = plant(path.join(dir, 'a', 'b', 'link'), 'rm-victim');
  const noAsar = process.noAsar;
  process.noAsar = true; // Electron's fs would open the name as an archive; this only writes the file
  try { fs.writeFileSync(path.join(dir, 'a', 'app.asar'), 'not an archive'); } finally { process.noAsar = noAsar; }
  fs.writeFileSync(path.join(dir, 'a', 'b', 'ro.txt'), 'x');
  fs.chmodSync(path.join(dir, 'a', 'b', 'ro.txt'), 0o444);
  D.rmTree(dir);
  assert.equal(fs.existsSync(dir), false);
  assert.ok(kept(victim));
  assert.equal(process.noAsar, noAsar, 'the asar switch is put back');
  // the path itself a link: the link goes, its target stays
  const link = path.join(jail, 'rm-link');
  fs.symlinkSync(victim, link, 'junction');
  D.rmTree(link);
  assert.equal(fs.existsSync(link), false);
  assert.ok(kept(victim));
  D.rmTree(path.join(jail, 'rm-absent')); // absent: nothing to do, no error
});

test('Jim NIT a: a waiter that judged a lock stale does not remove the fresh lock another waiter made meanwhile', () => {
  const root = path.join(jail, 'race-root');
  const tree = path.join(root, D.NAME);
  const lock = path.join(root, `.lock-${D.NAME}`);
  const owner = path.join(lock, 'owner.json');
  const hold = (token, startedMs) => { fs.mkdirSync(lock, { recursive: true }); fs.writeFileSync(owner, JSON.stringify({ pid: process.pid, token, startedMs })); };
  hold('dead-one', Date.now() - D.LOCK_STALE_MS - 60_000);
  let ran = 0, swapped = 0;
  // The log line comes after this waiter judged the lock and before it removes it: the other waiter wins there.
  const log = (m) => {
    if (!/taking it over/.test(m) || swapped) return;
    swapped++;
    fs.rmSync(owner); fs.rmdirSync(lock);
    hold('fresh', Date.now());
  };
  assert.throws(() => D.withLock(tree, log, () => { ran++; }, { waitMs: 30, pause: () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20) }), /another process \(pid \d+\) has been building/);
  assert.equal(swapped, 1, 'the takeover was reached');
  assert.equal(ran, 0, 'two builders never run');
  assert.equal(JSON.parse(fs.readFileSync(owner, 'utf8')).token, 'fresh', 'the fresh lock is untouched');
  assert.deepEqual(fs.readdirSync(root), [`.lock-${D.NAME}`], 'no tombstone is left');
  fs.rmSync(owner); fs.rmdirSync(lock);
});

test('Jim NIT b: --rebuild adopts a kept build that verifies instead of clearing it and building again', () => {
  const root = path.join(jail, 'rb-root');
  const tree = fakeTree(path.join(root, D.NAME), { mark: 'old' });
  const work = fakeTree(path.join(root, `.building-${D.NAME}-4194300`), { mark: 'new' });
  const logs = [];
  assert.equal(D.ensureTree({ env: { GUPPY_FIXTURE_ROOT: root }, log: (m) => logs.push(m), rebuild: true, nativeProbe: loads, builder: noBuild, pause: noPause, versions: NODE }), tree);
  assert.equal(fs.readFileSync(path.join(tree, 'MARK'), 'utf8'), 'new');
  assert.ok(logs.includes(`adopting the finished build an earlier run kept: ${work}`), logs.join('\n'));
  assert.deepEqual(fs.readdirSync(root), [D.NAME]);
  // with nothing kept, a rebuild builds
  let built = 0;
  D.ensureTree({ env: { GUPPY_FIXTURE_ROOT: root }, log: quiet, rebuild: true, nativeProbe: loads, pause: noPause, versions: NODE, builder: () => { built++; } });
  assert.equal(built, 1);
});

test('Jim NIT d: a run that finds the tree ready clears what earlier runs left beside it', () => {
  const root = path.join(jail, 'reap-root');
  const tree = fakeTree(path.join(root, D.NAME));
  const env = { GUPPY_FIXTURE_ROOT: root };
  const lock = path.join(root, `.lock-${D.NAME}`);
  const leave = () => {
    fakeTree(path.join(root, `.building-${D.NAME}-4194300`), { mark: 'kept' });
    fs.mkdirSync(path.join(root, `.tmp-${D.NAME}-4194300`), { recursive: true });
    fs.mkdirSync(path.join(root, `.old-${D.NAME}-4194300-1700000000000`), { recursive: true });
    fakeTree(path.join(root, `.building-${D.NAME}-${process.ppid}`), { mark: 'live' }); // a run that is alive
    return fs.readdirSync(root).sort();
  };
  const all = leave();
  const run = (extra) => D.ensureTree({ env, nativeProbe: loads, builder: noBuild, pause: noPause, versions: NODE, log: quiet, ...extra });

  // not on Electron as Node, not on a check, not while a build holds the lock: nothing is touched
  assert.equal(run({ versions: ELECTRON }), tree);
  assert.equal(run({ build: false }), tree);
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, token: 'a-build', startedMs: Date.now() }));
  assert.equal(run(), tree);
  fs.rmSync(path.join(lock, 'owner.json')); fs.rmdirSync(lock);
  assert.deepEqual(fs.readdirSync(root).sort(), all);

  const logs = [];
  assert.equal(run({ log: (m) => logs.push(m) }), tree);
  assert.deepEqual(fs.readdirSync(root).sort(), [`.building-${D.NAME}-${process.ppid}`, D.NAME].sort(), 'the dead runs\' folders are gone; a live run\'s folder and the tree stay');
  assert.equal(fs.readFileSync(path.join(tree, 'MARK'), 'utf8'), 'first', 'a ready tree is never replaced by a kept build');
  assert.ok(logs.includes(`clearing what earlier runs left beside the ready tree at ${tree}`), logs.join('\n'));
  // nothing left to clear: no lock is taken, nothing is said
  logs.length = 0;
  fs.rmSync(path.join(root, `.building-${D.NAME}-${process.ppid}`), { recursive: true, force: true });
  assert.equal(run({ log: (m) => logs.push(m) }), tree);
  assert.deepEqual(logs, []);
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
