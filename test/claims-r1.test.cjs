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
function setup(deps = {}) {
  const root = path.join(JAIL, `hive-${++n}`);
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  const appended = [];
  const logs = [];
  const store = new ClaimStore({ hiveRoot: root, keys: new SandboxKeyProvider(), keyRecord: new FileLedgerKeyRecord(path.join(`${root}-ud`, KEY_RECORD_FILE)), onAppend: (a, id, rec) => appended.push(rec), log: (row) => logs.push(row), ...deps });
  STORES.push(store);
  const read = (a = 'a1') => store.readLedger(a);
  const state = (a = 'a1') => { const r = read(a); return derive(r.records, (() => { try { return loadRegistry(root); } catch { return DEFAULT_KEY_REGISTRY; } })(), { r4: false }); };
  const claims = (a = 'a1') => read(a).records.filter((r) => r.t === 'claim');
  const live = (a = 'a1') => Object.values(state(a).claims).filter((c) => c.status === 'live');
  return { root, store, read, state, claims, live, appended, logs };
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

test('r1Identity is kind, key, source class, TTL, the refs as a set and the exact text', () => {
  const base = { kind: 'fact', text: 'x', source: 'self' };
  assert.notEqual(r1Identity(base), r1Identity({ ...base, kind: 'decision' }));
  assert.notEqual(r1Identity({ ...base, key: 'a.b' }), r1Identity(base));
  assert.equal(r1Identity(base), r1Identity({ ...base }));
  assert.equal(r1Identity(base), r1Identity({ ...base, source: 'human' }), 'self, human and legacy are one class: owner');
  assert.equal(r1Identity(base), r1Identity({ ...base, source: 'legacy' }));
  assert.notEqual(r1Identity(base), r1Identity({ ...base, source: 'mail:m1' }));
  assert.equal(r1Identity({ ...base, source: 'mail:m1' }), r1Identity({ ...base, source: 'mail:m2' }), 'mail is one class');
  assert.notEqual(r1Identity(base), r1Identity({ ...base, ttl: 'until:2026-12-01T00:00:00.000Z' }));
  assert.equal(r1Identity(base), r1Identity({ ...base, ttl: null }), 'no TTL and a null TTL are the same');
  const f = { type: 'file', value: 'src/a.ts' }, c = { type: 'commit', value: 'abc1234' };
  assert.notEqual(r1Identity(base), r1Identity({ ...base, refs: [f] }));
  assert.equal(r1Identity({ ...base, refs: [f, c] }), r1Identity({ ...base, refs: [c, f] }), 'refs are a set: order is not identity');
  assert.notEqual(r1Identity({ ...base, refs: [f] }), r1Identity({ ...base, refs: [f, f] }), 'nothing is deduplicated (exact-only)');
});

const MAIL = 'mail:2026-10-01T09-00-00-000Z-abcdef';

test('R1 (Jim R-1): a self note never sights a live MAIL claim, and mail never sights an owner claim', async () => {
  const x = setup();
  const mailed = await append(x.store, fact('synthetic relay listens on port 9001', { source: MAIL }));
  const own = await append(x.store, fact('synthetic relay listens on port 9001'));
  assert.match(own, /^c-/, 'the agent\'s own statement is an owner claim');
  assert.equal(x.state().claims[own].status, 'live');
  assert.equal(x.state().claims[mailed].status, 'live');
  const again = await append(x.store, fact('synthetic relay listens on port 9001', { source: MAIL }));
  assert.match(again, /^e-/, 'mail restating a live mail claim is still a sighting (of the mail claim)');
  assert.deepEqual(x.read().records.find((r) => r.id === again).targets, [mailed]);
  assert.equal(x.state().claims[own].sightings, 1, 'mail never raises an owner claim');
  const y = setup();
  const owner = await append(y.store, fact('synthetic owner fact'));
  assert.match(await append(y.store, fact('synthetic owner fact', { source: MAIL })), /^c-/, 'mail repeating an owner claim appends a mail claim');
  assert.equal(y.state().claims[owner].sightings, 1);
});

test('R1 (Jim R-2): an expired claim is not live for R1; a restatement with another TTL or none is a new claim', async () => {
  let t = Date.parse('2026-10-01T10:00:00Z');
  const x = setup({ now: () => new Date(t += 1000) });
  const a = await append(x.store, fact('synthetic freeze window is open', { ttl: 'until:2026-10-02T00:00:00Z' }));
  assert.match(await append(x.store, fact('synthetic freeze window is open', { ttl: 'until:2026-10-02T00:00:00Z' })), /^e-/, 'before expiry, the same TTL is a sighting');
  t = Date.parse('2026-10-05T10:00:00Z');
  const renewed = await append(x.store, fact('synthetic freeze window is open', { ttl: 'until:2026-10-20T00:00:00Z' }));
  assert.match(renewed, /^c-/, 'a new TTL renews it as a new claim');
  const plain = await append(x.store, fact('synthetic freeze window is open'));
  assert.match(plain, /^c-/, 'no TTL is another identity: a new claim');
  const same = await append(x.store, fact('synthetic freeze window is open', { ttl: 'until:2026-10-02T00:00:00Z' }));
  assert.match(same, /^c-/, 'the same TTL, already ended at the draft\'s wt: the candidate is not live for R1');
  assert.equal(x.state().claims[a].sightings, 2);
});

test('R1 (Jim R-2): a claim whose task TTL has ended (deps.taskStatus) is not sighted; an open task\'s is', async () => {
  const status = { 'task-77': 'doing' };
  const x = setup({ taskStatus: (id) => status[id] ?? null });
  const a = await append(x.store, fact('synthetic task-bound fact', { ttl: 'task:task-77' }));
  assert.match(await append(x.store, fact('synthetic task-bound fact', { ttl: 'task:task-77' })), /^e-/);
  status['task-77'] = 'done';
  assert.match(await append(x.store, fact('synthetic task-bound fact', { ttl: 'task:task-77' })), /^c-/, 'done: a new claim');
  status['task-77'] = 'cancelled';
  assert.equal(x.state().claims[a].sightings, 2);
  const y = setup({ taskStatus: () => 'cancelled' });
  await append(y.store, fact('synthetic cancelled-task fact', { ttl: 'task:task-78' }));
  assert.match(await append(y.store, fact('synthetic cancelled-task fact', { ttl: 'task:task-78' })), /^c-/, 'cancelled: a new claim');
});

const FILE_REF = { type: 'file', value: 'src/build.ts' }, COMMIT_REF = { type: 'commit', value: 'abc1234' };
test('R1 (Jim R-3): a restatement that adds or changes refs is a new claim, so the evidence is kept', async () => {
  const x = setup();
  await append(x.store, fact('synthetic build uses cache v2'));
  const withRef = await append(x.store, fact('synthetic build uses cache v2', { refs: [FILE_REF] }));
  assert.match(withRef, /^c-/);
  assert.deepEqual(x.read().records.find((r) => r.id === withRef).refs, [{ type: 'file', value: 'src/build.ts' }]);
  assert.match(await append(x.store, fact('synthetic build uses cache v2', { refs: [{ type: 'file', value: 'src/other.ts' }] })), /^c-/, 'changed refs');
  const two = await append(x.store, fact('synthetic build uses cache v2', { refs: [FILE_REF, COMMIT_REF] }));
  assert.match(two, /^c-/);
  const reordered = await append(x.store, fact('synthetic build uses cache v2', { refs: [COMMIT_REF, FILE_REF] }));
  assert.match(reordered, /^e-/, 'the same refs in another order: a sighting');
  assert.deepEqual(x.read().records.find((r) => r.id === reordered).targets, [two]);
});

test('R1 (Jim J1): a derive failure never blocks the append: the claim is appended and the failure is logged', async () => {
  const D = loadTs('src/main/claims/derive.ts');
  const real = D.derive;
  const x = setup();
  await append(x.store, fact('synthetic derive-failure fact'));
  D.derive = () => { throw new Error('synthetic derive failure'); };
  let id;
  try { id = await append(x.store, fact('synthetic derive-failure fact')); } finally { D.derive = real; }
  assert.match(id, /^c-/, 'appended as a claim');
  assert.ok(x.logs.some((r) => r.kind === 'claims-r1-failed' && /synthetic derive failure/.test(r.reason) && r.agentId === 'a1' && /^c-/.test(r.claimId)), JSON.stringify(x.logs));
  assert.ok(!JSON.stringify(x.logs.filter((r) => r.kind === 'claims-r1-failed')).includes('synthetic derive-failure fact'), 'the log row carries no claim text');
  assert.equal(x.claims().length, 2);
});

test('R1 (Jim K-1): a throwing taskStatus never blocks the append: the claim is appended and the failure is logged', async () => {
  let fail = false;
  const x = setup({ taskStatus: () => { if (fail) throw new Error('synthetic EBUSY on tasks.json'); return 'doing'; } });
  await append(x.store, fact('synthetic busy-task fact', { ttl: 'task:task-90' }));
  fail = true;
  const id = await append(x.store, fact('synthetic busy-task fact', { ttl: 'task:task-90' }));
  assert.match(id, /^c-/, 'appended as a claim');
  assert.ok(x.logs.some((r) => r.kind === 'claims-r1-failed' && /synthetic EBUSY/.test(r.reason) && /^c-/.test(r.claimId)), JSON.stringify(x.logs));
  assert.ok(!JSON.stringify(x.logs).includes('synthetic busy-task fact'), 'the log row carries no claim text');
  assert.equal(x.read().records.filter((r) => r.t === 'event').length, 0, 'a failed decision is never a sighting');
  assert.equal(x.claims().length, 2);
});

test('R1 (Jim J2): with several live exact copies (a pre-R1 ledger), the NEWEST is sighted', async () => {
  const x = setup();
  const older = await append(x.store, fact('synthetic doubled fact'));
  const newer = await append(x.store, fact('synthetic doubled fact', { pin: true }));   // a pin acts: a second live copy
  assert.match(newer, /^c-/);
  // A restart re-adopts the ledger: the index is rebuilt from disk, in ledger order.
  const ev = await append(x.store, fact('synthetic doubled fact'));
  assert.match(ev, /^e-/);
  assert.deepEqual(x.read().records.find((r) => r.id === ev).targets, [newer], 'the live index');
  // A restart re-adopts the ledger: the index is rebuilt from disk, in ledger order.
  const keys = x.store.d.keys, keyRecord = x.store.d.keyRecord;
  x.store.close();
  const y = new ClaimStore({ hiveRoot: x.root, keys, keyRecord, log: () => {} });
  STORES.push(y);
  const ev2 = await append(y, fact('synthetic doubled fact'));
  assert.deepEqual(y.readLedger('a1').records.find((r) => r.id === ev2).targets, [newer], 'the adopted index');
  const st = derive(y.readLedger('a1').records, DEFAULT_KEY_REGISTRY, { r4: false });
  assert.equal(st.claims[older].sightings, 1);
  assert.equal(st.claims[newer].sightings, 3);
});

test('R1 (Jim J3): the sighting\'s at is the draft\'s at (it ranks lastAt), for an endpoint and a legacy draft', async () => {
  const x = setup();
  const first = await append(x.store, fact('synthetic dated fact', { at: '2026-09-01T00:00:00Z' }));
  const ev = await append(x.store, fact('synthetic dated fact', { at: '2026-09-15T12:00:00Z' }));
  const rec = x.read().records.find((r) => r.id === ev);
  assert.equal(rec.at, '2026-09-15T12:00:00.000Z');
  assert.notEqual(rec.at, rec.wt);
  assert.equal(x.state().claims[first].lastAt, '2026-09-15T12:00:00.000Z');
  const text = '- synthetic dated legacy entry';
  const leg = (line) => ({ t: 'claim', kind: 'fact', text, source: 'legacy', at: '2026-08-02T00:00:00Z', legacy: { file: 'memory-archive-2026-08.md', line, sha256: sha256Hex(text) } });
  await append(x.store, leg(1), 'a1', 'w6-internal');
  const lev = await append(x.store, leg(5), 'a1', 'w6-internal');
  assert.match(lev, /^e-/);
  assert.equal(x.read().records.find((r) => r.id === lev).at, '2026-08-02T00:00:00.000Z');
});
