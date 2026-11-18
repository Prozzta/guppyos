'use strict';
/**
 * LAG-CLAIMS-SEGMENTS-ASYNC-108: the claims census must not list folders on the main thread
 * every time its window passes.
 *
 * Cause: ClaimStore.ledgerAgents() answers from a roster for ROSTER_REVALIDATE_MS. Once that
 * window has passed, the next call lists agents/ and then every agent's claims folder with
 * readdirSync, on the caller's thread. In the app the caller is the main thread and the census
 * has about ten synchronous consumers, so each window costs 1 + N directory listings there
 * (main-stall rows on 1.1.107 show one such slice at 679 ms).
 *
 * These tests count the synchronous listings, not time.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-claims-seg-async-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
const STORES = [];
test.after(() => {
  for (const s of STORES) { try { s.close(); } catch { /* closed */ } }
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const loadTs = require('./load-ts.cjs');
const ROOT = path.join(__dirname, '..');
const storeMod = loadTs(path.join(ROOT, 'src/main/claims/store.ts'));
const { SandboxKeyProvider, FileLedgerKeyRecord, FileHeadAnchorStore, KEY_RECORD_FILE, HEAD_ANCHOR_FILE } = loadTs(path.join(ROOT, 'src/main/claims/keyProvider.ts'));

/** Count synchronous directory listings by folder name until stop(). */
function spyReaddirSync() {
  const counts = {};
  const saved = fs.readdirSync;
  fs.readdirSync = function (p, ...rest) {
    const key = path.basename(String(p));
    counts[key] = (counts[key] ?? 0) + 1;
    return saved.call(this, p, ...rest);
  };
  return { n: (k) => counts[k] ?? 0, stop: () => { fs.readdirSync = saved; } };
}

let seq = 0;
function setup() {
  const root = path.join(JAIL, `hive-${++seq}`);
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  const ud = `${root}-userdata`;
  const later = () => Date.now() + 10_000;
  const anchors = new FileHeadAnchorStore(path.join(ud, HEAD_ANCHOR_FILE), later);
  const keys = new SandboxKeyProvider();
  let mono = 0;
  const mk = () => {
    let t = Date.parse('2026-11-18T10:00:00Z');
    const store = new storeMod.ClaimStore({ hiveRoot: root, keys, keyRecord: new FileLedgerKeyRecord(path.join(ud, KEY_RECORD_FILE)), headAnchor: anchors, now: () => new Date(t += 1000), monoNow: () => mono, wallNow: later });
    STORES.push(store);
    return store;
  };
  return { root, mk, tick: (ms) => { mono += ms; } };
}
async function ledgers(x, agents) {
  const s = x.mk();
  for (const a of agents) {
    const r = await s.appendRecord(a, { t: 'claim', kind: 'fact', text: `${a} first` }, 'endpoint');
    assert.equal(r.ok, true, JSON.stringify(r));
  }
  s.close();
}

test('a census whose window has passed, with nothing changed, lists no folder synchronously', async () => {
  const x = setup();
  await ledgers(x, ['andy', 'dwight', 'jim']);
  const s = x.mk();
  assert.deepEqual([...s.ledgerAgents()].sort(), ['andy', 'dwight', 'jim'], 'the first census lists the three ledgers');
  x.tick(storeMod.ROSTER_REVALIDATE_MS);
  const sp = spyReaddirSync();
  let r;
  try { r = s.ledgerAgents(); } finally { sp.stop(); }
  assert.deepEqual([...r].sort(), ['andy', 'dwight', 'jim'], 'the answer is still the roster');
  assert.equal(sp.n('agents'), 0, 'agents/ is not listed synchronously when the window passes');
  assert.equal(sp.n('claims'), 0, 'no claims folder is listed synchronously when the window passes');
});
