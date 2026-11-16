'use strict';
require('./tools/own-job.cjs');

/**
 * LAG-SYNC-IO-107 (god 484975; Jim's 1.1.106 stall rows): three paths on Electron main still ran
 * synchronous fs that held the thread under disk load:
 *   1. ipc:config:integrity   statSync:config.json            202 and 468 ms
 *   2. the ledger watch/poll  readFileSync:tasks.json          529 ms
 *   3. ipc:hive:mailObligations  3 existsSync per agent (not a wrapped call: no slice) 1278 ms
 * Each now does its disk work off the main thread. These tests count every synchronous fs call
 * under the test's own folder while a path runs (the count must be zero) and hold the answers to
 * the synchronous ones. The timed proof under a disk-heavy job is test/tools/lag-sync-io-107-load.cjs.
 * HOME and USERPROFILE are jailed first.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-lag-sync-io-107-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME, GEMINI_CLI_HOME: process.env.GEMINI_CLI_HOME };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL; process.env.CODEX_HOME = path.join(JAIL, '.codex'); process.env.GEMINI_CLI_HOME = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');

const userData = path.join(JAIL, 'userData');
fs.mkdirSync(userData);
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { app: { getPath: () => userData } } };
const cfg = loadTs('src/main/config.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const derived = loadTs('src/main/claims/derivedWriter.ts');
const configFile = path.join(userData, 'config.json');
const MIGRATED = { triggersMigratedV1: true, defaultModelCliMigratedV1: true };

test.after(() => {
  loadTs.closeConfigWatchers();
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

/** Every synchronous fs function that takes a path first. All of them, not only the six the
 *  stall watch wraps: path 3 was existsSync, which it does not. */
const SYNC_FNS = Object.keys(fs).filter((k) => k.endsWith('Sync') && typeof fs[k] === 'function' && !/^(f|close|write|read)Sync$|^(fstat|fsync|fdatasync|ftruncate|futimes|fchmod|fchown|readv|writev)Sync$/.test(k));
const under = (dir, p) => { const s = path.resolve(String(p)).toLowerCase(); const d = path.resolve(dir).toLowerCase(); return s === d || s.startsWith(d + path.sep); };
/** safeDirectoryWatch.ts asks existsSync(the watched folder) around every fs.watch event it
 *  delivers (so a deleted folder's handle is closed). That belongs to the watcher, on a folder
 *  and not on any file here, and arrives whenever the OS delivers the event, so it is not counted
 *  against a path. It is a known remaining synchronous call: the report on the card lists it. */
const WATCHED = new Set();
const watched = (dir) => { WATCHED.add(path.resolve(dir).toLowerCase()); };
/** Run fn (sync or async) and return the synchronous fs calls it made on paths under `dir`. */
async function syncCalls(dir, fn) {
  const orig = {};
  const calls = [];
  for (const k of SYNC_FNS) {
    orig[k] = fs[k];
    fs[k] = function (p, ...rest) {
      const probe = k === 'existsSync' && typeof p === 'string' && WATCHED.has(path.resolve(p).toLowerCase());
      if (!probe && (typeof p === 'string' || Buffer.isBuffer(p) || p instanceof URL) && under(dir, p)) calls.push(`${k}:${path.basename(String(p))}`);
      return orig[k].call(this, p, ...rest);
    };
  }
  let result;
  try { result = await fn(); } finally { for (const k of SYNC_FNS) fs[k] = orig[k]; }
  return { calls, result };
}
const until = async (cond, what, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) assert.fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};
watched(userData);
const corruptCopies = () => fs.readdirSync(userData).filter((n) => n.startsWith('config.json.corrupt-'));

test('the counter sees a synchronous call (it is not vacuous)', async () => {
  fs.writeFileSync(configFile, JSON.stringify({ ...MIGRATED, onboardingComplete: true }), 'utf8');
  cfg.__resetConfigCacheForTests();
  const { calls, result } = await syncCalls(userData, () => cfg.configIntegrityIssue());
  assert.equal(result, null);
  assert.ok(calls.includes('statSync:config.json') && calls.includes('readFileSync:config.json'), `the synchronous check stats and reads: ${calls}`);
  const seen = await syncCalls(userData, () => fs.existsSync(path.join(userData, 'nothing-here')));
  assert.deepEqual(seen.calls, ['existsSync:nothing-here']);
});

