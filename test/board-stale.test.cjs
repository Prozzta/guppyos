'use strict';

/**
 * ZT-I3 §3.2: `detectStale`, pure. Every rule with boundary times (just under / at the
 * threshold), liveness fixtures shaped as src/shared/livenessV1.ts (the canonical type,
 * C:/Dunder/_work/creed-177/LIVENESS-V1.md), and the pre-liveness fallback.
 *
 * Mutants that must die:
 *   M8  `>` instead of `>=` at a threshold
 *   M9  STALE without the card-edit condition
 *   M10 an orphan registry archive treated as explicit
 *   M10b an orphan registry archive ignored forever (without a bounded boot grace)
 *   L2  a liveness ARCHIVED moves regardless of archiveReason
 *   L3  the operator-hold exclusion removed
 *   N1b the pre-liveness fallback ignores onHold (Jim nit b)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { detectStale, BOARD_STALE_DEFAULTS: D } = loadTs('src/shared/boardStale.ts');

const H = 3_600_000;
const NOW = 100 * H;
const doing = (id, assignee, extra = {}) => ({ id, title: id, status: 'doing', assignee, ...extra });

/** A liveness-v1 record (the canonical shape). */
function lv(agentId, classification, since, extra = {}) {
  return { agentId, incarnation: `${agentId}-1`, lifecycle: 'LIVE', classification, classifiedSince: since,
    reason: 'none', evidence: { sampledAt: NOW }, ...extra };
}

function run({ tasks, meta = {}, registry = {}, liveness = {}, fleet = {}, now = NOW, cfg }) {
  const m = {};
  for (const c of tasks) m[c.id] = meta[c.id] ?? { statusSince: 0, lastEditAt: 0 };
  return detectStale({ tasks, meta: m, registry: new Map(Object.entries(registry)), liveness: new Map(Object.entries(liveness)),
    fleet: new Map(Object.entries(fleet)), now, cfg });
}
const kinds = (flags) => flags.map((f) => `${f.cardId}:${f.kind}${f.decision ? '!' : ''}`);
const live = { archived: false };

test('an explicit registry archive (or one from before 1.1.75, no reason) is ASSIGNEE_ARCHIVED, informational', () => {
  assert.deepEqual(kinds(run({ tasks: [doing('A', 'jim')], registry: { jim: { archived: true, archiveReason: 'explicit' } } })), ['A:ASSIGNEE_ARCHIVED']);
  assert.deepEqual(kinds(run({ tasks: [doing('A', 'jim')], registry: { jim: { archived: true } } })), ['A:ASSIGNEE_ARCHIVED']);
});

test('a boot-sweep orphan archive is neither DOWN nor a move; pty-exit is DOWN (BOOT-ORPHAN-ASSIGNEE-DOWN)', () => {
  assert.deepEqual(kinds(run({ tasks: [doing('A', 'jim')], registry: { jim: { archived: true, archiveReason: 'orphan', lastSeen: NOW } } })), []);
  assert.deepEqual(kinds(run({ tasks: [doing('A', 'jim')], registry: { jim: { archived: true, archiveReason: 'pty-exit' } } })), ['A:ASSIGNEE_DOWN']);
});

test('a boot orphan is quiet only inside its bounded grace, then DOWN (BOOT-ORPHAN-ASSIGNEE-DOWN)', () => {
  const at = (age) => kinds(run({ tasks: [doing('A', 'jim')], registry: { jim: { archived: true, archiveReason: 'orphan', lastSeen: NOW - age } } }));
  assert.deepEqual(at(D.bootGraceMs - 1), []);
  assert.deepEqual(at(D.bootGraceMs), ['A:ASSIGNEE_DOWN']);
});

test('liveness ARCHIVED moves only when explicit; boot orphan is ignored briefly, pty-exit flags DOWN; DELETED moves (L2)', () => {
  const reg = { jim: live };
  const arch = (reason, at = NOW - H) => lv('jim', 'EXITED', at, { lifecycle: 'ARCHIVED', archiveReason: reason, archivedAt: at });
  assert.deepEqual(kinds(run({ tasks: [doing('A', 'jim')], registry: reg, liveness: { jim: arch('explicit') } })), ['A:ASSIGNEE_ARCHIVED']);
  assert.deepEqual(kinds(run({ tasks: [doing('A', 'jim')], registry: reg, liveness: { jim: arch('orphan', NOW - 1) } })), []);
  assert.deepEqual(kinds(run({ tasks: [doing('A', 'jim')], registry: reg, liveness: { jim: arch('pty-exit') } })), ['A:ASSIGNEE_DOWN!']);
  assert.deepEqual(kinds(run({ tasks: [doing('A', 'gone')], liveness: { gone: lv('gone', 'EXITED', NOW - H, { lifecycle: 'DELETED' }) } })), ['A:ASSIGNEE_ARCHIVED']);
});

