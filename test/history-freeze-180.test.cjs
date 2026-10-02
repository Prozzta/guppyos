'use strict';

/**
 * HISTORY-SCROLL-FREEZE (1.1.80). Scrolling back in an agent's History tab blanked the whole app
 * (1.1.70 to 1.1.79):
 *  - a message row's 6 px margins collapsed out of the measured wrapper, so the virtual list
 *    measured every message row 6 px short;
 *  - each row crossing the mount boundary changed the real height by those 6 px, Chromium's
 *    scroll anchoring moved scrollTop to compensate, and the layout effect fed scrollTop back
 *    into the virtual window: a two-state flip React aborts ("Maximum update depth exceeded");
 *  - there was no error boundary, so React unmounted the WHOLE root, and nothing was logged.
 * F1: the wrapper contains its margins (flow-root), so measured = true stride.
 * F2: overflow-anchor: none on the scroller (the list keeps its own place).
 * F3: an error boundary around History and at the root; renderer errors become renderer-error rows.
 *
 * RENDERED (electron-harness, history-freeze.tsx): continuous scroll-up over short and real-shaped
 * rows, then F1 alone (anchoring forced back on) and F2 alone (margins forced back out), and a
 * throw inside the History boundary. MUTANT CENSUS: each fix removed in turn, via the harness's
 * HARNESS_SOURCE_OVERRIDES, must fail its own trial.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runScenario } = require('./electron-harness/run.cjs');
const { readSource, codeOnly, normaliseEol } = require('./read-source.cjs');
const loadTs = require('./load-ts.cjs');

const ROOT = path.join(__dirname, '..');
const SCENARIO = path.join(__dirname, 'electron-harness', 'scenarios', 'history-freeze.tsx');
const HISTORY_VIEW = path.join(ROOT, 'src', 'renderer', 'src', 'components', 'HistoryView.tsx');
const BOUNDARY = path.join(ROOT, 'src', 'renderer', 'src', 'components', 'ErrorBoundary.tsx');

const runs = new Map();
/** One harness run per source variant (cached): {} is the source as built. */
function run(key, overrides = {}) {
  if (!runs.has(key)) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf180-'));
    const map = {};
    for (const [file, [from, to]] of Object.entries(overrides)) {
      const text = normaliseEol(fs.readFileSync(file, 'utf8'));
      assert.ok(text.includes(from), `mutant ${key}: '${from}' is in ${path.basename(file)}`);
      const out = path.join(dir, path.basename(file));
      fs.writeFileSync(out, text.replace(from, to));
      map[file] = out;
    }
    runs.set(key, runScenario(SCENARIO, { timeoutMs: 120_000, env: { HARNESS_SOURCE_OVERRIDES: JSON.stringify(map) } })
      .finally(() => fs.rmSync(dir, { recursive: true, force: true })));
  }
  return runs.get(key);
}

const still = (t, name) => {
  assert.equal(t.loop, null, `${name}: no render loop (${t.loop} at step ${t.failStep})`);
  assert.ok(t.mounted > 0 && t.scrollHeight > 0, `${name}: the list is still mounted (${t.mounted} rows, ${t.scrollHeight}px)`);
  assert.equal(t.idleDistinctTops, 1, `${name}: the view is still once the input stops`);
};

test('RENDERED: scrolling back through short rows and real-shaped rows never loops; measured = true stride', async () => {
  const r = await run('built');
  assert.equal(r.ok, true, r.error);
  still(r.short, 'short rows');
  still(r.real, 'real-shaped rows');
  assert.equal(r.short.strideOff, 0, 'F1: each mounted wrapper is exactly the distance to the next row');
  assert.equal(r.real.strideOff, 0, 'F1: each mounted wrapper is exactly the distance to the next row');
});

test('RENDERED: F1 alone holds (the browser\'s scroll anchoring forced back on)', async () => {
  const r = await run('built');
  still(r.f1Only, 'F1 alone, real rows');
  still(r.f1OnlyShort, 'F1 alone, short rows');
});

test('RENDERED: F2 alone holds (the row margins forced back out of the measurement)', async () => {
  const r = await run('built');
  still(r.f2Only, 'F2 alone, real rows');
  still(r.f2OnlyShort, 'F2 alone, short rows');
  assert.equal(r.f2Only.strideOff, 6, 'the trial really removes F1: a message row measures 6 px short');
});

test('RENDERED: F3 a throw inside the History boundary shows a message, keeps the rest mounted, and is reported', async () => {
  const r = await run('built');
  assert.equal(r.boundary.siblingMounted, true, 'the rest of the panel stays mounted');
  assert.equal(r.boundary.fallbackShown, true, 'the boundary shows its message');
  assert.match(r.boundary.fallbackText, /History could not be shown/);
  assert.match(r.boundary.fallbackText, /history render failed \(test\)/);
  assert.deepEqual(r.boundary.reported, [{ where: 'History', message: 'history render failed (test)', hasComponentStack: true }]);
});

