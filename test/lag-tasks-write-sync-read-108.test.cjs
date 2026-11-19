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
    // Jim NIT: no retries, so a handle a fix leaks fails every test, not only (e).
    fs.rmSync(home, { recursive: true, force: true });
  });
  const hot = () => JSON.parse(fs.readFileSync(hotPath, 'utf8')).tasks;
  // The queue is idle: a turn for anything scheduled after a resolve, then every counted job done.
  const settle = async () => { await new Promise((res) => setImmediate(res)); await hive.drainReads(); };
  return { home, root, hotPath, hive, hot, settle, markDisposed: () => { disposed = true; } };
}

// Path-taking sync fs calls under `home`, while fn runs. fd-only calls need an openSync first,
// which is listed. log*.jsonl is the app log (kept-open appender, out of this card's scope).
const SYNC = ['readFileSync', 'writeFileSync', 'appendFileSync', 'statSync', 'lstatSync', 'existsSync', 'openSync',
  'renameSync', 'copyFileSync', 'mkdirSync', 'readdirSync', 'unlinkSync', 'rmSync', 'accessSync', 'utimesSync', 'truncateSync',
  'rmdirSync', 'realpathSync', 'opendirSync', 'chmodSync', 'cpSync'];
// The one sync call that is not the write's: safeDirectoryWatch checks, on each fs.watch delivery,
// that the watched folder still exists (the E45 libuv spin guard). It runs because our write fired
// an event, not inside the job, and is its own concern. Only that exact call (existsSync of a
// folder, from an FSWatcher delivery) is set aside, and each one is asserted to be just that.
async function syncCallsDuring(home, fn, settle) {
  const calls = [];
  const watcherCalls = [];
  const real = {};
  const base = path.resolve(home).toLowerCase();
  for (const k of SYNC) {
    real[k] = fs[k];
    fs[k] = function (p, ...rest) {
      const s = typeof p === 'string' ? p : Buffer.isBuffer(p) ? p.toString() : p instanceof URL ? p.pathname : null;
      if (s && path.resolve(s).toLowerCase().startsWith(base) && !/log[^\\/]*\.jsonl$/i.test(s)) {
        const row = `${k} ${path.relative(home, s)}`;
        let dir = false;
        try { dir = k === 'existsSync' && real.statSync(s).isDirectory(); } catch { dir = false; }
        if (dir && /FSWatcher\.emit/.test(new Error().stack)) watcherCalls.push(row); else calls.push(row);
      }
      return real[k].call(this, p, ...rest);
    };
  }
  // Jim SHOULD 1: the window stays open until the queue is idle, so a persist or cache refresh a
  // fix schedules after the caller's promise resolved is still seen.
  try { await fn(); if (settle) await settle(); } finally { for (const k of SYNC) fs[k] = real[k]; }
  for (const w of watcherCalls) assert.match(w, /^existsSync hive$/, 'only the watcher\'s own folder check is set aside');
  return calls;
}

test('(a) no sync fs on the hive folder while a card write runs: add, patch, delete, writeTasks', async (t) => {
  const r = rig(t);
  r.hive.tasks(); // the read cache is primed; only the write path is measured
  const got = {};
  const idle = r.settle;
  got.add = await syncCallsDuring(r.home, async () => {
    assert.equal(await r.hive.addTask(card('C')), true);
    // Jim SHOULD 3: the read right after the write serves the written ledger from the cache.
    assert.ok(r.hive.tasks().tasks.some((c) => c.id === 'C'), 'tasks() has C straight after the add');
  }, idle);
  got.patch = await syncCallsDuring(r.home, async () => { assert.equal(await r.hive.patchTask('A', { status: 'doing' }), true); }, idle);
  got.del = await syncCallsDuring(r.home, async () => { assert.equal(await r.hive.deleteTask('B'), true); }, idle);
  const next = r.hot().concat([card('D')]);
  got.write = await syncCallsDuring(r.home, async () => { await r.hive.writeTasks(next); }, idle);
  assert.deepEqual(got, { add: [], patch: [], del: [], write: [] });
  assert.deepEqual(r.hot().map((c) => c.id), ['A', 'C', 'D']);
  assert.equal(r.hot()[0].status, 'doing');
});

test('(a) no sync fs on the hive folder during an archive pass or an archived revive', async (t) => {
  const r = rig(t, [old('OLD1'), card('LIVE'), old('OLD2')]);
  let moved;
  const pass = await syncCallsDuring(r.home, async () => { moved = await r.hive.archivePass(NOW); }, r.settle);
  assert.deepEqual([...moved].sort(), ['OLD1', 'OLD2']);
  const revive = await syncCallsDuring(r.home, async () => { assert.equal(await r.hive.patchTask('OLD1', { status: 'todo' }), true); }, r.settle);
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
  // Jim SHOULD 3/4: right after the failed write the cache still says A is todo (it updates only on
  // success), and the failed write left no temp file.
  assert.equal(r.hive.tasks().tasks.find((c) => c.id === 'A').status, 'todo');
  assert.deepEqual(fs.readdirSync(r.root).filter((f) => f.includes('.tmp')), [], 'no temp file after the EPERM');
  assert.equal(await p2, true);
  const byId = Object.fromEntries(r.hot().map((c) => [c.id, c.status]));
  assert.deepEqual(byId, { A: 'todo', B: 'blocked', C: 'todo' });
});

