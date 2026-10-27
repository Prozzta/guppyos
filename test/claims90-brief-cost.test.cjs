'use strict';
/**
 * CLAIMS-90 brief cost (god 986e89): a search brief must fit the warm search deadline (250 ms). It re-read and
 * re-verified every ledger and re-derived every agent per ask (~230 ms raw on the step-3 hive, more with MACs).
 *  - STORE: readLedgerCached returns readLedger's last chain-'ok' result while the segment files are unchanged;
 *    never a record the MAC check did not pass, and a broken read is never kept.
 *  - WIRING: while no input changed, a brief touches no ledger record (getDeps, get's index and the target index
 *    are kept); any changed input (an agent's records, tasks) gives the fresh answer.
 * Timing over a real hive copy: test/tools/claims90-brief-bench.cjs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-brief-cost-'));
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
const { SandboxKeyProvider, FileLedgerKeyRecord, FileHeadAnchorStore, KEY_RECORD_FILE, HEAD_ANCHOR_FILE } = loadTs('src/main/claims/keyProvider.ts');
const { claimCardLeadOver, claimGetOver, warmCardLeads } = loadTs('src/main/claims/readWiring.ts');
const { DEFAULT_KEY_REGISTRY, saveRegistry } = loadTs('src/main/claims/registry.ts');

let n = 0;
function hive() {
  const root = path.join(JAIL, `hive-${++n}`);
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  return root;
}
const note = (text) => ({ t: 'claim', kind: 'fact', text });
async function ok(p) { const r = await p; assert.equal(r.ok, true, JSON.stringify(r)); return r.id; }

test('STORE: readLedgerCached is the same verified read while the files are unchanged; an append gives a new read with the new record', async () => {
  const root = hive(); const ud = `${root}-ud`;
  let t = Date.parse('2026-10-27T10:00:00Z');
  const store = new ClaimStore({ hiveRoot: root, keys: new SandboxKeyProvider(), keyRecord: new FileLedgerKeyRecord(path.join(ud, KEY_RECORD_FILE)), headAnchor: new FileHeadAnchorStore(path.join(ud, HEAD_ANCHOR_FILE)), now: () => new Date(t += 1000) });
  STORES.push(store);
  await ok(store.appendRecord('andy', note('first fact'), 'endpoint'));
  const a = store.readLedgerCached('andy');
  assert.equal(a.chain, 'ok');
  assert.equal(store.readLedgerCached('andy'), a, 'unchanged: the kept read (MUTANT: no cache, a new read each ask)');
  const id = await ok(store.appendRecord('andy', note('second fact'), 'endpoint'));
  const b = store.readLedgerCached('andy');
  assert.notEqual(b, a);
  assert.ok(b.records.some((r) => r.id === id), 'the appended record is read (MUTANT: the size left out of the fingerprint)');
  assert.equal(store.readLedgerCached('agent-with-no-ledger').records.length, 0);
});

test('STORE: an edit that keeps the size (and mtime) never serves the forged line; readLedger reports the break and a broken read is not kept', async () => {
  const root = hive(); const ud = `${root}-ud`;
  const store = new ClaimStore({ hiveRoot: root, keys: new SandboxKeyProvider(), keyRecord: new FileLedgerKeyRecord(path.join(ud, KEY_RECORD_FILE)), headAnchor: new FileHeadAnchorStore(path.join(ud, HEAD_ANCHOR_FILE)) });
  STORES.push(store);
  await ok(store.appendRecord('andy', note('the bump is aaaaaaaa'), 'endpoint'));
  await ok(store.appendRecord('andy', note('another fact'), 'endpoint'));
  const kept = store.readLedgerCached('andy');
  const dir = path.join(root, 'agents', 'andy', 'memory', 'claims');
  const seg = path.join(dir, fs.readdirSync(dir).sort().pop());
  const st = fs.statSync(seg);
  const forged = fs.readFileSync(seg, 'utf8').replace('aaaaaaaa', 'bbbbbbbb');
  fs.writeFileSync(seg, forged);
  fs.utimesSync(seg, st.atime, st.mtime);
  assert.equal(fs.statSync(seg).size, st.size);
  const c = store.readLedgerCached('andy');
  assert.notEqual(c, kept, 'a segment changed in place (same size, mtime put back) is re-read (MUTANT: size and mtime as the check)');
  assert.notEqual(c.chain, 'ok', 'and the re-read is the verified one: the forged line breaks the MAC');
  assert.notEqual(store.readLedger('andy').chain, 'ok', 'the integrity path agrees');
});

test('STORE: a break readLedger finds while the files are byte-for-byte unchanged (a cut head anchor) drops the kept ok read (MUTANT: the ok read kept past a broken readLedger)', async () => {
  const root = hive(); const ud = `${root}-ud`;
  const keys = new SandboxKeyProvider();
  const anchors = new FileHeadAnchorStore(path.join(ud, HEAD_ANCHOR_FILE));
  const mk = () => { const s = new ClaimStore({ hiveRoot: root, keys, keyRecord: new FileLedgerKeyRecord(path.join(ud, KEY_RECORD_FILE)), headAnchor: anchors }); STORES.push(s); return s; };
  const w = mk();
  await ok(w.appendRecord('andy', note('a fact'), 'endpoint'));
  w.close();
  const store = mk();
  assert.equal(store.readLedgerCached('andy').chain, 'ok');
  anchors.set(root, 'andy', { head: 'f'.repeat(64), lastId: 'c-000000000000' });
  assert.notEqual(store.readLedger('andy').chain, 'ok', 'the integrity read reports the cut');
  assert.notEqual(store.readLedgerCached('andy').chain, 'ok', 'the kept ok read was dropped');
});

test('STORE: a broken or torn read is never kept: once the break is mended with the files unchanged, the next ask is ok (MUTANT: every read kept)', async () => {
  const root = hive(); const ud = `${root}-ud`;
  const keys = new SandboxKeyProvider();
  const anchors = new FileHeadAnchorStore(path.join(ud, HEAD_ANCHOR_FILE));
  const mk = () => { const s = new ClaimStore({ hiveRoot: root, keys, keyRecord: new FileLedgerKeyRecord(path.join(ud, KEY_RECORD_FILE)), headAnchor: anchors }); STORES.push(s); return s; };
  const w = mk();
  await ok(w.appendRecord('andy', note('a fact'), 'endpoint'));
  w.close();
  const store = mk();
  const good = anchors.get(root, 'andy');
  assert.ok(good, 'the writer anchored its head');
  anchors.set(root, 'andy', { head: 'f'.repeat(64), lastId: 'c-000000000000' });
  assert.notEqual(store.readLedgerCached('andy').chain, 'ok', 'cut anchor: broken');
  anchors.set(root, 'andy', good);
  assert.equal(store.readLedgerCached('andy').chain, 'ok', 'anchor mended, segments byte-identical: the broken read was not served again');
  // Torn: a half-written tail line, then the files put back byte-for-byte.
  const dir = path.join(root, 'agents', 'andy', 'memory', 'claims');
  const seg = path.join(dir, fs.readdirSync(dir).sort().pop());
  const whole = fs.readFileSync(seg);
  fs.appendFileSync(seg, '{"t":"claim","id":"c-half');
  assert.ok(store.readLedgerCached('andy').torn, 'a torn tail is reported');
  fs.writeFileSync(seg, whole);
  const after = store.readLedgerCached('andy');
  assert.equal(after.chain, 'ok');
  assert.ok(!after.torn, 'the tail completed (cut back here): the torn read was not served again');
});

// CLAIMS-BRIEF-LATENCY (god 360a86): appended lines are verified alone, never trusted.
const { randomBytes } = require('node:crypto');
const { recordMac, sha256Hex, keyIdOf } = loadTs('src/main/claims/canonical.ts');
function grownStore() {
  const root = hive(); const ud = `${root}-ud`;
  const key = randomBytes(32);
  let t = Date.parse('2026-10-27T10:00:00Z');
  const anchors = new FileHeadAnchorStore(path.join(ud, HEAD_ANCHOR_FILE));
  const store = new ClaimStore({ hiveRoot: root, keys: new SandboxKeyProvider(key), keyRecord: new FileLedgerKeyRecord(path.join(ud, KEY_RECORD_FILE)), headAnchor: anchors, now: () => new Date(t += 1000) });
  STORES.push(store);
  const full = store.readInner.bind(store);
  const counts = { full: 0 };
  store.readInner = (...a) => { counts.full++; return full(...a); };
  const dir = path.join(root, 'agents', 'andy', 'memory', 'claims');
  const seg = () => path.join(dir, fs.readdirSync(dir).sort().pop());
  let k = 0;
  /** A line appended by hand: signed with `signKey` after the newest line unless `over` changes a field. */
  const append = (over = {}, signKey = key) => {
    const last = fs.readFileSync(seg(), 'utf8').trimEnd().split('\n').pop();
    const r = { t: 'claim', id: `c-hand${String(++k).padStart(6, '0')}`, at: new Date(t += 1000).toISOString(), kind: 'fact', text: `hand fact ${k}`, source: 'self', agent: 'andy', prev: sha256Hex(last), ...over };
    r.mac = recordMac(signKey, r);
    fs.appendFileSync(seg(), JSON.stringify(r) + '\n');
    return r.id;
  };
  return { root, key, store, counts, append, seg, anchors, setNow: (iso) => { t = Date.parse(iso); } };
}

