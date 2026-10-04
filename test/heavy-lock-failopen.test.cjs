'use strict';
/**
 * HEAVY-JOB-LOCK-FAILOPEN (1.1.77, god 570978). Three defects of the heavy-job lock, plus the two
 * wrapped-suite gaps in the card's notes (Andy 42b671):
 *  (a) FAIL-OPEN: a foreground heavy call's PostToolUse released the slot whenever the one process
 *      check FAILED (a listing timeout on a loaded machine, exactly when a second heavy job hurts).
 *      Now the slot is kept (background) and the watcher decides on clean listings, or the TTL.
 *  (b) STICKY: a holder stayed "orphan-kept" while ANY descendant of its PTY created after the
 *      acquire lived (Creed's own wait-for-release loop held the slot ~5 min). Now only the heavy
 *      CALL's processes count: created inside a heavy call's window (PreToolUse..PostToolUse, plus
 *      a small slack), or descendants of those.
 *  (c) CODEX UNGUARDED: Codex 0.157.1 writes `tools.exec_command({cmd:"...",workdir:"..."})` with
 *      bare keys; the rebuild's JSON.parse refused it, so every Codex exec hook was DEGRADED and the
 *      lock let it through ('degraded', tool null). Now the literal is read (keys only relaxed); a
 *      still-degraded PreToolUse carries the pending commands for the lock alone.
 *  (+) `env ... PATH="$(... | ...)" node test/tools/run-tests.cjs` and `node clean-run.cjs node
 *      test/tools/run-tests.cjs` were classified light (the suite ran unlocked).
 *  (+) The holders in fleet.json now say how long they have held and what keeps them.
 *
 * Named mutants, each must fail this file:
 *   F1 (a) a failed check releases the slot again (the keep branch removed)
 *   F2 (b) any descendant created after the acquire keeps the slot (the window test removed)
 *   F3 (b) the call's window is never closed at its PostToolUse
 *   F4 (c) the exec argument is parsed as strict JSON again
 *   F5 (c) a degraded PreToolUse ignores the pending-command hint
 *   F6 (+) `$(...)` is not opaque to the segment splitter
 *   F7 (+) a wrapper script's command is not classified
 *   F8 (+) the snapshot loses heldMs
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HeavyJobLock, classifyCommand, HEAVY_SCAN_MS, HEAVY_CALL_SLACK_MS } = loadTs('src/main/heavyJob.ts');
const mcp = loadTs('src/main/codexHookMcp.ts');
const { HookServer } = loadTs('src/main/hooks.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const T0 = 1_000_000;
const H = { heavy: true, kind: 'suite' };
function lock(limit, extra = {}) {
  let now = T0; const logs = [];
  const l = new HeavyJobLock({ limit: () => limit, now: () => now, setTimer: () => ({}), clearTimer: () => {}, log: (r) => logs.push(r), ...extra });
  return { l, logs, tick: (ms) => { now += ms; }, at: () => now };
}
const flush = () => new Promise((r) => setImmediate(r));
/** The agent's PTY root (pid 10, long-lived) and its CLI (pid 11, long-lived). */
const BASE = [{ pid: 10, parentPid: 1, commandLine: 'pty', createdMs: 1 }, { pid: 11, parentPid: 10, commandLine: 'claude.exe', createdMs: 2 }];

test('(a) a FAILED process check at the PostToolUse keeps the slot (fail closed); clean listings then free it', async () => {
  let procs = null;   // the listing fails (a timeout under load)
  const x = lock(1, { roots: () => [{ agentId: 'a', pid: 10 }], probe: async () => procs });
  x.l.acquire('a', H, 'node --test test/*.test.cjs', 'c1', false);
  x.tick(5000);
  x.l.callDone('a', 'c1');
  await flush();
  const snap = x.l.snapshot();
  assert.equal(snap.length, 1, 'kept: a failed check proves nothing');
  assert.deepEqual([snap[0].background, snap[0].lastProbe], [true, 'failed']);
  assert.ok(x.logs.some((r) => r.action === 'probe-failed-kept'));
  assert.equal(x.l.acquire('b', H, 'npm ci', 'b1', false).allow, false, 'a second heavy job is DENIED meanwhile');
  // Still failing: nothing changes (no misses on an unknown listing).
  x.tick(HEAVY_SCAN_MS); await x.l.scan(); await x.l.scan();
  assert.equal(x.l.snapshot().length, 1);
  // The listing works again and the job is gone: two clean scans free it.
  procs = BASE;
  await x.l.scan(); x.tick(HEAVY_SCAN_MS); await x.l.scan();
  assert.equal(x.l.snapshot().length, 0);
  // HEAVY-LOCK-SELF-WAIT: the denied b was queued, so the release is followed by b's reservation.
  assert.equal(x.logs.filter((r) => r.action === 'release').at(-1).reason, 'process-exit');
  assert.equal(x.logs.at(-1).action, 'reserve');
});

