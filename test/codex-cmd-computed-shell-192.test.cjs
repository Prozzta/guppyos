'use strict';
/**
 * CODEX-CMD-COMPUTED-SHELL-192: a Codex exec_command whose `shell` is computed (not a literal Guppy
 * can read from the rollout) may run in cmd. cmd has no `;` separator: given the `;` join line, cmd
 * parses the WHOLE line once (carets consumed, %VAR% expanded, an escaped `>` or `|` unescaped) and
 * hands the rest to the helper, which runs it under a second cmd that parses it again. Whatever
 * Guppy sends for such a call must run in cmd exactly as the call as written does.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const C = loadTs('src/main/heavyCpu.ts');
const { HeavyJobLock } = loadTs('src/main/heavyJob.ts');
const { HookServer } = loadTs('src/main/hooks.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const CSC = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

/** A hook server whose heavy jobs go to `request` (the real helper's serve in the LIVE test). */
async function server(t, request) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-ccs-'));
  const ph = process.env.HOME; const pu = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  assert.equal(os.homedir(), home, 'HOME jailed before any hive');
  const hive = new HiveManager(() => home);
  t.after(() => { if (ph === undefined) delete process.env.HOME; else process.env.HOME = ph; if (pu === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = pu; hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  await hive.ensureAgent({ id: 'a1', name: 'a1', provider: 'codex', cwd: home });
  const control = { takeSteer: () => null, shouldHalt: () => false, toolDecision: () => ({ deny: false }) };
  const s = new HookServer(hive, () => null, () => ({ notifications: false }), control, undefined);
  s.setHeavyLock(new HeavyJobLock({ limit: () => 'off', setTimer: () => ({}), clearTimer: () => {} }));
  const logs = [];
  s.setHeavyJobs(new C.HeavyJobs({ platform: 'win32', options: () => ({ background: false, half: true }), exe: () => 'x', channel: () => ({ request, close() {} }), setInterval: () => 1, clearInterval: () => {}, log: (r) => logs.push(r), root: () => 4321 }));
  s.setHeavyAutoApproves(() => true);
  return { s, logs, hive };
}

test('LIVE cmd, computed shell: what Guppy sends runs exactly as the call as written (carets, %VAR%, an escaped redirection, an escaped pipe)',
  { skip: process.platform !== 'win32' ? 'cmd is Windows-only' : !fs.existsSync(CSC) ? `no in-box csc at ${CSC}` : false, timeout: 120_000 },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccs-cmd-'));
    let serve = null;
    try {
      const exe = path.join(dir, 'guppy-heavyjob.exe');
      const c = spawnSync(CSC, ['-nologo', '-O', `-out:${exe}`, path.join(__dirname, '..', 'resources', 'heavyjob', 'guppy-heavyjob.cs')], { encoding: 'utf8', windowsHide: true });
      assert.equal(c.status, 0, `csc: ${c.stdout}${c.stderr}`);
      // Guppy's side: the real helper's serve makes and holds each job, as begin() does.
      serve = spawn(exe, ['serve'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      const request = (line) => new Promise((r) => { serve.stdout.once('data', (d) => { try { r(JSON.parse(String(d).trim().split('\n')[0])); } catch { r(null); } }); serve.stdin.write(`${line}\n`); });
      const { s } = await server(t, request);
      const work = path.join(dir, 'work');
      fs.mkdirSync(work);
      const env = { ...process.env, PATH: `${dir};${process.env.PATH}`, HCPU_A: '%HCPU_B%', HCPU_B: 'twice' };
      const run = (line) => spawnSync(env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { cwd: work, encoding: 'utf8', env, windowsHide: true, windowsVerbatimArguments: true });
      for (const line of ['echo a^&b', 'echo %HCPU_A%', 'echo a^>b', 'echo a^|sort']) {
        const plain = run(line);
        const left = fs.readdirSync(work);
        assert.deepEqual(left, [], `the plain run made no file: ${line}`);
        const reply = await s.handleWithClaimContext({ agent_id: 'a1', hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'text(1)' }, transport: 'mcp', hook_tool_input: { command: `npm ci & ${line}` }, hook_shell_unknown: true });
        const sent = reply?.hookSpecificOutput?.updatedInput?.command ?? `npm ci & ${line}`;
        // npm ci is what makes the call heavy; only the part after it is compared (npm itself is not run).
        const effective = sent.replace(/npm ci & /, '');
        const ran = run(effective);
        assert.equal(ran.stdout, plain.stdout, `same output as the call as written: ${line} (sent: ${sent})`);
        assert.equal(ran.status, plain.status, `same exit code: ${line}`);
        assert.deepEqual(fs.readdirSync(work), [], `no file made by an unescaped redirection: ${line}`);
      }
      // A pipe: if the call is wrapped at all, the pipe's right side runs inside its job too (under the
      // `;` line the outer cmd starts it, outside the job).
      const reply = await s.handleWithClaimContext({ agent_id: 'a1', hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'text(1)' }, transport: 'mcp', hook_tool_input: { command: 'npm ci & echo x| guppy-heavyjob list ID' }, hook_shell_unknown: true });
      const sent = reply?.hookSpecificOutput?.updatedInput?.command;
      if (sent !== undefined) {
        const id = /guppy-heavyjob join (\S+)/.exec(sent)?.[1];
        assert.ok(id, `a wrapped call joins a job: ${sent}`);
        const ran = run(sent.replace(/npm ci & /, '').replace(/ ID$/, ` ${id}`));
        const rows = ran.stdout.trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
        assert.ok(rows.some((r) => /^guppy-heavyjob\.exe$/i.test(r.name)), `the pipe's right side lists itself from inside the job: ${ran.stdout}${ran.stderr}`);
      }
    } finally {
      if (serve && serve.exitCode === null && serve.signalCode === null) {
        const gone = new Promise((r) => serve.once('exit', r));
        try { serve.stdin.end(); } catch { /* gone */ }
        await gone;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

// ── what Guppy knows of the shell, and what the hook does with it ──────────────────────────

const TURN = JSON.stringify({ type: 'turn_context', payload: { turn_id: 't1' } });
const EXEC = (input) => JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input } });
const FN = (args) => JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'c2', arguments: JSON.stringify(args) } });

