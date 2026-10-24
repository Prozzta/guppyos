'use strict';
require('./tools/own-job.cjs');
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

function perfFiles() {
  return fs.readdirSync(TEST_DIR).filter((f) => f.endsWith(R.PERF_SUFFIX));
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

test('GUARD: every discovered test file and every perf file requires tools/own-job.cjs as its first statement', () => {
  const files = [...R.discoverTestFiles(TEST_DIR), ...perfFiles()];
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
