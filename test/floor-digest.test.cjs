'use strict';

/**
 * ZT-I4: the floor digest and the decision-only wake of god.
 *
 * Mutants that must die:
 *   M13 wake on informational flags (auto-moves, DOING_MANY)
 *   M14 no dedupe: the same item re-wakes god
 *   M15 a wake on every digest run (no new item needed)
 *   M15b no batch window (wake on the first item at once)
 *   M25 'digest' added to SYSTEM_SENDERS (decisions silently dropped from god's actionable count)
 *   MCLR a cleared item is never forgotten (a flag that comes back never wakes again)
 *   G2   readFleetAgents ignores the top-level liveness[] (Dwight's records never reach the digest
 *        or board-status), or lets agents[].liveness override it (N2)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { buildFloorDigest, decideGodWake, decisionItems, FloorDigest, DIGEST_SENDER, FLOOR_DIGEST_DEFAULTS } = loadTs('src/main/floorDigest.ts');
const { SYSTEM_SENDERS } = loadTs('src/main/mailReaders.ts');

const MIN = 60_000;
const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const flag = (cardId, kind, decision, extra = {}) => ({ cardId, kind, agentId: 'jim', since: NOW, evidence: `${kind} evidence`, decision, ...extra });
const empty = { woken: {}, pendingSince: null };

test('decision items come only from decision flags and ledger errors (M13)', () => {
  const items = decisionItems([
    flag('A', 'STALE', true), flag('B', 'ASSIGNEE_ARCHIVED', false), flag('C', 'DOING_MANY', false), flag('D', 'ASSIGNEE_STUCK', true)
  ], [{ key: 'dup:X', level: 'error', cardId: 'X', message: 'duplicate id X at cards #1, #4' }, { key: 'desc:P+Q', level: 'warning', cardId: 'P', message: 'same description' }], NOW);
  assert.deepEqual(items.map((i) => i.id), ['stale:A:2026-10-01', 'assignee_stuck:D', 'dup:X']);
  assert.match(items[2].line, /which is canonical\?/);
});

test('wake policy: batch window, then one wake with every new item; never the same item twice (M14, M15, M15b)', () => {
  const W = FLOOR_DIGEST_DEFAULTS.wakeBatchMs;
  const a = [{ id: 'stale:A:2026-10-01', cardId: 'A', line: 'a' }];
  let r = decideGodWake(a, empty, NOW, W);
  assert.deepEqual([r.wake.length, r.state.pendingSince], [0, NOW], 'the first item opens the window');
  const ab = [...a, { id: 'dup:X', cardId: 'X', line: 'x' }];
  r = decideGodWake(ab, r.state, NOW + W - 1, W);
  assert.equal(r.wake.length, 0);
  r = decideGodWake(ab, r.state, NOW + W, W);
  assert.deepEqual(r.wake.map((i) => i.id), ['stale:A:2026-10-01', 'dup:X'], 'one wake carries the batch');
  r = decideGodWake(ab, r.state, NOW + 3 * W, W);
  assert.deepEqual([r.wake.length, r.state.pendingSince], [0, null], 'already woken: no repeat, no window');
});

test('a cleared item is forgotten, so it can wake again; STALE re-arms on a new day (MCLR)', () => {
  const item = { id: 'assignee_stuck:D', cardId: 'D', line: 'd' };
  let r = decideGodWake([item], empty, NOW, 0);
  assert.equal(r.wake.length, 1);
  r = decideGodWake([], r.state, NOW + MIN, 0);
  assert.deepEqual(r.state.woken, {}, 'the flag cleared');
  r = decideGodWake([item], r.state, NOW + 2 * MIN, 0);
  assert.equal(r.wake.length, 1, 'it came back: decide again');
  const tomorrow = Date.parse('2026-10-02T09:00:00.000Z');
  const items = decisionItems([flag('A', 'STALE', true)], [], tomorrow);
  r = decideGodWake(items, { woken: { 'stale:A:2026-10-01': NOW }, pendingSince: null }, tomorrow, 0);
  assert.deepEqual(r.wake.map((i) => i.id), ['stale:A:2026-10-02']);
});

test('the digest markdown lists decisions, in-flight age, blocked, flags and roster', () => {
  const { markdown } = buildFloorDigest({
    tasks: [{ id: 'A', status: 'doing', assignee: 'jim' }, { id: 'Q', status: 'blocked', assignee: 'ann', humanQA: [{ q: 'go?' }] }, { id: 'A', status: 'todo' }],
    meta: { A: { statusSince: NOW - 3 * 60 * MIN, statusSinceExact: false } },
    flags: [flag('A', 'STALE', true)], ledgerIssues: [],
    agents: [{ id: 'jim', name: 'Jim', inboxBacklog: 2, liveness: { classification: 'IDLE' } }], now: NOW
  });
  assert.match(markdown, /## Decisions needed\n\n- \[stale:A:2026-10-01\] A: STALE evidence - still doing\?/);
  assert.match(markdown, /- jim: A \(>= 3 h\)/);
  assert.match(markdown, /- Q \(ann\): 1 question\(s\) for the Human/);
  assert.match(markdown, /- Jim \(jim\): idle; 2 message\(s\) waiting/);
  assert.equal((markdown.match(/- jim: A/g) ?? []).length, 1, 'a duplicate id is listed once (first copy)');
});

test('the digest sender is NOT a system sender: a decision wake is actionable mail (M25)', () => {
  assert.equal(DIGEST_SENDER, 'digest');
  assert.equal(SYSTEM_SENDERS.has(DIGEST_SENDER), false);
});

function rig(t, flags) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-floor-digest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const clock = { now: NOW };
  const sent = [];
  const host = {
    root: () => root, tasks: () => ({ tasks: [{ id: 'A', status: 'doing', assignee: 'jim' }] }), taskMeta: () => ({}),
    flags: () => flags.current, ledgerIssues: () => [], send: (m, from) => sent.push({ ...m, from }), appendLog: () => {}
  };
  const digest = new FloorDigest(host, () => ({ ...FLOOR_DIGEST_DEFAULTS, wakeBatchMs: 10 * MIN }), () => clock.now);
  return { root, clock, sent, digest };
}

test('the scheduler writes floor-digest.md and sends ONE decision wake as "digest", once (M15)', (t) => {
  const flags = { current: [flag('A', 'STALE', true), flag('A', 'DOING_MANY', false)] };
  const r = rig(t, flags);
  r.digest.run();
  assert.ok(fs.existsSync(path.join(r.root, 'floor-digest.md')));
  assert.equal(r.sent.length, 0, 'inside the batch window');
  r.clock.now += 10 * MIN;
  r.digest.run();
  assert.equal(r.sent.length, 1);
  assert.deepEqual([r.sent[0].to, r.sent[0].act, r.sent[0].subject, r.sent[0].from], ['god', 'inform', 'Floor: 1 decision(s)', 'digest']);
  assert.match(r.sent[0].body, /^- \[stale:A:2026-10-01\] A: STALE evidence - still doing\?/);
  assert.doesNotMatch(r.sent[0].body, /DOING_MANY/, 'informational flags never reach the wake');
  r.clock.now += 60 * MIN;
  r.digest.run();
  assert.equal(r.sent.length, 1, 'the same decision never wakes god twice');
  // The woken set survives a restart (state/digest-woken.json).
  const again = new FloorDigest({ ...r.digest.host }, () => ({ ...FLOOR_DIGEST_DEFAULTS, wakeBatchMs: 0 }), () => r.clock.now);
  again.run();
  assert.equal(r.sent.length, 1);
});

test('no decisions: the digest is still written and god is not woken', (t) => {
  const r = rig(t, { current: [flag('A', 'ASSIGNEE_ARCHIVED', false)] });
  r.clock.now += 60 * MIN;
  r.digest.run();
  r.digest.run();
  assert.equal(r.sent.length, 0);
  assert.match(fs.readFileSync(path.join(r.root, 'floor-digest.md'), 'utf8'), /## Decisions needed\n\nNone\./);
});

test('an answered-but-blocked card wakes god once per ANSWER: a new answer re-arms it (S3)', () => {
  const ask = (since) => [{ cardId: 'Q', kind: 'ASK_ANSWERED_IDLE', agentId: 'jim', since, evidence: 'e', decision: true }];
  let r = decideGodWake(decisionItems(ask(1000), [], NOW), empty, NOW, 0);
  assert.deepEqual(r.wake.map((i) => i.id), ['ask_answered_idle:Q:1000']);
  r = decideGodWake(decisionItems(ask(1000), [], NOW + 86_400_000), r.state, NOW + 86_400_000, 0);
  assert.equal(r.wake.length, 0, 'the same answer never wakes again, on any day');
  r = decideGodWake(decisionItems(ask(5000), [], NOW + 86_400_000), r.state, NOW + 86_400_000, 0);
  assert.deepEqual(r.wake.map((i) => i.id), ['ask_answered_idle:Q:5000']);
});

test('a digest wake is actionable for god but leaves NO reply obligation (Jim S5)', async (t) => {
  const { HiveManager } = loadTs('src/main/hive.ts');
  const R = loadTs('src/main/mailReaders.ts');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-digest-oblig-'));
  const hive = new HiveManager(() => home);
  t.after(() => { hive.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  hive.ensureHive();
  const root = hive.root();
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  const clock = { now: NOW };
  const digest = new FloorDigest({
    root: () => root, tasks: () => ({ tasks: [] }), taskMeta: () => ({}), ledgerIssues: () => [],
    flags: () => [flag('A', 'ASSIGNEE_STUCK', true)], send: (m, from) => { hive.send(m, from); }, appendLog: () => {}
  }, () => ({ ...FLOOR_DIGEST_DEFAULTS, wakeBatchMs: 0 }), () => clock.now);
  assert.equal(digest.run().length, 1);
  const f = R.fleetMailFields(hive.mail, 'god-1');
  assert.equal(R.actionableBacklog(hive.mail, 'god-1'), 1, 'god sees it as actionable mail');
  assert.deepEqual([f.openRequestCount, f.awaitingReplyCount], [0, 0], 'and owes nobody a reply');
});

test('G2: readFleetAgents joins the top-level liveness[] by agentId, and it wins over agents[].liveness (N2)', (t) => {
  const { readFleetAgents } = loadTs('src/main/floorDigest.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zt-fleet-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'fleet.json'), JSON.stringify({
    agents: [{ id: 'jim', name: 'Jim' }, { id: 'pam', name: 'Pam', liveness: { classification: 'WORKING' } }, { id: 'kev', name: 'Kevin' }],
    liveness: [{ agentId: 'jim', classification: 'CRASHED', reason: 'pty-exit' }, { agentId: 'pam', classification: 'STUCK_WAKE', reason: 'wake-refused' }]
  }));
  const byId = Object.fromEntries(readFleetAgents(root).map((a) => [a.id, a.liveness && a.liveness.classification]));
  assert.deepEqual(byId, { jim: 'CRASHED', pam: 'STUCK_WAKE', kev: undefined });
});
