'use strict';
/**
 * HEAVY-LOCK-SINGLE-FILE-DENIAL-198 (Dwight 05:21Z + 05:24Z). During an exclusive bench, Dwight's
 * Codex ran `node --test test/<one>.test.cjs` and was queued as a "bench (a script the lock cannot
 * read yet)", while the denial text says single test files are not limited. The text was right; the
 * class was wrong. A Codex hook arrives over MCP with no cwd, so the lock read the test file against
 * Guppy's own folder, found nothing there, and held it as a provisional bench. The call's folder is
 * now the pending exec_command's `workdir` (relative: under the agent's folder), else the agent's
 * folder. All paths here are invented.
 *
 * Named mutants, each must fail this file:
 *   W1 the MCP hook sets no cwd (the old behaviour)
 *   W2 a relative workdir is taken as it is, not under the agent's folder
 *   W3 a call with no workdir gets no cwd (not the agent's folder)
 *   W4 pendingExecWorkdir reads `shell` instead of `workdir`
 *   W5 calls with the same cmd in different folders: the newest folder is claimed
 *   W6 the turn's cwd is ignored (the registry folder wins)
 *   W7 the agreement rule covers the folder only, not the shell
 *   W8 turnCwd reads the OLDEST turn_context
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const loadTs = require('../load-ts.cjs');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-sfd-'));
const realEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
test.after(() => { for (const [k, v] of Object.entries(realEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } fs.rmSync(JAIL, { recursive: true, force: true }); });

const { HookServer } = loadTs('src/main/hooks.ts');
const mcp = loadTs('src/main/codexHookMcp.ts');
const { HeavyJobLock } = loadTs('src/main/heavyJob.ts');

const THREAD = '01a0a169-b0e4-71f0-970a-4a8033ccaae4';
const TURN = '01a0a169-b0e4-71f0-970a-4a8033cc0001';
// A file name no checkout has, so Guppy's own folder can never answer for it.
const ONE = 'test/sfd-only-here-198.test.cjs';

/** The agent's registry folder holds ONE, and so do Codex's turn cwd, `wt` (a worktree beside them) and each `sub`. */
const AGENT = path.join(JAIL, 'agent');
const SESSION = path.join(JAIL, 'session');
const WT = path.join(JAIL, 'wt');
for (const d of [AGENT, SESSION, WT, path.join(AGENT, 'sub'), path.join(SESSION, 'sub')]) {
  fs.mkdirSync(path.join(d, 'test'), { recursive: true });
  fs.writeFileSync(path.join(d, ONE), "require('node:test')('x', () => {});\n");
}

/** The turn_context line; `cwd` undefined leaves it out. */
const turnAt = (cwd) => JSON.stringify({ timestamp: 't', type: 'turn_context', payload: cwd === undefined ? { turn_id: TURN } : { turn_id: TURN, cwd } });
const turn = turnAt(SESSION);
const call = (input) => JSON.stringify({ timestamp: 't', type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input } });
/** Codex 0.157.1's exec program: bare keys, one nested exec_command. */
const EX = (cmd, extra = '') => `const r = await tools.exec_command({cmd:${JSON.stringify(cmd)}${extra},yield_time_ms:30000}); text(r.output ?? '');`;

