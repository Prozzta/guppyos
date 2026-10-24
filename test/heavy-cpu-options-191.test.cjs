'use strict';
/**
 * HEAVY-CPU-OPTIONS-191: Settings, beside "Heavy jobs at once", two independent options for heavy jobs:
 * background CPU priority (BELOW_NORMAL) and a hard 50% CPU-rate cap with all processors visible.
 * Every allowed heavy PreToolUse is rewritten to `guppy-heavyjob join <job> <b> <h>; <command>`, after
 * Guppy made the job with the options in force; Settings changes reach running jobs; a job with nothing
 * of its call left is lifted and let go. The live proof (every process of a real FULL) is in
 * agents/creed-mukyiphw/heavycpu; the helper itself under a real job is in heavy-cpu-harness-191.
 *
 * Named mutants, each must fail this file:
 *   M1 the wrap ignores option 2 (always 0)
 *   M2 a denied heavy call is still wrapped (the wrap set before the lock decides, and withHeavyJob's deny guard off)
 *   M3 Codex's reply lacks permissionDecision 'allow' (Codex drops the rewrite)
 *   M4 Claude's reply carries permissionDecision 'allow' (skips Claude's own permission prompt)
 *   M5 the AGY shim does not translate updatedInput (AGY runs the call unwrapped)
 *   M6 AGY's CommandLine is not read (its heavy calls are never classified)
 *   M7 the lift lets go of a job that still has a process of its call
 *   M8 a Settings change does not reach running jobs
 *   M9 a job whose call has not started yet is let go as done (a later Settings change misses it)
 *   M10 a Codex call that asked for cmd gets the `;` line (the helper re-parses it: carets and %VAR% change)
 *   M11 a shell named by a const is not read (a const cmd gets the `;` line, unlike a literal one)
 *   M12 a const that is not provably one string is read anyway (shadowed, reassigned, a parameter)
 *   M13 the helper's second cmd re-parses the `;` line's rest (carets lost, %VAR% expanded twice)
 * test/tools/heavy-cpu-shell-mutants.cjs runs M11-M13 and more.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const C = loadTs('src/main/heavyCpu.ts');
const HJ = loadTs('src/main/heavyJob.ts');
const M = loadTs('src/main/codexHookMcp.ts');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('the options: each independent; the hard cap defaults to exactly 50% (M1)', () => {
  assert.deepEqual(C.heavyCpuOptions({}), { background: false, cap: true });
  assert.deepEqual(C.heavyCpuOptions({ heavyJobsBackgroundPriority: true }), { background: true, cap: true });
  assert.deepEqual(C.heavyCpuOptions({ heavyJobsCpuCap: false }), { background: false, cap: false });
  assert.deepEqual(C.heavyCpuOptions({ heavyJobsBackgroundPriority: true, heavyJobsCpuCap: false }), { background: true, cap: false });
  assert.equal(C.HEAVY_CPU_CAP_RATE, 5000, 'CPU-rate units are 1/100 percent of the whole machine');
});

test('the join line goes before the command, verbatim; command (Claude, Codex) and CommandLine (AGY)', () => {
  const o = { background: true, cap: false };
  assert.deepEqual(C.wrapToolInput({ command: 'npm ci', description: 'x' }, 'j1', o), { command: 'guppy-heavyjob join j1 1 0; npm ci', description: 'x' });
  assert.deepEqual(C.wrapToolInput({ CommandLine: 'npm run build', Cwd: 'C:/w' }, 'j2', { background: false, cap: true }), { CommandLine: 'guppy-heavyjob join j2 0 1; npm run build', Cwd: 'C:/w' });
  assert.equal(C.wrapToolInput({ file_path: 'x' }, 'j', o), null);
  assert.equal(C.wrapToolInput('npm ci', 'j', o), null);
  assert.match(C.heavyJobId('creed-mukyiphw', 3, 1e12), /^creed-mukyiphw-[a-z0-9]+-3$/);
  assert.match(C.heavyJobId('a b/c', 1, 0), /^[A-Za-z0-9_-]+$/);
});

test('the native helper pins hard-cap mode and the exact 50% CPU rate (M1)', () => {
  const native = read('resources/heavyjob/guppy-heavyjob.cs');
  assert.match(native, /CPU_RATE_ENABLE = 0x1, CPU_RATE_HARD_CAP = 0x4, CPU_RATE_50_PERCENT = 5000/);
  assert.match(native, /ControlFlags = cap \? CPU_RATE_ENABLE \| CPU_RATE_HARD_CAP : 0/);
  assert.match(native, /if \(!cap && !CpuRateEnabled\(job\)\) return;/, 'M9: fresh cap-off jobs skip invalid class-15 zero flags; a live cap-off still clears it');
  assert.match(native, /GUPPY_HEAVY_CPU_CAP.*cap \? "1" : "0"/, 'the joined command can size workers to the Job Object CPU share');
  assert.match(native, /self-query/, 'a joined Bash or PowerShell command can query its own Job Object rate');
  assert.match(native, /IsProcessInJob\(proc, job, out inJob\)/, 'a marker is trusted only while its process remains in the named job');
  assert.match(native, /created == 0 \|\| created > childCreated/, 'ancestor walk rejects a parent created after its child');
  assert.match(native, /MarkerRoot\(\).*?heavyjob-markers/s, 'breadcrumbs stay in a Guppy-owned folder');
  assert.match(native, /SpecialFolder\.LocalApplicationData/, 'a caller TEMP jail never owns marker cleanup');
  assert.match(native, /CleanMarkers\(\)/, 'dead pid+creation-time breadcrumbs are cleaned');
  assert.match(native, /if \(inJob \|\| \(Created\(child\) == childCreated && job != IntPtr\.Zero\)\) return name;/, 'reading a live shell marker never consumes it');
  assert.match(native, /var rate = new CPU_RATE \{ ControlFlags = cap \? CPU_RATE_ENABLE \| CPU_RATE_HARD_CAP : 0, CpuRate = cap \? CPU_RATE_50_PERCENT : 0 \}/);
  assert.doesNotMatch(native, /LIMIT_AFFINITY|SetProcessAffinityMask/);
  assert.match(native, /return \"\{\\\"background\\\":\" \+ \(background \? \"true\" : \"false\"\) \+ \",\\\"cap\\\":\" \+ \(cap \? \"true\" : \"false\"\) \+ \",\\\"rate\\\":\" \+ \(cap \? CPU_RATE_50_PERCENT : 0\) \+ \",\\\"affinity\\\":null\}\"/,
    'M1: capped queries must explicitly report no affinity limit');
  assert.match(native, /unsupported outer job; cap not applied \(ERROR_ACCESS_DENIED\)/,
    'an outer-job access denial is loud and distinguishable from an ordinary helper error');
  assert.match(native, /static bool OuterJobDenial\(Exception e\) \{ return e\.Message == \"AssignProcessToJobObject failed \(5\)\"; \}/,
    'only a failed assignment to Guppy\'s own job is classified as an unsupported outer job');
});

test('M6: AGY run_command CommandLine is read, so its heavy calls are classified', () => {
  assert.equal(HJ.commandFromToolInput({ CommandLine: 'npm ci' }), 'npm ci');
  assert.equal(HJ.classifyHeavy('run_command', { CommandLine: 'npm ci' }).heavy, true);
});

/** A fake helper: answers like `guppy-heavyjob serve`, records every request. */
function fakeChannel(rows = {}) {
  const sent = [];
  return {
    sent,
    rows,
    channel: () => ({
      request: async (line) => {
        sent.push(line);
        const [op, id] = line.split(' ');
        if (op === 'list') return { ok: true, rows: rows[id] ?? [] };
        return { ok: true };
      },
      close() {}
    })
  };
}