test('a pty-exit from either source wins over a boot-orphan record from the other (BOOT-ORPHAN-ASSIGNEE-DOWN S1)', () => {
  const pty = lv('jim', 'EXITED', NOW - H, { lifecycle: 'ARCHIVED', archiveReason: 'pty-exit', archivedAt: NOW - H });
  const orphan = lv('jim', 'EXITED', NOW, { lifecycle: 'ARCHIVED', archiveReason: 'orphan', archivedAt: NOW });
  assert.deepEqual(kinds(run({ tasks: [doing('A', 'jim')], registry: { jim: { archived: true, archiveReason: 'orphan', lastSeen: NOW } }, liveness: { jim: pty } })), ['A:ASSIGNEE_DOWN!']);
  assert.deepEqual(kinds(run({ tasks: [doing('A', 'jim')], registry: { jim: { archived: true, archiveReason: 'pty-exit', lastSeen: NOW - H } }, liveness: { jim: orphan } })), ['A:ASSIGNEE_DOWN!']);
});

test('an assignee nobody knows is ASSIGNEE_UNKNOWN, a decision; "unassigned" is no one', () => {
  assert.deepEqual(kinds(run({ tasks: [doing('A', 'ghost'), doing('B', 'unassigned'), doing('C', '')] })), ['A:ASSIGNEE_UNKNOWN!']);
});

test('CRASHED/EXITED: DOWN at downAfterMs, a decision at downDecisionMs (M8)', () => {
  const at = (ms) => kinds(run({ tasks: [doing('A', 'jim')], registry: { jim: live }, liveness: { jim: lv('jim', 'CRASHED', NOW - ms) } }));
  assert.deepEqual(at(D.downAfterMs - 1), []);
  assert.deepEqual(at(D.downAfterMs), ['A:ASSIGNEE_DOWN']);
  assert.deepEqual(at(D.downDecisionMs - 1), ['A:ASSIGNEE_DOWN']);
  assert.deepEqual(at(D.downDecisionMs), ['A:ASSIGNEE_DOWN!']);
});

test('STUCK_WAKE is ASSIGNEE_STUCK, a decision', () => {
  assert.deepEqual(kinds(run({ tasks: [doing('A', 'jim')], registry: { jim: live }, liveness: { jim: lv('jim', 'STUCK_WAKE', NOW - 1) } })), ['A:ASSIGNEE_STUCK!']);
});

test('STALE needs IDLE >= 6 h AND the card unedited >= 6 h (M8, M9)', () => {
  const S = D.staleAfterMs;
  const at = (idle, edit) => kinds(run({ tasks: [doing('A', 'jim')], registry: { jim: live },
    meta: { A: { statusSince: 0, lastEditAt: NOW - edit } }, liveness: { jim: lv('jim', 'IDLE', NOW - idle) } }));
  assert.deepEqual(at(S, S), ['A:STALE!']);
  assert.deepEqual(at(S - 1, S), []);
  assert.deepEqual(at(S, S - 1), [], 'a card edited within 6 h is not stale');
  assert.deepEqual(at(24 * H, H), []);
});

test('operator-hold IDLE for 24 h is never STALE (L3)', () => {
  const flags = run({ tasks: [doing('A', 'jim')], registry: { jim: live }, liveness: { jim: lv('jim', 'IDLE', NOW - 24 * H, { reason: 'operator-hold' }) } });
  assert.deepEqual(kinds(flags), []);
});

test('SUSPECT, UNKNOWN and BUSY_PROGRESSING never flag', () => {
  for (const c of ['SUSPECT', 'UNKNOWN', 'BUSY_PROGRESSING']) {
    assert.deepEqual(kinds(run({ tasks: [doing('A', 'jim')], registry: { jim: live }, liveness: { jim: lv('jim', c, NOW - 48 * H) } })), [], c);
  }
});

test('without liveness: STALE uses fleet lastActiveAt, skips onHold (nit b); STUCK is off', () => {
  const S = D.staleAfterMs;
  const base = { tasks: [doing('A', 'jim')], meta: { A: { statusSince: 0, lastEditAt: NOW - S } } };
  assert.deepEqual(kinds(run({ ...base, registry: { jim: live }, fleet: { jim: { lastActiveAt: NOW - S } } })), ['A:STALE!']);
  assert.deepEqual(kinds(run({ ...base, registry: { jim: live }, fleet: { jim: { lastActiveAt: NOW - S + 1 } } })), []);
  assert.deepEqual(kinds(run({ ...base, registry: { jim: live }, fleet: { jim: { lastActiveAt: NOW - S, onHold: true } } })), []);
  assert.deepEqual(kinds(run({ ...base, registry: { jim: { archived: false, onHold: true } }, fleet: { jim: { lastActiveAt: NOW - S } } })), []);
  assert.deepEqual(kinds(run({ ...base, registry: { jim: live }, fleet: { jim: { lastActiveAt: null } } })), [], 'no usage yet is unknown, not idle');
  assert.deepEqual(kinds(run({ ...base, registry: { jim: live } })), [], 'no fleet facts: nothing (and never STUCK)');
});

test('more than maxDoing doing cards: DOING_MANY on each, informational', () => {
  const tasks = [1, 2, 3, 4].map((n) => doing(`T${n}`, 'jim'));
  assert.deepEqual(kinds(run({ tasks, registry: { jim: live } })), ['T1:DOING_MANY', 'T2:DOING_MANY', 'T3:DOING_MANY', 'T4:DOING_MANY']);
  assert.deepEqual(kinds(run({ tasks: tasks.slice(0, 3), registry: { jim: live } })), []);
});

