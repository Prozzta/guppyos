'use strict';
/**
 * CLAIM-LEDGER W7: the Human's ledger UI (plan §3 W7; G7.1, G7.2).
 *  - The purge (R8): tombstone and re-chain through temp + rename, a purge event by the Human, the
 *    head re-anchored (F13); the text is gone from the segments, every backup day, restore asides and
 *    the continuous export; each backup stays a byte prefix; an interrupted swap is finished or dropped.
 *  - The UI: every write is an append except the purge (G7.1); revert, purge, export and a level drop
 *    from writer need main's confirm, and a cancel writes nothing; the purge also needs the typed word
 *    and can never come from an agent (no endpoint event, no HTTP route, IPC from the app window only).
 * Sandbox hives under a jailed HOME only: nothing here touches the live hive.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-claims-w7-'));
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
const { ClaimStore, PURGED_TEXT, rechainSegments } = loadTs(path.join(ROOT, 'src/main/claims/store.ts'));
const { SandboxKeyProvider, FileLedgerKeyRecord, FileHeadAnchorStore, KEY_RECORD_FILE, HEAD_ANCHOR_FILE } = loadTs(path.join(ROOT, 'src/main/claims/keyProvider.ts'));
const { sha256Hex } = loadTs(path.join(ROOT, 'src/main/claims/canonical.ts'));
const { derive } = loadTs(path.join(ROOT, 'src/main/claims/derive.ts'));
const { verifiedPrefix } = loadTs(path.join(ROOT, 'src/main/claims/indexSync.ts'));
const { DEFAULT_KEY_REGISTRY } = loadTs(path.join(ROOT, 'src/main/claims/registry.ts'));
const { scrubExport } = loadTs(path.join(ROOT, 'src/main/claims/exportLedger.ts'));
const { createLedgerUi, PURGE_WORD, PURGE_KEEPS } = loadTs(path.join(ROOT, 'src/main/claims/ledgerUi.ts'));
const { claimHistory, REVERTIBLE_EVENTS } = loadTs(path.join(ROOT, 'src/shared/claimsUi.ts'));

// CLAIMS-UI-W7-FLAKE-191: the secret's marker is a fresh 32-hex-char token. A 4-digit marker
// ('4417') turned up by chance in the ledger's hex hashes (1 run in 100, measured): a false fail.
const MARK = require('node:crypto').randomBytes(16).toString('hex');
const SECRET = `the door code is ${MARK}`;
let n = 0;
function setup() {
  const root = path.join(JAIL, `hive-${++n}`);
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  const ud = `${root}-userdata`;
  const keys = new SandboxKeyProvider();
  const anchors = new FileHeadAnchorStore(path.join(ud, HEAD_ANCHOR_FILE));
  const logs = [];
  const mk = (extra = {}) => {
    let t = Date.parse('2026-10-03T10:00:00Z');
    const store = new ClaimStore({ hiveRoot: root, keys, keyRecord: new FileLedgerKeyRecord(path.join(ud, KEY_RECORD_FILE)), headAnchor: anchors, now: () => new Date(t += 1000), alert: () => {}, log: (r) => logs.push(r), ...extra });
    STORES.push(store);
    return store;
  };
  const claimsDir = (a) => path.join(root, 'agents', a, 'memory', 'claims');
  const segs = (dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().map((f) => ({ name: f, text: fs.readFileSync(path.join(dir, f), 'utf8') }));
  const allText = (dir) => segs(dir).map((s) => s.text).join('');
  const lastLine = (a) => { const ls = allText(claimsDir(a)).split('\n').filter(Boolean); return ls[ls.length - 1]; };
  return { root, keys, anchors, logs, mk, claimsDir, segs, allText, lastLine };
}
const note = (text, extra = {}) => ({ t: 'claim', kind: 'fact', text, ...extra });
async function ok(p) { const r = await p; assert.equal(r.ok, true, JSON.stringify(r)); return r.id; }
function snapshot(dir) {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8'); } };
  if (fs.existsSync(dir)) walk(dir);
  return out;
}

/** A ledger with a secret claim in the middle, a backup day taken before the last records. */
async function seeded(x, store, agent = 'andy') {
  const a = await ok(store.appendRecord(agent, note('first'), 'endpoint'));
  const secret = await ok(store.appendRecord(agent, note(SECRET), 'endpoint'));
  const c = await ok(store.appendRecord(agent, note('third'), 'endpoint'));
  const backup = store.backupIfDue(agent, '2026-10-02T00:00:00Z');
  assert.ok(backup, 'a backup day was taken');
  const pin = await ok(store.appendRecord(agent, { t: 'event', ev: 'pin', targets: [c] }, 'endpoint'));
  const d = await ok(store.appendRecord(agent, note('fourth'), 'endpoint'));
  return { a, secret, c, pin, d, backup };
}

// ------------------------------------------------------------------ the store purge (R8)

