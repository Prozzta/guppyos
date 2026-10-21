'use strict';

/**
 * STALL-WATCH-198 (god, UI-CRAWL-HALFCORES-197): main-stall / input-delay / renderer-longtask rows
 * in log.jsonl, from a 25 ms heartbeat and timed sync calls (ipc handlers, sync fs),
 * plus the renderer's Event Timing and long tasks. Rate-capped (1 row per kind per 5 s, the rest
 * folded), config `stallWatch` default on, part 5 (the profiler) default OFF. Never typed text.
 *
 * Each check is a killer in K (it throws when the module misbehaves); the tests run them on the
 * real source and the census at the end runs them on mutated source (loadTs.fromText, nothing
 * written to disk). One real block too: a spawnSync of a 300 ms busy node child on the real clock
 * is a row with no slice (child_process is never wrapped: main makes no sync child call).
 * No hive, no HOME: nothing here builds hive objects.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const MAIN = 'src/main/stallWatch.ts';
const RENDERER = 'src/renderer/src/stallWatch.ts';
const ROOT = path.join(__dirname, '..');
const src = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const code = (p) => src(p).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
const M = loadTs(MAIN);
const R = loadTs(RENDERER);

const ORIGIN = 1_700_000_000_000;

/** A watcher on a fake clock; the heartbeat is driven by hand (beat()). */
function rig(mod = M, deps = {}) {
  let now = 1000;
  const rows = [];
  const timers = [];
  const w = new mod.StallWatch({
    now: () => now, origin: ORIGIN, log: (r) => rows.push(r),
    setInterval: (fn, ms) => { timers.push({ fn, ms }); return `I${timers.length}`; },
    clearInterval: () => {},
    ...deps
  });
  return { w, rows, timers, advance: (ms) => { now += ms; }, at: () => now, stalls: () => rows.filter((r) => r.kind === 'main-stall') };
}

/** A fake target whose sync calls take `ms` on the fake clock. */
function slowObj(r, names, ms) {
  const o = {};
  for (const n of names) o[n] = function (...args) { r.advance(ms); return { self: this, args }; };
  return o;
}

function fakeIpc() {
  const ipc = { handlers: {}, listeners: {},
    handle(ch, fn) { this.handlers[ch] = fn; },
    on(ch, fn) { (this.listeners[ch] ||= []).push(fn); return this; },
    once(ch, fn) { (this.listeners[ch] ||= []).push(fn); return this; },
    removeListener(ch, fn) { this.listeners[ch] = (this.listeners[ch] || []).filter((f) => f !== fn); return this; } };
  ipc.off = ipc.removeListener;
  return ipc;
}

