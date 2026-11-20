'use strict';
require('./tools/own-job.cjs');
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Module = require('node:module');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const cut = fs.readFileSync(path.join(ROOT, 'scripts', 'cut-cmd-natives.cjs'), 'utf8');
const check = fs.readFileSync(path.join(ROOT, 'scripts', 'check-cut-natives.cjs'), 'utf8');
const fsHandleContract = require('../scripts/check-cut-natives.cjs');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

test('cut command scrubs cwd-search hardening and provisions the pinned model before each Windows build', () => {
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
  assert.deepEqual(JSON.parse(r.stdout), {
    npmCi: ['ci'],
    modelProvision: [path.join('scripts', 'fetch-memory-model.cjs')],
    inheritedNoDefaultCurrentDirectoryInExePath: false
  });
  const provision = "run(process.execPath, [path.join('scripts', 'fetch-memory-model.cjs')]);";
  const rawBuild = "run(npm, ['run', 'dist:win:raw']);";
  assert.equal((cut.match(new RegExp(provision.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length, 1);
  assert.ok(cut.indexOf(provision) < cut.indexOf(rawBuild));
  assert.match(cut, /--dist-only'\)\) \{\s+provisionModel\(\);\s+run\(npm, \['run', 'dist:win:raw'\]\);/);
  assert.match(cut, /run\(npm, \['ci'\]\);\s+provisionModel\(\);\s+run\(npm, \['run', 'dist:win:raw'\]\);/);
  assert.match(cut, /release-markers\.cjs/);
});

test('model provision rejects a wrong-digest cache without changing the manifest bytes', () => {
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'model-digest-'));
  try {
    const script = path.join(tmp, 'scripts', 'fetch-memory-model.cjs');
    const manifestFile = path.join(tmp, 'resources', 'models', 'native-memory-manifest.json');
    const cache = path.join(tmp, 'cache');
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'resources', 'models', 'native-memory-manifest.json'), 'utf8'));
    const [rel] = Object.keys(manifest.model.files);
    write(script, fs.readFileSync(path.join(ROOT, 'scripts', 'fetch-memory-model.cjs')));
    write(manifestFile, JSON.stringify(manifest));
    write(path.join(cache, ...rel.split('/')), 'wrong cached model bytes');
    const before = fs.readFileSync(manifestFile);
    const r = spawnSync(process.execPath, [script], {
      encoding: 'utf8', env: { ...process.env, MUNDER_MODEL_CACHE: cache }
    });
    assert.notEqual(r.status, 0, 'a wrong-digest cache must fail provisioning');
    assert.match(r.stderr, /SHA-256/);
    assert.deepEqual(fs.readFileSync(manifestFile), before, 'provisioning must not rewrite the manifest');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('post-cut probe runs Electron as Node and loads both native modules', () => {
  assert.match(check, /ELECTRON_RUN_AS_NODE: '1'/);
  assert.match(check, /node-pty/);
  assert.match(check, /better-sqlite3/);
  assert.match(check, /CUT FS-HANDLE MISSING EXPORTS/);
  assert.match(check, /posixRenameAsync/);
  assert.match(check, /select 42 as n/);
  assert.match(check, /const modulesPath = path\.resolve\(modules\)/);
  assert.match(check, /path\.dirname\(path\.dirname\(modulesPath\)\)/);
  assert.match(check, /deleteEnvCaseInsensitive\(env, 'NODE_PATH'\)/);
  assert.match(check, /deleteEnvCaseInsensitive\(env, 'NODE_OPTIONS'\)/);
  assert.match(cut, /check-cut-natives\.cjs/);
});

function runPackagedProbe(contract, addonExports, { inheritedEnv = {}, missingArchiveDependency = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'cut-native-'));
  try {
    const resources = path.join(tmp, 'resources');
    const modules = path.join(resources, 'app.asar.unpacked', 'node_modules');
    const archive = path.join(resources, 'app.asar', 'node_modules');
    const dev = path.join(tmp, 'dev-node-path');
    write(path.join(archive, 'node-pty', 'index.js'), 'module.exports = { spawn() {} };');
    write(path.join(archive, 'better-sqlite3', 'index.js'), `${missingArchiveDependency ? "require('missing-cut-dependency'); " : ''}module.exports = class { prepare() { return { get() { return { n: 42 }; } }; } close() {} };`);
    write(path.join(dev, 'missing-cut-dependency', 'index.js'), 'module.exports = {};');
    fs.mkdirSync(modules, { recursive: true });
    const addonPaths = [];
    let invoked;
    let result;
    const spawn = (_electron, args, options) => {
      invoked = { args, options };
      const requireFromArchive = (id) => {
        if (id === path.join(archive, 'node-pty')) return { spawn() {} };
        if (id === path.join(archive, 'better-sqlite3')) {
          const module = { exports: {} };
          vm.runInNewContext(fs.readFileSync(path.join(id, 'index.js'), 'utf8'), { module, exports: module.exports, require: requireFromArchive });
          return module.exports;
        }
        if (id === 'missing-cut-dependency') {
          if (Object.keys(options.env).some((key) => key.toLowerCase() === 'node_path')) return {};
          throw new Error("Cannot find module 'missing-cut-dependency'");
        }
        throw new Error(`unexpected packaged require: ${id}`);
      };
      let stdout = '';
      try {
        vm.runInNewContext(args[1], {
          process: { dlopen(holder, addonPath) { addonPaths.push(addonPath); holder.exports = addonExports; } },
          require: requireFromArchive,
          console: { log(line) { stdout += `${line}\n`; } }
        });
        result = { status: 0, stdout, stderr: '' };
      } catch (error) {
        result = { status: 1, stdout, stderr: `${error.message}\n` };
      }
      return result;
    };
    const status = contract.main(process.execPath, modules, { spawn, env: inheritedEnv });
    return { status, invoked, addonPaths, result };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function assertPackagedProbeContract(contract) {
  const v107 = { finalPath() {}, procOpen() {}, procAlive() {}, procClose() {}, procAdopt() {} };
  const current = Object.fromEntries(contract.FS_HANDLE_REQUIRED_EXPORTS.map((name) => [name, () => {}]));
  // MIRROR-PARSE-ZERO-108 added threadCpuMs to the required list, so the 1.1.107 addon now lacks three.
  // v108pre is the addon as it was just before that (both renames, no thread clock): it pins the new
  // export alone, the way v107 pins the two renames.
  const v108pre = { ...v107, posixRename() {}, posixRenameAsync() {} };
  assert.deepEqual(contract.missingFsHandleExports(v107), ['posixRename', 'posixRenameAsync', 'threadCpuMs']);
  assert.deepEqual(contract.missingFsHandleExports(v108pre), ['threadCpuMs']);
  assert.deepEqual(contract.missingFsHandleExports(current), []);

  const oldProbe = runPackagedProbe(contract, v107);
  assert.equal(oldProbe.status, 1);
  assert.match(oldProbe.invoked.options.env.ELECTRON_RUN_AS_NODE, /1/);
  assert.match(oldProbe.invoked.args[1], /process\.dlopen/);
  assert.equal(oldProbe.addonPaths.length, 1);
  assert.match(oldProbe.result.stderr, /CUT FS-HANDLE MISSING EXPORTS: posixRename, posixRenameAsync, threadCpuMs\n/);

  const preProbe = runPackagedProbe(contract, v108pre);
  assert.equal(preProbe.status, 1, 'a cut carrying the addon from before the thread clock fails');
  assert.match(preProbe.result.stderr, /CUT FS-HANDLE MISSING EXPORTS: threadCpuMs\n/);

  const currentProbe = runPackagedProbe(contract, current);
  assert.equal(currentProbe.status, 0);
  assert.equal(currentProbe.addonPaths.length, 1);

  const probe = runPackagedProbe(contract, current, {
    inheritedEnv: { nOdE_pAtH: 'would-mask-missing-cut-dependency' },
    missingArchiveDependency: true
  });
  assert.equal(probe.status, 1);
  assert.doesNotMatch(Object.keys(probe.invoked.options.env).join(','), /node_path/i);
  assert.match(probe.result.stderr, /missing-cut-dependency/);
  assert.equal(probe.addonPaths.length, 1);
}

test('packaged probe rejects the 1.1.107 fs-handle exports and accepts the current addon', () => {
  assertPackagedProbeContract(fsHandleContract);
});

function mutatedProbeContract(needle, replacement) {
  assert.ok(check.includes(needle), `mutation target not found: ${needle}`);
  const mutant = new Module(path.join(ROOT, 'scripts', 'check-cut-natives-mutant.cjs'), module);
  mutant.filename = path.join(ROOT, 'scripts', 'check-cut-natives-mutant.cjs');
  mutant.paths = Module._nodeModulePaths(ROOT);
  mutant._compile(check.replace(needle, replacement), mutant.filename);
  return mutant.exports;
}

test('N, T, F, and D mutations each fail the packaged probe contract', () => {
  const mutants = [
    ['N', "deleteEnvCaseInsensitive(env, 'NODE_PATH');", "deleteEnvCaseInsensitive(env, 'NODE_PATH_MUTANT');"],
    ['T', 'if (fsHandleMissing.length)', 'if (false && fsHandleMissing.length)'],
    ['F', 'JSON.stringify(FS_HANDLE_REQUIRED_EXPORTS)', 'JSON.stringify([])'],
    ['D', 'process.dlopen(fsHandle, ${JSON.stringify(fsHandleAddon)});', 'void fsHandle;']
  ];
  for (const [name, needle, replacement] of mutants) {
    assert.throws(() => assertPackagedProbeContract(mutatedProbeContract(needle, replacement)), assert.AssertionError, `${name} mutant must fail`);
  }
});
