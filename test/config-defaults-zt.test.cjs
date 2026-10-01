'use strict';

/**
 * ZT-I4: the shipped defaults. The hourly ops standup is opt-in (the floor digest replaces
 * it for zero model tokens), and the heartbeat is retired: never armed, never seeded, and
 * removed once from an old config.
 *
 * Mutants that must die:
 *   M16  the standup re-enabled by default
 *   MHB1 a heartbeat mission is armed again
 *   MHB2 the heartbeat is seeded again for new installs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { readSource, codeOnly } = require('./read-source.cjs');

const CONFIG = codeOnly(readSource('src/main/config.ts'), 'config.ts');
const INDEX = codeOnly(readSource('src/main/index.ts'), 'index.ts');

function block(src, start) {
  const i = src.indexOf(start);
  assert.ok(i >= 0, `found ${start}`);
  return src.slice(i, src.indexOf('};', i));
}

test('OPS_STANDUP_MISSION ships disabled; the TE0 delta gate is unchanged (M16)', () => {
  const standup = block(CONFIG, 'export const OPS_STANDUP_MISSION');
  assert.match(standup, /enabled: false,/);
  assert.doesNotMatch(standup, /^\s*enabled: true,/m);
  assert.match(standup, /deltaGate: \{ enabled: true \}/);
});

test('the heartbeat is never armed, never seeded, and removed once (MHB1, MHB2)', () => {
  const sync = INDEX.slice(INDEX.indexOf('function syncMissions'), INDEX.indexOf('const fire = ', INDEX.indexOf('function syncMissions')));
  assert.match(sync, /if \(m\.kind === 'heartbeat'\) continue;/);
  assert.ok(!INDEX.includes('function armHeartbeat'));
  assert.doesNotMatch(INDEX, /\.\.\.HEARTBEAT_MISSION, lastFiredAt/, 'no seeding');
  assert.match(INDEX, /if \(!cfg2\.heartbeatRetired\) \{/);
  assert.match(INDEX, /missions\.filter\(\(m\) => m\.id !== HEARTBEAT_MISSION\.id && m\.kind !== 'heartbeat'\)/);
});

test('the digest settings are optional config with code defaults', () => {
  assert.match(CONFIG, /floorDigest\?: \{/);
  assert.match(INDEX, /\{ \.\.\.FLOOR_DIGEST_DEFAULTS, \.\.\.\(readConfig\(\)\.floorDigest \?\? \{\}\) \}/);
});
