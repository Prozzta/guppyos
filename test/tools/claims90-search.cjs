'use strict';
/*
 * CLAIMS-90 M3: this build's `memory search` over a GIVEN index file, offline (the auditor's fix-2 replay
 * against the frozen T_s index). No app, no HTTP, no hive discovery: the store is opened from a COPY of the
 * file (so a frozen snapshot is never written), the query is embedded with the real model, store.search runs
 * exactly as the engine runs it, and formatSearch prints the text agents read.
 *
 * Run UNDER ELECTRON AS NODE (the app's better-sqlite3 and sqlite-vec are Electron-ABI builds):
 *   set ELECTRON_RUN_AS_NODE=1
 *   <electron.exe> test/tools/claims90-search.cjs --db <index.sqlite> --query "<q>"
 *        [--wing <agentId>] [--room <room>] [--results N] [--key <key>] [--kind <kind>] [--history | --all]
 *        [--exact] [--newest] [--hive <hiveRoot>] [--full] [--json] [--out <file>] [--model <dir>] [--in-place]
 *   <electron.exe> = require('./test/electron-harness/electron-bin.cjs').harnessElectron() in the repo.
 *
 * Output: the search text on stdout (`--json`: {query, flags, hits: redacted hits, text}); `--out <file>` also
 * writes it (Electron's stdout is not reliable on Windows). Exit 0 ok, 2 usage, 1 error (message on stderr and
 * in --out). `--in-place` opens the file itself (a scratch db, never a snapshot). The model dir defaults to the
 * repo's resources/models/<manifest dir>. CLAIMS-90 R2 (C90-GET): `--exact` runs store.searchExact (no embedding) plus
 * the PROTOCOL.md / board.md line scan of `--hive <root>` (none without --hive); `--newest` prints the newest-first order
 * and the JSON rows carry rankNewest / rankCurrent, as the engine does. The copy is made writable (a frozen snapshot
 * is often read-only; SQLite needs to open it rw for its WAL).
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const outFile = val('--out');
const emit = (text, code) => { if (outFile) fs.writeFileSync(outFile, text); if (code === 0) process.stdout.write(text); else process.stderr.write(text); process.exitCode = code; };

const db = val('--db');
const query = val('--query');
if (!db || !query) { emit('usage: claims90-search.cjs --db <index.sqlite> --query "<q>" [--wing id] [--room r] [--results N] [--key k] [--kind k] [--history|--all] [--exact] [--newest] [--hive root] [--full] [--json] [--out f] [--model dir] [--in-place]\n', 2); process.exit(2); }

(async () => {
  let store = null; let emb = null; let tmp = null;
  try {
    const loadTs = require(path.join(REPO, 'test', 'load-ts.cjs'));
    const Database = require('better-sqlite3');
    const ort = require('onnxruntime-node');
    const sqliteVec = require('sqlite-vec');
    const { NativeMemoryStore } = loadTs('src/main/nativeMemory/store.ts');
    const { redactHit, exactNeedle, exactFileHits } = loadTs('src/main/nativeMemory/engine.ts');
    const { formatSearch, newestOrder, rankHits } = loadTs('src/main/nativeMemory/format.ts');
    const { WordPieceTokenizer, wordPieceConfigFromTokenizerJson } = loadTs('src/main/nativeMemory/wordpiece.ts');
    const { OnnxEmbedder } = loadTs('src/main/nativeMemory/embedder.ts');
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'resources', 'models', 'native-memory-manifest.json'), 'utf8'));
    const modelDir = val('--model', path.join(REPO, 'resources', 'models', manifest.model.dir));

    // The index: a copy by default, so the given file (a frozen snapshot) is never written to.
    let file = db;
    if (!has('--in-place')) {
      if (!fs.existsSync(db)) throw new Error(`index not found: ${db}`);
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claims90-search-'));
      file = path.join(tmp, path.basename(db));
      fs.copyFileSync(db, file);
      for (const side of ['-wal', '-shm']) if (fs.existsSync(db + side)) fs.copyFileSync(db + side, file + side);
      for (const f of [file, file + '-wal', file + '-shm']) { try { if (fs.existsSync(f)) fs.chmodSync(f, 0o600); } catch { /* best effort */ } }
    }
    const vecPath = sqliteVec.getLoadablePath();
    const vecSha256 = crypto.createHash('sha256').update(fs.readFileSync(vecPath)).digest('hex');
    store = NativeMemoryStore.open(file, { Database, vecPath, vecSha256 });

    const flags = { wing: val('--wing'), room: val('--room'), since: val('--since'), before: val('--before'), full: has('--full'), exact: has('--exact'), newest: has('--newest') };
    const results = Number(val('--results', '5'));
    const mode = has('--all') ? 'all' : has('--history') ? 'history' : 'live';
    let hits;
    if (flags.exact) {
      const needle = exactNeedle(query);
      const hiveRoot = val('--hive');
      const chunks = needle ? store.searchExact({ query: needle, wing: flags.wing, room: flags.room, sinceMs: flags.since ? Date.parse(flags.since) : null, beforeMs: flags.before ? Date.parse(flags.before) : null, k: results, mode, kind: val('--kind'), key: val('--key') }) : [];
      const files = needle && hiveRoot && !flags.wing && !flags.room && !val('--kind') && !val('--key') ? exactFileHits(hiveRoot, needle, results) : [];
      hits = [...chunks, ...files];
    } else {
      const tok = new WordPieceTokenizer(wordPieceConfigFromTokenizerJson(JSON.parse(fs.readFileSync(path.join(modelDir, 'tokenizer.json'), 'utf8'))));
      emb = new OnnxEmbedder(path.join(modelDir, 'onnx', 'model.onnx'), tok, ort, { intraOpNumThreads: 2 });
      const [queryVec] = await emb.embed([query]);
      hits = store.search({ query, queryVec, wing: flags.wing, room: flags.room, sinceMs: flags.since ? Date.parse(flags.since) : null, beforeMs: flags.before ? Date.parse(flags.before) : null, k: Number.isFinite(results) && results > 0 ? results : 5, mode, kind: val('--kind'), key: val('--key') });
    }
    const json = flags.newest ? (() => { const cur = rankHits(query, hits); return newestOrder(query, hits).map((h, i) => ({ ...redactHit(h), rankNewest: i + 1, rankCurrent: cur.indexOf(h) + 1 })); })() : hits.map(redactHit);
    const text = formatSearch(query, flags, hits);
    emit(has('--json') ? `${JSON.stringify({ query, flags: { ...flags, results, mode, kind: val('--kind'), key: val('--key') }, hits: json, text })}\n` : text, 0);
  } catch (e) {
    emit(`claims90-search: ${e && e.stack ? e.stack : String(e)}\n`, 1);
  } finally {
    try { if (emb) await emb.unload(); } catch { /* none */ }
    try { if (store) store.db.close(); } catch { /* none */ }
    if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* none */ } }
  }
})();
