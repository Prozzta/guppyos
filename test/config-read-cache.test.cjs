'use strict';

/**
 * MAIN-SYNC-LOG-LEDGER (config): readConfig was a disk read + parse + migrations on every call
 * (~2,900 calls/min on Guppy main under a heavy run on 1.1.99). It now serves one deep-frozen
 * parsed config from memory. Our own writes drop it (one disk read per write: Jim P1), and this
 * module's read-modify-writes read fresh; an external edit is picked up by fs.watch or, as the
 * authority, by a stat revalidate at most CONFIG_REVALIDATE_MS (1 s) after the last check. The
 * missing, corrupt and unreadable paths are not cached and behave as before.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-config-read-cache-'));
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { app: { getPath: () => userData } } };
const cfg = loadTs('src/main/config.ts');
const { readConfig, writeConfig, resetConfig, configIntegrityIssue, CONFIG_REVALIDATE_MS, __resetConfigCacheForTests } = cfg;
const file = path.join(userData, 'config.json');
const MIGRATED = { triggersMigratedV1: true, defaultModelCliMigratedV1: true };

let clock = 1_000_000;
const tick = (ms) => { clock += ms; };
/** Count the config.json disk reads and stats inside fn. */
function io(fn) {
  const { readFileSync, statSync } = fs;
  const n = { reads: 0, stats: 0 };
  fs.readFileSync = function (p, ...rest) { if (String(p) === file) n.reads++; return readFileSync.call(this, p, ...rest); };
  fs.statSync = function (p, ...rest) { if (String(p) === file) n.stats++; return statSync.call(this, p, ...rest); };
  try { n.result = fn(); } finally { fs.readFileSync = readFileSync; fs.statSync = statSync; }
  return n;
}
const handEdit = (obj) => fs.writeFileSync(file, JSON.stringify({ ...MIGRATED, ...obj }), 'utf8');
const fresh = (obj) => { handEdit(obj); __resetConfigCacheForTests(() => clock); };

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

test('1000 reads inside the window reach disk once, return one deep-frozen object, and never stat again', () => {
  fresh({ onboardingComplete: true, recentHives: ['C:/h1'], missions: [] });
  const first = io(() => readConfig());
  assert.deepEqual([first.reads, first.stats], [1, 1]);
  const many = io(() => { let last; for (let i = 0; i < 1000; i++) { tick(0.5); last = readConfig(); } return last; });
  assert.deepEqual([many.reads, many.stats], [0, 0], 'served from memory, no disk call at all');
  assert.equal(many.result, first.result, 'the same object, not a clone per call');
  const c = many.result;
  assert.ok(Object.isFrozen(c) && Object.isFrozen(c.recentHives) && Object.isFrozen(c.contextTrigger) && Object.isFrozen(c.contextTrigger.compact) && Object.isFrozen(c.mcpDefaults));
  assert.throws(() => { c.onboardingComplete = false; }, TypeError);
  assert.throws(() => { c.recentHives.push('C:/x'); }, TypeError);
  assert.throws(() => { c.contextTrigger.compact.enabled = !c.contextTrigger.compact.enabled; }, TypeError);
  assert.equal(readConfig().onboardingComplete, true);
});

test('freezing never reaches the shared DEFAULTS: a missing file still gives mutable defaults', () => {
  fresh({ onboardingComplete: true });
  readConfig();
  fs.rmSync(file);
  tick(CONFIG_REVALIDATE_MS);
  const d = readConfig();
  assert.equal(Object.isFrozen(d), false);
  assert.equal(Object.isFrozen(d.missions), false, 'DEFAULTS.missions is not frozen by an earlier cached read');
  assert.equal(Object.isFrozen(d.mcpDefaults), false);
  assert.equal(d.onboardingComplete, false);
  assert.equal(configIntegrityIssue(), null);
  const again = io(() => readConfig());
  assert.deepEqual([again.reads, again.stats], [0, 1], 'missing is not cached: one stat per call, as existsSync was');
});

test('writeConfig then readConfig sees the write at once with one disk read; the file matches', () => {
  fresh({ onboardingComplete: false, recentHives: [] });
  readConfig();
  writeConfig({ onboardingComplete: true, toolOutputCap: 1234 });
  const r = io(() => readConfig());
  assert.deepEqual([r.reads, r.stats], [1, 1], 'a write drops the cache: one read per write (Jim P1)');
  assert.equal(r.result.onboardingComplete, true);
  assert.equal(r.result.toolOutputCap, 1234);
  assert.ok(Object.isFrozen(r.result));
  // The same value a cold disk read builds.
  __resetConfigCacheForTests();
  assert.deepEqual(readConfig(), r.result);
  // Two writes in a row: each merges with the one before (no lost update through the cache).
  writeConfig({ toolOutputCap: 1 });
  writeConfig({ notifications: true });
  assert.deepEqual([readConfig().toolOutputCap, readConfig().notifications], [1, true]);
  const cached = io(() => readConfig());
  assert.deepEqual([cached.reads, cached.stats], [0, 0], 'then cached again');
  tick(CONFIG_REVALIDATE_MS);
  assert.deepEqual([io(() => readConfig()).reads, io(() => readConfig()).stats], [0, 0], 'keyed by the stat taken before its read');
});