test('purge: the text is gone from the segments and backups, a purge event by the human, chain ok, head re-anchored', async () => {
  const x = setup();
  const store = x.mk();
  const s = await seeded(x, store);
  const before = store.readLedger('andy');
  const r = await store.purge('andy', [s.secret], true);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(r.copies >= 1, 'the backup was rewritten');
  const live = x.allText(x.claimsDir('andy'));
  assert.ok(!live.includes(MARK), 'the secret is gone from the live segments');
  assert.ok(!x.allText(s.backup).includes(MARK), 'the secret is gone from the backup day');
  const after = store.readLedger('andy');
  assert.equal(after.chain, 'ok');
  assert.equal(after.records.length, before.records.length + 1, 'nothing dropped; one purge event added');
  const ev = after.records[after.records.length - 1];
  assert.equal(ev.t, 'event'); assert.equal(ev.ev, 'purge'); assert.equal(ev.by, 'human'); assert.deepEqual(ev.targets, [s.secret]);
  const tomb = after.records.find((rec) => rec.id === s.secret);
  assert.equal(tomb.text, PURGED_TEXT);
  assert.equal(after.records.find((rec) => rec.id === s.a).text, 'first', 'other claims keep their text');
  assert.equal(x.anchors.get(x.root, 'andy').head, sha256Hex(x.lastLine('andy')), 'the anchor moved to the new head (F13)');
  assert.equal(x.anchors.get(x.root, 'andy').pending, undefined, 'the pending re-anchor was committed');
  const state = derive(after.records, DEFAULT_KEY_REGISTRY, { r4: false });
  assert.equal(state.claims[s.secret].status, 'purged');
  assert.equal(state.claims[s.c].pinned, true, 'the pin survives the re-chain');
  // No leftovers next to the ledger; the log names ids only.
  const memDir = path.dirname(x.claimsDir('andy'));
  assert.deepEqual(fs.readdirSync(memDir).filter((f) => f.startsWith('claims.')), []);
  assert.ok(!fs.readdirSync(x.claimsDir('andy')).some((f) => !f.endsWith('.jsonl')), 'no purge-anchor or temp file left');
  assert.ok(!JSON.stringify(x.logs).includes(MARK), 'no text in the log');
  // A fresh store (a restart) reads the same verified ledger and can append on it.
  store.close();
  const s2 = x.mk();
  assert.equal(s2.readLedger('andy').chain, 'ok');
  await ok(s2.appendRecord('andy', note('after the purge'), 'endpoint'));
  assert.equal(s2.readLedger('andy').chain, 'ok');
});

test('purge: each backup stays a byte prefix of the live ledger (G1.7), and a restore aside is scrubbed too', async () => {
  const x = setup();
  const store = x.mk();
  const s = await seeded(x, store);
  // A restore puts the live segments aside (claims.pre-restore-*) and brings the backup back.
  const restored = store.restoreBackup('andy', '2026-10-02');
  assert.equal(restored.chain, 'ok');
  await ok(store.appendRecord('andy', note('after the restore'), 'endpoint'));
  const memDir = path.dirname(x.claimsDir('andy'));
  const aside = fs.readdirSync(memDir).find((f) => f.startsWith('claims.pre-restore-'));
  assert.ok(aside && x.allText(path.join(memDir, aside)).includes(MARK));
  const r = await store.purge('andy', [s.secret], true);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(!x.allText(path.join(memDir, aside)).includes(MARK), 'the restore aside is scrubbed');
  assert.ok(!x.allText(s.backup).includes(MARK));
  const live = x.segs(x.claimsDir('andy'));
  for (const b of x.segs(s.backup)) {
    const l = live.find((f) => f.name === b.name);
    assert.ok(l && l.text.startsWith(b.text), `${b.name}: the backup is a byte prefix of the live segment`);
  }
});

