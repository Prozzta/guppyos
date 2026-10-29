'use strict';
require('./tools/own-job.cjs');
/**
 * WAKE-STUCK-REFUSAL-ESCALATE (1.1.97, 2026-10-21 17:01:50-17:03:08Z): Dwight's terminal kept a
 * stale 'model: loading' header, so every reconcile wake settled REFUSED SCREEN_NOT_READY
 * startup:header-loading with 2 messages waiting, and nothing said so: WakeStallWatch is fed only
 * from no-claims (and every reconcile claim clears it), QuietRefusalWatch counts only
 * output-not-quiet, FloorWakeStallWatch needs two agents, and wakeBreadcrumb folded the repeats
 * into one log row. RefusedSettleWatch (refusedSettleWatch.ts) counts identical refused settles per
 * agent+incarnation from the owner's onOutcome, before folding, and raises once per run: a log row,
 * a floor-digest decision, a board-status flag. It never acts.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');

const WATCH = 'src/main/refusedSettleWatch.ts';
const DIGEST = 'src/main/floorDigest.ts';
const W = loadTs(WATCH);
const FD = loadTs(DIGEST);
const BS = loadTs('src/main/boardStatus.ts');

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 21, 17, 1, 50);
const HEADER = { kind: 'REFUSED', reason: 'SCREEN_NOT_READY', detail: 'startup:header-loading' };
const MODAL = { kind: 'REFUSED', reason: 'SCREEN_NOT_READY', detail: 'MODAL:update' };
const QUIET = { kind: 'REFUSED', reason: 'SCREEN_NOT_READY', detail: 'output-not-quiet' };
const PAUSED = { kind: 'REFUSED', reason: 'INHIBITED', detail: 'paused' };
const COMMITTED = { kind: 'COMMITTED' };
const INC6 = 'pty-dwight-mu32ztys#6';
const INC7 = 'pty-dwight-mu32ztys#7';

function rig(mod = W) {
  const rows = [];
  const watch = new mod.RefusedSettleWatch((row) => rows.push(row));
  let n = 0;
  const feed = (outcome, at, over = {}) => watch.outcome({
    agentId: 'dwight', incarnation: INC6, outcome, at, requestId: `req-${n++}`, inboxIds: 2, ...over
  });
  return { watch, rows, feed, raised: () => rows.filter((r) => r.event === 'raised'), cleared: () => rows.filter((r) => r.event === 'cleared') };
}

/** The watch with one edit (the mutants; loaded from text, never written to the tree). */
function mutant(file, from, to) {
  const src = readSource(file);
  assert.ok(src.includes(from), `mutant anchor missing in ${file}: ${from}`);
  return loadTs.fromText(file, src.replace(from, () => to));
}

// ---------------------------------------------------------------- t1 Dwight's shape
function t1(mod) {
  const r = rig(mod);
  r.feed(HEADER, T0);
  r.feed(HEADER, T0 + MIN);
  assert.equal(r.rows.length, 0, 'two refusals are not yet a run');
  assert.deepEqual(r.watch.stalls(), []);
  r.feed(HEADER, T0 + 2 * MIN, { requestId: 'req-dwight-3' });
  assert.equal(r.raised().length, 1, 'exactly one raised row at the third');
  const row = r.raised()[0];
  assert.deepEqual(row, {
    kind: 'wake-refusal-stuck', event: 'raised', agentId: 'dwight', incarnation: INC6,
    why: 'SCREEN_NOT_READY:startup:header-loading', count: 3, since: T0, requestId: 'req-dwight-3', inboxIds: 2
  });
  const stalls = r.watch.stalls();
  assert.equal(stalls.length, 1);
  assert.equal(stalls[0].count, 3);
  assert.equal(stalls[0].since, T0);
  r.feed(HEADER, T0 + 3 * MIN);
  assert.equal(r.rows.length, 1, 'a fourth refusal adds no row');
  assert.equal(r.watch.stalls()[0].count, 4, 'but the item keeps counting');
}
test('t1 Dwight shape: three identical refused settles 60 s apart with mail waiting raise once, with count 3; the fourth adds nothing', () => t1(W));

