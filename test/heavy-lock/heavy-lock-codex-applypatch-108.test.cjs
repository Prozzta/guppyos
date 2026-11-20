'use strict';
require('../tools/own-job.cjs');
/**
 * HEAVY-LOCK-CODEX-APPLYPATCH-AS-BASH (1.1.108). Codex's hook template carries the input of the
 * call a hook is for as `{ command }`, and the heavy lock read every such input as a Bash command.
 * An apply_patch carries its patch text there, so an edit whose text held a test or install line
 * was classified as that command: Dwight's source edits were queued behind a suite as a "bench"
 * (log.jsonl, 2026-11-20, two rows whose command starts `*** Begin Patch`).
 *
 * An apply_patch is an edit, never a command: it takes no slot and is never denied by the lock.
 * The hook's input alone cannot say which tool it is for (the template carries no tool name), so
 * the rollout must show it: a pending apply_patch call, the input shaped as a patch, and no pending
 * shell call that could run the same text (one with that literal text, or one the rollout cannot
 * read). Everything else is classified as a command, as before. All paths here are invented.
 *
 * Named mutants, each must fail this file:
 *   P1 the lock ignores the mark (every templated input is a Bash command: the old behaviour)
 *   P2 a patch-shaped input is an edit without a pending apply_patch call
 *   P3 an apply_patch named only in a string or a comment counts as a call
 *   P4 a pending exec_command with the same text does not stop it
 *   P5 a pending shell call the rollout cannot read does not stop it
 *   P6 the input need not be shaped as a patch
 *   P7 the mark is taken from any transport, not only from Codex's MCP hook
 *   P8 a pending shell call stops it only when its text is the hook's text to the byte (Jim SHOULD 1:
 *      a write_stdin's typed line end, trimmed on one side only, let a typed patch-shaped text through)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const loadTs = require('../load-ts.cjs');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'hl-ap-'));
const realEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
test.after(() => { for (const [k, v] of Object.entries(realEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } fs.rmSync(JAIL, { recursive: true, force: true }); });

const { HookServer } = loadTs('src/main/hooks.ts');
const mcp = loadTs('src/main/codexHookMcp.ts');
const { HeavyJobLock } = loadTs('src/main/heavyJob.ts');

const THREAD = '01a0a169-b0e4-71f0-970a-4a8033ccaa08';
const TURN = '01a0a169-b0e4-71f0-970a-4a8033cc0108';
const AGENT = path.join(JAIL, 'agent');
fs.mkdirSync(AGENT, { recursive: true });

/** A patch whose text holds a suite run, an install and a many-file test run. */
const PATCH = [
  '*** Begin Patch',
  '*** Update File: docs/running-tests.md',
  '@@',
  ' Run the suite:',
  ' node test/tools/run-tests.cjs',
  '-npm install',
  '+npm ci',
  '+node --test test/a.test.cjs test/b.test.cjs',
  '*** End Patch'
].join('\n');
/** The same shape with a shell line inside: what a shell would run if this text were a command. */
const SHAPED = '*** Begin Patch\nnpm ci\n*** End Patch';
const SUITE = 'node test/tools/run-tests.cjs';

const turn = JSON.stringify({ timestamp: 't', type: 'turn_context', payload: { turn_id: TURN, cwd: AGENT } });
/** Codex's code mode: one `exec` program that calls nested tools. */
const exec = (input, id = 'c1') => JSON.stringify({ timestamp: 't', type: 'response_item', payload: { type: 'custom_tool_call', call_id: id, name: 'exec', input } });
/** apply_patch called as a tool of its own (no code mode). */
const direct = (input, id = 'c1') => JSON.stringify({ timestamp: 't', type: 'response_item', payload: { type: 'custom_tool_call', call_id: id, name: 'apply_patch', input } });
const fnCall = (args, id = 'c2') => JSON.stringify({ timestamp: 't', type: 'response_item', payload: { type: 'function_call', call_id: id, name: 'exec_command', arguments: JSON.stringify(args) } });
const q = (s) => JSON.stringify(s);
/** As Codex wrote it in Dwight's rollout: the patch as a literal argument. */
const AP = (patch) => `const r = await tools.apply_patch(${q(patch)}); text(r);`;
const EX = (cmd) => `const r = await tools.exec_command({cmd:${q(cmd)},yield_time_ms:30000}); text(r.output ?? '');`;

