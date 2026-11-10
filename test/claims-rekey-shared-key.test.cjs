'use strict';
require('./tools/own-job.cjs');
/**
 * CLAIMS-REKEY-SHARED-KEY (Jim, CLAIMS-KEY-MISSING-1110 item 5): one user-data folder holds ONE
 * claims-mac.key for every floor. A rekey or a fresh floor's first use must never replace it, or
 * every other floor goes key-missing (read-only). The record files are shared too, and two app
 * instances must not lose each other's entries.
 *   - floors A, B and C share one user-data folder; rekeying them in turn leaves all three verifying.
 *   - a fresh floor's first use (and a rekey) leaves an existing key file that does not decrypt as is,
 *     and alerts.
 *   - concurrent record and anchor writes from several processes keep every entry.
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
const ROOT = path.join(__dirname, '..');
const { ClaimStore } = loadTs(path.join(ROOT, 'src/main/claims/store.ts'));
const {
  SafeStorageKeyProvider, FileLedgerKeyRecord, FileHeadAnchorStore, MAC_KEY_FILE, KEY_RECORD_FILE, HEAD_ANCHOR_FILE, hiveIdOf, withUserDataLock,
} = loadTs(path.join(ROOT, 'src/main/claims/keyProvider.ts'));

// A stand-in for safeStorage: reversible, so a garbage file reads as decrypt-failed.
const fakeSafe = () => ({
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from('ENC:' + s),
  decryptString: (b) => { const t = b.toString(); if (!t.startsWith('ENC:')) throw new Error('bad'); return t.slice(4); },
});

let n = 0;
/** One user-data folder as main wires it (index.ts): one key file, one record, one anchor file. */
function userData() {
  const ud = path.join(JAIL, `userdata-${++n}`);
  fs.mkdirSync(ud, { recursive: true });
  const safe = fakeSafe();
  return {
    ud,
    keyFile: path.join(ud, MAC_KEY_FILE),
    keys: new SafeStorageKeyProvider(path.join(ud, MAC_KEY_FILE), safe),
    record: new FileLedgerKeyRecord(path.join(ud, KEY_RECORD_FILE)),
    anchors: new FileHeadAnchorStore(path.join(ud, HEAD_ANCHOR_FILE)),
  };
}
function floor(name) {
  const root = path.join(JAIL, `${name}-${++n}`, 'hive');
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  return root;
}
function open(root, u) {
  const alerts = [];
  let t = Date.parse('2026-11-10T08:00:00Z');
  const store = new ClaimStore({ hiveRoot: root, keys: u.keys, keyRecord: u.record, headAnchor: u.anchors, now: () => new Date(t += 1000), alert: (r) => alerts.push(r) });
  STORES.push(store);
  return { store, alerts };
}
const note = (text) => ({ t: 'claim', kind: 'fact', text });
async function ok(p) { const r = await p; assert.equal(r.ok, true, JSON.stringify(r)); return r.id; }
const chain = (root, u, a) => { const { store } = open(root, u); const c = store.readLedger(a).chain; store.close(); return c; };

test('3 floors share one user-data folder: rekey A, B, C in turn and all three verify on one key', async () => {
  // Each floor's ledger was written under a key that is now gone (the old user-data folder).
  const lost = userData();
  const floors = { A: floor('FLOOR-A'), B: floor('FLOOR-B'), C: floor('FLOOR-C') };
  for (const [name, root] of Object.entries(floors)) {
    const { store } = open(root, lost);
    for (const a of ['andy', 'dwight']) await ok(store.appendRecord(a, note(`${name} ${a} before`), 'endpoint'));
    store.close();
  }
  const u = userData();
  for (const root of Object.values(floors)) assert.equal(chain(root, u, 'andy').reason, 'key-missing');

  const rekeyed = {};
  let keyBytes = null;
  for (const [name, root] of Object.entries(floors)) {
    const { store } = open(root, u);
    const rk = await store.rekey(true);
    store.close();
    assert.equal(rk.ok, true, `${name}: ${JSON.stringify(rk)}`);
    assert.deepEqual(rk.rekeyed.sort(), ['andy', 'dwight']);
    rekeyed[name] = rk.keyId;
    if (keyBytes === null) keyBytes = fs.readFileSync(u.keyFile);
    else assert.ok(fs.readFileSync(u.keyFile).equals(keyBytes), `${name}'s rekey left the shared key file as it was`);
    // Every floor rekeyed so far still verifies.
    for (const done of Object.keys(rekeyed)) {
      for (const a of ['andy', 'dwight']) assert.equal(chain(floors[done], u, a), 'ok', `${done}/${a} after ${name}'s rekey`);
    }
  }
  assert.equal(new Set(Object.values(rekeyed)).size, 1, 'one shared key id for all three floors');
  assert.equal(u.keys.load().keyId, rekeyed.A);
  for (const root of Object.values(floors)) assert.equal(u.record.get(root), rekeyed.A, 'each floor recorded under the shared key id');
  // And all three can still write, then verify.
  for (const [name, root] of Object.entries(floors)) {
    const { store } = open(root, u);
    await ok(store.appendRecord('andy', note(`${name} after`), 'endpoint'));
    store.close();
  }
  for (const root of Object.values(floors)) assert.equal(chain(root, u, 'andy'), 'ok');
  // A second rekey of A (key still loads) mints nothing and keeps B and C working.
  const { store: again } = open(floors.A, u);
  const rk2 = await again.rekey(true);
  again.close();
  assert.equal(rk2.keyId, rekeyed.A);
  assert.ok(fs.readFileSync(u.keyFile).equals(keyBytes));
  for (const root of Object.values(floors)) assert.equal(chain(root, u, 'dwight'), 'ok');
});

