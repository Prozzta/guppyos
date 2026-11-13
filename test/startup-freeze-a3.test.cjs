'use strict';
require('./tools/own-job.cjs');
// STARTUP-FREEZE-104 A3 (Jim audit A4/A7/A9, god 00422a, Jim 3929e7): the verify-once claims cache.
// - In one session a kept verified read is served while each kept segment keeps its size and last 4 KiB; a stat and
//   a tail read, never a whole kept file; appended whole lines verify as before.
// - Across launches a MAC'd checkpoint in user-data names each CLOSED segment's whole-file sha256; a restart verifies
//   only the lines after the proven segments. Any byte changed in a closed segment (same size, same tail included) is
//   a full verify that refuses, as before. The checkpoint is bound to the hive and key id and to the exact segments.
// - warm() reads and verifies asynchronously, in slices, never in the caller's turn, outside the append queue (a write during it makes the warm drop that agent).
// Temp hives from generated fixtures only; HOME is jailed before product code loads.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-sf104-a3-'));
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
const { SandboxKeyProvider, FileLedgerKeyRecord, FileHeadAnchorStore, KEY_RECORD_FILE, HEAD_ANCHOR_FILE } = loadTs(path.join(ROOT, 'src/main/claims/keyProvider.ts'));
const { canonicalJson, recordMac, sha256Hex } = loadTs(path.join(ROOT, 'src/main/claims/canonical.ts'));

const KEY = crypto.randomBytes(32);
let TEMPLATE = null;
let n = 0;
/** A temp hive whose ledgers are written line by line here (fast), each line a real record shape, chained and MAC'd. */
function setup() {
  const root = path.join(JAIL, `hive-${++n}`);
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  const ud = `${root}-userdata`;
  fs.mkdirSync(ud, { recursive: true });
  const keys = new SandboxKeyProvider(KEY);
  const keyRecord = new FileLedgerKeyRecord(path.join(ud, KEY_RECORD_FILE));
  const anchors = new FileHeadAnchorStore(path.join(ud, HEAD_ANCHOR_FILE));
  const cp = { text: null, saves: 0, load() { return this.text; }, save(t) { this.text = t; this.saves++; } };
  const rows = [];
  const mk = (extra = {}) => {
    const alerts = [];
    let t = Date.parse('2026-11-12T10:00:00Z');
    const store = new ClaimStore({ hiveRoot: root, keys, keyRecord, headAnchor: anchors, checkpoint: cp, now: () => new Date(t += 1000), alert: (r) => alerts.push(r), log: (r) => rows.push(r), ...extra });
    STORES.push(store);
    return { store, alerts };
  };
  const claimsDir = (a) => path.join(root, 'agents', a, 'memory', 'claims');
  return { root, ud, keys, keyRecord, anchors, cp, rows, mk, claimsDir };
}

/** Write `months` (name -> line count) for agent `a`, chained from '' (or from `prev`), with the real record shape. */
function writeLedger(x, a, months, from = { prev: '', i: 0 }) {
  // One real append gives the template (fields and order as the store writes them).
  if (!TEMPLATE) {
    const probe = setup();
    const { store } = probe.mk();
    return store.appendRecord('tmpl', { t: 'claim', kind: 'fact', text: 'template' }, 'endpoint').then((r) => {
      assert.equal(r.ok, true, JSON.stringify(r));
      store.close();
      const f = path.join(probe.claimsDir('tmpl'), fs.readdirSync(probe.claimsDir('tmpl'))[0]);
      TEMPLATE = JSON.parse(fs.readFileSync(f, 'utf8').split('\n')[0]);
      return writeLedger(x, a, months, from);
    });
  }
  x.keyRecord.set(x.root, crypto.createHash('sha256').update(KEY).digest('hex').slice(0, 16));
  fs.mkdirSync(x.claimsDir(a), { recursive: true });
  let { prev, i } = from;
  for (const [name, count] of Object.entries(months)) {
    const out = [];
    for (let k = 0; k < count; k++, i++) {
      const rec = { ...TEMPLATE, agent: a, id: `c-${(i + 1).toString(16).padStart(12, '0')}`, text: `fact number ${String(i).padStart(6, '0')} of ${a}`, prev };
      for (const f of ['wt', 'at']) if (f in rec) rec[f] = `${name.slice(0, 7)}-05T10:00:00.000Z`;
      delete rec.mac;
      rec.mac = recordMac(KEY, rec);
      const line = canonicalJson(rec);
      out.push(line);
      prev = sha256Hex(line);
    }
    fs.appendFileSync(path.join(x.claimsDir(a), name), out.map((l) => l + '\n').join(''));
  }
  x.anchors.set(x.root, a, { head: prev, lastId: `c-${i.toString(16).padStart(12, '0')}` });
  return Promise.resolve({ prev, i });
}