// ── path 1: config:integrity ────────────────────────────────────────────────────────────────
test('config integrity (async): a good file answers null with no synchronous fs, cold or cached, and fills the read cache', async () => {
  fs.writeFileSync(configFile, JSON.stringify({ ...MIGRATED, onboardingComplete: true }), 'utf8');
  cfg.__resetConfigCacheForTests();
  const cold = await syncCalls(userData, () => cfg.configIntegrityIssueAsync());
  assert.equal(cold.result, null);
  assert.deepEqual(cold.calls, [], 'cold: stat and read are asynchronous');
  const warm = await syncCalls(userData, () => cfg.configIntegrityIssueAsync());
  assert.equal(warm.result, null);
  assert.deepEqual(warm.calls, [], 'cached: the stat is asynchronous');
  const read = await syncCalls(userData, () => cfg.readConfig());
  assert.equal(read.result.onboardingComplete, true);
  assert.deepEqual(read.calls, [], 'readConfig is served the value the async check cached');
});

test('config integrity (async): an outside edit is seen by the next check, as the fresh synchronous check saw it', async () => {
  fs.writeFileSync(configFile, JSON.stringify({ ...MIGRATED, onboardingComplete: false, defaultModel: 'edited-by-hand' }), 'utf8');
  const { calls, result } = await syncCalls(userData, () => cfg.configIntegrityIssueAsync());
  assert.equal(result, null);
  assert.deepEqual(calls, []);
  assert.equal(cfg.readConfig().onboardingComplete, false, 'the edit is what readers now get');
});

test('config integrity (async): a corrupt file is quarantined once, reported like the synchronous check, and never overwritten', async () => {
  const corrupt = '{"harnessHome":';
  fs.writeFileSync(configFile, corrupt, 'utf8');
  cfg.__resetConfigCacheForTests();
  const first = await syncCalls(userData, () => cfg.configIntegrityIssueAsync());
  assert.deepEqual(first.calls, [], 'the read and the quarantine copy are asynchronous');
  const issue = first.result;
  assert.equal(issue.file, 'config.json');
  assert.match(issue.quarantine, /^config\.json\.corrupt-/);
  assert.equal(typeof issue.error, 'string');
  assert.equal(fs.readFileSync(path.join(userData, issue.quarantine), 'utf8'), corrupt, 'the copy holds the corrupt bytes');
  assert.equal(fs.readFileSync(configFile, 'utf8'), corrupt, 'config.json is left as found');
  const again = await syncCalls(userData, () => cfg.configIntegrityIssueAsync());
  assert.deepEqual(again.calls, []);
  assert.deepEqual(again.result, issue, 'the same issue on the next poll');
  assert.deepEqual(corruptCopies(), [issue.quarantine], 'one copy per corrupt content, not one per poll');
  // The synchronous check agrees, and takes no second copy of the same content.
  assert.deepEqual(cfg.configIntegrityIssue(), issue);
  assert.deepEqual(corruptCopies(), [issue.quarantine]);
  assert.equal(cfg.readConfig().onboardingComplete, false, 'readers get safe defaults');
  assert.throws(() => cfg.writeConfig({ onboardingComplete: true }), /refusing to overwrite it/);
  assert.equal(fs.readFileSync(configFile, 'utf8'), corrupt);
  // The same message the synchronous check gives for these bytes, from a clean start.
  for (const n of corruptCopies()) fs.rmSync(path.join(userData, n));
  cfg.__resetConfigCacheForTests();
  fs.writeFileSync(configFile, corrupt + ' ', 'utf8');
  const sync = cfg.configIntegrityIssue();
  for (const n of corruptCopies()) fs.rmSync(path.join(userData, n));
  fs.writeFileSync(configFile, corrupt + '  ', 'utf8');
  cfg.__resetConfigCacheForTests();
  const async_ = await cfg.configIntegrityIssueAsync();
  assert.equal(async_.error, sync.error, 'same parse error text');
  assert.equal(async_.file, sync.file);
});

