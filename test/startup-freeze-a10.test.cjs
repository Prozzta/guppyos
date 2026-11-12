'use strict';
require('./tools/own-job.cjs');

/**
 * STARTUP-FREEZE-104 A10 (Jim's 10x profile of 90b20a7b, ef46c1): with the registry storm gone the import ran 8x
 * further and hit the next O(ledger)-per-append cost: R1 (r1Live) and the supersede recheck read and parsed every
 * segment and ran derive over the whole ledger on every append (58.8 s of a warm start), and derive re-hashed the
 * 12.8 MB registry each time. Now:
 *  - the store keeps one view per agent (records + derive's statuses) and moves it over its own appends: a run of
 *    sightings and plain claims reads no segment and runs no derive (fs and derive spies);
 *  - a status is reused only when the appends since cannot have changed it; whatever the store answers equals a
 *    fresh derive of the ledger on disk (seeded random runs of claims, single and multi keys, duplicates,
 *    supersedes, retracts and events);
 *  - an R2 supersede by a newer single-key claim is seen (the old claim is no longer sighted);
 *  - derive hashes a frozen registry once, and a registry that can still change every time;
 *  - the S0 import yields (deps.tick) between appends.
 * Temp hives in a jailed HOME only.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-sf104-a10-'));
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
const { ClaimStore } = loadTs('src/main/claims/store.ts');
const { SandboxKeyProvider, FileLedgerKeyRecord, KEY_RECORD_FILE } = loadTs('src/main/claims/keyProvider.ts');
const REG = loadTs('src/main/claims/registry.ts');
const DERIVE = loadTs('src/main/claims/derive.ts');
const I = loadTs('src/main/claims/ingest.ts');

const realDerive = DERIVE.derive;
let deriveCalls = 0;
DERIVE.derive = (...a) => { deriveCalls++; return realDerive(...a); };

let hiveN = 0;
function hive() {
  const root = path.join(JAIL, `hive-${++hiveN}`);
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  return root;
}
function mkStore(root) {
  const logs = [];
  let t = Date.parse('2026-10-03T10:00:00Z');
  const now = () => new Date(t += 1000);
  const store = new ClaimStore({ hiveRoot: root, keys: new SandboxKeyProvider(), keyRecord: new FileLedgerKeyRecord(path.join(`${root}-userdata`, KEY_RECORD_FILE)), now, log: (r) => logs.push(r), alert: () => {} });
  STORES.push(store);
  return { store, logs };
}
async function ok(p) { const r = await p; assert.equal(r.ok, true, JSON.stringify(r)); return r.id; }
const sightings = (logs) => logs.filter((l) => l.kind === 'claims-r1-sighting');

/** The ledger as it is on disk, parsed as ledgerRecords reads it. */
function diskRecords(store, agent) {
  const out = [];
  for (const f of store.segments(agent)) for (const line of fs.readFileSync(f, 'utf8').split('\n')) if (line) out.push(JSON.parse(line));
  return out;
}
/** Pre-register the keys, then age the file so loadRegistryShared keeps one frozen object (as at the gate). */
async function settleRegistry(store, root, agent, keys) {
  for (const key of keys) await ok(store.appendRecord(agent, { t: 'claim', kind: 'fact', text: `seed ${key}`, key }, 'endpoint'));
  store.flushKeyRegistry();
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(REG.registryPath(root), old, old);
  const reg = REG.loadRegistryShared(root);
  assert.equal(REG.loadRegistryShared(root), reg, 'the registry must be one shared object for the rest of the run');
  return reg;
}

/** Counts readFileSync of this agent's ledger segments while `fn` runs. */
async function spySegments(store, agent, fn) {
  const real = fs.readFileSync;
  const dir = path.dirname(store.segments(agent)[0]);
  let reads = 0;
  fs.readFileSync = function (p, ...rest) { if (typeof p === 'string' && path.dirname(p) === dir) reads++; return real.call(this, p, ...rest); };
  try { await fn(); } finally { fs.readFileSync = real; }
  return reads;
}

