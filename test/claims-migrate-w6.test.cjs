'use strict';
/**
 * CLAIM-LEDGER W6 (src/main/claims/migrate.ts): the legacy import, the fallback parser and the frozen
 * backup (_work/system1/CLAIM-LEDGER-BUILD-PLAN.md §3 W6).
 *   - the split is the replay bed's reference split (god ce0e54), plus the orphan-fence addition;
 *   - G6.1: every non-blank line is an entry line or a counted skipped line; text verbatim; the
 *     parts of an over-limit entry concatenate back to it and hash to its legacy.sha256;
 *   - G6.2 / G6.4: a re-import creates nothing, keyed on sha256 never file:line, including an entry
 *     that the REAL 1.1.83 rollover moves from memory.md into an archive between two scans;
 *   - the parser skips known hashes and rendered [c:<id>] lines, and keeps long entries whole;
 *   - G6.5: the frozen backup is byte-identical and never overwritten.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const loadTs = require('./load-ts.cjs');

const ROOT = path.join(__dirname, '..');
const M = loadTs(path.join(ROOT, 'src', 'main', 'claims', 'migrate.ts'));
const C = loadTs(path.join(ROOT, 'src', 'shared', 'claims.ts'));
const R = loadTs(path.join(ROOT, 'src', 'main', 'memoryRollover.ts'));
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'claims-w6-'));

/** Records as the ledger would hold them after appending drafts (W1 assigns the ids). */
const asRecords = (drafts, from = 0) => drafts.map((d, i) => ({ v: 1, id: `c${from + i}`, at: d.at || '2026-10-03T00:00:00.000Z', wt: '2026-10-03T00:00:00.000Z', agent: 'a', prev: '', mac: '', ...d }));

const SAMPLE = [
  '# Memory: creed',
  '',
  '## How I work (standing lessons)',
  '_Your method lessons (how you work): bullets or ### subheadings only, a ## heading ends this section; kept at the top, never archived._',
  '',
  '### Safety',
  '- Commit only as the repo-local identity.',
  '- Heavy lock: check it in a separate call',
  '  before any test.',
  '',
  '## 2026-10-02 notes',
  '<!-- a comment -->',
  '- 2026-10-02T09:15 READS baseline: 640M reads.',
  '  - a sub-bullet folds into its parent',
  '1. a numbered entry',
  'A plain line that wraps',
  'onto the next line.',
  '- an entry with a fence',
  '```',
  'code line',
  '',
  '```',
  '',
  '```',
  'an orphan fence',
  '```',
  '| a | table |',
  '|---|---|',
].join('\n');

test('split: the reference rules (bullets with continuations, wraps, numbered, plain, headings and boilerplate skipped)', () => {
  const { entries, skippedLines } = M.splitEntries(SAMPLE, 'memory.md');
  const texts = entries.map((e) => e.text);
  assert.deepEqual(texts, [
    '- Commit only as the repo-local identity.',
    '- Heavy lock: check it in a separate call\n  before any test.',
    '- 2026-10-02T09:15 READS baseline: 640M reads.\n  - a sub-bullet folds into its parent',
    // the reference's hard-wrap rule: a plain line joins an entry whose last line ends no sentence
    '1. a numbered entry\nA plain line that wraps\nonto the next line.',
    '- an entry with a fence\n```\ncode line\n\n```',
    '```\nan orphan fence\n```',
    '| a | table |\n|---|---|',
  ]);
  // # Memory, ## How I work, the italic seed, ### Safety, ## 2026-10-02 notes, the comment
  assert.equal(skippedLines, 6);
  assert.equal(entries[4].style, 'bullet');
  assert.equal(entries[5].style, 'plain', 'an orphan fence is its own plain entry, not dropped');
});

test('G6.1 coverage: entry lines + skipped lines = every non-blank line', () => {
  const { entries, skippedLines } = M.splitEntries(SAMPLE, 'memory.md');
  const nonBlank = SAMPLE.split('\n').filter((l) => l.trim() !== '').length;
  const entryLines = entries.reduce((s, e) => s + e.text.split('\n').filter((l) => l.trim() !== '').length, 0);
  assert.equal(entryLines + skippedLines, nonBlank);
});

