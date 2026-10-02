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

test('RENDERED: B1 the root boundary\'s Reload goes through main (recovery notice), never location.reload()', async () => {
  const r = await run('built');
  assert.equal(r.rootReload.buttonShown, true);
  assert.deepEqual(r.rootReload.reloadCalls, ['The app'], 'one reloadAfterError, naming the boundary');
  assert.equal(r.rootReload.unloadAttempts, 0, 'the page never reloaded itself (that lands on the HivePicker)');
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

test('MUTANT M5 (Reload by location.reload()): the page reloads itself and main is never asked', async () => {
  const from = '      (window as unknown as { cth?: { reloadAfterError?: (where: string) => void } }).cth?.reloadAfterError?.(this.props.where);';
  const r = await run('M5', { [BOUNDARY]: [from, '      window.location.reload();'] });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.rootReload.reloadCalls, []);
  assert.equal(r.rootReload.unloadAttempts, 1);
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
  assert.match(preload, /reloadAfterError: \(where: string\): void =>\s*ipcRenderer\.send\('window:reloadAfterError', where\)/);
  const idx = codeOnly(readSource('src/main/index.ts'));
  assert.match(idx, /ipcMain\.on\('renderer:error', \(_evt, raw: unknown\) => \{\s*const row = rendererErrorRow\(raw, rendererErrorDue\);/);
  // B1: the notice is set BEFORE the reload, so window:recoveringSync is true for the new page
  assert.match(idx, /ipcMain\.on\('window:reloadAfterError', [\s\S]{0,200}?recoveryNotices\.set\(wc\.id, \{[^}]*action: 'reload'[\s\S]{0,300}?wc\.reload\(\);/);
  // N1: a test's env is spread BEFORE the isolation keys
  const runSrc = codeOnly(readSource('test/electron-harness/run.cjs'));
  assert.match(runSrc, /\.\.\.\(opts\.env \|\| \{\}\),[\s\S]{0,300}?MUNDER_DEV: ''/);
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

test('renderer-error: N2 a repeat is COUNTED, and its next row (after the window) carries the count', () => {
  let t = 0;
  const gate = E.createRendererErrorGate({ now: () => t, perMinute: 20, perHour: 120, repeatMs: 60_000 });
  const rep = (m) => ({ source: 'window-error', message: m });
  assert.deepEqual(gate(rep('loop')), { log: true, dropped: 0, repeats: 0 });
  // the same error every second for 3 minutes: never folded forever
  const rows = [];
  for (t = 1000; t <= 180_000; t += 1000) { const v = gate(rep('loop')); if (v.log) rows.push({ t, repeats: v.repeats }); }
  assert.deepEqual(rows, [{ t: 60_000, repeats: 59 }, { t: 120_000, repeats: 59 }, { t: 180_000, repeats: 59 }]);
});

test('renderer-error: N3 distinct errors are capped a minute and an hour; the next row says how many were dropped', () => {
  let t = 0;
  const gate = E.createRendererErrorGate({ now: () => t, perMinute: 3, perHour: 5, repeatMs: 60_000 });
  const rep = (m) => ({ source: 'window-error', message: m });
  const logged = (m) => gate(rep(m)).log;
  assert.deepEqual([logged('a'), logged('b'), logged('c'), logged('d')], [true, true, true, false], '3 a minute');
  t = 60_000; assert.deepEqual(gate(rep('e')), { log: true, dropped: 1, repeats: 0 });
  assert.equal(logged('f'), true);
  assert.equal(logged('g'), false, '5 an hour');
  t = 3_600_000; assert.deepEqual(gate(rep('h')), { log: true, dropped: 1, repeats: 0 });
  assert.ok(E.RENDERER_ERROR_PER_HOUR * (E.RENDERER_ERROR_MESSAGE_MAX + 2 * E.RENDERER_ERROR_STACK_MAX + 400) < 512 * 1024,
    'N3: at the caps an hour of rows stays under 512 KB (log.jsonl rotates at 8 MB)');
});

// ── B2: redaction (log.jsonl is read by every agent) ──────────────────────────────────────────
const L = loadTs('src/main/rendererErrorLog.ts');
const SECRET = 'sk-ant-api03-' + 'A1b2C3d4'.repeat(6);
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop';
const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----';

test('B2: every text of a renderer-error row is redacted; a secret straddling the cut is still caught', () => {
  const gate = E.createRendererErrorGate();
  const row = L.rendererErrorRow({ source: 'boundary', where: `History ${SECRET}`, message: `boom ${SECRET} ${JWT}`, stack: `at x ${PEM}`, componentStack: 'in Y Bearer abcdefghijklmnop' }, gate);
  const all = JSON.stringify(row);
  for (const x of ['sk-ant-api03', 'eyJhbGci', 'BEGIN RSA', 'abcdefghijklmnop']) assert.equal(all.includes(x), false, `${x} redacted`);
  assert.equal(row.kind, 'renderer-error');
  assert.match(row.message, /^boom \[redacted\]/);
  const edge = L.rendererErrorRow({ source: 'window-error', message: 'x'.repeat(E.RENDERER_ERROR_MESSAGE_MAX - 12) + SECRET }, gate);
  assert.equal(edge.message.includes('sk-ant'), false, 'redacted BEFORE the cut: no secret head survives the 500-char cut');
});

const R = loadTs('src/renderer/src/rendererErrors.ts');
test('B2: a rejected object is logged by its type only, never its fields', () => {
  assert.equal(R.text(new Error('m')), 'm');
  assert.equal(R.text('plain'), 'plain');
  const t = R.text({ token: SECRET, email: 'a@b.c' });
  assert.equal(t.includes('sk-ant') || t.includes('a@b.c') || t.includes('token'), false, t);
  assert.match(t, /a rejected Object \(fields not logged\)/);
});

// ── B2 / N2 mutants (source text, loaded in place) ───────────────────────────────────────────
const SHARED = 'src/shared/rendererError.ts';
const mutantShared = (from, to) => { const src = normaliseEol(fs.readFileSync(path.join(ROOT, SHARED), 'utf8')); assert.ok(src.includes(from), from); return loadTs.fromText(SHARED, src.replace(from, to)); };
const { redactSecrets } = loadTs('src/main/hive.ts');

test('MUTANT B2a (cut before redact): the secret head survives the cut', () => {
  const M = mutantShared('redact(v).slice(0, max)', 'redact(v.slice(0, max))');
  const r = M.normalizeRendererError({ source: 'window-error', message: 'x'.repeat(M.RENDERER_ERROR_MESSAGE_MAX - 12) + SECRET }, redactSecrets);
  assert.equal(r.message.includes('sk-ant'), true, 'without redact-first the cut leaves an unrecognisable secret head');
});

test('MUTANT B2b (main does not redact): the secret reaches the row', () => {
  const src = normaliseEol(fs.readFileSync(path.join(ROOT, 'src/main/rendererErrorLog.ts'), 'utf8'));
  const from = 'normalizeRendererError(raw, redactSecrets)';
  assert.ok(src.includes(from));
  const M = loadTs.fromText('src/main/rendererErrorLog.ts', src.replace(from, 'normalizeRendererError(raw)'));
  const row = M.rendererErrorRow({ source: 'boundary', message: `boom ${SECRET}` }, E.createRendererErrorGate());
  assert.equal(row.message.includes('sk-ant'), true);
});

test('MUTANT B2c (a rejected object stringified): its fields reach the log', () => {
  const file = 'src/renderer/src/rendererErrors.ts';
  const src = normaliseEol(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  const from = "if (typeof v === 'object') return `a rejected ${(v as object).constructor?.name || 'object'} (fields not logged)`;";
  assert.ok(src.includes(from));
  const M = loadTs.fromText(file, src.replace(from, "if (typeof v === 'object') return JSON.stringify(v);"));
  assert.equal(M.text({ token: SECRET }).includes('sk-ant'), true);
});

test('MUTANT N2 (a repeat refreshes the window: folded forever): the 3-minute loop gets no second row', () => {
  const M = mutantShared('if (prev && t - prev.at < repeatMs) { prev.repeats += 1;', 'if (prev && t - prev.at < repeatMs) { prev.at = t; prev.repeats += 1;');
  let t = 0;
  const gate = M.createRendererErrorGate({ now: () => t });
  gate({ source: 'window-error', message: 'loop' });
  let rows = 0;
  for (t = 1000; t <= 180_000; t += 1000) if (gate({ source: 'window-error', message: 'loop' }).log) rows += 1;
  assert.equal(rows, 0);
});
