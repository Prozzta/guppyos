'use strict';
require('./tools/own-job.cjs');
/**
 * CL-M4-FORWARD-PATH (Jim's CL-M4 calibration, section 4): consolidate at write time.
 *   - a bare --separate with candidates present returns the offer; --separate names the ids it keeps apart;
 *   - a live own claim with the note's --key is offered first, marked 'same key' (an offer, never a supersede);
 *   - the own pool is the whole ledger (no 6 h window), top 5, plus same-card claims;
 *   - claims-note-choice rows carry counts/flags (never text) to measure the replace share of new writes.
 * All texts and ids are invented.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-claims-fwd-'));
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
const C = loadTs(path.join(ROOT, 'src/main/claims/candidates.ts'));
const { ClaimStore } = loadTs(path.join(ROOT, 'src/main/claims/store.ts'));
const { SandboxKeyProvider, FileLedgerKeyRecord, KEY_RECORD_FILE } = loadTs(path.join(ROOT, 'src/main/claims/keyProvider.ts'));
const { handleClaimVerb } = loadTs(path.join(ROOT, 'src/main/claims/endpoint.ts'));
const { verifiedPrefix } = loadTs(path.join(ROOT, 'src/main/claims/indexSync.ts'));
const { derive } = loadTs(path.join(ROOT, 'src/main/claims/derive.ts'));
const { DEFAULT_KEY_REGISTRY } = loadTs(path.join(ROOT, 'src/main/claims/registry.ts'));
const { summarizeWriteHabit } = loadTs(path.join(ROOT, 'src/main/claims/writeHabit.ts'));
const cli = require(path.join(ROOT, 'resources/memory-cli.cjs'));

const H = 3600_000;
const T0 = Date.parse('2026-10-16T12:00:00.000Z');
const id = (n) => `c-${String(n).padStart(12, '0')}`;
const claim = (n, o = {}) => ({ id: id(n), owner: 'a1', wt: new Date(T0 - n * H).toISOString(), text: `invented note ${n}`, status: 'live', ...o });

test('cardIds: upper-case hyphenated tokens, a trailing build number dropped, the key read too', () => {
  assert.deepEqual(C.cardIds('Built CL-M4-FORWARD-PATH; then TES-BUBBLE-NITS-189 and v1.1.89 (UTF-16)'), ['CL-M4-FORWARD-PATH', 'TES-BUBBLE-NITS']);
  assert.deepEqual(C.cardIds('no card here', 'card.heavy-lock-shapes-189'), ['HEAVY-LOCK-SHAPES']);
  assert.deepEqual(C.cardIds('lower-case-words and c-0a1b2c3d4e5f'), []);
});

test('collect: the whole own ledger (no 6 h window), top 5, same key first, same-card extras after', async () => {
  const at = new Date(T0);
  const own = [
    claim(1, { text: 'zebra cache warm path' }),
    claim(2, { text: 'zebra cache cold path' }),
    claim(3, { text: 'zebra cache budget' }),
    claim(4, { text: 'zebra cache owner' }),
    claim(5, { text: 'zebra cache size' }),
    claim(6, { text: 'zebra cache eviction' }),
    // 9 days old: out of a 6 h window, in the forward pool. Its key matches; it ranks last by score.
    claim(216, { key: 'card.INVENTED-CARD', text: 'the invented release ships Friday' }),
    // Same key but superseded: never offered.
    claim(300, { key: 'card.INVENTED-CARD', text: 'the invented release ships Monday', status: 'superseded' }),
    // Same card in the text, outside the fused top: listed after it, newest first, at most CARD_EXTRA.
    claim(20, { text: 'INVENTED-CARD-189 step one done' }),
    claim(21, { text: 'INVENTED-CARD step two done' }),
    claim(22, { text: 'INVENTED-CARD step three done' }),
    claim(23, { text: 'INVENTED-CARD step four done' }),
    claim(24, { text: 'OTHER-CARD unrelated' }),
  ];
  // id(23), the OLDEST same-card claim, scores 7th: same-card extras still go newest first.
  const score = (q, pool) => ({ lexical: [id(1), id(2), id(3), id(4), id(5), id(6), id(23)].filter((x) => pool.some((c) => c.id === x)), vector: [] });
  const deps = { ownClaims: () => own, resolve: () => [], score };
  const r = await C.collectNoteCandidates(deps, 'a1', 'zebra cache moved; INVENTED-CARD shipped', at, { key: 'card.INVENTED-CARD' });
  assert.deepEqual(r.candidates.map((c) => [c.id, c.why ?? null, c.rank]), [
    [id(216), 'same key', 1],
    [id(1), null, 2], [id(2), null, 3], [id(3), null, 4], [id(4), null, 5], [id(5), null, 6],
    [id(20), 'same card', 7], [id(21), 'same card', 8], [id(22), 'same card', 9],
  ]);
  assert.equal(r.pool, own.length - 1, 'the whole ledger, the superseded claim out');
  assert.equal(r.candidates.every((c) => c.replaceable && c.owner === 'a1'), true);
  // No key: no same-key slot; the key claim takes its fused place (it scored nothing, so it is not in the top 5).
  const r2 = await C.collectNoteCandidates(deps, 'a1', 'zebra cache moved', at);
  assert.deepEqual(r2.candidates.map((c) => c.id), [id(1), id(2), id(3), id(4), id(5)]);
  assert.equal(r2.candidates.some((c) => c.why), false, 'no card in the note: no extras');
  // A same-key claim the fusion ranks first is listed once, as same key.
  const r3 = await C.collectNoteCandidates({ ...deps, score: () => ({ lexical: [id(216), id(1)], vector: [] }) }, 'a1', 'x', at, { key: 'card.INVENTED-CARD', cardExtra: 0 });
  assert.deepEqual(r3.candidates.slice(0, 2).map((c) => [c.id, c.why ?? null]), [[id(216), 'same key'], [id(1), null]]);
  assert.equal(new Set(r3.candidates.map((c) => c.id)).size, r3.candidates.length, 'never listed twice');
  // A 6 h window can still be asked for: the 9-day-old same-key claim is then out.
  const r4 = await C.collectNoteCandidates(deps, 'a1', 'x', at, { key: 'card.INVENTED-CARD', windowMs: 6 * H });
  assert.equal(r4.candidates.some((c) => c.id === id(216)), false);
  // Another agent's same-key claim is never a candidate.
  const r5 = await C.collectNoteCandidates({ ...deps, ownClaims: () => [claim(216, { key: 'k', owner: 'b9' })] }, 'a1', 'x', at, { key: 'k' });
  assert.deepEqual(r5.candidates, []);
});

test('makeLocalScorer: claim vectors are cached by text across notes; the query is embedded every time', async () => {
  const calls = [];
  const embed = async (texts) => { calls.push(texts.slice()); return texts.map((t) => [t.length, 1]); };
  const s = C.makeLocalScorer(embed, undefined, 2);
  const pool = [claim(1), claim(2)];
  await s('first query', pool);
  await s('second query', pool);
  await s('third query', [...pool, claim(3)]);
  assert.deepEqual(calls, [['first query', 'invented note 1', 'invented note 2'], ['second query'], ['third query', 'invented note 3']]);
  const out = await s('q', pool);
  assert.deepEqual(out.vector.length, 2);
});

test('S1: a warmed whole pool uses the full vector order; cold remains bounded', async () => {
  const calls = [];
  const embed = async (texts) => { calls.push(texts.slice()); return texts.map((t) => [t === 'query' ? 1 : Number(t.slice(6)), 1]); };
  const s = C.makeLocalScorer(embed, undefined, 5000);
  const pool = Array.from({ length: 110 }, (_, i) => claim(i + 1, { text: `claim-${i + 1}` }));
  const cold = await s('query', pool);
  assert.ok(cold.vector.length < pool.length, 'cold notes use vectorPool');
  await s.warm(pool);
  const warm = await s('query', pool);
  assert.equal(warm.vector.length, pool.length, 'a warmed whole pool gets whole-pool cosine');
  assert.deepEqual(warm.vector, C.cosineOrder([1, 1], pool.map((c) => ({ id: c.id, vec: [Number(c.text.slice(6)), 1] }))));
  pool.push(claim(111, { text: 'claim-111' }));
  const steady = await s('query', pool);
  assert.equal(steady.vector.length, pool.length, 'one just-written uncached claim preserves the warmed whole-pool path');
  assert.ok(calls.length >= 3);
});

test('S1 wiring: startup warms the live ledger only, after native prewarm', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.ts'), 'utf8');
  assert.match(src, /nativeMemory\.prewarm\(\);[^\n]*warmClaimCandidateVectors\(\)/, 'candidate warm follows native prewarm');
  assert.match(src, /view\.claims\.filter\(\(c\) => view\.status\(c\.id\) === 'live'\)/, 'only live claims enter startup warm pool');
});

test('S1: an over-cap warm warns once that complete whole-pool caching is impossible', async () => {
  const s = C.makeLocalScorer(async (texts) => texts.map(() => [1, 1]), undefined, 2);
  const warnings = [];
  const warn = console.warn;
  console.warn = (message) => warnings.push(message);
  try {
    const pool = [claim(1), claim(2), claim(3)];
    await s.warm(pool);
    await s.warm(pool);
  } finally { console.warn = warn; }
  assert.deepEqual(warnings, ['[claims] candidate vector warm pool 3 exceeds cache cap 2; new notes use the bounded cold path until the uncached tail is small']);
});

// ---------------------------------------------------------------- the note verb, end to end

let hiveN = 0;
function mkStore() {
  const root = path.join(JAIL, `hive-${++hiveN}`);
  fs.mkdirSync(path.join(root, 'agents'), { recursive: true });
  let t = T0 - 30 * 24 * H;
  const now = () => { t += 60_000; return new Date(t); };
  const store = new ClaimStore({ hiveRoot: root, keys: new SandboxKeyProvider(), keyRecord: new FileLedgerKeyRecord(path.join(`${root}-userdata`, KEY_RECORD_FILE)), now, log: () => {}, alert: () => {} });
  STORES.push(store);
  return store;
}
/** The product wiring of index.ts (claimsLedgerView, claimNoteCandidates, validateSupersedes, the log row). */
function wire(store, rows, scoreFn) {
  const view = (agentId) => {
    const prefix = verifiedPrefix(store.readLedger(agentId));
    if (!prefix) return null;
    const state = derive(prefix.records, DEFAULT_KEY_REGISTRY, { r4: false });
    return { claims: prefix.records.filter((r) => r.t === 'claim'), status: (x) => state.claims[x]?.status };
  };
  const score = scoreFn ?? C.makeLocalScorer(async (texts) => texts.map((x) => [x.includes('release') ? 1 : 0, x.includes('cache') ? 1 : 0, 0.1]));
  return {
    store, level: () => 'writer',
    noteCandidates: (agentId, text, o = {}) => C.collectNoteCandidates(C.ledgerCandidateDeps({ ledger: view, score }), agentId, text, new Date(T0 + H), o.key !== undefined ? { key: o.key } : {}),
    validateSupersedes: (agentId, ids) => { const v = view(agentId); return !!v && ids.length > 0 && new Set(ids).size === ids.length && ids.every((x) => v.claims.some((c) => c.id === x) && v.status(x) === 'live'); },
    onNoteChoice: (agentId, choice, ids, detail) => rows.push({ kind: 'claims-note-choice', agentId, choice, targets: ids.slice(0, 10), ...(detail ?? {}) }),
    liveByKey: (agentId, key) => { const v = view(agentId); return v ? v.claims.filter((c) => c.key === key && v.status(c.id) === 'live').sort((x, y) => Date.parse(y.wt) - Date.parse(x.wt)).map((c) => c.id) : []; },
    view,
  };
}
const ok = async (p) => { const r = await p; assert.equal(r.ok, true, JSON.stringify(r)); return r.id; };
const recs = (store, a = 'andy') => store.readLedger(a).records.filter((r) => r.t === 'claim');