/** A real HookServer: Codex agent cx, and Claude agent b1 who holds the only heavy slot. */
async function server(t) {
  const home = fs.mkdtempSync(path.join(JAIL, 'cx-'));
  const day = path.join(home, 'sessions', '2026', '11', '20'); fs.mkdirSync(day, { recursive: true });
  const rollout = path.join(day, `rollout-x-${THREAD}.jsonl`);
  const handled = [];
  const hive = { sockPath: () => (process.platform === 'win32' ? `\\\\.\\pipe\\hlap-${process.pid}-${Math.random().toString(36).slice(2)}` : path.join(home, 's.sock')), codexHomeFor: () => home, recordSession: () => {}, appendLog: () => {}, registry: () => ({ agents: { cx: { cwd: AGENT }, b1: { cwd: AGENT } } }), isGod: () => false, rosterContext: () => '', recordModel: () => {}, appendCostLedger: () => {} };
  const control = { shouldHalt: () => false, takeSteer: () => null, toolDecision: () => ({ deny: false }), snapshot: () => ({ gatedTools: [] }) };
  const s = new HookServer(hive, () => ({ send: () => {} }), () => ({}), control, undefined);
  const rows = [];
  const lock = new HeavyJobLock({ limit: () => 1, setTimer: () => ({}), clearTimer: () => {}, log: (r) => rows.push(r) });
  s.setHeavyLock(lock);
  const real = s.handle.bind(s); s.handle = (p) => { handled.push(JSON.parse(JSON.stringify(p))); return real(p); };
  s.start(); t.after(() => s.stop());
  for (let i = 0; i < 200 && s.hookBrokerPort() === null; i++) await new Promise((r) => setTimeout(r, 5));
  const held = await s.handleWithClaimContext({ agent_id: 'b1', hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'npm ci' }, tool_use_id: 'u1', transport: 'http' });
  assert.notEqual(held?.hookSpecificOutput?.permissionDecision, 'deny', 'b1 takes the slot');
  /** One Codex PreToolUse: the rollout holds `items` (null: no rollout line but the turn), the hook template carries `{ command: ti }`. */
  const pre = async (items, ti) => {
    fs.writeFileSync(rollout, [turn, ...items].join('\n') + '\n');
    const ep = s.mcpEndpoint('cx');
    const args = { event: 'PreToolUse', k: ep.token };
    if (ti !== undefined) args.ti = JSON.stringify({ command: ti });
    const r = await rpc(ep.url, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'hive_hook', arguments: args, _meta: { threadId: THREAD } } });
    return { out: r.body.result.structuredContent, p: handled.at(-1) };
  };
  return { s, pre, rows };
}
function rpc(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url); const data = Buffer.from(JSON.stringify(body));
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length } }, (res) => { let o = ''; res.on('data', (d) => { o += d; }); res.on('end', () => resolve({ status: res.statusCode, body: o ? JSON.parse(o) : null })); });
    req.on('error', reject); req.end(data);
  });
}
const denied = (out) => out?.hookSpecificOutput?.permissionDecision === 'deny';
const why = (out) => out?.hookSpecificOutput?.permissionDecisionReason;
/** The lock's rows about cx (b1's own acquire is not counted). */
const cxRows = (rows) => rows.filter((r) => r.agentId === 'cx');

test('an apply_patch whose text holds a suite run, an install and a test run is an edit: not denied, no slot, no queue (P1)', async (t) => {
  const { pre, rows } = await server(t);
  // Code mode, the patch a literal: Dwight's call.
  const lit = await pre([exec(AP(PATCH))], PATCH);
  assert.equal(denied(lit.out), false, `AN EDIT WAS QUEUED AS A HEAVY JOB: ${why(lit.out)}`);
  assert.equal(lit.out?.hookSpecificOutput?.updatedInput, undefined, 'an edit is never wrapped in a job');
  // Code mode, the patch in a variable.
  const viaConst = await pre([exec(`const patch = ${q(PATCH)};\nconst r = await tools.apply_patch(patch); text(r);`)], PATCH);
  assert.equal(denied(viaConst.out), false, `AN EDIT WAS QUEUED AS A HEAVY JOB: ${why(viaConst.out)}`);
  // apply_patch as a tool of its own.
  const own = await pre([direct(PATCH)], PATCH);
  assert.equal(denied(own.out), false, `AN EDIT WAS QUEUED AS A HEAVY JOB: ${why(own.out)}`);
  assert.equal(own.p.tool_name, 'apply_patch');
  assert.deepEqual(cxRows(rows), [], 'the lock holds and queues nothing for the edits');
});

