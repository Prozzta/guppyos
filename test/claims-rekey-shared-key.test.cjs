'use strict';
require('./tools/own-job.cjs');
/**
 * CLAIMS-REKEY-SHARED-KEY (Jim, CLAIMS-KEY-MISSING-1110 item 5): one user-data folder holds ONE
 * claims-mac.key for every floor. A rekey or a fresh floor's first use must never replace it, or
 * every other floor goes key-missing (read-only). The record files are shared too, and two app
 * instances must not lose each other's entries.
 *   R1 floors A, B and C share one user-data folder; rekeying them in turn leaves all three verifying.
 *   R2 a fresh floor joining a working folder adopts the shared key. (Already true on 4e39b652: a regression
 *      guard with no mutant; first use only creates when no key loads.)
 *   R3 an existing key file that does not decrypt is left as is by a first use and a rekey, and alerts.
 *   R4 the provider: create() makes a key only when no file exists, and leaves no tmp.
 *   R5 a rekey while the shared key loads never calls create().
 *   R6 the user-data lock is held while a write runs; a dead holder's stale lock is broken.
 *   R7 a lock held by a live holder is waited for a bounded time, then the write fails visibly.
 *   R8 an anchor set inside a census batch reads the file fresh: another instance's entry survives.
 *   plus: 4 processes x 40 concurrent record and anchor writes keep every entry (real sources).
 * Jim's d94d42a3 audit (SHOULD 1/2, NIT 1):
 *   R9 the unreadable-key alert names the key file path, the recovery step and what a rekey does to ledgers.
 *   R10 the publish under the lock survives a reader holding the file open and transient EPERM, and a
 *      persistent EPERM fails bounded with no tmp or lock left (from Jim's rk-probe.cjs).
 *   R11 a record or anchor write that throws never escapes the store: append/rekey/resetAnchor/readLedger
 *      return their result shape and log.
 *   R12 a key file that vanishes between create()'s check and its load is 'missing', not 'unreadable'.
 * Then a mutant census: rename-over, lock dropped, rekey mints, batch snapshot reused under the lock,
 * rename-over + rekey mints together (int 4e39b652's behaviour), then K6-K10 for R9-R12.
 * Synthetic floors (FLOOR-A/B/C) in temp dirs only. HOME and USERPROFILE are jailed and asserted
 * before any product code loads.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-claims-rekey-shared-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
const STORES = [];
test.after(() => {
  for (const s of STORES) { try { s.close(); } catch { /* closed */ } }
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');
const ROOT = path.join(__dirname, '..');
const KP = 'src/main/claims/keyProvider.ts';
const ST = 'src/main/claims/store.ts';
const real = { keys: loadTs(path.join(ROOT, KP)), store: loadTs(path.join(ROOT, ST)) };
const { KEY_RECORD_FILE, HEAD_ANCHOR_FILE, hiveIdOf } = real.keys;

// A stand-in for safeStorage: reversible, so a garbage file reads as decrypt-failed.
const fakeSafe = () => ({
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from('ENC:' + s),
  decryptString: (b) => { const t = b.toString(); if (!t.startsWith('ENC:')) throw new Error('bad'); return t.slice(4); },
});

let n = 0;
/** One user-data folder as main wires it (index.ts): one key file, one record, one anchor file. */
function userData(mods) {
  const K = mods.keys;
  const ud = path.join(JAIL, `userdata-${++n}`);
  fs.mkdirSync(ud, { recursive: true });
  return {
    ud,
    keyFile: path.join(ud, K.MAC_KEY_FILE),
    keys: new K.SafeStorageKeyProvider(path.join(ud, K.MAC_KEY_FILE), fakeSafe()),
    record: new K.FileLedgerKeyRecord(path.join(ud, K.KEY_RECORD_FILE)),
    anchors: new K.FileHeadAnchorStore(path.join(ud, K.HEAD_ANCHOR_FILE)),
  };
}
function floor(name) {
  const root = path.join(JAIL, `${name}-${++n}`, 'hive');
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  return root;
}
function open(mods, root, u, keys = u.keys, over = {}) {
  const alerts = [];
  const logs = [];
  let t = Date.parse('2026-11-10T08:00:00Z');
  const store = new mods.store.ClaimStore({ hiveRoot: root, keys, keyRecord: u.record, headAnchor: u.anchors, now: () => new Date(t += 1000), alert: (r) => alerts.push(r), log: (r) => logs.push(r), ...over });
  STORES.push(store);
  return { store, alerts, logs };
}
const note = (text) => ({ t: 'claim', kind: 'fact', text });
async function ok(p) { const r = await p; assert.equal(r.ok, true, JSON.stringify(r)); return r.id; }
const chain = (mods, root, u, a) => { const { store } = open(mods, root, u); const c = store.readLedger(a).chain; store.close(); return c; };
/** Floors whose ledgers were written under a key that is now gone (an old user-data folder). */
async function lostFloors(mods, names) {
  const lost = userData(mods);
  const floors = {};
  for (const name of names) {
    floors[name] = floor(`FLOOR-${name}`);
    const { store } = open(mods, floors[name], lost);
    for (const a of ['andy', 'dwight']) await ok(store.appendRecord(a, note(`${name} ${a} before`), 'endpoint'));
    store.close();
  }
  return floors;
}