test('note: a bare --separate returns the offer; --separate must name own live ids; nothing is superseded automatically', async () => {
  const store = mkStore();
  const rows = [];
  const d = wire(store, rows);
  const old = await ok(store.appendRecord('andy', { t: 'claim', kind: 'fact', key: 'card.rel-189', text: 'the release ships Friday' }, 'endpoint'));
  const other = await ok(store.appendRecord('andy', { t: 'claim', kind: 'fact', text: 'the cache is warm' }, 'endpoint'));
  const jims = await ok(store.appendRecord('jim', { t: 'claim', kind: 'fact', text: 'jim: the release ships Friday' }, 'endpoint'));
  const before = recs(store).length;

  // 1. Bare --separate with candidates present: the offer comes back, nothing is written.
  let r = await handleClaimVerb(d, 'andy', { cmd: 'note', args: { text: 'the release ships Monday', key: 'card.rel-189', separate: true } }, 'endpoint');
  assert.equal(r.json.choice, 'choose');
  assert.match(r.text, /^A bare --separate does not skip this offer: name the claims you keep apart, --separate ID\[,ID\]\./);
  assert.equal(r.json.candidates[0].id, old); assert.equal(r.json.candidates[0].why, 'same key');
  assert.match(r.text, new RegExp(`  ${old}  \\S+  \\[same key\\] card\\.rel-189 — the release ships Friday`));
  assert.match(r.text, /--supersedes ID --reason changed\|corrected\|moved/);
  assert.equal(recs(store).length, before, 'the offer never appends');
  assert.deepEqual(rows.at(-1), { kind: 'claims-note-choice', agentId: 'andy', choice: 'offered', targets: [old, other], origin: 'endpoint', shown: 2, sameKey: 1, sameCard: 0, keyed: true, bareSeparate: true });

  // 2. --separate naming something that is not an own live claim: refused, nothing written.
  for (const bad of [jims, 'c-ffffffffffff', `${old},${old}`]) {
    r = await handleClaimVerb(d, 'andy', { cmd: 'note', args: { text: 'the release ships Monday', separate: bad } }, 'endpoint');
    assert.equal(r.exit, 2, bad); assert.equal(recs(store).length, before);
  }
  for (const bad of ['', ' , ', 7, ['c-1', 3], 'not an id!']) {
    r = await handleClaimVerb(d, 'andy', { cmd: 'note', args: { text: 'x', separate: bad } }, 'endpoint');
    assert.equal(r.exit, 2, JSON.stringify(bad)); assert.match(r.error, /^--separate names the claim ids it keeps apart/, JSON.stringify(bad));
  }
  r = await handleClaimVerb(d, 'andy', { cmd: 'note', args: { text: 'x', separate: old, supersedes: [old], reason: 'changed' } }, 'endpoint');
  assert.equal(r.exit, 2);
  r = await handleClaimVerb(d, 'andy', { cmd: 'note', args: { text: 'x', separate: old, cancel: true } }, 'endpoint');
  assert.equal(r.exit, 2);

  // 3. --separate naming the same-key claim: written; the same-key claim stays LIVE (an offer, never a supersede).
  r = await handleClaimVerb(d, 'andy', { cmd: 'note', args: { text: 'the release notes ship Monday', key: 'card.rel-189', separate: old } }, 'endpoint');
  assert.equal(r.ok, true); assert.equal(r.json.choice, 'separate');
  const kept = r.json.id;
  assert.equal(recs(store).length, before + 1);
  assert.equal(recs(store).at(-1).supersedes, undefined, 'separate never supersedes');
  assert.equal(d.view('andy').status(old), 'live');
  assert.deepEqual(rows.at(-1), { kind: 'claims-note-choice', agentId: 'andy', choice: 'separate', targets: [old], origin: 'endpoint', shown: 2, sameKey: 1, sameCard: 0, keyed: true, inOffer: 1 });

  // 4. A same-key note with no choice is an offer, never a write: both same-key claims come first.
  r = await handleClaimVerb(d, 'andy', { cmd: 'note', args: { text: 'the release ships Tuesday', key: 'card.rel-189' } }, 'endpoint');
  assert.equal(r.json.choice, 'choose');
  assert.deepEqual(r.json.candidates.filter((c) => c.why === 'same key').map((c) => c.id), [kept, old], 'newest first');
  assert.equal(d.view('andy').status(old), 'live'); assert.equal(d.view('andy').status(kept), 'live');

  // 5. Replace: logged with inOffer and sameKeyChosen.
  r = await handleClaimVerb(d, 'andy', { cmd: 'note', args: { text: 'the release ships Tuesday', key: 'card.rel-189', supersedes: [old], reason: 'changed' } }, 'endpoint');
  assert.equal(r.ok, true);
  assert.equal(d.view('andy').status(old), 'superseded');
  assert.deepEqual(rows.at(-1), { kind: 'claims-note-choice', agentId: 'andy', choice: 'replace', targets: [old], origin: 'endpoint', shown: 3, sameKey: 2, sameCard: 0, keyed: true, inOffer: 1, sameKeyChosen: true });

  // 6. No log row carries note text.
  const logged = JSON.stringify(rows);
  for (const t of ['ships', 'release notes', 'cache']) assert.equal(logged.includes(t), false, t);
});

