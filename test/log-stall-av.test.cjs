'use strict';
require('./tools/own-job.cjs');

/**
 * LOG-STALL-AV (Jim, MAIL-AV-152; 1.1.53). The mail/Write/Read antivirus pain was synchronous
 * appendFileSync on Electron main into a 74 MB log.jsonl and a 21 MB cost-ledger.jsonl, never
 * rotated, rescanned on every open/close (~390-460 ms and ~0.9 scanner CPU-s per row, ~30 rows
 * per message).
 *  F1  the app keeps both files OPEN (one open, then writeSync per row: 0.01-0.06 ms).
 *  F2  both rotate at 8 MB; log keeps 8 rotated, the ledger keeps all; a pre-existing oversize
 *      file becomes a never-deleted legacy file; logTail and the lifetime-cost fold read across.
 *  F3  event-path wake rows are logged on edges only (< 5 per message), the rest counted.
 * Jim's audit (LOG-STALL-AUDIT-153), god's root fix: keep-open is the DEFAULT; HiveManager.dispose()
 * releases the descriptors and runs before reset's rm, change-home's copy, and quit (B1/B3);
 * provider-status also logs when it changes (B2); the rotated fd closes asynchronously (N2); the
 * live file is recreated inside the rotation (N3); legacy only before any rotation (N5).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'logstall-'));
const realEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
test.after(() => { for (const [k, v] of Object.entries(realEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } fs.rmSync(JAIL, { recursive: true, force: true }); });

const { AppendFile, rotatedFiles, filesInOrder, APPEND_ROTATE_BYTES, LOG_KEEP_ROTATED } = loadTs('src/main/appendLog.ts');

/** FLAKY-TIMING: wait until `cond()` holds (asynchronous closes landing), polling, up to `maxMs`.
 *  A fixed sleep failed under load; a condition that never holds still fails, at the deadline. */
async function until(cond, maxMs = 5000) {
  const end = Date.now() + maxMs;
  while (!cond()) { if (Date.now() > end) return false; await new Promise((r) => setTimeout(r, 20)); }
  return true;
}
const { CostLedgerTotals } = loadTs('src/main/costLifetime.ts');
const { planWakeRow, newWakeRowState, takeFolded, forgetWakeRows } = loadTs('src/main/wakeRowPolicy.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const dir = () => fs.mkdtempSync(path.join(JAIL, 'd-'));
/** Does this runtime refuse to delete a folder holding a kept-open 'a' descriptor (Node 20 / the app)? */
function openFileBlocksDelete() {
  const d = dir(); fs.mkdirSync(path.join(d, 'h'));
  const fd = fs.openSync(path.join(d, 'h', 'x.jsonl'), 'a');
  let blocked = false;
  try { fs.rmSync(path.join(d, 'h'), { recursive: true, force: true }); } catch { blocked = true; }
  fs.closeSync(fd);
  fs.rmSync(d, { recursive: true, force: true });
  return blocked;
}
const rows = (p) => fs.readFileSync(p, 'utf8').split('\n').filter(Boolean);

// ── F1 ────────────────────────────────────────────────────────────────────

test('F1: keepOpen = ONE open for many rows; every row is on disk the moment append returns, in order', () => {
  const p = path.join(dir(), 'log.jsonl');
  let opens = 0;
  const f = new AppendFile(p, { keepOpen: true, onOpen: () => { opens += 1; } });
  for (let i = 0; i < 50; i++) {
    f.append(JSON.stringify({ i }) + '\n');
    assert.equal(rows(p).length, i + 1, 'visible immediately (no buffer to flush)');
  }
  assert.equal(opens, 1, 'one open for 50 rows (each open is an antivirus rescan)');
  assert.equal(f.isOpen, true);
  assert.deepEqual(rows(p).map((l) => JSON.parse(l).i), [...Array(50).keys()]);
  f.close();
  assert.equal(f.isOpen, false);
  f.append('{"after":1}\n');
  assert.equal(opens, 2, 'reopens after a close');
  f.close();
});

test('F1 (B3): keep-open is the DEFAULT; keepOpen:false holds no descriptor between rows', () => {
  const d = dir(); const p = path.join(d, 'log.jsonl');
  const def = new AppendFile(p);
  def.append('{}\n');
  assert.equal(def.isOpen, true, 'the default is the production path');
  def.close();
  let opens = 0;
  const f = new AppendFile(p, { keepOpen: false, onOpen: () => { opens += 1; } });
  for (let i = 0; i < 3; i++) f.append('{}\n');
  assert.equal(opens, 3); assert.equal(f.isOpen, false);
  fs.rmSync(d, { recursive: true, force: true });   // deletable: nothing held
});

test('F1 (B1/B3): a HiveManager holds its log open by default; dispose() releases it so the hive folder can be deleted (reset) or copied', { skip: process.platform !== 'win32' }, async () => {
  const home = dir();
  // The host-independent check (Jim M2 on GUPPY-NODE-LTS): every 'a' descriptor the manager opens
  // under its home is seen open before dispose() and closed by it. appendLog.ts calls openSync and
  // closeSync through the node:fs module object, so this spy sees them. The rm below only bites
  // where an open file blocks a delete (Node 20, the app's Electron); on Node 24 this is the check.
  const held = new Map();   // fd -> path, for append opens under home not yet closed
  const { openSync, closeSync } = fs;
  fs.openSync = function (p, flags, ...rest) {
    const fd = openSync.call(this, p, flags, ...rest);
    if (flags === 'a' && path.resolve(String(p)).startsWith(path.resolve(home) + path.sep)) held.set(fd, String(p));
    return fd;
  };
  fs.closeSync = function (fd) { held.delete(fd); return closeSync.call(this, fd); };
  let hive;
  try {
    hive = new HiveManager(() => home);
    await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: home });
    hive.appendLog({ kind: 'x' });
    assert.ok([...held.values()].some((p) => path.basename(p) === 'log.jsonl'), 'the manager holds log.jsonl open (keepOpen is the default)');
    hive.dispose();
    assert.deepEqual([...held.values()], [], 'MUTANT: dispose() left append descriptors open (closeAppendFiles skipped)');
  } finally {
    fs.openSync = openSync; fs.closeSync = closeSync;
  }
  await hive?.drainReads();   // the replaced manager's reads end before its folder is removed below
  // A fresh manager for the delete check, which the spy has already proven releases on dispose.
  hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: home });
  hive.appendLog({ kind: 'x' });
  // Without dispose, Windows leaves the open file delete-pending and the rm fails: the reset bug.
  // GUPPY-NODE-LTS: that holds on the app's runtime (Electron 32, Node 20). A newer host Node
  // (24's libuv) opens files with FILE_SHARE_DELETE, so the same rm succeeds there; the host is
  // calibrated on a plain kept-open 'a' descriptor (appendLog's open) rather than by version.
  if (openFileBlocksDelete()) {
    assert.throws(() => fs.rmSync(path.join(home, 'hive'), { recursive: true, force: true }), /ENOTEMPTY|EBUSY|EPERM/);
  } else {
    assert.ok(fs.existsSync(path.join(home, 'hive', 'log.jsonl')), 'the manager wrote its log before the check');
  }
  hive.dispose();
  hive.dispose();   // idempotent
  await hive.drainReads();
  fs.rmSync(path.join(home, 'hive'), { recursive: true, force: true });
  assert.equal(fs.existsSync(path.join(home, 'hive')), false, 'after dispose the whole hive folder goes');
});

