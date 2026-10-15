'use strict';
/**
 * TEST-GLOB-PID-RECYCLE (1.1.88): a test lists and kills only the processes it started.
 * test-runner-glob listed the Human's HWiNFO64.EXE (pid 20664) as a hung file's child, on
 * ParentProcessId alone, and process.kill'ed it (it survived because it runs elevated). Fake process
 * tables here: an OLDER "child" and a RECYCLED grandchild are ignored and never killed; a pid that
 * changed hands between the snapshot and the kill is not killed.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const own = require('./tools/own-procs.cjs');
const { dueFiles, killTree } = require('./tools/file-watchdog.cjs');

const T = 1_792_000_000_000;   // the hung file's birth
const R = (pid, ppid, created, name = 'node.exe') => ({ pid, ppid, created, name });
const BOOT = T - 6 * 3600_000;
// The hung file (5000, dead: not in the table), what it really left, and what only LOOKS like it.
const TABLE = [
  R(20664, 5000, BOOT, 'HWiNFO64.EXE'),        // an OLDER "child": its long-gone parent had pid 5000
  R(6000, 5000, T + 300, 'conhost.exe'),       // the file's ConPTY conhost: ours
  R(6001, 6000, T + 400, 'cmd.exe'),           // its grandchild: ours
  R(6002, 6000, T - 60_000, 'svchost.exe'),    // a RECYCLED grandchild: older than its "parent" 6000
  R(7000, 1, T + 50, 'node.exe')               // unrelated
];
/** Fake deps that record every kill; `now` is the table at kill time (default: unchanged). */
const deps = (now = TABLE) => { const kills = []; return { kills, lookup: (pids) => now.filter((r) => pids.includes(r.pid)), kill: (rows) => kills.push(...rows.map((r) => r.pid)) }; };

test('a child is created at or after its parent: an OLDER process naming the parent is not a child', () => {
  const kids = own.childrenOf(TABLE, { pid: 5000, created: T });
  assert.deepStrictEqual(kids.map((r) => r.pid), [6000], 'HWiNFO64.EXE (created at boot) is not the file\'s child');
  assert.deepStrictEqual(own.childrenOf([R(9, 5000, T)], { pid: 5000, created: T }).map((r) => r.pid), [9], 'created at the same ms: a child');
});

test('the tree checks every link: a RECYCLED grandchild (older than its "parent") is not in it', () => {
  assert.deepStrictEqual(own.treeOf(TABLE, { pid: 5000, created: T }).map((r) => r.pid), [6000, 6001]);
});

test('a dead hung file: its orphans are killed, the older "child" and the recycled grandchild are NOT', () => {
  const d = deps();
  const r = own.killOwnTree({ pid: 5000, bornMs: T, name: 'node.exe' }, { table: () => TABLE, ...d });
  assert.deepStrictEqual(d.kills, [6001, 6000], 'deepest first');
  assert.ok(!d.kills.includes(20664) && !d.kills.includes(6002), 'NEVER the Human\'s process');
  assert.deepStrictEqual(r.skipped, []);
});

test('a recorded pid now held by ANOTHER process: nothing is ours, nothing is killed', () => {
  const table = [R(5000, 4, BOOT, 'HWiNFO64.EXE'), R(5100, 5000, T + 10, 'HWiNFO64.EXE')];
  const d = deps(table);
  const r = own.killOwnTree({ pid: 5000, bornMs: T, name: 'node.exe' }, { table: () => table, ...d });
  assert.deepStrictEqual(d.kills, [], 'not the stranger, and not the stranger\'s children');
  assert.strictEqual(r.stranger.name, 'HWiNFO64.EXE');
  // same birth, other image: still not ours
  assert.deepStrictEqual(own.ownTree([R(5000, 4, T, 'notepad.exe')], { pid: 5000, bornMs: T, name: 'node.exe' }).tree, []);
});

test('a live recorded process within the birth slack is ours, with its tree', () => {
  const table = [R(5000, 4, T - 15), ...TABLE];
  const t = own.ownTree(table, { pid: 5000, bornMs: T, name: 'node.exe' });
  assert.deepStrictEqual(t.tree.map((r) => r.pid), [5000, 6000, 6001]);
  assert.deepStrictEqual(own.ownTree(table, { pid: 5000, bornMs: T + own.BIRTH_SLACK_MS + 100 }).tree, [], 'outside the slack: not ours');
});

test('re-verified just before the kill: a pid that died and was REUSED since the snapshot is not killed', () => {
  const later = [R(6000, 5000, T + 300, 'conhost.exe'), R(6001, 77, T + 90_000, 'chrome.exe')];   // 6001 now another program
  const d = deps(later);
  const r = own.killVerified(own.treeOf(TABLE, { pid: 5000, created: T }), d);
  assert.deepStrictEqual(d.kills, [6000]);
  assert.deepStrictEqual(r.skipped.map((x) => x.pid), [6001]);
  // reused by the SAME image (another node.exe, another conhost): only the CreationDate tells them apart
  const twin = deps([R(6000, 5000, T + 9_000, 'conhost.exe')]);
  assert.deepStrictEqual(own.killVerified([R(6000, 5000, T + 300, 'conhost.exe')], twin).killed, []);
  assert.deepStrictEqual(twin.kills, [], 'same pid and name, another birth: not killed');
  const gone = deps([]);
  assert.deepStrictEqual(own.killVerified([R(6000, 5000, T + 300, 'conhost.exe')], gone).killed, []);
  assert.deepStrictEqual(gone.kills, [], 'a gone pid: no kill call at all');
});

