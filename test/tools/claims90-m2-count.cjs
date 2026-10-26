'use strict';
/*
 * CLAIMS-90 L6 M2 (god 3dc16a): over a file of search queries ({arm, query, flags} per JSON line), how many show the
 * brief of every card or release the query names, in the text the agent READS: this build's search (as
 * claims90-search.cjs: the index copy, the real model, store.search, the hive's briefs, formatSearch), then the
 * tool-output condenser as the answer child applies it (the default cap, a memory search is not a read command).
 * `before` is the same text condensed with its search header masked (no brief block kept, as before M2).
 * Counts only.
 *
 * Run UNDER ELECTRON AS NODE (see claims90-search.cjs):
 *   <electron.exe> test/tools/claims90-m2-count.cjs --db <index.sqlite> --hive <root> --queries <file> [--model <dir>] [--out <file>]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO = path.resolve(__dirname, '..', '..');
const argv = process.argv.slice(2);
const val = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const outFile = val('--out');
const say = (s) => { process.stdout.write(s); if (outFile) fs.appendFileSync(outFile, s); };

(async () => {
  const db = val('--db'); const hive = val('--hive'); const qfile = val('--queries');
  if (!db || !hive || !qfile) { console.error('usage: --db <index> --hive <root> --queries <file> [--model dir] [--out f]'); process.exit(2); }
  if (outFile) fs.writeFileSync(outFile, '');
  const loadTs = require(path.join(REPO, 'test', 'load-ts.cjs'));
  const Database = require('better-sqlite3');
  const ort = require('onnxruntime-node');
  const sqliteVec = require('sqlite-vec');
  const { NativeMemoryStore } = loadTs('src/main/nativeMemory/store.ts');
  const { dropStale, staleFetchK } = loadTs('src/main/nativeMemory/engine.ts');
  const { WordPieceTokenizer, wordPieceConfigFromTokenizerJson } = loadTs('src/main/nativeMemory/wordpiece.ts');
  const { OnnxEmbedder } = loadTs('src/main/nativeMemory/embedder.ts');
  const C = loadTs('src/main/toolOutputCondense.ts');
  const { targetIndex, targetsIn } = loadTs('src/main/claims/searchTargets.ts');
  const { readLedgers, readTasks, hiveCardLead, searchTextOver } = require(path.join(REPO, 'test', 'tools', 'claims90-hive-read.cjs'));
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO, 'resources', 'models', 'native-memory-manifest.json'), 'utf8'));
  const modelDir = val('--model', path.join(REPO, 'resources', 'models', manifest.model.dir));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claims90-m2-'));
  const file = path.join(tmp, path.basename(db));
  fs.copyFileSync(db, file);
  for (const side of ['-wal', '-shm']) if (fs.existsSync(db + side)) fs.copyFileSync(db + side, file + side);
  for (const f of [file, file + '-wal', file + '-shm']) { try { if (fs.existsSync(f)) fs.chmodSync(f, 0o600); } catch { /* best effort */ } }
  const vecPath = sqliteVec.getLoadablePath();
  const store = NativeMemoryStore.open(file, { Database, vecPath, vecSha256: crypto.createHash('sha256').update(fs.readFileSync(vecPath)).digest('hex') });
  const tok = new WordPieceTokenizer(wordPieceConfigFromTokenizerJson(JSON.parse(fs.readFileSync(path.join(modelDir, 'tokenizer.json'), 'utf8'))));
  const emb = new OnnxEmbedder(path.join(modelDir, 'onnx', 'model.onnx'), tok, ort, { intraOpNumThreads: 2 });

  const ix = targetIndex(readTasks(hive).map((t) => t && t.id), Object.values(readLedgers(hive)).flat().filter((r) => r.t === 'claim').map((r) => r.key));
  const lead = hiveCardLead(hive);
  const cap = C.capForCommand('memory search', C.effectiveCap(undefined));
  const rows = fs.readFileSync(qfile, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const shows = (text, id, items) => {
    const ls = text.split('\n').map((l) => l.trim());
    const at = ls.indexOf(id);
    return at >= 0 && ls.slice(at + 1, at + 1 + items.length).every((l, k) => l.length > 0 && items[k].startsWith(l.replace(/…$/, '')));
  };
  const t = { rows: 0, named: 0, condensed: 0, rawAll: 0, beforeAll: 0, afterAll: 0, fullRows: 0, fullCondensed: 0, fullBefore: 0, fullAfter: 0 };
  for (const r of rows) {
    const fl = r.flags ?? [];
    const opt = (f) => { const i = fl.indexOf(f); return i >= 0 ? fl[i + 1] : null; };
    const flags = { wing: opt('--wing'), room: opt('--room'), since: null, before: null, full: fl.includes('--full'), exact: false, newest: fl.includes('--newest') };
    const results = Number(opt('--results') ?? '5') || 5;
    const mode = fl.includes('--all') ? 'all' : fl.includes('--history') ? 'history' : 'live';
    process.env.C90_HIDE_STALE = r.arm === 'OFF' ? '0' : '1';
    const [queryVec] = await emb.embed([r.query]);
    let hits = store.search({ query: r.query, queryVec, wing: flags.wing, room: flags.room, sinceMs: null, beforeMs: null, k: staleFetchK(results, mode), poolK: results, mode, kind: null, key: null });
    hits = dropStale(hits, mode, results);
    const text = await searchTextOver(hive, r.query, flags, hits);
    const named = [];
    for (const x of targetsIn([r.query], ix)) { const rep = await lead([x.term]); const b = (rep.briefs ?? rep)[x.term.toLowerCase()]; if (b && b.length) named.push([x.term.toLowerCase(), b.slice(0, 12)]); }
    t.rows++;
    if (flags.full) t.fullRows++;
    if (!named.length) continue;
    t.named++;
    const condense = (s) => (C.shouldCondense('Bash', { command: 'memory search' }, { stdout: s }, cap) ? C.condenseOutput({ text: s, cap, path: 'C:/p/t.txt' }) : s);
    const isC = C.shouldCondense('Bash', { command: 'memory search' }, { stdout: text }, cap);
    const after = condense(text);
    const before = condense(text.replace(/Results for: "/, 'Results-for: "')).replace(/Results-for: "/, 'Results for: "');
    const all = (s) => named.every(([id, items]) => shows(s, id, items));
    if (isC) t.condensed++;
    if (all(text)) t.rawAll++;
    if (all(before)) t.beforeAll++;
    if (all(after)) t.afterAll++;
    if (flags.full) { if (isC) t.fullCondensed++; if (all(before)) t.fullBefore++; if (all(after)) t.fullAfter++; }
  }
  say(`${JSON.stringify(t)}\n`);
  try { await emb.unload(); } catch { /* none */ }
  try { store.db.close(); } catch { /* none */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* none */ }
})().catch((e) => { console.error(e && e.stack ? e.stack : String(e)); process.exit(1); });
