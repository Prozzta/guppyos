'use strict';
// REBRAND-ARTIFACT-NAMES (1.1.83): the release files are named Guppy-* from 1.1.83 on
// (electron-builder.yml artifactName; src/shared/updateState.ts GUPPY_ARTIFACTS_FROM). 1.1.81 and
// older build their MANUAL-download link from fixed names (updateState.ts installerUrl before
// 1.1.82): Munder-Difflin-<v>-win-x64-setup.exe, Munder-Difflin-<v>-mac-<arch>.dmg and
// Munder-Difflin-<v>-linux-x86_64.AppImage. So for each file of those three shapes this
// afterAllArtifactBuild hook writes a byte-identical Munder-Difflin-* copy next to it and returns
// it (electron-builder publishes returned files; our release uploads it from dist/). The native
// updater is unaffected: it follows latest*.yml, which names the Guppy-* file.
// Only those three shapes: blockmaps, latest*.yml, the portable exe and the mac zip are never
// built into a link by an old app.
const fs = require('node:fs');
const path = require('node:path');

const PREFIX = 'Guppy-';
const LEGACY_PREFIX = 'Munder-Difflin-';
/** The file shapes an old app builds a manual-download link from (after the prefix). */
const LEGACY_SHAPES = [
  /^\d+\.\d+\.\d+-win-x64-setup\.exe$/,
  /^\d+\.\d+\.\d+-mac-[A-Za-z0-9_]+\.dmg$/,
  /^\d+\.\d+\.\d+-linux-x86_64\.AppImage$/
];

/** The legacy name for a built file, or null when no old app links to a file of its shape. */
function legacyName(file) {
  const base = path.basename(file);
  if (!base.startsWith(PREFIX)) return null;
  const rest = base.slice(PREFIX.length);
  return LEGACY_SHAPES.some((r) => r.test(rest)) ? LEGACY_PREFIX + rest : null;
}

async function afterAllArtifactBuild(result) {
  const extra = [];
  for (const file of (result && result.artifactPaths) || []) {
    const name = legacyName(file);
    if (!name) continue;
    const dest = path.join(path.dirname(file), name);
    fs.copyFileSync(file, dest);
    const a = fs.statSync(file).size;
    const b = fs.statSync(dest).size;
    if (a !== b) throw new Error(`legacy copy ${name}: ${b} bytes, expected ${a}`);
    console.log(`  • legacy download name: ${name} (1.1.81 and older link to it)`);
    extra.push(dest);
  }
  return extra;
}

module.exports = afterAllArtifactBuild;
module.exports.default = afterAllArtifactBuild;
module.exports.legacyName = legacyName;
module.exports.LEGACY_SHAPES = LEGACY_SHAPES;
