'use strict';
/*
 * GUPPY-NODE-LTS (better-sqlite3 11 -> 12, SQLite 3.49 -> 3.53): the engine behaviours the memory
 * store relies on, checked on the REAL shipped driver. Run UNDER ELECTRON AS NODE, because the
 * app's better-sqlite3 is built for Electron's ABI, with the pinned sqlite-vec DLL.
 *
 *   electron.exe harness.cjs <out.json> <scratch dir>
 *
 * Only temp databases under <scratch>, built from the fixtures below: never a hive or app DB.
 * Writes { ok, ...facts } or { ok:false, error } to out.json (Electron's stdout is not reliable
 * on Windows). test/sqlite-engine-105.test.cjs asserts on it.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const [outFile, scratch] = process.argv.slice(2);
const REPO = path.resolve(__dirname, '..', '..');
process.chdir(REPO);
const loadTs = require(path.join(REPO, 'test', 'load-ts.cjs'));
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');
const { NativeMemoryStore, ftsQuery } = loadTs('src/main/nativeMemory/store.ts');

const vecPath = sqliteVec.getLoadablePath();
const f32 = (a) => Buffer.from(new Float32Array(a).buffer);
const size = (p) => (fs.existsSync(p) ? fs.statSync(p).size : null);

function versions() {
  const db = new Database(':memory:');
  db.loadExtension(vecPath);
  const r = { sqlite: db.prepare('select sqlite_version() v').get().v, vec: db.prepare('select vec_version() v').get().v,
    driver: require('better-sqlite3/package.json').version, abi: process.versions.modules, electron: process.versions.electron || null };
  db.close();
  return r;
}

/** FTS5 with the store's own external-content schema and triggers, queried the store's way. */
function fts() {
  const db = new Database(path.join(scratch, 'fts.sqlite'));
  db.exec(`
    CREATE TABLE chunks(chunk_id INTEGER PRIMARY KEY, content TEXT NOT NULL);
    CREATE VIRTUAL TABLE chunks_fts USING fts5(content, content='chunks', content_rowid='chunk_id');
    CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, content) VALUES (new.chunk_id, new.content); END;
    CREATE TRIGGER chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES ('delete', old.chunk_id, old.content); END;
    CREATE TRIGGER chunks_au AFTER UPDATE OF content ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES ('delete', old.chunk_id, old.content);
      INSERT INTO chunks_fts(rowid, content) VALUES (new.chunk_id, new.content); END;`);
  const ins = db.prepare('insert into chunks(chunk_id, content) values (?, ?)');
  ins.run(1, 'the kraken release rotates the logs');
  ins.run(2, 'kraken kraken kraken attack');
  ins.run(3, 'bananas are yellow');
  const q = ftsQuery('Kraken!');
  const ranked = () => db.prepare('select c.chunk_id id, bm25(chunks_fts) s from chunks_fts join chunks c on c.chunk_id = chunks_fts.rowid where chunks_fts match ? order by s').all(q);
  const byRank = ranked();
  const or = db.prepare('select rowid id from chunks_fts where chunks_fts match ? order by rowid').all(ftsQuery('bananas kraken')).map((r) => r.id);
  const prefix = db.prepare("select rowid id from chunks_fts where chunks_fts match 'krak*' order by rowid").all().map((r) => r.id);
  db.prepare('update chunks set content = ? where chunk_id = 3').run('kraken bananas');
  const afterUpdate = ranked().map((r) => r.id).sort();
  db.prepare('delete from chunks where chunk_id = 2').run();
  const afterDelete = ranked().map((r) => r.id).sort();
  db.exec("insert into chunks_fts(chunks_fts) values('integrity-check')");
  const hostile = ['"', "'); drop table chunks; --", 'NEAR(a b)', 'content:kraken', '*', 'AND OR NOT'];
  const hostileOk = hostile.every((t) => { const fq = ftsQuery(t); if (fq === null) return true; try { db.prepare('select count(*) n from chunks_fts where chunks_fts match ?').get(fq); return true; } catch { return false; } });
  const stillThere = db.prepare('select count(*) n from chunks').get().n;
  db.close();
  return { q, byRank: byRank.map((r) => r.id), bm25Negative: byRank.every((r) => r.s < 0), or, prefix, afterUpdate, afterDelete, integrityOk: true, hostileOk, stillThere };
}