function jobs(opts, f, now) {
  const timers = [];
  const logs = [];
  const j = new C.HeavyJobs({
    platform: 'win32', options: () => opts.o, exe: () => 'C:/x/guppy-heavyjob.exe', channel: f.channel,
    now: () => now.t, setInterval: (fn) => { timers.push(fn); return timers.length; }, clearInterval: () => {}, log: (r) => logs.push(r)
  });
  return { j, logs, timers };
}

test('HeavyJobs: the job is made with the options in force, then the call is rewritten (M1)', async () => {
  const f = fakeChannel(); const now = { t: 1000 }; const opts = { o: { background: false, cap: true } };
  const { j, logs } = jobs(opts, f, now);
  const w = await j.begin('creed', { command: 'npm ci' });
  const id = j.ids()[0];
  assert.deepEqual(f.sent, [`create ${id} 0 1`]);
  assert.equal(w.command, `guppy-heavyjob join ${id} 0 1; npm ci`);
  assert.equal(logs[0].action, 'wrap');
  // Elsewhere nothing is wrapped; without the helper nothing is wrapped.
  assert.equal(await new C.HeavyJobs({ platform: 'linux', options: () => opts.o, exe: () => 'x', channel: f.channel }).begin('a', { command: 'npm ci' }), null);
  assert.equal(await new C.HeavyJobs({ platform: 'win32', options: () => opts.o, exe: () => null, channel: f.channel }).begin('a', { command: 'npm ci' }), null);
});

test('HeavyJobs: a Settings change reaches every running job (M8)', async () => {
  const f = fakeChannel(); const now = { t: 1000 }; const opts = { o: { background: false, cap: false } };
  const { j } = jobs(opts, f, now);
  await j.begin('a', { command: 'npm ci' }); await j.begin('b', { command: 'npm run build' });
  opts.o = { background: true, cap: true };
  await j.applyLive();
  assert.deepEqual(f.sent.filter((l) => l.startsWith('set')), j.ids().map((id) => `set ${id} 1 1`));
});

test('HeavyJobs: a job whose processes all predate its call (a shell that outlived it) is lifted after two checks; one still running its call is kept (M7)', async () => {
  const f = fakeChannel(); const now = { t: 10_000 }; const opts = { o: { background: true, cap: true } };
  const { j, logs } = jobs(opts, f, now);
  await j.begin('a', { command: 'npm ci' });
  const id = j.ids()[0];
  f.rows[id] = [{ pid: 1, name: 'bash', createdMs: 9_000 }, { pid: 2, name: 'node', createdMs: 10_500 }];
  await j.poll(); await j.poll(); await j.poll();
  assert.deepEqual(j.ids(), [id], 'its own node is still running: kept');
  f.rows[id] = [{ pid: 1, name: 'bash', createdMs: 9_000 }];
  await j.poll();
  assert.deepEqual(j.ids(), [id], 'one check is not enough');
  await j.poll();
  assert.deepEqual(j.ids(), []);
  assert.ok(f.sent.includes(`set ${id} 0 0`), 'the limits are lifted from the shell that stays');
  assert.equal(f.sent.at(-1), `close ${id}`);
  assert.equal(logs.at(-1).action, 'lifted');
  // A process created just before the call started (clock skew) is still the call's own.
  await j.begin('b', { command: 'npm ci' });
  const id2 = j.ids()[0];
  f.rows[id2] = [{ pid: 3, name: 'cmd', createdMs: now.t - C.HEAVY_JOB_START_SKEW_MS + 1 }];
  await j.poll(); await j.poll();
  assert.deepEqual(j.ids(), [id2]);
  f.rows[id2] = [];
  await j.poll(); await j.poll();
  assert.deepEqual(j.ids(), []);
  assert.equal(logs.at(-1).action, 'done');
});