test('F1 wiring (B1/B3): no opt-in call; dispose() runs before reset\'s rm, before change-home\'s copy, and at quit', () => {
  const idx = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8').replace(/\r\n/g, '\n');
  assert.doesNotMatch(idx, /keepAppendFilesOpen\(/, 'the default is the app\'s path: nothing to turn on');
  // QUIT-HANG reshaped finish (quit-done row first); what matters: dispose, then app.exit.
  // STARTUP-FREEZE-104 A9 adds the key-registry flush before dispose (+ about 220 characters).
  assert.match(idx, /const finish = \(\): void => \{[\s\S]{0,520}?try \{ hive\.dispose\(\); \}[\s\S]{0,120}?app\.exit\(0\);/);
  const reset = idx.slice(idx.indexOf("ipcMain.handle('app:resetAll'"));
  const disposeAt = reset.indexOf('hive.dispose();'), rmAt = reset.indexOf('await removePathLinkSafe(hiveDir)');
  assert.ok(disposeAt > 0 && rmAt > disposeAt, 'reset: dispose, then rm');
  const change = idx.slice(idx.indexOf("ipcMain.handle('config:changeHome'"));
  const dAt = change.indexOf('hive.dispose();'), cpAt = change.indexOf('cpSync(src,');
  assert.ok(dAt > 0 && cpAt > dAt, 'change home: dispose, then copy');
});

test('F1 GATE (Jim\'s probe): with a large pre-existing log, an app append never reads or copies the log (the read cost ~390-460 ms)', async () => {
  const home = dir();
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: home });
  const log = path.join(home, 'hive', 'log.jsonl');
  const big = Buffer.alloc(20 * 1024 * 1024, 0x20); big[big.length - 1] = 0x0a;
  hive.dispose();   // the file is replaced under the manager: a fresh open, as in a new process
  fs.writeFileSync(log, big);
  // FLAKY-TIMING: the defect was a synchronous read of the whole log on the append path (~390-460
  // ms at 20 MB). It is checked by what the appends DO, not by how long a busy machine takes:
  // no byte of the log is read or copied while appending (the 20 MB file is renamed, never read).
  let readBytes = 0; let copies = 0;
  const real = { readFileSync: fs.readFileSync, readSync: fs.readSync, copyFileSync: fs.copyFileSync, createReadStream: fs.createReadStream };
  fs.readFileSync = function (...a) { const r = real.readFileSync.apply(this, a); readBytes += typeof r === 'string' ? Buffer.byteLength(r) : r.length; return r; };
  fs.readSync = function (...a) { const n = real.readSync.apply(this, a); readBytes += n; return n; };
  fs.copyFileSync = function (...a) { copies += 1; return real.copyFileSync.apply(this, a); };
  fs.createReadStream = function (...a) { copies += 1; return real.createReadStream.apply(this, a); };
  try {
    for (let i = 0; i < 40; i++) hive.appendLog({ kind: 'probe', i });
  } finally { Object.assign(fs, real); }
  hive.dispose();
  await hive.drainReads();
  assert.ok(readBytes < 64 * 1024, `the append path read ${readBytes} bytes (a whole-log read is ${big.length})`);
  assert.equal(copies, 0, 'nothing copied or streamed on the append path');
  const legacy = rotatedFiles(log).filter((r) => r.legacy);
  assert.equal(legacy.length, 1, 'the 20 MB file went to a legacy file');
  assert.equal(fs.statSync(legacy[0].path).size, big.length, 'every byte of it kept');
});

