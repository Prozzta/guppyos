'use strict';

/**
 * STARTUP-TIMING-162 + MEMORY-STATUS-LAZY (god, after Jim's STARTUP-STALL-159):
 * (1) the first 60 s are recorded as `startup-timing` rows (main loop delay per second, renderer
 *     long tasks, markers), then the recorder stops; cheap, no content;
 * (2) the Memory panel's status never forks the memory worker ("starts on first use").
 * No hive, no HOME: nothing here builds hive objects or starts a process.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const T = loadTs('src/main/startupTiming.ts');
const { StartupTiming, STARTUP_TIMING_WINDOW_MS, STARTUP_LOOP_ROW_SAMPLES, STARTUP_MAX_RENDERER_ROWS } = T;
const { NativeMemoryWiring } = loadTs('src/main/nativeMemory/mainWiring.ts');

const ROOT = path.join(__dirname, '..');
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const code = (p) => src(p).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');

/** A recorder on fake timers and a fake histogram (values in ns, as Node reports them). */
function rig({ origin = 1_000_000, startAt = origin + 500, windowMs } = {}) {
  let now = startAt;
  const rows = [];
  const timers = { interval: null, timeout: null, cleared: [] };
  const hist = { enabled: false, max: 0, p99: 0, resets: 0,
    enable() { this.enabled = true; }, disable() { this.enabled = false; },
    reset() { this.resets++; this.max = 0; this.p99 = 0; }, percentile(p) { assert.equal(p, 99); return this.p99; } };
  const rec = new StartupTiming({
    origin, now: () => now, log: (r) => rows.push(r), histogram: () => hist, windowMs,
    setInterval: (fn, ms) => { timers.interval = { fn, ms }; return 'I'; },
    clearInterval: (h) => timers.cleared.push(h),
    setTimeout: (fn, ms) => { timers.timeout = { fn, ms }; return 'T'; },
    clearTimeout: (h) => timers.cleared.push(h)
  });
  const tick = (maxMs, p99Ms = maxMs / 2) => { now += 1000; hist.max = maxMs * 1e6; hist.p99 = p99Ms * 1e6; timers.interval.fn(); };
  return { rec, rows, timers, hist, tick, advance: (ms) => { now += ms; }, at: () => now };
}

test('(1) start arms a 1 s sampler (unref-safe handles) and a stop timer that closes the window 60 s after PROCESS start, once', () => {
  const r = rig();
  r.rec.start();
  r.rec.start();
  assert.equal(r.rec.recording, true);
  assert.equal(r.hist.enabled, true);
  assert.equal(r.timers.interval.ms, 1000);
  assert.equal(r.timers.timeout.ms, STARTUP_TIMING_WINDOW_MS - 500, 'the window counts from process start, not from start()');
  assert.equal(STARTUP_TIMING_WINDOW_MS, 60_000);
});

test('(1) loop rows: one per 10 samples, max and p99 in ms (0.1 ms), t = ms since process start', () => {
  const r = rig();
  r.rec.start();
  for (let i = 0; i < STARTUP_LOOP_ROW_SAMPLES; i++) r.tick(i === 3 ? 2034.56 : 12, 11);
  assert.equal(r.rows.length, 1);
  const row = r.rows[0];
  assert.deepEqual(Object.keys(row).sort(), ['ev', 'kind', 'maxMs', 'p99Ms', 'stepMs', 't']);
  assert.equal(row.kind, 'startup-timing');
  assert.equal(row.ev, 'loop');
  assert.equal(row.t, 500);
  assert.equal(row.stepMs, 1000);
  assert.equal(row.maxMs.length, 10);
  assert.equal(row.maxMs[3], 2034.6);
  assert.equal(row.p99Ms[0], 11);
  assert.equal(r.hist.resets, 10, 'the histogram is reset every sample, so each value is that second alone');
  r.tick(5);
  assert.equal(r.rows.length, 1, 'the next row waits for its 10 samples');
});