/** Count HMAC computations (record MACs and the checkpoint's) while fn runs. */
function countHmacs(fn) {
  const real = crypto.createHmac;
  let c = 0;
  crypto.createHmac = function (...a) { c++; return real.apply(this, a); };
  try { const r = fn(); return { r, c }; } finally { crypto.createHmac = real; }
}
/** Whole-file reads of `files` while fn runs (readFileSync spy). */
function countReads(files, fn) {
  const real = fs.readFileSync;
  const want = new Set(files.map((f) => path.resolve(f)));
  let c = 0;
  fs.readFileSync = function (p, ...a) { if (typeof p === 'string' && want.has(path.resolve(p))) c++; return real.call(this, p, ...a); };
  try { const r = fn(); return { r, c }; } finally { fs.readFileSync = real; }
}
const ids = (r) => r.records.map((x) => x.id);

test('a restart verifies only the lines after the checkpoint\'s closed segments, and serves the same records', async () => {
  const x = setup();
  await writeLedger(x, 'andy', { '2026-09.jsonl': 400, '2026-10.jsonl': 400, '2026-11.jsonl': 25 });
  const first = x.mk().store;
  const full = countHmacs(() => first.readLedger('andy'));
  assert.equal(full.r.chain, 'ok');
  assert.ok(full.c >= 825, `the first read MACs every line (${full.c})`);
  first.close();
  assert.ok(x.cp.text, 'the checkpoint was written');
  const cp = JSON.parse(x.cp.text);
  assert.deepEqual(cp.agents.andy.segs.map((s) => [s.name, s.lines]), [['2026-09.jsonl', 400], ['2026-10.jsonl', 400]], 'closed segments only, never the newest');
  assert.ok(!/fact number/.test(x.cp.text), 'the checkpoint holds hashes, never record text');

  const second = x.mk().store;
  const again = countHmacs(() => second.readLedger('andy'));
  assert.equal(again.r.chain, 'ok');
  assert.deepEqual(ids(again.r), ids(full.r));
  assert.ok(again.c <= 25 + 2, `a restart MACs only the newest segment's lines and the checkpoint (${again.c})`);
  // An append chains on the head the checkpointed read adopted.
  const r = await second.appendRecord('andy', { t: 'claim', kind: 'fact', text: 'after restart' }, 'endpoint');
  assert.equal(r.ok, true, JSON.stringify(r));
  second.close();
  const third = x.mk().store;
  assert.equal(third.readLedger('andy').chain, 'ok', 'the appended line chains');
});

