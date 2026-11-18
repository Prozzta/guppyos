'use strict';
require('./tools/own-job.cjs');
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
 * These tests count the synchronous listings, not time. The clock and the keep-fresh timer are
 * the test's own (monoNow, rosterInterval): nothing here sleeps.
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
  const timers = [];
  const rosterInterval = (fn, ms) => { const h = { fn, ms, cleared: false, clear() { h.cleared = true; } }; timers.push(h); return h; };
  const mk = () => {
    let t = Date.parse('2026-11-18T10:00:00Z');
    const store = new storeMod.ClaimStore({ hiveRoot: root, keys, keyRecord: new FileLedgerKeyRecord(path.join(ud, KEY_RECORD_FILE)), headAnchor: anchors, now: () => new Date(t += 1000), monoNow: () => mono, wallNow: later, rosterInterval });
    STORES.push(store);
    return store;
  };
  return { root, mk, timers, tick: (ms) => { mono += ms; } };
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
  x.tick(storeMod.ROSTER_MAX_AGE_MS - 1); // as old as a roster may be and still be answered
  const sp = spyReaddirSync();
  let r;
  try { r = s.ledgerAgents(); } finally { sp.stop(); }
  assert.deepEqual([...r].sort(), ['andy', 'dwight', 'jim'], 'the answer is still the roster');
  assert.equal(sp.n('agents'), 0, 'agents/ is not listed synchronously when the window passes');
  assert.equal(sp.n('claims'), 0, 'no claims folder is listed synchronously when the window passes');
});

/** Hold the off-thread listing of agents/: the real listing is taken first, then kept back until
 *  release(), so what the relist carries is older than anything done meanwhile. */
function holdAgentsListing(t, x) {
  const fsp = require('node:fs/promises');
  const real = fsp.readdir;
  const dir = path.join(x.root, 'agents');
  let release; let started; let calls = 0; let fail = false;
  const gate = new Promise((r) => { release = r; });
  const reached = new Promise((r) => { started = r; });
  fsp.readdir = async (p, ...rest) => {
    if (path.resolve(String(p)) !== dir) return real(p, ...rest);
    calls++;
    const names = await real(p, ...rest);
    started();
    await gate;
    if (fail) throw Object.assign(new Error('EPERM: listing refused'), { code: 'EPERM' });
    return names;
  };
  t.after(() => { fsp.readdir = real; release(); });
  return { started: () => reached, release, calls: () => calls, failIt: () => { fail = true; } };
}
/** Wait for the held listing. A census that started none fails here by name instead of hanging:
 *  with nothing in flight rosterSettled() resolves at once. */
function listingStarted(h, s) {
  const none = s.rosterSettled().then(() => new Promise((r) => setImmediate(r))).then(() => { throw new Error('the census started no off-thread listing of agents/'); });
  return Promise.race([h.started(), none]);
}
function syncListings(fn) {
  const sp = spyReaddirSync();
  let r;
  try { r = fn(); } finally { sp.stop(); }
  return { r, agents: sp.n('agents'), claims: sp.n('claims') };
}
async function append(s, a) {
  const r = await s.appendRecord(a, { t: 'claim', kind: 'fact', text: `${a} first` }, 'endpoint');
  assert.equal(r.ok, true, JSON.stringify(r));
}

test('a census whose window has passed starts one off-thread listing, however many consumers ask', async (t) => {
  const x = setup();
  await ledgers(x, ['andy', 'dwight']);
  const s = x.mk();
  s.ledgerAgents();
  const h = holdAgentsListing(t, x);
  x.tick(storeMod.ROSTER_REVALIDATE_MS);
  for (let i = 0; i < 5; i++) assert.deepEqual([...s.ledgerAgents()].sort(), ['andy', 'dwight']);
  await listingStarted(h, s);
  for (let i = 0; i < 5; i++) s.ledgerAgents();
  assert.equal(h.calls(), 1, 'ten census reads past the window start one listing');
  h.release();
  await s.rosterSettled();
  s.ledgerAgents();
  await s.rosterSettled(); // a second listing, if one was started, has reached agents/ by now
  assert.equal(h.calls(), 1, 'the finished listing opened a new window: no second listing yet');
});