const K = {
  /** Config: unset/true/{} = on, false = off; profile only with { profile: true }. */
  mode(mod = M) {
    assert.deepEqual(mod.stallWatchMode(undefined), { on: true, profile: false });
    assert.deepEqual(mod.stallWatchMode(true), { on: true, profile: false });
    assert.deepEqual(mod.stallWatchMode({}), { on: true, profile: false });
    assert.deepEqual(mod.stallWatchMode({ profile: 'yes' }), { on: true, profile: false });
    assert.deepEqual(mod.stallWatchMode(false), { on: false, profile: false });
    assert.deepEqual(mod.stallWatchMode({ profile: true }), { on: true, profile: true });
  },

  /** A beat late by exactly 100 ms is a stall; by 99 it is not. */
  threshold(mod = M) {
    const r = rig(mod);
    r.w.start();
    assert.equal(r.timers[0].ms, 25, 'a 25 ms heartbeat');
    r.advance(25 + 99); r.w.beat();
    assert.equal(r.stalls().length, 0, 'late by 99 ms: no row');
    const from = r.at();
    r.advance(25 + 100); r.w.beat();
    const s = r.stalls();
    assert.equal(s.length, 1, 'late by 100 ms: a main-stall row');
    assert.equal(s[0].ms, 100);
    assert.equal(s[0].eld, 125);
    assert.equal(s[0].at, ORIGIN + from);
    assert.deepEqual(s[0].slices, [], 'no sync call overlapped: an unattributed stall');
  },

  /** A suspend-sized gap (>= 300 s) is not a stall. */
  suspend(mod = M) {
    const r = rig(mod);
    r.w.start();
    r.advance(300_000); r.w.beat();
    assert.equal(r.stalls().length, 0);
  },

  /** Sync fs calls that block main are named in the stall's row (basenames only, longest first). */
  namesFs(mod = M) {
    const r = rig(mod);
    const fsT = { ...slowObj(r, ['readFileSync', 'appendFileSync', 'renameSync', 'readdirSync', 'statSync', 'existsSync'], 300), ...slowObj(r, ['writeFileSync'], 200) };
    r.w.start({ fs: fsT });
    const ret = fsT.readFileSync('C:\\Users\\x\\hive\\agents\\a1\\inbox\\secret-body.json', 'utf8');
    assert.equal(ret.self, fsT, 'the original runs with its own this');
    assert.deepEqual(ret.args, ['C:\\Users\\x\\hive\\agents\\a1\\inbox\\secret-body.json', 'utf8'], 'and its own arguments');
    fsT.writeFileSync('C:\\Program Files\\notes dir\\draft notes.txt', 'typed words');
    r.w.beat();
    const s = r.stalls();
    assert.equal(s.length, 1);
    assert.deepEqual(s[0].slices, [
      { k: 'fs', name: 'readFileSync:secret-body.json', ms: 300 },
      { k: 'fs', name: 'writeFileSync:draft notes.txt', ms: 200 }
    ], 'the longest first; the path basename only (its spaces kept)');
    assert.doesNotMatch(JSON.stringify(s[0]), /typed words|notes dir|Users/, 'no contents, no directories');
    r.w.stop();
    assert.equal(fsT.readFileSync.toString().includes('advance'), true, 'stop() puts the originals back');
    // every listed sync fn is wrapped; an unlisted one (existsSync) is not
    const one = (n, arg, want) => {
      const q = rig(mod);
      const t = slowObj(q, [n], 300);
      q.w.start({ fs: t });
      t[n](arg, ['secret']);
      q.w.beat();
      assert.deepEqual(q.stalls()[0].slices, want, n);
    };
    for (const n of ['writeFileSync', 'appendFileSync', 'renameSync', 'readdirSync', 'statSync']) one(n, '/tmp/f.txt', [{ k: 'fs', name: `${n}:f.txt`, ms: 300 }]);
    one('existsSync', '/tmp/f.txt', []);
  },

  /** ipcMain handlers are timed by channel as they register; removeListener finds the wrapper. */
  ipc(mod = M) {
    const r = rig(mod);
    const ipc = fakeIpc();
    r.w.start({ ipcMain: ipc });
    ipc.handle('hive:slowRead', function (_evt, a) { r.advance(150); return `ok:${a}`; });
    const onFn = () => { r.advance(40); };
    ipc.on('agent:ping', onFn);
    assert.equal(ipc.handlers['hive:slowRead']({}, 'x'), 'ok:x', 'the handler result passes through');
    ipc.listeners['agent:ping'][0]({});
    r.w.beat();
    assert.deepEqual(r.stalls()[0].slices, [{ k: 'ipc', name: 'hive:slowRead', ms: 150 }, { k: 'ipc', name: 'agent:ping', ms: 40 }]);
    ipc.removeListener('agent:ping', onFn);
    assert.equal(ipc.listeners['agent:ping'].length, 0, 'removing the original removes its wrapper');
    r.w.stop();
    assert.equal(Object.prototype.hasOwnProperty.call(ipc, 'handle'), true);
    ipc.handle('after', () => 1);
    assert.equal(ipc.handlers.after.toString(), '() => 1', 'after stop(), registration is not wrapped');
  },

  /** On a real EventEmitter: once is timed once (it registers through on) and still removable. */
  ipcOnce(mod = M) {
    const { EventEmitter } = require('node:events');
    const r = rig(mod);
    const ipc = new EventEmitter();
    ipc.handle = () => {};
    r.w.start({ ipcMain: ipc });
    let calls = 0;
    ipc.once('win:closed', () => { calls++; r.advance(160); });
    ipc.emit('win:closed'); ipc.emit('win:closed');
    assert.equal(calls, 1);
    r.w.beat();
    assert.deepEqual(r.stalls()[0]?.slices, [{ k: 'ipc', name: 'win:closed', ms: 160 }], 'one slice, not two');
    const L = () => {};
    ipc.once('x', L);
    ipc.removeListener('x', L);
    assert.equal(ipc.listenerCount('x'), 0, 'a once listener is removable by its original');
    r.w.stop();
  },

  /** A slice is kept at >= 16 ms (and named only then). */
  sliceFloor(mod = M) {
    const r = rig(mod);
    let named = 0;
    r.w.slice('fs', () => { named++; return 'short'; }, 5000, 5015.9);
    r.w.slice('fs', () => { named++; return 'edge'; }, 5000, 5016);
    assert.equal(named, 1, 'a sub-16 ms call is never named');
    assert.deepEqual(r.w.overlapping(0, 1e9).map((s) => s.name), ['edge']);
  },

  /** Overlap is strict at both ends: a slice ending at the window start, or starting at its end, is out. */
  overlap(mod = M) {
    const r = rig(mod);
    r.w.slice('fs', () => 'before', 900, 1000);
    r.w.slice('fs', () => 'straddle-start', 950, 1020);
    r.w.slice('fs', () => 'inside', 1100, 1200);
    r.w.slice('fs', () => 'straddle-end', 1290, 1350);
    r.w.slice('fs', () => 'after', 1300, 1400);
    assert.deepEqual(r.w.overlapping(1000, 1300).map((s) => s.name), ['inside', 'straddle-start', 'straddle-end']);
  },

  /** The ring keeps the last 200 slices and a row carries the 8 longest. */
  ring(mod = M) {
    const r = rig(mod);
    for (let i = 0; i < 250; i++) r.w.slice('fs', () => `s${i}`, i * 100, i * 100 + 20 + (i % 10));
    const all = r.w.overlapping(0, 1e9);
    assert.equal(all.length, 8);
    assert.ok(all.every((s) => Number(s.name.slice(1)) >= 50), 'the oldest 50 were overwritten');
    assert.equal(all[0].ms, 29);
  },

  /** The rate cap: one row per kind per 5 s; the window's worst is written at its end with `folded`. */
  cap(mod = M) {
    const r = rig(mod);
    r.w.start();
    const stall = (late) => { r.advance(25 + late); r.w.beat(); };
    stall(150);                       // written
    for (const late of [120, 900, 300]) stall(late);  // folded
    assert.equal(r.stalls().length, 1, 'a burst inside 5 s writes one row');
    // the window (5 s from the first row) ends: quiet beats until then
    while (r.at() < 1000 + 175 + 4975) { r.advance(25); r.w.beat(); }
    assert.equal(r.stalls().length, 1, 'still folded 4,975 ms into the window');
    while (r.at() < 1000 + 175 + 5000) { r.advance(25); r.w.beat(); }
    const s = r.stalls();
    assert.equal(s.length, 2, 'the folded worst is written when the window ends');
    assert.equal(s[1].ms, 900);
    assert.equal(s[1].folded, 3);
    stall(200);
    assert.equal(r.stalls().length, 2, 'that write opened a new window: the next stall folds');
  },

  /** An event exactly at the window's end is written, not folded. */
  capEdge(mod = M) {
    const r = rig(mod);
    r.w.start();
    r.w.fromRenderer({ longtasks: [{ at: 1, ms: 300 }] });
    r.advance(5000);
    r.w.fromRenderer({ longtasks: [{ at: 2, ms: 250 }] });
    const lt = r.rows.filter((x) => x.kind === 'renderer-longtask');
    assert.deepEqual(lt.map((x) => [x.ms, x.folded]), [[300, undefined], [250, undefined]]);
  },

  /** stop() writes a folded row still pending. */
  capStop(mod = M) {
    const r = rig(mod);
    r.w.start();
    r.w.fromRenderer({ longtasks: [{ at: 1, ms: 300 }, { at: 2, ms: 400 }] });
    r.w.stop();
    const lt = r.rows.filter((x) => x.kind === 'renderer-longtask');
    assert.deepEqual(lt.map((x) => [x.ms, x.folded]), [[300, undefined], [400, 1]]);
  },

  /** The renderer batch: allow-listed events, sums >= 100 ms, a safe target, never other fields. */
  input(mod = M) {
    const r = rig(mod);
    r.w.start();
    r.w.fromRenderer({ inputs: [
      { ev: 'keydown', at: 1234.4, inputMs: 80, procMs: 900, presMs: 20, target: 'composer-input', text: 'secret typed text', key: 'a', data: 'secret' }
    ] });
    const rows = r.rows.filter((x) => x.kind === 'input-delay');
    assert.deepEqual(rows, [{ kind: 'input-delay', ev: 'keydown', at: 1234, ms: 1000, inputMs: 80, procMs: 900, presMs: 20, target: 'composer-input' }]);
    for (const [ms, label] of [[[33, 33, 33], 'a 99 ms sum'], [[0, 0, 0], 'zero']]) {
      const q = rig(mod); q.w.start();
      q.w.fromRenderer({ inputs: [{ ev: 'keydown', at: 1, inputMs: ms[0], procMs: ms[1], presMs: ms[2] }] });
      assert.equal(q.rows.length, 0, label);
    }
    const e = rig(mod); e.w.start();
    e.w.fromRenderer({ inputs: [{ ev: 'keydown', at: 1, inputMs: 34, procMs: 33, presMs: 33 }] });
    assert.equal(e.rows.length, 1, 'a 100 ms sum is kept');
    for (const bad of [
      { ev: 'keyup', at: 1, inputMs: 500, procMs: 0, presMs: 0 },
      { ev: 'click', at: 1, inputMs: 500, procMs: 0, presMs: 0 },
      { ev: 'keydown', at: 1, inputMs: -400, procMs: 600, presMs: 0 },
      { ev: 'keydown', at: 1, inputMs: '500', procMs: 0, presMs: 0 },
      { ev: 'keydown', at: Infinity, inputMs: 500, procMs: 0, presMs: 0 }
    ]) {
      const q = rig(mod); q.w.start();
      q.w.fromRenderer({ inputs: [bad] });
      assert.equal(q.rows.length, 0, JSON.stringify(bad));
    }
    const t = rig(mod); t.w.start();
    t.w.fromRenderer({ inputs: [{ ev: 'input', at: 1, inputMs: 500, procMs: 0, presMs: 0, target: 'hello world typed' }] });
    assert.equal('target' in t.rows[0], false, 'a target that is not an id is dropped');
  },

  /** Renderer long tasks: >= 200 ms; name/attr only as tokens. */
  longtask(mod = M) {
    const r = rig(mod); r.w.start();
    r.w.fromRenderer({ longtasks: [{ at: 1, ms: 199 }] });
    assert.equal(r.rows.length, 0, '199 ms: dropped');
    r.w.fromRenderer({ longtasks: [{ at: 1, ms: 200, name: 'self', attr: 'Not A Token!' }] });
    assert.deepEqual(r.rows, [{ kind: 'renderer-longtask', at: 1, ms: 200, name: 'self' }]);
  },

  /** Off (never started): nothing is written, nothing is wrapped. */
  off(mod = M) {
    const r = rig(mod);
    r.w.fromRenderer({ longtasks: [{ at: 1, ms: 900 }], inputs: [{ ev: 'keydown', at: 1, inputMs: 900, procMs: 0, presMs: 0 }] });
    r.advance(2000); r.w.beat();
    assert.equal(r.rows.length, 0);
    assert.equal(r.timers.length, 0, 'no heartbeat');
    assert.equal(mod.stallWatchMode(false).on, false);
  },

  /** Part 5 off by default: no session is asked for unless a profiler factory is passed. */
  profileOffByDefault(mod = M) {
    const r = rig(mod);
    r.w.start();
    assert.equal(r.timers.length, 1, 'only the heartbeat');
  },

  /** Part 5: a window with a >= 500 ms stall keeps its top frames; a quieter one does not. */
  profile(mod = M) {
    const posts = [];
    const profileRes = { profile: { nodes: [
      { id: 1, hitCount: 3, callFrame: { functionName: 'readConfig', url: 'file:///C:/app/out/main/index.js', lineNumber: 99 } },
      { id: 2, hitCount: 50, callFrame: { functionName: '(garbage collector)', url: '', lineNumber: -1 } },
      { id: 3, hitCount: 0, callFrame: { functionName: 'idle', url: '', lineNumber: 0 } },
      { id: 4, hitCount: 2, callFrame: { functionName: 'readConfig', url: 'file:///C:/app/out/main/index.js', lineNumber: 99 } }
    ] } };
    const session = { post(m, p, cb) { posts.push(m); if (cb) cb(null, profileRes); }, disconnect() { posts.push('disconnect'); } };
    const r = rig(mod, { profiler: () => session });
    r.w.start();
    assert.deepEqual(posts, ['Profiler.enable', 'Profiler.setSamplingInterval', 'Profiler.start']);
    assert.equal(r.timers[1].ms, 30_000);
    r.advance(25 + 499); r.w.beat();
    r.w.cycleProfile();
    assert.equal(r.rows.filter((x) => x.kind === 'main-stall-profile').length, 0, 'a 499 ms worst: not kept');
    assert.deepEqual(posts.slice(3), ['Profiler.stop', 'Profiler.start'], 'and the next window starts');
    r.advance(25 + 500); r.w.beat();
    r.w.cycleProfile();
    const p = r.rows.filter((x) => x.kind === 'main-stall-profile');
    assert.equal(p.length, 1, 'a 500 ms worst: kept');
    assert.equal(p[0].worstMs, 500);
    assert.deepEqual(p[0].top, [
      { fn: '(garbage collector)', file: '', line: 0, ms: 500 },
      { fn: 'readConfig', file: 'index.js', line: 100, ms: 50 }
    ]);
    r.w.cycleProfile();
    assert.equal(r.rows.filter((x) => x.kind === 'main-stall-profile').length, 1, 'the worst resets per window');
    r.w.stop();
    assert.equal(posts.at(-1), 'disconnect');
  }
};

