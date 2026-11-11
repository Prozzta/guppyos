'use strict';
require('./tools/own-job.cjs');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const semver = require('semver');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const hook = require('../build/legacyArtifactNames.cjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guppy-macos-floor-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('macOS 13 is the packaged app floor and Darwin 22 is the update-feed floor', async () => {
  const builder = read('electron-builder.yml');
  assert.match(builder, /^mac:\n[\s\S]*?^  minimumSystemVersion: "13\.0"$/m);
  assert.match(read('README.md'), /macOS 13\s*\n?\s*\(Ventura\) or newer/);
  assert.match(read('CONTRIBUTING.md'), /macOS 13 \(Ventura\) or newer/);

  const metadata = path.join(tmp, 'latest-mac.yml');
  fs.writeFileSync(metadata, 'version: 1.1.105\nminimumSystemVersion: 13.0\npath: Guppy.zip\n');
  await hook({ artifactPaths: [metadata] });
  assert.match(fs.readFileSync(metadata, 'utf8'), /^minimumSystemVersion: 22\.0\.0$/m);

  // electron-updater compares this metadata to os.release() with semver. Monterey
  // is Darwin 21, so it must be refused; Ventura starts at Darwin 22.
  assert.equal(semver.lt('21.6.0', hook.MAC_UPDATE_MINIMUM_SYSTEM_VERSION), true);
  assert.equal(semver.lt('22.0.0', hook.MAC_UPDATE_MINIMUM_SYSTEM_VERSION), false);
  const updater = read('node_modules/electron-updater/out/AppUpdater.js');
  assert.match(updater, /const currentOSVersion = \(0, os_1\.release\)\(\);/);
  assert.match(updater, /semver_1\.lt\)\(currentOSVersion, minimumSystemVersion\)/);
});

test('latest-mac metadata gains a Darwin minimum without changing other update feeds', async () => {
  const mac = path.join(tmp, 'latest-mac.yml');
  const windows = path.join(tmp, 'latest.yml');
  fs.writeFileSync(mac, 'version: 1.1.105\n');
  fs.writeFileSync(windows, 'version: 1.1.105\n');
  await hook({ artifactPaths: [mac, windows] });
  assert.match(fs.readFileSync(mac, 'utf8'), /^minimumSystemVersion: 22\.0\.0$/m);
  assert.doesNotMatch(fs.readFileSync(windows, 'utf8'), /minimumSystemVersion/);
});