async function threeFloorsRekeyed(mods) {
  const floors = await lostFloors(mods, ['A', 'B', 'C']);
  const u = userData(mods);
  for (const root of Object.values(floors)) assert.equal(chain(mods, root, u, 'andy').reason, 'key-missing');
  const rekeyed = {};
  let keyBytes = null;
  for (const [name, root] of Object.entries(floors)) {
    const { store } = open(mods, root, u);
    const rk = await store.rekey(true);
    store.close();
    assert.equal(rk.ok, true, `${name}: ${JSON.stringify(rk)}`);
    assert.deepEqual(rk.rekeyed.sort(), ['andy', 'dwight']);
    rekeyed[name] = rk.keyId;
    if (keyBytes === null) keyBytes = fs.readFileSync(u.keyFile);
    else assert.ok(fs.readFileSync(u.keyFile).equals(keyBytes), `${name}'s rekey left the shared key file as it was`);
    // Every floor rekeyed so far still verifies.
    for (const done of Object.keys(rekeyed)) {
      for (const a of ['andy', 'dwight']) assert.equal(chain(mods, floors[done], u, a), 'ok', `${done}/${a} after ${name}'s rekey`);
    }
  }
  assert.equal(new Set(Object.values(rekeyed)).size, 1, 'one shared key id for all three floors');
  assert.equal(u.keys.load().keyId, rekeyed.A);
  for (const root of Object.values(floors)) assert.equal(u.record.get(root), rekeyed.A, 'each floor recorded under the shared key id');
  // And all three can still write, then verify.
  for (const [name, root] of Object.entries(floors)) {
    const { store } = open(mods, root, u);
    await ok(store.appendRecord('andy', note(`${name} after`), 'endpoint'));
    store.close();
  }
  for (const root of Object.values(floors)) assert.equal(chain(mods, root, u, 'andy'), 'ok');
  // A second rekey of A (key still loads) mints nothing and keeps B and C working.
  const { store: again } = open(mods, floors.A, u);
  const rk2 = await again.rekey(true);
  again.close();
  assert.equal(rk2.keyId, rekeyed.A);
  assert.ok(fs.readFileSync(u.keyFile).equals(keyBytes));
  for (const root of Object.values(floors)) assert.equal(chain(mods, root, u, 'dwight'), 'ok');
}

async function freshFloorAdopts(mods) {
  const u = userData(mods);
  const A = floor('FLOOR-A');
  const { store: a } = open(mods, A, u);
  await ok(a.appendRecord('andy', note('A first'), 'endpoint'));
  a.close();
  const bytes = fs.readFileSync(u.keyFile);
  const D = floor('FLOOR-D');
  const { store: d } = open(mods, D, u);
  await ok(d.appendRecord('andy', note('D first'), 'endpoint'));
  d.close();
  assert.ok(fs.readFileSync(u.keyFile).equals(bytes), 'first use never replaced the key file');
  assert.equal(u.record.get(D), u.record.get(A));
  assert.equal(chain(mods, A, u, 'andy'), 'ok');
  assert.equal(chain(mods, D, u, 'andy'), 'ok');
}