test('note: no candidates writes new (bare --separate too); the ledger command logs unoffered', async () => {
  const store = mkStore();
  const rows = [];
  const d = wire(store, rows);
  let r = await handleClaimVerb(d, 'andy', { cmd: 'note', args: { text: 'a first fact', separate: true } }, 'endpoint');
  assert.equal(r.ok, true); assert.equal(recs(store).length, 1);
  assert.deepEqual(rows.at(-1), { kind: 'claims-note-choice', agentId: 'andy', choice: 'new', targets: [], origin: 'endpoint', shown: 0, sameKey: 0, sameCard: 0, keyed: false });
  r = await handleClaimVerb(d, 'andy', { cmd: 'note', args: { text: 'via the ledger command' } }, 'ledger-route');
  assert.equal(r.ok, true); assert.equal(recs(store).length, 2);
  assert.deepEqual(rows.at(-1), { kind: 'claims-note-choice', agentId: 'andy', choice: 'unoffered', targets: [], origin: 'ledger-route', shown: 0, sameKey: 0, sameCard: 0, keyed: false });
  r = await handleClaimVerb(d, 'andy', { cmd: 'note', args: { text: 'x', key: 5 } }, 'endpoint');
  assert.equal(r.exit, 2); assert.match(r.error, /--key/);
  // Cancel is logged with its detail.
  r = await handleClaimVerb(d, 'andy', { cmd: 'note', args: { text: 'x', key: 'k', cancel: true } }, 'endpoint');
  assert.deepEqual(rows.at(-1), { kind: 'claims-note-choice', agentId: 'andy', choice: 'cancel', targets: [], origin: 'endpoint', shown: 0, sameKey: 0, sameCard: 0, keyed: true });
});

