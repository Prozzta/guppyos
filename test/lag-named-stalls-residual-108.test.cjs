'use strict';
require('./tools/own-job.cjs');

/**
 * LAG-NAMED-STALLS-RESIDUAL-108 (god 7e3f47, rulings 3ed50a): the named paths that stalled the main
 * thread for 1 s or more on 1.1.106 and 1.1.107 and were still synchronous on int.
 *
 *   1. statSync:(  (2260 ms, 2026-11-17T21:34Z). The name is whole: at every PreToolUse the heavy-lock
 *      classifier asks its script reader about command words that might be script files, and the
 *      reader answered with statSync + readFileSync on the main thread. A PowerShell command with a
 *      bracket in a quoted string makes it stat `<cwd>/(`. The same reader runs at PostToolUse (a
 *      provisional hold is classified again) and in the lease of a suite runner, and the runner's
 *      test-file lister walks `<cwd>/test` with readdirSync.
 *
 * Each test counts every synchronous fs call under the agent's folder while the path runs (the
 * count must be zero) and holds the answer to the synchronous classifier's. Counts of calls, never
 * milliseconds. HOME and USERPROFILE are jailed first. All paths here are invented.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-lag-named-108-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');

const HJ = loadTs('src/main/heavyJob.ts');
const HK = loadTs('src/main/hooks.ts');

test.after(() => {
  loadTs.closeConfigWatchers?.();
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

/** Every synchronous fs function that takes a path first (as test/lag-main-sync-remainder-108.test.cjs). */
const SYNC_FNS = Object.keys(fs).filter((k) => k.endsWith('Sync') && typeof fs[k] === 'function' && !/^(f|close|write|read)Sync$|^(fstat|fsync|fdatasync|ftruncate|futimes|fchmod|fchown|readv|writev)Sync$/.test(k));
const under = (dir, p) => { const s = path.resolve(String(p)).toLowerCase(); const d = path.resolve(dir).toLowerCase(); return s === d || s.startsWith(d + path.sep); };
/** Run fn (sync or async) and return the synchronous fs calls it made on paths under `dir`. */
async function syncCalls(dir, fn) {
  const orig = {};
  const calls = [];
  for (const k of SYNC_FNS) {
    orig[k] = fs[k];
    fs[k] = function (p, ...rest) {
      if ((typeof p === 'string' || Buffer.isBuffer(p) || p instanceof URL) && under(dir, p)) calls.push(`${k}:${path.basename(String(p))}`);
      return orig[k].call(this, p, ...rest);
    };
  }
  let result;
  try { result = await fn(); } finally { for (const k of SYNC_FNS) fs[k] = orig[k]; }
  return { calls, result };
}

// ─── the agent's folder ─────────────────────────────────────────────────────────────────────────

const NT = ['npm', 'test'].join(' ');
const RUNNER = ['test', 'tools', 'run-tests.cjs'].join('/');
/** A fresh checkout: 25 `ln-many-*` test files (two in a sub-folder), one `ln-only-one`, the real
 *  runner, a script that runs the suite, a light one, one over the size cap, and a folder. */