test('config integrity (async): a repaired file clears the issue; a missing file is a first run, not an issue', async () => {
  assert.notEqual(await cfg.configIntegrityIssueAsync(), null, 'still corrupt from the test above');
  fs.writeFileSync(configFile, JSON.stringify({ ...MIGRATED, onboardingComplete: true }), 'utf8');
  const repaired = await syncCalls(userData, () => cfg.configIntegrityIssueAsync());
  assert.equal(repaired.result, null);
  assert.deepEqual(repaired.calls, []);
  assert.equal(cfg.readConfig().onboardingComplete, true);
  fs.rmSync(configFile);
  const missing = await syncCalls(userData, () => cfg.configIntegrityIssueAsync());
  assert.equal(missing.result, null);
  assert.deepEqual(missing.calls, []);
  assert.equal(cfg.readConfig().onboardingComplete, false, 'defaults');
  for (const n of corruptCopies()) fs.rmSync(path.join(userData, n));
});

test('config integrity (async): concurrent polls share one flight, and a write during the flight is not undone by it', async () => {
  fs.writeFileSync(configFile, JSON.stringify({ ...MIGRATED, onboardingComplete: false }), 'utf8');
  cfg.__resetConfigCacheForTests();
  const a = cfg.configIntegrityIssueAsync();
  const b = cfg.configIntegrityIssueAsync();
  assert.equal(a, b, 'one flight');
  // Our own write lands while the flight's stat or read is out: the flight holds older bytes.
  cfg.writeConfig({ onboardingComplete: true });
  assert.equal(await a, null);
  assert.equal(cfg.readConfig().onboardingComplete, true, 'the cache was not filled with the pre-write bytes');
  assert.equal(JSON.parse(fs.readFileSync(configFile, 'utf8')).onboardingComplete, true);
  assert.notEqual(cfg.configIntegrityIssueAsync(), a, 'a finished flight is not reused');
  await cfg.configIntegrityIssueAsync();
});

// ── path 2: tasks.json ──────────────────────────────────────────────────────────────────────
const card = (id, extra = {}) => ({ id, title: `card ${id}`, status: 'todo', tags: ['x'], ...extra });
const ids = (ledger) => ledger.tasks.map((c) => c.id);
function tasksFloor(t, tasks = [card('T1')]) {
  const home = fs.mkdtempSync(path.join(JAIL, 'tasks-'));
  const hive = new HiveManager(() => home);
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  hive.ensureHive();
  const file = path.join(hive.root(), 'tasks.json');
  const handEdit = (list) => fs.writeFileSync(file, JSON.stringify({ tasks: list }), 'utf8');
  handEdit(tasks);
  return { hive, file, handEdit, home };
}

test('tasks.json: an outside edit reaches the guard and its listeners with no synchronous read or stat of the ledger', async (t) => {
  const { hive, file, handEdit } = tasksFloor(t);
  hive.startLedgerGuard();
  assert.deepEqual(ids(hive.tasks()), ['T1']);
  const seen = [];
  // What index.ts hangs on the guard: listeners that read the board (hive.tasks()) on every change.
  hive.ledgerGuard.onChange((change) => { seen.push({ by: change.by, added: change.added, ids: ids(hive.tasks()) }); });
  const { calls } = await syncCalls(file, async () => {
    handEdit([card('T1'), card('T2')]);
    await until(() => seen.length > 0, 'the guard to announce the edit');
    // And every reader after it, for longer than the missed-watch fallback's period.
    const end = Date.now() + HiveManager.AUTHORITY_FALLBACK_MS + 600;
    while (Date.now() < end) { assert.deepEqual(ids(hive.tasks()), ['T1', 'T2']); await new Promise((r) => setTimeout(r, 50)); }
  });
  assert.deepEqual(seen[0], { by: 'file', added: ['T2'], ids: ['T1', 'T2'] }, 'the listener reads the edited board');
  assert.equal(seen.length, 1, 'one edit, one change');
  assert.deepEqual(calls.filter((c) => c !== 'writeFileSync:tasks.json'), [], 'no synchronous fs on tasks.json besides this test\'s own write');
});

test('tasks.json: the guard\'s sidecar for an outside edit is written off the main thread, before its listeners hear of it', async (t) => {
  const { hive, handEdit } = tasksFloor(t);
  hive.startLedgerGuard();
  const state = path.join(hive.root(), 'state');
  const sidecar = () => Object.keys(JSON.parse(fs.readFileSync(path.join(state, 'task-meta.json'), 'utf8')).cards);
  assert.deepEqual(sidecar(), ['T1'], 'the first check at start wrote it');
  const seen = [];
  let onDisk = null;
  hive.ledgerGuard.onChange((change) => { seen.push(change.added); });
  const { calls } = await syncCalls(state, async () => {
    handEdit([card('T1'), card('T2')]);
    await until(() => seen.length > 0, 'the guard to announce the edit');
  });
  onDisk = sidecar();
  assert.deepEqual(calls.filter((c) => /task-meta|^mkdirSync:state$/.test(c)), [], 'no synchronous write, rename or mkdir for the sidecar');
  assert.deepEqual(onDisk, ['T1', 'T2'], 'the sidecar on disk holds the change when the listener is told (derived card facts read it from disk)');
  assert.deepEqual(Object.keys(hive.ledgerGuard.taskMeta().cards), ['T1', 'T2']);
  assert.deepEqual(fs.readdirSync(state).filter((n) => n.includes('.tmp-')), [], 'no temp file left');
});

