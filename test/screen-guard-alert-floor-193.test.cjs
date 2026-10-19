'use strict';
/**
 * SCREEN-GUARD-ALERT-FLOOR-193 (generalised, god c6b4d7): a floor-wide wake-delivery stall reaches
 * god as a `Floor: N decision(s)` item, whatever path refused it.
 *
 * 1.1.91 (2026-10-18, app-start 11:25:33Z): Jim (3, then 4 messages), Andy (1) and Creed (1) waited
 * from the start. Every wake was refused, with a changing reason (settle REFUSED SCREEN_NOT_READY
 * startup:no-composer, reconcile-cooldown, lifecycle-unknown, in-flight), so the per-agent stall
 * watch (one reason for 5 min) never announced, and after ~11:55Z no refusal was even logged. No
 * wake committed until the 12:48Z restart, and god was never told.
 *
 * Fix: FloorWakeStallWatch (wakeStall.ts). The digest samples every live agent's pending mail; when
 * FLOOR_STALL_MIN_AGENTS agents have waited FLOOR_STALL_AFTER_MS and nothing moved floor-wide (no
 * committed wake, no pending id drained), it is one decision item, through the same digest and
 * decideGodWake as SHIPPED_INSTALLED. A human's hold (paused, halted, auto-delivery paused, a
 * quiet-held or HITL refusal) is not a stall.
 *
 * Mutants that must die: MUTANT CENSUS at the bottom.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');

const WSF = 'src/main/wakeStall.ts';
const FDF = 'src/main/floorDigest.ts';
const WS = loadTs(WSF);
const FD = loadTs(FDF);
const MIN = 60_000;
const TICK = 5 * MIN;          // FLOOR_DIGEST_DEFAULTS.digestEveryMs
const BATCH = 10 * MIN;        // FLOOR_DIGEST_DEFAULTS.wakeBatchMs
const T0 = Date.parse('2026-10-18T11:25:33.944Z');
const LIVE = ['god', 'jim-mtujpe28', 'andy-mtuk4y4x', 'phyllis-mu11xldm', 'dwight-mu32ztys', 'creed-mukyiphw'];

/** One digest run, as FloorDigest.run does it: the host samples, then build + decideGodWake. */
function digestRun(W, D, watch, rows, now, state) {
  watch.sample(rows, now);
  const floorStall = watch.stall(now);
  const { decisionItems } = D.buildFloorDigest({ tasks: [], meta: {}, flags: [], ledgerIssues: [], agents: [], now, floorStall });
  return { floorStall, items: decisionItems, ...D.decideGodWake(decisionItems, state, now, BATCH) };
}

/** Drive a floor: `at(now)` gives that tick's rows; `events(from, to)` feeds refusals and commits. */
function drive(W, D, { from, to, at, events = () => {} }) {
  const watch = new W.FloorWakeStallWatch(from);
  let state = { woken: {}, pendingSince: null };
  const wakes = [];
  const ids = new Set();
  for (let now = from; now <= to; now += TICK) {
    events(watch, now - TICK, now);
    const r = digestRun(W, D, watch, at(now), now, state);
    state = r.state;
    for (const i of r.items) if (i.id.startsWith('floor-wake-stall:')) ids.add(i.id);
    if (r.wake.length) wakes.push({ now, items: r.wake });
  }
  return { wakes, ids };
}