/** The renderer half on fake observers: an entry becomes a batch without its text. */
function rendererRig(mod = R) {
  const obs = {};
  const sent = [];
  const saved = { window: global.window, PerformanceObserver: global.PerformanceObserver };
  let interval = null;
  global.window = { cth: { stallWatch: (b) => sent.push(JSON.parse(JSON.stringify(b))) }, setInterval: (fn) => { interval = fn; return 1; } };
  global.PerformanceObserver = class {
    constructor(cb) { this.cb = cb; }
    observe(o) { obs[o.type] = { cb: this.cb, opts: o, self: this }; }
  };
  global.PerformanceObserver.supportedEntryTypes = ['event', 'longtask'];
  try { mod.startRendererStallWatch(); } finally { Object.assign(global, saved); }
  const feed = (type, entries) => obs[type].cb({ getEntries: () => entries });
  return { obs, sent, flush: () => { global.window = { cth: { stallWatch: (b) => sent.push(JSON.parse(JSON.stringify(b))) } }; try { interval(); } finally { global.window = saved.window; } }, feed };
}

const KR = {
  /** A keydown that busy-looped 900 ms in its handler gives an input-delay entry with the target's
   *  test id and never its value or text. */
  rendererInput(mod = R) {
    const rr = rendererRig(mod);
    assert.equal(rr.obs.event.opts.durationThreshold, 104);
    const composer = { tagName: 'TEXTAREA', id: '', value: 'secret typed text', textContent: 'secret typed text',
      getAttribute: (a) => (a === 'data-testid' ? 'composer-input' : null), closest() { return this; } };
    rr.feed('event', [
      { name: 'keydown', startTime: 1000, processingStart: 1080, processingEnd: 1980, duration: 1000, target: composer },
      { name: 'keyup', startTime: 1000, processingStart: 1080, processingEnd: 1980, duration: 1000, target: composer },
      { name: 'keydown', startTime: 3000, processingStart: 3010, processingEnd: 3050, duration: 96, target: composer }
    ]);
    rr.feed('longtask', [{ name: 'self', startTime: 1000, duration: 199 }, { name: 'self', startTime: 1000, duration: 900, attribution: [{ containerType: 'window' }] }]);
    rr.flush();
    assert.equal(rr.sent.length, 1);
    const b = rr.sent[0];
    assert.equal(b.inputs?.length, 1, 'only an allow-listed event of >= 100 ms');
    const { at, ...rest } = b.inputs[0];
    assert.ok(Number.isFinite(at));
    assert.deepEqual(rest, { ev: 'keydown', inputMs: 80, procMs: 900, presMs: 20, target: 'composer-input' });
    assert.deepEqual(b.longtasks.map((l) => [l.ms, l.attr]), [[900, 'window']]);
    assert.doesNotMatch(JSON.stringify(b), /secret|typed/, 'never the typed text');
  },

  /** targetName: the nearest data-testid, else id:<id>, else the tag; never a value or text. */
  targetName(mod = R) {
    const el = (o) => ({ tagName: 'DIV', id: '', getAttribute: () => null, closest: () => null, ...o });
    assert.equal(mod.targetName(el({ closest: () => ({ getAttribute: () => 'agent-card' }) })), 'agent-card');
    assert.equal(mod.targetName(el({ id: 'god-box' })), 'id:god-box');
    assert.equal(mod.targetName(el({ id: 'god-box', closest: () => ({ getAttribute: () => 'bad id!' }) })), 'id:god-box', 'a test id that is not an id is skipped');
    assert.equal(mod.targetName(el({ id: 'has spaces', tagName: 'TEXTAREA' })), 'textarea');
    assert.equal(mod.targetName(null), undefined);
    assert.equal(mod.targetName({ value: 'x' }), undefined);
  }
};

