'use strict';
require('./tools/own-job.cjs');
/**
 * CL-READERWATCHER: a hand edit of memory.md while the app runs stays searchable.
 * For an agent at reader or writer level with a ledger, discovery searches its claims instead of
 * memory.md (sources.ts ledgerReplaced). Before this card only the S0 import at claims start moved
 * memory.md bullets into the ledger, so a bullet written while the app ran was out of search until
 * the next start. main now runs W6's ReaderWatcher for exactly those agents (claims/readerWatch.ts).
 * End to end with W1's real ClaimStore, the S0 import and W6's append; "searchable" is the store's
 * onAppend for the new claim, which is what schedules the index sync in main. All text is invented.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-readerwatch-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
const STORES = [];
const WATCHERS = [];
test.after(() => {
  for (const w of WATCHERS) w.stopAll();
  for (const s of STORES) s.close();
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const loadTs = require('./load-ts.cjs');
const ROOT = path.join(__dirname, '..');
const { ClaimStore } = loadTs(path.join(ROOT, 'src/main/claims/store.ts'));
const { SandboxKeyProvider, FileLedgerKeyRecord, KEY_RECORD_FILE } = loadTs(path.join(ROOT, 'src/main/claims/keyProvider.ts'));
const { importAtStart } = loadTs(path.join(ROOT, 'src/main/claims/startupImport.ts'));
const { makeW6Append } = loadTs(path.join(ROOT, 'src/main/claims/w6Append.ts'));
const I = loadTs(path.join(ROOT, 'src/main/claims/ingest.ts'));

const memory = (who) => `# Memory — ${who}\n\n## 2026-10-01 notes\n- an invented note of ${who}\n`;
let n = 0;
/** A hive with one agent per level, each with a memory.md; the real store; main's wiring shape. */
async function floor(levels = { 'ag-w': 'writer', 'ag-r': 'reader', 'ag-s': 'shadow', 'ag-o': 'off' }, memories = {}) {
  const root = path.join(JAIL, `hive-${++n}`);
  for (const a of Object.keys(levels)) { fs.mkdirSync(path.join(root, 'agents', a), { recursive: true }); fs.writeFileSync(path.join(root, 'agents', a, 'memory.md'), memories[a] ?? memory(a)); }
  const appended = [];
  const rows = [];
  const store = new ClaimStore({ hiveRoot: root, keys: new SandboxKeyProvider(), keyRecord: new FileLedgerKeyRecord(path.join(`${root}-userdata`, KEY_RECORD_FILE)), log: (r) => rows.push(r), alert: () => {},
    onAppend: (agentId, id, rec) => appended.push({ agentId, id, text: rec.text, source: rec.source }) });
  STORES.push(store);
  const level = (a) => levels[a] ?? 'off';
  const ingest = { append: makeW6Append(store), read: (a) => store.readLedger(a), log: (r) => rows.push(r) };
  await importAtStart({ hiveRoot: root, ...ingest, agents: () => Object.keys(levels), level });
  // main's claimLedgerAgents: agents with a segment, plus the anchored ones.
  const ledgerAgents = () => [...new Set([...fs.readdirSync(path.join(root, 'agents')).filter((a) => store.segments(a).length > 0), ...store.anchoredAgents()])];
  const RW = loadTs(path.join(ROOT, 'src/main/claims/readerWatch.ts'));
  const box = { root };
  const watchers = new RW.ReaderWatchers({ hiveRoot: () => box.root, agents: ledgerAgents, level, debounceMs: 100, ...ingest });
  WATCHERS.push(watchers);
  return { root, store, levels, appended, rows, watchers, box, ingest, RW };
}
const waitFor = async (fn, ms = 5000) => { const until = Date.now() + ms; while (Date.now() < until) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); } return fn(); };
const edit = (f, a, text) => fs.appendFileSync(path.join(f.root, 'agents', a, 'memory.md'), `- ${text}\n`);
const ledgerTexts = (f, a) => f.store.readLedger(a).records.filter((r) => r.t === 'claim').map((r) => r.text);

