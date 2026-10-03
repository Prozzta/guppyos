#!/usr/bin/env node
'use strict';

/**
 * Release gate: the download links this app hands its users must resolve, on THIS app's own
 * repository (src/shared/updateState.ts REPO, Prozzta/guppyos). Never the upstream project.
 *
 * WHY. When a status carries no downloadUrl, the app builds the installer link itself from fixed
 * artifact names (updateState.ts installerUrl / artifactPrefix: Munder-Difflin-* up to 1.1.82,
 * Guppy-* from 1.1.83). If electron-builder.yml's artifactName and that rule ever disagree, the
 * manual-download link is a 404 for everyone on that path, and nothing fails or warns.
 *
 * (REBRAND-GUPPY 1.1.82: this used to check upstream's RELEASE.md, docs/index.html and
 * docs/llms.txt against chaitanyagiri/munder-difflin's latest release. Those are upstream's website
 * and release page, not this app's, and the live check asked the wrong repository.)
 *
 * Two modes:
 *   (default) offline: electron-builder.yml's Windows/mac/Linux artifact names for package.json's
 *             version equal the names installerUrl() builds. Run this BEFORE tagging.
 *   --live    also requests each asset of the tagged release v<version>, plus latest.yml through
 *             /releases/latest/download/ (the updater's path), and requires 200. Run it AFTER
 *             publishing.
 */

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
// `--version x.y.z` checks the names as they would be at that version (a fix branch made before the
// bump); the release gate runs without it, at package.json's version.
const vArg = process.argv.indexOf('--version');
const version = vArg > 0 && /^\d+\.\d+\.\d+$/.test(process.argv[vArg + 1] || '')
  ? process.argv[vArg + 1]
  : JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const builderYml = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');
const updateState = fs.readFileSync(path.join(root, 'src', 'shared', 'updateState.ts'), 'utf8');

const problems = [];

const repoM = /export const REPO = '([^']+)'/.exec(updateState);
const fromM = /export const GUPPY_ARTIFACTS_FROM = '(\d+)\.(\d+)\.(\d+)'/.exec(updateState);
if (!repoM) problems.push('src/shared/updateState.ts no longer exports REPO as a string literal');
if (!fromM) problems.push('src/shared/updateState.ts no longer exports GUPPY_ARTIFACTS_FROM');
const REPO = repoM ? repoM[1] : '';
if (REPO && !/^Prozzta\//.test(REPO)) problems.push(`REPO is ${REPO}: the release links must be on the Prozzta repository`);

/** updateState.ts artifactPrefix(), restated: Guppy from GUPPY_ARTIFACTS_FROM on. */
function prefixFor(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v);
  if (!m || !fromM) return 'Munder-Difflin';
  const a = [m[1], m[2], m[3]].map(Number);
  const b = [fromM[1], fromM[2], fromM[3]].map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 'Guppy' : 'Munder-Difflin';
  return 'Guppy';
}

/** An electron-builder.yml section's artifactName, expanded for this version. */
function artifact(section, vars) {
  const m = new RegExp(`^${section}:\\r?\\n(?:[ \\t].*\\r?\\n|\\r?\\n)*?[ \\t]+artifactName: (\\S+)`, 'm').exec(builderYml);
  if (!m) { problems.push(`electron-builder.yml ${section}: no artifactName`); return null; }
  return m[1].replace(/\$\{(\w+)\}/g, (_, k) => (k in vars ? vars[k] : `\${${k}}`));
}

const p = prefixFor(version);
const want = {
  'win setup': [artifact('nsis', { version }), `${p}-${version}-win-x64-setup.exe`],
  'win portable': [artifact('portable', { version }), `${p}-${version}-win-x64-portable.exe`],
  'mac dmg (universal)': [artifact('mac', { version, arch: 'universal', ext: 'dmg' }), `${p}-${version}-mac-universal.dmg`],
  'linux AppImage': [artifact('linux', { version }), `${p}-${version}-linux-x86_64.AppImage`]
};
for (const [what, [got, expected]] of Object.entries(want)) {
  if (got !== null && got !== expected) problems.push(`${what}: electron-builder.yml makes ${got}, the app links to ${expected}`);
}

/** REBRAND-ARTIFACT-NAMES (1.1.83): the names 1.1.81 and older link to, whatever the version
 *  (their installerUrl, restated). From the first Guppy-* release on, the build must also write
 *  these as copies (build/legacyArtifactNames.cjs, run as afterAllArtifactBuild). */
const legacy = {
  'win setup': `Munder-Difflin-${version}-win-x64-setup.exe`,
  'mac dmg (universal)': `Munder-Difflin-${version}-mac-universal.dmg`,
  'linux AppImage': `Munder-Difflin-${version}-linux-x86_64.AppImage`
};
if (p === 'Guppy') {
  const hookM = /^afterAllArtifactBuild: (\S+)\s*$/m.exec(builderYml);
  if (!hookM) problems.push('electron-builder.yml has no afterAllArtifactBuild: the Munder-Difflin-* copies 1.1.81 links to would not be built');
  else {
    let hook = null;
    try { hook = require(path.join(root, hookM[1])); } catch (e) { problems.push(`afterAllArtifactBuild ${hookM[1]}: cannot load: ${e.message}`); }
    if (hook && typeof hook.legacyName === 'function') {
      for (const [what, name] of Object.entries(legacy)) {
        const built = want[what][0];
        const copy = built ? hook.legacyName(built) : null;
        if (copy !== name) problems.push(`${what}: the build copies ${built} to ${copy}, 1.1.81 links to ${name}`);
      }
    } else if (hook) problems.push(`afterAllArtifactBuild ${hookM[1]}: no legacyName()`);
  }
}

async function checkLive() {
  const setup = want['win setup'][1];
  const urls = [
    ...[setup, `${setup}.blockmap`, 'latest.yml', want['win portable'][1], ...(p === 'Guppy' ? [legacy['win setup']] : [])]
      .map((name) => `https://github.com/${REPO}/releases/download/v${version}/${name}`),
    `https://github.com/${REPO}/releases/latest/download/latest.yml`
  ];
  for (const url of urls) {
    let status = 0;
    try {
      // GitHub 302s asset downloads to a CDN, so follow it; HEAD is enough.
      status = (await fetch(url, { method: 'HEAD', redirect: 'follow' })).status;
    } catch (e) {
      problems.push(`${url}: request failed: ${e.message}`);
      continue;
    }
    if (status !== 200) problems.push(`${url}: HTTP ${status} (advertised but not downloadable)`);
    else console.log(`  ok  ${url}`);
  }
}

module.exports = { prefixFor, artifact, want, legacy, problems, REPO };

if (require.main === module) {
  (async () => {
    if (process.argv.includes('--live')) {
      console.log(`Checking the v${version} downloads on ${REPO}…`);
      await checkLive();
    }
    if (problems.length) {
      console.error(`\n✗ release links are wrong (${problems.length}):`);
      for (const x of problems) console.error(`  - ${x}`);
      process.exit(1);
    }
    console.log(`✓ release links consistent at v${version} (${REPO}, ${p}-* artifacts)`);
  })();
}
