'use strict';
/**
 * REL-184 S0 drill (Jim option (a)): a writer agent with legacy memory.md and an archive, the start-up
 * import (claims/startupImport.ts), its FIRST claim, then the real ClaimsIndexSync into a real engine.
 * drill.args.skipImport is the control: the same run with no import.
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
  const { ClaimStore } = L('src/main/claims/store.ts');
  const { SandboxKeyProvider, FileLedgerKeyRecord, KEY_RECORD_FILE } = L('src/main/claims/keyProvider.ts');
  const { makeW6Append } = L('src/main/claims/w6Append.ts');
  const { importAtStart } = L('src/main/claims/startupImport.ts');
  const { ClaimsIndexSync } = L('src/main/claims/indexSync.ts');
  const { derive } = L('src/main/claims/derive.ts');
  const { worldView } = L('src/main/claims/world.ts');
  const { DEFAULT_KEY_REGISTRY } = L('src/main/claims/registry.ts');
  const { createClaimDelivery } = L('src/main/claims/delivery.ts');
  const hive = drill.hive;
  const A = 'w1';
  const dir = path.join(hive, 'agents', A);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory.md'), '# Memory\n\n## 2026-10-01\n- the zeppelin hangar code is twelve\n');
  fs.writeFileSync(path.join(dir, 'memory-archive-2026-09-20.md'), '# Memory\n\n## 2026-09-19\n- the gizmo relay uses crate seven\n');
  fs.writeFileSync(path.join(hive, 'memory-sources.json'), JSON.stringify({ topLevel: [], include: {}, ledger: { [A]: 'writer' } }));
  const level = (a) => (a === A ? 'writer' : 'off');

  const rows = [];
  const store = new ClaimStore({ hiveRoot: hive, keys: new SandboxKeyProvider(), keyRecord: new FileLedgerKeyRecord(path.join(drill.home, 'ud', KEY_RECORD_FILE)), log: (r) => rows.push(r) });
  // claims start: the import, before anything sees a segment
  const reports = drill.args.skipImport ? [] : await importAtStart({
    hiveRoot: hive, append: makeW6Append(store), read: (a) => store.readLedger(a), log: (r) => rows.push(r),
    agents: () => [A, 'off1'], level,
  });
  // the agent's first claim (the endpoint's note verb appends with this origin)
  const first = await store.appendRecord(A, { t: 'claim', kind: 'fact', text: 'the widget review moved to friday' }, 'endpoint');

  fs.mkdirSync(path.join(drill.home, 'db'), { recursive: true });
  const idx = NativeMemoryStore.open(path.join(drill.home, 'db', 's0.sqlite'), drill.openOpts);
  const eng = new MemoryEngine({ hiveRoot: hive, store: idx, embedder: bowEmbedder(), countTokens: words, watch: null, claimLedger: 'writer', implementedLevel: 'writer' });
  await eng.backfill();
  const sync = new ClaimsIndexSync({
    readLedger: (a) => store.readLedger(a), derive: () => derive, registry: () => DEFAULT_KEY_REGISTRY,
    ruleConfig: () => ({ r4: false }), level, agents: () => [A], send: (args) => eng.syncClaims(args),
  });
  const synced = await sync.syncAll();

  const search = async (query) => {
    const r = await eng.search({ query, results: 10, wing: A });
    const hits = Array.isArray(r.json) ? r.json : [];
    // the top hit, as the ledger text of its claim (null when it is markdown)
    const top = hits[0]?.claimId ? store.readLedger(A).records.find((x) => x.id === hits[0].claimId) : null;
    return { top: top ? `${top.source ?? ''}: ${top.text}` : null, markdown: hits.filter((h) => !h.claimId).length };
  };
  const zeppelin = await search('zeppelin hangar code');
  const gizmo = await search('gizmo relay crate');
  const widget = await search('widget review friday');

  // wake-up = the engine's wake-up plus main's W4 working set (mainWiring.handle)
  const delivery = createClaimDelivery({
    hiveRoot: () => hive, level, readLedger: (a) => store.readLedger(a), registry: () => DEFAULT_KEY_REGISTRY,
    derive, worldView, agentCwd: () => hive, tasks: () => [], usage: () => [],
    countTokens: () => (t) => Math.ceil(t.length / 4), git: async () => null,
    now: () => new Date('2026-10-08T12:00:00.000Z'), appendReceipt: () => {},
  });
  const wake = [(await eng.wakeUp(A)).text ?? '', (await delivery.workingSet(A)) ?? ''].join('\n\n');
  await eng.close(); idx.close(); store.close();

  return {
    ok: true,
    firstOk: first.ok === true,
    imported: reports.map((r) => ({ agent: r.agent, appended: r.appended, refused: r.refused.length })),
    importRows: rows.filter((r) => r.kind === 'claims-import').length,
    synced: synced.map((s) => s.sent),
    segments: store.segments(A).length,
    zeppelin, gizmo, widget,
    wake: {
      zeppelin: wake.includes('the zeppelin hangar code is twelve'),
      gizmo: wake.includes('the gizmo relay uses crate seven'),
      widget: wake.includes('the widget review moved to friday'),
    },
  };
};