test('STORE: lines appended after a kept read are verified alone and extend it (no full re-read), a new month segment too (MUTANT: a full read per append)', async () => {
  const g = grownStore();
  await ok(g.store.appendRecord('andy', note('first'), 'endpoint'));
  const a = g.store.readLedgerCached('andy');
  const fulls = g.counts.full;
  const id = g.append();
  const b = g.store.readLedgerCached('andy');
  assert.equal(b.chain, 'ok');
  assert.notEqual(b.records, a.records, 'a new records array (the brief re-indexes)');
  assert.deepEqual(b.records.map((r) => r.id), [...a.records.map((r) => r.id), id]);
  assert.equal(g.counts.full, fulls, 'the kept read was extended, not re-read');
  assert.equal(g.store.readLedgerCached('andy'), b, 'and kept');
  g.setNow('2026-11-02T10:00:00Z');
  const nid = await ok(g.store.appendRecord('andy', note('november'), 'endpoint'));
  const before = g.counts.full;
  const c = g.store.readLedgerCached('andy');
  assert.ok(path.basename(g.seg()).startsWith('2026-11'), 'a new segment');
  assert.equal(c.chain, 'ok'); assert.equal(c.records[c.records.length - 1].id, nid);
  assert.equal(g.counts.full, before, 'a new segment after the kept ones extends too');
  assert.equal(g.store.readLedger('andy').records.length, c.records.length, 'the full read agrees');
});

