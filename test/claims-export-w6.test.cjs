'use strict';
/**
 * CLAIM-LEDGER W6 (src/main/claims/exportLedger.ts): the rollback exports.
 *   - continuous export: append-only, one tagged line per record, month from the write time, a
 *     status change is an appended marker; split at 1.5 MiB so no file reaches the older build's
 *     2 MiB source cap (G6.8); syncExport catches up after a crash and is idempotent;
 *   - export --complete: memory.md replaced by temp file + rename, never carrying the generated
 *     marker, so the 1.1.83 rollover treats it as an ordinary memory.md and rolls it (G6.3 path);
 *   - G6.4 upgrade round trip: every line of the complete export is skipped by the fallback parser
 *     (tagged); a bullet the older build appends afterwards comes back as exactly one new claim.
 * All fixture text is invented.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const ROOT = path.join(__dirname, '..');
const E = loadTs(path.join(ROOT, 'src', 'main', 'claims', 'exportLedger.ts'));
const G = loadTs(path.join(ROOT, 'src', 'main', 'claims', 'generated.ts'));
const M = loadTs(path.join(ROOT, 'src', 'main', 'claims', 'migrate.ts'));
const R = loadTs(path.join(ROOT, 'src', 'main', 'memoryRollover.ts'));
const V = loadTs(path.join(ROOT, 'src', 'main', 'claims', 'views.ts'));
const renderers = (records) => V.createClaimViews(records, () => 0);
const view = { flags: {}, counters: {} };

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claims-export-'));
function ledger(n, { textLen = 40, month = '2026-10', kindEvery = 0 } = {}) {
  const records = [];
  const claims = {};
  for (let i = 0; i < n; i++) {
    const id = `c${i}`;
    const kind = kindEvery && i % kindEvery === 0 ? 'lesson' : 'fact';
    records.push({ v: 1, t: 'claim', id, at: `${month}-0${1 + (i % 9)}T10:00:00.000Z`, wt: `${month}-03T12:00:00.000Z`, agent: 'ag-1', prev: '', mac: '', kind, text: `invented fact ${i} ${'x'.repeat(textLen)}`, source: 'self', ...(kind === 'lesson' ? { pin: true } : {}) });
    claims[id] = { id, status: 'live', sightings: 1, firstAt: '', lastAt: '', pinned: kind === 'lesson', reasons: [] };
  }
  return { records, state: { v: 1, agent: 'ag-1', registryHash: '', ledgerHead: '', claims, conflicts: [] } };
}

test('continuous export: one tagged line per record, a header once, the month from the write time', () => {
  const d = dir();
  const { records, state } = ledger(3);
  for (const r of records) E.appendExport(d, r, state, renderers(records).renderExportLine);
  assert.deepEqual(E.exportFiles(d), ['memory-ledger-export-2026-10.md']);
  const text = fs.readFileSync(path.join(d, 'memory-ledger-export-2026-10.md'), 'utf8');
  assert.equal(text.match(/^# Memory ledger export/gm).length, 1);
  assert.deepEqual([...E.exportedIds(d)].sort(), ['c0', 'c1', 'c2']);
  for (const r of records) assert.ok(text.includes(`[c:${r.id}]`));
});

test('exportLine adds the [c:id] tag if a renderer forgot it, and always ends with one newline', () => {
  const { records, state } = ledger(1);
  const line = E.exportLine(records[0], state, () => 'a line with no tag\n');
  assert.equal(line, 'a line with no tag [c:c0]\n');
});

test('G6.8 split: a month over 1.5 MiB continues in -2, -3; no export file ever reaches the 2 MiB cap', () => {
  const d = dir();
  const { records, state } = ledger(1100, { textLen: 3900 });   // ~4.3 MB
  for (const r of records) E.appendExport(d, r, state, renderers(records).renderExportLine);
  const files = E.exportFiles(d);
  assert.deepEqual(files, ['memory-ledger-export-2026-10.md', 'memory-ledger-export-2026-10-2.md', 'memory-ledger-export-2026-10-3.md']);
  for (const f of files) {
    const size = fs.statSync(path.join(d, f)).size;
    assert.ok(size <= E.EXPORT_SPLIT_BYTES, `${f}: ${size}`);
    assert.ok(size < E.OLD_BUILD_MAX_SOURCE_BYTES);
  }
  assert.equal(E.exportedIds(d).size, 1100, 'every record exported exactly once across the parts');
});

test('syncExport: catches up the records a crash left out, in order, and is idempotent', () => {
  const d = dir();
  const { records, state } = ledger(10);
  for (const r of records.slice(0, 6)) E.appendExport(d, r, state, renderers(records).renderExportLine);
  assert.equal(E.syncExport(d, records, state, renderers(records).renderExportLine), 4);
  assert.equal(E.syncExport(d, records, state, renderers(records).renderExportLine), 0);
  const text = fs.readFileSync(path.join(d, 'memory-ledger-export-2026-10.md'), 'utf8');
  const order = [...text.matchAll(/\[c:(c\d+)\]/g)].map((m) => m[1]);
  assert.deepEqual(order, records.map((r) => r.id));
});

test('status changes are appended as marker lines, never edits; markers do not count as exports', () => {
  const d = dir();
  const { records, state } = ledger(3);
  for (const r of records) E.appendExport(d, r, state, renderers(records).renderExportLine);
  const before = fs.readFileSync(path.join(d, 'memory-ledger-export-2026-10.md'), 'utf8');
  const next = JSON.parse(JSON.stringify(state));
  next.claims.c1.status = 'superseded';
  next.claims.c3 = { id: 'c3', status: 'live', sightings: 1, firstAt: '', lastAt: '', pinned: false, reasons: [] };
  assert.deepEqual(E.statusChanges(state, next), [{ id: 'c1', from: 'live', to: 'superseded' }]);
  assert.equal(E.appendStatusMarkers(d, 'ag-1', state, next, '2026-10-03T13:00:00.000Z'), 1);
  const after = fs.readFileSync(path.join(d, 'memory-ledger-export-2026-10.md'), 'utf8');
  assert.ok(after.startsWith(before), 'append-only: the earlier bytes are unchanged');
  assert.match(after.slice(before.length), /status of \[c:c1\]: live -> superseded/);
  assert.equal(E.syncExport(d, records, state, renderers(records).renderExportLine), 0, 'the marker does not stop or fake an export');
  assert.ok(!E.exportedIds(d).has('c3'));
});

test('export --complete: memory.md replaced by temp + rename, every claim tagged, no generated marker, the A7.1 note', () => {
  const d = dir();
  const { records, state } = ledger(5, { kindEvery: 3 });
  fs.writeFileSync(path.join(d, 'memory.md'), `${G.GENERATED_MEMORY_MARKER}\n# a generated view\n`);
  const realRender = renderers(records).renderMemoryMd;
  const r = E.exportComplete(d, state, view, realRender);
  const text = fs.readFileSync(path.join(d, 'memory.md'), 'utf8');
  assert.ok(!G.isGeneratedMemory(text), 'the complete export is an ordinary memory.md');
  assert.equal(text, realRender(state, view, 'complete').replace(`${G.GENERATED_MEMORY_MARKER}\n`, ''), 'W6 exports the real W4 complete rendering, minus its generated marker');
  for (const c of records) assert.ok(text.includes(`[c:${c.id}]`));
  assert.match(text, /^## How I work \(standing lessons\)$/m);
  assert.equal(r.note, E.COMPLETE_EXPORT_NOTE);
  assert.deepEqual(fs.readdirSync(d).filter((n) => n.includes('.tmp')), []);
});

test('G6.3 path: the older rollover rolls a large complete export like any memory.md (it carries no marker)', () => {
  const d = dir();
  const { records, state } = ledger(600, { kindEvery: 50 });
  E.exportComplete(d, state, view, renderers(records).renderMemoryMd);
  const r = R.rolloverMemory(d, Date.parse('2026-10-04T12:00:00Z'));
  assert.equal(r.rotated, true);
  assert.ok(!r.generated);
});

test('G6.4 upgrade round trip: the complete export re-imports as nothing; a bullet the older build adds comes back once', () => {
  const d = dir();
  const { records, state } = ledger(20, { kindEvery: 4 });
  E.exportComplete(d, state, view, renderers(records).renderMemoryMd);
  const known = M.knownIdsFor(records);
  assert.deepEqual(M.parseNewBullets(fs.readFileSync(path.join(d, 'memory.md'), 'utf8'), known), []);
  fs.appendFileSync(path.join(d, 'memory.md'), '- 2026-10-05 a note written while on the older build\n');
  const back = M.parseNewBullets(fs.readFileSync(path.join(d, 'memory.md'), 'utf8'), known);
  assert.deepEqual(back.map((x) => x.text), ['- 2026-10-05 a note written while on the older build']);
});

// ——— god 6c4d4e ruling 2: no second copy of an entry its archive still holds ———

/** An invented agent folder: an archive (3 entries, one split into parts) + memory.md; records from the real import. */
function archived() {
  const d = dir();
  const longEntry = '- 2026-09-02 an invented long entry\n' + Array.from({ length: 60 }, (_, i) => `  continued invented line ${i} ${'y'.repeat(80)}`).join('\n');
  fs.writeFileSync(path.join(d, 'memory-archive-2026-09-20.md'), `# Memory archive - invented\n\n## 2026-09-01 invented\n- 2026-09-01 an invented archived fact alpha\n- 2026-09-01 an invented archived fact beta\n${longEntry}\n`);
  fs.writeFileSync(path.join(d, 'memory.md'), '# Memory - invented\n\n## How I work (standing lessons)\n- an invented lesson\n\n## 2026-10-01 invented\n- 2026-10-01 an invented recent fact gamma\n');
  const drafts = M.importLegacy(d);
  drafts.push({ t: 'claim', kind: 'fact', text: '- 2026-10-04 an invented post-migration fact delta', source: 'self' });
  const records = drafts.map((x, i) => ({ v: 1, id: `r${i}`, at: x.at || '2026-10-04T10:00:00.000Z', wt: '2026-10-04T10:00:00.000Z', agent: 'ag-1', prev: '', mac: '', ...x }));
  const claims = {};
  for (const r of records) claims[r.id] = { id: r.id, status: 'live', sightings: 1, firstAt: r.at, lastAt: r.at, pinned: r.kind === 'lesson', reasons: [] };
  return { d, records, state: { v: 1, agent: 'ag-1', registryHash: '', ledgerHead: '', claims, conflicts: [] } };
}
const byFile = (records, re) => records.filter((r) => r.legacy && re.test(r.legacy.file)).map((r) => r.id);

