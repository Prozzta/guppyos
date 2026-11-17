'use strict';
require('./tools/own-job.cjs');
require('./tools/mutant-runner-helper.cjs').gate(__filename);
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const child = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const scratch = loadTs('src/main/scratchDisk.ts');
const safeRemove = loadTs('src/main/fsSafeRemove.ts');

const jail = fs.mkdtempSync(path.join(os.tmpdir(), 'scratch-disk-'));
test.after(() => fs.rmSync(jail, { recursive: true, force: true }));

function facts(extra = {}) {
  return { path: 'C:/work/a', dirty: false, onOrigin: true, live: false, inboundLinks: [], cardDone: false, idle: false, ...extra };
}

function linkRemovalFixture(base) {
  const work = path.join(base, 'work'); const tree = path.join(work, 'tree'); const live = path.join(base, 'live');
  fs.mkdirSync(path.join(live, 'top'), { recursive: true }); fs.mkdirSync(path.join(live, 'scoped'), { recursive: true }); fs.mkdirSync(path.join(live, 'deep'), { recursive: true });
  fs.writeFileSync(path.join(live, 'top', 'a'), 'top'); fs.writeFileSync(path.join(live, 'scoped', 'b'), 'scoped'); fs.writeFileSync(path.join(live, 'deep', 'c'), 'deep');
  fs.mkdirSync(path.join(tree, 'node_modules', '@scope'), { recursive: true }); fs.mkdirSync(path.join(tree, 'resources', 'x', 'y'), { recursive: true });
  fs.symlinkSync(path.join(live, 'top'), path.join(tree, 'top-link'), 'junction');
  fs.symlinkSync(path.join(live, 'scoped'), path.join(tree, 'node_modules', '@scope', 'pkg'), 'junction');
  fs.symlinkSync(path.join(live, 'deep'), path.join(tree, 'resources', 'x', 'y', 'models'), 'junction');
  return { work, tree, live };
}
function assertLiveFixture(live) {
  assert.equal(fs.readFileSync(path.join(live, 'top', 'a'), 'utf8'), 'top');
  assert.equal(fs.readFileSync(path.join(live, 'scoped', 'b'), 'utf8'), 'scoped');
  assert.equal(fs.readFileSync(path.join(live, 'deep', 'c'), 'utf8'), 'deep');
}

test('managed path only permits direct, non-hidden children of _work', () => {
  const root = path.join(jail, 'work');
  assert.equal(scratch.managedScratchPath(root, path.join(root, 'agent-a')), true);
  assert.equal(scratch.managedScratchPath(root, root), false);
  assert.equal(scratch.managedScratchPath(root, path.join(root, 'agent-a', 'nested')), false);
  assert.equal(scratch.managedScratchPath(root, path.join(root, '.scratch-node-modules')), false);
  assert.equal(scratch.managedScratchPath(root, path.join(root, '..', 'outside')), false);
});

test('fixtures are stamped direct cache children and are not scratch paths', () => {
  const hive = path.join(jail, 'fixture-path'); const fixture = path.join(hive, 'cache', 'fixtures', 'guppy-v1.1.83');
  fs.mkdirSync(fixture, { recursive: true });
  assert.equal(scratch.managedFixturePath(hive, fixture), false);
  fs.writeFileSync(path.join(fixture, '.guppy-fixture.json'), '{"tag":"v1.1.83"}');
  assert.equal(scratch.managedFixturePath(hive, fixture), true);
  assert.equal(scratch.managedFixturePath(hive, path.join(fixture, 'nested')), false);
});

test('reap policy is fail-closed: dirty, unpushed, live and inbound links all win over done/idle', () => {
  assert.equal(scratch.planScratchReap(facts({ cardDone: true })).action, 'reap');
  assert.equal(scratch.planScratchReap(facts({ idle: true })).action, 'reap');
  for (const [change, reason] of [
    [{ dirty: true, cardDone: true }, 'dirty'],
    [{ onOrigin: false, cardDone: true }, 'unpushed-or-not-on-origin'],
    [{ live: true, cardDone: true }, 'live-process'],
    [{ inboundLinks: ['C:/work/b/node_modules/x'], cardDone: true }, 'inbound-node-modules-link']
  ]) assert.equal(scratch.planScratchReap(facts(change)).reason, reason);
  assert.equal(scratch.planScratchReap(facts()).reason, 'card-active');
});

