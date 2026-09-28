'use strict';
/**
 * ZT-I1-MAIL 1.1.75 (god 4dd770 decision 1, Jim): the release check scripts/verify-packaged-no-seams.cjs
 * proves the SHIPPED app.asar has the layer-(b) seams compiled out. Tested on synthetic asars (both
 * ways) and, when out/ is built, on the real main bundle of this tree's normal build.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const asar = require('@electron/asar');
const { verify, verifyBundleText } = require('../scripts/verify-packaged-no-seams.cjs');

const NORMAL = [
  'const LAYERB_SEAMS_BUILT = false;',
  'const DEV_ROOT_ENV = "";',
  'const DEV_HIDDEN_ENV = "";',
  '  // MUNDER_HIDDEN (dev only): a comment may name it',
  'function hiddenRun(env = process.env, dev = DEV_ISOLATION, seams = LAYERB_SEAMS_BUILT) { if (!dev || !seams) return false; return env[DEV_HIDDEN_ENV] === "1"; }'
].join('\n');
const SEAMS = NORMAL.replace('LAYERB_SEAMS_BUILT = false', 'LAYERB_SEAMS_BUILT = true')
  .replace('DEV_ROOT_ENV = ""', 'DEV_ROOT_ENV = "MUNDER_DEV_ROOT"').replace('DEV_HIDDEN_ENV = ""', 'DEV_HIDDEN_ENV = "MUNDER_HIDDEN"');

async function pack(t, mainText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-noseams-'));
  t.after(() => { try { asar.uncacheAll(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* leave it */ } });
  const src = path.join(dir, 'app');
  fs.mkdirSync(path.join(src, 'out', 'main'), { recursive: true });
  fs.writeFileSync(path.join(src, 'package.json'), '{}');
  fs.writeFileSync(path.join(src, 'out', 'main', 'index.js'), mainText);
  const out = path.join(dir, 'app.asar');
  await asar.createPackage(src, out);
  return out;
}

test('a normal build passes: false, empty names, only comments mention the variables', async (t) => {
  assert.deepEqual(verifyBundleText(NORMAL), { ok: true, problems: [] });
  assert.deepEqual(verify(await pack(t, NORMAL)), { ok: true, problems: [] });
});

test('a seams build FAILS, naming every problem', async (t) => {
  const r = verify(await pack(t, SEAMS));
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /LAYERB_SEAMS_BUILT = true/.test(p)));
  assert.ok(r.problems.some((p) => /"MUNDER_HIDDEN" is still in the code/.test(p)));
  assert.ok(r.problems.some((p) => /"MUNDER_DEV_ROOT" is still in the code/.test(p)));
  assert.equal(verifyBundleText(NORMAL.replace('const LAYERB_SEAMS_BUILT = false;', '')).ok, false, 'a missing constant fails closed');
  assert.equal(verifyBundleText(NORMAL + '\nconst x = typeof __LAYERB_SEAMS__;').ok, false, 'an unsubstituted define fails');
  assert.equal(verify(path.join(os.tmpdir(), 'no-such.asar')).ok, false);
});

const BUNDLE = path.join(__dirname, '..', 'out', 'main', 'index.js');
if (!fs.existsSync(BUNDLE)) {
  require('./tools/inert.cjs').announceInert('BUILT: the normal out/main bundle has the seams compiled out (did not run)', 'out/main/index.js not built — run npm run build');
} else {
  test('BUILT: this tree\'s normal out/main bundle has the seams compiled out', () => {
    if (process.env.MUNDER_LAYERB_SEAMS === '1') return;   // a deliberate seams build
    const r = verifyBundleText(fs.readFileSync(BUNDLE, 'utf8'));
    assert.deepEqual(r, { ok: true, problems: [] }, 'out/ must never hold a seams build outside a layer-b run');
  });
}
