'use strict';
require('./tools/own-job.cjs');
// MUTANT-JOURNAL-GATE (god 5cc045/ed8032): this suite loads a file a census mutates in place (one load-ts never sees);
// refuse a tree a killed census left mutated, before anything is read.
require('./tools/mutant-runner-helper.cjs').gate(__filename);
/**
 * BARE-NODE-TEST-NO-OWNER: every test file the runner discovers (and every perf file) requires
 * test/tools/own-job.cjs as its FIRST statement, so a bare `node --test <file>` of it owns a
 * kill-on-close job before any test code (and any spawn) runs. Spawning is transitive (a test that
 * only calls into src/main/hive.ts starts agents), so the rule is every file, not the ones that
 * mention child_process. A new file without the line fails here, with the line to paste.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const R = require('./tools/run-tests.cjs');

const TEST_DIR = __dirname;

/** The first statement of a file: after a BOM, blank lines, comments and 'use strict'. */
function firstStatement(src) {
  let s = src.replace(/^﻿/, '');
  for (;;) {
    s = s.replace(/^\s+/, '');
    if (s.startsWith('//')) { s = s.replace(/^\/\/[^\n]*\n?/, ''); continue; }
    if (s.startsWith('/*')) { const e = s.indexOf('*/'); if (e < 0) return s; s = s.slice(e + 2); continue; }
    if (/^['"]use strict['"];?/.test(s)) { s = s.replace(/^['"]use strict['"];?/, ''); continue; }
    return s.split('\n')[0].trim();
  }
}

/** The require line a file at `rel` (relative to test/) must carry. */
function expectedLine(rel) {
  const toTools = path.relative(path.dirname(path.join(TEST_DIR, rel)), path.join(TEST_DIR, 'tools', 'own-job.cjs')).split(path.sep).join('/');
  return `require('${toTools.startsWith('.') ? toTools : './' + toTools}');`;
}

/**
 * The serial perf lane's files, relative to test/. OWN-JOB-GUARD-PERF-DIR-GAP-108: the lane is
 * test/perf/*.perf.cjs (run-tests.cjs CLAIMS-PERF-LANE lists that folder with PERF_SUFFIX), and
 * this used to list test/ itself, where no perf file lives: the GUARD below covered none of them,
 * and two of the five had no job of their own. A missing or unreadable folder throws here, so the
 * guard can never pass on a lane it did not read.
 */
const PERF_DIR = 'perf';
function perfFiles(dir = path.join(TEST_DIR, PERF_DIR)) {
  return fs.readdirSync(dir).filter((f) => f.endsWith(R.PERF_SUFFIX)).sort().map((f) => path.join(PERF_DIR, f));
}

test('firstStatement: skips a BOM, blank lines, line and block comments and the strict pragma', () => {
  assert.equal(firstStatement("'use strict';\nrequire('./tools/own-job.cjs');\nconst x = 1;\n"), "require('./tools/own-job.cjs');");
  assert.equal(firstStatement("﻿/**\n * doc\n */\n// note\n\n'use strict'\nrequire('../tools/own-job.cjs');"), "require('../tools/own-job.cjs');");
  assert.equal(firstStatement("const test = require('node:test');\nrequire('./tools/own-job.cjs');"), "const test = require('node:test');", 'a require after another statement is too late');
  assert.equal(firstStatement("'use strict';\n/* a */ require('./tools/own-job.cjs'); // b"), "require('./tools/own-job.cjs'); // b");
});

test('expectedLine: the relative path to tools/own-job.cjs from the file\'s folder', () => {
  assert.equal(expectedLine('a.test.cjs'), "require('./tools/own-job.cjs');");
  assert.equal(expectedLine(path.join('heavy-lock', 'b.test.cjs')), "require('../tools/own-job.cjs');");
  assert.equal(expectedLine(path.join('start-fixes-163', 'c.test.cjs')), "require('../tools/own-job.cjs');");
});

test('perfFiles: lists the perf lane\'s own folder (test/perf), relative to test/, and nothing else', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'own-job-guard-perf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const f of ['b.perf.cjs', 'a.perf.cjs', 'c.test.cjs', 'notes.txt']) fs.writeFileSync(path.join(dir, f), '');
  assert.deepEqual(perfFiles(dir), [path.join('perf', 'a.perf.cjs'), path.join('perf', 'b.perf.cjs')], 'only *.perf.cjs, sorted, under perf/');
  assert.throws(() => perfFiles(path.join(dir, 'absent')), /ENOENT/, 'a missing perf folder is an error, not an empty list');

  const real = perfFiles();
  assert.ok(real.length > 0, 'the real perf lane is not empty (the runner refuses an empty one too)');
  for (const rel of real) {
    assert.equal(path.dirname(rel), 'perf', rel);
    assert.ok(fs.statSync(path.join(TEST_DIR, rel)).isFile(), `${rel} is a file under test/`);
    assert.equal(expectedLine(rel), "require('../tools/own-job.cjs');", `${rel}: the line is relative to test/perf`);
  }
  assert.deepEqual(fs.readdirSync(TEST_DIR).filter((f) => f.endsWith(R.PERF_SUFFIX)), [], 'no perf file sits in test/ itself, where neither the lane nor this list would find it');
});

test('GUARD: every discovered test file and every perf file requires tools/own-job.cjs as its first statement', () => {
  const perf = perfFiles();
  assert.ok(perf.length > 0, `the perf lane was listed (${perf.length} files)`);
  const files = [...R.discoverTestFiles(TEST_DIR), ...perf];
  assert.ok(files.length > 400, `the real test directory was walked (${files.length} files)`);
  const missing = [];
  for (const rel of files) {
    const src = fs.readFileSync(path.join(TEST_DIR, rel), 'utf8');
    const want = expectedLine(rel);
    const got = firstStatement(src);
    if (got.replace(/\s*\/\/.*$/, '').replace(/"/g, "'") !== want) missing.push(`${rel}: first statement is ${JSON.stringify(got.slice(0, 80))}; paste ${want} right after 'use strict';`);
  }
  assert.deepEqual(missing, [], `${missing.length} test file(s) run with no job of their own under a bare node --test:\n${missing.join('\n')}`);
});

test('GUARD: the helper itself is first in this file and in the test that proves it', () => {
  for (const f of ['own-job-guard.test.cjs', 'bare-node-test-owner.test.cjs']) {
    assert.equal(firstStatement(fs.readFileSync(path.join(TEST_DIR, f), 'utf8')), "require('./tools/own-job.cjs');", f);
  }
});
