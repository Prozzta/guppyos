'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { score } = require('../tools/claims-m4a-render-check.cjs');
const loadTs = require('./load-ts.cjs');
const { createClaimViews } = loadTs('src/main/claims/views.ts');

test('M4a checker requires the frozen current value labeled CURRENT and dates/labels visible priors', () => {
  const key = { items: [{ changed: true, agent: 'a1', current: 'current-invented', priorValues: ['prior-invented'], entryIds: ['old-entry'], historyAnchor: 'claim-history-c1' }] };
  let full = '### Claim history: invented\n- CURRENT — 2026-10-04 — current-invented [c:c1]\n- PRIOR — 2026-09-01 — prior-invented [c:c0]';
  const read = (_agent, name) => name === 'memory.md' ? full : 'current-invented [c:c1]';
  assert.deepEqual(score(key, read), { frozenChangedFacts: 1, fullViewPass: 1, workingSetPass: 1, fullViewScore: 1, workingSetScore: 1 });
  full = '### Claim history: invented\n- current-invented [c:c1]\n- prior-invented [c:c0]';
  const failed = score(key, read);
  assert.equal(failed.fullViewPass, 0);
  assert.equal(failed.workingSetPass, 1);
});

test('M4a checker scores actual generated grouped full view and capped working-set pointer', () => {
  const prior = { v: 1, id: 'c-prior00000001', t: 'claim', kind: 'fact', text: 'prior-invented', key: 'invented-topic',
    at: '2026-09-01T00:00:00.000Z', wt: '2026-09-01T00:00:00.000Z', agent: 'a1', source: 'self' };
  const current = { ...prior, id: 'c-current000001', text: 'current-invented', at: '2026-10-04T00:00:00.000Z',
    wt: '2026-10-04T00:00:00.000Z', supersedes: [prior.id] };
  const records = [prior, current];
  const state = { agent: 'a1', claims: {
    [prior.id]: { status: 'superseded', supersededBy: current.id, lastAt: prior.at, sightings: 0 },
    [current.id]: { status: 'live', lastAt: current.at, sightings: 0 },
  } };
  const world = { flags: {}, counters: {} };
  const views = createClaimViews(records, text => text.length);
  const full = views.renderMemoryMd(state, world, 'complete');
  const working = views.buildWorkingSet(state, world, 4500).text;
  const key = { items: [{ changed: true, agent: 'a1', topic: 'invented-topic', current: 'current-invented',
    priorValues: ['prior-invented'], entryIds: [], historyAnchor: `claim-history-${current.id}` }] };
  const result = score(key, (_agent, name) => name === 'memory.md' ? full : working);
  assert.equal(result.fullViewPass, 1);
  assert.equal(result.workingSetPass, 1);
});

test('memory search visibly labels superseded hits as dated prior versions', () => {
  const { formatSearch } = loadTs('src/main/nativeMemory/format.ts');
  const text = formatSearch('invented query', {}, [{ chunkId: 1, wing: 'a1', room: 'memory', source: 'claim', content: 'invented prior text',
    cosineSim: 0.5, bm25: -1, score: 1,
    claim: { id: 'c-prior00000001', status: 'superseded', kind: 'fact', key: 'invented-topic', at: '2026-09-01T00:00:00.000Z' } }]);
  assert.match(text, /Claim:  \[prior · fact · invented-topic · 2026-09-01/);
  assert.match(text, /Version: prior \(dated 2026-09-01\)/);
});
