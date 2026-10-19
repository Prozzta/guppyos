'use strict';

/**
 * GTC M3 (d), Jim 6b9a89 ruling (d): the renderer's hook stream carries `fully_idle`, and an AGY
 * mid-chain Stop (`fully_idle: false`) keeps the tab working, so `canDeliverToAgent` (the 'owner'
 * path's idle gate) does not let the queue type into a running tool chain.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const { HookServer } = loadTs('src/main/hooks.ts');
const { stopKeepsTurnOpen, canDeliverToAgent } = loadTs('src/renderer/src/hooks/queueDelivery.ts');

const ID = 'agy-mtest0001';

function server() {
  const sent = [];
  const hive = { sockPath: () => null, codexHomeFor: () => null, recordSession: () => {}, appendLog: () => {}, registry: () => ({ agents: {} }), isGod: () => false, rosterContext: () => '', recordModel: () => {}, appendCostLedger: () => {} };
  const web = { send: (ch, m) => sent.push({ ch, ...m }) };
  const control = { shouldHalt: () => false, takeSteer: () => null, toolDecision: () => ({ deny: false }) };
  const s = new HookServer(hive, () => web, () => ({}), control, undefined, undefined, () => {});
  return { s, stops: () => sent.filter((m) => m.ch === 'hive:hookEvent' && m.event === 'Stop') };
}

test('emit: the Stop the renderer receives carries fully_idle as fullyIdle (false, true, absent)', () => {
  const { s, stops } = server();
  s.handle({ hook_event_name: 'Stop', agent_id: ID, fully_idle: false });
  s.handle({ hook_event_name: 'Stop', agent_id: ID, fully_idle: true });
  s.handle({ hook_event_name: 'Stop', agent_id: ID });
  assert.deepEqual(stops().map((m) => m.fullyIdle), [false, true, undefined]);
});

test('renderer: a fully_idle:false Stop keeps the turn open; every other Stop ends it', () => {
  assert.equal(stopKeepsTurnOpen({ event: 'Stop', fullyIdle: false }), true);
  assert.equal(stopKeepsTurnOpen({ event: 'Stop', fullyIdle: true }), false);
  assert.equal(stopKeepsTurnOpen({ event: 'Stop' }), false, 'Claude and Codex send no fully_idle: their Stop is the end');
  assert.equal(stopKeepsTurnOpen({ event: 'SubagentStop', fullyIdle: false }), false);
});

test('renderer: useHive applies it before the idle branch, as working, so canDeliverToAgent refuses', () => {
  const src = codeOnly(readSource('src/renderer/src/hooks/useHive.ts'));
  const i = src.indexOf("} else if (e.event === 'Stop' || e.event === 'SubagentStop')");
  assert.ok(i > 0);
  const branch = src.slice(i, i + 900);
  const keep = branch.indexOf('stopKeepsTurnOpen(e)');
  const idle = branch.indexOf("status: 'idle'");
  assert.ok(keep > 0 && idle > keep, 'the keep-open check comes before the idle update');
  assert.match(branch.slice(keep, idle), /updateAgent\(e\.agentId, \{ status: 'working' \}\)/);
  assert.equal(canDeliverToAgent('working', 60_000, 12_000), false, 'working never delivers, however quiet');
});

test('preload: the hook event type declares fullyIdle', () => {
  const src = readSource('src/preload/index.ts');
  const at = src.indexOf('onHiveHookEvent: (');
  assert.ok(at > 0);
  assert.match(src.slice(at, at + 600), /fullyIdle\?: boolean/);
});
