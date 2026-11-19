'use strict';
require('./tools/own-job.cjs');

/**
 * LAG-TASKS-WRITE-SYNC-READ-108: every card write (writeTasks, addTask, patchTask, deleteTask,
 * archivePass) ran its whole read-modify-write with sync fs on main: tasks.json was read sync
 * (tasksForMutation), re-read sync (writeTasks), written with the sync atomicWriteJson, the
 * archive was stat'ed, read and appended sync, and the guard's sidecar was written sync. On a
 * slow disk each card write stalled the main thread.
 *
 * The contract pinned here:
 *  (a) no sync fs on the hive folder while a card write runs (the app log is out of scope: it is
 *      the shared kept-open appender, its own card);
 *  (b) one serial queue: a patch given as a function of the current card is computed inside the
 *      job, so two interleaved appends both land (the ledger op's appendNote/appendResult);
 *  (c) duplicate-id refusal holds for concurrent adds;
 *  (d) a job that throws (invalid ledger, EPERM) rejects only its own caller; the next one lands;
 *  (e) dispose(): a queued job and a job asked after it are refused, nothing is written after
 *      dispose(), drainReads() waits for the queue, and the folder can be removed;
 *  (f) the guard records our expected write BEFORE the rename, so a watcher check that runs
 *      between the rename and the job's continuation does not take our write for an outside edit;
 *  (g) an outside edit that lands between the job's read and its rename is not overwritten: the
 *      job sees the stamp change and re-merges against the new file;
 *  (h) no floating promise: every main-process call of a card-write method is awaited, returned,
 *      or carries a .catch/.then; the renderer IPC handlers keep their { ok } shape.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager, TaskLedgerInvalidError } = loadTs('src/main/hive.ts');

const H = 60 * 60_000;
const NOW = Date.parse('2026-10-21T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const card = (id, extra = {}) => ({ id, title: `title ${id}`, status: 'todo', dependsOn: [], priority: 3, createdAt: '2026-11-19T08:00:00.000Z', ...extra });
const old = (id) => card(id, { status: 'done', doneAt: iso(NOW - 72 * H), result: `[${iso(NOW - 72 * H)}] did ${id}` });

function rig(t, tasks = [card('A'), card('B')]) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-lagtasks108-'));
  const root = path.join(home, 'hive');
  fs.mkdirSync(root, { recursive: true });
  const hotPath = path.join(root, 'tasks.json');
  fs.writeFileSync(hotPath, JSON.stringify({ tasks }, null, 2));
  const hive = new HiveManager(() => home);
  let disposed = false;
  t.after(async () => {
    if (!disposed) { hive.dispose(); await hive.drainReads(); }
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  });
  const hot = () => JSON.parse(fs.readFileSync(hotPath, 'utf8')).tasks;
  return { home, root, hotPath, hive, hot, markDisposed: () => { disposed = true; } };
}

// Path-taking sync fs calls under `home`, while fn runs. fd-only calls need an openSync first,
// which is listed. log*.jsonl is the app log (kept-open appender, out of this card's scope).
const SYNC = ['readFileSync', 'writeFileSync', 'appendFileSync', 'statSync', 'lstatSync', 'existsSync', 'openSync',
  'renameSync', 'copyFileSync', 'mkdirSync', 'readdirSync', 'unlinkSync', 'rmSync', 'accessSync', 'utimesSync', 'truncateSync'];
async function syncCallsDuring(home, fn) {
  const calls = [];
  const real = {};
  const base = path.resolve(home).toLowerCase();
  for (const k of SYNC) {
    real[k] = fs[k];
    fs[k] = function (p, ...rest) {
      const s = typeof p === 'string' ? p : Buffer.isBuffer(p) ? p.toString() : p instanceof URL ? p.pathname : null;
      if (s && path.resolve(s).toLowerCase().startsWith(base) && !/log[^\\/]*\.jsonl$/i.test(s)) calls.push(`${k} ${path.relative(home, s)}`);
      return real[k].call(this, p, ...rest);
    };
  }
  try { await fn(); } finally { for (const k of SYNC) fs[k] = real[k]; }
  return calls;
}

test('(a) no sync fs on the hive folder while a card write runs: add, patch, delete, writeTasks', async (t) => {
  const r = rig(t);
  r.hive.tasks(); // the read cache is primed; only the write path is measured
  const got = {};
  got.add = await syncCallsDuring(r.home, async () => { assert.equal(await r.hive.addTask(card('C')), true); });
  got.patch = await syncCallsDuring(r.home, async () => { assert.equal(await r.hive.patchTask('A', { status: 'doing' }), true); });
  got.del = await syncCallsDuring(r.home, async () => { assert.equal(await r.hive.deleteTask('B'), true); });
  got.write = await syncCallsDuring(r.home, async () => { await r.hive.writeTasks(r.hot().concat([card('D')])); });
  assert.deepEqual(got, { add: [], patch: [], del: [], write: [] });
  assert.deepEqual(r.hot().map((c) => c.id), ['A', 'C', 'D']);
  assert.equal(r.hot()[0].status, 'doing');
});

test('(a) no sync fs on the hive folder during an archive pass or an archived revive', async (t) => {
  const r = rig(t, [old('OLD1'), card('LIVE'), old('OLD2')]);
  let moved;
  const pass = await syncCallsDuring(r.home, async () => { moved = await r.hive.archivePass(NOW); });
  assert.deepEqual([...moved].sort(), ['OLD1', 'OLD2']);
  const revive = await syncCallsDuring(r.home, async () => { assert.equal(await r.hive.patchTask('OLD1', { status: 'todo' }), true); });
  assert.deepEqual({ pass, revive }, { pass: [], revive: [] });
  assert.deepEqual(r.hot().map((c) => c.id).sort(), ['LIVE', 'OLD1']);
});

test('(b) a patch given as a function of the current card is computed inside the queue: two interleaved appends both land', async (t) => {
  const r = rig(t);
  const append = (tag) => (cur) => ({ notes: `${cur.notes ?? ''}[${tag}]` });
  const results = await Promise.all([r.hive.patchTask('A', append('one')), r.hive.patchTask('A', append('two')), r.hive.patchTask('A', { status: 'doing' })]);
  assert.deepEqual(results, [true, true, true]);
  const a = r.hot().find((c) => c.id === 'A');
  assert.equal(a.notes, '[one][two]', 'each append saw the card the job before it wrote');
  assert.equal(a.status, 'doing');
});

test('(c) concurrent adds of one id: exactly one lands, one card on disk', async (t) => {
  const r = rig(t);
  const results = await Promise.all([r.hive.addTask(card('D')), r.hive.addTask(card('D', { title: 'twin' }))]);
  assert.deepEqual(results, [true, false], 'queue order: the first asked wins');
  assert.deepEqual(r.hot().filter((c) => c.id === 'D').map((c) => c.title), ['title D']);
});

test('(d) a job that throws rejects its own caller only; the queue carries on (invalid ledger, EPERM)', async (t) => {
  const r = rig(t);
  const bad = r.hive.writeTasks([card('A'), card('A')]);
  const good = r.hive.addTask(card('C'));
  await assert.rejects(bad, TaskLedgerInvalidError);
  assert.equal(await good, true);
  assert.deepEqual(r.hot().map((c) => c.id), ['A', 'B', 'C']);

  const real = r.hive.atomicWriteJsonAsync;
  assert.equal(typeof real, 'function', 'the card write goes through the hive-owned async writer');
  let n = 0;
  r.hive.atomicWriteJsonAsync = async function (...a) {
    if (n++ === 0) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
    return real.apply(this, a);
  };
  const p1 = r.hive.patchTask('A', { status: 'doing' });
  const p2 = r.hive.patchTask('B', { status: 'blocked' });
  await assert.rejects(p1, { code: 'EPERM' });
  assert.equal(await p2, true);
  const byId = Object.fromEntries(r.hot().map((c) => [c.id, c.status]));
  assert.deepEqual(byId, { A: 'todo', B: 'blocked', C: 'todo' });
});

test('(e) dispose(): queued and later jobs are refused, nothing is written after, drainReads waits, rm works', async (t) => {
  const r = rig(t);
  const before = fs.readFileSync(r.hotPath, 'utf8');
  const queued = r.hive.addTask(card('Q'));
  assert.ok(queued instanceof Promise, 'the write is queued, not done in the caller\'s turn');
  r.hive.dispose();
  const after = r.hive.patchTask('A', { status: 'doing' });
  r.markDisposed();
  await r.hive.drainReads();
  await assert.rejects(queued, /disposed/);
  await assert.rejects(after, /disposed/);
  assert.equal(fs.readFileSync(r.hotPath, 'utf8'), before, 'no write landed after dispose()');
  assert.deepEqual(fs.readdirSync(r.root).filter((f) => f.includes('.tmp')), [], 'no temp file left');
  fs.rmSync(r.home, { recursive: true }); // no handle open: the folder goes (ENOTEMPTY/EBUSY otherwise)
  assert.equal(fs.existsSync(r.home), false);
});

test('(f) the guard expects our write before the rename: a watcher check right after the rename attributes it to the API', async (t) => {
  const r = rig(t);
  r.hive.ledgerGuard.check();
  const phases = [];
  r.hive.__taskWriteHookForTest = (phase) => {
    phases.push(phase);
    if (phase === 'written') r.hive.ledgerGuard.check(); // the fs.watch event's macrotask ran first
  };
  assert.equal(await r.hive.patchTask('A', { status: 'doing' }, 'slack'), true);
  assert.ok(phases.includes('written'), `the hook saw the rename (phases: ${phases.join(',')})`);
  assert.equal(r.hive.ledgerGuard.taskMeta().cards.A.lastEditBy, 'api:slack');
  assert.equal(r.hive.ledgerGuard.check(), null, 'the file holds the bytes the API wrote');
});

test('(g) an outside edit between the job\'s read and its rename is re-merged, not overwritten', async (t) => {
  const r = rig(t);
  let edited = 0;
  r.hive.__taskWriteHookForTest = (phase) => {
    if (phase !== 'merged' || edited++) return;
    const ledger = JSON.parse(fs.readFileSync(r.hotPath, 'utf8'));
    ledger.tasks.push(card('HAND', { notes: 'written by an agent by hand' }));
    fs.writeFileSync(r.hotPath, JSON.stringify(ledger, null, 2)); // the size changes
  };
  assert.equal(await r.hive.patchTask('A', { status: 'doing' }), true);
  assert.equal(edited, 2, 'the job merged twice: once before the outside edit, once after it');
  const byId = Object.fromEntries(r.hot().map((c) => [c.id, c.status]));
  assert.deepEqual(byId, { A: 'doing', B: 'todo', HAND: 'todo' });
});

// ---- (h) source pins ----
const SRC = path.resolve(__dirname, '..', 'src', 'main');
const codeOnly = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
function closeParen(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

test('(h) every main-process call of a card-write method is awaited, returned, or caught', () => {
  const files = fs.readdirSync(SRC, { recursive: true }).filter((f) => /\.ts$/.test(f) && !/\.d\.ts$/.test(f)).map((f) => path.join(SRC, f));
  // The voice deps (hiveAddTask/...) and reviveTask hand the same promise on: `!deps.hiveAddTask(c)`
  // on a promise is always false, so a refused add would read as success.
  const re = /\.(addTask|patchTask|deleteTask|writeTasks|archivePass|reviveTask|hiveAddTask|hivePatchTask|hiveDeleteTask)\(/g;
  const floating = [];
  for (const file of files) {
    const src = codeOnly(fs.readFileSync(file, 'utf8'));
    for (const m of src.matchAll(re)) {
      const before = src.slice(Math.max(0, m.index - 80), m.index).replace(/\s+/g, ' ');
      const recv = before.match(/([A-Za-z_$][\w$]*)$/);
      if (!recv) continue;
      const lead = before.slice(0, before.length - recv[1].length);
      const close = closeParen(src, m.index + m[0].length - 1);
      const after = src.slice(close + 1, close + 12);
      const ok = /(await|return|=>)\s*\(?\s*!?\s*$/.test(lead) || /^\s*\.(catch|then)\(/.test(after);
      if (!ok) floating.push(`${path.relative(SRC, file)}:${src.slice(0, m.index).split('\n').length} ${recv[1]}${m[0]}`);
    }
  }
  assert.deepEqual(floating, []);
});

test('(h) the renderer IPC handlers keep their { ok } reply and send it after the write landed', () => {
  const index = codeOnly(fs.readFileSync(path.join(SRC, 'index.ts'), 'utf8'));
  for (const name of ['addTask', 'patchTask', 'deleteTask']) {
    const at = index.indexOf(`ipcMain.handle('hive:${name}'`);
    assert.ok(at >= 0, `the hive:${name} handler`);
    const body = index.slice(at, at + 900);
    assert.match(body, new RegExp(`return \\{ ok: await hive\\.${name}\\(`), `hive:${name} replies { ok } once the write landed`);
  }
});

test('(h) the ledger op computes its append inside the queued patch, from the card the job read', () => {
  const ledger = codeOnly(fs.readFileSync(path.join(SRC, 'ledger.ts'), 'utf8'));
  assert.match(ledger, /await deps\.patchTask\(card\.id, \(cur[^)]*\) =>/, 'the patch is a function of the current card');
  assert.doesNotMatch(ledger, /const cur = deps\.readTasks\(\)\.find\(\(t\) => t\?\.id === card\.id\)/, 'no read-then-patch outside the queue');
});