test('tasks.json: an API write that lands during the async sidecar write is the last word on disk', async (t) => {
  const { hive, handEdit } = tasksFloor(t);
  hive.startLedgerGuard();
  const state = path.join(hive.root(), 'state');
  const sidecar = () => Object.keys(JSON.parse(fs.readFileSync(path.join(state, 'task-meta.json'), 'utf8')).cards).sort();
  const fsp = require('node:fs/promises');
  // Land our own (synchronous) write inside the async sidecar write: once while the temp file
  // is being written (the async write must withdraw), once just as it renames (it must repeat).
  for (const [round, hook] of [[0, 'writeFile'], [1, 'rename']]) {
    const outside = `F${round}`; const ours = `A${round}`;
    const orig = fsp[hook];
    let fired = 0;
    fsp[hook] = function (...args) {
      if (fired === 0 && args.some((a) => typeof a === 'string' && /task-meta\.json/.test(a))) {
        fired++;
        hive.addTask({ id: ours, title: 'ours', status: 'todo' });
      }
      return orig.apply(this, args);
    };
    try {
      handEdit([...hive.tasks().tasks, card(outside)]);
      await hive.ledgerGuard.checkSoon();
      await hive.ledgerGuard.checkSoon();
    } finally { fsp[hook] = orig; }
    assert.equal(fired, 1, `${hook}: the async sidecar write ran and our write landed inside it`);
    const want = Object.keys(hive.ledgerGuard.taskMeta().cards).sort();
    assert.ok(want.includes(ours) && want.includes(outside), `${hook}: both cards are in the guard's record: ${want}`);
    assert.deepEqual(sidecar(), want, `${hook}: the sidecar on disk is the guard's newest record`);
  }
  assert.deepEqual(fs.readdirSync(state).filter((n) => n.includes('.tmp-')), [], 'no temp file left');
});

test('tasks.json: readers past the revalidate window are still served from memory (the fallback renews the entry off-thread)', async (t) => {
  assert.ok(HiveManager.AUTHORITY_FALLBACK_MS < HiveManager.AUTHORITY_REVALIDATE_MS, 'the fallback renews before a reader finds the entry expired');
  const { hive, file } = tasksFloor(t);
  hive.startLedgerGuard();
  hive.tasks();
  const { calls } = await syncCalls(file, async () => {
    const end = Date.now() + HiveManager.AUTHORITY_REVALIDATE_MS + 1_500;
    while (Date.now() < end) { assert.deepEqual(ids(hive.tasks()), ['T1']); await new Promise((r) => setTimeout(r, 100)); }
  });
  assert.deepEqual(calls, [], 'no synchronous stat or read of tasks.json across the window');
});

test('tasks.json: our own API write is announced as ours and read back at once (the cache never serves the pre-write board)', async (t) => {
  const { hive } = tasksFloor(t);
  hive.startLedgerGuard();
  const seen = [];
  hive.ledgerGuard.onChange((change) => { seen.push({ by: change.by, ids: ids(hive.tasks()) }); });
  hive.addTask({ id: 'T9', title: 'ours', status: 'todo' });
  assert.deepEqual(ids(hive.tasks()), ['T1', 'T9']);
  await hive.ledgerGuard.checkSoon();
  await new Promise((r) => setTimeout(r, 600));
  await hive.ledgerGuard.checkSoon();
  assert.ok(seen.length >= 1, 'announced');
  for (const s of seen) { assert.match(s.by, /^api:/, `never attributed to a hand edit: ${s.by}`); assert.deepEqual(s.ids, ['T1', 'T9']); }
});

