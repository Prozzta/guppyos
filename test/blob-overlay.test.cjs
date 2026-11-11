'use strict';
require('./tools/own-job.cjs');

/**
 * GUPPY-BLOB-P01: the Guppy blob overlay.
 *
 *  (gate)    the overlay's own channels accept only the overlay's top frame; the app's channels
 *            (blob:setConfig, and every ledgerUiSender channel such as messageBox:deliver) refuse
 *            the overlay even though it is a BrowserWindow (the GUPPY-STAPLER-HOOKS caveat).
 *  (persist) the invisible toggle, the dragged position and the Settings fields are written to the
 *            REAL config.ts (jailed userData) and a fresh controller re-applies them.
 *  (pins)    the overlay preload exposes only blob:overlay:*, the overlay window is focusable:false,
 *            sandboxed, on its own partition, and the overlay never keeps the app alive.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Jail HOME/USERPROFILE and userData BEFORE any product code loads.
const jail = fs.mkdtempSync(path.join(os.tmpdir(), 'blob-overlay-'));
process.env.HOME = jail;
process.env.USERPROFILE = jail;
assert.equal(os.homedir(), jail, 'home is jailed');
const userData = path.join(jail, 'userData');
fs.mkdirSync(userData);
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { app: { getPath: () => userData } } };

const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');
const { readConfig, writeConfig, resetConfig: resetRealConfig } = loadTs('src/main/config.ts');
const {
  BlobOverlayController, registerBlobIpc, isAppWindowSender, isOverlaySender,
  REFUSED_NOT_APP, REFUSED_NOT_OVERLAY, BLOB_SIZE, RING_SIZE, BLOB_GAZE_HIDDEN_MS
} = loadTs('src/main/blobOverlay.ts');
const { ringSlotPosition, RING_SLOTS } = loadTs('src/renderer/src/blob/ring.ts');
const { sanitizeBlobPatch, isValidBlobHotkey, blobSettingsFrom, BLOB_DEFAULT_HOTKEY, BLOB_SLOTS } = loadTs('src/shared/blob.ts');

test.after(() => { require('./load-ts.cjs').closeConfigWatchers(); fs.rmSync(jail, { recursive: true, force: true }); });

const configFile = () => path.join(userData, 'config.json');
const onDisk = () => JSON.parse(fs.readFileSync(configFile(), 'utf8'));
/** A fresh install (through config.ts, which drops its read cache). */
function resetConfig() { resetRealConfig(); }

function fakeContents() {
  const mainFrame = { id: Symbol('frame') };
  return { mainFrame, sent: [], send(ch, payload) { this.sent.push([ch, payload]); }, isDestroyed: () => false };
}

function fakeWindow(bounds) {
  const w = {
    webContents: fakeContents(),
    bounds: { ...bounds },
    destroyed: false,
    visible: true,
    protection: [],
    closedFns: [],
    isDestroyed() { return this.destroyed; },
    isVisible() { return this.visible; },
    showInactive() { this.visible = true; },
    hide() { this.visible = false; },
    destroy() { this.destroyed = true; for (const f of this.closedFns) f(); },
    setContentProtection(on) { this.protection.push(on); },
    setBounds(r) { this.bounds = { ...r }; },
    on(ev, fn) { if (ev === 'closed') this.closedFns.push(fn); }
  };
  return w;
}

function appWindow() {
  return { protection: [], destroyed: false, isDestroyed() { return this.destroyed; }, setContentProtection(on) { this.protection.push(on); } };
}

function harness(opts = {}) {
  const created = [];
  const shortcuts = new Map();
  const logs = [];
  const apps = opts.apps ?? [appWindow()];
  let cursor = { x: 500, y: 500 };
  const displays = opts.displays ?? [{ x: 0, y: 0, width: 1920, height: 1040 }];
  const deps = {
    createWindow: (b, onGone) => { const w = fakeWindow(b); w.onGone = onGone; created.push(w); return w; },
    globalShortcut: {
      register: (acc, fn) => { if (opts.taken && opts.taken.includes(acc)) return false; shortcuts.set(acc, fn); return true; },
      unregister: (acc) => { shortcuts.delete(acc); }
    },
    readConfig: () => readConfig(),
    writeConfig: (p) => writeConfig(p),
    appWindows: () => apps,
    // Displays: the first is primary; a point outside every display gets the nearest (Electron's
    // getDisplayNearestPoint), modelled as the one whose centre is closest.
    workArea: (pt) => {
      if (!pt) return displays[0];
      const inside = displays.find((d) => pt.x >= d.x && pt.x < d.x + d.width && pt.y >= d.y && pt.y < d.y + d.height);
      if (inside) return inside;
      const dist = (d) => Math.hypot(pt.x - (d.x + d.width / 2), pt.y - (d.y + d.height / 2));
      return [...displays].sort((a, b) => dist(a) - dist(b))[0];
    },
    cursor: () => cursor,
    hidden: opts.hidden === true,
    log: (row) => logs.push(row),
    ...(opts.deps ?? {})
  };
  const ctl = new BlobOverlayController(deps);
  return { ctl, created, shortcuts, logs, apps, setCursor: (c) => { cursor = c; }, win: () => created[created.length - 1] };
}

