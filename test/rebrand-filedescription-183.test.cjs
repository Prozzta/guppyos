'use strict';
// REBRAND-FILEDESCRIPTION (1.1.83): Task Manager names a Windows process by its exe's
// FileDescription. electron-builder writes it from the package "description"
// (app-builder-lib winPackager.signAndEditResources: `appInfo.description || appInfo.productName`;
// the setup exe gets the same in NsisTarget), so 1.1.82's Guppy.exe showed the long tagline.
// electron-builder.yml sets extraMetadata.description, and these pins run the real config through
// electron-builder's own merge and AppInfo, so they follow what the build will stamp.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const { deepAssign } = require('builder-util');
const { AppInfo } = require('app-builder-lib/out/appInfo');

const REPO = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
const config = yaml.load(fs.readFileSync(path.join(REPO, 'electron-builder.yml'), 'utf8'));
/** What packager.js does: the app metadata with config.extraMetadata deep-assigned over it. */
const metadata = deepAssign(JSON.parse(JSON.stringify(pkg)), config.extraMetadata || {});
const appInfo = new AppInfo({ metadata, config });

test('the Windows exe FileDescription (Task Manager name) is Guppy', () => {
  assert.equal(appInfo.description, 'Guppy');
  assert.equal(appInfo.productName, 'Guppy');
});

test('only the description is overridden: the package name and version stay', () => {
  assert.deepEqual(Object.keys(config.extraMetadata), ['description']);
  assert.equal(metadata.name, 'munder-difflin');
  assert.equal(metadata.version, pkg.version);
});

test('the source package.json and the Linux .desktop Comment keep the long description', () => {
  assert.ok(pkg.description.length > 40 && pkg.description !== 'Guppy');
  assert.equal(config.linux.description, pkg.description);
});
