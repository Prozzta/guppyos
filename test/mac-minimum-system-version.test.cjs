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
const floor = require('../build/macUpdateFloor.cjs');
const dist = require('../scripts/dist.cjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guppy-macos-floor-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('macOS 13 is the packaged app floor and Darwin 22 is the update-feed floor', async () => {
  const builder = read('electron-builder.yml');
  assert.match(builder, /^mac:\n[\s\S]*?^  minimumSystemVersion: "13\.0"$/m);
  assert.match(read('README.md'), /macOS 13\s*\n?\s*\(Ventura\) or newer/);
  assert.match(read('CONTRIBUTING.md'), /macOS 13 \(Ventura\) or newer/);
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts.dist, 'npm run build && node scripts/dist.cjs');
  assert.equal(pkg.scripts['dist:mac'], 'npm run build && electron-builder --mac && node build/macUpdateFloor.cjs dist/latest-mac.yml');
  const releaseWorkflow = read('.github/workflows/release.yml');
  assert.match(releaseWorkflow, /name: Set macOS update floor\n\s+if: contains\(matrix\.args, '--mac'\) \|\| contains\(matrix\.args, '-m'\)\n\s+run: node build\/macUpdateFloor\.cjs dist\/latest-mac\.yml/);

  const metadata = path.join(tmp, 'latest-mac.yml');
  fs.writeFileSync(metadata, 'version: 1.1.105\nminimumSystemVersion: 13.0\npath: Guppy.zip\n');
  floor.main([metadata]);
  assert.match(fs.readFileSync(metadata, 'utf8'), /^minimumSystemVersion: 22\.0\.0$/m);

  // electron-updater compares this metadata to os.release() with semver. Monterey
  // is Darwin 21, so it must be refused; Ventura starts at Darwin 22.
  assert.equal(semver.lt('21.6.0', floor.MAC_UPDATE_MINIMUM_SYSTEM_VERSION), true);
  assert.equal(semver.lt('22.0.0', floor.MAC_UPDATE_MINIMUM_SYSTEM_VERSION), false);
  const updater = read('node_modules/electron-updater/out/AppUpdater.js');
  assert.match(updater, /const currentOSVersion = \(0, os_1\.release\)\(\);/);
  assert.match(updater, /semver_1\.lt\)\(currentOSVersion, minimumSystemVersion\)/);
});

test('post-build floor rewrite only accepts the generated mac update feed', () => {
  const mac = path.join(tmp, 'latest-mac.yml');
  const windows = path.join(tmp, 'latest.yml');
  fs.writeFileSync(mac, 'version: 1.1.105\n');
  fs.writeFileSync(windows, 'version: 1.1.105\n');
  floor.main([mac]);
  assert.match(fs.readFileSync(mac, 'utf8'), /^minimumSystemVersion: 22\.0\.0$/m);
  assert.throws(() => floor.main([windows]), /expected latest-mac\.yml/);
  assert.doesNotMatch(fs.readFileSync(windows, 'utf8'), /minimumSystemVersion/);
  assert.equal(floor.main(['--when-darwin', mac], 'win32'), false);
  assert.equal(floor.main(['--when-darwin', mac], 'darwin'), true);
});

test('dist forwards npm arguments to electron-builder before enforcing a requested mac floor', () => {
  const calls = [];
  const floors = [];
  const spawn = (command, args, options) => { calls.push({ command, args, options }); return { status: 0 }; };
  assert.equal(dist.run(['--win'], { spawn, platform: 'win32', cli: 'builder-cli', floor: (file) => floors.push(file) }), 0);
  assert.deepEqual(calls[0].args, ['builder-cli', '--win']);
  assert.deepEqual(floors, []);
  assert.equal(dist.run(['-m'], { spawn, platform: 'linux', cli: 'builder-cli', floor: (file) => floors.push(file) }), 0);
  assert.equal(floors.length, 1, 'a cross-platform mac target still needs a feed floor');
  assert.equal(dist.requestsMac([], 'darwin'), true);
  assert.equal(dist.requestsMac(['--linux'], 'darwin'), false);
  assert.equal(dist.requestsMac(['-mwl'], 'linux'), true);
});