test('config stallWatch: unset/true = on, false = off, the profiler only with { profile: true }', () => K.mode());
test('main-stall: a beat late by >= 100 ms is a row (99 is not); no overlapping call = slices []', () => K.threshold());
test('main-stall: a suspend-sized gap is not a stall', () => K.suspend());
test('main-stall names the blocking sync fs calls (basenames only, longest first)', () => K.namesFs());
test('ipcMain handlers are timed by channel; results, this and removeListener still work', () => K.ipc());
test('ipcMain.once: timed once, removable by its original', () => K.ipcOnce());
test('slices: kept at >= 16 ms, named only then', () => K.sliceFloor());
test('slices: overlap is strict at both window ends', () => K.overlap());
test('slices: a 200-entry ring; a row carries the 8 longest', () => K.ring());
test('rate cap: one row per kind per 5 s, the folded worst written at the window end', () => K.cap());
test('rate cap: an event exactly at the window end is written', () => K.capEdge());
test('rate cap: stop() writes the pending folded row', () => K.capStop());
test('input-delay: allow-listed events, >= 100 ms, safe target, no other fields', () => K.input());
test('renderer-longtask: >= 200 ms, token name/attr', () => K.longtask());
test('off: never started = no rows, no heartbeat', () => K.off());
test('part 5 ships off: no profiler session unless one is passed', () => K.profileOffByDefault());
test('part 5: only a window with a >= 500 ms stall keeps its top frames', () => K.profile());
test('renderer: a slow keydown becomes an input-delay entry with a test id, never the text', () => KR.rendererInput());
test('renderer: targetName is a test id, id or tag', () => KR.targetName());