test('(a) a clean check with nothing running still frees the slot at once (posttool)', async () => {
  const x = lock(1, { roots: () => [{ agentId: 'a', pid: 10 }], probe: async () => BASE });
  x.l.acquire('a', H, 'npm ci', 'c1', false);
  x.tick(5000);
  x.l.callDone('a', 'c1');
  await flush();
  assert.equal(x.l.snapshot().length, 0);
  assert.equal(x.logs.at(-1).reason, 'posttool');
});

test('(b) a process the agent starts AFTER the heavy call returned (a wait-for-release loop) never keeps the slot', async () => {
  let procs = BASE;
  const x = lock(1, { roots: () => [{ agentId: 'a', pid: 10 }], probe: async () => procs });
  x.l.acquire('a', H, 'node bench.cjs', 'c1', false);
  x.tick(60_000);
  // The agent's NEXT call (a background `while ...; sleep 5` loop) starts while the heavy call is
  // still returning; it is created after the heavy call's window closes.
  const end = x.at();
  procs = [...BASE, { pid: 20, parentPid: 11, commandLine: 'bash -c "while true; do sleep 5; done"', createdMs: end + HEAVY_CALL_SLACK_MS + 1 }, { pid: 21, parentPid: 20, commandLine: 'sleep 5', createdMs: end + HEAVY_CALL_SLACK_MS + 900 }];
  x.l.callDone('a', 'c1');
  await flush();
  assert.equal(x.l.snapshot().length, 0, 'released at posttool');
  assert.ok(!x.logs.some((r) => r.action === 'orphan-kept'));
});

test('(b) the heavy call\'s OWN processes keep the slot after it returns, children they spawn later included', async () => {
  let procs = BASE;
  const x = lock(1, { roots: () => [{ agentId: 'a', pid: 10 }], probe: async () => procs });
  x.l.acquire('a', H, 'npm ci', 'c1', false);
  const start = x.at();
  x.tick(30_000);
  // bash (in the window) -> npm (in the window) -> a node-gyp child created much later.
  procs = [...BASE,
    { pid: 30, parentPid: 11, commandLine: 'bash -c "npm ci"', createdMs: start + 100 },
    { pid: 31, parentPid: 30, commandLine: 'node npm-cli.js ci', createdMs: start + 400 },
    { pid: 32, parentPid: 31, commandLine: 'node-gyp rebuild', createdMs: start + 10 * 60_000 }];
  x.l.callDone('a', 'c1');   // the tool call timed out, the install goes on
  await flush();
  assert.equal(x.l.snapshot().length, 1);
  assert.ok(x.logs.some((r) => r.action === 'orphan-kept'));
  // Only the late child is left (its parents exited): it descends from the job, the slot stays.
  procs = [...BASE, { pid: 32, parentPid: 31, commandLine: 'node-gyp rebuild', createdMs: start + 10 * 60_000 }];
  x.tick(HEAVY_SCAN_MS); await x.l.scan(); x.tick(HEAVY_SCAN_MS); await x.l.scan();
  assert.equal(x.l.snapshot().length, 1, 'an orphan of the job stays attributed (same pid, same creation time)');
  procs = BASE;
  x.tick(HEAVY_SCAN_MS); await x.l.scan(); x.tick(HEAVY_SCAN_MS); await x.l.scan();
  assert.equal(x.l.snapshot().length, 0);
});

