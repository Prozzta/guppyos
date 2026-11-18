'use strict';
require('./tools/own-job.cjs');

/**
 * LAG-MAIN-SYNC-REMAINDER-108 (god b76880): the main-thread synchronous hive I/O the 1.1.106 and
 * 1.1.107 stall rows still named after LAG-SYNC-IO-107:
 *   1. ipc:hive:cardBadges      3 existsSync per agent, every 5 s (AgentStrip's poll)
 *   2. the floor digest run     readFileSync x3 under state/, writeFileSync floor-digest.md.tmp
 *   3. ipc:hive:floorDigest     readFileSync floor-digest.md
 *   4. ipc:hive:log             readdirSync of the hive root, existsSync/statSync/openSync log.jsonl
 *   5. memory-sources.json      existsSync + readFileSync on every claimLevel and derivedRepoNow
 * Each test counts every synchronous fs call under the test's own hive while the path runs (the
 * count must be zero) and holds the answer to the synchronous one. Counts of calls, never
 * milliseconds. HOME and USERPROFILE are jailed first.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-lag-main-sync-108-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, CODEX_HOME: process.env.CODEX_HOME, GEMINI_CLI_HOME: process.env.GEMINI_CLI_HOME };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL; process.env.CODEX_HOME = path.join(JAIL, '.codex'); process.env.GEMINI_CLI_HOME = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');

const userData = path.join(JAIL, 'userData');
fs.mkdirSync(userData);
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { app: { getPath: () => userData } } };
const { HiveManager } = loadTs('src/main/hive.ts');
const { fleetMailFields } = loadTs('src/main/mailReaders.ts');
const { FloorDigest, FLOOR_DIGEST_DEFAULTS } = loadTs('src/main/floorDigest.ts');
const { readSourcesConfig, SOURCES_CONFIG_FILE } = loadTs('src/main/nativeMemory/sources.ts');
/** A module this card adds: absent on the base, where the tests that need it fail by name. */
const added = (rel, name) => {
  let mod;
  try { mod = loadTs(rel); } catch (e) { assert.fail(`${rel} does not load: ${String(e).slice(0, 200)}`); }
  assert.equal(typeof mod[name], 'function', `${rel} must export ${name}`);
  return mod[name];
};

