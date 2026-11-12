const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTs } = require('./load-ts.cjs');
const { ClaimsBootstrap } = loadTs('src/main/claims/bootstrap.ts');

test('bootstrap records busy receipts, retries them, and never repeats completed imports', async () => {
  let state = null; let busy = new Set(['b']); const imports = []; let seeded = 0;
  const b = new ClaimsBootstrap({ now: () => 10 + imports.length, activeAgents: () => ['b', 'a'], isIdle: (a) => !busy.has(a),
    seedDefault: () => seeded++, importOne: async (a) => { imports.push(a); return {}; }, load: () => state, save: (s) => { state = structuredClone(s); }, log: () => {} });
  await b.run();
  assert.deepEqual(imports, ['a']); assert.equal(state.agents.b.state, 'skipped');
  busy = new Set(); await b.run();
  assert.deepEqual(imports, ['a', 'b']); assert.equal(state.agents.b.state, 'done'); assert.equal(seeded, 2);
});

test('a live append may share ClaimStore serial work during import without duplicate bootstrap work', async () => {
  let state = null; const calls = []; let chain = Promise.resolve();
  const serial = (f) => { chain = chain.then(f); return chain; };
  const b = new ClaimsBootstrap({ now: () => 1, activeAgents: () => ['x'], isIdle: () => true, seedDefault: () => {},
    importOne: () => serial(async () => { calls.push('import'); }), load: () => state, save: (s) => { state = structuredClone(s); }, log: () => {} });
  const run = b.run(); await serial(async () => { calls.push('live-append'); }); await run;
  assert.deepEqual(calls, ['import', 'live-append']); assert.equal(state.agents.x.state, 'done');
});
