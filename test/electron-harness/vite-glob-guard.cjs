'use strict';

// Fail loudly at the import.meta.glob boundary (Guppy form of MunderDev 90c87726).
// esbuild has no import.meta.glob, so a renderer module that uses it bundles fine and then
// throws at load, taking every real-App scenario with it and naming nothing useful.
// packSources.ts is the one module allowed to read bundled files that way, and the harness
// fakes it at its own boundary (harness-main.cjs, theme-pack-sources). Any OTHER source that
// reaches the bundle with import.meta.glob stops the build here, naming the file and the fix.

const fs = require('node:fs/promises');

const ALLOWED = /[\\/]scene[\\/]themes[\\/]packSources\.ts$/;
const GLOB = /\bimport\.meta\.glob\b/;

function viteGlobGuard() {
  return {
    name: 'vite-glob-guard',
    setup(build) {
      build.onLoad({ filter: /\.(t|j)sx?$/ }, async (args) => {
        if (ALLOWED.test(args.path) || /[\\/]node_modules[\\/]/.test(args.path)) return undefined;
        const text = await fs.readFile(args.path, 'utf8');
        if (!GLOB.test(text)) return undefined;
        return {
          errors: [{
            text: `${args.path} uses import.meta.glob, which the harness bundle (esbuild) does not provide. ` +
              'Read bundled files through scene/themes/packSources.ts, or fake this module at its own boundary in harness-main.cjs.'
          }]
        };
      });
    }
  };
}

module.exports = { viteGlobGuard };