const rows191 = (now) => LIVE.map((agentId) => ({
  agentId, deliberate: false,
  ids: agentId === 'jim-mtujpe28' ? (now >= Date.parse('2026-10-18T11:27:46Z') ? ['j1', 'j2', 'j3', 'j4'] : ['j1', 'j2', 'j3'])
    : agentId === 'andy-mtuk4y4x' ? ['a1'] : agentId === 'creed-mukyiphw' ? ['c1'] : []
}));
/** The 1.1.91 refusals, about every 2 min per waiting agent, until the log fell silent (~11:55Z). */
function events191(watch, from, to, perAgent) {
  const quietAt = Date.parse('2026-10-18T11:55:00Z');
  const cycle = ['SCREEN_NOT_READY:startup:no-composer', 'reconcile-cooldown', 'lifecycle-unknown', 'in-flight', 'SCREEN_NOT_READY:startup:no-composer', 'reconcile-cooldown'];
  for (let t = Math.max(from, T0); t < Math.min(to, quietAt); t += 2 * MIN) {
    for (const a of ['jim-mtujpe28', 'andy-mtuk4y4x', 'creed-mukyiphw']) {
      const why = cycle[Math.floor((t - T0) / (2 * MIN)) % cycle.length];
      watch.refusal(a, why);
      perAgent?.note(a, why, 1, t);
    }
  }
}

const K = {};

K.replay191 = (W = WS, D = FD) => {
  const per = new W.WakeStallWatch();
  const end = Date.parse('2026-10-18T12:48:19Z');   // the restart that ended it
  const { wakes, ids } = drive(W, D, { from: T0, to: end, at: rows191, events: (w, a, b) => events191(w, a, b, per) });
  assert.equal(per.stalls().length, 0, 'the per-agent watch stays silent on rotating reasons (the 1.1.91 gap)');
  const first = wakes.find((w) => w.items.some((i) => i.id.startsWith('floor-wake-stall:')));
  assert.ok(first, 'THE 1.1.91 FLOOR REACHES GOD');
  assert.ok(first.now - T0 <= 40 * MIN, `god is woken within 40 min of the stall starting, not 83: ${(first.now - T0) / MIN} min`);
  const item = first.items.find((i) => i.id.startsWith('floor-wake-stall:'));
  assert.equal(item.id, `floor-wake-stall:${T0}`, 'THE ID IS THE LAST PROGRESS');
  assert.match(item.line, /3 agents have mail waiting \(jim-mtujpe28 4, andy-mtuk4y4x 1, creed-mukyiphw 1\)/, 'IT NAMES WHO WAITS');
  assert.match(item.line, /most refusals were "SCREEN_NOT_READY:startup:no-composer" \(\d+ of \d+\)/, 'IT NAMES THE DOMINANT REFUSAL');
  assert.equal(ids.size, 1, 'ONE STALL IS ONE DECISION');
  assert.equal(wakes.filter((w) => w.items.some((i) => i.id.startsWith('floor-wake-stall:'))).length, 1, 'ONE STALL WAKES GOD ONCE');
};
test('the 1.1.91 log shape: 3 agents wait, reasons rotate, then the log goes silent: god gets one floor decision', () => K.replay191());

K.quietNight = (W = WS, D = FD) => {
  const from = Date.parse('2026-10-19T00:00:00Z');
  const to = from + 8 * 60 * MIN;
  const silent = (at, events, msg) => {
    const { ids } = drive(W, D, { from, to, at, events });
    assert.equal(ids.size, 0, msg);
  };
  silent(() => LIVE.map((agentId) => ({ agentId, ids: [], deliberate: false })), (w) => { w.refusal('god', 'no-pending-ids'); }, 'AN IDLE NIGHT WITH NO MAIL IS SILENT');
  silent(() => LIVE.map((agentId) => ({ agentId, ids: agentId === 'jim-mtujpe28' ? ['m1', 'm2'] : [], deliberate: false })), undefined, "ONE AGENT'S WAIT IS NOT A FLOOR STALL");
  silent(() => LIVE.map((agentId) => ({ agentId, ids: agentId === 'god' ? [] : ['m1'], deliberate: agentId !== 'god' })), undefined, "A HUMAN'S PAUSE IS NOT A STALL");
  silent(() => LIVE.map((agentId) => ({ agentId, ids: ['inform-1'], deliberate: false })),
    (w) => { for (const a of LIVE) w.refusal(a, 'quiet-held'); }, 'QUIET-HELD MAIL IS NOT A STALL');
};
test('quiet nights stay silent: no mail, one waiting agent, paused agents, quiet-held informs', () => K.quietNight());