test('memory CLI: --separate takes the ids it keeps apart; bare stays bare; text is never eaten', () => {
  assert.deepEqual(cli.parseArgs(['note', '--separate', 'c-0a1b2c3d4e5f,c-111111111111', 'both', 'stay']).args, { separate: 'c-0a1b2c3d4e5f,c-111111111111', text: 'both stay' });
  assert.deepEqual(cli.parseArgs(['note', '--separate=c-0a1b2c3d4e5f', 'x']).args, { separate: 'c-0a1b2c3d4e5f', text: 'x' });
  assert.deepEqual(cli.parseArgs(['note', '--separate', 'cache moved']).args, { separate: true, text: 'cache moved' });
  assert.deepEqual(cli.parseArgs(['note', 'cache', '--separate']).args, { separate: true, text: 'cache' });
  assert.deepEqual(cli.parseArgs(['note', '--cancel', 'x']).args, { cancel: true, text: 'x' });
});

test('W8: the replace share of new writes, unoffered notes, bare separates and same-key replaces', () => {
  const rows = [
    { kind: 'claims-note-choice', choice: 'offered', targets: ['c-a'], sameKey: 1, bareSeparate: true },
    { kind: 'claims-note-choice', choice: 'offered', targets: ['c-a'], sameKey: 1 },
    { kind: 'claims-note-choice', choice: 'replace', targets: ['c-a'], sameKeyChosen: true },
    { kind: 'claims-note-choice', choice: 'offered', targets: ['c-b'], sameKey: 0 },
    { kind: 'claims-note-choice', choice: 'separate', targets: ['c-b'] },
    { kind: 'claims-note-choice', choice: 'new', targets: [] },
    { kind: 'claims-note-choice', choice: 'unoffered', targets: [] },
  ];
  const s = summarizeWriteHabit(rows);
  assert.deepEqual([s.offered, s.bareSeparate, s.offeredSameKey, s.replace, s.replaceSameKey, s.unoffered, s.writes, s.replaceOfWrites], [3, 1, 2, 1, 1, 1, 4, 1 / 4]);
  assert.equal(summarizeWriteHabit([]).replaceOfWrites, null);
});