async function undecryptableLeftAlone(mods) {
  const u = userData(mods);
  fs.writeFileSync(u.keyFile, 'not a key this profile can decrypt');
  const bytes = fs.readFileSync(u.keyFile);
  // Provider level: create() refuses instead of replacing.
  assert.deepEqual(u.keys.create(), { ok: false, reason: 'decrypt-failed' });
  assert.ok(fs.readFileSync(u.keyFile).equals(bytes));
  // A fresh floor's first use.
  const D = floor('FLOOR-D');
  const { store, alerts } = open(mods, D, u);
  const r = await store.appendRecord('andy', note('first'), 'endpoint');
  assert.equal(r.ok, false);
  assert.match(r.error, /no ledger key could be created \(decrypt-failed\)/);
  assert.ok(fs.readFileSync(u.keyFile).equals(bytes), 'first use left the undecryptable key file as is');
  assert.equal(u.record.get(D), null, 'nothing recorded');
  const unreadable = alerts.filter((x) => x.kind === 'claims-key-missing' && /does not decrypt/.test(x.reason));
  assert.equal(unreadable.length, 1, JSON.stringify(alerts));
  await store.appendRecord('andy', note('again'), 'endpoint');
  assert.equal(alerts.filter((x) => /does not decrypt/.test(x.reason ?? '')).length, 1, 'alerted once');
  store.close();
  // A rekey on a floor with a ledger refuses too.
  const { B } = await lostFloors(mods, ['B']);
  const { store: rs, alerts: ra } = open(mods, B, u);
  const rk = await rs.rekey(true);
  rs.close();
  assert.equal(rk.ok, false);
  assert.deepEqual(rk.refused, [{ agentId: 'andy', why: 'no key (decrypt-failed)' }, { agentId: 'dwight', why: 'no key (decrypt-failed)' }]);
  assert.ok(fs.readFileSync(u.keyFile).equals(bytes), 'the rekey left the undecryptable key file as is');
  assert.equal(ra.filter((x) => /does not decrypt/.test(x.reason ?? '')).length, 1);
}

function providerCreate(mods) {
  const u = userData(mods);
  const c = u.keys.create();
  assert.equal(c.ok, true);
  const bytes = fs.readFileSync(u.keyFile);
  const again = u.keys.create();
  assert.equal(again.ok, true);
  assert.equal(again.keyId, c.keyId, 'an existing key is returned, not replaced');
  assert.ok(fs.readFileSync(u.keyFile).equals(bytes));
  assert.deepEqual(fs.readdirSync(u.ud).sort(), [mods.keys.MAC_KEY_FILE]);
}

/** The store side on its own: a provider whose create() would mint is never asked while the key loads. */
async function rekeyNeverCreates(mods) {
  const { A } = await lostFloors(mods, ['A']);
  const u = userData(mods);
  const shared = u.keys.create();
  assert.equal(shared.ok, true);
  let creates = 0;
  const counting = { load: () => u.keys.load(), create: () => { creates++; return u.keys.create(); } };
  const { store } = open(mods, A, u, counting);
  const rk = await store.rekey(true);
  store.close();
  assert.equal(rk.ok, true, JSON.stringify(rk));
  assert.equal(creates, 0, 'a rekey while the shared key loads never calls create()');
  assert.equal(rk.keyId, shared.keyId);
}

function lockHeldAndStaleBroken(mods) {
  const u = userData(mods);
  const file = path.join(u.ud, KEY_RECORD_FILE);
  assert.equal(mods.keys.withUserDataLock(file, () => fs.existsSync(`${file}.lock`)), true, 'held while the write runs');
  assert.equal(fs.existsSync(`${file}.lock`), false, 'released after');
  fs.writeFileSync(`${file}.lock`, '99999');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(`${file}.lock`, old, old);
  u.record.set(floor('FLOOR-A'), 'k1');
  assert.equal(fs.existsSync(`${file}.lock`), false, "a dead holder's stale lock was broken");
}

function busyLockFailsVisibly(mods) {
  const u = userData(mods);
  const file = path.join(u.ud, HEAD_ANCHOR_FILE);
  fs.writeFileSync(`${file}.lock`, String(process.pid)); // a live holder: fresh mtime
  const t0 = Date.now();
  try {
    assert.throws(() => u.anchors.set(floor('FLOOR-A'), 'andy', { head: 'a'.repeat(64), lastId: 'c-1' }), /the user-data lock stayed busy/, 'a busy lock fails the write visibly');
    assert.ok(Date.now() - t0 >= 4500, `waited about LOCK_WAIT_MS before failing (${Date.now() - t0} ms)`);
    assert.equal(fs.existsSync(file), false, 'nothing written past a busy lock');
    assert.equal(fs.existsSync(`${file}.lock`), true, "the live holder's lock is left alone");
  } finally { fs.rmSync(`${file}.lock`, { force: true }); }
}

function batchSetReadsFresh(mods) {
  const u = userData(mods);
  const file = path.join(u.ud, HEAD_ANCHOR_FILE);
  const other = new mods.keys.FileHeadAnchorStore(file); // a second app instance
  const X = floor('FLOOR-X');
  const Y = floor('FLOOR-Y');
  u.anchors.set(X, 'andy', { head: '1'.repeat(64), lastId: 'c-1' });
  u.anchors.batch(() => {
    u.anchors.get(X, 'andy');
    other.set(Y, 'jim', { head: '2'.repeat(64), lastId: 'c-2' });
    u.anchors.set(X, 'andy', { head: '3'.repeat(64), lastId: 'c-3' });
  });
  const after = new mods.keys.FileHeadAnchorStore(file);
  assert.equal(after.get(Y, 'jim')?.head, '2'.repeat(64), "the other instance's entry survived a set inside a batch");
  assert.equal(after.get(X, 'andy')?.head, '3'.repeat(64));
}

