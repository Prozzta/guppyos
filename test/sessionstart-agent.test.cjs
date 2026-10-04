'use strict';

/**
 * JOB-ENV / SessionStart (1.1.70, on top of SESSION-CROSSWIRE 6398caed).
 *
 * Claude Code 2.1.283 runs background jobs in one shared daemon (~/.claude/daemon.lock). The
 * daemon's env is that of the process that started it. Live on 2026-09-27 23:27:15Z, that
 * was Jim's app-launched TUI. Andy's job df0ccd91 (and two spares) therefore ran with
 * AGENT_ID=jim-mtujpe28.
 *
 * A job gets only its own `--settings <agent>/settings.json`:
 * - Every HTTP hook carries the agent in its URL, so those were right.
 * - SessionStart is a COMMAND hook (Claude does not run HTTP hooks for it), and its shim
 *   stamped env AGENT_ID. So Andy's SessionStart arrived as Jim's, and put Andy's session
 *   into Jim's hookSessionIds, which is the ownership record the crosswire guard trusts.
 *
 * Now the per-agent settings file puts the id in the command (`--agent <id>`), and the shim
 * prefers it. A disagreeing env id is logged once as a hook-identity-mismatch row.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'ssagent-'));
process.env.HOME = FAKE_HOME;
process.env.USERPROFILE = FAKE_HOME;
assert.equal(os.homedir(), FAKE_HOME, 'HOME redirect failed - aborting before touching ~/.claude');
test.after(() => fs.rmSync(FAKE_HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const loadTs = require('./load-ts.cjs');
const { HOOK_SHIM, HiveManager, hookShimArgs } = loadTs('src/main/hive.ts');
const { HookServer, applyUrlIdentity } = loadTs('src/main/hooks.ts');

const JIM = 'jim-mtujpe28';
const ANDY = 'andy-mtuk4y4x';
const ANDY_JOB = 'df0ccd91-6527-4fa7-a6c1-f8385ae9124b';

/** Run the REAL shim: argv as the settings file writes it, env as the daemon gives it. */
async function throughShim(payload, { args = [], envAgent }, t) {
  const dir = fs.mkdtempSync(path.join(FAKE_HOME, 'shim-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const shim = path.join(dir, 'cth-hook.cjs');
  fs.writeFileSync(shim, HOOK_SHIM);
  const sock = process.platform === 'win32' ? `\\\\.\\pipe\\md-ssagent-${process.pid}-${Math.random().toString(36).slice(2)}` : path.join(dir, 's.sock');
  let got = null;
  const server = net.createServer((c) => {
    let buf = '';
    c.setEncoding('utf8');
    c.on('data', (d) => { buf += d; if (buf.includes('\n')) { got = JSON.parse(buf.split('\n')[0]); c.end('{}'); } });
  });
  await new Promise((r) => server.listen(sock, r));
  const env = { ...process.env, HIVE_SOCK: sock };
  delete env.AGENT_ID;
  if (envAgent) env.AGENT_ID = envAgent;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [shim, ...args], { env, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
      child.on('error', reject);
      child.on('close', resolve);
      child.stdin.end(JSON.stringify(payload));
    });
  } finally {
    server.close();
  }
  assert.ok(got, 'the shim delivered the payload');
  return got;
}

function server() {
  const rec = { sessions: [], logs: [] };
  const hive = { sockPath: () => null, codexHomeFor: () => null, recordSession: (a, s) => rec.sessions.push([a, s]), appendLog: (r) => rec.logs.push(r), registry: () => ({ agents: {} }), isGod: () => false, rosterContext: () => '', recordModel: () => {}, appendCostLedger: () => {} };
  const control = { shouldHalt: () => false, takeSteer: () => null, toolDecision: () => ({ deny: false }) };
  const s = new HookServer(hive, () => ({ send: () => {} }), () => ({}), control);
  return { s, rec };
}

// ── the shim ────────────────────────────────────────────────────────────────────────────

