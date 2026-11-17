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
require('./tools/own-job.cjs');
// MUTANT-JOURNAL-GATE (god 5cc045/ed8032): this suite loads a file a census mutates in place (one load-ts never sees);
// refuse a tree a killed census left mutated, before anything is read.
require('./tools/mutant-runner-helper.cjs').gate(__filename);
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { readSource, codeOnly } = require('./read-source.cjs');
const loadTs = require('./load-ts.cjs');
const { runScenario } = require('./electron-harness/run.cjs');

const scenario = path.join(__dirname, 'electron-harness', 'scenarios', 'app-shallow-renders.tsx');
let run;
const result = () => (run ??= runScenario(scenario, { timeoutMs: 180_000 }));

test('RENDERED: N real ticks on a NON-selected agent render App and its memo children 0 times', async (t) => {
  const r = await result();
  assert.equal(r.ok, true, r.error);
  // APP-SHALLOW-LATE-RENDER-107: the once-at-startup render the scenario waits for by name.
  if (r.resized) t.diagnostic(`first resize answer ${r.resized.ms} ms after the selection; it rendered: ${JSON.stringify(r.resized.causes)}`);
  if (r.strayA) t.diagnostic(`phase A ran ${r.strayA.fromMs}..${r.strayA.toMs} ms; renders not per tick, with their cause: ${JSON.stringify(r.strayA.causes)}`);
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

// APP-SHALLOW-LATE-RENDER-107. Two late renders used to land in phase A under load:
//   1. the detail panel's first resize answer (once at startup): the scenario waits for it by name;
//   2. the integrity banner, every 2 s for good: a product fault, a poll with no news now keeps its state.
test('RENDERED: phase A starts after the first resize answer, and nothing but the ticks renders in it', async () => {
  const r = await result();
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.strayA.causes, [], 'A RENDER IN PHASE A THAT NO TICK CAUSED');
  for (const c of r.resized.causes) {
    assert.ok(c.hooks.length > 0 && c.props.length === 0, `the first resize answer renders from the component's own width state, got ${JSON.stringify(c)}`);
  }
  const sc = readSource('test/electron-harness/scenarios/app-shallow-renders.tsx');
  assert.match(sc, /selectedId: 'a1' \} as never\); \}\);\s*await firstResize\(host\);/, 'THE SCENARIO WAITS FOR THE FIRST RESIZE ANSWER BY NAME, RIGHT AFTER THE SELECTION');
});

const K = {};
K.sameIssues = (B) => {
  const one = { file: 'tasks.json', error: 'bad', quarantine: 'q1' };
  assert.equal(B.sameIssues([], []), true, 'AN EMPTY POLL ANSWER IS THE LIST ALREADY SHOWN');
  assert.equal(B.sameIssues([one], [{ ...one }]), true, 'the same issue in a fresh object is the same list');
  assert.equal(B.sameIssues([], [one]), false, 'A NEW ISSUE IS NEWS');
  assert.equal(B.sameIssues([one], []), false, 'a cleared issue is news');
  for (const [field, value] of [['file', 'x'], ['error', 'worse'], ['quarantine', 'q2'], ['repaired', true], ['notice', 'n'], ['title', 't'], ['details', 'd'], ['raisedAt', 5]]) {
    assert.equal(B.sameIssues([one], [{ ...one, [field]: value }]), false, `A CHANGED ${field} IS NEWS`);
  }
};
K.bannerKeepsState = (src) => {
  assert.match(src, /if \(alive\) setIssues\(\(shown\) => \(sameIssues\(shown, list\) \? shown : list\)\);/, 'A POLL WITH NO NEWS KEEPS THE BANNER STATE');
  assert.doesNotMatch(src, /setIssues\(list\)/);
};
const BANNER_TS = 'src/shared/integrityBanner.ts';
const BANNER_TSX = 'src/renderer/src/components/IntegrityRepairBanner.tsx';
test('U: a poll answer equal to the list shown is not news (every shown field compared)', () => K.sameIssues(loadTs(BANNER_TS)));
test('STATIC: the integrity banner keeps its state for a poll with no news', () => K.bannerKeepsState(readSource(BANNER_TSX)));

test('MUTANT CENSUS: each banner guarantee has a mutant that dies', () => {
  const ts = readSource(BANNER_TS);
  const tsx = readSource(BANNER_TSX);
  const swap = (text, from, to) => { assert.ok(text.includes(from), `mutant target missing: ${from}`); return text.replace(from, to); };
  const dies = (fn, re, name) => assert.throws(fn, re, `MUTANT LIVED: ${name}`);
  dies(() => K.sameIssues(loadTs.fromText(BANNER_TS, swap(ts, 'a.length === b.length && ', ''))), /A NEW ISSUE IS NEWS/, 'length not compared');
  for (const [field, expr] of [['file', 'i.file, '], ['raisedAt', ', i.raisedAt ?? null'], ['error', 'i.error, '], ['quarantine', 'i.quarantine ?? null, '], ['repaired', 'i.repaired === true, '], ['notice', 'i.notice ?? null, '], ['title', 'i.title ?? null, '], ['details', 'i.details ?? null, ']]) {
    dies(() => K.sameIssues(loadTs.fromText(BANNER_TS, swap(ts, expr, ''))), new RegExp(`A CHANGED ${field} IS NEWS`), `${field} not compared`);
  }
  dies(() => K.sameIssues(loadTs.fromText(BANNER_TS, swap(ts, 'fields(issue) === fields(b[k])', 'false'))), /AN EMPTY POLL ANSWER|the same issue in a fresh object/, 'never the same');
  dies(() => K.bannerKeepsState(swap(tsx, 'setIssues((shown) => (sameIssues(shown, list) ? shown : list));', 'setIssues(list);')), /A POLL WITH NO NEWS KEEPS THE BANNER STATE/, 'the banner sets every poll answer (the defect)');
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
