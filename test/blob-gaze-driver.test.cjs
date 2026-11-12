'use strict';
// BLOB-GAZE: the REAL blobatar gaze driver, under the app's own Electron, moves the eyes after lookAt.
// Root cause this pins: blobatar measures the eye travel with isPointInFill(new DOMPoint(...)); the
// Chromium in Electron 32 only took an SVGPoint, so the measure threw, no eye offsets were written and
// the eyes never moved. Electron 45 accepts it. A downgrade, or a blobatar update that breaks the
// measure, fails here instead of shipping a Blob with frozen eyes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.join(__dirname, '..');
const electron = process.platform === 'win32'
  ? path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(root, 'node_modules', 'electron', 'dist', 'electron');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('real blobatar gaze: lookAt left/right writes eye offsets of opposite sign and moves the eyes', { skip: !fs.existsSync(electron) && 'Electron not installed' }, () => {
  const env = { ...process.env, MUNDER_HIDDEN: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(electron, [path.join(__dirname, 'blob-gaze-driver-probe.cjs')], { cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  const out = JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(out.pif, true, 'the engine accepts blobatar\'s isPointInFill(DOMPoint)');
  assert.equal(out.structure, 2, 'the face has the body group and two eyes the measure needs');
  const left = Number.parseFloat(out.left.dx1);
  const right = Number.parseFloat(out.right.dx1);
  assert.ok(Number.isFinite(left) && Number.isFinite(right), `eye offsets written: ${JSON.stringify(out)}`);
  assert.ok(left < 0 && right > 0, `eyes look left then right: ${left} / ${right}`);
  assert.notEqual(out.left.eye, out.right.eye, 'the eye element itself moves');
});

test('diagnostic: the overlay warns once when the eyes are never driven, and main logs that line', () => {
  const app = read('src/renderer/src/blob/BlobApp.tsx');
  assert.match(app, /getPropertyValue\('--mo-gz-dx1'\)\.trim\(\) === ''\) \{\s*console\.warn\(`\$\{BLOB_GAZE_DEAD\}/);
  assert.match(app, /if \(deadCheck === undefined\) deadCheck = window\.setTimeout\(checkEyesDriven, GAZE_DEAD_CHECK_MS\)/, 'checked once per mount');
  const main = read('src/main/index.ts');
  assert.match(main, /m\.startsWith\(BLOB_GAZE_DEAD\)\) \{ try \{ hive\.appendLog\(\{ kind: 'blob-gaze-dead'/);
});