// ---------------------------------------------------------------- t2 the time path
function t2(mod) {
  const a = rig(mod);
  a.feed(HEADER, T0);
  a.feed(HEADER, T0 + MIN);
  assert.equal(a.rows.length, 0, 'two refusals a minute apart: not yet');
  const b = rig(mod);
  b.feed(HEADER, T0);
  b.feed(HEADER, T0 + 5 * MIN);
  assert.equal(b.raised().length, 1, 'two refusals 5 min apart raise by time');
  assert.equal(b.raised()[0].count, 2);
  const c = rig(mod);
  c.feed(HEADER, T0);
  assert.equal(c.rows.length, 0, 'one refusal alone never raises');
  assert.deepEqual(c.watch.stalls(), []);
}
test('t2 time path: two refusals 5 min apart raise with count 2; two a minute apart do not; one alone never does', () => t2(W));

// ---------------------------------------------------------------- t3 identity
function t3(mod) {
  const r = rig(mod);
  r.feed(HEADER, T0);
  r.feed(MODAL, T0 + MIN);
  r.feed(HEADER, T0 + 2 * MIN);
  assert.equal(r.raised().length, 0, 'runs of 1, 1, 1: no raise');
  assert.equal(r.cleared().length, 0, 'nothing raised, so nothing to clear');
  r.feed(HEADER, T0 + 3 * MIN);
  r.feed(HEADER, T0 + 4 * MIN);
  assert.equal(r.raised().length, 1, 'three identical in a row from the restart');
  assert.equal(r.raised()[0].since, T0 + 2 * MIN, 'the run began at the restart');
  r.feed(MODAL, T0 + 5 * MIN);
  const c = r.cleared();
  assert.equal(c.length, 1);
  assert.equal(c[0].reason, 'reason-changed');
  assert.equal(c[0].why, 'SCREEN_NOT_READY:startup:header-loading');
  assert.equal(r.watch.stalls().length, 0, 'the new run (count 1) is not raised');
}
test('t3 identity: a different refusal restarts the run; a raised run is cleared reason-changed', () => t3(W));

// ---------------------------------------------------------------- t4 incarnation
function t4(mod) {
  const r = rig(mod);
  r.feed(HEADER, T0, { incarnation: INC6 });
  r.feed(HEADER, T0 + MIN, { incarnation: INC6 });
  r.feed(HEADER, T0 + 2 * MIN, { incarnation: INC7 });
  r.feed(HEADER, T0 + 3 * MIN, { incarnation: INC7 });
  assert.equal(r.rows.length, 0, 'two on #6 then two on #7 is nothing: a restart is progress');
  const s = rig(mod);
  s.feed(HEADER, T0, { incarnation: INC6 });
  s.feed(HEADER, T0 + MIN, { incarnation: INC6 });
  s.feed(HEADER, T0 + 2 * MIN, { incarnation: INC6 });
  assert.equal(s.raised().length, 1);
  s.feed(HEADER, T0 + 3 * MIN, { incarnation: INC7 });
  assert.equal(s.cleared().length, 1);
  assert.equal(s.cleared()[0].reason, 'incarnation');
  assert.equal(s.cleared()[0].incarnation, INC6);
  assert.equal(s.watch.stalls().length, 0);
}
test('t4 incarnation: a new incarnation starts from zero; a raised run on #6 is cleared incarnation when #7 reports', () => t4(W));