test('a fresh floor joining a working folder adopts the shared key; the first floor keeps verifying', async () => {
  const u = userData();
  const A = floor('FLOOR-A');
  const { store: a } = open(A, u);
  await ok(a.appendRecord('andy', note('A first'), 'endpoint'));
  a.close();
  const bytes = fs.readFileSync(u.keyFile);
  const D = floor('FLOOR-D');
  const { store: d } = open(D, u);
  await ok(d.appendRecord('andy', note('D first'), 'endpoint'));
  d.close();
  assert.ok(fs.readFileSync(u.keyFile).equals(bytes), 'first use never replaced the key file');
  assert.equal(u.record.get(D), u.record.get(A));
  assert.equal(chain(A, u, 'andy'), 'ok');
  assert.equal(chain(D, u, 'andy'), 'ok');
});

test('an existing key file that does not decrypt is left untouched by a fresh floor first use and by a rekey, and alerts', async () => {
  const u = userData();
  fs.writeFileSync(u.keyFile, 'not a key this profile can decrypt');
  const bytes = fs.readFileSync(u.keyFile);
  // Provider level: create() refuses instead of replacing.
  assert.deepEqual(u.keys.create(), { ok: false, reason: 'decrypt-failed' });
  assert.ok(fs.readFileSync(u.keyFile).equals(bytes));
  // A fresh floor's first use.
  const D = floor('FLOOR-D');
  const { store, alerts } = open(D, u);
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
  const B = floor('FLOOR-B');
  const lost = userData();
  const { store: old } = open(B, lost);
  await ok(old.appendRecord('andy', note('B before'), 'endpoint'));
  old.close();
  const { store: rs, alerts: ra } = open(B, u);
  const rk = await rs.rekey(true);
  rs.close();
  assert.equal(rk.ok, false);
  assert.deepEqual(rk.refused, [{ agentId: 'andy', why: 'no key (decrypt-failed)' }]);
  assert.ok(fs.readFileSync(u.keyFile).equals(bytes), 'the rekey left the undecryptable key file as is');
  assert.equal(ra.filter((x) => /does not decrypt/.test(x.reason ?? '')).length, 1);
});

test('the provider: create() with no key file makes one; with a loading key file returns that key; leaves no tmp', () => {
  const u = userData();
  const c = u.keys.create();
  assert.equal(c.ok, true);
  const bytes = fs.readFileSync(u.keyFile);
  const again = u.keys.create();
  assert.equal(again.ok, true);
  assert.equal(again.keyId, c.keyId, 'an existing key is returned, not replaced');
  assert.ok(fs.readFileSync(u.keyFile).equals(bytes));
  assert.deepEqual(fs.readdirSync(u.ud).sort(), [MAC_KEY_FILE]);
});

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
  const u = userData();
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

test('the user-data lock: a held lock is waited for; a dead holder\'s stale lock is broken', () => {
  const u = userData();
  const file = path.join(u.ud, KEY_RECORD_FILE);
  fs.writeFileSync(`${file}.lock`, '99999');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(`${file}.lock`, old, old);
  u.record.set(floor('FLOOR-A'), 'k1');
  assert.equal(fs.existsSync(`${file}.lock`), false);
  assert.equal(withUserDataLock(file, () => fs.existsSync(`${file}.lock`)), true, 'held while the write runs');
});
