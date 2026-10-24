'use strict';
require('./tools/own-job.cjs');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { newMutantDir, cleanupMutantDir } = require('./mutant-dir-helper.cjs');

test('MUTANT DIR HELPER: allocations are unique and cleanup is exact', () => {
  const first = newMutantDir('helper');
  const second = newMutantDir('helper');
  const sentinel = path.join(first, 'must-survive-second-cleanup');
  const unallocated = fs.mkdtempSync(path.join(__dirname, '.mutants-unallocated-'));
  let secondCleaned = false;
  try {
    assert.notEqual(first, second, 'each allocation has its own directory');
    assert.equal(path.dirname(first), __dirname, 'first allocation stays directly under test');
    assert.equal(path.dirname(second), __dirname, 'second allocation stays directly under test');
    fs.writeFileSync(sentinel, 'present', 'utf8');
    cleanupMutantDir(second);
    secondCleaned = true;
    assert.ok(fs.existsSync(first), 'cleaning B leaves A intact');
    assert.ok(fs.existsSync(sentinel), 'cleaning B leaves A sentinel intact');
    assert.throws(() => cleanupMutantDir(unallocated), /unallocated mutant directory/);
    assert.ok(fs.existsSync(unallocated), 'refusing an unallocated directory leaves it intact');
  } finally {
    cleanupMutantDir(first);
    if (!secondCleaned) cleanupMutantDir(second);
    fs.rmSync(unallocated, { recursive: true, force: true });
  }
});
