'use strict';

/**
 * IDLE-MEANS-IDLE-187, surface 3 (TES StationFloor): the station floor reads the heavy-job lock as
 * the office floor does. A LIVE agent the classifier calls idle but which has a heavy job in the
 * background is working at its station; one queued for, or holding a reservation on, the heavy slot
 * is waiting at its station: no TES coffee run, no mug in hand. Its thought is the lock's line.
 * The coffee is checked against the real Crew and coffeeProps, fed by StationFloor's own projection.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const ts = require('typescript');
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');
const H = require('./fixtures/themes/pack-helpers.cjs');

const ACT = loadTs('src/shared/activityView.ts');
const MODEL = loadTs('src/renderer/src/scene/themes/bubbleModel.ts');
const T = loadTs('src/renderer/src/scene/themes/tiled.ts');
const P = loadTs('src/renderer/src/scene/themes/packs.ts');
const Cr = loadTs('src/renderer/src/scene/themes/crew.ts');
const SA = loadTs('src/renderer/src/scene/themes/seatAllocator.ts');
const CP = loadTs('src/renderer/src/scene/themes/coffeeProps.ts');
const FLOOR = 'src/renderer/src/scene/themes/StationFloor.tsx';

/** StationFloor's own crewAgents and bubbleThoughts, with their real imports. */
function stationFunctions() {
  const source = readSource(FLOOR);
  const file = ts.createSourceFile(FLOOR, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const names = ['crewAgents', 'bubbleThoughts'];
  const decls = file.statements.filter((s) => ts.isFunctionDeclaration(s) && s.name && names.includes(s.name.text));
  assert.equal(decls.length, names.length);
  const out = ts.transpileModule(`${decls.map((d) => d.getText(file)).join('\n')}\nmodule.exports = { crewAgents, bubbleThoughts };`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const mod = { exports: {} };
  new Function('activityStatus', 'activityThought', 'heavyActivity', 'presetIdOf', 'module', 'exports', out)(
    ACT.activityStatus, MODEL.activityThought, ACT.heavyActivity, () => 'worker', mod, mod.exports);
  return mod.exports;
}

const NOW = Date.parse('2026-10-15T07:40:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const idleRec = (agentId) => ({ v: 1, agentId, incarnation: 1, lifecycle: 'LIVE', classification: 'IDLE', classifiedSince: NOW - 60_000, reason: 'stop', evidence: { sampledAt: NOW } });
const busyRec = (agentId) => ({ ...idleRec(agentId), classification: 'BUSY_PROGRESSING' });
const PACK = { manifest: { builder: 'tes', id: 'tes' } };
const LOCK = {
  holders: [{ agentId: 'bg', kind: 'suite', since: iso(NOW - 180_000), background: true }, { agentId: 'fg', kind: 'suite', since: iso(NOW), background: false }],
  waiters: [{ agentId: 'q', kind: 'suite', since: iso(NOW - 120_000), position: 1 }],
  reserved: [{ agentId: 'r', kind: 'build', until: '2026-10-15T07:45:00.000Z' }]
};
const agent = (id, extra) => ({ id, status: 'idle', isGod: false, ...extra });

test('TES crew: background = working at the station, queued/reserved = waiting at it; others as before', () => {
  const { crewAgents } = stationFunctions();
  const ids = ['bg', 'q', 'r', 'fg', 'idle', 'busy'];
  const liveness = Object.fromEntries(ids.map((id) => [id, id === 'busy' ? busyRec(id) : idleRec(id)]));
  const crew = crewAgents(PACK, ids.map((id) => agent(id)), liveness, LOCK);
  assert.deepEqual(Object.fromEntries(crew.map((c) => [c.id, c.status])), { bg: 'working', q: 'waiting', r: 'waiting', fg: 'idle', idle: 'idle', busy: 'working' });
  for (const id of ['bg', 'q', 'r']) assert.ok(Cr.atDesk(crew.find((c) => c.id === id).status), `${id} is at its station`);
  // No lock (the store before its first snapshot): unchanged.
  assert.deepEqual(crewAgents(PACK, [agent('q')], { q: idleRec('q') }, null).map((c) => c.status), ['idle']);
  // Not LIVE (an exited agent still listed in the lock): never overlaid.
  assert.deepEqual(crewAgents(PACK, [agent('q', { status: 'exited' })], { q: { ...idleRec('q'), lifecycle: 'EXITED' } }, LOCK).map((c) => c.status), ['exited']);
});

test('TES thought: the lock line, with the overlaid status; an idle agent outside the lock is unchanged', () => {
  const { bubbleThoughts } = stationFunctions();
  const ids = ['bg', 'q', 'r', 'idle'];
  const liveness = Object.fromEntries(ids.map((id) => [id, idleRec(id)]));
  const got = Object.fromEntries(bubbleThoughts(ids.map((id) => agent(id, { action: 'reading the plan' })), liveness, LOCK).map((t) => [t.id, t.thought && [t.thought.status, t.thought.text]]));
  assert.deepEqual(got, {
    bg: ['working', 'suite in background'],
    q: ['waiting', 'queued for heavy slot #1'],
    r: ['waiting', 'heavy slot reserved until 07:45Z'],
    idle: ['idle', 'reading the plan']
  });
});

test('Jim NIT 2: a WORKING agent who is also queued, or runs a background job, keeps its own action in its cloud', () => {
  const { bubbleThoughts } = stationFunctions();
  const lock = {
    holders: [{ agentId: 'bgw', kind: 'suite', since: iso(NOW - 60_000), background: true }],
    waiters: [{ agentId: 'qw', kind: 'suite', since: iso(NOW - 60_000), position: 1 }],
    reserved: [{ agentId: 'rw', kind: 'build', until: '2026-10-15T07:45:00.000Z' }]
  };
  const ids = ['bgw', 'qw', 'rw'];
  const liveness = Object.fromEntries(ids.map((id) => [id, busyRec(id)]));
  const got = Object.fromEntries(bubbleThoughts(ids.map((id) => agent(id, { action: `editing ${id}.ts` })), liveness, lock).map((t) => [t.id, [t.thought.status, t.thought.text]]));
  assert.deepEqual(got, { bgw: ['working', 'editing bgw.ts'], qw: ['working', 'editing qw.ts'], rw: ['working', 'editing rw.ts'] });
  // The same for a hook status already 'working' with no liveness record yet.
  const noRec = bubbleThoughts([agent('qw', { status: 'working', action: 'editing qw.ts' })], {}, lock);
  assert.deepEqual([noRec[0].thought.status, noRec[0].thought.text], ['working', 'editing qw.ts']);
});

let cached;
function realPack() {
  if (cached) return cached;
  const r = P.readPack(P.memoryFiles(H.readPackDir(H.NEUTRAL)));
  const f = P.finishPack(r.value, H.decodeImages(H.NEUTRAL, T.normPath, r.value.images), r.diagnostics);
  assert.ok(f.value, JSON.stringify(f.diagnostics));
  return (cached = f.value);
}
const rng = (seed) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const crewOf = (seed) => { const pk = realPack(), S = pk.scene; return new Cr.Crew(S, SA.seatRulesFrom(pk.manifest, S.seatOrder.map((s) => s.name)), rng(seed), { coffeeGap: [1000, 2000] }); };

test('real TES coffee: a queued crewmate stays at its station and never goes for coffee, while an idle one does', () => {
  const { crewAgents } = stationFunctions();
  const lock = { waiters: [{ agentId: 'q', kind: 'suite', since: iso(NOW), position: 1 }] };
  const liveness = { q: idleRec('q'), i: idleRec('i') };
  for (const seed of [3, 4, 7, 11]) {
    const crew = crewOf(seed);
    crew.sync(crewAgents(PACK, [agent('q'), agent('i')], liveness, lock));
    const q = crew.get('q'), i = crew.get('i');
    let iRan = false, qRan = false, qMug = false;
    for (let t = 0; t < 120_000; t += 50) {
      crew.tick(50);
      if (i.coffee) iRan = true;
      if (q.coffee) qRan = true;
      if (CP.coffeeProps(crew).some((c) => (c.id ?? c.owner) === 'q')) qMug = true;
    }
    assert.ok(iRan, `seed ${seed}: the control (idle, not in the lock) goes for coffee`);
    assert.equal(qRan, false, `seed ${seed}: the queued crewmate never starts a coffee run`);
    assert.equal(qMug, false, `seed ${seed}: no mug for the queued crewmate`);
    assert.ok(q.seated && !q.homeSit, `seed ${seed}: it waits seated at its station`);
  }
});

test('real TES coffee: queued mid-run ends the run (back to the station); leaving the lock lets it go again', () => {
  const { crewAgents } = stationFunctions();
  const liveness = { a: idleRec('a') };
  const crew = crewOf(4);
  crew.sync(crewAgents(PACK, [agent('a')], liveness, null));
  const a = crew.get('a');
  for (let t = 0; t < 120_000 && !a.coffee; t += 50) crew.tick(50);
  assert.ok(a.coffee, 'it set off for coffee while idle');
  crew.sync(crewAgents(PACK, [agent('a')], liveness, { reserved: [{ agentId: 'a', kind: 'suite', until: iso(NOW + 300_000) }] }));
  assert.equal(a.coffee, null, 'the reservation ends the run');
  let ran = false;
  for (let t = 0; t < 60_000; t += 50) { crew.tick(50); if (a.coffee) ran = true; }
  assert.equal(ran, false);
  assert.ok(a.seated, 'back at its station');
  crew.sync(crewAgents(PACK, [agent('a')], liveness, { waiters: [] }));
  for (let t = 0; t < 240_000 && !a.coffee; t += 50) crew.tick(50);
  assert.ok(a.coffee, 'out of the lock, it is idle again and goes for coffee');
});

test('StationFloor reads the lock from the store and re-syncs when only the lock changes', () => {
  const src = readSource(FLOOR);
  assert.match(src, /import \{ activityStatus, heavyActivity, type HeavyLockView \} from '@shared\/activityView';/);
  assert.match(src, /const \{ agents, liveness, heavyLock \} = useStore\.getState\(\);\s*crew\.sync\(crewAgents\(pack, agents, liveness, heavyLock\)\);/);
  assert.match(src, /bubbleThoughts\(agents, liveness, heavyLock\)/);
  assert.match(src, /if \(s\.agents !== prev\.agents \|\| s\.liveness !== prev\.liveness \|\| s\.heavyLock !== prev\.heavyLock\) sync\(\);/);
});

test('Jim SHOULD 1: a run cut by the lock while carrying an empty mug to refill parks it EMPTY; a finished brew still parks full', () => {
  const { crewAgents } = stationFunctions();
  const liveness = { a: idleRec('a') };
  const reserved = { reserved: [{ agentId: 'a', kind: 'suite', until: iso(NOW + 300_000) }] };
  const seen = { walking: 0, brewing: 0 };
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 13]) for (const cutAt of ['walking', 'brewing']) {
    const crew = crewOf(seed);
    crew.sync(crewAgents(PACK, [agent('a')], liveness, null));
    const a = crew.get('a');
    let ok = false;
    for (let t = 0; t < 900_000; t += 50) {
      crew.tick(50);
      if (a.coffee && a.cup && a.coffee.phase === cutAt && (cutAt !== 'brewing' || a.coffee.t > 500)) { ok = true; break; }
    }
    if (!ok) continue;
    seen[cutAt]++;
    crew.sync(crewAgents(PACK, [agent('a')], liveness, reserved));
    for (let t = 0; t < 30_000 && !a.seated; t += 50) crew.tick(50);
    crew.tick(50);
    assert.ok(a.seated, `${seed}/${cutAt}: back at its station`);
    const mug = CP.coffeeProps(crew).find((c) => c.kind === 'mug' && c.owner === 'a');
    assert.ok(mug, `${seed}/${cutAt}: the mug is parked`);
    assert.equal(mug.full, false, `${seed}/${cutAt}: a refill that was never brewed parks empty`);
    assert.equal(a.mug.full, 0);
    // Not held back: free of the lock, it may go for coffee again at once (no phantom full mug to drink).
    crew.sync(crewAgents(PACK, [agent('a')], liveness, null));
    a.coffeeNext = 0;
    let went = false;
    for (let t = 0; t < 120_000 && !went; t += 50) { crew.tick(50); went = !!a.coffee; }
    assert.ok(went, `${seed}/${cutAt}: free again, it goes for coffee`);
  }
  assert.ok(seen.walking >= 3 && seen.brewing >= 3, `the cut was exercised: ${JSON.stringify(seen)}`);
  // The control: a run whose brew finished parks a full mug, at once and for 60 s.
  const crew = crewOf(4);
  crew.sync(crewAgents(PACK, [agent('a')], liveness, null));
  const a = crew.get('a');
  let brewed = false;
  for (let t = 0; t < 900_000 && !brewed; t += 50) { crew.tick(50); brewed = !!(a.cup && a.fresh); }
  assert.ok(brewed, 'a brew finished');
  crew.sync(crewAgents(PACK, [agent('a')], liveness, reserved));
  for (let t = 0; t < 30_000 && !a.seated; t += 50) crew.tick(50);
  assert.ok(a.seated && a.mug && a.mug.full > crew.t, 'a finished brew parks full');
  assert.equal(a.fresh, false, 'the parked mug takes the brew with it');
});

/** BubbleLayer with fake pixi bubbles, as tes-bubbles-186 loads it. */
function bubbleLayer() {
  const shown = [];
  class Container { constructor() { this.children = []; } addChild(c) { this.children.push(c); return c; } destroy() {} }
  class ThoughtBubble {
    constructor() { this.container = new Container(); }
    show(text) { shown.push(text); } hide() { shown.push(null); } setBounds() {} setView() {} setLift() {} setPosition() {}
    getLayout() { return null; } update() {} destroy() {}
  }
  const out = ts.transpileModule(readSource('src/renderer/src/scene/themes/BubbleLayer.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} };
  const req = (id) => ({ 'pixi.js': { Container }, '../office/ThoughtBubble': { ThoughtBubble }, '../office/MessageEnvelope': { MessageEnvelope: class {} }, './bubbleModel': MODEL })[id];
  new Function('require', 'module', 'exports', out)(req, mod, mod.exports);
  return { layer: new mod.exports.BubbleLayer({ width: 320, height: 200 }), shown };
}

test('Jim NIT 1: the brew line goes when the run is cut, and the cloud shows the lock line at once', () => {
  const { crewAgents, bubbleThoughts } = stationFunctions();
  const liveness = { a: idleRec('a') };
  const reserved = { reserved: [{ agentId: 'a', kind: 'suite', until: '2026-10-15T07:45:00.000Z' }] };
  const crew = crewOf(4);
  crew.sync(crewAgents(PACK, [agent('a')], liveness, null));
  const a = crew.get('a');
  for (let t = 0; t < 900_000 && !(a.coffee && a.coffee.phase === 'brewing' && a.coffee.t > 300); t += 50) crew.tick(50);
  assert.equal(a.coffee && a.coffee.phase, 'brewing');
  const { layer, shown } = bubbleLayer();
  const said = new Map();
  const frame = () => {
    const coffee = CP.coffeeProps(crew);
    for (const item of CP.freshSays(coffee, said)) layer.say(item.id, item.text, { ttl: item.ttl, key: item.key });
    for (const [id, key] of CP.endedSays(coffee, said)) layer.unsay(id, key);
  };
  frame();
  const brewLine = shown.at(-1);
  assert.ok(brewLine && !/heavy/.test(brewLine), `the brew line shows: ${brewLine}`);
  // The lock cuts the run: the thought becomes the lock line; the next frame takes the brew line off.
  crew.sync(crewAgents(PACK, [agent('a')], liveness, reserved));
  const th = bubbleThoughts([agent('a')], liveness, reserved)[0].thought;
  layer.setThought('a', { text: th.text, tool: th.tool });
  assert.equal(shown.at(-1), brewLine, 'the say still holds the cloud until the frame');
  frame();
  assert.equal(shown.at(-1), 'heavy slot reserved until 07:45Z', 'no brew line over the lock line');
  assert.equal(said.size, 0, 'forgotten');
  // unsay is keyed: a different line (a chat) is not taken off by a stale key.
  layer.say('a', 'quick sync', { ttl: 2600 });
  layer.unsay('a', 'brew:a:0');
  assert.equal(shown.at(-1), 'quick sync');
});

test('NIT 1 wiring: StationFloor says coffee lines by key and takes ended ones off', () => {
  const src = readSource(FLOOR);
  assert.match(src, /for \(const item of freshSays\(coffee, said\)\) bubbles\.say\(item\.id, item\.text, \{ ttl: item\.ttl, key: item\.key \}\);\s*for \(const \[id, key\] of endedSays\(coffee, said\)\) bubbles\.unsay\(id, key\);/);
});