test('split: CRLF gives the same entries and hashes as LF', () => {
  const lf = M.splitEntries(SAMPLE, 'memory.md').entries;
  const crlf = M.splitEntries(SAMPLE.replace(/\n/g, '\r\n'), 'memory.md').entries;
  assert.deepEqual(crlf.map((e) => [e.line, e.sha256, e.text]), lf.map((e) => [e.line, e.sha256, e.text]));
});

test('lessons: entries under "## How I work" are pinned lessons, including ### subsections; the next ## ends it', () => {
  const drafts = M.importLegacyDetailed;   // via draftsFor on the split
  const { entries } = M.splitEntries(SAMPLE, 'memory.md');
  const kinds = entries.map((e) => M.draftsFor(e, 'legacy')[0]).map((d) => [d.kind, d.pin === true]);
  assert.deepEqual(kinds.slice(0, 2), [['lesson', true], ['lesson', true]]);
  assert.ok(kinds.slice(2).every(([k, p]) => k === 'fact' && !p));
  assert.ok(drafts);
});

test('dates: text first, then heading, then the rolled marker, then the file name; ISO for `at`', () => {
  const text = ['## 2026-09-30 restart', '- no date here', '- 2026-10-01 dated', '<!-- rolled 2026-09-28T10:00:00Z -->', '## Undated', '- after a rolled marker'].join('\n');
  const e = M.splitEntries(text, 'memory-archive-2026-09-27.md').entries;
  assert.deepEqual(e.map((x) => [x.date, x.dateSource]), [['2026-09-30', 'heading'], ['2026-10-01', 'text'], ['2026-09-30', 'heading']]);
  assert.equal(M.isoAt('2026-10-02T09:15'), '2026-10-02T09:15:00.000Z');
  assert.equal(M.isoAt('2026-10-02'), '2026-10-02T00:00:00.000Z');
  assert.equal(M.isoAt(null), undefined);
  const f = M.splitEntries('- plain', 'memory-archive-2026-09-27.md').entries[0];
  assert.deepEqual([f.date, f.dateSource], ['2026-09-27', 'file-name']);
  const g = M.splitEntries('<!-- rolled 2026-09-28T10:00:00Z -->\n- x', 'memory.md').entries[0];
  assert.deepEqual([g.date, g.dateSource], ['2026-09-28', 'rolled-upper-bound']);
});

test('G6.1 limit: the W6 limit is the frozen CLAIM_TEXT_MAX_LEGACY; a long entry splits into parts that concatenate back and hash to its legacy.sha256', () => {
  assert.equal(M.LEGACY_TEXT_MAX, C.CLAIM_TEXT_MAX_LEGACY);
  assert.equal(M.LEGACY_TEXT_MAX, 4000);
  const lines = ['- 2026-10-03 a long entry'];
  for (let i = 0; i < 120; i++) lines.push(`  continuation line ${i} `.padEnd(60, 'x'));
  lines.push('  ' + 'y'.repeat(9000));   // one line longer than the limit: split inside the line
  const e = M.splitEntries(lines.join('\n'), 'memory.md').entries;
  assert.equal(e.length, 1);
  const parts = M.draftsFor(e[0], 'legacy');
  assert.ok(parts.length >= 4);
  for (const p of parts) assert.ok(p.text.length <= 4000, `part of ${p.text.length}`);
  assert.equal(parts.map((p) => p.text).join(''), e[0].text, 'verbatim: nothing cut');
  assert.equal(sha(parts.map((p) => p.text).join('')), parts[0].legacy.sha256);
  assert.ok(parts.every((p) => JSON.stringify(p.legacy) === JSON.stringify(parts[0].legacy)), 'every part has the same provenance');
  // line boundaries first: every part but the in-line splits ends on a newline
  assert.ok(parts[0].text.endsWith('\n'));
});

test('a short entry over 400 stays whole (4000 is the W6 limit, not 400)', () => {
  const t = '- ' + 'z'.repeat(1500);
  const d = M.draftsFor(M.splitEntries(t, 'memory.md').entries[0], 'legacy');
  assert.equal(d.length, 1);
  assert.equal(d[0].text, t);
});

