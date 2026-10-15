'use strict';
/**
 * GPU-SETTING-188, the rendered proof's Electron main: the PRODUCT's startup step (src/main/graphics.ts,
 * applyGraphicsModeAtStartup) on a jailed userData whose config.json holds the mode under test, then a
 * HIDDEN window's WebGL renderer and Chromium's GPU feature status, written as JSON to <out>.
 *   electron gpu-mode-main.cjs <jail> <out.json>
 * No --disable-gpu here (the other harness mains add it): this run is about what the GPU flags do.
 * Every Electron path (userData, sessionData, crashDumps, logs) is inside <jail>; no window is shown.
 */
const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const loadTs = require('../load-ts.cjs');
const { isolateAppPaths } = require('./isolate-paths.cjs');

const [jail, outFile] = process.argv.slice(-2);
if (!jail || !outFile || !outFile.endsWith('.json')) { process.stderr.write('usage: gpu-mode-main.cjs <jail> <out.json>\n'); process.exit(2); }
// HARNESS-CRASHPAD: every path and a local-only crash reporter inside <jail>, like every harness main.
isolateAppPaths(app, jail);
// The helper also adds disable-gpu (a hidden harness window needs no GPU); this run is ABOUT the GPU,
// so take it back out before ready. The keep-scheduled switches stay.
app.commandLine.removeSwitch('disable-gpu');
if (app.commandLine.hasSwitch('disable-gpu')) { process.stderr.write('gpu-mode-main: disable-gpu could not be removed\n'); process.exit(2); }

// THE PRODUCT STEP, before ready, exactly as src/main/index.ts runs it.
const graphics = loadTs('src/main/graphics.ts');
const shared = loadTs('src/shared/graphicsMode.ts');
const started = graphics.applyGraphicsModeAtStartup(app);

// What a floor's Pixi init asks WebGL for: the product's powerPreferenceFor on the applied mode.
const probe = (pp) => `(() => { const o = ${JSON.stringify(pp ? { powerPreference: pp } : {})};
  const c = document.createElement('canvas'); const gl = c.getContext('webgl2', o) || c.getContext('webgl', o);
  if (!gl) return { webgl: false, renderer: null, vendor: null, powerPreference: o.powerPreference || 'default' };
  const e = gl.getExtension('WEBGL_debug_renderer_info');
  return { webgl: true, renderer: e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    vendor: e ? gl.getParameter(e.UNMASKED_VENDOR_WEBGL) : null, powerPreference: o.powerPreference || 'default' }; })()`;

const finish = (payload, code) => { try { writeFileSync(outFile, JSON.stringify(payload, null, 2)); } catch { /* reported by the exit code */ } app.exit(code); };
setTimeout(() => finish({ error: 'timed out' }, 3), 60_000).unref();

app.whenReady().then(async () => {
  try {
    const w = new BrowserWindow({ show: false, width: 200, height: 200, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
    await w.loadURL('data:text/html;charset=utf-8,%3C!doctype%20html%3E%3Ctitle%3Egpu%3C%2Ftitle%3E');
    const page = await w.webContents.executeJavaScript(probe(shared.powerPreferenceFor(graphics.appliedGraphicsMode())));
    const feature = app.getGPUFeatureStatus();
    let basic = null;
    try { basic = await app.getGPUInfo('basic'); } catch (e) { basic = { error: String(e && e.message || e) }; }
    const status = graphics.graphicsStatus({ graphicsMode: started.mode }, feature);
    finish({ started, status, feature, gpuDevices: basic && basic.gpuDevice, page,
      label: shared.renderingLabel(page.renderer, status), electron: process.versions.electron }, 0);
  } catch (e) {
    finish({ error: String(e && e.stack || e) }, 1);
  }
});