test('CL-READERWATCHER: a writer\'s and a reader\'s hand edit while the app runs reaches the ledger and the index (onAppend); shadow and off are not watched', async () => {
  const f = await floor();
  f.watchers.sync();
  assert.deepEqual(f.watchers.watching(), ['ag-r', 'ag-w'], 'only the agents whose memory.md has left search');
  await new Promise((r) => setTimeout(r, 300));   // the spawn scans: nothing new after the import
  const before = f.appended.length;
  const t0 = Date.now();
  edit(f, 'ag-w', '2026-10-15T12:00 a hand-written writer note');
  edit(f, 'ag-r', '2026-10-15T12:00 a hand-written reader note');
  edit(f, 'ag-s', '2026-10-15T12:00 a shadow note');
  assert.ok(await waitFor(() => f.appended.length >= before + 2), `appended ${f.appended.length - before}`);
  const ms = Date.now() - t0;
  assert.ok(ms < 5000, `searchable after ${ms} ms`);
  const got = f.appended.slice(before).map((x) => [x.agentId, x.text, x.source]).sort();
  assert.deepEqual(got, [['ag-r', '- 2026-10-15T12:00 a hand-written reader note', 'self'], ['ag-w', '- 2026-10-15T12:00 a hand-written writer note', 'self']]);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(f.appended.length, before + 2, 'nothing for the shadow agent (its memory.md is still searched itself)');
  assert.ok(!ledgerTexts(f, 'ag-s').includes('- 2026-10-15T12:00 a shadow note'));
});

test('CL-READERWATCHER: an edit before any watcher started is caught by the spawn scan; nothing is appended twice', async () => {
  const f = await floor({ 'ag-w': 'writer' });
  edit(f, 'ag-w', 'written between the import and the watcher');
  f.watchers.sync();
  assert.ok(await waitFor(() => f.appended.some((x) => x.text === '- written between the import and the watcher')));
  edit(f, 'ag-w', 'and one more');
  assert.ok(await waitFor(() => f.appended.some((x) => x.text === '- and one more')));
  await new Promise((r) => setTimeout(r, 400));
  const texts = ledgerTexts(f, 'ag-w');
  assert.equal(texts.filter((t) => t === '- written between the import and the watcher').length, 1);
  assert.equal(texts.filter((t) => t === '- and one more').length, 1);
});

test('CL-READERWATCHER: sync follows the levels, new ledgers and the hive root', async () => {
  // ag-n has no bullets yet, so the import gave it no ledger: its memory.md is still searched itself.
  const f2 = await floor({ 'ag-w': 'writer', 'ag-n': 'writer' }, { 'ag-n': '# Memory\n' });
  assert.equal(f2.store.segments('ag-n').length, 0);
  f2.watchers.sync();
  assert.deepEqual(f2.watchers.watching(), ['ag-w'], 'no ledger, no watcher');
  // ag-n gets a ledger mid-run (here: its S0 import of a first bullet): the next sync watches it.
  edit(f2, 'ag-n', 'first bullet of a new hire');
  await I.shadowImport({ hiveRoot: f2.root, ...f2.ingest }, 'ag-n');
  f2.watchers.sync();
  assert.deepEqual(f2.watchers.watching(), ['ag-n', 'ag-w']);
  const before = f2.appended.length;
  edit(f2, 'ag-n', 'a hand edit of the new hire');
  assert.ok(await waitFor(() => f2.appended.slice(before).some((x) => x.agentId === 'ag-n' && x.text === '- a hand edit of the new hire')));
  // A level change to off stops the watcher: the edit is not ingested.
  f2.levels['ag-w'] = 'off';
  f2.watchers.sync();
  assert.deepEqual(f2.watchers.watching(), ['ag-n']);
  const mid = f2.appended.length;
  edit(f2, 'ag-w', 'written after the switch to off');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(f2.appended.length, mid);
  // A new hive root stops every watcher of the old one.
  f2.box.root = null;
  f2.watchers.sync();
  assert.deepEqual(f2.watchers.watching(), []);
});