test('(b) a BACKGROUND heavy call: its job (started as the call returns) keeps the slot; the agent\'s later calls do not', async () => {
  let procs = BASE;
  const x = lock(1, { roots: () => [{ agentId: 'a', pid: 10 }], probe: async () => procs });
  x.l.acquire('a', H, 'node test/tools/run-tests.cjs', 'c1', true);
  x.tick(200);
  const ret = x.at();
  x.l.callDone('a', 'c1');   // a background call returns at once
  procs = [...BASE,
    { pid: 40, parentPid: 11, commandLine: 'bash', createdMs: ret - 100 },
    { pid: 41, parentPid: 40, commandLine: 'node run-tests.cjs', createdMs: ret + 500 },
    { pid: 50, parentPid: 11, commandLine: 'bash -c "tail -f log"', createdMs: ret + 120_000 }];
  x.tick(HEAVY_SCAN_MS); await x.l.scan(); x.tick(HEAVY_SCAN_MS); await x.l.scan();
  assert.equal(x.l.snapshot().length, 1, 'the suite runs');
  // The clock moves past the tail loop's creation (a window left OPEN would now cover it).
  x.tick(150_000);
  procs = [...BASE, { pid: 50, parentPid: 11, commandLine: 'bash -c "tail -f log"', createdMs: ret + 120_000 }];
  x.tick(HEAVY_SCAN_MS); await x.l.scan(); x.tick(HEAVY_SCAN_MS); await x.l.scan();
  assert.equal(x.l.snapshot().length, 0, 'the suite ended; the later tail loop does not hold the slot');
});

test('Jim H1: an UNPAIRED (degraded Codex) heavy call whose PostToolUse never comes cannot claim the agent\'s later processes', async () => {
  // Jim's probe scenario: the suite runs 3 min and exits; 10 min later the agent runs `git status`.
  let procs = BASE;
  const x = lock(1, { roots: () => [{ agentId: 'dwight', pid: 10 }], probe: async () => procs });
  x.l.acquire('dwight', H, 'node test/tools/run-tests.cjs', 'cmd:node test/tools/run-tests.cjs', true);   // unpaired = background
  const start = x.at();
  procs = [...BASE, { pid: 60, parentPid: 11, commandLine: 'pwsh -c node test/tools/run-tests.cjs', createdMs: start + 400 }, { pid: 61, parentPid: 60, commandLine: 'node run-tests.cjs', createdMs: start + 900 }];
  for (let i = 0; i < 9; i++) { x.tick(HEAVY_SCAN_MS); await x.l.scan(); }   // 3 min: running
  assert.equal(x.l.snapshot().length, 1, 'held while the suite runs');
  procs = BASE;   // the suite exited
  x.tick(10 * 60_000);
  procs = [...BASE, { pid: 70, parentPid: 11, commandLine: 'pwsh -c git status', createdMs: x.at() - 1000 }];
  for (let i = 0; i < 4; i++) { x.tick(HEAVY_SCAN_MS); await x.l.scan(); }
  assert.equal(x.l.snapshot().length, 0, 'released: the later git status is not the job (was: held to the 60-min TTL)');
  assert.equal(x.logs.at(-1).reason, 'process-exit');
});

test('Jim H1: the bound never cuts the job itself: a late child of a process started in the window still counts', async () => {
  let procs = BASE;
  const x = lock(1, { roots: () => [{ agentId: 'dwight', pid: 10 }], probe: async () => procs });
  x.l.acquire('dwight', H, 'npm ci', 'cmd:npm ci', true);
  const start = x.at();
  x.tick(20 * 60_000);
  procs = [...BASE, { pid: 80, parentPid: 11, commandLine: 'npm ci', createdMs: start + 300 }, { pid: 81, parentPid: 80, commandLine: 'node-gyp', createdMs: start + 15 * 60_000 }];
  x.tick(HEAVY_SCAN_MS); await x.l.scan(); x.tick(HEAVY_SCAN_MS); await x.l.scan();
  assert.equal(x.l.snapshot().length, 1);
});

test('(b) re-entry: each heavy call has its own window', async () => {
  const x = lock(1, { roots: () => [{ agentId: 'a', pid: 10 }], probe: async () => BASE });
  x.l.acquire('a', H, 'npm ci', 'c1', false);
  x.tick(10_000);
  x.l.acquire('a', H, 'npm run build', 'c2', false);
  x.tick(10_000);
  x.l.callDone('a', 'c1');
  await flush();
  assert.equal(x.l.snapshot().length, 1, 'c2 is still running');
  assert.equal(x.l.snapshot()[0].openCalls, 1);
});

test('(+) visibility: the snapshot (fleet.json heavyLock.holders) says how long and why a slot is held', async () => {
  const x = lock(1);
  x.l.acquire('a', H, 'npm ci', 'c1', false);
  x.tick(4 * 60_000);
  const [s] = x.l.snapshot();
  assert.equal(s.heldMs, 4 * 60_000);
  assert.deepEqual([s.agentId, s.kind, s.background, s.openCalls, s.seenRunning, s.lastProbe], ['a', 'suite', false, 1, false, null]);
  assert.equal(s.since, new Date(T0).toISOString());
  const idx = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  assert.match(idx, /heavyLock: \{ limit: heavyLimit\(readConfig\(\)\.heavyJobsAtOnce\), holders: heavyLock\.snapshot\(\), \.\.\.heavyLock\.queueSnapshot\(\) \}/, 'the snapshot rides in fleet.json');
});

