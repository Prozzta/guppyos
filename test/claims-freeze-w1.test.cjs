'use strict';
/**
 * CLAIM-LEDGER day-0 freeze (src/shared/claims.ts): the runtime parts of the frozen interface.
 *   - G0.1 the flag clamp: effective = min(global, agent, IMPLEMENTED); a level above the build is
 *     clamped DOWN to the implemented level and flagged for a `claim-ledger-clamp` row, never `off`.
 *   - C2: `rekey` is an EventKind, and the key provider is injectable.
 *   - C3: one retract form. No `retract` event kind and no `retract` event draft.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const SRC = path.join(__dirname, '..', 'src', 'shared', 'claims.ts');
const claims = loadTs(SRC);
const source = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');   // a CRLF checkout (core.autocrlf)

test('G0.1 clamp table: min(global, agent, implemented), clamped down never to off', () => {
  const { effectiveLevel } = claims;
  const rows = [
    // global, agent, implemented, level, clamped
    ['writer', undefined, 'reader', 'reader', true],    // G6.3b: an S2 setting on the S1 build
    ['writer', 'writer', 'shadow', 'shadow', true],
    ['reader', undefined, 'reader', 'reader', false],
    ['reader', 'shadow', 'writer', 'shadow', false],    // the agent narrows the global
    ['shadow', 'writer', 'writer', 'shadow', false],    // the agent never widens it
    ['off', 'writer', 'writer', 'off', false],
    [undefined, undefined, 'writer', 'off', false],     // the default is off
    ['writer', undefined, 'off', 'off', true],          // a build with nothing implemented
    ['writer2', undefined, 'reader', 'reader', true],   // an unknown (newer) level clamps down, not off
    ['writer', 'writer2', 'writer', 'writer', false],
    // Garbled values never turn the ledger on (Jim, 54d96ddb): as the global they mean off ...
    [null, undefined, 'writer', 'off', false],
    ['', undefined, 'writer', 'off', false],
    [0, undefined, 'writer', 'off', false],
    [3, undefined, 'writer', 'off', false],
    ['Writer', undefined, 'writer', 'off', false],
    ['WRITER', 'writer', 'writer', 'off', false],
    [' writer', undefined, 'writer', 'off', false],
    [{}, undefined, 'writer', 'off', false],
    // ... and as an agent entry they follow the global.
    ['reader', null, 'writer', 'reader', false],
    ['reader', '', 'writer', 'reader', false],
    ['reader', 0, 'writer', 'reader', false],
    ['reader', 'Writer', 'writer', 'reader', false],
    ['shadow', ['writer'], 'writer', 'shadow', false],
  ];
  for (const [g, a, impl, level, clamped] of rows) {
    assert.deepEqual(effectiveLevel(g, a, impl), { level, clamped }, `${g}/${a}/${impl}`);
  }
  for (const g of ['shadow', 'reader', 'writer']) {
    for (const impl of ['shadow', 'reader']) {
      assert.notEqual(effectiveLevel(g, undefined, impl).level, 'off', `${g} on ${impl} never becomes off`);
    }
  }
});

test('the day-0 build implements nothing yet', () => {
  assert.equal(claims.IMPLEMENTED_LEVEL, 'off');
  assert.deepEqual([...claims.LEDGER_LEVELS], ['off', 'shadow', 'reader', 'writer']);
  assert.equal(claims.LEDGER_RECORD_VERSION, 1);
});

test('C2: rekey is an event kind; the key provider and the key-missing alert are frozen', () => {
  assert.ok(claims.EVENT_KINDS.includes('rekey'));
  for (const k of ['purge', 'unpin', 'pin', 'status-mark']) assert.ok(claims.EVENT_KINDS.includes(k), k);
  assert.match(source, /export interface MacKeyProvider \{[\s\S]*?load\(\): MacKeyLoad;[\s\S]*?create\(\): MacKeyLoad;/);
  assert.equal(claims.CLAIMS_ALERT_KEY_MISSING, 'claims-key-missing');
  assert.equal(claims.CLAIMS_ALERT_CHAIN_BROKEN, 'claims-chain-broken');
  assert.equal(claims.CLAIM_LEDGER_CLAMP_ROW, 'claim-ledger-clamp');
});

test('C3: one retract form, a claim with retracts', () => {
  assert.ok(!claims.EVENT_KINDS.includes('retract'));
  const draft = /export type RecordDraft =([\s\S]*?);\n\n/.exec(source);
  assert.ok(draft, 'RecordDraft found');
  const eventBranch = /t: 'event'; ev: ([^;]+);/.exec(draft[1]);
  assert.ok(eventBranch, 'the event branch found');
  assert.doesNotMatch(eventBranch[1], /'retract'/);
  assert.match(draft[1], /retracts\?: string\[\]/);
});

test('text limits: 400 for external entry points, 4000 for the w6-internal origin only', () => {
  assert.equal(claims.CLAIM_TEXT_MAX, 400);
  assert.equal(claims.CLAIM_TEXT_MAX_LEGACY, 4000);
  const origin = /export type AppendOrigin = ([^;]+);/.exec(source)[1];
  assert.deepEqual([...origin.matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]), ['endpoint', 'ledger-route', 'ui-ipc', 'w6-internal']);
  assert.match(source, /export type AppendRecordFn = \(agentId: string, draft: RecordDraft, origin: AppendOrigin\)/);
});

test('R5 candidates: W3 produces them, W5 enqueues them; derive is not involved', () => {
  assert.match(source, /export interface R5Candidate \{ a: string[^}]*; b: string; cosine: number; tau2: number \}/);
  assert.match(source, /export type R5CandidatesFn = \(agentId: string, claimId: string\) => Promise<R5Candidate\[\]>;/);
  assert.match(source, /export type EnqueueCandidatesFn = \(agentId: string, pairs: R5Candidate\[\]\) => void;/);
  assert.match(source, /export type DeriveFn = \(records: LedgerRec\[\], registry: KeyRegistry, ruleConfig: \{ r4: boolean \}\) => ClaimsState;/);
});

test('the EventKind union and EVENT_KINDS agree', () => {
  const union = /export type EventKind =([\s\S]*?);/.exec(source)[1];
  const names = [...union.matchAll(/'([a-z?-]+)'/g)].map((m) => m[1]);
  assert.deepEqual(names.sort(), [...claims.EVENT_KINDS].sort());
});
