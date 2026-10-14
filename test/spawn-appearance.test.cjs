'use strict';

// main's spawn-request appearance sanitiser (TES looks, MunderDev 0bba1dc8): only a small
// plain object of short strings ever reaches the renderer. Oversize, arrays, non-strings,
// unknown keys and long values are all dropped.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { spawnAppearance } = loadTs('src/main/spawnAppearance.ts');

test('a well-formed appearance passes through whole', () => {
  const v = { theme: 'deck', presetId: 'pilot', bodyId: 'b1', colors: { skin: '#aa8866', shirt: '#123456', hair: 'red' } };
  assert.deepEqual(spawnAppearance(v), v);
  assert.deepEqual(spawnAppearance({ presetId: 'pilot' }), { presetId: 'pilot' });
});

test('not a plain object: nothing is passed on', () => {
  for (const v of [undefined, null, '', 'pilot', 0, 7, true, [], [{ presetId: 'pilot' }], () => 1]) {
    assert.equal(spawnAppearance(v), undefined, `${typeof v} ${JSON.stringify(v)}`);
  }
  // an array is refused as such, even one carrying a named key
  assert.equal(spawnAppearance(Object.assign([], { presetId: 'pilot' })), undefined);
});

test('oversize (JSON over 400 chars) is dropped whole, even with valid keys inside', () => {
  const v = { presetId: 'pilot', note: 'x'.repeat(400) };
  assert.ok(JSON.stringify(v).length > 400);
  assert.equal(spawnAppearance(v), undefined);
  // just under the cap still passes its valid keys
  const ok = { presetId: 'pilot', note: 'x'.repeat(360) };
  assert.ok(JSON.stringify(ok).length <= 400);
  assert.deepEqual(spawnAppearance(ok), { presetId: 'pilot' });
});

test('unserialisable input (a cycle, a BigInt) is dropped, never thrown', () => {
  const cyc = { presetId: 'pilot' }; cyc.self = cyc;
  assert.equal(spawnAppearance(cyc), undefined);
  assert.equal(spawnAppearance({ presetId: 'pilot', n: 1n }), undefined);
});

test('extra keys are dropped; only theme, presetId, bodyId and colors survive', () => {
  assert.deepEqual(spawnAppearance({ presetId: 'pilot', __proto__x: 'a', command: 'rm -rf /', character: 'jim' }), { presetId: 'pilot' });
  assert.equal(spawnAppearance({ command: 'x', extra: 'y' }), undefined, 'nothing valid left: undefined, not {}');
  const r = spawnAppearance({ colors: { skin: '#fff', eyes: '#000', shirt: '#111' } });
  assert.deepEqual(r, { colors: { skin: '#fff', shirt: '#111' } });
});

test('non-string values are dropped', () => {
  assert.deepEqual(spawnAppearance({ theme: 1, presetId: { a: 1 }, bodyId: ['b'], colors: { skin: 0xffffff, shirt: null, hair: '#000' } }), { colors: { hair: '#000' } });
  assert.equal(spawnAppearance({ theme: true, presetId: null }), undefined);
  assert.equal(spawnAppearance({ colors: ['#fff'] }), undefined, 'colors as an array is dropped');
  assert.equal(spawnAppearance({ colors: '#fff' }), undefined, 'colors as a string is dropped');
  assert.equal(spawnAppearance({ colors: { skin: 1 } }), undefined, 'no valid colour: no colors key, so nothing');
});

test('long ids (over 40) and long colours (over 16) are dropped; the limits themselves pass', () => {
  const id40 = 'a'.repeat(40), id41 = 'a'.repeat(41), c16 = '#'.padEnd(16, 'f'), c17 = '#'.padEnd(17, 'f');
  assert.deepEqual(spawnAppearance({ theme: id40, presetId: id41, bodyId: id41 }), { theme: id40 });
  assert.deepEqual(spawnAppearance({ colors: { skin: c16, shirt: c17, hair: c17 } }), { colors: { skin: c16 } });
  assert.equal(spawnAppearance({ presetId: id41, colors: { hair: c17 } }), undefined);
});

test('main passes the request through spawnAppearance and nothing else', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  assert.match(main, /import \{ spawnAppearance \} from '\.\/spawnAppearance';/);
  assert.match(main, /appearance: spawnAppearance\(raw\.appearance\)/);
  assert.doesNotMatch(main, /appearance: raw\.appearance/);
});
