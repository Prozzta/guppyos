'use strict';
require('./tools/own-job.cjs');
/**
 * LAG-MAIN-SYNC-FIXES items 2 + 3 (1.1.106): sync file I/O the claims ledger did on main.
 *   2. FileHeadAnchorStore re-read and parsed claims-heads.json on every get/agents/set. It keeps
 *      the parsed map, revalidated by the file's stat key on every call (no time window), dropped
 *      by set(), and batch() lets a census check the file once. A stale map must never verify a
 *      forged (cut) ledger.
 *   3. claimLedgerAgents listed agents/ and every agent's claims folder for each consumer. The
 *      store now serves one census (ClaimStore.ledgerAgents), listed again on its own writes, an
 *      agents/ stat change, or after ROSTER_REVALIDATE_MS; the anchored half is always fresh.
 * fs spies count the calls; every guarantee has a mutant below that must die at its assertion.
 * HOME and USERPROFILE are jailed and asserted before any product code loads.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-claims-lag-'));
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
const { readSource } = require('./read-source.cjs');
const ROOT = path.join(__dirname, '..');
const real = {
  store: loadTs(path.join(ROOT, 'src/main/claims/store.ts')),
  keys: loadTs(path.join(ROOT, 'src/main/claims/keyProvider.ts')),
};
const { SandboxKeyProvider, FileLedgerKeyRecord, KEY_RECORD_FILE, HEAD_ANCHOR_FILE } = real.keys;
const { sha256Hex } = loadTs(path.join(ROOT, 'src/main/claims/canonical.ts'));

/** Count fs calls by kind and base name while `fn` runs. */
function spy() {
  const counts = {};
  const saved = {};
  for (const k of ['readFileSync', 'statSync', 'readdirSync']) {
    saved[k] = fs[k];
    fs[k] = function (p, ...rest) {
      const key = `${k}:${path.basename(String(p))}`;
      counts[key] = (counts[key] ?? 0) + 1;
      return saved[k].call(this, p, ...rest);
    };
  }
  return { counts, n: (k) => counts[k] ?? 0, stop: () => { for (const k of Object.keys(saved)) fs[k] = saved[k]; } };
}

let seq = 0;
/** A hive + user-data. `later` is a wall clock past the racy window, so a fresh write is proven. */
function setup(mods = real) {
  const root = path.join(JAIL, `hive-${++seq}`);
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  const ud = `${root}-userdata`;
  const file = path.join(ud, HEAD_ANCHOR_FILE);
  const keys = new SandboxKeyProvider();
  const later = () => Date.now() + 10_000;
  const anchorsOf = (wall = later) => new mods.keys.FileHeadAnchorStore(file, wall);
  const anchors = anchorsOf();
  let mono = 0;
  const mk = (extra = {}) => {
    let t = Date.parse('2026-11-12T10:00:00Z');
    const store = new mods.store.ClaimStore({ hiveRoot: root, keys, keyRecord: new FileLedgerKeyRecord(path.join(ud, KEY_RECORD_FILE)), headAnchor: anchors, now: () => new Date(t += 1000), monoNow: () => mono, wallNow: later, ...extra });
    STORES.push(store);
    return store;
  };
  const claimsDir = (a) => path.join(root, 'agents', a, 'memory', 'claims');
  return { root, ud, file, keys, anchors, anchorsOf, mk, claimsDir, tick: (ms) => { mono += ms; } };
}
const note = (text) => ({ t: 'claim', kind: 'fact', text });
async function ok(p) { const r = await p; assert.equal(r.ok, true, JSON.stringify(r)); return r.id; }
async function ledgers(x, agents) {
  const s = x.mk();
  for (const a of agents) await ok(s.appendRecord(a, note(`${a} first`), 'endpoint'));
  s.close();
}

// ------------------------------------------------------------------ guarantees (each a killer)