test('A10: a run of plain claims and exact duplicates reads no segment and runs no derive after the first', async () => {
  const root = hive();
  const { store, logs } = mkStore(root);
  await settleRegistry(store, root, 'a1', ['card.a10', 'project.a10']);
  const first = { t: 'claim', kind: 'fact', text: 'the base fact', key: 'card.a10' };
  const base = await ok(store.appendRecord('a1', first, 'endpoint'));
  await ok(store.appendRecord('a1', first, 'endpoint'));   // primes the view: one read, one derive
  assert.equal(sightings(logs).length, 1);
  const d0 = deriveCalls;
  const reads = await spySegments(store, 'a1', async () => {
    for (let i = 0; i < 60; i++) {
      await ok(store.appendRecord('a1', { t: 'claim', kind: 'fact', text: `plain ${i}`, key: 'card.a10' }, 'endpoint'));
      await ok(store.appendRecord('a1', { t: 'claim', kind: 'fact', text: `bare ${i}` }, 'endpoint'));
      await ok(store.appendRecord('a1', first, 'endpoint'));
      await ok(store.appendRecord('a1', { t: 'claim', kind: 'fact', text: `plain ${i}`, key: 'card.a10' }, 'endpoint'));
    }
  });
  assert.equal(reads, 0, 'no segment is read per append');
  assert.equal(deriveCalls - d0, 0, 'no derive per append');
  const sights = sightings(logs);
  assert.equal(sights.length, 1 + 120);
  assert.equal(sights.filter((l) => l.target === base).length, 61);
});

test('A10: a newer single-key claim supersedes (R2) the old one, and its duplicate is no longer a sighting', async () => {
  const root = hive();
  const { store, logs } = mkStore(root);
  await settleRegistry(store, root, 'a1', ['project.a10r2']);
  const v1 = { t: 'claim', kind: 'fact', text: 'version one', key: 'project.a10r2' };
  const v2 = { t: 'claim', kind: 'fact', text: 'version two', key: 'project.a10r2' };
  const id1 = await ok(store.appendRecord('a1', v1, 'endpoint'));
  await ok(store.appendRecord('a1', v1, 'endpoint'));
  assert.equal(sightings(logs).at(-1).target, id1);
  const id2 = await ok(store.appendRecord('a1', v2, 'endpoint'));
  const n = sightings(logs).length;
  const again = await ok(store.appendRecord('a1', v1, 'endpoint'));
  assert.equal(sightings(logs).length, n, 'a superseded claim is not sighted');
  assert.notEqual(again, id1);
  await ok(store.appendRecord('a1', v1, 'endpoint'));
  assert.equal(sightings(logs).at(-1).target, again, 'the restated v1 is the newest live claim of the key');
  const m = sightings(logs).length;
  await ok(store.appendRecord('a1', v2, 'endpoint'));
  assert.equal(sightings(logs).length, m, 'v2 lost R2 to the restated v1, so it is not sighted');
  void id2;
});

test('A10: another registry object is a fresh derive (cardinality comes from the registry)', async () => {
  const root = hive();
  const { store } = mkStore(root);
  const reg = await settleRegistry(store, root, 'a1', ['card.harbor']);
  const older = await ok(store.appendRecord('a1', { t: 'claim', kind: 'fact', text: 'harbor one', key: 'card.harbor' }, 'endpoint'));
  await ok(store.appendRecord('a1', { t: 'claim', kind: 'fact', text: 'harbor two', key: 'card.harbor' }, 'endpoint'));
  assert.equal(store.statusesOf('a1', store.current('a1'), [older], reg).get(older), 'live', 'card.* is multi: both live');
  const single = structuredClone(reg);
  single.keys['card.harbor'] = { ...single.keys['card.harbor'], cardinality: 'single' };
  Object.freeze(single);
  assert.equal(store.statusesOf('a1', store.current('a1'), [older], single).get(older), 'superseded', 'single: R2 by the newer one');
});

test('A10: a supersede of a claim appended after the view was built is rechecked against that claim', async () => {
  const root = hive();
  const { store } = mkStore(root);
  await settleRegistry(store, root, 'a1', ['card.beacon']);
  const x = { t: 'claim', kind: 'fact', text: 'beacon x', key: 'card.beacon' };
  await ok(store.appendRecord('a1', x, 'endpoint'));
  await ok(store.appendRecord('a1', x, 'endpoint'));   // builds the view
  const y = await ok(store.appendRecord('a1', { t: 'claim', kind: 'fact', text: 'beacon y', key: 'card.beacon' }, 'endpoint'));
  await ok(store.appendRecord('a1', { t: 'claim', kind: 'fact', text: 'beacon y2', key: 'card.beacon', supersedes: [y], supersedesReason: { category: 'changed' } }, 'endpoint'));
  const again = await store.appendRecord('a1', { t: 'claim', kind: 'fact', text: 'beacon y3', key: 'card.beacon', supersedes: [y], supersedesReason: { category: 'changed' } }, 'endpoint');
  assert.equal(again.ok, false, 'y is superseded now');
});

