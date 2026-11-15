'use strict';
require('./tools/own-job.cjs');

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

test.after(() => { require('./load-ts.cjs').closeConfigWatchers(); fs.rmSync(userData, { recursive: true, force: true }); });

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

// GUPPY-NODE-LTS: on Node 22+ (libuv 1.51+, Windows) an fs.watch whose folder is deleted never
// emits 'error' and spins the event loop at 100% CPU for ever, so the process never exits. The
// config watcher must close itself when its folder is gone, and closeConfigWatcher() must close it.
// Each case runs in its own process (the spin would take this one with it), bounded by a timeout;
// exit 4 = the child never had a live config watcher, so the case would prove nothing.
function configChild(body) {
  const { spawnSync } = require('node:child_process');
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'md-config-watch-'));
  const src = [
    "const fs = require('node:fs');",
    `const ud = ${JSON.stringify(ud)};`,
    // Records every fs.watch config.ts starts and whether it was closed.
    "const watchers = []; const realWatch = fs.watch;",
    "fs.watch = (...a) => { const w = realWatch(...a); const rec = { closed: false }; const c = w.close.bind(w); w.close = () => { rec.closed = true; return c(); }; watchers.push(rec); return w; };",
    "const electron = require.resolve('electron');",
    "require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { app: { getPath: () => ud } } };",
    `const cfg = require(${JSON.stringify(path.join(__dirname, 'load-ts.cjs'))})('src/main/config.ts');`,
    "cfg.writeConfig({ onboardingComplete: true });",
    // The watcher starts on a read of an existing config.json (readConfig), not on the write.
    "if (cfg.readConfig().onboardingComplete !== true) throw new Error('config not read');",
    'if (watchers.length !== 1 || watchers[0].closed) { console.error("no live config watcher", watchers.length); process.exit(4); }',
    body,
    // Long enough for the deletion to reach the watcher; then nothing else holds the process.
    "setTimeout(() => {}, 700);",
  ].join('\n');
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['-e', src], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', windowsHide: true, timeout: 20_000, killSignal: 'SIGKILL',
    env: { ...process.env, NODE_OPTIONS: '' } });
  try { fs.rmSync(ud, { recursive: true, force: true }); } catch { /* gone */ }
  return { r, ms: Date.now() - t0, gone: !fs.existsSync(ud) };
}

test('watcher: deleting the config folder closes its watcher, so the process still exits (Node 22+ never reports the error)', () => {
  // After a turn of the loop: a folder deleted in the same tick as the watch never reaches it.
  // First only config.json goes: the folder is still there, so the watcher must stay (exit 6).
  // Then the folder goes; once it is back, the next read must start a NEW watcher (exit 5): a
  // self-close that leaves configWatcher set would leave the folder unwatched for good (Jim J1/J3).
  const { r, ms } = configChild([
    "setTimeout(() => fs.rmSync(require('node:path').join(ud, 'config.json')), 100);",
    'setTimeout(() => { if (watchers[0].closed) { console.error("MUTANT: deleting config.json alone closed the watcher"); process.exit(6); } fs.rmSync(ud, { recursive: true, force: true }); }, 200);',
    'setTimeout(() => { fs.mkdirSync(ud, { recursive: true }); cfg.writeConfig({ onboardingComplete: true }); cfg.__resetConfigCacheForTests(); cfg.readConfig();',
    '  if (!watchers[0].closed || watchers.length !== 2 || watchers[1].closed) { console.error("MUTANT: no new watcher after the folder came back", watchers.length); process.exit(5); } }, 400);',
  ].join('\n'));
  assert.notEqual((r.error && r.error.code), 'ETIMEDOUT', `MUTANT: THE PROCESS NEVER EXITED after its config folder was deleted (${ms} ms): the watcher spins`);
  assert.equal(r.status, 0, r.stderr);
});

test('watcher: closeConfigWatcher() closes the live watcher before a delete', () => {
  // The self-close would also save this process, so the child spies fs.watch (config.ts calls it
  // through the module object) and exits 3 unless closeConfigWatcher() itself closed the watcher.
  const { r, ms } = configChild([
    'cfg.closeConfigWatcher();',
    'if (!watchers[0].closed) { console.error("MUTANT: closeConfigWatcher() left the watcher open"); process.exit(3); }',
    // The next read starts a new watcher (Jim J2: a close that keeps configWatcher set never re-watches).
    'cfg.__resetConfigCacheForTests(); cfg.readConfig();',
    'if (watchers.length !== 2 || watchers[1].closed) { console.error("MUTANT: no new watcher after closeConfigWatcher", watchers.length); process.exit(5); }',
    'cfg.closeConfigWatcher();',
    'setTimeout(() => fs.rmSync(ud, { recursive: true, force: true }), 100);',
  ].join(' '));
  assert.notEqual((r.error && r.error.code), 'ETIMEDOUT', `THE PROCESS NEVER EXITED after closeConfigWatcher and the delete (${ms} ms)`);
  assert.notEqual(r.status, 3, r.stderr);
  assert.equal(r.status, 0, r.stderr);
});
