'use strict';

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
const watcher = watchDirectorySafely(agent, () => {});
watcher.on('close', () => { closed = true; });
const cpu0 = process.cpuUsage();
fs.rmSync(agent, { recursive: true, force: true });
setTimeout(() => {
  const cpu = process.cpuUsage(cpu0);
  const cpuMs = (cpu.user + cpu.system) / 1000;
  console.log(JSON.stringify({ closed, cpuMs }));
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
});
