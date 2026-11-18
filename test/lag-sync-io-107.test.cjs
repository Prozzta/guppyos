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
  t.after(async () => { hive.dispose(); await hive.drainReads(); fs.rmSync(home, { recursive: true, force: true }); });
  hive.ensureHive();
  const file = path.join(hive.root(), 'tasks.json');
  const handEdit = (list) => fs.writeFileSync(file, JSON.stringify({ tasks: list }), 'utf8');
  handEdit(tasks);
  watched(hive.root());
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
  // ASYNC-RENAME-POSIX-107: the hook below is on the plain rename, so the addon rename is switched off here.
  const atomic = loadTs('src/main/atomicJson.ts');
  atomic.__setRenameAddonForTest(null);
  t.after(() => atomic.__setRenameAddonForTest(undefined));
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
  t.after(async () => { hive.dispose(); await hive.drainReads(); fs.rmSync(home, { recursive: true, force: true }); });
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
const ageless = (view) => JSON.parse(JSON.stringify(view, (k, v) => (/^age(Ms|Sec)?$/i.test(k) ? 0 : v)));

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
// ── round 2 (god 0c3d03; Jim da8425): the archive read, the mail body read, the first ledger load ──
const fsp = require('node:fs/promises');
const archive = loadTs('src/main/taskArchive.ts');
const mailCards = loadTs('src/main/mailCards.ts');
const { HookServer } = loadTs('src/main/hooks.ts');
const H = 60 * 60_000;
const oldDone = (id, extra = {}) => card(id, { status: 'done', doneAt: new Date(Date.now() - 72 * H).toISOString(), ...extra });
/** Run fn with one node:fs/promises function wrapped: `after(path)` runs once the wrapped call for
 *  a path it accepts has its answer, before the caller sees it (a write landing mid-read). */
async function during(name, accepts, after, fn) {
  const real = fsp[name];
  let fired = 0;
  fsp[name] = async function (p, ...rest) {
    const out = await real.call(this, p, ...rest);
    if (accepts(String(p)) && fired++ === 0) after(String(p));
    return out;
  };
  try { return { result: await fn(), fired }; } finally { fsp[name] = real; }
}
const jsonl = (calls) => calls.filter((c) => /\.jsonl$/.test(c));

test('archive: readCardsAsync reads tasks.json, the archive and task-meta.json with no synchronous fs, and answers as readCards', async (t) => {
  const { hive } = tasksFloor(t, [card('L1', { status: 'doing' }), oldDone('O1'), oldDone('O2')]);
  const root = hive.root();
  assert.deepEqual(hive.archivePass().sort(), ['O1', 'O2']);
  const sync = derived.readCards(root);
  assert.deepEqual(sync.map((c) => c.id).sort(), ['L1', 'O1', 'O2']);
  const counted = await syncCalls(root, () => derived.readCards(root));
  assert.ok(jsonl(counted.calls).length >= 2, `the synchronous reader reads the archive twice: ${counted.calls}`);
  const { calls, result } = await syncCalls(root, () => derived.readCardsAsync(root));
  assert.deepEqual(calls, [], 'no synchronous fs under the hive');
  assert.deepEqual(result, sync);
  // No archive folder at all: still asynchronous, still the synchronous answer.
  fs.rmSync(path.join(root, 'tasks-archive'), { recursive: true, force: true });
  const bare = await syncCalls(root, () => derived.readCardsAsync(root));
  assert.deepEqual(bare.calls, []);
  assert.deepEqual(bare.result, derived.readCards(root));
});

test('archive: a revive that lands while readCardsAsync is reading is the last word (never a mix of before and after)', async (t) => {
  const { hive } = tasksFloor(t, [card('L1'), oldDone('O1')]);
  const root = hive.root();
  assert.deepEqual(hive.archivePass(), ['O1']);
  // tasks.json is read (O1 not in it); then the revive moves O1 back to hot and tombstones it in
  // the archive. Hot-before plus archive-after would have O1 nowhere.
  const { result, fired } = await during('readFile', (p) => p.endsWith('tasks.json'), () => { assert.ok(hive.patchTask('O1', { notes: 'late' })); },
    () => derived.readCardsAsync(root));
  assert.equal(fired, 2, 'overtaken once, then read again');
  assert.deepEqual(result, derived.readCards(root));
  assert.deepEqual(result.map((c) => c.id).sort(), ['L1', 'O1']);
});

