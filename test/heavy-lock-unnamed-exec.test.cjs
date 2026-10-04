'use strict';
/**
 * HEAVY-LOCK-UNNAMED-EXEC (god 953d52). A Codex code-mode `exec` whose exec_command the rollout
 * cannot name (a computed cmd `for (const c of cmds) await tools.exec_command({cmd: c})`, a
 * template, an alias) arrives DEGRADED with no hint and passes the heavy-job lock unclassified.
 * Policy stays fail-open (god's call); this only makes such calls VISIBLE: pendingExecCommands
 * counts them (`unnamed`), the MCP route carries the count, and the lock logs its own row
 * `{kind:'heavy-lock', action:'unnamed-exec', unnamed, hinted, heavy}`. All commands are invented.
 *
 * Named mutants, each must fail this file:
 *   Q1 an unreadable `tools.exec_command(` cmd is not counted
 *   Q2 an alias / bracket mention of exec_command is not counted
 *   Q3 the MCP route does not carry the count
 *   Q4 the lock never writes the row
 *   Q5 the lock writes the row for every degraded call
 *   Q6 an unnamed exec takes the slot (a policy change god has not made)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HeavyJobLock } = loadTs('src/main/heavyJob.ts');
const mcp = loadTs('src/main/codexHookMcp.ts');
const { HookServer } = loadTs('src/main/hooks.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const TURN = 'turn-unnamed-1';
const line = (type, payload) => JSON.stringify({ timestamp: '2026-10-04T06:00:00.000Z', type, payload });
const tailOf = (input) => [line('turn_context', { turn_id: TURN }), line('response_item', { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input })].join('\n');
const hint = (input) => mcp.pendingExecCommands(tailOf(input));

test('pendingExecCommands counts the code-mode exec_command calls it cannot name', () => {
  const cases = [
    ['for (const c of cmds) await tools.exec_command({cmd: c});', [], 1],
    ['await tools.exec_command({ cmd: `npm ${x}` });', [], 1],
    ['await tools.exec_command(opts);', [], 1],
    ['const t = tools; await t.exec_command({cmd:"npm ci"});', [], 1],
    ['await tools["exec_command"]({cmd:"npm ci"});', [], 1],
    ['await tools.exec_command({cmd:"echo a"}); await tools.exec_command({cmd: c});', ['echo a'], 1],
    ['await tools.exec_command({cmd:"echo a"}); await tools.exec_command({cmd:"echo b"});', ['echo a', 'echo b'], 0],
    ['text("no shell here");', [], 0],
  ];
  for (const [input, commands, unnamed] of cases) {
    const h = hint(input);
    assert.deepEqual([h.commands, h.unnamed, h.complete], [commands, unnamed, unnamed === 0], input);
  }
  // An answered call is not pending: nothing to count.
  const answered = tailOf('for (const c of cmds) await tools.exec_command({cmd: c});') + '\n' + line('response_item', { type: 'custom_tool_call_output', call_id: 'c1', output: 'ok' });
  assert.equal(mcp.pendingExecCommands(answered).unnamed, 0);
});

test('wiring: the MCP route carries the unnamed count on a degraded PreToolUse', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'hooks.ts'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(src, /const hint = pendingExecCommands\(tail\);\n\s+if \(hint\.commands\.length\) p\.codex_commands = hint\.commands;\n\s+if \(hint\.unnamed\) p\.codex_unnamed_exec = hint\.unnamed;/);
});

async function server(t, limit) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-heavyun-'));
  const ph = process.env.HOME; const pu = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  assert.equal(os.homedir(), home, 'HOME jailed before any hive');
  const hive = new HiveManager(() => home);
  t.after(() => {
    if (ph === undefined) delete process.env.HOME; else process.env.HOME = ph;
    if (pu === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = pu;
  });
  for (const id of ['a1', 'a2']) await hive.ensureAgent({ id, name: id, provider: 'codex', cwd: home });
  const control = { takeSteer: () => null, shouldHalt: () => false, toolDecision: () => ({ deny: false }) };
  const s = new HookServer(hive, () => null, () => ({ notifications: false }), control, undefined);
  const l = new HeavyJobLock({ limit: () => limit, setTimer: () => ({}), clearTimer: () => {} });
  s.setHeavyLock(l);
  return { s, l, hive };
}

const rows = (hive) => fs.readFileSync(path.join(hive.root(), 'log.jsonl'), 'utf8').split('\n').filter(Boolean)
  .map((x) => JSON.parse(x)).filter((r) => r.kind === 'heavy-lock');

test('HOOK: an unnamed exec gets its own heavy-lock row and is still let through (fail-open, unchanged)', async (t) => {
  const { s, l, hive } = await server(t, 1);
  const base = { hook_event_name: 'PreToolUse', payload_degraded: true, transport: 'mcp' };
  // A degraded call with nothing unnamed (an apply-patch, say): the old 'degraded' row only.
  assert.equal(s.handle({ ...base, agent_id: 'a1' }).hookSpecificOutput?.permissionDecision, undefined);
  assert.deepEqual(rows(hive).map((r) => r.action), ['degraded']);
  // Unnamed, no hints: allowed, no slot, and the distinct row.
  const un = s.handle({ ...base, agent_id: 'a1', codex_unnamed_exec: 2 });
  assert.equal(un.hookSpecificOutput?.permissionDecision, undefined, 'still allowed');
  assert.equal(l.snapshot().length, 0, 'NO SLOT: the policy is unchanged');
  const r1 = rows(hive).filter((r) => r.action === 'unnamed-exec');
  assert.deepEqual(r1.map(({ agentId, unnamed, hinted, heavy }) => ({ agentId, unnamed, hinted, heavy })), [{ agentId: 'a1', unnamed: 2, hinted: 0, heavy: false }]);
  // Unnamed next to a readable heavy one: the heavy hint takes the slot as before; the row says so.
  s.handle({ ...base, agent_id: 'a2', codex_commands: ['node test/tools/run-tests.cjs'], codex_unnamed_exec: 1 });
  assert.deepEqual(l.snapshot().map((h) => h.agentId), ['a2']);
  const r2 = rows(hive).filter((r) => r.action === 'unnamed-exec');
  assert.deepEqual(r2.map(({ agentId, unnamed, hinted, heavy }) => ({ agentId, unnamed, hinted, heavy }))[1], { agentId: 'a2', unnamed: 1, hinted: 1, heavy: true });
  // A non-degraded call is never counted, whatever it carries.
  s.handle({ hook_event_name: 'PreToolUse', agent_id: 'a1', transport: 'mcp', tool_name: 'Bash', tool_input: { command: 'echo a' }, codex_unnamed_exec: 3 });
  assert.equal(rows(hive).filter((r) => r.action === 'unnamed-exec').length, 2);
});