for (const [name, bad, mutant] of [
  ['a MAC under another key', (g) => g.append({}, randomBytes(32)), 'no MAC check'],
  ['a prev that skips the head', (g) => g.append({ prev: 'e'.repeat(64) }), 'no prev check'],
  ['another agent\'s line', (g) => g.append({ agent: 'jim' }), 'no agent check'],
  ['an earlier line changed in place, then a good append', (g) => {
    const f = g.seg(); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('first', 'FIRST')); g.append();
  }, 'only the new bytes compared'],
  ['a cut head anchor, then a good append', (g) => {
    g.store.close(); g.anchors.set(g.root, 'andy', { head: 'f'.repeat(64), lastId: 'c-000000000000' }); g.append();
  }, 'no anchor check'],
]) {
  test(`STORE: an appended ${name} is never served; the read reports the break (MUTANT: ${mutant})`, async () => {
    const g = grownStore();
    await ok(g.store.appendRecord('andy', note('first'), 'endpoint'));
    await ok(g.store.appendRecord('andy', note('second'), 'endpoint'));
    assert.equal(g.store.readLedgerCached('andy').chain, 'ok');
    bad(g);
    assert.notEqual(g.store.readLedgerCached('andy').chain, 'ok');
  });
}

test('STORE: an appended rekey line is never taken on the fast path: one that does not follow the line before it reports the break (MUTANT: rekey accepted when appended)', async () => {
  const g = grownStore();
  await ok(g.store.appendRecord('andy', note('first'), 'endpoint'));
  assert.equal(g.store.readLedgerCached('andy').chain, 'ok');
  g.append({ t: 'event', ev: 'rekey', keyId: keyIdOf(g.key), targets: ['c-000000000000'] });
  const r = g.store.readLedgerCached('andy');
  assert.notEqual(r.chain, 'ok', 'the full verify checks a rekey against the line before it');
});