test('tasks.json: a check in flight when the guard stops announces nothing', async (t) => {
  const { hive, handEdit } = tasksFloor(t);
  hive.startLedgerGuard();
  hive.tasks();
  let changes = 0;
  hive.ledgerGuard.onChange(() => { changes++; });
  handEdit([card('T1'), card('T3')]);
  const flight = hive.ledgerGuard.checkSoon();
  hive.ledgerGuard.stop();
  await flight;
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(changes, 0, 'stopped: the read that came back belongs to nothing');
  assert.equal(hive.ledgerGuard.running(), false);
  assert.deepEqual(ids(hive.tasks()), ['T1', 'T3'], 'readers still get the file');
});

test('tasks.json: a corrupt or missing ledger is left to the synchronous reader (quarantine and defaults as before)', async (t) => {
  const { hive, file } = tasksFloor(t);
  hive.startLedgerGuard();
  hive.tasks();
  fs.writeFileSync(file, '{"tasks":[', 'utf8');
  await hive.ledgerGuard.checkSoon();
  await new Promise((r) => setTimeout(r, 500));
  await hive.ledgerGuard.checkSoon();
  const before = fs.readdirSync(hive.root()).filter((n) => n.startsWith('tasks.json.corrupt'));
  let threw = null; let got = null;
  try { got = hive.tasks(); } catch (e) { threw = e; }
  // Whatever the synchronous reader does with a corrupt ledger, a fresh manager over the same
  // folder (no async path has run in it) must do the same.
  const other = new HiveManager(() => path.dirname(hive.root()));
  t.after(() => other.dispose());
  let threw2 = null; let got2 = null;
  try { got2 = other.tasks(); } catch (e) { threw2 = e; }
  assert.equal(!!threw, !!threw2, 'same outcome kind');
  if (threw) assert.equal(String(threw.message).replace(/corrupt-[\w.-]+/g, 'corrupt-X'), String(threw2.message).replace(/corrupt-[\w.-]+/g, 'corrupt-X'));
  else assert.deepEqual(got, got2);
  assert.ok(before.length <= 1, 'the async refresh takes no quarantine copy of its own');
});

test('derived claims: readCardsAsync is readCards with the ledger read off the main thread', async (t) => {
  const { hive, file } = tasksFloor(t, [card('A1', { status: 'doing' }), card('A2', { status: 'done' })]);
  const root = hive.root();
  const sync = derived.readCards(root);
  const { calls, result } = await syncCalls(file, () => derived.readCardsAsync(root));
  assert.deepEqual(result, sync);
  assert.ok(result.length >= 2);
  assert.deepEqual(calls, []);
  fs.writeFileSync(file, 'not json', 'utf8');
  assert.deepEqual(await derived.readCardsAsync(root), derived.readCards(root), 'corrupt: as the synchronous one');
  fs.rmSync(file);
  assert.deepEqual(await derived.readCardsAsync(root), derived.readCards(root), 'missing: as the synchronous one');
});

// ── path 3: hive:mailObligations ────────────────────────────────────────────────────────────
async function mailFloor(t) {
  const home = fs.mkdtempSync(path.join(JAIL, 'mail-'));
  const hive = new HiveManager(() => home, () => true);
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'andy-1', name: 'Andy', provider: 'claude', cwd: home });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'codex', cwd: home });
  await hive.ensureAgent({ id: 'pam-1', name: 'Pam', provider: 'claude', cwd: home });
  const q = hive.send({ to: 'andy-1', act: 'request', subject: 'Review PR 12', body: 'please' }, 'god-1');
  const lost = hive.send({ to: 'jim-1', act: 'request', subject: 'Audit', body: 'x' }, 'god-1');
  hive.send({ to: 'andy-1', act: 'inform', subject: 'fyi', body: 'no reply owed' }, 'god-1');
  hive.mail.bodyMissing('jim-1', lost.id, 'missing');
  // The sends above left each ledger a save on a timer: write them now, so no save of theirs
  // lands inside a counted window.
  hive.mail.flushAll();
  watched(hive.root());
  await new Promise((r) => setTimeout(r, 150));
  return { hive, home, q, lost };
}
const plain = (v) => JSON.parse(JSON.stringify(v));
/** Ages move with the clock between two calls: compare everything else exactly. */
const ageless = (view) => JSON.parse(JSON.stringify(view, (k, v) => (/^age(Ms)?$/i.test(k) ? 0 : v)));

