'use strict';
require('./tools/own-job.cjs');
/**
 * STARTUP-FREEZE-104 A5 + A8 (Jim audit A5 SCALE-CLAIMS-EXPORT-DELTA, A8 SCALE-INGEST-ONCE, and the key
 * registry re-reads from his A3 gate run):
 *   - exportCache.ts writes the same bytes as exportLedger.ts (syncExport, appendStatusMarkers), across a
 *     1.5 MiB split, with archive-backed claims left out;
 *   - a second run reads no export file and stats only the part it appends to; unchanged archives are
 *     stat'd, never read; a deleted export file or an outside write to the open part is a full re-read;
 *   - the start-up sync (syncAllAsync) does nothing in the caller's turn, is sliced, writes nothing when the
 *     ledger read changed meanwhile (a purge's scrub), and an append waits for its agent's sync;
 *   - an append derives the ledger once (its "before" state is the previous append's "after");
 *   - newLegacyImportAsync offers the same drafts as newLegacyImport and reads no unchanged file twice;
 *   - loadRegistryShared: one frozen object while memory-keys.json is unchanged (racy rule);
 *   - main's wiring (source pins).
 * All fixture text is invented; temp folders only.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('./tools/test-temp.cjs');
const loadTs = require('./load-ts.cjs');

const ROOT = path.join(__dirname, '..');
const E = loadTs(path.join(ROOT, 'src', 'main', 'claims', 'exportLedger.ts'));
const C = loadTs(path.join(ROOT, 'src', 'main', 'claims', 'exportCache.ts'));
const W = loadTs(path.join(ROOT, 'src', 'main', 'claims', 'exportWiring.ts'));
const M = loadTs(path.join(ROOT, 'src', 'main', 'claims', 'migrate.ts'));
const REG = loadTs(path.join(ROOT, 'src', 'main', 'claims', 'registry.ts'));

const dir = () => tempDir('claims-a5-');
const render = (r) => `- ${r.at.slice(0, 10)} ${r.t === 'claim' ? r.text : 'event'} [c:${r.id}]`;

/** An archive with `n` entries; returns its entries' sha256 (the import's hash) by index. */
function writeArchive(d, name, n, tag) {
  const text = `# Memory archive\n\n${Array.from({ length: n }, (_, i) => `- 2026-09-0${1 + (i % 9)} archived ${tag} note ${i}`).join('\n')}\n`;
  fs.writeFileSync(path.join(d, name), text);
  return M.splitEntries(text, name).entries.map((e) => e.sha256);
}

function ledger(n, { textLen = 40, months = ['2026-10'], from = 0, legacy = null } = {}) {
  const records = [];
  const claims = {};
  for (let i = from; i < from + n; i++) {
    const id = `c${i}`;
    const month = months[i % months.length];
    const rec = { v: 1, t: 'claim', id, at: `${month}-0${1 + (i % 9)}T10:00:00.000Z`, wt: `${month}-03T12:00:00.000Z`, agent: 'ag-1', prev: '', mac: '', kind: 'fact', text: `invented fact ${i} ${'x'.repeat(textLen)}`, source: 'self' };
    if (legacy && legacy[i]) Object.assign(rec, { source: 'legacy', legacy: legacy[i] });
    records.push(rec);
    claims[id] = { id, status: 'live', sightings: 1, firstAt: '', lastAt: '', pinned: false, reasons: [] };
  }
  return { records, state: { v: 1, agent: 'ag-1', registryHash: '', ledgerHead: '', claims, conflicts: [] } };
}

const snapshot = (d) => Object.fromEntries(fs.readdirSync(d).sort().map((f) => [f, fs.readFileSync(path.join(d, f), 'utf8')]));
function copyDir(a, b) { for (const f of fs.readdirSync(a)) fs.copyFileSync(path.join(a, f), path.join(b, f)); }

/** fs calls on files of `d` while fn runs (readFileSync, statSync, fs.promises.readFile/stat). */
async function spyFs(d, fn) {
  const real = { rf: fs.readFileSync, st: fs.statSync, prf: fs.promises.readFile, pst: fs.promises.stat };
  const calls = [];
  const mine = (p) => typeof p === 'string' && path.resolve(p).startsWith(path.resolve(d) + path.sep);
  const note = (k, p) => { if (mine(p)) calls.push(`${k}:${path.basename(p)}`); };
  fs.readFileSync = function (p, ...a) { note('read', p); return real.rf.call(this, p, ...a); };
  fs.statSync = function (p, ...a) { note('stat', p); return real.st.call(this, p, ...a); };
  fs.promises.readFile = function (p, ...a) { note('read', p); return real.prf.call(this, p, ...a); };
  fs.promises.stat = function (p, ...a) { note('stat', p); return real.pst.call(this, p, ...a); };
  try { const r = await fn(); return { r, calls }; } finally { fs.readFileSync = real.rf; fs.statSync = real.st; fs.promises.readFile = real.prf; fs.promises.stat = real.pst; }
}

