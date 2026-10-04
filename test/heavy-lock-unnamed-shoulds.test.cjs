'use strict';
/**
 * HEAVY-LOCK-UNNAMED-SHOULDS (god 7acffb; Jim's re-audit of 8671c52e..6f3009e1, shoulds S1-S3).
 *  S3 when does a typed suite's slot free? `write_stdin` types the suite into a shell session an
 *     EARLIER exec_command started, and returns after its yield while the suite runs on. The slot
 *     must hold until the suite ends (not at the call's return), and the long-lived shell itself
 *     (created before the call) must not hold it after the suite ends.
 *  S1 codeMask must not read a quote inside a regex literal (`/"/`) as a string opening.
 *  S2 a single-quoted `chars` literal is read (hinted), not just counted.
 * All commands, pids and programs are invented.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { HeavyJobLock, HEAVY_SCAN_MS } = loadTs('src/main/heavyJob.ts');
const mcp = loadTs('src/main/codexHookMcp.ts');

const T0 = Date.parse('2026-10-04T08:00:00Z');   // a real epoch: the older shell's creation time stays after its parents'
const H = { heavy: true, kind: 'suite' };
function lock(limit, extra = {}) {
  let now = T0; const logs = [];
  const l = new HeavyJobLock({ limit: () => limit, now: () => now, setTimer: () => ({}), clearTimer: () => {}, log: (r) => logs.push(r), ...extra });
  return { l, logs, tick: (ms) => { now += ms; }, at: () => now };
}
const flush = () => new Promise((r) => setImmediate(r));
/** The agent's PTY root (pid 10) and its Codex CLI (pid 11). */
const BASE = [{ pid: 10, parentPid: 1, commandLine: 'pty', createdMs: 1 }, { pid: 11, parentPid: 10, commandLine: 'codex.exe', createdMs: 2 }];
/** The shell an earlier exec_command started, long before the write_stdin call. */
const SHELL = { pid: 90, parentPid: 11, commandLine: 'powershell.exe -NoLogo', createdMs: T0 - 20 * 60_000 };

for (const paired of [true, false]) {
  test(`S3: a suite typed with write_stdin into an older shell keeps the slot until it ends, not the shell (${paired ? 'PostToolUse arrives' : 'unpaired MCP hook'})`, async () => {
    let procs = [...BASE, SHELL];
    const x = lock(1, { roots: () => [{ agentId: 'a', pid: 10 }], probe: async () => procs });
    // hooks.ts: an mcp/degraded call is acquired as background (unpaired); a paired one is not.
    assert.equal(x.l.acquire('a', H, 'node test/tools/run-tests.cjs', 'c1', !paired).allow, true);
    const start = x.at();
    // The shell starts the typed suite during the call; write_stdin returns after its 10 s yield.
    procs = [...BASE, SHELL, { pid: 91, parentPid: 90, commandLine: 'node test/tools/run-tests.cjs', createdMs: start + 300 },
      { pid: 92, parentPid: 91, commandLine: 'node --test a.test.cjs', createdMs: start + 2_000 }];
    x.tick(10_000);
    if (paired) x.l.callDone('a', 'c1');
    await flush();
    for (let i = 0; i < 6; i++) { x.tick(HEAVY_SCAN_MS); await x.l.scan(); }
    assert.equal(x.l.snapshot().length, 1, 'HELD while the typed suite runs, after write_stdin returned');
    assert.equal(x.l.acquire('b', H, 'npm ci', 'b1', false).allow, false, 'another heavy job waits');
    // The suite ends; the shell session lives on (the agent keeps it for later input).
    procs = [...BASE, SHELL];
    for (let i = 0; i < 4; i++) { x.tick(HEAVY_SCAN_MS); await x.l.scan(); }
    assert.equal(x.l.snapshot().filter((h) => h.agentId === 'a').length, 0, 'freed when the suite ends: the older shell does not hold it');
  });
}

const line = (type, payload) => JSON.stringify({ timestamp: '2026-10-04T08:00:00.000Z', type, payload });
const hint = (input) => mcp.pendingExecCommands([line('turn_context', { turn_id: 't' }), line('response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input })].join('\n'));
const { classifyCommand } = loadTs('src/main/heavyJob.ts');

test('S1: a quote inside a regex literal no longer hides the calls after it; a division is not a regex', () => {
  const cases = [
    // Parsing output with a quote-bearing regex, then two literal calls (Jim's probe shape).
    [String.raw`const m = out.match(/"(.*)"/); await tools.exec_command({cmd:"node test/tools/run-tests.cjs"}); await tools.exec_command({cmd:"echo b"});`, ['node test/tools/run-tests.cjs', 'echo b'], 0],
    // A class holding the slash and a quote; flags after it.
    [String.raw`const r = /[/"]+/g; await tools.exec_command({cmd:"npm ci"}); await tools.exec_command({cmd: c});`, ['npm ci'], 1],
    // After return, and at a line start.
    [String.raw`function f(s) { return /"/.test(s); } await tools.exec_command({cmd:"npm ci"}); await tools.exec_command({cmd:"echo b"});`, ['npm ci', 'echo b'], 0],
    ['const ok = s\n  /"/.test(x);\nawait tools.exec_command({cmd:"npm ci"}); await tools.exec_command({cmd:"echo b"});', ['npm ci', 'echo b'], 0],
    // A division (after a value) is not a regex: the call with a slash in its command is read.
    [String.raw`const n = total / 2; await tools.exec_command({cmd:"npm ci /q"}); await tools.exec_command({cmd:"echo b"});`, ['npm ci /q', 'echo b'], 0],
    // A regex literal mentioning the tool is not a mention.
    [String.raw`const re = /exec_command\(/; await tools.exec_command({cmd:"npm ci"}); await tools.exec_command({cmd:"echo b"});`, ['npm ci', 'echo b'], 0],
  ];
  for (const [input, commands, unnamed] of cases) {
    const h = hint(input);
    assert.deepEqual([h.commands, h.unnamed], [commands, unnamed], input);
  }
  assert.equal(classifyCommand(hint(cases[0][0]).commands[0]).heavy, true, 'the suite behind the regex is heavy again');
});

test('S2: single-quoted and plain-template cmd/chars are read; a substitution or an escape JSON lacks stays unnamed', () => {
  const cases = [
    [String.raw`await tools.write_stdin({session_id: 1, chars: 'node test/tools/run-tests.cjs\n'});`, ['node test/tools/run-tests.cjs'], 0],
    ['await tools.write_stdin({session_id: 1, chars: `npm test\n`});', ['npm test'], 0],
    [String.raw`await tools.exec_command({cmd: 'echo \'a\' "b" c:\\x'});`, [String.raw`echo 'a' "b" c:\x`], 0],
    ['await tools.exec_command({cmd: `echo one\ttwo`});', ['echo one\ttwo'], 0],
    ['await tools.exec_command({cmd: `npm ${x}`});', [], 1],
    [String.raw`await tools.exec_command({cmd: 'npm \x41'});`, [], 1],
    [String.raw`await tools.exec_command({cmd: 'npm ci' + x});`, [], 1],
  ];
  for (const [input, commands, unnamed] of cases) {
    const h = hint(input);
    assert.deepEqual([h.commands, h.unnamed], [commands, unnamed], input);
  }
  assert.equal(classifyCommand(hint(cases[0][0]).commands[0]).heavy, true);
});