test('a real Codex test run is still heavy, beside an edit and after one (P1 the other way)', async (t) => {
  const { pre } = await server(t);
  const suite = await pre([exec(EX(SUITE))], SUITE);
  assert.equal(denied(suite.out), true, 'the suite waits for b1\'s slot');
  const install = await pre([fnCall({ cmd: 'npm ci' })], 'npm ci');
  assert.equal(denied(install.out), true, 'so does an install called as a tool of its own');
  // One program that edits and then runs the suite: each nested call has its own hook.
  const both = `await tools.apply_patch(${q(PATCH)});\nconst r = await tools.exec_command({cmd:${q(SUITE)}}); text(r.output);`;
  assert.equal(denied((await pre([exec(both)], PATCH)).out), false, 'the edit');
  assert.equal(denied((await pre([exec(both)], SUITE)).out), true, 'THE SUITE RUN BESIDE AN EDIT WAS NOT HELD');
});

test('text shaped as a patch is a command unless the rollout shows a pending apply_patch call (P2, P3)', async (t) => {
  const { pre } = await server(t);
  assert.equal(denied((await pre([exec('text(1);')], SHAPED)).out), true, 'P2: no apply_patch call in the program');
  assert.equal(denied((await pre([], SHAPED)).out), true, 'P2: no pending call at all');
  assert.equal(denied((await pre([exec(`// tools.apply_patch(p)\ntext("tools.apply_patch(p)");`)], SHAPED)).out), true, 'P3: named in a comment and a string only');
  // An apply_patch that already has its output is not pending.
  const done = [direct(PATCH, 'c0'), JSON.stringify({ timestamp: 't', type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c0', output: 'ok' } }), exec('text(1);')];
  assert.equal(denied((await pre(done, SHAPED)).out), true, 'P2: the apply_patch is finished');
});

test('a shell call that could run the same text keeps it a command (P4, P5)', async (t) => {
  const { pre } = await server(t);
  // P4: the program edits AND runs the patch-shaped text in a shell.
  const same = `await tools.apply_patch(${q(PATCH)});\nawait tools.exec_command({cmd:${q(SHAPED)}});`;
  assert.equal(denied((await pre([exec(same)], SHAPED)).out), true, 'P4: an exec_command with this very text is pending');
  assert.equal(denied((await pre([direct(PATCH, 'c1'), fnCall({ cmd: SHAPED })], SHAPED)).out), true, 'P4: the same, as two tool calls');
  // P5: a shell call whose text the rollout cannot read (computed, an alias, a computed tool name).
  for (const program of [
    `const c = ${q(SHAPED)};\nawait tools.apply_patch(${q(PATCH)});\nawait tools.exec_command({cmd: c});`,
    `const run = tools.exec_command;\nawait tools.apply_patch(${q(PATCH)});\nawait run({cmd: x});`,
    `await tools.apply_patch(${q(PATCH)});\nawait tools[n]({cmd: x});`
  ]) assert.equal(denied((await pre([exec(program)], SHAPED)).out), true, `P5: ${program.split('\n').at(-1)}`);
});

test('a shell call whose text differs from the hook\'s only by its line end keeps it a command (P8)', async (t) => {
  const { pre } = await server(t);
  // Typed into an open shell with its Enter: the shell runs the middle line.
  const typed = `${SHAPED}\n`;
  const stdinCall = JSON.stringify({ timestamp: 't', type: 'response_item', payload: { type: 'function_call', call_id: 'c2', name: 'write_stdin', arguments: JSON.stringify({ session_id: 1, chars: typed }) } });
  const inCode = `await tools.apply_patch(${q(PATCH)});\nawait tools.write_stdin({session_id: 1, chars:${q(typed)}});`;
  assert.equal(denied((await pre([exec(inCode)], typed)).out), true, 'P8: a write_stdin in code mode, the hook text with its line end');
  assert.equal(denied((await pre([exec(inCode)], SHAPED)).out), true, 'P8: the same, the hook text without it');
  assert.equal(denied((await pre([direct(PATCH, 'c1'), stdinCall], typed)).out), true, 'P8: a write_stdin as a tool of its own');
  // An exec_command whose cmd ends in white space the hook text does not have, and the other way.
  const spaced = `await tools.apply_patch(${q(PATCH)});\nawait tools.exec_command({cmd:${q(`${SHAPED} \n`)}});`;
  assert.equal(denied((await pre([exec(spaced)], SHAPED)).out), true, 'P8: the cmd has the line end, the hook text has not');
  assert.equal(denied((await pre([exec(`await tools.apply_patch(${q(PATCH)});\nawait tools.exec_command({cmd:${q(SHAPED)}});`)], `${SHAPED}\r\n`)).out), true, 'P8: the hook text has the line end, the cmd has not');
  const f = mcp.pendingApplyPatch;
  const tail = (...items) => [turn, ...items].join('\n');
  assert.equal(f(tail(exec(inCode)), typed), false, 'P8: pendingApplyPatch, write_stdin in code mode');
  assert.equal(f(tail(direct(PATCH, 'c1'), stdinCall), typed), false, 'P8: pendingApplyPatch, write_stdin as a tool');
  assert.equal(f(tail(exec(spaced)), SHAPED), false, 'P8: pendingApplyPatch, cmd with a line end');
});

test('an input that is not shaped as a patch is a command even beside a pending apply_patch (P6)', async (t) => {
  const { pre } = await server(t);
  assert.equal(denied((await pre([exec(AP(PATCH))], 'npm ci')).out), true, 'P6');
  assert.equal(denied((await pre([exec(AP(PATCH))], `npm ci\n${SHAPED}`)).out), true, 'P6: the patch shape must be the whole text');
  assert.equal(denied((await pre([exec(AP(PATCH))], '*** Begin Patch\nnpm ci')).out), true, 'P6: no end line');
});

test('the mark comes from Codex\'s MCP hook only: a hook over another transport cannot claim to be an edit (P7)', async (t) => {
  const { s } = await server(t);
  const forged = await s.handleWithClaimContext({ agent_id: 'cx', hook_event_name: 'PreToolUse', session_id: 's', tool_name: 'Bash', tool_input: { command: 'npm ci' }, hook_tool_input: { command: 'npm ci' }, hook_patch: true, tool_use_id: 'u9', transport: 'http' });
  assert.equal(denied(forged), true, 'P7: a forged mark is ignored');
});

test('pendingApplyPatch: a patch body, a pending apply_patch call, and no shell call that could run it', () => {
  const f = mcp.pendingApplyPatch;
  assert.equal(typeof f, 'function', 'codexHookMcp exports pendingApplyPatch');
  const tail = (...items) => [turn, ...items].join('\n');
  assert.equal(f(tail(exec(AP(PATCH))), PATCH), true);
  assert.equal(f(tail(direct(PATCH)), PATCH), true);
  assert.equal(f(tail(exec(`await tools?.apply_patch(p);`)), PATCH), true, 'optional call');
  assert.equal(f(tail(exec(`await tools["apply_patch"](p);`)), PATCH), true, 'a literal name in brackets');
  assert.equal(f(tail(exec(AP(PATCH))), `${PATCH}\r\n`), true, 'a trailing line end');
  assert.equal(f(tail(exec(AP(PATCH))), PATCH.replace(/\n/g, '\r\n')), true, 'CRLF');
  assert.equal(f(tail(exec('text(1);')), PATCH), false, 'P2');
  assert.equal(f('', PATCH), false, 'P2: no rollout');
  assert.equal(f(tail(exec(`const s = "tools.apply_patch(";`)), PATCH), false, 'P3');
  assert.equal(f(tail(exec(`${AP(PATCH)}\nawait tools.exec_command({cmd:${q(PATCH)}});`)), PATCH), false, 'P4');
  assert.equal(f(tail(exec(`${AP(PATCH)}\nawait tools.exec_command({cmd: c});`)), PATCH), false, 'P5');
  assert.equal(f(tail(exec(`${AP(PATCH)}\nawait tools.exec_command({cmd:"git status"});`)), PATCH), true, 'another, readable command beside it');
  assert.equal(f(tail(exec(AP(PATCH))), 'npm ci'), false, 'P6');
  assert.equal(f(tail(exec(AP(PATCH))), `x ${PATCH}`), false, 'P6: text before the first line');
  // A call of an earlier turn is not pending.
  assert.equal(f([turn, exec(AP(PATCH)), turn, exec('text(1);', 'c5')].join('\n'), PATCH), false, 'the apply_patch is an older turn\'s');
});