test('A10: a soft-supersede whose winner then loses R2 frees the loser (linked ids are re-derived)', async () => {
  const root = hive();
  const { store } = mkStore(root);
  const reg = await settleRegistry(store, root, 'a1', ['project.lighthouse']);
  const y = await ok(store.appendRecord('a1', { t: 'claim', kind: 'fact', text: 'lighthouse y', key: 'project.lighthouse' }, 'endpoint'));
  const z = await ok(store.appendRecord('a1', { t: 'claim', kind: 'fact', text: 'loose z' }, 'endpoint'));
  await ok(store.appendSoftSupersede('a1', z, y, 'item-1'));
  const at = () => store.statusesOf('a1', store.current('a1'), [z], reg).get(z);
  assert.equal(at(), 'superseded?');
  await ok(store.appendRecord('a1', { t: 'claim', kind: 'fact', text: 'lighthouse c', key: 'project.lighthouse' }, 'endpoint'));
  assert.equal(at(), 'live', 'y lost R2, so the proposal no longer holds');
});

test('A11: a registry that only gained keys (the writer save) does not force a derive', async () => {
  const root = hive();
  const { store, logs } = mkStore(root);
  await settleRegistry(store, root, 'a1', ['card.anchor']);
  const first = { t: 'claim', kind: 'fact', text: 'anchor fact', key: 'card.anchor' };
  await ok(store.appendRecord('a1', first, 'endpoint'));
  await ok(store.appendRecord('a1', first, 'endpoint'));   // primes the view
  const d0 = deriveCalls;
  const regs = new Set();
  for (let i = 0; i < 25; i++) {
    await ok(store.appendRecord('a1', { t: 'claim', kind: 'fact', text: `grow ${i}`, key: `card.${(0x10000000 + i * 7919 * 104729).toString(16)}g${i}` }, 'endpoint'));
    await ok(store.appendRecord('a1', { t: 'claim', kind: 'fact', text: `grow p ${i}`, key: `project.${(0x20000000 + i * 6007 * 99991).toString(16)}h${i}` }, 'endpoint'));
    store.flushKeyRegistry();
    regs.add(REG.loadRegistryShared(root));
    await ok(store.appendRecord('a1', first, 'endpoint'));
  }
  assert.ok(regs.size >= 20, `the registry object changed ${regs.size} times`);
  assert.equal(deriveCalls - d0, 0, 'no derive when the registry only gained keys');
  assert.equal(sightings(logs).length, 26);
});

test('A11: sameStatusesUnder is false for any registry change derive reads differently', () => {
  const base = structuredClone(REG.DEFAULT_KEY_REGISTRY);
  base.keys['card.old'] = { cardinality: 'multi', addedAt: '2026-10-03T10:00:00.000Z', addedBy: 'a1' };
  base.keys['project.old'] = { cardinality: 'single', addedAt: '2026-10-03T10:00:00.000Z', addedBy: 'a1' };
  const v = (fn) => { const n = structuredClone(base); fn(n); return DERIVE.sameStatusesUnder(base, n); };
  const add = (k, cardinality, extra = {}) => (n) => { n.keys[k] = { cardinality, addedAt: '2026-10-03T10:00:01.000Z', addedBy: 'a1', ...extra }; };
  assert.equal(v(() => {}), true, 'unchanged');
  assert.equal(v(add('card.new', 'multi')), true, 'an added key as its namespace has it');
  assert.equal(v(add('project.new', 'single')), true, 'an added single key as its namespace has it');
  assert.equal(v(add('nowhere.new', 'multi')), true, 'an added multi key under no namespace (not single either way)');
  assert.equal(v(add('card.new', 'single')), false, 'an added key whose cardinality differs from its namespace');
  assert.equal(v(add('nowhere.new', 'single')), false, 'an added single key under no namespace');
  assert.equal(v(add('card.new', 'multi', { aliasOf: 'card.old' })), false, 'an added alias');
  assert.equal(v((n) => { n.keys['card.old'].cardinality = 'single'; }), false, 'a kept key changed cardinality');
  assert.equal(v((n) => { n.keys['card.old'].aliasOf = 'project.old'; }), false, 'a kept key became an alias');
  assert.equal(v((n) => { delete n.keys['card.old']; }), false, 'a removed key');
  assert.equal(v((n) => { delete n.keys['card.old']; n.keys['card.other'] = { cardinality: 'multi', addedAt: 'x', addedBy: 'a1' }; }), false, 'a removed key with as many added');
  assert.equal(v((n) => { n.namespaces[0] = { ...n.namespaces[0], cardinality: n.namespaces[0].cardinality === 'single' ? 'multi' : 'single' }; }), false, 'a namespace changed');
});

