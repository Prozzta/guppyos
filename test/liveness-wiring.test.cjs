'use strict';
/**
 * ZERO-TOKEN-LIVENESS, wiring (design slice 5; Jim L6): main constructs ONE AgentLivenessMonitor,
 * feeds it existing facts (registry, PTY, wake coordinator, Codex rollout, wake refusals, PTY ends),
 * samples it on the 15-second wake beat after the WWR and on turn-boundary hooks, writes its edges
 * to log.jsonl, puts its records in fleet.json, and writes fleet.json atomically.
 *
 * Named mutants, each must fail this file:
 *   M14 every 15-s sample appends a log row (rows are for edges only)
 *   M15 a registry archive emits an agent wake or a board edit from the liveness path
 *   M16 fleet.json is written in place (a reader can see a torn file)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const INDEX = codeOnly(readSource('src/main/index.ts'));
const between = (src, from, to) => {
  const a = src.indexOf(from);
  assert.ok(a >= 0, `missing ${from}`);
  const b = src.indexOf(to, a + from.length);
  assert.ok(b > a, `missing ${to} after ${from}`);
  return src.slice(a, b);
};

test('one monitor, fed by the existing facts; its sink is the hive log and nothing else', () => {
  assert.equal([...INDEX.matchAll(/new AgentLivenessMonitor\(/g)].length, 1);
  const ctor = between(INDEX, 'const agentLiveness = new AgentLivenessMonitor({', '});');
  assert.match(ctor, /sink: \(row\) => \{ try \{ hive\.appendLog\(row\); \}/);
  const factsFn = between(INDEX, 'function livenessFactsFor(agentId: string)', 'const agentLiveness = new AgentLivenessMonitor');
  for (const source of ['ptyManager.livenessFacts(ptyId)', 'workerWake.livenessFacts(agentId)', 'control.snapshot(agentId)', 'codexLifecycle.probe(home)', 'mailPendingIds(agentId)']) {
    assert.ok(factsFn.includes(source), `facts from ${source}`);
  }
  // The rollout probe walks session folders synchronously: never for an idle agent.
  assert.match(factsFn, /if \(pf && a\.provider === 'codex' && wake\.lifecycle !== 'idle'\) \{/);
  // The facts builder only reads: no submit, wake, write, spawn or model path.
  assert.doesNotMatch(factsFn, /submit|requestInboxWake|scheduleWake|\.write\(|\bspawn(Sync)?\(|hiddenClaude|condense|appendLog|setArchived/);
});

test('sampled on the 15-s wake beat AFTER the WWR, on turn-boundary hooks, at PTY ends and at the archival edge', () => {
  const beat = between(INDEX, 'function runWorkerWakeBeat(): void {', '\n}\n');
  assert.ok(beat.indexOf('inboxWake.reconcileAll(live);') < beat.indexOf('sampleLivenessAll();'), 'after the WWR');
  // The HookServer observer is the 1.1.76 one, unchanged, wrapped: the bridge sees the hook first.
  assert.match(INDEX, /withLivenessEdge\(\(agentId, event, message, fullyIdle, turnId, source\) => \{ if \(agentId\) hookSeenAt\.set\(agentId, Date\.now\(\)\); inboxWake\?\.onHook\(agentId, event, message, fullyIdle, turnId, source\); \}\),/);
  const wrap = between(INDEX, 'function withLivenessEdge(', '\n}\n');
  assert.ok(wrap.indexOf('observe(agentId, event, message, fullyIdle, turnId, source);') < wrap.indexOf('sampleLiveness(agentId)'), 'observe first, then sample');
  assert.match(wrap, /LIVENESS_EDGE_HOOKS\.has\(event\)\) sampleLiveness\(agentId\)/);
  assert.match(INDEX, /ptyManager\.setEndObserver\(\(e\) => \{[\s\S]*?agentLiveness\.notePtyEnd\(agentId, \{ ptyId: e\.id, incarnation: e\.incarnation, explicit: e\.explicit/);
  // The end observer is registered with the PTY manager before the exit handler (both module-level).
  assert.ok(INDEX.indexOf('ptyManager.setEndObserver(') < INDEX.indexOf('ptyManager.setExitHandler('));
  // The WWR boundary: the bridge is given the monitor's record-first hook.
  assert.match(INDEX, /liveness: \{ stuckWake: \(agentId, reason\) => \{ agentLiveness\.noteStuckWake\(agentId, reason\); \} \}/);
});

test('M15: the archival edge only re-samples liveness: no wake, no board or task edit, no restart from the liveness path', () => {
  const teardown = between(INDEX, 'function teardownPty(id: string', '\n}\n');
  const at = teardown.indexOf('sampleLiveness(agentId);');
  assert.ok(at > teardown.indexOf('hive.setArchived(agentId, true, archiveReason)'), 'after the archive is written');
  // Everything the liveness code in main does: none of it wakes, submits, edits tasks or restarts.
  const liveCode = [
    between(INDEX, 'function livenessFactsFor(agentId: string)', 'function noteWakeRefusal('),
    between(INDEX, 'ptyManager.setEndObserver((e) => {', '});')
  ].join('\n');
  assert.doesNotMatch(liveCode, /scheduleWake|requestInboxWake|onControlRelease|submit\(|updateTask|writeTasks|board|spawnAgentCore|restartWithModel|ptyManager\.kill|ptyManager\.write/);
  assert.match(liveCode, /liveness:changed/, 'the renderer is told (data only)');
});

test('M14: a beat that changes no classification appends no row (edges only)', () => {
  const { AgentLivenessMonitor } = loadTs('src/main/agentLiveness.ts');
  const rows = [];
  let now = Date.parse('2026-10-01T12:00:00Z');
  const f = {
    agentId: 'a1', registry: { archived: false, onHold: false },
    pty: { ptyId: 'p', incarnation: 1, spawnedAt: now - 3_600_000, lastTrafficAt: now - 60_000 },
    wake: { lifecycle: 'idle', provisional: false, activeSince: 0, openTurnId: null, turnStartAt: 0, lastTurnEndAt: now - 60_000, lastHookAt: now - 60_000, lastHumanNeedsAt: 0 },
    control: { paused: false, halted: false, autoDeliveryPaused: false }, mailWaiting: 0
  };
  const mon = new AgentLivenessMonitor({ agents: () => ['a1'], facts: () => f, sink: (r) => rows.push(r), now: () => now });
  for (let i = 0; i < 40; i++) { mon.sampleAll(); now += 15_000; }   // 10 minutes of beats
  assert.equal(rows.length, 1, 'the first observation only');
  assert.equal(rows[0].kind, 'liveness');
});

test('G1 (Jim P10): the ONE operator action that can lead to a turn is gated in main: STUCK_WAKE + wwr-max-recoveries only, then the bridge', () => {
  const ipc = between(INDEX, "ipcMain.handle('liveness:reoffer', (_evt, agentId: unknown) => {", '\n});');
  assert.match(ipc, /if \(typeof agentId !== 'string' \|\| !agentId\) return false;/);
  assert.match(ipc, /const rec = agentLiveness\.getLiveness\(agentId\);\n\s+if \(!rec \|\| rec\.classification !== 'STUCK_WAKE' \|\| rec\.reason !== 'wwr-max-recoveries'\) return false;/);
  assert.ok(ipc.indexOf("rec.reason !== 'wwr-max-recoveries') return false;") < ipc.indexOf('inboxWake?.onOperatorReoffer(agentId)'), 'gate first, then the bridge');
  assert.equal([...INDEX.matchAll(/onOperatorReoffer\(/g)].length, 1, 'nothing else in main re-offers');
});

test('G3 (Jim P11): refusal evidence is recorded only while mail waits (and never for no-pending-ids)', () => {
  const fn = between(INDEX, 'function noteWakeRefusal(agentId: string, why: string, inboxIds: number): void {', '\n}\n');
  assert.match(fn, /if \(inboxIds > 0 && why !== 'no-pending-ids'\) \{\n\s+const run = wakeStalls\.watchingFor\(agentId\);\n\s+agentLiveness\.noteWakeRefusal\(agentId, Date\.now\(\), run\?\.since\);/);
  assert.equal([...fn.matchAll(/agentLiveness\.noteWakeRefusal\(/g)].length, 1, 'one call, inside the guard');
});

test('fleet.json carries the records: every LIVE one, recent non-LIVE ones', () => {
  const fleet = between(INDEX, 'function writeFleetSnapshot(): void {', '\n}\n');
  assert.match(fleet, /liveness: agentLiveness\.fleetRecords\(now\)/);
});

test('M16: fleet.json is written atomically (temp file, then rename): a reader never sees it half-written', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'liveness-fleet-'));
  const realHome = process.env.HOME; const realProfile = process.env.USERPROFILE;
  process.env.HOME = home; process.env.USERPROFILE = home;
  t.after(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    if (realProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realProfile;
    fs.rmSync(home, { recursive: true, force: true });
  });
  assert.equal(os.homedir(), home, 'HOME redirect failed - aborting before constructing any hive');
  const { HiveManager } = loadTs('src/main/hive.ts');
  const hiveHome = path.join(home, 'harness');
  fs.mkdirSync(path.join(hiveHome, 'hive'), { recursive: true });
  const hive = new HiveManager(() => hiveHome);
  t.after(() => hive.dispose());
  const fleetPath = path.join(hiveHome, 'hive', 'fleet.json');
  const writes = [];
  const renames = [];
  const realWrite = fs.writeFileSync; const realRename = fs.renameSync;
  fs.writeFileSync = function (p, ...rest) { writes.push(String(p)); return realWrite.call(this, p, ...rest); };
  fs.renameSync = function (a, b, ...rest) { renames.push([String(a), String(b)]); return realRename.call(this, a, b, ...rest); };
  try {
    hive.writeFleetSnapshot({ ts: 1, agents: [], liveness: [{ agentId: 'a1' }] });
  } finally {
    fs.writeFileSync = realWrite; fs.renameSync = realRename;
  }
  assert.ok(!writes.some((p) => path.resolve(p) === path.resolve(fleetPath)), `never written in place: ${JSON.stringify(writes)}`);
  assert.ok(renames.some(([, to]) => path.resolve(to) === path.resolve(fleetPath)), 'renamed into place');
  assert.deepEqual(JSON.parse(fs.readFileSync(fleetPath, 'utf8')).liveness, [{ agentId: 'a1' }]);
});
