'use strict';
require('./tools/own-job.cjs');

// Behavioural checks at two theme boundaries, run on the REAL sources bundled by esbuild:
//  1. getTheme() falls back to the Office for every id that is not its own built-in theme,
//     including ids that name Object.prototype members ("constructor", "__proto__", ...).
//  2. The harness bundle stops, naming the file, when a module other than
//     scene/themes/packSources.ts uses import.meta.glob (Guppy form of MunderDev 90c87726),
//     and lets packSources.ts through to its own fake.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const esbuild = require('esbuild');
const { viteGlobGuard } = require('./electron-harness/vite-glob-guard.cjs');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'src', 'renderer', 'src');

/** Vite's ?url / ?raw imports as plain strings, so a renderer module bundles under node. */
const viteQueries = {
  name: 'vite-queries',
  setup(build) {
    build.onResolve({ filter: /\?(url|raw)$/ }, (args) => ({ path: args.path, namespace: 'vite-query' }));
    build.onLoad({ filter: /.*/, namespace: 'vite-query' }, (args) => ({
      contents: `export default ${JSON.stringify(args.path.endsWith('?raw') ? '{}' : 'url:' + args.path)};`, loader: 'js'
    }));
  }
};

async function loadThemeRegistry() {
  const out = await esbuild.build({
    entryPoints: [path.join(RENDERER, 'scene', 'office', 'themeRegistry.ts')],
    bundle: true, write: false, format: 'cjs', platform: 'node', target: 'node20',
    alias: { '@shared': path.join(ROOT, 'src', 'shared'), '@': RENDERER },
    external: ['pixi.js'],
    logLevel: 'silent',
    plugins: [viteQueries]
  });
  const mod = { exports: {} };
  // pixi.js needs a browser to load; nothing on the getTheme path calls into it.
  const req = (id) => (id === 'pixi.js' ? {} : require(id));
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, req);
  return mod.exports;
}

test('getTheme: an id naming an Object.prototype member gets the Office, never a prototype value', async () => {
  const { getTheme, OFFICE_THEME } = await loadThemeRegistry();
  assert.equal(OFFICE_THEME.id, 'office');
  for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', 'no-such-pack', '']) {
    assert.equal(getTheme(id), OFFICE_THEME, `getTheme(${JSON.stringify(id)})`);
  }
  assert.equal(getTheme('office'), OFFICE_THEME);
});

function bundleWithGuard(files, entry) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glob-guard-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return esbuild.build({
    entryPoints: [path.join(dir, entry)], bundle: true, write: false, format: 'iife', logLevel: 'silent',
    plugins: [viteGlobGuard()]
  }).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

test('harness bundle: an import.meta.glob outside packSources.ts stops the build and names the file', async () => {
  await assert.rejects(
    bundleWithGuard({
      'entry.ts': "import { all } from './scene/themes/other';\nconsole.log(all);\n",
      'scene/themes/other.ts': "export const all = import.meta.glob('./x/*.json');\n"
    }, 'entry.ts'),
    (e) => {
      const text = e.errors.map((x) => x.text).join('\n');
      assert.match(text, /other\.ts uses import\.meta\.glob/);
      assert.match(text, /packSources\.ts/);
      return true;
    }
  );
});

test('harness bundle: packSources.ts itself and glob-free modules pass the guard', async () => {
  const r = await bundleWithGuard({
    'entry.ts': "import { a } from './scene/themes/packSources';\nimport { b } from './plain';\nconsole.log(a, b);\n",
    // the allowed module may use it (the real harness fakes it before the guard runs)
    'scene/themes/packSources.ts': "export const a = import.meta.glob('./x/*.json');\n",
    'plain.ts': 'export const b = 2;\n'
  }, 'entry.ts');
  assert.equal(r.errors.length, 0);
  // and the real harness wires the guard after the packSources fake
  const main = fs.readFileSync(path.join(__dirname, 'electron-harness', 'harness-main.cjs'), 'utf8');
  assert.match(main, /plugins: \[sourceOverrides, themePackSources, viteGlobGuard\(\), viteAssets, cssAsStyleTag\]/);
});