test('RESTART: a same-size, same-tail edit inside a closed segment is a full verify that refuses (Jim 3929e7)', async () => {
  const x = setup();
  await writeLedger(x, 'andy', { '2026-09.jsonl': 300, '2026-10.jsonl': 300, '2026-11.jsonl': 5 });
  const a = x.mk();
  assert.equal(a.store.readLedger('andy').chain, 'ok');
  const before = ids(a.store.readLedgerCached('andy'));
  // Edit line 3 of the first closed month: same size, far from its last 4 KiB.
  const f = path.join(x.claimsDir('andy'), '2026-09.jsonl');
  const buf = fs.readFileSync(f);
  const at = buf.indexOf('fact number 000002');
  assert.ok(at > 0 && at < buf.length - 8192);
  buf.write('FACT', at, 'utf8');
  const st = fs.statSync(f);
  fs.writeFileSync(f, buf);
  fs.utimesSync(f, st.atime, st.mtime);
  // In this session the records main verified are served (never the edited bytes).
  const cached = a.store.readLedgerCached('andy');
  assert.deepEqual(ids(cached), before);
  assert.ok(!cached.records.some((r) => /FACT/.test(r.text ?? '')), 'the edited text is never served');
  a.store.close();
  // After a restart the checkpoint does not vouch for it: the whole-file sha256 differs.
  const b = x.mk();
  const r = b.store.readLedger('andy');
  assert.equal(r.chain.reason, 'mac', JSON.stringify(r.chain));
  assert.ok(b.alerts.some((al) => al.kind === 'claims-chain-broken'), 'alerted as before');
  assert.ok(x.rows.some((row) => row.kind === 'claims-checkpoint-mismatch' && row.agentId === 'andy'));
  b.store.close();
  assert.equal(JSON.parse(x.cp.text).agents.andy, undefined, 'a broken chain drops the agent from the checkpoint');
});

test('a forged checkpoint, another key id or another hive is ignored: a full verify', async () => {
  const x = setup();
  await writeLedger(x, 'andy', { '2026-09.jsonl': 200, '2026-10.jsonl': 5 });
  const s = x.mk().store;
  s.readLedger('andy');
  s.close();
  const good = x.cp.text;
  const lines = 205;
  // 1. A changed line count, MAC kept: forged.
  const j = JSON.parse(good);
  j.agents.andy.segs[0].lines = 199;
  x.cp.text = JSON.stringify(j);
  let c = countHmacs(() => x.mk().store.readLedger('andy'));
  assert.equal(c.r.chain, 'ok');
  assert.ok(c.c >= lines, `forged: full verify (${c.c})`);
  assert.ok(x.rows.some((row) => row.kind === 'claims-checkpoint-ignored'));
  // 2. Another key id, correctly MAC'd under this key: still not this ledger key's checkpoint.
  const k = JSON.parse(good); delete k.mac; k.keyId = '0123456789abcdef';
  k.mac = crypto.createHmac('sha256', KEY).update('claims-checkpoint\n').update(canonicalJson(k)).digest('hex');
  x.cp.text = JSON.stringify(k);
  c = countHmacs(() => x.mk().store.readLedger('andy'));
  assert.ok(c.c >= lines, `another key id: full verify (${c.c})`);
  // 3. Another hive (a copied user-data): the same text served to a second hive with the same ledger bytes.
  const y = setup();
 
  await writeLedger(y, 'andy', { '2026-09.jsonl': 200, '2026-10.jsonl': 5 });
  y.cp.text = good;
  c = countHmacs(() => y.mk().store.readLedger('andy'));
  assert.equal(c.r.chain, 'ok');
  assert.ok(c.c >= lines, `another hive: full verify (${c.c})`);
  // The good one is used.
  x.cp.text = good;
  c = countHmacs(() => x.mk().store.readLedger('andy'));
  assert.ok(c.c <= 5 + 2, `the good checkpoint is used (${c.c})`);
});

test('the segment set must match exactly: a deleted middle segment and a renamed one are full verifies', async () => {
  const x = setup();
  await writeLedger(x, 'andy', { '2026-08.jsonl': 50, '2026-09.jsonl': 50, '2026-10.jsonl': 50, '2026-11.jsonl': 3 });
  const s = x.mk().store;
  s.readLedger('andy');
  s.close();
  const good = x.cp.text;
  fs.renameSync(path.join(x.claimsDir('andy'), '2026-09.jsonl'), path.join(JAIL, `aside-${n}.jsonl`));
  let c = countHmacs(() => x.mk().store.readLedger('andy'));
  assert.equal(c.r.chain.reason, 'prev', 'the missing month breaks the chain, as without a checkpoint');
  assert.ok(x.rows.some((row) => row.kind === 'claims-checkpoint-mismatch'));
  // Put it back under another name (sorts the same, another name): no trust from the checkpoint.
  fs.renameSync(path.join(JAIL, `aside-${n}.jsonl`), path.join(x.claimsDir('andy'), '2026-09.jsonl'));
  x.cp.text = good;
  fs.renameSync(path.join(x.claimsDir('andy'), '2026-08.jsonl'), path.join(x.claimsDir('andy'), '2026-07.jsonl'));
  c = countHmacs(() => x.mk().store.readLedger('andy'));
  assert.equal(c.r.chain, 'ok');
  assert.ok(c.c >= 153, `a renamed segment: full verify (${c.c})`);
});

