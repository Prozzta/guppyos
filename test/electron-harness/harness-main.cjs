'use strict';

/**
 * Electron main process for the renderer test harness (authorised on `L0-UI-B5`).
 *
 * WHY A REAL BrowserWindow. The evidence this harness exists to produce is about a
 * RENDERED screen: xterm only fills `entry.opened` and a readable buffer row once
 * `term.open()` has run against a real element, and computed style, accessibility
 * semantics and responsive behaviour are properties of a layout engine rather than
 * of a DOM tree. jsdom was explicitly excluded and would not answer any of them - it
 * has no layout, so every one of those reads would return a plausible-looking value
 * that nothing produced.
 *
 * TEST INFRASTRUCTURE ONLY. Nothing here is imported by the app, no production file
 * is modified to make a scenario observable, and the scenarios import the REAL
 * renderer modules rather than reimplementing their logic. If an observation turns
 * out to need a production change, the rule is to report it and stop - not to add a
 * seam quietly, because a seam added to make a test pass is a change to the thing
 * being measured.
 *
 * ISOLATION. `userData` is repointed at a throwaway directory before `app.whenReady`,
 * so a harness run cannot read or write Stable's or Dev's state. The window is never
 * shown.
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const { isolateAppPaths } = require('./isolate-paths.cjs');
const { viteGlobGuard } = require('./vite-glob-guard.cjs');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

/** `--scenario <abs.ts>` `--width N` `--height N` `--timeout N` */
function argOf(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const scenario = argOf('scenario');
const width = Number(argOf('width', '1280'));
const height = Number(argOf('height', '800'));
const timeoutMs = Number(argOf('timeout', '30000'));
// LOAD-FLAKES-176 (Jim): `--timeout` is the SCENARIO's budget, from `__harnessRun()` on. Building,
// loading and evaluating the bundle (the real App is ~17 MB) is SETUP, with its own generous guard
// that names the phase it stopped in. Under a saturated CPU setup alone once ate the whole 150 s
// scenario budget of app-recovery before the scenario started (inline map: 58 MB, eval ~1 s idle,
// ~100 s at a 40x throttle).
const setupTimeoutMs = Number(argOf('setup-timeout', '300000'));

// Isolated before anything can resolve a default path off the package name.
// THE SANDBOX BELONGS TO THE PARENT (run.cjs), which creates it, passes it here as
// `--sandbox`, and removes it AFTER this process has exited. This process used to create
// it and `rmSync` it on the way out, inside a swallowed `catch` - and on Windows Chromium
// still holds files open at that moment, so the removal failed silently, every time. That
// is how about 1,400 directories and 14 GB accumulated in %TEMP% before anyone noticed. A
// child cannot reliably delete the directory its own open handles live in; its parent can.
const sandboxRoot = argOf('sandbox', null);
if (!sandboxRoot) {
  process.stderr.write('harness: refusing to run without --sandbox <dir>; the parent (run.cjs) owns the sandbox lifecycle\n');
  process.exit(2);
}
// Test-only device scale sweep.  Applied before ready so the renderer sees the same DPR it would
// on a differently scaled monitor, while still using the throwaway harness profile. The switch
// alone sets it: a zoomFactor on top would square it (1.25 -> 1.5625).
const forcedDpr = Number(process.env.HARNESS_DPR || '');
if (Number.isFinite(forcedDpr) && forcedDpr > 0) app.commandLine.appendSwitch('force-device-scale-factor', String(forcedDpr));
// HARNESS-CRASHPAD: every path, crashDumps included, inside the sandbox (asserted).
isolateAppPaths(app, sandboxRoot);

let finished = false;
// The scenario may stall in the renderer without ever returning a result. Keep its
// last checkpoint in main so the timeout names the frame and operation that stopped.
let latestProgress = { frames: 0, phase: 'setup', step: 'bundle', at: new Date().toISOString() };
let progressTimer = null;
function noteProgress(payload) {
  if (!payload || typeof payload !== 'object') return;
  const { frames, phase, step } = payload;
  if (Number.isFinite(frames) && frames >= 0) latestProgress.frames = Math.floor(frames);
  if (typeof phase === 'string' && phase) latestProgress.phase = phase;
  if (typeof step === 'string' && step) latestProgress.step = step;
  latestProgress.at = new Date().toISOString();
}
function logProgress() {
  process.stderr.write(`[harness] progress ${JSON.stringify(latestProgress)}\n`);
}
/** One exit path, so a result and a failure cannot both be printed. */
function finish(payload) {
  if (finished) return;
  finished = true;
  if (progressTimer) clearInterval(progressTimer);
  process.stdout.write(`\n__HARNESS_RESULT__${JSON.stringify(payload)}\n`);
  app.exit(0);
}

/**
 * Bundle the scenario for the renderer.
 *
 * The scenario is TypeScript and pulls in the real components, so it is bundled the
 * way the app bundles them rather than loaded through a bespoke loader: same
 * resolution, same `@shared` alias, same CSS. A stylesheet import is turned into a
 * runtime `<style>` injection, because xterm measures a real cell from real CSS and
 * dropping the stylesheet would silently change every geometry-dependent reading.
 */
async function bundleScenario(entry) {
  const esbuild = require('esbuild');
  // Vite-style asset imports (`x.png?url`, `x.tmj?raw`) and the `@brand` alias, so a scenario can
  // mount the REAL App (RR-164): ?url resolves to a file URL, ?raw to the file's text.
  const viteAssets = {
    name: 'vite-assets',
    setup(build) {
      const { dirname, resolve: res, join: j } = require('node:path');
      const { pathToFileURL } = require('node:url');
      const root = j(__dirname, '..', '..');
      build.onResolve({ filter: /\?(url|raw|worker)$/ }, (args) => {
        const [spec, kind] = args.path.split('?');
        const p = spec.startsWith('@brand/') ? res(root, 'src', 'renderer', 'src', 'assets', 'brand', spec.slice(7))
          : spec.startsWith('@/') ? res(root, 'src', 'renderer', 'src', spec.slice(2))
            : res(dirname(args.importer), spec);
        return { path: p, namespace: `vite-${kind}` };
      });
      // ?worker (monaco): a stub Worker class; a scenario never opens the editor.
      build.onLoad({ filter: /.*/, namespace: 'vite-worker' }, () => ({ contents: 'export default class { postMessage() {} terminate() {} addEventListener() {} removeEventListener() {} }', loader: 'js' }));
      build.onLoad({ filter: /.*/, namespace: 'vite-url' }, (args) => ({ contents: `export default ${JSON.stringify(pathToFileURL(args.path).href)};`, loader: 'js' }));
      build.onLoad({ filter: /.*/, namespace: 'vite-raw' }, async (args) => ({ contents: `export default ${JSON.stringify(await require('node:fs/promises').readFile(args.path, 'utf8'))};`, loader: 'js' }));
    }
  };
  const cssAsStyleTag = {
    name: 'css-as-style-tag',
    setup(build) {
      build.onLoad({ filter: /\.css$/ }, async (args) => {
        const css = await require('node:fs/promises').readFile(args.path, 'utf8');
        return {
          contents: `const s=document.createElement('style');s.textContent=${JSON.stringify(css)};document.head.appendChild(s);`,
          loader: 'js'
        };
      });
    }
  };
  // HISTORY-SCROLL-FREEZE mutant census: HARNESS_SOURCE_OVERRIDES = {"<abs source path>": "<abs file
  // with the mutated text>"} loads the mutated text IN PLACE of that source (its own directory stays
  // the resolve root, so its relative imports still work). Unset, the bundle is unchanged.
  const overrides = (() => { try { return JSON.parse(process.env.HARNESS_SOURCE_OVERRIDES || '{}'); } catch { return {}; } })();
  const norm = (p) => require('node:path').resolve(p).toLowerCase();
  const overrideMap = new Map(Object.entries(overrides).map(([from, to]) => [norm(from), to]));
  const sourceOverrides = {
    name: 'source-overrides',
    setup(build) {
      if (!overrideMap.size) return;
      build.onLoad({ filter: /\.(t|j)sx?$/ }, async (args) => {
        const to = overrideMap.get(norm(args.path));
        if (!to) return undefined;
        const ext = args.path.split('.').pop();
        return { contents: await require('node:fs/promises').readFile(to, 'utf8'), loader: ext, resolveDir: require('node:path').dirname(args.path) };
      });
    }
  };
  // Theme packs (TES foundation; upstream 90c87726's boundary): packSources.ts reads the bundled
  // themes/ folder through Vite's import.meta.glob, which esbuild does not provide, so the module
  // would throw at load and take every real-App scenario with it. It is faked HERE, at its own
  // boundary: no packs (the Office), unless HARNESS_THEME_PACKS names fixture folders to bundle:
  // [{ "dir": "<folder name>", "from": "<abs folder>", "id"?: "<theme.json id override>",
  //    "dropPictures"?: ["<pack path>"] }]  (a dropped picture is listed but has no URL, so the
  // pack catalogues but cannot load: the floor's invalid-pack path).
  const themePackSources = {
    name: 'theme-pack-sources',
    setup(build) {
      const fs = require('node:fs');
      const { join: j, relative, dirname: dn } = require('node:path');
      const { pathToFileURL } = require('node:url');
      build.onLoad({ filter: /[\\/]scene[\\/]themes[\\/]packSources\.ts$/ }, (args) => {
        const specs = (() => { try { return JSON.parse(process.env.HARNESS_THEME_PACKS || '[]'); } catch { return []; } })();
        const packs = specs.map((s) => {
          const entries = {}, pictures = [];
          const walk = (d) => {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
              const p = j(d, e.name);
              if (e.isDirectory()) { walk(p); continue; }
              const rel = relative(s.from, p).split('\\').join('/');
              if (/\.(json|tmx|tsx|tmj|tsj|txt)$/.test(rel)) {
                let text = fs.readFileSync(p, 'utf8');
                if (rel === 'theme.json' && s.id) text = JSON.stringify({ ...JSON.parse(text), id: s.id });
                entries[rel] = text;
              } else if (rel.endsWith('.png')) {
                entries[rel] = null; // listed (so map references resolve), not text
                if (!(s.dropPictures || []).includes(rel)) pictures.push([rel, pathToFileURL(p).href]);
              }
            }
          };
          walk(s.from);
          return { dir: s.dir, entries, pictures };
        });
        return {
          contents: [
            "import { memoryFiles } from './packs';",
            "import { normPath } from './tiled';",
            `const PACKS = ${JSON.stringify(packs)};`,
            'let cache = null;',
            'export function bundledPacks() {',
            '  return (cache ??= new Map(PACKS.map((p) => [p.dir, { dir: p.dir, files: memoryFiles(p.entries), pictures: new Map(p.pictures.map(([k, u]) => [normPath(k), u])) }])));',
            '}',
          ].join('\n'),
          loader: 'ts',
          resolveDir: dn(args.path)
        };
      });
    }
  };
  const out = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'SCENARIO',
    platform: 'browser',
    target: 'chrome120',
    // LOAD-FLAKES-176: no inline map by default. It was 40 of the App bundle's 58 MB, and the
    // renderer parses all of it before the scenario can start. HARNESS_SOURCEMAP=1 restores it for
    // a debugging run (stack traces into the .ts sources).
    sourcemap: process.env.HARNESS_SOURCEMAP === '1' ? 'inline' : false,
    // `@` is the renderer's own root alias (electron.vite / tsconfig.web): a scenario that
    // mounts a real COMPONENT, not only terminalPool, pulls in modules that use it.
    alias: {
      '@shared': join(__dirname, '..', '..', 'src', 'shared'),
      '@': join(__dirname, '..', '..', 'src', 'renderer', 'src')
    },
    jsx: 'automatic',
    // What electron-vite defines for the renderer, so a scenario can mount the REAL App (RR-164).
    define: { 'import.meta.env': '{"DEV":false,"PROD":true,"MODE":"production"}', __APP_VERSION__: '"0.0.0-harness"' },
    // viteGlobGuard runs after the packSources fake, so only an unfaked import.meta.glob user stops the build.
    plugins: [sourceOverrides, themePackSources, viteGlobGuard(), viteAssets, cssAsStyleTag],
    logLevel: 'silent'
  });
  return out.outputFiles[0].text;
}