// ── Mutant census: each fix removed must fail its own trial ─────────────────────────────────
const F1 = [" style={{ display: 'flow-root' }}", ''];
const F2 = ["        overflowAnchor: 'none',\n", ''];

test('MUTANT M1 (no flow-root): the F1-alone trial loops; the built trials measure 6 px short', async () => {
  const r = await run('M1', { [HISTORY_VIEW]: F1 });
  assert.equal(r.ok, true, r.error);
  assert.match(String(r.f1Only.loop ?? r.f1OnlyShort.loop), /Maximum update depth/, 'without F1, anchoring ON loops again');
  assert.equal(r.real.strideOff, 6);
});

test('MUTANT M2 (no overflow-anchor:none): the F2-alone trial loops', async () => {
  const r = await run('M2', { [HISTORY_VIEW]: F2 });
  assert.equal(r.ok, true, r.error);
  assert.match(String(r.f2Only.loop ?? r.f2OnlyShort.loop), /Maximum update depth/, 'without F2, collapsed margins loop again');
});

test('MUTANT M3 (neither): plain scrolling loops, as 1.1.70 to 1.1.79 did', async () => {
  const src = normaliseEol(fs.readFileSync(HISTORY_VIEW, 'utf8'));
  const both = src.replace(F1[0], F1[1]).replace(F2[0], F2[1]);
  assert.notEqual(both, src);
  const r = await run('M3', { [HISTORY_VIEW]: [src, both] });
  assert.equal(r.ok, true, r.error);
  assert.match(String(r.short.loop), /Maximum update depth/);
  assert.match(String(r.real.loop), /Maximum update depth/);
});

test('MUTANT M4 (a boundary that does not catch): the History fallback is gone', async () => {
  const r = await run('M4', { [BOUNDARY]: ['return { error };', 'return { error: null };'] });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.boundary.fallbackShown, false);
});

// ── F3 wiring and the log row (pure) ────────────────────────────────────────────────────────
test('F3 wiring: History sits in its boundary; the root has one; the forwarder is installed; main writes renderer-error', () => {
  const panel = codeOnly(readSource('src/renderer/src/components/AgentDetailPanel.tsx'));
  assert.match(panel, /<ErrorBoundary key=\{agent\.id\} where="History">\s*<HistoryView agentId=\{agent\.id\} \/>\s*<\/ErrorBoundary>/);
  const main = codeOnly(readSource('src/renderer/src/main.tsx'));
  assert.match(main, /installRendererErrorForwarder\(\);/);
  assert.match(main, /<ErrorBoundary where="The app" recover="reload">\s*<App \/>\s*<\/ErrorBoundary>/);
  const preload = codeOnly(readSource('src/preload/index.ts'));
  assert.match(preload, /logRendererError: \(report: RendererErrorReport\): void =>\s*ipcRenderer\.send\('renderer:error', report\)/);
  const idx = codeOnly(readSource('src/main/index.ts'));
  assert.match(idx, /ipcMain\.on\('renderer:error', \(_evt, raw: unknown\) => \{\s*const report = normalizeRendererError\(raw\);/);
  assert.match(idx, /kind: 'renderer-error', \.\.\.report/);
});

const E = loadTs('src/shared/rendererError.ts');

test('renderer-error: a report is validated and cut; anything else is refused', () => {
  assert.equal(E.normalizeRendererError(null), null);
  assert.equal(E.normalizeRendererError({ source: 'nope', message: 'x' }), null);
  assert.equal(E.normalizeRendererError({ source: 'boundary', message: '' }), null);
  const r = E.normalizeRendererError({ source: 'boundary', where: 'History', message: 'm'.repeat(900), stack: 's'.repeat(9000), extra: 1 });
  assert.equal(r.message.length, E.RENDERER_ERROR_MESSAGE_MAX);
  assert.equal(r.stack.length, E.RENDERER_ERROR_STACK_MAX);
  assert.equal(r.where, 'History');
  assert.equal('extra' in r, false);
});

test('renderer-error: the gate folds an echo, caps a minute, and says how many it dropped', () => {
  let t = 0;
  const gate = E.createRendererErrorGate({ now: () => t, perMinute: 3, repeatMs: 2000 });
  const rep = (m) => ({ source: 'window-error', message: m });
  assert.deepEqual(gate(rep('a')), { log: true, dropped: 0 });
  t = 500; assert.equal(gate(rep('a')).log, false, 'the same message within 2 s is one row');
  t = 600; assert.equal(gate(rep('b')).log, true);
  t = 700; assert.equal(gate(rep('c')).log, true);
  t = 800; assert.equal(gate(rep('d')).log, false, 'past 3 a minute');
  t = 900; assert.equal(gate(rep('e')).log, false);
  t = 60_000; assert.deepEqual(gate(rep('f')), { log: true, dropped: 2 }, 'the next minute says 2 were dropped');
});