function agentDir() {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'memory-archive-2026-09-30.md'), '# Memory\n\n## 2026-09-29\n- old fact one\n- repeated fact\n');
  fs.writeFileSync(path.join(dir, 'memory.md'), '# Memory\n\n## 2026-10-03\n- new fact two\n- repeated fact\n');
  fs.writeFileSync(path.join(dir, 'notes.md'), '- not a memory file\n');
  return dir;
}

test('import: archives (by name) then memory.md; other .md files are not memory; source legacy with provenance', () => {
  const dir = agentDir();
  assert.deepEqual(M.legacyFiles(dir), ['memory-archive-2026-09-30.md', 'memory.md']);
  const d = M.importLegacy(dir);
  assert.deepEqual(d.map((x) => x.text), ['- old fact one', '- repeated fact', '- new fact two', '- repeated fact']);
  assert.ok(d.every((x) => x.t === 'claim' && x.source === 'legacy' && x.legacy && x.legacy.sha256 === sha(x.text)));
  assert.deepEqual(d.map((x) => x.legacy.file), ['memory-archive-2026-09-30.md', 'memory-archive-2026-09-30.md', 'memory.md', 'memory.md']);
  assert.equal(d[0].at, '2026-09-29T00:00:00.000Z');
});

test('G6.1 manifest: per file bytes, sha256, entries and the line reconciliation', () => {
  const dir = agentDir();
  const { manifest } = M.importLegacyDetailed(dir);
  for (const m of manifest) {
    const buf = fs.readFileSync(path.join(dir, m.file));
    assert.equal(m.bytes, buf.length);
    assert.equal(m.sha256, crypto.createHash('sha256').update(buf).digest('hex'));
    assert.equal(m.entryLines + m.skippedLines, m.nonBlankLines);
  }
  assert.deepEqual(manifest.map((m) => m.entries), [2, 2]);
});

test('G6.2 idempotence: a re-import creates 0 claims; repeats are imported once each', () => {
  const dir = agentDir();
  const first = M.newLegacyDrafts(dir, []);
  assert.equal(first.length, 4, 'both copies of the repeated entry are claims');
  assert.equal(M.newLegacyDrafts(dir, asRecords(first)).length, 0);
});

test('G6.2 per-hash counts: the ledger holds one copy of a repeated entry, the files hold two, so exactly one more is imported', () => {
  const dir = agentDir();
  const one = M.importLegacy(dir).filter((d) => d.text === '- repeated fact').slice(0, 1);
  const more = M.newLegacyDrafts(dir, asRecords(one));
  assert.deepEqual(more.map((d) => d.text), ['- old fact one', '- new fact two', '- repeated fact']);
});

test('G6.2 idempotence over split parts: the parts of one entry count as one entry', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'memory.md'), '- ' + 'p'.repeat(9000) + '\n- short\n');
  const first = M.newLegacyDrafts(dir, []);
  assert.equal(first.length, 4);   // 3 parts + 1
  assert.equal(M.newLegacyDrafts(dir, asRecords(first)).length, 0);
});

test('G6.2/G6.4: an entry the REAL 1.1.83 rollover moves from memory.md into an archive creates 0 new claims', () => {
  const dir = tmp();
  const body = ['# Memory: a', '', R.PINNED_SEED.trimEnd(), '- a pinned lesson', ''];
  for (let i = 0; i < 400; i++) body.push(`## 2026-10-0${1 + (i % 3)} section ${i}`, `- fact number ${i}: ${'w'.repeat(80)}`, '');
  fs.writeFileSync(path.join(dir, 'memory.md'), body.join('\n'));
  const first = M.newLegacyDrafts(dir, []);
  const before = new Set(first.map((d) => d.legacy.sha256));
  const r = R.rolloverMemory(dir, Date.parse('2026-10-03T12:00:00Z'));
  assert.ok(r && (r.rolled === true || r.archived || r.archive), `rollover ran: ${JSON.stringify(r)}`);
  assert.ok(M.legacyFiles(dir).length >= 2, 'an archive now exists');
  const moved = M.importLegacyDetailed(dir).entries.filter((e) => e.file !== 'memory.md' && before.has(e.sha256));
  assert.ok(moved.length > 100, `entries moved into the archive: ${moved.length}`);
  const again = M.newLegacyDrafts(dir, asRecords(first));
  assert.deepEqual(again.map((d) => d.text), [], 'nothing re-imported after the move');
});