test('mail obligations (async): the synchronous view, with no synchronous fs once the ledgers are loaded', async (t) => {
  const { hive, home, q, lost } = await mailFloor(t);
  const sync = hive.mailObligations();
  assert.deepEqual(sync.map((a) => [a.agentId, a.openRequestCount]), [['andy-1', 1], ['jim-1', 1]]);
  const counted = await syncCalls(home, () => hive.mailObligations());
  assert.ok(counted.calls.filter((c) => c.startsWith('existsSync:')).length >= 3, `the synchronous view probes the inboxes: ${counted.calls}`);
  const { calls, result } = await syncCalls(home, () => hive.mailObligationsAsync());
  assert.deepEqual(calls, [], 'no synchronous fs under the hive');
  assert.deepEqual(ageless(result), ageless(sync));
  assert.deepEqual(plain(result).flatMap((a) => a.openRequests.map((r) => r.id)).sort(), [q.id, lost.id].sort());
  // An archived agent leaves the list in both.
  hive.setArchived('jim-1', true);
  assert.deepEqual(ageless(await hive.mailObligationsAsync()), ageless(hive.mailObligations()));
  assert.deepEqual((await hive.mailObligationsAsync()).map((a) => a.agentId), ['andy-1']);
});

test('mail obligations (async): ledgers not loaded yet, an agent with no inbox and an unreadable ledger give the synchronous answers', async (t) => {
  const { hive, home } = await mailFloor(t);
  // A second manager over the same hive has loaded no ledger: the async view loads them itself
  // (the load runs restart recovery, so the yardstick is another cold manager, read synchronously).
  const cold = new HiveManager(() => home, () => true);
  const coldSync = new HiveManager(() => home, () => true);
  t.after(() => { cold.dispose(); coldSync.dispose(); });
  const coldView = ageless(await cold.mailObligationsAsync());
  assert.deepEqual(coldView, ageless(coldSync.mailObligations()));
  assert.deepEqual(coldView.map((a) => [a.agentId, a.openRequestCount]), [['andy-1', 1], ['jim-1', 1]]);
  // No inbox: the agent has nothing, as hasAgent() said.
  fs.rmSync(path.join(hive.root(), 'agents', 'pam-1', 'inbox'), { recursive: true, force: true });
  assert.deepEqual(ageless(await hive.mailObligationsAsync()), ageless(hive.mailObligations()));
  const gone = new HiveManager(() => home, () => true);
  const goneSync = new HiveManager(() => home, () => true);
  t.after(() => { gone.dispose(); goneSync.dispose(); });
  assert.deepEqual(ageless(await gone.mailObligationsAsync()), ageless(goneSync.mailObligations()));
});

// ── the wiring ──────────────────────────────────────────────────────────────────────────────
test('wiring: the two polls and the ledger watch use the off-thread paths', () => {
  const index = codeOnly(readSource('src/main/index.ts'));
  assert.match(index, /ipcMain\.handle\('config:integrity', \(\) => configIntegrityIssueAsync\(\)\)/);
  assert.doesNotMatch(index, /ipcMain\.handle\('config:integrity', \(\) => configIntegrityIssue\(\)\)/);
  const at = index.indexOf("ipcMain.handle('hive:mailObligations'");
  assert.ok(at >= 0);
  const handler = index.slice(at, at + 900);
  assert.match(handler, /await hive\.mailObligationsAsync\(\)/);
  assert.doesNotMatch(handler, /hive\.mailObligations\(\)/);
  const guard = codeOnly(readSource('src/main/taskLedgerGuard.ts'));
  assert.match(guard, /this\.poll = setInterval\(\(\) => \{ void this\.checkSoon\(\); \}, GUARD_POLL_MS\)/);
  assert.match(guard, /this\.debounce = setTimeout\(\(\) => \{ this\.debounce = null; void this\.checkSoon\(\); \}, GUARD_DEBOUNCE_MS\)/);
  assert.equal((guard.match(/readFileSync\(join\(root, 'tasks\.json'\)/g) || []).length, 1, 'the guard keeps one synchronous read: check(), for start() and API callers');
  const live = codeOnly(readSource('src/main/claims/derivedLive.ts'));
  assert.doesNotMatch(live, /\breadCards\(/, 'the live derived writer reads the ledger with readCardsAsync');
  const hive = codeOnly(readSource('src/main/hive.ts'));
  assert.match(hive, /readLedger: \(root, known\) => this\.loadAuthorityAsync\(join\(root, 'tasks\.json'\), true, known\)/);
});
