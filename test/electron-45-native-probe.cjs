'use strict';

// Called by electron-45-natives.test.cjs both as normal Electron and with
// ELECTRON_RUN_AS_NODE=1. It proves loadability without opening a BrowserWindow.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

assert.ok(process.versions.electron, 'must run in Electron');
// Everything this probe writes goes under the folder the test owns (and removes): the WAL database
// and, under normal Electron, every app path (HARNESS-CRASHPAD). No folder, no run.
const work = process.env.E45_PROBE_DIR;
if (!work || !fs.existsSync(work)) {
  process.stderr.write('electron-45-native-probe: E45_PROBE_DIR (a folder the test removes) is required\n');
  process.exit(2);
}
const pty = require('node-pty');
const Database = require('better-sqlite3');
const ort = require('onnxruntime-node');
const sqliteVec = require('sqlite-vec');

assert.equal(typeof pty.spawn, 'function', 'node-pty loaded');
const db = new Database(':memory:');
assert.equal(db.prepare('select 45 as n').get().n, 45, 'better-sqlite3 queried');
const sqlite = db.prepare('select sqlite_version() v').get().v;
db.exec('create virtual table search using fts5(body); insert into search values (\'electron forty five\');');
assert.equal(db.prepare('select count(*) n from search where search match ?').get('electron').n, 1, 'FTS5 queried');
db.loadExtension(sqliteVec.getLoadablePath());
db.exec('create virtual table vectors using vec0(embedding float[2] distance_metric=cosine);');
db.prepare('insert into vectors(rowid, embedding) values (?, ?)').run(1n, Buffer.from(new Float32Array([1, 0]).buffer));
assert.equal(db.prepare('select rowid from vectors where embedding match ? and k = 1').get(Buffer.from(new Float32Array([1, 0]).buffer)).rowid, 1, 'vec0 KNN queried');
db.close();
const walFile = path.join(work, 'wal.sqlite');
const walDb = new Database(walFile);
assert.equal(walDb.pragma('journal_mode = WAL', { simple: true }), 'wal', 'WAL enabled');
walDb.close();
assert.equal(typeof ort.InferenceSession, 'function', 'onnxruntime-node loaded');
assert.equal(typeof sqliteVec.load, 'function', 'sqlite-vec loaded');

const betterSqlite3Binary = (Object.keys(require.cache).find((file) =>
  /[\\/]better-sqlite3[\\/].*\.node$/i.test(file)) || '')
  .replace(/^.*[\\/]better-sqlite3[\\/]/i, '').split('\\').join('/');
assert.equal(betterSqlite3Binary, 'prebuilds/win32-x64.node', 'loaded N-API prebuild');
assert.ok(Number(process.versions.napi) >= 10, `N-API ${process.versions.napi}`);

const report = JSON.stringify({
  electron: process.versions.electron,
  node: process.versions.node,
  napi: process.versions.napi,
  betterSqlite3Binary,
  sqlite,
  runAsNode: process.env.ELECTRON_RUN_AS_NODE === '1'
});

if (process.env.ELECTRON_RUN_AS_NODE === '1') {
  console.log(report);
} else {
  // Do not create a window: this is a hidden native-loader smoke only.
  const { app } = require('electron');
  const { isolateAppPaths } = require('./electron-harness/isolate-paths.cjs');
  isolateAppPaths(app, path.join(work, 'electron'));
  app.whenReady().then(() => { console.log(report); app.exit(0); });
}
