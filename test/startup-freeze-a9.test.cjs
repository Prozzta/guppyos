'use strict';
require('./tools/own-job.cjs');

/**
 * STARTUP-FREEZE-104 A9 (Jim's 10x gate of 5b4db994): every claim with a new key parsed memory-keys.json into its
 * own copy and wrote the whole file back (1.87 MB growing to 4.08 MB; about 6,300 adds per cold start = about
 * 19 GB parsed and written on main). The store now keeps one KeyRegistryWriter per hive:
 *  - a burst of new keys reads the file once and writes it once (fs spy);
 *  - a key enters only when its claim is acked, and one claims-key-added row is logged per add;
 *  - every registry reader (loadRegistry, loadRegistryShared, the get path's raw text read) and close() save the
 *    acked keys first; without a reader the timer saves them within REGISTRY_SAVE_MS;
 *  - another writer's change is re-read and the unsaved keys are put on top; a failed save drops them and logs
 *    claims-key-save-failed per key, as before.
 * Temp hives in a jailed HOME only.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-sf104-a9-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
const STORES = [];
test.after(() => {
  for (const s of STORES) s.close();
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const loadTs = require('./load-ts.cjs');
const { ClaimStore } = loadTs('src/main/claims/store.ts');
const { SandboxKeyProvider, FileLedgerKeyRecord, KEY_RECORD_FILE } = loadTs('src/main/claims/keyProvider.ts');
const REG = loadTs('src/main/claims/registry.ts');

let hiveN = 0;
function hive() {
  const root = path.join(JAIL, `hive-${++hiveN}`);
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  return root;
}
function mkStore(root, io) {
  const logs = [];
  let t = Date.parse('2026-10-03T10:00:00Z');
  const now = () => new Date(t += 1000);
  const store = new ClaimStore({ hiveRoot: root, keys: new SandboxKeyProvider(), keyRecord: new FileLedgerKeyRecord(path.join(`${root}-userdata`, KEY_RECORD_FILE)), now, log: (r) => logs.push(r), alert: () => {}, ...(io ? { io } : {}) });
  STORES.push(store);
  return { store, logs };
}
const note = (text, key) => ({ t: 'claim', kind: 'fact', text, key });
async function ok(p) { const r = await p; assert.equal(r.ok, true, JSON.stringify(r)); return r.id; }
const regFile = (root) => REG.registryPath(root);
const fileKeys = (root) => (fs.existsSync(regFile(root)) ? Object.keys(JSON.parse(fs.readFileSync(regFile(root), 'utf8')).keys) : []);
const added = (logs) => logs.filter((l) => l.kind === 'claims-key-added').map((l) => l.key);

/** Counts reads and writes of the registry file (and its tmp) while `fn` runs. */
async function spyRegistry(root, fn) {
  const p = path.resolve(regFile(root));
  const n = { reads: 0, writes: 0, renames: 0 };
  const real = { readFileSync: fs.readFileSync, writeFileSync: fs.writeFileSync, renameSync: fs.renameSync };
  fs.readFileSync = function (q, ...x) { if (path.resolve(String(q)) === p) n.reads++; return real.readFileSync.call(this, q, ...x); };
  fs.writeFileSync = function (q, ...x) { if (String(q).startsWith(p)) n.writes++; return real.writeFileSync.call(this, q, ...x); };
  fs.renameSync = function (a, b, ...x) { if (path.resolve(String(b)) === p) n.renames++; return real.renameSync.call(this, a, b, ...x); };
  try { await fn(); } finally { Object.assign(fs, real); }
  return n;
}

test('a burst of 300 new keys reads the registry once and writes it once', async () => {
  const root = hive();
  const { store, logs } = mkStore(root);
  await ok(store.appendRecord('andy', note('seed', 'agent.andy.seed'), 'endpoint'));
  store.flushKeyRegistry();
  const keys = Array.from({ length: 300 }, (_, i) => `card.a9-burst-${i}`);
  const t0 = Date.now();
  const n = await spyRegistry(root, async () => {
    for (const k of keys) await ok(store.appendRecord('andy', note(`fact ${k}`, k), 'endpoint'));
    store.flushKeyRegistry();
  });
  // One save per REGISTRY_SAVE_MS at most (a loaded machine may take longer than 1 s), and the final flush.
  const bound = 1 + Math.floor((Date.now() - t0) / REG.REGISTRY_SAVE_MS);
  assert.ok(n.reads <= 1, `the registry is parsed at most once for the burst (was once per key): ${n.reads}`);
  assert.ok(n.writes >= 1 && n.writes <= bound, `saves ${n.writes}, bound ${bound} (was one per key: 300)`);
  assert.equal(n.renames, n.writes, 'atomic: each save is a tmp + rename');
  assert.deepEqual(added(logs), ['agent.andy.seed', ...keys], 'one claims-key-added row per add, in order');
  const onDisk = new Set(fileKeys(root));
  for (const k of ['agent.andy.seed', ...keys]) assert.ok(onDisk.has(k), k);
  assert.equal(JSON.parse(fs.readFileSync(regFile(root), 'utf8')).keys['card.a9-burst-7'].addedBy, 'andy');
});