test('daemon-job shape: settings say andy, env says jim -> the hook is andy\'s, and the env id is reported', async (t) => {
  const got = await throughShim({ hook_event_name: 'SessionStart', session_id: ANDY_JOB, source: 'startup' }, { args: ['--agent', ANDY], envAgent: JIM }, t);
  assert.equal(got.agent_id, ANDY);
  assert.equal(got.env_agent_id, JIM);
});

test('agreeing env: no mismatch field', async (t) => {
  const got = await throughShim({ hook_event_name: 'SessionStart', session_id: 's1' }, { args: ['--agent', ANDY], envAgent: ANDY }, t);
  assert.equal(got.agent_id, ANDY);
  assert.equal('env_agent_id' in got, false);
});

test('no --agent (an old settings file): env AGENT_ID as before', async (t) => {
  const got = await throughShim({ hook_event_name: 'SessionStart', session_id: 's1' }, { envAgent: JIM }, t);
  assert.equal(got.agent_id, JIM);
  assert.equal('env_agent_id' in got, false);
});

test('the status-line mode keeps working with --agent in front', async (t) => {
  const got = await throughShim({ context_window: { total_input_tokens: 1000, context_window_size: 200000 } }, { args: ['--agent', ANDY, '--status'], envAgent: JIM }, t);
  assert.equal(got.hook_event_name, 'Status');
  assert.equal(got.agent_id, ANDY);
});

test('a forged env_agent_id in the payload is dropped (only the shim sets it); the HTTP path strips it too', async (t) => {
  const got = await throughShim({ hook_event_name: 'SessionStart', env_agent_id: 'mallory' }, { args: ['--agent', ANDY], envAgent: ANDY }, t);
  assert.equal('env_agent_id' in got, false);
  const p = { hook_event_name: 'Stop', env_agent_id: 'mallory' };
  applyUrlIdentity(p, ANDY);
  assert.equal('env_agent_id' in p, false);
  assert.equal(p.agent_id, ANDY);
});

// ── the settings file ───────────────────────────────────────────────────────────────────

test('the per-agent settings put the id in every command hook (SessionStart always; all of them without a broker)', async (t) => {
  const harness = fs.mkdtempSync(path.join(FAKE_HOME, 'harness-'));
  const hive = new HiveManager(() => harness);
  t.after(() => hive.dispose());
  const withBroker = hive.hookSettings('C:/hive/bin/cth-hook.cjs', FAKE_HOME, {}, undefined, `http://127.0.0.1:60971/hook/${ANDY}/${'a'.repeat(32)}`, ANDY);
  const ss = withBroker.hooks.SessionStart[0].hooks[0];
  assert.equal(ss.type, 'command');
  assert.match(ss.command, new RegExp(`"C:/hive/bin/cth-hook\\.cjs" --agent ${ANDY}$`));
  const noBroker = hive.hookSettings('C:/hive/bin/cth-hook.cjs', FAKE_HOME, {}, undefined, null, ANDY);
  for (const [event, entries] of Object.entries(noBroker.hooks)) {
    for (const h of entries.flatMap((e) => e.hooks)) assert.match(h.command, new RegExp(`--agent ${ANDY}`), event);
  }
  assert.match(noBroker.statusLine.command, new RegExp(`--agent ${ANDY} --status$`));
});

test('CL-M4-BRIEFING-BUDGET C: SessionStart has a SECOND command entry, the claims briefing (--part briefing), with or without a broker', async (t) => {
  const harness = fs.mkdtempSync(path.join(FAKE_HOME, 'harness-'));
  const hive = new HiveManager(() => harness);
  t.after(() => hive.dispose());
  for (const url of [`http://127.0.0.1:60971/hook/${ANDY}/${'a'.repeat(32)}`, null]) {
    const ss = hive.hookSettings('C:/hive/bin/cth-hook.cjs', FAKE_HOME, {}, undefined, url, ANDY).hooks.SessionStart;
    assert.equal(ss.length, 2, 'two separate entries: Claude Code gives each output its own 10,000 chars');
    assert.equal(ss[0].hooks[0].type, 'command');
    assert.match(ss[0].hooks[0].command, new RegExp(`"C:/hive/bin/cth-hook\\.cjs" --agent ${ANDY}$`), 'the bundle entry, as before');
    assert.equal(ss[1].hooks.length, 1);
    assert.equal(ss[1].hooks[0].type, 'command', 'SessionStart runs no HTTP hooks');
    assert.match(ss[1].hooks[0].command, new RegExp(`"C:/hive/bin/cth-hook\\.cjs" --agent ${ANDY} --part briefing$`));
  }
});