test('HeavyJobs: a job whose call has not started yet (a prompt, a wait for the slot) is kept, and a Settings change still reaches it (M9)', async () => {
  const f = fakeChannel(); const now = { t: 10_000 }; const opts = { o: { background: false, cap: false } };
  const { j, logs } = jobs(opts, f, now);
  await j.begin('a', { command: 'node test/tools/run-tests.cjs' });
  const id = j.ids()[0];
  for (let i = 0; i < 5; i++) { now.t += C.HEAVY_JOB_POLL_MS; await j.poll(); }
  assert.deepEqual(j.ids(), [id], 'empty since it was made: the call has not started, so it is kept');
  opts.o = { background: true, cap: true };
  await j.applyLive();
  assert.equal(f.sent.at(-1), `set ${id} 1 1`, 'the change reaches the job before its call starts');
  f.rows[id] = [{ pid: 7, name: 'bash', createdMs: now.t }];
  await j.poll();
  f.rows[id] = [];
  await j.poll(); await j.poll();
  assert.deepEqual(j.ids(), [], 'started, then empty on two checks: done');
  assert.equal(logs.at(-1).action, 'done');
  // A call that never ran (denied at its prompt) is let go after HEAVY_JOB_UNSTARTED_MS.
  await j.begin('b', { command: 'npm ci' });
  const id2 = j.ids()[0];
  now.t += C.HEAVY_JOB_UNSTARTED_MS - 1;
  await j.poll(); await j.poll();
  assert.deepEqual(j.ids(), [id2]);
  now.t += 1;
  await j.poll();
  assert.deepEqual(j.ids(), []);
  assert.equal(f.sent.at(-1), `close ${id2}`);
  assert.equal(logs.at(-1).action, 'never-started');
});

// ── the hook boundary ────────────────────────────────────────────────────────────────────

const { HookServer } = loadTs('src/main/hooks.ts');
const { HiveManager, AGY_HOOK_SHIM } = loadTs('src/main/hive.ts');
const { HeavyJobLock } = HJ;

