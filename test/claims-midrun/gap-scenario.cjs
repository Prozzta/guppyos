'use strict';
// CL-READERWATCHER MUST-1: Jim's paced-search drill (his scratchpad jim-rw-gap.cjs, taken as it was
// with the additions marked "Andy"). Is there a search gap AFTER the settled file is written, while
// the worker indexes the imported claims? Mode 'sync': onSettled starts the index sync and the drill
// searches in a loop while it runs. 'shadow': the same after a shadow-to-reader raise. 'backfill': a
// worker reconcile runs between the settled file and the sync. 'upgrade' (SHOULD-1) and 'deleted'
// (SHOULD-2) as in Jim's audit. Invented text only.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DIM = 384;
function bowEmbedder(delayMs) {
  return {
    loaded: true,
    embed: async (texts) => {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
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
    },
    unload: async () => {},
  };
}
const words = (t) => t.split(/\s+/).filter(Boolean).length;

module.exports = async (drill) => {
  drill.assert.harnessStarted();
  drill.assert.homeJailed();
  const L = (rel) => drill.loadTs(rel);
  const { NativeMemoryStore } = L('src/main/nativeMemory/store.ts');
  const { MemoryEngine } = L('src/main/nativeMemory/engine.ts');
  const { readSourcesConfig } = L('src/main/nativeMemory/sources.ts');
  const { ClaimStore } = L('src/main/claims/store.ts');
  const { SandboxKeyProvider, FileLedgerKeyRecord, KEY_RECORD_FILE } = L('src/main/claims/keyProvider.ts');
  const { makeW6Append } = L('src/main/claims/w6Append.ts');
  const { ClaimsIndexSync } = L('src/main/claims/indexSync.ts');
  const { derive } = L('src/main/claims/derive.ts');
  const { DEFAULT_KEY_REGISTRY } = L('src/main/claims/registry.ts');
  const RW = L('src/main/claims/readerWatch.ts');
  const mode = drill.args.mode;
  const N = drill.args.filler ?? 40;
  const hive = drill.hive;
  const A = 'w1';
  const dir = path.join(hive, 'agents', A);
  fs.mkdirSync(dir, { recursive: true });
  const filler = Array.from({ length: N }, (_, i) => `- filler note ${i} about the quartz pallet number ${i * 7}`).join('\n');
  fs.writeFileSync(path.join(dir, 'memory.md'), `# Memory\n\n## 2026-10-01\n${filler}\n- the zeppelin hangar code is twelve\n`);
  // Andy: another agent's file, deleted during w1's pending window, must still leave the index
  const other = path.join(hive, 'agents', 'w9', 'memory.md');
  if (mode === 'backfill') { fs.mkdirSync(path.dirname(other), { recursive: true }); fs.writeFileSync(other, '# Memory\n\n- the heron pier is long\n'); }
  const setLevel = (lv) => fs.writeFileSync(path.join(hive, 'memory-sources.json'), JSON.stringify({ topLevel: [], include: {}, ledger: lv ? { [A]: lv } : {} }));
  setLevel(null);
  const level = (a) => readSourcesConfig(hive).ledger?.[a] ?? 'off';

  const rows = [];
  let store;
  const appendW6 = (...a) => makeW6Append(store)(...a);
  let sync = null, importRun = null, syncP = null;
  const watchers = new RW.ReaderWatchers({
    hiveRoot: () => hive, agents: () => (store.segments(A).length ? [A] : []), candidates: () => [A], level, debounceMs: 100,
    onSettled: (a) => { if (mode !== 'backfill') syncP = sync.syncNow(a); },
    append: appendW6, read: (a) => store.readLedger(a), log: (r) => rows.push(r),
  });
  const KEYS = new SandboxKeyProvider();
  const openStore = () => new ClaimStore({
    hiveRoot: hive, keys: KEYS, keyRecord: new FileLedgerKeyRecord(path.join(drill.home, 'ud', KEY_RECORD_FILE)), log: (r) => rows.push(r),
    onAppend: (a) => { if (RW.memoryMdReplaced(level(a)) && !importRun) importRun = watchers.ensureImported(a); },
  });
  store = openStore();
  fs.mkdirSync(path.join(drill.home, 'db'), { recursive: true });
  const idx = NativeMemoryStore.open(path.join(drill.home, 'db', 'gap.sqlite'), drill.openOpts);
  const eng = new MemoryEngine({ hiveRoot: hive, store: idx, embedder: bowEmbedder(drill.args.delayMs ?? 0), countTokens: words, watch: null, claimLedger: 'writer', implementedLevel: 'writer',
    // Andy: the 2 s file-change debounce shortened for the 'backfill' mode's memory.md edit
    ...(mode === 'backfill' ? { setTimer: (fn, ms) => setTimeout(fn, Math.min(ms, 50)) } : {}) });
  await eng.backfill();
  // Andy, Jim's SHOULD-1 (rw2): a search queued from inside the apply step runs as the very next step
  // (search outranks ingest). The markdown must already be gone then: dropping it in a step of its own
  // after the apply would let that search see the claims AND the markdown (a double hit).
  const behind = [];
  const applyClaims = idx.applyClaims.bind(idx);
  idx.applyClaims = (...args) => {
    const out = applyClaims(...args);
    behind.push(eng.search({ query: 'zeppelin hangar code', results: 10, wing: A }).then((r) => {
      const hits = Array.isArray(r.json) ? r.json : [];
      return { md: hits.filter((h) => !h.claimId && /memory\.md$/.test(String(h.source))).length, claims: hits.filter((h) => h.claimId).length };
    }));
    return out;
  };
  sync = new ClaimsIndexSync({
    readLedger: (a) => store.readLedger(a), derive: () => derive, registry: () => DEFAULT_KEY_REGISTRY,
    ruleConfig: () => ({ r4: false }), level, agents: () => [A],
    send: (args) => eng.syncClaims(args).then((json) => ({ ok: true, json }), (e) => ({ ok: false, error: String(e && e.message) })),
  });
  const seen = new Map(); // every record ever read, so a hit on a claim whose ledger was deleted still resolves
  const recs = () => { const r = store.readLedger(A).records; for (const x of r) seen.set(x.id, x); return r; };
  const textOf = (id) => { recs(); return seen.get(id)?.text ?? ''; };
  const zep = async () => {
    const r = await eng.search({ query: 'zeppelin hangar code', results: 10, wing: A });
    const hits = Array.isArray(r.json) ? r.json : [];
    const all = recs();
    return hits.some((h) => (h.claimId ? /zeppelin hangar code is twelve/.test(textOf(h.claimId)) : /memory\.md$/.test(String(h.source))));
  };
  const yak = async () => {
    const r = await eng.search({ query: 'yak barn opens', results: 10, wing: A });
    const hits = Array.isArray(r.json) ? r.json : [];
    const all = recs();
    return hits.some((h) => (h.claimId ? /yak barn opens at nine/.test(all.find((x) => x.id === h.claimId)?.text ?? '') : /memory\.md$/.test(String(h.source))));
  };
  let before, raised, shadowFile = null, yakBefore = null;
  if (mode === 'upgrade') {
    // a 1.1.87 hive: an established writer whose ledger holds everything, and no settled file
    // (1.1.87 writes none). The 1.1.88 start import appends nothing: does it still settle?
    setLevel('writer');
    const { importAtStart } = L('src/main/claims/startupImport.ts');
    const imp = () => importAtStart({ hiveRoot: hive, append: appendW6, read: (a) => store.readLedger(a), log: (r) => rows.push(r), agents: () => [A], level });
    await imp();
    const file = path.join(dir, 'memory', 'claims-import.json');
    fs.rmSync(file);
    const rep = await imp();
    const settledAfterNoop = fs.existsSync(file);
    // and a read-only run of an established ledger (a torn tail): the report says read-only
    fs.rmSync(file);
    const seg = fs.readdirSync(path.join(dir, 'memory', 'claims')).filter((n) => n.endsWith('.jsonl'))[0];
    store.close();
    fs.appendFileSync(path.join(dir, 'memory', 'claims', seg), '{"broken":\n');
    store = openStore();
    const rep2 = await imp();
    const ro = { readOnly: rep2[0]?.readOnly ?? null, settled: fs.existsSync(file) };
    // Andy: a second start with the file in place leaves it as it is (not rewritten every run).
    const kept = fs.readFileSync(file, 'utf8');
    await new Promise((r) => setTimeout(r, 20));
    await imp();
    const unchanged = fs.readFileSync(file, 'utf8') === kept;
    // Andy: a NEW ledger torn before its first record is read-only with nothing in it: no settle.
    const B = 'w2';
    const bdir = path.join(hive, 'agents', B);
    fs.mkdirSync(path.join(bdir, 'memory', 'claims'), { recursive: true });
    fs.writeFileSync(path.join(bdir, 'memory.md'), '# Memory\n\n- the walrus gate is blue\n');
    fs.writeFileSync(path.join(bdir, 'memory', 'claims', seg), '{"broken":\n');
    store.close(); store = openStore();
    const rep3 = await importAtStart({ hiveRoot: hive, append: appendW6, read: (a) => store.readLedger(a), log: (r) => rows.push(r), agents: () => [B], level: () => 'writer' });
    const torn = { readOnly: rep3[0]?.readOnly ?? null, records: store.readLedger(B).records.length, settled: fs.existsSync(path.join(bdir, 'memory', 'claims-import.json')) };
    await eng.close(); idx.close(); store.close();
    return { ok: true, mode, noop: { appended: rep[0]?.appended, offered: rep[0]?.offered, settled: settledAfterNoop }, ro, unchanged, torn };
  }
  if (mode === 'deleted') {
    // an established writer (settled, synced), then its ledger folder (or its whole memory/ folder)
    // is deleted while main still holds the anchor (A-2). What do search and the 60 s sync do?
    setLevel('writer');
    const { importAtStart } = L('src/main/claims/startupImport.ts');
    await importAtStart({ hiveRoot: hive, append: appendW6, read: (a) => store.readLedger(a), log: (r) => rows.push(r), agents: () => [A], level });
    const settled0 = fs.existsSync(path.join(dir, 'memory', 'claims-import.json'));
    await sync.syncNow(A);
    await eng.reconcileNow();
    const found0 = await zep();
    const anchoredNow = [A]; // main's anchor (claimsAnchorCheck) is not modelled by this harness: held by hand
    store.close();
    fs.rmSync(path.join(dir, 'memory', drill.args.whole ? '' : 'claims'), { recursive: true, force: true });
    store = openStore();
    await eng.setClaimLedger('writer', anchoredNow);
    await eng.reconcileNow();
    const foundDeleted = await zep();
    // Andy (SHOULD-2): A-2 keeps the claims as the source; the markdown does not swap back in.
    const hitsDeleted = (await eng.search({ query: 'zeppelin hangar code', results: 10, wing: A })).json;
    const deletedSources = { claims: hitsDeleted.filter((h) => h.claimId).length, markdown: hitsDeleted.filter((h) => !h.claimId && /memory\.md$/.test(String(h.source))).length };
    const chain = store.readLedger(A).chain;
    const syncs = [];
    for (let i = 0; i < 3; i++) {
      watchers.sync();
      const run = watchers.importing?.get?.(A);
      if (run) await run;
      if (syncP) { await syncP; syncP = null; }
      await eng.reconcileNow();
      syncs.push({ settled: fs.existsSync(path.join(dir, 'memory', 'claims-import.json')), found: await zep(), imports: rows.filter((r) => r.kind === 'claims-import').length, refusedRows: rows.filter((r) => r.kind === 'claims-import-refused').length, legacy: recs().filter((r) => r.t === 'claim' && r.source === 'legacy').length, watching: watchers.watching() });
    }
    watchers.stopAll();
    await eng.close(); idx.close(); store.close();
    return { ok: true, mode, whole: !!drill.args.whole, settled0, found0, anchoredNow, foundDeleted, deletedSources, chain: typeof chain === 'string' ? chain : JSON.stringify(chain), syncs, rowKinds: [...new Set(rows.map((r) => r.kind))] };
  }
  if (mode === 'shadow') {
    // shadow at claims start: the S0 import runs (no settled file), then a hand edit while shadow,
    // then the raise to reader. A reader writes no claims: only the 60 s sync can start the import.
    setLevel('shadow');
    const { importAtStart } = L('src/main/claims/startupImport.ts');
    await importAtStart({ hiveRoot: hive, append: appendW6, read: (a) => store.readLedger(a), log: (r) => rows.push(r), agents: () => [A], level });
    shadowFile = fs.existsSync(path.join(dir, 'memory', 'claims-import.json'));
    await eng.reconcileNow?.();
    fs.appendFileSync(path.join(dir, 'memory.md'), '- the yak barn opens at nine\n');
    await eng.reconcileNow?.();
    yakBefore = await yak();
    before = await zep();
    setLevel('reader');
    await eng.reconcileNow?.();
    raised = await zep();
    watchers.sync();
    importRun = watchers.importing?.get?.(A) ?? null;
  } else {
    before = await zep();
    setLevel('writer');
    await eng.reconcileNow?.();
    raised = await zep();
    await store.appendRecord(A, { t: 'claim', kind: 'fact', text: 'the widget review moved to friday' }, 'endpoint');
  }
  const t0 = Date.now();
  if (importRun) await importRun;
  const settled = fs.existsSync(path.join(dir, 'memory', 'claims-import.json'));
  const samples = [];
  let otherIndexed = null, otherGone = null;
  if (mode === 'backfill') {
    otherIndexed = idx.sourceShas().has('agents/w9/memory.md');
    fs.rmSync(other);
    // a worker reconcile (a watched file changed, the manifest debounce) lands before main's 300 ms sync
    await eng.backfill();
    otherGone = !idx.sourceShas().has('agents/w9/memory.md');
    samples.push({ at: Date.now() - t0, found: await zep(), phase: 'after-backfill' });
    // Andy: a memory.md edit seen by the file watcher before the sync does not remove it either
    fs.appendFileSync(path.join(dir, 'memory.md'), '- the otter dock is closed\n');
    eng.sourceChanged(path.join(dir, 'memory.md'));
    await new Promise((r) => setTimeout(r, 300));
    samples.push({ at: Date.now() - t0, found: await zep(), phase: 'after-memory-edit' });
    const r = await sync.syncNow(A);
    samples.push({ at: Date.now() - t0, found: await zep(), phase: 'after-sync', ok: r?.reply?.ok ?? r?.sent ?? null });
  } else {
    let done = false;
    const p = (syncP ?? Promise.resolve()).finally(() => { done = true; });
    // paced: back-to-back searches (priority 0) would starve the sync's ingest steps
    while (!done) { samples.push({ at: Date.now() - t0, found: await zep(), phase: 'during-sync', syncing: !!syncP }); await new Promise((r) => setTimeout(r, 15)); }
    await p;
    samples.push({ at: Date.now() - t0, found: await zep(), phase: 'after-sync' });
  }
  // Andy: after the sync the markdown itself is out of search (the claims replaced it).
  const mdAfter = (await eng.search({ query: 'zeppelin hangar code', results: 10, wing: A })).json.filter((h) => !h.claimId && /memory\.md$/.test(String(h.source))).length;
  const claimAfter = (await eng.search({ query: 'zeppelin hangar code', results: 10, wing: A })).json.filter((h) => h.claimId).length;
  const yakAfterP = yak();
  await yakAfterP;
  watchers.stopAll();
  const behindApply = await Promise.all(behind);
  await eng.close(); idx.close(); store.close();
  const misses = samples.filter((s) => !s.found);
  return {
    ok: true, mode, filler: N, before, raised, settled, shadowFile, yakBefore, yakAfter: await yakAfterP, legacyClaims: recs().filter((r) => r.t === 'claim' && r.source === 'legacy').length,
    samples: samples.length, misses: misses.length, missFrom: misses[0]?.at ?? null, missTo: misses.at(-1)?.at ?? null,
    last: samples.at(-1), phases: [...new Set(misses.map((m) => m.phase))], mdAfter, claimAfter, otherIndexed, otherGone,
    syncedDuring: samples.filter((s) => s.phase === 'during-sync').length, behindApply,
  };
};
