'use strict';

/**
 * MAIN-SYNC-LOG-LEDGER (registry): HiveManager.registry() was a disk read + parse on every call
 * (~430 calls/min on Guppy main under a heavy run on 1.1.99). It now serves one deep-frozen parsed
 * roster from memory. Our own writes drop it (the next read sees them); a write by another process
 * is picked up by fs.watch or, as the authority, by a stat revalidate at most
 * AUTHORITY_REVALIDATE_MS (1 s) after the last check. Mutations still read the file fresh
 * (registryForMutation), and the missing, corrupt and unreadable paths are not cached.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const WINDOW = HiveManager.AUTHORITY_REVALIDATE_MS;
const agent = (id, extra = {}) => ({ id, name: id, role: 'worker', status: 'idle', lastSeen: 1, capabilities: ['a'], ...extra });

let clock = 1_000_000;
const tick = (ms) => { clock += ms; };
function floor(t, agents = { a1: agent('a1') }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-registry-read-cache-'));
  const hive = new HiveManager(() => home);
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  hive.ensureHive();
  const file = path.join(hive.root(), 'registry.json');
  const handEdit = (reg) => fs.writeFileSync(file, JSON.stringify(reg), 'utf8');
  handEdit({ godId: null, agents });
  hive.__resetAuthorityCacheForTests(() => clock);
  return { hive, file, handEdit };
}
/** Count the registry.json disk reads and stats inside fn. */
function io(file, fn) {
  const { readFileSync, statSync } = fs;
  const n = { reads: 0, stats: 0 };
  fs.readFileSync = function (p, ...rest) { if (String(p) === file) n.reads++; return readFileSync.call(this, p, ...rest); };
  fs.statSync = function (p, ...rest) { if (String(p) === file) n.stats++; return statSync.call(this, p, ...rest); };
  try { n.result = fn(); } finally { fs.readFileSync = readFileSync; fs.statSync = statSync; }
  return n;
}

test('1000 reads inside the window reach disk once, return one deep-frozen object, and never stat again', (t) => {
  const { hive, file } = floor(t);
  const first = io(file, () => hive.registry());
  assert.deepEqual([first.reads, first.stats], [1, 1]);
  const many = io(file, () => { let last; for (let i = 0; i < 1000; i++) { tick(0.5); last = hive.registry(); } return last; });
  assert.deepEqual([many.reads, many.stats], [0, 0], 'served from memory, no disk call at all');
  assert.equal(many.result, first.result, 'the same object, not a clone per call');
  const r = many.result;
  assert.ok(Object.isFrozen(r) && Object.isFrozen(r.agents) && Object.isFrozen(r.agents.a1) && Object.isFrozen(r.agents.a1.capabilities));
  assert.throws(() => { r.godId = 'x'; }, TypeError);
  assert.throws(() => { r.agents.a1.onHold = true; }, TypeError);
  assert.throws(() => { r.agents.a1.capabilities.push('b'); }, TypeError);
  assert.throws(() => { delete r.agents.a1; }, TypeError);
});

test('a mutation reads the file fresh, never the frozen cache, and its write is seen by the next read', (t) => {
  const { hive, file, handEdit } = floor(t);
  hive.registry();
  // Another process changes the roster inside the window: the mutation must build on it.
  handEdit({ godId: null, agents: { a1: agent('a1'), a2: agent('a2') } });
  assert.equal(hive.registry().agents.a2, undefined, 'readers may lag by up to the window');
  assert.deepEqual(hive.setAgentHold('a2', true), { ok: true, onHold: true }, 'the mutation saw a2');
  const after = io(file, () => hive.registry());
  assert.equal(after.reads, 1, 'our write dropped the cache');
  assert.equal(after.result.agents.a2.onHold, true);
  assert.ok(after.result.agents.a1, 'no lost update: a1 kept');
  assert.ok(Object.isFrozen(after.result.agents.a2));
  assert.deepEqual(after.result, JSON.parse(fs.readFileSync(file, 'utf8')), 'equal to a cold read');
});

test('an external edit is invisible inside the window and picked up by the stat revalidate at AUTHORITY_REVALIDATE_MS', (t) => {
  assert.ok(WINDOW <= 1000, 'revalidate within 1 s');
  const { hive, file, handEdit } = floor(t);
  assert.equal(hive.registry().godId, null);
  handEdit({ godId: 'g1', agents: { g1: agent('g1') } });
  tick(WINDOW - 1);
  assert.equal(hive.registry().godId, null, 'inside the window (no event loop turn, so no watcher yet)');
  tick(1);
  const r = io(file, () => hive.registry());
  assert.equal(r.result.godId, 'g1');
  assert.deepEqual([r.reads, r.stats], [1, 1]);
  tick(WINDOW);
  const same = io(file, () => hive.registry());
  assert.deepEqual([same.reads, same.stats], [0, 1], 'unchanged on disk: a stat, no read');
  assert.equal(same.result, r.result);
  clock -= 10 * WINDOW;
  assert.equal(io(file, () => hive.registry()).stats, 1, 'a clock that went back revalidates');
});