test('purge: refused without the Human flag, on a read-only ledger, for a non-claim or an already purged claim; nothing changes', async () => {
  const x = setup();
  const store = x.mk();
  const s = await seeded(x, store);
  const dir = x.claimsDir('andy');
  const snap = snapshot(dir);
  for (const flag of [undefined, false, 'true', 1]) {
    const r = await store.purge('andy', [s.secret], flag);
    assert.equal(r.ok, false); assert.match(r.error, /Human's confirmation/);
  }
  assert.match((await store.purge('andy', [s.pin], true)).error, /not a claim/);
  assert.match((await store.purge('andy', ['c-000000000000'], true)).error, /not a claim/);
  assert.match((await store.purge('andy', [s.secret, s.secret], true)).error, /repeated/);
  assert.deepEqual(snapshot(dir), snap, 'the refusals wrote nothing');
  await ok(store.purge('andy', [s.secret], true));
  // A claim purged already is not purged twice (S3: the same call only scrubs its copies again).
  const n0 = store.readLedger('andy').records.length;
  assert.deepEqual(await store.purge('andy', [s.secret], true), { ok: true, id: null, copies: 0, failedCopies: [] });
  assert.equal(store.readLedger('andy').records.length, n0);
  // A tampered ledger is read-only: no purge (it would re-sign the tampering).
  const seg = x.segs(dir)[0];
  fs.writeFileSync(path.join(dir, seg.name), seg.text.replace('"first"', '"FIRST"'));
  store.close();
  const s2 = x.mk();
  const snap2 = snapshot(dir);
  const r = await s2.purge('andy', [s.a], true);
  assert.equal(r.ok, false); assert.match(r.error, /read-only/);
  assert.deepEqual(snapshot(dir), snap2);
  // The key gone: refused too.
  const x3 = setup(); const s3 = x3.mk(); const t3 = await seeded(x3, s3); s3.close();
  x3.keys.drop();
  const s4 = x3.mk();
  assert.equal((await s4.purge('andy', [t3.secret], true)).ok, false);
  assert.ok(x3.allText(x3.claimsDir('andy')).includes(MARK));
});

test('purge: no agent path can write one (the endpoint and the UI origin refuse a purge event)', async () => {
  const x = setup();
  const store = x.mk();
  const s = await seeded(x, store);
  for (const origin of ['endpoint', 'ledger-route', 'ui-ipc']) {
    const r = await store.appendRecord('andy', { t: 'event', ev: 'purge', targets: [s.secret] }, origin);
    assert.equal(r.ok, false, origin); assert.match(r.error, /unsupported event/);
  }
  assert.ok(x.allText(x.claimsDir('andy')).includes(MARK));
});

test('purge swap crash states: the re-anchor is main\'s pending record (user-data); finished, dropped, or the old copy removed', async () => {
  // Build a purged copy P and the original O of the same ledger.
  const x = setup();
  const store = x.mk();
  const s = await seeded(x, store);
  store.close();
  const dir = x.claimsDir('andy');
  const O = snapshot(dir);
  const oldAnchor = x.anchors.get(x.root, 'andy');
  const s1 = x.mk();
  await ok(s1.purge('andy', [s.secret], true));
  s1.close();
  const P = snapshot(dir);
  const newAnchor = x.anchors.get(x.root, 'andy');
  assert.equal(newAnchor.pending, undefined, 'a finished purge leaves no pending re-anchor');
  const pendingAnchor = { ...oldAnchor, pending: { head: newAnchor.head, lastId: newAnchor.lastId } };
  const write = (d, files) => { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); for (const [k, v] of Object.entries(files)) fs.writeFileSync(path.join(d, k), v); };
  const fresh = `${dir}.purge-new`, old = `${dir}.purge-old`;

  // 1. Between the renames: no claims dir, purge-new and purge-old; main recorded the pending head.
  fs.rmSync(dir, { recursive: true, force: true });
  write(fresh, P);
  write(old, O);
  x.anchors.set(x.root, 'andy', pendingAnchor);
  let st = x.mk();
  assert.equal(st.readLedger('andy').chain, 'ok', 'the swap was finished and the re-anchor committed');
  assert.deepEqual(snapshot(dir), P);
  assert.ok(!fs.existsSync(fresh) && !fs.existsSync(old));
  assert.deepEqual(x.anchors.get(x.root, 'andy'), newAnchor);
  st.close();

  // 2. Before the first rename: the old ledger and a stray purge-new: the purge is dropped.
  write(dir, O);
  write(fresh, P);
  x.anchors.set(x.root, 'andy', pendingAnchor);
  st = x.mk();
  assert.equal(st.readLedger('andy').chain, 'ok');
  assert.deepEqual(snapshot(dir), O, 'the old ledger is intact');
  assert.ok(!fs.existsSync(fresh));
  assert.deepEqual(x.anchors.get(x.root, 'andy'), oldAnchor, 'a dropped purge does not re-anchor, and the pending entry is gone');
  st.close();

  // 3. After both renames, before the old copy was deleted: committed, purge-old removed.
  write(dir, P);
  write(old, O);
  x.anchors.set(x.root, 'andy', pendingAnchor);
  st = x.mk();
  assert.equal(st.readLedger('andy').chain, 'ok');
  assert.deepEqual(snapshot(dir), P);
  assert.ok(!fs.existsSync(old));
  assert.deepEqual(x.anchors.get(x.root, 'andy'), newAnchor);
  st.close();

  // 4. A pending purge never excuses a cut: the old ledger cut by its last line reaches neither head.
  const cut = Object.fromEntries(Object.entries(O).map(([k, v]) => [k, v]));
  const last = Object.keys(cut).sort().pop();
  cut[last] = cut[last].split('\n').filter(Boolean).slice(0, -1).map((l) => `${l}\n`).join('');
  write(dir, cut);
  x.anchors.set(x.root, 'andy', pendingAnchor);
  st = x.mk();
  assert.deepEqual(st.readLedger('andy').chain, { brokenAt: 'head-anchor', reason: 'prev' });
  assert.deepEqual(x.anchors.get(x.root, 'andy'), pendingAnchor, 'nothing committed or dropped on a cut');
  st.close();
});

test('B1: a purge-anchor.json planted in the agent folder moves nothing; the cut is caught (Andy\'s probe)', async () => {
  const x = setup();
  const s1 = x.mk();
  for (const text of ['first', 'second', 'a retraction the agent wants gone']) await ok(s1.appendRecord('andy', note(text), 'endpoint'));
  s1.close();
  const before = x.anchors.get(x.root, 'andy');
  const dir = x.claimsDir('andy');
  const seg = x.segs(dir)[0];
  const kept = seg.text.split('\n').filter(Boolean).slice(0, 2);
  fs.writeFileSync(path.join(dir, seg.name), kept.map((l) => `${l}\n`).join(''));
  fs.writeFileSync(path.join(dir, 'purge-anchor.json'), JSON.stringify({ head: sha256Hex(kept[1]), lastId: JSON.parse(kept[1]).id }));
  const s2 = x.mk();
  assert.deepEqual(s2.readLedger('andy').chain, { brokenAt: 'head-anchor', reason: 'prev' });
  assert.deepEqual(x.anchors.get(x.root, 'andy'), before, 'the anchor did not move');
  s2.close();
});

