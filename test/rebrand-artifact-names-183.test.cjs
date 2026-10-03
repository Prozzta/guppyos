'use strict';
/**
 * REBRAND-ARTIFACT-NAMES (1.1.83): the release files become Guppy-*, and a 1.1.81 install's
 * MANUAL-download link (fixed Munder-Difflin-* names) still resolves: afterAllArtifactBuild writes a
 * byte-identical Munder-Difflin-* copy of each file such a link names, and the release gate
 * (tools/check-release-links.cjs) requires the hook offline and the copy live.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const hook = require('../build/legacyArtifactNames.cjs');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'md-artifact-names-'));
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

/** 1.1.81's installerUrl file names, verbatim from release-1.1.81 src/shared/updateState.ts. */
const v181Name = (v, platform, arch) => (platform === 'darwin' ? `Munder-Difflin-${v}-mac-${arch}.dmg`
  : platform === 'win32' ? `Munder-Difflin-${v}-win-x64-setup.exe`
  : `Munder-Difflin-${v}-linux-x86_64.AppImage`);

test('legacyName: exactly the three shapes 1.1.81 links to, mapped to the names it builds', () => {
  assert.equal(hook.legacyName('C:\\dist\\Guppy-1.1.83-win-x64-setup.exe'), v181Name('1.1.83', 'win32'));
  assert.equal(hook.legacyName('/dist/Guppy-1.1.83-mac-universal.dmg'), v181Name('1.1.83', 'darwin', 'universal'));
  assert.equal(hook.legacyName('/dist/Guppy-1.2.0-mac-arm64.dmg'), v181Name('1.2.0', 'darwin', 'arm64'));
  assert.equal(hook.legacyName('/dist/Guppy-1.1.83-linux-x86_64.AppImage'), v181Name('1.1.83', 'linux'));
  for (const f of ['Guppy-1.1.83-win-x64-setup.exe.blockmap', 'Guppy-1.1.83-win-x64-portable.exe', 'latest.yml',
    'Guppy-1.1.83-mac-universal.zip', 'app.asar', 'Munder-Difflin-1.1.83-win-x64-setup.exe', 'Guppy-x-win-x64-setup.exe']) {
    assert.equal(hook.legacyName(`/dist/${f}`), null, f);
  }
});

test('afterAllArtifactBuild: writes byte-identical copies next to the files and returns only them', async () => {
  const dist = fs.mkdtempSync(path.join(tmpRoot, 'dist-'));
  const files = {
    'Guppy-1.1.83-win-x64-setup.exe': 'SETUP-BYTES',
    'Guppy-1.1.83-win-x64-setup.exe.blockmap': 'BM',
    'Guppy-1.1.83-win-x64-portable.exe': 'PORTABLE',
    'latest.yml': 'version: 1.1.83'
  };
  for (const [n, b] of Object.entries(files)) fs.writeFileSync(path.join(dist, n), b);
  const extra = await hook({ artifactPaths: Object.keys(files).map((n) => path.join(dist, n)) });
  assert.deepEqual(extra, [path.join(dist, 'Munder-Difflin-1.1.83-win-x64-setup.exe')]);
  assert.equal(fs.readFileSync(extra[0], 'utf8'), 'SETUP-BYTES');
  assert.deepEqual(fs.readdirSync(dist).sort(), [...Object.keys(files), 'Munder-Difflin-1.1.83-win-x64-setup.exe'].sort());
  assert.deepEqual(await hook({ artifactPaths: [] }), []);
  assert.deepEqual(await hook({}), []);
});

test('electron-builder.yml: Guppy-* names, the hook is wired, and latest.yml keeps naming the Guppy-* file', () => {
  const y = read('electron-builder.yml');
  assert.match(y, /^afterAllArtifactBuild: build\/legacyArtifactNames\.cjs$/m);
  assert.match(y, /^ {2}artifactName: Guppy-\$\{version\}-win-x64-setup\.exe$/m);
  assert.doesNotMatch(y, /artifactName: Munder-Difflin/);
  // electron-builder resolves a hook as module.default ?? module.
  assert.equal(typeof hook, 'function');
  assert.equal(hook.default, hook);
});

test('check-release-links: Guppy-* passes for 1.1.83 only with the hook; the hook\'s copies equal 1.1.81\'s names; --live asks for the copy', () => {
  const run = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'tools', 'check-release-links.cjs'), ...a], { encoding: 'utf8', windowsHide: true });
  const ok = run('--version', '1.1.83');
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /Guppy-\* artifacts/);
  const old = run('--version', '1.1.82');
  assert.equal(old.status, 1);
  assert.match(old.stderr, /win setup: electron-builder\.yml makes Guppy-1\.1\.82-win-x64-setup\.exe, the app links to Munder-Difflin-1\.1\.82-win-x64-setup\.exe/);
  const src = read('tools/check-release-links.cjs');
  assert.match(src, /\.\.\.\(p === 'Guppy' \? \[legacy\['win setup'\]\] : \[\]\)/, 'the live check requests the Munder-Difflin-* copy');
  assert.match(src, /'win setup': `Munder-Difflin-\$\{version\}-win-x64-setup\.exe`/);
});

test('check-release-links (mutant): without the hook line, 1.1.83 is refused', () => {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'repo-'));
  for (const rel of ['tools/check-release-links.cjs', 'package.json', 'src/shared/updateState.ts', 'build/legacyArtifactNames.cjs']) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), path.join(dir, rel));
  }
  const y = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
  fs.writeFileSync(path.join(dir, 'electron-builder.yml'), y.replace(/^afterAllArtifactBuild: .*$/m, ''));
  const r = spawnSync(process.execPath, [path.join(dir, 'tools', 'check-release-links.cjs'), '--version', '1.1.83'], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no afterAllArtifactBuild/);
  // ... and a hook that maps to the wrong name is refused too.
  fs.writeFileSync(path.join(dir, 'electron-builder.yml'), y);
  const h = fs.readFileSync(path.join(ROOT, 'build', 'legacyArtifactNames.cjs'), 'utf8');
  fs.writeFileSync(path.join(dir, 'build', 'legacyArtifactNames.cjs'), h.replace("const LEGACY_PREFIX = 'Munder-Difflin-';", "const LEGACY_PREFIX = 'MunderDifflin-';"));
  const w = spawnSync(process.execPath, [path.join(dir, 'tools', 'check-release-links.cjs'), '--version', '1.1.83'], { encoding: 'utf8', windowsHide: true });
  assert.equal(w.status, 1);
  assert.match(w.stderr, /win setup: the build copies Guppy-1\.1\.83-win-x64-setup\.exe to MunderDifflin-1\.1\.83-win-x64-setup\.exe, 1\.1\.81 links to Munder-Difflin-1\.1\.83-win-x64-setup\.exe/);
});