/** A real HookServer: Codex agent cx (folder AGENT) and Claude agent b1, one heavy slot. */
async function server(t) {
  const home = fs.mkdtempSync(path.join(JAIL, 'cx-'));
  const day = path.join(home, 'sessions', '2026', '10', '20'); fs.mkdirSync(day, { recursive: true });
  const rollout = path.join(day, `rollout-x-${THREAD}.jsonl`);
  const handled = [];
  const hive = { sockPath: () => (process.platform === 'win32' ? `\\\\.\\pipe\\sfd-${process.pid}-${Math.random().toString(36).slice(2)}` : path.join(home, 's.sock')), codexHomeFor: () => home, recordSession: () => {}, appendLog: () => {}, registry: () => ({ agents: { cx: { cwd: AGENT }, b1: { cwd: AGENT } } }), isGod: () => false, rosterContext: () => '', recordModel: () => {}, appendCostLedger: () => {} };
  const control = { shouldHalt: () => false, takeSteer: () => null, toolDecision: () => ({ deny: false }), snapshot: () => ({ gatedTools: [] }) };
  const s = new HookServer(hive, () => ({ send: () => {} }), () => ({}), control, undefined);
  const rows = [];
  const lock = new HeavyJobLock({ limit: () => 1, setTimer: () => ({}), clearTimer: () => {}, log: (r) => rows.push(r) });
  s.setHeavyLock(lock);
  const real = s.handle.bind(s); s.handle = (p) => { handled.push(JSON.parse(JSON.stringify(p))); return real(p); };
  s.start(); t.after(() => s.stop());
  for (let i = 0; i < 200 && s.hookBrokerPort() === null; i++) await new Promise((r) => setTimeout(r, 5));
  // b1 holds the only slot with a bench, as Creed's did at 05:05Z.
  const held = await s.handleWithClaimContext({ agent_id: 'b1', hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'GUPPY_BENCH=1 node bench.cjs' }, tool_use_id: 'u1', transport: 'http' });
  assert.notEqual(held?.hookSpecificOutput?.permissionDecision, 'deny', 'b1 takes the slot');
  /** One Codex PreToolUse for `program` (with the hook template's {command} when `ti` is given). */
  const pre = async (program, ti, turnLine = turn) => {
    fs.writeFileSync(rollout, [turnLine, call(program)].join('\n') + '\n');
    const ep = s.mcpEndpoint('cx');
    const args = { event: 'PreToolUse', k: ep.token };
    if (ti) args.ti = JSON.stringify({ command: ti });
    const r = await rpc(ep.url, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'hive_hook', arguments: args, _meta: { threadId: THREAD } } });
    return { out: r.body.result.structuredContent, p: handled.at(-1) };
  };
  return { pre, rows };
}
function rpc(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url); const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => { let o = ''; res.on('data', (d) => { o += d; }); res.on('end', () => resolve({ status: res.statusCode, body: o ? JSON.parse(o) : null })); });
    req.on('error', reject); req.end(data);
  });
}
const denied = (out) => out?.hookSpecificOutput?.permissionDecision === 'deny';
const slash = (x) => x.replace(/\\/g, '/');

test('Dwight\'s call: one test file in the exec_command workdir runs during another agent\'s bench (W1)', async (t) => {
  const { pre } = await server(t);
  const wd = `,workdir:${JSON.stringify(WT)}`;
  const own = await pre(EX(`node --test ${ONE}`, wd), `node --test ${ONE}`);
  assert.equal(own.p.cwd, WT, 'the hook carries the call\'s folder');
  assert.equal(denied(own.out), false, `A SINGLE TEST FILE WAS QUEUED: ${own.out?.hookSpecificOutput?.permissionDecisionReason}`);
  // The same call rebuilt from the rollout alone (a Codex without input templates).
  const rebuilt = await pre(EX(`node --test ${ONE}`, wd));
  assert.equal(rebuilt.p.cwd, WT);
  assert.equal(denied(rebuilt.out), false);
});

test('a relative workdir is under the turn\'s cwd; no workdir is the turn\'s cwd; with no turn cwd, the agent\'s folder (W2, W3, W6)', async (t) => {
  const { pre } = await server(t);
  const rel = await pre(EX(`node --test ${ONE}`, ',workdir:"sub"'), `node --test ${ONE}`);
  assert.equal(slash(rel.p.cwd), slash(path.join(SESSION, 'sub')), 'Codex\'s own turn cwd, not the registry folder (Jim NIT 2)');
  assert.equal(denied(rel.out), false);
  const none = await pre(EX(`node --test ${ONE}`), `node --test ${ONE}`);
  assert.equal(none.p.cwd, SESSION);
  assert.equal(denied(none.out), false);
  const relNoTurn = await pre(EX(`node --test ${ONE}`, ',workdir:"sub"'), `node --test ${ONE}`, turnAt(undefined));
  assert.equal(slash(relNoTurn.p.cwd), slash(path.join(AGENT, 'sub')));
  const noneNoTurn = await pre(EX(`node --test ${ONE}`), `node --test ${ONE}`, turnAt(undefined));
  assert.equal(noneNoTurn.p.cwd, AGENT);
  assert.equal(denied(noneNoTurn.out), false);
});