test('registry round trip rejects malformed rows and preserves owner/card/timestamps', () => {
  const hive = path.join(jail, 'hive');
  const state = { v: 1, records: [{ path: 'C:/work/a', owner: 'dwight', card: 'CARD-1', kind: 'worktree', createdAt: 11, touchedAt: 12 }] };
  scratch.writeScratchState(hive, state);
  assert.deepEqual(scratch.readScratchState(hive), state);
  fs.writeFileSync(scratch.stateFile(hive), JSON.stringify({ v: 1, records: [{ nope: true }] }));
  assert.deepEqual(scratch.readScratchState(hive), { v: 1, records: [] });
});

test('manager authenticates owner, refuses a common repo, and only reaps a registered idle jail', async () => {
  const base = path.join(jail, 'managed'); const hive = path.join(base, 'hive'); const work = path.join(base, '_work');
  const jailRoot = path.join(work, 'dwight-jail-a'); const common = path.join(work, 'common-repo');
  fs.mkdirSync(jailRoot, { recursive: true }); fs.mkdirSync(path.join(common, '.git'), { recursive: true });
  let clock = 100;
  const manager = new scratch.ScratchDiskManager(() => hive, (card) => card === 'CARD-1', async () => [], undefined, () => clock);
  assert.match(manager.register('dwight', common, 'CARD-1').line, /common repository/);
  assert.equal(manager.register('dwight', jailRoot, 'CARD-1').ok, true);
  assert.match(manager.register('jim', jailRoot, 'CARD-1').line, /another agent/);
  clock += scratch.SCRATCH_IDLE_MS + 1;
  // A new or rebuilt persisted index deliberately vetoes its own sweep; once
  // the next unchanged validation confirms it, the otherwise-safe jail reaps.
  let r;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    r = await manager.sweep();
    if (r.reaped.length) break;
  }
  assert.deepEqual(r.reaped, [path.resolve(jailRoot)]);
  assert.equal(fs.existsSync(jailRoot), false);
});

test('a broken link protects its candidate but not an unrelated done tree, and is reported', { skip: process.platform !== 'win32' }, async () => {
  const base = path.join(jail, 'broken-link-scope'); const hive = path.join(base, 'hive'); const work = path.join(base, '_work');
  const candidate = path.join(work, 'dwight-broken'); const unrelated = path.join(work, 'dwight-clean'); const broken = path.join(candidate, 'nested', 'gone');
  fs.mkdirSync(path.dirname(broken), { recursive: true }); fs.mkdirSync(unrelated, { recursive: true });
  fs.symlinkSync(path.join(base, 'does-not-exist'), broken, 'junction');
  const manager = new scratch.ScratchDiskManager(() => hive, () => true, async () => []);
  assert.equal(manager.register('dwight', candidate, 'CARD-1').ok, true);
  assert.equal(manager.register('dwight', unrelated, 'CARD-1').ok, true);
  let result;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    result = await manager.sweep();
    if (result.reaped.length) break;
  }
  assert.deepEqual(result.reaped, [path.resolve(unrelated)]);
  assert.deepEqual(result.brokenLinks, [{ path: broken, target: null }]);
  assert.match(result.kept.find((row) => row.path === path.resolve(candidate)).reason, /inbound-node-modules-link/);
  assert.equal(fs.existsSync(candidate), true);
  fs.rmdirSync(broken);
});

test('registered fixtures are permanently protected, even for a done card', async () => {
  const base = path.join(jail, 'fixture-manager'); const hive = path.join(base, 'hive');
  const fixture = path.join(hive, 'cache', 'fixtures', 'guppy-v1.1.83');
  fs.mkdirSync(fixture, { recursive: true }); fs.writeFileSync(path.join(fixture, '.guppy-fixture.json'), '{"tag":"v1.1.83"}');
  const manager = new scratch.ScratchDiskManager(() => hive, () => true, async () => []);
  assert.equal(manager.registerFixture('creed', fixture, 'DRILL-TREE-SELF-BUILD-108').ok, true);
  const result = await manager.sweep();
  assert.deepEqual(result.reaped, []);
  assert.deepEqual(result.kept, [{ path: path.resolve(fixture), owner: 'creed', reason: 'fixture-protected' }]);
  assert.equal(fs.existsSync(fixture), true);
});