test('CL-M4-BRIEFING-BUDGET C: the shim marks --part briefing; a payload cannot forge the mark', async (t) => {
  const brief = await throughShim({ hook_event_name: 'SessionStart', session_id: 's1', source: 'compact' }, { args: ['--agent', ANDY, '--part', 'briefing'] }, t);
  assert.equal(brief.munder_part, 'briefing');
  assert.equal(brief.agent_id, ANDY);
  const forged = await throughShim({ hook_event_name: 'SessionStart', session_id: 's1', source: 'startup', munder_part: 'briefing' }, { args: ['--agent', ANDY] }, t);
  assert.equal('munder_part' in forged, false, 'only the shim sets it');
  const other = await throughShim({ hook_event_name: 'SessionStart', session_id: 's1', source: 'startup' }, { args: ['--agent', ANDY, '--part', 'other'] }, t);
  assert.equal('munder_part' in other, false);
});

test('an id that would need quoting is never put on the command line (env fallback)', () => {
  assert.deepEqual(hookShimArgs(ANDY), ['--agent', ANDY]);
  assert.deepEqual(hookShimArgs('a b'), []);
  assert.deepEqual(hookShimArgs('x";rm'), []);
  assert.deepEqual(hookShimArgs(undefined), []);
});

// ── the hook server ─────────────────────────────────────────────────────────────────────

test('HOOKSERVER: the daemon-job SessionStart records the session for ANDY, never Jim; one mismatch row', async (t) => {
  const payload = await throughShim({ hook_event_name: 'SessionStart', session_id: ANDY_JOB, source: 'startup' }, { args: ['--agent', ANDY], envAgent: JIM }, t);
  const { s, rec } = server();
  s.handle(payload);
  s.handle({ ...payload }); // a second SessionStart (compact/clear) of the same session
  assert.deepEqual(rec.sessions, [[ANDY, ANDY_JOB], [ANDY, ANDY_JOB]]);
  const rows = rec.logs.filter((r) => r.kind === 'hook-identity-mismatch');
  assert.deepEqual(rows, [{ kind: 'hook-identity-mismatch', agentId: ANDY, envAgentId: JIM, event: 'SessionStart', sessionId: ANDY_JOB }]);
});

test('end to end with the crosswire record: Andy\'s job never lands in Jim\'s hookSessionIds', async (t) => {
  const harness = fs.mkdtempSync(path.join(FAKE_HOME, 'harness-'));
  const hive = new HiveManager(() => harness);
  t.after(() => hive.dispose());
  await hive.ensureAgent({ id: 'god', name: 'Michael', provider: 'claude', cwd: FAKE_HOME, isGod: true });
  await hive.ensureAgent({ id: JIM, name: 'Jim', provider: 'claude', cwd: FAKE_HOME });
  await hive.ensureAgent({ id: ANDY, name: 'Andy', provider: 'claude', cwd: FAKE_HOME });
  const control = { shouldHalt: () => false, takeSteer: () => null, toolDecision: () => ({ deny: false }) };
  const s = new HookServer(hive, () => ({ send: () => {} }), () => ({}), control);
  s.handle(await throughShim({ hook_event_name: 'SessionStart', session_id: ANDY_JOB, source: 'startup' }, { args: ['--agent', ANDY], envAgent: JIM }, t));
  const reg = hive.registry();
  assert.deepEqual(reg.agents[ANDY].hookSessionIds, [ANDY_JOB]);
  assert.equal(reg.agents[JIM].hookSessionIds, undefined);
  assert.equal(hive.sessionClaimedByOther(JIM, ANDY_JOB), true, 'Jim can never resume it');
});