test('(+) wrapped suites are heavy: PATH="$(... | ...)" prefixes and a wrapper script that runs a command', () => {
  const suite = (c) => assert.equal(classifyCommand(c).kind, 'suite', c);
  suite('cd C:/x && env -u HIVE_ROOT -u AGENT_ID PATH="$(echo "$PATH" | tr \':\' \'\\n\' | grep -viE \'Dunder/hive\' | paste -sd:)" node test/tools/run-tests.cjs > log 2>&1; echo exit $?');
  suite('X="$(cat a | head -1)" node --test test/*.test.cjs');
  suite('PATH=$(echo $PATH | tr : x) node test/tools/run-tests.cjs');   // unquoted: only $(...) opacity keeps the pipe in
  suite('env -u A PATH=$(printf %s "$PATH" | sed s/x/y/) npm test');
  suite('node C:/Dunder/_work/andy-scratch/clean-run.cjs node test/tools/run-tests.cjs');
  suite('node clean-run.cjs env -u A node test/tools/run-tests.cjs');
  assert.equal(classifyCommand('node clean-run.cjs node test/one.test.cjs').heavy, false, 'a light command through the wrapper stays light');
  suite('echo "$(node test/tools/run-tests.cjs | tail -3)"');   // a substitution RUNS its command
  suite('X=$(npm test) && echo $X');
  assert.equal(classifyCommand('echo "$(git rev-parse HEAD | cut -c1-8)"').heavy, false, 'a light substitution stays light');
  assert.equal(classifyCommand("echo '$(npm test)'").heavy, false, 'single-quoted: literal text, not run');
  assert.equal(classifyCommand('echo $((1 + 2))').heavy, false, 'arithmetic is not a substitution');
  assert.equal(classifyCommand('node script.cjs some-arg').heavy, false);
});

// — (c) Codex —

/** A Codex 0.157.1 `exec` program exactly as its rollout writes it (Dwight's rollout, 2026-10-01). */
const EX157 = (cmd) => `const r = await tools.exec_command({cmd:${JSON.stringify(cmd)},workdir:"C:\\\\Dunder\\\\_work\\\\dwight-177-reply",yield_time_ms:30000,max_output_tokens:4000}); text(r.output ?? '');`;

test('(c) the Codex 0.157.1 exec shape (bare keys) is named Bash/{command}; computed, templated or single-quoted values stay unnameable', () => {
  assert.deepEqual(mcp.normaliseCodexExec(EX157('npm ci')), { toolName: 'Bash', toolInput: { command: 'npm ci' } });
  assert.deepEqual(mcp.normaliseCodexExec(EX157('node --test --test-concurrency=1 test\\a.test.cjs; $code = $LASTEXITCODE')), { toolName: 'Bash', toolInput: { command: 'node --test --test-concurrency=1 test\\a.test.cjs; $code = $LASTEXITCODE' } });
  for (const bad of [
    'await tools.exec_command({ cmd: c });',
    "await tools.exec_command({ cmd: 'npm ci' });",
    'await tools.exec_command({ cmd: `npm ${x}` });',
    'await tools.exec_command({ cmd: "a" + "b" });'
  ]) assert.equal(mcp.normaliseCodexExec(bad), null, bad);
  assert.deepEqual(mcp.relaxedObjectLiteral('{cmd:"x",n:1,ok:true,list:["a"],o:{k:null}}'), { cmd: 'x', n: 1, ok: true, list: ['a'], o: { k: null } });
  assert.deepEqual(mcp.relaxedObjectLiteral('{"cmd":"a:b{c}","w":"x,y:z"}'), { cmd: 'a:b{c}', w: 'x,y:z' }, 'colons and braces inside strings are data');
});

const TURN = '01a0f798-0000-7000-8000-000000000001';
const line = (type, payload) => JSON.stringify({ timestamp: '2026-10-01T13:00:00.000Z', type, payload });
const L = {
  turnContext: (t) => line('turn_context', { turn_id: t }),
  call: (id, name, input) => line('response_item', { type: 'custom_tool_call', name, call_id: id, input }),
  out: (id) => line('response_item', { type: 'custom_tool_call_output', call_id: id, output: 'ok' })
};