test('a listing that finishes after an own write does not replace the roster that write made', async (t) => {
  const x = setup();
  await ledgers(x, ['andy', 'dwight']);
  const s = x.mk();
  s.ledgerAgents();
  const h = holdAgentsListing(t, x);
  x.tick(storeMod.ROSTER_REVALIDATE_MS);
  s.ledgerAgents();
  await listingStarted(h, s); // the listing it carries has no pam
  await append(s, 'pam');
  assert.deepEqual([...s.ledgerAgents()].sort(), ['andy', 'dwight', 'pam'], 'the own write is in the very next census');
  h.release();
  await s.rosterSettled();
  const after = syncListings(() => s.ledgerAgents());
  assert.deepEqual([...after.r].sort(), ['andy', 'dwight', 'pam'], 'pam is still in the roster');
  assert.equal(after.agents + after.claims, 0, 'and the roster the write made still stands: nothing is listed again');
});

test('a listing that finishes after close() is dropped: it does not throw and the next census lists afresh', async (t) => {
  const x = setup();
  await ledgers(x, ['andy', 'dwight']);
  const s = x.mk();
  s.ledgerAgents();
  const h = holdAgentsListing(t, x);
  x.tick(storeMod.ROSTER_REVALIDATE_MS);
  s.ledgerAgents();
  await listingStarted(h, s);
  s.close();
  h.release();
  await s.rosterSettled();
  const after = syncListings(() => s.ledgerAgents());
  assert.deepEqual([...after.r].sort(), ['andy', 'dwight']);
  assert.equal(after.agents, 1, 'the census after close() lists agents/ itself: the late listing did not become the roster');
});

test('a listing that cannot read agents/ leaves the roster as it was and does not throw', async (t) => {
  const x = setup();
  await ledgers(x, ['andy', 'dwight']);
  const s = x.mk();
  s.ledgerAgents();
  const h = holdAgentsListing(t, x);
  h.failIt();
  x.tick(storeMod.ROSTER_REVALIDATE_MS);
  s.ledgerAgents();
  await listingStarted(h, s);
  h.release();
  await s.rosterSettled();
  const after = syncListings(() => s.ledgerAgents());
  assert.deepEqual([...after.r].sort(), ['andy', 'dwight'], 'the roster is not emptied by a failed listing');
  assert.equal(after.agents + after.claims, 0, 'and the census still answers without a synchronous listing');
  await s.rosterSettled();
  assert.equal(h.calls(), 2, 'that census asked for the listing again');
});

test('segmentsAsync answers what segments answers', async () => {
  const x = setup();
  await ledgers(x, ['andy']);
  const s = x.mk();
  const dir = path.join(x.root, 'agents', 'andy', 'memory', 'claims');
  const seg = fs.readdirSync(dir).find((n) => /\.jsonl$/.test(n));
  fs.copyFileSync(path.join(dir, seg), path.join(dir, seg.replace(/\d{4}-\d{2}/, '2031-01')));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a segment');
  assert.equal(s.segments('andy').length, 2, 'the rig made a second segment');
  assert.deepEqual(await s.segmentsAsync('andy'), s.segments('andy'));
  assert.deepEqual(await s.segmentsAsync('nobody'), []);
});

/** A claims folder made by something other than this store, under an agents/ entry that exists
 *  already (so the agents/ stat key does not move). */