test('fs.watch marks the cache dirty: an external edit is seen before the window ends', async (t) => {
  const { hive, handEdit } = floor(t);
  assert.equal(hive.registry().godId, null);
  await new Promise((r) => setTimeout(r, 100));
  handEdit({ godId: 'g2', agents: { g2: agent('g2') } });
  const until = Date.now() + 5000;
  while (hive.registry().godId !== 'g2' && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
  assert.equal(hive.registry().godId, 'g2', 'the frozen test clock never reached the window: only the watcher can have done it');
});

test('corrupt registry: not cached, quarantined once, mutations refused; integrityIssues sees it inside the window; a repair is seen at once', (t) => {
  const { hive, file, handEdit } = floor(t);
  hive.registry();
  const corrupt = '{"agents":';
  fs.writeFileSync(file, corrupt, 'utf8');
  assert.match(hive.integrityIssues()[0].quarantine, /^registry\.json\.corrupt-/, 'a forced scan skips the window');
  const r = io(file, () => [hive.registry(), hive.registry()]);
  assert.equal(r.reads, 2, 'each read re-reads, as before');
  assert.deepEqual(r.result[0], { godId: null, agents: {} });
  assert.equal(Object.isFrozen(r.result[0]), false, 'the safe default is a fresh object');
  assert.match(hive.setAgentHold('a1', true).error, /registry\.json is invalid JSON; refusing to overwrite it/);
  assert.equal(fs.readFileSync(file, 'utf8'), corrupt);
  assert.equal(fs.readdirSync(hive.root()).filter((n) => n.startsWith('registry.json.corrupt-')).length, 1);
  handEdit({ godId: 'g3', agents: {} });
  assert.equal(hive.registry().godId, 'g3', 'no window to wait out after a corrupt read');
  assert.deepEqual(hive.integrityIssues().filter((i) => i.file === 'registry.json'), []);
});

test('a missing registry gives fresh defaults and is not cached', (t) => {
  const { hive, file } = floor(t);
  hive.registry();
  fs.rmSync(file);
  tick(WINDOW);
  const d = hive.registry();
  assert.deepEqual(d, { godId: null, agents: {} });
  assert.equal(Object.isFrozen(d), false);
  const again = io(file, () => hive.registry());
  assert.equal(again.stats, 1, 'not cached: checked on every call');
  assert.notEqual(again.result, d);
});

test('an unreadable registry still throws, and is not cached', (t) => {
  const { hive, file } = floor(t);
  const { readFileSync } = fs;
  fs.readFileSync = function (p, ...rest) { if (String(p) === file) { const e = new Error('locked'); e.code = 'EBUSY'; throw e; } return readFileSync.call(this, p, ...rest); };
  try { assert.throws(() => hive.registry(), /registry\.json could not be read: locked/); } finally { fs.readFileSync = readFileSync; }
  assert.ok(hive.registry().agents.a1);
});

test('a failed write drops the cache: the next read goes to disk and returns what is there', (t) => {
  const { hive, file } = floor(t);
  hive.registry();
  const { renameSync } = fs;
  fs.renameSync = () => { const e = new Error('denied'); e.code = 'EACCES'; throw e; };
  try { assert.equal(hive.setAgentHold('a1', true).ok, false); } finally { fs.renameSync = renameSync; }
  const r = io(file, () => hive.registry());
  assert.equal(r.reads, 1);
  assert.equal(r.result.agents.a1.onHold, undefined);
});

test('wiring: readers use the cache, mutations read the file, every registry write drops the cache', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'hive.ts'), 'utf8').replace(/\r\n/g, '\n');
  const body = (sig) => { const i = src.indexOf(sig); assert.ok(i >= 0, sig); return src.slice(i, src.indexOf('\n  }\n', i)); };
  assert.match(body('  registry(fresh = false): Registry {'), /this\.readAuthoritativeJsonCached\(join\(root, 'registry\.json'\)/);
  assert.match(body('  private registryForMutation(): Registry {'), /this\.readAuthoritativeJson\(join\(root, 'registry\.json'\)/);
  assert.ok(!/readAuthoritativeJsonCached/.test(body('  private registryForMutation(): Registry {')));
  assert.match(body('  integrityIssues(): HiveIntegrityIssue[] {'), /this\.registry\(true\);/);
  assert.match(body('  private atomicWriteJson(p: string, data: unknown): void {'), /finally \{ this\.authorityCache\.delete\(p\); \}/);
  // registry.json is only ever written through writeJson / atomicWriteJson.
  const direct = src.split('\n').filter((l) => /registry\.json/.test(l) && /writeFileSync|renameSync|atomicWriteJsonFile\(/.test(l));
  assert.deepEqual(direct, []);
  assert.match(body('  dispose(): void {'), /this\.closeAuthorityWatchers\(\);/);
});