test('Jim P1: an outside write that lands between our rename and the next read is seen within the window, and the next write keeps it', () => {
  fresh({ toolOutputCap: 10 });
  readConfig();
  const { renameSync } = fs;
  fs.renameSync = function (from, to, ...rest) {
    const r = renameSync.call(this, from, to, ...rest);
    if (String(to) === file) fs.writeFileSync(file, JSON.stringify({ ...MIGRATED, toolOutputCap: 777, notifications: false }), 'utf8');
    return r;
  };
  try { writeConfig({ toolOutputCap: 11 }); } finally { fs.renameSync = renameSync; }
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).toolOutputCap, 777, 'disk = EXTERNAL');
  // A merge never builds on the unverified entry: it reads the disk.
  writeConfig({ notifications: true });
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual([disk.toolOutputCap, disk.notifications], [777, true], 'no lost update');
  assert.equal(readConfig().toolOutputCap, 777);
  // Without the follow-up write: EXTERNAL is what the next read shows, and it stays.
  fresh({ toolOutputCap: 20 });
  readConfig();
  fs.renameSync = function (from, to, ...rest) {
    const r = renameSync.call(this, from, to, ...rest);
    if (String(to) === file) fs.writeFileSync(file, JSON.stringify({ ...MIGRATED, toolOutputCap: 888 }), 'utf8');
    return r;
  };
  try { writeConfig({ toolOutputCap: 21 }); } finally { fs.renameSync = renameSync; }
  assert.equal(readConfig().toolOutputCap, 888, 'EXTERNAL at once, so within 1 s');
  for (let i = 0; i < 3; i++) { tick(CONFIG_REVALIDATE_MS); assert.equal(readConfig().toolOutputCap, 888); }
});

test('a read-modify-write inside the window builds on an outside edit, not on the cached value', () => {
  fresh({ toolOutputCap: 30, notifications: false });
  readConfig();
  handEdit({ toolOutputCap: 31, notifications: false });
  assert.equal(readConfig().toolOutputCap, 30, 'readers may lag by up to the window');
  writeConfig({ notifications: true });
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual([disk.toolOutputCap, disk.notifications], [31, true], 'the outside edit survives our write');
});

test('an external edit is invisible inside the window and picked up by the stat revalidate at CONFIG_REVALIDATE_MS', () => {
  assert.ok(CONFIG_REVALIDATE_MS <= 1000, 'revalidate within 1 s');
  fresh({ toolOutputCap: 100 });
  assert.equal(readConfig().toolOutputCap, 100);
  handEdit({ toolOutputCap: 200 });
  tick(CONFIG_REVALIDATE_MS - 1);
  assert.equal(readConfig().toolOutputCap, 100, 'inside the window (no event loop turn, so no watcher yet)');
  tick(1);
  const r = io(() => readConfig());
  assert.equal(r.result.toolOutputCap, 200);
  assert.deepEqual([r.reads, r.stats], [1, 1]);
  tick(CONFIG_REVALIDATE_MS);
  const same = io(() => readConfig());
  assert.deepEqual([same.reads, same.stats], [0, 1], 'unchanged on disk: a stat, no read');
  assert.equal(same.result, r.result);
  tick(CONFIG_REVALIDATE_MS - 1);
  const renewed = io(() => readConfig());
  assert.deepEqual([renewed.reads, renewed.stats], [0, 0], 'a key match renews the window: one stat per window, not per call');
  clock -= 10 * CONFIG_REVALIDATE_MS;
  assert.equal(io(() => readConfig()).stats, 1, 'a clock that went back revalidates');
});