async function server(t, limit, o) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hcpu-'));
  const ph = process.env.HOME; const pu = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  assert.equal(os.homedir(), home, 'HOME jailed before any hive');
  const hive = new HiveManager(() => home);
  t.after(() => { if (ph === undefined) delete process.env.HOME; else process.env.HOME = ph; if (pu === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = pu; hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  for (const id of ['a1', 'a2']) await hive.ensureAgent({ id, name: id, provider: 'claude', cwd: home });
  const control = { takeSteer: () => null, shouldHalt: () => false, toolDecision: () => ({ deny: false }) };
  const s = new HookServer(hive, () => null, () => ({ notifications: false }), control, undefined);
  s.setHeavyLock(new HeavyJobLock({ limit: () => limit, setTimer: () => ({}), clearTimer: () => {} }));
  const f = fakeChannel();
  const logs = [];
  s.setHeavyJobs(new C.HeavyJobs({ platform: 'win32', options: () => o, exe: () => 'x', channel: f.channel, setInterval: () => 1, clearInterval: () => {}, log: (r) => logs.push(r) }));
  const fire = (agent_id, command, extra = {}) => s.handleWithClaimContext({ agent_id, hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command }, ...extra });
  return { s, f, fire, hive, logs };
}

test('HOOK: an allowed heavy call is rewritten for each provider; a light one and a denied one are not (M2, M3, M4)', async (t) => {
  const { f, fire } = await server(t, 1, { background: true, cap: true });
  const claude = await fire('a1', 'npm ci', { transport: 'http', tool_use_id: 'u1' });
  assert.match(claude.hookSpecificOutput.updatedInput.command, /^guppy-heavyjob join a1-[a-z0-9]+-1 1 1; npm ci$/);
  assert.equal(claude.hookSpecificOutput.permissionDecision, undefined, 'Claude applies the rewrite as it is; its own permission check stays');
  assert.equal(claude.hookSpecificOutput.hookEventName, 'PreToolUse');
  const denied = await fire('a2', 'npm run build', { transport: 'http' });
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(denied.hookSpecificOutput.updatedInput, undefined, 'a denied call never runs: no job');
  assert.equal(f.sent.length, 1);
  const light = await fire('a2', 'git status', { transport: 'http' });
  assert.equal(light?.hookSpecificOutput?.updatedInput, undefined);
  assert.equal(f.sent.length, 1);
  // Codex: the rollout shows the outer exec script; the hook template carries the nested command.
  const codex = await fire('a2', 'const r = await tools.exec_command({cmd:"git status"});', { transport: 'mcp', tool_name: 'Bash', hook_tool_input: { command: 'npm ci' } });
  assert.equal(codex.hookSpecificOutput.permissionDecision, 'deny', 'the lock reads the nested command too: a1 holds the slot');
  assert.equal(codex.hookSpecificOutput.updatedInput, undefined);
});

test('HOOK: Codex that asks its user first: no rewrite and no allow, so its approval prompt stays; the same call auto-approved is wrapped (Jim SHOULD-2)', async (t) => {
  const { s, f, fire, hive, logs } = await server(t, 'off', { background: false, cap: true });
  const asks = await fire('a1', 'text(1)', { transport: 'mcp', tool_name: 'Bash', hook_tool_input: { command: 'npm ci' } });
  assert.deepEqual(logs.filter((r) => r.action === 'skip-ask-first'), [{ kind: 'heavy-cpu', action: 'skip-ask-first', agentId: 'a1', provider: 'claude' }], 'the declined call is logged with its agent and provider (Jim SHOULD-1 a)');
  assert.equal(asks?.hookSpecificOutput?.permissionDecision, undefined, 'no allow for an agent that asks');
  assert.equal(asks?.hookSpecificOutput?.updatedInput, undefined);
  assert.equal(f.sent.length, 0, 'no job made for a call that is not rewritten');
  s.setHeavyAutoApproves((id) => id === 'a1');
  const auto = await fire('a1', 'text(1)', { transport: 'mcp', tool_name: 'Bash', hook_tool_input: { command: 'npm ci' } });
  assert.equal(auto.hookSpecificOutput.permissionDecision, 'allow');
  assert.match(auto.hookSpecificOutput.updatedInput.command, /^guppy-heavyjob join a1-\S+ 0 1; npm ci$/);
  // Claude (http) needs no allow: wrapped whatever its approval mode.
  const claude = await fire('a2', 'npm ci', { transport: 'http' });
  assert.match(claude.hookSpecificOutput.updatedInput.command, /^guppy-heavyjob join a2-\S+ 0 1; npm ci$/);
  assert.equal(claude.hookSpecificOutput.permissionDecision, undefined);
  // AGY's rewrite is an allow too: only for an agent that auto-approves.
  await hive.ensureAgent({ id: 'g1', name: 'g1', provider: 'antigravity', cwd: os.tmpdir() });
  const agy = await fire('g1', 'npm ci', { transport: 'http' });
  assert.equal(agy?.hookSpecificOutput?.updatedInput, undefined, 'an AGY agent that asks is not rewritten');
  assert.deepEqual(logs.filter((r) => r.action === 'skip-ask-first').map((r) => [r.agentId, r.provider]), [['a1', 'claude'], ['g1', 'antigravity']], 'only the declined calls are logged');
  s.setHeavyAutoApproves((id) => id === 'a1' || id === 'g1');
  const agyAuto = await fire('g1', 'npm ci', { transport: 'http' });
  assert.match(agyAuto.hookSpecificOutput.updatedInput.command, /^guppy-heavyjob join g1-\S+ 0 1; npm ci$/);
});

test('approvesWithoutAsking: the provider\'s own auto-approve flag, every token of it', () => {
  const { approvesWithoutAsking } = C;
  assert.equal(approvesWithoutAsking('codex', ['codex', '--dangerously-bypass-approvals-and-sandbox']), true);
  assert.equal(approvesWithoutAsking('codex', ['codex', '-a', 'on-request']), false);
  assert.equal(approvesWithoutAsking('antigravity', ['agy', '--dangerously-skip-permissions']), true);
  assert.equal(approvesWithoutAsking('antigravity', ['agy']), false);
  assert.equal(approvesWithoutAsking('claude', ['claude', '--permission-mode', 'bypassPermissions']), true);
  assert.equal(approvesWithoutAsking('claude', ['claude', '--permission-mode', 'default']), false);
});

test('HOOK: Codex with the lock Off: the nested command from the hook template is wrapped, with allow; a cmd call gets the cmd separator (M3, M10)', async (t) => {
  const { s, fire } = await server(t, 'off', { background: false, cap: true });
  s.setHeavyAutoApproves(() => true);
  const r = await fire('a1', 'text(1)', { transport: 'mcp', tool_name: 'Bash', hook_tool_input: { command: 'node test/tools/run-tests.cjs' } });
  assert.equal(r.hookSpecificOutput.permissionDecision, 'allow', 'Codex drops updatedInput without allow');
  assert.match(r.hookSpecificOutput.updatedInput.command, /^guppy-heavyjob join a1-\S+ 0 1; node test\/tools\/run-tests\.cjs$/);
  const light = await fire('a1', 'text(1)', { transport: 'mcp', tool_name: 'Bash', hook_tool_input: { command: 'git log' } });
  assert.equal(light?.hookSpecificOutput?.updatedInput, undefined);
  // A call that asked for cmd gets cmd's own separator (M10); hook_cmd_shell without the template is ignored.
  const cmd = await fire('a1', 'text(1)', { transport: 'mcp', tool_name: 'Bash', hook_tool_input: { command: 'npm ci' }, hook_cmd_shell: true });
  assert.match(cmd.hookSpecificOutput.updatedInput.command, /^guppy-heavyjob join a1-\S+ 0 1 & npm ci$/);
  const claude = await fire('a2', 'npm ci', { transport: 'http', hook_cmd_shell: true });
  assert.match(claude.hookSpecificOutput.updatedInput.command, /^guppy-heavyjob join a2-\S+ 0 1; npm ci$/);
});

test('HOOK: with no tool-use id (AGY, some Codex paths) the PostToolUse of a wrapped call releases its slot (Jim SHOULD-1)', async (t) => {
  const { s, fire } = await server(t, 1, { background: false, cap: true });
  const pre = await fire('a1', 'npm ci', { transport: 'http' });
  const wrapped = pre.hookSpecificOutput.updatedInput.command;
  assert.match(wrapped, /^guppy-heavyjob join a1-\S+ 0 1; npm ci$/);
  assert.equal((await fire('a2', 'npm run build', { transport: 'http' })).hookSpecificOutput.permissionDecision, 'deny', 'a1 holds the slot');
  // The Post carries the command as it ran: the rewritten one.
  await s.handleWithClaimContext({ agent_id: 'a1', hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: wrapped }, transport: 'http' });
  const next = await fire('a2', 'npm run build', { transport: 'http' });
  assert.notEqual(next?.hookSpecificOutput?.permissionDecision, 'deny', 'the slot was released by the Post');
  assert.match(next.hookSpecificOutput.updatedInput.command, /^guppy-heavyjob join a2-\S+ 0 1; npm run build$/);
  const { withoutJoinLine } = C;
  assert.equal(withoutJoinLine('guppy-heavyjob join a1-x_y-1 1 0 & npm ci'), 'npm ci');
  assert.equal(withoutJoinLine('npm ci; guppy-heavyjob join a1 1 0; x'), 'npm ci; guppy-heavyjob join a1 1 0; x', 'only a leading join line');
});