test('a cut tail of the newest segment still breaks at the head anchor after a checkpointed restart (C3)', async () => {
  const x = setup();
  await writeLedger(x, 'andy', { '2026-10.jsonl': 100, '2026-11.jsonl': 6 });
  const s = x.mk().store;
  assert.equal(s.readLedger('andy').chain, 'ok');
  s.close();
  const f = path.join(x.claimsDir('andy'), '2026-11.jsonl');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).slice(0, 4).map((l) => l + '\n').join(''));
  const m = x.mk();
  assert.deepEqual(m.store.readLedger('andy').chain, { brokenAt: 'head-anchor', reason: 'prev' });
  // And a whole closed month cut away (the newest deleted): the anchor catches it too.
  const y = setup();
  await writeLedger(y, 'andy', { '2026-09.jsonl': 50, '2026-10.jsonl': 50, '2026-11.jsonl': 2 });
  const t = y.mk().store; t.readLedger('andy'); t.close();
  fs.rmSync(path.join(y.claimsDir('andy'), '2026-11.jsonl'));
  assert.deepEqual(y.mk().store.readLedger('andy').chain, { brokenAt: 'head-anchor', reason: 'prev' });
});

test('in one session: a cached read stats and tail-reads, never re-reads a whole kept segment; an append verifies only itself', async () => {
  const x = setup();
  await writeLedger(x, 'andy', { '2026-10.jsonl': 300, '2026-11.jsonl': 300 });
  const { store } = x.mk();
  assert.equal(store.readLedger('andy').chain, 'ok');
  const files = ['2026-10.jsonl', '2026-11.jsonl'].map((f) => path.join(x.claimsDir('andy'), f));
  const hit = countReads(files, () => countHmacs(() => store.readLedgerCached('andy')));
  assert.equal(hit.c, 0, 'no whole-file read on a hit');
  assert.equal(hit.r.c, 0, 'no MAC on a hit');
  assert.equal(hit.r.r.records.length, 600);
  const r = await store.appendRecord('andy', { t: 'claim', kind: 'fact', text: 'one more' }, 'endpoint');
  assert.equal(r.ok, true);
  const grown = countReads(files, () => countHmacs(() => store.readLedgerCached('andy')));
  assert.equal(grown.c, 0, 'the appended line is read through an fd, not a whole-file read');
  assert.equal(grown.r.c, 1, 'only the appended line is MAC-checked');
  assert.equal(grown.r.r.records.length, 601);
  // A same-size edit inside a kept segment's last 4 KiB is a full read (the tail fingerprint), which refuses.
  const g = files[0];
  const gb = fs.readFileSync(g);
  const ga = gb.lastIndexOf('fact number');
  assert.ok(ga > gb.length - 4096);
  gb.write('FACT', ga, 'utf8');
  fs.writeFileSync(g, gb);
  assert.equal(store.readLedgerCached('andy').chain.reason, 'mac', 'a changed tail is re-verified in-session');
  gb.write('fact', ga, 'utf8');
  fs.writeFileSync(g, gb);
  assert.equal(store.readLedger('andy').chain, 'ok');
  // An anchor the kept read never reached (main's own record moved) is a full read that reports it.
  store.close(); // flush this process's pending anchor, so the stored one is the one held to
  const held = x.anchors.get(x.root, 'andy');
  x.anchors.set(x.root, 'andy', { head: 'f'.repeat(64), lastId: held.lastId });
  assert.deepEqual(store.readLedgerCached('andy').chain, { brokenAt: 'head-anchor', reason: 'prev' });
  x.anchors.set(x.root, 'andy', held);
  assert.equal(store.readLedger('andy').chain, 'ok');
  // A shrunk kept segment (a cut) is a full read that breaks at the anchor.
  store.close();
  const f = files[1];
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).slice(0, 200).map((l) => l + '\n').join(''));
  assert.deepEqual(store.readLedgerCached('andy').chain, { brokenAt: 'head-anchor', reason: 'prev' });
});

