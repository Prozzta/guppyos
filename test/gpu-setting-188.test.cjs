'use strict';
/**
 * GPU-SETTING-188: Settings → Graphics (Auto / GPU / CPU only) with a "Rendering: …" indicator.
 * - the setting's parse and default (a missing, corrupt or unknown value is Auto);
 * - main applies it BEFORE app ready (CPU only = disableHardwareAcceleration), and never after;
 * - the floors ask WebGL for the high-performance GPU only under GPU, and record what they got;
 * - the indicator says what is really in use, and a GPU choice that fell back says so.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const g = loadTs('src/shared/graphicsMode.ts');
const main = loadTs('src/main/graphics.ts');

test('parse: exactly auto | gpu | cpu; anything else is not a mode', () => {
  for (const m of ['auto', 'gpu', 'cpu']) assert.equal(g.parseGraphicsMode(m), m);
  for (const bad of ['AUTO', ' gpu', 'gpu ', 'hardware', '', 0, 1, null, undefined, {}, ['cpu'], true]) assert.equal(g.parseGraphicsMode(bad), null, JSON.stringify(bad));
  assert.equal(g.DEFAULT_GRAPHICS_MODE, 'auto');
  assert.deepEqual([...g.GRAPHICS_MODES], ['auto', 'gpu', 'cpu']);
});

test('default: a config without the key, with a bad value, or none at all is Auto', () => {
  assert.equal(g.graphicsModeOf({ graphicsMode: 'cpu' }), 'cpu');
  for (const c of [{}, { graphicsMode: 'nope' }, { graphicsMode: 3 }, null, undefined]) assert.equal(g.graphicsModeOf(c), 'auto');
});

test('config.json TEXT read before ready: missing, corrupt, not an object, or unknown -> Auto; never throws', () => {
  assert.equal(g.graphicsModeFromConfigText('{"onboardingComplete":true,"graphicsMode":"cpu"}'), 'cpu');
  assert.equal(g.graphicsModeFromConfigText('{"graphicsMode":"gpu"}'), 'gpu');
  for (const t of [null, undefined, '', '{', '{"graphicsMode":', 'null', '[]', '["cpu"]', '"cpu"', '42', '{"graphicsMode":"CPU"}', '\uFEFF{"graphicsMode":"cpu"}'])
    assert.equal(g.graphicsModeFromConfigText(t), 'auto', JSON.stringify(t));
});

/** A fake Electron app that records the order of what main does. */
function fakeApp({ ready = false, userData = 'C:/ud' } = {}) {
  const calls = [];
  return { calls, isReady: () => { calls.push('isReady'); return ready; }, getPath: (n) => { calls.push(`getPath:${n}`); return userData; }, disableHardwareAcceleration: () => calls.push('disableHardwareAcceleration') };
}
const reader = (files) => (p) => { const k = p.split('\\').join('/'); if (!(k in files)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return files[k]; };

test('main, before ready: CPU only disables hardware acceleration (once); Auto and GPU leave Chromium alone', () => {
  for (const [mode, disables] of [['cpu', true], ['gpu', false], ['auto', false]]) {
    main.__resetGraphicsForTests();
    const app = fakeApp();
    const r = main.applyGraphicsModeAtStartup(app, reader({ 'C:/ud/config.json': JSON.stringify({ graphicsMode: mode }) }));
    assert.deepEqual(r, { mode, applied: true });
    assert.equal(app.calls.filter((c) => c === 'disableHardwareAcceleration').length, disables ? 1 : 0, mode);
    assert.ok(app.calls.indexOf('isReady') < (disables ? app.calls.indexOf('disableHardwareAcceleration') : Infinity), 'checked not ready first');
    assert.equal(main.appliedGraphicsMode(), mode);
    // a second call (a re-import) never applies twice
    main.applyGraphicsModeAtStartup(app, reader({ 'C:/ud/config.json': '{"graphicsMode":"cpu"}' }));
    assert.equal(app.calls.filter((c) => c === 'disableHardwareAcceleration').length, disables ? 1 : 0);
  }
});

test('main: a missing or corrupt config.json is Auto (no flag, no throw); after ready nothing is applied', () => {
  for (const files of [{}, { 'C:/ud/config.json': '{ not json' }, { 'C:/ud/config.json': '{"graphicsMode":"Cpu"}' }]) {
    main.__resetGraphicsForTests();
    const app = fakeApp();
    assert.deepEqual(main.applyGraphicsModeAtStartup(app, reader(files)), { mode: 'auto', applied: true });
    assert.ok(!app.calls.includes('disableHardwareAcceleration'));
  }
  main.__resetGraphicsForTests();
  const late = fakeApp({ ready: true });
  const orig = console.error; const errs = []; console.error = (m) => errs.push(String(m));
  try { assert.deepEqual(main.applyGraphicsModeAtStartup(late, reader({ 'C:/ud/config.json': '{"graphicsMode":"cpu"}' })), { mode: 'cpu', applied: false }); }
  finally { console.error = orig; }
  assert.ok(!late.calls.includes('disableHardwareAcceleration'), 'too late: nothing half-applied');
  assert.match(errs.join('\n'), /after app ready: not applied/);
  assert.equal(main.appliedGraphicsMode(), 'auto');
  main.__resetGraphicsForTests();
});

test('main: the status is what is IN FORCE plus the saved mode; CPU only always reports software', () => {
  main.__resetGraphicsForTests();
  main.applyGraphicsModeAtStartup(fakeApp(), reader({ 'C:/ud/config.json': '{"graphicsMode":"cpu"}' }));
  assert.deepEqual(main.graphicsStatus({ graphicsMode: 'gpu' }, { gpu_compositing: 'enabled' }), { applied: 'cpu', stored: 'gpu', hardwareDisabled: true, hardwareCompositing: false });
  main.__resetGraphicsForTests();
  main.applyGraphicsModeAtStartup(fakeApp(), reader({}));
  assert.deepEqual(main.graphicsStatus({}, { gpu_compositing: 'enabled' }), { applied: 'auto', stored: 'auto', hardwareDisabled: false, hardwareCompositing: true });
  assert.equal(main.graphicsStatus(null, { gpu_compositing: 'disabled_software' }).hardwareCompositing, false);
  assert.equal(main.graphicsStatus(null, { gpu_compositing: 'unavailable_software' }).hardwareCompositing, false);
  assert.equal(main.graphicsStatus(null, null).hardwareCompositing, null);
  main.__resetGraphicsForTests();
});

test('index.ts applies the mode at MODULE LOAD, after the userData path is final and before the lock and app ready', () => {
  const src = codeOnly(readSource('src/main/index.ts'), 'index.ts');
  const call = src.indexOf('\nconst graphicsAtStartup = applyGraphicsModeAtStartup(app);');
  assert.ok(call > 0, 'a top-level statement (column 0), not inside a handler');
  assert.equal(src.split('applyGraphicsModeAtStartup(').length - 1, 1, 'called once');
  assert.ok(call > src.lastIndexOf("app.setPath('userData'"), 'after every userData setPath (the mode lives in its config.json)');
  for (const later of ['app.requestSingleInstanceLock()', 'app.whenReady()', "app.on('ready'"]) {
    const i = src.indexOf(later);
    if (i >= 0) assert.ok(call < i, `before ${later}`);
  }
  assert.doesNotMatch(src, /appendSwitch\('ignore-gpu-blocklist'\)|disable-gpu/, 'GPU mode never overrides the blocklist (fall back, never a black screen)');
});

test('IPC: status, set (refused when unknown), restart through the normal teardown; preload names the same channels', () => {
  const idx = codeOnly(readSource('src/main/index.ts'), 'index.ts');
  const pre = codeOnly(readSource('src/preload/index.ts'), 'preload.ts');
  for (const ch of ['graphics:status', 'graphics:setMode', 'graphics:restart']) {
    assert.match(idx, new RegExp(`ipcMain\\.handle\\('${ch}'`), ch);
    assert.match(pre, new RegExp(`ipcRenderer\\.invoke\\('${ch}'`), ch);
  }
  assert.match(idx, /ipcMain\.handle\('graphics:restart', \(\) => \{\s*app\.relaunch\(\);\s*teardownAndQuit\(\);\s*\}\);/);
  const cfg = codeOnly(readSource('src/main/config.ts'), 'config.ts');
  assert.match(cfg, /export function setGraphicsMode\(value: unknown\): HarnessConfig \{\s*const mode = parseGraphicsMode\(value\);\s*if \(mode === null\) throw new Error\('invalid graphics mode'\);/);
});

test('floors: GPU asks WebGL for high-performance, Auto and CPU only ask nothing; both floors record the renderer they got', () => {
  assert.equal(g.powerPreferenceFor('gpu'), 'high-performance');
  assert.equal(g.powerPreferenceFor('auto'), undefined);
  assert.equal(g.powerPreferenceFor('cpu'), undefined);
  for (const f of ['src/renderer/src/scene/themes/StationFloor.tsx', 'src/renderer/src/scene/office/OfficeFloor.tsx']) {
    const src = codeOnly(readSource(f), 'f.tsx');
    assert.match(src, /const gfx = await floorPowerPreference\(\);\s*await app\.init\(\{\s*\.\.\.gfx,/, `${f}: the preference goes into app.init`);
    assert.match(src, /if \(mountIdRef\.current !== mountId\) \{ safeDestroy\(app\); return; \}\s*recordFloorRenderer\(app\);/, `${f}: the renderer is recorded right after init`);
  }
});

test('the renderer probe: UNMASKED_RENDERER via the debug extension, RENDERER without it, null on anything else', () => {
  const probe = loadTs('src/renderer/src/scene/graphicsProbe.ts');
  const gl = (ext, names) => ({ RENDERER: 7937, getExtension: (n) => (n === 'WEBGL_debug_renderer_info' && ext ? { UNMASKED_RENDERER_WEBGL: 37446 } : null), getParameter: (p) => names[p] });
  assert.equal(probe.webglRendererName(gl(true, { 37446: 'ANGLE (NVIDIA, X)', 7937: 'WebKit WebGL' })), 'ANGLE (NVIDIA, X)');
  assert.equal(probe.webglRendererName(gl(false, { 7937: 'WebKit WebGL' })), 'WebKit WebGL');
  assert.equal(probe.webglRendererName(null), null);
  assert.equal(probe.webglRendererName({}), null);
  assert.equal(probe.webglRendererName({ getExtension: () => { throw new Error('lost'); } }), null);
});

const NV = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 SUPER (0x00002702) Direct3D11 vs_5_0 ps_5_0, D3D11)';
const INTEL = 'ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E92) Direct3D11 vs_5_0 ps_5_0, D3D11)';
const SWS = 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)';
const WARP = 'ANGLE (Microsoft, Microsoft Basic Render Driver (0x0000008C) Direct3D11 vs_5_0 ps_5_0, D3D11)';

test('names: the GPU from an ANGLE string; SwiftShader and WARP are software', () => {
  assert.equal(g.gpuNameOf(NV), 'NVIDIA GeForce RTX 4080 SUPER');
  assert.equal(g.gpuNameOf(INTEL), 'Intel(R) UHD Graphics 630');
  assert.equal(g.gpuNameOf('  Apple M2  '), 'Apple M2');
  assert.equal(g.isSoftwareRenderer(SWS), true);
  assert.equal(g.isSoftwareRenderer(WARP), true);
  assert.equal(g.isSoftwareRenderer('Google SwiftShader'), true);
  assert.equal(g.isSoftwareRenderer(NV), false);
  assert.equal(g.isSoftwareRenderer(INTEL), false);
  assert.equal(g.isSoftwareRenderer(null), false);
});

test('the indicator says what is REALLY in use', () => {
  const st = (applied, hw = true) => ({ applied, hardwareDisabled: applied === 'cpu', hardwareCompositing: applied === 'cpu' ? false : hw });
  assert.equal(g.renderingLabel(NV, st('auto')), 'Rendering: NVIDIA GeForce RTX 4080 SUPER (GPU)');
  assert.equal(g.renderingLabel(NV, st('gpu')), 'Rendering: NVIDIA GeForce RTX 4080 SUPER (GPU)');
  assert.equal(g.renderingLabel(SWS, st('cpu')), 'Rendering: software (CPU)');
  assert.equal(g.renderingLabel(NV, st('cpu')), 'Rendering: software (CPU)', 'hardware off wins over any string');
  assert.equal(g.renderingLabel(SWS, st('gpu', false)), 'Rendering: software (CPU): no usable GPU, fell back to the CPU');
  assert.equal(g.renderingLabel(WARP, st('auto', false)), 'Rendering: software (CPU): no usable GPU');
  assert.equal(g.renderingLabel(null, st('auto', false)), 'Rendering: software (CPU): no usable GPU');
  assert.equal(g.renderingLabel(null, st('auto', true)), 'Rendering: GPU');
  assert.equal(g.renderingLabel(null, { applied: 'auto', hardwareDisabled: false, hardwareCompositing: null }), 'Rendering: unknown');
  assert.equal(g.hardwareCompositing({ gpu_compositing: 'enabled' }), true);
  assert.equal(g.hardwareCompositing({ gpu_compositing: 'enabled_on' }), true);
  assert.equal(g.hardwareCompositing({ gpu_compositing: 'disabled_software' }), false);
  assert.equal(g.hardwareCompositing({}), null);
});

test('Settings: the Graphics section renders in General with the three modes, Auto selected by default', () => {
  const ui = loadTs('src/renderer/src/components/GraphicsSetting.tsx');
  const html = renderToStaticMarkup(React.createElement(ui.GraphicsSetting));
  assert.match(html, /data-graphics-setting/);
  assert.match(html, />Graphics</);
  for (const m of ['auto', 'gpu', 'cpu']) assert.match(html, new RegExp(`<option value="${m}"`));
  assert.match(html, /<option value="auto" selected="">Auto \(graphics card when available\)<\/option>/);
  assert.match(html, /data-graphics-indicator/);
  // god ed8398: CPU only disables hardware acceleration for the whole app, so the copy says app-wide.
  assert.match(html, /Guppy draws with/);
  assert.doesNotMatch(html, /Draw the floor/);
  assert.match(ui.GRAPHICS_COPY.help, /all of Guppy \(terminals, office and floor\)/);
  assert.match(ui.GRAPHICS_COPY.help, /CPU only turns the graphics card off for the whole app/);
  assert.equal(ui.restartPending({ applied: 'auto', stored: 'cpu' }), true);
  assert.equal(ui.restartPending({ applied: 'cpu', stored: 'cpu' }), false);
  assert.equal(ui.restartPending(null), false);
  assert.equal(ui.GRAPHICS_COPY.confirm(1), 'Restarting stops 1 running agent. Restart now?');
  assert.equal(ui.GRAPHICS_COPY.confirm(3), 'Restarting stops 3 running agents. Restart now?');
  const modal = codeOnly(readSource('src/renderer/src/components/SettingsModal.tsx'), 'm.tsx');
  const general = modal.indexOf("{activeSection === 'General' && (");
  const at = modal.indexOf('<GraphicsSetting />');
  assert.ok(general > 0 && at > general && at < modal.indexOf("{activeSection === 'Prerequisites'"), 'in General');
});