test('CL-READERWATCHER: a failing background scan is logged, not an unhandled rejection, and no scan runs after stop', async () => {
  const root = path.join(JAIL, `hive-${++n}`); const dir = path.join(root, 'agents', 'ag-1');
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'memory.md'), memory('ag-1'));
  const rows = []; let reads = 0; let fail = false;
  const deps = { hiveRoot: root, append: async () => ({ ok: true, id: 'x' }), read: () => { reads++; if (fail) throw new Error('invented read failure'); return { chain: 'ok', records: [] }; }, log: (r) => rows.push(r) };
  const unhandled = [];
  const on = (e) => unhandled.push(e);
  process.on('unhandledRejection', on);
  const w = new I.ReaderWatcher(deps, 'ag-1', 50);
  try {
    await w.start();
    fail = true;
    fs.appendFileSync(path.join(dir, 'memory.md'), '- a note that meets a failing read\n');
    assert.ok(await waitFor(() => rows.some((r) => r.kind === 'claims-watch-error' && /invented read failure/.test(r.error))), JSON.stringify(rows));
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(unhandled, []);
    w.stop();
    const after = reads;
    fs.appendFileSync(path.join(dir, 'memory.md'), '- written after stop\n');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(reads, after, 'no scan after stop');
  } finally { w.stop(); process.off('unhandledRejection', on); }
});

test('CL-READERWATCHER: stop() during a scan with a change queued behind it runs no further scan', async () => {
  const root = path.join(JAIL, `hive-${++n}`); const dir = path.join(root, 'agents', 'ag-1');
  fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'memory.md'), memory('ag-1'));
  let reads = 0; let release = null;
  const gate = () => new Promise((r) => { release = r; });
  const deps = { hiveRoot: root, read: () => { reads++; return { chain: 'ok', records: [] }; }, log: () => {},
    append: async () => { await gate(); return { ok: true, id: 'x' }; } };
  const w = new I.ReaderWatcher(deps, 'ag-1', 30);
  try {
    const first = w.start();                      // the spawn scan: its append waits at the gate
    assert.ok(await waitFor(() => release !== null));
    fs.appendFileSync(path.join(dir, 'memory.md'), '- queued behind the running scan\n');
    await new Promise((r) => setTimeout(r, 300)); // the debounced scan finds one running: one more is queued
    w.stop();
    const after = reads;
    for (let i = 0; i < 5; i++) { release?.(); release = null; await new Promise((r) => setTimeout(r, 50)); }
    await first;
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(reads, after, 'the queued scan did not run after stop');
  } finally { w.stop(); for (let i = 0; i < 5; i++) release?.(); }
});

test('CL-READERWATCHER wiring: main starts the watchers after the S0 import, at claims start and on a timer', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/main/index.ts'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(src, /const readerWatchers = new ReaderWatchers\(\{/);
  assert.match(src, /agents: \(\) => \(claimsEndpoint\(\) \? claimLedgerAgents\(\) : \[\]\),\n/);
  // god 886ed8: the mid-run import covers the same agents as the S0 import, and its settling syncs the index.
  assert.match(src, /candidates: \(\) => \{ const root = hive\.root\(\); return root && claimsEndpoint\(\) \? claimImportCandidates\(root\) : \[\]; \},/);
  assert.match(src, /onSettled: \(agentId\) => \{ claimsIndexSync\(\)\?\.schedule\(agentId\); \},\n\s+level: claimLevel,/);
  assert.match(src, /agents: \(\) => claimImportCandidates\(root\),\n\s+level: claimLevel,/, 'importAtStart uses the same candidates');
  const onAppend = src.slice(src.indexOf('onAppend: (agentId, id, rec) => {'), src.indexOf('claimExport().onAppend(agentId, id, rec);'));
  assert.match(onAppend, /memoryMdReplaced\(claimLevel\(agentId\)\) && !importSettled\(at, agentId\)\) void claimsImportReady\(\)\.then\(\(\) => readerWatchers\.ensureImported\(agentId\)\)/, 'a first claim starts the import');
  assert.match(src, /claimsImportReady\(\)\.then\(\(\) => readerWatchers\.sync\(\)/, 'only after the S0 import has settled');
  assert.match(src, /setInterval\(syncReaderWatchers, READER_WATCH_SYNC_MS\)/);
  const start = src.slice(src.indexOf('function claimsEndpoint('), src.indexOf('function claimsEndpoint(') + 6000);
  assert.match(start, /setImmediate\(syncReaderWatchers\)/, 'at claims start');
});

