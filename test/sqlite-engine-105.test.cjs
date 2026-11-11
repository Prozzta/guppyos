'use strict';
require('./tools/own-job.cjs');
// MUTANT-JOURNAL-GATE (god 5cc045/ed8032): this suite loads electron-bin.cjs, a file a census mutates
// in place; refuse a tree a killed census left mutated, before anything is read.
require('./tools/mutant-runner-helper.cjs').gate(__filename);
/**
 * GUPPY-NODE-LTS (god 7b2253): better-sqlite3 11.10 -> 12.11 moves SQLite 3.49 -> 3.53. The
 * memory store's engine behaviours, checked on the REAL shipped natives (the app's Electron-ABI
 * better-sqlite3 + the pinned sqlite-vec DLL) by test/sqlite-engine-105/harness.cjs under
 * Electron as Node (no window). Fixtures only, in a temp jail: never a hive or app database.
 *  - FTS5: the store's external-content table + triggers, bm25 order, OR and prefix queries,
 *    update/delete through the triggers, integrity-check, hostile input through ftsQuery.
 *  - WAL: a reader keeps its snapshot during a write, checkpoint(TRUNCATE) empties the log,
 *    close leaves no log, reopen is still WAL with every row; the store's own close does the same.
 *  - vec0: cosine KNN with exact distances, the 'vis' metadata filter inside KNN (k results even
 *    when a nearer row is hidden), vec_distance_cosine, delete.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

let ELECTRON = null;
try { ELECTRON = require('./electron-harness/electron-bin.cjs').harnessElectron(); } catch { ELECTRON = null; }
const HAVE_ELECTRON = typeof ELECTRON === 'string' && fs.existsSync(ELECTRON);
const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-engine-105-'));
test.after(() => fs.rmSync(JAIL, { recursive: true, force: true }));

let cached = null;
function run() {
  if (cached) return cached;
  const out = path.join(JAIL, 'result.json');
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', HOME: JAIL, USERPROFILE: JAIL };
  const r = spawnSync(ELECTRON, [path.join(__dirname, 'sqlite-engine-105', 'harness.cjs'), out, path.join(JAIL, 'db')],
    { env, cwd: path.resolve(__dirname, '..'), timeout: 120000, windowsHide: true });
  assert.ok(fs.existsSync(out), `harness wrote no result (status ${r.status}) ${String(r.stderr || '').slice(0, 400)}`);
  const j = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(j.ok, true, j.error);
  cached = j;
  return j;
}
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-5, `${msg}: ${a} vs ${b}`);

test('engine: the shipped driver is better-sqlite3 12 on SQLite 3.53+, under Electron\'s ABI, with vec0', { skip: !HAVE_ELECTRON }, () => {
  const { versions: v } = run();
  assert.match(v.driver, /^12\./);
  const [maj, min] = v.sqlite.split('.').map(Number);
  assert.ok(maj === 3 && min >= 53, `SQLite ${v.sqlite}`);
  assert.ok(v.electron, 'ran under Electron as Node');
  assert.match(v.vec, /^v0\.1\./);
});

test('FTS5: external content + triggers, bm25 order, OR / prefix, update and delete, integrity, hostile input', { skip: !HAVE_ELECTRON }, () => {
  const { fts } = run();
  assert.equal(fts.q, '"kraken"', 'the store\'s ftsQuery');
  assert.deepEqual(fts.byRank, [2, 1], 'bm25: the denser match ranks first');
  assert.equal(fts.bm25Negative, true, 'FTS5 bm25 is negative, smaller is better (the store negates it)');
  assert.deepEqual(fts.or, [1, 2, 3]);
  assert.deepEqual(fts.prefix, [1, 2]);
  assert.deepEqual(fts.afterUpdate, [1, 2, 3], 'the update trigger re-indexes');
  assert.deepEqual(fts.afterDelete, [1, 3], 'the delete trigger removes');
  assert.equal(fts.integrityOk, true);
  assert.equal(fts.hostileOk, true); assert.equal(fts.stillThere, 2);
});

test('WAL: reader snapshot during a write, checkpoint(TRUNCATE), close leaves no log, reopen keeps WAL and rows', { skip: !HAVE_ELECTRON }, () => {
  const { wal: w } = run();
  assert.equal(w.mode, 'wal');
  assert.ok(w.walAfterWrite > 0, 'writes go to the -wal log');
  assert.equal(w.readerBefore, 200);
  assert.equal(w.readerDuringWrite, 200, 'an uncommitted write is not visible to a reader');
  assert.equal(w.readerAfterCommit, 201);
  assert.deepEqual(w.checkpoint, { busy: 0, log: 0, checkpointed: 0 }, 'TRUNCATE completes and resets the log');
  assert.equal(w.walAfterCheckpoint, 0);
  assert.ok(w.walAfterClose === null || w.walAfterClose === 0, `no log left after the last close (${w.walAfterClose})`);
  assert.deepEqual(w.reopened, { mode: 'wal', rows: 201, integrity: 'ok' });
});

test('WAL: the real NativeMemoryStore opens in WAL and its close leaves no log; reopen reads the row', { skip: !HAVE_ELECTRON }, () => {
  const { store: s } = run();
  assert.equal(s.mode, 'wal');
  assert.ok(s.walAfterClose === null || s.walAfterClose === 0, `store close leaves no log (${s.walAfterClose})`);
  assert.equal(s.meta, '105'); assert.equal(s.quick, 'ok');
});

test('vec0: cosine KNN with exact distances; the vis filter applies inside KNN; delete', { skip: !HAVE_ELECTRON }, () => {
  const { vec: v } = run();
  assert.deepEqual(v.knnLive.map((r) => r.id), [1, 2], 'k = 2 live rows even though hidden row 4 is as near as row 1');
  close(v.knnLive[0].d, 0, 'identical vector'); close(v.knnLive[1].d, 0.2, 'cos 0.8');
  assert.deepEqual(v.knnAll.map((r) => r.id).sort(), [1, 4], 'unfiltered KNN takes the two identical vectors');
  for (const r of v.knnAll) close(r.d, 0, `row ${r.id}`);
  close(v.scalar, 1, 'vec_distance_cosine of orthogonal vectors');
  assert.deepEqual(v.afterDelete, [2, 3]);
});
