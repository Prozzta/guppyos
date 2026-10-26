'use strict';
// HALFCORES-OVERSUBSCRIBE: the rate-to-worker contract must kill a mutant that ignores self-query.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..', '..');
const { recover, mutateFile, restoreFile, checkAnchors } = require('./mutant-runner-helper.cjs');
recover(root);
if (process.argv.includes('--recover-only')) process.exit(0);
const file = path.join(root, 'test', 'tools', 'run-tests.cjs');
const test = 'test/test-runner-glob.test.cjs';
const original = fs.readFileSync(file, 'utf8');
const from = 'try { rateNow = jobRate({ env }); }';
if (original.indexOf(from) < 0 || original.indexOf(from) !== original.lastIndexOf(from)) throw new Error('mutant anchor missing or ambiguous');
checkAnchors(root, [{ name: 'self-query ignored', file, from }]);
const run = () => spawnSync(process.execPath, ['--test', '--test-name-pattern', 'self-queried hard-capped', test], { cwd: root, encoding: 'utf8', windowsHide: true });
if (run().status !== 0) throw new Error('baseline red');
try {
  mutateFile(root, file, original, original.replace(from, 'try { rateNow = 0; }'));
  const r = run();
  if (r.status === 0 || !/not ok \d+ - a self-queried hard-capped heavy job/.test(`${r.stdout}\n${r.stderr}`)) throw new Error('self-query-ignore mutant survived or died elsewhere');
  console.log('KILLED self-query ignored');
} finally { restoreFile(root, file, original); }