// ── F2 ────────────────────────────────────────────────────────────────────

test('F2: rotation at the cap; the live file stays under it; rotated names sort in write order; log retention keeps N; legacy is never pruned', async () => {
  const d = dir(); const p = path.join(d, 'log.jsonl');
  fs.writeFileSync(p, 'L'.repeat(2000) + '\n');   // pre-existing, over the test cap
  let t = 1000;
  const f = new AppendFile(p, { capBytes: 1000, keep: 3, keepOpen: true, now: () => ++t });
  for (let i = 0; i < 120; i++) f.append(JSON.stringify({ i, pad: 'x'.repeat(40) }) + '\n');
  f.close();
  // N2 closes a rotated file asynchronously, and on Windows a pruned file stays listed until
  // its handle closes. Here rotations come every few rows in ONE tick, so wait for the closes to
  // land (FLAKY-TIMING: a fixed 100 ms failed under load; a wrong retention still fails at the deadline).
  await until(() => rotatedFiles(p).filter((r) => !r.legacy).length === 3);
  const rot = rotatedFiles(p);
  assert.equal(rot.filter((r) => r.legacy).length, 1, 'the legacy file is kept');
  assert.equal(fs.readFileSync(rot.find((r) => r.legacy).path, 'utf8'), 'L'.repeat(2000) + '\n', 'byte-identical');
  assert.equal(rot.filter((r) => !r.legacy).length, 3, 'retention: 3 rotated');
  assert.ok(fs.statSync(p).size < 1000);
  for (const r of rot) assert.match(path.basename(r.path), /^log\.(legacy-)?\d+\.jsonl$/);
  const order = filesInOrder(p);
  assert.equal(order.at(-1), p, 'the live file is last');
  const seq = order.filter((x) => !/legacy/.test(x)).flatMap(rows).map((l) => JSON.parse(l).i);
  for (let k = 1; k < seq.length; k++) assert.equal(seq[k], seq[k - 1] + 1, 'contiguous, in order, no row lost or duplicated in what is kept');
  assert.equal(seq.at(-1), 119);
});

test('F2 (N3): the live file exists again the instant a rotation returns, with keepOpen on or off', () => {
  for (const keepOpen of [true, false]) {
    const d = dir(); const p = path.join(d, 'log.jsonl');
    let t = 0;
    const f = new AppendFile(p, { capBytes: 200, keepOpen, now: () => ++t });
    let rotations = 0;
    for (let i = 0; i < 40; i++) {
      const before = rotatedFiles(p).length;
      f.append(JSON.stringify({ i, pad: 'x'.repeat(30) }) + '\n');
      if (rotatedFiles(p).length > before) { rotations += 1; assert.ok(fs.existsSync(p), `recreated inside the rotation (keepOpen ${keepOpen})`); assert.equal(fs.statSync(p).size, 0); }
    }
    f.close();
    assert.ok(rotations >= 3);
  }
});

test('F2 (N2): the rotated file\'s descriptor is closed ASYNCHRONOUSLY (its antivirus scan off main); rows stay complete', async () => {
  const d = dir(); const p = path.join(d, 'log.jsonl');
  const realClose = fs.close, realCloseSync = fs.closeSync;
  let asyncCloses = 0, syncCloses = 0;
  fs.close = (fd, cb) => { asyncCloses += 1; return realClose(fd, cb); };
  fs.closeSync = (fd) => { syncCloses += 1; return realCloseSync(fd); };
  let t = 0;
  try {
    const f = new AppendFile(p, { capBytes: 300, keep: Infinity, now: () => ++t });
    for (let i = 0; i < 30; i++) f.append(JSON.stringify({ i, pad: 'y'.repeat(30) }) + '\n');
    const rotations = rotatedFiles(p).length;
    assert.ok(rotations >= 3);
    assert.equal(asyncCloses, rotations, 'one async close per rotation');
    assert.equal(syncCloses, 0, 'no synchronous close on the append path');
    f.close();
  } finally { fs.close = realClose; fs.closeSync = realCloseSync; }
  // Wait for the asynchronous closes to land (FLAKY-TIMING: was a fixed 50 ms).
  const read = () => { try { return filesInOrder(p).flatMap(rows).map((l) => JSON.parse(l).i); } catch { return null; } };
  await until(() => { const a = read(); return !!a && a.length === 30; });
  const all = read();
  assert.deepEqual(all, [...Array(30).keys()]);
});

