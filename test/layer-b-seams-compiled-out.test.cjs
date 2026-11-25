'use strict';
require('./tools/own-job.cjs');
// MUTANT-JOURNAL-GATE (god 5cc045/ed8032): this suite loads a file a census mutates in place (one load-ts never sees);
// refuse a tree a killed census left mutated, before anything is read.
require('./tools/mutant-runner-helper.cjs').gate(__filename);
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
const { removeDir } = require('./tools/test-temp.cjs');
const asar = require('@electron/asar');
const { verify, verifyBundleText } = require('../scripts/verify-packaged-no-seams.cjs');
// As tools/test-temp.cjs: under Electron the patched fs cannot remove a *.asar file.
const ofs = process.versions.electron ? require('original-fs') : fs;

const NORMAL = [
  'const LAYERB_SEAMS_BUILT = false;',
  'const DEV_ROOT_ENV = "";',
  'const DEV_HIDDEN_ENV = "";',
  '  // MUNDER_HIDDEN (dev only): a comment may name it',
  'function hiddenRun(env = process.env, dev = DEV_ISOLATION, seams = LAYERB_SEAMS_BUILT) { if (!dev || !seams) return false; return env[DEV_HIDDEN_ENV] === "1"; }'
].join('\n');
const SEAMS = NORMAL.replace('LAYERB_SEAMS_BUILT = false', 'LAYERB_SEAMS_BUILT = true')
  .replace('DEV_ROOT_ENV = ""', 'DEV_ROOT_ENV = "MUNDER_DEV_ROOT"').replace('DEV_HIDDEN_ENV = ""', 'DEV_HIDDEN_ENV = "MUNDER_HIDDEN"');

// @electron/asar resolves createPackage with out.end(), the archive's write stream, before that stream
// has closed its file handle. Under Electron a folder that holds a file still open cannot be removed
// (ENOTEMPTY), so cleanup used to start against an open app.asar. pack() waits for 'close'.
async function archiveClosed(ws) {
  if (!ws || typeof ws.once !== 'function' || typeof ws.closed !== 'boolean') {
    throw new Error('createPackage no longer resolves with its write stream: pack() cannot wait for the archive to close');
  }
  if (ws.closed) return;
  await new Promise((res, rej) => { ws.once('close', res); ws.once('error', rej); });
}

// The after-hook's cleanup, checked: removeDir's answer was dropped before, so a folder that stayed went
// unrecorded until the runner's TEMP LEAK line. A failure names the last rm code, the tries and what is left.
async function removePacked(dir, opts = {}) {
  let tries = 0;
  let last = null;
  const rmOnce = opts.rm || ((d) => ofs.rmSync(d, { recursive: true, force: true }));
  const gone = await removeDir(dir, { ...opts, rm: (d) => { tries++; try { rmOnce(d); } catch (e) { last = e; throw e; } } });
  if (gone && !ofs.existsSync(dir)) return;
  let left;
  try { left = ofs.readdirSync(dir).join(', ') || '(empty)'; } catch (e) { left = `unreadable (${e.code})`; }
  assert.fail(`TEMP FOLDER LEFT: ${dir}; removeDir=${gone}; tries=${tries}; last rm error=${last ? last.code : 'none'}; left: ${left}`);
}

async function pack(t, mainText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-noseams-'));
  t.after(async () => { try { asar.uncacheAll(); } catch { /* nothing cached */ } await removePacked(dir); });
  const src = path.join(dir, 'app');
  fs.mkdirSync(path.join(src, 'out', 'main'), { recursive: true });
  fs.writeFileSync(path.join(src, 'package.json'), '{}');
  fs.writeFileSync(path.join(src, 'out', 'main', 'index.js'), mainText);
  const out = path.join(dir, 'app.asar');
  await archiveClosed(await asar.createPackage(src, out));
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

// Red before the wait under Electron: ENOTEMPTY at round 0 (the archive was still open). Node removes a
// folder with an open file, so this cell is green on the Node leg either way.
test('pack() returns with the archive closed: the folder goes at the first rmSync, every round', async (t) => {
  for (let i = 0; i < 20; i++) {
    const dir = path.dirname(await pack(t, NORMAL));
    try { asar.uncacheAll(); } catch { /* nothing cached */ }
    assert.doesNotThrow(() => ofs.rmSync(dir, { recursive: true, force: true }), `round ${i}: the first rmSync`);
    assert.equal(ofs.existsSync(dir), false, `round ${i}: the folder is gone`);
  }
});

// Red before removePacked: the hook awaited removeDir and dropped its false, so this shape passed in silence.
// The budget is passed for THIS call only; the default budget is untouched.
test('cleanup that cannot finish FAILS the cell: a file held open past the budget is named', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-noseams-'));
  const fd = fs.openSync(path.join(dir, 'held.txt'), 'w');
  try {
    if (process.versions.electron) {
      await assert.rejects(removePacked(dir, { budgetMs: 300 }),
        /TEMP FOLDER LEFT: .*md-noseams-.*; removeDir=false; tries=\d+; last rm error=(ENOTEMPTY|EPERM|EBUSY); left: /);
    } else {
      // Node removes a folder that holds an open file, so the same call succeeds here.
      await removePacked(dir, { budgetMs: 300 });
      assert.equal(fs.existsSync(dir), false, 'Node: the folder is gone');
    }
  } finally {
    fs.closeSync(fd);
  }
  assert.equal(await removeDir(dir), true, 'the folder goes once the file is closed');
  assert.equal(ofs.existsSync(dir), false);
});

test('cleanup that reports success but leaves the folder FAILS the cell (both runtimes)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-noseams-'));
  fs.writeFileSync(path.join(dir, 'stays.txt'), 'x');
  try {
    await assert.rejects(removePacked(dir, { rm: () => { /* returns, removes nothing */ } }),
      /TEMP FOLDER LEFT: .*md-noseams-.*; removeDir=true; tries=1; last rm error=none; left: stays\.txt/);
  } finally {
    assert.equal(await removeDir(dir), true);
  }
  assert.equal(ofs.existsSync(dir), false);
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