K.progress = (W = WS, D = FD) => {
  const from = Date.parse('2026-10-19T09:00:00Z');
  const to = from + 3 * 60 * MIN;
  const stuck = ['jim-mtujpe28', 'andy-mtuk4y4x'];
  const rowsWith = (extra) => (now) => [...stuck.map((agentId) => ({ agentId, ids: ['m1'], deliberate: false })), ...extra(now)];
  const commits = drive(W, D, { from, to, at: rowsWith(() => []),
    events: (w, a, b) => { for (let t = a; t < b; t += MIN) if ((t - from) % (10 * MIN) === 0) w.commit('god', t); } });
  assert.equal(commits.ids.size, 0, 'A COMMIT ELSEWHERE KEEPS THE FLOOR MOVING');
  // Creed's mail is surfaced by hooks (a new id each tick, the old one gone): delivered, so moving.
  const drains = drive(W, D, { from, to, at: rowsWith((now) => [{ agentId: 'creed-mukyiphw', ids: [`c${now}`], deliberate: false }]) });
  assert.equal(drains.ids.size, 0, 'DRAINED MAIL IS PROGRESS');
  // The same floor with nothing moving: a stall, as a control.
  assert.equal(drive(W, D, { from, to, at: rowsWith(() => []) }).ids.size, 1, 'the control stalls');
};
test('progress anywhere keeps it silent: a committed wake, or mail drained by a hook', () => K.progress());

K.nextStall = (W = WS) => {
  const t = Date.parse('2026-10-19T09:00:00Z');
  const w = new W.FloorWakeStallWatch(t);
  const rows = [{ agentId: 'a', ids: ['1'], deliberate: false }, { agentId: 'b', ids: ['2'], deliberate: false }];
  w.sample(rows, t);
  assert.equal(w.stall(t + W.FLOOR_STALL_AFTER_MS - 1), null, 'not before FLOOR_STALL_AFTER_MS');
  assert.equal(w.stall(t + W.FLOOR_STALL_AFTER_MS)?.since, t);
  w.refusal('a', 'in-flight');
  w.commit('c', t + 30 * MIN);   // another agent's wake: a and b still wait
  w.sample(rows, t + 30 * MIN);
  assert.equal(w.stall(t + 49 * MIN), null, 'A COMMIT ENDS THE STALL');
  const next = w.stall(t + 50 * MIN);
  assert.equal(next?.since, t + 30 * MIN, 'THE NEXT STALL IS A NEW DECISION');
  assert.equal(next.refusals, 0, 'refusals are counted from the last progress');
  assert.equal(next.top, null);
};
test('a commit ends the stall; the next one carries a new since (a new decision)', () => K.nextStall());

K.wiring = () => {
  const src = readSource('src/main/index.ts');
  assert.ok(src.includes("if (fields.outcome === 'COMMITTED') floorStalls.commit(String(fields.agentId ?? ''), Date.now());"), 'EVERY COMMITTED SETTLE IS PROGRESS');
  assert.ok(src.includes("if (Number(fields.inboxIds ?? 0) > 0) floorStalls.refusal(String(fields.agentId ?? ''), String(fields.why ?? ''));"), 'A NO-CLAIM IS A REFUSAL');
  assert.ok(src.includes('const ids = mailPendingIds(agentId).filter((id) => !((quiet.get(id) ?? 0) > now));'), 'THE SAMPLE IS THE WAKE PATH\'S OWN PENDING IDS, LESS HELD QUIET MAIL');
  assert.ok(src.includes('return { agentId, ids, deliberate: snap.paused || snap.halted || snap.autoDeliveryPaused };'), 'A HUMAN\'S HOLD IS DELIBERATE');
  assert.ok(src.includes('.filter((id) => !!ptyForAgent(id))'), 'ONLY LIVE AGENTS ARE SAMPLED');
  const fd = readSource(FDF);
  assert.ok(fd.includes('floorStall: (() => { try { return this.host.floorStall?.() ?? null; } catch { return null; } })(),'), 'THE DIGEST ASKS THE HOST, FAIL-SAFE');
};
test('wiring: settles and no-claims feed the watch; the digest samples live agents through mailPendingIds', () => K.wiring());

