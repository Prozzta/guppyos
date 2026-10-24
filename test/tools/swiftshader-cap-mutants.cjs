'use strict';
// HALFCORES-OVERSUBSCRIBE: deleting the capped view must make its unit test fail.
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.join(__dirname, '..', '..');
const source = path.join(root, 'test', 'electron-harness', 'electron-bin.cjs');
const original = fs.readFileSync(source, 'utf8');
const from = 'return limit === null ? half : (limit & half) || limit;';
if (original.indexOf(from) < 0 || original.indexOf(from) !== original.lastIndexOf(from)) throw new Error('capped-view mutant anchor missing or ambiguous');
try {
  fs.writeFileSync(source, original.replace(from, 'return null;'));
  const r = spawnSync(process.execPath, ['--test', 'test/electron-view-self-heal-198.test.cjs'], { cwd: root, encoding: 'utf8', windowsHide: true });
  const output = `${r.stdout}\n${r.stderr}`;
  if (r.status === 0 || !/every job uses a bounded SwiftShader view|four processors in the capped view/.test(output)) throw new Error(`SURVIVED delete-capped-view: ${output}`);
  console.log('KILLED delete-capped-view');
} finally { fs.writeFileSync(source, original); }