test('checkAnchored answers from the kept reads (no whole-file read) and still catches a deleted ledger', async () => {
  const x = setup();
  await writeLedger(x, 'andy', { '2026-10.jsonl': 200, '2026-11.jsonl': 10 });
  await writeLedger(x, 'jim', { '2026-11.jsonl': 50 });
  const { store, alerts } = x.mk();
  assert.deepEqual(store.checkAnchored(), []);
  const files = ['andy/memory/claims/2026-10.jsonl', 'andy/memory/claims/2026-11.jsonl', 'jim/memory/claims/2026-11.jsonl'].map((f) => path.join(x.root, 'agents', f));
  const again = countReads(files, () => store.checkAnchored());
  assert.deepEqual(again.r, []);
  assert.equal(again.c, 0, 'the 5-min check reads no whole ledger when nothing changed');
  fs.rmSync(path.join(x.root, 'agents', 'jim'), { recursive: true });
  assert.deepEqual(store.checkAnchored(), ['jim']);
  assert.ok(alerts.some((a) => a.kind === 'claims-chain-broken' && a.agentId === 'jim'));
});

test('warm(): nothing in the caller\'s turn, sliced by the clock, then reads are the cached ones', async () => {
  const x = setup();
  await writeLedger(x, 'andy', { '2026-09.jsonl': 3000, '2026-10.jsonl': 3000, '2026-11.jsonl': 1000 });
  await writeLedger(x, 'jim', { '2026-11.jsonl': 500 });
  const { store } = x.mk();
  const files = fs.readdirSync(x.claimsDir('andy')).map((f) => path.join(x.claimsDir('andy'), f));
  // The caller's turn: no read at all.
  let sync = 0;
  const agentsDir = path.join(x.root, 'agents');
  const realRead = fs.readFileSync; const realAsync = fs.promises.readFile; const realDir = fs.readdirSync;
  const mine = (p) => typeof p === 'string' && path.resolve(p).startsWith(agentsDir);
  fs.readFileSync = function (p, ...a) { if (mine(p)) sync++; return realRead.call(this, p, ...a); };
  fs.promises.readFile = function (p, ...a) { if (mine(p)) sync++; return realAsync.call(this, p, ...a); };
  const agents = store.ledgerAgents();
  fs.readdirSync = function (p, ...a) { if (mine(p)) sync++; return realDir.call(this, p, ...a); };
  let p;
  try { p = store.warm(agents, { sliceMs: 4 }); } finally { fs.readFileSync = realRead; fs.promises.readFile = realAsync; fs.readdirSync = realDir; }
  assert.equal(sync, 0, 'warm() reads nothing in the caller\'s turn');
  // The whole warm reads ledger segments through fs/promises only (a synchronous whole-file read blocks main).
  let syncSeg = 0;
  fs.readFileSync = function (q, ...a) { if (mine(q) && String(q).endsWith('.jsonl')) syncSeg++; return realRead.call(this, q, ...a); };
  try { await p; } finally { fs.readFileSync = realRead; }
  assert.equal(syncSeg, 0, 'no synchronous segment read during the warm');
  // Real clock, 4 ms slices: the longest stretch between two pauses stays far under the 50 ms block budget.
  let last = 0; let worst = 0; let pauses = 0;
  const y = setup();
  await writeLedger(y, 'andy', { '2026-09.jsonl': 3000, '2026-10.jsonl': 3000, '2026-11.jsonl': 1000 });
  const s2 = y.mk().store;
  last = performance.now();
  const res = await s2.warm(['andy'], { sliceMs: 4, pause: () => new Promise((r) => setImmediate(() => { const t = performance.now(); worst = Math.max(worst, t - last); pauses++; r(); last = performance.now(); })) });
  assert.deepEqual(res.warmed, ['andy']);
  assert.ok(pauses >= 3, `the warm paused between slices (${pauses})`);
  assert.ok(worst < 50, `no stretch between pauses reached 50 ms (${worst.toFixed(1)} ms)`);
  // Afterwards a read is the cached one: no whole-file read, no MAC.
  const hit = countReads(files, () => countHmacs(() => store.readLedgerCached('andy')));
  assert.equal(hit.c, 0);
  assert.equal(hit.r.c, 0);
  assert.equal(hit.r.r.records.length, 7000);
  assert.equal(store.readLedgerCached('jim').records.length, 500);
  // An injected clock decides the slices (a mutant that ignores the budget pauses only between agents and files).
  const z = setup();
  await writeLedger(z, 'andy', { '2026-10.jsonl': 2000, '2026-11.jsonl': 10 });
  let now = 0; let zp = 0;
  await z.mk().store.warm(['andy'], { sliceMs: 8, clock: () => (now += 10), pause: () => { zp++; return Promise.resolve(); } });
  assert.ok(zp >= 10, `the clock budget forced pauses inside one agent (${zp})`);
});

