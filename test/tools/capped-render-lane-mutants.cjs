'use strict';
// HALFCORES-OVERSUBSCRIBE: hand mutants for the cap-only exclusive Electron render lane.
// Run manually (not a *.test.cjs): node test/tools/capped-render-lane-mutants.cjs
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');
const { recover, mutateFile, restoreFile, checkAnchors } = require('./mutant-runner-helper.cjs');
recover(root);
if (process.argv.includes('--recover-only')) process.exit(0);
const source = path.join(root, 'test', 'tools', 'run-tests.cjs');
const contract = 'test/capped-render-lane-198.test.cjs';
const original = fs.readFileSync(source, 'utf8');
const mutants = [
  {
    name: 'cap-off-classifies-render-files',
    from: 'const renderFiles = rateNow > 0 ? renderLaneFiles(files, { testDir }) : [];',
    to: 'const renderFiles = renderLaneFiles(files, { testDir });',
    dies: /cap-off retains the pre-lane single invocation/
  },
  {
    name: 'render-lane-is-not-serial',
    // The perf lane is serial too (run-tests.cjs line ~471): anchor on the render lane's label.
    from: "label: 'render lane: ', extraArgs: ['--test-concurrency=1']",
    to: "label: 'render lane: ', extraArgs: []",
    dies: /Electron harness lane is serial/
  }
];
checkAnchors(root, mutants.map(({ name, from }) => ({ name, file: source, from })));
const run = () => spawnSync(process.execPath, ['--test', contract], { cwd: root, encoding: 'utf8', windowsHide: true });
if (run().status !== 0) throw new Error('BASELINE RED: capped render lane contract must pass before mutation');
try {
  for (const mutant of mutants) {
    const hits = original.split(mutant.from).length - 1;
    if (hits !== 1) throw new Error(`mutant anchor ${mutant.name} matched ${hits} times`);
    mutateFile(root, source, original, original.replace(mutant.from, mutant.to));
    const result = run();
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.status === 0 || !mutant.dies.test(output)) throw new Error(`SURVIVED ${mutant.name}: ${output}`);
    console.log(`KILLED ${mutant.name}`);
    restoreFile(root, source, original);
  }
} finally {
  restoreFile(root, source, original);
}