test('parser: skips known hashes and rendered [c:id] lines; a new entry becomes a self claim, whole even over 400', () => {
  const records = asRecords([{ t: 'claim', kind: 'fact', text: '- known', source: 'legacy', legacy: { file: 'memory.md', line: 1, sha256: sha('- known') } }]);
  const known = M.knownIdsFor(records);
  assert.ok(known.has('c0') && known.has(`b:${sha('- known')}`));
  const long = '- ' + 'n'.repeat(900);
  const md = ['- known', '- rendered line [c:c0]', '- tagged with an unknown id [c:zz9]', long].join('\n');
  const d = M.parseNewBullets(md, known);
  assert.deepEqual(d.map((x) => x.text), ['- tagged with an unknown id [c:zz9]', long]);
  assert.ok(d.every((x) => x.source === 'self' && x.legacy && x.legacy.file === 'memory.md'));
});

test('parser + import agree: a parsed self claim is not re-imported later as legacy', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'memory.md'), '- first\n');
  const recs = asRecords(M.newLegacyDrafts(dir, []));
  fs.appendFileSync(path.join(dir, 'memory.md'), '- added by the agent\n');
  const parsed = M.parseNewBullets(fs.readFileSync(path.join(dir, 'memory.md'), 'utf8'), M.knownIdsFor(recs));
  assert.deepEqual(parsed.map((x) => x.text), ['- added by the agent']);
  const all = recs.concat(asRecords(parsed, recs.length));
  assert.equal(M.newLegacyDrafts(dir, all).length, 0);
});

test('G6.5 frozen backup: byte-identical copies plus a manifest; never overwritten', () => {
  const dir = agentDir();
  const dest = path.join(tmp(), 'backup');
  const a = M.frozenBackup(dir, dest);
  assert.equal(a.written, true);
  for (const f of a.files) {
    assert.ok(fs.readFileSync(path.join(dest, f.file)).equals(fs.readFileSync(path.join(dir, f.file))));
  }
  fs.appendFileSync(path.join(dir, 'memory.md'), '- later\n');
  const b = M.frozenBackup(dir, dest);
  assert.equal(b.written, false);
  assert.notDeepEqual(fs.readFileSync(path.join(dest, 'memory.md')), fs.readFileSync(path.join(dir, 'memory.md')));
  assert.deepEqual(b.files, a.files);
});

test('the module never sets a source an external caller could choose: only legacy (import) and self (parser)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'claims', 'migrate.ts'), 'utf8');
  assert.ok(!/source:\s*'(human|god)'/.test(src));
  assert.ok(!/mail:/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')));
});

test('part counting is order-proof: another record between two parts, and a part orphaned by a crash', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'memory.md'), '- ' + 'q'.repeat(9000) + '\n');
  const parts = M.newLegacyDrafts(dir, []);
  assert.equal(parts.length, 3);
  const other = { t: 'claim', kind: 'fact', text: 'a note from elsewhere', source: 'self' };
  const interleaved = asRecords([parts[0], other, parts[1], parts[2]]);
  assert.equal(M.newLegacyDrafts(dir, interleaved).length, 0, 'interleaved parts still count as the entry');
  const orphan = asRecords([parts[0]]);   // a crash after the first part
  assert.equal(M.newLegacyDrafts(dir, orphan).length, 3, 'a lone part is not the entry: it is imported again');
  assert.ok(!M.knownIdsFor(orphan).has(`b:${parts[0].legacy.sha256}`), 'nor is it "known" to the parser');
  const healed = asRecords([parts[0], ...parts]);
  assert.equal(M.newLegacyDrafts(dir, healed).length, 0, 'after the re-import the orphan blocks nothing');
});
