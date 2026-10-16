'use strict';
/**
 * GPU-COMPOSITING-INSTALLED-189: the startup 'graphics' row in log.jsonl.
 *
 * Chromium reports gpu_compositing 'disabled_software' (webgl 'disabled_off') in EVERY mode until the
 * GPU process has sent its info (the first `gpu-info-update`, ~200-470 ms after ready on the Human's
 * RTX 4080 SUPER). 1.1.88 wrote the row at ready, so it said hardwareCompositing false on every
 * launch, GPU mode included, while the page drew on the GPU. The row is now written once Chromium
 * knows: on the first gpu-info-update (or at once when it already came, or in CPU only mode), and a
 * GPU process that never reports gives null ('unknown'), never false.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const main = loadTs('src/main/graphics.ts');

const SOFTWARE_BEFORE_INFO = { gpu_compositing: 'disabled_software', webgl: 'disabled_off' };
const HARDWARE = { gpu_compositing: 'enabled', webgl: 'enabled' };

/** A fake Electron app: Chromium's feature status, the gpu-info-update event, and the startup bits. */
function fakeApp(status = SOFTWARE_BEFORE_INFO) {
  const app = new EventEmitter();
  app.status = status;
  app.getGPUFeatureStatus = () => app.status;
  app.isReady = () => false;
  app.getPath = () => 'C:/ud';
  app.disableHardwareAcceleration = () => {};
  /** Chromium got the GPU process's info: the status changes, then the event fires. */
  app.gpuReports = (next) => { app.status = next; app.emit('gpu-info-update'); };
  return app;
}
/** Timers the test fires by hand. */
function fakeTimers() {
  const pending = new Set();
  return {
    pending,
    setTimer: (fn, ms) => { const t = { fn, ms }; pending.add(t); return t; },
    clearTimer: (t) => { pending.delete(t); },
    fireAll: () => { for (const t of [...pending]) { pending.delete(t); t.fn(); } }
  };
}
function start(mode) {
  main.__resetGraphicsForTests();
  const app = fakeApp();
  main.applyGraphicsModeAtStartup(app, () => JSON.stringify({ graphicsMode: mode }));
  main.watchGpuReports(app);
  return app;
}

test('T1 GPU mode: no row while Chromium has not heard from the GPU process; then hardware, from the status at that moment', () => {
  for (const mode of ['gpu', 'auto']) {
    const app = start(mode);
    const rows = []; const timers = fakeTimers();
    main.logGraphicsWhenKnown(app, { mode, applied: true }, (r) => rows.push(r), timers);
    assert.equal(rows.length, 0, `${mode}: nothing written at ready (the status still reads the before-info default)`);
    app.gpuReports(HARDWARE);
    assert.deepEqual(rows, [{ kind: 'graphics', mode, applied: true, hardwareCompositing: true, gpuCompositing: 'enabled' }], mode);
    assert.equal(timers.pending.size, 0, `${mode}: the timeout is cleared`);
  }
});

test('T2 CPU only: written at once, software, without waiting for the GPU process', () => {
  const app = start('cpu');
  const rows = []; const timers = fakeTimers();
  main.logGraphicsWhenKnown(app, { mode: 'cpu', applied: true }, (r) => rows.push(r), timers);
  assert.deepEqual(rows, [{ kind: 'graphics', mode: 'cpu', applied: true, hardwareCompositing: false, gpuCompositing: 'disabled_software' }]);
  assert.equal(timers.pending.size, 0);
  assert.equal(app.listenerCount('gpu-info-update'), 1, 'only the module watch listens; nothing is left waiting');
});

test('T3 a GPU process that never reports: null (unknown) at the timeout, never false', () => {
  const app = start('gpu');
  const rows = []; const timers = fakeTimers();
  main.logGraphicsWhenKnown(app, { mode: 'gpu', applied: true }, (r) => rows.push(r), timers);
  assert.equal([...timers.pending][0].ms, main.GRAPHICS_ROW_TIMEOUT_MS);
  assert.equal(main.GRAPHICS_ROW_TIMEOUT_MS, 10_000);
  timers.fireAll();
  assert.deepEqual(rows, [{ kind: 'graphics', mode: 'gpu', applied: true, hardwareCompositing: null, gpuCompositing: 'disabled_software' }]);
  assert.equal(app.listenerCount('gpu-info-update'), 1, 'the row listener is removed');
  app.gpuReports(HARDWARE);
  assert.equal(rows.length, 1, 'a late report does not write a second row');
});

