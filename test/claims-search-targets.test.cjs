'use strict';
/**
 * CLAIMS-90 search S3/S4 (god 33b32e): searchTargets.ts maps a card id, a card-owned branch or a release version
 * named in a query or a hit to the card or release whose brief leads the results. Pure; synthetic ids only.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const loadTs = require(path.join(__dirname, 'load-ts.cjs'));
const { targetIndex, targetsIn } = loadTs('src/main/claims/searchTargets.ts');

const ix = targetIndex(
  ['FOO-7', 'Bar-Baz-12', 'INT-9.1.2', 'qux'],
  ['card.foo-7.merge', 'card.only-key-3.donesha', 'card.dec-5.decision.x', 'release.9.1.1.tag', 'release.9.0.7', 'release.9.1.2.bump','branch.loose', 'release.notes'],
);
const terms = (texts, max) => targetsIn(texts, ix, max).map((t) => `${t.kind}:${t.term}`);

test('index: card ids from tasks first, then card.<id> keys; releases from release.<v>[.x] keys', () => {
  assert.deepEqual([...ix.cards.values()].sort(), ['Bar-Baz-12', 'FOO-7', 'INT-9.1.2', 'dec-5', 'only-key-3', 'qux']);
  assert.deepEqual([...ix.releases].sort(), ['9.0.7', '9.1.1', '9.1.2']);
});

test('a card id in any case and inside punctuation names its card, as tasks.json writes it', () => {
  for (const q of ['foo-7 merge sha', '(FOO-7)', 'FOO-7: done', 'card.foo-7.merge', 'card.foo-7', '"Foo-7".', 'see foo-7.']) {
    assert.deepEqual(terms([q]), ['card:FOO-7'], q);
  }
  assert.deepEqual(terms(['only-key-3 donesha']), ['card:only-key-3']);
  assert.deepEqual(terms(['card.dec-5.decision.x']), ['card:dec-5']);
});

test('a branch a card owns names that card; a foreign branch path names nothing', () => {
  assert.deepEqual(terms(['guppy/foo-7 tip']), ['card:FOO-7']);
  assert.deepEqual(terms(['origin/guppy/bar-baz-12']), ['card:Bar-Baz-12']);
  assert.deepEqual(terms(['feature/foo-7']), []);
});

test('a short name of one card names it: a run of 2+ id words, or the stem of <stem>-<n>; a shared one names none', () => {
  assert.deepEqual(terms(['bar-baz merged']), ['card:Bar-Baz-12']);
  assert.deepEqual(terms(['baz-12']), ['card:Bar-Baz-12']);
  assert.deepEqual(terms(['foo done']), ['card:FOO-7']);
  const long = targetIndex(['HEAVY-LOCK-CMD-QUOTED-CARET-198', 'HEAVY-LOCK-GLOB-LOOP-196', 'WAKE-STRANDED-IN-COMPOSER'], []);
  const at = (q) => targetsIn([q], long).map((t) => t.term);
  assert.deepEqual(at('quoted-caret done'), ['HEAVY-LOCK-CMD-QUOTED-CARET-198']);
  assert.deepEqual(at('QUOTED-CARET-198'), ['HEAVY-LOCK-CMD-QUOTED-CARET-198']);
  assert.deepEqual(at('wake-stranded'), ['WAKE-STRANDED-IN-COMPOSER']);
  assert.deepEqual(at('heavy-lock'), [], 'a run two cards share');
  assert.deepEqual(at('caret glob stranded'), [], 'one word that is no <stem>-<n> stem');
  const two = targetIndex(['dup-1', 'dup-2', 'solo', 'solo-4'], []);
  assert.deepEqual(targetsIn(['dup'], two), []);
  assert.deepEqual(targetsIn(['solo'], two), [{ kind: 'card', term: 'solo' }]);
});

test('a release version in each written form names release.<v> when a release key exists', () => {
  for (const q of ['9.1.1', 'v9.1.1', 'release.9.1.1', 'release.9.1.1.tag', 'int-9.1.1', 'INT 9.1.1', 'release-9.1.1', 'rc-9.1.1', 'rc/9.1.1', '(9.1.1)']) {
    assert.deepEqual(terms([q]), ['release:release.9.1.1'], q);
  }
  assert.deepEqual(terms(['9.9.9 v9.9.9 int-9.9.9']), [], 'no release key, no target');
  assert.deepEqual(terms(['release.notes']), []);
});

test('a card id wins over a release reading of the same token', () => {
  assert.deepEqual(terms(['INT-9.1.2 done']), ['card:INT-9.1.2']);
  assert.deepEqual(terms(['9.1.2']), ['release:release.9.1.2']);
});

test('mention order, query first, deduplicated across texts, capped at max', () => {
  assert.deepEqual(terms(['9.0.7 foo-7', 'FOO-7 bar-baz-12 qux', 'release.9.0.7 9.1.1']),
    ['release:release.9.0.7', 'card:FOO-7', 'card:Bar-Baz-12', 'card:qux', 'release:release.9.1.1']);
  assert.deepEqual(terms(['qux foo-7 9.1.1'], 2), ['card:qux', 'card:FOO-7']);
  assert.deepEqual(terms([null, 'qux']), ['card:qux']);
});
