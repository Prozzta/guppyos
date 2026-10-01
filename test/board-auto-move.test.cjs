'use strict';

/**
 * ZT-I3 §3.3: the board monitor's one automatic move. A doing card whose assignee was
 * EXPLICITLY archived goes back to todo, assignee kept, with one note line, a board-auto
 * log row and the guard's sidecar stamped 'api:board-auto'. Idempotent. Every other flag
 * is published (state/board-flags.json) and logged only when it appears or clears.
 *
 * Mutants that must die:
 *   M11 the assignee is cleared on the move
 *   M12 a move on every tick (not idempotent)
 *   M12b an orphan archive moves
 *   MLOG a board-flag row on every tick (not change-only)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { BoardMonitor } = loadTs('src/main/boardMonitor.ts');

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const agent = (id, extra = {}) => ({ id, name: id, cwd: '.', status: 'idle', lastSeen: 0, ...extra });

function rig(t, agents, tasks) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-board-auto-'));
  const hive = new HiveManager(() => home);
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  hive.ensureHive();
  const root = hive.root();
  fs.writeFileSync(path.join(root, 'registry.json'), JSON.stringify({ godId: null, agents }, null, 2));
  fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify({ tasks }, null, 2));
  hive.ledgerGuard.check();
  const monitor = new BoardMonitor({ hive, now: () => NOW });
  const log = () => fs.readFileSync(path.join(root, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const card = (id) => hive.tasks().tasks.find((c) => c.id === id);
  return { hive, root, monitor, log, card };
}

test('an explicit archive moves the doing card to todo, assignee kept, noted and logged (M11)', (t) => {
  const r = rig(t, { jim: agent('jim', { archived: true, archiveReason: 'explicit' }) },
    [{ id: 'A', title: 'A', status: 'doing', assignee: 'jim', notes: 'earlier note', note: 'kept', repo: 'x' }]);
  r.monitor.tick();
  const a = r.card('A');
  assert.equal(a.status, 'todo');
  assert.equal(a.assignee, 'jim', 'NEVER clear the assignee on a status change');
  assert.equal(a.note, 'kept');
  assert.equal(a.repo, 'x');
  const lines = a.notes.split('\n');
  assert.equal(lines[0], 'earlier note');
  assert.match(lines[1], /^2026-10-01T12:00:00\.000Z harness: doing -> todo: assignee jim archived \(explicit\) at .+\. Assignee kept\.$/);
  const auto = r.log().filter((l) => l.kind === 'board-auto');
  assert.deepEqual(auto.map((l) => [l.cardId, l.from, l.to, l.assignee]), [['A', 'doing', 'todo', 'jim']]);
  assert.equal(r.hive.ledgerGuard.taskMeta().cards.A.lastEditBy, 'api:board-auto');
  assert.deepEqual(r.monitor.flags(), [], 'after the move nothing is left to flag');
});

test('the move is idempotent: a second tick changes nothing (M12)', (t) => {
  const r = rig(t, { jim: agent('jim', { archived: true, archiveReason: 'explicit' }) },
    [{ id: 'A', title: 'A', status: 'doing', assignee: 'jim' }]);
  r.monitor.tick();
  const bytes = fs.readFileSync(path.join(r.root, 'tasks.json'));
  r.monitor.tick();
  r.monitor.tick();
  assert.deepEqual(fs.readFileSync(path.join(r.root, 'tasks.json')), bytes);
  assert.equal(r.log().filter((l) => l.kind === 'board-auto').length, 1);
});

test('an orphan archive, and a non-doing card, never move (M12b)', (t) => {
  const r = rig(t, { jim: agent('jim', { archived: true, archiveReason: 'orphan' }), ann: agent('ann', { archived: true, archiveReason: 'explicit' }) },
    [{ id: 'A', title: 'A', status: 'doing', assignee: 'jim' }, { id: 'B', title: 'B', status: 'blocked', assignee: 'ann' }]);
  const before = fs.readFileSync(path.join(r.root, 'tasks.json'));
  r.monitor.tick();
  assert.deepEqual(fs.readFileSync(path.join(r.root, 'tasks.json')), before);
  assert.deepEqual(r.monitor.flags().map((f) => `${f.cardId}:${f.kind}`), ['A:ASSIGNEE_DOWN']);
});

test('flags are published to state/board-flags.json and logged only when raised or cleared (MLOG)', (t) => {
  const r = rig(t, { jim: agent('jim') }, [{ id: 'A', title: 'A', status: 'doing', assignee: 'ghost' }]);
  r.monitor.tick();
  r.monitor.tick();
  const pub = JSON.parse(fs.readFileSync(path.join(r.root, 'state', 'board-flags.json'), 'utf8'));
  assert.deepEqual(pub.flags.map((f) => `${f.cardId}:${f.kind}`), ['A:ASSIGNEE_UNKNOWN']);
  assert.equal(r.log().filter((l) => l.kind === 'board-flag').length, 1);
  r.hive.patchTask('A', { assignee: 'jim' }, 'ipc');
  r.monitor.tick();
  const rows = r.log().filter((l) => l.kind === 'board-flag').map((l) => `${l.event}:${l.flag}`);
  assert.deepEqual(rows, ['raised:ASSIGNEE_UNKNOWN', 'cleared:ASSIGNEE_UNKNOWN']);
});

test('liveness records riding in fleet.json are used when no in-process source is wired', (t) => {
  const r = rig(t, { jim: agent('jim') }, [{ id: 'A', title: 'A', status: 'doing', assignee: 'jim' }]);
  fs.writeFileSync(path.join(r.root, 'fleet.json'), JSON.stringify({ ts: NOW, agents: [{ id: 'jim', lastActiveSecAgo: 5,
    liveness: { agentId: 'jim', incarnation: 'j1', lifecycle: 'LIVE', classification: 'STUCK_WAKE', classifiedSince: NOW - 1000, reason: 'wake-refused', evidence: { sampledAt: NOW } } }] }));
  r.monitor.tick();
  assert.deepEqual(r.monitor.flags().map((f) => `${f.cardId}:${f.kind}`), ['A:ASSIGNEE_STUCK']);
});

test('wired as in the app (guard change -> tick), the move happens once (the nested tick finds the card already moved)', (t) => {
  const r = rig(t, { jim: agent('jim', { archived: true, archiveReason: 'explicit' }) },
    [{ id: 'A', title: 'A', status: 'doing', assignee: 'jim' }]);
  let ticks = 0;
  r.hive.ledgerGuard.onChange(() => { ticks++; r.monitor.tick(); });
  r.monitor.tick();
  assert.equal(ticks, 1, 'the auto-move write notified the guard listener once');
  assert.equal(r.card('A').notes.split('\n').length, 1);
  assert.equal(r.log().filter((l) => l.kind === 'board-auto').length, 1);
});
