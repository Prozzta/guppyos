'use strict';
/**
 * CLAIM-LEDGER G3.2, the drill script (run in BOTH trees by g32.test.cjs through the C4 runner):
 * index the sandbox copy of the full corpus with the tree's own engine and the REAL model, then
 * time the default search (engine.search: query embed + FTS + vec + fusion), warm.
 *   args.claims = true (the new build): every flagged agent's memory.md bullets become claim chunks
 *   (one bullet = one claim, all live), as after the S0 import; its markdown memory leaves the index.
 * Returns the latency samples' p50/p95 and the corpus counts.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

module.exports = async (drill) => {
  drill.assert.harnessStarted();
  drill.assert.homeJailed();
  const a = drill.args;
  const { NativeMemoryStore } = drill.loadTs('src/main/nativeMemory/store.ts');
  const { MemoryEngine } = drill.loadTs('src/main/nativeMemory/engine.ts');
  const tokenizer = (() => {
    const { WordPieceTokenizer, wordPieceConfigFromTokenizerJson } = drill.loadTs('src/main/nativeMemory/wordpiece.ts');
    return new WordPieceTokenizer(wordPieceConfigFromTokenizerJson(JSON.parse(fs.readFileSync(path.join(drill.modelDir, 'tokenizer.json'), 'utf8'))));
  })();
  const embedder = drill.makeEmbedder();
  const store = NativeMemoryStore.open(path.join(drill.home, 'g32.sqlite'), drill.openOpts);
  const eng = new MemoryEngine({ hiveRoot: drill.hive, store, embedder, countTokens: (t) => tokenizer.count(t), watch: null, ...(a.claims ? { claimLedger: 'reader', implementedLevel: 'writer' } : {}) });
  const t0 = Date.now();
  await eng.backfill();
  await drill.assert.modelLoaded(embedder);
  let claimCount = 0;
  if (a.claims) {
    const { withParts } = drill.loadTs('src/main/claims/chunks.ts');
    for (const agent of a.claimAgents) {
      const bullets = a.bullets[agent] ?? [];
      const chunks = bullets.map((text, i) => {
        const content = `fact · - · 2026-10-03\n${text}`;
        return { claimId: `c-${crypto.createHash('sha256').update(`${agent}#${i}`).digest('hex').slice(0, 12)}`, wing: agent, kind: 'fact', ckey: null, at: '2026-10-03T10:00:00.000Z', status: 'live', content, contentSha256: crypto.createHash('sha256').update(content).digest('hex') };
      });
      claimCount += chunks.length;
      await eng.syncClaims({ wing: agent, path: `agents/${agent}/memory/claims`, head: 'h', chunks: withParts(chunks) });
    }
  }
  const buildMs = Date.now() - t0;
  for (const q of a.queries.slice(0, 10)) await eng.search({ query: q, results: 5 });   // warm-up
  const samples = [];
  let found = 0;
  for (const q of a.queries) {
    const s = process.hrtime.bigint();
    const r = await eng.search({ query: q, results: 5 });
    samples.push(Number(process.hrtime.bigint() - s) / 1e6);
    // G3.5 proxy: the phrase the query was cut from is in a top-5 hit (the header echoes the query: strip it).
    const body = String(r.text ?? '').split(/\r?\n/).filter((l) => !l.includes('Results for:')).join(' ').toLowerCase();
    if (body.includes(q.toLowerCase())) found++;
  }
  samples.sort((x, y) => x - y);
  const pct = (p) => samples[Math.min(samples.length - 1, Math.floor(p * samples.length))];
  const counts = store.counts();
  await eng.close();
  store.close();
  return { queries: samples.length, p50: pct(0.5), p95: pct(0.95), max: samples[samples.length - 1], counts, claimCount, buildMs, foundRate: found / samples.length };
};
