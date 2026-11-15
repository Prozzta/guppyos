'use strict';
require('./tools/own-job.cjs');

// Run the real Electron 45 Node runtime: Node 22+ on Windows can otherwise
// retain a deleted-directory fs.watch handle and consume a full CPU core.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const root = path.join(__dirname, '..');
const electron = process.platform === 'win32'
  ? path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  : path.join(root, 'node_modules', 'electron', 'dist', 'electron');

test('Electron-as-Node closes a deleted watched agent directory before it can spin', { skip: !fs.existsSync(electron) && 'Electron not installed' }, (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'electron45-safe-watch-'));
  const child = path.join(fixture, 'child.cjs');
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.writeFileSync(child, `
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require(${JSON.stringify(path.join(root, 'test', 'load-ts.cjs'))});
const { watchDirectorySafely } = loadTs(${JSON.stringify(path.join(root, 'src', 'main', 'safeDirectoryWatch.ts'))});
const agents = fs.mkdtempSync(path.join(os.tmpdir(), 'electron45-agent-'));
const agent = path.join(agents, 'agents', 'archived-agent');
fs.mkdirSync(path.join(agent, 'outbox'), { recursive: true });
let closed = false;
let selfClosed = 0;
const watcher = watchDirectorySafely(agent, () => {}, () => { selfClosed++; });
watcher.on('close', () => { closed = true; });
// The owner's own close is not a self-close (its owner already knows).
const other = path.join(agents, 'other');
fs.mkdirSync(other);
let ownerSelfClosed = 0;
watchDirectorySafely(other, () => {}, () => { ownerSelfClosed++; }).close();
const cpu0 = process.cpuUsage();
fs.rmSync(agent, { recursive: true, force: true });
setTimeout(() => {
  const cpu = process.cpuUsage(cpu0);
  const cpuMs = (cpu.user + cpu.system) / 1000;
  fs.rmSync(agents, { recursive: true, force: true });
  console.log(JSON.stringify({ closed, cpuMs, selfClosed, ownerSelfClosed }));
  process.exit(closed && cpuMs < 250 ? 0 : 1);
}, 500);
`);
  const run = spawnSync(electron, [child], {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8', windowsHide: true, timeout: 10_000
  });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  const report = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1));
  assert.equal(report.closed, true, 'the directory watcher closed after agent archive');
  assert.ok(report.cpuMs < 250, `CPU after delete must be idle, got ${report.cpuMs}ms`);
  // E45-INT-REGRESSIONS item 6: the owner hears of the self-close once (so it can watch the folder
  // again when it comes back), and not of its own close.
  assert.equal(report.selfClosed, 1, 'the owner is told once that the watcher closed itself');
  assert.equal(report.ownerSelfClosed, 0, 'an owner close is not reported back');
});

test('owners that keep watch state drop it on a self-close (config, hive authority)', () => {
  const config = fs.readFileSync(path.join(root, 'src', 'main', 'config.ts'), 'utf8');
  assert.match(config, /\}, \(\) => \{ if \(configWatcher === mine\) configWatcher = null; \}\);/);
  const hive = fs.readFileSync(path.join(root, 'src', 'main', 'hive.ts'), 'utf8');
  assert.match(hive, /\}, \(\) => \{ if \(this\.authorityWatchers\.get\(dir\) === w\) this\.authorityWatchers\.delete\(dir\); \}\);/);
});