// No child_process wrapping: main makes no sync child call (SYNC-CHILD CENSUS, sync-child-calls-173),
// so a real block of that kind (here, in this test process) is a row with no slice, as native code is.
test('REAL block: a 300 ms spawnSync on the real clock is a main-stall row; child_process is never wrapped', () => {
  const rows = [];
  const w = new M.StallWatch({ now: () => performance.now(), origin: performance.timeOrigin, log: (r) => rows.push(r), setInterval: () => 'I', clearInterval: () => {} });
  const orig = childProcess.spawnSync;
  w.start({ fs });
  try {
    assert.equal(childProcess.spawnSync, orig);
    const res = childProcess.spawnSync(process.execPath, ['-e', 'const t = Date.now(); while (Date.now() - t < 300);'], { windowsHide: true });
    assert.equal(res.status, 0);
    w.beat();
  } finally { w.stop(); }
  const s = rows.filter((r) => r.kind === 'main-stall');
  assert.equal(s.length, 1);
  assert.ok(s[0].ms >= 250, `blocked ${s[0].ms} ms`);
  assert.deepEqual(s[0].slices, []);
  assert.doesNotMatch(code(MAIN), /childProcess|execSync|execFileSync|spawnSync/, 'stallWatch.ts wraps no child_process API');
});

