'use strict';
/**
 * CLAIMS-HEAD-ANCHOR: main keeps each agent's ledger head in user-data. A ledger that no longer
 * reaches its anchored head (its folder deleted, a line cut off the end, a restart from '') is a
 * `prev` break at 'head-anchor': read-only, one alert, never repaired. A lagging anchor is fine
 * (it moves up); a first run adopts the head; a restore and the Human's reset re-anchor.
 * HOME and USERPROFILE are jailed and asserted before any product code loads.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-claims-anchor-'));
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
const { ClaimStore } = loadTs(path.join(ROOT, 'src/main/claims/store.ts'));
const { SandboxKeyProvider, FileLedgerKeyRecord, FileHeadAnchorStore, KEY_RECORD_FILE, HEAD_ANCHOR_FILE } = loadTs(path.join(ROOT, 'src/main/claims/keyProvider.ts'));
const { sha256Hex } = loadTs(path.join(ROOT, 'src/main/claims/canonical.ts'));

let n = 0;
function setup() {
  const root = path.join(JAIL, `hive-${++n}`);
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  const ud = `${root}-userdata`;
  const keys = new SandboxKeyProvider();
  const anchors = new FileHeadAnchorStore(path.join(ud, HEAD_ANCHOR_FILE));
  const mk = (extra = {}) => {
    const alerts = [];
    let t = Date.parse('2026-10-03T10:00:00Z');
    const store = new ClaimStore({ hiveRoot: root, keys, keyRecord: new FileLedgerKeyRecord(path.join(ud, KEY_RECORD_FILE)), headAnchor: anchors, now: () => new Date(t += 1000), alert: (r) => alerts.push(r), ...extra });
    STORES.push(store);
    return { store, alerts };
  };
  const claimsDir = (a) => path.join(root, 'agents', a, 'memory', 'claims');
  const lastLine = (a) => { const f = fs.readdirSync(claimsDir(a)).sort().pop(); const ls = fs.readFileSync(path.join(claimsDir(a), f), 'utf8').split('\n').filter(Boolean); return ls[ls.length - 1]; };
  return { root, keys, anchors, mk, claimsDir, lastLine };
}
const note = (text) => ({ t: 'claim', kind: 'fact', text });
async function ok(p) { const r = await p; assert.equal(r.ok, true, JSON.stringify(r)); return r.id; }

test('the anchor follows the head after appends (flushed by close or the timer), in user-data, never in the hive', async () => {
  const x = setup();
  const { store } = x.mk();
  for (let i = 0; i < 3; i++) await ok(store.appendRecord('andy', note(`f${i}`), 'endpoint'));
  store.close();
  assert.equal(x.anchors.get(x.root, 'andy').head, sha256Hex(x.lastLine('andy')));
  const { store: s2 } = x.mk({ anchorDelayMs: 5 });
  await ok(s2.appendRecord('andy', note('f3'), 'endpoint'));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(x.anchors.get(x.root, 'andy').head, sha256Hex(x.lastLine('andy')), 'the timer flushed it');
  assert.ok(!fs.readdirSync(x.root).some((f) => /head/i.test(f)), 'nothing in the hive');
});

test('a deleted ledger folder is detected: prev at head-anchor, read-only, one alert; no restart from empty', async () => {
  const x = setup();
  const { store } = x.mk();
  for (let i = 0; i < 3; i++) await ok(store.appendRecord('andy', note(`f${i}`), 'endpoint'));
  store.close();
  fs.rmSync(path.join(x.root, 'agents', 'andy'), { recursive: true });
  const m = x.mk();
  assert.deepEqual(m.store.readLedger('andy').chain, { brokenAt: 'head-anchor', reason: 'prev' });
  const r = await m.store.appendRecord('andy', note('a fresh start'), 'endpoint');
  assert.equal(r.ok, false); assert.match(r.error, /read-only \(prev at head-anchor\)/);
  assert.equal(fs.existsSync(x.claimsDir('andy')), false, 'nothing was written');
  assert.equal(m.alerts.filter((a) => a.kind === 'claims-chain-broken' && a.brokenAt === 'head-anchor').length, 1);
  // Other agents are unaffected.
  await ok(m.store.appendRecord('dwight', note('fine'), 'endpoint'));
});

test('a cut-off tail (valid chain, shorter) and a ledger restarted from empty are detected', async () => {
  const x = setup();
  const { store } = x.mk();
  for (let i = 0; i < 4; i++) await ok(store.appendRecord('andy', note(`f${i}`), 'endpoint'));
  store.close();
  const f = path.join(x.claimsDir('andy'), fs.readdirSync(x.claimsDir('andy'))[0]);
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(f, lines.slice(0, 2).join('\n') + '\n');
  assert.deepEqual(x.mk().store.readLedger('andy').chain, { brokenAt: 'head-anchor', reason: 'prev' });
  // Restarted: a single valid first line (prev '') from another ledger of the same key.
  const { store: other } = x.mk();
  await ok(other.appendRecord('creed', note('creed first'), 'endpoint'));
  other.close();
  const creedLine = x.lastLine('creed').replace('"agent":"creed"', '"agent":"andy"');
  fs.writeFileSync(f, creedLine + '\n');
  assert.notEqual(x.mk().store.readLedger('andy').chain, 'ok');
});

test('a lagging anchor is fine and moves up; no anchor yet adopts the head', async () => {
  const x = setup();
  const { store } = x.mk({ anchorDelayMs: 10_000 });
  await ok(store.appendRecord('andy', note('f0'), 'endpoint'));
  store.close();
  const anchored = x.anchors.get(x.root, 'andy').head;
  const { store: s2 } = x.mk({ anchorDelayMs: 10_000 });
  await ok(s2.appendRecord('andy', note('f1'), 'endpoint'));
  await ok(s2.appendRecord('andy', note('f2'), 'endpoint'));
  // "crash" before the anchor write: the anchor still names f0's line.
  assert.equal(x.anchors.get(x.root, 'andy').head, anchored);
  const m = x.mk();
  assert.equal(m.store.readLedger('andy').chain, 'ok', 'the chain grew past the anchor');
  m.store.close();
  assert.equal(x.anchors.get(x.root, 'andy').head, sha256Hex(x.lastLine('andy')), 'and the anchor moved up');
  // First run after the upgrade: no anchors at all.
  fs.rmSync(path.join(`${x.root}-userdata`, HEAD_ANCHOR_FILE));
  const f = x.mk();
  assert.equal(f.store.readLedger('andy').chain, 'ok');
  f.store.close();
  assert.equal(x.anchors.get(x.root, 'andy').head, sha256Hex(x.lastLine('andy')));
});

test('a restore re-anchors; the Human reset re-anchors after review; a rekey keeps the anchor in step', async () => {
  const x = setup();
  let t = Date.parse('2026-10-30T09:00:00Z');
  const now = () => new Date(t);
  const { store } = x.mk({ now });
  await ok(store.appendRecord('andy', note('day one'), 'endpoint'));
  t = Date.parse('2026-10-31T09:00:00Z');
  await ok(store.appendRecord('andy', note('day two'), 'endpoint'));
  store.close();
  const r = store.restoreBackup('andy', '2026-10-30');
  assert.equal(r.chain, 'ok', 'the restored (shorter) ledger is the anchored one');
  assert.equal(x.mk().store.readLedger('andy').chain, 'ok');
  // Deleted, reviewed by the Human, reset.
  fs.rmSync(x.claimsDir('andy'), { recursive: true });
  const m = x.mk();
  assert.equal(m.store.readLedger('andy').chain.reason, 'prev');
  assert.equal(m.store.resetAnchor('andy', undefined), false, 'only with the Human confirm');
  assert.equal(m.store.resetAnchor('andy', true), true);
  assert.equal(m.store.readLedger('andy').chain, 'ok');
  await ok(m.store.appendRecord('andy', note('after the reset'), 'endpoint'));
  m.store.close();
  // A rekey writes lines; the anchor follows them.
  x.keys.drop();
  const k = x.mk();
  const rk = await k.store.rekey(true);
  assert.equal(rk.ok, true, JSON.stringify(rk));
  k.store.close();
  assert.equal(x.anchors.get(x.root, 'andy').head, sha256Hex(x.lastLine('andy')));
  assert.equal(x.mk().store.readLedger('andy').chain, 'ok');
});

// — Jim's CLAIMS-HEAD-ANCHOR audit (A-1, A-2, A-3) —

test('Jim A-1: a cut made while the key is lost is still a head-anchor break, and the Human rekey refuses it (no laundering)', async () => {
  const x = setup();
  const { store } = x.mk();
  for (let i = 0; i < 4; i++) await ok(store.appendRecord('a1', note(`f${i}`), 'endpoint'));
  await ok(store.appendRecord('dwight', note('fine'), 'endpoint'));
  store.close();
  const f = path.join(x.claimsDir('a1'), fs.readdirSync(x.claimsDir('a1'))[0]);
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(f, lines.slice(0, 2).join('\n') + '\n');   // a valid, shorter chain
  x.keys.drop();                                               // and the key is lost
  const m = x.mk();
  assert.deepEqual(m.store.readLedger('a1').chain, { brokenAt: 'head-anchor', reason: 'prev' }, 'the cut is seen under key-missing');
  assert.equal(m.store.readLedger('dwight').chain.reason, 'key-missing', 'an uncut ledger stays key-missing');
  // The rekey's own write step re-checks the anchor too (a cut between its read and its write).
  assert.match(String(m.store.prevChainOnly('a1')), /head-anchor/);
  assert.equal(typeof m.store.prevChainOnly('dwight'), 'object');
  const rk = await m.store.rekey(true);
  assert.ok(rk.refused.some((r) => r.agentId === 'a1' && /head-anchor/.test(r.why)), JSON.stringify(rk));
  assert.deepEqual(rk.rekeyed, ['dwight']);
  m.store.close();
  assert.equal(fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length, 2, 'no rekey line on the cut ledger');
  assert.deepEqual(x.mk().store.readLedger('a1').chain, { brokenAt: 'head-anchor', reason: 'prev' }, 'still the anchor break after the rekey');
  assert.equal(x.mk().store.readLedger('dwight').chain, 'ok');
  // Only the Human's explicit reset (after review) accepts the cut.
  const h = x.mk();
  assert.equal(h.store.resetAnchor('a1', true), true);
  assert.notEqual(h.store.readLedger('a1').chain.brokenAt, 'head-anchor');
});

test('Jim A-1: an edited last line (with the key) is still reported as mac at its id, not as an anchor break', async () => {
  const x = setup();
  const { store } = x.mk();
  for (let i = 0; i < 2; i++) await ok(store.appendRecord('a1', note(`orig${i}`), 'endpoint'));
  store.close();
  const f = path.join(x.claimsDir('a1'), fs.readdirSync(x.claimsDir('a1'))[0]);
  const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
  const id = JSON.parse(lines[1]).id;
  lines[1] = lines[1].replace('orig1', 'edit1');
  fs.writeFileSync(f, lines.join('\n') + '\n');
  assert.deepEqual(x.mk().store.readLedger('a1').chain, { brokenAt: id, reason: 'mac' });
});

test('Jim A-1: under key-missing the anchor never moves up (unverified lines are not anchored)', async () => {
  const x = setup();
  const { store } = x.mk();
  await ok(store.appendRecord('a1', note('f0'), 'endpoint'));
  store.close();
  const before = x.anchors.get(x.root, 'a1').head;
  // An appended line the old key would have signed, but now nothing verifies it.
  const { store: s2 } = x.mk({ anchorDelayMs: 10_000 });
  await ok(s2.appendRecord('a1', note('f1'), 'endpoint'));
  s2.anchorTimers?.clear?.();
  x.keys.drop();
  const m = x.mk();
  assert.equal(m.store.readLedger('a1').chain.reason, 'key-missing');
  m.store.close();
  assert.equal(x.anchors.get(x.root, 'a1').head, before);
});

test('Jim A-2: a deleted ledger alerts at claims start with no append and no read of that agent; every anchored agent is checked', async () => {
  const x = setup();
  const { store } = x.mk();
  for (let i = 0; i < 2; i++) await ok(store.appendRecord('a2', note(`f${i}`), 'endpoint'));
  await ok(store.appendRecord('andy', note('fine'), 'endpoint'));
  store.close();
  fs.rmSync(path.join(x.root, 'agents', 'a2'), { recursive: true });
  const m = x.mk();
  assert.deepEqual(m.store.anchoredAgents(), ['a2', 'andy']);
  assert.deepEqual(m.store.checkAnchored(), ['a2']);
  assert.deepEqual(m.store.checkAnchored(), ['a2'], 'the periodic check finds it again');
  const broken = m.alerts.filter((a) => a.kind === 'claims-chain-broken');
  assert.equal(broken.length, 1, 'one alert'); assert.equal(broken[0].agentId, 'a2'); assert.equal(broken[0].brokenAt, 'head-anchor');
});

test('Jim A-2: W3 discovery keeps an anchored agent flagged with no segment left: its markdown stays out of search', () => {
  const { discoverSources } = loadTs(path.join(ROOT, 'src/main/nativeMemory/sources.ts'));
  const root = path.join(JAIL, `disc-${++n}`);
  fs.mkdirSync(path.join(root, 'agents', 'a2'), { recursive: true });
  for (const f of ['memory.md', 'memory-archive-2026-09.md', 'notes.md']) fs.writeFileSync(path.join(root, 'agents', 'a2', f), 'x');
  const opts = { claimLedger: 'reader', implemented: 'writer' };
  const plain = discoverSources(root, undefined, opts).eligible.map((e) => e.path);
  assert.ok(plain.includes('agents/a2/memory.md'), 'no ledger, no anchor: the markdown is a source');
  const anchored = discoverSources(root, undefined, { ...opts, anchored: ['a2'] }).eligible;
  assert.deepEqual(anchored.filter((e) => /memory(-archive-.*)?\.md$/.test(e.path)), [], 'anchored: memory.md and the archive stay out');
  assert.ok(anchored.some((e) => e.kind === 'claims' && e.wing === 'a2'), 'and it is still a claims source');
  assert.ok(anchored.some((e) => e.path === 'agents/a2/notes.md'), 'other files untouched');
  const shadow = discoverSources(root, undefined, { claimLedger: 'shadow', implemented: 'writer', anchored: ['a2'] }).eligible.map((e) => e.path);
  assert.ok(shadow.includes('agents/a2/memory.md'), 'at shadow the anchor changes nothing');
});

test('Jim A-3: anchors are keyed by hive: two hives in one user-data with the same agent id never read each other', async () => {
  const ud = path.join(JAIL, `shared-ud-${++n}`);
  const anchors = new FileHeadAnchorStore(path.join(ud, HEAD_ANCHOR_FILE));
  const keys = new SandboxKeyProvider();
  const mk = (root) => { fs.mkdirSync(path.join(root, 'agents'), { recursive: true }); const alerts = []; const s = new ClaimStore({ hiveRoot: root, keys, keyRecord: new FileLedgerKeyRecord(path.join(ud, KEY_RECORD_FILE)), headAnchor: anchors, alert: (r) => alerts.push(r) }); STORES.push(s); return { s, alerts }; };
  const A = path.join(JAIL, `hiveA-${n}`); const B = path.join(JAIL, `hiveB-${n}`);
  const a = mk(A); const b = mk(B);
  for (let i = 0; i < 3; i++) await ok(a.s.appendRecord('andy', note(`a${i}`), 'endpoint'));
  await ok(b.s.appendRecord('andy', note('b0'), 'endpoint'));
  a.s.close(); b.s.close();
  assert.notEqual(anchors.get(A, 'andy').head, anchors.get(B, 'andy').head);
  const a2 = mk(A); const b2 = mk(B);
  assert.equal(a2.s.readLedger('andy').chain, 'ok');
  assert.equal(b2.s.readLedger('andy').chain, 'ok');
  assert.deepEqual([...a2.alerts, ...b2.alerts], []);
  assert.deepEqual(anchors.agents(A), ['andy']);
  assert.equal(anchors.get(path.join(JAIL, 'hiveC'), 'andy'), null);
});

test('Jim A-3: the app wiring pins: the anchor file in user-data, the anchored agents to the worker and the index sync, the checks at start, worker start and periodically', () => {
  assert.equal(HEAD_ANCHOR_FILE, 'claims-heads.json');
  const idx = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.ts'), 'utf8');
  assert.match(idx, /headAnchor: new FileHeadAnchorStore\(join\(app\.getPath\('userData'\), HEAD_ANCHOR_FILE\)\),/, 'in user-data, beside the key record');
  assert.match(idx, /anchoredAgents: \(\) => claimsEndpoint\(\)\?\.store\.anchoredAgents\(\) \?\? \[\],/, 'the worker is told the anchored agents');
  assert.match(idx, /return \[\.\.\.new Set\(\[\.\.\.withSegments, \.\.\.store\.anchoredAgents\(\)\]\)\];/, 'the index sync covers anchored agents');
  assert.match(idx, /onWorkerReady: \(\) => \{ claimsAnchorCheck\(\); void claimsIndexSync\(\)\?\.syncAll\(\); \}/, 'a worker (re)start checks');
  assert.match(idx, /setImmediate\(claimsAnchorCheck\);/, 'claims start checks');
  assert.match(idx, /setInterval\(claimsAnchorCheck, CLAIMS_ANCHOR_CHECK_MS\)\.unref\?\.\(\);/, 'and periodically');
  assert.match(idx, /try \{ claimsEndpoint\(\)\?\.store\.checkAnchored\(\); \}/);
});

test('Jim should (re-audit): a cut or deleted ledger sends NOTHING to the index (never []), so its claims stay and its markdown stays out', async () => {
  const { ClaimsIndexSync } = loadTs(path.join(ROOT, 'src/main/claims/indexSync.ts'));
  const x = setup();
  const { store } = x.mk();
  for (let i = 0; i < 4; i++) await ok(store.appendRecord('a1', note(`f${i}`), 'endpoint'));
  for (let i = 0; i < 2; i++) await ok(store.appendRecord('a2', note(`g${i}`), 'endpoint'));
  await ok(store.appendRecord('dwight', note('fine'), 'endpoint'));
  store.close();
  const f = path.join(x.claimsDir('a1'), fs.readdirSync(x.claimsDir('a1'))[0]);
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).slice(0, 2).join('\n') + '\n');   // cut: 2 valid records left
  fs.rmSync(path.join(x.root, 'agents', 'a2'), { recursive: true });                                             // deleted
  const m = x.mk();
  const sent = []; const logs = [];
  const sync = new ClaimsIndexSync({
    readLedger: (a) => m.store.readLedger(a),
    derive: () => (records) => ({ v: 1, agent: 'x', registryHash: '', ledgerHead: 'h', conflicts: [], claims: Object.fromEntries(records.filter((r) => r.t === 'claim').map((r) => [r.id, { id: r.id, status: 'live', sightings: 0, firstAt: '', lastAt: '', pinned: false, reasons: [] }])) }),
    registry: () => ({ v: 1, namespaces: [], keys: {} }), ruleConfig: () => ({ r4: false }), level: () => 'reader',
    agents: () => [...new Set([...['a1', 'dwight'], ...m.store.anchoredAgents()])],   // as index.ts: segments plus anchored
    send: async (args) => { sent.push(args); return { ok: true }; }, log: (r) => logs.push(r),
  });
  const out = await sync.syncAll();
  assert.deepEqual(sent.map((s) => s.wing), ['dwight'], 'only the intact ledger is sent');
  assert.deepEqual(out.filter((o) => !o.sent).map((o) => o.why), ['head-anchor', 'head-anchor']);
  assert.deepEqual(logs.filter((l) => l.kind === 'claims-index-skipped').map((l) => [l.agentId, l.why]).sort(), [['a1', 'head-anchor'], ['a2', 'head-anchor']]);
});
