'use strict';
require('./tools/own-job.cjs');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const cut = fs.readFileSync(path.join(ROOT, 'scripts', 'cut-cmd-natives.cjs'), 'utf8');
const check = fs.readFileSync(path.join(ROOT, 'scripts', 'check-cut-natives.cjs'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

test('cut command scrubs cwd-search hardening for literal npm ci and the raw Windows build', () => {
  assert.match(cut, /key\.toLowerCase\(\) === 'nodefaultcurrentdirectoryinexepath'/);
  assert.match(cut, /run\(npm, \['ci'\]\)/);
  assert.equal(pkg.scripts['cut:win'], 'node scripts/cut-cmd-natives.cjs');
  assert.equal(pkg.scripts['dist:win'], 'node scripts/cut-cmd-natives.cjs --dist-only');
  assert.match(pkg.scripts['dist:win:raw'], /electron-builder --win/);
  assert.match(cut, /--install-only/);
  assert.match(cut, /shell: command === npm && process\.platform === 'win32'/);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'cut-cmd-natives.cjs'), '--print-plan'], {
    encoding: 'utf8', env: { ...process.env, nOdEfAuLtCuRrEnTdIrEcToRyInExEpAtH: '1' }
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { npmCi: ['ci'], inheritedNoDefaultCurrentDirectoryInExePath: false });
  assert.match(cut, /release-markers\.cjs/);
});

test('post-cut probe runs Electron as Node and loads both native modules', () => {
  assert.match(check, /ELECTRON_RUN_AS_NODE: '1'/);
  assert.match(check, /node-pty/);
  assert.match(check, /better-sqlite3/);
  assert.match(check, /select 42 as n/);
  assert.match(check, /const modulesPath = path\.resolve\(modules\)/);
  assert.match(check, /path\.dirname\(path\.dirname\(modulesPath\)\)/);
  assert.match(check, /deleteEnvCaseInsensitive\(env, 'NODE_PATH'\)/);
  assert.match(check, /deleteEnvCaseInsensitive\(env, 'NODE_OPTIONS'\)/);
  assert.match(cut, /check-cut-natives\.cjs/);
});

test('packaged probe rejects a missing archive dependency despite inherited NODE_PATH', () => {
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'cut-native-'));
  try {
    const resources = path.join(tmp, 'resources');
    const modules = path.join(resources, 'app.asar.unpacked', 'node_modules');
    const archive = path.join(resources, 'app.asar', 'node_modules');
    const dev = path.join(tmp, 'dev-node-path');
    write(path.join(archive, 'node-pty', 'index.js'), 'module.exports = { spawn() {} };');
    write(path.join(archive, 'better-sqlite3', 'index.js'), "require('missing-cut-dependency'); module.exports = class { prepare() { return { get() { return { n: 42 }; } }; } close() {} };");
    write(path.join(dev, 'missing-cut-dependency', 'index.js'), 'module.exports = {};');
    fs.mkdirSync(modules, { recursive: true });
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-cut-natives.cjs'), process.execPath, modules], {
      encoding: 'utf8', env: { ...process.env, nOdE_pAtH: dev }
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /CUT NATIVES FAILED/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