test('Codex cmd: the pending exec_command\'s literal shell is read from the rollout; only cmd takes `&` (M10)', () => {
  const { pendingExecShell, isCmdShell } = loadTs('src/main/codexHookMcp.ts');
  const turn = JSON.stringify({ type: 'turn_context', payload: { turn_id: 't1' } });
  const exec = (input) => JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input } });
  const fn = (args) => JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'c2', arguments: JSON.stringify(args) } });
  assert.equal(pendingExecShell([turn, exec('await tools.exec_command({cmd: "npm ci", shell: "cmd.exe"});')].join('\n'), 'npm ci'), 'cmd.exe');
  assert.equal(pendingExecShell([turn, exec('await tools.exec_command({cmd: "npm ci"});')].join('\n'), 'npm ci'), null, 'no shell: Codex\'s default');
  assert.equal(pendingExecShell([turn, exec('await tools.exec_command({cmd: "npm ci", shell: s});')].join('\n'), 'npm ci'), undefined, 'computed: unknown');
  assert.equal(pendingExecShell([turn, exec('await tools.exec_command({cmd: "git status", shell: "cmd"});')].join('\n'), 'npm ci'), undefined, 'another call');
  assert.equal(pendingExecShell([turn, fn({ cmd: 'npm ci', shell: 'C:\\Windows\\System32\\cmd.exe' })].join('\n'), 'npm ci'), 'C:\\Windows\\System32\\cmd.exe');
  for (const s of ['cmd', 'CMD.EXE', 'C:\\Windows\\System32\\cmd.exe', 'C:/Windows/System32/cmd.exe']) assert.equal(isCmdShell(s), true, s);
  for (const s of [null, undefined, 'powershell', 'pwsh.exe', 'bash', 'C:\\tools\\mycmd.exe']) assert.equal(isCmdShell(s), false, String(s));
});

test('CODEX-CMD-COMPUTED-SHELL-192: a shell named by a const of one string reads as that string, so it gets cmd\'s `&` line like a literal (M11, M12)', () => {
  const { pendingExecShell } = loadTs('src/main/codexHookMcp.ts');
  const turn = JSON.stringify({ type: 'turn_context', payload: { turn_id: 't1' } });
  const exec = (input) => JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input } });
  const shellOf = (program) => pendingExecShell([turn, exec(program)].join('\n'), 'npm ci');
  // Provable: one const, read only as a call's shell.
  for (const [program, want] of [
    ['const sh = "cmd.exe";\nawait tools.exec_command({cmd: "npm ci", shell: sh});', 'cmd.exe'],
    ["const shell = 'cmd'\nawait tools.exec_command({ cmd: 'npm ci', shell });", 'cmd'],
    ['const sh = "cmd"\ninput = 1;\nawait tools.exec_command({cmd: "npm ci", shell: sh});', 'cmd'],
    ['const SH = `C:\\\\Windows\\\\System32\\\\cmd.exe`, x = 1;\nawait tools.exec_command({shell: SH, cmd: "npm ci"});', 'C:\\Windows\\System32\\cmd.exe'],
    ['const sh = "cmd"; // a comment naming sh\nconst o = { sh: 1 }; o.sh;\nawait tools.exec_command({cmd: "npm ci", shell: sh});', 'cmd'],
    ['const sh = "pwsh";\nawait tools.exec_command({cmd: "npm ci", shell: sh});', 'pwsh'],
  ]) assert.equal(shellOf(program), want, program);
  // Not provable: unknown (the `;` line, which the helper now runs once-parsed).
  for (const program of [
    'let sh = "cmd";\nawait tools.exec_command({cmd: "npm ci", shell: sh});',
    'const sh = "cmd";\n{ const sh = "pwsh"; await tools.exec_command({cmd: "npm ci", shell: sh}); }',
    'const sh = "cmd";\nconst f = (sh) => tools.exec_command({cmd: "npm ci", shell: sh}); await f("pwsh");',
    'const sh = "cmd";\nconsole.log(sh);\nawait tools.exec_command({cmd: "npm ci", shell: sh});',
    'const sh = "cmd";\nconst t = `${sh = 1}`;\nawait tools.exec_command({cmd: "npm ci", shell: sh});',
    'const sh = "cm" + "d";\nawait tools.exec_command({cmd: "npm ci", shell: sh});',
    'const sh = "cmd"\n  + ".exe";\nawait tools.exec_command({cmd: "npm ci", shell: sh});',
    'const sh = "cmd"\ninstanceof Object;\nawait tools.exec_command({cmd: "npm ci", shell: sh});',
    'const sh = "cmd"\n  in o;\nawait tools.exec_command({cmd: "npm ci", shell: sh});',
    'const sh = `${"cmd"}`;\nawait tools.exec_command({cmd: "npm ci", shell: sh});',
    'const sh = pick();\nawait tools.exec_command({cmd: "npm ci", shell: sh});',
    'const sh = "cmd";\nawait tools.exec_command({cmd: "npm ci", shell: sh ? sh : "pwsh"});',
    'await tools.exec_command({cmd: "npm ci", shell: sh});',
    'const sh = "cmd";\nconst t = "pwsh";\nawait tools.exec_command({cmd: "npm ci", shell: sh, shell: t});',
    'const sh = "cmd";\nfoo({x: sh});\nawait tools.exec_command({cmd: "npm ci", shell: sh});',
  ]) assert.equal(shellOf(program), undefined, program);
  // Parity: hooks.ts marks hook_cmd_shell from isCmdShell(pendingExecShell(...)) (source pin, M10),
  // and a marked call gets the `&` line (the HOOK test above): the const and the literal read alike.
  assert.equal(shellOf('const sh = "cmd";\nawait tools.exec_command({cmd: "npm ci", shell: sh});'), shellOf('await tools.exec_command({cmd: "npm ci", shell: "cmd"});'));
});

