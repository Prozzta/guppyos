'use strict';
require('./tools/own-job.cjs');
/**
 * FLAKE-FS-REMOVE-GAP-RACE-CHILD-FAILED-108: a race process that ends without a result says how it
 * ended.
 *
 * fs-remove-gap's CONTROL went red once under suite load with "RACE FAILED: no result: Command
 * failed: <the command line>" and nothing more. The text was cut after 200 characters, and the
 * command line alone is that long: the exit code and the child's stderr came after the cut. So the
 * one occurrence could not say whether the child threw (a stack on stderr) or was ended from
 * outside (no stderr).
 *
 * This file starts one race process through many() that dies before it runs anything, by a
 * --require fixture in NODE_OPTIONS, and reads what many() reports for it. It is light: one child,
 * no race.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { many } = require('./fs-remove-gap-race.cjs');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-gap-report-'));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

/** Run one race process that loads `body` first (and dies in it); returns the failed racer's text. */
async function dead(name, body) {
  const fixture = path.join(ROOT, `${name}.cjs`);
  fs.writeFileSync(fixture, body);
  const before = process.env.NODE_OPTIONS;
  const exeBefore = process.env.FS_GAP_EXE;
  delete process.env.FS_GAP_EXE;
  // forward slashes: NODE_OPTIONS reads a backslash as an escape
  process.env.NODE_OPTIONS = `${before ? before + ' ' : ''}--require "${fixture.replace(/\\/g, '/')}"`;
  let res;
  try { res = await many(['sync'], 1, 1, 1); }
  finally {
    if (before === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = before;
    if (exeBefore !== undefined) process.env.FS_GAP_EXE = exeBefore;
  }
  const t = res.totals.sync;
  assert.equal(t.races, 1);
  assert.equal(t.failed, 1, 'the dead racer is a failed race');
  const keys = Object.keys(t.errors);
  assert.equal(keys.length, 1, JSON.stringify(keys));
  return keys[0];
}

test('a racer that throws before its result: the exit code and the END of its stderr are in the report', async () => {
  // 3000 characters of stderr first: the reason of a real crash is at the end of a stack, not the start
  const text = await dead('throws', `process.stderr.write('x'.repeat(3000) + '\\nFS-GAP-REPORT-LAST-STDERR-LINE\\n'); process.exit(3);\n`);
  assert.match(text, /^RACE FAILED: no result: exit 3\b/, `THE EXIT CODE COMES FIRST: ${text.slice(0, 300)}`);
  assert.ok(text.includes('FS-GAP-REPORT-LAST-STDERR-LINE'), `THE END OF THE CHILD'S STDERR IS KEPT: ${text.slice(0, 300)}`);
});

test('a racer that ends with no stderr (what a kill from outside leaves) says so: it cannot be read as a throw', async () => {
  const text = await dead('silent', 'process.exit(1);\n');
  assert.match(text, /^RACE FAILED: no result: exit 1\b/, text.slice(0, 300));
  assert.ok(text.includes('stderr: (empty)'), `AN EMPTY STDERR IS SAID, not left out: ${text.slice(0, 300)}`);
});
