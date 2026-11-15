'use strict';
require('./tools/own-job.cjs');
/**
 * DOTDOT-PREFIX-FALSE-REFUSAL (Jim, after FS-CONTAINMENT-TOCTOU N1): a path.relative() result leaves
 * its base only on a real '..' segment or an absolute result; a name that merely starts with two dots
 * stays inside. The shared helper, and codexTrustSeed's product-created scope through it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { posix, win32 } = require('node:path');
const loadTs = require('./load-ts.cjs');

const { relEscapes } = loadTs('src/main/relEscapes.ts');
const seed = loadTs('src/main/codexTrustSeed.ts');

test('relEscapes: segments, not a string prefix, on both path flavours', () => {
  for (const [P, s] of [[posix, '/'], [win32, '\\']]) {
    for (const rel of ['..notes.txt', '..d', `..d${s}x`, 'a', `a${s}..b`, '...']) assert.equal(relEscapes(rel, P), false, `${rel} stays inside`);
    for (const rel of ['..', `..${s}x`, `..${s}..x`, `..${s}..`]) assert.equal(relEscapes(rel, P), true, `${rel} leaves`);
  }
  assert.equal(relEscapes('/etc', posix), true, 'absolute (posix)');
  assert.equal(relEscapes('D:\\x', win32), true, 'another drive (win32)');
  assert.equal(relEscapes('\\\\host\\share\\x', win32), true, 'a UNC share (win32)');
  assert.equal(relEscapes(win32.relative('C:\\h', 'C:\\h\\..wt'), win32), false);
  assert.equal(relEscapes(win32.relative('C:\\h', 'D:\\h'), win32), true, 'relative() across drives is absolute');
});

test('codexTrustSeed product-created: a "..name" folder under worktrees is inside; a real ".." step is not', () => {
  for (const [platform, home, s] of [['linux', '/h', '/'], ['win32', 'C:\\h', '\\']]) {
    const ctx = { harnessHome: home, scope: 'product-created', platform };
    assert.equal(seed.shouldSeedCodexTrust(`${home}${s}worktrees${s}..wt`, ctx), true, `${platform}: ..wt`);
    assert.equal(seed.shouldSeedCodexTrust(`${home}${s}hive${s}agents${s}..a1`, ctx), true, `${platform}: ..a1`);
    assert.equal(seed.shouldSeedCodexTrust(`${home}${s}worktrees${s}..${s}..wt`, ctx), false, `${platform}: ../..wt leaves`);
    assert.equal(seed.shouldSeedCodexTrust(`${home}${s}worktrees`, ctx), false, `${platform}: the root itself is not inside`);
  }
});
