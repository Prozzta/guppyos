'use strict';
/**
 * HEAVY-LOCK-CODEX-EXEC (god fa8c45). Dwight's Codex (code mode, `shell: "powershell"`) ran the full
 * suite as `node test/tools/run-tests.cjs *> <file>.log` with no heavy-lock acquire. The Codex hook
 * rebuilt that call fine (not degraded); the CLASSIFIER called it light: stripRedirects knew the
 * POSIX redirects but not PowerShell's all-streams `*>` / `*>>`, so `*>` and the log path stayed as
 * positional arguments, and a suite runner with any argument after it reads as a FILTERED (light) run.
 * The 'degraded' rows around it were apply-patch calls (no command): not the cause.
 * All commands and paths here are invented.
 *
 * Named mutants, each must fail this file:
 *   P1 `*>` is not a redirect again
 *   P2 only `*>` is, not `*>>`
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const HJ = loadTs('src/main/heavyJob.ts');
const M = loadTs('src/main/codexHookMcp.ts');

test('PowerShell all-streams redirects never read as a suite filter', () => {
  const heavy = [
    'node test/tools/run-tests.cjs *> C:\\x\\full.log',
    'node test/tools/run-tests.cjs *>> C:\\x\\full.log',
    'node test/tools/run-tests.cjs *>C:\\x\\full.log',
    'node test/tools/run-tests.cjs *>&1 | Out-File C:\\x\\full.log',
    'node test/tools/run-tests.cjs *>$null',
    '& node .\\test\\tools\\run-tests.cjs *> full.log',
    'npm run test:focused *> full.log',
  ];
  for (const c of heavy) {
    const k = HJ.classifyCommand(c);
    assert.equal(k.heavy, true, `A SUITE BEHIND *> IS SEEN: ${c}`);
    assert.equal(k.kind, 'suite', c);
  }
  // A real filter stays light, and so does one test file with its output redirected (no false heavy).
  assert.equal(HJ.classifyCommand('node test/tools/run-tests.cjs heavy-lock *> f.log').heavy, false, 'a filtered run');
  assert.equal(HJ.classifyCommand('node --test test/one.test.cjs *> f.log').heavy, false, 'one file, not "a glob or a directory"');
  assert.equal(HJ.classifyCommand('node --test test/one.test.cjs *>> f.log').heavy, false);
  // The POSIX forms are unchanged.
  assert.equal(HJ.classifyCommand('node test/tools/run-tests.cjs > f.log 2>&1').kind, 'suite');
  assert.equal(HJ.classifyCommand('node test/tools/run-tests.cjs 2>&1 | Tee-Object -FilePath f.log').kind, 'suite');
});

/** A Codex code-mode rollout tail: the turn, then the pending `exec` custom tool call. */
function tail(input) {
  return [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    { type: 'response_item', payload: { type: 'custom_tool_call', status: 'completed', call_id: 'call-1', name: 'exec', input } },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n';
}

test('the Codex exec call Dwight ran, rebuilt from its rollout, takes the lock', () => {
  const input = 'const r = await tools.exec_command({cmd:"node test/tools/run-tests.cjs *> C:\\\\x\\\\full.log","shell":"powershell","workdir":"C:\\\\x\\\\wt","yield_time_ms":1000,"max_output_tokens":300}); text(JSON.stringify(r));';
  const rb = M.rebuildToolHook(tail(input), 'PreToolUse');
  assert.equal(rb.degraded, false, 'the rebuild itself was never the problem');
  const k = HJ.classifyHeavy(rb.toolName, rb.toolInput);
  assert.equal(k.heavy, true, 'CODEX POWERSHELL SUITE IS HEAVY');
  assert.equal(k.kind, 'suite');
  // The degraded fallback (pending-command hints) classifies the same command the same way.
  const hint = M.pendingExecCommands(tail(input));
  assert.deepEqual(hint.commands, ['node test/tools/run-tests.cjs *> C:\\x\\full.log']);
  assert.equal(HJ.classifyCommand(hint.commands[0]).heavy, true);
});