test('watchdog: an OLDER node --test or test-file process under a recycled pid is not due', () => {
  const now = 1_000_000;
  const P = (pid, ppid, name, cmd, age) => ({ pid, ppid, name, cmd, startedAt: now - age });
  const procs = [
    P(10, 1, 'node.exe', 'node run-tests.cjs', 100_000),
    P(20, 10, 'node.exe', 'node.exe --test a.test.cjs', 90_000),
    P(30, 20, 'node.exe', 'node.exe C:/r/test/hung.test.cjs', 6_000),
    P(21, 10, 'node.exe', 'node.exe --test x.test.cjs', 500_000),       // older than the runner
    P(22, 21, 'node.exe', 'node.exe C:/o/test/x.test.cjs', 6_000),
    P(31, 20, 'node.exe', 'node.exe C:/o/test/old.test.cjs', 95_000)    // older than its node --test
  ];
  assert.deepStrictEqual(dueFiles(procs, 10, 5_000, now).map((d) => d.pid), [30]);
  assert.deepStrictEqual(dueFiles(procs.filter((p) => p.pid !== 10), 10, 5_000, now), [], 'no runner row: nothing can be verified');
});

test('watchdog: the tree kill takes the file and its tree, verified, never an older process naming it', () => {
  const now = 1_000_000;
  const P = (pid, ppid, name, age) => ({ pid, ppid, name, cmd: '', startedAt: now - age });
  const procs = [P(30, 20, 'node.exe', 6_000), P(32, 30, 'conhost.exe', 5_000), P(33, 30, 'HWiNFO64.EXE', 900_000)];
  const kills = [];
  const rows = (pids) => procs.filter((p) => pids.includes(p.pid)).map((p) => ({ pid: p.pid, ppid: p.ppid, created: p.startedAt, name: p.name }));
  killTree(procs, 30, { lookup: rows, kill: (rs) => kills.push(...rs.map((r) => r.pid)) });
  assert.deepStrictEqual(kills, [32, 30], 'deepest first: the file LAST, so the run it ends cannot stop the kill halfway');
});

test('parseRows reads pid|ppid|createdMs|name, names with spaces kept', () => {
  assert.deepStrictEqual(own.parseRows('12|4|1792000000000|node.exe\r\n13|12|1792000000001|Some App.exe\r\n\r\njunk'),
    [R(12, 4, 1792000000000), R(13, 12, 1792000000001, 'Some App.exe')]);
});

test('PIN: the suite\'s kill sites go through own-procs (no ParentProcessId-only listing, no taskkill /T, no process.kill of a listed pid)', () => {
  const src = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
  const glob = src('test-runner-glob.test.cjs'), dog = src('tools/file-watchdog.cjs');
  assert.doesNotMatch(glob, /Sync\('taskkill'/, 'test-runner-glob');
  assert.doesNotMatch(glob, /-Filter "ParentProcessId=/, 'test-runner-glob: no ParentProcessId-only listing');
  // process.kill(pid, 0) only probes; any other process.kill takes a bare pid that may have been reused
  for (const f of ['test-runner-glob.test.cjs', 'claude-model-list-180.test.cjs', 'models-refresh-173.test.cjs', 'quit-sweep.electron.test.cjs']) {
    const kills = (src(f).match(/process\.kill\([^)]*\)/g) || []).filter((k) => !/,\s*0\)$/.test(k));
    assert.deepStrictEqual(kills, [], `${f}: no process.kill of a recorded or listed pid`);
  }
  assert.doesNotMatch(dog, /execFileSync\('taskkill'/, 'file-watchdog');
});

test('own-procs, real (win32): kills a tree of TWO children it started, and not one recorded with another birth', { timeout: 60_000, skip: process.platform !== 'win32' && 'win32 only' }, async () => {
  const { spawn } = require('node:child_process');
  const start = () => { const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true }); return { c, rec: { pid: c.pid, bornMs: Date.now(), name: 'node.exe' }, exit: new Promise((r) => c.once('exit', r)) }; };
  const a = start(), b = start(), keep = start();
  try {
    await new Promise((r) => setTimeout(r, 500));
    // one call, several rows (PowerShell 5.1 once took the JSON list as ONE object and killed none)
    const rows = own.lookupPids([a.c.pid, b.c.pid]);
    assert.strictEqual(rows.length, 2);
    const r = own.killVerified(rows);
    assert.strictEqual(r.killed.length, 2);
    await Promise.all([a.exit, b.exit]);
    // the pid of a live process, recorded with a birth an hour off: another process's, never killed
    const k = own.killOwnTree({ ...keep.rec, bornMs: keep.rec.bornMs - 3600_000 });
    assert.deepStrictEqual(k.killed, []);
    assert.ok(k.stranger, 'seen as a stranger');
    await new Promise((r) => setTimeout(r, 300));
    assert.strictEqual(keep.c.exitCode, null, 'still running');
  } finally { for (const x of [a, b, keep]) try { x.c.kill(); } catch { /* gone */ } }
});

test('own-procs, real (win32): finds this process by pid with its CreationDate, within the birth slack', { skip: process.platform !== 'win32' && 'win32 only' }, () => {
  const [me] = own.lookupPids([process.pid]);
  assert.ok(me, 'this process is in the table');
  assert.ok(Math.abs(me.created - own.bornNow()) <= own.BIRTH_SLACK_MS, `CreationDate ${me.created} vs node birth ${own.bornNow()}`);
  assert.strictEqual(own.ownTree([me], { pid: process.pid, bornMs: own.bornNow(), name: me.name }).root.pid, process.pid);
});