// god 886ed8: an agent raised to reader or writer mid-run, or given its first ledger.
const settledFile = (f, a) => path.join(f.root, 'agents', a, 'memory', 'claims-import.json');
const midrun = (f, extra = {}) => {
  const segs = () => fs.readdirSync(path.join(f.root, 'agents')).filter((a) => f.store.segments(a).length > 0);
  const settled = [];
  const ws = new f.RW.ReaderWatchers({ hiveRoot: () => f.root, agents: segs, candidates: () => Object.keys(f.levels), level: (a) => f.levels[a] ?? 'off', debounceMs: 100, onSettled: (a) => settled.push(a), ...f.ingest, ...extra });
  WATCHERS.push(ws);
  return { ws, settled };
};

test('CL-READERWATCHER mid-run: a raised agent is imported (memory.md and archives) before its swap, then watched; a drop to shadow or off unsettles it', async () => {
  const f = await floor({ 'ag-w': 'writer', 'ag-s': 'shadow', 'ag-x': 'off' });
  assert.equal(fs.existsSync(settledFile(f, 'ag-w')), true, 'a writer settles at the S0 import');
  assert.equal(fs.existsSync(settledFile(f, 'ag-s')), false, 'a shadow agent does not (its memory.md stays searched)');
  assert.equal(fs.existsSync(settledFile(f, 'ag-x')), false);
  fs.writeFileSync(path.join(f.root, 'agents', 'ag-x', 'memory-archive-2026-09-01.md'), '# Memory\n\n## 2026-09-01\n- an invented archive note of ag-x\n');
  const { ws, settled } = midrun(f);
  f.levels['ag-x'] = 'writer';
  const p1 = ws.ensureImported('ag-x');
  assert.equal(ws.ensureImported('ag-x'), p1, 'one import at a time per agent');
  await p1;
  assert.deepEqual(settled, ['ag-x']);
  assert.equal(fs.existsSync(settledFile(f, 'ag-x')), true);
  assert.deepEqual(ledgerTexts(f, 'ag-x').sort(), ['- an invented archive note of ag-x', '- an invented note of ag-x']);
  ws.sync();
  assert.deepEqual(ws.watching(), ['ag-w', 'ag-x']);
  await ws.ensureImported('ag-s');
  assert.equal(fs.existsSync(settledFile(f, 'ag-s')), false, 'no import while it is shadow');
  assert.ok(!settled.includes('ag-s'), 'and no swap signalled for it');
  // a raise of the shadow agent goes through sync (the 60 s timer in main)
  f.levels['ag-s'] = 'reader';
  edit(f, 'ag-s', 'written while it was shadow');
  ws.sync();
  assert.ok(await waitFor(() => settled.includes('ag-s')));
  assert.ok(ledgerTexts(f, 'ag-s').includes('- written while it was shadow'), 'what came while it was shadow is imported first');
  assert.ok(await waitFor(() => ws.watching().includes('ag-s')));
  // a drop: the settled file goes, so a later raise imports again before its swap
  f.levels['ag-x'] = 'off';
  ws.sync();
  assert.equal(fs.existsSync(settledFile(f, 'ag-x')), false);
  assert.deepEqual(ws.watching(), ['ag-s', 'ag-w']);
  assert.ok(f.rows.some((r) => r.kind === 'claims-import-unsettled' && r.agent === 'ag-x'));
  edit(f, 'ag-x', 'written while it was off');
  f.levels['ag-x'] = 'writer';
  await ws.ensureImported('ag-x');
  assert.equal(fs.existsSync(settledFile(f, 'ag-x')), true);
  assert.ok(ledgerTexts(f, 'ag-x').includes('- written while it was off'));
  // NIT-1 (Jim): an agent with nothing to import settles (no segment, so nothing swaps) and is
  // watched, instead of being re-imported at every sync; a bullet it writes later reaches its ledger.
  const g = await floor({ 'ag-e': 'off' }, { 'ag-e': '# Memory\n' });
  const m = midrun(g);
  g.levels['ag-e'] = 'writer';
  await m.ws.ensureImported('ag-e');
  assert.equal(fs.existsSync(settledFile(g, 'ag-e')), true);
  assert.deepEqual(m.settled, ['ag-e']);
  const imports = g.rows.filter((r) => r.kind === 'claims-import' && r.agent === 'ag-e').length;
  m.ws.sync(); m.ws.sync();
  assert.equal(g.rows.filter((r) => r.kind === 'claims-import' && r.agent === 'ag-e').length, imports, 'no re-import at later syncs');
  assert.ok(await waitFor(() => m.ws.watching().includes('ag-e')), 'watched without a ledger');
  edit(g, 'ag-e', 'the first note of a new hire');
  assert.ok(await waitFor(() => ledgerTexts(g, 'ag-e').includes('- the first note of a new hire')), 'its first bullet reaches the ledger');
  // and an id with no agent folder (a typo in memory-sources.json) is not imported, and no folder is made
  g.levels['ag-typo'] = 'writer';
  await m.ws.ensureImported('ag-typo');
  assert.equal(fs.existsSync(path.join(g.root, 'agents', 'ag-typo')), false);
  assert.ok(!g.rows.some((r) => r.agent === 'ag-typo'), 'no rows for it');
  // nor at a start import: no settled file (so no folder) is made for it
  await importAtStart({ hiveRoot: g.root, ...g.ingest, agents: () => ['ag-typo'], level: () => 'writer' });
  assert.equal(fs.existsSync(path.join(g.root, 'agents', 'ag-typo')), false);
  m.ws.stopAll();
  // an agent whose every entry is refused has nothing in a ledger: it stays unsettled (memory.md searched)
  const h = await floor({ 'ag-p': 'off' }, { 'ag-p': '# Memory\n\n- a poison entry\n' });
  const p = midrun(h, { append: (a, d, ...rest) => (/poison/.test(d.text ?? '') ? Promise.resolve({ ok: false, error: 'an invented refusal' }) : h.ingest.append(a, d, ...rest)) });
  h.levels['ag-p'] = 'writer';
  await p.ws.ensureImported('ag-p');
  assert.equal(fs.existsSync(settledFile(h, 'ag-p')), false);
  p.ws.stopAll();
  // the same when the only entry is refused before any append (one line over the legacy limit)
  const k = await floor({ 'ag-l': 'off' }, { 'ag-l': `# Memory\n\n- ${'x'.repeat(100_000)}\n` });
  const q = midrun(k);
  k.levels['ag-l'] = 'writer';
  await q.ws.ensureImported('ag-l');
  assert.ok(k.rows.some((r) => r.kind === 'claims-import-refused' && r.agent === 'ag-l'), 'refused at parse');
  assert.equal(fs.existsSync(settledFile(k, 'ag-l')), false);
  q.ws.stopAll();
});