const CSC =path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

test('LIVE Bash join keeps its marker for repeated, sibling and background self-queries without TEMP residue (B1)',
  { skip: process.platform !== 'win32' || !fs.existsSync(path.join(__dirname, '..', 'resources', 'heavyjob', 'bin', 'guppy-heavyjob.exe')) ? 'Windows helper not built' : false, timeout: 30_000 },
  async () => {
    const { spawn, spawnSync } = require('node:child_process');
    const exe = path.join(__dirname, '..', 'resources', 'heavyjob', 'bin', 'guppy-heavyjob.exe');
    const bash = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
    if (!fs.existsSync(bash)) return;
    const id = `hcpu-b1-${process.pid}`;
    const quote = (s) => `'${s.replace(/'/g, "'\\\"'\\\"'")}'`;
    const expected = { background: false, cap: true, rate: 5000, affinity: null };
    const serve = spawn(exe, ['serve'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let buffer = ''; const replies = [];
    serve.stdout.setEncoding('utf8');
    serve.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (/"event"/.test(line)) continue;
        const resolve = replies.shift(); if (resolve) resolve(JSON.parse(line));
      }
    });
    const ask = (line) => new Promise((resolve) => { replies.push(resolve); serve.stdin.write(`${line}\n`); });
    const assertQueries = async (line, count) => {
      const name = `${id}-${count}`;
      assert.deepEqual(await ask(`create ${name} 0 1`), { ok: true });
      try {
        const r = spawnSync(bash, ['-lc', `${quote(exe)} join ${name} 0 1; ${line}`], { encoding: 'utf8', windowsHide: true });
        assert.equal(r.status, 0, r.stderr);
        const rows = r.stdout.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
        assert.equal(rows.length, count, r.stdout);
        for (const row of rows) assert.deepEqual(row, expected, r.stderr);
      } finally { assert.deepEqual(await ask(`close ${name}`), { ok: true }); }
    };
    try {
      // The same shell, two separately spawned Node processes, and a background command all find
      // the still-live shell marker.  A marker is lifetime state, not a one-shot query token.
      await assertQueries(`${quote(exe)} self-query; ${quote(exe)} self-query; ${quote(exe)} self-query`, 3);
      const nodeExe = exe.replace(/\\/g, '/');
      const nodeQuery = `${quote(process.execPath)} -e ${quote(`process.stdout.write(require("node:child_process").execFileSync(${JSON.stringify(nodeExe)}, ["self-query"], {encoding:"utf8"}))`)}`;
      await assertQueries(`${nodeQuery}; ${nodeQuery}`, 2);
      await assertQueries(`${quote(exe)} self-query; ${quote(exe)} self-query & wait`, 2);
      const root = path.join(process.env.TEMP || os.tmpdir(), 'guppy-heavyjob-markers');
      assert.ok(!fs.existsSync(root), 'marker bookkeeping never leaves a caller TEMP directory');
    } finally {
      try { serve.stdin.end(); } catch { /* gone */ }
      if (serve.exitCode === null) await new Promise((resolve) => serve.once('exit', resolve));
    }
  });

