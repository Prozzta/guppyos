'use strict';
/**
 * CLAIMS-HEAD-ANCHOR: main keeps each agent's ledger head in user-data. A ledger that no longer
 * reaches its anchored head (its folder deleted, a line cut off the end, a restart from '') is a
 * `prev` break at 'head-anchor': read-only, one alert, never repaired. A lagging anchor is fine
 * (it moves up); a first run adopts the head; a restore and the Human's reset re-anchor.
 * HOME and USERPROFILE are jailed and asserted before any product code loads.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-claims-anchor-'));
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
const ROOT = path.join(__dirname, '..');
const { ClaimStore } = loadTs(path.join(ROOT, 'src/main/claims/store.ts'));
const { SandboxKeyProvider, FileLedgerKeyRecord, FileHeadAnchorStore, KEY_RECORD_FILE, HEAD_ANCHOR_FILE } = loadTs(path.join(ROOT, 'src/main/claims/keyProvider.ts'));
const { sha256Hex } = loadTs(path.join(ROOT, 'src/main/claims/canonical.ts'));

let n = 0;
function setup() {
  const root = path.join(JAIL, `hive-${++n}`);
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  const ud = `${root}-userdata`;
  const keys = new SandboxKeyProvider();
  const anchors = new FileHeadAnchorStore(path.join(ud, HEAD_ANCHOR_FILE));
  const mk = (extra = {}) => {
    const alerts = [];
    let t = Date.parse('2026-10-03T10:00:00Z');
    const store = new ClaimStore({ hiveRoot: root, keys, keyRecord: new FileLedgerKeyRecord(path.join(ud, KEY_RECORD_FILE)), headAnchor: anchors, now: () => new Date(t += 1000), alert: (r) => alerts.push(r), ...extra });
    STORES.push(store);
    return { store, alerts };
  };
  const claimsDir = (a) => path.join(root, 'agents', a, 'memory', 'claims');
  const lastLine = (a) => { const f = fs.readdirSync(claimsDir(a)).sort().pop(); const ls = fs.readFileSync(path.join(claimsDir(a), f), 'utf8').split('\n').filter(Boolean); return ls[ls.length - 1]; };
  return { root, keys, anchors, mk, claimsDir, lastLine };
}
const note = (text) => ({ t: 'claim', kind: 'fact', text });
async function ok(p) { const r = await p; assert.equal(r.ok, true, JSON.stringify(r)); return r.id; }

test('the anchor follows the head after appends (flushed by close or the timer), in user-data, never in the hive', async () => {
  const x = setup();
  const { store } = x.mk();
  for (let i = 0; i < 3; i++) await ok(store.appendRecord('andy', note(`f${i}`), 'endpoint'));
  store.close();
  assert.equal(x.anchors.get(x.root, 'andy').head, sha256Hex(x.lastLine('andy')));
  const { store: s2 } = x.mk({ anchorDelayMs: 5 });
  await ok(s2.appendRecord('andy', note('f3'), 'endpoint'));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(x.anchors.get(x.root, 'andy').head, sha256Hex(x.lastLine('andy')), 'the timer flushed it');
  assert.ok(!fs.readdirSync(x.root).some((f) => /head/i.test(f)), 'nothing in the hive');
});

test('a deleted ledger folder is detected: prev at head-anchor, read-only, one alert; no restart from empty', async () => {
  const x = setup();
  const { store } = x.mk();
  for (let i = 0; i < 3; i++) await ok(store.appendRecord('andy', note(`f${i}`), 'endpoint'));
  store.close();
  fs.rmSync(path.join(x.root, 'agents', 'andy'), { recursive: true });
  const m = x.mk();
  assert.deepEqual(m.store.readLedger('andy').chain, { brokenAt: 'head-anchor', reason: 'prev' });
  const r = await m.store.appendRecord('andy', note('a fresh start'), 'endpoint');
  assert.equal(r.ok, false); assert.match(r.error, /read-only \(prev at head-anchor\)/);
  assert.equal(fs.existsSync(x.claimsDir('andy')), false, 'nothing was written');
  assert.equal(m.alerts.filter((a) => a.kind === 'claims-chain-broken' && a.brokenAt === 'head-anchor').length, 1);
  // Other agents are unaffected.
  await ok(m.store.appendRecord('dwight', note('fine'), 'endpoint'));
});

test('a cut-off tail (valid chain, shorter) and a ledger restarted from empty are detected', async () => {
  const x = setup();
  const { store } = x.mk();
  for (let i = 0; i < 4; i++) await ok(store.appendRecord('andy', note(`f${i}`), 'endpoint'));
  store.close();
  const f = path.join(x.claimsDir('andy'), fs.readdirSync(x.claimsDir('andy'))[0]);
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(f, lines.slice(0, 2).join('\n') + '\n');
  assert.deepEqual(x.mk().store.readLedger('andy').chain, { brokenAt: 'head-anchor', reason: 'prev' });
  // Restarted: a single valid first line (prev '') from another ledger of the same key.
  const { store: other } = x.mk();
  await ok(other.appendRecord('creed', note('creed first'), 'endpoint'));
  other.close();
  const creedLine = x.lastLine('creed').replace('"agent":"creed"', '"agent":"andy"');
  fs.writeFileSync(f, creedLine + '\n');
  assert.notEqual(x.mk().store.readLedger('andy').chain, 'ok');
});

test('a lagging anchor is fine and moves up; no anchor yet adopts the head', async () => {
  const x = setup();
  const { store } = x.mk({ anchorDelayMs: 10_000 });
  await ok(store.appendRecord('andy', note('f0'), 'endpoint'));
  store.close();
  const anchored = x.anchors.get(x.root, 'andy').head;
  const { store: s2 } = x.mk({ anchorDelayMs: 10_000 });
  await ok(s2.appendRecord('andy', note('f1'), 'endpoint'));
  await ok(s2.appendRecord('andy', note('f2'), 'endpoint'));
  // "crash" before the anchor write: the anchor still names f0's line.
  assert.equal(x.anchors.get(x.root, 'andy').head, anchored);
  const m = x.mk();
  assert.equal(m.store.readLedger('andy').chain, 'ok', 'the chain grew past the anchor');
  m.store.close();
  assert.equal(x.anchors.get(x.root, 'andy').head, sha256Hex(x.lastLine('andy')), 'and the anchor moved up');
  // First run after the upgrade: no anchors at all.
  fs.rmSync(path.join(`${x.root}-userdata`, HEAD_ANCHOR_FILE));
  const f = x.mk();
  assert.equal(f.store.readLedger('andy').chain, 'ok');
  f.store.close();
  assert.equal(x.anchors.get(x.root, 'andy').head, sha256Hex(x.lastLine('andy')));
});

test('a restore re-anchors; the Human reset re-anchors after review; a rekey keeps the anchor in step', async () => {
  const x = setup();
  let t = Date.parse('2026-10-30T09:00:00Z');
  const now = () => new Date(t);
  const { store } = x.mk({ now });
  await ok(store.appendRecord('andy', note('day one'), 'endpoint'));
  t = Date.parse('2026-10-31T09:00:00Z');
  await ok(store.appendRecord('andy', note('day two'), 'endpoint'));
  store.close();
  const r = store.restoreBackup('andy', '2026-10-30');
  assert.equal(r.chain, 'ok', 'the restored (shorter) ledger is the anchored one');
  assert.equal(x.mk().store.readLedger('andy').chain, 'ok');
  // Deleted, reviewed by the Human, reset.
  fs.rmSync(x.claimsDir('andy'), { recursive: true });
  const m = x.mk();
  assert.equal(m.store.readLedger('andy').chain.reason, 'prev');
  assert.equal(m.store.resetAnchor('andy', undefined), false, 'only with the Human confirm');
  assert.equal(m.store.resetAnchor('andy', true), true);
  assert.equal(m.store.readLedger('andy').chain, 'ok');
  await ok(m.store.appendRecord('andy', note('after the reset'), 'endpoint'));
  m.store.close();
  // A rekey writes lines; the anchor follows them.
  x.keys.drop();
  const k = x.mk();
  const rk = await k.store.rekey(true);
  assert.equal(rk.ok, true, JSON.stringify(rk));
  k.store.close();
  assert.equal(x.anchors.get(x.root, 'andy').head, sha256Hex(x.lastLine('andy')));
  assert.equal(x.mk().store.readLedger('andy').chain, 'ok');
});
