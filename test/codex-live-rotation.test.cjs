'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('./load-ts.cjs')('src/main/codexLiveRotation.ts');
const W = require('./load-ts.cjs')('src/main/codexLiveRotationWiring.ts');
const T = require('./load-ts.cjs')('src/main/codexThreadRotation.ts');
const loadTs = require('./load-ts.cjs');
const source = fsRead('src/main/codexLiveRotation.ts');
const indexSource = fsRead('src/main/index.ts');
const base = () => ({ bytes: R.CODEX_LIVE_ROTATE_BYTES + 1, stopSeen: true, turnOpen: false, toolRunning: false, owed: false, wakePending: false, wakeInFlight: false, wakeHeld: false, heavy: false, floorHeld: false, inputPending: false, humanTyping: false, workspaceIsolated: false });
function fsRead(p) { return require('node:fs').readFileSync(p, 'utf8'); }
test('under cap is kept and exactly 20 MiB is not rotated', () => {
  assert.equal(R.CODEX_LIVE_ROTATE_BYTES, 20 * 1024 * 1024, 'B1: normal live-rollout cap is pinned');
  assert.equal(R.CODEX_LIVE_ROTATE_HARD_BYTES, 64 * 1024 * 1024, 'B4: escalation cap is pinned');
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
test('W1 fresh recheck must still be the same rotation target', () => {
  const first = { ptyId: 'p1', sessionId: 's1', action: 'rotate' };
  assert.equal(W.sameCodexLiveRotationTarget(first, first), true);
  assert.equal(W.sameCodexLiveRotationTarget(first, { ...first, action: 'defer' }), false);
  assert.equal(W.sameCodexLiveRotationTarget(first, { ...first, sessionId: 's2' }), false);
});
test('W1 mutant: ignored second fresh read is killed', () => {
  const wiring = fsRead('src/main/codexLiveRotationWiring.ts');
  const M = loadTs.fromText('src/main/codexLiveRotationWiring.ts', wiring.replace("return second.action === 'rotate' && second.ptyId === first.ptyId && second.sessionId === first.sessionId;", 'return true;'));
  assert.equal(M.sameCodexLiveRotationTarget({ ptyId: 'p1', sessionId: 's1', action: 'rotate' }, { ptyId: 'p1', sessionId: 's1', action: 'defer' }), true, 'the ignored-read mutant is observable');
});
test('W7 fact mapping carries stop/turn state without index source pins', () => {
  const f = W.mapCodexLiveRotationFacts({ ...base(), lastTurnEndAt: 10, openTurn: false, active: false, lastHumanInputAt: 9 });
  assert.equal(f.stopSeen, true); assert.equal(f.turnOpen, false); assert.equal(f.humanTyping, false);
  assert.equal(W.mapCodexLiveRotationFacts({ ...base(), lastTurnEndAt: 0, openTurn: false, active: true, lastHumanInputAt: 1 }).turnOpen, true);
});
test('W7 fact mapping makes a newer human input block rotation', () => {
  const f = W.mapCodexLiveRotationFacts({ ...base(), lastTurnEndAt: 10, lastHumanInputAt: 11 });
  assert.equal(f.humanTyping, true);
  assert.equal(R.decideCodexLiveRotation(f).reason, 'human-typing');
});
test('W7 mutant: human typing cannot be discarded', () => {
  const wiring = fsRead('src/main/codexLiveRotationWiring.ts');
  const M = loadTs.fromText('src/main/codexLiveRotationWiring.ts', wiring.replace('humanTyping: i.lastHumanInputAt > i.lastTurnEndAt,', 'humanTyping: false,'));
  assert.equal(M.mapCodexLiveRotationFacts({ ...base(), lastTurnEndAt: 10, lastHumanInputAt: 11 }).humanTyping, false, 'the typing-discard mutant is observable');
});
test('W8 exit gate rejects refused or vanished PTYs, preserving only uncertain live exits', () => {
  assert.equal(W.shouldArmCodexLiveRotationExit('REFUSED', true), false);
  assert.equal(W.shouldArmCodexLiveRotationExit('COMMITTED', false), false);
  assert.equal(W.shouldArmCodexLiveRotationExit('INTERFERED', true), true);
});
test('W8 mutant: refused owner cannot retain an exit arm', () => {
  const wiring = fsRead('src/main/codexLiveRotationWiring.ts');
  const M = loadTs.fromText('src/main/codexLiveRotationWiring.ts', wiring.replace("return outcomeKind !== 'REFUSED' && ptyStillLive;", 'return ptyStillLive;'));
  assert.equal(M.shouldArmCodexLiveRotationExit('REFUSED', true), true, 'the refused-arm mutant is observable');
});
test('W2 only relaunches a successful graceful /exit', () => {
  assert.equal(W.shouldRelaunchCodexLiveRotation(0), true);
  assert.equal(W.shouldRelaunchCodexLiveRotation(1), false);
  assert.equal(W.shouldRelaunchCodexLiveRotation(null), false);
});
test('W2 mutant: non-zero exit relaunches is killed', () => {
  const wiring = fsRead('src/main/codexLiveRotationWiring.ts');
  const M = loadTs.fromText('src/main/codexLiveRotationWiring.ts', wiring.replace('return exitCode === 0;', 'return true;'));
  assert.equal(M.shouldRelaunchCodexLiveRotation(1), true, 'the failed-exit relaunch mutant is observable');
});
test('W3 relaunch starts a fresh conversation instead of resuming the old one', () => {
  const fresh = W.freshCodexLiveRotationSpawn({ resume: true, requireResume: true, resumeSessionId: 'old', startFresh: false, label: 'keep' });
  assert.deepEqual(fresh, { resume: false, requireResume: false, resumeSessionId: undefined, startFresh: true, label: 'keep' });
});
test('W3 mutant: old-session resume is killed', () => {
  const wiring = fsRead('src/main/codexLiveRotationWiring.ts');
  const M = loadTs.fromText('src/main/codexLiveRotationWiring.ts', wiring.replace('resume: false, requireResume: false, resumeSessionId: undefined, startFresh: true', 'resume: true, requireResume: true, resumeSessionId: opts.resumeSessionId, startFresh: false'));
  assert.equal(M.freshCodexLiveRotationSpawn({ resume: true, requireResume: true, resumeSessionId: 'old' }).startFresh, false, 'the old-session mutant is observable');
});
test('W4 only Codex PTYs are rotation candidates', () => {
  assert.equal(W.mayConsiderCodexLiveRotation('codex', false), true);
  assert.equal(W.mayConsiderCodexLiveRotation('claude', false), false);
  assert.equal(W.mayConsiderCodexLiveRotation('codex', true), false);
});
test('W4 mutant: non-Codex PTYs cannot rotate', () => {
  const wiring = fsRead('src/main/codexLiveRotationWiring.ts');
  const M = loadTs.fromText('src/main/codexLiveRotationWiring.ts', wiring.replace("return provider === 'codex' && !alreadyArmed;", 'return !alreadyArmed;'));
  assert.equal(M.mayConsiderCodexLiveRotation('claude', false), true, 'the non-Codex mutant is observable');
});
test('W5 beat sweep considers every live agent', () => {
  const seen = []; W.sweepCodexLiveRotations(['a', 'b', 'c'], id => seen.push(id));
  assert.deepEqual(seen, ['a', 'b', 'c']);
});
test('W5 mutant: removed beat sweep is killed', () => {
  const wiring = fsRead('src/main/codexLiveRotationWiring.ts');
  const M = loadTs.fromText('src/main/codexLiveRotationWiring.ts', wiring.replace('for (const agentId of agentIds) consider(agentId);', 'void agentIds; void consider;'));
  const seen = []; M.sweepCodexLiveRotations(['a'], id => seen.push(id));
  assert.deepEqual(seen, [], 'the removed-sweep mutant is observable');
});
test('W6 delayed arm is limited to its original PTY incarnation', () => {
  assert.equal(W.isCurrentCodexLiveRotationIncarnation(4, 4), true);
  assert.equal(W.isCurrentCodexLiveRotationIncarnation(4, 5), false);
});
test('W6 mutant: a new incarnation cannot inherit an old rotation arm', () => {
  const wiring = fsRead('src/main/codexLiveRotationWiring.ts');
  const M = loadTs.fromText('src/main/codexLiveRotationWiring.ts', wiring.replace('return current === armed;', 'return true;'));
  assert.equal(M.isCurrentCodexLiveRotationIncarnation(4, 5), true, 'the stale-incarnation mutant is observable');
});
test('index.ts live-rotation wiring retains all 17 safety call sites', () => {
  const facts = indexSource.slice(indexSource.indexOf('function codexLiveRotationFacts'), indexSource.indexOf('/** Log every reason transition'));
  const rotation = indexSource.slice(indexSource.indexOf('function considerCodexLiveRotation'), indexSource.indexOf('// IDLE-MEANS-IDLE:', indexSource.indexOf('function considerCodexLiveRotation')));
  const exit = indexSource.slice(indexSource.indexOf('ptyManager.setExitHandler'), indexSource.indexOf('const pending = pendingInstallRelaunch', indexSource.indexOf('ptyManager.setExitHandler')));
  const beat = indexSource.slice(indexSource.indexOf('function runWorkerWakeBeat'), indexSource.indexOf('/** (Re)arm the always-on beats', indexSource.indexOf('function runWorkerWakeBeat')));
  const arm = indexSource.slice(indexSource.indexOf('function armCodexLiveRotationExitDeadline'), indexSource.indexOf('function considerCodexLiveRotation'));
  const required = [
    [facts, 'findCachedCodexRollout(liveCodexRollouts'], [facts, 'owed: (mail.awaitingReply?.length ?? 0) > 0 || (mail.openRequests?.length ?? 0) > 0'],
    [facts, 'lastHumanInputAt: humanAt'], [facts, 'workspaceIsolated: !!ptyId && (worktreePaths.has(ptyId) || liveWorkers.has(ptyId))'],
    [rotation, "mayConsiderCodexLiveRotation(ptyProvider.get(ptyForAgent(agentId) ?? ''), pendingCodexLiveRotation.has(ptyForAgent(agentId) ?? ''))"],
    [rotation, 'const b = codexLiveRotationFacts(agentId);'], [rotation, 'sameCodexLiveRotationTarget('],
    [rotation, 'freshCodexLiveRotationSpawn(spawn.opts)'], [rotation, "text: '/exit'"],
    [rotation, "if (outcome.kind === 'REFUSED') {\n      pendingCodexLiveRotation.delete(a.ptyId!)"],
    [rotation, 'shouldArmCodexLiveRotationExit(outcome.kind, ptyStillLive)'],
    [arm, 'isCurrentCodexLiveRotationIncarnation(incarnation, ptyManager.incarnation(ptyId))'],
    [exit, 'shouldRelaunchCodexLiveRotation(exitCode)'], [exit, 'teardownPty(id, naturalExitReason);'],
    [exit, 'void spawnAgentCore(rotating.opts, rotating.owner);'], [beat, 'sweepCodexLiveRotations(live, considerCodexLiveRotation);'],
    [indexSource, 'if (agentId && event === \'Stop\') setImmediate(() => considerCodexLiveRotation(agentId));']
  ];
  for (const [text, call] of required) assert.ok(text.includes(call), `missing live-rotation safety call: ${call}`);
  assert.ok(rotation.indexOf('const b = codexLiveRotationFacts(agentId);') < rotation.indexOf("text: '/exit'"), 'fresh read must precede /exit');
  assert.ok(exit.indexOf('shouldRelaunchCodexLiveRotation(exitCode)') < exit.indexOf('void spawnAgentCore(rotating.opts, rotating.owner);'), 'exit gate must precede relaunch');
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
