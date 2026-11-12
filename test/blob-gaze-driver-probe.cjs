'use strict';

// Run by blob-gaze-driver.test.cjs under the app's own Electron. It renders the real blobatar face
// (the overlay's options) with the real gaze driver and stylesheets in an offscreen window, points
// the eyes far left and far right, and prints what the driver wrote. Nothing is faked; no network.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'blob-gaze-driver-'));
app.setPath('userData', path.join(tmp, 'userData'));
app.disableHardwareAcceleration();
const dist = path.join(__dirname, '..', 'node_modules', 'blobatar', 'dist');
const url = (f) => pathToFileURL(path.join(dist, f)).href;
const page = path.join(tmp, 'gaze.html');
// The overlay's own stylesheet: it sets the eye travel (--mo-track-travel), which gaze.css registers at 0.
const appCss = pathToFileURL(path.join(__dirname, '..', 'src', 'renderer', 'src', 'blob', 'blob.css')).href;
fs.writeFileSync(page, `<!doctype html><meta charset="utf-8">
<link rel="stylesheet" href="${url('motion.css')}"><link rel="stylesheet" href="${url('gaze.css')}"><link rel="stylesheet" href="${appCss}">
<body style="margin:0"><div id="face" class="blob-face"></div>
<script type="module">
  import { _parts } from '${url('internal.js')}';
  import { gaze } from '${url('gaze.js')}';
  // Built exactly as blobatar/react's <Blobatar animate> builds it: _parts() inside its own svg + g.
  const p = _parts('guppy', { palette: { head: '#ffd84a', eye: '#1a1320' }, background: false, traits: { shape: 0.05 }, animate: 'always', size: 88 });
  const style = Object.entries(p.vars || {}).map(([k, v]) => k + ':' + v).join(';');
  document.getElementById('face').innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="88" height="88" aria-hidden="true" style="' + style + '"><g class="' + p.cls + '">' + p.inner + '</g></svg>';
  const svg = document.querySelector('#face svg');
  const g = gaze(svg, { target: null });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const read = () => {
    const eyes = svg.querySelector('.mo-eyes');
    const cs = eyes && getComputedStyle(eyes);
    return { dx1: cs ? cs.getPropertyValue('--mo-gz-dx1').trim() : null, eye: svg.querySelector('.mo-eye') ? getComputedStyle(svg.querySelector('.mo-eye')).translate : null };
  };
  window.runGaze = async () => {
    let pif;
    try { pif = svg.querySelector('.mo-bob > g:not(.mo-eyes) path, .mo-bob > g:not(.mo-eyes) circle').isPointInFill(new DOMPoint(44, 44)); }
    catch (e) { pif = 'THROW ' + e.message; }
    const out = { pif, structure: !!svg.querySelector('.mo-bob > g:not(.mo-eyes)') && svg.querySelectorAll('.mo-eye').length };
    g.lookAt({ x: -2000, y: 44 }); await wait(1200); out.left = read();
    g.lookAt({ x: 3000, y: 44 }); await wait(1200); out.right = read();
    g.stop();
    return out;
  };
</script>`);

app.whenReady().then(async () => {
  let code = 0;
  try {
    const w = new BrowserWindow({ width: 88, height: 88, show: false, webPreferences: { offscreen: true, backgroundThrottling: false } });
    await w.loadFile(page);
    await w.webContents.executeJavaScript('new Promise((r) => { const t = () => (window.runGaze ? r() : setTimeout(t, 20)); t(); })');
    const out = await w.webContents.executeJavaScript('window.runGaze()');
    console.log(JSON.stringify({ electron: process.versions.electron, ...out }));
  } catch (e) {
    console.error(e && e.stack || String(e));
    code = 1;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
    app.exit(code);
  }
});