/** ipcMain double: records handlers so a test can invoke a channel as a given sender. */
function fakeIpc() {
  const h = new Map();
  return { handle: (ch, fn) => { assert.ok(!h.has(ch), `${ch} registered once`); h.set(ch, fn); }, call: (ch, evt, ...a) => h.get(ch)(evt, ...a), channels: () => [...h.keys()] };
}

// ─── (gate) ───────────────────────────────────────────────────────────────────

test('gate: isAppWindowSender refuses the overlay, a subframe, and a non-window; accepts an app top frame', () => {
  const app = fakeContents();
  const overlay = fakeContents();
  const known = new Set([app, overlay]); // the overlay IS a BrowserWindow: fromWebContents finds it
  const hasWindow = (wc) => known.has(wc);
  assert.equal(isAppWindowSender({ sender: app, senderFrame: app.mainFrame }, hasWindow, overlay), true);
  assert.equal(isAppWindowSender({ sender: overlay, senderFrame: overlay.mainFrame }, hasWindow, overlay), false, 'overlay refused');
  assert.equal(isAppWindowSender({ sender: app, senderFrame: { id: 'sub' } }, hasWindow, overlay), false, 'subframe refused');
  assert.equal(isAppWindowSender({ sender: fakeContents(), senderFrame: null }, hasWindow, overlay), false, 'no window refused');
  assert.equal(isAppWindowSender(null, hasWindow, overlay), false);
  // no overlay alive: the old rule (any app window top frame)
  assert.equal(isAppWindowSender({ sender: app, senderFrame: app.mainFrame }, hasWindow, null), true);
  assert.equal(isOverlaySender({ sender: overlay, senderFrame: overlay.mainFrame }, null), false, 'no overlay: nothing is the overlay');
});

test('gate: blob:overlay:* only from the overlay top frame; blob:status/setConfig only from an app window', () => {
  resetConfig();
  writeConfig({ blobEnabled: true });
  const hz = harness();
  hz.ctl.apply();
  const overlay = hz.win().webContents;
  const app = fakeContents();
  const known = new Set([app, overlay]);
  // exactly the wiring index.ts uses for ledgerUiSender
  const isApp = (evt) => isAppWindowSender(evt, (wc) => known.has(wc), hz.ctl.overlayContents());
  const ipc = fakeIpc();
  registerBlobIpc(ipc, hz.ctl, isApp);
  assert.deepEqual(ipc.channels().sort(), ['blob:overlay:action', 'blob:overlay:drag', 'blob:overlay:gaze', 'blob:overlay:ring', 'blob:overlay:status', 'blob:setConfig', 'blob:status']);

  const fromOverlay = { sender: overlay, senderFrame: overlay.mainFrame };
  const fromOverlaySub = { sender: overlay, senderFrame: { id: 'iframe' } };
  const fromApp = { sender: app, senderFrame: app.mainFrame };

  for (const ch of ['blob:overlay:status', 'blob:overlay:action', 'blob:overlay:ring', 'blob:overlay:drag', 'blob:overlay:gaze']) {
    assert.deepEqual(ipc.call(ch, fromApp, 'invisible'), REFUSED_NOT_OVERLAY, `${ch} refuses the app window`);
    assert.deepEqual(ipc.call(ch, fromOverlaySub, 'invisible'), REFUSED_NOT_OVERLAY, `${ch} refuses an overlay subframe`);
  }
  assert.equal(ipc.call('blob:overlay:status', fromOverlay).ok, true);

  assert.deepEqual(ipc.call('blob:setConfig', fromOverlay, { invisible: false }), REFUSED_NOT_APP, 'the overlay cannot change its own settings');
  assert.deepEqual(ipc.call('blob:status', fromOverlay), REFUSED_NOT_APP);
  assert.equal(readConfig().blobInvisible, undefined, 'the refused patch wrote nothing');
  assert.equal(ipc.call('blob:status', fromApp).ok, true);
  const r = ipc.call('blob:setConfig', fromApp, { invisibleMain: true });
  assert.equal(r.ok, true);
  assert.equal(r.status.invisibleMain, true);

  // the overlay is refused by the app gate only while it is the live overlay
  assert.equal(isApp(fromOverlay), false);
  hz.ctl.dispose();
  assert.equal(hz.ctl.overlayContents(), null);
  assert.deepEqual(ipc.call('blob:overlay:status', fromOverlay), REFUSED_NOT_OVERLAY, 'a destroyed overlay is no longer trusted');
});