test('registry: card.<id> keys are multi (no rule supersede), never refused as near misses; old registries gain card.*', () => {
  const R = loadTs(path.join(ROOT, 'src/main/claims/registry.ts'));
  const reg = structuredClone(R.DEFAULT_KEY_REGISTRY);
  assert.deepEqual(R.checkKey(reg, 'card.cl-w7', 'andy', '2026-10-16T00:00:00Z'), { ok: true, cardinality: 'multi', added: true });
  assert.deepEqual(R.checkKey(reg, 'card.cl-w8', 'andy', '2026-10-16T00:00:00Z'), { ok: true, cardinality: 'multi', added: true }, 'a sibling card is not a typo');
  // Other namespaces keep the near-miss guard.
  assert.equal(R.checkKey(reg, 'release.current', 'andy', '2026-10-16T00:00:00Z').ok, true);
  assert.equal(R.checkKey(reg, 'release.curent', 'andy', '2026-10-16T00:00:00Z').didYouMean, 'release.current');
  const root = path.join(JAIL, 'reg-old');
  fs.mkdirSync(root, { recursive: true });
  const old = { v: 1, namespaces: R.DEFAULT_KEY_REGISTRY.namespaces.filter((n) => n.pattern !== 'card.*'), keys: { 'release.current': { cardinality: 'single', addedAt: 'x', addedBy: 'andy' } } };
  fs.writeFileSync(R.registryPath(root), JSON.stringify(old));
  const loaded = R.loadRegistry(root);
  assert.deepEqual(loaded.namespaces.at(-1), { pattern: 'card.*', cardinality: 'multi' });
  // A branch no card owns keeps its merge claim under branch.<name> (single); old registries gain it.
  assert.deepEqual(R.checkKey(reg, 'branch.lone-branch', 'derived', '2026-10-16T00:00:00Z'), { ok: true, cardinality: 'single', added: true });
  const noBranch = { v: 1, namespaces: R.DEFAULT_KEY_REGISTRY.namespaces.filter((n) => n.pattern !== 'branch.*'), keys: {} };
  fs.writeFileSync(R.registryPath(root), JSON.stringify(noBranch));
  assert.ok(R.loadRegistry(root).namespaces.some((n) => n.pattern === 'branch.*' && n.cardinality === 'single'), 'old registries gain branch.*');
  assert.deepEqual(loaded.keys, old.keys);
  // Two notes on one card key both stay live under derive (R2 is single-only).
  const recsIn = [
    { t: 'claim', id: 'c-000000000001', agent: 'andy', kind: 'fact', key: 'card.cl-w7', text: 'a', source: 'self', at: '2026-10-16T00:00:00Z', wt: '2026-10-16T00:00:00Z', prev: '', mac: 'm1' },
    { t: 'claim', id: 'c-000000000002', agent: 'andy', kind: 'fact', key: 'card.cl-w7', text: 'b', source: 'self', at: '2026-10-16T01:00:00Z', wt: '2026-10-16T01:00:00Z', prev: 'm1', mac: 'm2' },
  ];
  const st = derive(recsIn, reg, { r4: false });
  assert.deepEqual([st.claims['c-000000000001'].status, st.claims['c-000000000002'].status], ['live', 'live']);
  const single = derive(recsIn.map((r) => ({ ...r, key: 'release.current' })), reg, { r4: false });
  assert.equal(single.claims['c-000000000001'].status, 'superseded', 'control: a single key does supersede by rule');
});

// ---------------------------------------------------------------- Jim's audit of bbdcfd9c: S1-S3, nits 1, 2, 5

