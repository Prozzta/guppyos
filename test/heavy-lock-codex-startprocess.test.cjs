'use strict';
/**
 * HEAVY-LOCK-SHAPES-189, god conv-cbab35. At 18:18:34Z Dwight's Codex (code mode, PowerShell) started
 * a full suite with `$suite=Start-Process -FilePath npm.cmd -ArgumentList 'test' ...` while Jim held
 * the one heavy slot: two suites ran at once. The Codex hook rebuilt that call fine (not degraded);
 * the CLASSIFIER called it light, for two reasons:
 *   - a launcher (`Start-Process`, `saps`, `start`) was a command of its own, not its program;
 *   - a PowerShell assignment (`$suite=...`, `$r = ...`) hid the command after it.
 * The 'degraded' row at 18:18:27Z (tool null) was the apply_patch exec just before: not the cause.
 * The `probe-failed rows:null` rows after it are the process listing timing out under the two
 * suites' load (already fail-closed): a result, not a cause. Paths here are invented.
 *
 * Named mutants, each must fail this file:
 *   S1 launchers are not followed       S2 `@(` read as a computed subexpression
 *   S3 `$x=cmd` is not an assignment    S4 `$x = cmd` is not an assignment
 *   S5 an npx option value (`--prefix ../wt`) is read as the program
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const HJ = loadTs('src/main/heavyJob.ts');
const M = loadTs('src/main/codexHookMcp.ts');

/** Dwight's 18:18:34Z exec_command, as the rollout has it (paths invented). */
const DWIGHT = String.raw`$p='C:\x\wt'; $d=Join-Path $p '.proof'; $loop=Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $d 'loop.ps1')) -WorkingDirectory $p -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $d 'loop.out.txt') -RedirectStandardError (Join-Path $d 'loop.err.txt'); Start-Sleep -Milliseconds 200; $suite=Start-Process -FilePath npm.cmd -ArgumentList 'test' -WorkingDirectory $p -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $d 'suite.out.txt') -RedirectStandardError (Join-Path $d 'suite.err.txt'); "TARGET_LOOP_PID=$($loop.Id) SUITE_PID=$($suite.Id)"`;

function tail(input) {
  return [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    { type: 'response_item', payload: { type: 'custom_tool_call', status: 'completed', call_id: 'call-1', name: 'exec', input } },
  ].map((x) => JSON.stringify(x)).join('\n') + '\n';
}

test('the Codex exec call Dwight ran at 18:18:34Z, rebuilt from its rollout, takes the lock', () => {
  const input = `const r = await tools.exec_command(${JSON.stringify({ cmd: DWIGHT, workdir: 'C:\\x\\wt', yield_time_ms: 10000, max_output_tokens: 1000 })});\ntext(r.output);`;
  const rb = M.rebuildToolHook(tail(input), 'PreToolUse');
  assert.equal(rb.degraded, false, 'the rebuild was never the problem');
  const k = HJ.classifyHeavy(rb.toolName, rb.toolInput);
  assert.equal(k.heavy, true, 'A SUITE STARTED BY Start-Process IS HEAVY'); // before: light
  assert.equal(k.kind, 'suite');
  assert.ok(!k.provisional, 'named, not merely unknown');
  const hint = M.pendingExecCommands(tail(input));
  assert.equal(HJ.classifyCommand(hint.commands[0]).kind, 'suite', 'the degraded fallback agrees');
});

test('launchers run their program: Start-Process, saps, start (before: all light)', () => {
  const rows = [
    [`Start-Process -FilePath npm.cmd -ArgumentList 'test'`, 'suite'],
    [`Start-Process npm.cmd 'test'`, 'suite'],
    [`Start-Process npm -ArgumentList 'ci' -NoNewWindow -Wait`, 'install'],
    [`Start-Process -FilePath node -ArgumentList @('test/tools/run-tests.cjs') -PassThru`, 'suite'],
    [`saps npm.cmd -ArgumentList 'run','test'`, 'suite'],
    [`start npm test`, 'suite'],
    [`start "" /b npm ci`, 'install'],
  ];
  for (const [c, kind] of rows) {
    const k = HJ.classifyCommand(c);
    assert.equal(k.heavy, true, `LAUNCHED HEAVY: ${c}`);
    assert.equal(k.kind, kind, c);
  }
  // Light programs stay light.
  for (const c of [
    `Start-Process -FilePath notepad.exe -ArgumentList 'x.txt'`,
    `Start-Process -FilePath node -ArgumentList 'test/tools/run-tests.cjs','heavy-lock'`,
    `Start-Process node -ArgumentList '--test','test/one.test.cjs'`,
    `start https://example.invalid`,
  ]) assert.equal(HJ.classifyCommand(c).heavy, false, `LIGHT: ${c}`);
});

test('npx: an option value is not the program (replay FP: `npx --prefix ../wt asar ...`)', () => {
  const k = HJ.classifyCommand('npx --prefix ../wt-x asar extract-file a.asar package.json', 0, { readScript: () => null });
  assert.equal(k.heavy, false, 'NPX PREFIX VALUE IS NOT A PROGRAM'); // before: provisional
  assert.equal(HJ.classifyCommand('npx --prefix ../wt-x electron-builder --win').kind, 'build');
});

test('a PowerShell assignment runs its right-hand side (before: light)', () => {
  for (const c of [`$r=npm test`, `$r = npm ci`, `$suite = Start-Process npm.cmd test`, `$env:X=1; $r=npm test`]) {
    assert.equal(HJ.classifyCommand(c).heavy, true, `ASSIGNED HEAVY: ${c}`);
  }
  for (const c of [`$p='C:\\x\\wt'`, `$n = 3`, `$d=Join-Path $p '.proof'`]) {
    assert.equal(HJ.classifyCommand(c).heavy, false, `LIGHT: ${c}`);
  }
});