test('ruling 2: archive-backed legacy claims (content-checked by sha256) stay out of the continuous export; the rest is exported', () => {
  const { d, records, state } = archived();
  const arch = byFile(records, /^memory-archive-/);
  assert.ok(arch.length >= 4, `the long entry is split into parts (${arch.length} archive records)`);
  assert.deepEqual([...E.archiveBackedIds(d, records, state)].sort(), [...arch].sort());
  E.syncExport(d, records, state, renderers(records).renderExportLine);
  const ex = E.exportedIds(d);
  for (const id of arch) assert.ok(!ex.has(id), `${id} is still in its archive: not exported again`);
  for (const r of records.filter((x) => !arch.includes(x.id))) assert.ok(ex.has(r.id), `${r.id} (${r.legacy ? r.legacy.file : 'post-migration'}) is exported`);
});

test('ruling 2: re-evaluated on every sync: a changed entry, then a deleted archive, bring their claims back', () => {
  const { d, records, state } = archived();
  E.syncExport(d, records, state, renderers(records).renderExportLine);
  const file = path.join(d, 'memory-archive-2026-09-20.md');
  const alpha = records.find((r) => r.text && r.text.includes('fact alpha')).id;
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('fact alpha', 'fact alpha, edited'));
  assert.equal(E.syncExport(d, records, state, renderers(records).renderExportLine), 1, 'only the entry the archive no longer holds');
  assert.ok(E.exportedIds(d).has(alpha));
  fs.rmSync(file);
  const rest = byFile(records, /^memory-archive-/).filter((id) => id !== alpha);
  assert.equal(E.syncExport(d, records, state, renderers(records).renderExportLine), rest.length, 'the archive is gone: all its claims are back');
  for (const id of rest) assert.ok(E.exportedIds(d).has(id));
  assert.equal(E.syncExport(d, records, state, renderers(records).renderExportLine), 0, 'idempotent');
});

