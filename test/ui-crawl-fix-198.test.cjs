'use strict';
require('./tools/own-job.cjs');

/**
 * UI-CRAWL fix (Dwight d41157ff moved fleet/capacity/undelivered persistence off main; Andy's audit
 * FAIL 0/2/3; god conv-88ef05). The crawl gain stays (worst stall 2117 -> 744 ms); these pins are the
 * regressions the related lane found and the audit's minors:
 *
 *   M1  a 1:1 hold and a rename patch the IN-MEMORY fleet snapshot (god's roster is injected from it)
 *       and republish through the async writer: no sync read-modify-write of fleet.json (that raced
 *       the async publish and lost the patch, and stalled main). fleetFlushed() settles once the
 *       publish is on disk.
 *   M2  a failed async capacity write is logged (console.warn), as the sync path always did.
 *   q   the will-quit race: the sync saveNow is the last word (an older async write withdraws at
 *       its rename, commit check) and leaves no stray `.tmp-*`.
 *   s   the STALL-WATCH sync counter map is bounded: temp/mail-id names fold to one key, the map
 *       holds the current minute only and at most SYNC_TARGETS_MAX targets, a row the busiest 12.
 *   b   BoardStatusWriter.write renders the roster from the in-process snapshot, never a sync read.
 *
 * Each check is a killer in K (it throws when the code misbehaves); the tests run them on the real
 * source and the census at the end runs them on mutated source (loadTs.fromText, nothing written to
 * disk). Killers that make temp dirs clean up themselves.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const HIVE = 'src/main/hive.ts';
const CAP = 'src/main/capacityPersistence.ts';
const AJ = 'src/main/atomicJson.ts';
const SW = 'src/main/stallWatch.ts';
const BS = 'src/main/boardStatus.ts';

const H = loadTs(HIVE);
const C = loadTs(CAP);
const A = loadTs(AJ);
const S = loadTs(SW);
const B = loadTs(BS);

const between = (src, from, to) => {
  const a = src.indexOf(from);
  assert.ok(a >= 0, `missing ${from}`);
  const b = src.indexOf(to, a + from.length);
  assert.ok(b > a, `missing ${to} after ${from}`);
  return src.slice(a, b);
};

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `uic-${tag}-`));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });

// --- hive rig ---------------------------------------------------------------------------------------
async function floor(mod = H) {
  const home = tmp('fleet');
  const hive = new mod.HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home });
  const fleetPath = path.join(home, 'hive', 'fleet.json');
  const publish = () => hive.writeFleetSnapshot({
    ts: Date.now() - 4000,
    agents: [
      { id: 'god-1', name: 'Michael', role: 'orchestrator', isGod: true, breaker: 'ok', tokens: 1, usd: 0, lastActiveSecAgo: 6, inboxBacklog: 0 },
      { id: 'jim-1', name: 'Jim', role: 'agent', breaker: 'ok', tokens: 1, usd: 0, lastActiveSecAgo: 6, inboxBacklog: 0 }
    ]
  });
  const row = () => JSON.parse(fs.readFileSync(fleetPath, 'utf8')).agents.find((a) => a.id === 'jim-1');
  const done = () => { try { hive.dispose(); } catch { /* best effort */ } rm(home); };
  return { home, hive, fleetPath, publish, row, done };
}

// --- stall-watch rig (as stall-watch-198) ----------------------------------------------------------
const ORIGIN = 1_700_000_000_000;
function rig(mod = S) {
  let now = 1000;
  const rows = [];
  const w = new mod.StallWatch({ now: () => now, origin: ORIGIN, log: (r) => rows.push(r), setInterval: () => 'I1', clearInterval: () => {} });
  return { w, rows, advance: (ms) => { now += ms; }, stalls: () => rows.filter((r) => r.kind === 'main-stall') };
}
function slowObj(r, names, ms) {
  const o = {};
  for (const n of names) o[n] = function (...args) { r.advance(ms); return { self: this, args }; };
  return o;
}

// --- capacity rig ---------------------------------------------------------------------------------
/** serializeCapacityStore needs only persistable(); the text carries savedAt, which tells writes apart. */
const tracker = { persistable: () => [] };
const savedAt = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).savedAt;
const temps = (file) => fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith(`${path.basename(file)}.tmp`));
async function withWarn(fn) {
  const warns = [];
  const real = console.warn;
  console.warn = (...a) => { warns.push(a.map(String).join(' ')); };
  try { await fn(); } finally { console.warn = real; }
  return warns;
}