test('F2 (N5): an oversize live file AFTER rotation has begun (its rename was busy) rotates normally and is pruned; only a pre-rotation file is legacy', () => {
  const d = dir(); const p = path.join(d, 'log.jsonl');
  fs.writeFileSync(path.join(d, 'log.1000.jsonl'), '{"old":1}\n');
  fs.writeFileSync(p, 'B'.repeat(2000) + '\n');   // over the cap, but rotation already ran here
  let t = 5000;
  const f = new AppendFile(p, { capBytes: 1000, keep: 1, now: () => ++t });
  f.append('{"x":1}\n');
  f.close();
  const rot = rotatedFiles(p);
  assert.equal(rot.filter((r) => r.legacy).length, 0, 'not legacy');
  assert.equal(rot.length, 1, 'retention applied to it');
  assert.equal(rows(p).length, 1, 'the row landed in the fresh live file');
});

test('F2: the cost ledger keeps EVERY rotated file (Infinity)', () => {
  const d = dir(); const p = path.join(d, 'cost-ledger.jsonl');
  let t = 0;
  const f = new AppendFile(p, { capBytes: 300, keep: Infinity, keepOpen: true, now: () => ++t });
  for (let i = 0; i < 100; i++) f.append(JSON.stringify({ agent_id: 'a', session_id: 's', usd: i }) + '\n');
  f.close();
  const all = filesInOrder(p).filter((x) => fs.existsSync(x)).flatMap(rows).map((l) => JSON.parse(l).usd);
  assert.deepEqual(all, [...Array(100).keys()], 'nothing pruned');
});

test('F2: logTail across rotation returns exactly the naive tail of the concatenated log', async () => {
  const home = dir();
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: home });
  const live = path.join(home, 'hive', 'log.jsonl');
  // Two rotated files + the live one, as the app writes them.
  fs.writeFileSync(path.join(home, 'hive', 'log.1000.jsonl'), [1, 2, 3].map((i) => JSON.stringify({ i })).join('\n') + '\n');
  fs.writeFileSync(path.join(home, 'hive', 'log.2000.jsonl'), [4, 5].map((i) => JSON.stringify({ i })).join('\n') + '\n');
  fs.writeFileSync(live, [6, 7].map((i) => JSON.stringify({ i })).join('\n') + '\n');
  assert.deepEqual(hive.logTail(4).map((r) => r.i), [4, 5, 6, 7]);
  assert.deepEqual(hive.logTail(100).map((r) => r.i), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(hive.logTail(2).map((r) => r.i), [6, 7]);
  hive.dispose();
  await hive.drainReads();
});

