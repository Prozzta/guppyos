'use strict';
// HALFCORES-OVERSUBSCRIBE: the rate-to-worker contract must kill a mutant that ignores self-query.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..', '..');
const { recover, mutateFile, restoreFile, checkAnchors, runTests, verdict, requireBaseline } = require('./mutant-runner-helper.cjs');
recover(root);
if (process.argv.includes('--recover-only')) process.exit(0);
const file = path.join(root, 'test', 'tools', 'run-tests.cjs');
const test = 'test/test-runner-glob.test.cjs';
const original = fs.readFileSync(file, 'utf8');
const from = 'try { rateNow = jobRate({ env }); }';
if (original.indexOf(from) < 0 || original.indexOf(from) !== original.lastIndexOf(from)) throw new Error('mutant anchor missing or ambiguous');
checkAnchors(root, [{ name: 'self-query ignored', file, from }]);
const run = () => runTests(root, [test], { timeout: 0, args: ['--test-name-pattern', 'self-queried hard-capped'] });
requireBaseline(run(), `${test} (self-queried hard-capped)`);
try {
  mutateFile(root, file, original, original.replace(from, 'try { rateNow = 0; }'));
  const r = run();
  const v = verdict(r, /not ok \d+ - a self-queried hard-capped heavy job/);
  if (v !== 'KILLED') throw new Error(`self-query-ignore mutant: ${v}${v === 'NO-RESULT' ? ` (${r.why})` : ''}`);
  console.log('KILLED self-query ignored');
} finally { restoreFile(root, file, original); }
