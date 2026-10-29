/**
 * PERF-151-NITS (god's card, after APP-SHALLOW-SELECTOR): the last whole-`agents` subscribers that
 * are always mounted (AgentStrip, CapacityDetailPanel, TaskDetailOverlay) now key on primitives,
 * the two Jim nits N2/N3 are fixed and proven rendered, and the dead TerminalView.tsx is gone.
 *
 *   RENDERED  the real App in the Electron harness, renders counted per component (DevTools fiber
 *             walk, scenarios/render-counter.ts): N ticks on a non-selected agent cost the strip,
 *             the capacity detail and the task detail 0 renders, and only THAT agent's card entry
 *             renders N times; an open task detail still costs 0 per tick and 1 per rename.
 *   U         the id/name selectors, against the real store, pin exactly when they change.
 *   N2        control strip: a thrown control shows a wrapped, dismissable error that does not
 *             self-clear; a confirmation still clears itself. Composer: a Free Flow error wraps
 *             and dismisses.
 *   N3        at the 320 px splitter minimum with a 2-deep queue and a long display name, the
 *             status clips (scrollWidth > clientWidth) and every control, "clear all" included,
 *             lies within the row.
 *   STATIC    selectors in store.ts; no whole-array subscription in the three files;
 *             TerminalView.tsx absent; recorder exports clearError; the strip keeps 'ok' flashes
 *             on a timer only and carries the dismiss button.
 *
 * Single file: `node test/tools/run-tests.cjs perf-151-nits`.
 */
require('./tools/own-job.cjs');
// MUTANT-JOURNAL-GATE (god 5cc045/ed8032): this suite loads a file a census mutates in place (one load-ts never sees);
// refuse a tree a killed census left mutated, before anything is read.
require('./tools/mutant-runner-helper.cjs').gate(__filename);
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readSource, codeOnly } = require('./read-source.cjs');
const { runScenario } = require('./electron-harness/run.cjs');

const scenario = path.join(__dirname, 'electron-harness', 'scenarios', 'perf-151-nits.tsx');
let run;
const result = () => (run ??= runScenario(scenario, { timeoutMs: 180_000 }));

test('RENDERED: N ticks on a NON-selected agent render the strip, capacity detail and task detail 0 times', async () => {
  const r = await result();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.floorMounted, true, 'the real floor (a canvas) must be mounted: this measures the live tree');
  const a = r.phaseA;
  for (const k of ['App', 'AgentStrip', 'CapacityDetailPanel', 'TaskDetailOverlay', 'OfficeFloor', 'CapacityStrip']) {
    assert.equal(a[k], 0, `${k} rendered ${a[k]} times for ${r.N} ticks on another agent (raw: ${JSON.stringify(r.rawA)})`);
  }
  // Only the ticked agent's entry follows its agent: N StripAgent renders, N AgentCard renders
  // (used to be N per card, 2N for the two non-god cards).
  assert.equal(a.StripAgent, r.N, `exactly the ticked agent's StripAgent must render per tick (got ${a.StripAgent}; raw: ${JSON.stringify(r.rawA)})`);
  assert.equal(a.AgentCard, r.N, `only the ticked agent's card may render (got ${a.AgentCard} for ${r.N} ticks; raw: ${JSON.stringify(r.rawA)})`);
});

test('RENDERED: an OPEN task detail costs 0 per tick and renders on a rename', async () => {
  const r = await result();
  assert.equal(r.ok, true, r.error);
  assert.equal(r.tOpenTicks.TaskDetailOverlay, 0, `open task detail rendered ${r.tOpenTicks.TaskDetailOverlay} times for ticks (${JSON.stringify(r.tOpenTicks)})`);
  assert.ok(r.tRename.TaskDetailOverlay >= 1, `a rename changes the name key, so the open detail must render (got ${r.tRename.TaskDetailOverlay})`);
  assert.ok(r.tRename.AgentStrip === 0, `a rename does not change the id key, the strip itself stays put (got ${r.tRename.AgentStrip})`);
});

test('U: the id/name selectors change exactly when the roster or a name changes', async () => {
  const r = await result();
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.pins, {
    idSameOnTick: true, idSameOnRename: true, idOnAdd: true, idOnRemove: true, idOnReorder: true,
    nameSameOnTick: true, nameOnRename: true, nameOnAdd: true
  });
});

