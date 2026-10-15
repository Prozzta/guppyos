'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const ts = require('typescript');
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');

const MODEL = loadTs('src/renderer/src/scene/themes/bubbleModel.ts');
const FLOOR = 'src/renderer/src/scene/themes/StationFloor.tsx';
const LIVENESS = {
  v: 1, agentId: 'dwight', incarnation: 1, lifecycle: 'LIVE', classification: 'BUSY_PROGRESSING',
  classifiedSince: 0, reason: 'turn-started', evidence: { sampledAt: 0 }
};

function stationBubbleThoughts() {
  const source = readSource(FLOOR);
  const file = ts.createSourceFile(FLOOR, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const declaration = file.statements.find((s) => ts.isFunctionDeclaration(s) && s.name?.text === 'bubbleThoughts');
  assert.ok(declaration, 'StationFloor defines its liveness-aware bubble projection');
  const output = ts.transpileModule(`${declaration.getText(file)}\nmodule.exports = bubbleThoughts;`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const mod = { exports: {} };
  new Function('activityThought', 'module', 'exports', output)(MODEL.activityThought, mod, mod.exports);
  return mod.exports;
}

test('1. StationFloor updates an idle cloud to working when only its liveness changes', () => {
  const bubbleThoughts = stationBubbleThoughts();
  const agent = { id: 'dwight', status: 'idle', action: 'wire the bubble layer' };
  assert.deepEqual(bubbleThoughts([agent], { dwight: LIVENESS })[0].thought, {
    status: 'working', text: 'wire the bubble layer', tool: undefined
  });
  const idle = { ...LIVENESS, classification: 'IDLE' };
  assert.deepEqual(bubbleThoughts([agent], { dwight: idle })[0].thought, {
    status: 'idle', text: 'wire the bubble layer', tool: undefined
  });
});

test('2. rich statuses retain their own useful cloud text', () => {
  assert.deepEqual(MODEL.activityThought({ status: 'blocked', action: '' }, LIVENESS), {
    status: 'blocked', text: 'needs you'
  });
  assert.equal(MODEL.activityThought({ status: 'ghost' }, LIVENESS), null);
});

test('3. a replayed Crew/coffee say stream is consumed exactly once by its cursor', () => {
  const cursor = MODEL.createSayCursor();
  const said = [];
  const events = [{ key: 'brew:andy:1', id: 'andy', text: 'brewing coffee', ttl: 2600 }];
  MODEL.consumeSays(events, cursor, (id, text, options) => said.push({ id, text, options }));
  MODEL.consumeSays(events, cursor, (id, text, options) => said.push({ id, text, options }));
  assert.deepEqual(said, [{ id: 'andy', text: 'brewing coffee', options: { ttl: 2600 } }]);
});

test('4. the shared overlay reuses the Office ThoughtBubble and MessageEnvelope primitives', () => {
  const source = readSource('src/renderer/src/scene/themes/BubbleLayer.ts');
  assert.match(source, /import \{ MessageEnvelope, type MessageAct \} from '\.\.\/office\/MessageEnvelope';/);
  assert.match(source, /import \{ ThoughtBubble \} from '\.\.\/office\/ThoughtBubble';/);
  assert.match(source, /say\(id: string, text: string, options: BubbleSayOptions = \{\}\)/);
  assert.match(source, /new MessageEnvelope\(from, to, act, needsHuman\)/);
});

test('5. StationFloor keeps the live overlay above people and ticks it before a depth no-op', () => {
  const source = readSource(FLOOR);
  assert.match(source, /world\.addChild\(sortLayer\);[\s\S]*world\.addChild\(bubbles\.container\);/);
  assert.match(source, /bubbles\.update\(dt, anchors, world\.scale\.x\);[\s\S]*if \(depth === lastDepth\) return;/);
  assert.match(source, /window\.cth\.onHiveMessage[\s\S]*bubbles\.handoff/);
  assert.match(source, /bubbles\.consumeSays\(crewSays\(crew\.events\), sayCursor\);/);
});