test('B1: a purge-new/purge-old pair main never recorded is not swapped in (no pending re-anchor)', async () => {
  const x = setup();
  const s1 = x.mk();
  for (const text of ['first', 'second', 'third']) await ok(s1.appendRecord('andy', note(text), 'endpoint'));
  s1.close();
  const before = x.anchors.get(x.root, 'andy');
  const dir = x.claimsDir('andy');
  const O = snapshot(dir);
  const cut = Object.fromEntries(Object.entries(O).map(([k, v]) => [k, v.split('\n').filter(Boolean).slice(0, 2).map((l) => `${l}\n`).join('')]));
  const fresh = `${dir}.purge-new`, old = `${dir}.purge-old`;
  fs.renameSync(dir, old);
  fs.mkdirSync(fresh, { recursive: true });
  for (const [k, v] of Object.entries(cut)) fs.writeFileSync(path.join(fresh, k), v);
  const s2 = x.mk();
  assert.deepEqual(s2.readLedger('andy').chain, { brokenAt: 'head-anchor', reason: 'prev' });
  assert.ok(fs.existsSync(fresh) && fs.existsSync(old) && !fs.existsSync(dir), 'the fake swap was left as it is');
  assert.deepEqual(x.anchors.get(x.root, 'andy'), before);
  s2.close();
});