// ---------------------------------------------------------------- t5 resets
function t5(mod) {
  const a = rig(mod);
  a.feed(HEADER, T0);
  a.feed(HEADER, T0 + MIN);
  a.feed(COMMITTED, T0 + 2 * MIN);
  assert.equal(a.rows.length, 0, 'COMMITTED on a run not raised: no row');
  a.feed(HEADER, T0 + 3 * MIN);
  a.feed(HEADER, T0 + 4 * MIN);
  assert.equal(a.raised().length, 0, 'the count started again after COMMITTED');
  a.feed(HEADER, T0 + 5 * MIN);
  assert.equal(a.raised().length, 1);
  a.feed(COMMITTED, T0 + 6 * MIN);
  assert.equal(a.cleared().length, 1);
  assert.equal(a.cleared()[0].reason, 'committed');
  assert.equal(a.watch.stalls().length, 0);

  const b = rig(mod);
  b.feed(HEADER, T0); b.feed(HEADER, T0 + MIN); b.feed(HEADER, T0 + 2 * MIN);
  assert.equal(b.raised().length, 1);
  b.feed(HEADER, T0 + 3 * MIN, { inboxIds: 0 });
  assert.equal(b.cleared().length, 1);
  assert.equal(b.cleared()[0].reason, 'drained');
  b.feed(HEADER, T0 + 4 * MIN, { inboxIds: 0 });
  b.feed(HEADER, T0 + 5 * MIN, { inboxIds: 0 });
  b.feed(HEADER, T0 + 6 * MIN, { inboxIds: 0 });
  assert.equal(b.raised().length, 1, 'refusals with no mail pending never count');

  const c = rig(mod);
  c.feed(HEADER, T0); c.feed(HEADER, T0 + MIN); c.feed(HEADER, T0 + 2 * MIN);
  c.feed(PAUSED, T0 + 3 * MIN);
  assert.equal(c.cleared().length, 1);
  assert.equal(c.cleared()[0].reason, 'deliberate');
  c.feed(PAUSED, T0 + 4 * MIN); c.feed(PAUSED, T0 + 5 * MIN); c.feed(PAUSED, T0 + 6 * MIN);
  assert.equal(c.raised().length, 1, 'a deliberate refusal never counts');
  for (const why of ['no-pending-ids', 'halted', 'auto-delivery-paused', 'hitl-hold', 'quiet-held']) {
    const d = rig(mod);
    for (let i = 0; i < 4; i++) d.feed({ kind: 'REFUSED', reason: why }, T0 + i * MIN);
    assert.equal(d.rows.length, 0, `${why} never counts`);
  }

  const e = rig(mod);
  for (let i = 0; i < 4; i++) e.feed(QUIET, T0 + i * MIN);
  assert.equal(e.rows.length, 0, 'output-not-quiet is QuietRefusalWatch\'s, never counted here');
  e.feed(HEADER, T0 + 4 * MIN); e.feed(QUIET, T0 + 5 * MIN); e.feed(HEADER, T0 + 6 * MIN); e.feed(HEADER, T0 + 7 * MIN);
  assert.equal(e.raised().length, 1, 'an output-not-quiet refusal in between neither counts nor resets');
}
test('t5 resets: COMMITTED clears (a row only when raised); no mail clears drained; a deliberate refusal clears and never counts; output-not-quiet never counts', () => t5(W));

// ---------------------------------------------------------------- t6 rate cap
function t6(mod) {
  const r = rig(mod);
  let at = T0;
  for (let cycle = 0; cycle < 4; cycle++) {
    r.feed(HEADER, at); r.feed(HEADER, at + MIN); r.feed(HEADER, at + 2 * MIN);
    assert.equal(r.watch.stalls().length, 1, `the item is present in run ${cycle + 1}`);
    r.feed(COMMITTED, at + 3 * MIN);
    at += 7 * MIN;
  }
  assert.equal(r.raised().length, 3, 'three raised rows in the hour');
  assert.equal(r.rows.filter((x) => x.event === 'capped').length, 1, 'then one capped row');
  assert.equal(r.cleared().length, 4, 'every raised run was cleared, the capped one too');
  r.feed(HEADER, at); r.feed(HEADER, at + MIN); r.feed(HEADER, at + 2 * MIN);
  assert.equal(r.rows.filter((x) => x.event === 'capped').length, 1, 'a fifth run writes nothing more');
  assert.equal(r.watch.stalls().length, 1, 'but is still the digest item');
  const s = rig(mod);
  s.feed(HEADER, T0 + 2 * 60 * MIN, { incarnation: INC7 });
  s.feed(HEADER, T0 + 2 * 60 * MIN + MIN, { incarnation: INC7 });
  s.feed(HEADER, T0 + 2 * 60 * MIN + 2 * MIN, { incarnation: INC7 });
  assert.equal(s.raised().length, 1, 'the cap is per agent+incarnation per hour');
}
test('t6 rate cap: four raise/clear cycles in 30 min write three raised rows and one capped; the item stays', () => t6(W));