test('T4 a real fallback (the GPU process reports software) is still false', () => {
  const app = start('gpu');
  const rows = []; const timers = fakeTimers();
  main.logGraphicsWhenKnown(app, { mode: 'gpu', applied: true }, (r) => rows.push(r), timers);
  app.gpuReports({ gpu_compositing: 'disabled_software', webgl: 'unavailable_software' });
  assert.deepEqual(rows, [{ kind: 'graphics', mode: 'gpu', applied: true, hardwareCompositing: false, gpuCompositing: 'disabled_software' }]);
});

test('T5 one row per call: later reports and the timeout add nothing', () => {
  const app = start('gpu');
  const rows = []; const timers = fakeTimers();
  main.logGraphicsWhenKnown(app, { mode: 'gpu', applied: true }, (r) => rows.push(r), timers);
  app.gpuReports(HARDWARE);
  app.gpuReports({ gpu_compositing: 'disabled_software' });
  timers.fireAll();
  assert.equal(rows.length, 1);
  assert.equal(app.listenerCount('gpu-info-update'), 1, 'the row listener is gone');
});

test('T6 asked after the GPU process already reported (a later hive bootstrap): written at once', () => {
  const app = start('gpu');
  app.gpuReports(HARDWARE);
  const rows = []; const timers = fakeTimers();
  main.logGraphicsWhenKnown(app, { mode: 'gpu', applied: true }, (r) => rows.push(r), timers);
  assert.deepEqual(rows, [{ kind: 'graphics', mode: 'gpu', applied: true, hardwareCompositing: true, gpuCompositing: 'enabled' }]);
  assert.equal(timers.pending.size, 0);
});

test('T7 a row that cannot be written (append throws, status throws) never throws out', () => {
  const app = start('gpu');
  const timers = fakeTimers();
  main.logGraphicsWhenKnown(app, { mode: 'gpu', applied: true }, () => { throw new Error('log closed'); }, timers);
  assert.doesNotThrow(() => app.gpuReports(HARDWARE));
  const broken = start('cpu');
  broken.getGPUFeatureStatus = () => { throw new Error('no gpu info'); };
  const rows = [];
  assert.doesNotThrow(() => main.logGraphicsWhenKnown(broken, { mode: 'cpu', applied: true }, (r) => rows.push(r), fakeTimers()));
  assert.deepEqual(rows, [{ kind: 'graphics', mode: 'cpu', applied: true, hardwareCompositing: false, gpuCompositing: null }]);
});

test('the default 10 s timer is unref-ed: a GPU process that never reports cannot hold quit open (Jim N2)', () => {
  const app = start('gpu');
  const realSet = global.setTimeout; let handle = null;
  global.setTimeout = (fn, ms) => { handle = realSet(fn, ms); return handle; };
  try { main.logGraphicsWhenKnown(app, { mode: 'gpu', applied: true }, () => {}); } finally { global.setTimeout = realSet; }
  assert.ok(handle, 'a default timer was set');
  assert.equal(handle.hasRef(), false);
  clearTimeout(handle);
});

test('index.ts: the watch starts at module load; the bootstrap row goes through logGraphicsWhenKnown, never read at ready', () => {
  const src = codeOnly(readSource('src/main/index.ts'), 'index.ts');
  const watch = src.indexOf('\nwatchGpuReports(app);');
  assert.ok(watch > 0, 'a top-level statement');
  assert.ok(watch > src.indexOf('\nconst graphicsAtStartup = applyGraphicsModeAtStartup(app);'), 'after the mode is applied');
  assert.ok(watch < src.indexOf('app.whenReady()'), 'before app ready, so no report is missed');
  assert.equal(src.split('logGraphicsWhenKnown(').length - 1, 1, 'one call site');
  assert.doesNotMatch(src, /kind: 'graphics',/, 'index.ts no longer writes the row inline');
  const boot = src.slice(src.indexOf('function bootstrapHiveServices('));
  assert.match(boot.slice(0, boot.indexOf('\n}\n')), /logGraphicsWhenKnown\(app, graphicsAtStartup, /);
});