test('archive: readArchiveTextsAsync gives readArchive\'s cards and archiveStamp\'s stamp, shares one flight, and sees an outside append', async (t) => {
  const { hive } = tasksFloor(t, [oldDone('O1'), oldDone('O2')]);
  const root = hive.root();
  hive.archivePass();
  const [a, b] = await Promise.all([archive.readArchiveTextsAsync(root), archive.readArchiveTextsAsync(root)]);
  assert.equal(a, b, 'one flight');
  assert.equal(a.stamp, archive.archiveStamp(root));
  assert.deepEqual([...archive.parseArchive(a.texts)], [...archive.readArchive(root)]);
  const file = a.files[a.files.length - 1].file;
  fs.appendFileSync(file, `${JSON.stringify({ v: 1, at: new Date().toISOString(), card: oldDone('OUT') })}\n`);
  const c = await archive.readArchiveTextsAsync(root);
  assert.equal(c.stamp, archive.archiveStamp(root));
  assert.deepEqual([...archive.parseArchive(c.texts).keys()].sort(), ['O1', 'O2', 'OUT']);
  // A torn line is skipped by both.
  fs.appendFileSync(file, '{"v":1,"card":{"id":"TORN"');
  assert.deepEqual([...archive.parseArchive((await archive.readArchiveTextsAsync(root)).texts)], [...archive.readArchive(root)]);
});

test('archive: an archive pass and a revive no longer make the next reader read the archive synchronously', async (t) => {
  const { hive } = tasksFloor(t, [card('L1'), oldDone('O1')]);
  const root = hive.root();
  assert.deepEqual(hive.archivePass(), ['O1']);
  await hive.__revalidateArchiveForTests();
  const first = await syncCalls(root, () => hive.allTasks());
  assert.deepEqual(jsonl(first.calls).filter((c) => c.startsWith('readFileSync:')), [], `cached after the off-thread read: ${first.calls}`);
  assert.deepEqual(first.result.tasks.map((c) => c.id).sort(), ['L1', 'O1']);
  // A second pass: the appended bytes are read back (not the archive), and the cards in memory follow.
  assert.ok(hive.addTask(oldDone('O2', { notes: 'second' })));
  const pass = await syncCalls(root, () => { const moved = hive.archivePass(); return { moved, all: hive.allTasks().tasks }; });
  assert.deepEqual(pass.result.moved, ['O2']);
  assert.deepEqual(jsonl(pass.calls).filter((c) => c.startsWith('readFileSync:')), [], `no whole-archive read: ${pass.calls}`);
  assert.deepEqual(pass.result.all.map((c) => c.id).sort(), ['L1', 'O1', 'O2']);
  assert.deepEqual(plain(pass.result.all.find((c) => c.id === 'O2')), plain(archive.readArchive(root).get('O2')));
  // A revive: the card leaves the cached archive with its tombstone.
  const before = hive.archived(root);
  const rev = await syncCalls(root, () => { const ok = hive.patchTask('O1', { notes: 'back' }); return { ok, all: hive.allTasks().tasks }; });
  assert.ok(rev.result.ok);
  assert.deepEqual(jsonl(rev.calls).filter((c) => c.startsWith('readFileSync:')), [], `no whole-archive read: ${rev.calls}`);
  assert.equal(rev.result.all.filter((c) => c.id === 'O1').length, 1);
  assert.equal(rev.result.all.find((c) => c.id === 'O1').notes, 'back');
  assert.equal(archive.readArchive(root).has('O1'), false);
  // The merged-list cache compares the archive by identity: a write makes a new map, never edits the old one.
  assert.ok(before.has('O1') && !hive.archived(root).has('O1') && hive.archived(root) !== before, 'MUTANT: the archive write edits the cached map in place');
  // And the files agree with memory once re-read.
  await hive.__revalidateArchiveForTests();
  assert.deepEqual(hive.allTasks().tasks.map((c) => c.id).sort(), ['L1', 'O1', 'O2']);
});

