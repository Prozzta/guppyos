'use strict';
require('./tools/own-job.cjs');
// TEST-TEMP-LEAK-UNDER-LOAD: the teardown waits in test/tools/await-exit.cjs never resolve while a
// process they wait for still runs, and reject (naming it) at the cap instead of hanging or passing.
const test = require('node:test');
const assert = require('node:assert/strict');
const { awaitHeldExit, awaitOrphansExit, awaitRowsExit, waitScript } =require('./tools/await-exit.cjs');

function clock() {
  let t = 0;
  return { now: () => t, step: (ms) => { t += ms; } };
}

test('awaitHeldExit resolves only once every hold reports the process gone', async () => {
  let polls = 0;
  const a = { pid: 11, hold: { alive: () => polls < 3 } };
  const b = { pid: 12, hold: { alive: () => { polls++; return polls < 5; } } };
  await awaitHeldExit([a, b], { stepMs: 1 });
  assert.ok(polls >= 5, 'it kept polling until the last hold was signalled');
});

test('awaitHeldExit rejects at the cap naming only the pids still running', async () => {
  const c = clock();
  const holds = [{ pid: 21, hold: { alive: () => true } }, { pid: 22, hold: { alive: () => false } }];
  await assert.rejects(awaitHeldExit(holds, { capMs: 100, stepMs: 1, now: () => { c.step(40); return c.now(); } }),
    (e) => /still running 100 ms after the kill: pid 21$/.test(e.message));
});

test('awaitHeldExit with no live hold returns at once', async () => {
  await awaitHeldExit([{ pid: 31, hold: { alive: () => false } }], { capMs: 0 });
});

const ROOT = { pid: 100, bornMs: 5000, goneBy: 9000 };
// the root (100) has exited: its rows are found by ppid and birth (own-procs ownTree)
const table = () => [
  { pid: 101, ppid: 100, created: 5100, name: 'crashpad_handler.exe' },
  { pid: 102, ppid: 100, created: 5200, name: 'electron.exe' },
  { pid: 106, ppid: 102, created: 5300, name: 'electron.exe' },
  { pid: 103, ppid: 100, created: 3000, name: 'old.exe' }, // older than the root: an earlier pid 100's child
  { pid: 105, ppid: 100, created: 9500, name: 'late.exe' }, // born after the root was gone: a reused pid's child
  { pid: 104, ppid: 7, created: 5400, name: 'stranger.exe' },
];

test('awaitOrphansExit waits for the gone root\'s tree only, never strangers', async () => {
  let script = null;
  const rows = await awaitOrphansExit(ROOT, { table, platform: 'win32', ps: async (s) => { script = s; return ''; } });
  assert.deepEqual(rows.map((r) => r.pid).sort(), [101, 102, 106]);
  for (const pid of [101, 102, 106]) assert.match(script, new RegExp(`"pid":${pid}[,}]`));
  assert.doesNotMatch(script, /"pid":(100|103|104|105)[,}]/);
});

test('awaitOrphansExit never waits for the root itself while its row is still listed', async () => {
  let script = null;
  const rows = await awaitOrphansExit(ROOT, { table: () => [{ pid: 100, ppid: 1, created: 4999, name: 'electron.exe' }, ...table()],
    platform: 'win32', ps: async (s) => { script = s; return ''; } });
  assert.ok(rows.length && !rows.some((r) => r.pid === 100));
  assert.doesNotMatch(script, /"pid":100[,}]/);
});

test('awaitOrphansExit rejects naming each process the wait reports LIVE', async () => {
  await assert.rejects(awaitOrphansExit(ROOT, { table, platform: 'win32', capMs: 50, ps: async () => 'other output\r\nLIVE 101 crashpad_handler.exe\r\n' }),
    (e) => /still running 50 ms after pid 100 exited: 101 crashpad_handler\.exe$/.test(e.message));
});

test('awaitOrphansExit with no orphan does not start the wait', async () => {
  const rows = await awaitOrphansExit(ROOT, { table: () => [table()[3], table()[5]], platform: 'win32', ps: async () => { throw new Error('no wait expected'); } });
  assert.deepEqual(rows, []);
});

test('awaitOrphansExit is a no-op off Windows', async () => {
  assert.deepEqual(await awaitOrphansExit(ROOT, { table: () => { throw new Error('no table'); }, platform: 'linux' }), []);
});

test('awaitRowsExit waits for exactly the recorded rows and rejects naming each one LIVE', async () => {
  let script = null;
  const rows = [{ pid: 201, created: 7000, name: 'node.exe' }];
  assert.deepEqual(await awaitRowsExit(rows, { platform: 'win32', ps: async (s) => { script = s; return ''; } }), rows);
  assert.match(script, /"pid":201,"created":7000,"name":"node.exe"/);
  await assert.rejects(awaitRowsExit(rows, { platform: 'win32', capMs: 60, ps: async () => 'LIVE 201 node.exe\r\n' }),
    (e) => /still running 60 ms after the kill: 201 node\.exe$/.test(e.message));
});

test('awaitRowsExit with no row, or off Windows, starts no wait', async () => {
  const ps = async () => { throw new Error('no wait expected'); };
  assert.deepEqual(await awaitRowsExit([], { platform: 'win32', ps }), []);
  assert.deepEqual(await awaitRowsExit([{ pid: 1, created: 1, name: 'x' }], { platform: 'linux', ps }), []);
});

test('awaitRowsExit, real PowerShell: an exited row resolves, a running one rejects naming it', { skip: process.platform !== 'win32' }, async () => {
  const { spawn } = require('node:child_process');
  const { lookupPids, childrenOf } = require('./tools/own-procs.cjs');
  const start = async () => {
    const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    await new Promise((resolve, reject) => { c.once('spawn', resolve); c.once('error', reject); });
    const ids = lookupPids([process.pid, c.pid]);
    const self = ids.find((r) => r.pid === process.pid);
    const row = self && childrenOf(ids, self).find((r) => r.pid === c.pid);
    assert.ok(row, 'the child is listed as ours');
    return { c, row, exited: new Promise((resolve) => c.once('exit', resolve)) };
  };
  const a = await start();
  const b = await start();
  try {
    a.c.kill();
    await a.exited;
    // the LAST row is the gone one: PowerShell's own exit code must not fail the wait
    await assert.rejects(awaitRowsExit([b.row, a.row], { capMs: 300 }), (e) => new RegExp(`after the kill: ${b.row.pid} node\\.exe$`).test(e.message));
    assert.deepEqual(await awaitRowsExit([a.row], { capMs: 300 }), [a.row]);
  } finally { a.c.kill(); b.c.kill(); await b.exited; }
});

test('waitScript re-checks identity and waits within the cap', () => {
  const s = waitScript([{ pid: 5, created: 77, name: "o'k.exe", extra: 1 }], 1234);
  assert.match(s, /AddMilliseconds\(1234\)/);
  assert.match(s, /o''k\.exe/);
  assert.match(s, /ToUnixTimeMilliseconds\(\) -ne \$t\.created/);
  assert.match(s, /WaitForExit\(\$left\)/);
  assert.match(s, /\nexit 0$/, 'a row already gone (caught) does not make the wait exit 1');
  assert.doesNotMatch(s, /extra/);
});
