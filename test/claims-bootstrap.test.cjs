const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { ClaimsBootstrap, bootstrapMarkerFile, loadBootstrapMarker, saveBootstrapMarker } = loadTs('src/main/claims/bootstrap.ts');
const { ClaimStore } = loadTs('src/main/claims/store.ts');
const { SandboxKeyProvider, FileLedgerKeyRecord, KEY_RECORD_FILE } = loadTs('src/main/claims/keyProvider.ts');
const { makeW6Append } = loadTs('src/main/claims/w6Append.ts');
const { shadowImport } = loadTs('src/main/claims/ingest.ts');

test('bootstrap marker is retained atomically and ignores a malformed prior receipt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-bootstrap-'));
  try {
    const state = { version: 1, startedAt: 1, updatedAt: 2, agents: { a: { state: 'done', at: 2 } } };
    saveBootstrapMarker(root, state);
    assert.deepEqual(loadBootstrapMarker(root), state);
    assert.ok(fs.existsSync(bootstrapMarkerFile(root)), 'the completed marker remains for a no-op rerun');
    fs.writeFileSync(bootstrapMarkerFile(root), '{torn');
    assert.equal(loadBootstrapMarker(root), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

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

test('a live ClaimStore append remains intact when it arrives during the bootstrap import', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-bootstrap-live-'));
  const agent = 'ag-1'; let state = null;
  try {
    const dir = path.join(root, 'agents', agent); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'memory.md'), '# Memory\n\n## 2026-10-03\n- imported legacy fact\n');
    const store = new ClaimStore({ hiveRoot: root, keys: new SandboxKeyProvider(), keyRecord: new FileLedgerKeyRecord(path.join(`${root}-ud`, KEY_RECORD_FILE)), log: () => {}, alert: () => {} });
    const append = makeW6Append(store);
    const bootstrap = new ClaimsBootstrap({
      now: () => 1, activeAgents: () => [agent], isIdle: () => true, seedDefault: () => {},
      importOne: async (id) => { const r = await shadowImport({ hiveRoot: root, append, read: (a) => store.readLedger(a), log: () => {} }, id, { settle: true }); return { refused: r.refused.map((x) => x.error) }; },
      load: () => state, save: (next) => { state = structuredClone(next); }, log: () => {},
    });
    const importing = bootstrap.run();
    const live = append(agent, { t: 'claim', kind: 'fact', text: 'live append during import', source: 'self' }, 'w6-internal', { r5: true });
    const [liveResult] = await Promise.all([live, importing]);
    assert.equal(liveResult.ok, true);
    const texts = store.readLedger(agent).records.filter((r) => r.t === 'claim').map((r) => r.text);
    assert.ok(texts.includes('imported legacy fact'));
    assert.ok(texts.includes('live append during import'));
    assert.equal(state.agents[agent].state, 'done');
    store.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