/** Jim SHOULD 1: the unreadable-key alert names the full key path and the recovery, for first use and rekey. */
async function unreadableAlertNamesFileAndRecovery(mods) {
  const u = userData(mods);
  fs.writeFileSync(u.keyFile, 'not a key this profile can decrypt');
  const { store, alerts } = open(mods, floor('FLOOR-D'), u);
  assert.equal((await store.appendRecord('andy', note('first'), 'endpoint')).ok, false);
  store.close();
  const { B } = await lostFloors(mods, ['B']);
  const { store: rs, alerts: ra } = open(mods, B, u);
  assert.equal((await rs.rekey(true)).ok, false);
  rs.close();
  for (const [where, list] of [['first use', alerts], ['rekey', ra]]) {
    const row = list.find((x) => /does not decrypt/.test(x.reason ?? ''));
    assert.ok(row, `${where}: alerted`);
    assert.equal(row.file, u.keyFile, `${where}: the row names the full key path`);
    assert.ok(row.reason.includes(u.keyFile), `${where}: the reason names the full key path`);
    assert.equal(typeof row.recovery, 'string', `${where}: the row carries the recovery`);
    assert.ok(row.recovery.includes(`move ${u.keyFile} out of that folder`), `${where}: the exact step names the file`);
    assert.match(row.recovery, /quit every Guppy instance/);
    assert.match(row.recovery, /Keep the file/);
    // CLAIMS-REKEY-ENTRYPOINT-108: the recovery names the command that runs the rekey, and who approves it.
    assert.ok(row.recovery.includes("that floor's god runs `claims rekey --floor <hive folder>` and the Human confirms it in that floor's Guppy window"), `${where}: the recovery names the rekey command`);
    assert.ok(!/ask god to run it/.test(row.recovery), `${where}: no "ask god" without a command`);
    assert.match(row.recovery, /Until a floor is rekeyed, all of its claim ledgers stay read-only/);
    assert.match(row.recovery, /accepted on their prev chain only/);
  }
  assert.ok(fs.readFileSync(u.keyFile, 'utf8').startsWith('not a key'), 'no auto-replace');
}

/** EPERM as a rename over a file someone holds open fails on Windows (Jim's eperm probe). */
const eperm = () => Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
const atomic = loadTs(path.join(ROOT, 'src/main/atomicJson.ts'));
/**
 * This tree's fs-handle addon, pinned. Under ELECTRON_RUN_AS_NODE atomicJson looks in the runtime's
 * resourcesPath first, and an installed Guppy older than ASYNC-RENAME-POSIX-107 ships an addon with no
 * posixRename; the case tests what this branch ships.
 */
function treeAddon() {
  if (process.platform !== 'win32') return null;
  const m = { exports: {} };
  process.dlopen(m, path.join(ROOT, 'resources', 'fs-handle', 'bin', 'guppy_fs_handle.node'));
  assert.equal(typeof m.exports.posixRename, 'function', "this tree's addon has posixRename");
  return m.exports;
}

