'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { estimateCostUsd, normalizeModel, priceFor } = loadTs('src/main/pricing.ts');

test('pricing resolves every shipped Claude picker id to its published rate row', () => {
  const cases = [
    ['claude-fable-5-1', { inputPerM: 10, outputPerM: 50, cacheReadPerM: 0.25, cacheWrite5mPerM: 12.5, cacheWrite1hPerM: 20 }],
    ['claude-mythos-5-1', { inputPerM: 10, outputPerM: 50, cacheReadPerM: 0.25, cacheWrite5mPerM: 12.5, cacheWrite1hPerM: 20 }],
    ['claude-fable-5', { inputPerM: 10, outputPerM: 50, cacheReadPerM: 1, cacheWrite5mPerM: 12.5, cacheWrite1hPerM: 20 }],
    ['claude-opus-5-5', { inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.2, cacheWrite5mPerM: 5, cacheWrite1hPerM: 8 }],
    ['claude-opus-5-5[1m]', { inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.2, cacheWrite5mPerM: 5, cacheWrite1hPerM: 8 }],
    ['claude-opus-5', { inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5, cacheWrite5mPerM: 6.25, cacheWrite1hPerM: 10 }],
    ['claude-opus-4-8', { inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5, cacheWrite5mPerM: 6.25, cacheWrite1hPerM: 10 }],
    ['claude-opus-4-8[1m]', { inputPerM: 5, outputPerM: 25, cacheReadPerM: 0.5, cacheWrite5mPerM: 6.25, cacheWrite1hPerM: 10 }],
    ['claude-sonnet-5', { inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.2, cacheWrite5mPerM: 2.5, cacheWrite1hPerM: 4 }],
    ['claude-sonnet-4-6', { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWrite5mPerM: 3.75, cacheWrite1hPerM: 6 }],
    ['claude-sonnet-4-6[1m]', { inputPerM: 3, outputPerM: 15, cacheReadPerM: 0.3, cacheWrite5mPerM: 3.75, cacheWrite1hPerM: 6 }],
    ['claude-haiku-4-5-20251001', { inputPerM: 1, outputPerM: 5, cacheReadPerM: 0.1, cacheWrite5mPerM: 1.25, cacheWrite1hPerM: 2 }]
  ];
  for (const [model, expected] of cases) assert.deepEqual(priceFor(model), expected, model);
});

test('pricing strips the accepted Opus 5.5 1M suffix before lookup', () => {
  assert.equal(normalizeModel('claude-opus-5-5[1m]'), 'claude-opus-5-5');
  assert.deepEqual(priceFor('claude-opus-5-5[1m]'), priceFor('claude-opus-5-5'));
});

test('pricing costs Claude Code cache writes at the recorded one-hour rate', () => {
  assert.equal(estimateCostUsd('claude-opus-5-5', {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1_000_000
  }), 8);
});