test('gate pin: ledgerUiSender (messageBox:deliver, claims-ui) refuses the live overlay', () => {
  const src = codeOnly(readSource('src/main/index.ts'));
  const m = src.match(/function ledgerUiSender\([^)]*\)[^{]*\{([\s\S]*?)\n\}/);
  assert.ok(m, 'ledgerUiSender exists');
  assert.match(m[1], /isAppWindowSender\(\s*evt\s*,[\s\S]*blobOverlay\??\.overlayContents\(\)/, 'ledgerUiSender passes the live overlay to isAppWindowSender');
  assert.match(src, /ipcMain\.handle\('messageBox:deliver'[\s\S]{0,400}ledgerUiSender\(/, 'messageBox:deliver still gates on ledgerUiSender');
  assert.match(src, /registerBlobIpc\(\s*ipcMain[\s\S]{0,120}blobOverlay\s*,[\s\S]{0,80}ledgerUiSender\(/, 'blob:setConfig uses the same app gate');
});

// ─── (persist) ────────────────────────────────────────────────────────────────

test('persist: off by default: no overlay, no hotkey, nothing written', () => {
  resetConfig();
  const hz = harness();
  const s = hz.ctl.apply();
  assert.equal(s.enabled, false);
  assert.equal(hz.created.length, 0);
  assert.equal(hz.shortcuts.size, 0);
  assert.equal(fs.existsSync(configFile()) && 'blobEnabled' in onDisk(), false);
});

test('persist: enable creates a protected overlay (invisible defaults on) and registers the default hotkey', () => {
  resetConfig();
  const hz = harness();
  const r = hz.ctl.setConfig({ enabled: true });
  assert.equal(r.ok, true);
  assert.equal(onDisk().blobEnabled, true);
  assert.equal(hz.created.length, 1);
  assert.deepEqual(hz.win().protection, [true], 'content protection on');
  assert.deepEqual([...hz.shortcuts.keys()], [BLOB_DEFAULT_HOTKEY]);
  assert.equal(r.status.hotkeyRegistered, true);
  assert.deepEqual(hz.win().bounds, { x: 1920 - BLOB_SIZE - 24, y: 1040 - BLOB_SIZE - 24, width: BLOB_SIZE, height: BLOB_SIZE }, 'default bottom-right corner');
  // the hotkey hides and shows it (inactive)
  hz.shortcuts.get(BLOB_DEFAULT_HOTKEY)();
  assert.equal(hz.win().visible, false);
  hz.shortcuts.get(BLOB_DEFAULT_HOTKEY)();
  assert.equal(hz.win().visible, true);
  hz.ctl.dispose();
  assert.equal(hz.shortcuts.size, 0, 'dispose unregisters');
  assert.equal(hz.win().destroyed, true);
});

test('persist: the invisible toggle writes config, flips protection, and a fresh controller re-applies it', () => {
  resetConfig();
  writeConfig({ blobEnabled: true });
  const a = harness();
  a.ctl.apply();
  const r = a.ctl.action('invisible');
  assert.equal(r.ok && r.state, 'done');
  assert.equal(r.status.invisible, false);
  assert.equal(onDisk().blobInvisible, false, 'persisted');
  assert.deepEqual(a.win().protection, [true, false]);
  const pushed = a.win().webContents.sent.at(-1);
  assert.equal(pushed[0], 'blob:status');
  assert.equal(pushed[1].invisible, false, 'the overlay is told');
  a.ctl.dispose();

  const b = harness();
  b.ctl.apply();
  assert.deepEqual(b.win().protection, [false], 'restart: the persisted state is applied');
  b.ctl.action('invisible');
  assert.equal(onDisk().blobInvisible, true);
  assert.deepEqual(b.win().protection, [false, true]);
  b.ctl.dispose();
});

test('persist: invisibleMain protects every app window, new ones too, even with the blob off', () => {
  resetConfig();
  const apps = [appWindow(), appWindow()];
  const hz = harness({ apps });
  assert.equal(hz.ctl.setConfig({ invisibleMain: true }).ok, true);
  assert.equal(onDisk().blobInvisibleMain, true);
  assert.equal(hz.created.length, 0, 'the blob stays off');
  for (const w of apps) assert.equal(w.protection.at(-1), true);
  const late = appWindow();
  hz.ctl.protectAppWindow(late);
  assert.deepEqual(late.protection, [true], 'a floor opened later is protected');
  // a fresh controller (restart) protects a window created before apply()
  const fresh = harness({ apps: [] });
  const early = appWindow();
  fresh.ctl.protectAppWindow(early);
  assert.deepEqual(early.protection, [true], 'settings are read at construction');
  hz.ctl.setConfig({ invisibleMain: false });
  for (const w of apps) assert.equal(w.protection.at(-1), false);
});

test('persist: a drag follows main\'s cursor and the position survives a restart', () => {
  resetConfig();
  writeConfig({ blobEnabled: true });
  const a = harness();
  a.ctl.apply();
  const start = { ...a.win().bounds };
  a.setCursor({ x: 500, y: 500 });
  a.ctl.dragStart();
  a.setCursor({ x: 300, y: 260 });
  a.ctl.dragMove();
  assert.deepEqual(a.win().bounds, { x: start.x - 200, y: start.y - 240, width: BLOB_SIZE, height: BLOB_SIZE });
  assert.equal(onDisk().blobPosition, undefined, 'nothing written mid-drag');
  a.ctl.dragEnd();
  assert.deepEqual(onDisk().blobPosition, { x: start.x - 200, y: start.y - 240 });
  a.ctl.dragMove();
  assert.deepEqual(a.win().bounds.x, start.x - 200, 'a move after dragEnd does nothing');
  a.ctl.dispose();

  const b = harness();
  b.ctl.apply();
  assert.deepEqual(b.win().bounds, { x: start.x - 200, y: start.y - 240, width: BLOB_SIZE, height: BLOB_SIZE }, 'restored');
  b.ctl.dispose();
});

test('persist: hotkey change re-registers; a taken hotkey reports unregistered; \'\' means none; invalid is refused', () => {
  resetConfig();
  writeConfig({ blobEnabled: true });
  const hz = harness({ taken: ['Control+Shift+K'] });
  hz.ctl.apply();
  let r = hz.ctl.setConfig({ hotkey: 'Alt+Shift+B' });
  assert.equal(r.ok, true);
  assert.deepEqual([...hz.shortcuts.keys()], ['Alt+Shift+B'], 'the old hotkey is released');
  assert.equal(onDisk().blobHotkey, 'Alt+Shift+B');
  r = hz.ctl.setConfig({ hotkey: 'Control+Shift+K' });
  assert.equal(r.status.hotkeyRegistered, false);
  assert.equal(hz.shortcuts.size, 0);
  assert.ok(hz.logs.some((l) => l.kind === 'blob-hotkey-unavailable' && l.hotkey === 'Control+Shift+K'));
  r = hz.ctl.setConfig({ hotkey: '' });
  assert.equal(r.ok, true);
  assert.equal(r.status.hotkey, '');
  assert.equal(hz.shortcuts.size, 0);
  r = hz.ctl.setConfig({ hotkey: 'G' });
  assert.equal(r.ok, false, 'a bare key is refused');
  assert.equal(onDisk().blobHotkey, '', 'unchanged');
  hz.ctl.setConfig({ enabled: false });
  assert.equal(hz.win().destroyed, true, 'disable destroys the overlay');
  hz.ctl.dispose();
});

test('persist: a hidden (harness) run never shows the overlay or takes a hotkey', () => {
  resetConfig();
  writeConfig({ blobEnabled: true });
  const hz = harness({ hidden: true });
  hz.ctl.apply();
  assert.equal(hz.created.length, 0);
  assert.equal(hz.shortcuts.size, 0);
});

// ─── ring + slots ─────────────────────────────────────────────────────────────

test('ring: opens around the blob centre and closes back; coming-soon / disabled slots; close collapses', () => {
  resetConfig();
  writeConfig({ blobEnabled: true, blobPosition: { x: 800, y: 600 } });
  const hz = harness();
  hz.ctl.apply();
  hz.ctl.setRing(true);
  const off = Math.round((RING_SIZE - BLOB_SIZE) / 2);
  assert.deepEqual(hz.win().bounds, { x: 800 - off, y: 600 - off, width: RING_SIZE, height: RING_SIZE });
  for (const s of ['screenshot', 'meeting', 'message']) assert.deepEqual(hz.ctl.action(s), { ok: true, slot: s, state: 'coming-soon' });
  assert.deepEqual(hz.ctl.action('screen'), { ok: true, slot: 'screen', state: 'disabled' });
  assert.equal(hz.ctl.action('nope').ok, false);
  assert.equal(hz.ctl.action('close').state, 'done');
  assert.deepEqual(hz.win().bounds, { x: 800, y: 600, width: BLOB_SIZE, height: BLOB_SIZE });
  assert.deepEqual([...BLOB_SLOTS].sort(), ['close', 'invisible', 'meeting', 'message', 'screen', 'screenshot']);
  hz.ctl.dispose();
});

// ─── validation ───────────────────────────────────────────────────────────────

test('validation: hotkeys and patches', () => {
  for (const ok of ['', 'Control+Alt+G', 'CommandOrControl+Shift+F12', 'Alt+Space', 'Super+1']) assert.equal(isValidBlobHotkey(ok), true, ok);
  for (const bad of ['G', 'Control+', '+G', 'Control+Control+G', 'Foo+G', 'Control+Alt', 'Control+GG', 7, null, 'Control+'.repeat(20) + 'G']) assert.equal(isValidBlobHotkey(bad), false, String(bad));
  assert.deepEqual(sanitizeBlobPatch({ enabled: true, invisible: 'yes', junk: 1, blobPosition: { x: 1, y: 1 } }), { ok: true, fields: { blobEnabled: true } }, 'unknown keys and wrong types dropped; position is not a Settings field');
  assert.deepEqual(sanitizeBlobPatch({ hotkey: '  Alt+Shift+B ' }), { ok: true, fields: { blobHotkey: 'Alt+Shift+B' } });
  assert.equal(sanitizeBlobPatch({ hotkey: 'B' }).ok, false);
  assert.equal(sanitizeBlobPatch(null).ok, false);
  assert.deepEqual(blobSettingsFrom({ blobHotkey: 'nonsense', blobPosition: { x: 'a', y: 1 }, blobInvisible: 0 }),
    { enabled: false, hotkey: BLOB_DEFAULT_HOTKEY, invisible: true, invisibleMain: false, position: null, dictation: false }, 'malformed config falls back to defaults');
});

// ─── (pins) ───────────────────────────────────────────────────────────────────

test('pin: the overlay preload exposes only window.blob over blob:overlay:* (+ the blob:status and blob:gaze pushes)', () => {
  const src = codeOnly(readSource('src/preload/blob.ts'));
  const invoked = [...src.matchAll(/ipcRenderer\.(\w+)\(\s*'([^']+)'/g)].map((m) => `${m[1]} ${m[2]}`);
  assert.ok(invoked.length >= 5);
  for (const c of invoked) {
    assert.ok(/^invoke blob:overlay:/.test(c) || /^(on|removeListener) blob:(status|gaze)$/.test(c), `unexpected channel use: ${c}`);
  }
  assert.doesNotMatch(src, /ipcRenderer\.(send|sendSync|postMessage)\b/);
  const exposed = [...src.matchAll(/exposeInMainWorld\(\s*'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(exposed, ['blob']);
});

test('pin: the overlay window is focusable:false, sandboxed, on its own partition, and never keeps the app alive', () => {
  const src = codeOnly(readSource('src/main/index.ts'));
  const m = src.match(/function createBlobOverlayWindow\([\s\S]*?\n\}/);
  assert.ok(m, 'createBlobOverlayWindow exists');
  const body = m[0];
  for (const re of [/focusable:\s*false/, /sandbox:\s*true/, /contextIsolation:\s*true/, /nodeIntegration:\s*false/, /skipTaskbar:\s*true/,
    /partition:\s*BLOB_PARTITION/, /preload:\s*join\(__dirname,\s*'\.\.\/preload\/blob\.js'\)/, /showInactive\(\)/,
    /setWindowOpenHandler\(\(\)\s*=>\s*\(\{\s*action:\s*'deny'\s*\}\)\)/, /'will-navigate'[\s\S]{0,40}preventDefault/, /setPermissionRequestHandler/]) {
    assert.match(body, re);
  }
  assert.doesNotMatch(body, /\.show\(\)/, 'never show() (it would take focus)');
  assert.doesNotMatch(body, /allWindows\.add/, 'the overlay is not an app window');
  assert.match(src, /allWindows\.delete\(win\);[\s\S]{0,200}if \(allWindows\.size === 0\)[^\n]*blobOverlay\.dispose\(\)/, 'last app window closed -> overlay disposed');
  assert.match(src, /app\.on\('will-quit',\s*\(\)\s*=>\s*\{[\s\S]{0,80}blobOverlay\.dispose\(\)/);
});

// ─── Jim M1 / S1 / S2 ─────────────────────────────────────────────────────────

const inside = (r, wa) => r.x >= wa.x && r.y >= wa.y && r.x + (r.width ?? 0) <= wa.x + wa.width && r.y + (r.height ?? 0) <= wa.y + wa.height;
function assertRingOnScreen(win, wa, label) {
  const b = win.bounds;
  assert.equal(b.width, RING_SIZE, label);
  assert.ok(inside(b, wa), `${label}: ring box ${JSON.stringify(b)} inside ${JSON.stringify(wa)}`);
  for (const slot of RING_SLOTS) {
    const c = ringSlotPosition(slot);
    const pt = { x: b.x + c.x, y: b.y + c.y };
    assert.ok(pt.x - 30 >= wa.x && pt.y - 30 >= wa.y && pt.x + 30 <= wa.x + wa.width && pt.y + 30 <= wa.y + wa.height, `${label}: slot ${slot} at ${JSON.stringify(pt)} fully on screen`);
  }
}

test('M1: at the default corner the open ring (box and every slot button) is inside the work area', () => {
  resetConfig();
  writeConfig({ blobEnabled: true });
  const hz = harness();
  hz.ctl.apply();
  const collapsed = { ...hz.win().bounds };
  hz.ctl.setRing(true);
  assertRingOnScreen(hz.win(), { x: 0, y: 0, width: 1920, height: 1040 }, 'default corner');
  hz.ctl.setRing(false);
  assert.deepEqual(hz.win().bounds, collapsed, 'closing puts the blob back where it was');
  assert.equal(readConfig().blobPosition, undefined, 'opening the ring saves nothing');
  hz.ctl.dispose();
});

test('M1: every edge and a second display with negative coordinates', () => {
  const displays = [{ x: 0, y: 0, width: 1920, height: 1040 }, { x: -1280, y: -200, width: 1280, height: 984 }];
  const spots = [{ x: 0, y: 0 }, { x: 1824, y: 0 }, { x: 0, y: 944 }, { x: 900, y: 944 }, { x: -1280, y: -200 }, { x: -96, y: 688 }];
  for (const pos of spots) {
    resetConfig();
    writeConfig({ blobEnabled: true, blobPosition: pos });
    const hz = harness({ displays });
    hz.ctl.apply();
    hz.ctl.setRing(true);
    const wa = displays.find((d) => pos.x >= d.x && pos.x < d.x + d.width && pos.y >= d.y && pos.y < d.y + d.height);
    assertRingOnScreen(hz.win(), wa, JSON.stringify(pos));
    hz.ctl.dispose();
  }
});

test('S1: a saved position on a display that is gone comes back inside the nearest work area', () => {
  resetConfig();
  writeConfig({ blobEnabled: true, blobPosition: { x: 4200, y: 300 } });   // a right-hand monitor, unplugged
  const hz = harness();
  hz.ctl.apply();
  const b = hz.win().bounds;
  assert.ok(inside(b, { x: 0, y: 0, width: 1920, height: 1040 }), JSON.stringify(b));
  assert.deepEqual({ x: b.x, y: b.y }, { x: 1920 - BLOB_SIZE, y: 300 });
  hz.ctl.dispose();
});

test('S1: a drag dropped past an edge is saved fully on screen', () => {
  resetConfig();
  writeConfig({ blobEnabled: true, blobPosition: { x: 1800, y: 900 } });
  const hz = harness();
  hz.ctl.apply();
  hz.setCursor({ x: 0, y: 0 });
  hz.ctl.dragStart();
  hz.setCursor({ x: 300, y: 300 });
  hz.ctl.dragMove();
  hz.ctl.dragEnd();
  assert.deepEqual(onDisk().blobPosition, { x: 1920 - BLOB_SIZE, y: 1040 - BLOB_SIZE });
  assert.deepEqual(hz.win().bounds, { x: 1920 - BLOB_SIZE, y: 1040 - BLOB_SIZE, width: BLOB_SIZE, height: BLOB_SIZE });
  hz.ctl.dispose();
});

test('S2: a dead overlay renderer is destroyed and re-created once (protection re-applied), then left off', () => {
  resetConfig();
  writeConfig({ blobEnabled: true });
  const hz = harness();
  hz.ctl.apply();
  const first = hz.win();
  first.onGone('crashed');
  assert.equal(first.destroyed, true);
  assert.equal(hz.created.length, 2, 're-created once');
  assert.deepEqual(hz.win().protection, [true], 'the new window is protected');
  assert.equal(hz.ctl.overlayContents(), hz.win().webContents);
  first.onGone('crashed');
  assert.equal(hz.created.length, 2, "a stale window's death is ignored");
  hz.win().onGone('oom');
  assert.equal(hz.win().destroyed, true);
  assert.equal(hz.created.length, 2, 'a second death leaves it off');
  assert.equal(hz.ctl.overlayContents(), null);
  assert.deepEqual(hz.logs.filter((l) => l.kind === 'blob-renderer-gone').map((l) => [l.reason, l.respawn]), [['crashed', true], ['oom', false]]);
  hz.ctl.dispose();
});

test('S2 pin: the overlay window forwards render-process-gone to the controller', () => {
  const src = codeOnly(readSource('src/main/index.ts'));
  const m = src.match(/function createBlobOverlayWindow\([\s\S]*?\n\}/);
  assert.match(m[0], /webContents\.on\('render-process-gone',[^\n]*onGone\(details\.reason\)/);
});

// ─── (BLOB-GAZE / BLOB-ORCH-MOOD) ───────────────────────────────────────────────

/** Manual timers: fire() runs every pending callback once (each tick re-schedules itself). */
function manualTimers() {
  const live = new Map(); let n = 0;
  return {
    set: (fn, ms) => { const h = ++n; live.set(h, { fn, ms }); return h; },
    clear: (h) => { live.delete(h); },
    pending: () => [...live.values()].map((t) => t.ms),
    fire: () => { const all = [...live.entries()]; live.clear(); for (const [, t] of all) t.fn(); },
  };
}
const { BLOB_GAZE_MS, BLOB_MOODS, isBlobMood } = loadTs('src/shared/blob.ts');
const gazeSent = (w) => w.webContents.sent.filter(([ch]) => ch === 'blob:gaze').map(([, p]) => p);

test('gaze: off until the overlay asks; then the cursor, in overlay client coordinates, only when it changes', () => {
  resetConfig(); writeConfig({ blobEnabled: true });
  const t = manualTimers();
  const hz = harness({ deps: { gazeTimers: t } });
  hz.ctl.apply();
  const w = hz.win();
  assert.deepEqual(t.pending(), [], 'no timer before the overlay asks');
  hz.ctl.setGaze(true);
  assert.deepEqual(t.pending(), [BLOB_GAZE_MS], 'visible: sampled at BLOB_GAZE_MS');
  hz.setCursor({ x: w.bounds.x + 10, y: w.bounds.y - 40 });
  t.fire();
  assert.deepEqual(gazeSent(w), [{ x: 10, y: -40 }]);
  t.fire();
  assert.equal(gazeSent(w).length, 1, 'an unchanged point is not resent');
  hz.setCursor({ x: w.bounds.x + 11.6, y: w.bounds.y });
  t.fire();
  assert.deepEqual(gazeSent(w).at(-1), { x: 12, y: 0 }, 'rounded');
  hz.ctl.setGaze(false);
  assert.deepEqual(t.pending(), [], 'off: the timer is gone');
  hz.ctl.setGaze('yes');
  assert.deepEqual(t.pending(), [], 'only a real true turns it on');
});

test('gaze: the focused field wins over the cursor; a bad focus point falls back to the cursor', () => {
  resetConfig(); writeConfig({ blobEnabled: true });
  const t = manualTimers();
  let focus = null;
  const hz = harness({ deps: { gazeTimers: t, focusPoint: () => focus } });
  hz.ctl.apply();
  const w = hz.win();
  hz.ctl.setGaze(true);
  hz.setCursor({ x: w.bounds.x + 5, y: w.bounds.y + 5 });
  focus = { x: w.bounds.x - 300, y: w.bounds.y + 200 };
  t.fire();
  assert.deepEqual(gazeSent(w).at(-1), { x: -300, y: 200 });
  focus = { x: NaN, y: 1 };
  t.fire();
  assert.deepEqual(gazeSent(w).at(-1), { x: 5, y: 5 });
  hz.ctl.setGaze(false);
});

test('gaze: hidden overlay only checks slowly and sends nothing; destroy stops the feed', () => {
  resetConfig(); writeConfig({ blobEnabled: true });
  const t = manualTimers();
  const hz = harness({ deps: { gazeTimers: t } });
  hz.ctl.apply();
  const w = hz.win();
  w.visible = false;   // not shown yet (ready-to-show) or hidden by the hotkey
  hz.ctl.setGaze(true);
  assert.deepEqual(t.pending(), [BLOB_GAZE_HIDDEN_MS]);
  t.fire();
  assert.deepEqual(gazeSent(w), [], 'nothing sent while hidden');
  assert.deepEqual(t.pending(), [BLOB_GAZE_HIDDEN_MS], 'still checking');
  hz.ctl.toggleVisible();
  assert.deepEqual(t.pending(), [BLOB_GAZE_MS], 'shown: re-paced');
  t.fire();
  assert.equal(gazeSent(w).length, 1);
  writeConfig({ blobEnabled: false });
  hz.ctl.apply();
  assert.deepEqual(t.pending(), [], 'overlay gone: no timer left');
});

test('mood: idle by default, setMood validates and pushes on change only', () => {
  resetConfig(); writeConfig({ blobEnabled: true });
  const hz = harness();
  hz.ctl.apply();
  const w = hz.win();
  assert.equal(hz.ctl.status().mood, 'idle');
  assert.deepEqual([...BLOB_MOODS], ['idle', 'working', 'sleepy', 'waiting', 'sick', 'happy', 'sad']);
  assert.equal(isBlobMood('working'), true); assert.equal(isBlobMood('angry'), false); assert.equal(isBlobMood(1), false);
  const pushes = () => w.webContents.sent.filter(([ch]) => ch === 'blob:status').length;
  const before = pushes();
  assert.equal(hz.ctl.setMood('angry'), false);
  assert.equal(pushes(), before, 'refused: no push');
  assert.equal(hz.ctl.setMood('working'), true);
  assert.equal(pushes(), before + 1);
  assert.equal(w.webContents.sent.at(-1)[1].mood, 'working');
  assert.equal(hz.ctl.setMood('working'), true);
  assert.equal(pushes(), before + 1, 'same mood: no push');
  assert.equal(hz.ctl.status().mood, 'working');
});

test('BLOB-GAZE pins: gaze.css, eye travel, reduced motion, face priority and the mood map', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const app = codeOnly(read('src/renderer/src/blob/BlobApp.tsx'));
  assert.match(read('src/renderer/src/blob/main.tsx'), /import 'blobatar\/gaze\.css'/);
  assert.match(read('src/renderer/src/blob/blob.css'), /--mo-track-travel:\s*[1-9]/, 'travel is registered at 0px: it must be set');
  assert.match(app, /'\(prefers-reduced-motion: reduce\)'/);
  assert.match(app, /api\.gaze\(!mq\.matches\)/, 'the feed is off under reduced motion');
  assert.match(app, /off\(\); void api\.gaze\(false\)/, 'unmount turns the feed off');
  assert.match(app, /faceExpression\(toast \? expr : null, dictExpr, status\?\.mood\)/);
  const map = /MOOD_EXPR[^=]*=\s*\{([^}]*)\}/.exec(app)[1].split(',').map((e) => e.trim()).filter(Boolean)
    .map((e) => e.includes(':') ? e.split(':').map((x) => x.trim()) : [e, e]);
  assert.deepEqual(Object.fromEntries(map), { idle: 'idle', working: 'thinking', sleepy: 'sleepy', waiting: 'unsure', sick: 'sick', happy: 'happy', sad: 'sad' });
  const fe = /export function faceExpression\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(app)[1];
  assert.ok(fe.indexOf('toastExpr') < fe.indexOf('dictExpr') && fe.indexOf('dictExpr') < fe.indexOf('MOOD_EXPR'), 'toast, then dictation, then mood');
});