test('F2: the lifetime cost folded across rotations, INCLUDING a rotation mid-fold, equals the fold of one file', async () => {
  const d = dir(); const p = path.join(d, 'cost-ledger.jsonl');
  // A realistic stream: cumulative per-session samples with a restart (the counter drops).
  const stream = [];
  for (let i = 1; i <= 60; i++) stream.push({ agent_id: 'a', session_id: 's1', usd: i * 0.1 });
  for (let i = 1; i <= 30; i++) stream.push({ agent_id: 'a', session_id: 's1', usd: i * 0.05 });   // reset
  for (let i = 1; i <= 40; i++) stream.push({ agent_id: 'b', session_id: 's2', usd: i * 0.2 });
  const one = path.join(d, 'one.jsonl');
  fs.writeFileSync(one, stream.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const ref = new CostLedgerTotals(); await ref.refreshFully(one);

  let t = 0;
  const f = new AppendFile(p, { capBytes: 700, keep: Infinity, keepOpen: true, now: () => ++t });
  const got = new CostLedgerTotals();
  for (let i = 0; i < stream.length; i++) {
    f.append(JSON.stringify(stream[i]) + '\n');
    if (i % 17 === 0) await got.refresh(p);   // fold while it grows and rotates
  }
  f.close();
  await got.refreshFully(p);
  assert.ok(rotatedFiles(p).length >= 5, 'it really rotated');
  assert.equal(got.ready, true);
  assert.ok(Math.abs(got.floorTotal() - ref.floorTotal()) < 1e-9, `${got.floorTotal()} vs ${ref.floorTotal()}`);
  assert.ok(Math.abs(got.usdFor('a') - ref.usdFor('a')) < 1e-9);
  assert.ok(Math.abs(got.usdFor('b') - ref.usdFor('b')) < 1e-9);
  // Incremental, not a re-read: every rotated file is remembered as done, and a refresh with
  // nothing new reads nothing (a re-read of the whole rotated ledger every beat would be the
  // very cost this change removes).
  assert.equal(got.doneIds.size, rotatedFiles(p).length, 'each rotated file folded once and remembered');
  const before = got.floorTotal();
  const realConsume = got.consume.bind(got); let consumed = 0;
  got.consume = (b) => { consumed += b.length; return realConsume(b); };
  await got.refresh(p); await got.refresh(p);
  assert.equal(consumed, 0, 'nothing re-read');
  assert.equal(got.floorTotal(), before);
});

// ── F3 ────────────────────────────────────────────────────────────────────

/** One delivered message as the live floor logs it (Jim's per-message mix, MAIL-AV-152). */
function messageSequence(agent) {
  const s = [];
  s.push(['delivery', { agentId: agent, messageId: 'm', fresh: true }]);
  s.push(['observer', { agentId: agent, messageId: 'm', bridge: true }]);
  s.push(['schedule', { agentId: agent, cause: 'delivery', took: 'armed' }]);
  for (let k = 0; k < 5; k++) {
    s.push(['enter', { agentId: agent, cause: 'hook', mode: 'event' }]);
    s.push(['facts', { agentId: agent, cause: 'hook', mode: 'event', idleMs: 10 * k, paused: false }]);
    s.push(['no-claim', { agentId: agent, cause: 'hook', mode: 'event', why: 'active', inboxIds: 1 }]);
    s.push(['schedule', { agentId: agent, cause: 'hook', took: 'coalesced' }]);
  }
  for (let k = 0; k < 8; k++) s.push(['hook', { agentId: agent, event: k % 2 ? 'PostToolUse' : 'PreToolUse', edge: null }]);
  s.push(['hook', { agentId: agent, event: 'Stop', edge: 'idle' }]);
  s.push(['enter', { agentId: agent, cause: 'hook', mode: 'event' }]);
  s.push(['facts', { agentId: agent, cause: 'hook', mode: 'event', idleMs: 0 }]);
  s.push(['claim', { agentId: agent, cause: 'hook', mode: 'event', ids: 1, requestId: 'r' }]);
  s.push(['submit', { agentId: agent, cause: 'hook', mode: 'event', requestId: 'r' }]);
  s.push(['settle', { agentId: agent, cause: 'hook', mode: 'event', outcome: 'COMMITTED', requestId: 'r' }]);
  return s;
}

test('F3 GATE: one delivered message logs < 5 rows in all (the hive message row + 3 wake rows; it was ~30), and every folded row is counted', () => {
  const st = newWakeRowState();
  const seq = messageSequence('a1');
  const logged = seq.map(([stage, f]) => [stage, planWakeRow(st, stage, f)]).filter(([, r]) => r);
  assert.ok(seq.length >= 28, `the input is the ~30-row mix (${seq.length})`);
  assert.ok(1 + logged.length < 5, `message + ${logged.length} wake rows: ${logged.map(([s]) => s).join(',')}`);
  assert.deepEqual(logged.map(([s]) => s), ['no-claim', 'hook', 'settle']);
  const settle = logged[2][1];
  assert.deepEqual(settle.claim, { cause: 'hook', mode: 'event', ids: 1, requestId: 'r' }, 'the settle carries its claim');
  assert.equal(logged[0][1].why, 'active');
  assert.ok(logged[0][1].facts, 'the refusal carries its facts');
  const folded = takeFolded(st);
  const total = Object.values(folded).reduce((a, b) => a + b, 0);
  assert.equal(total + logged.length + 1, seq.length + 1, 'every row is either logged or counted');
  assert.equal(takeFolded(st), null, 'the summary clears');
});

test('F3: the edges that must survive: a lifecycle edge, a refusal whose REASON changes (with its facts), a claim, a settle, a missing bridge, a throw', () => {
  const st = newWakeRowState();
  assert.equal(planWakeRow(st, 'hook', { agentId: 'a', event: 'PreToolUse', edge: null }), null);
  assert.ok(planWakeRow(st, 'hook', { agentId: 'a', event: 'Stop', edge: 'idle' }));
  assert.ok(planWakeRow(st, 'provider-status', { agentId: 'a', status: 'idle', edge: true }));
  // B2: a non-edge reading logs when the status CHANGES (the AGY diagnosis needed the refused
  // idle ticks), identical repeats fold, agents are independent; a non-edge Stop logs too.
  assert.ok(planWakeRow(st, 'provider-status', { agentId: 'a', status: 'running', edge: false }), 'changed: logged');
  assert.equal(planWakeRow(st, 'provider-status', { agentId: 'a', status: 'running', edge: false }), null, 'same again: folded');
  assert.ok(planWakeRow(st, 'provider-status', { agentId: 'a', status: 'idle', edge: false }), 'a refused idle after running: logged');
  assert.equal(planWakeRow(st, 'provider-status', { agentId: 'a', status: 'idle', edge: false }), null);
  assert.ok(planWakeRow(st, 'provider-status', { agentId: 'z', status: 'idle', edge: false }), 'per agent');
  assert.ok(planWakeRow(st, 'hook', { agentId: 'a', event: 'Stop', edge: false }), 'a non-edge Stop logs');
  forgetWakeRows(st, 'a');
  assert.ok(planWakeRow(st, 'provider-status', { agentId: 'a', status: 'idle', edge: false }), 'forget clears the last status (N4)');
  planWakeRow(st, 'facts', { agentId: 'a', paused: true, idleMs: 5 });
  const r1 = planWakeRow(st, 'no-claim', { agentId: 'a', why: 'paused', inboxIds: 2 });
  assert.deepEqual(r1.facts, { paused: true, idleMs: 5 }, 'the refusal carries the state it was refused in');
  assert.equal(planWakeRow(st, 'no-claim', { agentId: 'a', why: 'paused', inboxIds: 3 }), null, 'the same reason again is folded');
  assert.ok(planWakeRow(st, 'no-claim', { agentId: 'a', why: 'active', inboxIds: 3 }), 'a new reason is an edge');
  assert.equal(planWakeRow(st, 'no-claim', { agentId: 'a', why: 'paused', inboxIds: 3 }), null, 'a FLAPPING reason already logged since the last claim is folded');
  assert.equal(planWakeRow(st, 'no-claim', { agentId: 'a', why: 'active', inboxIds: 3 }), null);
  assert.ok(planWakeRow(st, 'no-claim', { agentId: 'b', why: 'active', inboxIds: 1 }), 'agents are independent');
  assert.equal(planWakeRow(st, 'claim', { agentId: 'a', ids: 1 }), null, 'a claim rides on its outcome row');
  assert.ok(planWakeRow(st, 'no-claim', { agentId: 'a', why: 'active', inboxIds: 1 }), 'after a claim the same reason logs again');
  assert.deepEqual(planWakeRow(st, 'settle', { agentId: 'a', outcome: 'COMMITTED' }).claim, { ids: 1 });
  planWakeRow(st, 'claim', { agentId: 'a', ids: 2 });
  assert.deepEqual(planWakeRow(st, 'submit-threw', { agentId: 'a', error: 'x' }).claim, { ids: 2 }, 'a failed submit carries its claim too');
  assert.equal(planWakeRow(st, 'delivery', { agentId: 'a', messageId: 'm', fresh: true }), null, 'a fresh delivery is the message row');
  assert.ok(planWakeRow(st, 'delivery', { agentId: 'a', messageId: 'm', fresh: false }), 'a RE-delivery logs');
  assert.ok(planWakeRow(st, 'observer', { agentId: 'a', bridge: false }), 'a missing bridge is the case observer exists for');
  assert.ok(planWakeRow(st, 'beat', { live: 2, agents: 'a,b' }));
  assert.equal(planWakeRow(st, 'beat', { live: 2, agents: 'a,b' }), null, 'the same beat again is folded');
  assert.ok(planWakeRow(st, 'beat', { live: 3, agents: 'a,b,c' }), 'a changed beat logs');
  for (const s of ['throw', 'stall', 'codex-rollout', 'heartbeat', 'bridge-built']) {
    assert.ok(planWakeRow(st, s, { agentId: 'a' }), s);
  }
  assert.ok(planWakeRow(st, 'schedule', { agentId: '', took: 'no-agent-id' }), 'an anomaly logs');
});

test('F3 wiring: wakeDiag counts EVERY row in telemetry first, then the breadcrumb de-dup, then the edge policy; the folded counts are written once per minute; other log rows (app-start, palace-*, hook-transport) never pass through it', () => {
  const idx = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  const body = /function wakeDiag\([\s\S]*?\n\}/.exec(idx)[0];
  const order = ['wakeTelemetry.note(', 'shouldLogBreadcrumb(', 'takeFolded(', 'planWakeRow('].map((k) => body.indexOf(k));
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), `order ${order}`);
  assert.match(body, /hive\.appendLog\(\{ kind: 'wake-folded', minute: wakeFoldedMinute, counts \}\)/);
  assert.match(body, /if \(row\) hive\.appendLog\(\{ kind: 'wake', stage, \.\.\.row \}\)/);
  const stall = /diag: \(stage, fields\) => \{[\s\S]*?\n  \}/.exec(idx)[0];
  assert.match(stall, /wakeDiag\(stage, fields\);[\s\S]*noteWakeRefusal/, 'the stall watchdog still sees every refusal');
  assert.match(idx, /try \{ workerWake\.forget\(agentId, id\); \} catch \{[^}]*\}\s*try \{ forgetWakeRows\(wakeRows, agentId\); \}/, 'N4: an agent that leaves the floor is forgotten by the row policy too');
});

