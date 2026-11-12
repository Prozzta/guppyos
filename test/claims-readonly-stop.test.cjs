'use strict';
require('./tools/own-job.cjs');
/**
 * CLAIMS-READONLY-RETRY-STORM (god 2ab323): a read-only derived ledger (its key missing) was offered every
 * changed slot, each append re-listing the claims segments and refused. The writer now asks the store once
 * per sync (ClaimStore.appendBlocked), writes nothing while the ledger is read-only, ends a sync whose
 * refusal turns out to be the ledger's state, logs one row per state change, and resumes when the key
 * returns. The store's own refusals are unchanged. Fixtures only: HOME jailed, throwaway hive roots.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-claims-rostop-'));
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
const ST = 'src/main/claims/store.ts';
const WR = 'src/main/claims/derivedWriter.ts';
const real = { store: loadTs(ST), W: loadTs(WR) };
const { SandboxKeyProvider, FileLedgerKeyRecord, KEY_RECORD_FILE } = loadTs('src/main/claims/keyProvider.ts');
const { derive } = loadTs('src/main/claims/derive.ts');
const { DEFAULT_KEY_REGISTRY } = loadTs('src/main/claims/registry.ts');
const { DERIVED_AGENT_ID } = loadTs('src/shared/claims.ts');
const D = DERIVED_AGENT_ID;
const readSource = (rel) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

const fact = (i, v = 'doing') => ({
  slot: `card.syn-${i}.status`, key: `card.syn-${i}.status`, kind: 'fact', text: `Card SYN-${i} status: ${v}`,
  at: '2026-10-01T00:00:00.000Z', refs: [{ type: 'task', value: `SYN-${i}` }],
});
const facts = (n, v) => Array.from({ length: n }, (_, i) => fact(i, v));
const note = (text) => ({ t: 'claim', kind: 'fact', text });

let n = 0;
/** A store over a fresh hive root; `again` opens a second store on the same root (a restart). */
function hive(mods, keys = new SandboxKeyProvider()) {
  const root = path.join(JAIL, `hive-${++n}`);
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  const record = new FileLedgerKeyRecord(path.join(`${root}-ud`, KEY_RECORD_FILE));
  const logs = [];
  const open = () => {
    const store = new mods.store.ClaimStore({ hiveRoot: root, keys, keyRecord: record, log: (row) => logs.push(row) });
    STORES.push(store);
    const calls = { append: 0 };
    const appendRecord = store.appendRecord.bind(store);
    store.appendRecord = (...a) => { calls.append++; return appendRecord(...a); };
    const deps = { store, derive: (records) => derive(records, DEFAULT_KEY_REGISTRY, { r4: false }), log: (row) => logs.push(row) };
    return { store, deps, calls };
  };
  return { root, keys, logs, open, rows: (kind) => logs.filter((r) => r.kind === kind) };
}

/** Counts readdirSync calls on claims folders while fn runs. */
async function claimsListings(fn) {
  const orig = fs.readdirSync;
  let count = 0;
  fs.readdirSync = function (p, ...rest) { if (/claims/.test(String(p))) count++; return orig.call(this, p, ...rest); };
  try { await fn(); } finally { fs.readdirSync = orig; }
  return count;
}

/** A fake store: refusals and blocks scripted per call. */
function fakeStore({ refuse = () => false, blocked = () => null }) {
  const calls = { append: 0, blocked: 0 };
  const store = {
    readLedger: () => ({ records: [], torn: null, chain: 'ok' }),
    appendRecord: async () => { calls.append++; return refuse(calls.append) ? { ok: false, error: 'refused' } : { ok: true, id: `c-${calls.append}` }; },
    appendBlocked: () => { calls.blocked++; return blocked(calls); },
  };
  const logs = [];
  const deps = { store, derive: (records) => derive(records, DEFAULT_KEY_REGISTRY, { r4: false }), log: (row) => logs.push(row) };
  return { deps, calls, logs, rows: (kind) => logs.filter((r) => r.kind === kind) };
}