test('link-safe scratch removal preserves top, scoped and deep junction targets under system node', async () => {
  const fixture = linkRemovalFixture(path.join(jail, 'link-safe-system'));
  await scratch.removeScratchRoot(fixture.work, fixture.tree);
  assert.equal(fs.existsSync(fixture.tree), false);
  assertLiveFixture(fixture.live);
});

test('a junction injected after the initial walk is never recursively followed', { skip: process.platform !== 'win32' }, async () => {
  const base = path.join(jail, 'late-junction'); const root = path.join(base, 'tree'); const live = path.join(base, 'live');
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(live, { recursive: true });
  fs.writeFileSync(path.join(root, 'listed-first'), 'remove'); fs.writeFileSync(path.join(live, 'keep'), 'live');
  await safeRemove.safeRemoveTree(root, async () => fs.symlinkSync(live, path.join(root, 'late'), 'junction'));
  assert.equal(fs.readFileSync(path.join(live, 'keep'), 'utf8'), 'live');
  assert.equal(fs.existsSync(root), false);
  const syncRoot = path.join(base, 'sync-tree'); fs.mkdirSync(syncRoot, { recursive: true }); fs.writeFileSync(path.join(syncRoot, 'listed-first'), 'remove');
  safeRemove.safeRemoveTreeSync(syncRoot, () => fs.symlinkSync(live, path.join(syncRoot, 'late'), 'junction'));
  assert.equal(fs.readFileSync(path.join(live, 'keep'), 'utf8'), 'live');
  assert.equal(fs.existsSync(syncRoot), false);
});

test('link-safe scratch removal preserves junction targets under installed Electron as Node', { skip: process.platform !== 'win32' }, () => {
  const fixtureBase = path.join(jail, 'link-safe-electron'); const fixture = linkRemovalFixture(fixtureBase);
  const exe = process.env.GUPPY_PACKAGED_EXE || path.join(process.env.LOCALAPPDATA || 'C:\\Users\\FiercePC\\AppData\\Local', 'Programs', 'Guppy', 'Guppy.exe');
  assert.equal(fs.existsSync(exe), true, `installed Guppy executable missing: ${exe}`);
  const result = child.spawnSync(exe, [path.join(__dirname, 'scratch-disk-electron-child.cjs'), fixtureBase], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /"ok":true/);
  assert.equal(fs.existsSync(fixture.tree), false);
  assertLiveFixture(fixture.live);
});

test('jails that are bare/common git dirs or worktree gitdir targets are refused', () => {
  const base = path.join(jail, 'git-dir-refusal'); const hive = path.join(base, 'hive'); const work = path.join(base, '_work');
  const bare = path.join(work, 'bare'); fs.mkdirSync(path.join(bare, 'objects'), { recursive: true }); fs.mkdirSync(path.join(bare, 'refs'), { recursive: true }); fs.writeFileSync(path.join(bare, 'HEAD'), 'ref: refs/heads/main\n');
  assert.equal(scratch.scratchKind(bare), null);
  const target = path.join(work, 'dwight-common'); fs.mkdirSync(target, { recursive: true });
  const linked = path.join(work, 'linked'); fs.mkdirSync(linked, { recursive: true }); fs.writeFileSync(path.join(linked, '.git'), 'gitdir: ../dwight-common/worktrees/linked\n');
  const manager = new scratch.ScratchDiskManager(() => hive, () => false, async () => []);
  assert.match(manager.register('dwight', bare, 'CARD-1').line, /common repository/);
  assert.match(manager.register('dwight', target, 'CARD-1').line, /referenced by a worktree gitdir/);
  const foreign = path.join(work, 'jim-foreign'); fs.mkdirSync(foreign, { recursive: true });
  assert.match(manager.register('dwight', foreign, 'CARD-1').line, /owner prefix/);
});