/** A ledger with archive-backed legacy claims (ruling 2): c0..c4 are in memory-archive-2026-09.md. */
function withArchive(d, n, opts = {}) {
  const shas = writeArchive(d, 'memory-archive-2026-09.md', 5, 'a');
  const legacy = {};
  for (let i = 0; i < 5; i++) legacy[i] = { file: 'memory-archive-2026-09.md', line: 3 + i, sha256: shas[i] };
  return ledger(n, { ...opts, legacy });
}

test('the cached export writes the same bytes as syncExport and appendStatusMarkers, across the 1.5 MiB split', async () => {
  const a = dir(), b = dir(), c = dir();
  // 900 lines of about 2 KiB: the month splits into parts; two months interleaved; archive-backed claims left out.
  for (const d of [a, b, c]) withArchive(d, 0);
  const { records, state } = withArchive(a, 900, { textLen: 4000, months: ['2026-10', '2026-11'] });
  // A partial export already there (a crash): the first 100 records.
  for (const r of records.slice(5, 100)) E.appendExport(a, r, state, render);
  copyDir(a, b); copyDir(a, c);
  const n1 = E.syncExport(a, records, state, render);
  const n2 = C.cachedSyncExport(b, records, state, render, C.newExportCache());
  const flush = new Set();
  const n3 = await C.cachedSyncExportAsync(c, records, state, render, C.newExportCache(), async () => {}, () => true, flush);
  await E.flushExport(flush);
  assert.equal(n1, 800);
  assert.equal(n2, n1);
  assert.equal(n3, n1);
  const sa = snapshot(a);
  assert.ok(Object.keys(sa).filter((f) => /-2\.md$/.test(f)).length >= 2, `both months split (${Object.keys(sa)})`);
  assert.ok(Object.values(sa).every((t) => Buffer.byteLength(t) <= E.EXPORT_SPLIT_BYTES), 'no part over the split');
  assert.ok(!Object.values(sa).join('').includes('[c:c0]'), 'an archive-backed claim stays out');
  assert.deepEqual(snapshot(b), sa);
  assert.deepEqual(snapshot(c), sa);
  // Markers: the same bytes too.
  const next = structuredClone(state); next.claims.c7.status = 'retracted'; next.claims.c9.status = 'superseded';
  assert.equal(E.appendStatusMarkers(a, 'ag-1', state, next, '2026-11-04T00:00:00.000Z'), 2);
  const cb = C.newExportCache();
  C.cachedExportedIds(b, cb);
  assert.equal(C.cachedStatusMarkers(b, 'ag-1', state, next, '2026-11-04T00:00:00.000Z', cb), 2);
  assert.deepEqual(snapshot(b), snapshot(a));
});

test('a second run reads no export file, stats only the part it appends to, and never re-reads an unchanged archive', async () => {
  const d = dir();
  const { records, state } = withArchive(d, 900, { textLen: 2000 });
  const cache = C.newExportCache();
  C.cachedSyncExport(d, records.slice(0, 899), state, render, cache);
  const parts = fs.readdirSync(d).filter((f) => E.EXPORT_RE.test(f));
  assert.ok(parts.length >= 2);
  const { r: n, calls } = await spyFs(d, () => C.cachedSyncExport(d, records, state, render, cache));
  assert.equal(n, 1);
  const last = E.exportFiles(d).at(-1);
  assert.deepEqual(calls.filter((x) => x.startsWith('read:')), [], 'no file read');
  assert.deepEqual(calls.filter((x) => x.startsWith('stat:memory-ledger-export')), [`stat:${last}`], 'only the open part is stat\'d');
  assert.deepEqual(calls.filter((x) => x.includes('memory-archive')), ['stat:memory-archive-2026-09.md'], 'the archive is stat\'d, not read');
  // The same bytes as the uncached path would have written.
  const ref = dir();
  withArchive(ref, 0);
  E.syncExport(ref, records, state, render);
  assert.deepEqual(snapshot(d), snapshot(ref));
});

