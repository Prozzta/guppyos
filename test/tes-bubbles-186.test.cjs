'use strict';
require('./tools/own-job.cjs');

const test = require('node:test');
const assert = require('node:assert/strict');
const ts = require('typescript');
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');

const MODEL = loadTs('src/renderer/src/scene/themes/bubbleModel.ts');
const { heavyActivity } = loadTs('src/shared/activityView.ts');
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
  new Function('activityThought', 'heavyActivity', 'module', 'exports', output)(MODEL.activityThought, heavyActivity, mod, mod.exports);
  return mod.exports;
}

function stationFunctions(names, fakeWindow = {}) {
  const source = readSource(FLOOR);
  const file = ts.createSourceFile(FLOOR, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const wanted = new Set(names);
  const declarations = file.statements.filter((s) => ts.isFunctionDeclaration(s) && s.name && wanted.has(s.name.text));
  assert.equal(declarations.length, names.length, 'all StationFloor functions are present');
  const output = ts.transpileModule(`${declarations.map((s) => s.getText(file)).join('\n')}\nmodule.exports = { ${names.join(', ')} };`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const mod = { exports: {} };
  new Function('activityThought', 'heavyActivity', 'module', 'exports', 'window', output)(MODEL.activityThought, heavyActivity, mod, mod.exports, fakeWindow);
  return mod.exports;
}

function loadBubbleLayer() {
  const thoughts = [], envelopes = [];
  class Container {
    constructor() { this.children = []; this.destroyed = 0; }
    addChild(child) { this.children.push(child); return child; }
    destroy() { this.destroyed++; }
  }
  class ThoughtBubble {
    constructor() { this.container = new Container(); this.destroyed = 0; thoughts.push(this); }
    show() {} hide() {} setBounds() {} setView() {} setLift() {} setPosition() {}
    getLayout() { return null; }
    update() {}
    destroy() { this.destroyed++; }
  }
  class MessageEnvelope {
    constructor(...args) { this.args = args; this.container = new Container(); this.destroyed = 0; envelopes.push(this); }
    update() { return true; }
    destroy() { this.destroyed++; }
  }
  const source = readSource('src/renderer/src/scene/themes/BubbleLayer.ts');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} };
  const localRequire = (id) => {
    if (id === 'pixi.js') return { Container };
    if (id === '../office/ThoughtBubble') return { ThoughtBubble };
    if (id === '../office/MessageEnvelope') return { MessageEnvelope };
    if (id === './bubbleModel') return MODEL;
    throw new Error(`unexpected module ${id}`);
  };
  new Function('require', 'module', 'exports', output)(localRequire, mod, mod.exports);
  return { BubbleLayer: mod.exports.BubbleLayer, thoughts, envelopes };
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

test('4. BubbleLayer destroys removed thoughts and expired envelopes with Pixi stubbed', () => {
  const { BubbleLayer, thoughts, envelopes } = loadBubbleLayer();
  const bubbles = new BubbleLayer({ width: 320, height: 180 });
  bubbles.setThought('gone', { text: 'leaving' });
  bubbles.remove('gone');
  assert.equal(thoughts[0].destroyed, 1, 'remove frees a thought that may not have a sprite');
  bubbles.update(0, [{ id: 'from', x: 1, y: 2 }, { id: 'to', x: 3, y: 4 }], { scale: 1, x: 0, y: 0, resolution: 1 });
  bubbles.handoff('from', 'to', 'request', true);
  assert.deepEqual(envelopes[0].args, [{ id: 'from', x: 1, y: 2 }, { id: 'to', x: 3, y: 4 }, 'request', true]);
  bubbles.update(16, [], { scale: 1, x: 0, y: 0, resolution: 1 });
  assert.equal(envelopes[0].destroyed, 1, 'a finished envelope is freed rather than retained forever');
});

test('5. Station bridge subscribes, maps human targets, and cleans up the same listener and layer', () => {
  let listener, subscribes = 0, unsubscribes = 0;
  const fakeWindow = { cth: { onHiveMessage(fn) { subscribes++; listener = fn; return () => { unsubscribes++; }; } } };
  const { bindHiveBubbles } = stationFunctions(['bindHiveBubbles'], fakeWindow);
  const calls = [], app = {};
  let destroys = 0;
  const cleanup = bindHiveBubbles(app, { handoff: (...args) => calls.push(args), destroy: () => { destroys++; } });
  assert.equal(subscribes, 1);
  assert.equal(typeof app.__offMessage, 'function', 'the unsubscriber is retained for this mount');
  listener({ from: 'dwight', targets: ['andy', 'human'], act: 'request', needsHuman: true });
  assert.deepEqual(calls, [
    ['dwight', 'andy', 'request', true],
    ['dwight', '__human__', 'request', true]
  ]);
  cleanup();
  assert.equal(unsubscribes, 1);
  assert.equal(destroys, 1);
});

test('6. departures free rendered and unrendered bubbles, while repeated Crew events are fresh', () => {
  const { crewSays, newerCrewEvents, removeDepartedSprites, removeUnrenderedBubbles } = stationFunctions([
    'crewSays', 'newerCrewEvents', 'removeDepartedSprites', 'removeUnrenderedBubbles'
  ]);
  const removed = [], sprites = new Map([['rendered', { sprite: { destroyed: 0, destroy() { this.destroyed++; } } }]]);
  removeDepartedSprites(sprites, new Set(), { remove: (id) => removed.push(id) });
  const bubbleIds = new Set(['unrendered']);
  removeUnrenderedBubbles(bubbleIds, new Map(), new Set(), { remove: (id) => removed.push(id) });
  assert.deepEqual(removed, ['rendered', 'unrendered']);
  assert.equal(sprites.size, 0);
  assert.equal(bubbleIds.size, 0);
  const events = [
    { kind: 'errand', id: 'andy', at: 10 },
    { kind: 'errand', id: 'andy', at: 11 },
    { kind: 'chat', id: 'andy', with: 'dwight', at: 12 }
  ];
  assert.deepEqual(newerCrewEvents(events, 10), events.slice(1));
  const said = [];
  MODEL.consumeSays(crewSays(events), MODEL.createSayCursor(), (id, text) => said.push({ id, text }));
  assert.deepEqual(said, [
    { id: 'andy', text: 'stepping away' }, { id: 'andy', text: 'stepping away' },
    { id: 'andy', text: 'quick sync' }, { id: 'dwight', text: 'quick sync' }
  ]);
  // COFFEE-NEVER-186: coffee lines (brew, sip) come from coffeeProps, once per coffee state, not from here.
  assert.deepEqual(crewSays([{ kind: 'brew', id: 'andy', at: 13 }, { kind: 'sip', id: 'andy', at: 14 }]), []);
});
