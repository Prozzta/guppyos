'use strict';
/**
 * CL-READERWATCHER (god 886ed8) drill: an agent becomes a writer WHILE THE APP RUNS. At claims start
 * it is off (no S0 import); then memory-sources.json makes it a writer and it writes its first claim.
 * Its memory.md and archive notes must never leave search: discovery keeps them until the agent's
 * import has settled, and after it they are found as imported claims.
 * main's wiring is modelled here: the store's onAppend starts the import (ReaderWatchers.ensureImported)
 * and onSettled syncs the index. A tree without readerWatch.ts (v1.1.87) has no such wiring.
 * drill.args.hold: hold the import's appends until the "during" searches are done.
 * Invented text only; the result carries facts the test asserts on.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DIM = 384;
function bowEmbedder() {
  return {
    loaded: true,
    embed: async (texts) => texts.map((t) => {
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
    }),
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
  const { importAtStart } = L('src/main/claims/startupImport.ts');
  const { ClaimsIndexSync } = L('src/main/claims/indexSync.ts');
  const { derive } = L('src/main/claims/derive.ts');
  const { DEFAULT_KEY_REGISTRY } = L('src/main/claims/registry.ts');
  let RW = null;
  if (fs.existsSync(path.join(drill.tree, 'src/main/claims/readerWatch.ts'))) RW = L('src/main/claims/readerWatch.ts');
  const hive = drill.hive;
  const A = 'w1';
  const dir = path.join(hive, 'agents', A);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory.md'), '# Memory\n\n## 2026-10-01\n- the zeppelin hangar code is twelve\n');
  fs.writeFileSync(path.join(dir, 'memory-archive-2026-09-20.md'), '# Memory\n\n## 2026-09-19\n- the gizmo relay uses crate seven\n');
  const setLevel = (lv) => fs.writeFileSync(path.join(hive, 'memory-sources.json'), JSON.stringify({ topLevel: [], include: {}, ledger: lv ? { [A]: lv } : {} }));
  setLevel(null);
  // main's claimLevel: the manifest entry (read on every call), capped by the writer setting.
  const level = (a) => readSourcesConfig(hive).ledger?.[a] ?? 'off';

  const rows = [];
  let gate = null;
  const held = new Promise((resolve) => { gate = resolve; });
  if (!drill.args.hold) gate();
  let store;
  const appendW6 = (...a) => makeW6Append(store)(...a);
  // the import's appends wait on the gate (the S0 import of a big memory.md takes a while)
  const ingest = { append: async (...a) => { await held; return appendW6(...a); }, read: (a) => store.readLedger(a), log: (r) => rows.push(r) };
  let sync = null;
  let importRun = null;
  const watchers = RW && typeof RW.ReaderWatchers.prototype.ensureImported === 'function'
    ? new RW.ReaderWatchers({ hiveRoot: () => hive, agents: () => (store.segments(A).length ? [A] : []), candidates: () => [A], level, debounceMs: 100, onSettled: (a) => { void sync.syncNow(a); }, ...ingest })
    : null;
  store = new ClaimStore({
    hiveRoot: hive, keys: new SandboxKeyProvider(), keyRecord: new FileLedgerKeyRecord(path.join(drill.home, 'ud', KEY_RECORD_FILE)), log: (r) => rows.push(r),
    // main's onAppend: start the import of an unsettled reader or writer (this tree's wiring, if any)
    onAppend: (a) => { if (watchers && RW.memoryMdReplaced(level(a)) && !importRun) importRun = watchers.ensureImported(a); },
  });

  // claims start: the S0 import, with w1 still off
  const startReports = await importAtStart({ hiveRoot: hive, append: appendW6, read: (a) => store.readLedger(a), log: (r) => rows.push(r), agents: () => [A], level });

  fs.mkdirSync(path.join(drill.home, 'db'), { recursive: true });
  const idx = NativeMemoryStore.open(path.join(drill.home, 'db', 'midrun.sqlite'), drill.openOpts);
  const eng = new MemoryEngine({ hiveRoot: hive, store: idx, embedder: bowEmbedder(), countTokens: words, watch: null, claimLedger: 'writer', implementedLevel: 'writer' });
  await eng.backfill();
  // main's send goes over the worker RPC: a refusal is a reply, not a throw
  sync = new ClaimsIndexSync({
    readLedger: (a) => store.readLedger(a), derive: () => derive, registry: () => DEFAULT_KEY_REGISTRY,
    ruleConfig: () => ({ r4: false }), level, agents: () => [A],
    send: (args) => eng.syncClaims(args).then((json) => ({ ok: true, json }), (e) => ({ ok: false, error: String(e && e.message) })),
  });
  const search = async (query) => {
    const r = await eng.search({ query, results: 10, wing: A });
    const hits = Array.isArray(r.json) ? r.json : [];
    const recs = store.readLedger(A).records;
    const claim = (h) => recs.find((x) => x.id === h.claimId);
    const top = hits[0]?.claimId ? claim(hits[0]) : null;
    // a hit as its claim's text, or (JSON hits carry no content) the markdown file it came from
    const texts = hits.map((h) => (h.claimId ? claim(h)?.text ?? '' : `file:${String(h.source).split(/[\/]/).pop()}`));
    return { top: top ? `${top.source ?? ''}: ${top.text}` : (hits[0] ? texts[0] : null), markdown: hits.filter((h) => !h.claimId).length, found: (re, file) => texts.some((t) => re.test(t) || t === `file:${file}`) };
  };
  const look = async () => {
    const z = await search('zeppelin hangar code'); const g = await search('gizmo relay crate'); const w = await search('widget review friday');
    return { zeppelin: z.found(/zeppelin hangar code is twelve/, 'memory.md'), gizmo: g.found(/gizmo relay uses crate seven/, 'memory-archive-2026-09-20.md'), widget: w.found(/widget review moved to friday/), zeppelinTop: z.top, gizmoTop: g.top, widgetTop: w.top, markdown: z.markdown + g.markdown };
  };
  const before = await look();

  // MID-RUN: the hand edit that makes w1 a writer, then its first claim (the endpoint's note verb)
  setLevel('writer');
  await eng.reconcileNow?.();
  const raised = await look();
  const first = await store.appendRecord(A, { t: 'claim', kind: 'fact', text: 'the widget review moved to friday' }, 'endpoint');
  // what main does next: the index sync of the appended claim, and the worker's discovery
  const syncedDuring = (await sync.syncAll()).map((s) => (s.sent ? s.reply?.ok === true : false));
  await eng.backfill();
  const during = await look();
  const settledDuring = fs.existsSync(path.join(dir, 'memory', 'claims-import.json'));

  gate();
  if (importRun) await importRun;
  await new Promise((r) => setTimeout(r, 50));
  const syncedAfter = (await sync.syncAll()).map((s) => (s.sent ? s.reply?.ok === true : false));
  await eng.backfill();
  const after = await look();
  const legacyClaims = store.readLedger(A).records.filter((r) => r.t === 'claim' && r.source === 'legacy').length;
  watchers?.stopAll();
  await eng.close(); idx.close(); store.close();

  return {
    ok: true,
    wired: !!watchers,
    firstOk: first.ok === true,
    startImported: startReports.length,
    legacyClaims,
    settledDuring,
    settledAfter: fs.existsSync(path.join(dir, 'memory', 'claims-import.json')),
    syncedDuring, syncedAfter,
    before, raised, during, after,
    importRows: rows.filter((r) => r.kind === 'claims-import').length,
  };
};