test('a changed archive, a deleted export file or an outside write to the open part is read again', () => {
  const d = dir();
  const { records, state } = withArchive(d, 40);
  const cache = C.newExportCache();
  C.cachedSyncExport(d, records, state, render, cache);
  // The archive loses its entries (rewritten, other size): its claims come back (ruling 2, recomputed).
  fs.writeFileSync(path.join(d, 'memory-archive-2026-09.md'), '# Memory archive\n\n- something else entirely\n');
  assert.equal(C.cachedSyncExport(d, records, state, render, cache), 5);
  // A deleted export file: every record in it is exported again, as syncExport would.
  const f = E.exportFiles(d)[0];
  fs.rmSync(path.join(d, f));
  const ref = dir();
  copyDir(d, ref);
  const want = E.syncExport(ref, records, state, render);
  assert.equal(C.cachedSyncExport(d, records, state, render, cache), want);
  assert.deepEqual(snapshot(d), snapshot(ref));
  // An outside append to the open part (its size is not the one written): re-read, then the same bytes.
  const open = path.join(d, E.exportFiles(d).at(-1));
  fs.appendFileSync(open, '- 2026-10-09 typed by hand [c:c40]\n');
  fs.appendFileSync(path.join(ref, path.basename(open)), '- 2026-10-09 typed by hand [c:c40]\n');
  const more = ledger(3, { from: 40 });
  const all = [...records, ...more.records];
  const st = { ...state, claims: { ...state.claims, ...more.state.claims } };
  assert.equal(C.cachedSyncExport(d, all, st, render, cache), E.syncExport(ref, all, st, render));
  assert.deepEqual(snapshot(d), snapshot(ref));
});

test('an outside write that fills the open part moves the next line to a new part, as syncExport does', () => {
  const d = dir(), ref = dir();
  const { records, state } = ledger(700, { textLen: 2000 });   // about 1.4 MiB: one part, room for more
  const cache = C.newExportCache();
  C.cachedSyncExport(d, records.slice(0, 699), state, render, cache);
  copyDir(d, ref);
  const open = E.exportFiles(d).at(-1);
  const room = E.EXPORT_SPLIT_BYTES - fs.statSync(path.join(d, open)).size;
  assert.ok(room > 4096, `room left (${room})`);
  const pad = `${'y'.repeat(room - 1000)}\n`;   // typed by hand; leaves less room than one line
  for (const x of [d, ref]) fs.appendFileSync(path.join(x, open), pad);
  assert.equal(C.cachedSyncExport(d, records, state, render, cache), E.syncExport(ref, records, state, render));
  assert.deepEqual(snapshot(d), snapshot(ref));
  assert.equal(E.exportFiles(d).length, 2, 'the line went to part 2');
});

test('the async catch-up writes nothing when the ledger read changed meanwhile (a purge between two slices)', async () => {
  const d = dir();
  const { records, state } = ledger(50);
  const flush = new Set();
  const n = await C.cachedSyncExportAsync(d, records, state, render, C.newExportCache(), async () => {}, () => false, flush);
  assert.equal(n, null);
  assert.deepEqual(fs.readdirSync(d), []);
});

/** A ClaimExport over a fake store: `records` is the verified ledger; derive calls are counted. */
function wiring(d, records, extra = {}) {
  let derives = 0;
  const read = { current: { records, chain: 'ok' } };
  const rows = [];
  const ex = W.createClaimExport({
    level: () => 'writer',
    agentDir: () => d,
    readLedger: () => read.current,
    registry: () => REG.DEFAULT_KEY_REGISTRY,
    derive: (recs) => { derives++; return { v: 1, agent: 'ag-1', registryHash: '', ledgerHead: '', claims: Object.fromEntries(recs.filter((r) => r.t === 'claim').map((r) => [r.id, { id: r.id, status: 'live', sightings: 1, firstAt: '', lastAt: '', pinned: false, reasons: [] }])), conflicts: [] }; },
    view: () => ({ flags: {}, counters: {} }),
    log: (row) => rows.push(row),
    ...extra,
  });
  return { ex, read, rows, derives: () => derives };
}