test('S2: an agent cannot revert the Human\'s step (purge, the Human\'s revert); its own steps it can', async () => {
  const x = setup();
  const store = x.mk();
  const s = await seeded(x, store);
  const u = ui(x, store);
  const purged = await u.api.purge('andy', [s.secret], PURGE_WORD);
  assert.equal(purged.ok, true, JSON.stringify(purged));
  const undo = await ok(store.appendRecord('andy', { t: 'event', ev: 'pin', targets: [s.a] }, 'endpoint'));
  const humanRevert = await u.api.revert('andy', undo);
  assert.equal(humanRevert.ok, true, JSON.stringify(humanRevert));
  for (const origin of ['endpoint', 'ledger-route']) {
    for (const target of [purged.id, humanRevert.id]) {
      const r = await store.appendRecord('andy', { t: 'event', ev: 'revert', targets: [target] }, origin);
      assert.equal(r.ok, false, `${origin} revert of ${target}`);
      assert.match(r.error, /the Human's step; only the Human can revert it/);
    }
  }
  const state = derive(store.readLedger('andy').records, DEFAULT_KEY_REGISTRY, { r4: false });
  assert.equal(state.claims[s.secret].status, 'purged', 'the purge stands');
  assert.equal(state.claims[s.a].pinned, false, 'the Human\'s revert stands');
  // The agent's own pin it may still revert.
  await ok(store.appendRecord('andy', { t: 'event', ev: 'revert', targets: [s.pin] }, 'endpoint'));
  assert.equal(derive(store.readLedger('andy').records, DEFAULT_KEY_REGISTRY, { r4: false }).claims[s.c].pinned, false);
});

/** A synthetic ledger for derive (no chain or MAC: derive reads records only). */
function rec(i, extra) {
  const at = new Date(Date.parse('2026-10-03T10:00:00Z') + i * 1000).toISOString();
  return { v: 1, at, wt: at, agent: 'andy', prev: '', mac: '', ...extra };
}
/** For each revertible kind: a base ledger, the event, and a check that the event had an effect. */
const SCENARIOS = {
  pin: () => ({ ev: { ev: 'pin', targets: ['c-1'] } }),
  unpin: () => ({ base: { 'c-1': { pin: true } }, ev: { ev: 'unpin', targets: ['c-1'] } }),
  'soft-supersede': () => ({ ev: { ev: 'soft-supersede', targets: ['c-1', 'c-2'], by: 'code' } }),
  'inferred-supersede': () => ({ ev: { ev: 'inferred-supersede', targets: ['c-1', 'c-2'], by: 'code', rule: 'R4' } }),
  'reconcile-answer': () => ({ ev: { ev: 'reconcile-answer', targets: ['c-1', 'c-2'], answer: 'supersedes' } }),
  accept: () => ({ pre: [{ id: 'e-0', ev: 'soft-supersede', targets: ['c-1', 'c-2'], by: 'code' }], ev: { ev: 'accept', targets: ['c-1', 'c-2'] } }),
  dismiss: () => ({ base: { 'c-1': { key: 'project.x' }, 'c-2': { key: 'project.x', source: 'mail:jim' } }, ev: { ev: 'dismiss', targets: ['c-1', 'c-2'] } }),
};

test('S1 + nit 2: a revert of EVERY revertible kind restores derive\'s state before that event (property)', () => {
  assert.equal(REVERTIBLE_EVENTS.has('sighting'), false, 'a sighting is not offered: derive counts it without consulting reverts');
  assert.deepEqual([...REVERTIBLE_EVENTS].sort(), Object.keys(SCENARIOS).sort(), 'every revertible kind has a scenario');
  const view = (st) => ({ claims: st.claims, conflicts: st.conflicts });
  for (const kind of REVERTIBLE_EVENTS) {
    const sc = SCENARIOS[kind]();
    const claims = ['c-1', 'c-2', 'c-3'].map((id, i) => rec(i, { id, t: 'claim', kind: 'fact', text: `claim ${id}`, source: 'self', ...(sc.base?.[id] ?? {}) }));
    const pre = (sc.pre ?? []).map((e, i) => rec(10 + i, { t: 'event', by: 'self', ...e }));
    const ev = rec(20, { id: 'e-ev', t: 'event', by: 'self', ...sc.ev });
    const rv = rec(30, { id: 'e-rv', t: 'event', ev: 'revert', targets: ['e-ev'], by: 'human' });
    for (const r4 of [false, true]) {
      if (kind === 'inferred-supersede' && !r4) continue;
      const before = view(derive([...claims, ...pre], DEFAULT_KEY_REGISTRY, { r4 }));
      const withEv = view(derive([...claims, ...pre, ev], DEFAULT_KEY_REGISTRY, { r4 }));
      const reverted = view(derive([...claims, ...pre, ev, rv], DEFAULT_KEY_REGISTRY, { r4 }));
      assert.notDeepEqual(withEv, before, `${kind}: the scenario's event changes the state (r4 ${r4})`);
      assert.deepEqual(reverted, before, `${kind}: its revert restores the state before it (r4 ${r4})`);
    }
  }
});

test('S1: the UI does not offer a revert on a sighting; the history still shows it', async () => {
  const x = setup();
  const store = x.mk();
  const a = await ok(store.appendRecord('andy', note('seen twice'), 'endpoint'));
  const dup = await store.appendRecord('andy', note('seen twice'), 'endpoint');
  assert.equal(dup.ok, true, JSON.stringify(dup));
  const u = ui(x, store);
  const v = u.api.view('andy');
  const sight = v.events.find((e) => e.ev === 'sighting');
  assert.ok(sight, 'the duplicate is an R1 sighting');
  assert.equal(sight.revertible, false);
  assert.ok(!claimHistory(v, a).items.some((i) => i.revert === sight.id));
  assert.match((await u.api.revert('andy', sight.id)).error, /a sighting cannot be reverted/);
  assert.equal(u.calls.confirm.length, 0);
});

test('S3: a backup copy that fails is reported (UI note, log) and a purge of the same claim again rewrites it', async () => {
  const x = setup();
  const store = x.mk();
  const s = await seeded(x, store);
  const day = path.basename(s.backup);
  // Block the copy's temp file with a directory of that name: its write fails.
  const blocked = x.segs(s.backup).map((f) => path.join(s.backup, `${f.name}.purge-tmp`));
  for (const b of blocked) fs.mkdirSync(b);
  const u = ui(x, store);
  const r = await u.api.purge('andy', [s.secret], PURGE_WORD);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.note, new RegExp(`NOT rewritten \\(the text may still be there\\): ${day}\\. Purge this claim again to retry them\\.`));
  assert.ok(x.allText(s.backup).includes(MARK), 'the blocked backup still holds the text');
  assert.ok(x.logs.some((l) => l.kind === 'claims-purge-failed' && l.step === 'copy' && l.dir === day), 'the failure is logged');
  assert.ok(x.logs.some((l) => l.kind === 'claims-purge' && l.failedCopies.includes(day)));
  const events = store.readLedger('andy').records.length;
  // The obstacle gone, the same purge again: the copies are scrubbed, the ledger is not touched.
  for (const b of blocked) fs.rmSync(b, { recursive: true, force: true });
  const live = x.allText(x.claimsDir('andy'));
  const again = await u.api.purge('andy', [s.secret], PURGE_WORD);
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.id, undefined, 'no second purge event');
  assert.match(again.note, /^\d+ backup file\(s\) and \d+ export line\(s\) rewritten\.$/);
  assert.equal(u.calls.confirm[1].title, 'Scrub the copies again?');
  assert.ok(!x.allText(s.backup).includes(MARK), 'the backup is scrubbed now');
  assert.equal(x.allText(x.claimsDir('andy')), live, 'the live ledger is unchanged');
  assert.equal(store.readLedger('andy').records.length, events);
  const liveSegs = x.segs(x.claimsDir('andy'));
  for (const b of x.segs(s.backup)) assert.ok(liveSegs.find((f) => f.name === b.name).text.startsWith(b.text), 'still a byte prefix (G1.7)');
  // The store's own answer for a claim purged already: ok, no event id, the copies counted.
  const direct = await store.purge('andy', [s.secret], true);
  assert.deepEqual(direct, { ok: true, id: null, copies: 0, failedCopies: [] });
});