/** LAG-2a: an unchanged file is parsed once; every call still stats it. */
async function parsedOnce(mods) {
  const x = setup(mods);
  await ledgers(x, ['andy', 'dwight']);
  const a = x.anchorsOf();
  const sp = spy();
  try {
    for (let i = 0; i < 10; i++) { a.get(x.root, 'andy'); a.agents(x.root); }
  } finally { sp.stop(); }
  assert.equal(sp.n(`readFileSync:${HEAD_ANCHOR_FILE}`), 1, 'LAG-2a: 20 reads of an unchanged anchor file parse it once');
  assert.equal(sp.n(`statSync:${HEAD_ANCHOR_FILE}`), 20, 'LAG-2a: every read outside a batch revalidates by stat');
  assert.deepEqual(a.agents(x.root).sort(), ['andy', 'dwight']);
}

/** LAG-2b: another writer's change (tmp + rename, as main and the backfill script write) is read
 *  on the very next call: no time window. */
async function externalWriteSeen(mods) {
  const x = setup(mods);
  await ledgers(x, ['andy']);
  const a = x.anchorsOf();
  const before = a.get(x.root, 'andy');
  x.anchorsOf().set(x.root, 'andy', { head: 'f'.repeat(64), lastId: 'c-000000000001' });
  assert.equal(a.get(x.root, 'andy').head, 'f'.repeat(64), 'LAG-2b: a change by another writer is read on the next call');
  assert.notEqual(before.head, 'f'.repeat(64));
}

/** LAG-2c: a same-size in-place rewrite inside the file's timestamp tick keeps every stat field
 *  but the content; a map read that close to a change is never trusted (statCacheKey racy rule). */
async function racyRewriteSeen(mods) {
  const x = setup(mods);
  await ledgers(x, ['andy']);
  const a = x.anchorsOf(Date.now); // the real wall clock: the racy rule is live
  const text = fs.readFileSync(x.file, 'utf8');
  const head = JSON.parse(text).hives[Object.keys(JSON.parse(text).hives)[0]].andy.head;
  const forged = head.replace(/^./, head[0] === 'a' ? 'b' : 'a');
  fs.writeFileSync(x.file, text);
  // The two writes land in one timestamp tick: the file system reports the same stat for both
  // (Jim, NTFS: 843 of 1999 consecutive writes). Pinned here, so the case is deterministic.
  const statSync = fs.statSync;
  const frozen = statSync(x.file);
  fs.statSync = function (p, ...rest) { return path.resolve(String(p)) === path.resolve(x.file) ? frozen : statSync.call(this, p, ...rest); };
  try {
    assert.equal(a.get(x.root, 'andy').head, head);
    fs.writeFileSync(x.file, text.replace(head, forged)); // same size, in place, same tick
    assert.equal(a.get(x.root, 'andy').head, forged, 'LAG-2c: a racily read map is not trusted on the next call');
  } finally { fs.statSync = statSync; }
}

/** LAG-2d: set() writes what get() then returns, inside a census batch too (checkAnchor advances
 *  an anchor mid-census and reads it again); the cached map is never edited in place. */
async function setDropsCache(mods) {
  const x = setup(mods);
  await ledgers(x, ['andy']);
  const a = x.anchorsOf();
  a.batch(() => {
    a.get(x.root, 'andy');
    a.set(x.root, 'andy', { head: 'e'.repeat(64), lastId: 'c-000000000002' });
    assert.equal(a.get(x.root, 'andy').head, 'e'.repeat(64), 'LAG-2d: get after set (in a batch) returns what was set');
  });
  assert.equal(JSON.parse(fs.readFileSync(x.file, 'utf8')).hives[Object.keys(JSON.parse(fs.readFileSync(x.file, 'utf8')).hives)[0]].andy.head, 'e'.repeat(64));
}