test('a blocked card answered >= 30 min ago is ASK_ANSWERED_IDLE, a decision', () => {
  const card = (mins, extra = []) => ({ id: 'Q', status: 'blocked', assignee: 'jim',
    humanQA: [{ q: 'go?', a: 'yes', answeredAt: new Date(NOW - mins * 60_000).toISOString() }, ...extra] });
  assert.deepEqual(kinds(run({ tasks: [card(30)], registry: { jim: live } })), ['Q:ASK_ANSWERED_IDLE!']);
  assert.deepEqual(kinds(run({ tasks: [card(29)], registry: { jim: live } })), []);
  assert.deepEqual(kinds(run({ tasks: [card(90, [{ q: 'and this?' }])], registry: { jim: live } })), [], 'still waiting on the human');
});

test('a duplicate id: only the first card is judged', () => {
  const tasks = [{ id: 'A', status: 'done', assignee: 'jim' }, doing('A', 'jim')];
  assert.deepEqual(kinds(run({ tasks, registry: { jim: { archived: true, archiveReason: 'explicit' } } })), []);
});

test('today\'s three stale cards, as synthetic fixtures: assignee parked, IDLE for days, no edit', () => {
  const tasks = [doing('ZERO-TOKEN-LIVENESS', 'dwight'), doing('ZT-I1-MAIL', 'andy'), doing('CARD-BADGE-AMBIGUOUS', 'jim')];
  const meta = Object.fromEntries(tasks.map((c) => [c.id, { statusSince: NOW - 72 * H, lastEditAt: NOW - 72 * H }]));
  const liveness = Object.fromEntries(['dwight', 'andy', 'jim'].map((a) => [a, lv(a, 'IDLE', NOW - 50 * H)]));
  const flags = run({ tasks, meta, registry: { dwight: live, andy: live, jim: live }, liveness });
  assert.deepEqual(kinds(flags), ['ZERO-TOKEN-LIVENESS:STALE!', 'ZT-I1-MAIL:STALE!', 'CARD-BADGE-AMBIGUOUS:STALE!']);
});

test('answers that are dismissed or resolvedBy god, and parked cards, are not ASK_ANSWERED_IDLE (K6, S3)', () => {
  const answered = (extra = {}) => ({ q: 'go?', a: 'yes', answeredAt: new Date(NOW - 5 * H).toISOString(), ...extra });
  const card = (qa, extra = {}) => ({ id: 'Q', status: 'blocked', assignee: 'jim', humanQA: qa, ...extra });
  assert.deepEqual(kinds(run({ tasks: [card([answered({ dismissedAt: new Date(NOW).toISOString() })])], registry: { jim: live } })), []);
  assert.deepEqual(kinds(run({ tasks: [card([answered({ resolvedBy: 'god-askme-tidy' })])], registry: { jim: live } })), []);
  assert.deepEqual(kinds(run({ tasks: [card([answered()], { parked: true })], registry: { jim: live } })), []);
  assert.deepEqual(kinds(run({ tasks: [card([answered()])], registry: { jim: live } })), ['Q:ASK_ANSWERED_IDLE!']);
});

test('a registry pty-exit archive: DOWN since its lastSeen, a decision at downDecisionMs (K9)', () => {
  const at = (ms) => kinds(run({ tasks: [doing('A', 'jim')], registry: { jim: { archived: true, archiveReason: 'pty-exit', lastSeen: NOW - ms } } }));
  assert.deepEqual(at(D.downDecisionMs - 1), ['A:ASSIGNEE_DOWN']);
  assert.deepEqual(at(D.downDecisionMs), ['A:ASSIGNEE_DOWN!']);
});

test('an assignee known only to liveness (LIVE) is not UNKNOWN (K10)', () => {
  assert.deepEqual(kinds(run({ tasks: [doing('A', 'newbie')], liveness: { newbie: lv('newbie', 'BUSY_PROGRESSING', NOW - 1) } })), []);
});

test('flag times are stable across ticks (no flag moves just because time passed)', () => {
  const tasks = [1, 2, 3, 4].map((n) => doing(`T${n}`, 'jim'));
  const meta = Object.fromEntries(tasks.map((c, i) => [c.id, { statusSince: NOW - (i + 1) * H, lastEditAt: NOW }]));
  const a = run({ tasks, meta, registry: { jim: live } });
  const b = run({ tasks, meta, registry: { jim: live }, now: NOW + 60_000 });
  assert.deepEqual(a.map((f) => f.since), b.map((f) => f.since));
  const arch = (now) => run({ tasks: [doing('A', 'jim')], registry: { jim: { archived: true, archiveReason: 'explicit', lastSeen: NOW - H } }, now });
  assert.equal(arch(NOW)[0].since, NOW - H);
  assert.equal(arch(NOW)[0].archivedAt, NOW - H);
  assert.equal(arch(NOW + 60_000)[0].since, NOW - H);
});