function agentDir() {
  const dir = fs.mkdtempSync(path.join(JAIL, 'agent-'));
  fs.mkdirSync(path.join(dir, 'test', 'tools'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test', 'sub'), { recursive: true });
  for (let i = 0; i < 23; i++) fs.writeFileSync(path.join(dir, 'test', `ln-many-${i}.test.cjs`), '');
  for (let i = 0; i < 2; i++) fs.writeFileSync(path.join(dir, 'test', 'sub', `ln-many-sub-${i}.test.cjs`), '');
  fs.writeFileSync(path.join(dir, 'test', 'ln-only-one.test.cjs'), '');
  fs.copyFileSync(path.resolve(__dirname, 'tools', 'run-tests.cjs'), path.join(dir, RUNNER));
  fs.writeFileSync(path.join(dir, 'suite.sh'), `#!/bin/bash\n${NT}\n`);
  fs.writeFileSync(path.join(dir, 'light.sh'), '#!/bin/bash\necho hi\ngit log -1\n');
  fs.writeFileSync(path.join(dir, 'outer.sh'), '#!/bin/bash\nbash inner.sh\n');
  fs.writeFileSync(path.join(dir, 'inner.sh'), `#!/bin/bash\n${NT}\n`);
  fs.writeFileSync(path.join(dir, 'big.sh'), `#!/bin/bash\n${'# pad\n'.repeat(HJ.HEAVY_SCRIPT_MAX_BYTES / 6 + 10)}`);
  fs.mkdirSync(path.join(dir, 'tooldir'));
  return dir;
}

/** The bracket command, cut down from the recorded one of 2026-11-16T20:16:41Z (PowerShell tool). */
const BRACKET = '`$d (`';
/** [tool, command, what]: every shape that reaches the reader or the lister. */
const SHAPES = [
  ['Bash', 'bash suite.sh', 'a script that runs the suite'],
  ['Bash', 'bash light.sh', 'a light script'],
  ['Bash', 'bash outer.sh', 'a script that runs a script'],
  ['Bash', 'bash big.sh', 'a script over the size cap'],
  ['Bash', 'bash nothere.sh', 'a script that is not there'],
  ['Bash', './tooldir', 'a folder'],
  ['Bash', `node ${RUNNER} ln-many`, 'the runner with a broad filter'],
  ['Bash', `node ${RUNNER} ln-only-one`, 'the runner with one file'],
  ['Bash', 'cd test && node tools/run-tests.cjs ln-many', 'the runner after a cd'],
  ['PowerShell', BRACKET, 'the bracket of the recorded stall'],
  ['Bash', 'git status', 'nothing to read'],
];

/** A real HookServer on a stub hive, with the lock wired as src/main/index.ts wires it. */
function server(dir, limit = 1) {
  const hive = { sockPath: () => path.join(JAIL, 'never.sock'), codexHomeFor: () => JAIL, recordSession: () => {}, appendLog: () => {}, registry: () => ({ agents: { a1: { cwd: dir }, b1: { cwd: dir } } }), isGod: () => false, rosterContext: () => '', recordModel: () => {}, appendCostLedger: () => {} };
  const control = { shouldHalt: () => false, takeSteer: () => null, toolDecision: () => ({ deny: false }), snapshot: () => ({ gatedTools: [] }) };
  const s = new HK.HookServer(hive, () => ({ send: () => {} }), () => ({}), control, undefined);
  const rows = [];
  const lock = new HJ.HeavyJobLock({
    limit: () => limit, setTimer: () => ({}), clearTimer: () => {}, leasePollMs: 1, log: (r) => rows.push(r),
    classifyCtx: (cwd) => HK.HookServer.heavyScriptCtx(cwd),
    ...(typeof HK.HookServer.heavyRead === 'function' ? { classifyRead: (run) => HK.HookServer.heavyRead(run) } : {}),
  });
  s.setHeavyLock(lock);
  const fire = (agent_id, hook_event_name, tool_name, command, id, more = {}) => s.handleWithClaimContext({ agent_id, hook_event_name, session_id: 's', cwd: dir, tool_name, tool_input: more.background ? { command, run_in_background: true } : { command }, tool_use_id: id, transport: 'http', ...more.payload });
  return { s, lock, rows, fire };
}
const denied = (out) => out?.hookSpecificOutput?.permissionDecision === 'deny';
const suiteIn = (file) => ({ heavy: true, kind: 'suite', why: `${NT} (in ${file})` });
const sync = (dir, tool, command) => HJ.classifyHeavy(tool, { command }, HK.HookServer.heavyScriptCtx(dir));

// ─── the counter counts ─────────────────────────────────────────────────────────────────────────

test('NON-VACUOUS: the counter sees the synchronous reader and lister, and the bracket really is asked for', async () => {
  const dir = agentDir();
  const a = await syncCalls(dir, () => sync(dir, 'Bash', 'bash suite.sh'));
  assert.ok(a.calls.includes('statSync:suite.sh') && a.calls.includes('readFileSync:suite.sh'), JSON.stringify(a.calls));
  assert.deepEqual(a.result, suiteIn('suite.sh'));
  const b = await syncCalls(dir, () => sync(dir, 'Bash', `node ${RUNNER} ln-many`));
  assert.ok(b.calls.includes('readdirSync:test') && b.calls.includes('readdirSync:sub'), JSON.stringify(b.calls));
  assert.equal(b.result.kind, 'suite', JSON.stringify(b.result));
  const c = await syncCalls(dir, () => sync(dir, 'PowerShell', BRACKET));
  assert.ok(c.calls.includes('statSync:('), `THE STALL'S NAME: ${JSON.stringify(c.calls)}`);
});

// ─── PreToolUse ─────────────────────────────────────────────────────────────────────────────────

test('PreToolUse: no shape of command makes the hook touch the disk synchronously, and each is judged as before', async () => {
  for (const [tool, command, what] of SHAPES) {
    const dir = agentDir();
    const want = sync(dir, tool, command);
    const { fire, lock } = server(dir);
    // b1 holds the only slot, so a heavy call of a1 is denied and a light one is not.
    assert.equal(denied(await fire('b1', 'PreToolUse', 'Bash', 'GUPPY_BENCH=1 node bench.cjs', 'u0')), false, 'b1 takes the slot');
    const { calls, result } = await syncCalls(dir, () => fire('a1', 'PreToolUse', tool, command, 'u1'));
    assert.deepEqual(calls, [], `${what} (${command}): synchronous fs on the main thread`);
    assert.equal(denied(result), want.heavy, `${what} (${command}): judged as the synchronous classifier judges it (${JSON.stringify(want)})`);
    assert.deepEqual(lock.snapshot().map((h) => h.agentId), ['b1']);
  }
});

test('PreToolUse: a degraded Codex hook classifies its rollout hints without synchronous fs', async () => {
  const dir = agentDir();
  const { fire } = server(dir);
  assert.equal(denied(await fire('b1', 'PreToolUse', 'Bash', 'GUPPY_BENCH=1 node bench.cjs', 'u0')), false);
  const { calls, result } = await syncCalls(dir, () => fire('a1', 'PreToolUse', 'exec', '', 'u1', { payload: { tool_input: {}, payload_degraded: true, transport: 'mcp', codex_commands: ['git status', 'bash suite.sh'] } }));
  assert.deepEqual(calls, []);
  assert.equal(denied(result), true, 'the hinted suite script is denied');
});

test('PreToolUse: a hook template\'s own input (hook_tool_input) is what is read ahead', async () => {
  const dir = agentDir();
  const { fire } = server(dir);
  assert.equal(denied(await fire('b1', 'PreToolUse', 'Bash', 'GUPPY_BENCH=1 node bench.cjs', 'u0')), false);
  const { calls, result } = await syncCalls(dir, () => fire('a1', 'PreToolUse', 'exec', 'git status', 'u1', { payload: { transport: 'mcp', hook_tool_input: { command: 'bash suite.sh' } } }));
  assert.deepEqual(calls, []);
  assert.equal(denied(result), true);
});

// ─── PostToolUse ────────────────────────────────────────────────────────────────────────────────

test('PostToolUse: a provisional background hold is classified again without synchronous fs (freed when light, kept when heavy)', async () => {
  for (const [body, kept] of [['echo hi\ngit log -1\n', false], [`${NT}\n`, true]]) {
    const dir = agentDir();
    const { fire, lock, rows } = server(dir);
    const pre = await syncCalls(dir, () => fire('a1', 'PreToolUse', 'Bash', 'bash later.sh', 'j1', { background: true }));
    assert.deepEqual(pre.calls, []);
    assert.equal(lock.snapshot().length, 1, 'held for a script that is not there yet');
    fs.writeFileSync(path.join(dir, 'later.sh'), body);
    const post = await syncCalls(dir, () => fire('a1', 'PostToolUse', 'Bash', 'bash later.sh', 'j1', { background: true }));
    assert.deepEqual(post.calls, [], JSON.stringify(body));
    assert.equal(lock.snapshot().length, kept ? 1 : 0, JSON.stringify(body));
    assert.equal(rows.some((r) => r.action === 'settled-light'), !kept);
  }
});

test('PostToolUse: a call that holds nothing provisional is not read at all', async () => {
  const dir = agentDir();
  const { fire } = server(dir);
  await fire('a1', 'PreToolUse', 'Bash', 'bash light.sh', 'u1');
  const asked = [];
  const orig = { stat: fs.promises.stat, readFile: fs.promises.readFile, readdir: fs.promises.readdir };
  for (const k of Object.keys(orig)) fs.promises[k] = function (p, ...rest) { if (typeof p === 'string' && under(dir, p)) asked.push(`${k}:${path.basename(p)}`); return orig[k].call(this, p, ...rest); };
  let calls;
  try { ({ calls } = await syncCalls(dir, () => fire('a1', 'PostToolUse', 'Bash', 'bash light.sh', 'u1'))); } finally { Object.assign(fs.promises, orig); }
  assert.deepEqual(calls, []);
  assert.deepEqual(asked, [], 'nothing would be classified, so nothing is read');
});

// ─── the lease ──────────────────────────────────────────────────────────────────────────────────

test('LEASE: a suite runner\'s argv is judged in its folder without synchronous fs', async () => {
  const dir = agentDir();
  const { lock } = server(dir);
  const runner = path.join(dir, RUNNER);
  const one = await syncCalls(dir, () => lock.lease('a1', { op: 'acquire', pid: 4241, createdMs: Date.now(), runner: [runner, 'ln-only-one'], cwd: dir }));
  assert.deepEqual(one.calls, []);
  assert.equal(one.result.state, 'light', JSON.stringify(one.result));
  assert.equal(one.result.why, 'a filtered suite runner');
  const many = await syncCalls(dir, () => lock.lease('a1', { op: 'acquire', pid: 4242, createdMs: Date.now(), runner: [runner, 'ln-many'], cwd: dir }));
  assert.deepEqual(many.calls, []);
  assert.notEqual(many.result.state, 'light', `the broad filter is the suite: ${JSON.stringify(many.result)}`);
});

test('WIRING: main gives the lock the read-ahead beside its synchronous context', () => {
  const src = codeOnly(readSource('src/main/index.ts'));
  assert.ok(/classifyCtx: \(cwd\) => HookServer\.heavyScriptCtx\(cwd\),\s*classifyRead: \(run\) => HookServer\.heavyRead\(run\),/.test(src), 'src/main/index.ts must pass classifyRead to the heavy lock');
});

// ─── the read-ahead itself ──────────────────────────────────────────────────────────────────────

test('READ-AHEAD: heavyRead answers every shape exactly as the synchronous classifier does, with no synchronous fs', async () => {
  assert.equal(typeof HK.HookServer.heavyRead, 'function', 'HookServer.heavyRead must exist');
  const dir = agentDir();
  for (const [tool, command, what] of SHAPES) {
    const want = sync(dir, tool, command);
    const { calls, result } = await syncCalls(dir, () => HK.HookServer.heavyRead(() => HJ.classifyHeavy(tool, { command }, HK.HookServer.heavyScriptCtx(dir))));
    assert.deepEqual(calls, [], `${what} (${command})`);
    assert.deepEqual(result, want, `${what} (${command})`);
  }
  // Outside a read-ahead the context reads the disk itself, as its direct callers expect.
  assert.deepEqual(sync(dir, 'Bash', 'bash suite.sh'), suiteIn('suite.sh'));
});

test('READ-AHEAD: what was read ahead is gone once the run returns or throws', async () => {
  assert.equal(typeof HK.HookServer.heavyRead, 'function', 'HookServer.heavyRead must exist');
  const dir = agentDir();
  await HK.HookServer.heavyRead(() => sync(dir, 'Bash', 'bash light.sh'));
  await assert.rejects(HK.HookServer.heavyRead(() => { sync(dir, 'Bash', 'bash light.sh'); throw new Error('boom'); }), /boom/);
  // A later synchronous caller sees the file as it is now, not as it was read ahead.
  fs.writeFileSync(path.join(dir, 'light.sh'), `${NT}\n`);
  assert.deepEqual(sync(dir, 'Bash', 'bash light.sh'), suiteIn('light.sh'));
});