// ---------------------------------------------------------------- t7 digest
function t7(fd) {
  const r = rig();
  r.feed(HEADER, T0); r.feed(HEADER, T0 + MIN); r.feed(HEADER, T0 + 2 * MIN);
  const now = T0 + 3 * MIN;
  const stalls = r.watch.stalls().map((s) => ({ ...s, name: 'Dwight' }));
  const items = fd.decisionItems([], [], now, [], [], [], [], stalls);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, `wake-refusal-stuck:dwight:${INC6}:${T0}`);
  assert.equal(items[0].cardId, null);
  assert.equal(items[0].line, 'Dwight: 2 message(s) waiting 3 min; every reconcile wake refused 3 times as "SCREEN_NOT_READY:startup:header-loading" on this terminal (incarnation 6) - read Dwight\'s screen; a stale header or popup needs a person');
  // covered: one decision per agent.
  assert.equal(fd.decisionItems([], [], now, [{ agentId: 'dwight', messages: 1, since: T0 }], [], [], [], stalls).filter((i) => i.id.startsWith('wake-refusal-stuck')).length, 0, 'a held wake covers it');
  assert.equal(fd.decisionItems([], [], now, [], [], [{ agentId: 'dwight', count: 3, since: T0 }], [], stalls).filter((i) => i.id.startsWith('wake-refusal-stuck')).length, 0, 'a quiet stall covers it');
  assert.equal(fd.decisionItems([], [], now, [], [], [], [{ agentId: 'dwight', why: 'x', inboxIds: 2, since: T0 }], stalls).filter((i) => i.id.startsWith('wake-refusal-stuck')).length, 0, 'a wake stall covers it');
  // stable within the run, so god is woken once.
  r.feed(HEADER, T0 + 3 * MIN);
  const again = fd.decisionItems([], [], now + MIN, [], [], [], [], r.watch.stalls());
  assert.equal(again[0].id, items[0].id, 'the id is stable within the run');
  const w1 = fd.decideGodWake(items, { woken: {}, pendingSince: null }, now, 0);
  assert.equal(w1.wake.length, 1);
  const w2 = fd.decideGodWake(again, w1.state, now + MIN, 0);
  assert.equal(w2.wake.length, 0, 'one wake per run');
  // a new run is a new decision.
  r.feed(COMMITTED, T0 + 4 * MIN);
  r.feed(HEADER, T0 + 5 * MIN); r.feed(HEADER, T0 + 6 * MIN); r.feed(HEADER, T0 + 7 * MIN);
  const next = fd.decisionItems([], [], T0 + 8 * MIN, [], [], [], [], r.watch.stalls());
  assert.equal(next.length, 1);
  assert.notEqual(next[0].id, items[0].id, 'a later run has its own id');
  assert.equal(next[0].id, `wake-refusal-stuck:dwight:${INC6}:${T0 + 5 * MIN}`);
  // buildFloorDigest lists it under Decisions needed through refusedSettles.
  const md = fd.buildFloorDigest({ tasks: [], meta: {}, flags: [], ledgerIssues: [], agents: [], now: T0 + 8 * MIN, refusedSettles: r.watch.stalls() }).markdown;
  assert.ok(md.includes(`- [${next[0].id}] dwight: 2 message(s) waiting 3 min;`), md);
}
test('t7 digest: the decision item carries the exact line, is skipped when covered, is stable within a run and new across runs', () => t7(FD));