test('archive: landedCards answers as the whole-archive read back does (whole, torn, and a later-named file)', (t) => {
  const { hive } = tasksFloor(t, []);
  const root = hive.root();
  const now = Date.now();
  const cards = [oldDone('A'), oldDone('B')];
  const whole = (list) => { const back = archive.readArchive(root); return list.filter((c) => JSON.stringify(back.get(c.id)) === JSON.stringify(c)).map((c) => c.id).sort(); };
  const mark = archive.appendArchived(root, cards, now);
  const got = archive.landedCards(root, mark, cards);
  assert.deepEqual([...got.landed].sort(), whole(cards));
  assert.equal(got.full, null, 'settled by the appended bytes');
  // A card that did not land as it was: the whole archive decides.
  const other = [{ ...cards[0], notes: 'changed' }, cards[1]];
  const mixed = archive.landedCards(root, mark, other);
  assert.deepEqual([...mixed.landed].sort(), whole(other));
  assert.deepEqual([...mixed.landed], ['B']);
  assert.ok(mixed.full, 'read whole');
  // A later-named archive file can hold a later line for the id: the whole archive decides.
  fs.writeFileSync(path.join(root, 'tasks-archive', '9999-12.jsonl'), `${JSON.stringify({ v: 1, at: new Date(now).toISOString(), tombstone: 'A' })}\n${JSON.stringify({ v: 1, at: new Date(now).toISOString(), card: oldDone('A', { notes: 'later' }) })}\n`);
  const later = archive.landedCards(root, mark, cards);
  assert.deepEqual([...later.landed].sort(), whole(cards));
  assert.deepEqual([...later.landed], ['B']);
  assert.deepEqual(archive.landedCards(root, null, cards).landed, later.landed, 'no mark: the whole archive');
});

test('archive: the mail-card catch-up lists the registry\'s card ids through its own driver, as registryCardIds does', async (t) => {
  const { hive } = tasksFloor(t, [card('L1'), oldDone('O1'), oldDone('O2')]);
  const root = hive.root();
  hive.archivePass();
  const drive = async (g) => {
    let input;
    for (;;) {
      const r = g.next(input);
      if (r.done) return r.value;
      const op = r.value;
      if (op && 'readdir' in op) input = await fsp.readdir(op.readdir).catch(() => []);
      else if (op && 'read' in op) input = await fsp.readFile(op.read, 'utf8').catch(() => undefined);
      else input = undefined;
    }
  };
  const sync = mailCards.registryCardIds(root);
  assert.deepEqual([...sync].sort(), ['L1', 'O1', 'O2']);
  const { calls, result } = await syncCalls(root, () => drive(mailCards.registryCardIdsSteps(root)));
  assert.deepEqual(calls, []);
  assert.deepEqual(result, sync);
  // A revive between the hot read and the archive read: read again, not O1 lost.
  const raced = await during('readFile', (p) => p.endsWith('tasks.json'), () => { assert.ok(hive.patchTask('O1', { notes: 'late' })); },
    () => drive(mailCards.registryCardIdsSteps(root)));
  assert.equal(raced.fired, 2, 'overtaken once, then read again');
  assert.deepEqual([...raced.result].sort(), ['L1', 'O1', 'O2']);
  assert.deepEqual(raced.result, mailCards.registryCardIds(root));
});

