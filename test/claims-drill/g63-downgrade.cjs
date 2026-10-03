'use strict';
/**
 * CLAIM-LEDGER W6 drill script (G6.3, G6.3b): runs INSIDE the target build's tree under Andy's
 * Electron-as-Node runner (test/claims-drill/runner.cjs, C4), against a sandbox hive W6 prepared.
 *
 * It does what the older build does at its next start, with the older build's OWN code:
 *   1. the spawn-time rollover of every agent's memory.md (memoryRollover.ts);
 *   2. a full index of the hive with its own engine (sources allow-list, chunker, MiniLM, sqlite-vec);
 *   3. its own `memory search` for every checklist item.
 * Before counting anything it proves the drill is real (F7): the harness started, the home is jailed,
 * and the model is loaded after the first embed. A missing piece throws, which FAILS the drill.
 *
 * args: { checklist: [{ agent, query, expect }], lessons: { <agent>: [<lesson text>] } }
 * returns: { total, found, missing, lessonsIntact, sources, rolled }
 */
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

module.exports = async function g63(drill) {
  drill.assert.harnessStarted();
  drill.assert.homeJailed();
  const treeRequire = createRequire(path.join(drill.tree, 'package.json'));
  const Database = treeRequire('better-sqlite3');
  const ort = treeRequire('onnxruntime-node');
  const { rolloverMemory } = drill.loadTs('src/main/memoryRollover.ts');
  const { discoverSources } = drill.loadTs('src/main/nativeMemory/sources.ts');
  const { NativeMemoryStore } = drill.loadTs('src/main/nativeMemory/store.ts');
  const { MemoryEngine } = drill.loadTs('src/main/nativeMemory/engine.ts');
  const { WordPieceTokenizer, wordPieceConfigFromTokenizerJson } = drill.loadTs('src/main/nativeMemory/wordpiece.ts');
  const { OnnxEmbedder } = drill.loadTs('src/main/nativeMemory/embedder.ts');

  // 1. The older build's spawn-time rollover, for every agent.
  const agentsDir = path.join(drill.hive, 'agents');
  const rolled = {};
  for (const id of fs.readdirSync(agentsDir)) {
    const r = rolloverMemory(path.join(agentsDir, id), Date.parse('2026-10-10T12:00:00Z'));
    rolled[id] = !!r.rotated;
  }
  const lessonsIntact = {};
  for (const [id, lessons] of Object.entries(drill.args.lessons || {})) {
    const md = fs.readFileSync(path.join(agentsDir, id, 'memory.md'), 'utf8');
    lessonsIntact[id] = /^## How I work \(standing lessons\)/m.test(md) && lessons.every((l) => md.includes(l));
  }

  // 2. A full index with the older build's own engine and the real model.
  const tok = new WordPieceTokenizer(wordPieceConfigFromTokenizerJson(JSON.parse(fs.readFileSync(path.join(drill.modelDir, 'tokenizer.json'), 'utf8'))));
  const embedder = new OnnxEmbedder(path.join(drill.modelDir, 'onnx', 'model.onnx'), tok, ort, { intraOpNumThreads: 2 });
  await embedder.embed(['a first embed proves the model is loaded']);
  drill.assert.modelLoaded(embedder);
  const store = NativeMemoryStore.open(path.join(drill.hive, 'hive.sqlite'), { Database, vecPath: drill.vecPath, vecSha256: drill.vecSha256 });
  const words = (s) => s.split(/\s+/).filter(Boolean).length;
  const eng = new MemoryEngine({ hiveRoot: drill.hive, store, embedder, countTokens: words, mode: () => 'native', watch: null, setTimer: (fn) => setImmediate(fn), clearTimer: () => {} });
  await eng.backfill();
  const sources = discoverSources(drill.hive).eligible.length;

  // 3. Its own search, per checklist item.
  const missing = [];
  let found = 0;
  for (const item of drill.args.checklist) {
    const r = await eng.search({ query: item.query, results: 10 });
    if (r.exit === 0 && r.text.includes(item.expect)) found++;
    else missing.push(item);
  }
  await eng.close();
  return { total: drill.args.checklist.length, found, missing, lessonsIntact, sources, rolled };
};
