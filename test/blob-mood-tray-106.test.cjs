'use strict';
// BLOB-ORCH-MOOD + BLOB-TRAY-TOASTS (1.1.106): the one orchestrator mood source, the faces each
// surface shows, the PNG renderer's hidden window, and the tray's face swap.
require('./tools/own-job.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { OrchestratorMood, deriveMood, newlyDone, countOpenAsks, MOOD_HOLD_MS, MOOD_HAPPY_MS, MOOD_SLEEPY_MS } = loadTs('src/main/blobMood.ts');
const { BLOB_FACES, MOOD_FACE, trayFace, toastFace, currentFace, BLOB_IDENTITY } = loadTs('src/shared/blobFace.ts');
const { BlobFaceRenderer, BLOB_RENDER_SIZES, BLOB_RENDER_STEP_MS, blobatarSvg, rasterScript } = loadTs('src/main/blobFaceRenderer.ts');
const { TrayModeController } = loadTs('src/main/trayMode.ts');
const { BLOB_MOODS } = loadTs('src/shared/blob.ts');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');

const god = (classification, since = 0, extra = {}) => ({ classification, classifiedSince: since, ...extra });
const quiet = (g = god('IDLE', 0)) => ({ god: g, breakerLevels: ['healthy'], openAsks: 0 });

test('deriveMood: the god-approved priority, highest first', () => {
  const now = 10 * 60_000;
  assert.equal(deriveMood(quiet(god('CRASHED')), now, 0), 'sad');
  assert.equal(deriveMood(quiet(god('STUCK_WAKE')), now, 0), 'sad');
  assert.equal(deriveMood(quiet(god('EXITED', 0, { reason: 'pty-exit-unrequested' })), now, 0), 'sad');
  assert.equal(deriveMood(quiet(god('EXITED', 0, { reason: 'pty-exit-requested' })), now, 0), 'idle', 'a requested exit is not an error');
  // sad beats sick beats happy beats waiting beats working
  assert.equal(deriveMood({ god: god('CRASHED'), breakerLevels: ['steering'], openAsks: 3 }, now, now + 1), 'sad');
  for (const level of ['steering', 'constrained', 'stopped']) {
    assert.equal(deriveMood({ god: god('BUSY_PROGRESSING'), breakerLevels: ['healthy', level], openAsks: 2 }, now, now + 1), 'sick', level);
  }
  assert.equal(deriveMood({ god: god('BUSY_PROGRESSING'), breakerLevels: ['healthy'], openAsks: 2 }, now, now + 1), 'happy');
  assert.equal(deriveMood({ god: god('BUSY_PROGRESSING'), breakerLevels: ['healthy'], openAsks: 2 }, now, now), 'waiting', 'the burst has ended');
  assert.equal(deriveMood(quiet(god('BUSY_PROGRESSING')), now, 0), 'working');
  assert.equal(deriveMood(quiet(god('IDLE', now - MOOD_SLEEPY_MS)), now, 0), 'sleepy');
  assert.equal(deriveMood(quiet(god('IDLE', now - MOOD_SLEEPY_MS + 1)), now, 0), 'idle');
  assert.equal(deriveMood(quiet(null), now, 0), 'idle', 'no god');
  assert.equal(deriveMood(quiet(god('CRASHED', 0, { lifecycle: 'ARCHIVED' })), now, 0), 'idle', 'an archived god is not an error');
  for (const m of ['sad', 'sick', 'happy', 'waiting', 'working', 'sleepy', 'idle']) assert.ok(BLOB_MOODS.includes(m), m);
});

function fakeTimers() {
  const pending = new Map(); let seq = 0;
  return { pending, set: (fn, ms) => { seq += 1; pending.set(seq, { fn, ms }); return seq; }, clear: (h) => { pending.delete(h); },
    fire() { const all = [...pending.entries()]; pending.clear(); for (const [, t] of all) t.fn(); } };
}

function moodWorld(inputs) {
  let now = 1_000_000; const timers = fakeTimers(); const shown = [];
  const m = new OrchestratorMood({ read: () => inputs, now: () => now, timers });
  m.onChange((x) => shown.push(x));
  return { m, timers, shown, inputs, advance(ms) { now += ms; }, get now() { return now; } };
}

test('OrchestratorMood: the shown mood changes at most once per hold (no thrash), and catches up after it', () => {
  const w = moodWorld(quiet(god('BUSY_PROGRESSING', 0)));
  assert.equal(w.m.tick(), 'working'); assert.deepEqual(w.shown, ['working']);
  w.inputs.god = god('IDLE', 0); w.inputs.openAsks = 1;
  w.advance(500);
  assert.equal(w.m.tick(), 'working', 'inside the hold the old mood stays');
  assert.equal(w.timers.pending.size, 1, 'a re-check is scheduled for the end of the hold');
  assert.equal([...w.timers.pending.values()][0].ms, MOOD_HOLD_MS - 500);
  w.inputs.god = god('BUSY_PROGRESSING', 0); w.inputs.openAsks = 0;
  w.advance(100); w.m.tick();   // flipped back inside the hold: nothing shown
  assert.deepEqual(w.shown, ['working']);
  w.inputs.openAsks = 1;
  w.advance(MOOD_HOLD_MS); w.timers.fire();
  assert.deepEqual(w.shown, ['working', 'waiting'], 'after the hold the wanted mood shows once');
  // mutant guard: ten rapid flips inside one hold give no change
  for (let i = 0; i < 10; i += 1) { w.inputs.openAsks = i % 2; w.advance(100); w.m.tick(); }
  assert.deepEqual(w.shown, ['working', 'waiting']);
});

test('OrchestratorMood: several dones in one burst stay one happy burst of 6 s; it ends on its own timer', () => {
  const w = moodWorld(quiet(god('IDLE', 1_000_000)));
  w.m.tick(); assert.deepEqual(w.shown, [], 'it starts idle: no change to report');
  w.advance(MOOD_HOLD_MS);
  w.m.noteCardDone();
  assert.deepEqual(w.shown, ['happy']);
  const end = w.now + MOOD_HAPPY_MS;
  w.advance(2_000); w.m.noteCardDone();
  w.advance(2_000); w.m.noteCardDone();
  assert.deepEqual(w.shown, ['happy'], 'no flicker');
  w.advance(end - w.now - 1); w.m.tick();
  assert.equal(w.m.mood(), 'happy', 'later dones did not extend the burst, and it still holds before its end');
  w.advance(1); w.timers.fire();
  assert.deepEqual(w.shown, ['happy', 'idle'], 'the burst ends at 6 s from the first done');
});

test('OrchestratorMood: a failing read keeps the mood and logs; a throwing listener does not stop the others', () => {
  const rows = []; let fail = false; let now = 0; const got = [];
  const m = new OrchestratorMood({ read: () => { if (fail) throw new Error('boom'); return quiet(god('BUSY_PROGRESSING')); }, now: () => now, timers: fakeTimers(), log: (r) => rows.push(r) });
  m.onChange(() => { throw new Error('listener'); });
  m.onChange((x) => got.push(x));
  assert.equal(m.tick(), 'working'); assert.deepEqual(got, ['working']);
  assert.equal(rows[0].kind, 'blob-mood-listener-failed');
  fail = true; now += 10_000;
  assert.equal(m.tick(), 'working');
  assert.equal(rows[1].kind, 'blob-mood-read-failed');
});

test('newlyDone seeds on the first beat and counts only fresh dones; countOpenAsks matches ASK ME', () => {
  const t1 = [{ id: 'A', status: 'done' }, { id: 'B', status: 'doing' }];
  const s1 = newlyDone(null, t1); assert.equal(s1.fresh, 0, 'startup is not a celebration');
  const s2 = newlyDone(s1.done, [{ id: 'A', status: 'done' }, { id: 'B', status: 'done' }, { id: 'C', status: 'done' }]);
  assert.equal(s2.fresh, 2);
  assert.equal(newlyDone(s2.done, [{ id: 'A', status: 'done' }]).fresh, 0, 'a done card leaving the list is not fresh');
  const asks = [
    { status: 'doing', humanQA: [{ q: 'x?' }] },
    { status: 'blocked', humanQA: [{ q: 'answered', a: 'yes' }, { q: 'open' }] },
    { status: 'done', humanQA: [{ q: 'on a done card' }] },
    { status: 'todo', humanQA: [{ q: 'dismissed', dismissedAt: 5 }] },
    { status: 'todo' }, null,
  ];
  assert.equal(countOpenAsks(asks), 2);
});

test('faces: tray, toast and saved face per state; MOOD_FACE matches BlobApp MOOD_EXPR', () => {
  assert.equal(trayFace('idle', 'listening', true), 'thinking');
  assert.equal(trayFace('sick', 'transcribing', false), 'thinking');
  assert.equal(trayFace('happy', 'error', true), 'sad');
  assert.equal(trayFace('working', 'ready', true), 'thinking', 'a non-idle mood shows even while invisible (the default)');
  assert.equal(trayFace('idle', 'ready', true), 'shy');
  assert.equal(trayFace('idle', 'off', false), 'idle');
  assert.equal(trayFace('waiting', undefined, false), 'unsure');
  assert.equal(toastFace('done', 'sad'), 'happy');
  assert.equal(toastFace('error', 'happy'), 'sad');
  assert.equal(toastFace('info', 'sleepy'), 'sleepy');
  assert.equal(currentFace('working', 'listening'), 'surprised');
  assert.equal(currentFace('working', 'ready'), 'thinking');
  // BlobApp's MOOD_EXPR names the same expressions (one Blob, one map).
  const app = read('src/renderer/src/blob/BlobApp.tsx');
  const block = app.slice(app.indexOf('export const MOOD_EXPR'), app.indexOf('};', app.indexOf('export const MOOD_EXPR')));
  for (const [mood, face] of Object.entries(MOOD_FACE)) {
    assert.ok(new RegExp(`\\b${mood}: ${face}\\b`).test(block) || (mood === face && new RegExp(`\\b${mood},`).test(block)), `${mood} -> ${face} in BlobApp`);
  }
  assert.match(app, /const BLOB_NAME = BLOB_IDENTITY\.name;/, 'BlobApp draws the shared identity');
});

test('every face renders through blobatar with the Blob identity, each face distinct', async () => {
  const seen = new Set();
  for (const face of BLOB_FACES) {
    const uri = await blobatarSvg(face, 32);
    assert.match(uri, /^data:image\/svg\+xml,/);
    // The eye colour is pinned on every face; the head is the pinned yellow unless the expression tints it (sick, shy).
    assert.ok(decodeURIComponent(uri).includes(BLOB_IDENTITY.palette.eye), `${face} uses the pinned eye colour`);
    if (face === 'idle') assert.ok(decodeURIComponent(uri).includes(BLOB_IDENTITY.palette.head), 'idle uses the pinned head colour');
    seen.add(uri);
  }
  assert.equal(seen.size, BLOB_FACES.length, 'no two faces draw the same');
  await assert.rejects(blobatarSvg('nope', 16), /no expression 'nope'/);
});

function fakeWindow(behaviour) {
  const w = { destroyed: false, loaded: [], scripts: 0,
    loadURL: (u) => { w.loaded.push(u); if (behaviour === 'load-hangs') return new Promise(() => {}); return behaviour === 'load-fails' ? Promise.reject(new Error('load failed')) : Promise.resolve(); },
    executeJavaScript: async (code) => {
      w.scripts += 1;
      if (behaviour === 'script-hangs') return new Promise(() => {});
      if (behaviour === 'script-fails') throw new Error('script failed');
      const jobs = JSON.parse(code.slice(code.lastIndexOf('})(') + 3, code.lastIndexOf(')')));
      const out = {};
      for (const [key] of jobs) out[key] = behaviour === 'bad-png' ? 'data:image/svg+xml,x' : `data:image/png;base64,${Buffer.from(key).toString('base64')}`;
      return out;
    },
    destroy: () => { w.destroyed = true; }, isDestroyed: () => w.destroyed };
  return w;
}

test('renderer: one hidden window renders every face x size and is destroyed; render() is once', async () => {
  const wins = []; const rows = [];
  const r = new BlobFaceRenderer({ svgFor: async (f, s) => `data:image/svg+xml,${f}-${s}`, createWindow: () => { const w = fakeWindow('ok'); wins.push(w); return w; }, log: (x) => rows.push(x) });
  assert.equal(r.ready(), false); assert.equal(r.png('happy', 16), null);
  const [a, b] = await Promise.all([r.render(), r.render()]);
  assert.equal(a, true); assert.equal(b, true);
  assert.equal(wins.length, 1, 'concurrent renders share one window');
  assert.equal(wins[0].destroyed, true, 'the window is gone after the render');
  assert.deepEqual(wins[0].loaded, ['about:blank'], 'it loads nothing from the network');
  assert.deepEqual(r.stats, { windows: 1, open: 0 });
  for (const f of BLOB_FACES) for (const s of BLOB_RENDER_SIZES) assert.match(r.png(f, s), /^data:image\/png;base64,/);
  assert.equal(await r.render(), true); assert.equal(wins.length, 1, 'a second render() reuses the PNGs');
  assert.equal(rows[0].kind, 'blob-faces-rendered');
});

test('renderer: a failure leaves no window, logs, never throws, and a later render can succeed', async () => {
  for (const mode of ['load-fails', 'script-fails', 'bad-png']) {
    const wins = []; const rows = [];
    const r = new BlobFaceRenderer({ svgFor: async () => 'data:image/svg+xml,x', createWindow: () => { const w = fakeWindow(mode); wins.push(w); return w; }, log: (x) => rows.push(x) });
    assert.equal(await r.render(), false, mode);
    assert.equal(wins[0].destroyed, true, `${mode}: destroyed in finally`);
    assert.deepEqual(r.stats, { windows: 1, open: 0 }, mode);
    assert.equal(r.ready(), false); assert.equal(r.png('idle', 16), null);
    assert.equal(rows[0].kind, 'blob-faces-render-failed', mode);
  }
  // svg generation fails before any window exists: none is created
  const wins = [];
  const r = new BlobFaceRenderer({ svgFor: async () => { throw new Error('no blobatar'); }, createWindow: () => { const w = fakeWindow('ok'); wins.push(w); return w; } });
  assert.equal(await r.render(), false); assert.equal(wins.length, 0);
  // a window that throws on create
  const r2 = new BlobFaceRenderer({ svgFor: async () => 'data:image/svg+xml,x', createWindow: () => { throw new Error('no window'); } });
  assert.equal(await r2.render(), false); assert.deepEqual(r2.stats, { windows: 0, open: 0 });
  let fail = true;
  const r3 = new BlobFaceRenderer({ svgFor: async () => 'data:image/svg+xml,x', createWindow: () => fakeWindow(fail ? 'script-fails' : 'ok') });
  assert.equal(await r3.render(), false); fail = false;
  assert.equal(await r3.render(), true, 'a retry after a failure works');
});

test('Jim SHOULD: a raster script (or load) that never settles fails the render at the step cap: false, destroyed, open 0, logged', async () => {
  assert.equal(BLOB_RENDER_STEP_MS, 5_000);
  for (const mode of ['script-hangs', 'load-hangs']) {
    const wins = []; const rows = [];
    const r = new BlobFaceRenderer({ svgFor: async () => 'data:image/svg+xml,x', createWindow: () => { const w = fakeWindow(mode); wins.push(w); return w; }, log: (x) => rows.push(x), stepMs: 50 });
    assert.equal(await r.render(), false, `${mode}: THE RENDER NEVER ANSWERED`);
    assert.equal(wins[0].destroyed, true, `${mode}: THE HUNG WINDOW WAS NOT DESTROYED`);
    assert.deepEqual(r.stats, { windows: 1, open: 0 }, mode);
    assert.equal(rows[0].kind, 'blob-faces-render-failed');
    assert.match(rows[0].error, /did not settle in 50 ms/);
  }
});

test('rasterScript is a self-contained page script with the jobs inlined (no network, no node)', () => {
  const code = rasterScript([['idle@16', 'data:image/svg+xml,%3Csvg%3E', 16]]);
  assert.match(code, /toDataURL\('image\/png'\)/);
  assert.ok(!/require\(|fetch\(|XMLHttpRequest|import\(/.test(code));
  assert.ok(code.includes(JSON.stringify([['idle@16', 'data:image/svg+xml,%3Csvg%3E', 16]])));
});

class FakeTray {
  constructor(icon) { this.icon = icon; this.images = []; this.destroyed = false; }
  setContextMenu() {} on() {} destroy() { this.destroyed = true; } isDestroyed() { return this.destroyed; }
  setImage(i) { if (i === 'throw') throw new Error('bad image'); this.images.push(i); this.icon = i; }
}

test('tray: setFace swaps the live icon, a new tray starts on the face, and the exe icon stays until a face exists', async () => {
  let enabled = true; const trays = []; let iconCalls = 0;
  const ctl = new TrayModeController({ platform: () => 'win32', enabled: () => enabled, icon: async () => { iconCalls += 1; return 'exe'; },
    createTray: (i) => { const t = new FakeTray(i); trays.push(t); return t; }, buildMenu: (x) => x, toggleBlob() {}, quit() {} });
  await ctl.sync();
  assert.equal(trays[0].icon, 'exe', 'no face yet: the exe icon');
  ctl.setFace(null); assert.equal(trays[0].icon, 'exe', 'a missing face keeps the exe icon');
  ctl.setFace('happy-img'); assert.equal(trays[0].icon, 'happy-img');
  ctl.setFace('happy-img'); assert.deepEqual(trays[0].images, ['happy-img'], 'the same face is not re-set');
  ctl.setFace('throw'); assert.equal(trays[0].icon, 'happy-img', 'a failing swap keeps the current icon');
  enabled = false; await ctl.sync(); enabled = true;
  ctl.setFace('sad-img'); await ctl.sync();
  assert.equal(trays[1].icon, 'sad-img', 'a tray created later starts on the current face');
  assert.equal(iconCalls, 1, 'the exe icon is not fetched once a face exists');
});

test('index.ts wiring: one mood feeds overlay + tray; toasts carry faces; save IPC is app-only; render is lazy', () => {
  const src = read('src/main/index.ts');
  assert.match(src, /orchestratorMood\.onChange\(\(m\) => \{ blobOverlay\.setMood\(m\); refreshTrayFace\(\); \}\);/);
  assert.match(src, /hookServer\.toastIcon = \(kind\) => blobToastIcon\(kind\);/);
  assert.match(src, /new Notification\(\{ title, body, \.\.\.blobToastIconOpt\('error'\) \}\)/, 'breaker toasts are sad');
  assert.match(src, /ipcMain\.handle\('blob:save-image', async \(evt\)[^\n]*\n  if \(!ledgerUiSender\(evt\)\) return/);
  assert.match(src, /webPreferences: \{ session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true/);
  assert.match(src, /cb\(\{ cancel: !\/\^\(data\|about\):\/i\.test\(d\.url\) \}\)/, 'the render session fetches nothing');
  assert.match(src, /session\.fromPartition\('blob-face-render'\)/, 'an in-memory partition, not persist:');
  // lazy: the only render() calls are the 10 s timer inside armAlwaysOnBeats and the Save handler
  const calls = src.split('blobFaces.render()').length - 1;
  assert.equal(calls, 2);
  const beats = src.slice(src.indexOf('function armAlwaysOnBeats'), src.indexOf('function armAlwaysOnBeats') + 1500);
  assert.match(beats, /blobFacesTimer = setTimeout\(\(\) => \{ void blobFaces\.render\(\)[\s\S]*\}, 10_000\);/);
  assert.match(read('src/main/hooks.ts'), /this\.notify\(agentId \?\? 'Agent', 'finished — idle', 'done'\);/, 'an agent done toast is happy');
  assert.match(read('src/preload/index.ts'), /blobSaveImage: \(\): Promise<BlobSaveImageResult> => ipcRenderer\.invoke\('blob:save-image'\)/);
});