test('(1) marks: window-ready once per run, agent marks once per id, t from process start; nothing before start or after stop', () => {
  const r = rig();
  r.rec.mark('window-ready');
  assert.equal(r.rows.length, 0, 'not armed yet');
  r.rec.start();
  r.advance(300);
  r.rec.mark('window-ready');
  r.rec.mark('window-ready');
  r.rec.mark('agent-spawn', 'god');
  r.rec.mark('agent-spawn', 'god');
  r.rec.mark('agent-spawn', 'dwight-1');
  r.rec.mark('agent-first-output', 'god');
  r.rec.mark('memory-worker-fork');
  const marks = r.rows.filter((x) => x.ev === 'mark');
  assert.deepEqual(marks.map((m) => [m.name, m.id, m.t]), [
    ['window-ready', undefined, 800], ['agent-spawn', 'god', 800], ['agent-spawn', 'dwight-1', 800],
    ['agent-first-output', 'god', 800], ['memory-worker-fork', undefined, 800]
  ]);
  r.rec.stop();
  const n = r.rows.length;
  r.rec.mark('agent-spawn', 'late');
  r.rec.fromRenderer({ longtasks: [{ at: r.at(), ms: 900 }] });
  assert.equal(r.rows.length, n, 'stopped: nothing more this run');
});

test('(1) stop: flushes the partial loop row, writes ONE end row naming the worst second and the longest task, disables the histogram, clears both timers; idempotent', () => {
  const r = rig();
  r.rec.start();
  r.tick(15); r.tick(1980, 1900); r.tick(20);
  r.rec.fromRenderer({ longtasks: [{ at: 1_000_000 + 12_345, ms: 1733, name: 'self', attr: 'window' }, { at: 1_000_000 + 13_000, ms: 80 }] });
  r.advance(500);
  r.rec.stop();
  r.rec.stop();
  const loop = r.rows.filter((x) => x.ev === 'loop');
  assert.equal(loop.length, 1);
  assert.equal(loop[0].maxMs.length, 4, 'three ticks plus the partial second at stop');
  const ends = r.rows.filter((x) => x.ev === 'end');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].loopWorstMs, 1980);
  assert.equal(ends[0].loopWorstT, 2500, 'the second that ended at +2.5 s');
  assert.equal(ends[0].longtasks, 2);
  assert.equal(ends[0].longtaskMaxMs, 1733);
  assert.equal(ends[0].longtaskMaxT, 12_345);
  assert.equal(r.hist.enabled, false);
  assert.deepEqual(r.timers.cleared.sort(), ['I', 'T']);
  assert.equal(r.rec.recording, false);
});

test('(1) the stop timer is what ends it: firing it writes the end row', () => {
  const r = rig();
  r.rec.start();
  r.timers.timeout.fn();
  assert.equal(r.rec.recording, false);
  assert.equal(r.rows.at(-1).ev, 'end');
});

test('(1) started after the window (a late whenReady): records nothing and arms nothing', () => {
  const r = rig({ startAt: 1_000_000 + 61_000 });
  r.rec.start();
  assert.equal(r.rec.recording, false);
  assert.equal(r.timers.interval, null);
  assert.equal(r.timers.timeout, null);
  r.rec.mark('window-ready');
  assert.equal(r.rows.length, 0);
});

test('(1) no histogram (an old runtime): marks and long tasks still work, no loop rows, no sampler', () => {
  const rows = [];
  let to = null;
  const rec = new StartupTiming({ origin: 0, now: () => 100, log: (x) => rows.push(x), histogram: () => null,
    setInterval: () => assert.fail('no sampler without a histogram'), setTimeout: (fn) => { to = fn; return 1; }, clearTimeout: () => {} });
  rec.start();
  rec.mark('window-ready');
  to();
  assert.deepEqual(rows.map((x) => x.ev), ['mark', 'end']);
});