test('STORE: a pending purge re-anchor refuses the fast path; the full read drops one the ledger never reached (MUTANT: pending purge ignored when appended)', async () => {
  const g = grownStore();
  await ok(g.store.appendRecord('andy', note('first'), 'endpoint'));
  g.store.close();   // the head anchor flushed: no unflushed head of this process stands in for the stored one
  assert.equal(g.store.readLedgerCached('andy').chain, 'ok');
  const stored = g.anchors.get(g.root, 'andy');
  g.anchors.set(g.root, 'andy', { ...stored, pending: { head: 'a'.repeat(64), lastId: 'c-000000000000' } });
  g.append();
  assert.equal(g.store.readLedgerCached('andy').chain, 'ok');
  assert.equal(g.anchors.get(g.root, 'andy').pending, undefined, 'the swap never happened: the full read dropped the pending re-anchor');
});

test('STORE: a line chained on the head but written into an older segment is never served (MUTANT: any kept file may grow)', async () => {
  const g = grownStore();
  await ok(g.store.appendRecord('andy', note('october'), 'endpoint'));
  g.setNow('2026-11-02T10:00:00Z');
  await ok(g.store.appendRecord('andy', note('november'), 'endpoint'));
  assert.equal(g.store.readLedgerCached('andy').chain, 'ok');
  const newest = g.seg();
  const older = path.join(path.dirname(newest), fs.readdirSync(path.dirname(newest)).sort()[0]);
  const head = fs.readFileSync(newest, 'utf8').trimEnd().split('\n').pop();
  const r = { t: 'claim', id: 'c-hand-older', at: '2026-11-03T10:00:00.000Z', kind: 'fact', text: 'misplaced', source: 'self', agent: 'andy', prev: sha256Hex(head) };
  r.mac = recordMac(g.key, r);
  fs.appendFileSync(older, JSON.stringify(r) + '\n');
  assert.notEqual(g.store.readLedgerCached('andy').chain, 'ok');
});

// Wiring fixtures: a stub store whose records arrays the test controls (the same array while "unchanged").
const BUMP1 = '57ae9b25' + 'a'.repeat(32);
const BUMP2 = '0badf00d' + 'b'.repeat(32);
const c = (id, key, at, text, value) => ({ t: 'claim', id, at, wt: at, agent: 'derived', kind: 'fact', key, text, source: 'derived', value });
/** Count every element read of a records array (index access, iteration). */
function counted(arr) {
  const box = { gets: 0 };
  const p = new Proxy(arr, { get(t, k, r) { if (typeof k === 'string' && /^\d+$/.test(k)) box.gets++; return Reflect.get(t, k, r); } });
  return { p, box };
}

test('WIRING: a warm brief touches no ledger record; a changed records array or tasks list gives the fresh answer (MUTANT: getDeps rebuilt per ask)', () => {
  const root = hive();
  const one = counted([c('c_000000000001', 'release.1.1.90.bump', '2026-10-17T10:00:00.000Z', `Guppy 1.1.90 version bump is ${BUMP1}`, BUMP1)]);
  const ledgers = { derived: one.p };
  let tasks = [{ id: 'INT-1.1.90', status: 'done' }];
  const reads = { cached: 0, full: 0 };
  const store = {
    readLedger: (a) => { reads.full++; return { records: ledgers[a] ?? [], torn: null, chain: 'ok' }; },
    readLedgerCached: (a) => { reads.cached++; return { records: ledgers[a] ?? [], torn: null, chain: 'ok' }; },
  };
  const d = { root, store, agents: () => Object.keys(ledgers), tasks: () => tasks };
  const q = { cards: [], texts: ['bump 1.1.90 version commit'] };
  const first = claimCardLeadOver(d, q);
  assert.ok(first.briefs['release.1.1.90'].includes(`bump: ${BUMP1}`), JSON.stringify(first));
  assert.equal(reads.full, 0, 'the brief reads through readLedgerCached when the store has it');
  one.box.gets = 0;
  const again = claimCardLeadOver(d, q);
  assert.deepEqual(again, first);
  assert.equal(one.box.gets, 0, 'warm: no record read (getDeps, the get index and the target index are kept)');
  assert.match(claimGetOver(d, { term: 'release.1.1.90' }).text, new RegExp(`bump: ${BUMP1}`), 'get shares the kept index');
  // A new records array (the store re-read a changed ledger): the newer bump.
  ledgers.derived = [...one.p, c('c_000000000002', 'release.1.1.90.bump', '2026-10-18T10:00:00.000Z', `Guppy 1.1.90 version bump is ${BUMP2}`, BUMP2)];
  assert.ok(claimCardLeadOver(d, q).briefs['release.1.1.90'].includes(`bump: ${BUMP2}`), 'a changed ledger is re-read and re-indexed');
  // A new card in tasks.json: the target index is rebuilt and names it.
  assert.deepEqual(claimCardLeadOver(d, { cards: [], texts: ['what is MAIL-STUCK-9 last sha'] }).pointed, []);
  tasks = [...tasks, { id: 'MAIL-STUCK-9', status: 'done' }];
  const r = claimCardLeadOver(d, { cards: [], texts: ['q', 'MAIL-STUCK-9 was merged'] });
  assert.deepEqual(r.pointed, ['mail-stuck-9'], 'a changed task list rebuilds the target index (MUTANT: tasks left out of the kept signature)');
});

