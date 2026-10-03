'use strict';
/**
 * CLAIM-LEDGER G3.6 (F6), run by runner.cjs INSIDE an old build's tree (1.1.83): that build's own
 * engine, against a user-data memory folder that holds the new build's v2 index file and the old
 * build's own index, now STALE (the hive changed after it was written). The old engine must
 * rebuild/reconcile ITS OWN file cleanly, find what is in the hive now and nothing that was
 * removed, and leave the v2 file byte-unchanged (it never opens it). Also the worked example of a
 * drill script for W6.
 *
 * args: { oldDb, v2File, steps: { remove: [rel], append: { rel, text } }, find, findMarker, gone, goneMarker }
 * (a marker is a word in the content that is not in the query: the reply text echoes the query)
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const words = (t) => t.split(/\s+/).filter(Boolean).length;

module.exports = async (drill) => {
  drill.assert.harnessStarted();
  drill.assert.homeJailed();
  const a = drill.args;
  const { NativeMemoryStore } = drill.loadTs('src/main/nativeMemory/store.ts');
  const { MemoryEngine } = drill.loadTs('src/main/nativeMemory/engine.ts');
  const v2Before = sha(a.v2File);
  const embedder = drill.makeEmbedder();
  const engineOn = (dbFile) => {
    const store = NativeMemoryStore.open(dbFile, drill.openOpts);
    const eng = new MemoryEngine({ hiveRoot: drill.hive, store, embedder, countTokens: words, mode: () => 'native', watch: null });
    // Real timers (Creed): an immediate setTimer fires the idle model unload at once (a race).
    eng.storeOpenOptions = drill.openOpts;
    return { store, eng };
  };

  // 1. The old build indexes the hive as it was (its own file, written while it was installed).
  let { store, eng } = engineOn(a.oldDb);
  const first = await eng.backfill();
  await drill.assert.modelLoaded(embedder);
  await eng.close();
  store.close();

  // 2. Life goes on under the new build: sources change; the old index is now stale.
  for (const rel of a.steps.remove) fs.rmSync(path.join(drill.hive, rel), { force: true });
  fs.appendFileSync(path.join(drill.hive, a.steps.append.rel), a.steps.append.text);

  // 3. The downgrade: the old build starts again on its stale file and reconciles it.
  ({ store, eng } = engineOn(a.oldDb));
  const second = await eng.backfill();
  const found = await eng.search({ query: a.find, results: 5 });
  const gone = await eng.search({ query: a.gone, results: 5 });
  const counts = store.counts();
  await eng.close();
  store.close();

  const body = (r) => String(r.text ?? '').replace(/Results for: ".*"/, '');
  const sources = (r) => (Array.isArray(r.json) ? r.json.map((h) => String(h.source)) : []);
  const memDir = path.dirname(a.oldDb);
  return {
    firstEmbedded: first.embedded,
    secondRemoved: second.removed,
    secondEmbedded: second.embedded,
    foundExit: found.exit,
    foundNew: body(found).includes(a.findMarker),
    goneFound: body(gone).includes(a.goneMarker),
    goneSources: sources(gone).filter((s) => a.steps.remove.some((r) => s.replace(/\\/g, '/').endsWith(r))),
    counts,
    v2Unchanged: sha(a.v2File) === v2Before,
    memDirFiles: fs.readdirSync(memDir).sort(),
  };
};