const { APPEND_LINK_CHECK_MS } = loadTs('src/main/appendLog.ts');
const seq = (p) => rows(p).map((l) => JSON.parse(l).a);
/** Count the fstat calls (both kinds) made while fn runs; `hold: true` keeps every asynchronous
 *  answer back until `release()` (a slow disk). */
function watchFstat({ hold = false } = {}) {
  const real = { fstat: fs.fstat, fstatSync: fs.fstatSync };
  const w = { sync: 0, asked: 0, answered: 0, held: [], release() { for (const go of w.held.splice(0)) go(); }, restore() { fs.fstat = real.fstat; fs.fstatSync = real.fstatSync; } };
  fs.fstatSync = (...a) => { w.sync += 1; return real.fstatSync(...a); };
  fs.fstat = (fd, cb) => {
    w.asked += 1;
    // The answer is taken now (while the descriptor is this file's) and handed over later.
    real.fstat(fd, (err, st) => { const go = () => { w.answered += 1; cb(err, st); }; if (hold) w.held.push(go); else go(); });
  };
  return w;
}

test('RESIDUAL (Jim PERF-153-FINAL): a live log DELETED under a kept-open file is noticed within a second and recreated; no rows go to the ghost after that', async () => {
  const d = dir(); const p = path.join(d, 'log.jsonl');
  let t = 1_000_000;
  const f = new AppendFile(p, { now: () => t });
  f.append('{"a":1}\n');
  fs.rmSync(p);                                   // someone deletes the live log
  t += APPEND_LINK_CHECK_MS;
  f.append('{"a":2}\n');
  f.append('{"a":3}\n');                          // written while the check is still being answered
  assert.ok(await until(() => fs.existsSync(p)), 'recreated by path');
  assert.deepEqual(seq(p), [2, 3], 'the row that started the check and the one after it are in the new file, in order');
  f.append('{"a":4}\n');
  assert.deepEqual(seq(p), [2, 3, 4], 'later rows follow, on disk the moment append returns');
  // Throttled: within the interval no fstat is made (and nothing is lost when nothing was deleted).
  const w = watchFstat();
  try { for (let i = 0; i < 20; i++) f.append('{"a":5}\n'); } finally { w.restore(); }
  assert.equal(w.sync + w.asked, 0, 'at most one check a second');
  f.close();
  assert.equal(rows(p).length, 23);
});

