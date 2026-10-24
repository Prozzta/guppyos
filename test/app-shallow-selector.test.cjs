/**
 * APP-SHALLOW-SELECTOR (ACTIVITY-LAG-151 fix 4, god's card): App.tsx no longer subscribes to the
 * whole `agents` array, and the heavy always-mounted children are memo'd, so a real tick on an
 * agent you are not looking at (status/action/progress/contextTokens: what every hook and parser
 * write does all day) renders App ZERO times instead of re-rendering the whole tree.
 *
 *   RENDERED  the real App in the Electron harness, renders counted per component (DevTools
 *             fiber walk, see scenarios/render-counter.ts): N ticks on a non-selected agent
 *             cost App/floor/strip/panels 0 renders; N ticks on the SELECTED agent still render
 *             App N times (the counter is live; the detail panel follows its agent); adding an
 *             agent still renders App (the count selector is live).
 *   U         the selectors, against the real store, pin exactly when they change.
 *   STATIC    App.tsx carries no whole-array subscription; the effects key on the roster key;
 *             each listed component is `memo(function Name(`.
 *
 * Single file: `node test/tools/run-tests.cjs app-shallow-selector`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readSource, codeOnly } = require('./read-source.cjs');
const { runScenario } = require('./electron-harness/run.cjs');

const scenario = path.join(__dirname, 'electron-harness', 'scenarios', 'app-shallow-renders.tsx');
let run;
const result = () => (run ??= runScenario(scenario, { timeoutMs: 180_000 }));

test('RENDERED: N real ticks on a NON-selected agent render App and its memo children 0 times', async (t) => {
  const r = await result();
  assert.equal(r.ok, true, r.error);
  if (r.settled) t.diagnostic(`census settled in ${r.settled.ms} ms; late renders before phase A: ${JSON.stringify(r.settled.late)}`);
  assert.equal(r.floorMounted, true, 'the real floor (a canvas) must be mounted: this measures the live tree');
  const a = r.phaseA;
  assert.equal(a.App, 0, `App rendered ${a.App} times for ${r.N} ticks on another agent (raw: ${JSON.stringify(r.rawA)})`);
  // The memo'd children App used to drag along. (AgentStrip, CapacityDetailPanel and
  // TaskDetailOverlay subscribe to the whole array themselves and still render per tick: that is
  // PERF-151-NITS, a separate card; they are reported in rawA, not asserted here.)
  for (const k of ['OfficeFloor', 'CapacityStrip', 'MemoryPanel', 'UpdateBadge', 'CapacityLimitBanner', 'AgentDetailPanel']) {
    assert.equal(a[k], 0, `${k} rendered ${a[k]} times for ticks on another agent (raw: ${JSON.stringify(r.rawA)})`);
  }
});

test('RENDERED (control): N ticks on the SELECTED agent render App N times, the floor still 0', async () => {
  const r = await result();
  assert.equal(r.ok, true, r.error);
  const b = r.phaseB;
  // One render per tick (selectedAgent delivers a fresh object), plus at most a couple from
  // App-local state (layout/height effects), never one more per tick.
  assert.ok(b.App >= r.N && b.App <= r.N + 2, `the counter must be live: App should render once per real change of its selected agent, got ${b.App} for ${r.N} (raw: ${JSON.stringify(r.rawB)})`);
  assert.ok(b.AgentDetailPanel >= r.N && b.AgentDetailPanel <= r.N + 2, `the detail panel follows its agent prop (got ${b.AgentDetailPanel})`);
  assert.equal(b.OfficeFloor, 0, 'the floor is memo: an App render must not re-render it');
  assert.equal(b.CapacityStrip, 0, 'the strip is memo: an App render must not re-render it');
  assert.equal(b.MemoryPanel, 0, 'the memory panel is memo');
});

test('RENDERED: adding an agent still renders App (the count selector is live)', async () => {
  const r = await result();
  assert.equal(r.ok, true, r.error);
  assert.ok(r.phaseC.App >= 1, `App must render when the roster changes (got ${r.phaseC.App})`);
});

test('U: the selectors change exactly when the roster changes', async () => {
  const r = await result();
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.pins, {
    countSame: true, keySameOnTick: true, keyOnAdd: true, keyOnRemove: true, keyOnReorder: true,
    keyOnPty: true, keyOnIdSwap: true, countOnAdd: true
  });
});

test('STATIC: App.tsx has no whole-array subscription and keys its effects on the roster key', () => {
  const app = codeOnly(readSource('src/renderer/src/App.tsx'));
  assert.doesNotMatch(app, /useStore\(\s*\(?s\)?\s*=>\s*s\.agents\s*\)/, 'App must not subscribe to the whole agents array');
  assert.match(app, /useStore\(selectAgentCount\)/);
  assert.match(app, /useStore\(selectRosterPtyKey\)/);
  assert.match(app, /acquireTerminal\(a\.ptyId\);\s*\}, \[rosterPtyKey\]\);/, 'the terminal pre-warm effect keys on the roster key');
  assert.match(app, /restoreFocusMode\(\);\s*\}, \[config\?\.onboardingComplete, rosterPtyKey\]\);/, 'the focus-mode restore effect keys on the roster key');
  const store = codeOnly(readSource('src/renderer/src/store/store.ts'));
  assert.match(store, /export function selectAgentCount\(s: State\): number \{\s*return s\.agents\.length;/);
  assert.match(store, /export function selectRosterPtyKey\(s: State\): string \{\s*return s\.agents\.map\(a => a\.id \+ ':' \+ \(a\.ptyId \?\? ''\)\)\.join\('\|'\);/);
});

test('STATIC: the always-mounted children are memo(function Name(', () => {
  const files = {
    OfficeFloor: 'src/renderer/src/scene/office/OfficeFloor.tsx',
    MemoryPanel: 'src/renderer/src/components/MemoryPanel.tsx',
    CapacityStrip: 'src/renderer/src/components/CapacityStrip.tsx',
    CapacityDetailPanel: 'src/renderer/src/components/CapacityDetailPanel.tsx',
    CapacityLimitBanner: 'src/renderer/src/components/CapacityLimitBanner.tsx',
    TaskDetailOverlay: 'src/renderer/src/components/TaskDetailOverlay.tsx',
    UpdateBadge: 'src/renderer/src/components/UpdateBadge.tsx',
    AgentStrip: 'src/renderer/src/components/AgentStrip.tsx',
    AgentDetailPanel: 'src/renderer/src/components/AgentDetailPanel.tsx'
  };
  for (const [name, file] of Object.entries(files)) {
    const src = codeOnly(readSource(file));
    assert.match(src, new RegExp(`export const ${name} = memo\\(function ${name}\\(`), `${file} must export a memo'd ${name}`);
    assert.doesNotMatch(src, new RegExp(`export function ${name}\\(`), `${file} must not also export a bare ${name}`);
  }
});
