'use strict';
require('./tools/own-job.cjs');
require('./tools/mutant-runner-helper.cjs').gate(__filename);
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const loadTs = require('./load-ts.cjs');
const scratch = loadTs('src/main/scratchDisk.ts');

const jail = fs.mkdtempSync(path.join(os.tmpdir(), 'scratch-disk-'));
test.after(() => fs.rmSync(jail, { recursive: true, force: true }));

function facts(extra = {}) {
  return { path: 'C:/work/a', dirty: false, onOrigin: true, live: false, inboundLinks: [], cardDone: false, idle: false, ...extra };
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
  const jailRoot = path.join(work, 'jail-a'); const common = path.join(work, 'common-repo');
  fs.mkdirSync(jailRoot, { recursive: true }); fs.mkdirSync(path.join(common, '.git'), { recursive: true });
  let clock = 100;
  const manager = new scratch.ScratchDiskManager(() => hive, (card) => card === 'CARD-1', async () => [], undefined, () => clock);
  assert.match(manager.register('dwight', common, 'CARD-1').line, /common repository/);
  assert.equal(manager.register('dwight', jailRoot, 'CARD-1').ok, true);
  assert.match(manager.register('jim', jailRoot, 'CARD-1').line, /another agent/);
  clock += scratch.SCRATCH_IDLE_MS + 1;
  const r = await manager.sweep();
  assert.deepEqual(r.reaped, [path.resolve(jailRoot)]);
  assert.equal(fs.existsSync(jailRoot), false);
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

test('inbound scan finds a scoped node_modules junction and never follows it for disk size', { skip: process.platform !== 'win32' }, () => {
  const work = path.join(jail, 'links'); const victim = path.join(work, 'victim'); const user = path.join(work, 'user');
  fs.mkdirSync(path.join(victim, 'pkg'), { recursive: true }); fs.mkdirSync(path.join(user, 'node_modules', '@scope'), { recursive: true });
  fs.writeFileSync(path.join(victim, 'pkg', 'payload'), crypto.randomBytes(64));
  fs.symlinkSync(path.join(victim, 'pkg'), path.join(user, 'node_modules', '@scope', 'pkg'), 'junction');
  assert.deepEqual(scratch.inboundNodeModulesLinks(work, victim), [path.join(user, 'node_modules', '@scope', 'pkg')]);
  assert.ok(scratch.scratchBytes(work) < 256, 'junction target is not counted through the user tree');
});

test('mutant pins: each never-reap guard and source-input key is present', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'scratchDisk.ts'), 'utf8');
  for (const token of ['if (f.dirty)', 'if (!f.onOrigin)', 'if (f.live)', 'if (f.inboundLinks.length)', 'package-lock.json', 'package.json', 'const tools = join(project, \'tools\')', 'path-changed-or-missing', 'fixture-protected']) assert.ok(src.includes(token), token);
});