test('ruling 2: a claim naming an archive that is not in the folder, or a lesson, is never left out', () => {
  const { d, records, state } = archived();
  const ghost = { ...records[0], id: 'ghost', legacy: { ...records[0].legacy, file: 'memory-archive-1999-01-01.md' } };
  const lesson = { ...records[0], id: 'les', kind: 'lesson' };
  const ids = E.archiveBackedIds(d, [...records, ghost, lesson], state);
  assert.ok(!ids.has('ghost'));
  assert.ok(!ids.has('les'));
});

test('ruling 2: export --complete with the archive-backed exclude omits them and keeps How I work; without it, every record', () => {
  const { d, records, state } = archived();
  const arch = byFile(records, /^memory-archive-/);
  E.exportComplete(d, state, view, renderers(records).renderMemoryMd, E.archiveBackedIds(d, records, state));
  const text = fs.readFileSync(path.join(d, 'memory.md'), 'utf8');
  for (const id of arch) assert.ok(!text.includes(`[c:${id}]`), id);
  for (const r of records.filter((x) => !arch.includes(x.id))) assert.ok(text.includes(`[c:${r.id}]`), r.id);
  assert.match(text, /^## How I work \(standing lessons\)\n- .*an invented lesson \[status:live\] \[c:/m);
  const all = dir();
  E.exportComplete(all, state, view, renderers(records).renderMemoryMd);
  const full = fs.readFileSync(path.join(all, 'memory.md'), 'utf8');
  for (const r of records) assert.ok(full.includes(`[c:${r.id}]`), `default: every record (${r.id})`);
});

test('W6-D2 (god 909a70): excluded only while live or superseded?; a retracted or superseded archived claim exports its MARKED line', () => {
  const { d, records, state } = archived();
  const alpha = records.find((r) => r.text && r.text.includes('fact alpha')).id;
  const beta = records.find((r) => r.text && r.text.includes('fact beta')).id;
  E.syncExport(d, records, state, renderers(records).renderExportLine);
  assert.ok(!E.exportedIds(d).has(alpha));
  const next = JSON.parse(JSON.stringify(state));
  next.claims[alpha].status = 'retracted';
  next.claims[beta].status = 'superseded?';
  assert.ok(!E.archiveBackedIds(d, records, next).has(alpha), 'retracted: no longer left out');
  assert.ok(E.archiveBackedIds(d, records, next).has(beta), "'superseded?' is still a live view: left out");
  assert.equal(E.syncExport(d, records, next, renderers(records).renderExportLine), 1);
  const text = E.exportFiles(d).map((f) => fs.readFileSync(path.join(d, f), 'utf8')).join('');
  assert.match(text, new RegExp(String.raw`"- 2026-09-01 an invented archived fact alpha" \[status:retracted\] \[c:${alpha}\]`), 'the real W4 rendered line carries its status and id');
  next.claims[beta].status = 'superseded';
  assert.equal(E.syncExport(d, records, next, renderers(records).renderExportLine), 1);
  // and the complete export marks it too
  E.exportComplete(d, next, view, renderers(records).renderMemoryMd, E.archiveBackedIds(d, records, next));
  const mem = fs.readFileSync(path.join(d, 'memory.md'), 'utf8');
  assert.match(mem, new RegExp(String.raw`- 2026-09-01 an invented archived fact alpha \[status:retracted\] \[c:${alpha}\]`));
  assert.match(mem, new RegExp(String.raw`- 2026-09-01 an invented archived fact beta \[status:superseded\] \[c:${beta}\]`));
});

test('W6-D3: a legacy.file with a path in it is never treated as an archive in the folder', () => {
  const { d, records, state } = archived();
  const r0 = records.find((r) => r.legacy && /^memory-archive-/.test(r.legacy.file));
  for (const file of [`memory-archive-x/../${r0.legacy.file}`, `memory-archive-x\..\${r0.legacy.file}`]) {
    const odd = { ...r0, id: 'odd', legacy: { ...r0.legacy, file } };
    assert.ok(!E.archiveBackedIds(d, [odd], state).has('odd'), file);
  }
  assert.ok(E.archiveBackedIds(d, [r0], state).has(r0.id), 'the plain name still counts');
});

test("Jim's re-audit nit: archiveBackedIds without the derived state throws (it would read every claim as live)", () => {
  const { d, records } = archived();
  assert.throws(() => E.archiveBackedIds(d, records), /the derived state is required/);
  assert.throws(() => E.archiveBackedIds(d, records, null), /the derived state is required/);
});