/** A derived ledger written under key K, then K lost: the store reopens key-missing. */
async function keyMissingHive(mods) {
  const h = hive(mods);
  const a = h.open();
  const first = await mods.W.syncDerived(a.deps, facts(5));
  assert.equal(first.appended, 5, 'setup: the derived ledger is written while the key loads');
  a.store.close();
  const saved = h.keys.load();
  assert.equal(saved.ok, true, 'setup: the key is there');
  h.keys.drop();
  return { h, b: h.open(), savedKey: saved.key };
}

const CASES = [
  ['RO-1', async (mods) => {
    // noAttemptsWhileReadOnly: a key-missing ledger is offered nothing, however many slots changed.
    const { h, b } = await keyMissingHive(mods);
    let r10, r200;
    await mods.W.syncDerived(b.deps, facts(1, 'warm')); // the store's first read of the ledger lists it once
    const l10 = await claimsListings(async () => { r10 = await mods.W.syncDerived(b.deps, facts(10, 'done')); });
    const l200 = await claimsListings(async () => { r200 = await mods.W.syncDerived(b.deps, facts(200, 'blocked')); });
    assert.equal(b.calls.append, 0, 'RO-1 noAttemptsWhileReadOnly: no append is attempted on a read-only ledger');
    assert.equal(r10.readOnly, 10, 'RO-1 noAttemptsWhileReadOnly: every fact is counted read-only');
    assert.equal(r200.readOnly, 200, 'RO-1 noAttemptsWhileReadOnly: every fact is counted read-only');
    assert.equal(r200.failed, 0, 'RO-1 noAttemptsWhileReadOnly: nothing is counted as a failed append');
    assert.ok(l200 <= l10, `RO-1 noAttemptsWhileReadOnly: claims listings do not grow with the slot count (${l10} vs ${l200})`);
    assert.equal(h.rows('claims-derived-append-failed').length, 0, 'RO-1 noAttemptsWhileReadOnly: no per-slot failure rows');
    const ro = h.rows('claims-derived-readonly');
    assert.equal(ro.length, 1, `RO-1 noAttemptsWhileReadOnly: one read-only row for two syncs, got ${ro.length}`);
    assert.equal(ro[0].reason, 'key-missing', 'RO-1 noAttemptsWhileReadOnly: the row says why');
  }],
  ['RO-2', async (mods) => {
    // resumesOnKeyRestore: the Human restores the key file; the store loads it at the next start (the store's
    // key handling is unchanged: an agent read key-missing stays so until the store reloads), and the writer writes.
    const { h, b, savedKey } = await keyMissingHive(mods);
    await mods.W.syncDerived(b.deps, facts(10, 'done'));
    assert.equal(b.calls.append, 0, 'RO-2 resumesOnKeyRestore: setup is read-only');
    b.store.close();
    h.keys.key = Buffer.from(savedKey);
    const c = h.open();
    const r = await mods.W.syncDerived(c.deps, facts(10, 'done'));
    assert.equal(r.appended, 10, `RO-2 resumesOnKeyRestore: the next sync writes (${JSON.stringify(r)})`);
    assert.equal(r.readOnly, undefined, 'RO-2 resumesOnKeyRestore: nothing is read-only');
    assert.equal(h.rows('claims-derived-append-failed').length, 0, 'RO-2 resumesOnKeyRestore: no refusals');
  }],
  ['RO-3', async (mods) => {
    // resumesOnRekey: the Human's rekey makes the ledger writable again.
    const { h, b } = await keyMissingHive(mods);
    await mods.W.syncDerived(b.deps, facts(10, 'done'));
    assert.equal(b.calls.append, 0, 'RO-3 resumesOnRekey: setup is read-only');
    const before = h.rows('claims-derived-writable').length;
    const rk = await b.store.rekey(true);
    assert.equal(rk.ok, true, `RO-3 resumesOnRekey: setup rekey (${JSON.stringify(rk)})`);
    const r = await mods.W.syncDerived(b.deps, facts(10, 'done'));
    assert.ok(r.appended + r.unchanged + (r.redated ?? 0) > 0 && !r.readOnly, `RO-3 resumesOnRekey: the writer runs again (${JSON.stringify(r)})`);
    assert.equal(h.rows('claims-derived-append-failed').length, 0, 'RO-3 resumesOnRekey: no refusals after the rekey');
    assert.equal(h.rows('claims-derived-writable').length, before + 1, 'RO-3 resumesOnRekey: one writable row says it resumed');
    await mods.W.syncDerived(b.deps, facts(10, 'review'));
    assert.equal(h.rows('claims-derived-writable').length, before + 1, 'RO-3 resumesOnRekey: no row while the state holds');
  }],
  ['RO-4', async (mods) => {
    // stopsOnMidSyncBlock: a refusal that turns out to be the ledger's state ends the sync.
    const f = fakeStore({ refuse: () => true, blocked: (c) => (c.append >= 1 ? { brokenAt: 'key', reason: 'key-missing' } : null) });
    const r = await mods.W.syncDerived(f.deps, facts(50));
    assert.equal(f.calls.append, 1, `RO-4 stopsOnMidSyncBlock: 0 attempts after the first read-only refusal (${f.calls.append})`);
    assert.equal(r.readOnly, 50, 'RO-4 stopsOnMidSyncBlock: the refused fact and the rest are read-only');
    assert.equal(f.rows('claims-derived-append-failed').length, 0, 'RO-4 stopsOnMidSyncBlock: no failure rows');
    assert.equal(f.rows('claims-derived-readonly').length, 1, 'RO-4 stopsOnMidSyncBlock: one read-only row');
  }],
  ['RO-5', async (mods) => {
    // otherRefusalsContinue: a record refused while the ledger stays writable is a failure; the rest are written.
    const f = fakeStore({ refuse: (i) => i === 1 });
    const r = await mods.W.syncDerived(f.deps, facts(20));
    assert.equal(f.calls.append, 20, 'RO-5 otherRefusalsContinue: every fact is still offered');
    assert.equal(r.failed, 1, 'RO-5 otherRefusalsContinue: one failure');
    assert.equal(r.appended, 19, 'RO-5 otherRefusalsContinue: the rest are written');
    assert.equal(f.rows('claims-derived-append-failed').length, 1, 'RO-5 otherRefusalsContinue: the failure is logged');
    assert.equal(f.rows('claims-derived-readonly').length, 0, 'RO-5 otherRefusalsContinue: no read-only row');
  }],
  ['RO-6', async (mods) => {
    // firstUseWrites: no key and no ledger anywhere is first use, not read-only: the key is created.
    const h = hive(mods);
    const a = h.open();
    assert.equal(a.store.appendBlocked(D), null, 'RO-6 firstUseWrites: first use is not blocked');
    const r = await mods.W.syncDerived(a.deps, facts(3));
    assert.equal(r.appended, 3, `RO-6 firstUseWrites: the first sync writes (${JSON.stringify(r)})`);
    assert.equal(h.rows('claims-key-created').length, 1, 'RO-6 firstUseWrites: the key was created');
  }],
  ['RO-7', async (mods) => {
    // keyMissingElsewhere: the derived ledger is empty but another agent's exists; the key is missing.
    const h = hive(mods);
    const a = h.open();
    const w = await a.store.appendRecord('andy', note('andy wrote first'), 'endpoint');
    assert.equal(w.ok, true, 'RO-7 keyMissingElsewhere: setup append');
    a.store.close();
    h.keys.drop();
    const b = h.open();
    const blocked = b.store.appendBlocked(D);
    assert.equal(blocked?.reason, 'key-missing', `RO-7 keyMissingElsewhere: the store reports the block (${JSON.stringify(blocked)})`);
    const r = await mods.W.syncDerived(b.deps, facts(30));
    assert.equal(b.calls.append, 0, 'RO-7 keyMissingElsewhere: no append is attempted');
    assert.equal(r.readOnly, 30, 'RO-7 keyMissingElsewhere: every fact is read-only');
    assert.equal(h.rows('claims-key-created').length, 1, 'RO-7 keyMissingElsewhere: no second key is created');
  }],
  ['RO-8', async (mods) => {
    // storeStillRefuses: the writer's stop changes nothing in the store: a direct append is still refused.
    const { b } = await keyMissingHive(mods);
    const r = await b.store.appendRecord(D, note('a direct write'), 'endpoint');
    assert.equal(r.ok, false, 'RO-8 storeStillRefuses: the store refuses a read-only append itself');
    assert.match(r.error, /read-only/, 'RO-8 storeStillRefuses: and says why');
  }],
];

