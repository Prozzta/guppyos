'use strict';

// The manifest-driven station allocator. The pack declares the fill order
// (stations.seatOrder, captain first for the orchestrator) and a per-preset
// seat (builder.presets[].seat). Preset affinity wins: a generic agent holding
// that station moves to the next free one in the order.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const SA = loadTs('src/renderer/src/scene/themes/seatAllocator.ts');
const Mf = loadTs('src/renderer/src/scene/themes/manifest.ts');

// The Human's acceptance rule, as manifest data (seat and preset names are plain strings to the engine).
const manifest = () => Mf.validateManifest({
  schema: 1, id: 'seat-rule', label: 'Seat rule', sceneKind: 'stations', map: 'm.tmx', palette: { background: '#000000' },
  stations: {
    layer: 'Stations', entrance: 'Spawn', captain: 'Captain',
    seatOrder: ['Captain', 'Speck1', 'Speck2', 'Chair1', 'Chair2', 'Chair3', 'Chair4', 'Chair5', 'Chair6'],
  },
  navigation: {},
  spriteRenderer: { kind: 'sheet', sheet: 's.png', frameWidth: 32, frameHeight: 32, rows: { down: 0, up: 1, left: 4, right: 6, sitDown: 2, sitUp: 3, sitLeft: 5, sitRight: 7 } },
  builder: { presets: [{ id: 'sele', seat: 'Speck1' }, { id: 'jackov', seat: 'Speck2' }] },
});

const alloc = () => {
  const r = manifest();
  assert.deepEqual(r.diagnostics.filter((d) => d.level === 'error'), []);
  return new SA.SeatAllocator(SA.seatRulesFrom(r.manifest));
};

test('the Human\'s case: generic, generic -> Speck1, Speck2; a Sele joins -> Sele takes Speck1 and the generic moves to Chair1', () => {
  const A = alloc();
  assert.deepEqual(A.join({ id: 'g1' }), [{ agentId: 'g1', from: null, to: 'Speck1' }]);
  assert.deepEqual(A.join({ id: 'g2' }), [{ agentId: 'g2', from: null, to: 'Speck2' }]);
  assert.deepEqual(A.join({ id: 'sele-1', presetId: 'sele' }), [
    { agentId: 'sele-1', from: null, to: 'Speck1' },
    { agentId: 'g1', from: 'Speck1', to: 'Chair1' },
  ]);
  assert.deepEqual(A.snapshot(), { Speck1: 'sele-1', Speck2: 'g2', Chair1: 'g1' });
});

test('captain first, and only for the orchestrator', () => {
  const A = alloc();
  A.join({ id: 'g1' });
  assert.equal(A.seat('g1'), 'Speck1'); // a generic never takes the captain's station
  A.join({ id: 'boss', orchestrator: true });
  assert.equal(A.seat('boss'), 'Captain');
});

const table = [
  // [joins in order, expected station per agent]
  [[['j', 'jackov'], ['g1'], ['g2']], { j: 'Speck2', g1: 'Speck1', g2: 'Chair1' }],
  [[['g1'], ['g2'], ['j', 'jackov']], { g1: 'Speck1', j: 'Speck2', g2: 'Chair1' }],
  [[['g1'], ['g2'], ['s', 'sele'], ['j', 'jackov']], { s: 'Speck1', j: 'Speck2', g1: 'Chair1', g2: 'Chair2' }],
  [[['s1', 'sele'], ['s2', 'sele']], { s1: 'Speck1', s2: 'Speck2' }], // a second Sele does not evict the first; it fills in order
  [[['x', 'unknown-preset'], ['g']], { x: 'Speck1', g: 'Speck2' }], // a preset without a seat is generic
];
for (const [joins, want] of table) {
  test(`order table: ${joins.map((j) => j.join(':')).join(', ')}`, () => {
    const A = alloc();
    for (const [id, presetId] of joins) A.join({ id, presetId });
    assert.deepEqual(Object.fromEntries(Object.keys(want).map((id) => [id, A.seat(id)])), want);
  });
}

test('full house: the overflow waits and takes the first station freed; a freed preset seat goes to its preset', () => {
  const A = alloc();
  const ids = ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8'];
  for (const id of ids) A.join({ id });
  assert.equal(A.seat('g8'), 'Chair6');
  A.join({ id: 'late' });
  assert.equal(A.seat('late'), null);
  assert.deepEqual(A.leave('g3'), [{ agentId: 'g3', from: 'Chair1', to: null }, { agentId: 'late', from: null, to: 'Chair1' }]);
  // a Sele arriving at a full house still gets its seat; the generic there waits
  const ch = A.join({ id: 's', presetId: 'sele' });
  assert.deepEqual(ch, [{ agentId: 's', from: null, to: 'Speck1' }, { agentId: 'g1', from: 'Speck1', to: null }]);
  A.leave('g5');
  assert.equal(A.seat('g1'), 'Chair3');
});

test('a station the map does not offer is never assigned', () => {
  const r = manifest();
  const A = new SA.SeatAllocator(SA.seatRulesFrom(r.manifest, ['Captain', 'Speck2', 'Chair1']));
  A.join({ id: 's', presetId: 'sele' });
  A.join({ id: 'g' });
  assert.deepEqual(A.snapshot(), { Speck2: 's', Chair1: 'g' });
});