test('first ledger load (async): a cold manager loads each ledger with no synchronous read of the ledger or the inbox', async (t) => {
  const { hive, home } = await mailFloor(t);
  const reads = (calls) => calls.filter((c) => /^(readFileSync|readdirSync|statSync|lstatSync|existsSync|openSync):/.test(c));
  const coldSync = new HiveManager(() => home, () => true);
  const cold = new HiveManager(() => home, () => true);
  t.after(() => { cold.dispose(); coldSync.dispose(); });
  const counted = await syncCalls(path.join(hive.root(), 'agents'), () => coldSync.mailObligations());
  assert.ok(reads(counted.calls).some((c) => c === 'readFileSync:mail-ledger.json' || /^readFileSync:.*\.json$/.test(c)), `the synchronous load reads: ${counted.calls}`);
  const { calls, result } = await syncCalls(path.join(hive.root(), 'agents'), () => cold.mailObligationsAsync());
  assert.deepEqual(reads(calls), [], 'no synchronous read under agents/');
  assert.deepEqual(ageless(result), ageless(counted.result));
});

test('first ledger load (async): a delivery that loads the ledger while its files are being read is the last word', async (t) => {
  const { hive, home } = await mailFloor(t);
  const cold = new HiveManager(() => home, () => true);
  t.after(() => { cold.dispose(); });
  let sent = null;
  const { result, fired } = await during('readdir', (p) => /andy-1[\\/]inbox$/.test(p), () => { sent = cold.send({ to: 'andy-1', act: 'request', subject: 'mid-load', body: 'x' }, 'god-1'); },
    () => cold.mailObligationsAsync());
  assert.equal(fired, 1);
  assert.ok(sent && sent.id);
  assert.ok(cold.mail.ledger('andy-1').entries[sent.id], 'the delivery is in the loaded ledger');
  assert.deepEqual(ageless(result), ageless(cold.mailObligations()));
  assert.ok(plain(result).find((a) => a.agentId === 'andy-1').openRequests.some((r) => r.id === sent.id));
  void hive;
});

async function hookFloor(t) {
  const f = await mailFloor(t);
  const control = { takeSteer: () => null, shouldHalt: () => false, toolDecision: () => ({ deny: false }) };
  const server = new HookServer(f.hive, () => null, () => ({ notifications: false }), control, undefined, undefined, () => {});
  t.after(() => { try { server.stop(); } catch { /* noop */ } });
  const live = (agent_id, hook_event_name, extra = {}) => server.handleWithClaimContext({ agent_id, hook_event_name, session_id: `s-${agent_id}`, ...extra });
  const ctx = (res) => res?.hookSpecificOutput?.additionalContext ?? '';
  return { ...f, server, live, ctx };
}
const bodyReads = (calls, id) => calls.filter((c) => c.endsWith(`:${id}.json`));

test('mail bodies: a hook shows its mail with no synchronous read or stat of the mail file, as the synchronous handler shows it', async (t) => {
  const f = await hookFloor(t);
  const g = await hookFloor(t);
  // The yardstick: the same hook through the synchronous handler, which reads the body itself.
  const base = await syncCalls(g.home, () => g.server.handle({ agent_id: 'andy-1', hook_event_name: 'UserPromptSubmit', session_id: 's-andy-1', prompt: 'hi' }));
  assert.ok(bodyReads(base.calls, g.q.id).some((c) => c.startsWith('readFileSync:')), `the synchronous handler reads the body: ${base.calls}`);
  const { calls, result } = await syncCalls(f.home, () => f.live('andy-1', 'UserPromptSubmit', { prompt: 'hi' }));
  assert.deepEqual(bodyReads(calls, f.q.id), [], 'the body is read off the main thread');
  const text = f.ctx(result);
  assert.match(text, new RegExp(`\\[hive-mail:${f.q.id}\\]`));
  assert.match(text, /please/);
  const norm = (s, floor) => s.split(floor.q.id).join('<q>').replace(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{6}/g, '<id>').replace(/conv-[0-9a-f]+/g, '<conv>');
  assert.equal(norm(text, f), norm(g.ctx(base.result), g));
  assert.equal(f.hive.mail.ledger('andy-1').entries[f.q.id].state, g.hive.mail.ledger('andy-1').entries[g.q.id].state);
});

