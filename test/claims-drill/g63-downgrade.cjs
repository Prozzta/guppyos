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
 * args: { checklist: [{ agent, query, expect }], lessons: { <agent>: [<lesson text>] }, absent: [<token in no file>] }
 * returns: { total, found, missing, absentFound, lessonsIntact, sources, rolled }
 */
const fs = require('fs');
const path = require('path');

module.exports = async function g63(drill) {
  drill.assert.harnessStarted();
  drill.assert.homeJailed();
  const { rolloverMemory } = drill.loadTs('src/main/memoryRollover.ts');
  const { discoverSources } = drill.loadTs('src/main/nativeMemory/sources.ts');
  const { NativeMemoryStore } = drill.loadTs('src/main/nativeMemory/store.ts');
  const { MemoryEngine } = drill.loadTs('src/main/nativeMemory/engine.ts');

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

  // 2. A full index with the older build's own engine and the real model (its own index file, in the jailed user data).
  const embedder = drill.makeEmbedder();
  const memDir = path.join(drill.home, 'AppData', 'Roaming', 'drill-user-data', 'memory');
  fs.mkdirSync(memDir, { recursive: true });
  const store = NativeMemoryStore.open(path.join(memDir, 'hive.sqlite'), drill.openOpts);
  // chunk sizes as the real app counts them (worker.ts: countTokens = the WordPiece tokenizer), not words
  const { WordPieceTokenizer, wordPieceConfigFromTokenizerJson } = drill.loadTs('src/main/nativeMemory/wordpiece.ts');
  const tok = new WordPieceTokenizer(wordPieceConfigFromTokenizerJson(JSON.parse(fs.readFileSync(path.join(drill.modelDir, 'tokenizer.json'), 'utf8'))));
  const eng = new MemoryEngine({ hiveRoot: drill.hive, store, embedder, countTokens: (t) => tok.count(t), mode: () => 'native', watch: null });
  // the engine's default timers: a setImmediate stand-in ignores the delay, so the idle unload would drop the model between searches
  await eng.backfill();
  await drill.assert.modelLoaded(embedder);
  const sources = discoverSources(drill.hive).eligible.length;

  // 3. Its own search, per checklist item.
  const missing = [];
  let found = 0;
  // the reply echoes the query ('Results for: "<query>"'); only the hits count
  const hits = async (query) => {
    const r = await eng.search({ query, results: 10 });
    return { exit: r.exit, body: String(r.text ?? '').replace(/Results for: ".*"/, '').replace(/\s+/g, ' ') };
  };
  for (const item of drill.args.checklist) {
    const r = await hits(item.query);
    if (r.exit === 0 && r.body.includes(item.expect.replace(/\s+/g, ' '))) found++;
    else missing.push(item);
  }
  // control: a token in no file must NOT count as found (proves the echo is not counted)
  const absentFound = [];
  for (const t of drill.args.absent || []) if ((await hits(t)).body.includes(t)) absentFound.push(t);
  await eng.close();   // clears the idle-unload timer and unloads the model
  return { total: drill.args.checklist.length, found, missing, absentFound, lessonsIntact, sources, rolled };
};