test('two pending calls with the same cmd in different folders: no folder is claimed, the file is held as before (W5)', async (t) => {
  const { pre } = await server(t);
  const cmd = `node --test ${ONE}`;
  const two = `await tools.exec_command({cmd:${JSON.stringify(cmd)},workdir:${JSON.stringify(WT)}}); await tools.exec_command({cmd:${JSON.stringify(cmd)},workdir:${JSON.stringify(AGENT)}});`;
  const r = await pre(two, cmd);
  assert.equal(r.p.cwd, undefined, 'ambiguous: one call\'s script could be read in the other\'s folder');
  assert.equal(denied(r.out), true, 'the old provisional bench');
  // The same folder twice is not ambiguous.
  const same = `await tools.exec_command({cmd:${JSON.stringify(cmd)},workdir:${JSON.stringify(WT)}}); await tools.exec_command({cmd:${JSON.stringify(cmd)},workdir:${JSON.stringify(WT)}});`;
  assert.equal((await pre(same, cmd)).p.cwd, WT);
});

test('the boundary stays: a test file missing from the call\'s folder is still held, and the deny row names that folder', async (t) => {
  const { pre, rows } = await server(t);
  const gone = 'test/sfd-not-written-198.test.cjs';
  const r = await pre(EX(`node --test ${gone}`, `,workdir:${JSON.stringify(WT)}`), `node --test ${gone}`);
  assert.equal(denied(r.out), true, 'an unreadable file is a provisional bench, as before');
  const row = rows.filter((x) => x.action === 'deny').at(-1);
  assert.equal(row.heavyKind, 'bench');
  assert.ok(slash(row.why).includes(`${slash(WT)}/${gone}`), row.why);
  // A real suite is held whatever the folder.
  assert.equal(denied((await pre(EX('npm test', `,workdir:${JSON.stringify(WT)}`), 'npm test')).out), true);
});

test('pendingExecWorkdir: the literal workdir of the pending call with that cmd (W4)', () => {
  const tail = (input) => [turn, call(input)].join('\n') + '\n';
  const prog = 'await tools.exec_command({cmd:"a",workdir:"C:\\\\w1",shell:"powershell"}); await tools.exec_command({cmd:"b",workdir:"D:\\\\w2"});';
  assert.equal(mcp.pendingExecWorkdir(tail(prog), 'a'), 'C:\\w1');
  assert.equal(mcp.pendingExecWorkdir(tail(prog), 'b'), 'D:\\w2');
  assert.equal(mcp.pendingExecShell(tail(prog), 'a'), 'powershell', 'the shell lookup is unchanged');
  assert.equal(mcp.pendingExecWorkdir(tail(EX('a')), 'a'), null, 'none given: the session folder');
  assert.equal(mcp.pendingExecWorkdir(tail('const w = "x"; await tools.exec_command({cmd:"a",workdir:w});'), 'a'), undefined, 'computed');
  assert.equal(mcp.pendingExecWorkdir(tail(prog), 'c'), undefined, 'no such call');
  // A plain function_call exec_command (JSON arguments).
  const fn = [turn, JSON.stringify({ timestamp: 't', type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'exec_command', arguments: JSON.stringify({ cmd: 'a', workdir: 'C:\\w3' }) } })].join('\n') + '\n';
  assert.equal(mcp.pendingExecWorkdir(fn, 'a'), 'C:\\w3');
});

test('the shell lookup takes the same rule: two pending calls with the same cmd and different shells claim none (W7)', () => {
  const tail = (input) => [turn, call(input)].join('\n') + '\n';
  const mixed = 'await tools.exec_command({cmd:"a",shell:"cmd"}); await tools.exec_command({cmd:"a",shell:"powershell"});';
  assert.equal(mcp.pendingExecShell(tail(mixed), 'a'), undefined);
  assert.equal(mcp.pendingExecShell(tail('await tools.exec_command({cmd:"a",shell:"cmd"}); await tools.exec_command({cmd:"a",shell:"cmd"});'), 'a'), 'cmd');
  assert.equal(mcp.pendingExecShell(tail('await tools.exec_command({cmd:"a",shell:"cmd"}); await tools.exec_command({cmd:"b"});'), 'a'), 'cmd', 'another cmd does not count');
});

test('turnCwd: the newest turn_context\'s cwd, null when it has none (W8)', () => {
  assert.equal(mcp.turnCwd([turnAt('C:\\old'), turnAt('C:\\new'), call('x')].join('\n')), 'C:\\new');
  assert.equal(mcp.turnCwd([turnAt('C:\\old'), turnAt(undefined)].join('\n')), null);
  assert.equal(mcp.turnCwd(call('x')), null);
});