function outsideLedger(x, from, to) {
  fs.cpSync(path.join(x.root, 'agents', from, 'memory', 'claims'), path.join(x.root, 'agents', to, 'memory', 'claims'), { recursive: true });
}
async function withEmptyToby(x) {
  await ledgers(x, ['andy', 'dwight']);
  fs.mkdirSync(path.join(x.root, 'agents', 'toby'), { recursive: true });
  const s = x.mk();
  assert.deepEqual([...s.ledgerAgents()].sort(), ['andy', 'dwight']);
  return s;
}

test('a roster older than ROSTER_MAX_AGE_MS is not answered: that census lists synchronously and exactly, with no timer tick', async () => {
  const x = setup();
  const s = await withEmptyToby(x);
  outsideLedger(x, 'dwight', 'toby');
  x.tick(storeMod.ROSTER_MAX_AGE_MS); // the keep-fresh timer never ran (a sleep, a starved loop)
  const got = syncListings(() => s.ledgerAgents());
  assert.deepEqual([...got.r].sort(), ['andy', 'dwight', 'toby'], 'the folder made elsewhere is in this very census');
  assert.equal(got.agents, 1, 'agents/ was listed synchronously, once');
  assert.equal(x.timers.length, 1, 'a second synchronous listing starts no second timer');
  await s.rosterSettled();
  const next = syncListings(() => s.ledgerAgents());
  assert.equal(next.agents + next.claims, 0, 'and that listing is the roster now');
});

test('the keep-fresh timer starts the off-thread listing with no census asking', async (t) => {
  const x = setup();
  const s = await withEmptyToby(x);
  assert.equal(x.timers.length, 1, 'the first census started one timer');
  assert.equal(x.timers[0].ms, storeMod.ROSTER_KEEP_FRESH_MS);
  assert.ok(storeMod.ROSTER_KEEP_FRESH_MS + storeMod.ROSTER_REVALIDATE_MS < storeMod.ROSTER_MAX_AGE_MS, 'a tick comes well before the roster may no longer be answered');
  s.ledgerAgents();
  assert.equal(x.timers.length, 1, 'a later census starts no second timer');
  const h = holdAgentsListing(t, x);
  x.timers[0].fn(); // inside the window: nothing to do
  const idle = await Promise.race([s.rosterSettled().then(() => true), new Promise((r) => setImmediate(() => r(false)))]);
  assert.equal(idle, true, 'a tick inside the window starts no listing');
  assert.equal(h.calls(), 0, 'a tick inside the window lists nothing');
  outsideLedger(x, 'dwight', 'toby');
  x.tick(storeMod.ROSTER_KEEP_FRESH_MS);
  const sp = spyReaddirSync();
  try { x.timers[0].fn(); x.timers[0].fn(); } finally { sp.stop(); }
  assert.equal(sp.n('agents') + sp.n('claims'), 0, 'the tick lists nothing synchronously');
  await listingStarted(h, s);
  h.release();
  await s.rosterSettled();
  assert.equal(h.calls(), 1, 'two ticks start one listing');
  const got = syncListings(() => s.ledgerAgents());
  assert.deepEqual([...got.r].sort(), ['andy', 'dwight', 'toby'], 'the folder made elsewhere is in the roster before any census asked');
  assert.equal(got.agents + got.claims, 0, 'and that census listed nothing synchronously');
});

test('close() clears the keep-fresh timer; a tick after close does nothing; the next census starts a new timer', async (t) => {
  const x = setup();
  const s = await withEmptyToby(x);
  const h = holdAgentsListing(t, x);
  s.close();
  assert.equal(x.timers[0].cleared, true, 'close() cleared the timer');
  x.tick(storeMod.ROSTER_KEEP_FRESH_MS);
  h.release(); // nothing is held: a listing, if one starts, runs to its end and is counted
  x.timers[0].fn(); // a tick that was already due
  await s.rosterSettled();
  assert.equal(h.calls(), 0, 'a tick after close() starts no listing');
  s.ledgerAgents();
  assert.equal(x.timers.length, 2, 'the store is used again: a new timer');
  assert.equal(x.timers[1].cleared, false);
});