test('a freed preset seat goes to a waiting agent of that preset before earlier waiting generics', () => {
  // a full house; then a Sele waits behind three generics
  const B = alloc();
  for (const id of ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8']) B.join({ id });
  B.join({ id: 'gw' });
  B.join({ id: 'hold', presetId: 'jackov' }); // takes Speck2, g2 waits
  B.join({ id: 'sw', presetId: 'sele' }); // takes Speck1, g1 waits
  B.join({ id: 'sw2', presetId: 'sele' }); // Speck1 is a Sele's: sw2 waits behind gw, g2, g1
  const ch = B.leave('sw');
  assert.deepEqual(ch, [{ agentId: 'sw', from: 'Speck1', to: null }, { agentId: 'sw2', from: null, to: 'Speck1' }]);
});

test('a seated Sele moves up when Speck1 frees; the longest-seated first; its chair goes to the hand-out', () => {
  const A = alloc();
  A.join({ id: 's1', presetId: 'sele' }); // Speck1
  A.join({ id: 'g1' }); // Speck2
  A.join({ id: 's2', presetId: 'sele' }); // Chair1
  A.join({ id: 's3', presetId: 'sele' }); // Chair2
  assert.deepEqual(A.snapshot(), { Speck1: 's1', Speck2: 'g1', Chair1: 's2', Chair2: 's3' });
  assert.deepEqual(A.leave('s1'), [
    { agentId: 's1', from: 'Speck1', to: null },
    { agentId: 's2', from: 'Chair1', to: 'Speck1' },
  ]);
  A.join({ id: 'g2' });
  assert.equal(A.seat('g2'), 'Chair1', 'the freed chair is handed out in order');
  // a waiting Sele still comes before a seated one
  const B = alloc();
  for (const id of ['s1', 's2']) B.join({ id, presetId: 'sele' }); // Speck1, Speck2
  for (const id of ['g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7']) B.join({ id }); // Chair1..6 full, g7 waits
  B.join({ id: 'sw', presetId: 'sele' }); // waits
  const ch = B.leave('s1');
  assert.deepEqual(ch.slice(0, 2), [{ agentId: 's1', from: 'Speck1', to: null }, { agentId: 'sw', from: null, to: 'Speck1' }]);
  assert.equal(B.seat('s2'), 'Speck2', 'the seated Sele stays put');
});

test('move-up never takes the orchestrator off the captain\'s station, whatever its preset', () => {
  const A = alloc();
  A.join({ id: 'g1' }); // Speck1
  A.join({ id: 'boss', orchestrator: true, presetId: 'sele' }); // Captain
  assert.deepEqual(A.leave('g1'), [{ agentId: 'g1', from: 'Speck1', to: null }]);
  assert.equal(A.seat('boss'), 'Captain');
});

test('move-up runs when a preset seat frees, not when its holder\'s preset changes away (documented on join)', () => {
  const A = alloc();
  A.join({ id: 's1', presetId: 'sele' }); // Speck1
  A.join({ id: 's2', presetId: 'sele' }); // Speck2
  assert.deepEqual(A.join({ id: 's1' }), []); // s1 drops the preset and keeps Speck1
  assert.deepEqual(A.snapshot(), { Speck1: 's1', Speck2: 's2' });
  assert.deepEqual(A.leave('s1').at(-1), { agentId: 's2', from: 'Speck2', to: 'Speck1' }); // it moves up once Speck1 frees
});

test('fuzz: random joins and leaves keep every seat rule', () => {
  const rng = (seed) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const order = ['Captain', 'Speck1', 'Speck2', 'Chair1', 'Chair2', 'Chair3', 'Chair4', 'Chair5', 'Chair6'];
  const pool = [
    { id: 'm', orchestrator: true }, { id: 's1', presetId: 'sele' }, { id: 's2', presetId: 'sele' }, { id: 's3', presetId: 'sele' },
    { id: 'j1', presetId: 'jackov' }, { id: 'j2', presetId: 'jackov' },
    ...Array.from({ length: 8 }, (_, i) => ({ id: 'g' + i })),
  ];
  for (let seed = 1; seed <= 60; seed++) {
    const r = rng(seed), A = alloc(), here = new Map(), log = [];
    for (let step = 0; step < 80; step++) {
      const a = pool[Math.floor(r() * pool.length)];
      if (here.has(a.id)) { A.leave(a.id); here.delete(a.id); log.push('-' + a.id); } else { A.join(a); here.set(a.id, a); log.push('+' + a.id); }
      const snap = A.snapshot(), at = (id) => A.seat(id), why = `seed ${seed}: ${log.join(' ')} -> ${JSON.stringify(snap)}`;
      const seated = [...here.keys()].filter(at);
      assert.equal(new Set(seated.map(at)).size, seated.length, 'one agent per seat: ' + why);
      assert.ok(Object.values(snap).every((id) => here.has(id)), 'only present agents hold seats: ' + why);
      if (snap.Captain) assert.equal(snap.Captain, 'm', 'the captain is the orchestrator\'s: ' + why);
      if (here.has('m')) assert.equal(at('m'), 'Captain', why);
      const free = order.filter((s) => s !== 'Captain' && !snap[s]);
      if (free.length) assert.ok([...here.values()].every((x) => at(x.id) || x.orchestrator), 'nobody waits while a chair is free: ' + why);
      for (const [pid, seat] of [['sele', 'Speck1'], ['jackov', 'Speck2']]) {
        if ([...here.values()].some((x) => x.presetId === pid)) assert.equal(here.get(snap[seat])?.presetId, pid, `${seat} is a ${pid}'s while one is aboard: ${why}`);
      }
    }
  }
});