test('wiring: armed before the first ipcMain registration, config-gated, the profiler only on profile, the renderer channel', () => {
  const idx = code('src/main/index.ts');
  const start = idx.indexOf('stallWatch.start(');
  assert.ok(start > 0);
  for (const re of [/ipcMain\.handle\(/, /ipcMain\.on\(/, /ipcMain\.once\(/]) {
    const m = re.exec(idx);
    if (m) assert.ok(m.index > start, `${re} registers before stallWatch.start`);
  }
  assert.match(idx, /const stallMode = stallWatchMode\(readConfig\(\)\.stallWatch\);/);
  assert.match(idx, /if \(stallMode\.on\) stallWatch\.start\(\{ ipcMain, fs: fsModule as unknown as Record<string, unknown> \}\);/);
  assert.match(idx, /profiler: stallMode\.profile \? \(\) => \{[^\n]*\} : null/);
  assert.match(idx, /import fsModule from 'node:fs';/, 'a default import: the real module object, not a namespace copy');
  assert.doesNotMatch(idx, /childProcessModule/, 'main hands stallWatch no child_process (SYNC-CHILD CENSUS)');
  assert.match(idx, /ipcMain\.on\('stall:watch', \(_evt, batch: unknown\) => stallWatch\.fromRenderer\(batch\)\);/);
  assert.match(code('src/preload/index.ts'), /stallWatch: \([^\n]*\): void =>\s*ipcRenderer\.send\('stall:watch', batch\)/);
  assert.match(code('src/renderer/src/main.tsx'), /\nstartRendererStallWatch\(\);/);
  assert.match(code('src/main/config.ts'), /stallWatch\?: boolean \| \{ profile\?: boolean \};/);
  assert.doesNotMatch(code(RENDERER), /\.value\b|textContent|innerText|\.key\b|\.data\b/, 'the renderer half never reads text');
});

// ─── Mutant census: each mutant must be killed by its killer, for the right reason ───────────────

const MUTANTS = [
  { name: 'stall threshold > instead of >=', file: MAIN, from: 'late >= STALL_MIN_MS', to: 'late > STALL_MIN_MS', k: K.threshold },
  { name: 'stall threshold 101', file: MAIN, from: 'STALL_MIN_MS = 100;', to: 'STALL_MIN_MS = 101;', k: K.threshold },
  { name: 'heartbeat 50 ms', file: MAIN, from: 'STALL_BEAT_MS = 25;', to: 'STALL_BEAT_MS = 50;', k: K.threshold },
  { name: 'no suspend skip', file: MAIN, from: ' && gap < STALL_MAX_MS', to: '', k: K.suspend },
  { name: 'slice floor <=', file: MAIN, from: 'if (end - start < SLICE_MIN_MS) return;', to: 'if (end - start <= SLICE_MIN_MS) return;', k: K.sliceFloor },
  { name: 'timed skips the slice', file: MAIN, from: 'if (t1 - t0 >= SLICE_MIN_MS) self.slice(', to: 'if (t1 - t0 >= SLICE_MIN_MS * 1e9) self.slice(', k: K.namesFs },
  { name: 'ipc not wrapped', file: MAIN, from: 'return orig.call(this, channel, listener(channel, fn), ...rest);', to: 'return orig.call(this, channel, fn, ...rest);', k: K.ipc },
  { name: 'once wrapped twice', file: MAIN, from: "for (const m of ['handle', 'on'] as const)", to: "for (const m of ['handle', 'on', 'once'] as const)", k: K.ipcOnce },
  { name: 'once listener not carried', file: MAIN, from: "if ('listener' in fn) (w", to: "if (false) (w", k: K.ipcOnce },
  { name: 'removeListener not mapped', file: MAIN, from: '(typeof fn === \'function\' && map.get(fn)) || fn', to: 'fn', k: K.ipc },
  { name: 'fs path not basenamed', file: MAIN, from: '(a) => `${fn}:${baseName(a[0])}`', to: '(a) => `${fn}:${String(a[0])}`', k: K.namesFs },
  { name: 'overlap end >=', file: MAIN, from: 's.end > from', to: 's.end >= from', k: K.overlap },
  { name: 'overlap start <=', file: MAIN, from: 's.start < to', to: 's.start <= to', k: K.overlap },
  { name: 'overlap not sorted', file: MAIN, from: 'hits.sort((a, b) => (b.end - b.start) - (a.end - a.start));', to: '', k: K.overlap },
  { name: 'row slices 9', file: MAIN, from: 'STALL_ROW_SLICES = 8;', to: 'STALL_ROW_SLICES = 9;', k: K.ring },
  { name: 'ring 250', file: MAIN, from: 'SLICE_RING = 200;', to: 'SLICE_RING = 250;', k: K.ring },
  { name: 'cap window >', file: MAIN, from: 'if (!c || t >= c.until) {', to: 'if (!c || t > c.until) {', k: K.capEdge },
  { name: 'cap 4 s', file: MAIN, from: 'ROW_CAP_MS = 5_000;', to: 'ROW_CAP_MS = 4_000;', k: K.cap },
  { name: 'cap off (every row written)', file: MAIN, from: 'if (!c || t >= c.until) {', to: 'if (true) {', k: K.cap },
  { name: 'folded not counted', file: MAIN, from: '    c.folded++;\n', to: '', k: K.cap },
  { name: 'worst = least', file: MAIN, from: 'if (!c.worst || ms > c.worstMs)', to: 'if (!c.worst || ms < c.worstMs)', k: K.cap },
  { name: 'beat never flushes', file: MAIN, from: '    this.flushDue(t);\n  }\n\n  /** The renderer', to: '  }\n\n  /** The renderer', k: K.cap },
  { name: 'flush keeps no new window', file: MAIN, from: 'this.caps.set(kind, { until: at + ROW_CAP_MS,', to: 'this.caps.set(kind, { until: 0,', k: K.cap },
  { name: 'stop drops pending', file: MAIN, from: '    this.flushDue(Infinity);\n', to: '', k: K.capStop },
  { name: 'input floor <=', file: MAIN, from: 'if (ms < INPUT_DELAY_MIN_MS ||', to: 'if (ms <= INPUT_DELAY_MIN_MS ||', k: K.input },
  { name: 'input events not allow-listed', file: MAIN, from: '!INPUT_EVENTS.has(e.ev) || ', to: '', k: K.input },
  { name: 'input negatives kept', file: MAIN, from: '        if (e.inputMs < 0 || e.procMs < 0 || e.presMs < 0) continue;\n', to: '', k: K.input },
  { name: 'input target unvalidated', file: MAIN, from: "typeof e.target === 'string' && ID_RE.test(e.target)", to: "typeof e.target === 'string'", k: K.input },
  { name: 'input spreads the entry', file: MAIN, from: "ev: e.ev, at: ms0(e.at),", to: "...e, ev: e.ev, at: ms0(e.at),", k: K.input },
  { name: 'longtask floor <=', file: MAIN, from: 'e.ms < RENDERER_LONGTASK_MIN_MS', to: 'e.ms <= RENDERER_LONGTASK_MIN_MS', k: K.longtask },
  { name: 'longtask attr unvalidated', file: MAIN, from: "typeof e.attr === 'string' && TOKEN_RE.test(e.attr)", to: "typeof e.attr === 'string'", k: K.longtask },
  { name: 'fromRenderer ignores off', file: MAIN, from: 'if (!this.on || !batch ||', to: 'if (!batch ||', k: K.off },
  { name: 'config false not off', file: MAIN, from: 'if (v === false) return { on: false, profile: false };', to: '', k: K.mode },
  { name: 'profile on truthy', file: MAIN, from: '(v as { profile?: unknown }).profile === true', to: '!!(v as { profile?: unknown }).profile', k: K.mode },
  { name: 'profile keep >', file: MAIN, from: 'worst >= PROFILE_KEEP_MS', to: 'worst > PROFILE_KEEP_MS', k: K.profile },
  { name: 'profile worst not reset', file: MAIN, from: '    this.windowWorst = 0;\n    try {', to: '    try {', k: K.profile },
  { name: 'renderer input floor 1001', file: RENDERER, from: 'const INPUT_MIN_MS = 100;', to: 'const INPUT_MIN_MS = 1001;', k: KR.rendererInput },
  { name: 'renderer sends the value', file: RENDERER, from: 'const target = targetName(e.target);', to: 'const target = (e.target as unknown as { value?: string })?.value;', k: KR.rendererInput },
  { name: 'renderer no event allow-list', file: RENDERER, from: '!INPUT_EVENTS.has(e.name) || ', to: '', k: KR.rendererInput },
  { name: 'renderer testid unvalidated', file: RENDERER, from: 'if (testId && ID_RE.test(testId)) return testId;', to: 'if (testId) return testId;', k: KR.targetName },
  { name: 'renderer id unvalidated', file: RENDERER, from: 'if (el.id && ID_RE.test(`id:${el.id}`))', to: 'if (el.id)', k: KR.targetName }
];

function mutateText(file, from, to, name) {
  const text = src(file);
  const n = text.split(from).length - 1;
  assert.equal(n, 1, `${name}: anchor found ${n} times`);
  return text.replace(from, to);
}

test('mutant census: every mutant is killed by its killer', async (t) => {
  for (const m of MUTANTS) {
    await t.test(`mutant: ${m.name}`, () => {
      const mod = loadTs.fromText(m.file, mutateText(m.file, m.from, m.to, m.name));
      assert.throws(() => m.k(mod), assert.AssertionError, `${m.name} SURVIVED`);
    });
  }
});