test('(g) bound (Jim MUST 2): an outside writer at every merge gets a rejection after 3 re-merges, keeps its edit, and the next job lands', async (t) => {
  const r = rig(t);
  let edits = 0;
  r.hive.__taskWriteHookForTest = (phase) => {
    if (phase !== 'merged') return;
    edits++;
    const ledger = JSON.parse(fs.readFileSync(r.hotPath, 'utf8'));
    ledger.tasks.push(card(`HAND${edits}`));
    fs.writeFileSync(r.hotPath, JSON.stringify(ledger, null, 2));
  };
  const busy = r.hive.patchTask('A', { status: 'doing' });
  const next = r.hive.addTask(card('N'));
  await assert.rejects(busy, (e) => e.code === 'ETASKSBUSY' && /outside writer/.test(e.message) && e.attempts === 4);
  assert.equal(edits, 4, 'one first merge and 3 re-merges, then it stops');
  const held = r.hot();
  assert.deepEqual(held.map((c) => c.id), ['A', 'B', 'HAND1', 'HAND2', 'HAND3', 'HAND4'], 'the file holds the last outside edit');
  assert.equal(held[0].status, 'todo', 'our refused patch was not written after the bound');
  assert.deepEqual(fs.readdirSync(r.root).filter((f) => f.includes('.tmp')), [], 'no temp file left');
  r.hive.__taskWriteHookForTest = undefined;
  assert.equal(await next, true, 'the next queued job lands');
  assert.deepEqual(r.hot().map((c) => c.id), ['A', 'B', 'HAND1', 'HAND2', 'HAND3', 'HAND4', 'N']);
});

test('MUST 1: a card write on a hive with no tasks.json creates only the root and tasks.json, and the card lands', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-lagtasks108-fresh-'));
  const hive = new HiveManager(() => home);
  t.after(async () => { hive.dispose(); await hive.drainReads(); fs.rmSync(home, { recursive: true, force: true }); });
  assert.equal(await hive.addTask(card('FIRST')), true);
  const root = path.join(home, 'hive');
  // The write no longer bootstraps the hive (registry, PROTOCOL.md, shims, the C2 seed): startup
  // (ensureHive in index.ts) and agent spawn (ensureAgent) do that. Only the ledger is made here.
  // The guard's meta sidecar sits under state/ and the log is the app log, both written by the job.
  const made = fs.readdirSync(root).filter((f) => !/^(state|log[^\\/]*\.jsonl)$/.test(f)).sort();
  assert.deepEqual(made, ['tasks.json']);
  assert.equal(fs.existsSync(path.join(root, 'registry.json')), false, 'no registry: the hive was not created by a card write');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'tasks.json'), 'utf8')).tasks.map((c) => c.id), ['FIRST']);
});