/** Jim SHOULD 2a: the locked rename retries (POSIX rename, then bounded EPERM/EBUSY retry) and leaves no tmp. */
async function renameRetriesUnderLock(mods) {
  atomic.__setRenameAddonForTest(treeAddon());
  try { await renameRetriesUnderLockWith(mods); } finally { atomic.__setRenameAddonForTest(undefined); }
}
async function renameRetriesUnderLockWith(mods) {
  const u = userData(mods);
  const X = floor('FLOOR-X');
  const file = path.join(u.ud, HEAD_ANCHOR_FILE);
  u.anchors.set(X, 'andy', { head: 'a'.repeat(64), lastId: 'c-0' });
  const leftovers = () => fs.readdirSync(u.ud).filter((f) => f.endsWith('.tmp') || f.endsWith('.lock'));
  // 1. A reader holding the file open (Windows: a plain rename over it is EPERM).
  if (process.platform === 'win32') {
    const fd = fs.openSync(file, 'r');
    try { assert.doesNotThrow(() => u.anchors.set(X, 'andy', { head: 'b'.repeat(64), lastId: 'c-1' }), 'a set over a reader holding the file open'); } finally { fs.closeSync(fd); }
    assert.equal(new mods.keys.FileHeadAnchorStore(file).get(X, 'andy')?.head, 'b'.repeat(64), 'set over an open reader');
  }
  // 2. Without the POSIX rename: two EPERMs then success is retried; EPERM every time fails bounded, no tmp left.
  const realRename = fs.renameSync;
  atomic.__setRenameAddonForTest(null);
  let calls = 0;
  try {
    fs.renameSync = (...a) => { if (++calls <= 2) throw eperm(); return realRename(...a); };
    u.record.set(X, 'key-retried');
    assert.equal(new mods.keys.FileLedgerKeyRecord(path.join(u.ud, KEY_RECORD_FILE)).get(X), 'key-retried', 'a transient EPERM was retried');
    calls = 0;
    fs.renameSync = () => { calls++; throw eperm(); };
    assert.throws(() => u.anchors.set(X, 'andy', { head: 'c'.repeat(64), lastId: 'c-2' }), /EPERM/);
    assert.ok(calls > 1 && calls <= 6, `the retry is bounded (${calls} attempts)`);
  } finally { fs.renameSync = realRename; atomic.__setRenameAddonForTest(treeAddon()); }
  assert.deepEqual(leftovers(), [], 'no tmp or lock left after a failed publish');
  // 3. Jim's eperm probe, short: a reader process in a tight readFileSync loop while sets run.
  const src = `const fs=require('fs');const e=Date.now()+1800;let n=0;while(Date.now()<e){try{fs.readFileSync(${JSON.stringify(file)});n++}catch{}}process.stdout.write(String(n))`; // write, not console.log: FORCE_COLOR would colour a number
  const rd = spawn(process.execPath, ['-e', src], { env: { ...process.env, HOME: JAIL, USERPROFILE: JAIL }, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let reads = '';
  rd.stdout.on('data', (d) => { reads += d; });
  const exited = new Promise((r) => rd.on('close', r)); // close: stdout drained too
  await new Promise((r) => setTimeout(r, 400));
  let sets = 0;
  const fails = {};
  for (const end = Date.now() + 1000; Date.now() < end;) {
    try { u.anchors.set(X, 'andy', { head: (sets + 1).toString(16).padStart(64, '0'), lastId: `c-${sets}` }); sets++; }
    catch (e) { fails[e.code ?? e.message.slice(0, 40)] = (fails[e.code ?? e.message.slice(0, 40)] ?? 0) + 1; }
  }
  await exited;
  assert.ok(Number(reads) > 0, 'the reader ran');
  assert.deepEqual(fails, {}, `every set over a busy reader succeeded (${sets} ok)`);
  assert.deepEqual(leftovers(), []);
}

/** A store whose set() throws, as a busy lock or an exhausted rename does. */
function throwingSet(target, isBroken) {
  return new Proxy(target, { get(t, k) {
    if (k === 'set') return (...a) => { if (isBroken()) throw eperm(); return t.set(...a); };
    const v = t[k];
    return typeof v === 'function' ? v.bind(t) : v;
  } });
}
const failedRows = (logs, kind) => logs.filter((r) => r.kind === kind).map((r) => r.at);

/** Jim SHOULD 2b: every anchor and key-record write a store makes returns its result shape and logs; nothing throws. */
async function storeSitesNeverThrow(mods) {
  let broken = false;
  const isBroken = () => broken;
  // keys() first use (store.ts keys) and appendNow's record after create(): append returns {ok:false}.
  for (const keyFirst of [true, false]) {
    const u = userData(mods);
    if (keyFirst) assert.equal(u.keys.create().ok, true);
    const F = floor('FLOOR-F');
    broken = true;
    const { store, logs } = open(mods, F, u, u.keys, { keyRecord: throwingSet(u.record, isBroken) });
    const r = await store.appendRecord('andy', note('first'), 'endpoint').catch((e) => ({ threw: String(e) }));
    assert.equal(r.ok, false, `append (key file ${keyFirst ? 'present' : 'absent'}): ${JSON.stringify(r)}`);
    assert.match(r.error, /the ledger key id could not be recorded \(Error: EPERM/);
    assert.deepEqual(failedRows(logs, 'claims-key-record-failed'), keyFirst ? ['first-use', 'first-use'] : ['first-use']);
    broken = false;
    await ok(store.appendRecord('andy', note('after'), 'endpoint'));
    store.close();
  }
  // rekey: every line written, then the record fails: a refusal naming why, and a retry works.
  const { B } = await lostFloors(mods, ['B']);
  const u = userData(mods);
  broken = true;
  const rec = throwingSet(u.record, isBroken);
  const { store: rs, logs: rl } = open(mods, B, u, u.keys, { keyRecord: rec });
  const rk = await rs.rekey(true).catch((e) => ({ threw: String(e) }));
  assert.equal(rk.ok, false, JSON.stringify(rk));
  assert.deepEqual(rk.rekeyed, [], 'a ledger whose key id was not recorded is not reported as rekeyed');
  assert.equal(rk.recorded, false);
  assert.deepEqual(rk.refused.map((x) => x.agentId).sort(), ['andy', 'dwight']);
  assert.ok(rk.refused.every((x) => /^not in effect: the key id was not recorded \(Error: EPERM.*\), retry the rekey$/.test(x.why)), JSON.stringify(rk.refused));
  assert.deepEqual(failedRows(rl, 'claims-key-record-failed'), ['rekey']);
  assert.equal(rl.find((r) => r.kind === 'claims-rekey')?.recorded, false);
  assert.equal(rs.readLedger('andy').chain.reason, 'key-missing', 'unrecorded: still read-only');
  broken = false;
  const rk2 = await rs.rekey(true);
  assert.equal(rk2.ok, true, JSON.stringify(rk2));
  rs.close();
  assert.equal(chain(mods, B, u, 'andy'), 'ok');
  // Anchors: the Human's reset returns false; a pending purge's commit or drop on read is logged.
  const A = floor('FLOOR-A');
  const ua = userData(mods);
  const anchors = throwingSet(ua.anchors, isBroken);
  const { store: as } = open(mods, A, ua, ua.keys, { headAnchor: anchors });
  await ok(as.appendRecord('andy', note('one'), 'endpoint'));
  await ok(as.appendRecord('andy', note('two'), 'endpoint'));
  as.close();
  const segs = fs.readdirSync(path.join(A, 'agents', 'andy', 'memory', 'claims')).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(A, 'agents', 'andy', 'memory', 'claims', f));
  const lines = segs.flatMap((f) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean));
  const sha = (s) => require('node:crypto').createHash('sha256').update(s).digest('hex');
  const head = sha(lines[lines.length - 1]);
  const mid = sha(lines[0]);
  const lastId = JSON.parse(lines[lines.length - 1]).id;
  broken = true;
  {
    const { store, logs } = open(mods, A, ua, ua.keys, { headAnchor: anchors });
    assert.equal(await store.resetAnchor('andy', true).catch((e) => `threw ${e}`), false, 'reset reports the failed write');
    assert.deepEqual(failedRows(logs, 'claims-anchor-failed'), ['reset']);
    store.close();
  }
  for (const [pending, at] of [[{ head, lastId }, 'purge-commit'], [{ head: 'f'.repeat(64), lastId: 'c-gone' }, 'purge-drop']]) {
    ua.anchors.set(A, 'andy', { head: at === 'purge-commit' ? mid : head, lastId, pending });
    const { store, logs } = open(mods, A, ua, ua.keys, { headAnchor: anchors });
    let c;
    assert.doesNotThrow(() => { c = store.readLedger('andy').chain; }, `${at}: a failed anchor write never throws out of a read`);
    assert.equal(c, 'ok', at);
    assert.ok(failedRows(logs, 'claims-anchor-failed').includes(at), `${at}: logged ${JSON.stringify(logs.filter((r) => r.kind === 'claims-anchor-failed'))}`);
    store.close();
  }
  broken = false;
}

/** Jim NIT 1: the key file vanishing between create()'s existence check and its load is 'missing', so create makes one. */
function vanishedKeyIsMissing(mods) {
  const u = userData(mods);
  assert.equal(u.keys.create().ok, true);
  let calls = 0;
  const safe = { ...fakeSafe(), isEncryptionAvailable: () => { if (++calls === 2) fs.rmSync(u.keyFile); return true; } };
  const kp = new mods.keys.SafeStorageKeyProvider(u.keyFile, safe);
  const r = kp.create();
  assert.equal(r.ok, true, `a vanished key file is not 'decrypt-failed': ${JSON.stringify(r)}`);
  assert.equal(kp.load().keyId, r.keyId, 'the new key is on disk');
  assert.deepEqual(fs.readdirSync(u.ud).sort(), [mods.keys.MAC_KEY_FILE]);
}

const CASES = [
  ['R1', threeFloorsRekeyed], ['R2', freshFloorAdopts], ['R3', undecryptableLeftAlone], ['R4', providerCreate],
  ['R5', rekeyNeverCreates], ['R6', lockHeldAndStaleBroken], ['R7', busyLockFailsVisibly], ['R8', batchSetReadsFresh],
  ['R9', unreadableAlertNamesFileAndRecovery], ['R10', renameRetriesUnderLock], ['R11', storeSitesNeverThrow], ['R12', vanishedKeyIsMissing],
];
/** An assertion failure names its case, so the census can tell where a mutant died. */
async function runCase(id, fn, mods) {
  try { await fn(mods); } catch (e) {
    if (e instanceof assert.AssertionError) e.message = `${id}: ${e.message}`;
    throw e;
  }
}
for (const [id, fn] of CASES) test(`${id}: ${fn.name}`, () => runCase(id, fn, real));

function runChild(ud, tag, count, goFile) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(__dirname, 'claims-rekey-shared-key', 'record-child.cjs'), ud, tag, String(count), goFile], {
      env: { ...process.env, HOME: JAIL, USERPROFILE: JAIL, CLAIMS_REKEY_JAIL: JAIL }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => resolve({ code, err }));
  });
}