test('CL-READERWATCHER mid-run: a failed import leaves no settled file, is logged, and the next sync retries it', async () => {
  const f = await floor({ 'ag-x': 'off' });
  let fail = true;
  const { ws, settled } = midrun(f, { read: (a) => { if (fail) throw new Error('invented ledger read failure'); return f.store.readLedger(a); } });
  f.levels['ag-x'] = 'writer';
  // its first claim made a ledger: still no watcher while its import has not settled
  assert.equal((await f.store.appendRecord('ag-x', { t: 'claim', kind: 'fact', text: 'a first claim of ag-x' }, 'endpoint')).ok, true);
  await ws.ensureImported('ag-x');
  assert.equal(fs.existsSync(settledFile(f, 'ag-x')), false);
  assert.ok(f.rows.some((r) => r.kind === 'claims-import-failed' && r.agent === 'ag-x' && /invented ledger read failure/.test(r.error)));
  assert.deepEqual(settled, []);
  ws.sync();
  assert.deepEqual(ws.watching(), [], 'an unsettled agent is not watched');
  await new Promise((r) => setTimeout(r, 50));
  fail = false;
  ws.sync();
  assert.ok(await waitFor(() => settled.includes('ag-x')));
  assert.equal(fs.existsSync(settledFile(f, 'ag-x')), true);
});

