'use strict';
/**
 * CLAIM-LEDGER W6 (src/main/claims/ingest.ts): the S0 import run and the reader-mode watcher.
 *   - every append goes through appendRecord with origin 'w6-internal' (no other origin, no R5 here);
 *   - refusals are reported (and logged one row each), never dropped silently;
 *   - a read-only ledger (broken chain, lost key) gets nothing appended;
 *   - G6.5 the frozen backup is taken once; G6.2 a second run appends nothing;
 *   - G6.7 reader visibility: a bullet appended to memory.md is appended to the ledger within the
 *     debounce window (the engine's indexing adds the rest of the 60 s budget, W3);
 *   - a half-written last line is not taken by a watch scan; the spawn scan takes everything.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const ROOT = path.join(__dirname, '..');
const I = loadTs(path.join(ROOT, 'src', 'main', 'claims', 'ingest.ts'));
const C = loadTs(path.join(ROOT, 'src', 'shared', 'claims.ts'));

function hive() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claims-ingest-'));
  const dir = path.join(root, 'agents', 'ag-1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory-archive-2026-09-30.md'), '# Memory\n\n## 2026-09-29\n- archived fact\n');
  fs.writeFileSync(path.join(dir, 'memory.md'), '# Memory\n\n## 2026-10-03\n- live fact\n- ' + 'L'.repeat(4500) + '\n');
  return { root, dir };
}

/** An in-memory W1 stand-in that enforces the frozen limits by origin. */
function fakeLedger({ refuse = () => null, chain = 'ok' } = {}) {
  const records = [];
  const calls = [];
  const rows = [];
  const deps = {
    append: async (agent, draft, origin) => {
      calls.push({ agent, origin, draft });
      const max = origin === 'w6-internal' ? C.CLAIM_TEXT_MAX_LEGACY : C.CLAIM_TEXT_MAX;
      if (draft.text.length > max) return { ok: false, error: `text over ${max}` };
      const why = refuse(draft);
      if (why) return { ok: false, error: why };
      const id = `c${records.length}`;
      records.push({ v: 1, id, wt: new Date().toISOString(), at: draft.at || new Date().toISOString(), agent, prev: '', mac: '', ...draft });
      return { ok: true, id };
    },
    read: () => ({ records: records.slice(), torn: null, chain }),
    log: (r) => rows.push(r),
  };
  return { deps, records, calls, rows };
}

test('S0 import: frozen backup once, every entry appended via w6-internal, a re-run appends nothing', async () => {
  const { root, dir } = hive();
  const L = fakeLedger();
  const a = await I.shadowImport({ hiveRoot: root, ...L.deps }, 'ag-1');
  assert.deepEqual([a.offered, a.appended, a.refused.length], [4, 4, 0]);   // archived, live, 2 parts of the long one
  assert.ok(L.calls.every((c) => c.origin === 'w6-internal' && c.agent === 'ag-1'));
  assert.ok(L.calls.every((c) => c.draft.source === 'legacy'));
  assert.deepEqual(a.backup, { written: true, files: 2 });
  const bdir = path.join(root, 'backups', I.FROZEN_BACKUP_DIR, 'ag-1');
  assert.ok(fs.readFileSync(path.join(bdir, 'memory.md')).equals(fs.readFileSync(path.join(dir, 'memory.md'))));
  const b = await I.shadowImport({ hiveRoot: root, ...L.deps }, 'ag-1');
  assert.deepEqual([b.offered, b.appended], [0, 0]);
  assert.equal(b.backup.written, false);
  assert.equal(L.rows.filter((r) => r.kind === 'claims-import').length, 2);
});

test('refusals are reported and logged one row each, never dropped silently', async () => {
  const { root } = hive();
  const L = fakeLedger({ refuse: (d) => (d.text.includes('live fact') ? 'refused for the test' : null) });
  const r = await I.shadowImport({ hiveRoot: root, ...L.deps }, 'ag-1');
  assert.equal(r.refused.length, 1);
  assert.deepEqual(Object.keys(r.refused[0]).sort(), ['chars', 'error', 'file', 'line']);
  assert.equal(r.refused[0].file, 'memory.md');
  assert.equal(L.rows.filter((x) => x.kind === 'claims-import-refused').length, 1);
  assert.equal(r.appended, r.offered - 1);
});

test('a read-only ledger (broken chain or lost key) gets nothing appended, and says why', async () => {
  const { root } = hive();
  const L = fakeLedger({ chain: { brokenAt: 'c3', reason: 'key-missing' } });
  const r = await I.shadowImport({ hiveRoot: root, ...L.deps }, 'ag-1');
  assert.equal(L.calls.length, 0);
  assert.match(r.readOnly, /key-missing/);
});

const waitFor = async (pred, ms) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
  return true;
};

test('G6.7 reader watcher: a bullet appended to memory.md reaches the ledger within the debounce window; self source', async () => {
  const { root, dir } = hive();
  const L = fakeLedger();
  await I.shadowImport({ hiveRoot: root, ...L.deps }, 'ag-1');
  const before = L.records.length;
  const w = new I.ReaderWatcher({ hiveRoot: root, ...L.deps }, 'ag-1', 100);
  const first = await w.start();
  assert.equal(first.appended, 0, 'the spawn scan finds nothing new after the import');
  try {
    const t0 = Date.now();
    fs.appendFileSync(path.join(dir, 'memory.md'), '- 2026-10-03T15:10 a new note from the agent\n');
    assert.ok(await waitFor(() => L.records.length === before + 1, 5000), 'appended');
    const ms = Date.now() - t0;
    assert.ok(ms < 5000, `visible to the ledger in ${ms} ms`);
    const rec = L.records[L.records.length - 1];
    assert.equal(rec.source, 'self');
    assert.equal(rec.text, '- 2026-10-03T15:10 a new note from the agent');
    assert.equal(L.calls[L.calls.length - 1].origin, 'w6-internal');
  } finally { w.stop(); }
});

test('reader watcher: a half-written last line waits; the spawn scan takes it', async () => {
  const { root, dir } = hive();
  const L = fakeLedger();
  await I.shadowImport({ hiveRoot: root, ...L.deps }, 'ag-1');
  const w = new I.ReaderWatcher({ hiveRoot: root, ...L.deps }, 'ag-1', 50);
  await w.start();
  try {
    const n = L.records.length;
    fs.appendFileSync(path.join(dir, 'memory.md'), '- half written');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(L.records.length, n, 'not taken while unterminated');
    const r = await w.scan(true);
    assert.equal(r.appended, 1);
    assert.equal(L.records[L.records.length - 1].text, '- half written');
  } finally { w.stop(); }
});
