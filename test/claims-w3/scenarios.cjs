'use strict';
/**
 * CLAIM-LEDGER W3 gate scenarios, run through the C4 drill runner against THIS tree (Electron as
 * Node: the app's better-sqlite3 + sqlite-vec; a jailed home; a sandbox hive). The embedder is a
 * deterministic bag-of-words fake (similar words -> similar vectors), so nearness is controllable;
 * the gates are about filtering, not relevance. CL-S1 M3: the fake embeds EXACTLY what it is given
 * (it used to drop a `kind · key · date` header line itself, which hid the product sending one) and
 * records it in `seen`; the engine must send a claim's text alone (store.ts claimEmbedText).
 * drill.args.scenario picks one; each returns facts the test asserts on.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DIM = 384;
function bowEmbedder() {
  const e = { loaded: true, calls: 0, texts: 0, seen: [] };
  e.embed = async (texts) => {
    e.calls++; e.texts += texts.length; e.seen.push(...texts);
    return texts.map((t) => {
      const body = t;
      const v = new Float32Array(DIM);
      for (const w of body.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
        const h = crypto.createHash('sha256').update(w).digest();
        v[h.readUInt16BE(0) % DIM] += 1;
        v[h.readUInt16BE(2) % DIM] += 0.5;
      }
      let n = 0; for (const x of v) n += x * x; n = Math.sqrt(n) || 1;
      for (let i = 0; i < DIM; i++) v[i] /= n;
      if (n === 1 && !body.trim()) v[0] = 1;
      return v;
    });
  };
  e.unload = async () => {};
  return e;
}

function prng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; }; }
const VOCAB = 'release window deploy friday gizmo widget relay port crate twelve zeppelin hangar code audit ledger claim memory search vector index status agent build cut tag branch merge review lesson fact todo pointer'.split(' ');
const words = (t) => t.split(/\s+/).filter(Boolean).length;

function write(root, rel, text) {
  const p = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

module.exports = async (drill) => {
  drill.assert.harnessStarted();
  drill.assert.homeJailed();
  const L = (rel) => drill.loadTs(rel);
  const { NativeMemoryStore, visOf } = L('src/main/nativeMemory/store.ts');
  const { MemoryEngine } = L('src/main/nativeMemory/engine.ts');
  const { withParts } = L('src/main/claims/chunks.ts');
  const { sha256Hex } = L('src/main/claims/canonical.ts');
  const hive = drill.hive;
  const dbDir = path.join(drill.home, 'db');
  fs.mkdirSync(dbDir, { recursive: true });
  let dbN = 0;
  const open = (file) => NativeMemoryStore.open(file ?? path.join(dbDir, `i${++dbN}.sqlite`), drill.openOpts);
  const engine = (store, emb, extra = {}) => new MemoryEngine({ hiveRoot: hive, store, embedder: emb, countTokens: words, watch: null, claimLedger: 'reader', implementedLevel: 'writer', ...extra });
  const manifest = (ledger) => fs.writeFileSync(path.join(hive, 'memory-sources.json'), JSON.stringify({ topLevel: [], include: {}, ledger }));
  /** An agent with a ledger (one segment): only such an agent swaps its markdown for claims. */
  const ledger = (a) => {
    const d = path.join(hive, 'agents', a, 'memory', 'claims');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, '2026-10.jsonl'), '');
  };
  /** A claim chunk as chunksFor would make it (header line + body). */
  const chunk = (id, wing, status, text, extra = {}) => {
    const kind = extra.kind ?? 'fact'; const key = extra.key ?? null; const at = extra.at ?? '2026-10-03T10:00:00.000Z';
    const content = `${kind} · ${key ?? '-'} · ${at.slice(0, 10)}\n${text}`;
    return { claimId: id, wing, kind, ckey: key, at, status, content, contentSha256: sha256Hex(content) };
  };
  const sync = (eng, wing, chunks) => eng.syncClaims({ wing, path: `agents/${wing}/memory/claims`, head: 'h', chunks: withParts(chunks) });
  const claimHits = (r) => (Array.isArray(r.json) ? r.json.filter((h) => h.claimId) : []);
  const s = drill.args.scenario;

  if (s === 'noleak') {
    // G3.1: random static corpora x 1,000 queries, both branches, no hidden claim by default.
    const out = { corpora: 0, queries: 0, leaks: [], historyGone: 0, liveClaimHits: 0, mdHits: 0, historyHits: 0, allGoneHits: 0 };
    for (const seed of [11, 22, 33]) {
      const rnd = prng(seed);
      const root = path.join(hive);
      fs.rmSync(path.join(root, 'agents'), { recursive: true, force: true });
      write(root, 'agents/a1/notes.md', `# Notes\n\n${Array.from({ length: 30 }, (_, i) => `## n${i}\n- ${VOCAB[i % VOCAB.length]} ${VOCAB[(i * 7) % VOCAB.length]} note ${i}`).join('\n\n')}\n`);
      ledger('a1');
      manifest({ a1: 'reader' });
      const store = open(); const emb = bowEmbedder(); const eng = engine(store, emb);
      await eng.backfill();
      const statuses = ['live', 'live', 'live', 'superseded', 'superseded?', 'retracted', 'purged'];
      const chunks = Array.from({ length: 300 }, (_, i) => {
        const text = Array.from({ length: 3 + Math.floor(rnd() * 5) }, () => VOCAB[Math.floor(rnd() * VOCAB.length)]).join(' ') + ` c${i}`;
        return chunk(`c-${seed.toString(16).padStart(4, '0')}${String(i).padStart(8, '0')}`, 'a1', statuses[Math.floor(rnd() * statuses.length)], text);
      });
      const statusOf = new Map(chunks.map((c) => [c.claimId, c.status]));
      await sync(eng, 'a1', chunks);
      for (let q = 0; q < 1000 / 3 + 1; q++) {
        const query = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => VOCAB[Math.floor(rnd() * VOCAB.length)]).join(' ');
        const filtered = q % 2 === 0;
        const r = await eng.search({ query, results: 10, ...(filtered ? { wing: 'a1' } : {}) });
        out.queries++;
        out.mdHits += (r.json ?? []).filter((h) => !h.claimId).length;
        for (const h of claimHits(r)) {
          if (visOf(statusOf.get(h.claimId)) !== 'live') out.leaks.push({ seed, query, filtered, claim: h.claimId, status: statusOf.get(h.claimId) });
          else out.liveClaimHits++;
        }
        const hr = await eng.search({ query, results: 10, mode: 'history', ...(filtered ? { wing: 'a1' } : {}) });
        for (const h of claimHits(hr)) { out.historyHits++; if (visOf(statusOf.get(h.claimId)) === 'gone') out.historyGone++; }
        if (q % 10 === 0) {
          const ar = await eng.search({ query, results: 10, mode: 'all' });
          out.allGoneHits += claimHits(ar).filter((h) => visOf(statusOf.get(h.claimId)) === 'gone').length;
        }
      }
      await eng.close(); store.close();
      out.corpora++;
    }
    return out;
  }

  if (s === 'embedtext') {
    // CL-S1 M3: a claim part is embedded as its TEXT, never with its `kind · key · date` header, and an
    // index made under the old recipe (no claim_embed_version for the wing) re-embeds the wing once.
    fs.rmSync(path.join(hive, 'agents'), { recursive: true, force: true });
    ledger('a1');
    manifest({ a1: 'writer' });
    const store = open(); const emb = bowEmbedder(); const eng = engine(store, emb);
    await eng.backfill();
    const target = 'the zeppelin hangar code is twelve and the relay uses crate seven';
    const chunks = [
      chunk('c-0000000000e1', 'a1', 'live', target, { kind: 'decision', key: 'release.hangar.window' }),
      chunk('c-0000000000e2', 'a1', 'superseded', 'the hangar audit tag moved to friday', { key: 'release.hangar.window' }),
      chunk('c-0000000000e3', 'a1', 'live', 'a widget review lesson about the build cut'),
    ];
    const vecOf = (id) => {
      const r = store.db.prepare('SELECT v.embedding AS e FROM chunks c JOIN chunks_vec v ON v.rowid = c.chunk_id WHERE c.claim_id = ?').get(id);
      return new Float32Array(r.e.buffer.slice(r.e.byteOffset, r.e.byteOffset + r.e.byteLength));
    };
    const maxDiff = (a, b) => a.reduce((m, x, i) => Math.max(m, Math.abs(x - b[i])), 0);
    const [bare] = await emb.embed([target]);
    const [withHeader] = await emb.embed([chunks[0].content]);
    emb.seen.length = 0;
    const first = await sync(eng, 'a1', chunks);
    const out = {
      firstEmbedded: first.embedded,
      seen: emb.seen.slice(),
      version: store.meta('claim_embed_version:a1'),
      targetIsBare: maxDiff(vecOf('c-0000000000e1'), bare) < 1e-6,
      targetIsHeadered: maxDiff(vecOf('c-0000000000e1'), withHeader) < 1e-6,
      headerChangesVector: maxDiff(bare, withHeader) > 1e-3,
    };
    out.secondEmbedded = (await sync(eng, 'a1', chunks)).embedded;
    // An index from before the fix: its wing has no claim_embed_version row.
    store.db.prepare('DELETE FROM index_meta WHERE key = ?').run('claim_embed_version:a1');
    emb.seen.length = 0;
    const up = await sync(eng, 'a1', chunks);
    out.upgrade = { embedded: up.embedded, dropped: up.dropped, seen: emb.seen.slice(), version: store.meta('claim_embed_version:a1') };
    out.afterUpgradeTargetIsBare = maxDiff(vecOf('c-0000000000e1'), bare) < 1e-6;
    out.liveAfter = claimHits(await eng.search({ query: 'hangar', results: 10, wing: 'a1' })).map((h) => h.claimId).sort();
    out.historyAfter = claimHits(await eng.search({ query: 'hangar', results: 10, wing: 'a1', mode: 'history' })).map((h) => h.claimId).sort();
    out.thirdEmbedded = (await sync(eng, 'a1', chunks)).embedded;
    await eng.close(); store.close();
    return out;
  }

  if (s === 'later') {
    // G3.1b: a claim indexed live, then hidden by each kind of supersede; inside the visibility
    // window (the sync's own return) it is gone from both branches. Never a re-embed.
    fs.rmSync(path.join(hive, 'agents'), { recursive: true, force: true });
    ledger('a1');
    manifest({ a1: 'writer' });
    const store = open(); const emb = bowEmbedder(); const eng = engine(store, emb);
    await eng.backfill();
    const longText = `${Array.from({ length: 140 }, (_, i) => `filler${i % 9}`).join(' ')} quetzalcoatl`;
    const base = [
      chunk('c-000000000001', 'a1', 'live', 'the zebrafinch protocol uses port 9001'),
      chunk('c-000000000002', 'a1', 'live', 'the axolotl relay is in crate twelve'),
      chunk('c-000000000003', 'a1', 'live', 'the narwhal cut ships friday'),
      chunk('c-000000000004', 'a1', 'live', 'the okapi branch merges after review'),
    ];
    // A long (multi-part) claim: parts split as chunksFor would.
    const { chunksFor } = L('src/main/claims/chunks.ts');
    const longParts = chunksFor([{ v: 1, id: 'c-000000000005', t: 'claim', kind: 'fact', text: longText, source: 'legacy', at: '2026-10-03T10:00:00.000Z', wt: '2026-10-03T10:00:00.000Z', agent: 'a1', prev: '', mac: '' }],
      { v: 1, agent: 'a1', registryHash: '', ledgerHead: '', conflicts: [], claims: { 'c-000000000005': { id: 'c-000000000005', status: 'live', sightings: 0, firstAt: '', lastAt: '', pinned: false, reasons: [] } } });
    let all = [...base, ...longParts];
    await sync(eng, 'a1', all);
    const words5 = { 'c-000000000001': 'zebrafinch', 'c-000000000002': 'axolotl', 'c-000000000003': 'narwhal', 'c-000000000004': 'okapi', 'c-000000000005': 'quetzalcoatl' };
    const seen = async (id) => {
      const q = words5[id];
      const a = claimHits(await eng.search({ query: q, results: 10 })).some((h) => h.claimId === id);
      const b = claimHits(await eng.search({ query: q, results: 10, wing: 'a1' })).some((h) => h.claimId === id);
      return { fast: a, filtered: b };
    };
    const before = {}; for (const id of Object.keys(words5)) before[id] = await seen(id);
    let reEmbedded = 0;
    const causes = { 'c-000000000001': ['superseded', 'R2 key supersede'], 'c-000000000002': ['retracted', 'R3 retract'], 'c-000000000003': ['superseded', 'R4 inferred-supersede event'], 'c-000000000004': ['superseded', 'soft newest-wins event'], 'c-000000000005': ['superseded', 'R2 on a multi-part claim'] };
    const after = {};
    for (const [id, [status, cause]] of Object.entries(causes)) {
      all = all.map((c) => (c.claimId === id ? { ...c, status } : c));
      const t0 = emb.texts;
      const r = await sync(eng, 'a1', all);
      reEmbedded += emb.texts - t0;
      after[id] = { cause, ...(await seen(id)), statusChanges: r.statusChanges };
    }
    const history = claimHits(await eng.search({ query: 'zebrafinch', results: 10, mode: 'history' })).map((h) => [h.claimId, h.status]);
    const parts = longParts.length;
    const out = { before, after, reEmbedded, history, parts };
    await eng.close(); store.close();
    return out;
  }

  if (s === 'cap') {
    // G3.1c: the N nearest (N >> k) are all hidden; both branches still return k live.
    fs.rmSync(path.join(hive, 'agents'), { recursive: true, force: true });
    ledger('a1');
    manifest({ a1: 'reader' });
    const store = open(); const emb = bowEmbedder(); const eng = engine(store, emb);
    await eng.backfill();
    const chunks = [];
    for (let i = 0; i < 600; i++) chunks.push(chunk(`c-${String(i).padStart(12, '0')}`, 'a1', i < 590 ? (i % 2 ? 'superseded' : 'retracted') : 'live', i < 590 ? `alpha beta gamma delta ${i}` : `alpha beta gamma epsilon ${i}`));
    for (let i = 0; i < 50; i++) chunks.push(chunk(`c-9${String(i).padStart(11, '0')}`, 'a1', 'live', `unrelated words ${VOCAB[i % VOCAB.length]} ${i}`));
    await sync(eng, 'a1', chunks);
    const statusOf = new Map(chunks.map((c) => [c.claimId, c.status]));
    const fast = claimHits(await eng.search({ query: 'alpha beta gamma delta', results: 5 }));
    const filtered = claimHits(await eng.search({ query: 'alpha beta gamma delta', results: 5, wing: 'a1' }));
    // Jim S-a: the vector branch on its own. Every one of the k hits must come from the KNN (cosineSim
    // set): without the in-KNN vis filter (or a stale vec0 vis) the KNN returns hidden rows, the row
    // check drops them, and only lexical hits (cosineSim null) are left. Checked twice: vis set at
    // insert (this store) and vis set later by a status change (all live first, then hidden).
    const vec = async (e) => ({
      fast: claimHits(await e.search({ query: 'alpha beta gamma delta', results: 5 })).map((h) => [statusOf.get(h.claimId), h.cosineSim !== null]),
      filtered: claimHits(await e.search({ query: 'alpha beta gamma delta', results: 5, wing: 'a1' })).map((h) => [statusOf.get(h.claimId), h.cosineSim !== null]),
    });
    const vecAtInsert = await vec(eng);
    await eng.close(); store.close();
    const store2 = open(); const eng2 = engine(store2, bowEmbedder());
    await eng2.backfill();
    await sync(eng2, 'a1', chunks.map((c) => ({ ...c, status: 'live' })));
    const changed = await sync(eng2, 'a1', chunks);
    const vecAfterChange = await vec(eng2);
    await eng2.close(); store2.close();
    return {
      fast: fast.map((h) => statusOf.get(h.claimId)), filtered: filtered.map((h) => statusOf.get(h.claimId)),
      fastLiveEpsilon: fast.filter((h) => Number(h.claimId.slice(2)) >= 590 && Number(h.claimId.slice(2)) < 600).length,
      vecAtInsert, vecAfterChange, statusChanges: changed.statusChanges, reEmbedded: changed.embedded,
    };
  }

  if (s === 'disposable') {
    // G3.3: delete the index file, rebuild (backfill + main's resync), identical results.
    fs.rmSync(path.join(hive, 'agents'), { recursive: true, force: true });
    write(hive, 'agents/a1/notes.md', '# Notes\n\n## one\n- the gizmo relay uses port 4471\n\n## two\n- widgets ship in crates of twelve\n');
    write(hive, 'agents/a2/memory.md', '# Memory\n\n## 2026-09-02\n- the hangar door code is 7781\n');
    ledger('a1');
    manifest({ a1: 'reader' });
    const chunks = Array.from({ length: 40 }, (_, i) => chunk(`c-${String(i).padStart(12, '0')}`, 'a1', i % 5 === 0 ? 'superseded' : 'live', `${VOCAB[i % VOCAB.length]} ${VOCAB[(i * 3) % VOCAB.length]} claim ${i}`));
    const queries = ['gizmo relay', 'hangar code', 'release window', 'ledger claim', 'crate twelve widget', 'audit review', 'friday deploy'];
    const file = path.join(dbDir, 'disposable.sqlite');
    const run = async () => {
      const store = open(file); const eng = engine(store, bowEmbedder());
      await eng.backfill(); await sync(eng, 'a1', chunks);
      const res = [];
      for (const q of queries) for (const mode of ['live', 'history']) {
        const r = await eng.search({ query: q, results: 8, mode });
        res.push((r.json ?? []).map((h) => `${h.source}|${h.claimId ?? ''}|${h.status ?? ''}`));
      }
      const counts = store.counts();
      await eng.close(); store.close();
      return { res, counts };
    };
    const a = await run();
    for (const f of fs.readdirSync(dbDir)) if (f.startsWith('disposable.sqlite')) fs.rmSync(path.join(dbDir, f));
    const b = await run();
    return { identical: JSON.stringify(a.res) === JSON.stringify(b.res), a: a.counts, b: b.counts, sample: a.res[0] };
  }

  if (s === 'flip') {
    // G3.4: at reader, memory.md / memory-archive-* / memory-ledger-export-* leave the index (0
    // chunks), claims come in; a flip back restores them and removes the claims.
    fs.rmSync(path.join(hive, 'agents'), { recursive: true, force: true });
    write(hive, 'agents/a1/memory.md', '# Memory\n\n## 2026-09-01\n- memfact alpha\n');
    write(hive, 'agents/a1/memory-archive-2026-09-01.md', '# Archive\n\n- archfact beta\n');
    write(hive, 'agents/a1/memory-ledger-export-2026-10.md', '- exportfact gamma [c:c-000000000001]\n');
    write(hive, 'agents/a1/notes.md', '# Notes\n\n- notefact delta\n');
    write(hive, 'agents/a2/memory.md', '# Memory\n\n- otheragent epsilon\n');
    ledger('a1');
    const pattern = "SELECT count(*) AS n FROM chunks WHERE wing = 'a1' AND (source_id LIKE 'agents/a1/memory.md' OR source_id LIKE 'agents/a1/memory-archive-%.md' OR source_id LIKE 'agents/a1/memory-ledger-export-%.md')";
    const store = open(); const eng = engine(store, bowEmbedder());
    const count = () => ({ excluded: store.db.prepare(pattern).get().n, notes: store.db.prepare("SELECT count(*) AS n FROM chunks WHERE source_id = 'agents/a1/notes.md'").get().n,
      other: store.db.prepare("SELECT count(*) AS n FROM chunks WHERE wing = 'a2'").get().n, claims: store.db.prepare("SELECT count(*) AS n FROM claims WHERE wing = 'a1'").get().n,
      claimChunks: store.db.prepare("SELECT count(*) AS n FROM chunks WHERE claim_id IS NOT NULL").get().n, statuses: store.db.prepare('SELECT count(*) AS n FROM claim_status').get().n });
    const chunks = [chunk('c-000000000001', 'a1', 'live', 'memfact alpha as a claim')];
    manifest({ a1: 'shadow', a2: 'off' });
    await eng.backfill();
    const shadow = count();
    let shadowSync = 'accepted';
    try { await sync(eng, 'a1', chunks); } catch (e) { shadowSync = String(e.message); }
    manifest({ a1: 'reader', a2: 'off' });
    const flipped = await eng.backfill();
    await sync(eng, 'a1', chunks);
    const reader = count();
    const searchMem = claimHits(await eng.search({ query: 'memfact alpha', results: 10 })).length;
    const mdMem = (await eng.search({ query: 'memfact alpha', results: 10 })).json.filter((h) => !h.claimId && h.wing === 'a1' && /memory\.md$/.test(h.source)).length;
    manifest({ a1: 'shadow', a2: 'off' });
    const back = await eng.backfill();
    const flippedBack = count();
    await eng.close(); store.close();
    return { shadow, shadowSync, reader, flippedRemoved: flipped.removed, searchMem, mdMem, flippedBack, backRemoved: back.removed };
  }

  if (s === 'appendOnly') {
    fs.rmSync(path.join(hive, 'agents'), { recursive: true, force: true });
    ledger('a1');
    manifest({ a1: 'reader' });
    const store = open(); const eng = engine(store, bowEmbedder());
    await eng.backfill();
    await sync(eng, 'a1', [chunk('c-000000000001', 'a1', 'live', 'one claim')]);
    const tryIt = (sql) => { try { store.db.prepare(sql).run(); return 'ok'; } catch (e) { return String(e.message); } };
    const out = {
      update: tryIt("UPDATE claims SET content = 'changed'"),
      delete: tryIt('DELETE FROM claims'),
      statusUpdate: tryIt("UPDATE claim_status SET status = 'retracted', vis = 'history'"),
      claims: store.db.prepare('SELECT count(*) AS n FROM claims').get().n,
      schema: store.meta('schema_version'),
      again: await sync(eng, 'a1', [chunk('c-000000000001', 'a1', 'live', 'one claim')]),
      again2: await sync(eng, 'a1', [chunk('c-000000000001', 'a1', 'live', 'one claim')]),
    };
    await eng.close(); store.close();
    return out;
  }

  if (s === 'r5') {
    fs.rmSync(path.join(hive, 'agents'), { recursive: true, force: true });
    ledger('a1');
    ledger('a2');
    manifest({ a1: 'writer', a2: 'writer' });
    const store = open(); const eng = engine(store, bowEmbedder());
    await eng.backfill();
    await sync(eng, 'a1', [
      chunk('c-00000000000a', 'a1', 'live', 'the deploy window is friday evening'),
      chunk('c-00000000000b', 'a1', 'live', 'the deploy window is friday evening'),            // near-identical: a candidate
      chunk('c-00000000000c', 'a1', 'live', 'the deploy window is friday evening', { key: 'release.window' }),
      chunk('c-00000000000d', 'a1', 'superseded', 'the deploy window is friday evening'),       // hidden: never a candidate
      chunk('c-00000000000e', 'a1', 'live', 'zeppelin hangar code audit'),                     // unrelated
    ]);
    await sync(eng, 'a2', [chunk('c-00000000000f', 'a2', 'live', 'the deploy window is friday evening')]);   // another agent
    await sync(eng, 'a1', [
      chunk('c-00000000000a', 'a1', 'live', 'the deploy window is friday evening'), chunk('c-00000000000b', 'a1', 'live', 'the deploy window is friday evening'),
      chunk('c-00000000000c', 'a1', 'live', 'the deploy window is friday evening', { key: 'release.window' }), chunk('c-00000000000d', 'a1', 'superseded', 'the deploy window is friday evening'),
      chunk('c-00000000000e', 'a1', 'live', 'zeppelin hangar code audit'),
      chunk('c-000000000010', 'a1', 'live', 'the deploy window is friday evening', { key: 'release.window' }),
    ]);
    const plain = await eng.r5Candidates('a1', 'c-00000000000a', 0.9);
    const keyed = await eng.r5Candidates('a1', 'c-000000000010', 0.9);
    const unknown = await eng.r5Candidates('a1', 'c-0000000000ff', 0.9);
    await eng.close(); store.close();
    return { plain, keyed, unknown };
  }

  // — W3 audit fixes (Jim CL-W3-AUDIT) —
  const md3 = () => {
    fs.rmSync(path.join(hive, 'agents'), { recursive: true, force: true });
    write(hive, 'agents/a1/memory.md', '# Memory\n\n## 2026-09-01\n- memfact alpha zircon\n');
    write(hive, 'agents/a1/memory-archive-2026-09-01.md', '# Archive\n\n- archfact zircon beta\n');
    write(hive, 'agents/a1/memory-ledger-export-2026-10.md', '- exportfact zircon gamma\n');
    write(hive, 'agents/a1/notes.md', '# Notes\n\n- notefact delta\n');
    ledger('a1');
  };
  const replacedCount = (store) => store.db.prepare("SELECT count(*) AS n FROM chunks WHERE source_id IN ('agents/a1/memory.md') OR source_id LIKE 'agents/a1/memory-archive-%' OR source_id LIKE 'agents/a1/memory-ledger-export-%'").get().n;
  const claimRows = (store) => store.db.prepare('SELECT count(*) AS n FROM claims').get().n;
  const zircon = async (eng) => (await eng.search({ query: 'zircon', results: 10 })).json.map((h) => (h.claimId ? `claim:${h.claimId}` : h.source));

  if (s === 'flipLive') {
    // W3-1 (a): a manifest flip, then a sync with NO backfill: the replaced markdown leaves in the same step.
    md3();
    manifest({ a1: 'shadow' });
    const store = open(); const eng = engine(store, bowEmbedder(), { claimLedger: 'writer' });
    await eng.backfill();
    const before = replacedCount(store);
    manifest({ a1: 'reader' });
    await sync(eng, 'a1', [chunk('c-000000000001', 'a1', 'live', 'memfact alpha zircon as a claim')]);
    const out = { before, after: replacedCount(store), hits: await zircon(eng), notes: store.db.prepare("SELECT count(*) AS n FROM chunks WHERE source_id = 'agents/a1/notes.md'").get().n };
    await eng.close(); store.close();
    return out;
  }

  if (s === 'settingLive') {
    // W3-1 (b): the Settings level on a running worker: a raise swaps markdown for claims, a drop to
    // shadow brings memory.md back and hides the claims, no restart; a sync carrying the level follows it.
    md3();
    manifest({});
    const store = open(); const eng = engine(store, bowEmbedder(), { claimLedger: 'shadow' });
    await eng.backfill();
    const atShadow = { replaced: replacedCount(store), hits: await zircon(eng) };
    let refused = 'accepted';
    try { await eng.syncClaims({ wing: 'a1', path: 'agents/a1/memory/claims', head: 'h', chunks: withParts([chunk('c-000000000001', 'a1', 'live', 'memfact alpha zircon as a claim')]) }); } catch (e) { refused = String(e.message); }
    const raise = await eng.setClaimLedger('reader');
    await sync(eng, 'a1', [chunk('c-000000000001', 'a1', 'live', 'memfact alpha zircon as a claim')]);
    const atReader = { replaced: replacedCount(store), claims: claimRows(store), hits: await zircon(eng) };
    const drop = await eng.setClaimLedger('shadow');
    const backToShadow = { replaced: replacedCount(store), claims: claimRows(store), hits: await zircon(eng) };
    // A sync that carries the level (main's current setting) makes the engine follow it first.
    const follow = await eng.syncClaims({ wing: 'a1', path: 'agents/a1/memory/claims', head: 'h', claimLedger: 'writer', chunks: withParts([chunk('c-000000000001', 'a1', 'live', 'memfact alpha zircon as a claim')]) });
    const followed = { replaced: replacedCount(store), claims: claimRows(store), follow };
    await eng.close(); store.close();
    return { atShadow, refused, raise, atReader, drop, backToShadow, followed };
  }

  if (s === 'manifestWatch') {
    // W3-1: a memory-sources.json change on disk reconciles (the watcher), with no sync and no restart.
    md3();
    manifest({ a1: 'reader' });
    const cbs = [];
    const store = open(); const eng = engine(store, bowEmbedder(), { claimLedger: 'writer', watch: (dir, onChange) => { cbs.push([dir, onChange]); return { close() {} }; } });
    await eng.backfill();
    await sync(eng, 'a1', [chunk('c-000000000001', 'a1', 'live', 'memfact alpha zircon as a claim')]);
    eng.startWatching();
    const atReader = { replaced: replacedCount(store), claims: claimRows(store) };
    manifest({ a1: 'shadow' });
    for (const [dir, fn] of cbs) if (path.resolve(dir) === path.resolve(hive)) fn('memory-sources.json');
    await new Promise((r) => setTimeout(r, 3500));
    const afterWatch = { replaced: replacedCount(store), claims: claimRows(store) };
    await eng.close(); store.close();
    return { atReader, afterWatch, rootWatched: cbs.some(([d]) => path.resolve(d) === path.resolve(hive)) };
  }

  if (s === 'gaps') {
    // W3-2 (1) a claim chunk with no status row is never returned (both branches); (2) a claim main
    // no longer sends is dropped; (3, 4) wake-up never carries claim chunks.
    md3();
    manifest({ a1: 'reader' });
    const store = open(); const eng = engine(store, bowEmbedder(), { claimLedger: 'writer' });
    await eng.backfill();
    await sync(eng, 'a1', [chunk('c-000000000001', 'a1', 'live', 'orphanword quokka'), chunk('c-000000000002', 'a1', 'live', 'second wombat claim')]);
    store.db.prepare("DELETE FROM claim_status WHERE claim_id = 'c-000000000001'").run();
    const orphan = {
      fast: claimHits(await eng.search({ query: 'orphanword quokka', results: 10 })).map((h) => h.claimId),
      filtered: claimHits(await eng.search({ query: 'orphanword quokka', results: 10, wing: 'a1' })).map((h) => h.claimId),
      history: claimHits(await eng.search({ query: 'orphanword quokka', results: 10, mode: 'history' })).map((h) => h.claimId),
    };
    const wake = (await eng.wakeUp('a1')).text;
    const wakeAll = (await eng.wakeUp(null)).text;
    await sync(eng, 'a1', []);
    const unsent = { claims: claimRows(store), all: claimHits(await eng.search({ query: 'wombat quokka', results: 10, mode: 'all' })).length, statuses: store.db.prepare('SELECT count(*) AS n FROM claim_status').get().n };
    await eng.close(); store.close();
    return { orphan, wakeHasClaim: /quokka|wombat/.test(wake) || /quokka|wombat/.test(wakeAll), wakeHasNotes: /notefact/.test(wake), unsent };
  }

  if (s === 'anchoredDeleted') {
    // Jim A-2: a1's ledger folder is deleted; main still holds its anchor. The engine keeps a1
    // flagged: memory.md and the rest stay out, its claims stay, nothing is re-embedded. Without
    // the anchor (the bug) the markdown swaps back in.
    md3();
    manifest({ a1: 'reader' });
    const run = async (anchored) => {
      ledger('a1');
      const store = open(); const emb = bowEmbedder(); const eng = engine(store, emb, { claimLedger: 'writer', anchored });
      await eng.backfill();
      await sync(eng, 'a1', [chunk('c-000000000001', 'a1', 'live', 'memfact alpha zircon as a claim')]);
      fs.rmSync(path.join(hive, 'agents', 'a1', 'memory', 'claims'), { recursive: true, force: true });
      const t0 = emb.texts;
      const r = await eng.reconcileNow();
      const out = { replaced: replacedCount(store), claims: claimRows(store), reEmbedded: emb.texts - t0, removed: r.removed };
      await eng.close(); store.close();
      return out;
    };
    const anchoredRun = await run(['a1']);
    // The anchor can also arrive later, through the claim-ledger op (main pushes it with the level).
    ledger('a1');
    const store = open(); const eng = engine(store, bowEmbedder(), { claimLedger: 'writer' });
    await eng.backfill();
    await sync(eng, 'a1', [chunk('c-000000000001', 'a1', 'live', 'memfact alpha zircon as a claim')]);
    const pushed = await eng.setClaimLedger('writer', ['a1']);
    fs.rmSync(path.join(hive, 'agents', 'a1', 'memory', 'claims'), { recursive: true, force: true });
    await eng.reconcileNow();
    const viaOp = { changed: pushed.changed, replaced: replacedCount(store), claims: claimRows(store) };
    await eng.close(); store.close();
    const plain = await run([]);
    return { anchored: anchoredRun, viaOp, plain };
  }

  if (s === 'workerLedger') {
    // Jim S-b: the claim-ledger op through runWorker's dispatch (a fake port; no markdown, empty
    // syncs, so nothing is embedded). Global shadow refuses a claims-sync; after the op it is accepted.
    const { runWorker } = L('src/main/nativeMemory/worker.ts');
    fs.rmSync(path.join(hive, 'agents'), { recursive: true, force: true });
    ledger('a1');
    manifest({});
    const listeners = []; const events = []; const replies = new Map();
    const port = { on: (_ev, fn) => listeners.push(fn), postMessage: (m) => (typeof m.id === 'number' ? replies.set(m.id, m) : events.push(m)) };
    const ort = { Tensor: class {}, InferenceSession: { create: async () => { throw new Error('no model in this scenario'); } } };
    // This drill runs with needModel: false, so the tree's model (gitignored, provisioned by
    // scripts/fetch-memory-model.cjs) may be absent, as in a fresh worktree. runWorker still reads
    // <modelDir>/tokenizer.json at start, so the scenario brings its own minimal BERT WordPiece
    // tokenizer; the model itself is never loaded (ort is a stub, nothing is embedded).
    const modelDir = path.join(drill.home, 'stub-model');
    fs.mkdirSync(modelDir, { recursive: true });
    fs.writeFileSync(path.join(modelDir, 'tokenizer.json'), JSON.stringify({
      normalizer: { type: 'BertNormalizer', lowercase: true, strip_accents: null, handle_chinese_chars: true, clean_text: true },
      pre_tokenizer: { type: 'BertPreTokenizer' },
      model: { type: 'WordPiece', unk_token: '[UNK]', continuing_subword_prefix: '##', max_input_chars_per_word: 100, vocab: { '[PAD]': 0, '[UNK]': 1, '[CLS]': 2, '[SEP]': 3 } },
    }));
    await runWorker({ hiveRoot: hive, dbFile: path.join(dbDir, 'worker.sqlite'), modelDir, modelSha256: null, vecPath: drill.vecPath, vecSha256: drill.vecSha256, claimLedger: 'shadow' }, port, { Database: drill.openOpts.Database, ort });
    let id = 0;
    const call = async (op, args) => {
      const my = ++id;
      for (const fn of listeners) fn({ data: { id: my, op, args } });
      for (let i = 0; i < 200 && !replies.has(my); i++) await new Promise((r) => setTimeout(r, 25));
      return replies.get(my) ?? { timeout: true };
    };
    // A real worker clamps to this build's IMPLEMENTED_LEVEL ('off' until the rollout), so the op is
    // observed through the engine's stored level: a new value changes it (and reconciles), a repeat does not.
    const sync = await call('claims-sync', { wing: 'a1', path: 'agents/a1/memory/claims', head: 'h', chunks: [] });
    const op = await call('claim-ledger', { value: 'reader' });
    const again = await call('claim-ledger', { value: 'reader' });
    const back = await call('claim-ledger', { value: 'shadow' });
    const shutdown = await call('shutdown', {});
    return { ready: events.some((e) => e.event === 'ready'), sync, op, again, back, shutdown };
  }

  if (s === 'buildV2') {
    // A real v2 index (for G3.6): markdown + claims, at args.dbFile.
    fs.rmSync(path.join(hive, 'agents'), { recursive: true, force: true });
    write(hive, 'agents/a1/notes.md', '# Notes\n\n- v2 notes\n');
    ledger('a1');
    manifest({ a1: 'reader' });
    const store = open(drill.args.dbFile); const eng = engine(store, bowEmbedder());
    await eng.backfill();
    await sync(eng, 'a1', [chunk('c-000000000001', 'a1', 'live', 'a v2 claim')]);
    const counts = store.counts();
    await eng.close(); store.close();
    fs.rmSync(path.join(hive, 'memory-sources.json'), { force: true });
    fs.rmSync(path.join(hive, 'agents'), { recursive: true, force: true });
    return { counts, schema: 2 };
  }

  return { ok: false, reason: `unknown scenario ${s}` };
};