test('CL-READERWATCHER known limit 1: a bullet the rollover moves into an archive before the memory.md scan is still ingested; one already taken is not offered again', async () => {
  const f = await floor({ 'ag-w': 'writer' });
  f.watchers.sync();
  await new Promise((r) => setTimeout(r, 300));
  edit(f, 'ag-w', 'taken from memory.md');
  assert.ok(await waitFor(() => f.appended.some((x) => x.text === '- taken from memory.md')));
  // the rollover: memory.md cut to its header, the older bullets (one never scanned) into an archive
  const dir = path.join(f.root, 'agents', 'ag-w');
  const body = fs.readFileSync(path.join(dir, 'memory.md'), 'utf8').replace(/\n$/, '') + '\n- moved before the scan\n';
  // memory.md is cut to its header, and the agent is mid-way through a new bullet (no newline yet)
  fs.writeFileSync(path.join(dir, 'memory.md'), '# Memory — ag-w\n- half writ');
  fs.writeFileSync(path.join(dir, 'memory-archive-2026-10-15.md'), body);
  assert.ok(await waitFor(() => f.appended.some((x) => x.text === '- moved before the scan')), JSON.stringify(f.rows.slice(-3)));
  await new Promise((r) => setTimeout(r, 400));
  const texts = ledgerTexts(f, 'ag-w');
  assert.equal(texts.filter((t) => t === '- moved before the scan').length, 1);
  assert.equal(texts.filter((t) => t === '- taken from memory.md').length, 1, 'not again from the archive');
  assert.equal(texts.filter((t) => t === '- an invented note of ag-w').length, 1, 'the imported note not again either');
  assert.equal(f.store.readLedger('ag-w').records.find((r) => r.text === '- moved before the scan').legacy.file, 'memory-archive-2026-10-15.md');
  assert.ok(!texts.some((t) => t.startsWith('- half writ')), 'the archive scan leaves memory.md, and its unfinished line, to the memory.md scan');
  fs.appendFileSync(path.join(dir, 'memory.md'), 'ten\n');
  assert.ok(await waitFor(() => f.appended.some((x) => x.text === '- half written' && x.source === 'self')));
});

test('CL-READERWATCHER archives: scanned only after an archive changes (Jim: "archive flag kept"), and a refused archive entry is logged once (NIT-2)', async () => {
  const f = await floor({ 'ag-w': 'writer' });
  let reads = 0;
  const r5 = new Map();
  const append = (a, d, ...rest) => (r5.set(d.text, rest[1]?.r5), /poison/.test(d.text ?? '') ? Promise.resolve({ ok: false, error: 'an invented refusal' }) : f.ingest.append(a, d, ...rest));
  const ws = new f.RW.ReaderWatchers({ hiveRoot: () => f.root, agents: () => ['ag-w'], level: () => 'writer', debounceMs: 100, append,
    read: (a) => { reads++; return f.store.readLedger(a); }, log: f.ingest.log });
  WATCHERS.push(ws);
  ws.sync();
  await new Promise((r) => setTimeout(r, 300));
  const dir = path.join(f.root, 'agents', 'ag-w');
  const archive = path.join(dir, 'memory-archive-2026-10-14.md');
  const refusedRows = () => f.rows.filter((r) => r.kind === 'claims-import-refused' && r.via === 'watch-archive').length;
  fs.writeFileSync(archive, '# Memory\n\n## 2026-10-14\n- a poison archive note\n- a good archive note\n');
  assert.ok(await waitFor(() => f.appended.some((x) => x.text === '- a good archive note')));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(refusedRows(), 1);
  assert.equal(r5.get('- a good archive note'), false, 'archive entries go in without R5, as at the S0 import (Jim: "archive scan r5 on")');
  fs.appendFileSync(archive, '- a second good archive note\n');
  assert.ok(await waitFor(() => f.appended.some((x) => x.text === '- a second good archive note')));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(refusedRows(), 1, 'the refused entry is not offered and logged again at the next archive change');
  // a memory.md change alone does not scan the archives again (one ledger read, not two)
  const before = reads;
  edit(f, 'ag-w', 'a plain memory.md note');
  assert.ok(await waitFor(() => f.appended.some((x) => x.text === '- a plain memory.md note')));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(reads - before, 1, 'one ledger read: the memory.md scan only');
  ws.stopAll();
});