for (const [id, fn] of CASES) test(id, () => fn(real));

const MUTANTS = [
  { id: 'M1', what: 'the writer does not ask before a sync', file: WR, from: '  if (facts.length && derivedBlocked(deps)) { counts.readOnly = facts.length; return counts; }\n', to: '', dies: ['RO-1', 'RO-7'] },
  { id: 'M2', what: 'a read-only refusal does not end the sync', file: WR, from: '} else if (derivedBlocked(deps)) {', to: '} else if (false) {', dies: ['RO-4'] },
  { id: 'M3', what: 'every refusal ends the sync', file: WR, from: '} else if (derivedBlocked(deps)) {', to: '} else if (derivedBlocked(deps) || true) {', dies: ['RO-5'] },
  { id: 'M4', what: 'a row per sync, not per state change', file: WR, from: "if (k !== (lastBlocked.get(deps.store) ?? '')) {", to: 'if (true) {', dies: ['RO-1', 'RO-3'] },
  { id: 'M5', what: 'the writer remembers the block and never re-asks', file: WR, from: 'const b = deps.store.appendBlocked?.(DERIVED_AGENT_ID) ?? null;', to: "const b = lastBlocked.get(deps.store) ? { brokenAt: 'key', reason: 'key-missing' } as ChainBreak : (deps.store.appendBlocked?.(DERIVED_AGENT_ID) ?? null);", dies: ['RO-3'] },
  { id: 'M8', what: 'the writer remembers the block across a restart', file: WR, from: 'const b = deps.store.appendBlocked?.(DERIVED_AGENT_ID) ?? null;', to: "const b = (derivedBlocked as any).ever ? { brokenAt: 'key', reason: 'key-missing' } as ChainBreak : (deps.store.appendBlocked?.(DERIVED_AGENT_ID) ?? null); if (b) (derivedBlocked as any).ever = true;", dies: ['RO-2'] },
  { id: 'M6', what: 'the store ignores a key missing while ledgers exist', file: ST, from: "if (!this.keys() && this.anySegmentAnywhere()) return { brokenAt: 'key', reason: 'key-missing' };", to: '', dies: ['RO-7'] },
  { id: 'M7', what: 'the store calls first use read-only', file: ST, from: "if (!this.keys() && this.anySegmentAnywhere()) return { brokenAt: 'key', reason: 'key-missing' };", to: "if (!this.keys()) return { brokenAt: 'key', reason: 'key-missing' };", dies: ['RO-6'] },
];