test('(1) the renderer batch is validated: only its own mark, safe ids, tasks >= 50 ms, allow-listed tokens; no content reaches a row', () => {
  const r = rig();
  r.rec.start();
  r.rec.fromRenderer(null);
  r.rec.fromRenderer('x');
  r.rec.fromRenderer({
    marks: [
      { name: 'first-agent-redraw', at: 1_000_000 + 7000, id: 'god' },
      { name: 'first-agent-redraw', at: 1_000_000 + 7100, id: 'god' },
      { name: 'first-agent-redraw', at: 1_000_000 + 7200, id: 'C:\\Users\\secret path' },
      { name: 'window-ready', at: 1 },
      { name: 'memory-worker-fork', at: 1 },
      { name: 'first-agent-redraw', at: 'soon', id: 'x' }
    ],
    longtasks: [
      { at: 1_000_000 + 9000, ms: 49.9 },
      { at: 1_000_000 + 9100, ms: 250.4, name: 'self', attr: 'window' },
      { at: 1_000_000 + 9200, ms: 300, name: 'rm -rf / && echo', attr: 'https://example.com/x?q=1' },
      { at: NaN, ms: 300 },
      { at: 1_000_000 + 9300, ms: Infinity }
    ]
  });
  const marks = r.rows.filter((x) => x.ev === 'mark');
  assert.deepEqual(marks.map((m) => [m.name, m.id, m.t]), [['first-agent-redraw', 'god', 7000], ['first-agent-redraw', undefined, 7200]],
    'main-only marks cannot be forged over IPC; a path-like id is dropped (the mark stays, id-less)');
  const tasks = r.rows.filter((x) => x.ev === 'longtask');
  assert.deepEqual(tasks, [
    { kind: 'startup-timing', ev: 'longtask', t: 9100, ms: 250, name: 'self', attr: 'window' },
    { kind: 'startup-timing', ev: 'longtask', t: 9200, ms: 300 }
  ]);
  for (const row of r.rows) {
    for (const [k, v] of Object.entries(row)) {
      if (typeof v === 'string') assert.match(`${k}=${v}`, /^(kind|ev|name|attr|id)=[A-Za-z0-9._:-]{1,64}$/, 'strings are only kinds, names, tokens and ids');
    }
  }
});

test('(1) a flooding renderer is capped; the end row counts what was dropped', () => {
  const r = rig();
  r.rec.start();
  for (let b = 0; b < 5; b++) r.rec.fromRenderer({ longtasks: Array.from({ length: 100 }, (_, i) => ({ at: 1_000_000 + i, ms: 60 })) });
  assert.equal(r.rows.filter((x) => x.ev === 'longtask').length, STARTUP_MAX_RENDERER_ROWS);
  r.rec.stop();
  assert.equal(r.rows.at(-1).dropped, 500 - STARTUP_MAX_RENDERER_ROWS);
});

test('(1) a log that throws never escapes (best-effort rows)', () => {
  const rec = new StartupTiming({ origin: 0, now: () => 1, log: () => { throw new Error('disk'); }, histogram: () => null,
    setTimeout: () => 1, clearTimeout: () => {} });
  rec.start();
  assert.doesNotThrow(() => { rec.mark('window-ready'); rec.fromRenderer({ longtasks: [{ at: 5, ms: 70 }] }); rec.stop(); });
});

test('(1) REAL loop delay: Node\'s histogram sees a blocked main thread in the right second', async () => {
  const { monitorEventLoopDelay, performance } = require('node:perf_hooks');
  const rows = [];
  const origin = Date.now();
  const rec = new StartupTiming({ origin, now: Date.now, log: (x) => rows.push(x), histogram: () => monitorEventLoopDelay({ resolution: 10 }), windowMs: 2_600 });
  rec.start();
  await new Promise((res) => setTimeout(res, 1_150));
  const until = performance.now() + 400;
  while (performance.now() < until) { /* block the loop */ }
  await new Promise((res) => setTimeout(res, 1_700));
  assert.equal(rec.recording, false, 'it stopped by itself');
  const loop = rows.filter((x) => x.ev === 'loop').flatMap((x) => x.maxMs);
  assert.ok(loop.length >= 2, `samples: ${loop}`);
  assert.ok(Math.max(...loop) >= 300, `the 400 ms block shows (max ${Math.max(...loop)} ms)`);
  const end = rows.find((x) => x.ev === 'end');
  assert.ok(end.loopWorstMs >= 300 && end.loopWorstT >= 1_100 && end.loopWorstT <= 2_700, JSON.stringify(end));
});

// ── the renderer half ───────────────────────────────────────────────────────

