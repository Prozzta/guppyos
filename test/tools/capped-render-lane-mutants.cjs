'use strict';
// HALFCORES-OVERSUBSCRIBE: hand mutants for the cap-only exclusive Electron render lane.
// Run manually (not a *.test.cjs): node test/tools/capped-render-lane-mutants.cjs
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const { recover, mutateFile, restoreFile, checkAnchors } = require('./mutant-runner-helper.cjs');
const { runTests, verdict, requireBaseline } = require('./mutant-tap.cjs');
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
const run = () => runTests(root, [contract], { timeout: 0 });
requireBaseline(run(), 'capped render lane contract');
try {
  for (const mutant of mutants) {
    const hits = original.split(mutant.from).length - 1;
    if (hits !== 1) throw new Error(`mutant anchor ${mutant.name} matched ${hits} times`);
    mutateFile(root, source, original, original.replace(mutant.from, mutant.to));
    const result = run();
    const output = `${result.stdout}\n${result.stderr}`;
    const v = verdict(result, mutant.dies); // NO-RESULT and KILLED ELSEWHERE fail as loudly as a survivor
    if (v !== 'KILLED') throw new Error(`${v} ${mutant.name}: ${v === 'NO-RESULT' ? `${result.why}\n` : ''}${output}`);
    console.log(`KILLED ${mutant.name}`);
    restoreFile(root, source, original);
  }
} finally {
  restoreFile(root, source, original);
}
