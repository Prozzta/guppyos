'use strict';

/**
 * PRICING-CACHE-TTL-SPLIT: the proxy bridge is the live CostSample producer.
 * Pin both TTL fields across its emit and HookServer's ledger pricing boundary.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const hooksSource = readSource('src/main/hooks.ts');
const shimSource = codeOnly(readSource('src/main/hive.ts'));
const EMIT_5M = /cache_creation_5m:\s*cacheCreation5m/;
const EMIT_1H = /cache_creation_1h:\s*cacheCreation1h/;

function server(HookServer) {
  const rows = [];
  const hive = {
    sockPath: () => null, codexHomeFor: () => null, recordSession: () => {}, appendLog: () => {},
    registry: () => ({ agents: {} }), isGod: () => false, rosterContext: () => '', recordModel: () => {},
    appendCostLedger: (row) => rows.push(row)
  };
  const control = { shouldHalt: () => false, takeSteer: () => null, toolDecision: () => ({ deny: false }) };
  return { rows, hooks: new HookServer(hive, () => ({ send: () => {} }), () => ({}), control, undefined, undefined, () => {}) };
}

function samples(hooks) {
  hooks.handle({ hook_event_name: 'CostSample', agent_id: 'proxy-agent', session_id: 'mixed', model: 'claude-opus-5-5', input: 0, output: 0, cache_read: 0, cache_creation: 1_000_000, cache_creation_5m: 400_000, cache_creation_1h: 600_000 });
  hooks.handle({ hook_event_name: 'CostSample', agent_id: 'proxy-agent', session_id: 'summed', model: 'claude-opus-5-5', input: 0, output: 0, cache_read: 0, cache_creation: 1_000_000 });
}

test('proxy CostSample TTLs reach ledger pricing; summed-only retains the 1h fallback', () => {
  const { HookServer } = loadTs('src/main/hooks.ts');
  const live = server(HookServer);
  samples(live.hooks);
  assert.deepEqual(live.rows.map((r) => [r.sessionId, r.usd]), [['mixed', 6.8], ['summed', 8]]);
});

test('proxy shim emits both TTL fields, and deleting either emit field kills the shim pin', () => {
  assert.match(shimSource, EMIT_5M);
  assert.match(shimSource, EMIT_1H);
  assert.throws(() => assert.match(shimSource.replace('cache_creation_5m: cacheCreation5m, ', ''), EMIT_5M));
  assert.throws(() => assert.match(shimSource.replace(', cache_creation_1h: cacheCreation1h', ''), EMIT_1H));
});

test('dropping the 5m HookServer handoff turns the mixed ledger pin red', () => {
  const mutant = hooksSource.replace('cacheWrite5mTokens: cacheCreation5m,', 'cacheWrite5mTokens: undefined,');
  assert.notEqual(mutant, hooksSource, 'the requested handoff mutant applied');
  const { HookServer } = loadTs.fromText('src/main/hooks.ts', mutant);
  const altered = server(HookServer);
  samples(altered.hooks);
  assert.notEqual(altered.rows[0].usd, 6.8, 'without the 5m handoff, mixed pricing is no longer exact');
  assert.equal(altered.rows[0].usd, 8, 'the missing 5m bucket falls back to the 1h rate');
});
