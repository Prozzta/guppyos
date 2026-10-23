'use strict';

/**
 * MAIN-SYNC-LOG-LEDGER commit 3, Jim's FAIL on 91235c64: with tasks() served from the deep-frozen
 * authority cache, the voice task actions broke. assign_task and update_task set fields on a
 * frozen card (TypeError: "That action failed"), and create_task and delete_task wrote back a
 * list built on a cached read up to AUTHORITY_REVALIDATE_MS old, dropping a card another
 * writer had added inside that window. The voice path now matches on the cached read only and
 * writes through hive.addTask / patchTask / deleteTask, which read tasks.json fresh and merge by
 * id. These tests drive the real realtime:action handler on a real HiveManager.
 *
 * Also pinned: the ledger guard drops the cached tasks entry before its onChange listeners run
 * (the board tick, board status, the ASSIGNEE_ARCHIVED auto-move), so they see what it saw.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// realtimeActions.ts registers on electron's ipcMain: a fake that keeps the handlers.
const handlers = {};
require.cache[require.resolve('electron')] = {
  id: 'electron', filename: 'electron', loaded: true,
  exports: { ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } } }
};
const loadTs = require('./load-ts.cjs');
const RA = loadTs('src/main/realtimeActions.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { readSource } = require('./read-source.cjs');

const card = (id, extra = {}) => ({ id, title: `card ${id}`, status: 'todo', dependsOn: [], ...extra });

// One registration (ipcMain.handle is called once in main); each test points it at its own hive.
let current = null;
RA.registerRealtimeActionIpc({
  hiveEnabled: () => true,
  hiveRegistry: () => ({ agents: {} }),
  hiveSend: (m) => m,
  hiveLog: () => {},
  // The same wiring as index.ts.
  hiveTasks: () => current.tasks(),
  hiveAddTask: (task) => current.addTask(task, 'voice'),
  hivePatchTask: (id, patch) => current.patchTask(id, patch, 'voice'),
  hiveDeleteTask: (id) => current.deleteTask(id, 'voice')
});
const say = (verb, args) => handlers['realtime:action'](null, { verb, ...args });

const clock = 1_000_000;
function floor(t, tasks) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-voice-task-cache-'));
  const hive = new HiveManager(() => home);
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); current = null; });
  hive.ensureHive();
  const file = path.join(hive.root(), 'tasks.json');
  const handEdit = (list) => fs.writeFileSync(file, JSON.stringify({ tasks: list }), 'utf8');
  const disk = () => JSON.parse(fs.readFileSync(file, 'utf8')).tasks;
  handEdit(tasks);
  // The window clock stands still, so every read below is inside one window; the racy wall is a
  // minute ahead, so files just written count as old (proven) and the cache serves them.
  hive.__resetAuthorityCacheForTests(() => clock, () => Date.now() + 60_000);
  current = hive;
  return { hive, handEdit, disk };
}

test('assign_task and update_task succeed on a card read from the frozen cache, and write by id', async (t) => {
  const { hive, disk } = floor(t, [card('alpha-route'), card('beta-sync', { result: 'old' })]);
  const cached = hive.tasks();
  assert.ok(Object.isFrozen(cached.tasks[0]), 'the voice match runs on the frozen cached cards');
  const a = await say('assign_task', { task: 'alpha route', assignee: 'jim-1' });
  assert.equal(a.ok, true, a.spoken);
  assert.match(a.spoken, /Assigned "card alpha-route" to jim-1/);
  const u = await say('update_task', { task: 'beta sync', status: 'doing', result: 'halfway' });
  assert.equal(u.ok, true, u.spoken);
  assert.match(u.spoken, /to doing/);
  assert.deepEqual(disk().map((c) => [c.id, c.status, c.assignee, c.result]), [
    ['alpha-route', 'todo', 'jim-1', undefined],
    ['beta-sync', 'doing', undefined, 'halfway']
  ]);
  assert.equal(cached.tasks[0].assignee, undefined, 'the cached object itself is untouched');
  assert.deepEqual(hive.tasks().tasks.map((c) => c.assignee ?? c.status), ['jim-1', 'doing'], 'the next read sees the writes');
});

test('a card added by another writer inside the window survives a voice create', async (t) => {
  const { hive, handEdit, disk } = floor(t, [card('alpha-route')]);
  hive.tasks();
  handEdit([card('alpha-route'), card('hand-added')]);
  assert.deepEqual(hive.tasks().tasks.map((c) => c.id), ['alpha-route'], 'control: the cache still serves the old list');
  const r = await say('create_task', { title: 'Voice made this' });
  assert.equal(r.ok, true, r.spoken);
  const ids = disk().map((c) => c.id);
  assert.deepEqual(ids.slice(0, 2), ['alpha-route', 'hand-added']);
  assert.equal(ids.length, 3);
  assert.match(ids[2], /^voice-made-this-/);
});

test('a card added by another writer inside the window survives a voice delete', async (t) => {
  const { hive, handEdit, disk } = floor(t, [card('alpha-route'), card('beta-sync')]);
  hive.tasks();
  handEdit([card('alpha-route'), card('beta-sync'), card('hand-added')]);
  assert.equal(hive.tasks().tasks.length, 2, 'control: the cache still serves the old list');
  const r = await say('delete_task', { task: 'alpha route' });
  assert.equal(r.ok, true, r.spoken);
  assert.deepEqual(disk().map((c) => c.id), ['beta-sync', 'hand-added']);
});

test('an edit made inside the window is kept by a voice update of another card', async (t) => {
  const { hive, handEdit, disk } = floor(t, [card('alpha-route'), card('beta-sync')]);
  hive.tasks();
  handEdit([card('alpha-route', { notes: 'by hand' }), card('beta-sync')]);
  const r = await say('update_task', { task: 'beta sync', status: 'blocked' });
  assert.equal(r.ok, true, r.spoken);
  assert.deepEqual(disk().map((c) => [c.id, c.status, c.notes]), [['alpha-route', 'todo', 'by hand'], ['beta-sync', 'blocked', undefined]]);
});

test('a card deleted elsewhere inside the window is not brought back by a voice assign, update or delete', async (t) => {
  const { hive, handEdit, disk } = floor(t, [card('alpha-route'), card('beta-sync')]);
  hive.tasks();
  handEdit([card('beta-sync')]);
  for (const [verb, args] of [['assign_task', { task: 'alpha route', assignee: 'jim-1' }], ['update_task', { task: 'alpha route', status: 'done' }], ['delete_task', { task: 'alpha route' }]]) {
    const r = await say(verb, args);
    assert.equal(r.ok, false, verb);
    assert.match(r.spoken, /no longer on the board/, verb);
    assert.deepEqual(disk().map((c) => c.id), ['beta-sync'], verb);
  }
});

test('the ledger guard drops the cached tasks entry before its listeners run', (t) => {
  const { hive, handEdit } = floor(t, [card('alpha-route')]);
  hive.ledgerGuard.check(); // baseline
  hive.tasks();
  const seen = [];
  const off = hive.ledgerGuard.onChange(() => { seen.push(hive.tasks().tasks.map((c) => c.id)); });
  t.after(off);
  handEdit([card('alpha-route'), card('hand-added')]);
  assert.equal(hive.tasks().tasks.length, 1, 'control: inside the window the cache serves the old list');
  hive.ledgerGuard.check();
  assert.deepEqual(seen, [['alpha-route', 'hand-added']], 'the listener reads what the guard saw');
});

test('index.ts wires the voice deps to the by-id mutators with source "voice", and nothing writes a whole list', () => {
  const index = readSource('src/main/index.ts');
  assert.match(index, /hiveAddTask: \(task\) => hive\.addTask\(task, 'voice'\)/);
  assert.match(index, /hivePatchTask: \(id, patch\) => hive\.patchTask\(id, patch, 'voice'\)/);
  assert.match(index, /hiveDeleteTask: \(id\) => hive\.deleteTask\(id, 'voice'\)/);
  assert.doesNotMatch(index, /hiveWriteTasks/);
  assert.doesNotMatch(readSource('src/main/realtimeActions.ts'), /hiveWriteTasks|writeTasks\(/);
});