test('MUST 1 / god: a bootstrap file deleted mid-run is no longer rebuilt by a card write; the next agent spawn rebuilds it (never silently dropped)', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-lagtasks108-heal-'));
  const realHome = process.env.HOME; const realProfile = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  t.after(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    if (realProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realProfile;
  });
  assert.equal(os.homedir(), home, 'HOME redirect failed - aborting before constructing any hive');
  const hive = new HiveManager(() => home);
  t.after(async () => { hive.dispose(); await hive.drainReads(); fs.rmSync(home, { recursive: true, force: true }); });
  hive.ensureHive();
  const root = hive.root();
  const files = ['PROTOCOL.md', 'COMMANDS.md'].map((f) => path.join(root, f));
  for (const f of files) assert.ok(fs.existsSync(f), `control: ensureHive wrote ${path.basename(f)}`);
  for (const f of files) fs.rmSync(f);
  assert.equal(await hive.addTask(card('W1')), true);
  for (const f of files) assert.equal(fs.existsSync(f), false, `the card write left ${path.basename(f)} alone (no sync bootstrap on the write path)`);
  await hive.ensureAgent({ id: 'a1', name: 'Ann', provider: 'claude', cwd: home });
  for (const f of files) assert.ok(fs.existsSync(f), `the spawn rebuilt ${path.basename(f)}`);
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

// Top-level argument count of the call whose '(' is at `open`.
function argCount(src, open) {
  const close = closeParen(src, open);
  if (close < 0) return 0;
  if (!src.slice(open + 1, close).trim()) return 0;
  let depth = 0;
  let n = 1;
  for (let i = open + 1; i < close; i++) {
    const ch = src[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) n++;
  }
  return n;
}
// The '(' of the call an arrow starting at `arrowParams` is an argument of, or -1.
function enclosingOpen(src, at) {
  let depth = 0;
  for (let i = at - 1; i >= 0; i--) {
    const ch = src[i];
    if (ch === ')' || ch === ']' || ch === '}') depth++;
    else if (ch === '(' || ch === '[' || ch === '{') {
      if (depth === 0) return ch === '(' ? i : -1;
      depth--;
    } else if (ch === ';' && depth === 0) return -1;
  }
  return -1;
}
/**
 * Is the promise of the call `recv.method(...)` (method's '(' at `open`, receiver starting at
 * `start`) handled? Jim MUST 3 / SHOULD 5:
 *  - `await x()` (so `!(await x())`), or `return x()` with nothing between: `return !x()` and
 *    `=> !x()` are always false on a promise, so a `!` is allowed only straight after `await`;
 *  - `=> x()`: the arrow hands the promise to its caller, unless that caller is forEach (it drops
 *    it) or map without an awaited/returned Promise.all/allSettled around it;
 *  - `.catch(` after the call, or `.then(` with a rejection handler (two arguments, or a .catch next).
 */
function callIsHandled(src, start, open) {
  const lead = src.slice(Math.max(0, start - 120), start).replace(/\s+/g, ' ');
  const close = closeParen(src, open);
  const after = src.slice(close + 1);
  const chained = after.match(/^\s*\.(catch|then)\(/);
  if (chained) {
    if (chained[1] === 'catch') return true;
    const thenOpen = close + 1 + chained[0].length - 1;
    if (argCount(src, thenOpen) >= 2) return true;
    return /^\s*\.catch\(/.test(src.slice(closeParen(src, thenOpen) + 1));
  }
  if (/(^|[^\w$.])await\s*$/.test(lead)) return true;
  if (/(^|[^\w$.])return\s*$/.test(lead)) return true;
  if (/=>\s*$/.test(lead)) {
    const arrow = src.lastIndexOf('=>', start);
    const encl = enclosingOpen(src, arrow);
    if (encl < 0) return true;
    const callee = src.slice(Math.max(0, encl - 200), encl);
    if (/\.forEach\s*$/.test(callee)) return false;
    if (/\.map\s*$/.test(callee)) return /(await|return)\s+Promise\.(all|allSettled)\(\s*[\w$.]*\.map\s*$/.test(callee.replace(/\s+/g, ' '));
    return true;
  }
  return false;
}
const CARD_WRITE = /\.(addTask|patchTask|deleteTask|writeTasks|archivePass|reviveTask|hiveAddTask|hivePatchTask|hiveDeleteTask)\(/g;
function floatingCalls(src, label) {
  const out = [];
  for (const m of src.matchAll(CARD_WRITE)) {
    const before = src.slice(Math.max(0, m.index - 80), m.index);
    const recv = before.match(/([A-Za-z_$][\w$]*)$/);
    if (!recv) continue;
    const start = m.index - recv[1].length;
    if (!callIsHandled(src, start, m.index + m[0].length - 1)) out.push(`${label}:${src.slice(0, m.index).split('\n').length} ${recv[1]}${m[0]}`);
  }
  return out;
}

test('(h) the scan itself: a negated or dropped promise is red, an awaited or handled one passes (Jim MUST 3, SHOULD 5)', () => {
  const red = [
    'function f(deps, card) { return !deps.hiveAddTask(card); }',
    'const g = (x, c) => !x.addTask(c);',
    'list.forEach((c) => hive.addTask(c));',
    'list.map((c) => hive.addTask(c));',
    'hive.patchTask(id, p).then((ok) => log(ok));',
    'void hive.deleteTask(id);',
    'if (!deps.hiveDeleteTask(card.id)) return no;',
    'hive.addTask(c);'
  ];
  const pass = [
    'async function f(deps, card) { if (!(await deps.hiveAddTask(card))) return no; }',
    'async function f(deps, card) { return deps.hiveAddTask(card); }',
    'const wire = { addTask: (task) => hive.addTask(task, "ledger") };',
    'async function f() { await Promise.all(list.map((c) => hive.addTask(c))); }',
    'hive.patchTask(id, p).then((ok) => log(ok), (e) => log(e));',
    'hive.patchTask(id, p).then((ok) => log(ok)).catch((e) => log(e));',
    'hive.archivePass().catch((e) => log(e));'
  ];
  for (const s of red) assert.equal(floatingCalls(s, 'fx').length, 1, `red: ${s}`);
  for (const s of pass) assert.deepEqual(floatingCalls(s, 'fx'), [], `pass: ${s}`);
});

test('(h) every main-process call of a card-write method is awaited, returned, or caught', () => {
  const files = fs.readdirSync(SRC, { recursive: true }).filter((f) => /\.ts$/.test(f) && !/\.d\.ts$/.test(f)).map((f) => path.join(SRC, f));
  const floating = [];
  for (const file of files) floating.push(...floatingCalls(codeOnly(fs.readFileSync(file, 'utf8')), path.relative(SRC, file)));
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