test('LIVE cmd: the `&` join line leaves the command exactly as cmd runs it (output and exit code), and its processes are in the job',
  { skip: process.platform !== 'win32' ? 'cmd is Windows-only' : !fs.existsSync(CSC) ? `no in-box csc at ${CSC}` : false, timeout: 120_000 },
  async () => {
    const { spawnSync, spawn } = require('node:child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcpu-cmd-'));
    const serve = { child: null };
    try {
      const exe = path.join(dir, 'guppy-heavyjob.exe');
      const c = spawnSync(CSC, ['-nologo', '-O', `-out:${exe}`, path.join(__dirname, '..', 'resources', 'heavyjob', 'guppy-heavyjob.cs')], { encoding: 'utf8', windowsHide: true });
      assert.equal(c.status, 0, `csc: ${c.stdout}${c.stderr}`);
      const env = { ...process.env, PATH: `${dir};${process.env.PATH}`, HCPU_V: 'v^1', HCPU_OUTER: '%HCPU_INNER%', HCPU_INNER: 'expanded-twice' };
      const id = `hcpu-cmd-${process.pid}`;
      // Guppy's side: the job is made and held by serve, as begin() does.
      serve.child = spawn(exe, ['serve'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      const created = await new Promise((r) => { serve.child.stdout.once('data', (d) => r(String(d))); serve.child.stdin.write(`create ${id} 0 1\n`); });
      assert.match(created, /"ok":true/);
      const run = (line) => spawnSync(env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { cwd: dir, encoding: 'utf8', env, windowsHide: true, windowsVerbatimArguments: true }); // a re-parsed `^>` writes here, not in the repo
      // Carets, a variable (expanded once), quotes, a second command, a pipe, a trailing space, the exit code.
      for (const line of ['echo a^&b %HCPU_V% "q^x" & echo second', 'echo x| findstr x', 'echo t ', 'echo 7 & exit /b 7']) {
        const plain = run(line);
        const joined = run(joinLineFor(id) + line);
        assert.equal(joined.stdout, plain.stdout, line);
        assert.equal(joined.status, plain.status, line);
        assert.doesNotMatch(joined.stderr, /limits not applied/, joined.stderr);
      }
      // CODEX-CMD-COMPUTED-SHELL-192 (M13): a shell Guppy cannot know gets the `;` line, and under
      // cmd the helper re-runs what cmd handed it. That second cmd must change nothing: carets,
      // a variable whose value names another (expanded once), escaped operators, quotes, a
      // percent, redirection, a pipe, chains, a block, the exit code, all as plain cmd gives them.
      for (const line of ['echo a^&b %HCPU_V% "q^x" & echo second', 'echo %HCPU_OUTER%', 'echo "a^b" c^^d', 'echo a^|b ^> c ^< d',
        'echo ^"a^&b', 'echo 50% done', 'echo r> NUL & echo after', 'echo x| findstr x', 'echo a && echo b || echo c',
        'if 1==1 (echo yes) else (echo no)', 'for %f in (1 2) do @echo %f', 'echo 7 & exit /b 7',
        'node -e "process.stdout.write(process.argv.slice(1).join(String.fromCharCode(124)))" a "b c" d^e "%HCPU_OUTER%"']) {
        const plain = run(line);
        const joined = run(C.joinLine(id, { background: false, cap: true }, false) + line);
        assert.equal(joined.stdout, plain.stdout, `; ${line}`);
        assert.equal(joined.status, plain.status, `; ${line}`);
        assert.doesNotMatch(joined.stderr, /limits not applied/, joined.stderr);
      }
      // The known limit of the `;` line: a block holding an operator, `(a & b)`, is split by the outer
      // cmd before the helper runs. Only a shell Guppy knows is cmd gets the `&` line that keeps it.
      // The command's processes run inside the job: it lists itself from inside.
      const inside = run(joinLineFor(id) + `guppy-heavyjob list ${id}`);
      const rows = inside.stdout.trim().split(/\r?\n/).map((l) => JSON.parse(l)); // one JSON line per process
      assert.ok(rows.some((r) => /^cmd\.exe$/i.test(r.name)), `cmd is in the job: ${inside.stdout}`);
      const usable = rows[0]?.cpus;
      assert.ok(Number.isInteger(usable) && usable > 0 && rows.every((r) => r.cpus === usable), `CPU-rate control leaves the process's actually usable processors available: ${inside.stdout}`);
      // A shell with its own console: its conhost.exe started with it, before the join line, and joins too.
      // (Start-Process makes a new console; without -Wait, which would put the shell in a job of its own.)
      const ownFile = path.join(dir, 'own.txt');
      const ps = `$p = Start-Process -FilePath $env:ComSpec -ArgumentList '/d /s /c "${joinLineFor(id)}guppy-heavyjob list ${id}"' -WindowStyle Hidden -RedirectStandardOutput '${ownFile}' -PassThru; $p.WaitForExit(); exit $p.ExitCode`;
      const ps1 = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', env: require('./tools/ps-env.cjs').psEnv(env), windowsHide: true });
      assert.equal(ps1.status, 0, ps1.stderr);
      const ownOut = fs.readFileSync(ownFile, 'utf8');
      const ownRows = ownOut.trim().split(/\r?\n/).map((l) => JSON.parse(l));
      assert.ok(ownRows.some((r) => /^conhost\.exe$/i.test(r.name)), `the shell's console host is in the job: ${ownOut}`);
    } finally {
      try { serve.child?.stdin.end(); } catch { /* gone */ }
      await new Promise((r) => (serve.child && serve.child.exitCode === null ? serve.child.once('exit', r) : r()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

function joinLineFor(id) { return C.joinLine(id, { background: false, cap: true }, true); }

test('Codex hook config: PreToolUse carries ${tool_input}; an unfilled or bad template is ignored', () => {
  const toml = M.codexMcpHookToml('http://127.0.0.1:1/mcp/a/x', 'ab'.repeat(16));
  assert.match(toml.hook('PreToolUse'), /input = \{ event = "PreToolUse", k = "[0-9a-f]{32}", ti = "\$\{tool_input\}" \}/);
  assert.doesNotMatch(toml.hook('PostToolUse'), /tool_input/);
  assert.deepEqual(M.templatedToolInput('{"command":"npm ci"}'), { command: 'npm ci' });
  assert.deepEqual(M.templatedToolInput({ command: 'npm ci' }), { command: 'npm ci' });
  assert.equal(M.templatedToolInput('${tool_input}'), undefined);
  assert.equal(M.templatedToolInput('not json'), undefined);
  assert.equal(M.templatedToolInput(undefined), undefined);
  assert.match(read('src/main/hooks.ts'), /const ti = event === 'PreToolUse' \? templatedToolInput\(args\.ti\) : undefined;\s+if \(ti\) p\.hook_tool_input = ti;/);
});

/** Run the REAL AGY shim against a fake hook server that answers `reply`; resolve its stdout. */
function shimOut(reply) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hcpu-shim-'));
    const shim = path.join(dir, 'agy-hook.cjs'); fs.writeFileSync(shim, AGY_HOOK_SHIM);
    const sock = process.platform === 'win32' ? `\\\\.\\pipe\\hcpu-shim-${process.pid}-${Math.random().toString(36).slice(2)}` : path.join(dir, 's.sock');
    const srv = net.createServer((c) => { let b = ''; c.on('data', (d) => { b += d; if (b.includes('\n')) c.end(JSON.stringify(reply)); }); });
    srv.listen(sock, () => {
      const ch = spawn(process.execPath, [shim, 'PreToolUse'], { env: { ...process.env, AGENT_ID: 'a1', HIVE_SOCK: sock, HIVE_HOOK_TOKEN: 'ab'.repeat(16) }, stdio: ['pipe', 'pipe', 'ignore'] });
      let out = '';
      ch.stdout.on('data', (d) => { out += d; });
      ch.on('error', reject);
      ch.on('close', () => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); resolve(out); });
      ch.stdin.end(JSON.stringify({ conversationId: 'c', toolCall: { name: 'run_command', args: { CommandLine: 'npm ci' } } }));
    });
  });
}

test('AGY shim: a rewrite becomes AGY\'s allow + overwrite, context rides along; a plain allow still prints nothing (M5)', async () => {
  const updatedInput = { CommandLine: 'guppy-heavyjob join j 1 0; npm ci', Cwd: 'C:/w' };
  assert.deepEqual(JSON.parse(await shimOut({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput } })), { decision: 'allow', overwrite: updatedInput });
  assert.deepEqual(JSON.parse(await shimOut({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput, additionalContext: 'mail' } })), { decision: 'allow', overwrite: updatedInput, systemMessage: 'mail' });
  assert.equal(await shimOut({}), '', 'no output = allow (any object is a decision to AGY)');
  assert.equal(JSON.parse(await shimOut({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'no' } })).decision, 'deny');
});