test('concurrent record and anchor writes from several instances keep every entry', async () => {
  const u = userData(real);
  const goFile = path.join(u.ud, 'go');
  const tags = ['P1', 'P2', 'P3', 'P4'];
  const count = 40;
  const runs = tags.map((t) => runChild(u.ud, t, count, goFile));
  await new Promise((r) => setTimeout(r, 1500)); // let every child load and wait on the go file
  fs.writeFileSync(goFile, '');
  const res = await Promise.all(runs);
  for (const [i, r] of res.entries()) assert.equal(r.code, 0, `${tags[i]}: ${r.err}`);
  const recs = JSON.parse(fs.readFileSync(path.join(u.ud, KEY_RECORD_FILE), 'utf8')).hives;
  const anchors = JSON.parse(fs.readFileSync(path.join(u.ud, HEAD_ANCHOR_FILE), 'utf8')).hives;
  for (const t of tags) {
    for (let i = 0; i < count; i++) {
      const id = hiveIdOf(path.join(u.ud, '..', `FLOOR-${t}-${i}`));
      assert.equal(recs[id]?.keyId, `key-${t}-${i}`, `record entry ${t}-${i}`);
      assert.equal(anchors[id]?.andy?.head, `head-${t}-${i}`, `anchor entry ${t}-${i}`);
    }
  }
  assert.equal(Object.keys(recs).length, tags.length * count);
  assert.ok(!fs.readdirSync(u.ud).some((f) => f.endsWith('.lock') || f.endsWith('.tmp')), 'no lock or tmp left behind');
});