test('(1) renderer: buffered long tasks and each terminal\'s FIRST redraw go to main in batches; after 55 s (R2: before main closes) it stops, disconnects and flushes', () => {
  const sent = [];
  const timers = [];
  let observer = null;
  let nowMs = 400;
  const saved = { window: globalThis.window, performance: globalThis.performance, PO: globalThis.PerformanceObserver };
  class FakePO {
    constructor(cb) { this.cb = cb; observer = this; this.disconnected = false; }
    observe(o) { this.opts = o; }
    disconnect() { this.disconnected = true; }
    static get supportedEntryTypes() { return ['longtask', 'mark']; }
  }
  try {
    globalThis.PerformanceObserver = FakePO;
    Object.defineProperty(globalThis, 'performance', { value: { timeOrigin: 5_000, now: () => nowMs }, configurable: true, writable: true });
    globalThis.window = {
      cth: { startupTiming: (b) => sent.push(b) },
      setInterval: (fn, ms) => { timers.push({ kind: 'i', fn, ms }); return 7; },
      clearInterval: (h) => timers.push({ kind: 'ci', h }),
      setTimeout: (fn, ms) => { timers.push({ kind: 't', fn, ms }); return 8; }
    };
    const R = loadTs('src/renderer/src/startupTiming.ts');
    R.startRendererStartupTiming();
    R.startRendererStartupTiming();
    assert.deepEqual(observer.opts, { type: 'longtask', buffered: true });
    const flush = timers.find((x) => x.kind === 'i');
    const stop = timers.find((x) => x.kind === 't');
    assert.equal(flush.ms, 2_000);
    assert.equal(stop.ms, 55_000 - 400, 'R2: the final batch leaves before main closes at 60 s');
    assert.equal(timers.filter((x) => x.kind === 't').length, 1, 'armed once');

    observer.cb({ getEntries: () => [{ startTime: 100.4, duration: 812.6, name: 'self', attribution: [{ containerType: 'window', containerSrc: 'https://x' }] }, { startTime: 1, duration: 20, name: 'self' }] });
    assert.equal(R.startupRedrawPending('god'), true);
    nowMs = 3_000;
    R.noteFirstAgentRedraw('god');
    R.noteFirstAgentRedraw('god');
    assert.equal(R.startupRedrawPending('god'), false, 'one first redraw per terminal');
    flush.fn();
    assert.deepEqual(sent, [{
      longtasks: [{ at: 5_100, ms: 813, name: 'self', attr: 'window' }],
      marks: [{ name: 'first-agent-redraw', at: 8_000, id: 'god' }]
    }]);
    flush.fn();
    assert.equal(sent.length, 1, 'an empty batch is not sent');

    stop.fn();
    assert.equal(observer.disconnected, true);
    assert.ok(timers.some((x) => x.kind === 'ci' && x.h === 7));
    assert.equal(R.startupRedrawPending('dwight'), false, 'stopped: the data path pays one boolean check');
    R.noteFirstAgentRedraw('dwight');
    flush.fn();
    assert.equal(sent.length, 1);
  } finally {
    globalThis.window = saved.window;
    Object.defineProperty(globalThis, 'performance', { value: saved.performance, configurable: true, writable: true });
    globalThis.PerformanceObserver = saved.PO;
  }
});

// ── wiring (source pins: these run inside Electron) ─────────────────────────

