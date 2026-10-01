'use strict';
/**
 * ZERO-TOKEN-LIVENESS, PTY slice (design slice 3; Jim L5): CRASHED vs EXITED comes from an
 * EXPLICIT-TEARDOWN MARK set before any harness-requested kill, never from the exit code (a tab
 * kill, a breaker, a worker release and a crash all exit non-zero on Windows/ConPTY). Every
 * incarnation's end reaches the end observer BEFORE its session is removed; a respawn on the same
 * id is a new incarnation that inherits nothing.
 *
 * Hand-built sessions (no node-pty spawn), the input-provenance.test.cjs pattern; `pid` is left
 * undefined so ensureKilled never schedules a real tree kill.
 *
 * Named mutants, each must fail this file:
 *   M8  a marked (requested) teardown is labelled CRASHED
 *   M9  an unmarked non-zero exit is labelled EXITED
 *   M10 output from the dead incarnation after a respawn updates the new incarnation
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const { PtyManager } = loadTs('src/main/pty.ts');
const { AgentLivenessMonitor } = loadTs('src/main/agentLiveness.ts');

const T0 = Date.parse('2026-10-01T12:00:00Z');

function session(id, incarnation, over = {}) {
  const calls = [];
  const s = {
    id, cwd: '.', command: 'x', owner: null, tail: '', hasOutput: false, humanInputGeneration: 0,
    lastOutputAt: T0, spawnedAt: T0, incarnation,
    proc: { pid: undefined, kill: () => calls.push({ kill: true, markedBefore: s.explicitTeardown === true }) },
    ...over
  };
  return { s, calls };
}

/** A PtyManager whose end observer feeds a real liveness monitor for agent `a1`. */
function rig() {
  const m = new PtyManager();
  const ends = [];
  const rows = [];
  let live = null;   // the live session the facts describe (null = none)
  const mon = new AgentLivenessMonitor({
    agents: () => ['a1'],
    facts: () => ({
      agentId: 'a1', registry: { archived: false, onHold: false },
      pty: live ? { ptyId: live.id, incarnation: live.incarnation, spawnedAt: T0 - 3_600_000, lastTrafficAt: 0 } : null,
      wake: { lifecycle: 'idle', provisional: false, activeSince: 0, openTurnId: null, turnStartAt: 0, lastTurnEndAt: 0, lastHookAt: 0, lastHumanNeedsAt: 0 },
      control: { paused: false, halted: false, autoDeliveryPaused: false }, mailWaiting: 0
    }),
    sink: (r) => rows.push(r),
    now: () => T0
  });
  m.setEndObserver((e) => {
    ends.push({ ...e, sessionStillThere: m.sessions.has(e.id) });
    mon.notePtyEnd('a1', { ptyId: e.id, incarnation: e.incarnation, explicit: e.explicit, exitCode: e.exitCode, at: e.at });
  });
  return { m, ends, rows, mon, setLive: (s) => { live = s; } };
}

test('M8: kill() marks the session BEFORE the kill and reports an EXPLICIT end, before the session is removed', () => {
  const r = rig();
  const { s, calls } = session('p', 11);
  r.m.sessions.set('p', s);
  r.setLive(s);
  assert.equal(r.m.kill('p').ok, true);
  assert.deepEqual(calls, [{ kill: true, markedBefore: true }]);
  assert.equal(r.ends.length, 1);
  assert.deepEqual([r.ends[0].explicit, r.ends[0].incarnation, r.ends[0].exitCode, r.ends[0].sessionStillThere], [true, 11, null, true]);
  assert.equal(r.m.sessions.has('p'), false);
  assert.equal(r.mon.getLiveness('a1').classification, 'EXITED');
});

test('killByOwner (a floor window closing) marks every session it kills: their exits are EXITED', () => {
  const r = rig();
  const owner = { id: 'wc' };
  const a = session('p1', 1, { owner }).s;
  const b = session('p2', 2, { owner: { id: 'other' } }).s;
  r.m.sessions.set('p1', a); r.m.sessions.set('p2', b);
  r.m.killByOwner(owner);
  assert.equal(a.explicitTeardown, true);
  assert.notEqual(b.explicitTeardown, true, 'another window\'s terminal is untouched');
  // node-pty's exit for p1 then arrives through the same report the onExit closure makes.
  r.m.reportEnd('p1', a, 1);
  assert.equal(r.ends[0].explicit, true);
});

test('M9: an unmarked exit is CRASHED whatever its code (0, 1, null); the code is kept as evidence', () => {
  for (const code of [1, 0, null]) {
    const r = rig();
    const { s } = session('p', 5);
    r.m.sessions.set('p', s);
    r.setLive(s);
    r.m.reportEnd('p', s, code);
    assert.equal(r.ends[0].explicit, false);
    const rec = r.mon.getLiveness('a1');
    assert.equal(rec.classification, 'CRASHED', `code ${code}`);
    assert.equal(rec.evidence.exitCode, code);
  }
});

test('the natural-exit path reports before it deletes, after its stale-session guard (source pin)', () => {
  const src = codeOnly(readSource('src/main/pty.ts'));
  const onExit = src.slice(src.indexOf('proc.onExit('), src.indexOf('proc.onExit(') + 900);
  const guard = onExit.indexOf('if (this.sessions.get(opts.id) !== session) return;');
  const report = onExit.indexOf('this.reportEnd(opts.id, session, exitCode)');
  const del = onExit.indexOf('this.sessions.delete(opts.id)');
  assert.ok(guard >= 0 && report > guard && del > report, 'guard, then report, then delete');
  // kill(): mark, kill, report, delete.
  const kill = src.slice(src.indexOf('  kill(id: string)'), src.indexOf('  list()'));
  const order = ['s.explicitTeardown = true', 's.proc.kill()', 'this.reportEnd(id, s, null)', 'this.sessions.delete(id)'].map((t) => kill.indexOf(t));
  assert.ok(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])), `kill order ${order}`);
});

test('M10: output from the dead incarnation after a same-id respawn never touches the new one', () => {
  const m = new PtyManager();
  const old = session('p', 1).s;
  const fresh = session('p', 2, { lastOutputAt: T0 + 5000, spawnedAt: T0 + 5000 }).s;
  m.sessions.set('p', fresh);   // the respawn reclaimed the id
  m.deliverData('p', old, 'late bytes from the dead process');
  assert.deepEqual(m.livenessFacts('p'), { incarnation: 2, spawnedAt: T0 + 5000, lastTrafficAt: 0 });
  m.deliverData('p', fresh, 'first frame');
  const f = m.livenessFacts('p');
  assert.equal(f.incarnation, 2);
  assert.ok(f.lastTrafficAt >= T0, 'real output of the live incarnation counts');
});

test('an end observer that throws never breaks a kill', () => {
  const m = new PtyManager();
  m.setEndObserver(() => { throw new Error('observer'); });
  m.sessions.set('p', session('p', 3).s);
  assert.equal(m.kill('p').ok, true);
  assert.equal(m.sessions.has('p'), false);
});