const K = {
  /** M1: a hold patches the in-memory snapshot in the same turn and is published by the async writer. */
  async holdPatch(mod = H) {
    const f = await floor(mod);
    try {
      f.publish();
      await f.hive.fleetFlushed();
      assert.equal(f.row().onHold, undefined);
      assert.deepEqual(f.hive.setAgentHold('jim-1', true), { ok: true, onHold: true });
      assert.match(f.hive.rosterContext(), /jim-1 "Jim" \([^)]*ON HOLD/, 'A HOLD PATCHES THE IN-MEMORY SNAPSHOT AT ONCE');
      assert.equal(f.row().onHold, undefined, 'NO SYNC WRITE OF fleet.json IN THE HOLD TURN');
      await f.hive.fleetFlushed();
      assert.equal(f.row().onHold, true, 'A HOLD IS PUBLISHED THROUGH THE ASYNC WRITER');
      f.hive.setAgentHold('jim-1', false);
      assert.doesNotMatch(f.hive.rosterContext(), /ON HOLD/);
      await f.hive.fleetFlushed();
      assert.equal(f.row().onHold, false, 'AND SO IS THE RELEASE');
    } finally { f.done(); }
  },

  /** M1: a rename, the same way. */
  async renamePatch(mod = H) {
    const f = await floor(mod);
    try {
      f.publish();
      await f.hive.fleetFlushed();
      assert.deepEqual(f.hive.renameAgent('jim-1', 'Kevin'), { ok: true, name: 'Kevin' });
      assert.match(f.hive.rosterContext(), /jim-1 "Kevin"/, 'A RENAME PATCHES THE IN-MEMORY SNAPSHOT AT ONCE');
      assert.equal(f.row().name, 'Jim', 'NO SYNC WRITE OF fleet.json IN THE RENAME TURN');
      await f.hive.fleetFlushed();
      assert.equal(f.row().name, 'Kevin', 'A RENAME IS PUBLISHED THROUGH THE ASYNC WRITER');
    } finally { f.done(); }
  },

  /** M1: before anything is published there is nothing to patch: no file appears, nothing throws. */
  async noSnapshot(mod = H) {
    const f = await floor(mod);
    try {
      assert.deepEqual(f.hive.setAgentHold('jim-1', true), { ok: true, onHold: true });
      assert.deepEqual(f.hive.renameAgent('jim-1', 'Kevin'), { ok: true, name: 'Kevin' });
      await f.hive.fleetFlushed();
      assert.equal(f.hive.rosterContext(), null, 'NO ROSTER BEFORE THE FIRST PUBLISH');
      assert.equal(fs.existsSync(f.fleetPath), false, 'NO fleet.json IS CONJURED BY A HOLD');
      assert.equal(f.hive.registry().agents['jim-1'].onHold, true, 'the registry is the record');
    } finally { f.done(); }
  },

  /** M1: the hold and rename paths hold no read-modify-write of fleet.json (source pin). */
  noRmw() {
    const src = codeOnly(readSource(HIVE));
    const hold = between(src, 'setAgentHold(id: string, hold: boolean)', "this.appendLog({ kind: 'agent-hold'");
    const rename = between(src, 'renameAgent(id: string, name: string)', "this.appendLog({ kind: 'rename'");
    for (const [name, body] of [['setAgentHold', hold], ['renameAgent', rename]]) {
      assert.doesNotMatch(body, /fleet\.json|readJson|readFileSync|existsSync|writeJson\(fleetPath/, `NO SYNC READ-MODIFY-WRITE OF fleet.json IN ${name}`);
      assert.match(body, /this\.patchFleetAgent\(id,/, `${name} patches the snapshot`);
    }
  },

  /** M1/M16: fleetFlushed settles only once the latest publish is on disk (two quick publishes collapse). */
  async flushWaits(mod = H) {
    const f = await floor(mod);
    try {
      f.hive.writeFleetSnapshot({ ts: 1, agents: [] });
      f.hive.writeFleetSnapshot({ ts: 2, agents: [] });
      assert.equal(fs.existsSync(f.fleetPath), false, 'deferred off the caller\'s turn');
      await f.hive.fleetFlushed();
      assert.equal(JSON.parse(fs.readFileSync(f.fleetPath, 'utf8')).ts, 2, 'fleetFlushed WAITS FOR THE PUBLISH');
      f.hive.writeFleetSnapshot({ ts: 3, agents: [] });
      await f.hive.fleetFlushed();
      assert.equal(JSON.parse(fs.readFileSync(f.fleetPath, 'utf8')).ts, 3, 'AND FOR THE NEXT ONE');
    } finally { f.done(); }
  },

  /** M2: a failed async write is logged, like the sync one; the counts still come back. */
  async warnOnFail(mod = C) {
    const d = tmp('cap');
    try {
      const file = path.join(d, 'missing-dir', 'capacity.json');
      const store = new mod.CapacityStore(file, tracker, 5_000, () => 7);
      let out;
      const warns = await withWarn(async () => { out = await store.saveAsync(); });
      assert.deepEqual(out, { written: 0, omitted: 0 }, 'the counts come back');
      assert.equal(warns.filter((w) => w.includes('[capacity] could not write the durable store')).length, 1, 'A FAILED ASYNC CAPACITY WRITE IS LOGGED');
      const sync = await withWarn(() => { store.saveNow(); });
      assert.equal(sync.filter((w) => w.includes('could not write the durable store')).length, 1, 'the sync path still logs');
      // and a write that succeeds says nothing
      const ok = await withWarn(() => new mod.CapacityStore(path.join(d, 'capacity.json'), tracker, 5_000, () => 8).saveAsync());
      assert.deepEqual(ok, []);
    } finally { rm(d); }
  },

  /** q: an async write still ahead of its writeFile when will-quit's saveNow runs (its temp file is not
   *  on disk yet, so the sweep cannot catch it) must withdraw at its rename; saveNow is the last word. */
  async quitRace(mod = C) {
    const d = tmp('quit');
    const real = fsp.writeFile;
    try {
      const file = path.join(d, 'capacity.json');
      let now = 1;
      const store = new mod.CapacityStore(file, tracker, 5_000, () => now);
      let release = null;
      const parked = new Promise((atWrite) => {
        fsp.writeFile = function (...args) {
          fsp.writeFile = real;
          return new Promise((res, rej) => { release = () => real.apply(this, args).then(res, rej); atWrite(); });
        };
      });
      const pending = store.saveAsync();   // parks before its temp file exists
      await parked;
      assert.deepEqual(temps(file), [], 'nothing of the async write is on disk yet');
      fs.writeFileSync(`${file}.tmp-deadbe`, '{}');   // a stray from a write the process ended under
      now = 2;
      store.saveNow();                                 // will-quit
      assert.equal(savedAt(file), 2);
      assert.equal(temps(file).filter((n) => n.endsWith('deadbe')).length, 0, 'NO STRAY TEMP FILE: the quit write sweeps them');
      release();
      await pending;
      assert.equal(savedAt(file), 2, 'A STALE ASYNC RENAME NEVER OVERWRITES THE QUIT WRITE');
      assert.deepEqual(temps(file), [], 'the withdrawn write removed its own temp file');
      // a newer async write after the quit write still publishes (the generation moved on)
      now = 3;
      await store.saveAsync();
      assert.equal(savedAt(file), 3);
    } finally { fsp.writeFile = real; rm(d); }
  },

  /** q (INT 1.1.99 fixup 4): a rename already past its commit check when will-quit's saveNow runs
   *  lands after it; settleQuit waits for it (bounded) and writes the quit snapshot again. */
  async quitJoin(mod = C) {
    const d = tmp('qjoin');
    const real = fsp.rename;
    let release = null;
    try {
      const file = path.join(d, 'capacity.json');
      let now = 1;
      const store = new mod.CapacityStore(file, tracker, 5_000, () => now);
      assert.equal(await store.settleQuit(1_000), false, 'NOTHING IN FLIGHT: NO REWRITE');
      assert.equal(fs.existsSync(file), false, 'and nothing is written');
      // The OS has taken the rename (the temp has left its `.tmp-*` name, so saveNow's sweep cannot
      // catch it) but it lands only on release: the window the commit check cannot close.
      const parked = new Promise((atRename) => {
        fsp.rename = function (from, to) {
          fsp.rename = real;
          const taken = `${to}.taken`;
          fs.renameSync(from, taken);
          return new Promise((res, rej) => { release = () => real(taken, to).then(res, rej); atRename(); });
        };
      });
      const pending = store.saveAsync();   // passes its commit check, then parks inside rename
      await parked;
      now = 2;
      store.saveNow();                     // will-quit
      assert.equal(savedAt(file), 2);
      const t1 = Date.now();
      const join = store.settleQuit(5_000);
      release();
      await pending;
      assert.equal(await join, true, 'AN IN-FLIGHT WRITE IS JOINED');
      assert.ok(Date.now() - t1 < 2_500, 'THE JOIN ENDS WHEN THE WRITE LANDS, not at its bound');
      assert.equal(savedAt(file), 2, 'THE QUIT SNAPSHOT IS WRITTEN AGAIN AFTER THE LATE RENAME');
      assert.deepEqual(temps(file), [], 'no temp file is left');
      // bounded: a rename that never lands does not hold the quit
      now = 3;
      const stuck = new Promise((atRename) => { fsp.rename = () => { atRename(); return new Promise(() => {}); }; });
      void store.saveAsync();
      await stuck;
      fsp.rename = real;
      now = 4;
      store.saveNow();
      const hung = await Promise.race([store.settleQuit(50), new Promise((r) => setTimeout(() => r('HUNG'), 1_500))]);
      assert.equal(hung, true, 'THE JOIN IS BOUNDED: a rename that never lands does not hold the quit');
      assert.equal(savedAt(file), 4);
    } finally { fsp.rename = real; rm(d); }
  },

  /** q (Jim's U2): a rename that fails EPERM and retries re-asks the commit check, so a saveNow that ran
   *  during the backoff wins over the retry. */
  async retryRecheck(mod = A) {
    const d = tmp('qretry');
    const real = fsp.rename;
    try {
      const file = path.join(d, 'capacity.json');
      let newest = true;
      fsp.rename = async () => {
        fsp.rename = real;
        fs.writeFileSync(file, 'quit');    // will-quit's saveNow lands between the attempts
        newest = false;
        const e = new Error('EPERM: operation not permitted, rename'); e.code = 'EPERM';
        throw e;
      };
      assert.equal(await mod.atomicWriteTextAsync(file, 'older', () => newest), false, 'A RETRY AFTER A NEWER WRITE WITHDRAWS');
      assert.equal(fs.readFileSync(file, 'utf8'), 'quit', 'THE RETRY RE-CHECKS THE COMMIT: the quit write stays the last word');
      assert.deepEqual(fs.readdirSync(d), ['capacity.json'], 'the withdrawn retry removed its temp file');
    } finally { fsp.rename = real; rm(d); }
  },

  /** U5: patchFleetAgent publishes a clone; a snapshot already handed out keeps its row as it was. */
  async cloneRow(mod = H) {
    const f = await floor(mod);
    try {
      f.publish();
      const before = f.hive.fleetSnapshotView();
      const jim = before.agents.find((a) => a.id === 'jim-1');
      f.hive.setAgentHold('jim-1', true);
      f.hive.renameAgent('jim-1', 'Kevin');
      assert.equal(jim.onHold, undefined, 'A HANDED-OUT SNAPSHOT ROW IS NOT MUTATED BY A HOLD');
      assert.equal(jim.name, 'Jim', 'NOR BY A RENAME');
      const after = f.hive.fleetSnapshotView().agents.find((a) => a.id === 'jim-1');
      assert.notEqual(after, jim);
      assert.deepEqual([after.onHold, after.name], [true, 'Kevin']);
      await f.hive.fleetFlushed();
    } finally { f.done(); }
  },

  /** q: atomicWriteTextAsync's commit check: false withdraws the write, true publishes it. */
  async commitGate(mod = A) {
    const d = tmp('aj');
    try {
      const file = path.join(d, 'x.json');
      assert.equal(await mod.atomicWriteTextAsync(file, '1', () => false), false, 'COMMIT FALSE REPORTS FALSE');
      assert.equal(fs.existsSync(file), false, 'COMMIT FALSE WITHDRAWS THE WRITE');
      assert.deepEqual(fs.readdirSync(d), [], 'and leaves no temp file');
      assert.equal(await mod.atomicWriteTextAsync(file, '2', () => true), true);
      assert.equal(fs.readFileSync(file, 'utf8'), '2');
      assert.equal(await mod.atomicWriteTextAsync(file, '3'), true, 'no commit = publish');
      assert.equal(fs.readFileSync(file, 'utf8'), '3');
    } finally { rm(d); }
  },

  /** s: the sync counter map is bounded, pruned by the minute, folded for temp names; a row carries 12. */
  syncBounded(mod = S) {
    const r = rig(mod);
    const fsT = slowObj(r, ['readFileSync', 'writeFileSync'], 1);
    r.w.start({ fs: fsT });
    for (let i = 0; i < 30; i++) fsT.readFileSync('C:\\x\\config.json');
    for (const hex of ['a1b2c3', 'd4e5f6', '0a0b0c']) fsT.writeFileSync(`C:\\x\\fleet.json.tmp-${hex}`, 'row');
    for (const id of ['2026-10-22T18-13-14-298Z-d68f57', '2026-10-22T19-34-33-467Z-222510']) fsT.readFileSync(`C:\\x\\inbox\\${id}.json`);
    assert.equal(r.w.sync.size, 3, 'THREE KEYS SO FAR: the temp names fold, the mail ids fold');
    for (let i = 0; i < 200; i++) fsT.readFileSync(`C:\\x\\agents\\a${i}.json`);
    assert.ok(r.w.sync.size <= mod.SYNC_TARGETS_MAX + 1, `THE SYNC COUNTER MAP IS BOUNDED (${r.w.sync.size} keys)`);
    assert.equal(r.w.sync.get('other')?.calls, 200 - (mod.SYNC_TARGETS_MAX - 3), 'ONCE THE CAP IS REACHED a new target counts under other');
    assert.deepEqual(r.w.sync.get('writeFileSync:fleet.json.tmp-*'), { calls: 3, bytes: 9 }, 'TEMP NAMES FOLD TO ONE KEY');
    assert.deepEqual(r.w.sync.get('readFileSync:<id>.json'), { calls: 2, bytes: 0 }, 'MAIL IDS FOLD TO ONE KEY');
    assert.equal([...r.w.sync.keys()].some((k) => /tmp-[0-9a-f]{6}|d68f57/.test(k)), false, 'no unique name is a key');
    r.w.beat();
    const row = r.stalls()[0];
    assert.ok(row, 'the slow calls made a stall row');
    assert.equal(row.sync.length, mod.STALL_ROW_SYNC, 'A ROW CARRIES THE BUSIEST 12');
    assert.equal(row.sync[0].target, 'other');
    assert.equal(row.sync[1].target, 'readFileSync:config.json');
    assert.equal(row.sync[1].callsPerMin, 30);
    for (let i = 1; i < row.sync.length; i++) assert.ok(row.sync[i - 1].callsPerMin >= row.sync[i].callsPerMin, 'most calls first');
    assert.ok(JSON.stringify(row).length < 2000, `a row stays small (${JSON.stringify(row).length} chars)`);
    // the minute turns: the old minute's keys are gone
    r.advance(60_000);
    fsT.readFileSync('C:\\x\\registry.json');
    assert.deepEqual([...r.w.sync.keys()], ['readFileSync:registry.json'], 'OLD MINUTES ARE PRUNED');
    assert.deepEqual(r.w.syncStats(), [{ target: 'readFileSync:registry.json', callsPerMin: 1, bytes: 0 }]);
    r.w.stop();
  },

  /** b: the board-status roster comes from the in-process snapshot; without one, the file (compat). */
  boardSnapshot(mod = B) {
    const root = tmp('board');
    try {
      fs.writeFileSync(path.join(root, 'fleet.json'), JSON.stringify({ agents: [{ id: 'zz-1', name: 'Zed' }] }));
      const host = { root: () => root, tasks: () => ({ tasks: [] }), taskMeta: () => ({}), flags: () => [] };
      const snap = { agents: [{ id: 'a1', name: 'Al', onHold: true, inboxBacklog: 2 }] };
      const md = new mod.BoardStatusWriter({ ...host, fleetSnapshot: () => snap }, () => 5_000).write();
      assert.match(md, /- Al \(a1\): on hold; 0 doing; 2 message\(s\) waiting/, 'THE BOARD STATUS ROSTER COMES FROM THE SNAPSHOT');
      assert.doesNotMatch(md, /Zed/, 'never the file when a snapshot is supplied');
      assert.match(new mod.BoardStatusWriter(host, () => 5_000).write(), /Zed \(zz-1\)/, 'no snapshot supplied (tests, CLIs): the file');
      assert.match(new mod.BoardStatusWriter({ ...host, fleetSnapshot: () => null }, () => 5_000).write(), /No agents\./, 'a null snapshot is an empty roster, not a throw');
    } finally { rm(root); }
  },

  /** b: index.ts supplies the snapshot to the board-status writer; will-quit still flushes capacity sync. */
  indexWiring(index = readSource('src/main/index.ts')) {
    const INDEX = codeOnly(index);
    const ctor = between(INDEX, 'const boardStatus = new BoardStatusWriter({', '});');
    assert.match(ctor, /fleetSnapshot: \(\) => hive\.fleetSnapshotView\(\),/, 'THE BOARD STATUS WRITER GETS THE SNAPSHOT');
    const quit = between(INDEX, "app.on('will-quit', () => {", '\n});');
    assert.match(quit, /capacityStore\.saveNow\(\);/, 'will-quit flushes the capacity store synchronously');
    const join = between(INDEX, 'let analyticsFlushed = false;', ']).then(finish, finish);');
    assert.match(join, /capacityStore\.settleQuit\(CAPACITY_QUIT_JOIN_MS\)\.catch\(\(\) => undefined\)/, 'WILL-QUIT JOINS AN IN-FLIGHT CAPACITY WRITE');
    assert.match(INDEX, /const CAPACITY_QUIT_JOIN_MS = 1_000;/);
    const timer = between(codeOnly(readSource(CAP)), 'scheduleSave(): void {', '\n  }');
    assert.match(timer, /void this\.saveAsync\(\)/, 'the timer path is the async writer');
  }
};

test('M1: a 1:1 hold patches the in-memory snapshot at once and is published by the async writer', () => K.holdPatch());
test('M1: a rename, the same way', () => K.renamePatch());
test('M1: before the first publish there is nothing to patch: no roster, no conjured file, nothing thrown', () => K.noSnapshot());
test('M1: no sync read-modify-write of fleet.json in the hold or rename path (source)', () => K.noRmw());
test('M1/M16: fleetFlushed settles once the latest publish is on disk', () => K.flushWaits());
test('M2: a failed async capacity write is logged like the sync one', () => K.warnOnFail());
test('quit race: saveNow is the last word over an in-flight async write, and sweeps stray temp files', () => K.quitRace());
test('quit race: atomicWriteTextAsync withdraws on commit false', () => K.commitGate());
test('quit race (fixup 4): settleQuit joins a rename that lands after saveNow and writes the quit snapshot again, bounded', () => K.quitJoin());
test('quit race (U2): an EPERM retry re-asks the commit check', () => K.retryRecheck());
test('U5: patchFleetAgent publishes a clone, never the live row', () => K.cloneRow());
test('STALL-WATCH: the sync counter map is bounded, pruned by the minute, folded; a row carries 12', () => K.syncBounded());
test('board-status: the roster comes from the in-process snapshot', () => K.boardSnapshot());
test('wiring: index.ts feeds the snapshot to the board-status writer; will-quit flushes capacity', () => K.indexWiring());

// --- mutant census ----------------------------------------------------------------------------------
const MUTANTS = [
  { name: 'M1 a hold does not patch the snapshot', file: HIVE, from: 'this.patchFleetAgent(id, (row) => { row.onHold = hold; });', to: '', k: K.holdPatch },
  { name: 'M1 a rename does not patch the snapshot', file: HIVE, from: 'this.patchFleetAgent(id, (row) => { row.name = nextName; });', to: '', k: K.renamePatch },
  { name: 'M1 patched in memory but never published', file: HIVE, from: 'if (hit) this.writeFleetSnapshot({ ...snap, agents });', to: 'if (hit) this.fleetSnapshot = { ...snap, agents };', k: K.holdPatch },
  { name: 'M1 the hold patches the wrong row', file: HIVE, from: "if (!row || typeof row !== 'object' || row.id !== id) return row;", to: "if (!row || typeof row !== 'object' || row.id === id) return row;", k: K.holdPatch },
  { name: 'M1 fleetFlushed settles before the publish', file: HIVE, from: 'fleetFlushed(): Promise<void> { return this.fleetSettled; }', to: 'fleetFlushed(): Promise<void> { return Promise.resolve(); }', k: K.flushWaits },
  { name: 'M2 the failed async write is silent', file: CAP, from: "console.warn('[capacity] could not write the durable store:', e);\n  }\n  return { written, omitted };", to: '}\n  return { written, omitted };', k: K.warnOnFail },
  { name: 'q the async write ignores the generation', file: CAP, from: '() => mine === this.seq)', to: '() => true)', k: K.quitRace },
  { name: 'q saveNow does not move the generation', file: CAP, from: '    this.seq++;\n    const out = saveCapacityStore(', to: '    const out = saveCapacityStore(', k: K.quitRace },
  { name: 'q saveNow leaves stray temp files', file: CAP, from: '    removeCapacityTemps(this.file);\n', to: '', k: K.quitRace },
  { name: 'q4 settleQuit never rewrites', file: CAP, from: '    clearTimeout(timer);\n    this.saveNow();\n', to: '    clearTimeout(timer);\n', k: K.quitJoin },
  { name: 'q4 settleQuit does not wait for the write', file: CAP, from: '      this.writing.catch(() => undefined),\n', to: '', k: K.quitJoin },
  { name: 'q4 in-flight writes are not counted', file: CAP, from: '    this.inFlight++;\n', to: '', k: K.quitJoin },
  { name: 'q4 the join is unbounded', file: CAP, from: 'timer = setTimeout(resolve, capMs);', to: 'timer = setTimeout(() => undefined, capMs);', k: K.quitJoin },
  { name: 'q4 will-quit does not join', file: 'src/main/index.ts', from: '    capacityStore.settleQuit(CAPACITY_QUIT_JOIN_MS).catch(() => undefined)\n', to: '', k: K.indexWiring, text: true },
  { name: 'U2 the commit is checked on the first attempt only', file: AJ, from: 'if (commit && !commit()) { await rm(tmp, { force: true }); return false; }', to: 'if (attempt === 0 && commit && !commit()) { await rm(tmp, { force: true }); return false; }', k: K.retryRecheck },
  { name: 'U5 patchFleetAgent mutates the live row', file: HIVE, from: '      const next = { ...row };\n', to: '      const next = row;\n', k: K.cloneRow },
  { name: 'q the commit check is skipped', file: AJ, from: 'if (commit && !commit()) { await rm(tmp, { force: true }); return false; }', to: '', k: K.commitGate },
  { name: 's the map is not capped', file: SW, from: 'this.sync.size < SYNC_TARGETS_MAX ? key', to: 'true ? key', k: K.syncBounded },
  { name: 's old minutes are kept', file: SW, from: 'if (minute !== this.syncMinute) { this.sync.clear(); this.syncMinute = minute; }', to: 'this.syncMinute = minute;', k: K.syncBounded },
  { name: 's a row carries every target', file: SW, from: '.slice(0, STALL_ROW_SYNC);', to: ';', k: K.syncBounded },
  { name: 's temp names are not folded', file: SW, from: ".replace(/\\.tmp-[0-9a-f]+$/i, '.tmp-*')", to: '', k: K.syncBounded },
  { name: 'b the board status reads the file anyway', file: BS, from: 'this.host.fleetSnapshot ? fleetAgentsFromSnapshot(this.host.fleetSnapshot()) : readFleetAgents(root)', to: 'readFleetAgents(root)', k: K.boardSnapshot }
];

test('mutant census: every mutant is applied once and dies by its killer', async () => {
  for (const m of MUTANTS) {
    const src = readSource(m.file);
    assert.equal(src.split(m.from).length - 1, 1, `${m.name}: the mutation site must match exactly once`);
    const mod = m.text ? src.replace(m.from, m.to) : loadTs.fromText(m.file, src.replace(m.from, m.to));
    let died = null;
    try { await m.k(mod); } catch (e) { died = e; }
    assert.ok(died, `${m.name}: the mutant SURVIVED`);
    assert.match(String(died.message), /[A-Z]{3,}/, `${m.name}: died, but not by a named check: ${died.message}`);
  }
});