test('(1) WIRING: armed in whenReady, window-ready on the main window, the memory fork, PTY spawn/first output, the renderer IPC; the redraw is marked in xterm\'s write callback', () => {
  const idx = code('src/main/index.ts');
  assert.match(idx, /new StartupTiming\(\{\s*origin: performance\.timeOrigin,[\s\S]*?histogram: \(\) => monitorEventLoopDelay\(\{ resolution: 10 \}\)/);
  const ready = idx.slice(idx.indexOf('app.whenReady().then('));
  assert.ok(ready.indexOf('startupTiming.start();') > 0 && ready.indexOf('startupTiming.start();') < ready.indexOf('bootstrapHiveServices();'), 'armed before the hive and the agents start');
  assert.match(idx, /mainWindow\?\.webContents\.once\('did-finish-load', \(\) => \{\s*startupTiming\.mark\('window-ready'\);/);
  assert.match(idx, /fork: \(entry\) => \{\s*startupTiming\.mark\('memory-worker-fork'\);\s*return utilityProcess\.fork\(entry, \[\], \{ serviceName: 'munder-memory'/);
  assert.match(idx, /spawned: \(id\) => startupTiming\.mark\('agent-spawn', id\),\s*firstOutput: \(id\) => startupTiming\.mark\('agent-first-output', id\),\s*output: \(id, chars\) => startupTiming\.ptyOutput\(id, chars\),\s*recording: \(\) => startupTiming\.recording/);
  assert.match(idx, /ipcMain\.on\('startup:timing', \(_evt, batch: unknown\) => startupTiming\.fromRenderer\(batch\)\)/);
  const pty = code('src/main/pty.ts');
  assert.match(pty, /if \(this\.startupHooks\) \{\s*try \{\s*const h = this\.startupHook\(\);\s*if \(h\) \{ if \(!session\.hasOutput\) h\.firstOutput\(id\); h\.output\(id, data\.length\); \}\s*\} catch \{\s*\}\s*\}\s*session\.hasOutput = true;/,
    'first output = the PTY\'s first bytes, checked before hasOutput flips; R1 counts every chunk (a length); after the window only a null check');
  assert.match(code('src/renderer/src/components/terminalPool.ts'), /entry\.term\.open\(entry\.host\);\s*entry\.opened = true;\s*noteTerminalOpen\(entry\.ptyId\);/, 'R1: terminal-open mark');
  assert.match(pty, /proc\.onData\(\(data\) => this\.deliverData\(opts\.id, session, data\)\);\s*if \(this\.startupHooks\) \{ try \{ this\.startupHook\(\)\?\.spawned\(opts\.id\); \} catch \{\s*\} \}/);
  assert.match(pty, /if \(h && !h\.recording\(\)\) this\.startupHooks = null;/, 'the hooks drop themselves when the recorder stops');
  const pool = code('src/renderer/src/components/terminalPool.ts');
  assert.match(pool, /const firstWrite = startupRedrawPending\(ptyId\);\s*term\.write\(chunk, \(\) => \{\s*if \(firstWrite\) noteFirstAgentRedraw\(ptyId\);/);
  assert.match(code('src/renderer/src/main.tsx'), /startRendererStartupTiming\(\);/);
  assert.match(code('src/preload/index.ts'), /startupTiming: \(batch[\s\S]*?\): void =>\s*ipcRenderer\.send\('startup:timing', batch\)/);
});

// ── (2) MEMORY-STATUS-LAZY ────────────────────────────────────────────────────

function fakeWorker() {
  const w = { posted: [], handlers: { message: [], exit: [] } };
  w.postMessage = (m) => {
    w.posted.push(m);
    if (m.op === 'status') setImmediate(() => w.handlers.message.forEach((f) => f({ id: m.id, ok: true, exit: 0, json: { sources: 141, chunks: 900 } })));
  };
  w.on = (ev, fn) => w.handlers[ev].push(fn);
  w.kill = () => true;
  return w;
}

function lazyWiring(over = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st162-'));
  const res = path.join(root, 'res');
  const plat = `${process.platform}-${process.arch}`;
  const vec = path.join(root, 'vec0.bin');
  fs.writeFileSync(vec, 'v');
  fs.mkdirSync(path.join(res, 'models', 'm', 'onnx'), { recursive: true });
  fs.writeFileSync(path.join(res, 'models', 'm', 'onnx', 'model.onnx'), 'o');
  fs.writeFileSync(path.join(res, 'models', 'native-memory-manifest.json'), JSON.stringify({ model: { dir: 'm', onnxSha256: 'a', tokenizerSha256: 'b' }, vec0: { [plat]: { package: 'p', file: 'vec0.bin', sha256: 'c' } } }));
  const forks = [];
  const w = new NativeMemoryWiring({
    hiveRoot: () => root, enabled: () => true, userData: path.join(root, 'ud'), resourcesDir: res, workerEntry: 'w.js',
    fork: () => { const x = fakeWorker(); forks.push(x); return x; }, memoryBaseUrl: () => null,
    writeCommand: () => null, log: () => {}, vecLoadablePath: () => vec, ...over
  });
  return { w, forks, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('(2) the panel\'s status (asked at start-up) NEVER forks the worker: running false, no index ("starts on first use")', async () => {
  const { w, forks, cleanup } = lazyWiring();
  try {
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(await w.statusReport(), { available: true, running: false, reason: null, index: null });
    }
    assert.equal(forks.length, 0, 'no fork');
    assert.equal(w.running(), false);
  } finally { cleanup(); }
});

test('(2) once the worker runs (a first search, or the 30 s prewarm), status asks it and reports the index', async () => {
  const { w, forks, cleanup } = lazyWiring();
  try {
    assert.equal(w.prewarm(), true);
    assert.equal(forks.length, 1);
    const s = await w.statusReport();
    assert.equal(s.running, true);
    assert.deepEqual(s.index, { sources: 141, chunks: 900 });
    assert.equal(forks.length, 1, 'no second fork');
  } finally { cleanup(); }
});

test('(2) unavailable memory reports its reason, running false, and forks nothing', async () => {
  const { w, forks, cleanup } = lazyWiring({ enabled: () => false });
  try {
    assert.deepEqual(await w.statusReport(), { available: false, running: false, reason: 'disabled', index: null });
    assert.equal(forks.length, 0);
  } finally { cleanup(); }
});

test('(2) WIRING: the IPC answers from statusReport (never query(\'status\') directly); the panel says "starts on first use"', () => {
  const idx = code('src/main/index.ts');
  const h = idx.slice(idx.indexOf("ipcMain.handle('hive:memoryStatus'"), idx.indexOf("ipcMain.handle('hive:searchMemory'"));
  assert.match(h, /nativeMemory\.statusReport\(\)/);
  assert.doesNotMatch(h, /query\(/, 'the status IPC cannot fork the worker');
  assert.equal((idx.match(/nativeMemory\.query\('status'/g) || []).length, 0, 'no other path asks status through the forking query');
  const panel = code('src/renderer/src/components/MemoryPanel.tsx');
  assert.match(panel, /status\.running === false\s*\? \{ dot: 'var\(--cth-mint\)', label: 'On · starts on first use' \}/);
  assert.match(code('src/preload/index.ts'), /running: boolean;/);
});

// ── Jim's R1-R4 (STARTUP-TIMING-162-AUDIT) ─────────────────────────────────────────────────

test('R1: per-terminal output counts per second, one row per terminal per loop row (and at stop); counts only, no content; nothing after stop', () => {
  const r = rig();
  r.rec.start();
  r.rec.ptyOutput('god', 100);            // second 0 (t=500)
  r.advance(600); r.rec.ptyOutput('god', 50);   // t=1100: second 1
  r.rec.ptyOutput('dwight-1', 3_000_000);
  r.advance(2_000); r.rec.ptyOutput('god', 7);  // t=3100: second 3
  r.rec.ptyOutput('god', 0); r.rec.ptyOutput('god', NaN); r.rec.ptyOutput('C:\evil path', 5);
  for (let i = 0; i < STARTUP_LOOP_ROW_SAMPLES; i++) r.tick(1);
  const rows = r.rows.filter((x) => x.ev === 'pty-bytes');
  assert.deepEqual(rows, [
    { kind: 'startup-timing', ev: 'pty-bytes', id: 'god', t: 0, stepMs: 1000, chars: [100, 50, 0, 7] },
    { kind: 'startup-timing', ev: 'pty-bytes', id: 'dwight-1', t: 1000, stepMs: 1000, chars: [3_000_000] }
  ], 'flushed with the loop row; an unsafe id is never written');
  r.rec.ptyOutput('god', 9);
  r.rec.stop();
  assert.deepEqual(r.rows.filter((x) => x.ev === 'pty-bytes').at(-1).chars, [9], 'the partial segment flushes at stop');
  const n = r.rows.length;
  r.rec.ptyOutput('god', 9);
  r.rec.stop();
  assert.equal(r.rows.length, n);
});

test('R1: terminal-open is a renderer mark (once per terminal); R3: renderer times are clamped to [0, window]', () => {
  const r = rig();
  r.rec.start();
  r.rec.fromRenderer({
    marks: [{ name: 'terminal-open', at: 1_000_000 + 2_000, id: 'god' }, { name: 'terminal-open', at: 1_000_000 + 2_500, id: 'god' }],
    longtasks: [{ at: 1_000_000 - 50_000, ms: 60 }, { at: 1_000_000 + 9e9, ms: 70 }]
  });
  r.rec.fromRenderer({ marks: [{ name: 'first-agent-redraw', at: -5, id: 'x' }] });
  assert.deepEqual(r.rows.filter((x) => x.ev === 'mark').map((m) => [m.name, m.id, m.t]), [['terminal-open', 'god', 2000], ['first-agent-redraw', 'x', 0]]);
  assert.deepEqual(r.rows.filter((x) => x.ev === 'longtask').map((x) => x.t), [0, STARTUP_TIMING_WINDOW_MS]);
});

test('R4: both timers are unref\'d (they never hold the process open)', () => {
  const handles = [];
  const mk = () => { const h = { unrefd: false, unref() { this.unrefd = true; } }; handles.push(h); return h; };
  const hist = { enable() {}, disable() {}, reset() {}, max: 0, percentile: () => 0 };
  const rec = new StartupTiming({ origin: 0, now: () => 10, log: () => {}, histogram: () => hist,
    setInterval: mk, clearInterval: () => {}, setTimeout: mk, clearTimeout: () => {} });
  rec.start();
  assert.equal(handles.length, 2, 'the sampler and the stop timer');
  assert.ok(handles.every((h) => h.unrefd), 'both unref\'d');
});
