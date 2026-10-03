'use strict';
/**
 * CLAIM-LEDGER R1 (plan §W2 "R1 exact duplicate becomes a sighting"; B11: exact-only), written by
 * the W1 store on every append path (the endpoint and W6's import): an exact duplicate of one of
 * the agent's LIVE claims (same kind, same key or none, the same stored text) is appended as a
 * `sighting` event of it, never as a second live claim; it never runs R5 (it is an event).
 * Jim's arm-L finding (CL-W8-ARM-L-RESULTS.md). Synthetic text only; HOME jailed first.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-claims-r1-'));
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
const { ClaimStore, r1Identity } = loadTs('src/main/claims/store.ts');
const { SandboxKeyProvider, FileLedgerKeyRecord, KEY_RECORD_FILE } = loadTs('src/main/claims/keyProvider.ts');
const { derive } = loadTs('src/main/claims/derive.ts');
const { DEFAULT_KEY_REGISTRY, loadRegistry } = loadTs('src/main/claims/registry.ts');
const { parseNewBullets, knownIdsFor, ledgerEntryCounts } = loadTs('src/main/claims/migrate.ts');
const { makeW6Append } = loadTs('src/main/claims/w6Append.ts');
const { shouldRunR5 } = loadTs('src/main/claims/reconcile.ts');
const { sha256Hex } = loadTs('src/main/claims/canonical.ts');

let n = 0;
function setup() {
  const root = path.join(JAIL, `hive-${++n}`);
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  const appended = [];
  const store = new ClaimStore({ hiveRoot: root, keys: new SandboxKeyProvider(), keyRecord: new FileLedgerKeyRecord(path.join(`${root}-ud`, KEY_RECORD_FILE)), onAppend: (a, id, rec) => appended.push(rec) });
  STORES.push(store);
  const read = (a = 'a1') => store.readLedger(a);
  const state = (a = 'a1') => { const r = read(a); return derive(r.records, (() => { try { return loadRegistry(root); } catch { return DEFAULT_KEY_REGISTRY; } })(), { r4: false }); };
  const claims = (a = 'a1') => read(a).records.filter((r) => r.t === 'claim');
  const live = (a = 'a1') => Object.values(state(a).claims).filter((c) => c.status === 'live');
  return { root, store, read, state, claims, live, appended };
}
async function append(store, draft, agent = 'a1', origin = 'endpoint') {
  const r = await store.appendRecord(agent, draft, origin);
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.id;
}
const fact = (text, extra = {}) => ({ t: 'claim', kind: 'fact', text, ...extra });

test('R1: an exact duplicate with no key gives ONE live claim with sightings 2 (a sighting event, not a claim)', async () => {
  const x = setup();
  const first = await append(x.store, fact('synthetic relay listens on port 4471'));
  const second = await append(x.store, fact('synthetic relay listens on port 4471'));
  assert.match(second, /^e-/, 'the duplicate is an event');
  assert.equal(x.claims().length, 1);
  const ev = x.read().records.find((r) => r.id === second);
  assert.deepEqual({ ev: ev.ev, targets: ev.targets, rule: ev.rule, by: ev.by }, { ev: 'sighting', targets: [first], rule: 'R1', by: 'self' });
  assert.equal(x.live().length, 1);
  assert.equal(x.state().claims[first].sightings, 2);
  await append(x.store, fact('synthetic relay listens on port 4471'));
  assert.equal(x.state().claims[first].sightings, 3, 'every restatement counts');
  assert.equal(x.read().chain, 'ok', 'the chain verifies with the sighting in it');
});

test('R1: a keyed exact restatement is a sighting, NOT an R2 supersede: the original stays live', async () => {
  const x = setup();
  const first = await append(x.store, fact('synthetic window is friday', { key: 'release.window' }));
  const again = await append(x.store, fact('synthetic window is friday', { key: 'release.window' }));
  assert.match(again, /^e-/);
  const s = x.state();
  assert.equal(s.claims[first].status, 'live');
  assert.equal(s.claims[first].sightings, 2);
  assert.equal(x.claims().length, 1);
});

test('R1 is exact-only: a different text, kind or key appends a claim (no near-duplicates, no folding)', async () => {
  const x = setup();
  await append(x.store, fact('synthetic relay listens on port 4471'));
  for (const d of [
    fact('synthetic relay listens on port 4472'),                       // different text
    fact('Synthetic relay listens on port 4471'),                       // case is not folded
    fact('synthetic relay listens on port 4471 '),                      // whitespace is not folded
    { t: 'claim', kind: 'decision', text: 'synthetic relay listens on port 4471' },   // different kind
    fact('synthetic relay listens on port 4471', { key: 'project.relay-port' }),       // a key vs none
  ]) assert.match(await append(x.store, d), /^c-/, JSON.stringify(d));
  assert.equal(x.claims().length, 6);
  assert.equal(x.live().length, 5 + 1 - 0, 'all live (no keys collide)');
});

test('R1: a duplicate of a SUPERSEDED or RETRACTED claim appends normally (only a live claim is sighted)', async () => {
  const x = setup();
  const old = await append(x.store, fact('synthetic old fact'));
  await append(x.store, fact('synthetic newer fact', { supersedes: [old] }));
  assert.equal(x.state().claims[old].status, 'superseded');
  const back = await append(x.store, fact('synthetic old fact'));
  assert.match(back, /^c-/, 'superseded: a new claim');
  assert.equal(x.state().claims[back].status, 'live');
  const gone = await append(x.store, fact('synthetic withdrawn fact'));
  await append(x.store, fact('withdrawn', { retracts: [gone] }));
  assert.equal(x.state().claims[gone].status, 'retracted');
  assert.match(await append(x.store, fact('synthetic withdrawn fact')), /^c-/, 'retracted: a new claim');
});

test('R1: a draft that acts (supersedes, retracts or pins) is appended as a claim even with the same text', async () => {
  const x = setup();
  const a = await append(x.store, fact('synthetic pinned fact'));
  assert.match(await append(x.store, fact('synthetic pinned fact', { pin: true })), /^c-/, 'a pin is an act');
  const b = await append(x.store, fact('synthetic other'));
  assert.match(await append(x.store, fact('synthetic pinned fact', { supersedes: [b] })), /^c-/);
  void a;
});

test('R1: an exact duplicate never runs R5 (the append is a sighting event); a new claim still does', async () => {
  const x = setup();
  await append(x.store, fact('synthetic r5 fact'));
  await append(x.store, fact('synthetic r5 fact'));
  assert.deepEqual(x.appended.map((r) => [r.t, shouldRunR5(r)]), [['claim', true], ['event', false]]);
});

test('R1 in the W6 import: a memory.md bullet restating a live claim becomes a sighting, and a re-run offers it no more', async () => {
  const x = setup();
  const w6 = makeW6Append(x.store);
  const noted = await append(x.store, fact('- synthetic bullet fact'));
  const md = '- synthetic bullet fact\n- synthetic new bullet\n';
  let drafts = parseNewBullets(md, knownIdsFor(x.read().records));
  assert.equal(drafts.length, 2);
  const ids = [];
  for (const d of drafts) { const r = await w6('a1', d, 'w6-internal', { r5: false }); assert.equal(r.ok, true); ids.push(r.id); }
  assert.match(ids[0], /^e-/, 'the restatement is a sighting');
  assert.match(ids[1], /^c-/, 'the new bullet is a claim');
  assert.equal(x.state().claims[noted].sightings, 2);
  const ev = x.read().records.find((r) => r.id === ids[0]);
  assert.equal(ev.reason, `legacy ${sha256Hex('- synthetic bullet fact')}`, 'the sighting names the entry hash');
  drafts = parseNewBullets(md, knownIdsFor(x.read().records));
  assert.deepEqual(drafts, [], 'idempotent: nothing offered again');
});

test('R1 in the W6 import: a repeated legacy entry is one claim plus a sighting, and counts as imported twice', async () => {
  const x = setup();
  const text = '- synthetic repeated archive entry';
  const draft = (line) => ({ t: 'claim', kind: 'fact', text, source: 'legacy', legacy: { file: 'memory-archive-2026-09.md', line, sha256: sha256Hex(text) } });
  const a = await append(x.store, draft(3), 'a1', 'w6-internal');
  const b = await append(x.store, draft(9), 'a1', 'w6-internal');
  assert.match(a, /^c-/); assert.match(b, /^e-/);
  assert.equal(ledgerEntryCounts(x.read().records).get(sha256Hex(text)), 2, 'W6 counts the sighting as the second entry');
  // A PART of a split entry is never R1: its hash is the whole entry's, not its own text's.
  const part = { t: 'claim', kind: 'fact', text, source: 'legacy', legacy: { file: 'memory-archive-2026-09.md', line: 20, sha256: sha256Hex(`${text}\nmore`) } };
  assert.match(await append(x.store, part, 'a1', 'w6-internal'), /^c-/);
});

test('r1Identity is kind, key and the exact text', () => {
  assert.notEqual(r1Identity({ kind: 'fact', text: 'x' }), r1Identity({ kind: 'decision', text: 'x' }));
  assert.notEqual(r1Identity({ kind: 'fact', key: 'a.b', text: 'x' }), r1Identity({ kind: 'fact', text: 'x' }));
  assert.equal(r1Identity({ kind: 'fact', text: 'x' }), r1Identity({ kind: 'fact', text: 'x' }));
});