test('install key changes for patch inputs and is stable for unchanged project inputs', () => {
  const project = path.join(jail, 'project');
  fs.mkdirSync(path.join(project, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(project, 'package-lock.json'), '{"lockfileVersion":3}');
  fs.writeFileSync(path.join(project, 'package.json'), '{"scripts":{"postinstall":"node tools/patch.cjs"}}');
  fs.writeFileSync(path.join(project, 'tools', 'patch.cjs'), 'module.exports = 16;');
  const a = scratch.managedInstallKey(project, '22.0.0', 'win32', 'x64');
  assert.equal(a, scratch.managedInstallKey(project, '22.0.0', 'win32', 'x64'));
  fs.writeFileSync(path.join(project, 'tools', 'patch.cjs'), 'module.exports = 17;');
  assert.notEqual(a, scratch.managedInstallKey(project, '22.0.0', 'win32', 'x64'));
  assert.notEqual(a, scratch.managedInstallKey(project, '23.0.0', 'win32', 'x64'));
});

test('persisted whole-floor inbound index finds nested, outside and gitdir references without following links', { skip: process.platform !== 'win32' }, async () => {
  const work = path.join(jail, 'links'); const victim = path.join(work, 'victim'); const user = path.join(work, 'user');
  fs.mkdirSync(path.join(victim, 'pkg'), { recursive: true }); fs.mkdirSync(path.join(user, 'node_modules', '@scope'), { recursive: true });
  const outside = path.join(jail, 'MunderDev', 'consumer'); fs.mkdirSync(path.join(outside, 'nested', 'modules'), { recursive: true });
  const gitUser = path.join(jail, 'other-worktree'); fs.mkdirSync(gitUser, { recursive: true });
  fs.writeFileSync(path.join(victim, 'pkg', 'payload'), crypto.randomBytes(64));
  fs.symlinkSync(path.join(victim, 'pkg'), path.join(user, 'node_modules', '@scope', 'pkg'), 'junction');
  fs.symlinkSync(path.join(victim, 'pkg'), path.join(outside, 'nested', 'modules', 'pkg'), 'junction');
  fs.writeFileSync(path.join(gitUser, '.git'), 'gitdir: ../links/victim/git-meta\\n');
  const hive = path.join(jail, 'links-hive');
  const cold = await scratch.refreshInboundLinkIndex(hive, work);
  assert.equal(cold.error, null);
  const expected = [
    path.join(user, 'node_modules', '@scope', 'pkg'),
    path.join(outside, 'nested', 'modules', 'pkg'),
    `gitdir:${path.join(gitUser, '.git')}`
  ].sort();
  assert.deepEqual(scratch.inboundLinksFromIndex(cold.index, victim), expected);
  const warm = await scratch.refreshInboundLinkIndex(hive, work);
  assert.equal(warm.error, null);
  assert.deepEqual(scratch.inboundLinksFromIndex(warm.index, victim), expected);
  assert.ok(scratch.scratchBytes(work) < 256, 'junction target is not counted through the user tree');
});

test('mutant pins: each never-reap guard and source-input key is present', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'scratchDisk.ts'), 'utf8');
  const safe = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'fsSafeRemove.ts'), 'utf8');
  for (const token of ['if (f.dirty)', 'if (!f.onOrigin)', 'if (f.live)', 'if (f.inboundLinks.length)', 'package-lock.json', 'package.json', 'const tools = join(project, \'tools\')', 'path-changed-or-missing', 'fixture-protected', 'worktreeGitdirPointsInto', 'inbound-index-rebuilt-no-delete-this-sweep', 'scan-timeout']) assert.ok(src.includes(token), token);
  for (const token of ['removeReparsePointSync', 'unlinkReparsePointsUnderSync', 'findReparsePointsSync', 'beforeRootRmdir', 'directory changed during removal']) assert.ok(safe.includes(token), token);
  assert.equal(safe.includes('rm(path, { recursive'), false, 'safe removal must not delegate to recursive rm');
});
