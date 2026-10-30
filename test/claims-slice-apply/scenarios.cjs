'use strict';
/**
 * CLAIMS-SYNC-SLICE-APPLY scenarios, run through the C4 drill runner against THIS tree (Electron as
 * Node: the app's better-sqlite3 + sqlite-vec; a jailed home; a sandbox hive; the W3 bag-of-words
 * fake embedder). A claims sync of a wing with nothing to replace applies in slices of whole claims:
 *   'visible'  a search queued behind the FIRST slice's apply finds that slice's claims while the
 *              sync is still running (before the final step); the final step writes the head row.
 *   'crash'    the embedder dies after the first slice: the slice stays searchable with no head;
 *              the next sync embeds only what is missing and finishes (head row, nothing twice).
 *   'markdown' a wing whose markdown is indexed keeps the all-at-once apply (MUST-1): one apply,
 *              the markdown found during the embeds, claims and no markdown behind the apply.
 * Invented text only. drill.args.scenario picks one; each returns facts the test asserts on.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DIM = 384;
// A search embeds its query through the same embedder (engine.search, one `tokNNN` text): those
// calls are counted apart, so `calls` (and `failAt`) count claim-part embeds only and the drill's
// own searches never consume the budget or hit the dead embedder.
const isQuery = (texts) => texts.length === 1 && /^tok\d{3}$/.test(texts[0]);
function bowEmbedder(failAt = 0) {
  const e = { loaded: true, calls: 0, queries: 0 };
  e.embed = async (texts) => {
    if (isQuery(texts)) e.queries++;
    else {
      e.calls++;
      if (failAt && e.calls >= failAt) throw new Error('embedder died (drill)');
    }
    return texts.map((t) => {
      const v = new Float32Array(DIM);
      for (const w of t.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        const h = crypto.createHash('sha256').update(w).digest();
        v[h.readUInt16BE(0) % DIM] += 1;
        v[h.readUInt16BE(2) % DIM] += 0.5;
      }
      let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
      for (let i = 0; i < DIM; i++) v[i] /= n;
      if (n === 1 && !t.trim()) v[0] = 1;
      return v;
    });
  };
  e.unload = async () => {};
  return e;
}
const words = (t) => t.split(/\s+/).filter(Boolean).length;

module.exports = async (drill) => {
  drill.assert.harnessStarted();
  drill.assert.homeJailed();
  const L = (rel) => drill.loadTs(rel);
  const { NativeMemoryStore, claimEmbedVersionKey, CLAIM_EMBED_VERSION } = L('src/main/nativeMemory/store.ts');
  const { MemoryEngine, CLAIMS_APPLY_SLICE } = L('src/main/nativeMemory/engine.ts');
  const { withParts } = L('src/main/claims/chunks.ts');
  const { sha256Hex } = L('src/main/claims/canonical.ts');
  const hive = drill.hive;
  const dbDir = path.join(drill.home, 'db');
  fs.mkdirSync(dbDir, { recursive: true });
  const open = () => NativeMemoryStore.open(path.join(dbDir, 'i.sqlite'), drill.openOpts);
  const engine = (store, emb) => new MemoryEngine({ hiveRoot: hive, store, embedder: emb, countTokens: words, watch: null, claimLedger: 'writer', implementedLevel: 'writer' });
  const manifest = (ledger) => fs.writeFileSync(path.join(hive, 'memory-sources.json'), JSON.stringify({ topLevel: [], include: {}, ledger }));
  const ledger = (a) => {
    const d = path.join(hive, 'agents', a, 'memory', 'claims');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, '2026-10.jsonl'), '');
    fs.writeFileSync(path.join(hive, 'agents', a, 'memory', 'claims-import.json'), '{"v":1}\n');
  };
  const chunk = (id, wing, text) => {
    const at = '2026-10-03T10:00:00.000Z';
    const content = `fact · - · ${at.slice(0, 10)}\n${text}`;
    return { claimId: id, wing, kind: 'fact', ckey: null, at, status: 'live', content, contentSha256: sha256Hex(content) };
  };
  const W = drill.args.wing ?? 'd1';
  const PATH = `agents/${W}/memory/claims`;
  const N = drill.args.n ?? CLAIMS_APPLY_SLICE * 3 + 5;
  // claim i carries a unique token `tokNNN` so a search for it hits that claim alone
  const tok = (i) => `tok${String(i).padStart(3, '0')}`;
  const claims = Array.from({ length: N }, (_, i) => chunk(`c-${String(i).padStart(12, '0')}`, W, `slice claim ${tok(i)} about the quartz pallet`));
  const sync = (eng, extra = {}) => eng.syncClaims({ wing: W, path: PATH, head: 'h', chunks: withParts(claims), ...extra });
  const hits = async (eng, q) => { const r = await eng.search({ query: q, results: 10, wing: W }); return Array.isArray(r.json) ? r.json : []; };
  const finds = async (eng, i) => (await hits(eng, tok(i))).some((h) => h.claimId === claims[i].claimId);
  const mdHits = (hs) => hs.filter((h) => !h.claimId && /memory\.md$/.test(String(h.source))).length;
  /** Every applyClaims call: queue a search right behind it (search outranks ingest, so it runs as
   *  the next queue step) and record what it saw and whether the sync had already resolved. */
  const watchApplies = (store, eng, state) => {
    const applies = [];
    const real = store.applyClaims.bind(store);
    store.applyClaims = (...args) => {
      const out = real(...args);
      const plan = args[1];
      const rec = { add: plan.add.length, drop: plan.drop.length, partial: !!(args[4] && args[4].partial), behind: null };
      applies.push(rec);
      rec.behind = hits(eng, tok(0)).then((hs) => { rec.behind = { first: hs.some((h) => h.claimId === claims[0].claimId), claims: hs.filter((h) => h.claimId).length, md: mdHits(hs), settled: state.settled }; });
      return out;
    };
    return applies;
  };
  const settle = async (applies) => { for (const a of applies) if (a.behind && typeof a.behind.then === 'function') await a.behind; return applies; };
  const s = drill.args.scenario;

  if (s === 'visible') {
    fs.rmSync(path.join(hive, 'agents'), { recursive: true, force: true });
    ledger(W); manifest({ [W]: 'writer' });
    const store = open(); const emb = bowEmbedder(); const eng = engine(store, emb);
    await eng.backfill();
    const state = { settled: false };
    const applies = watchApplies(store, eng, state);
    const res = await sync(eng).then((r) => { state.settled = true; return r; });
    await settle(applies);
    const sampled = [0, 1, CLAIMS_APPLY_SLICE - 1, CLAIMS_APPLY_SLICE, N - 1];
    const found = {}; for (const i of sampled) found[i] = await finds(eng, i);
    const out = { n: N, slice: CLAIMS_APPLY_SLICE, res, applies, found, head: store.sourceShas().get(PATH) ?? null, embedVersion: store.meta(claimEmbedVersionKey(W)), expectVersion: String(CLAIM_EMBED_VERSION), embedCalls: emb.calls,
      claimRows: store.db.prepare('SELECT count(*) AS n FROM claims WHERE wing = ?').get(W).n };
    await eng.close(); store.close();
    return out;
  }

  if (s === 'crash') {
    fs.rmSync(path.join(hive, 'agents'), { recursive: true, force: true });
    ledger(W); manifest({ [W]: 'writer' });
    const store = open();
    // dies mid-second-slice: the first slice (CLAIMS_APPLY_SLICE embed calls) is applied, 5 more parts embedded
    const dying = bowEmbedder(CLAIMS_APPLY_SLICE + 6);
    const eng = engine(store, dying);
    await eng.backfill();
    const state = { settled: false };
    const applies = watchApplies(store, eng, state);
    let error = null;
    try { await sync(eng); } catch (e) { error = String(e && e.message); }
    await settle(applies);
    const crashed = { error, applies: applies.length, firstFound: await finds(eng, 0), lastFound: await finds(eng, N - 1), head: store.sourceShas().get(PATH) ?? null,
      claimRows: store.db.prepare('SELECT count(*) AS n FROM claims WHERE wing = ?').get(W).n, embedVersion: store.meta(claimEmbedVersionKey(W)) };
    await eng.close();
    // the next sync (a restart: a fresh engine over the same index) embeds only what is missing
    const emb2 = bowEmbedder(); const eng2 = engine(store, emb2);
    await eng2.backfill();
    const applies2 = watchApplies(store, eng2, { settled: false });
    const res2 = await sync(eng2);
    await settle(applies2);
    const nApplies2 = applies2.length;  // before res3: the no-op third sync is one apply of its own
    const sampled = [0, CLAIMS_APPLY_SLICE - 1, CLAIMS_APPLY_SLICE, CLAIMS_APPLY_SLICE + 5, N - 1];
    const found = {}; for (const i of sampled) found[i] = await finds(eng2, i);
    const res3 = await sync(eng2);
    const out = { n: N, slice: CLAIMS_APPLY_SLICE, crashed, res2, applies2: nApplies2, embedCalls2: emb2.calls, found, head: store.sourceShas().get(PATH) ?? null, res3,
      claimRows: store.db.prepare('SELECT count(*) AS n FROM claims WHERE wing = ?').get(W).n, chunkRows: store.db.prepare('SELECT count(*) AS n FROM chunks WHERE source_id = ?').get(PATH).n };
    await eng2.close(); store.close();
    return out;
  }

  if (s === 'markdown') {
    // MUST-1: the wing's memory.md is indexed before its ledger exists; the first sync replaces it.
    fs.rmSync(path.join(hive, 'agents'), { recursive: true, force: true });
    const dir = path.join(hive, 'agents', W);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'memory.md'), `# Memory\n\n## 2026-10-01\n- the markdown note ${tok(0)} about the quartz pallet\n`);
    manifest({});
    const store = open(); const emb = bowEmbedder(); const eng = engine(store, emb);
    await eng.backfill();
    const mdBefore = mdHits(await hits(eng, tok(0)));
    ledger(W); manifest({ [W]: 'writer' });
    const state = { settled: false };
    const applies = watchApplies(store, eng, state);
    // a search in the middle of the embeds (after the first slice's worth): markdown, no claims
    let during = null;
    const realEmbed = emb.embed;
    emb.embed = async (texts) => { const v = await realEmbed(texts); if (!isQuery(texts) && emb.calls === CLAIMS_APPLY_SLICE + 1) during = hits(eng, tok(0)).then((hs) => ({ md: mdHits(hs), claims: hs.filter((h) => h.claimId).length })); return v; };
    const res = await sync(eng).then((r) => { state.settled = true; return r; });
    await settle(applies);
    during = during ? await during : null;
    const after = await hits(eng, tok(0));
    const out = { n: N, slice: CLAIMS_APPLY_SLICE, mdBefore, during, res, applies, after: { md: mdHits(after), claims: after.filter((h) => h.claimId).length },
      head: store.sourceShas().get(PATH) ?? null, mdIndexed: store.sourceShas().has(`agents/${W}/memory.md`) };
    await eng.close(); store.close();
    return out;
  }

  return { ok: false, reason: `unknown scenario ${s}` };
};