// ---------------------------------------------------------------- t8 board-status
test('t8 board-status: the Flags section carries the wake-refusal-stuck line while raised and nothing after a clear', () => {
  const r = rig();
  r.feed(HEADER, T0); r.feed(HEADER, T0 + MIN); r.feed(HEADER, T0 + 2 * MIN);
  const now = T0 + 3 * MIN;
  const flags = r.watch.flags(now, (id) => (id === 'dwight' ? 'Dwight' : id));
  assert.equal(flags.length, 1);
  assert.equal(flags[0].kind, 'wake-refusal-stuck');
  assert.equal(flags[0].cardId, '-');
  assert.equal(flags[0].decision, false, 'the digest item is the decision, not the flag');
  const evidence = 'Dwight: 2 message(s) waiting 3 min; every reconcile wake refused 3 times as "SCREEN_NOT_READY:startup:header-loading" on this terminal (incarnation 6) - read Dwight\'s screen; a stale header or popup needs a person';
  const md = BS.renderBoardStatus({ tasks: [], meta: {}, flags, agents: [], appStart: null, now });
  const flagsSection = md.slice(md.indexOf('## Flags'));
  assert.ok(flagsSection.includes(`- wake-refusal-stuck -: ${evidence}`), flagsSection);
  const digest = FD.buildFloorDigest({ tasks: [], meta: {}, flags, ledgerIssues: [], agents: [], now }).markdown;
  assert.ok(digest.slice(digest.indexOf('## Flags')).includes(`- wake-refusal-stuck -: ${evidence}`), 'the digest Flags mirror carries it too');
  assert.ok(!digest.includes('[wake-refusal-stuck -'), 'the flag alone is no decision item');
  r.feed(COMMITTED, T0 + 4 * MIN);
  assert.deepEqual(r.watch.flags(now + MIN), []);
  const after = BS.renderBoardStatus({ tasks: [], meta: {}, flags: r.watch.flags(now + MIN), agents: [], appStart: null, now: now + MIN });
  assert.ok(!after.includes('wake-refusal-stuck'));
});

