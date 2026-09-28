'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-config-integrity-'));
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: { app: { getPath: () => userData } }
};
const { readConfig, writeConfig, resetConfig, configIntegrityIssue } = loadTs('src/main/config.ts');
const file = path.join(userData, 'config.json');

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

test('missing config.json is a first run, not an integrity failure', () => {
  assert.equal(fs.existsSync(file), false);
  assert.equal(readConfig().onboardingComplete, false);
  assert.equal(configIntegrityIssue(), null);
  writeConfig({ onboardingComplete: true });
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).onboardingComplete, true);
});

test('corrupt config is quarantined, shown, and never overwritten by write or reset', () => {
  const corrupt = '{"harnessHome":';
  fs.writeFileSync(file, corrupt, 'utf8');
  assert.equal(readConfig().onboardingComplete, false, 'read-only startup receives safe defaults');
  const issue = configIntegrityIssue();
  assert.equal(issue.file, 'config.json');
  assert.match(issue.quarantine, /^config\.json\.corrupt-/);
  assert.equal(fs.readFileSync(file, 'utf8'), corrupt);
  assert.throws(() => writeConfig({ onboardingComplete: true }), /refusing to overwrite it/);
  assert.throws(() => resetConfig(), /refusing to overwrite it/);
  assert.equal(fs.readFileSync(file, 'utf8'), corrupt);
  assert.equal(fs.readFileSync(path.join(userData, issue.quarantine), 'utf8'), corrupt);
});

test('config atomic publish retries a transient Windows rename lock', () => {
  fs.writeFileSync(file, JSON.stringify({ onboardingComplete: false, triggersMigratedV1: true, defaultModelCliMigratedV1: true }), 'utf8');
  const renameSync = fs.renameSync;
  let attempts = 0;
  fs.renameSync = (...args) => {
    attempts++;
    if (attempts < 3) {
      const error = new Error('simulated sharing violation');
      error.code = 'EBUSY';
      throw error;
    }
    return renameSync(...args);
  };
  try {
    writeConfig({ onboardingComplete: true });
  } finally {
    fs.renameSync = renameSync;
  }
  assert.equal(attempts, 3);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).onboardingComplete, true);
  assert.equal(fs.readdirSync(userData).some((name) => name.startsWith('config.json.tmp-')), false);
});