test('N2 (control strip): a thrown control shows a wrapped, dismissable error that stays; an ok flash self-clears', async () => {
  const r = await result();
  assert.equal(r.ok, true, r.error);
  const n = r.n2;
  assert.equal(n.stopBtnFound, true, 'the live worker must show its control strip with the stop button');
  assert.equal(n.errShown, true, 'a thrown control must show [data-control-flash="error"]');
  assert.equal(n.errInfo.role, 'alert');
  assert.match(n.errInfo.text, /stop after this step failed: the control socket/, `the full reason is shown (${n.errInfo.text})`);
  assert.equal(n.errInfo.whiteSpace, 'normal', 'the error wraps (no nowrap/ellipsis)');
  assert.ok(n.errInfo.height > 2 * parseFloat(n.errInfo.lineHeight) * 0.9, `a long error must wrap past one line (height ${n.errInfo.height}, line-height ${n.errInfo.lineHeight})`);
  assert.equal(n.errInfo.hasDismiss, true, 'the error carries a dismiss button');
  assert.equal(n.errStillShownAfter2s5, true, 'an error is kept until dismissed, not cleared on the 1.8 s timer');
  assert.equal(n.errAfterDismiss, false, 'dismiss removes the error');
  assert.ok(n.okInfo, 'a successful control still flashes [data-control-flash="ok"]');
  assert.equal(n.okInfo.role, 'status');
  assert.equal(n.okInfo.whiteSpace, 'nowrap', 'a confirmation stays on one line');
  assert.equal(n.okAfter2s, false, 'an ok flash clears itself');
});

test('N2 (composer): a Free Flow error wraps and dismisses', async () => {
  const r = await result();
  assert.equal(r.ok, true, r.error);
  const n = r.n2;
  assert.ok(n.ffInfo, 'a recorder error must show [data-ff-hint="error"]');
  assert.equal(n.ffInfo.role, 'alert');
  assert.equal(n.ffInfo.whiteSpace, 'normal', 'the voice error wraps');
  assert.equal(n.ffInfo.hasDismiss, true);
  assert.equal(n.ffAfterDismiss, false, 'dismiss clears the recorder error and the hint');
});

test('N3: at the 320 px splitter minimum a long status clips inside the row and "clear all" stays inside it', async () => {
  const r = await result();
  assert.equal(r.ok, true, r.error);
  const n = r.n3;
  assert.equal(n.sidebarWidth, 320);
  assert.ok(n.rowRect && n.rowRect.width > 0, 'the composer fixed row is mounted');
  assert.ok(n.rowChildren.length >= 4, `expected the label, the count, the status and "clear all" (got ${JSON.stringify(n.rowChildren)})`);
  const status = n.rowChildren.find((c) => c.isStatus);
  const clearAll = n.rowChildren.find((c) => /clear all/.test(c.text));
  assert.ok(status, `the status names the agent (got ${JSON.stringify(n.rowChildren)})`);
  assert.ok(clearAll, 'the 2-deep queue shows "clear all"');
  // The long name makes the status wider than the space it gets: it must be the element that
  // gives (clipped with an ellipsis), which is what minWidth: 0 on it and on the row buys.
  assert.ok(status.scrollWidth > status.clientWidth, `the status must be clipped, not laid out at full width (scrollWidth ${status.scrollWidth}, clientWidth ${status.clientWidth}; ${JSON.stringify(n)})`);
  // A shrunk box with visible overflow would paint the name over "clear all": the clipping must
  // be real (overflow hidden, ellipsis), not just a narrow box.
  assert.equal(status.overflowX, 'hidden', `the status must clip its overflow (${JSON.stringify(status)})`);
  assert.equal(status.textOverflow, 'ellipsis', `the clipped status must show an ellipsis (${JSON.stringify(status)})`);
  for (const c of n.rowChildren) {
    assert.ok(c.width > 0, `${c.tag} "${c.text}" collapsed to zero width (${JSON.stringify(n)})`);
    assert.ok(c.left >= n.rowRect.left - 0.5 && c.right <= n.rowRect.right + 0.5, `${c.tag} "${c.text}" spills past the row (${JSON.stringify(c)} vs ${JSON.stringify(n.rowRect)})`);
  }
  assert.ok(clearAll.right <= n.rowRect.right + 0.5 && clearAll.width > 0, '"clear all" stays inside the row');
});