/** LAG-2e: a batch checks the file once; after the batch every call revalidates again. */
async function batchOnce(mods) {
  const x = setup(mods);
  await ledgers(x, ['andy', 'dwight', 'jim']);
  const a = x.anchorsOf();
  const sp = spy();
  try { a.batch(() => { for (let i = 0; i < 5; i++) for (const id of a.agents(x.root)) a.get(x.root, id); }); } finally { sp.stop(); }
  assert.equal(sp.n(`statSync:${HEAD_ANCHOR_FILE}`), 1, 'LAG-2e: a census batch stats the anchor file once');
  x.anchorsOf().set(x.root, 'andy', { head: 'd'.repeat(64), lastId: 'c-000000000003' });
  assert.equal(a.get(x.root, 'andy').head, 'd'.repeat(64), 'LAG-2e: after a batch ends, the next call revalidates');
}

/** LAG-2f (the card's boundary): a stale map never verifies a forged head. Main's map holds an
 *  older head; another writer anchors a newer one; the ledger is cut back to the older head. */
async function staleNeverVerifiesForged(mods) {
  const x = setup(mods);
  const s1 = x.mk();
  for (let i = 0; i < 2; i++) await ok(s1.appendRecord('andy', note(`f${i}`), 'endpoint'));
  s1.close();
  assert.equal(x.mk().readLedger('andy').chain, 'ok'); // main's map now holds the 2-line head
  const other = x.mk({ headAnchor: x.anchorsOf() });
  await ok(other.appendRecord('andy', note('f2'), 'endpoint'));
  other.close();
  const f = path.join(x.claimsDir('andy'), fs.readdirSync(x.claimsDir('andy'))[0]);
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 3);
  fs.writeFileSync(f, lines.slice(0, 2).join('\n') + '\n'); // the forged cut: a valid, shorter chain
  assert.equal(x.anchorsOf().get(x.root, 'andy').head, sha256Hex(lines[2]), 'the file holds the newer anchor');
  assert.deepEqual(x.mk().readLedger('andy').chain, { brokenAt: 'head-anchor', reason: 'prev' }, 'LAG-2f: a stale anchor map verified a cut ledger');
}

/** LAG-2g: checkAnchored reads the anchor file once for its whole census. */
async function censusBatched(mods) {
  const x = setup(mods);
  await ledgers(x, ['andy', 'dwight', 'jim', 'kevin']);
  const s = x.mk();
  const sp = spy();
  let broken;
  try { broken = s.checkAnchored(); } finally { sp.stop(); }
  assert.deepEqual(broken, []);
  assert.equal(sp.n(`statSync:${HEAD_ANCHOR_FILE}`), 1, 'LAG-2g: checkAnchored stats the anchor file once for four agents');
  assert.ok(sp.n(`readFileSync:${HEAD_ANCHOR_FILE}`) <= 1, 'LAG-2g: and parses it at most once');
}

/** LAG-3a: many consumers share one census: agents/ and each claims folder are listed once. */
async function rosterShared(mods) {
  const x = setup(mods);
  await ledgers(x, ['andy', 'dwight', 'jim']);
  fs.mkdirSync(path.join(x.root, 'agents', 'oscar', 'memory'), { recursive: true }); // no ledger
  const s = x.mk();
  const sp = spy();
  let r;
  try { for (let i = 0; i < 6; i++) r = s.ledgerAgents(); } finally { sp.stop(); }
  assert.deepEqual([...r].sort(), ['andy', 'dwight', 'jim']);
  assert.equal(sp.n('readdirSync:agents'), 1, 'LAG-3a: six roster reads list agents/ once');
  assert.equal(sp.n('readdirSync:claims'), 4, 'LAG-3a: and each agent folder\'s claims once');
}