test('A15: keysTurnedSingle names the added keys that became single, and is null for any other difference', () => {
  const base = structuredClone(REG.DEFAULT_KEY_REGISTRY);
  base.keys['card.old'] = { cardinality: 'multi', addedAt: '2026-10-03T10:00:00.000Z', addedBy: 'a1' };
  base.keys['project.old'] = { cardinality: 'single', addedAt: '2026-10-03T10:00:00.000Z', addedBy: 'a1' };
  const v = (fn) => { const n = structuredClone(base); fn(n); return DERIVE.keysTurnedSingle(base, n); };
  const add = (k, cardinality, extra = {}) => (n) => { n.keys[k] = { cardinality, addedAt: '2026-10-03T10:00:01.000Z', addedBy: 'a1', ...extra }; };
  assert.deepEqual(DERIVE.keysTurnedSingle(base, base), []);
  assert.deepEqual(v(() => {}), []);
  assert.deepEqual(v(add('agent.a1.home', 'single')), ['agent.a1.home'], 'the writer registers agent.<id>.* single; derive did not read it single');
  assert.deepEqual(v((n) => { add('agent.a1.x', 'single')(n); add('card.new', 'multi')(n); add('agent.a1.y', 'single')(n); }), ['agent.a1.x', 'agent.a1.y']);
  assert.deepEqual(v(add('project.new', 'single')), [], 'single either way');
  assert.deepEqual(v(add('card.new', 'single')), ['card.new']);
  assert.equal(v(add('project.new', 'multi')), null, 'an added key that stops being single');
  assert.equal(v(add('agent.a1.z', 'single', { aliasOf: 'project.old' })), null, 'an added alias');
  assert.equal(v((n) => { n.keys['card.old'].cardinality = 'single'; }), null, 'a kept key changed');
  assert.equal(v((n) => { delete n.keys['card.old']; add('agent.a1.w', 'single')(n); }), null, 'a removed key');
  assert.equal(v((n) => { n.namespaces[1] = { ...n.namespaces[1], cardinality: 'multi' }; }), null, 'a namespace changed');
  assert.equal(DERIVE.sameStatusesUnder(base, (() => { const n = structuredClone(base); add('agent.a1.q', 'single')(n); return n; })()), false, 'A11 itself is unchanged');
});

test('A15: new agent.<id>.* keys saved during appends force no derive; a reason row for each full derive', async () => {
  const root = hive();
  const { store, logs } = mkStore(root);
  await settleRegistry(store, root, 'a1', ['card.anchor15']);
  const first = { t: 'claim', kind: 'fact', text: 'anchor fact 15', key: 'card.anchor15' };
  await ok(store.appendRecord('a1', first, 'endpoint'));
  await ok(store.appendRecord('a1', first, 'endpoint'));   // primes the view
  assert.deepEqual(logs.filter((l) => l.kind === 'claims-view-derive').map((l) => l.reason), ['no-view']);
  const d0 = deriveCalls;
  const regs = new Set();
  for (let i = 0; i < 25; i++) {
    await ok(store.appendRecord('a1', { t: 'claim', kind: 'fact', text: `own ${i}`, key: `agent.a1.${(0x30000000 + i * 7919 * 104729).toString(16)}k${i}` }, 'endpoint'));
    store.flushKeyRegistry();
    regs.add(REG.loadRegistryShared(root));
    await ok(store.appendRecord('a1', first, 'endpoint'));
  }
  assert.ok(regs.size >= 20, `the registry object changed ${regs.size} times`);
  assert.equal(deriveCalls - d0, 0, 'no derive when the registry only gained agent keys');
  assert.equal(sightings(logs).length, 26);
  // A claim of a key that turned single is re-derived when asked about (R2 now applies to it).
  const k = 'agent.a1.harborlight';
  const old = await ok(store.appendRecord('a1', { t: 'claim', kind: 'fact', text: 'harbor old', key: k }, 'endpoint'));
  await ok(store.appendRecord('a1', { t: 'claim', kind: 'fact', text: 'harbor new', key: k }, 'endpoint'));
  store.flushKeyRegistry();
  const reg = REG.loadRegistryShared(root);
  assert.equal(store.statusesOf('a1', store.current('a1'), [old], reg).get(old), realDerive(diskRecords(store, 'a1'), reg, { r4: false }).claims[old].status);
  assert.equal(store.statusesOf('a1', store.current('a1'), [old], reg).get(old), 'superseded');
  const reasons = logs.filter((l) => l.kind === 'claims-view-derive');
  assert.equal(reasons.at(-1).reason, 'dirty-key');
  assert.ok(reasons.every((l) => l.agentId === 'a1' && l.records > 0 && Number.isFinite(l.ms)));
  // A registry another writer changed (an alias) is a full derive, logged as such.
  const aliased = structuredClone(reg);
  aliased.keys[k] = { ...aliased.keys[k], aliasOf: 'card.anchor15' };
  deepFreezeLocal(aliased);
  store.statusesOf('a1', store.current('a1'), [old], aliased);
  assert.equal(logs.filter((l) => l.kind === 'claims-view-derive').at(-1).reason, 'registry');
});
function deepFreezeLocal(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const x of Object.values(o)) deepFreezeLocal(x); } return o; }