test('nit 1: the tombstone drops refs, the supersedes reason, section and legacy; keeps what derive places it by', async () => {
  const x = setup();
  const store = x.mk();
  const old = await ok(store.appendRecord('andy', note('the old door code'), 'endpoint'));
  const secret = await ok(store.appendRecord('andy', note(SECRET, {
    refs: [{ type: 'file', value: 'notes/door.txt' }], section: 'Codes', supersedes: [old], supersedesReason: { category: 'changed', note: 'the old code leaked' },
    source: 'self',
  }), 'w6-internal'));   // a section is set by the import only
  const raw = store.readLedger('andy').records.find((r) => r.id === secret);
  assert.ok(raw.refs && raw.section && raw.supersedesReason, `the seeded claim carries the fields: ${JSON.stringify(Object.keys(raw))}`);
  await ok(store.purge('andy', [secret], true));
  const t = store.readLedger('andy').records.find((r) => r.id === secret);
  assert.equal(t.text, PURGED_TEXT);
  for (const k of ['refs', 'supersedesReason', 'section', 'redacted', 'legacy']) assert.equal(k in t, false, `${k} is dropped`);
  for (const k of ['id', 'kind', 'source', 'at', 'wt', 'agent']) assert.deepEqual(t[k], raw[k], `${k} is kept`);
  assert.deepEqual(t.supersedes, [old], 'the link derive needs is kept');
  assert.ok(!x.allText(x.claimsDir('andy')).includes('door.txt') && !x.allText(x.claimsDir('andy')).includes('Codes'));
  assert.equal(derive(store.readLedger('andy').records, DEFAULT_KEY_REGISTRY, { r4: false }).claims[old].status, 'superseded');
});

test('SHOULD 4: both purge dialogs name what a purge does not remove', async () => {
  assert.match(PURGE_KEEPS, /memory\.md.*below writer.*memory archives.*claims\.torn\.jsonl.*search and usage logs.*mail.*index database until it is rebuilt or compacted \(not automatic yet\)/);
  const x = setup();
  const store = x.mk();
  const s = await seeded(x, store);
  const u = ui(x, store);
  await u.api.purge('andy', [s.secret], PURGE_WORD);
  await u.api.purge('andy', [s.secret], PURGE_WORD);
  assert.equal(u.calls.confirm.length, 2);
  for (const q of u.calls.confirm) assert.ok(q.detail.endsWith(PURGE_KEEPS), q.detail);
});

test('rechainSegments throws on an unparseable line (a purge never rewrites what it cannot read)', () => {
  const key = Buffer.alloc(32, 7);
  const files = [{ name: '2026-09.jsonl', text: 'not json\n' }];
  assert.throws(() => rechainSegments(files, new Set(['c-x']), key), 'an unparseable line throws');
});

// ------------------------------------------------------------------ the UI (G7.1, G7.2)

function ui(x, store, over = {}) {
  const calls = { confirm: [], saved: [], changed: 0, exported: [], logs: [] };
  let answer = true;
  let level = 'writer';
  const deps = {
    store: () => store,
    agents: () => ['andy'],
    level: () => level,
    savedLevel: () => level,
    saveLevel: (l) => { calls.saved.push(l); level = l; },
    levelChanged: () => { calls.changed++; return Promise.resolve(); },
    registry: () => DEFAULT_KEY_REGISTRY,
    derive, verifiedPrefix,
    exportComplete: (a) => { calls.exported.push(a); return { ok: true, file: 'memory.md', bytes: 10, note: '' }; },
    scrubExport: (a, ids) => scrubExport(path.join(x.root, 'agents', a), new Set(ids), (id) => `- [purged] [c:${id}]`),
    confirm: async (q) => { calls.confirm.push(q); return answer; },
    log: (r) => calls.logs.push(r),
    ...over,
  };
  return { api: createLedgerUi(deps), calls, answer: (a) => { answer = a; }, setLevel: (l) => { level = l; } };
}

test('UI: a cancelled confirm writes nothing (revert, purge, export, a level drop)', async () => {
  const x = setup();
  const store = x.mk();
  const s = await seeded(x, store);
  const u = ui(x, store);
  u.answer(false);
  const dir = path.join(x.root, 'agents', 'andy');
  const snap = snapshot(dir);
  for (const r of [
    await u.api.revert('andy', s.pin),
    await u.api.purge('andy', [s.secret], PURGE_WORD),
    await u.api.exportNow('andy'),
    await u.api.setLevel('reader'),
  ]) { assert.equal(r.ok, false); assert.equal(r.cancelled, true); }
  assert.equal(u.calls.confirm.length, 4);
  assert.deepEqual(u.calls.saved, []); assert.deepEqual(u.calls.exported, []); assert.equal(u.calls.changed, 0);
  assert.deepEqual(snapshot(dir), snap);
});

test('UI: the purge needs the typed word and main\'s danger confirm; wrong word = no dialog, no write', async () => {
  const x = setup();
  const store = x.mk();
  const s = await seeded(x, store);
  const u = ui(x, store);
  const dir = path.join(x.root, 'agents', 'andy');
  const snap = snapshot(dir);
  for (const typed of [undefined, '', 'Purge', 'purge ', 'yes', true]) {
    const r = await u.api.purge('andy', [s.secret], typed);
    assert.equal(r.ok, false); assert.match(r.error, /type "purge"/);
  }
  assert.match((await u.api.purge('andy', [s.pin], PURGE_WORD)).error, /not a claim/);
  assert.match((await u.api.purge('andy', 's', PURGE_WORD)).error, /bad claim ids/);
  assert.equal(u.calls.confirm.length, 0, 'no dialog before the typed word and a valid target');
  assert.deepEqual(snapshot(dir), snap);
  // The continuous export holds the text too: it is scrubbed (marker lines kept).
  const exp = path.join(dir, 'memory-ledger-export-2026-10.md');
  fs.writeFileSync(exp, `- ${SECRET} [c:${s.secret}]\n- third [c:${s.c}]\n- status of [c:${s.secret}] live -> superseded\n`);
  const r = await u.api.purge('andy', [s.secret], PURGE_WORD);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(u.calls.confirm.length, 1); assert.equal(u.calls.confirm[0].danger, true);
  const text = fs.readFileSync(exp, 'utf8');
  assert.ok(!text.includes(MARK)); assert.ok(text.includes(`- third [c:${s.c}]`)); assert.ok(text.includes(`status of [c:${s.secret}]`));
  const v = u.api.view('andy');
  assert.equal(v.claims.find((c) => c.id === s.secret).status, 'purged');
  assert.equal(v.counts.purged, 1);
});

