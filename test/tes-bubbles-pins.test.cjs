'use strict';

// TES-BUBBLES-186 follow-up pins.  These deliberately inspect the mount/tick
// wiring rather than tes-raster: the behavior layer already exercises the
// bridge itself, while these keep the integration call sites from disappearing.
const test = require('node:test');
const assert = require('node:assert/strict');
const { readSource } = require('./read-source.cjs');

const FLOOR = 'src/renderer/src/scene/themes/StationFloor.tsx';

function one(source, from, to, name) {
  const hits = source.split(from).length - 1;
  assert.equal(hits, 1, `${name}: edit target must occur exactly once (got ${hits})`);
  return source.replace(from, to);
}

function pinBridgeLifecycle(source) {
  assert.match(source,
    /\(app as any\)\.__disposeHiveBubbles = bindHiveBubbles\(app, bubbles\);/,
    'M4c: the bridge disposer is stored on the Pixi app for unmount');
}

function pinSyncAndTick(source) {
  assert.match(source,
    /const thoughts = new Map\(bubbleThoughts\(agents, liveness, heavyLock\)\.map\(\(item\) => \[item\.id, item\.thought\]\)\);\s*removeUnrenderedBubbles\(bubbleIds, sprites, ids, bubbles\);/,
    'M7b: sync removes bubbles whose agents no longer render');
  assert.match(source,
    /const freshEvents = newerCrewEvents\(crew\.events, lastCrewEventAt\);/,
    'S1: tick projects only Crew events newer than its cursor');
  assert.match(source,
    /if \(freshEvents\.length\) \{\s*bubbles\.consumeSays\(crewSays\(freshEvents\), sayCursor\);\s*lastCrewEventAt = freshEvents\[freshEvents\.length - 1\]\.at;\s*\}/,
    'S3: tick advances the Crew-event cursor after consuming fresh events');
}

test('TES bubble mount, sync and tick wiring is present', () => {
  const source = readSource(FLOOR);
  pinBridgeLifecycle(source);
  pinSyncAndTick(source);
});

test('M4c, M7b, S1 and S3 source mutants die at their named pins', () => {
  const real = readSource(FLOOR);
  const mutants = [
    { name: 'M4c', pin: pinBridgeLifecycle,
      source: one(real, '(app as any).__disposeHiveBubbles = bindHiveBubbles(app, bubbles);', '', 'M4c') },
    { name: 'M7b', pin: pinSyncAndTick,
      source: one(real, 'removeUnrenderedBubbles(bubbleIds, sprites, ids, bubbles);', '', 'M7b') },
    { name: 'S1', pin: pinSyncAndTick,
      source: one(real, 'const freshEvents = newerCrewEvents(crew.events, lastCrewEventAt);', 'const freshEvents = crew.events;', 'S1') },
    { name: 'S3', pin: pinSyncAndTick,
      source: one(real, 'lastCrewEventAt = freshEvents[freshEvents.length - 1].at;', '', 'S3') }
  ];
  for (const mutant of mutants) {
    assert.throws(() => mutant.pin(mutant.source), assert.AssertionError,
      `${mutant.name} survived its integration pin`);
  }
});