test.after(() => {
  loadTs.closeConfigWatchers();
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

/** Every synchronous fs function that takes a path first (as test/lag-sync-io-107.test.cjs). */
const SYNC_FNS = Object.keys(fs).filter((k) => k.endsWith('Sync') && typeof fs[k] === 'function' && !/^(f|close|write|read)Sync$|^(fstat|fsync|fdatasync|ftruncate|futimes|fchmod|fchown|readv|writev)Sync$/.test(k));
const under = (dir, p) => { const s = path.resolve(String(p)).toLowerCase(); const d = path.resolve(dir).toLowerCase(); return s === d || s.startsWith(d + path.sep); };
/** safeDirectoryWatch.ts probes existsSync(the watched folder) around each fs.watch event; that is
 *  the watcher's, arrives when the OS delivers the event, and is not counted against a path. */
const WATCHED = new Set();
const watched = (dir) => { WATCHED.add(path.resolve(dir).toLowerCase()); };
/** Run fn (sync or async) and return the synchronous fs calls it made on paths under `dir`.
 *  A temp file's random suffix is cut, so the lists compare exactly. */
async function syncCalls(dir, fn) {
  const orig = {};
  const calls = [];
  for (const k of SYNC_FNS) {
    orig[k] = fs[k];
    fs[k] = function (p, ...rest) {
      const probe = k === 'existsSync' && typeof p === 'string' && WATCHED.has(path.resolve(p).toLowerCase());
      if (!probe && (typeof p === 'string' || Buffer.isBuffer(p) || p instanceof URL) && under(dir, p)) calls.push(`${k}:${path.basename(String(p)).replace(/\.tmp-[0-9a-f]+$/, '.tmp')}`);
      return orig[k].call(this, p, ...rest);
    };
  }
  let result;
  try { result = await fn(); } finally { for (const k of SYNC_FNS) fs[k] = orig[k]; }
  return { calls, result };
}

const AGENTS = [['god-1', 'Michael'], ['andy-1', 'Andy'], ['jim-1', 'Jim'], ['pam-1', 'Pam']];
async function floor(t) {
  const home = fs.mkdtempSync(path.join(JAIL, 'floor-'));
  const hive = new HiveManager(() => home, () => true);
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  for (const [id, name] of AGENTS) await hive.ensureAgent({ id, name, provider: 'claude', cwd: home, isGod: id === 'god-1' });
  hive.send({ to: 'andy-1', act: 'request', subject: 'Review PR 12', body: 'please' }, 'god-1');
  hive.send({ to: 'andy-1', act: 'inform', subject: 'fyi', body: 'no reply owed' }, 'god-1');
  // The sends left each ledger a save on a timer: write them now, so none lands in a counted window.
  hive.mail.flushAll();
  watched(hive.root());
  await new Promise((r) => setTimeout(r, 150));
  return { hive, home, root: hive.root() };
}

const MIN = 60_000;
const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const flag = (cardId, kind, decision) => ({ cardId, kind, agentId: 'jim-1', since: NOW, evidence: `${kind} evidence`, decision });
function digestRig(root, flags = []) {
  const clock = { now: NOW };
  const sent = [];
  const logged = [];
  const host = {
    root: () => root, fleetSnapshot: () => ({ agents: [] }), tasks: () => ({ tasks: [{ id: 'A', status: 'doing', assignee: 'jim-1' }] }), taskMeta: () => ({}),
    flags: () => flags, ledgerIssues: () => [], send: (m, from) => sent.push({ ...m, from }), appendLog: (row) => logged.push(row)
  };
  const digest = new FloorDigest(host, () => ({ ...FLOOR_DIGEST_DEFAULTS, wakeBatchMs: 10 * MIN }), () => clock.now);
  return { digest, clock, sent, logged, flags };
}

// ── the counter ─────────────────────────────────────────────────────────────────────────────
test('the counter sees the calls the old paths made (it is not vacuous)', async (t) => {
  const { hive, root } = await floor(t);
  // What ipc:hive:cardBadges ran for every agent on each 5 s poll (index.ts fleetMail).
  const mail = await syncCalls(root, () => AGENTS.map(([id]) => fleetMailFields(hive.mail, id)));
  assert.deepEqual(mail.calls, Array(AGENTS.length * 3).fill('existsSync:inbox'), 'three synchronous inbox probes per agent');
  assert.equal(mail.result[1].inboxBacklog, 2, 'andy-1 has two messages waiting');
  // What ipc:hive:log ran on each poll.
  const log = await syncCalls(root, () => hive.logTail(50));
  assert.ok(log.calls.includes(`readdirSync:${path.basename(root)}`) && log.calls.includes('statSync:log.jsonl'), `the synchronous tail lists the hive and stats the log: ${log.calls}`);
  // What claimLevel and derivedRepoNow ran on every call.
  fs.writeFileSync(path.join(root, SOURCES_CONFIG_FILE), JSON.stringify({ topLevel: [], include: {}, ledgerDefault: 'writer' }), 'utf8');
  const src = await syncCalls(root, () => readSourcesConfig(root));
  assert.deepEqual(src.calls, [`existsSync:${SOURCES_CONFIG_FILE}`, `readFileSync:${SOURCES_CONFIG_FILE}`]);
});

// ── path 1: hive:cardBadges ─────────────────────────────────────────────────────────────────
test('card badges come from the kept fleet snapshot: the same fields, no synchronous fs', async (t) => {
  const cardBadgesFromFleet = added('src/main/cardBadges.ts', 'cardBadgesFromFleet');
  const { hive, root } = await floor(t);
  const flags = [flag('A', 'STALE', true)];
  assert.deepEqual(cardBadgesFromFleet(hive.fleetSnapshotView(), flags), { flags, inboxBacklog: {}, inboxHeld: {}, heldUntil: {}, silentTurns: {} }, 'before the first snapshot: the flags and no badges');
  // The rows main's writeFleetSnapshot publishes: `...fleetMail(id)` and `silentTurn`.
  const silent = { kind: 'no-hooks', since: NOW - 5 * MIN, tool: 'Bash' };
  const agents = AGENTS.map(([id, name]) => ({
    id, name, ...fleetMailFields(hive.mail, id),
    ...(id === 'jim-1' ? { inboxHeld: 2, heldUntil: NOW + MIN } : {}),
    silentTurn: id === 'pam-1' ? silent : null
  }));
  hive.writeFleetSnapshot({ ts: NOW, agents });
  await hive.fleetFlushed();
  const { calls, result } = await syncCalls(root, () => cardBadgesFromFleet(hive.fleetSnapshotView(), flags));
  assert.deepEqual(calls, [], 'the badge answer touches no file');
  assert.deepEqual(result, {
    flags,
    inboxBacklog: { 'god-1': 0, 'andy-1': 2, 'jim-1': 0, 'pam-1': 0 },
    inboxHeld: { 'jim-1': 2 },
    heldUntil: { 'jim-1': NOW + MIN },
    silentTurns: { 'pam-1': silent }
  });
});

test('card badges: a held count without its release time, and rows that are not agents, publish nothing', () => {
  const cardBadgesFromFleet = added('src/main/cardBadges.ts', 'cardBadgesFromFleet');
  const none = { flags: [], inboxBacklog: {}, inboxHeld: {}, heldUntil: {}, silentTurns: {} };
  for (const snap of [null, undefined, 'x', 7, {}, { agents: 'x' }, { agents: [null, 4, 'a', {}, { id: 9, inboxBacklog: 1 }, { id: '', inboxBacklog: 1 }] }]) {
    assert.deepEqual(cardBadgesFromFleet(snap, []), none, `no badges from ${JSON.stringify(snap)}`);
  }
  const got = cardBadgesFromFleet({ agents: [
    { id: 'a', inboxBacklog: 3, inboxHeld: 1 },
    { id: 'b', inboxBacklog: 0, inboxHeld: 0, heldUntil: 50 },
    { id: 'c', inboxBacklog: 'many', inboxHeld: 2, heldUntil: 60, silentTurn: 'no' },
    { id: 'd', inboxBacklog: 1, inboxHeld: 1, heldUntil: 70, silentTurn: { kind: 'no-hooks', since: 5 } }
  ] }, []);
  assert.deepEqual(got, {
    flags: [],
    inboxBacklog: { a: 3, b: 0, d: 1 },
    inboxHeld: { c: 2, d: 1 },
    heldUntil: { c: 60, d: 70 },
    silentTurns: { d: { kind: 'no-hooks', since: 5 } }
  });
});

// ── path 2: the floor digest run ────────────────────────────────────────────────────────────
test('a digest run reads its state and writes the digest with no synchronous fs, and the digest is the same', async (t) => {
  const { root } = await floor(t);
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  fs.writeFileSync(path.join(root, 'state', 'asks-backstop.json'), JSON.stringify({ v: 1, closed: [{ agentId: 'andy-1', from: 'god-1', id: 'm-1', subject: 'Old ask', at: NOW - MIN }] }), 'utf8');
  fs.writeFileSync(path.join(root, 'state', 'needs-human-flagged.json'), JSON.stringify({ v: 1, flagged: [{ agentId: 'pam-1', name: 'Pam', card: 'A', id: 'm-2', subject: 'Look at this', at: NOW - MIN }] }), 'utf8');
  const r = digestRig(root, [flag('A', 'STALE', true)]);
  const first = await syncCalls(root, () => r.digest.run());
  assert.deepEqual(first.calls, [], 'the first run: three reads and two writes, none of them synchronous');
  assert.deepEqual(first.result, [], 'inside the batch window nobody is woken');
  const md = fs.readFileSync(path.join(root, 'floor-digest.md'), 'utf8');
  assert.match(md, /- andy-1 <- god-1: Old ask \(m-1\)/, 'the backstop file was read');
  assert.match(md, /- Pam on A: Look at this \(m-2\)/, 'the flagged file was read');
  assert.equal(typeof JSON.parse(fs.readFileSync(path.join(root, 'state', 'digest-woken.json'), 'utf8')).pendingSince, 'number', 'the pending decision was saved');
  assert.deepEqual(fs.readdirSync(root).filter((n) => n.includes('.tmp-')), [], 'no temp file is left');
  r.clock.now += 10 * MIN;
  const second = await syncCalls(root, () => r.digest.run());
  assert.deepEqual(second.calls, [], 'the waking run: no synchronous fs either');
  assert.equal(second.result.length, 1, 'the run answers with what it sent');
  assert.deepEqual(r.sent.map((m) => [m.to, m.act, m.subject, m.from]), [['god', 'inform', 'Floor: 1 decision(s)', 'digest']]);
  r.clock.now += 60 * MIN;
  const third = await syncCalls(root, () => r.digest.run());
  assert.deepEqual([third.calls, third.result, r.sent.length], [[], [], 1], 'the same decision never wakes god twice');
  assert.deepEqual(r.logged.filter((row) => row.kind !== 'floor-digest-wake'), [], 'no write failed');
});

test('digest runs that overlap wake god once, and a run under way when the digest stops writes nothing', async (t) => {
  const { root } = await floor(t);
  const r = digestRig(root, [flag('A', 'STALE', true)]);
  await r.digest.run();
  r.clock.now += 10 * MIN;
  // Three runs asked for in one turn (a flag change, the timer, the mirror guard): each reads the
  // woken state the one before it saved.
  const wakes = await Promise.all([r.digest.run(), r.digest.run(), r.digest.run()]);
  assert.deepEqual(wakes.map((w) => w.length), [1, 0, 0], 'the first run wakes; the two behind it see its saved state');
  assert.equal(r.sent.length, 1);

  const stopped = fs.mkdtempSync(path.join(JAIL, 'stopped-'));
  const s = digestRig(stopped, [flag('A', 'STALE', true)]);
  s.clock.now += 10 * MIN;
  await s.digest.run();
  s.clock.now += 10 * MIN;
  fs.rmSync(path.join(stopped, 'floor-digest.md'));
  const stateFile = path.join(stopped, 'state', 'digest-woken.json');
  const stateBefore = fs.readFileSync(stateFile, 'utf8');
  s.flags.push(flag('B', 'STALE', false));
  // A reset or a change of home stops the digest and then clears or leaves the folder: a run
  // already asked for must not write into it or wake god from it.
  const under_way = s.digest.run();
  s.digest.stop();
  assert.deepEqual(await under_way, []);
  assert.deepEqual([fs.existsSync(path.join(stopped, 'floor-digest.md')), fs.readFileSync(stateFile, 'utf8') === stateBefore, s.sent.length], [false, true, 0], 'no digest file, the saved state untouched, god not woken');
  assert.equal((await s.digest.run()).length, 1, 'a run asked for after the stop works as before');
  assert.ok(fs.existsSync(path.join(stopped, 'floor-digest.md')));
});

// ── path 4: hive:log ────────────────────────────────────────────────────────────────────────
test('the async log tail answers as the synchronous one, rotated files included, with no synchronous fs', async (t) => {
  const { hive, root } = await floor(t);
  assert.equal(typeof hive.logTailAsync, 'function', 'HiveManager must have logTailAsync');
  for (let i = 0; i < 40; i++) hive.appendLog({ kind: 'lag-108-row', seq: i });
  await hive.flushLog?.();
  const live = path.join(root, 'log.jsonl');
  const until = Date.now() + 10_000;
  while (!(fs.existsSync(live) && fs.readFileSync(live, 'utf8').includes('"seq":39'))) {
    if (Date.now() > until) assert.fail('the 40 rows never reached log.jsonl');
    await new Promise((r) => setTimeout(r, 20));
  }
  // Two rotated files beside the live one, an older legacy one, and a name that is not a log.
  fs.writeFileSync(path.join(root, 'log.1700000000000.jsonl'), Array.from({ length: 30 }, (_, i) => JSON.stringify({ kind: 'old', seq: i })).join('\n') + '\n', 'utf8');
  fs.writeFileSync(path.join(root, 'log.1800000000000.jsonl'), Array.from({ length: 30 }, (_, i) => JSON.stringify({ kind: 'mid', seq: i })).join('\n') + '\nnot json\n', 'utf8');
  fs.writeFileSync(path.join(root, 'log.legacy-1600000000000.jsonl'), JSON.stringify({ kind: 'legacy' }) + '\n', 'utf8');
  fs.writeFileSync(path.join(root, 'log.notes.jsonl'), JSON.stringify({ kind: 'not-a-log' }) + '\n', 'utf8');
  for (const n of [0, 1, 5, 60, 90, 5000]) {
    const want = hive.logTail(n);
    const { calls, result } = await syncCalls(root, () => hive.logTailAsync(n));
    assert.deepEqual(calls, [], `n=${n}: no synchronous fs`);
    assert.deepEqual(result, want, `n=${n}: the same rows as the synchronous tail`);
  }
  assert.ok(hive.logTail(5000).some((r) => r.kind === 'old') && hive.logTail(5000).some((r) => r.kind === 'legacy') && hive.logTail(5000).some((r) => r.raw === 'not json'), 'the comparison covered the rotated files and a row that is not JSON');
  assert.ok(!hive.logTail(5000).some((r) => r.kind === 'not-a-log'));
  fs.rmSync(live);
  assert.deepEqual(await hive.logTailAsync(10), hive.logTail(10), 'no live file: the rotated rows');
  const bare = new HiveManager(() => fs.mkdtempSync(path.join(JAIL, 'bare-')), () => false);
  t.after(() => bare.dispose());
  assert.deepEqual(await bare.logTailAsync(10), [], 'no hive: no rows');
});

// ── path 5: memory-sources.json ─────────────────────────────────────────────────────────────
test('the sources cache answers as readSourcesConfig, from memory once read, and follows the file', async (t) => {
  const SourcesConfigCache = added('src/main/nativeMemory/sourcesCache.ts', 'SourcesConfigCache');
  const root = fs.mkdtempSync(path.join(JAIL, 'sources-'));
  const file = path.join(root, SOURCES_CONFIG_FILE);
  const cache = new SourcesConfigCache();
  t.after(() => cache.dispose());
  const empty = { topLevel: [], include: {} };
  assert.deepEqual(cache.get(root), empty, 'no file: the empty config, as readSourcesConfig');
  fs.writeFileSync(file, JSON.stringify({ topLevel: ['board.md'], include: { 'andy-1': ['notes.md'] }, ledger: { 'andy-1': 'writer' }, ledgerDefault: 'writer' }), 'utf8');
  await cache.refresh(root);
  const hot = await syncCalls(root, () => [cache.get(root), cache.get(root), cache.get(root)]);
  assert.deepEqual(hot.calls, [], 'a kept config is served with no synchronous fs');
  for (const got of hot.result) assert.deepEqual(got, readSourcesConfig(root));
  assert.equal(hot.result[0].ledger['andy-1'], 'writer');
  // An edit from outside (god, the Human, the CLI) is picked up by the off-thread check.
  await new Promise((r) => setTimeout(r, 150));
  fs.writeFileSync(file, JSON.stringify({ topLevel: [], include: {}, ledger: { 'andy-1': 'off' } }), 'utf8');
  const check = await syncCalls(root, () => cache.refresh(root));
  assert.deepEqual(check.calls, [], 'the check itself is off the main thread');
  assert.deepEqual(cache.get(root), readSourcesConfig(root));
  assert.equal(cache.get(root).ledger['andy-1'], 'off');
  // A file that is not JSON, then no file: empty both times, never an error and never the old value.
  fs.writeFileSync(file, '{ not json', 'utf8');
  await cache.refresh(root);
  assert.deepEqual(cache.get(root), empty);
  fs.writeFileSync(file, JSON.stringify({ topLevel: ['x.md'], include: {} }), 'utf8');
  await cache.refresh(root);
  assert.deepEqual(cache.get(root).topLevel, ['x.md']);
  fs.rmSync(file);
  await cache.refresh(root);
  assert.deepEqual(cache.get(root), empty);
  // Main's own write (the seed, a promotion): dropped, so the very next read is the disk.
  fs.writeFileSync(file, JSON.stringify({ topLevel: [], include: {}, ledgerDefault: 'writer' }), 'utf8');
  cache.drop();
  assert.equal(cache.get(root).ledgerDefault, 'writer', 'after drop() the next get reads the file');
  // Another hive root is another config.
  const other = fs.mkdtempSync(path.join(JAIL, 'sources-b-'));
  assert.deepEqual(cache.get(other), empty);
  assert.equal(cache.get(root).ledgerDefault, 'writer');
});

test('the sources cache checks the file on its own clock, with no caller asking twice', async (t) => {
  const SourcesConfigCache = added('src/main/nativeMemory/sourcesCache.ts', 'SourcesConfigCache');
  const root = fs.mkdtempSync(path.join(JAIL, 'sources-t-'));
  const file = path.join(root, SOURCES_CONFIG_FILE);
  fs.writeFileSync(file, JSON.stringify({ topLevel: [], include: {}, ledgerDefault: 'writer' }), 'utf8');
  let checks = 0;
  const cache = new SourcesConfigCache({ revalidateMs: 25, onCheck: () => { checks++; } });
  t.after(() => cache.dispose());
  assert.equal(cache.get(root).ledgerDefault, 'writer');
  await new Promise((r) => setTimeout(r, 150));
  fs.writeFileSync(file, JSON.stringify({ topLevel: [], include: {} }), 'utf8');
  // Wait on the checks themselves (two more after the edit), not on a time.
  const from = checks;
  const end = Date.now() + 10_000;
  while (checks < from + 2) {
    if (Date.now() > end) assert.fail(`the cache never checked the file again (${checks} checks)`);
    await new Promise((r) => setTimeout(r, 10));
  }
  const { calls, result } = await syncCalls(root, () => cache.get(root));
  assert.deepEqual(calls, []);
  assert.equal(result.ledgerDefault, undefined, 'the first get after the edit already has it');
  cache.dispose();
  const at = checks;
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(checks, at, 'dispose() stops the checks');
});

test('a check under way when main writes the file does not put the old config back', async (t) => {
  const SourcesConfigCache = added('src/main/nativeMemory/sourcesCache.ts', 'SourcesConfigCache');
  const root = fs.mkdtempSync(path.join(JAIL, 'sources-r-'));
  const file = path.join(root, SOURCES_CONFIG_FILE);
  fs.writeFileSync(file, JSON.stringify({ topLevel: [], include: {}, ledger: { 'andy-1': 'off' } }), 'utf8');
  const cache = new SourcesConfigCache();
  t.after(() => cache.dispose());
  assert.equal(cache.get(root).ledger['andy-1'], 'off');
  // Hold the check's read: it has the old text in hand and has not answered yet.
  const fsp = require('node:fs/promises');
  const realRead = fsp.readFile;
  let release; let reads = 0;
  const gate = new Promise((r) => { release = r; });
  fsp.readFile = async (p, ...rest) => {
    if (path.resolve(String(p)) !== path.resolve(file)) return realRead(p, ...rest);
    reads++;
    const old = await realRead(p, ...rest);
    await gate;
    return old;
  };
  t.after(() => { fsp.readFile = realRead; });
  const under_way = cache.refresh(root);
  while (reads < 1) await new Promise((r) => setImmediate(r));
  // Main promotes the agent (its own write, then drop) and reads the level at once.
  fs.writeFileSync(file, JSON.stringify({ topLevel: [], include: {}, ledger: { 'andy-1': 'writer' } }), 'utf8');
  cache.drop();
  assert.equal(cache.get(root).ledger['andy-1'], 'writer');
  release();
  await under_way;
  assert.equal(reads, 1, 'the held read is the check (the test is not vacuous)');
  assert.equal(cache.get(root).ledger['andy-1'], 'writer', 'the late answer of the old check is not kept');
});

// ── wiring ──────────────────────────────────────────────────────────────────────────────────
test('main wiring: the five paths use the answers above', () => {
  const index = codeOnly(readSource('src/main/index.ts'), 'index.ts');
  assert.match(index, /ipcMain\.handle\('hive:cardBadges', \(\) => cardBadgesFromFleet\(hive\.fleetSnapshotView\(\), boardMonitor\.flags\(\)\)\);/, 'hive:cardBadges answers from the kept snapshot');
  assert.match(index, /silentTurn: silent\[id\] \?\? null,/, 'the snapshot rows carry the silent turn');
  assert.match(index, /\.\.\.fleetMail\(id\),/, 'and the mail fields');
  assert.equal((index.match(/floorDigest\.run\(\)/g) ?? []).length, 2);
  assert.equal((index.match(/void floorDigest\.run\(\)\.catch\(\(e\) => \{ console\.error\('\[floor-digest\]', e\); \}\);/g) ?? []).length, 2, 'both callers start the async run and report its failure');
  assert.match(index, /ipcMain\.handle\('hive:floorDigest', async \(\) => \{\n\s+const root = hive\.root\(\);\n\s+if \(!root\) return '';\n\s+try \{ return await readFileTracked\(join\(root, FLOOR_DIGEST_FILE\), 'utf8'\); \} catch \{ return ''; \}\n\}\);/, 'the Floor panel read is async');
  assert.match(index, /ipcMain\.handle\('hive:log', \(_evt, n: unknown\) => hive\.logTailAsync\(typeof n === 'number' \? n : 200\)\);/, 'the log poll is async');
  assert.doesNotMatch(index, /readSourcesConfig\(/, 'main reads memory-sources.json through the cache only');
  assert.equal((index.match(/sourcesConfig\.get\(root\)/g) ?? []).length, 4, 'derivedRepoNow, claimLevel, the import candidates and the Settings floor');
  assert.match(index, /const wrote = seedFloorSources\(root, project\);\n\s+sourcesConfig\.drop\(\);/, 'the seed drops the kept config');
  assert.match(index, /promote: \(agentId\) => \{ enableLedgerAgent\(root, agentId\); sourcesConfig\.drop\(\); \},/);
  assert.match(index, /seedDefault: \(\) => \{ enableLedgerDefault\(root\); sourcesConfig\.drop\(\); \},/);
});
