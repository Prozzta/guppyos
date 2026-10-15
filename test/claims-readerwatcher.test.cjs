'use strict';
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
  assert.match(src, /agents: \(\) => \(claimsEndpoint\(\) \? claimLedgerAgents\(\) : \[\]\),\n\s+level: claimLevel,/);
  assert.match(src, /claimsImportReady\(\)\.then\(\(\) => readerWatchers\.sync\(\)/, 'only after the S0 import has settled');
  assert.match(src, /setInterval\(syncReaderWatchers, READER_WATCH_SYNC_MS\)/);
  const start = src.slice(src.indexOf('function claimsEndpoint('), src.indexOf('function claimsEndpoint(') + 6000);
  assert.match(start, /setImmediate\(syncReaderWatchers\)/, 'at claims start');
});