test('fs.watch marks the cache dirty: an external edit is seen before the window ends', async () => {
  fresh({ toolOutputCap: 300 });
  assert.equal(readConfig().toolOutputCap, 300);
  // Let fresh()'s own config.json events land (a watcher from an earlier test may already exist),
  // then re-arm the window: a key match renews it.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(readConfig().toolOutputCap, 300);
  // Churn on another file in the folder does not mark the cache dirty (the name filter).
  fs.writeFileSync(path.join(userData, 'other.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(userData, 'other.json'), '{"a":1}', 'utf8');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(io(() => readConfig()).stats, 0, 'another file\'s events leave the window alone');
  handEdit({ toolOutputCap: 301 });
  const until = Date.now() + 5000;
  while (readConfig().toolOutputCap !== 301 && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
  assert.equal(readConfig().toolOutputCap, 301, 'the frozen test clock never reached the window: only the watcher can have done it');
});

test('corrupt config: not cached, quarantined, writes refused; a repair is seen on the next read', () => {
  fresh({ onboardingComplete: true });
  readConfig();
  const corrupt = '{"harnessHome":';
  fs.writeFileSync(file, corrupt, 'utf8');
  tick(CONFIG_REVALIDATE_MS);
  const r = io(() => [readConfig(), readConfig()]);
  assert.equal(r.reads, 2, 'each read re-reads, as before');
  assert.equal(r.result[0].onboardingComplete, false);
  assert.equal(Object.isFrozen(r.result[0]), false, 'the corrupt path still returns fresh defaults');
  assert.match(configIntegrityIssue().quarantine, /^config\.json\.corrupt-/);
  assert.throws(() => writeConfig({ onboardingComplete: true }), /refusing to overwrite it/);
  assert.throws(() => resetConfig(), /refusing to overwrite it/);
  assert.equal(fs.readFileSync(file, 'utf8'), corrupt);
  handEdit({ onboardingComplete: true });
  assert.equal(readConfig().onboardingComplete, true, 'no window to wait out after a corrupt read');
  assert.equal(configIntegrityIssue(), null);
});

test('an unreadable config still throws, and is not cached', () => {
  fresh({ onboardingComplete: true });
  const { readFileSync } = fs;
  fs.readFileSync = function (p, ...rest) { if (String(p) === file) { const e = new Error('locked'); e.code = 'EBUSY'; throw e; } return readFileSync.call(this, p, ...rest); };
  try { assert.throws(() => readConfig(), /config\.json could not be read: locked/); } finally { fs.readFileSync = readFileSync; }
  assert.equal(readConfig().onboardingComplete, true);
});

test('a failed write drops the cache: the next read goes to disk and returns what is there', () => {
  fresh({ toolOutputCap: 500 });
  readConfig();
  const { renameSync } = fs;
  fs.renameSync = () => { const e = new Error('held'); e.code = 'EPERM'; throw e; };
  try { assert.throws(() => writeConfig({ toolOutputCap: 501 }), /Could not atomically publish/); } finally { fs.renameSync = renameSync; }
  const r = io(() => readConfig());
  assert.equal(r.reads, 1);
  assert.equal(r.result.toolOutputCap, 500);
});

test('a read whose migration persists caches the persisted text, not the pre-migration build', () => {
  fs.writeFileSync(file, JSON.stringify({ defaultModelCliMigratedV1: true, triggersMigratedV1: false, webhookSecret: 's3cret', webhookEnabled: true }), 'utf8');
  __resetConfigCacheForTests(() => clock);
  const first = readConfig();
  assert.equal(first.triggersMigratedV1, true);
  assert.equal(first.webhookTriggers[0].id, 'legacy');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).triggersMigratedV1, true, 'persisted');
  const second = io(() => readConfig());
  assert.deepEqual([second.reads, second.stats], [1, 1], 'the pre-migration build (keyed to the old file) was not cached: the persisted file is read once');
  assert.deepEqual(second.result, first);
  tick(CONFIG_REVALIDATE_MS);
  const later = io(() => readConfig());
  assert.deepEqual([later.reads, later.stats], [0, 1], 'then keyed to the file the migration wrote');
});

test('wiring: readConfig serves the cache before any disk call; every write goes through writeConfigAtomically', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'config.ts'), 'utf8').replace(/\r\n/g, '\n');
  const body = src.slice(src.indexOf('function readConfigCached(fresh: boolean): HarnessConfig {'), src.indexOf('\n}\n', src.indexOf('function readConfigCached(fresh: boolean): HarnessConfig {')));
  assert.ok(body.indexOf('return c.value;') < body.indexOf('statOrNull(p)'), 'the window check comes before the stat');
  assert.ok(!/existsSync\(p\)/.test(body), 'no per-call existsSync');
  // Every read-modify-write and integrity check in this module reads fresh; readConfig() is only defined here.
  assert.equal((src.match(/readConfigCached\(true\)/g) || []).length, 8);
  assert.equal((src.match(/readConfig\(\)/g) || []).length, 1);
  // config.json is only ever published by writeConfigAtomically (which replaces the cache).
  assert.equal((src.match(/writeConfigAtomically\(p, /g) || []).length, 3, 'persistConfig, pruneRetiredConfigKeys and resetConfig');
  const atomic = src.slice(src.indexOf('function writeConfigAtomically('), src.indexOf('\n}\n', src.indexOf('function writeConfigAtomically(')));
  assert.equal((atomic.match(/configCache = null;/g) || []).length, 2, 'a write drops the cache, failed or not');
  assert.ok(atomic.endsWith('  configWriteGen++;\n  configCache = null;'), 'the success path');
  assert.ok(!/statOrNull|statSync|configCache = \{/.test(atomic), 'no write-through entry, no stat after the rename (Jim P1)');
});