test('an append derives the ledger once after the previous append (not three times)', async () => {
  const d = dir();
  const { records } = ledger(30);
  const w = wiring(d, records.slice(0, 28), { defer: (fn) => fn() });
  w.ex.onAppend('ag-1', 'c27', records[27]);
  await w.ex.drain();
  w.read.current = { records: [...w.read.current.records, records[28]], chain: 'ok' };
  const before = w.derives();
  w.ex.onAppend('ag-1', 'c28', records[28]);
  await w.ex.drain();
  assert.equal(w.derives() - before, 1, 'the "before" state is the previous append\'s');
  // A read with other record objects (a purge re-read) derives the "before" state again.
  w.read.current = { records: [...w.read.current.records.map((r) => ({ ...r })), records[29]], chain: 'ok' };
  const b2 = w.derives();
  w.ex.onAppend('ag-1', 'c29', records[29]);
  await w.ex.drain();
  assert.equal(w.derives() - b2, 2);
  assert.equal(fs.readFileSync(path.join(d, E.exportFiles(d)[0]), 'utf8').match(/\[c:c\d+\]/g).length, 30);
});

test('syncAllAsync: nothing in the caller\'s turn, sliced by the clock, an append waits for its agent\'s sync', async () => {
  const d = dir();
  const { records } = withArchive(d, 3000);
  let now = 0; let pauses = 0;
  const w = wiring(d, records, { clock: () => (now += 5), pause: () => { pauses++; return new Promise((r) => setImmediate(r)); } });
  const { r: p, calls } = await spyFs(d, () => { const p = w.ex.syncAllAsync(['ag-1'], 8); return { p }; });
  assert.deepEqual(calls, [], 'no fs call in the caller\'s turn');
  // An append queued during the sync runs after it (its line comes after every synced line).
  const extra = ledger(1, { from: 3000 }).records[0];
  w.read.current = { records: [...records, extra], chain: 'ok' };
  w.ex.onAppend('ag-1', extra.id, extra);
  const n = await p.p;
  await w.ex.drain();
  assert.ok(pauses >= 5, `paused between slices (${pauses})`);
  // The sync read the ledger after the caller's turn (with the extra record); the append then found it exported.
  assert.equal(n, 2996);
  assert.deepEqual(w.rows.map((r) => [r.kind, r.lines]), [['claims-export-sync', 2996], ['claims-export-append', 0]]);
  const ids = fs.readFileSync(path.join(d, E.exportFiles(d)[0]), 'utf8').match(/\[c:(c\d+)\]/g);
  assert.equal(ids.length, 2996, 'every non-archived record exported once');
  assert.equal(ids.at(-1), `[c:${extra.id}]`);
  // A ledger re-read between two slices (a purge's scrub): the sync writes nothing and says so.
  const d3 = dir();
  const w3 = wiring(d3, ledger(3000).records, { clock: () => (now += 5), pause: () => { w3.read.current = { ...w3.read.current }; return new Promise((r) => setImmediate(r)); } });
  assert.equal(await w3.ex.syncAllAsync(['ag-1'], 8), 0);
  assert.ok(w3.rows.some((r) => r.kind === 'claims-export-sync-deferred'));
  assert.deepEqual(E.exportFiles(d3), []);
  // Undisturbed, the sync itself exports.
  const d2 = dir();
  const w2 = wiring(d2, ledger(40).records);
  assert.equal(await w2.ex.syncAllAsync(['ag-1']), 40);
});

test('newLegacyImportAsync: the same drafts as newLegacyImport; an unchanged file is not read again', async () => {
  const d = dir();
  writeArchive(d, 'memory-archive-2026-08.md', 30, 'dup');
  writeArchive(d, 'memory-archive-2026-09.md', 30, 'dup');   // the same 30 entries again: counted by hash
  writeArchive(d, 'memory-archive-2026-10.md', 20, 'other');
  fs.writeFileSync(path.join(d, 'memory.md'), '# memory\n\n- a note in memory.md\n- another one\n');
  const old = Date.now() / 1000 - 3600;
  for (const f of fs.readdirSync(d)) fs.utimesSync(path.join(d, f), old, old);
  // The ledger holds the first file's entries once (so the second file's copies are new).
  const first = M.newLegacyImport(d, []).drafts.slice(0, 30);
  const held = first.map((x, i) => ({ v: 1, t: 'claim', id: `c${i}`, agent: 'ag-1', at: '', wt: '', kind: 'fact', text: x.text, source: 'legacy', legacy: x.legacy }));
  const want = M.newLegacyImport(d, held);
  const cache = new Map();
  const got = await M.newLegacyImportAsync(d, held, cache, async () => {});
  assert.deepEqual(got, want);
  assert.equal(want.drafts.length, 30 + 20 + 2);
  const { r: again, calls } = await spyFs(d, () => M.newLegacyImportAsync(d, held, cache, async () => {}));
  assert.deepEqual(again, want);
  assert.deepEqual(calls.filter((x) => x.startsWith('read:')), [], 'no file read on the second run');
  // A changed file is read again (and only it).
  fs.appendFileSync(path.join(d, 'memory-archive-2026-10.md'), '- a late archived note\n');
  fs.utimesSync(path.join(d, 'memory-archive-2026-10.md'), old + 60, old + 60);
  const { r: third, calls: c3 } = await spyFs(d, () => M.newLegacyImportAsync(d, held, cache, async () => {}));
  assert.deepEqual(third, M.newLegacyImport(d, held));
  assert.deepEqual(c3.filter((x) => x.startsWith('read:')), ['read:memory-archive-2026-10.md']);
  // A file written just now (racy) is never kept.
  fs.appendFileSync(path.join(d, 'memory.md'), '- fresh\n');
  await M.newLegacyImportAsync(d, held, cache, async () => {});
  assert.ok(!cache.has(path.join(d, 'memory.md')), 'a racy file is not kept');
});