// Each edit is [file, from, to]. R1 is guarded twice (create() never replaces, and rekey adopts a
// loading key), so only both halves together (K5, int's old behaviour) reach it.
const RENAME_OVER = [
  [KP, '    if (existsSync(this.file)) return this.existing(retry);\n    const key = randomBytes(KEY_BYTES);', '    const key = randomBytes(KEY_BYTES);'],
  [KP, '      linkSync(tmp, this.file);', "      require('node:fs').renameSync(tmp, this.file);"],
];
const REKEY_MINTS = [[ST, "const made = cur.ok ? cur : cur.reason === 'missing' ? this.d.keys.create() : cur;", 'const made = this.d.keys.create();']];
const MUTANTS = [
  { id: 'K1', what: 'create() renames a new key over the shared file', edits: RENAME_OVER, dies: ['R3', 'R4'] },
  { id: 'K2', what: 'the user-data lock is dropped',
    edits: [[KP, '  const lock = `${file}.lock`;\n  mkdirSync(dirname(file), { recursive: true });', '  if (file) return fn();\n  const lock = `${file}.lock`;\n  mkdirSync(dirname(file), { recursive: true });']], dies: ['R6', 'R7'] },
  { id: 'K3', what: 'rekey mints through create() even while the shared key loads', edits: REKEY_MINTS, dies: ['R5'] },
  { id: 'K4', what: 'a locked anchor set reuses the batch snapshot',
    edits: [[KP, '    // may have written since, and its entries must survive this write.\n    this.cache = null;\n    this.batchFresh = false;\n', '    // may have written since, and its entries must survive this write.\n']], dies: ['R8'] },
  { id: 'K5', what: "int's old behaviour: rekey mints and create() renames over", edits: [...RENAME_OVER, ...REKEY_MINTS], dies: ['R1', 'R3', 'R4', 'R5'] },
  // Jim's 2 SHOULD + 2 NIT (god 350c1c).
  { id: 'K6', what: 'the unreadable-key alert drops the path and recovery',
    edits: [[ST, '      kind: CLAIMS_ALERT_KEY_MISSING, file, to: [\'god\', \'human\'],', '      kind: CLAIMS_ALERT_KEY_MISSING, to: [\'god\', \'human\'],'], [ST, '      recovery: unreadableKeyRecovery(file),\n', '']], dies: ['R9'] },
  { id: 'K7', what: 'the locked rename is a plain renameSync (no POSIX rename, no retry)',
    edits: [[KP, "import { renameWithRetry } from '../atomicJson';", "import { renameSync as renameWithRetry } from 'node:fs';"]], dies: ['R10'] },
  { id: 'K8', what: 'a failed key-record write throws out of the store',
    edits: [[ST, '    catch (e) {\n      const error = String(e).slice(0, 160);', '    catch (e) {\n      if (e) throw e;\n      const error = String(e).slice(0, 160);']], dies: ['R11'] },
  { id: 'K9', what: 'a failed anchor write throws out of the store',
    edits: [[ST, "    catch (e) { this.log({ kind: 'claims-anchor-failed', agentId, at,", "    catch (e) { if (e) throw e; this.log({ kind: 'claims-anchor-failed', agentId, at,"]], dies: ['R11'] },
  { id: 'K10', what: "existing() maps a vanished file to 'decrypt-failed'",
    edits: [[KP, "    if (l.ok || l.reason !== 'missing') return l;\n    return retry ? this.create(false) : l;", "    return l.ok || l.reason === 'unavailable' ? l : { ok: false, reason: 'decrypt-failed' };"]], dies: ['R12'] },
];