test('warm() and an append during it: the warm drops that agent, the append chains on the file\'s head', async () => {
  const x = setup();
  await writeLedger(x, 'andy', { '2026-10.jsonl': 2000, '2026-11.jsonl': 50 });
  const { store } = x.mk();
  const w = store.warm(['andy'], { sliceMs: 2 });
  const a = store.appendRecord('andy', { t: 'claim', kind: 'fact', text: 'during the warm' }, 'endpoint');
  const [res, r] = await Promise.all([w, a]);
  assert.deepEqual(res.skipped, ['andy']);
  assert.equal(r.ok, true, JSON.stringify(r));
  const read = store.readLedgerCached('andy');
  assert.equal(read.chain, 'ok');
  assert.equal(read.records.length, 2051);
  store.close();
  assert.equal(x.mk().store.readLedger('andy').chain, 'ok', 'a restart verifies the chain with the append');
});

test('a write that finished before the warm does not stop it (only one in flight or during it does)', async () => {
  const x = setup();
  await writeLedger(x, 'andy', { '2026-11.jsonl': 50 });
  const { store } = x.mk();
  const a = await store.appendRecord('andy', { t: 'claim', kind: 'fact', text: 'before the warm' }, 'endpoint');
  assert.equal(a.ok, true, JSON.stringify(a));
  const res = await store.warm(['andy']);
  assert.deepEqual(res.warmed, ['andy']);
});

test('a purge between two warm slices is never overwritten by the warm\'s older read', async () => {
  const x = setup();
  await writeLedger(x, 'andy', { '2026-10.jsonl': 3000, '2026-11.jsonl': 50 });
  const seed = x.mk().store;
  // '[secret]' has the tombstone's length: the purged line keeps its size (the purge event still grows the newest segment).
  const s = await seed.appendRecord('andy', { t: 'claim', kind: 'fact', text: '[secret]' }, 'endpoint');
  assert.equal(s.ok, true, JSON.stringify(s));
  await seed.appendRecord('andy', { t: 'claim', kind: 'fact', text: 'after the secret' }, 'endpoint');
  seed.close();
  const { store } = x.mk();
  let now = 0; let p = 0; let purged = null;
  const w = store.warm(['andy'], {
    sliceMs: 8, clock: () => (now += 10),
    // Pause 4 is inside the verify (the segments are already read): the purge lands between two slices.
    pause: () => { if (++p === 4) purged = store.purge('andy', [s.id], true); return new Promise((r) => setImmediate(r)); },
  });
  const res = await w;
  assert.ok(purged, `the purge ran during the warm (${p} pauses)`);
  const pr = await purged;
  assert.equal(pr.ok, true, JSON.stringify(pr));
  assert.deepEqual(res.skipped, ['andy']);
  const live = store.readLedgerCached('andy');
  assert.equal(live.chain, 'ok');
  assert.ok(!live.records.some((r) => r.text === '[secret]'), 'the purged text is not served');
  const a = await store.appendRecord('andy', { t: 'claim', kind: 'fact', text: 'after the purge' }, 'endpoint');
  assert.equal(a.ok, true, JSON.stringify(a));
  store.close();
  const again = x.mk().store.readLedger('andy');
  assert.equal(again.chain, 'ok', 'the append chained on the purged head');
  assert.equal(again.records.length, 3054);
});