test('loadRegistryShared: one frozen registry while memory-keys.json is unchanged; a change or a fresh write is read', () => {
  const root = dir();
  const p = REG.registryPath(root);
  const reg = structuredClone(REG.DEFAULT_KEY_REGISTRY);
  fs.writeFileSync(p, JSON.stringify(reg, null, 2));
  const old = Date.now() / 1000 - 3600;
  fs.utimesSync(p, old, old);
  const a = REG.loadRegistryShared(root);
  const { calls } = (() => { const real = fs.readFileSync; const calls = []; fs.readFileSync = function (q, ...x) { if (String(q) === p) calls.push(q); return real.call(this, q, ...x); }; try { REG.loadRegistryShared(root); } finally { fs.readFileSync = real; } return { calls }; })();
  assert.equal(calls.length, 0, 'an unchanged file is not read again');
  assert.equal(REG.loadRegistryShared(root), a);
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.namespaces), 'readers get a frozen registry');
  assert.ok(!Object.isFrozen(REG.loadRegistry(root)), 'loadRegistry still returns an editable copy');
  // A changed file (other size) is read again.
  reg.keys['x.y'] = { cardinality: 'single', by: 'test', at: '2026-11-12' };
  fs.writeFileSync(p, JSON.stringify(reg, null, 2));
  fs.utimesSync(p, old + 5, old + 5);
  const b = REG.loadRegistryShared(root);
  assert.notEqual(b, a);
  assert.ok(b.keys['x.y']);
  // A file written just now is read on every call (racy rule).
  fs.writeFileSync(p, JSON.stringify(reg, null, 1));
  const c1 = REG.loadRegistryShared(root);
  assert.notEqual(REG.loadRegistryShared(root), c1);
});

test('main wiring: the start-up export sync is syncAllAsync, the legacy cache is shared, readers use the shared registry', () => {
  const idx = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.ts'), 'utf8');
  assert.match(idx, /void warmed\.then\(\(\) => claimExport\(\)\.syncAllAsync\(claimLedgerAgents\(\)\)\)/);
  assert.match(idx, /const claimsLegacyCache: LegacyCache = new Map\(\);/);
  assert.equal(idx.split('legacyCache: claimsLegacyCache').length - 1, 2, 'the import and the reader watchers');
  assert.doesNotMatch(idx, /return root \? loadRegistry\(root\)/, 'no reader re-parses the registry');
  const store = fs.readFileSync(path.join(ROOT, 'src', 'main', 'claims', 'store.ts'), 'utf8');
  assert.equal(store.split('registry = loadRegistryShared(this.d.hiveRoot)').length - 1, 3);
  // A9 replaced the key check's own copy (a parse per new key) with the store's KeyRegistryWriter, whose check
  // leaves the working copy unchanged until commit (startup-freeze-a9).
  assert.match(store, /try \{ c = writer\.check\(draft\.key, agentId, wt\); \} catch \(e\) \{ return \{ error: `the key registry is unreadable/, 'the key check uses the writer');
  const rw = fs.readFileSync(path.join(ROOT, 'src', 'main', 'claims', 'readerWatch.ts'), 'utf8');
  assert.equal(rw.split('legacyCache: this.d.legacyCache').length - 1, 2);
});