function rng(seed) {
  let x = seed >>> 0 || 1;
  return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 0x100000000; };
}

for (const seed of [1, 2, 3, 7, 42, 1009]) {
  test(`A10: every status the store answers equals a fresh derive of the ledger on disk (seed ${seed})`, async () => {
    const root = hive();
    const { store } = mkStore(root);
    const KEYS = ['project.northwind', 'project.quartz', 'card.marble', 'card.lantern'];
    await settleRegistry(store, root, 'a1', KEYS);
    const r = rng(seed);
    const pick = (a) => a[Math.floor(r() * a.length)];
    const drafts = [];
    const okBy = {};
    let reused = 0;
    const claimIds = () => diskRecords(store, 'a1').filter((x) => x.t === 'claim').map((x) => x.id);
    const eventIds = () => diskRecords(store, 'a1').filter((x) => x.t === 'event').map((x) => x.id);
    for (let step = 0; step < 160; step++) {
      const ids = claimIds();
      const op = pick(['dup', 'dup', 'dup', 'multi', 'none', 'single', 'single', 'supersede', 'retract', 'event', 'event', 'soft', 'at', 'newkey', 'newkey', 'agentkey', 'agentkey']);
      let draft;
      if (op === 'dup' && drafts.length) draft = pick(drafts);
      else if (op === 'multi') draft = { t: 'claim', kind: 'fact', text: `m ${step}`, key: pick(KEYS.slice(2)) };
      else if (op === 'none') draft = { t: 'claim', kind: 'fact', text: `n ${step}` };
      else if (op === 'newkey') draft = { t: 'claim', kind: 'fact', text: `k ${step}`, key: `${pick(['card', 'project', 'agent.a1'])}.${Math.floor(r() * 0xffffffff).toString(16).padStart(8, 'q')}x${step}` };
      // A15: claims under agent keys already used (single once saved; R2 between them).
      else if (op === 'agentkey') { const used = drafts.filter((x) => x.key?.startsWith('agent.a1.')); draft = used.length ? { t: 'claim', kind: 'fact', text: `ak ${step % 4}`, key: pick(used).key } : null; }
      else if (op === 'single') draft = { t: 'claim', kind: 'fact', text: `s ${step % 7}`, key: pick(KEYS.slice(0, 2)) };
      else if (op === 'at') draft = { t: 'claim', kind: 'fact', text: `s ${step % 5}`, key: pick(KEYS.slice(0, 2)), at: new Date(Date.parse('2026-10-03T10:00:00Z') + Math.floor(r() * 400) * 1000).toISOString() };
      else if (op === 'supersede') draft = { t: 'claim', kind: 'fact', text: `r ${step}`, key: pick(KEYS), supersedes: [pick(ids)], supersedesReason: { category: 'changed' } };
      else if (op === 'retract') draft = { t: 'claim', kind: 'fact', text: `x ${step}`, retracts: [pick(ids)] };
      else if (op === 'event') {
        const ev = pick(['reconcile-answer', 'reconcile-answer', 'accept', 'pin', 'dismiss', 'revert', 'unpin']);
        const evs = eventIds();
        draft = ev === 'revert' ? (evs.length ? { t: 'event', ev, targets: [pick(evs)] } : null)
          : ev === 'pin' || ev === 'unpin' ? { t: 'event', ev, targets: [pick(ids)] }
            : ev === 'reconcile-answer' ? { t: 'event', ev, targets: [pick(ids), pick(ids)], answer: pick(['supersedes', 'keep-both']) }
              : { t: 'event', ev, targets: [pick(ids), pick(ids)] };
      }
      if (!draft && op !== 'soft') continue;
      const res = op === 'soft' ? await store.appendSoftSupersede('a1', pick(ids), pick(ids), `item-${step}`)
        : await store.appendRecord('a1', draft, pick(['endpoint', 'ui-ipc']));
      if (res.ok && draft?.t === 'event') okBy[draft.ev] = (okBy[draft.ev] ?? 0) + 1;
      if (res.ok) { okBy[op] = (okBy[op] ?? 0) + 1; if (draft?.t === 'claim' && !draft.supersedes && !draft.retracts) drafts.push(draft); }
      // Ask the store about a few claims, as R1 and the recheck do, and hold it to a fresh derive.
      const all = claimIds();
      const ask = [...new Set([pick(all), pick(all), pick(all)])];
      const d0 = deriveCalls;
      const regNow = REG.loadRegistryShared(root);   // A11: grows as new keys are saved
      const got = store.statusesOf('a1', store.current('a1'), ask, regNow);
      if (deriveCalls === d0) reused++;
      const fresh = realDerive(diskRecords(store, 'a1'), regNow, { r4: false });
      for (const id of ask) assert.equal(got.get(id), fresh.claims[id]?.status, `seed ${seed} step ${step} op ${op}: ${id}`);
    }
    for (const op of ['dup', 'multi', 'none', 'single', 'supersede', 'retract', 'event', 'soft', 'reconcile-answer', 'revert', 'newkey', 'agentkey']) assert.ok(okBy[op] > 0, `no ${op} went in: ${JSON.stringify(okBy)}`);
    assert.ok(reused >= 40, `the view was reused only ${reused} times; the run proves nothing about reuse`);
  });
}