test('S1: only a bounded set gets a vector (BM25 top, newest, same key / card); a cold 1,390-claim ledger embeds about 100 texts', async () => {
  const pool = Array.from({ length: 1390 }, (_, i) => claim(i + 1, { text: `zebra invented note ${i + 1}` }));
  const lexical = pool.map((c) => c.id).reverse();   // BM25 likes the oldest best here
  const focus = new Set([id(700), id(9999)]);
  const vp = C.vectorPool(pool, lexical, focus);
  const ids = new Set(vp.map((c) => c.id));
  assert.equal(vp.length, C.VECTOR_LEXICAL + C.VECTOR_RECENT + 1);
  for (const x of lexical.slice(0, C.VECTOR_LEXICAL)) assert.ok(ids.has(x), 'the BM25 top');
  for (let n = 1; n <= C.VECTOR_RECENT; n++) assert.ok(ids.has(id(n)), 'the newest');
  assert.ok(ids.has(id(700)), 'a focus claim'); assert.ok(!ids.has(id(9999)), 'a focus id outside the pool is ignored');
  assert.deepEqual(vp.map((c) => c.id), pool.filter((c) => ids.has(c.id)).map((c) => c.id), 'pool order kept');
  // The live scorer: the cold first note embeds the query plus that set, not the ledger.
  const sizes = [];
  const s = C.makeLocalScorer(async (texts) => { sizes.push(texts.length); return texts.map((t) => [t.length % 7, 1]); });
  const out = await s('zebra moved', pool, focus);
  assert.equal(sizes.length, 1); assert.equal(sizes[0], 1 + out.vector.length, 'the query plus the vector set, once');
  assert.ok(out.vector.length >= C.VECTOR_LEXICAL && out.vector.length <= C.VECTOR_LEXICAL + C.VECTOR_RECENT + 1, String(out.vector.length));
  assert.equal(out.lexical.length, 1390, 'BM25 still ranks the whole pool');
  assert.deepEqual(new Set(out.vector), new Set(C.vectorPool(pool, out.lexical, focus).map((c) => c.id)));
  // collect hands the scorer the note's own same-key and same-card claims as focus.
  let seen = null;
  const own = [claim(1, { key: 'card.x-y' }), claim(2, { text: 'X-Y-189 done' }), claim(3), claim(4, { owner: 'b9', key: 'card.x-y' })];
  await C.collectNoteCandidates({ ownClaims: () => own, resolve: () => [], score: (q, p, f) => { seen = f; return { lexical: [], vector: [] }; } }, 'a1', 'X-Y moved', new Date(T0), { key: 'card.x-y' });
  assert.deepEqual([...seen].sort(), [id(1), id(2)]);
});

test('nit 1: the vector cache evicts oldest-inserted first, never below the current set', async () => {
  const calls = [];
  const s = C.makeLocalScorer(async (texts) => { calls.push(texts.slice(1)); return texts.map(() => [1, 0]); }, undefined, 2);
  await s('q', [claim(1)]); await s('q', [claim(2)]); await s('q', [claim(3)]);   // cache: 2, 3 (1 evicted)
  await s('q', [claim(2)]); await s('q', [claim(1)]);
  assert.deepEqual(calls, [['invented note 1'], ['invented note 2'], ['invented note 3'], [], ['invented note 1']]);
  // A set larger than the cap is kept whole for that call.
  calls.length = 0;
  const big = [claim(5), claim(6), claim(7)];
  await s('q', big); await s('q', big);
  assert.deepEqual(calls, [['invented note 5', 'invented note 6', 'invented note 7'], []]);
});

test('S2 + nit 2: --separate is validated first; naming no listed claim brings the offer back; inOffer counts only listed ids', async () => {
  const store = mkStore();
  const rows = [];
  const d = wire(store, rows);
  const outside = await ok(store.appendRecord('andy', { t: 'claim', kind: 'fact', text: 'zzz unrelated old fact' }, 'endpoint'));
  for (let i = 0; i < 6; i++) await ok(store.appendRecord('andy', { t: 'claim', kind: 'fact', text: `the cache fact ${i}` }, 'endpoint'));
  const jims = await ok(store.appendRecord('jim', { t: 'claim', kind: 'fact', text: 'the cache fact jim' }, 'endpoint'));
  const before = recs(store).length;
  let r = await handleClaimVerb(d, 'andy', { cmd: 'note', args: { text: 'the cache moved' } }, 'endpoint');
  const offer = r.json.candidates.map((c) => c.id);
  assert.equal(offer.length, 5); assert.ok(!offer.includes(outside), 'the unrelated claim is outside the offer');
  // An own live id outside the offer: the offer comes back, nothing written.
  r = await handleClaimVerb(d, 'andy', { cmd: 'note', args: { text: 'the cache moved', separate: outside } }, 'endpoint');
  assert.equal(r.json.choice, 'choose');
  assert.match(r.text, /^None of the ids after --separate is in this offer: choose from it/);
  assert.equal(recs(store).length, before);
  assert.equal(rows.at(-1).choice, 'offered'); assert.equal(rows.at(-1).offOfferSeparate, true); assert.equal(rows.at(-1).bareSeparate, undefined);
  // Validation comes first: another agent's id is refused (exit 2), not answered with the offer.
  r = await handleClaimVerb(d, 'andy', { cmd: 'note', args: { text: 'the cache moved', separate: jims } }, 'endpoint');
  assert.equal(r.exit, 2); assert.match(r.error, /--separate must name only your own currently live claims/);
  // One listed id with one unlisted: written; inOffer is 1, not 2.
  r = await handleClaimVerb(d, 'andy', { cmd: 'note', args: { text: 'the cache moved', separate: `${offer[0]},${outside}` } }, 'endpoint');
  assert.equal(r.ok, true); assert.equal(r.json.choice, 'separate');
  assert.equal(rows.at(-1).choice, 'separate'); assert.equal(rows.at(-1).inOffer, 1);
  assert.equal(d.view('andy').status(outside), 'live'); assert.equal(d.view('andy').status(offer[0]), 'live');
  // With nothing to offer, an own live id is written as before (the ledger route: no offer at all).
  r = await handleClaimVerb(d, 'andy', { cmd: 'note', args: { text: 'via the ledger', separate: outside } }, 'ledger-route');
  assert.equal(r.ok, true);
});

