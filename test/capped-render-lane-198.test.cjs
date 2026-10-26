'use strict';
// MUTANT-JOURNAL-GATE (god 5cc045/ed8032): this suite loads a file a census mutates in place (one load-ts never sees);
// refuse a tree a killed census left mutated, before anything is read.
require('./tools/mutant-runner-helper.cjs').gate(__filename);

// HALFCORES-OVERSUBSCRIBE: a hard-capped job accounts the whole Electron tree.
// The render lane must follow what a test launches, not a stale filename list.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const R = require('./tools/run-tests.cjs');

test('cap render lane derives Electron files from the harness import, not their filenames', () => {
  const reads = [];
  const files = ['renamed.test.cjs', 'tes-custom.test.cjs', 'plain.test.cjs'];
  const source = {
    'renamed.test.cjs': "const { runScenario } = require('./electron-harness/run.cjs');",
    'tes-custom.test.cjs': "import { runScenario } from './electron-harness/run.cjs';",
    'plain.test.cjs': "const x = 'electron-harness/run.cjs';"
  };
  const got = R.renderLaneFiles(files, { testDir: 'test', readSource: (p) => { reads.push(p); return source[p.slice(p.lastIndexOf('\\') + 1)] || source[p.slice(p.lastIndexOf('/') + 1)]; } });
  assert.deepEqual(got, ['renamed.test.cjs', 'tes-custom.test.cjs']);
  assert.equal(reads.length, files.length, 'every candidate is classified from its actual launch source');
});

test('cap render lane runs ordinary files first, then the Electron harness serially; cap-off stays one byte-compatible burst', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guppy-render-lane-'));
  try {
    fs.writeFileSync(path.join(dir, 'ordinary.test.cjs'), "'use strict';\n");
    fs.writeFileSync(path.join(dir, 'renamed-render.test.cjs'), "const { runScenario } = require('./electron-harness/run.cjs');\n");
    const capped = [];
    const common = {
      testDir: dir, cwd: dir, readdir: () => ['ordinary.test.cjs', 'renamed-render.test.cjs'],
      spawn: (args) => { capped.push(args); return { status: 0 }; },
      log: () => {}, err: () => {}, readFile: () => '', removeFile: () => {},
      startGate: () => null, tempJail: () => null, cores: 32, jobRate: () => 5000,
    };
    assert.equal(R.run(common), 0);
    assert.equal(capped.length, 2, 'the capped lane is exclusive: one node invocation per lane');
    assert.deepEqual(capped[0].filter((a) => a.endsWith('.test.cjs')).map((file) => path.basename(file)), ['ordinary.test.cjs']);
    assert.ok(capped[0].includes('--test-concurrency=16'), 'ordinary cap lane retains its half-core concurrency');
    assert.deepEqual(capped[1].filter((a) => a.endsWith('.test.cjs')).map((file) => path.basename(file)), ['renamed-render.test.cjs']);
    assert.ok(capped[1].includes('--test-concurrency=1'), 'Electron harness lane is serial');

    const open = [];
    assert.equal(R.run({ ...common, spawn: (args) => { open.push(args); return { status: 0 }; }, jobRate: () => 0 }), 0);
    assert.equal(open.length, 1, 'cap-off retains the pre-lane single invocation');
    assert.deepEqual(open[0].filter((a) => a.endsWith('.test.cjs')).map((file) => path.basename(file)), ['ordinary.test.cjs', 'renamed-render.test.cjs']);
    assert.ok(!open[0].some((a) => a.startsWith('--test-concurrency=')), 'cap-off remains at Node default concurrency');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
