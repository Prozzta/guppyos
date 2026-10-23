'use strict';

/**
 * MAIN-SYNC-LOG-LEDGER (tasks): HiveManager.tasks() was a disk read + parse of tasks.json on every
 * call (~40 calls/min on Guppy main under a heavy run on 1.1.99, but the file is the large one:
 * ~13 MB/min). It now serves one deep-frozen parsed ledger from memory, on the same cache as
 * registry(). Our own writes drop it (the next read sees them); a write by another process is
 * picked up by fs.watch or, as the authority, by a stat revalidate at most
 * AUTHORITY_REVALIDATE_MS (1 s) after the last check. Mutations still read the file fresh
 * (tasksForMutation, writeTasks), and the missing, corrupt and unreadable paths are not cached.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const WINDOW = HiveManager.AUTHORITY_REVALIDATE_MS;
const card = (id, extra = {}) => ({ id, title: `card ${id}`, status: 'todo', tags: ['x'], ...extra });

let clock = 1_000_000;
const tick = (ms) => { clock += ms; };
function floor(t, tasks = [card('T1')]) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-tasks-read-cache-'));
  const hive = new HiveManager(() => home);
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  hive.ensureHive();
  const file = path.join(hive.root(), 'tasks.json');
  const handEdit = (list) => fs.writeFileSync(file, JSON.stringify({ tasks: list }), 'utf8');
  handEdit(tasks);
  // The racy rule's wall clock: a minute ahead, so files just written here count as old (proven)
  // writes; the racy test drives it itself.
  hive.__resetAuthorityCacheForTests(() => clock, () => Date.now() + 60_000);
  return { hive, file, handEdit };
}
/** Count the tasks.json disk reads and stats inside fn. */
function io(file, fn) {
  const { readFileSync, statSync } = fs;
  const n = { reads: 0, stats: 0 };
  fs.readFileSync = function (p, ...rest) { if (String(p) === file) n.reads++; return readFileSync.call(this, p, ...rest); };
  fs.statSync = function (p, ...rest) { if (String(p) === file) n.stats++; return statSync.call(this, p, ...rest); };
  try { n.result = fn(); } finally { fs.readFileSync = readFileSync; fs.statSync = statSync; }
  return n;
}
const ids = (ledger) => ledger.tasks.map((c) => c.id);

test('1000 reads inside the window reach disk once, return one deep-frozen object, and never stat again', (t) => {
  const { hive, file } = floor(t);
  const first = io(file, () => hive.tasks());
  assert.deepEqual([first.reads, first.stats], [1, 1]);
  const many = io(file, () => { let last; for (let i = 0; i < 1000; i++) { tick(0.5); last = hive.tasks(); } return last; });
  assert.deepEqual([many.reads, many.stats], [0, 0], 'served from memory, no disk call at all');
  assert.equal(many.result, first.result, 'the same object, not a clone per call');
  const l = many.result;
  assert.ok(Object.isFrozen(l) && Object.isFrozen(l.tasks) && Object.isFrozen(l.tasks[0]) && Object.isFrozen(l.tasks[0].tags));
  assert.throws(() => { l.tasks.push(card('T9')); }, TypeError);
  assert.throws(() => { l.tasks[0].status = 'done'; }, TypeError);
  assert.throws(() => { l.tasks[0].tags.push('y'); }, TypeError);
  assert.throws(() => { l.tasks.splice(0, 1); }, TypeError);
  // allTasks merges into a new list, but the hot cards are the same frozen objects.
  const all = hive.allTasks();
  assert.notEqual(all.tasks, l.tasks);
  assert.equal(all.tasks[0], l.tasks[0]);
});

test('a mutation reads the file fresh, never the frozen cache, and its write is seen by the next read', (t) => {
  const { hive, file, handEdit } = floor(t);
  hive.tasks();
  // Another process adds a card inside the window: the mutation must build on it.
  handEdit([card('T1'), card('T2')]);
  assert.deepEqual(ids(hive.tasks()), ['T1'], 'readers may lag by up to the window');
  assert.equal(hive.addTask(card('T3')), true);
  const after = io(file, () => hive.tasks());
  assert.equal(after.reads, 1, 'our write dropped the cache');
  assert.deepEqual(ids(after.result), ['T1', 'T2', 'T3'], 'no lost update: T2 kept');
  assert.ok(Object.isFrozen(after.result.tasks[2]));
  assert.deepEqual(after.result, JSON.parse(fs.readFileSync(file, 'utf8')), 'equal to a cold read');
  // writeTasks merges against the file too, not the cache.
  hive.tasks();
  handEdit([card('T1'), card('T2'), card('T3'), card('T4')]);
  hive.writeTasks([card('T1', { status: 'doing' }), card('T2'), card('T3'), card('T4')]);
  const w = hive.tasks();
  assert.deepEqual(ids(w), ['T1', 'T2', 'T3', 'T4']);
  assert.equal(w.tasks[0].status, 'doing');
});