test('LAG-SYNC-FS-LOG-108: the once-a-second deleted-file check never calls fstatSync on the append path; a row written during a slow check lands once', async () => {
  const p = path.join(dir(), 'log.jsonl');
  let t = 1_000_000;
  const f = new AppendFile(p, { now: () => t });
  f.append('{"a":1}\n');                          // the open (its own fstat for the size) is behind us
  const w = watchFstat({ hold: true });
  try {
    for (let a = 2; a <= 7; a++) { t += APPEND_LINK_CHECK_MS; f.append(`{"a":${a}}\n`); }
    assert.equal(w.sync, 0, 'no synchronous fstat on the main thread');
    assert.equal(w.asked, 1, 'one check asked for, and no second one while it is unanswered');
    assert.deepEqual(seq(p), [1, 2, 3, 4, 5, 6, 7], 'every row is on disk the moment append returns');
    assert.ok(await until(() => w.held.length === 1), 'the slow answer is ready');
    w.release();
    assert.equal(w.answered, 1);
    assert.deepEqual(seq(p), [1, 2, 3, 4, 5, 6, 7], 'the file was not deleted: nothing is written twice');
    t += APPEND_LINK_CHECK_MS; f.append('{"a":8}\n');
    assert.equal(w.asked, 2, 'the next second checks again');
    assert.equal(w.sync, 0);
  } finally { w.release(); w.restore(); }
  f.close();
  assert.deepEqual(seq(p), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('LAG-SYNC-FS-LOG-108: the rows remembered during one check are bounded (a check that is never answered is taken on the spot)', () => {
  const { APPEND_LINK_HELD_MAX } = loadTs('src/main/appendLog.ts');
  const p = path.join(dir(), 'log.jsonl');
  let t = 1_000_000;
  const f = new AppendFile(p, { now: () => t });
  f.append('{"a":0}\n');
  t += APPEND_LINK_CHECK_MS;
  const w = watchFstat({ hold: true });
  try {
    for (let a = 1; a < APPEND_LINK_HELD_MAX; a++) f.append(`{"a":${a}}\n`);
    assert.equal(w.sync, 0);
    assert.equal(f.sinceCheck.length, APPEND_LINK_HELD_MAX - 1);
    f.append('{"a":-1}\n');
    assert.equal(w.sync, 1, 'answered on this thread once the bound is reached');
    assert.equal(f.sinceCheck, null);
  } finally { w.release(); w.restore(); }
  f.close();
  assert.equal(rows(p).length, APPEND_LINK_HELD_MAX + 1, 'every row once');
});

// Jim's NIT on 73bd9d3c (mutant settleNoGen): the bound settles a check on this thread and finds
// the file still there, so nothing closes the descriptor. The slow answer of THAT check arrives
// later, while a newer check is in flight. It must be dropped: taken as the newer check's answer
// it would stop the remembering, and a row written after it would stay in the deleted file.
test('LAG-SYNC-FS-LOG-108: the slow answer of a check the bound already settled does not end the next check (a row after it still reaches the new file)', async () => {
  const { APPEND_LINK_HELD_MAX } = loadTs('src/main/appendLog.ts');
  const p = path.join(dir(), 'log.jsonl');
  let t = 1_000_000;
  const f = new AppendFile(p, { now: () => t });
  f.append('{"a":0}\n');
  t += APPEND_LINK_CHECK_MS;
  const w = watchFstat({ hold: true });
  try {
    for (let a = 0; a < APPEND_LINK_HELD_MAX; a++) f.append('{"a":0}\n');   // check A, settled by the bound
    assert.deepEqual([w.asked, w.sync, f.sinceCheck], [1, 1, null], 'the bound answered check A on this thread: not deleted');
    assert.ok(await until(() => w.held.length === 1), "check A's own answer is still on its way");
    fs.rmSync(p);                                 // now the live log is deleted
    t += APPEND_LINK_CHECK_MS;
    f.append('{"a":1}\n');                        // starts check B
    f.append('{"a":2}\n');
    assert.equal(w.asked, 2);
    assert.ok(await until(() => w.held.length === 2));
    w.held.shift()();                             // check A's slow answer ("not deleted") arrives
    assert.notEqual(f.sinceCheck, null, "A SETTLED CHECK'S LATE ANSWER DOES NOT END THE NEXT CHECK");
    f.append('{"a":3}\n');                        // written to the ghost, remembered for check B
    w.release();                                  // check B: deleted
    assert.deepEqual(seq(p), [1, 2, 3], 'every row since check B began is in the new file, once, in order');
  } finally { w.release(); w.restore(); }
  f.close();
});

test('LAG-SYNC-FS-LOG-108: close() during a check on a deleted log still puts the rows in the new file; the late answer changes nothing', async () => {
  const p = path.join(dir(), 'log.jsonl');
  let t = 1_000_000;
  const f = new AppendFile(p, { now: () => t });
  f.append('{"a":1}\n');
  fs.rmSync(p);
  t += APPEND_LINK_CHECK_MS;
  const w = watchFstat({ hold: true });
  try {
    f.append('{"a":2}\n');
    f.append('{"a":3}\n');
    assert.equal(w.asked, 1);
    f.close();                                    // a quit: the answer has not come
    assert.equal(f.isOpen, false);
    assert.deepEqual(seq(p), [2, 3], 'the rows written since the check began are in the file at the path');
    assert.ok(await until(() => w.held.length === 1));
    w.release();                                  // the answer for a descriptor that is gone
    assert.deepEqual(seq(p), [2, 3], 'not written a second time');
    assert.equal(f.isOpen, false, 'and nothing reopened');
  } finally { w.release(); w.restore(); }
});

test('LAG-SYNC-FS-LOG-108: a row that reaches the cap during a check keeps every row once, in order, deleted log or not', async () => {
  // Not deleted: the row that reaches the cap rotates as before, and the late answer is dropped.
  {
    const p = path.join(dir(), 'log.jsonl');
    let t = 1_000_000;
    const f = new AppendFile(p, { capBytes: 300, keep: Infinity, now: () => t });
    f.append('{"a":1}\n');
    const w = watchFstat({ hold: true });
    try {
      t += APPEND_LINK_CHECK_MS;
      for (let a = 2; a <= 60; a++) { t += 1; f.append(`{"a":${a},"pad":"xxxxxxxxxxxxxxxxxxxx"}\n`); }
      assert.ok(rotatedFiles(p).length >= 3, 'it rotated while the answer was held');
      assert.ok(await until(() => w.held.length === 1), 'the answer for the first descriptor arrives late');
      w.release();
    } finally { w.release(); w.restore(); }
    f.close();
    assert.deepEqual(filesInOrder(p).flatMap((x) => seq(x)), Array.from({ length: 60 }, (_, i) => i + 1));
  }
  // Deleted, and the row that reaches the cap arrives before the answer.
  {
    const p = path.join(dir(), 'log.jsonl');
    let t = 1_000_000;
    const f = new AppendFile(p, { capBytes: 300, keep: Infinity, now: () => t });
    f.append('{"a":1}\n');
    fs.rmSync(p);
    t += APPEND_LINK_CHECK_MS;
    const w = watchFstat({ hold: true });
    try {
      f.append('{"a":2}\n');
      f.append(`{"a":3,"pad":"${'x'.repeat(400)}"}\n`);   // over the cap on the ghost
      assert.ok(fs.existsSync(p), 'recreated by path without waiting for the answer');
    } finally { w.release(); w.restore(); }
    f.close();
    assert.deepEqual(filesInOrder(p).flatMap((x) => seq(x)), [2, 3], 'no row lost to the ghost, none written twice');
  }
});

test('LAG-SYNC-FS-LOG-108: the lifetime-cost fold lists the ledger folder off the main thread (no readdirSync), with the same totals', async () => {
  const d = dir(); const p = path.join(d, 'cost-ledger.jsonl');
  let t = 0;
  const f = new AppendFile(p, { capBytes: 400, keep: Infinity, now: () => ++t });
  for (let i = 1; i <= 40; i++) f.append(JSON.stringify({ agent_id: i % 2 ? 'a' : 'b', session_id: 's', usd: i / 100 }) + '\n');
  f.close();
  assert.ok(rotatedFiles(p).length >= 2, 'the ledger is spread over rotated files');
  const real = fs.readdirSync; const listed = [];
  fs.readdirSync = (dirPath, ...rest) => { if (path.resolve(String(dirPath)) === path.resolve(d)) listed.push(String(dirPath)); return real(dirPath, ...rest); };
  const got = new CostLedgerTotals();
  try { await got.refreshFully(p); await got.refresh(p); } finally { fs.readdirSync = real; }
  assert.deepEqual(listed, [], 'no synchronous listing of the ledger folder');
  assert.equal(got.ready, true);
  assert.ok(Math.abs(got.usdFor('a') - 0.39) < 1e-9 && Math.abs(got.usdFor('b') - 0.40) < 1e-9, `${got.usdFor('a')} ${got.usdFor('b')}`);
  // An unreadable folder is the live file alone, as before: nothing folded, the totals stand.
  const none = new CostLedgerTotals();
  await none.refresh(path.join(d, 'absent', 'cost-ledger.jsonl'));
  assert.equal(none.ready, false);
});