// ─── MUTANT CENSUS ──────────────────────────────────────────────────────────────────────────

function mutateText(rel, edits, tag) {
  let text = readSource(rel);
  for (const [from, to] of edits) {
    const hits = text.split(from).length - 1;
    assert.equal(hits, 1, `mutant ${tag}: edit target must match EXACTLY ONCE, matched ${hits}: ${JSON.stringify(from.slice(0, 80))}`);
    text = text.replace(from, () => to);
  }
  return text;
}
const MUTANTS = [
  { file: WSF, name: 'no progress gate', edits: [['    if (now - this.progressAt < FLOOR_STALL_AFTER_MS) return null;\n', '']],
    killer: 'progress', dies: /A COMMIT ELSEWHERE KEEPS THE FLOOR MOVING/ },
  { file: WSF, name: 'a commit is not progress', edits: [['  commit(agentId: string, now: number): void {\n    this.progress(now);\n', '  commit(agentId: string, now: number): void {\n']],
    killer: 'progress', dies: /A COMMIT ELSEWHERE KEEPS THE FLOOR MOVING/ },
  { file: WSF, name: 'a drained id is not progress', edits: [['      if (drained) this.progress(now);\n', '']],
    killer: 'progress', dies: /DRAINED MAIL IS PROGRESS/ },
  { file: WSF, name: "a human's pause is ignored", edits: [['const held = r.deliberate || ', 'const held = ']],
    killer: 'quietNight', dies: /A HUMAN'S PAUSE IS NOT A STALL/ },
  { file: WSF, name: 'a quiet-held refusal is ignored', edits: [["const held = r.deliberate || DELIBERATE.has(this.lastWhy.get(r.agentId) ?? '');", 'const held = r.deliberate;']],
    killer: 'quietNight', dies: /QUIET-HELD MAIL IS NOT A STALL/ },
  { file: WSF, name: 'one agent is a floor stall', edits: [['    if (agents.length < FLOOR_STALL_MIN_AGENTS) return null;\n', '    if (agents.length < 1) return null;\n']],
    killer: 'quietNight', dies: /ONE AGENT'S WAIT IS NOT A FLOOR STALL/ },
  { file: WSF, name: "an agent's wait restarts every sample", edits: [['since: before && !drained ? before.since : now', 'since: now']],
    killer: 'replay191', dies: /THE 1\.1\.91 FLOOR REACHES GOD/ },
  { file: WSF, name: 'a commit does not reset the stall', edits: [['  private progress(now: number): void { this.progressAt = now; this.reasons.clear(); }', '  private progress(now: number): void { this.reasons.clear(); }']],
    killer: 'nextStall', dies: /A COMMIT ENDS THE STALL/ },
  { file: FDF, name: 'the digest drops the floor stall', edits: [['  if (input.floorStall) items.unshift(floorStallItem(input.floorStall, now));\n', '']],
    killer: 'replay191', dies: /THE 1\.1\.91 FLOOR REACHES GOD/ },
  { file: FDF, name: 'the item id moves every run', edits: [['    id: `floor-wake-stall:${s.since}`, cardId: null,', '    id: `floor-wake-stall:${now}`, cardId: null,']],
    killer: 'replay191', dies: /THE ID IS THE LAST PROGRESS/ }
];

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  for (const m of MUTANTS) {
    await t.test(`mutant: ${m.name}`, () => {
      const mutated = loadTs.fromText(m.file, mutateText(m.file, m.edits, m.name));
      const args = m.file === WSF ? [mutated, FD] : [WS, mutated];
      assert.throws(() => K[m.killer](...args), (e) => {
        assert.match(String(e && e.message), m.dies, `${m.name}: died for the wrong reason: ${e && e.message}`);
        return true;
      });
    });
  }
});