/** WAL: snapshot isolation for a reader, checkpoint TRUNCATE, close, reopen. */
function wal() {
  const file = path.join(scratch, 'wal.sqlite');
  const w = new Database(file);
  const mode = w.pragma('journal_mode = WAL', { simple: true });
  w.pragma('synchronous = NORMAL');
  w.exec('create table t(id integer primary key, v text not null)');
  const ins = w.prepare('insert into t(v) values (?)');
  w.transaction(() => { for (let i = 0; i < 200; i++) ins.run(`row ${i}`); })();
  const walAfterWrite = size(`${file}-wal`);
  const r = new Database(file, { readonly: true });
  const count = () => r.prepare('select count(*) n from t').get().n;
  const readerBefore = count();
  w.exec("BEGIN; INSERT INTO t(v) VALUES ('pending');");
  const readerDuringWrite = count();
  w.exec('COMMIT');
  const readerAfterCommit = count();
  const cp = w.pragma('wal_checkpoint(TRUNCATE)');
  const walAfterCheckpoint = size(`${file}-wal`);
  r.close();
  w.close();
  const walAfterClose = size(`${file}-wal`);
  const again = new Database(file);
  const reopened = { mode: again.pragma('journal_mode', { simple: true }), rows: again.prepare('select count(*) n from t').get().n, integrity: again.pragma('integrity_check', { simple: true }) };
  again.close();
  return { mode, walAfterWrite, readerBefore, readerDuringWrite, readerAfterCommit, checkpoint: cp[0], walAfterCheckpoint, walAfterClose, reopened };
}

/** vec0 with the store's shape (cosine, a 'vis' metadata column): KNN, the filter inside KNN. */
function vec() {
  const db = new Database(path.join(scratch, 'vec.sqlite'));
  db.loadExtension(vecPath);
  db.exec("create virtual table chunks_vec using vec0(embedding float[4] distance_metric=cosine, vis text)");
  const ins = db.prepare('insert into chunks_vec(rowid, embedding, vis) values (?, ?, ?)');
  ins.run(BigInt(1), f32([1, 0, 0, 0]), 'live');
  ins.run(BigInt(2), f32([0.8, 0.6, 0, 0]), 'live');
  ins.run(BigInt(3), f32([0, 1, 0, 0]), 'live');
  ins.run(BigInt(4), f32([1, 0, 0, 0]), 'hidden');
  const qv = f32([1, 0, 0, 0]);
  const knnLive = db.prepare("select rowid id, distance d from chunks_vec where embedding match ? and k = 2 and vis in ('live') order by distance").all(qv);
  const knnAll = db.prepare('select rowid id, distance d from chunks_vec where embedding match ? and k = 2 order by distance').all(qv);
  const scalar = db.prepare('select vec_distance_cosine(?, ?) d').get(qv, f32([0, 1, 0, 0])).d;
  db.prepare('delete from chunks_vec where rowid = 1').run();
  const afterDelete = db.prepare("select rowid id from chunks_vec where embedding match ? and k = 2 and vis in ('live') order by distance").all(qv).map((r) => r.id);
  db.close();
  return { knnLive, knnAll: knnAll.map((r) => ({ id: r.id, d: r.d })), scalar, afterDelete };
}

/** The real store: open (WAL, vec0 by digest, schema), close (its wal_checkpoint TRUNCATE), reopen. */
function store() {
  const file = path.join(scratch, 'store.sqlite');
  const vecSha256 = crypto.createHash('sha256').update(fs.readFileSync(vecPath)).digest('hex');
  const s = NativeMemoryStore.open(file, { Database, vecPath, vecSha256 });
  const mode = s.db.pragma('journal_mode', { simple: true });
  s.db.exec("insert into index_meta(key, value) values ('engine-check', '105')");
  s.close();
  const walAfterClose = size(`${file}-wal`);
  const s2 = NativeMemoryStore.open(file, { Database, vecPath, vecSha256 });
  const meta = s2.db.prepare("select value from index_meta where key = 'engine-check'").get();
  const quick = s2.db.pragma('quick_check', { simple: true });
  s2.close();
  return { mode, walAfterClose, meta: meta ? meta.value : null, quick };
}

let result;
try {
  fs.mkdirSync(scratch, { recursive: true });
  result = { ok: true, versions: versions(), fts: fts(), wal: wal(), vec: vec(), store: store() };
} catch (e) {
  result = { ok: false, error: String((e && e.stack) || e) };
}
fs.writeFileSync(outFile, JSON.stringify(result, (k, v) => (typeof v === 'bigint' ? Number(v) : v)));