test('an external edit is invisible inside the window and picked up by the stat revalidate at AUTHORITY_REVALIDATE_MS', (t) => {
  assert.ok(WINDOW <= 1000, 'revalidate within 1 s');
  const { hive, file, handEdit } = floor(t);
  assert.deepEqual(ids(hive.tasks()), ['T1']);
  handEdit([card('T1'), card('T5')]);
  tick(WINDOW - 1);
  assert.deepEqual(ids(hive.tasks()), ['T1'], 'inside the window (no event loop turn, so no watcher yet)');
  tick(1);
  const r = io(file, () => hive.tasks());
  assert.deepEqual(ids(r.result), ['T1', 'T5']);
  assert.deepEqual([r.reads, r.stats], [1, 1]);
  tick(WINDOW);
  const same = io(file, () => hive.tasks());
  assert.deepEqual([same.reads, same.stats], [0, 1], 'unchanged on disk: a stat, no read');
  assert.equal(same.result, r.result);
  tick(WINDOW / 2);
  assert.equal(io(file, () => hive.tasks()).stats, 0, 'a key match renewed the window');
  clock -= 10 * WINDOW;
  assert.equal(io(file, () => hive.tasks()).stats, 1, 'a clock that went back revalidates');
});

test('fs.watch marks the cache dirty: an external edit is seen before the window ends', async (t) => {
  const { hive, handEdit } = floor(t);
  assert.deepEqual(ids(hive.tasks()), ['T1']);
  await new Promise((r) => setTimeout(r, 100));
  handEdit([card('T6')]);
  const until = Date.now() + 5000;
  while (ids(hive.tasks())[0] !== 'T6' && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(ids(hive.tasks()), ['T6'], 'the frozen test clock never reached the window: only the watcher can have done it');
});

test('registry and tasks are cached separately: a registry write leaves the tasks cache alone', (t) => {
  const { hive, file } = floor(t);
  const reg = path.join(hive.root(), 'registry.json');
  fs.writeFileSync(reg, JSON.stringify({ godId: null, agents: { a1: { id: 'a1', name: 'a1', role: 'worker', status: 'idle', lastSeen: 1 } } }), 'utf8');
  const l = hive.tasks();
  assert.ok(hive.registry().agents.a1);
  assert.equal(hive.setAgentHold('a1', true).ok, true);
  const r = io(file, () => hive.tasks());
  assert.deepEqual([r.reads, r.stats], [0, 0]);
  assert.equal(r.result, l);
  assert.equal(io(reg, () => hive.registry()).reads, 1, 'the registry write dropped only its own entry');
});

test('corrupt tasks.json: not cached, quarantined once, mutations refused; integrityIssues sees it inside the window; a repair is seen at once', (t) => {
  const { hive, file, handEdit } = floor(t);
  hive.tasks();
  const corrupt = '{"tasks":';
  fs.writeFileSync(file, corrupt, 'utf8');
  assert.match(hive.integrityIssues().find((i) => i.file === 'tasks.json').quarantine, /^tasks\.json\.corrupt-/, 'a forced scan skips the window');
  const r = io(file, () => [hive.tasks(), hive.tasks()]);
  assert.equal(r.reads, 2, 'each read re-reads, as before');
  assert.deepEqual(r.result[0], { tasks: [] });
  assert.equal(Object.isFrozen(r.result[0]), false, 'the safe default is a fresh object');
  assert.throws(() => hive.addTask(card('T7')), /tasks\.json is invalid JSON; refusing to overwrite it/);
  assert.equal(fs.readFileSync(file, 'utf8'), corrupt);
  assert.equal(fs.readdirSync(hive.root()).filter((n) => n.startsWith('tasks.json.corrupt-')).length, 1);
  handEdit([card('T8')]);
  assert.deepEqual(ids(hive.tasks()), ['T8'], 'no window to wait out after a corrupt read');
  assert.deepEqual(hive.integrityIssues().filter((i) => i.file === 'tasks.json' && i.quarantine), []);
});

test('a missing tasks.json gives fresh defaults and is not cached', (t) => {
  const { hive, file } = floor(t);
  hive.tasks();
  fs.rmSync(file);
  tick(WINDOW);
  const d = hive.tasks();
  assert.deepEqual(d, { tasks: [] });
  assert.equal(Object.isFrozen(d), false);
  const again = io(file, () => hive.tasks());
  assert.equal(again.stats, 1, 'not cached: checked on every call');
  assert.notEqual(again.result, d);
});

test('an unreadable tasks.json still throws, and is not cached', (t) => {
  const { hive, file } = floor(t);
  const { readFileSync } = fs;
  fs.readFileSync = function (p, ...rest) { if (String(p) === file) { const e = new Error('locked'); e.code = 'EBUSY'; throw e; } return readFileSync.call(this, p, ...rest); };
  try { assert.throws(() => hive.tasks(), /tasks\.json could not be read: locked/); } finally { fs.readFileSync = readFileSync; }
  assert.deepEqual(ids(hive.tasks()), ['T1']);
});

test('a failed write drops the cache: the next read goes to disk and returns what is there', (t) => {
  const { hive, file } = floor(t);
  hive.tasks();
  const { renameSync } = fs;
  fs.renameSync = () => { const e = new Error('denied'); e.code = 'EACCES'; throw e; };
  try { assert.throws(() => hive.addTask(card('T9'))); } finally { fs.renameSync = renameSync; }
  const r = io(file, () => hive.tasks());
  assert.equal(r.reads, 1);
  assert.deepEqual(ids(r.result), ['T1']);
});

test('wiring: readers use the cache, mutations read the file, every tasks write drops the cache', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'hive.ts'), 'utf8').replace(/\r\n/g, '\n');
  const body = (sig) => { const i = src.indexOf(sig); assert.ok(i >= 0, sig); return src.slice(i, src.indexOf('\n  }\n', i)); };
  assert.match(body('  tasks(fresh = false): unknown {'), /this\.readAuthoritativeJsonCached\(join\(root, 'tasks\.json'\), \(\) => \(\{ tasks: \[\] \}\), fresh\)/);
  assert.match(body('  private tasksForMutation(): { tasks?: HiveTask[] } {'), /this\.readAuthoritativeJson\(join\(root, 'tasks\.json'\)/);
  assert.ok(!/readAuthoritativeJsonCached/.test(body('  private tasksForMutation(): { tasks?: HiveTask[] } {')));
  assert.match(body('  writeTasks(tasks: HiveTask[], source: TaskEditSource = \'ipc\'): void {'), /this\.readAuthoritativeJson<\{ tasks\?: unknown \}>\(path,/);
  assert.match(body('  integrityIssues(): HiveIntegrityIssue[] {'), /this\.tasks\(true\);/);
  // tasks.json is only ever written through writeJson / atomicWriteJson.
  const direct = src.split('\n').filter((l) => /tasks\.json/.test(l) && /writeFileSync|renameSync|atomicWriteJsonFile\(/.test(l));
  assert.deepEqual(direct, []);
});

/** statSync for `file` reports `over` on top of the real stat: one key for different texts. */
function fakeStat(file, over, fn) {
  const { statSync } = fs;
  fs.statSync = function (p, ...rest) { const st = statSync.call(this, p, ...rest); return String(p) === file ? { ...st, ...over } : st; };
  try { return fn(); } finally { fs.statSync = statSync; }
}
const T = 4_000_000_000_000;
const KEY = { mtimeMs: T, ctimeMs: T, size: 999, ino: 7 };

test('racy-git rule (Jim): two same-size ledgers under one stat key; a read within STAT_RACY_MS of the change is cached unproven, so the next revalidate reads the disk', (t) => {
  const { STAT_RACY_MS } = loadTs('src/main/statCacheKey.ts');
  const { hive, file, handEdit } = floor(t);
  let wall = T + 40; // the read lands 40 ms after the change
  hive.__resetAuthorityCacheForTests(() => clock, () => wall);
  fakeStat(file, KEY, () => {
    assert.deepEqual(ids(hive.tasks()), ['T1']);
    handEdit([card('T2')]); // same size, same key: a second write inside the tick
    tick(WINDOW);
    const r = io(file, () => hive.tasks());
    assert.deepEqual([r.reads, r.stats], [1, 1], 'unproven: the revalidate reads the disk once');
    assert.deepEqual(ids(r.result), ['T2']);
    wall = T + STAT_RACY_MS; tick(WINDOW);
    assert.equal(io(file, () => hive.tasks()).reads, 1, 'this read proves the key');
    tick(WINDOW);
    const idle = io(file, () => hive.tasks());
    assert.deepEqual([idle.reads, idle.stats], [0, 1], 'proven: a stat, no read');
  });
});

test('idle cost: a simulated minute on an unchanged ledger is 1 read and 60 stats', (t) => {
  const { hive, file } = floor(t);
  const minute = io(file, () => { for (let i = 0; i < 60; i++) { hive.tasks(); hive.tasks(); tick(WINDOW); } });
  assert.deepEqual([minute.reads, minute.stats], [1, 60]);
});
