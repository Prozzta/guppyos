'use strict';

// electron-updater compares UpdateInfo.minimumSystemVersion with os.release(),
// which is the Darwin kernel release on macOS (Ventura = Darwin 22.0.0), rather
// than the marketing macOS version used by Info.plist. electron-builder writes
// latest-mac.yml after afterAllArtifactBuild, so this runs after the builder.
const fs = require('node:fs');
const path = require('node:path');

const MAC_UPDATE_MINIMUM_SYSTEM_VERSION = '22.0.0';

function setMacUpdateMinimum(file) {
  if (path.basename(file) !== 'latest-mac.yml') {
    throw new Error(`expected latest-mac.yml, got ${path.basename(file)}`);
  }
  const before = fs.readFileSync(file, 'utf8');
  const line = `minimumSystemVersion: ${MAC_UPDATE_MINIMUM_SYSTEM_VERSION}`;
  const after = /^minimumSystemVersion:\s*.*$/m.test(before)
    ? before.replace(/^minimumSystemVersion:\s*.*$/m, line)
    : `${before.replace(/\s*$/, '')}\n${line}\n`;
  if (after !== before) fs.writeFileSync(file, after);
}

function maybeSetMacUpdateMinimum(file, platform = process.platform) {
  if (platform !== 'darwin') return false;
  setMacUpdateMinimum(file);
  return true;
}

function main(argv = process.argv.slice(2), platform = process.platform) {
  const whenDarwin = argv[0] === '--when-darwin';
  const files = whenDarwin ? argv.slice(1) : argv;
  if (files.length !== 1) throw new Error('usage: node build/macUpdateFloor.cjs [--when-darwin] <dist/latest-mac.yml>');
  return whenDarwin ? maybeSetMacUpdateMinimum(files[0], platform) : (setMacUpdateMinimum(files[0]), true);
}

if (require.main === module) main();

module.exports = { MAC_UPDATE_MINIMUM_SYSTEM_VERSION, setMacUpdateMinimum, maybeSetMacUpdateMinimum, main };