// ---------------------------------------------------------------- t9 wiring pins
test('t9 wiring: fed from the owner\'s onOutcome (not wakeDiag), the watch cannot type, OutcomeRecord carries incarnation', () => {
  const idx = readSource('src/main/index.ts');
  const call = 'refusedSettles.outcome({ agentId: r.agentId, incarnation: r.incarnation, outcome: r.outcome, at: r.at, requestId: r.requestId, inboxIds: mailPendingIds(r.agentId).length })';
  assert.equal(idx.split('refusedSettles.outcome(').length - 1, 1, 'fed from exactly one place');
  const callAt = idx.indexOf(call);
  assert.ok(callAt > 0, 'the onOutcome feed with the pending-mail count');
  const onOutcomeAt = idx.lastIndexOf('onOutcome: (r) => {', callAt);
  assert.ok(onOutcomeAt > 0 && callAt - onOutcomeAt < 600, 'inside the owner onOutcome handler');
  assert.ok(idx.indexOf('quietRefusals.outcome(', onOutcomeAt) < callAt, 'next to the quiet-refusal watch');
  // Jim P1/P2: the call sits above the COMMITTED branch, with no early return before it, so the
  // watch sees every refusal AND every COMMITTED (which ends a run).
  const before = idx.slice(onOutcomeAt, callAt);
  assert.ok(!before.includes('COMMITTED') && !before.includes('return'), `fed before the COMMITTED branch and any return: ${before}`);
  const diagAt = idx.indexOf("} else if (stage === 'settle') {");
  assert.ok(diagAt > 0);
  assert.ok(!idx.slice(diagAt, diagAt + 800).includes('refusedSettles'), 'the folded wakeDiag hook does not feed it');
  assert.ok(idx.includes('refusedSettles: () => refusedSettles.stalls(refusedLive)'), 'the digest host reads its stalls, pruned by the live floor');
  assert.equal(idx.split('...refusedSettles.flags(Date.now(), agentDisplayName, refusedLive)').length - 1, 2, 'board-status and the digest both get its flags, pruned too');
  assert.ok(idx.includes('pending: (agentId: string) => mailPendingIds(agentId).length'), 'live pending = the same pending-mail count the feed uses');
  assert.ok(idx.includes('return p ? ptyManager.incarnation(p) : undefined;'), 'live incarnation = the PTY manager\'s, as the owner records it');
  const forgetAt = idx.indexOf('try { refusedSettles.forget(agentId); } catch');
  assert.ok(forgetAt > 0 && Math.abs(forgetAt - idx.indexOf('try { workerWake.forget(agentId, id); } catch')) < 300, 'teardownPty forgets the run beside the other watches');

  const watch = readSource(WATCH).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const banned = watch.match(/\b(write|submit|term|send|pty|requeue)\b/gi);
  assert.equal(banned, null, `the watch holds nothing that can act: ${banned}`);
  assert.ok(!watch.includes('setTimeout') && !watch.includes('setInterval') && !watch.includes('Date.now'), 'no clock of its own');
  assert.ok(watch.includes("import { DELIBERATE } from './wakeStall'"), 'one deliberate set, shared with wakeStall');

  const owner = readSource('src/main/automaticSubmit.ts');
  const rec = owner.slice(owner.indexOf('export interface OutcomeRecord {'));
  assert.ok(rec.slice(0, rec.indexOf('}')).includes('incarnation: unknown;'), 'OutcomeRecord carries incarnation');
  const emits = owner.split('onOutcome?.(').slice(1);
  assert.equal(emits.length, 4, 'four emit sites');
  for (const e of emits) assert.ok(e.slice(0, e.indexOf('});') + 3).includes('incarnation:'), `every emit site fills it: ${e.slice(0, 120)}`);

  const digest = readSource(DIGEST);
  assert.ok(digest.includes("refusedSettles: (() => { try { return this.host.refusedSettles?.() ?? []; } catch { return []; } })()"), 'run() collects it like the other watches');
  assert.ok(readSource('src/shared/boardStale.ts').includes("| 'wake-refusal-stuck';"), 'the flag kind is pinned (cardId stays a string: the flag uses \'-\')');
});

// ---------------------------------------------------------------- t10-t12 the clear path (Jim SHOULD1)
function raisedRig(mod) {
  const r = rig(mod);
  r.feed(HEADER, T0); r.feed(HEADER, T0 + MIN); r.feed(HEADER, T0 + 2 * MIN);
  assert.equal(r.raised().length, 1);
  return r;
}
const live = (pending, incarnation = INC6) => ({ pending: () => pending, incarnation: () => incarnation });

function t10(mod) {
  const r = raisedRig(mod);
  r.watch.forget('other');
  assert.equal(r.watch.stalls().length, 1, 'another agent\'s teardown is not Dwight\'s');
  r.watch.forget('dwight');
  assert.deepEqual(r.watch.stalls(), [], 'the PTY went: the run went with it');
  assert.equal(r.cleared().length, 1);
  assert.equal(r.cleared()[0].reason, 'forget');
  r.watch.forget('dwight');
  assert.equal(r.rows.length, 2, 'a second forget writes nothing');
}
test('t10 forget: teardown ends the run with one cleared row', () => t10(W));

function t11(mod) {
  const r = raisedRig(mod);
  const two = T0 + 120 * MIN;
  assert.equal(r.watch.stalls(live(2)).length, 1, 'mail still waiting on the same incarnation: the item stays');
  assert.equal(r.watch.flags(two, undefined, live(2)).length, 1);
  assert.equal(r.rows.length, 1);
  assert.deepEqual(r.watch.flags(two, undefined, live(0)), [], 'a person typed, the agent read its mail, no outcome ever came: the flag drops');
  assert.equal(r.cleared().length, 1);
  assert.equal(r.cleared()[0].reason, 'drained');
  assert.deepEqual(r.watch.stalls(live(0)), [], 'and stays down');
  assert.equal(r.rows.length, 2, 'one cleared row');
}
test('t11 read-time prune: no mail pending clears a raised run without an outcome', () => t11(W));