test('Jim SHOULD 1 (source pin): main sends the row\'s own recovery for an unreadable key', () => {
  const src = readSource('src/main/index.ts').split('\r\n').join('\n');
  assert.ok(src.includes("const what = row.kind === CLAIMS_ALERT_KEY_MISSING && typeof row.recovery === 'string'\n            ? row.recovery\n"), 'index.ts alert uses row.recovery');
});

test('CLAIMS-KEYMISSING-TEXT-108 (source pin): the missing-key alert names no Settings rekey that does not exist', () => {
  const src = readSource('src/main/index.ts');
  assert.ok(!/rekey in Settings/i.test(src), 'index.ts still points at a Settings rekey');
  // CLAIMS-REKEY-ENTRYPOINT-108: it names the command with this floor's folder (claims-rekey-entrypoint.test.cjs has the rest).
  assert.ok(src.includes('Recovery is a rekey of this floor, which only the Human can approve: god runs \\`${rekeyCommandFor(root)}\\` and the Human confirms it in the Guppy window.'),'the missing-key text names who runs the rekey');
  assert.ok(!/rekey in Settings/i.test(readSource('src/main/claims/store.ts')), 'store.ts recovery text has no Settings rekey either');
});

test('Jim NIT 2 (source pin): the main-thread lock wait says why it must stay short', () => {
  const src = readSource(KP).split('\r\n').join('\n');
  assert.match(src, /\/\/ This blocks the calling thread \(main\) for up to LOCK_WAIT_MS[^\n]*\n[^\n]*\n\s*\/\/ Never widen what runs under withUserDataLock[^\n]*\n\s*Atomics\.wait\(lockSleep/);
});

function mutated(m) {
  const texts = {};
  for (const [file, from, to] of m.edits) {
    const text = texts[file] ?? readSource(file).split('\r\n').join('\n');
    assert.equal(text.split(from).length - 1, 1, `${m.id}: the mutant edit applies exactly once`);
    texts[file] = text.split(from).join(to);
  }
  // Only the mutated files are swapped; the store takes its providers by injection.
  return {
    keys: texts[KP] ? loadTs.fromText(KP, texts[KP]) : real.keys,
    store: texts[ST] ? loadTs.fromText(ST, texts[ST]) : real.store,
  };
}

for (const m of MUTANTS) {
  test(`mutant: ${m.id} ${m.what}`, async () => {
    const mods = mutated(m);
    for (const id of m.dies) {
      const fn = CASES.find(([c]) => c === id)[1];
      let died = null;
      try { await runCase(id, fn, mods); } catch (e) { died = e; }
      assert.ok(died instanceof assert.AssertionError, `SURVIVED: ${m.id} (${m.what}) at ${id}${died ? `: ${died.message}` : ''}`);
    }
  });
}

test('MUTANT CENSUS: every mutant applies once and names a case that exists; every case has a mutant', () => {
  const ids = new Set(CASES.map(([c]) => c));
  for (const m of MUTANTS) {
    for (const [file, from] of m.edits) assert.equal(readSource(file).split('\r\n').join('\n').split(from).length - 1, 1, `${m.id} applies once`);
    for (const id of m.dies) assert.ok(ids.has(id), `${m.id} names ${id}`);
  }
  const killed = new Set(MUTANTS.flatMap((m) => m.dies));
  for (const id of CASES.map(([c]) => c).filter((c) => c !== 'R2')) assert.ok(killed.has(id), `${id} has a mutant`);
});
