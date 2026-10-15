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
      if (CP.coffeeProps(crew).some((c) => c.id === 'q')) qMug = true;
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