function t12(mod) {
  const r = raisedRig(mod);
  assert.equal(r.watch.stalls(live(2, INC6)).length, 1);
  assert.deepEqual(r.watch.stalls(live(2, INC7)), [], 'the PTY was relaunched: incarnation 7 is not the run\'s');
  assert.equal(r.cleared()[0].reason, 'incarnation');
  const r2 = raisedRig(mod);
  assert.deepEqual(r2.watch.stalls({ pending: () => 2, incarnation: () => undefined }), [], 'no live PTY at all: the run cannot be re-asked');
  assert.equal(r2.cleared()[0].reason, 'incarnation');
  const r3 = raisedRig(mod);
  assert.equal(r3.watch.stalls().length, 1, 'a read with no live probe prunes nothing (the tests above)');
}
test('t12 read-time prune: a live incarnation that is not the run\'s clears it', () => t12(W));

// ---------------------------------------------------------------- mutants
const MUTANTS = [
  { name: 'M1 threshold 3 -> 1', file: WATCH, from: 'export const REFUSED_SETTLE_ALERT_AFTER = 3;', to: 'export const REFUSED_SETTLE_ALERT_AFTER = 1;', killers: { t1, t3 } },
  { name: 'M2 incarnation dropped from the key', file: WATCH, from: "if (cur && cur.incarnation !== incarnation) { this.end(cur, 'incarnation'); cur = undefined; }", to: '', killers: { t4 } },
  { name: 'M3 identity compare dropped', file: WATCH, from: "if (cur && cur.why !== why) { this.end(cur, 'reason-changed'); cur = undefined; }", to: '', killers: { t3 } },
  { name: 'M4 raised flag never set', file: WATCH, from: 'run.raised = true;', to: '', killers: { t1 } },
  { name: 'M5 time path ignores its guard', file: WATCH, from: 'const byTime = cur.count >= 2 && at - cur.since >= REFUSED_SETTLE_ALERT_MS;', to: 'const byTime = cur.count >= 2;', killers: { t2 } },
  { name: 'M6 COMMITTED reset removed', file: WATCH, from: "if (outcome.kind === 'COMMITTED') { if (cur) this.end(cur, 'committed'); return; }", to: "if (outcome.kind === 'COMMITTED') return;", killers: { t5 } },
  { name: 'M7 cap removed', file: WATCH, from: 'if (recent.length >= REFUSED_SETTLE_RAISE_CAP) {', to: 'if (false) {', killers: { t6 } },
  { name: 'M8 digest id without since', file: DIGEST, from: 'id: `wake-refusal-stuck:${r.agentId}:${r.incarnation}:${r.since}`', to: 'id: `wake-refusal-stuck:${r.agentId}:${r.incarnation}`', killers: { t7 } },
  { name: 'M9 forget is a no-op', file: WATCH, from: "if (cur) this.end(cur, 'forget');", to: 'void cur;', killers: { t10 } },
  { name: 'M10 prune ignores pending mail', file: WATCH, from: "if (live.pending(run.agentId) <= 0) { this.end(run, 'drained'); continue; }", to: '', killers: { t11 } },
  { name: 'M11 prune ignores the live incarnation', file: WATCH, from: "if (incarnationKey(live.incarnation(run.agentId)) !== run.incarnation) this.end(run, 'incarnation');", to: '', killers: { t12 } }
];

for (const m of MUTANTS) {
  test(`mutant ${m.name} is killed by ${Object.keys(m.killers).join(', ')}`, () => {
    const mod = mutant(m.file, m.from, m.to);
    for (const [name, killer] of Object.entries(m.killers)) {
      assert.throws(() => killer(mod), `${name} must go red under ${m.name}`);
    }
  });
}