/** LAG-3b: this store's own first append for an agent is in the very next roster. */
async function ownAppendSeen(mods) {
  const x = setup(mods);
  await ledgers(x, ['andy']);
  const s = x.mk();
  assert.deepEqual(s.ledgerAgents(), ['andy']);
  fs.mkdirSync(path.join(x.root, 'agents', 'pam'), { recursive: true });
  assert.deepEqual(s.ledgerAgents(), ['andy']);
  await ok(s.appendRecord('pam', note('pam first'), 'endpoint'));
  // An agent's folder already existed (agents/ unchanged) and no time passed.
  assert.deepEqual([...s.ledgerAgents()].sort(), ['andy', 'pam'], 'LAG-3b: a ledger this store just started is in the next roster');
}

/** LAG-3c: an agent added or archived (agents/ changed) is seen on the next call. */
async function agentsDirChangeSeen(mods) {
  const x = setup(mods);
  await ledgers(x, ['andy', 'dwight']);
  const s = x.mk();
  assert.deepEqual([...s.ledgerAgents()].sort(), ['andy', 'dwight']);
  // Copy dwight's ledger to a new agent folder made by another process, no time passing.
  fs.cpSync(path.join(x.root, 'agents', 'dwight'), path.join(x.root, 'agents', 'stanley'), { recursive: true });
  assert.ok(s.ledgerAgents().includes('stanley'), 'LAG-3c: a new agent folder is listed on the next roster read');
}

/** LAG-3d: a claims folder another process makes under an existing agent is listed within
 *  ROSTER_REVALIDATE_MS. */
async function revalidateBound(mods) {
  const x = setup(mods);
  await ledgers(x, ['andy', 'dwight']);
  fs.mkdirSync(path.join(x.root, 'agents', 'toby'), { recursive: true });
  const s = x.mk();
  assert.deepEqual([...s.ledgerAgents()].sort(), ['andy', 'dwight']);
  fs.cpSync(x.claimsDir('dwight'), x.claimsDir('toby'), { recursive: true });
  x.tick(mods.store.ROSTER_REVALIDATE_MS);
  assert.ok(s.ledgerAgents().includes('toby'), 'LAG-3d: a folder made elsewhere is listed once ROSTER_REVALIDATE_MS passed');
}

/** LAG-3e: the anchored half is fresh on every call (Jim A-2: a deleted ledger still alerts). */
async function anchoredFresh(mods) {
  const x = setup(mods);
  await ledgers(x, ['andy']);
  const s = x.mk();
  assert.deepEqual(s.ledgerAgents(), ['andy']);
  x.anchorsOf().set(x.root, 'meredith', { head: 'c'.repeat(64), lastId: 'c-000000000004' });
  assert.deepEqual([...s.ledgerAgents()].sort(), ['andy', 'meredith'], 'LAG-3e: an anchored agent with no segment is in the next roster');
  fs.rmSync(path.join(x.root, 'agents', 'andy'), { recursive: true });
  assert.ok(s.ledgerAgents().includes('andy'), 'LAG-3e: a deleted ledger stays in the roster through its anchor');
}

const CASES = [
  ['LAG-2a', parsedOnce], ['LAG-2b', externalWriteSeen], ['LAG-2c', racyRewriteSeen], ['LAG-2d', setDropsCache],
  ['LAG-2e', batchOnce], ['LAG-2f', staleNeverVerifiesForged], ['LAG-2g', censusBatched],
  ['LAG-3a', rosterShared], ['LAG-3b', ownAppendSeen], ['LAG-3c', agentsDirChangeSeen], ['LAG-3d', revalidateBound], ['LAG-3e', anchoredFresh],
];
for (const [id, fn] of CASES) test(`${id}: ${fn.name}`, () => fn(real));

test('the app wiring: claimLedgerAgents is the shared census', () => {
  const idx = readSource('src/main/index.ts');
  assert.match(idx, /function claimLedgerAgents\(\): string\[\] \{\r?\n  const root = hive\.root\(\); if \(!root\) return \[\];\r?\n  return \(claimsEndpoint\(\) as ClaimsEndpointDeps\)\.store\.ledgerAgents\(\);\r?\n\}/);
  assert.match(idx, /headAnchor: new FileHeadAnchorStore\(join\(app\.getPath\('userData'\), HEAD_ANCHOR_FILE\)\),/);
});

