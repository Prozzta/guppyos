'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('./load-ts.cjs')('src/main/codexLiveRotation.ts');
const loadTs = require('./load-ts.cjs');
const source = fsRead('src/main/codexLiveRotation.ts');
const indexSource = fsRead('src/main/index.ts');
const base = () => ({ bytes: R.CODEX_LIVE_ROTATE_BYTES + 1, stopSeen: true, turnOpen: false, toolRunning: false, owed: false, wakePending: false, wakeInFlight: false, wakeHeld: false, heavy: false, floorHeld: false, inputPending: false, humanTyping: false, workspaceIsolated: false });
function fsRead(p) { return require('node:fs').readFileSync(p, 'utf8'); }
test('under cap is kept and exactly 20 MiB is not rotated', () => {
  assert.deepEqual(R.decideCodexLiveRotation({ ...base(), bytes: R.CODEX_LIVE_ROTATE_BYTES }), { action: 'keep', reason: 'under-cap', escalate: false, bytes: R.CODEX_LIVE_ROTATE_BYTES });
});
test('over cap rotates only on a completed, entirely quiet turn', () => {
  assert.equal(R.decideCodexLiveRotation(base()).action, 'rotate');
});
for (const [field, reason] of [
  ['stopSeen', 'no-stop'], ['turnOpen', 'turn-open'], ['toolRunning', 'tool-running'], ['owed', 'owed-obligation'], ['wakePending', 'wake-pending'], ['wakeInFlight', 'wake-in-flight'], ['wakeHeld', 'wake-held'], ['heavy', 'heavy-held'], ['floorHeld', 'floor-held'], ['inputPending', 'input-pending'], ['humanTyping', 'human-typing'], ['workspaceIsolated', 'workspace-isolated']
]) test(`defers when ${reason}`, () => {
  const f = base(); f[field] = field === 'stopSeen' ? false : true;
  const d = R.decideCodexLiveRotation(f); assert.equal(d.action, 'defer'); assert.equal(d.reason, reason);
});
test('64 MiB deferred path escalates but never forces rotation', () => {
  const d = R.decideCodexLiveRotation({ ...base(), bytes: R.CODEX_LIVE_ROTATE_HARD_BYTES, floorHeld: true });
  assert.deepEqual(d, { action: 'defer', reason: 'floor-held', escalate: true, bytes: R.CODEX_LIVE_ROTATE_HARD_BYTES });
});
test('digest key is deterministic and reason-specific', () => {
  assert.equal(R.liveRotationEscalationId('dwight', 's1', 'floor-held'), 'codex-live-rotation:dwight:s1:floor-held');
});
test('MUTANT CENSUS: each removed safety guard permits rotation and dies', () => {
  for (const [needle, field] of [
    ["!f.stopSeen ? 'no-stop'", 'stopSeen'], ["f.turnOpen ? 'turn-open'", 'turnOpen'], ["f.toolRunning ? 'tool-running'", 'toolRunning'], ["f.owed ? 'owed-obligation'", 'owed'], ["f.wakePending ? 'wake-pending'", 'wakePending'], ["f.wakeInFlight ? 'wake-in-flight'", 'wakeInFlight'], ["f.wakeHeld ? 'wake-held'", 'wakeHeld'], ["f.heavy ? 'heavy-held'", 'heavy'], ["f.floorHeld ? 'floor-held'", 'floorHeld'], ["f.inputPending ? 'input-pending'", 'inputPending'], ["f.humanTyping ? 'human-typing'", 'humanTyping'], ["f.workspaceIsolated ? 'workspace-isolated'", 'workspaceIsolated']
  ]) {
    const M = loadTs.fromText('src/main/codexLiveRotation.ts', source.replace(needle, 'false ? \'mutant\''));
    const f = base(); f[field] = field === 'stopSeen' ? false : true;
    assert.equal(M.decideCodexLiveRotation(f).action, 'rotate', `${field} mutant must permit a dangerous rotation`);
  }
});
test('index wires /exit rotation before submit and starts grace after owner settlement', () => {
  const arm = indexSource.indexOf('pendingCodexLiveRotation.set(a.ptyId!');
  const submit = indexSource.indexOf('automaticSubmit.submit({ requestId: `codex-live-rotate:');
  assert.ok(arm >= 0 && arm < submit, 'natural exit must find its restart record before /exit can be written');
  assert.ok(indexSource.includes("if (outcome.kind === 'REFUSED')"));
  assert.ok(indexSource.includes('const incarnation = ptyManager.incarnation(a.ptyId!)'));
  assert.ok(indexSource.includes('if (ptyManager.incarnation(ptyId) !== incarnation)'));
  assert.ok(indexSource.includes('armCodexLiveRotationExitDeadline(a.ptyId!, incarnation, agentId, a.sessionId, again.bytes)'));
  assert.ok(indexSource.includes("workspaceIsolated: !!ptyId && (worktreePaths.has(ptyId) || liveWorkers.has(ptyId))"));
});