test('WIRING: warmCardLeads after a ledger change leaves the next brief warm; it builds nothing before a first brief for the root (MUTANT: warm builds no index)', () => {
  const root = hive();
  const one = counted([c('c_000000000001', 'release.1.1.90.bump', '2026-10-17T10:00:00.000Z', `Guppy 1.1.90 version bump is ${BUMP1}`, BUMP1)]);
  const ledgers = { derived: one.p };
  const store = { readLedger: (a) => ({ records: ledgers[a] ?? [], torn: null, chain: 'ok' }) };
  const d = { root, store, agents: () => Object.keys(ledgers), tasks: () => [] };
  assert.equal(warmCardLeads(d), false, 'no brief asked for this root yet: nothing built');
  assert.equal(one.box.gets, 0);
  const q = { cards: [], texts: ['bump 1.1.90 version commit'] };
  claimCardLeadOver(d, q);
  const two = counted([...one.p, c('c_000000000002', 'release.1.1.90.bump', '2026-10-18T10:00:00.000Z', `Guppy 1.1.90 version bump is ${BUMP2}`, BUMP2)]);
  ledgers.derived = two.p;
  assert.equal(warmCardLeads(d), true);
  two.box.gets = 0;
  assert.ok(claimCardLeadOver(d, q).briefs['release.1.1.90'].includes(`bump: ${BUMP2}`), 'the warmed answer is the new one');
  assert.equal(two.box.gets, 0, 'the brief after the warm touched no record');
});

test('WIRING: a registry change with the ledgers unchanged re-derives (MUTANT: the kept derive served across a registry change)', () => {
  const root = hive();
  const owner = (id, at, who) => ({ t: 'claim', id, at, wt: at, agent: 'derived', kind: 'fact', key: 'card.foo-7.owner', text: `FOO-7 owner is ${who}`, source: 'derived' });
  const recs = [owner('c_000000000001', '2026-10-17T10:00:00.000Z', 'alpha'), owner('c_000000000002', '2026-10-18T10:00:00.000Z', 'beta')];
  const store = { readLedger: () => ({ records: recs, torn: null, chain: 'ok' }), readLedgerCached: () => ({ records: recs, torn: null, chain: 'ok' }) };
  const d = { root, store, agents: () => ['derived'], tasks: () => [{ id: 'FOO-7', status: 'doing' }] };
  const q = { term: 'card.foo-7.owner' };
  assert.match(claimGetOver(d, q).text, /competing: 1 other live value/, 'card.* is multi: both owners live');
  const reg = structuredClone(DEFAULT_KEY_REGISTRY);
  reg.keys['card.foo-7.owner'] = { cardinality: 'single' };
  saveRegistry(root, reg);
  const t = claimGetOver(d, q).text;
  assert.match(t, /superseded: 1 replaced value/, 'single now: the older owner is superseded (same records array)');
  assert.doesNotMatch(t, /competing:/);
});
