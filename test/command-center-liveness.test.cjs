'use strict';
/**
 * ZERO-TOKEN-LIVENESS, renderer slice (design "UI and Human choices"; Jim L3): the Command Center
 * liveness chip (src/renderer/src/components/LivenessChip.tsx) renders shared/livenessView.ts, and
 * its offers are click-only. Restart-and-continue and the mail re-offer start model work, so a
 * render, a liveness edge or a periodic sample must never fire them.
 *
 * Named mutants, each must fail this file:
 *   M17 SUSPECT offers a restart
 *   M18 an ARCHIVED record loses its context (last classification, archive reason/time) on the chip
 *   M19 an old incarnation's STUCK badge survives a respawn (a stale snapshot overwrites a newer edge)
 *   M20 reoffer / restart fires on render, on an edge, or from anything but a click
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const V = loadTs('src/shared/livenessView.ts');
const { LivenessChip, LivenessSummary } = loadTs('src/renderer/src/components/LivenessChip.tsx');

const T0 = Date.parse('2026-10-01T12:00:00Z');
const rec = (over = {}) => ({
  agentId: 'a1', incarnation: 'pty-a1#3', lifecycle: 'LIVE', classification: 'IDLE', classifiedSince: T0 - 12 * 60_000,
  reason: 'turn-ended', evidence: { sampledAt: T0 }, ...over
});
const spies = () => {
  const calls = [];
  return { calls, props: { onInspect: () => calls.push('inspect'), onRestartContinue: () => calls.push('restart'), onReoffer: () => calls.push('reoffer') } };
};
const chip = (r, props = {}) => renderToStaticMarkup(React.createElement(LivenessChip, { rec: r, now: T0, ...props }));

test('tones and labels follow the design: busy green, idle neutral, suspect amber, stuck red, crashed red, exited dark', () => {
  const tone = (classification, reason = 'x') => V.livenessChipView(rec({ classification, reason }), T0).tone;
  assert.deepEqual(
    ['BUSY_PROGRESSING', 'IDLE', 'SUSPECT', 'STUCK_WAKE', 'CRASHED', 'EXITED', 'UNKNOWN'].map((c) => tone(c)),
    ['green', 'neutral', 'amber', 'red', 'red', 'dark', 'neutral']);
  const hold = V.livenessChipView(rec({ reason: 'operator-hold' }), T0);
  assert.deepEqual([hold.label, hold.tone], ['on hold', 'neutral']);
  assert.equal(V.livenessChipView(rec(), T0).duration, '12m');
});

test('M17: SUSPECT offers inspect only, never a restart or a re-offer', () => {
  const v = V.livenessChipView(rec({ classification: 'SUSPECT', reason: 'no-progress' }), T0);
  assert.deepEqual(v.actions, ['inspect']);
  const html = chip(rec({ classification: 'SUSPECT', reason: 'no-progress' }), spies().props);
  assert.match(html, />inspect</);
  assert.doesNotMatch(html, /restart|re-offer/);
});

test('offers per state: STUCK after the cap re-offers; STUCK while the WWR recovers only inspects; ended processes restart', () => {
  assert.deepEqual(V.livenessChipView(rec({ classification: 'STUCK_WAKE', reason: 'wwr-max-recoveries' }), T0).actions, ['inspect', 'reoffer']);
  assert.deepEqual(V.livenessChipView(rec({ classification: 'STUCK_WAKE', reason: 'wwr-recovering' }), T0).actions, ['inspect']);
  assert.deepEqual(V.livenessChipView(rec({ classification: 'CRASHED', reason: 'pty-exit-unrequested' }), T0).actions, ['restart-continue']);
  assert.deepEqual(V.livenessChipView(rec({ classification: 'EXITED', lifecycle: 'ARCHIVED', archiveReason: 'pty-exit' }), T0).actions, ['restart-continue']);
  assert.deepEqual(V.livenessChipView(rec({ classification: 'EXITED', lifecycle: 'ARCHIVED', archiveReason: 'explicit' }), T0).actions, [], 'a person archived it on purpose');
  for (const c of ['BUSY_PROGRESSING', 'IDLE', 'UNKNOWN']) assert.deepEqual(V.livenessChipView(rec({ classification: c }), T0).actions, [], c);
});

test('M18: an ARCHIVED record renders neutral and keeps its context: last classification, reason, archive time, incarnation', () => {
  const r = rec({ classification: 'CRASHED', reason: 'pty-exit-unrequested', lifecycle: 'ARCHIVED', archiveReason: 'pty-exit', archivedAt: T0 - 60_000,
    evidence: { sampledAt: T0, processExitAt: T0 - 61_000, exitCode: 3 } });
  const v = V.livenessChipView(r, T0);
  assert.equal(v.tone, 'neutral');
  assert.equal(v.label, 'archived · crashed');
  const detail = v.detail.join('\n');
  for (const want of ['CRASHED (ARCHIVED)', 'reason: pty-exit-unrequested', 'incarnation: pty-a1#3', `archived (pty-exit) at ${new Date(T0 - 60_000).toISOString()}`, 'process exit (code 3) 1m ago']) {
    assert.ok(detail.includes(want), `missing "${want}" in:\n${detail}`);
  }
  assert.match(chip(r), /archived · crashed/);
});

test('M19: a stale snapshot (an old incarnation STUCK) never overwrites a newer record after a respawn', () => {
  const newer = rec({ incarnation: 'pty-a1#4', classification: 'UNKNOWN', reason: 'boot-grace', evidence: { sampledAt: T0 + 5000 } });
  const stale = rec({ incarnation: 'pty-a1#3', classification: 'STUCK_WAKE', reason: 'wwr-max-recoveries', evidence: { sampledAt: T0 } });
  let m = V.applyLivenessUpdate({}, newer);
  m = V.applyLivenessUpdate(m, stale);
  assert.equal(m.a1.incarnation, 'pty-a1#4');
  assert.equal(m.a1.classification, 'UNKNOWN');
  const later = rec({ incarnation: 'pty-a1#4', classification: 'IDLE', evidence: { sampledAt: T0 + 20_000 } });
  assert.equal(V.applyLivenessUpdate(m, later).a1.classification, 'IDLE');
});

test('M20 (behaviour): rendering never calls a handler, whatever the state', () => {
  const s = spies();
  for (const classification of ['BUSY_PROGRESSING', 'IDLE', 'SUSPECT', 'STUCK_WAKE', 'CRASHED', 'EXITED', 'UNKNOWN']) {
    for (const reason of ['wwr-max-recoveries', 'pty-exit-unrequested', 'operator-hold']) {
      chip(rec({ classification, reason }), s.props);
      chip(rec({ classification, reason, lifecycle: 'ARCHIVED', archiveReason: 'pty-exit' }), s.props);
    }
  }
  assert.deepEqual(s.calls, []);
  // The buttons exist and do call their handler, from onClick.
  const el = LivenessChip({ rec: rec({ classification: 'STUCK_WAKE', reason: 'wwr-max-recoveries' }), now: T0, ...s.props });
  const buttons = [];
  const walk = (n) => { if (!n || typeof n !== 'object') return; if (Array.isArray(n)) { n.forEach(walk); return; } if (n.type === 'button') buttons.push(n); walk(n.props?.children); };
  walk(el);
  assert.deepEqual(buttons.map((b) => b.props.children), ['inspect', 're-offer mail']);
  buttons.forEach((b) => b.props.onClick());
  assert.deepEqual(s.calls, ['inspect', 'reoffer']);
});

test('M20 (source): the chip has no effect hook; handlers run only inside onClick; the panel subscription only stores data', () => {
  const chipSrc = codeOnly(readSource('src/renderer/src/components/LivenessChip.tsx'));
  assert.doesNotMatch(chipSrc, /use(Layout)?Effect|setTimeout|setInterval|queueMicrotask/);
  const calls = [...chipSrc.matchAll(/handler\(\)|on(Inspect|RestartContinue|Reoffer)\(/g)];
  assert.equal(calls.length, 1, 'one call site');
  assert.ok(chipSrc.includes('onClick={() => handler()}'));
  const panel = codeOnly(readSource('src/renderer/src/components/CommandCenterPanel.tsx'));
  const effect = panel.slice(panel.indexOf('const [liveness, setLiveness]'), panel.indexOf('window.cth.getConfig().then'));
  assert.ok(effect.includes('onLivenessChange') && effect.includes('livenessSnapshot'));
  assert.doesNotMatch(effect, /restartWithModel|livenessReoffer|requestInboxWake|submit/);
  const reofferUses = [...panel.matchAll(/livenessReoffer\(/g)].map((m) => panel.slice(Math.max(0, m.index - 40), m.index));
  assert.equal(reofferUses.length, 1);
  assert.match(reofferUses[0], /onReoffer=\{\(\) => \{ void window\.cth\.$/);
});

test('the floor summary counts LIVE agents per classification', () => {
  const html = renderToStaticMarkup(React.createElement(LivenessSummary, { records: [
    rec({ agentId: 'a', classification: 'BUSY_PROGRESSING' }), rec({ agentId: 'b', classification: 'BUSY_PROGRESSING' }),
    rec({ agentId: 'c', classification: 'STUCK_WAKE' }), rec({ agentId: 'd', classification: 'CRASHED', lifecycle: 'ARCHIVED', archiveReason: 'pty-exit' })
  ] }));
  assert.match(html, /busy 2 · stuck 1/);
  assert.doesNotMatch(html, /crashed/, 'archived agents are not on the floor');
});
