'use strict';
require('./tools/own-job.cjs');
/**
 * CLAIMS-REKEY-SHARED-KEY (Jim, CLAIMS-KEY-MISSING-1110 item 5): one user-data folder holds ONE
 * claims-mac.key for every floor. A rekey or a fresh floor's first use must never replace it, or
 * every other floor goes key-missing (read-only). The record files are shared too, and two app
 * instances must not lose each other's entries.
 *   R1 floors A, B and C share one user-data folder; rekeying them in turn leaves all three verifying.
 *   R2 a fresh floor joining a working folder adopts the shared key.
 *   R3 an existing key file that does not decrypt is left as is by a first use and a rekey, and alerts.
 *   R4 the provider: create() makes a key only when no file exists, and leaves no tmp.
 *   R5 a rekey while the shared key loads never calls create().
 *   R6 the user-data lock is held while a write runs; a dead holder's stale lock is broken.
 *   R7 a lock held by a live holder is waited for a bounded time, then the write fails visibly.
 *   R8 an anchor set inside a census batch reads the file fresh: another instance's entry survives.
 *   plus: 4 processes x 40 concurrent record and anchor writes keep every entry (real sources).
 * Then a mutant census: rename-over, lock dropped, rekey mints, batch snapshot reused under the lock.
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
function open(mods, root, u, keys = u.keys) {
  const alerts = [];
  let t = Date.parse('2026-11-10T08:00:00Z');
  const store = new mods.store.ClaimStore({ hiveRoot: root, keys, keyRecord: u.record, headAnchor: u.anchors, now: () => new Date(t += 1000), alert: (r) => alerts.push(r) });
  STORES.push(store);
  return { store, alerts };
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

const CASES = [
  ['R1', threeFloorsRekeyed], ['R2', freshFloorAdopts], ['R3', undecryptableLeftAlone], ['R4', providerCreate],
  ['R5', rekeyNeverCreates], ['R6', lockHeldAndStaleBroken], ['R7', busyLockFailsVisibly], ['R8', batchSetReadsFresh],
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

const MUTANTS = [
  { id: 'K1', what: 'create() renames a new key over the shared file (the old behaviour)', file: KP,
    edits: [['    if (existsSync(this.file)) return this.existing();\n    const key = randomBytes(KEY_BYTES);', '    const key = randomBytes(KEY_BYTES);'],
      ['      linkSync(tmp, this.file);', '      renameSync(tmp, this.file);']], dies: ['R1', 'R2', 'R3', 'R4'] },
  { id: 'K2', what: 'the user-data lock is dropped', file: KP,
    edits: [['  const lock = `${file}.lock`;\n  mkdirSync(dirname(file), { recursive: true });', '  if (file) return fn();\n  const lock = `${file}.lock`;\n  mkdirSync(dirname(file), { recursive: true });']], dies: ['R6', 'R7'] },
  { id: 'K3', what: 'rekey mints through create() even while the shared key loads', file: ST,
    edits: [["const made = cur.ok ? cur : cur.reason === 'missing' ? this.d.keys.create() : cur;", 'const made = this.d.keys.create();']], dies: ['R5'] },
  { id: 'K4', what: 'a locked anchor set reuses the batch snapshot', file: KP,
    edits: [['    // may have written since, and its entries must survive this write.\n    this.cache = null;\n    this.batchFresh = false;\n', '    // may have written since, and its entries must survive this write.\n']], dies: ['R8'] },
];

function mutated(m) {
  let text = readSource(m.file).split('\r\n').join('\n');
  for (const [from, to] of m.edits) {
    assert.equal(text.split(from).length - 1, 1, `${m.id}: the mutant edit applies exactly once`);
    text = text.split(from).join(to);
  }
  // Only the mutated file is swapped; the store takes its providers by injection.
  return m.file === KP ? { keys: loadTs.fromText(KP, text), store: real.store } : { keys: real.keys, store: loadTs.fromText(ST, text) };
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
    for (const [from] of m.edits) assert.equal(readSource(m.file).split('\r\n').join('\n').split(from).length - 1, 1, `${m.id} applies once`);
    for (const id of m.dies) assert.ok(ids.has(id), `${m.id} names ${id}`);
  }
  const killed = new Set(MUTANTS.flatMap((m) => m.dies));
  for (const id of CASES.map(([c]) => c)) assert.ok(killed.has(id), `${id} has a mutant`);
});