test('WIRING: the default 50% cap, migration, Settings row and live apply are connected (M1/M8)', () => {
  assert.match(read('src/main/hooks.ts'), /if \(ti && tail && typeof ti\.command === 'string' && isCmdShell\(pendingExecShell\(tail, ti\.command\)\)\) p\.hook_cmd_shell = true;/, 'a Codex call that asked for cmd is marked from its rollout (M10)');
  const cfg = read('src/main/config.ts');
  assert.match(cfg, /heavyJobsBackgroundPriority\?: boolean;/);
  assert.match(cfg, /heavyJobsCpuCap\?: boolean;/);
  assert.match(cfg, /heavyJobsBackgroundPriority: false,\s+heavyJobsCpuCap: true,/);
  assert.match(cfg, /migrateHeavyJobsCpuCap/);
  assert.match(cfg, /next\.heavyJobsHalfCores === true/, 'M7: only an explicit legacy ON may carry into the new default-on cap');
  const ui = read('src/renderer/src/components/SettingsModal.tsx');
  const at = ui.indexOf('Heavy jobs at once\n') >= 0 ? ui.indexOf('Heavy jobs at once\n') : ui.indexOf('Heavy jobs at once\r\n');
  assert.ok(at > 0 && ui.indexOf('Heavy jobs at background priority') > at && ui.indexOf('Heavy jobs CPU cap') > at, 'the two rows follow "Heavy jobs at once"');
  assert.match(ui, /updateConfig\(\{ heavyJobsBackgroundPriority: next \}/);
  assert.match(ui, /updateConfig\(\{ heavyJobsCpuCap: next \}/);
  const note = ui.indexOf('Codex and Antigravity agents that ask before running commands are not limited.');
  assert.ok(note > ui.indexOf('Heavy jobs CPU cap'), 'the ask-first exemption is said under the two toggles (Jim SHOULD-1 b)');
  const idx = read('src/main/index.ts');
  assert.match(idx, /hookServer\.setHeavyJobs\(heavyJobs\);/);
  assert.match(idx, /options: \(\) => heavyCpuOptions\(readConfig\(\)\)/, 'read live');
  assert.match(idx, /'heavyJobsBackgroundPriority' in patch \|\| 'heavyJobsCpuCap' in patch\)\) void heavyJobs\.applyLive\(\)/);
  assert.match(idx, /if \(heavyJobExe\(\)\) opts\.pathPrepend = \[\.\.\.\(opts\.pathPrepend \?\? \[\]\), heavyJobDir\(\)\];/);
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts.build, /node tools\/build-heavyjob\.cjs/);
  assert.match(read('electron-builder.yml'), /- from: resources\/heavyjob\/bin\s+to: heavyjob/);
  assert.match(read('.gitignore'), /^resources\/heavyjob\/bin\/$/m, 'never a committed .exe');
});

test('SPAWN: every agent spawn goes through spawnAgentCore, which clears the auto-approve record before its PTY starts (Jim NIT2)', () => {
  const idx = read('src/main/index.ts').replace(/\r\n/g, '\n');
  const core = idx.indexOf('async function spawnAgentCore(');
  const end = idx.indexOf('\n}\n', core);
  assert.ok(core > 0 && end > core);
  // The only PTY starts in main are inside spawnAgentCore (the agent CLI, and the missing-CLI installer).
  const starts = [...idx.matchAll(/ptyManager\.spawn\(/g)].map((m) => m.index);
  assert.equal(starts.length, 2);
  for (const at of starts) {
    assert.ok(at > core && at < end, 'a PTY start outside spawnAgentCore would skip the auto-approve record');
    const before = idx.slice(at - 600, at);
    const cleared = before.lastIndexOf('if (opts.hive?.id) heavyAutoApprove.delete(opts.hive.id);');
    assert.ok(cleared >= 0, 'cleared before the PTY starts');
    assert.doesNotMatch(before.slice(cleared).replace(/const res = await $/, ''), /\bawait\b|\breturn\b/, 'nothing between the clear and the PTY start can wait or leave');
  }
  assert.match(idx.slice(core, end), /const res = await ptyManager\.spawn\(opts, owner\);\s+if \(res\.ok && opts\.hive\?\.id\) heavyAutoApprove\.set\(/, 'set only when the spawn succeeded');
  // Restart & Continue, wake respawn and model switch are renderer spawns: all through pty:spawn into spawnAgentCore.
  assert.match(idx, /ipcMain\.handle\('pty:spawn'[\s\S]{0,900}?return spawnAgentCore\(opts, owner\);/);
  assert.equal([...read('src/preload/index.ts').matchAll(/ipcRenderer\.invoke\('pty:spawn'/g)].length, 1, 'the renderer reaches a PTY only through pty:spawn');
});
