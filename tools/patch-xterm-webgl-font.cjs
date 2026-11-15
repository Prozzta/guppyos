#!/usr/bin/env node
'use strict';

// TERM-FONT-105: @xterm/addon-webgl 0.19.0 builds its canvas font strings as
//   `${italic} ${weight} ${px}px ${family}`   (glyph atlas, TextureAtlas._drawToCache)
//   `${italic ? "italic" : ""} ${weight} ...` (BaseRenderLayer._getFont)
// so every non-italic glyph gets a font string with a LEADING SPACE (" normal 14px ...").
// Chrome 128 (Electron 32) accepted it; Chrome 156 (Electron 45) rejects a canvas font string
// with leading whitespace, the assignment is ignored, ctx.font stays "10px sans-serif", and
// every terminal glyph is rasterised in a 10px proportional sans inside monospace cells.
// Upstream is unfixed (0.19.0 latest, 0.20.0-beta.330 builds the same string).
//
// The patch emits the italic part with its own trailing space only when it is set, so the
// string starts with the weight: "normal 14px ..." / "italic bold 14px ...".
//
// Strict like patch-node-pty-winpty-gyp, by SHA-256 of each lib file:
//   pristine 0.19.0 -> patch, then require the result to equal the pinned patched digest
//   already patched -> no-op (second npm ci / npm rebuild / npm run postinstall)
//   anything else  -> fail (different addon version, partial patch, ...)
// `--check` only asserts the patched digests. It is a postinstall step AND the first step of
// `npm run build`, so a skipped, masked or undone patch fails before anything is bundled.
// `--root <addon-webgl dir>` targets another tree (self-test).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ADDON_WEBGL_VERSION = '0.19.0';
// Per file: pristine + patched digests and the exact patch points (each must occur once).
const FILES = {
  'lib/addon-webgl.js': {
    pristine: 'b85f8d4b3e9756bebb757e3fe47134d70f03ea3d6b187624426d2e2b65dec06c',
    patched: 'db53c7ef85c3eec5f9df20af5ca1888bfeef8897a18217f0652686cc063aa1e8',
    edits: [
      ['this._tmpCtx.font=`${D} ${S} ${', 'this._tmpCtx.font=`${D?D+" ":""}${S} ${'],
      ['return`${i?"italic":""} ${t?e.options.fontWeightBold', 'return`${i?"italic ":""}${t?e.options.fontWeightBold']
    ]
  },
  'lib/addon-webgl.mjs': {
    pristine: '5ac2cbbb8a861ba99176eda0ee91f10c08de32d091e3488edf699ad111131ebb',
    patched: '1707f2a8590d1e811f2b83a205903705301d7398adcc356465ac1aa87f357c8e',
    edits: [
      ['this._tmpCtx.font=`${ue} ${G} ${', 'this._tmpCtx.font=`${ue?ue+" ":""}${G} ${'],
      ['return`${s?"italic":""} ${o} ${', 'return`${s?"italic ":""}${o} ${']
    ]
  }
};

if (require.main !== module) {
  module.exports = { ADDON_WEBGL_VERSION, FILES };
  return;
}
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const root = arg('--root') ? path.resolve(arg('--root')) : path.join(__dirname, '..', 'node_modules', '@xterm', 'addon-webgl');
const check = process.argv.includes('--check');
const fail = (msg) => { console.error(`[patch-xterm-webgl-font] FAILED: ${msg}`); process.exit(1); };
const pkgPath = path.join(root, 'package.json');
if (!fs.existsSync(pkgPath)) fail(`@xterm/addon-webgl package.json missing at ${pkgPath}`);
const version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
if (version !== ADDON_WEBGL_VERSION) fail(`@xterm/addon-webgl ${ADDON_WEBGL_VERSION} required, got ${version}; re-check its canvas font strings before changing the dependency`);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

const out = [];
for (const [rel, pin] of Object.entries(FILES)) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) fail(`${rel} missing`);
  let source = fs.readFileSync(file, 'utf8');
  const inputSha = sha(source);
  if (inputSha === pin.patched) continue;
  if (check) fail(`${rel} is not the pinned patched form (sha256 ${inputSha}): terminal glyphs would render in 10px sans-serif on Chromium >= 156`);
  if (inputSha !== pin.pristine) fail(`${rel} is neither pristine ${ADDON_WEBGL_VERSION} nor the pinned patched form (sha256 ${inputSha})`);
  for (const [before, after] of pin.edits) {
    if (source.split(before).length !== 2) fail(`${rel} patch point missing or repeated: ${before}`);
    source = source.replace(before, () => after);
  }
  const outSha = sha(source);
  if (outSha !== pin.patched) fail(`patched ${rel} sha256 ${outSha} != pinned ${pin.patched}`);
  out.push([file, source]);
}
for (const [file, source] of out) fs.writeFileSync(file, source);
console.log(`[patch-xterm-webgl-font] canvas font strings ${out.length ? 'patched' : check ? 'are patched' : 'already patched'} (no leading space)`);