test('the same new key twice is added once; a near miss of an unsaved key is refused', async () => {
  const root = hive();
  const { store, logs } = mkStore(root);
  await ok(store.appendRecord('andy', note('one', 'release.current'), 'endpoint'));
  await ok(store.appendRecord('andy', note('two', 'release.current'), 'endpoint'));
  assert.deepEqual(added(logs), ['release.current']);
  const r = await store.appendRecord('andy', note('x', 'release.curent'), 'endpoint');
  assert.equal(r.ok, false);
  assert.equal(r.didYouMean, 'release.current');
});

test('every registry reader sees an acked key without a flush; the get path flushes before its raw read', async () => {
  for (const reader of ['loadRegistry', 'loadRegistryShared']) {
    const root = hive();
    const { store } = mkStore(root);
    await ok(store.appendRecord('andy', note('x', 'agent.andy.editor'), 'endpoint'));
    assert.equal(REG[reader](root).keys['agent.andy.editor']?.cardinality, 'single', reader);
    assert.ok(fileKeys(root).includes('agent.andy.editor'), `${reader} saved it`);
  }
  // A loadRegistryShared cache HIT (an old, unchanged file) must still see a key acked after it was cached.
  const root = hive();
  const { store } = mkStore(root);
  await ok(store.appendRecord('andy', note('x', 'agent.andy.first'), 'endpoint'));
  store.flushKeyRegistry();
  const old = Date.now() / 1000 - 60;
  fs.utimesSync(regFile(root), old, old);           // past the racy window: the next read is kept
  const cached = REG.loadRegistryShared(root);
  assert.equal(REG.loadRegistryShared(root), cached, 'primed: a cache hit');
  await ok(store.appendRecord('andy', note('y', 'agent.andy.second'), 'endpoint'));
  assert.equal(REG.loadRegistryShared(root).keys['agent.andy.second']?.cardinality, 'single', 'not the stale cached object');
  const rw = fs.readFileSync(path.join(ROOT, 'src/main/claims/readWiring.ts'), 'utf8');
  assert.match(rw, /flushRegistryWrites\(root\);[^\n]*\n\s*let regText: string \| null; try \{ regText = readFileSync\(registryPath\(root\), 'utf8'\)/);
});

test('main saves acked keys at quit (after the agent sweep, before exit) and on a hive change', () => {
  const idx = fs.readFileSync(path.join(ROOT, 'src/main/index.ts'), 'utf8');
  const finish = idx.slice(idx.indexOf("kind: 'quit-done'"), idx.indexOf('app.exit(0);', idx.indexOf("kind: 'quit-done'")));
  assert.match(finish, /try \{ claimStore\?\.store\.flushKeyRegistry\(\); \}/, 'the will-quit finish flushes');
  assert.match(idx, /if \(!claimStore \|\| claimStore\.root !== root\) \{[\s\S]{0,120}if \(claimStore\) \{ try \{ claimStore\.store\.flushKeyRegistry\(\); \}/, 'a hive change flushes the old store');
});

test('without a reader the timer saves within REGISTRY_SAVE_MS; close() saves at once', async () => {
  assert.equal(REG.REGISTRY_SAVE_MS, 1000);
  const root = hive();
  const { store } = mkStore(root);
  await ok(store.appendRecord('andy', note('x', 'agent.andy.timer'), 'endpoint'));
  assert.ok(!fileKeys(root).includes('agent.andy.timer'), 'not saved per key');
  await new Promise((r) => setTimeout(r, 1300));
  assert.ok(fileKeys(root).includes('agent.andy.timer'), 'saved by the timer');
  const root2 = hive();
  const { store: s2 } = mkStore(root2);
  await ok(s2.appendRecord('andy', note('x', 'agent.andy.quit'), 'endpoint'));
  s2.close();
  assert.ok(fileKeys(root2).includes('agent.andy.quit'), 'close saves');
});

test('store: a claim whose append fails adds no key (the key is still new for the next claim)', async () => {
  const root = hive();
  let fail = true;
  const io = {
    openSync: (p, f) => fs.openSync(p, f), writeSync: (fd, buf) => fs.writeSync(fd, buf), closeSync: (fd) => fs.closeSync(fd),
    fsync: (fd, cb) => { if (fail) { fail = false; setImmediate(() => cb(new Error('simulated EIO'))); return; } fs.fsync(fd, cb); },
  };
  const { store, logs } = mkStore(root, io);
  const r = await store.appendRecord('andy', note('lost', 'agent.andy.unacked'), 'endpoint');
  assert.equal(r.ok, false);
  store.flushKeyRegistry();
  assert.ok(!fileKeys(root).includes('agent.andy.unacked'), 'not in the file');
  assert.equal(REG.loadRegistry(root).keys['agent.andy.unacked'], undefined, 'not in what readers see');
  assert.deepEqual(added(logs), []);
  await ok(store.appendRecord('andy', note('kept', 'agent.andy.unacked'), 'endpoint'));
  assert.deepEqual(added(logs), ['agent.andy.unacked'], 'added by the claim that was acked');
});

test('writer: check() keeps nothing until commit (a failed append adds no key)', () => {
  const root = hive();
  const w = new REG.KeyRegistryWriter(root, () => {});
  const a = w.check('agent.andy.x', 'andy', '2026-10-03T10:00:00Z');
  assert.equal(a.ok && a.added, true);
  const b = w.check('agent.andy.x', 'andy', '2026-10-03T10:00:01Z');
  assert.equal(b.ok && b.added, true, 'not committed: still new');
  w.flush();
  assert.deepEqual(fileKeys(root), []);
  w.commit('agent.andy.x', b.entry);
  const c = w.check('agent.andy.x', 'andy', '2026-10-03T10:00:02Z');
  assert.equal(c.ok && c.added, false, 'committed: known');
  w.flush();
  assert.equal(JSON.parse(fs.readFileSync(regFile(root), 'utf8')).keys['agent.andy.x'].addedAt, '2026-10-03T10:00:01Z');
});

test('writer: another writer\'s change is kept and the unsaved keys go on top', () => {
  const root = hive();
  const w = new REG.KeyRegistryWriter(root, () => {});
  const a = w.check('agent.andy.mine', 'andy', '2026-10-03T10:00:00Z');
  w.commit('agent.andy.mine', a.entry);
  const other = REG.loadRegistry(root);           // flushes mine first
  other.keys['agent.pam.theirs'] = { cardinality: 'single', addedAt: '2026-10-03T10:00:05Z', addedBy: 'pam' };
  const b = w.check('agent.andy.second', 'andy', '2026-10-03T10:00:06Z');
  w.commit('agent.andy.second', b.entry);
  REG.saveRegistry(root, other);                   // a foreign save after my commit, without my second key
  w.flush();
  assert.deepEqual(fileKeys(root).sort(), ['agent.andy.mine', 'agent.andy.second', 'agent.pam.theirs']);
});

test('writer: a failed save drops the unsaved keys, logs each, and the key is new again', () => {
  const root = hive();
  const failed = [];
  const w = new REG.KeyRegistryWriter(root, (keys) => failed.push(...keys));
  const a = w.check('agent.andy.lost', 'andy', '2026-10-03T10:00:00Z');
  w.commit('agent.andy.lost', a.entry);
  const real = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };
  try { w.flush(); } finally { fs.renameSync = real; }
  assert.deepEqual(failed, ['agent.andy.lost']);
  const again = w.check('agent.andy.lost', 'andy', '2026-10-03T10:00:01Z');
  assert.equal(again.ok && again.added, true);
});

test('store: a failed save is logged as claims-key-save-failed with the key', async () => {
  const root = hive();
  const { store, logs } = mkStore(root);
  await ok(store.appendRecord('andy', note('x', 'agent.andy.f'), 'endpoint'));
  const real = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); };
  try { store.flushKeyRegistry(); } finally { fs.renameSync = real; }
  assert.ok(logs.some((l) => l.kind === 'claims-key-save-failed' && l.key === 'agent.andy.f'));
});