test('UI: a revert is an append, restores the state before the step (G5.4) and cannot be reverted again', async () => {
  const x = setup();
  const store = x.mk();
  const s = await seeded(x, store);
  const u = ui(x, store);
  assert.equal(u.api.view('andy').claims.find((c) => c.id === s.c).pinned, true);
  const before = x.segs(x.claimsDir('andy'));
  const r = await u.api.revert('andy', s.pin);
  assert.equal(r.ok, true, JSON.stringify(r));
  const after = x.segs(x.claimsDir('andy'));
  for (const b of before) assert.ok(after.find((f) => f.name === b.name).text.startsWith(b.text), 'append only');
  const v = u.api.view('andy');
  assert.equal(v.claims.find((c) => c.id === s.c).pinned, false, 'the pin is undone');
  const ev = v.events.find((e) => e.id === r.id);
  assert.equal(ev.ev, 'revert'); assert.equal(ev.by, 'human'); assert.equal(ev.revertible, false);
  const pinEv = v.events.find((e) => e.id === s.pin);
  assert.equal(pinEv.reverted, true); assert.equal(pinEv.revertible, false);
  assert.match((await u.api.revert('andy', s.pin)).error, /already reverted/);
  assert.match((await u.api.revert('andy', r.id)).error, /cannot be reverted/);
  assert.match((await u.api.revert('andy', 'e-zz')).error, /bad event id/);
  // The history tells why, and marks the reverted step.
  const h = claimHistory(v, s.c);
  assert.ok(h.items.some((i) => /pinned by the agent/.test(i.text) && i.reverted));
  assert.ok(h.items[0].text.startsWith('Written by the agent as a fact'));
  assert.equal(u.calls.confirm.length, 1, 'only the real revert asked');
});

test('UI: a Human preference is a source-human append; over 400 characters is refused, never cut', async () => {
  const x = setup();
  const store = x.mk();
  await seeded(x, store);
  const u = ui(x, store);
  const id = await ok(u.api.addPreference('andy', 'Ask before deleting a branch.', 'pref.git.branches'));
  const c = u.api.view('andy').claims.find((k) => k.id === id);
  assert.equal(c.source, 'human'); assert.equal(c.kind, 'preference'); assert.equal(c.key, 'pref.git.branches');
  const long = await u.api.addPreference('andy', 'x'.repeat(401));
  assert.equal(long.ok, false);
  assert.ok(!x.allText(x.claimsDir('andy')).includes('x'.repeat(401)));
  assert.equal((await u.api.addPreference('andy', '   ')).ok, false);
  assert.equal(u.calls.confirm.length, 0, 'a preference is the Human typing it: no extra dialog');
});

test('UI: setLevel saves and pushes the change; a drop from writer exports every writer first and refuses on a failure', async () => {
  const x = setup();
  const store = x.mk();
  await seeded(x, store);
  let u = ui(x, store);
  assert.equal((await u.api.setLevel('writer')).ok, true);
  assert.deepEqual(u.calls.saved, ['writer']); assert.equal(u.calls.changed, 1); assert.equal(u.calls.confirm.length, 0);
  const r = await u.api.setLevel('reader');
  assert.equal(r.ok, true); assert.deepEqual(u.calls.exported, ['andy']); assert.deepEqual(u.calls.saved, ['writer', 'reader']); assert.equal(u.calls.changed, 2);
  // A failed export: the level stays.
  u = ui(x, store, { exportComplete: () => ({ ok: false, error: 'disk full' }) });
  const bad = await u.api.setLevel('off');
  assert.equal(bad.ok, false); assert.match(bad.error, /disk full; the level was not changed/);
  assert.deepEqual(u.calls.saved, []); assert.equal(u.calls.changed, 0);
  assert.equal((await u.api.setLevel('sideways')).ok, false);
  // Export below writer is refused (memory.md is still the agent's own file).
  u = ui(x, store); u.setLevel('reader');
  assert.match((await u.api.exportNow('andy')).error, /still its own file/);
  assert.deepEqual(u.calls.exported, []);
});

test('UI: a read-only ledger shows why and accepts no revert or purge', async () => {
  const x = setup();
  const store = x.mk();
  const s = await seeded(x, store);
  store.close();
  const dir = x.claimsDir('andy');
  const seg = x.segs(dir)[0];
  // Tamper after the pin, so the pin is in the verified prefix and only the read-only rule stops its revert.
  fs.writeFileSync(path.join(dir, seg.name), seg.text.replace('"fourth"', '"FOURTH"'));
  const u = ui(x, x.mk());
  const v = u.api.view('andy');
  assert.ok(v.readOnly);
  assert.ok(v.events.some((e) => e.id === s.pin), 'the pin is in the verified prefix');
  assert.match((await u.api.revert('andy', s.pin)).error, /read-only/);
  assert.match((await u.api.purge('andy', [s.a], PURGE_WORD)).error, /read-only/);
  assert.equal(u.calls.confirm.length, 0);
});

