'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { score } = require('../tools/claims-m4a-render-check.cjs');
const loadTs = require('./load-ts.cjs');
const { createClaimViews } = loadTs('src/main/claims/views.ts');

const entryClaims = { a1: {
  'a1:memory.md:10': { claimId: 'c-current000001', text: 'current-invented' },
  'a1:memory.md:4': { claimId: 'c-prior00000001', text: 'prior-invented' },
} };
const key = { items: [{ changed: true, agent: 'a1', topic: 'invented-topic',
  current: 'a1:memory.md:10', entryIds: ['a1:memory.md:4', 'a1:memory.md:10'] }] };
const goodFull = '### Claim history: invented\n- CURRENT — 2026-10-04 — current-invented [status:live] [c:c-current000001]\n- PRIOR — 2026-09-01 — prior-invented [status:superseded] [c:c-prior00000001]';
const goodWorking = '# Memory working set\n- current-invented [status:current] [c:c-current000001] [history: memory.md#claim-history-c-current000001]';
const read = (full = goodFull, working = goodWorking) => (_agent, name) => name === 'memory.md' ? full : working;

test('M4a reads frozen key locators and scores through each replay entry-to-claim map', () => {
  assert.deepEqual(score(key, read(), entryClaims), { frozenChangedFacts: 1, fullViewPass: 1, workingSetPass: 1, fullViewScore: 1, workingSetScore: 1 });
  const noMap = score(key, read(), {});
  assert.equal(noMap.fullViewPass, 0, 'an unmapped frozen locator cannot accidentally match rendered prose');
});

test('M4a arm A without claim ids uses replay text mappings under the same label rules', () => {
  const textMap = { a1: {
    'a1:memory.md:10': { text: 'current-invented' },
    'a1:memory.md:4': { text: 'prior-invented' },
  } };
  const full = '- CURRENT — 2026-10-04 — current-invented\n- PRIOR — 2026-09-01 — prior-invented';
  const working = '- current-invented [history: memory.md#arm-a-history]';
  const result = score(key, read(full, working), textMap);
  assert.equal(result.fullViewPass, 1);
  assert.equal(result.workingSetPass, 1);
  assert.equal(score(key, read(full, '- invented-topic history: memory.md#arm-a-history'), textMap).workingSetPass, 1,
    'arm A credits the product standalone pointer using the frozen topic');
});

test('M4a rejects every stale duplicate copy of a prior, not just its first labeled line', () => {
  const mutated = `${goodFull}\n- prior-invented shown again [status:live] [c:c-prior00000001]`;
  assert.equal(score(key, read(mutated), entryClaims).fullViewPass, 0);
});

test('M4a clause 3: the working set shows the current version OR a per-fact pointer (design §8)', () => {
  // (1) The pointer alone, current budgeted out: passes.
  const standalone = '# Memory working set\n- invented-topic history: memory.md#claim-history-c-current000001';
  assert.equal(score(key, read(goodFull, standalone), entryClaims).workingSetPass, 1);
  // (2) The current version shown with no pointer: passes (Jim W1; it scored 0 before).
  const shownOnly = '# Memory working set\n- current-invented [status:current] [c:c-current000001]';
  assert.equal(score(key, read(goodFull, shownOnly), entryClaims).workingSetPass, 1, 'a shown current alone satisfies clause 3');
  // (3) Neither: fails (deleting the pointer loop with current budgeted out).
  const neither = standalone.replace(/^.*history:.*$/m, '');
  assert.equal(score(key, read(goodFull, neither), entryClaims).workingSetPass, 0, 'neither current nor pointer fails');
  // A prior shown as if current is not the current version.
  const priorOnly = '# Memory working set\n- prior-invented [status:current] [c:c-prior00000001]';
  assert.equal(score(key, read(goodFull, priorOnly), entryClaims).workingSetPass, 0, 'the prior shown is not the current');
});

test('M4a rejects a dropped date label even when claim text itself contains an ISO date', () => {
  const datedText = goodFull.replace('prior-invented', 'prior-invented 2025-01-01').replace('- PRIOR — 2026-09-01 —', '- PRIOR —');
  assert.equal(score(key, read(datedText), entryClaims).fullViewPass, 0);
});

test('M4a scores actual generated grouped view by claim id', () => {
  const prior = { v: 1, id: 'c-prior00000001', t: 'claim', kind: 'fact', text: 'prior-invented', key: 'invented-topic', at: '2026-09-01T00:00:00.000Z', wt: '2026-09-01T00:00:00.000Z', agent: 'a1', source: 'self' };
  const current = { ...prior, id: 'c-current000001', text: 'current-invented', at: '2026-10-04T00:00:00.000Z', wt: '2026-10-04T00:00:00.000Z', supersedes: [prior.id] };
  const records = [prior, current];
  const state = { agent: 'a1', claims: {
    [prior.id]: { status: 'superseded', supersededBy: current.id, lastAt: prior.at, sightings: 0 },
    [current.id]: { status: 'live', lastAt: current.at, sightings: 0 },
  } };
  const views = createClaimViews(records, text => text.length);
  const full = views.renderMemoryMd(state, { flags: {}, counters: {} }, 'complete');
  const result = score(key, (_agent, name) => name === 'memory.md' ? full : goodWorking, entryClaims);
  assert.equal(result.fullViewPass, 1);
});

test('memory search visibly labels superseded hits as dated prior versions', () => {
  const { formatSearch } = loadTs('src/main/nativeMemory/format.ts');
  const text = formatSearch('invented query', {}, [{ chunkId: 1, wing: 'a1', room: 'memory', source: 'claim', content: 'invented prior text', cosineSim: 0.5, bm25: -1, score: 1,
    claim: { id: 'c-prior00000001', status: 'superseded', kind: 'fact', key: 'invented-topic', at: '2026-09-01T00:00:00.000Z' } }]);
  assert.match(text, /Claim:  \[prior · fact · invented-topic · 2026-09-01/);
  assert.match(text, /Version: prior \(dated 2026-09-01\)/);
});