test('A10: derive hashes a frozen registry once; a registry that can change is hashed every time', async () => {
  const crypto = require('node:crypto');
  const real = crypto.createHash;
  let hashes = 0;
  crypto.createHash = function (...a) { hashes++; return real.apply(this, a); };
  try {
    const live = structuredClone(REG.DEFAULT_KEY_REGISTRY);
    const h1 = realDerive([], live, { r4: false }).registryHash;
    live.keys['project.added'] = { cardinality: 'single', addedAt: '2026-10-03T10:00:00.000Z', addedBy: 'a1' };
    const h2 = realDerive([], live, { r4: false }).registryHash;
    assert.notEqual(h1, h2, 'a changed registry gets a new hash');
    const frozen = REG.loadRegistryShared(hive());
    assert.ok(Object.isFrozen(frozen));
    const n = hashes;
    const a = realDerive([], frozen, { r4: false }).registryHash;
    const b = realDerive([], frozen, { r4: false }).registryHash;
    assert.equal(a, b);
    assert.equal(hashes - n, 1, 'one hash for the frozen registry');
  } finally { crypto.createHash = real; }
});

test('A10: the S0 import yields to the event loop between appends', async () => {
  const root = hive();
  const dir = path.join(root, 'agents', 'ag-1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory.md'), '# Memory\n\n## 2026-10-03\n' + Array.from({ length: 12 }, (_, i) => `- fact ${i}\n`).join(''));
  const seq = [];
  const records = [];
  const deps = {
    hiveRoot: root,
    append: async (agent, draft) => { seq.push('append'); records.push({ v: 1, id: `c${records.length}`, t: 'claim', ...draft }); return { ok: true, id: `c${records.length}` }; },
    read: () => ({ records: records.slice(), torn: null, chain: 'ok' }),
    log: () => {},
    tick: async () => { seq.push('tick'); },
  };
  const rep = await I.shadowImport(deps, 'ag-1');
  assert.equal(rep.appended, 12);
  const firstAppend = seq.indexOf('append');
  const tail = seq.slice(firstAppend);
  for (let i = 1; i < tail.length; i++) assert.ok(!(tail[i] === 'append' && tail[i - 1] === 'append'), `two appends with no yield between them at ${i}`);
});