test('S3 (option a): a card.* note on the ledger route meeting a live same-key claim is refused until it chooses', async () => {
  const store = mkStore();
  const rows = [];
  const d = wire(store, rows);
  const old = await ok(store.appendRecord('andy', { t: 'claim', kind: 'fact', key: 'card.rel-189', text: 'the release ships Friday' }, 'endpoint'));
  const before = recs(store).length;
  let r = await handleClaimVerb(d, 'andy', { cmd: 'note', args: { text: 'the release ships Monday', key: 'card.rel-189' } }, 'ledger-route');
  assert.equal(r.ok, false); assert.equal(r.exit, 2);
  assert.equal(r.error, `your live claim ${old} already has key card.rel-189. Say what this note does to it, then send the op again: add "supersedes": ["${old}"], "reason": "changed" (or "corrected" / "moved") to the memory part when it replaces it; add "separate": ["${old}"] when both stay true. Nothing was written`);
  assert.equal(recs(store).length, before);
  assert.deepEqual(rows.at(-1), { kind: 'claims-note-choice', agentId: 'andy', choice: 'offered', targets: [old], origin: 'ledger-route', shown: 1, sameKey: 1, sameCard: 0, keyed: true, cardKeyRefused: true });
  // A bare separate does not count as a choice.
  r = await handleClaimVerb(d, 'andy', { cmd: 'note', args: { text: 'x', key: 'card.rel-189', separate: true } }, 'ledger-route');
  assert.equal(r.exit, 2);
  // Other keys: written as before (unoffered).
  r = await handleClaimVerb(d, 'andy', { cmd: 'note', args: { text: 'a list fact', key: 'list.rel' } }, 'ledger-route');
  assert.equal(r.ok, true);
  r = await handleClaimVerb(d, 'andy', { cmd: 'note', args: { text: 'a second list fact', key: 'list.rel' } }, 'ledger-route');
  assert.equal(r.ok, true, 'a live same-key claim under another namespace does not refuse');
  // Separate: written, the old one stays live.
  r = await handleClaimVerb(d, 'andy', { cmd: 'note', args: { text: 'release notes are drafted', key: 'card.rel-189', separate: [old] } }, 'ledger-route');
  assert.equal(r.ok, true); assert.equal(d.view('andy').status(old), 'live');
  const kept = r.json.id;
  // Two live: both named, newest first.
  r = await handleClaimVerb(d, 'andy', { cmd: 'note', args: { text: 'y', key: 'card.rel-189' } }, 'ledger-route');
  assert.match(r.error, new RegExp(`^your live claims ${kept}, ${old} already have key card\\.rel-189\\..*"separate": \\["${kept}", "${old}"\\]`));
  // Supersedes: written, the old one superseded by this choice only.
  r = await handleClaimVerb(d, 'andy', { cmd: 'note', args: { text: 'the release ships Monday', key: 'card.rel-189', supersedes: [old], reason: 'changed' } }, 'ledger-route');
  assert.equal(r.ok, true); assert.equal(d.view('andy').status(old), 'superseded'); assert.equal(d.view('andy').status(kept), 'live');
  // The CLI (endpoint) path is unchanged: it offers, it does not refuse.
  r = await handleClaimVerb(d, 'andy', { cmd: 'note', args: { text: 'the release ships Tuesday', key: 'card.rel-189' } }, 'endpoint');
  assert.equal(r.ok, true); assert.equal(r.json.choice, 'choose');
});