test('G7.1: every UI write goes through appendRecord with origin ui-ipc, except the one purge call', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/main/claims/ledgerUi.ts'), 'utf8');
  const writes = [...src.matchAll(/store\.(\w+)\(/g)].map((m) => m[1]).filter((m) => m !== 'readLedger');
  // Preference, revert, and CL-M4-CHAINS-PANEL's keep one / keep all are appends; then the purge.
  assert.deepEqual(writes.sort(), ['appendRecord', 'appendRecord', 'appendRecord', 'appendRecord', 'purge']);
  assert.equal([...src.matchAll(/appendRecord\([^)]*'ui-ipc'\)/g)].length, 4);
  assert.equal([...REVERTIBLE_EVENTS].includes('purge'), false);
  assert.equal([...REVERTIBLE_EVENTS].includes('revert'), false);
});

test('G7.2: the purge is reachable only from the app window\'s Settings IPC', () => {
  const idx = fs.readFileSync(path.join(ROOT, 'src/main/index.ts'), 'utf8');
  const handlers = idx.split('\n').filter((l) => l.includes("ipcMain.handle('claims-ui:"));
  assert.equal(handlers.length, 9);   // W7's 7, and CL-M4-CHAINS-PANEL's keep-one / keep-all
  for (const h of handlers) assert.match(h, /\(ledgerUiSender\(evt\) \?/, h);
  assert.match(idx, /function ledgerUiSender[^]*?BrowserWindow\.fromWebContents\(evt\.sender\) && evt\.senderFrame === evt\.sender\.mainFrame/);
  assert.match(idx, /if \(DEV_HIDDEN\) return false;/, 'a hidden harness run never confirms');
  assert.match(idx, /defaultId: 1, cancelId: 1/, 'Cancel is the default button');
  // Nothing else in main calls a purge.
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  const callers = walk(path.join(ROOT, 'src')).filter((f) => /\.tsx?$/.test(f)).filter((f) => /\.purge\(/.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(ROOT, f).split(path.sep).join('/')).sort();
  assert.deepEqual(callers, ['src/main/claims/ledgerUi.ts', 'src/main/index.ts', 'src/renderer/src/components/ClaimLedgerSettings.tsx']);
  assert.equal(idx.split('\n').filter((l) => /\.purge\(/.test(l)).length, 1, 'index.ts: only the claims-ui:purge handler');
  // No HTTP route, hook server or memory endpoint names it.
  for (const f of walk(path.join(ROOT, 'src/main')).filter((p) => /\.ts$/.test(p) && !/claims[\\/](store|ledgerUi)\.ts$/.test(p) && !/[\\/]index\.ts$/.test(p))) {
    assert.ok(!/ledgerUi|claims-ui:purge/.test(fs.readFileSync(f, 'utf8')), path.relative(ROOT, f));
  }
  // The renderer reaches the ledger UI from Settings only (no realtime or agent tool).
  const rend = walk(path.join(ROOT, 'src/renderer/src')).filter((f) => /\.tsx?$/.test(f) && /claimsUi/.test(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(ROOT, f).split(path.sep).join('/'));
  assert.deepEqual(rend, ['src/renderer/src/components/ClaimLedgerSettings.tsx']);
  // The Settings level change pushes to the running worker (W3: claimLedgerChanged).
  assert.match(idx, /'claimLedger' in patch\) void nativeMemory\.claimLedgerChanged\(\)/);
});

test('G7.3 (Jim SHOULD 1): the read-only banner says why in plain words and names the way out', () => {
  const { readOnlyText } = loadTs(path.join(ROOT, 'src/shared/claimsUi.ts'));
  const cases = [
    ['mac at c-0a1b2c3d4e5f', /integrity check failed at c-0a1b2c3d4e5f: a record was changed after it was written/],
    ['prev at head-anchor', /records are missing from its end: the ledger was cut or replaced/],
    ['prev at e-123456789abc', /chain of records breaks at e-123456789abc/],
    ['parse at C:\\hive\\agents\\andy\\memory\\claims\\2026-10.jsonl@120', /a line at 2026-10\.jsonl@120 cannot be read/],
    ['key-missing at c-0a1b2c3d4e5f', /ledger key is missing/],
  ];
  for (const [ro, why] of cases) {
    const t = readOnlyText(ro);
    assert.match(t, why, ro);
    assert.match(t, /^This ledger is locked because /);
    assert.match(t, /The way out: ask god to review it; the fix is restoring a backup day, or your anchor reset after that review/);
    assert.ok(!/\bmac\b/.test(t), `no jargon: ${t}`);
  }
  const src = fs.readFileSync(path.join(ROOT, 'src/renderer/src/components/ClaimLedgerSettings.tsx'), 'utf8');
  assert.match(src, /\{readOnlyText\(view\.readOnly as string\)\}/);
});