app.whenReady().then(async () => {
  // LOAD-FLAKES-176: setup (bundle, load, eval) and the scenario have separate budgets.
  let phase = 'bundle';
  const setupStart = Date.now();
  const setupTimer = setTimeout(
    () => finish({ ok: false, error: `harness setup timed out after ${setupTimeoutMs}ms in phase ${phase} (the scenario never started)` }),
    setupTimeoutMs
  );
  setupTimer.unref?.();
  let timer = null;

  ipcMain.once('harness:result', (_e, payload) => {
    clearTimeout(setupTimer);
    if (timer) clearTimeout(timer);
    finish(payload);
  });
  ipcMain.on('harness:progress', (_e, payload) => noteProgress(payload));

  try {
    const code = await bundleScenario(scenario);
    const bundleFile = join(sandboxRoot, 'scenario.js');
    writeFileSync(bundleFile, code, 'utf8');

    const win = new BrowserWindow({
      width,
      height,
      show: false,
      webPreferences: {
        preload: join(__dirname, 'harness-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        // Offscreen windows are throttled, which would make a scenario that waits
        // on a frame or a timer flaky for a reason that has nothing to do with it.
        backgroundThrottling: false
      }
    });

    // Real window geometry, because a responsive reading taken by resizing a <div>
    // measures a <div>. The scenario awaits the resize so a later measurement cannot
    // race the layout it is supposed to be measuring.
    ipcMain.handle('harness:resize', (_e, { width: w, height: h }) => {
      win.setSize(Math.round(w), Math.round(h));
      return new Promise((resolve) => setTimeout(() => resolve({ size: win.getSize() }), 120));
    });

    // TES-GUPPY-FRAMING: a screenshot of the whole (hidden) page at a given CONTENT size, so a
    // full-window shot is the size asked for whatever the window frame is.
    ipcMain.handle('harness:capture', async (_e, { width: w, height: h }) => {
      win.setContentSize(Math.round(w), Math.round(h));
      await new Promise((r) => setTimeout(r, 400));
      const img = await win.webContents.capturePage();
      return { size: img.getSize(), png: img.toDataURL() };
    });

    // IMPACT-LOOP-171: the renderer's OWN process memory (private bytes, as the app's
    // RendererMemorySampler reads it), which a page cannot observe about itself.
    ipcMain.handle('harness:metrics', () => {
      const pid = win.webContents.getOSProcessId();
      const r = app.getAppMetrics().find((x) => x.pid === pid);
      return r ? { privateMb: Math.round((r.memory.privateBytes || 0) / 1024), workingSetMb: Math.round(r.memory.workingSetSize / 1024) } : null;
    });

    // TES-GUPPY-FPS: cumulative CPU seconds of the renderer and the GPU process (where Pixi's
    // WebGL work lands), read from main the same way for every floor a scenario measures.
    ipcMain.handle('harness:cpu', () => {
      const pid = win.webContents.getOSProcessId();
      const all = app.getAppMetrics();
      const sec = (m) => (m && m.cpu ? m.cpu.cumulativeCPUUsage ?? null : null);
      return { renderer: sec(all.find((x) => x.pid === pid)), gpu: sec(all.find((x) => x.type === 'GPU')) };
    });

    // A REAL CLICK. `element.click()` dispatches an untrusted synthetic event from inside
    // the page; this goes through Chromium's input pipeline at window coordinates, so it
    // is hit-tested against what is actually rendered there and arrives `isTrusted`.
    ipcMain.handle('harness:click', async (_e, { x, y }) => {
      const at = { x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 };
      win.webContents.sendInputEvent({ type: 'mouseDown', ...at });
      win.webContents.sendInputEvent({ type: 'mouseUp', ...at });
      return new Promise((resolve) => setTimeout(() => resolve(true), 80));
    });

    // A REAL KEYSTROKE (MODEL-NOT-KEPT-191). `dispatchEvent(new KeyboardEvent(...))` is untrusted
    // and runs no microtask checkpoint between listeners; this goes through Chromium's input
    // pipeline to the focused element and arrives `isTrusted`, with a checkpoint after each
    // listener, as a person's key does. `char` only for a printable key, as a keyboard sends it.
    ipcMain.handle('harness:key', async (_e, { keyCode, char }) => {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode });
      if (char) win.webContents.sendInputEvent({ type: 'char', keyCode: char });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode });
      return new Promise((resolve) => setTimeout(() => resolve(true), 80));
    });

    // THE ACCESSIBILITY TREE, NOT THE DOM. C2.11 #14 asks what a screen reader is
    // handed, which is a platform artifact computed from role, name and semantics -
    // routinely different from the markup, and not derivable from it. This is the
    // read jsdom cannot even approximate.
    ipcMain.handle('harness:axtree', async () => {
      try {
        if (!win.webContents.debugger.isAttached()) win.webContents.debugger.attach('1.3');
        await win.webContents.debugger.sendCommand('Accessibility.enable');
        const { nodes } = await win.webContents.debugger.sendCommand('Accessibility.getFullAXTree');
        return nodes.map((n) => ({
          role: n.role?.value ?? null,
          name: n.name?.value ?? null,
          ignored: n.ignored === true
        }));
      } catch (e) {
        return { error: String(e) };
      }
    });

    win.webContents.on('console-message', (_e, _level, message) => {
      process.stderr.write(`[renderer] ${message}\n`);
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      finish({ ok: false, error: `renderer process gone: ${details.reason}` });
    });

    phase = 'load';
    await win.loadFile(join(__dirname, 'page.html'));
    // Executed rather than script-tagged so a bundling or syntax error surfaces here
    // as a rejected promise instead of a silent blank page.
    phase = 'eval';
    await win.webContents.executeJavaScript(code, true);
    // The scenario's own budget starts HERE, with the scenario.
    clearTimeout(setupTimer);
    const setupMs = Date.now() - setupStart;
    process.stderr.write(`[harness] setup ${setupMs} ms (bundle ${code.length} bytes)\n`);
    noteProgress({ phase: 'scenario', step: 'awaiting scenario start', frames: 0 });
    logProgress();
    progressTimer = setInterval(logProgress, 10_000);
    progressTimer.unref?.();
    timer = setTimeout(
      () => {
        logProgress();
        finish({ ok: false, error: `harness timed out after ${timeoutMs}ms (scenario; setup took ${setupMs} ms before it); progress ${JSON.stringify(latestProgress)}` });
      },
      timeoutMs
    );
    timer.unref?.();
    await win.webContents.executeJavaScript('window.__harnessRun()', true);
  } catch (e) {
    finish({ ok: false, error: String((e && e.stack) || e) });
  }
});

app.on('window-all-closed', () => { /* the scenario decides when the run is over */ });