test('(c) rebuildToolHook names a pending 0.157.1 exec (was DEGRADED); pendingExecCommands reads what a still-degraded call will run', () => {
  const one = [L.turnContext(TURN), L.call('c1', 'exec', EX157('npm ci'))].join('\n');
  const r = mcp.rebuildToolHook(one, 'PreToolUse');
  assert.deepEqual([r.degraded, r.toolName, r.toolInput], [false, 'Bash', { command: 'npm ci' }]);
  // Two nested commands: the hook stays DEGRADED (no honest single name), the hint has both.
  const two = EX157('echo a') + '\n' + EX157('node test/tools/run-tests.cjs');
  const tail = [L.turnContext(TURN), L.call('c1', 'exec', two)].join('\n');
  assert.equal(mcp.rebuildToolHook(tail, 'PreToolUse').degraded, true);
  assert.deepEqual(mcp.pendingExecCommands(tail), { commands: ['echo a', 'node test/tools/run-tests.cjs'], complete: true, unnamed: 0 });
  // Only the current turn's PENDING calls: answered ones and older turns are not.
  const old = [L.turnContext('old'), L.call('c0', 'exec', EX157('npm ci')), L.turnContext(TURN), L.call('c1', 'exec', EX157('echo a')), L.out('c1')].join('\n');
  assert.deepEqual(mcp.pendingExecCommands(old), { commands: [], complete: true, unnamed: 0 });
  assert.equal(mcp.pendingExecCommands([L.turnContext(TURN), L.call('c1', 'exec', 'await tools.exec_command({ cmd: c });')].join('\n')).complete, false);
});

async function server(t, limit) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-heavyfo-'));
  const ph = process.env.HOME; const pu = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  assert.equal(os.homedir(), home, 'HOME jailed before any hive');
  const hive = new HiveManager(() => home);
  t.after(() => { if (ph === undefined) delete process.env.HOME; else process.env.HOME = ph; if (pu === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = pu; hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  for (const id of ['a1', 'a2']) await hive.ensureAgent({ id, name: id, provider: 'claude', cwd: home });
  const control = { takeSteer: () => null, shouldHalt: () => false, toolDecision: () => ({ deny: false }) };
  const s = new HookServer(hive, () => null, () => ({ notifications: false }), control, undefined);
  const l = new HeavyJobLock({ limit: () => limit, setTimer: () => ({}), clearTimer: () => {} });
  s.setHeavyLock(l);
  return { s, l, hive };
}

test('(c) HOOK: a DEGRADED Codex PreToolUse whose pending commands include a heavy one takes the slot (another agent is denied); light hints are allowed', async (t) => {
  const { s, l, hive } = await server(t, 1);
  const light = s.handle({ agent_id: 'a1', hook_event_name: 'PreToolUse', tool_name: undefined, payload_degraded: true, transport: 'mcp', codex_commands: ['echo a', 'git status'] });
  assert.equal(light.hookSpecificOutput?.permissionDecision, undefined);
  assert.equal(l.snapshot().length, 0, 'light: no slot');
  const heavy = s.handle({ agent_id: 'a1', hook_event_name: 'PreToolUse', payload_degraded: true, transport: 'mcp', codex_commands: ['echo a', 'node test/tools/run-tests.cjs'] });
  assert.equal(heavy.hookSpecificOutput?.permissionDecision, undefined, 'a1 takes the slot');
  assert.deepEqual([l.snapshot()[0].agentId, l.snapshot()[0].command, l.snapshot()[0].background], ['a1', 'node test/tools/run-tests.cjs', true]);
  const denied = s.handle({ agent_id: 'a2', hook_event_name: 'PreToolUse', payload_degraded: true, transport: 'mcp', codex_commands: ['npm ci'] });
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  const log = fs.readFileSync(path.join(hive.root(), 'log.jsonl'), 'utf8');
  assert.match(log, /"action":"degraded","agentId":"a1","tool":null,"hinted":2,"heavy":true/);
});

test('(c) wiring: the MCP route attaches the pending-command hint to a degraded PreToolUse only', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'hooks.ts'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(src, /if \(rebuilt\.degraded && event === 'PreToolUse' && tail\) \{\n\s+const hint = pendingExecCommands\(tail\);\n\s+if \(hint\.commands\.length\) p\.codex_commands = hint\.commands;/);
});