test('a torn newest segment is left to the synchronous read (it quarantines), never warmed', async () => {
  const x = setup();
  await writeLedger(x, 'andy', { '2026-11.jsonl': 20 });
  fs.appendFileSync(path.join(x.claimsDir('andy'), '2026-11.jsonl'), '{"t":"claim","half');
  const { store } = x.mk();
  const res = await store.warm(['andy']);
  assert.deepEqual(res.skipped, ['andy']);
  const r = store.readLedgerCached('andy');
  assert.ok(r.torn, 'the synchronous read quarantined the torn tail');
  assert.equal(r.records.length, 20);
});

test('the head-anchor store re-reads its file only when it changed (claims-heads.json)', () => {
  const ud = path.join(JAIL, 'anchors-only');
  fs.mkdirSync(ud, { recursive: true });
  const file = path.join(ud, HEAD_ANCHOR_FILE);
  // LAG-MAIN-SYNC-FIXES (1.1.106): a map read within STAT_RACY_MS of the file's change is not cached (two same-size
  // in-place writes in one tick share a stat key: claims-lag-sync LAG-2c). Here the wall clock is past that window.
  const a = new FileHeadAnchorStore(file, () => Date.now() + 1000);
  a.set('C:/h', 'andy', { head: 'a'.repeat(64), lastId: 'c-000000000001' });
  const c = countReads([file], () => { for (let i = 0; i < 50; i++) a.get('C:/h', 'andy'); });
  assert.ok(c.c <= 1, `one read for 50 asks (${c.c})`);
  // Another writer's change is seen (a new size).
  const b = new FileHeadAnchorStore(file);
  b.set('C:/h', 'andy', { head: 'b'.repeat(64), lastId: 'c-000000000002' });
  assert.equal(a.get('C:/h', 'andy').head, 'b'.repeat(64));
  // A returned value is a copy.
  a.get('C:/h', 'andy').head = 'x';
  assert.equal(a.get('C:/h', 'andy').head, 'b'.repeat(64));
});

test('main wiring: the startup readers run after the warm, and read-only callers use the kept verified reads', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/main/index.ts'), 'utf8');
  const block = src.slice(src.indexOf('const warmed = startClaimsWarm(root, claimStore.store);'), src.indexOf('// W5 startup census.') + 400);
  assert.ok(block.length > 400, 'the warm starts with the claim store');
  for (const pin of ['void warmed.then(claimsAnchorCheck);', 'startAfterMailCardCatchUp(Promise.allSettled([mailCardCatchUp, warmed]),',
    'void warmed.then(() => claimExport().syncAllAsync(','void warmed.then(syncReaderWatchers);', 'void warmed.then(async () => { for (const agentId of claimLedgerAgents())']) {
    assert.ok(block.includes(pin), `pinned: ${pin}`);
  }
  assert.ok(!/setImmediate\((claimsAnchorCheck|syncReaderWatchers)\)/.test(block), 'no startup reader runs before the warm');
  assert.match(src, /claimsWarmReady\(\)\.then\(\(\) => importAtStart\(\{/, 'the import waits for the warm');
  // The full reads left in main are the purge scrub (an integrity path) and int's god-only bootstrap import (b247909c,
  // under the heavy lock, not at startup); the rest use the cache.
  assert.equal((src.match(/store\.readLedger\(/g) ?? []).length, 2);
  assert.match(src, /importOne: async \(agentId\) => \{\s*\n\s*const report = await shadowImport\(\{ hiveRoot: root, append: makeW6Append\(store\), read: \(a\) => store\.readLedger\(a\),/);
  assert.match(src, /verifiedPrefix\(ep\.store\.readLedger\(agentId\)\);\s*\n\s*if \(!prefix\) return 0;/);
  assert.match(src, /checkpoint: \{\s*\n\s*load: \(\) => \{ try \{ return readFileSync\(join\(app\.getPath\('userData'\), CLAIMS_CHECKPOINT_FILE\)/);
});
