'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('./load-ts.cjs')('src/main/codexLiveRotation.ts');
const W = require('./load-ts.cjs')('src/main/codexLiveRotationWiring.ts');
const T = require('./load-ts.cjs')('src/main/codexThreadRotation.ts');
const loadTs = require('./load-ts.cjs');
const source = fsRead('src/main/codexLiveRotation.ts');
const base = () => ({ bytes: R.CODEX_LIVE_ROTATE_BYTES + 1, stopSeen: true, turnOpen: false, toolRunning: false, owed: false, wakePending: false, wakeInFlight: false, wakeHeld: false, heavy: false, floorHeld: false, inputPending: false, humanTyping: false, workspaceIsolated: false });
function fsRead(p) { return require('node:fs').readFileSync(p, 'utf8'); }
test('under cap is kept and exactly 20 MiB is not rotated', () => {
  assert.equal(R.CODEX_LIVE_ROTATE_BYTES, 20 * 1024 * 1024, 'W2: normal live-rollout cap is pinned');
  assert.equal(R.CODEX_LIVE_ROTATE_HARD_BYTES, 64 * 1024 * 1024, 'W2: escalation cap is pinned');
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
test('W3 fact mapping carries stop/turn state without index source pins', () => {
  const f = W.mapCodexLiveRotationFacts({ ...base(), lastTurnEndAt: 10, openTurn: false, active: false, lastHumanInputAt: 9 });
  assert.equal(f.stopSeen, true); assert.equal(f.turnOpen, false); assert.equal(f.humanTyping, false);
  assert.equal(W.mapCodexLiveRotationFacts({ ...base(), lastTurnEndAt: 0, openTurn: false, active: true, lastHumanInputAt: 1 }).turnOpen, true);
});
test('W5 fact mapping makes a newer human input block rotation', () => {
  const f = W.mapCodexLiveRotationFacts({ ...base(), lastTurnEndAt: 10, lastHumanInputAt: 11 });
  assert.equal(f.humanTyping, true);
  assert.equal(R.decideCodexLiveRotation(f).reason, 'human-typing');
});
test('W7 exit gate rejects refused or vanished PTYs, preserving only uncertain live exits', () => {
  assert.equal(W.shouldArmCodexLiveRotationExit('REFUSED', true), false);
  assert.equal(W.shouldArmCodexLiveRotationExit('COMMITTED', false), false);
  assert.equal(W.shouldArmCodexLiveRotationExit('INTERFERED', true), true);
});
test('per-session rollout cache stats the known file without another sessions walk', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-live-cache-'));
  const session = '11111111-1111-1111-1111-111111111111';
  const dir = path.join(home, 'sessions', '2026', '10', '21');
  const file = path.join(dir, `rollout-2026-10-21T19-00-00-${session}.jsonl`);
  try {
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, '1234');
    const cache = new Map();
    assert.equal(T.findCachedCodexRollout(cache, home, session).bytes, 4);
    fs.appendFileSync(file, '56');
    assert.equal(T.findCachedCodexRollout(cache, home, session).bytes, 6, 'cached path still observes growth');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
