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
 *   Q7 write_stdin is not read (Jim F1)           Q8 its trailing newline is kept
 *   Q9 a function_call write_stdin is not read    Q10 an empty poll becomes a hint
 *   Q11 `tools?.exec_command(` is not read (S1)   Q12 `tools["exec_command"](` is not read (S1)
 *   Q13 a computed `tools[n](` is not counted (S2)
 *   Q14 mentions are counted in strings/comments (S3)  Q15 a call inside a string is read (S3)
 *   Q16 `cmd: "a" + b` reads as the literal "a"
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HeavyJobLock, classifyCommand } = loadTs('src/main/heavyJob.ts');
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
    ['const {exec_command: run} = tools; await run({cmd:"npm ci"});', [], 1],
    ['await Promise.all(xs.map((c) => tools.exec_command({cmd: c})));', [], 1],
    ['await tools.exec_command({ cmd: "a" + "b" });', [], 1],
    ['await tools.exec_command({cmd:"npm ci", workdir: w, yield_time_ms: 1000});', ['npm ci'], 0],
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

test('Jim F1: write_stdin input is a hint (literal) or unnamed (computed); an empty poll is neither', () => {
  const SUITE = 'node test/tools/run-tests.cjs';
  // P6: one write_stdin into a session started earlier (its session_id computed).
  const p6 = hint('await tools.write_stdin({session_id: s.session_id, chars:"node test/tools/run-tests.cjs\\r\\n", yield_time_ms: 1000});');
  assert.deepEqual([p6.commands, p6.unnamed], [[SUITE], 0]);
  // P7: a shell started, then the suite typed into it: the suite is a hint next to the shell.
  const p7 = hint('const s = await tools.exec_command({cmd:"powershell"}); await tools.write_stdin({session_id: s.session_id, chars:"node test/tools/run-tests.cjs\\n"});');
  assert.deepEqual([p7.commands, p7.unnamed], [['powershell', SUITE], 0]);
  assert.equal(p7.commands.some((c) => classifyCommand(c).heavy), true, 'THE TYPED SUITE IS HEAVY');
  assert.deepEqual([hint('await tools.write_stdin({session_id: 1, chars: line});').unnamed, hint('await tools.write_stdin({session_id: 1, chars: line});').commands], [1, []]);
  assert.deepEqual([hint('await tools.write_stdin({session_id: 1, chars: ""});').unnamed, hint('await tools.write_stdin({session_id: 1, chars: ""});').commands], [0, []], 'a poll');
  assert.deepEqual(hint('await tools.write_stdin({session_id: 1, chars: "y\\n"});').commands, ['y'], 'an interactive reply is light');
  // No chars key at all is a poll too; one that could hide chars (shorthand, quoted, spread) is unnamed.
  assert.deepEqual([hint('await tools.write_stdin({session_id: s.session_id, yield_time_ms: 5000});').unnamed, hint('await tools.write_stdin({session_id: s.session_id, yield_time_ms: 5000});').commands], [0, []], 'a poll without chars');
  for (const p of ['await tools.write_stdin({session_id: 1, chars});', "await tools.write_stdin({session_id: 1, 'chars': x});", 'await tools.write_stdin({session_id: 1, ...o});']) {
    assert.equal(hint(p).unnamed, 1, p);
  }
  assert.equal(hint('await tools.exec_command({workdir: "w"});').unnamed, 1, 'an exec_command with no cmd is not a poll');
  // Non-code mode: a pending function_call write_stdin, its JSON arguments.chars read the same way.
  const fc = [line('turn_context', { turn_id: TURN }), line('response_item', { type: 'function_call', name: 'write_stdin', call_id: 'c1', arguments: JSON.stringify({ session_id: 7, chars: 'npm test\n' }) })].join('\n');
  assert.deepEqual(mcp.pendingExecCommands(fc).commands, ['npm test']);
  const poll = [line('turn_context', { turn_id: TURN }), line('response_item', { type: 'function_call', name: 'write_stdin', call_id: 'c1', arguments: JSON.stringify({ session_id: 7, chars: '' }) })].join('\n');
  assert.deepEqual(mcp.pendingExecCommands(poll).commands, []);
});

test('Jim S1-S3: optional and bracket calls are read; computed tool names count; strings and comments never do', () => {
  const cases = [
    // S1: the literal behind `?.` or a literal bracket name is read (and hinted).
    ['await tools?.exec_command({cmd:"npm ci"});', ['npm ci'], 0],
    ['await tools["exec_command"]({cmd:"npm ci"});', ['npm ci'], 0],
    ["await tools['write_stdin']({session_id: 1, chars:\"npm ci\\n\"});", ['npm ci'], 0],
    // S2: a computed tool name is unnamed; a literal non-shell one is not.
    ['const n = pick(); await tools[n]({cmd:"npm ci"});', [], 1],
    ['await tools["exec" + "_command"]({cmd:"npm ci"});', [], 1],
    ['await tools["apply_patch"]("*** Begin Patch");', [], 0],
    // S3: the name inside a literal command, a comment, or a string is no mention.
    ['await tools.exec_command({cmd:"git grep exec_command"}); await tools.exec_command({cmd:"echo b"});', ['git grep exec_command', 'echo b'], 0],
    ['// exec_command and write_stdin are the shell tools\nawait tools.exec_command({cmd:"echo a"}); /* tools.exec_command({cmd: c}) */ await tools.exec_command({cmd:"echo b"});', ['echo a', 'echo b'], 0],
    ['text("tools.exec_command({cmd: c})");', [], 0],
  ];
  for (const [input, commands, unnamed] of cases) {
    const h = hint(input);
    assert.deepEqual([h.commands, h.unnamed], [commands, unnamed], input);
  }
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

test('HOOK (Jim P7): a suite typed into a shell with write_stdin takes the slot through the hint path', async (t) => {
  const { s, l, hive } = await server(t, 1);
  const h = hint('const s = await tools.exec_command({cmd:"powershell"}); await tools.write_stdin({session_id: s.session_id, chars:"node test/tools/run-tests.cjs\\n"});');
  assert.equal(h.unnamed, 0);
  s.handle({ hook_event_name: 'PreToolUse', agent_id: 'a1', payload_degraded: true, transport: 'mcp', codex_commands: h.commands });
  assert.deepEqual(l.snapshot().map((x) => [x.agentId, x.command]), [['a1', 'node test/tools/run-tests.cjs']]);
  assert.equal(rows(hive).filter((r) => r.action === 'unnamed-exec').length, 0, 'read, so not unnamed');
});