test('mail bodies: mail delivered while the bodies are being read is read off-thread too (the ledger is the generation check)', async (t) => {
  const f = await hookFloor(t);
  let late = null;
  const counted = await syncCalls(f.home, () => during('readFile', (p) => p.endsWith(`${f.q.id}.json`), () => { late = f.hive.send({ to: 'andy-1', act: 'request', subject: 'late', body: 'arrived mid-read' }, 'god-1'); },
    () => f.live('andy-1', 'UserPromptSubmit', { prompt: 'hi' })));
  assert.equal(counted.result.fired, 2, 'overtaken once, then read again');
  const text = f.ctx(counted.result.result);
  assert.match(text, /arrived mid-read/);
  assert.match(text, /please/);
  assert.deepEqual(bodyReads(counted.calls, late.id).filter((c) => !/^(writeFileSync|renameSync|openSync|mkdirSync):/.test(c) && !c.startsWith('existsSync:')), [], `the late mail's body was not read synchronously: ${bodyReads(counted.calls, late.id)}`);
  assert.deepEqual(bodyReads(counted.calls, f.q.id), []);
});

test('mail bodies: a body that is gone or unparseable is decided by the synchronous read, exactly as before', async (t) => {
  const f = await hookFloor(t);
  const g = await hookFloor(t);
  for (const x of [f, g]) fs.rmSync(path.join(x.hive.root(), 'agents', 'andy-1', 'inbox', `${x.q.id}.json`));
  const a = f.ctx(await f.live('andy-1', 'UserPromptSubmit', { prompt: 'hi' }));
  const b = g.ctx(g.server.handle({ agent_id: 'andy-1', hook_event_name: 'UserPromptSubmit', session_id: 's-andy-1', prompt: 'hi' }));
  assert.ok(!a.includes(`[hive-mail:${f.q.id}]`), a);
  assert.ok(!b.includes(`[hive-mail:${g.q.id}]`), b);
  const state = (x) => { const e = x.hive.mail.ledger('andy-1').entries[x.q.id]; return [e.state, e.reason ?? null, e.missingAt ? 'missing' : null]; };
  assert.deepEqual(state(f), state(g));
  assert.equal(state(f)[0], 'acted');
  // A subagent's hook and a one-way pipe read nothing ahead.
  assert.equal(await f.server.prefetchMailBodies({ agent_id: 'andy-1', hook_event_name: 'UserPromptSubmit', transport: 'pipe-oneway' }), null);
  assert.equal(await f.server.prefetchMailBodies({ agent_id: 'andy-1', hook_event_name: 'PreToolUse' }), null);
});

test('wiring (round 2): the archive, the ledger load and the mail bodies use the off-thread paths', () => {
  const dw = codeOnly(readSource('src/main/claims/derivedWriter.ts'));
  const at = dw.indexOf('export async function readCardsAsync');
  assert.match(dw.slice(at, dw.indexOf('function cardsFromLedger')), /readArchiveTextsAsync\(hiveRoot\)/);
  const mc = codeOnly(readSource('src/main/mailCards.ts'));
  assert.match(mc, /const cardIds = yield\* registryCardIdsSteps\(hiveRoot\)/);
  const ml = codeOnly(readSource('src/main/mailLedger.ts'));
  assert.match(ml, /try \{ await this\.stateAsync\(id\); \} catch \{ failed\.add\(id\); \}/);
  const hk = codeOnly(readSource('src/main/hooks.ts'));
  assert.match(hk, /bodies = await this\.prefetchMailBodies\(p\)/);
  const hv = codeOnly(readSource('src/main/hive.ts'));
  const pass = hv.slice(hv.indexOf('  archivePass(now'), hv.indexOf('  private archived(root'));
  assert.doesNotMatch(pass, /= readArchive\(root\)/, 'the pass reads back through landedCards');
  assert.match(pass, /landedCards\(root, mark, moving\)/);
});