test('S3 through the ledger command: refused before anything is written; key / supersedes / separate reach the claim', async () => {
  const L = loadTs(path.join(ROOT, 'src/main/ledger.ts'));
  const { cardKeyRefusal } = loadTs(path.join(ROOT, 'src/main/claims/endpoint.ts'));
  const store = mkStore();
  const rows = [];
  const d = wire(store, rows);
  const agentDir = path.join(JAIL, `ledger-agent-${hiveN}`);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'memory.md'), '# m\n');
  const tasks = [{ id: 'CARD-1', title: 'invented', status: 'todo', dependsOn: [], priority: 1, createdAt: 'x' }];
  let patches = 0;
  const deps = (level = 'writer') => ({
    agentId: 'andy', agentDir, isRecipient: (to) => to === 'god', readTasks: () => tasks.map((t) => ({ ...t })), addTask: () => false,
    patchTask: () => { patches += 1; return true; }, now: () => new Date(T0),
    memoryClaim: {
      level,
      note: async (args) => { const r = await handleClaimVerb(d, 'andy', { cmd: 'note', args }, 'ledger-route'); return { ok: r.ok, ...(r.json && r.json.id ? { id: r.json.id } : {}), ...(r.error ? { error: r.error } : {}) }; },
      precheck: (args) => cardKeyRefusal(d, 'andy', args)?.text ?? null,
    },
  });
  const outbox = () => { try { return fs.readdirSync(path.join(agentDir, 'outbox')); } catch { return []; } };
  const op = (name, memory) => ({ op: name, card: { id: 'CARD-1', patch: { status: 'doing' } }, message: { to: 'god', act: 'inform', subject: 's', body: 'b' }, memory });
  const old = await ok(store.appendRecord('andy', { t: 'claim', kind: 'fact', key: 'card.card-1', text: 'card one is half done' }, 'endpoint'));
  const before = recs(store).length;
  let r = await L.applyLedgerOp(op('s3-1', { append: 'card one is done', key: 'card.card-1' }), deps());
  assert.equal(r.status, 409); assert.match(r.body.line, new RegExp(`^refused: your live claim ${old} already has key card\\.card-1\\.`));
  assert.equal(recs(store).length, before); assert.equal(patches, 0, 'the card is not patched'); assert.deepEqual(outbox(), [], 'no message sent');
  // P1 / S2: a syntactically valid but unrelated --separate does not bypass the ledger refusal.
  r = await L.applyLedgerOp(op('s3-p1', { append: 'card one is also done', key: 'card.card-1', separate: ['c-000000000000'] }), deps());
  assert.equal(r.status, 409); assert.match(r.body.line, new RegExp(`^refused: your live claim ${old} already has key card\\.card-1\\.`));
  assert.equal(recs(store).length, before);
  // The same op name, now with a choice: applied (a refused op was never recorded).
  r = await L.applyLedgerOp(op('s3-1', { append: 'card one is done', key: 'card.card-1', supersedes: [old], reason: 'changed' }), deps());
  assert.equal(r.status, 200, r.body.line);
  const c = recs(store).at(-1);
  assert.deepEqual([c.key, c.supersedes, c.supersedesReason], ['card.card-1', [old], { category: 'changed' }]);
  assert.equal(d.view('andy').status(old), 'superseded');
  r = await L.applyLedgerOp(op('s3-2', { append: 'card one has a follow-up', key: 'card.card-1', separate: [c.id] }), deps());
  assert.equal(r.status, 200, r.body.line); assert.equal(d.view('andy').status(c.id), 'live');
  // Field checks, before anything.
  for (const [m, re] of [
    [{ append: 'x', supersedes: [old] }, /needs "reason"/], [{ append: 'x', reason: 'changed' }, /goes with memory.supersedes/],
    [{ append: 'x', supersedes: [old], separate: [old], reason: 'changed' }, /not both/], [{ append: 'x', separate: ['nope'] }, /memory.separate/],
    [{ append: 'x', supersedes: [old, old], reason: 'moved' }, /memory.supersedes/], [{ append: 'x', key: 7 }, /memory.key/],
    [{ append: 'x', key: 'k'.repeat(201) }, /memory.key: a key of at most 200 chars/],
  ]) { const x = await L.applyLedgerOp(op('s3-bad', m), deps()); assert.equal(x.status, 400, JSON.stringify(m)); assert.match(x.body.line, re); }
  // Below writer: memory.md as before; the key is not checked (memory.md has no keys).
  r = await L.applyLedgerOp({ op: 's3-3', memory: { append: '- a plain note', key: 'card.card-1' } }, deps('reader'));
  assert.equal(r.status, 200, r.body.line);
  assert.match(fs.readFileSync(path.join(agentDir, 'memory.md'), 'utf8'), /- a plain note/);
  // main wires the same precheck.
  const idx = fs.readFileSync(path.join(ROOT, 'src/main/index.ts'), 'utf8');
  assert.match(idx, /precheck: \(args\) => cardKeyRefusal\(d, agentId, args\)\?\.text \?\? null/);
  assert.match(idx, /liveByKey: \(agentId, key\) =>/);
  // Pin the production endpoint wiring, not the test-only wire() helper: live claims are newest
  // first and dead claims do not grant a ledger-route bypass (K17/K18).
  assert.match(idx, /\.filter\(\(c\) => c\.key === key && view\.status\(c\.id\) === 'live'\)/);
  assert.match(idx, /\.sort\(\(a, b\) => Date\.parse\(b\.wt\) - Date\.parse\(a\.wt\)/);
});

test('nit 5: a leading kind word sets the kind (and says so); --kind wins; a lone word stays text', async () => {
  assert.deepEqual(cli.parseArgs(['note', 'lesson', 'always', 'resolve', 'by', 'hash']).args, { kind: 'lesson', text: 'always resolve by hash' });
  assert.deepEqual(cli.parseArgs(['note', 'decision use option a']).args, { kind: 'decision', text: 'use option a' });
  assert.deepEqual(cli.parseArgs(['note', '--kind', 'fact', 'lesson', 'learned']).args, { kind: 'fact', text: 'lesson learned' });
  assert.deepEqual(cli.parseArgs(['note', 'lesson']).args, { text: 'lesson' });
  assert.deepEqual(cli.parseArgs(['note', 'decision:', 'x']).args, { text: 'decision: x' });
  assert.deepEqual(cli.parseArgs(['note', 'Lesson', 'x']).args, { text: 'Lesson x' });
  assert.deepEqual(cli.parseArgs(['search', 'lesson', 'x']).args, { query: 'lesson x' });
  const err = [];
  await cli.main(['note', 'todo', 'ship', 'it'], {}, { out: () => {}, err: (s) => err.push(s) });
  assert.match(err[0], /^memory: noted as kind todo \(the first word\); use --kind fact to keep the word as text/);
});