function mutated(m) {
  const src = readSource(m.file).split('\r\n').join('\n');
  assert.equal(src.split(m.from).length - 1, 1, `${m.id}: the mutant edit applies exactly once`);
  const text = src.split(m.from).join(m.to);
  return m.file === WR ? { store: real.store, W: loadTs.fromText(WR, text) } : { store: loadTs.fromText(ST, text), W: real.W };
}

for (const m of MUTANTS.filter((x) => x.dies.length)) {
  test(`mutant: ${m.id} ${m.what}`, async () => {
    const mods = mutated(m);
    for (const id of m.dies) {
      const fn = CASES.find(([c]) => c === id)[1];
      let died = null;
      try { await fn(mods); } catch (e) { died = e; }
      assert.ok(died instanceof assert.AssertionError, `SURVIVED: ${m.id} (${m.what}) at ${id}`);
      assert.match(died.message, new RegExp(id), `${m.id} died at the wrong guarantee: ${died.message}`);
    }
  });
}

test('MUTANT CENSUS: every mutant applies once and names a guarantee that exists', () => {
  const ids = new Set(CASES.map(([c]) => c));
  for (const m of MUTANTS) {
    assert.equal(readSource(m.file).split('\r\n').join('\n').split(m.from).length - 1, 1, `${m.id} applies once`);
    for (const id of m.dies) assert.ok(ids.has(id), `${m.id} names ${id}`);
  }
  const killed = new Set(MUTANTS.flatMap((m) => m.dies));
  for (const id of ids) if (id !== 'RO-8') assert.ok(killed.has(id), `${id} has a mutant`);
});
