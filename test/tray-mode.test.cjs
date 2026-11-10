'use strict';
require('./tools/own-job.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const loadTs = require('./load-ts.cjs');
const { TrayModeController } = loadTs('src/main/trayMode.ts');

class FakeTray {
  constructor() { this.menu = null; this.click = null; this.destroyed = false; }
  setContextMenu(menu) { this.menu = menu; }
  on(event, listener) { if (event === 'click') this.click = listener; }
  destroy() { this.destroyed = true; }
  isDestroyed() { return this.destroyed; }
}

function world({ enabled = true, platform = 'win32' } = {}) {
  const trays = []; const main = { hidden: false, shown: 0, restored: 0, focused: 0, destroyed: false, minimized: false,
    isDestroyed() { return this.destroyed; }, hide() { this.hidden = true; }, show() { this.shown++; }, restore() { this.restored++; }, focus() { this.focused++; }, isMinimized() { return this.minimized; } };
  let blobs = 0, quits = 0, iconCalls = 0;
  const ctl = new TrayModeController({ platform: () => platform, enabled: () => enabled, icon: async () => { iconCalls++; return 'guppy-exe-icon'; }, createTray: () => { const t = new FakeTray(); trays.push(t); return t; }, buildMenu: (items) => items, toggleBlob: () => { blobs++; }, quit: () => { quits++; } });
  return { ctl, trays, main, get iconCalls() { return iconCalls; }, get blobs() { return blobs; }, get quits() { return quits; }, setEnabled(v) { enabled = v; } };
}

test('tray mode hides only an opted-in Windows close and restores from its tray', async () => {
  const w = world(); w.ctl.setPrimaryWindow(w.main); await w.ctl.sync();
  const e = { prevented: false, preventDefault() { this.prevented = true; } };
  assert.equal(w.ctl.hideOnClose(e, w.main, false), true); assert.equal(e.prevented, true); assert.equal(w.main.hidden, true);
  assert.equal(w.trays.length, 1); assert.equal(w.iconCalls, 1);
  w.main.minimized = true; w.trays[0].click();
  assert.deepEqual([w.main.shown, w.main.restored, w.main.focused], [1, 1, 1]);
  for (const item of w.trays[0].menu) item.click();
  assert.equal(w.blobs, 1); assert.equal(w.quits, 1);
});

test('tray mode is inert off Windows, when disabled, and while a real quit is underway', async () => {
  for (const opts of [{ enabled: false }, { platform: 'darwin' }]) {
    const w = world(opts); const e = { prevented: false, preventDefault() { this.prevented = true; } };
    assert.equal(w.ctl.hideOnClose(e, w.main, false), false); await w.ctl.sync();
    assert.equal(e.prevented, false); assert.equal(w.trays.length, 0);
  }
  const w = world(); w.ctl.setPrimaryWindow(w.main); await w.ctl.sync(); const e = { prevented: false, preventDefault() { this.prevented = true; } };
  assert.equal(w.ctl.hideOnClose(e, w.main, true), false); assert.equal(e.prevented, false);
});

test('turning tray mode off destroys the existing tray', async () => {
  const w = world(); w.ctl.setPrimaryWindow(w.main); await w.ctl.sync(); assert.equal(w.trays.length, 1);
  w.setEnabled(false); await w.ctl.sync(); assert.equal(w.trays[0].destroyed, true);
});

test('a close remains ordinary until the startup tray was created', () => {
  const w = world(); w.ctl.setPrimaryWindow(w.main);
  const e = { prevented: false, preventDefault() { this.prevented = true; } };
  assert.equal(w.ctl.hideOnClose(e, w.main, false), false);
  assert.equal(e.prevented, false);
});

test('main surfaces the hidden primary for second-instance and quit warnings', () => {
  const source = fs.readFileSync('src/main/index.ts', 'utf8');
  assert.match(source, /surfaceWindow\(primaryWindow \?\? mainWindow, \{ show: true, restore: true, focus: true \}\)/);
  assert.match(source, /const quitWindow = primaryWindow \?\? mainWindow;/);
  assert.match(source, /surfaceWindow\(quitWindow, \{ show: true, focus: true \}\)/);
  assert.match(source, /if \(!isFloor && trayMode\.hideOnClose\(e, win, quitting\)\) return;/);
});