test('STATIC: the selectors live in store.ts and the three components no longer subscribe to the whole array', () => {
  const store = codeOnly(readSource('src/renderer/src/store/store.ts'));
  assert.match(store, /export function selectAgentIdKey\(s: State\): string \{\s*return s\.agents\.map\(a => a\.id\)\.join\('\|'\);/);
  assert.match(store, /export function selectAgentNameKey\(s: State\): string \{\s*return s\.agents\.map\(a => a\.id \+ ':' \+ a\.name\)\.join\('\|'\);/);
  assert.match(store, /export function agentNameOf\(id: string\): string \| undefined \{/);
  const files = {
    AgentStrip: 'src/renderer/src/components/AgentStrip.tsx',
    CapacityDetailPanel: 'src/renderer/src/components/CapacityDetailPanel.tsx',
    TaskDetailOverlay: 'src/renderer/src/components/TaskDetailOverlay.tsx'
  };
  for (const [name, file] of Object.entries(files)) {
    const src = codeOnly(readSource(file));
    assert.doesNotMatch(src, /useStore\(\s*\(?s\)?\s*=>\s*s\.agents\s*\)/, `${name} must not subscribe to the whole agents array`);
    assert.match(src, new RegExp(`export const ${name} = memo\\(function ${name}\\(`));
  }
  const strip = codeOnly(readSource(files.AgentStrip));
  assert.match(strip, /useStore\(selectAgentIdKey\)/);
  assert.match(strip, /function StripAgent\(\{ id, children \}/, 'each card entry subscribes to its own agent');
  assert.match(strip, /useStore\(s => s\.agents\.find\(x => x\.id === id\)\)/);
  assert.match(codeOnly(readSource(files.CapacityDetailPanel)), /selectAgentNameKey\(s\)/);
  assert.match(codeOnly(readSource(files.TaskDetailOverlay)), /selectAgentNameKey\(s\)/);
});

test('STATIC: the dead TerminalView.tsx is gone and nothing imports it', () => {
  const root = path.join(__dirname, '..');
  assert.equal(fs.existsSync(path.join(root, 'src/renderer/src/components/TerminalView.tsx')), false, 'TerminalView.tsx must be removed');
  const walk = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out); else if (/\.(tsx?|cjs|mjs|js)$/.test(e.name)) out.push(p);
    }
    return out;
  };
  for (const f of walk(path.join(root, 'src'))) {
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /from ['"][^'"]*\/TerminalView['"]/, `${path.relative(root, f)} still imports TerminalView`);
  }
});

test('STATIC: N2 wiring in AgentControlStrip, MessageQueueComposer and the recorder', () => {
  const strip = codeOnly(readSource('src/renderer/src/components/AgentControlStrip.tsx'));
  assert.match(strip, /kind === 'ok' \? setTimeout\(\(\) => setNote\(null\), 1800\) : null/, 'only ok flashes are on a timer');
  assert.match(strip, /data-control-flash=\{note\.kind\}/);
  assert.match(strip, /aria-label="Dismiss this error"/);
  assert.match(strip, /failed\('stop after this step', e\)/);
  const composer = codeOnly(readSource('src/renderer/src/components/MessageQueueComposer.tsx'));
  assert.match(composer, /data-ff-hint=\{ffIsError \? 'error' : 'progress'\}/);
  assert.match(composer, /aria-label="Dismiss this voice error"/);
  assert.match(composer, /freeflowRecorder\.clearError\(\)/);
  const rec = codeOnly(readSource('src/renderer/src/freeflow/recorder.ts'));
  assert.match(rec, /function clearError\(\): void \{\s*setState\(\{ error: null \}\);/);
  assert.match(rec, /clearError \}/);
});

// INT 1.1.102: both render-census scenarios hold off the demo loop by its period (1800 ms). Pin the
// period and that no other renderer setInterval uses it, so the hold cannot drift or catch another timer.
test('PIN: the scenarios hold off the demo loop by its period, and only it ticks at 1800 ms', () => {
  const mock = codeOnly(readSource('src/renderer/src/store/mockEvents.ts'));
  assert.match(mock, /const TICK_MS = 1800;/, 'the demo loop period the scenarios hold off');
  assert.match(mock, /window\.setInterval\([\s\S]*?\}, TICK_MS\)/, 'the demo loop is a setInterval at TICK_MS');
  for (const s of ['perf-151-nits.tsx', 'app-shallow-renders.tsx']) {
    assert.match(readSource('test/electron-harness/scenarios/' + s), /window\.setInterval = \(\(fn: TimerHandler, ms\?: number, \.\.\.rest: unknown\[\]\) => \(ms === 1800 \? 0 :/, s + ' holds off the demo loop');
  }
  const hits = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.tsx?$/.test(e.name) && !/\.test\./.test(e.name) && /setInterval\((?:(?!setInterval|setTimeout)[\s\S]){0,400}?,\s*(?:1800|1_800)\s*\)/.test(fs.readFileSync(p, 'utf8'))) hits.push(path.relative(path.join(__dirname, '..'), p).split(path.sep).join('/')); } };
  walk(path.join(__dirname, '..', 'src', 'renderer', 'src'));
  assert.deepEqual(hits, [], 'no renderer setInterval at a literal 1800 ms (the scenarios would hold it off too)');
});
