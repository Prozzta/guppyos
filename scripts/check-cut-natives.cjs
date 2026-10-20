#!/usr/bin/env node
'use strict';

// Run against the unpacked modules with the packaged Electron binary.  This is
// deliberately a separate process: a successful builder exit is not evidence
// that Electron can load the ABI-specific native addons it just shipped.
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const [electron, modules] = process.argv.slice(2);
if (!electron || !modules) {
  console.error('usage: check-cut-natives.cjs <electron.exe> <unpacked node_modules>');
  process.exit(2);
}
const probe = [
  `const pty = require(${JSON.stringify(path.join(modules, 'node-pty'))});`,
  `const Database = require(${JSON.stringify(path.join(modules, 'better-sqlite3'))});`,
  "if (typeof pty.spawn !== 'function') throw new Error('node-pty did not load');",
  "const db = new Database(':memory:');",
  "if (db.prepare('select 42 as n').get().n !== 42) throw new Error('better-sqlite3 query failed');",
  "db.close(); console.log('CUT NATIVES OK: node-pty + better-sqlite3');"
].join('\n');
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
delete env.NoDefaultCurrentDirectoryInExePath;
const r = spawnSync(electron, ['-e', probe], { encoding: 'utf8', env, windowsHide: true });
if (r.error || r.status !== 0 || !r.stdout.includes('CUT NATIVES OK')) {
  console.error('CUT NATIVES FAILED');
  if (r.error) console.error(r.error.message);
  if (r.stdout) process.stderr.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.status || 1);
}
process.stdout.write(r.stdout);
