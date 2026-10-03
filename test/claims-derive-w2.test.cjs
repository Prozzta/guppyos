'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..');
function loadTs(relative, localRequire = require) {
  const filename = path.join(ROOT, relative);
  const source = fs.readFileSync(filename, 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
  const loaded = { exports: {} };
  new Function('exports', 'require', 'module', js)(loaded.exports, localRequire, loaded);
  return loaded.exports;
}

const { derive } = loadTs('src/main/claims/derive.ts');
const { worldView } = loadTs('src/main/claims/world.ts', (name) =>
  name === './ttl' ? loadTs('src/main/claims/ttl.ts') : require(name));
const registry = {
  v: 1,
  namespaces: [{ pattern: 'fact.*', cardinality: 'single' }, { pattern: 'multi.*', cardinality: 'multi' }],
  keys: { 'fact.alias': { cardinality: 'single', addedAt: '2026-01-01T00:00:00.000Z', addedBy: 'human', aliasOf: 'fact.name' }, 'fact.name': { cardinality: 'single', addedAt: '2026-01-01T00:00:00.000Z', addedBy: 'human' } },
};

function claim(id, { key, source = 'self', text = id, at = '2026-01-01T00:00:00.000Z', wt = at, mac = `mac-${id}`, prev = '', ...extra } = {}) {
  return { v: 1, id, t: 'claim', kind: 'fact', ...(key ? { key } : {}), text, source, at, wt, agent: 'agent-a', mac, prev, ...extra };
}
function event(id, ev, targets, extra = {}) {
  return { v: 1, id, t: 'event', ev, targets, by: 'code', at: '2026-01-03T00:00:00.000Z', wt: '2026-01-03T00:00:00.000Z', agent: 'agent-a', mac: `mac-${id}`, prev: '', ...extra };
}
function stable(value) { return JSON.stringify(value); }

test('G2.1 rebuild after deleting claims-state.json is byte-identical', (t) => {
  const rows = [claim('a', { key: 'fact.name' }), claim('b', { key: 'fact.name', at: '2026-01-02T00:00:00.000Z' })];
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claims-state-')), 'claims-state.json');
  const first = stable(derive(rows, registry, { r4: false }));
  fs.writeFileSync(file, first, 'utf8');
  fs.unlinkSync(file);
  const rebuilt = stable(derive(rows, registry, { r4: false }));
  fs.writeFileSync(file, rebuilt, 'utf8');
  assert.equal(fs.readFileSync(file, 'utf8'), first);
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
});

test('G2.2 state retains every claim id and excludes event ids', () => {
  const rows = [claim('a'), claim('b'), event('e-sighting', 'sighting', ['a'])];
  const state = derive(rows, registry, { r4: false });
  assert.deepEqual(Object.keys(state.claims), ['a', 'b']);
  assert.equal(state.claims.a.sightings, 2);
});

test('G2.3 shuffled input order derives the same state while preserving the append-chain tail', () => {
  const rows = [
    claim('a', { key: 'fact.name', at: '2026-01-01T00:00:00.000Z', mac: 'h1', prev: '' }),
    claim('b', { key: 'fact.alias', at: '2026-01-02T00:00:00.000Z', mac: 'h2', prev: 'h1' }),
    event('e', 'sighting', ['b'], { mac: 'h3', prev: 'h2' }),
  ];
  const shuffled = [rows[1], rows[0], rows[2]]; // perturb input order, not the final append record
  assert.equal(stable(derive(rows, registry, { r4: false })), stable(derive(shuffled, registry, { r4: false })));
  assert.equal(derive(rows, registry, { r4: false }).ledgerHead, 'h3');
});

test('R1 sightings update count and time window without storing event ids', () => {
  const rows = [claim('a', { at: '2026-01-02T00:00:00.000Z' }), event('s', 'sighting', ['a'], { at: '2026-01-01T00:00:00.000Z' })];
  const state = derive(rows, registry, { r4: false });
  assert.equal(state.claims.a.sightings, 2);
  assert.equal(state.claims.a.firstAt, '2026-01-01T00:00:00.000Z');
  assert.equal(state.claims.a.lastAt, '2026-01-02T00:00:00.000Z');
});

test('R2 tie-breaks equal event time by write time before id', () => {
  const state = derive([
    claim('new-write', { key: 'fact.name', at: '2026-01-01T00:00:00.000Z', wt: '2026-01-02T00:00:00.000Z' }),
    claim('old-write', { key: 'fact.name', at: '2026-01-01T00:00:00.000Z', wt: '2026-01-01T00:00:00.000Z' }),
  ], registry, { r4: false });
  assert.equal(state.claims['old-write'].status, 'superseded');
  assert.equal(state.claims['old-write'].supersededBy, 'new-write');
  assert.equal(state.claims['new-write'].status, 'live');
});

test('R2 uses bitemporal order, alias cardinality, and never lets mail supersede self/human', () => {
  const rows = [
    claim('old', { key: 'fact.name', at: '2026-01-01T00:00:00.000Z' }),
    claim('mail', { key: 'fact.alias', source: 'mail:m1', at: '2026-01-03T00:00:00.000Z' }),
    claim('new', { key: 'fact.name', source: 'human', at: '2026-01-02T00:00:00.000Z' }),
    claim('multi-a', { key: 'multi.same' }), claim('multi-b', { key: 'multi.same', at: '2026-01-04T00:00:00.000Z' }),
  ];
  const state = derive(rows, registry, { r4: false });
  assert.equal(state.claims.old.status, 'superseded');
  assert.equal(state.claims.old.supersededBy, 'new');
  assert.equal(state.claims.new.status, 'live');
  assert.equal(state.claims.mail.status, 'live');
  assert.deepEqual(state.conflicts, [{ a: 'mail', b: 'new', rule: 'R2-mail' }]);
  assert.equal(state.claims['multi-a'].status, 'live');
  assert.equal(state.claims['multi-b'].status, 'live');
});

test('R2 protects legacy from mail and lets a newer owner claim supersede older mail without conflict', () => {
  const mailNew = derive([
    claim('legacy', { key: 'fact.name', source: 'legacy' }),
    claim('mail-new', { key: 'fact.name', source: 'mail:god', at: '2026-01-02T00:00:00.000Z' }),
  ], registry, { r4: false });
  assert.equal(mailNew.claims.legacy.status, 'live');
  assert.equal(mailNew.claims['mail-new'].status, 'live');
  assert.deepEqual(mailNew.conflicts, [{ a: 'legacy', b: 'mail-new', rule: 'R2-mail' }]);

  const ownerNew = derive([
    claim('mail-old', { key: 'fact.name', source: 'mail:m1' }),
    claim('self-new', { key: 'fact.name', source: 'self', at: '2026-01-02T00:00:00.000Z' }),
  ], registry, { r4: false });
  assert.equal(ownerNew.claims['mail-old'].status, 'superseded');
  assert.equal(ownerNew.claims['self-new'].status, 'live');
  assert.deepEqual(ownerNew.conflicts, []);
});

test('R3 applies explicit supersedes and retracts but protects self/human from poisoned mail', () => {
  const rows = [
    claim('self'), claim('mail-source', { source: 'mail:m1', supersedes: ['self'], retracts: ['human'] }), claim('human', { source: 'human' }),
    claim('replacement', { supersedes: ['self'] }),
  ];
  const state = derive(rows, registry, { r4: false });
  assert.equal(state.claims.self.status, 'superseded');
  assert.equal(state.claims.self.supersededBy, 'replacement');
  assert.equal(state.claims.human.status, 'live');
});

test('R3 mail supersede is blocked for legacy; reconcile answers clear pairs and apply [loser, winner]', () => {
  const blocked = derive([
    claim('legacy', { source: 'legacy' }),
    claim('bad-mail', { source: 'mail:m1', supersedes: ['legacy'] }),
  ], registry, { r4: false });
  assert.equal(blocked.claims.legacy.status, 'live');

  const rows = [
    claim('mail', { key: 'fact.name', source: 'mail:m1', at: '2026-01-02T00:00:00.000Z' }),
    claim('self', { key: 'fact.name' }),
    event('answer', 'reconcile-answer', ['mail', 'self'], { answer: 'supersedes' }),
  ];
  const answered = derive(rows, registry, { r4: false });
  assert.equal(answered.claims.mail.status, 'superseded');
  assert.equal(answered.claims.mail.supersededBy, 'self');
  assert.deepEqual(answered.conflicts, []);

  const keepBoth = derive([
    ...rows.slice(0, 2), event('keep', 'reconcile-answer', ['mail', 'self'], { answer: 'keep-both' }),
  ], registry, { r4: false });
  assert.equal(keepBoth.claims.mail.status, 'live');
  assert.equal(keepBoth.claims.self.status, 'live');
  assert.deepEqual(keepBoth.conflicts, []);

  const dismissed = derive([
    ...rows.slice(0, 2), event('dismiss', 'dismiss', ['mail', 'self']),
  ], registry, { r4: false });
  assert.deepEqual(dismissed.conflicts, []);
});

test('accept hardens a soft supersede; a later soft event never downgrades hard superseded', () => {
  const accepted = derive([
    claim('old'), claim('new'),
    event('soft', 'soft-supersede', ['old', 'new']),
    event('accept', 'accept', ['old', 'new'], { at: '2026-01-04T00:00:00.000Z', wt: '2026-01-04T00:00:00.000Z' }),
  ], registry, { r4: false });
  assert.equal(accepted.claims.old.status, 'superseded');
  assert.equal(accepted.claims.old.supersededBy, 'new');

  const hardThenSoft = derive([
    claim('old'), claim('new'),
    claim('explicit', { supersedes: ['old'] }),
    event('soft', 'soft-supersede', ['old', 'new']),
  ], registry, { r4: false });
  assert.equal(hardThenSoft.claims.old.status, 'superseded');
});

test('revert makes its targeted soft-supersede event inert', () => {
  const rows = [
    claim('old'), claim('new'),
    event('soft', 'soft-supersede', ['old', 'new']),
    event('undo', 'revert', ['soft'], { at: '2026-01-04T00:00:00.000Z', wt: '2026-01-04T00:00:00.000Z' }),
  ];
  const state = derive(rows, registry, { r4: false });
  assert.equal(state.claims.old.status, 'live');
  assert.equal(state.claims.old.supersededBy, undefined);
});

test('chain head follows append order even when the last append is backdated', () => {
  const rows = [
    claim('first', { at: '2026-01-02T00:00:00.000Z', wt: '2026-01-02T00:00:00.000Z', mac: 'mac-first' }),
    claim('last-append', { at: '2026-01-01T00:00:00.000Z', wt: '2026-01-03T00:00:00.000Z', mac: 'mac-last' }),
  ];
  assert.equal(derive(rows, registry, { r4: false }).ledgerHead, 'mac-last');
});

test('R4 applies inferred supersedes only when enabled; R8 purge keeps a tombstone', () => {
  const rows = [claim('old'), claim('new'), event('r4', 'inferred-supersede', ['old', 'new'], { rule: 'R4@0.92' }), event('purge', 'purge', ['new'], { by: 'human' })];
  assert.equal(derive(rows, registry, { r4: false }).claims.old.status, 'live');
  const enabled = derive(rows, registry, { r4: true });
  assert.equal(enabled.claims.old.status, 'superseded');
  assert.equal(enabled.claims.new.status, 'purged');
  assert.equal(Object.keys(enabled.claims).length, 2);
  assert.deepEqual(enabled.conflicts, []); // R5 candidates are W3/W5-owned, not inferred by derive.
});

test('G2.4 derive has no embedder dependency and remains deterministic with a throwing stub installed', () => {
  const previous = globalThis.embedder;
  globalThis.embedder = () => { throw new Error('derive must not call an embedder'); };
  try {
    const rows = [claim('a'), claim('b')];
    assert.equal(stable(derive(rows, registry, { r4: false })), stable(derive(rows, registry, { r4: false })));
  } finally {
    if (previous === undefined) delete globalThis.embedder;
    else globalThis.embedder = previous;
  }
});

test('G2.6 10k distinct claims derive under 200ms', () => {
  const rows = Array.from({ length: 10_000 }, (_, index) => claim(`c${String(index).padStart(5, '0')}`, { key: `fact.k${index}`, mac: `m${index}` }));
  const start = process.hrtime.bigint();
  const state = derive(rows, registry, { r4: false });
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  assert.equal(Object.keys(state.claims).length, 10_000);
  assert.ok(elapsedMs < 200, `derive took ${elapsedMs.toFixed(1)}ms`);
});

test('R2 remains bounded for a hot single key at the 10k-claim scale', () => {
  const rows = Array.from({ length: 10_000 }, (_, index) => claim(`h${String(index).padStart(5, '0')}`, {
    key: 'fact.hot', at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(), mac: `mh${index}`,
  }));
  const start = process.hrtime.bigint();
  const state = derive(rows, registry, { r4: false });
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  assert.equal(state.claims.h09999.status, 'live');
  assert.ok(elapsedMs < 200, `single-key derive took ${elapsedMs.toFixed(1)}ms`);
});

test('R6/R7 world facts are view-time flags; counters only rank and never alter ClaimsState', () => {
  const rows = [
    { ...claim('a'), ttl: 'until:2026-01-02T00:00:00.000Z', refs: [{ type: 'file', value: 'src/a.ts' }, { type: 'task', value: 'gone' }] },
    { ...claim('b'), refs: [{ type: 'commit', value: 'deadbeef' }] },
  ];
  const state = derive(rows, registry, { r4: false });
  const world = {
    now: '2026-01-03T00:00:00.000Z', taskStatus: () => null, fileExists: () => false,
    commitExists: () => false, fileChangedSince: (_file, since) => since <= '2026-01-02T00:00:00.000Z',
    cardOutcomes: { doneCard: 'helped', badCard: 'hurt' },
  };
  const view = worldView(state, rows, [
    { at: '2026-01-04T00:00:00.000Z', claim: 'a', op: 'hit', card: 'doneCard' },
    { at: '2026-01-05T00:00:00.000Z', claim: 'a', op: 'view', card: 'badCard' },
    { at: '2026-01-06T00:00:00.000Z', claim: 'b', op: 'helped' },
  ], world);
  assert.deepEqual(view.flags.a, ['changed-since', 'expired', 'stale-ref']);
  assert.deepEqual(view.flags.b, ['stale-ref']);
  assert.deepEqual(view.counters.a, { helped: 1, hurt: 1, lastSeen: '2026-01-05T00:00:00.000Z' });
  assert.deepEqual(view.counters.b, { helped: 1, hurt: 0, lastSeen: '2026-01-06T00:00:00.000Z' });
  assert.deepEqual(state.claims.a.status, 'live');
});

test('task ttl expires only when its task is done or cancelled', () => {
  const rows = [{ ...claim('task-ttl'), ttl: 'task:CL-17' }];
  const state = derive(rows, registry, { r4: false });
  const world = {
    now: '2026-01-03T00:00:00.000Z', taskStatus: (id) => id === 'CL-17' ? 'done' : null,
    fileExists: () => true, commitExists: () => true, fileChangedSince: () => false, cardOutcomes: {},
  };
  assert.deepEqual(worldView(state, rows, [], world).flags['task-ttl'], ['expired']);
  assert.equal(worldView(state, rows, [], { ...world, taskStatus: () => 'doing' }).flags['task-ttl'], undefined);
});
