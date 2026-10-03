'use strict';

// REBRAND-LINK-SCHEME (1.1.83): hire links use guppy://, and munderdifflin:// stays
// an alias so links people already shared keep opening.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const { HIRE_LINK_SCHEMES, isHireLinkArg, parseHireDeepLink } = loadTs('src/shared/hire.ts');

const SRC = 'https://gallery.example/pr-reviewer.json';
const q = `src=${encodeURIComponent(SRC)}`;

test('guppy:// is the main scheme and munderdifflin:// the alias', () => {
  assert.deepEqual([...HIRE_LINK_SCHEMES], ['guppy', 'munderdifflin']);
});

test('both schemes parse, in the host and the path form, in any case', () => {
  for (const link of [
    `guppy://hire?${q}`, `guppy:hire?${q}`, `GUPPY://HIRE?${q}`,
    `munderdifflin://hire?${q}`, `munderdifflin:hire?${q}`, `MunderDifflin://hire?${q}`,
  ]) {
    assert.equal(parseHireDeepLink(link), SRC, link);
  }
});

test('other schemes, other actions and unsafe manifests are still refused', () => {
  for (const link of [
    `guppyx://hire?${q}`, `xguppy://hire?${q}`, `munder://hire?${q}`, `https://hire?${q}`,
    `guppy://spawn?${q}`, 'guppy://hire', `guppy://hire?src=${encodeURIComponent('http://evil.example/x.json')}`,
    `guppy://hire?src=${encodeURIComponent('file:///C:/x.json')}`, 'not a url',
  ]) {
    assert.equal(parseHireDeepLink(link), null, link);
  }
});

test('argv lookup finds a link of either scheme and nothing else', () => {
  assert.equal(isHireLinkArg(`guppy://hire?${q}`), true);
  assert.equal(isHireLinkArg(`Guppy://hire?${q}`), true);
  assert.equal(isHireLinkArg(`munderdifflin://hire?${q}`), true);
  for (const arg of ['C:\\Program Files\\Guppy\\Guppy.exe', '--allow-file-access-from-files', 'guppy', 'guppy.exe',
    'C:\\guppy://x', `xguppy://hire?${q}`, '.']) {
    assert.equal(isHireLinkArg(arg), false, arg);
  }
  const argv = ['C:\\Guppy\\Guppy.exe', '--', `guppy://hire?${q}`];
  assert.equal(argv.find(isHireLinkArg), argv[2]);
});

test('main registers every scheme and reads argv through isHireLinkArg', () => {
  const main = read('src/main/index.ts');
  assert.match(main, /for \(const scheme of HIRE_LINK_SCHEMES\) \{/);
  assert.match(main, /app\.setAsDefaultProtocolClient\(scheme, process\.execPath, \[resolve\(process\.argv\[1\]\)\]\);/);
  assert.match(main, /app\.setAsDefaultProtocolClient\(scheme\);/);
  assert.doesNotMatch(main, /setAsDefaultProtocolClient\('/, 'no scheme is registered by a literal');
  assert.match(main, /const link = argv\.find\(isHireLinkArg\);/, 'second-instance (Windows/Linux warm start)');
  assert.match(main, /const startupHireLink = process\.argv\.find\(isHireLinkArg\);/, 'cold start');
  const code = main.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l)).join('\n');
  assert.doesNotMatch(code.replace(/console\.\w+\('[^']*'\)/g, ''), /munderdifflin:/, 'no scheme literal left in main code');
});

test('the builder config registers both schemes for macOS and Linux', () => {
  assert.match(read('electron-builder.yml'), /^protocols:\n {2}- name: Guppy\n {4}schemes:\n {6}- guppy\n {6}- munderdifflin\n/m);
});
