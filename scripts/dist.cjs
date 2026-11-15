'use strict';

// Keep npm run dist argument forwarding intact.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { setMacUpdateMinimum } = require('../build/macUpdateFloor.cjs');

const root = path.join(__dirname, '..');

function requestsMac(args, platform = process.platform) {
  const hasMac = args.some((arg) => /^(?:--mac(?:os)?|-m)(?:=|$)/.test(arg) || (/^-[mwl]+$/.test(arg) && arg.includes('m')));
  if (hasMac) return true;
  const hasExplicitPlatform = args.some((arg) => /^(?:--(?:mac(?:os)?|win|linux)|-[mwl])(?:=|$)/.test(arg) || /^-[mwl]+$/.test(arg));
  return !hasExplicitPlatform && platform === 'darwin';
}

function run(args = process.argv.slice(2), options = {}) {
  const spawn = options.spawn || spawnSync;
  const platform = options.platform || process.platform;
  const cli = options.cli || require.resolve('electron-builder/cli.js');
  const floor = options.floor || setMacUpdateMinimum;
  const result = spawn(process.execPath, [cli, ...args], { cwd: root, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) return result.status ?? 1;
  if (requestsMac(args, platform)) floor(path.join(root, 'dist', 'latest-mac.yml'));
  return 0;
}

if (require.main === module) {
  try { process.exitCode = run(); }
  catch (error) { console.error(error.stack || error.message); process.exitCode = 1; }
}

module.exports = { requestsMac, run };