// ------------------------------------------------------------------ mutant census

const KP = 'src/main/claims/keyProvider.ts';
const ST = 'src/main/claims/store.ts';
const MUTANTS = [
  { id: 'M1', what: 'the cached map is served without a stat check', file: KP, from: 'if (c && this.depth > 0 && this.batchFresh) return c.j;', to: 'if (c) return c.j;', dies: ['LAG-2b', 'LAG-2e', 'LAG-2f'] },
  { id: 'M2', what: 'the stat key comparison is dropped', file: KP, from: 'if (c && c.key !== null && c.key === statKey(st))', to: 'if (c)', dies: ['LAG-2b', 'LAG-2c', 'LAG-2f'] },
  { id: 'M3', what: 'a racily read map is cached under its key', file: KP, from: 'this.cache = { key: provenStatKey(st, this.wall()), j };', to: 'this.cache = { key: statKey(st), j };', dies: ['LAG-2c'] },
  { id: 'M4', what: 'set() keeps the old map', file: KP, from: '    this.cache = null;\n    this.batchFresh = false;\n    const h = (j.hives', to: '    const h = (j.hives', dies: ['LAG-2d'] },
  { id: 'M5', what: 'a snapshot outlives its batch', file: KP, from: 'if (c && this.depth > 0 && this.batchFresh) return c.j;', to: 'if (c && this.batchFresh) return c.j;', dies: ['LAG-2e'] },
  { id: 'M6', what: 'the map is not cached at all (the old parse per call)', file: KP, from: 'this.cache = { key: provenStatKey(st, this.wall()), j };', to: 'this.cache = null;', dies: ['LAG-2a'] },
  { id: 'M7', what: 'checkAnchored reads outside one batch', file: ST, from: 'if (this.d.headAnchor?.batch) this.d.headAnchor.batch(run); else run();\n    return broken;', to: 'run();\n    return broken;', dies: ['LAG-2g'] },
  { id: 'M8', what: 'the roster is listed per call', file: ST, from: "&& mono() - r.at < ROSTER_REVALIDATE_MS) return [...r.agents];", to: "&& false) return [...r.agents];", dies: ['LAG-3a'] },
  { id: 'M9', what: 'an own append does not dirty the roster', file: ST, from: '        this.rosterDirty();\n        h = {', to: '        h = {', dies: ['LAG-3b'] },
  { id: 'M10', what: 'the agents/ stat key is ignored', file: ST, from: 'r.key !== null && r.key === key && mono()', to: 'mono()', dies: ['LAG-3c'] },
  { id: 'M11', what: 'the roster never expires', file: ST, from: "&& mono() - r.at < ROSTER_REVALIDATE_MS) return [...r.agents];", to: ") return [...r.agents];", dies: ['LAG-3d'] },
  { id: 'M12', what: 'the anchored half is dropped from the roster', file: ST, from: 'return [...new Set([...withSegments, ...anchored])];', to: 'return [...new Set([...withSegments])];', dies: ['LAG-3e'] },
];

function mutated(m) {
  const src = readSource(m.file).split('\r\n').join('\n');
  assert.equal(src.split(m.from).length - 1, 1, `${m.id}: the mutant edit applies exactly once`);
  const text = src.split(m.from).join(m.to);
  // The two modules load each other's real siblings; only the mutated file is swapped.
  if (m.file === KP) {
    const keys = loadTs.fromText(KP, text);
    return { keys, store: real.store };
  }
  return { keys: real.keys, store: loadTs.fromText(ST, text) };
}

for (const m of MUTANTS) {
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
  for (const id of ids) assert.ok(killed.has(id), `${id} has a mutant`);
});