test('execShellFields: a literal cmd is cmd; no shell is Codex\'s default; a computed shell, or a call not found, is unknown', () => {
  const { execShellFields } = loadTs('src/main/codexHookMcp.ts');
  const f = (line) => execShellFields([TURN, line].join('\n'), 'npm ci');
  assert.deepEqual(f(EXEC('await tools.exec_command({cmd: "npm ci", shell: "cmd.exe"});')), { hook_cmd_shell: true });
  assert.deepEqual(f(EXEC('await tools.exec_command({cmd: "npm ci"});')), {}, 'Codex\'s default shell: the `;` line');
  assert.deepEqual(f(EXEC('await tools.exec_command({cmd: "npm ci", shell: "powershell"});')), {});
  assert.deepEqual(f(EXEC('await tools.exec_command({cmd: "npm ci", shell: s});')), { hook_shell_unknown: true }, 'computed');
  assert.deepEqual(f(EXEC('await tools.exec_command({cmd: c, shell: "cmd"});')), { hook_shell_unknown: true }, 'a computed cmd: the call is not found');
  assert.deepEqual(f(FN({ cmd: 'npm ci', shell: 'C:\\Windows\\System32\\cmd.exe' })), { hook_cmd_shell: true });
  assert.deepEqual(f(FN({ cmd: 'npm ci', shell: 7 })), { hook_shell_unknown: true }, 'not a string');
  assert.deepEqual(execShellFields('', 'npm ci'), { hook_shell_unknown: true }, 'no rollout');
});

test('WIRING: the MCP PreToolUse takes its shell fields from execShellFields, nothing else sets them', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'hooks.ts'), 'utf8');
  assert.equal((src.match(/execShellFields\(/g) || []).length, 1, 'called once');
  assert.match(src, /if \(ti && typeof ti\.command === 'string'\) Object\.assign\(p, execShellFields\(tail, ti\.command\)\);/);
  assert.equal((src.match(/p\.hook_cmd_shell = /g) || []).length, 0);
  assert.equal((src.match(/p\.hook_shell_unknown = /g) || []).length, 0);
});

async function fakeServer(t) {
  const sent = [];
  const request = async (line) => { sent.push(line); return { ok: true }; };
  return { ...(await server(t, request)), sent };
}
const fire = (s, extra) => s.handleWithClaimContext({ agent_id: 'a1', hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'text(1)' }, transport: 'mcp', hook_tool_input: { command: 'npm ci' }, ...extra });

test('HOOK: Codex with an unknown shell: no rewrite and no allow; the agent goes in its own job, logged (CODEX-AGY-ASKFIRST-HEAVYCPU-192)', async (t) => {
  const { s, logs, sent } = await fakeServer(t);
  const r = await fire(s, { hook_shell_unknown: true });
  assert.equal(r?.hookSpecificOutput?.updatedInput, undefined, 'the call runs as written');
  assert.equal(r?.hookSpecificOutput?.permissionDecision, undefined, 'no allow: Codex\'s own approval stays');
  assert.deepEqual(sent, ['agent a1-agent 4321', 'set a1-agent 0 1'], 'no per-call job: the agent tree goes in its own job, then the limits go on');
  assert.deepEqual(logs.filter((x) => x.action === 'attach').map((x) => [x.agentId, x.provider, x.reason]), [['a1', 'codex', 'unknown-shell']]);
  // Known shells are still wrapped, each with its own separator.
  assert.match((await fire(s, {})).hookSpecificOutput.updatedInput.command, /^guppy-heavyjob join a1-\S+ 0 1; npm ci$/);
  assert.match((await fire(s, { hook_cmd_shell: true })).hookSpecificOutput.updatedInput.command, /^guppy-heavyjob join a1-\S+ 0 1 & npm ci$/);
  assert.equal(logs.filter((x) => x.action === 'attach').length, 1);
});

test('HOOK: the unknown-shell field is Codex\'s alone: a Claude call carrying it is wrapped as before', async (t) => {
  const { s, logs, hive } = await fakeServer(t);
  await hive.ensureAgent({ id: 'c1', name: 'c1', provider: 'claude', cwd: os.tmpdir() });
  const r = await s.handleWithClaimContext({ agent_id: 'c1', hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'npm ci' }, transport: 'http', hook_shell_unknown: true });
  assert.match(r.hookSpecificOutput.updatedInput.command, /^guppy-heavyjob join c1-\S+ 0 1; npm ci$/);
  assert.equal(logs.filter((x) => x.action === 'attach').length, 0);
});
