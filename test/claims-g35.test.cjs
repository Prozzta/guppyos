'use strict';
/**
 * G3.5 product fixes (Jim's CL-W8-G35-PARITY.md findings 1-3), invented text only, HOME jailed first:
 *   (1) ROOMS: a claim chunk is filed in the room its Markdown had (an archive's room, memory.md's
 *       `memory`; a note: `memory`), so a room-scoped search keeps legacy parity;
 *   (2) SECTION: W6 carries an entry's heading as ClaimRec.section on BOTH paths (the import and the
 *       fallback parser), cut at 200 (never refused), import-only, MAC-covered, outside R1's
 *       identity, never printed per bullet in an export, and in every chunk as a heading line;
 *   (3) TAILS: a long claim is cut into even parts, each later part led by the claim's first line.
 * The search-side half of (1) is the W3 drill scenario 'rooms' (claims-w3-index.test.cjs).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-claims-g35-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
const STORES = [];
test.after(() => {
  for (const s of STORES) s.close();
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const loadTs = require('./load-ts.cjs');
const { chunksFor, claimParts, claimLead, claimRoom, CLAIM_CHUNK_CHARS } = loadTs('src/main/claims/chunks.ts');
const { claimEmbedText } = loadTs('src/main/nativeMemory/store.ts');
const M = loadTs('src/main/claims/migrate.ts');
const { ClaimStore } = loadTs('src/main/claims/store.ts');
const { SandboxKeyProvider, FileLedgerKeyRecord, KEY_RECORD_FILE } = loadTs('src/main/claims/keyProvider.ts');
const { handleClaimVerb } = loadTs('src/main/claims/endpoint.ts');
const { createClaimViews } = loadTs('src/main/claims/views.ts');
const { sha256Hex } = loadTs('src/main/claims/canonical.ts');

const rec = (id, text, extra = {}) => ({ v: 1, id, t: 'claim', kind: 'fact', text, source: 'legacy', at: '2026-09-27T00:00:00.000Z', wt: '2026-10-04T00:00:00.000Z', agent: 'a1', prev: '', mac: 'm', ...extra });
const live = (...ids) => ({ claims: Object.fromEntries(ids.map((id) => [id, { id, status: 'live' }])) });
let n = 0;
function store() {
  const root = path.join(JAIL, `hive-${++n}`);
  fs.mkdirSync(path.join(root, 'agents', 'a1'), { recursive: true });
  const s = new ClaimStore({ hiveRoot: root, keys: new SandboxKeyProvider(), keyRecord: new FileLedgerKeyRecord(path.join(`${root}-ud`, KEY_RECORD_FILE)) });
  STORES.push(s);
  return { root, s };
}

// ——— (1) rooms ———

test('G3.5 (1): a claim chunk is filed in its legacy file\'s room; memory.md and notes go to `memory`', () => {
  const out = chunksFor([
    rec('c-000000000001', '- 2026-09-27 synthetic archived fact', { legacy: { file: 'memory-archive-2026-09-27.md', line: 4, sha256: 'a'.repeat(64) } }),
    rec('c-000000000002', '- 2026-10-02 synthetic memory.md fact', { legacy: { file: 'memory.md', line: 9, sha256: 'b'.repeat(64) } }),
    rec('c-000000000003', 'a synthetic note written after the migration', { source: 'self' }),
    rec('c-000000000004', 'a synthetic claim with a path in its legacy file', { legacy: { file: 'sub/memory-archive-x.md', line: 1, sha256: 'c'.repeat(64) } }),
  ], live('c-000000000001', 'c-000000000002', 'c-000000000003', 'c-000000000004'));
  assert.deepEqual(out.map((c) => c.room), ['memory-archive-2026-09-27', 'memory', 'memory', 'memory']);
  assert.equal(claimRoom({ legacy: { file: 'Memory-Archive-2026-10-01.md' } }), 'memory-archive-2026-10-01', 'named as sources.ts names the Markdown room');
});

// ——— (2) section ———

const MD = '# Memory - a1\n\n## CUT RECIPE, STEP ZERO\n- 2026-10-01 synthetic: fetch the release branch before cutting\n\n## 2026-10-02 synthetic session\n- 2026-10-02 synthetic: the relay listens on port 4471\n';

test('G3.5 (2): W6 carries the heading as `section` on BOTH paths: the legacy import and the fallback parser', () => {
  const dir = path.join(JAIL, 'agent-import'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory-archive-2026-10-02.md'), MD);
  const imported = M.importLegacy(dir);
  assert.deepEqual(imported.map((d) => d.section), ['CUT RECIPE, STEP ZERO', '2026-10-02 synthetic session']);
  const parsed = M.parseNewBullets(MD, new Set());
  assert.deepEqual(parsed.map((d) => d.section), ['CUT RECIPE, STEP ZERO', '2026-10-02 synthetic session']);
  assert.equal(M.parseNewBullets('- 2026-10-03 synthetic headless bullet\n', new Set())[0].section, undefined, 'no heading, no section');
});

test('G3.5 (2): a section is cut at 200 on a code-point boundary, never refused and never a lone surrogate', () => {
  assert.equal(M.SECTION_MAX, 200);
  const long = 'S'.repeat(199) + '\u{1F600}' + 'tail';   // the emoji's high surrogate sits at index 199
  const cut = M.clampSection(long);
  assert.equal(cut, 'S'.repeat(199));
  assert.ok(!/[\uD800-\uDBFF]$/.test(cut));
  assert.equal(M.clampSection('x'.repeat(300)).length, 200);
  assert.equal(M.clampSection('  spaced heading  '), 'spaced heading');
  assert.equal(M.clampSection('   '), undefined);
  const e = { file: 'memory.md', line: 3, style: 'bullet', multiLine: false, section: 'H'.repeat(500), date: null, dateSource: 'none', sha256: sha256Hex('- x'), text: '- synthetic entry under a giant heading', lesson: false };
  const r = M.entryDrafts(e, 'legacy');
  assert.equal(r.refusal, null, 'never refused'); assert.equal(r.drafts.length, 1, 'never dropped'); assert.equal(r.drafts[0].section.length, 200);
});

test('G3.5 (2): the store keeps a section from the import only (MAC-covered); the endpoint refuses one', async () => {
  const { s } = store();
  const ok = await s.appendRecord('a1', { t: 'claim', kind: 'fact', text: '- synthetic sectioned entry', source: 'legacy', legacy: { file: 'memory.md', line: 2, sha256: sha256Hex('- synthetic sectioned entry') }, section: 'SYNTHETIC HEADING' }, 'w6-internal');
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(s.readLedger('a1').records[0].section, 'SYNTHETIC HEADING');
  const viaStore = await s.appendRecord('a1', { t: 'claim', kind: 'fact', text: 'synthetic', section: 'x' }, 'endpoint');
  assert.equal(viaStore.ok, false); assert.match(viaStore.error, /section is set by the import only/);
  const viaVerb = await handleClaimVerb({ store: s, level: () => 'writer' }, 'a1', { cmd: 'note', args: { text: 'synthetic', section: 'x' } }, 'endpoint');
  assert.equal(viaVerb.ok, false); assert.match(viaVerb.error, /"section" is set by the app/);
  // MAC coverage: editing only the section in the segment breaks the chain.
  const seg = s.segments('a1')[0];
  fs.writeFileSync(seg, fs.readFileSync(seg, 'utf8').replace('SYNTHETIC HEADING', 'SYNTHETIC HEADINX'));
  const read = s.readLedger('a1');
  assert.notEqual(read.chain, 'ok', 'the section is under the MAC');
  assert.equal(read.chain.reason, 'mac');
});

test('G3.5 (2): R1\'s identity excludes section: the same entry under another heading is the same claim (W6 dedup, A7.2)', async () => {
  const { s } = store();
  const text = '- synthetic entry seen under two headings';
  const d = (section, line) => ({ t: 'claim', kind: 'fact', text, source: 'legacy', legacy: { file: 'memory.md', line, sha256: sha256Hex(text) }, section });
  const a = await s.appendRecord('a1', d('FIRST SYNTHETIC HEADING', 3), 'w6-internal');
  const b = await s.appendRecord('a1', d('SECOND SYNTHETIC HEADING', 9), 'w6-internal');
  assert.match(a.id, /^c-/);
  assert.match(b.id, /^e-/, 'a sighting, not a second claim');
  assert.equal(M.ledgerEntryCounts(s.readLedger('a1').records).get(sha256Hex(text)), 2, 'W6 counts it imported twice');
});

test('G3.5 (2): every chunk carries `## <section>` (searched and embedded), inside the chunk budget', () => {
  const section = 'CUT RECIPE, STEP ZERO';
  const [c] = chunksFor([rec('c-000000000010', '- synthetic: fetch before cutting', { section })], live('c-000000000010'));
  assert.equal(c.content, `fact · - · 2026-09-27\n## ${section}\n- synthetic: fetch before cutting`);
  assert.equal(claimEmbedText(c.content), `## ${section}\n- synthetic: fetch before cutting`, 'the heading is embedded; the kind · key · date line is not (F1)');
  const long = Array.from({ length: 40 }, (_, i) => `- synthetic step ${i}: the widget relay calibrates the crate`).join('\n');
  const parts = chunksFor([rec('c-000000000011', long, { section: 'H'.repeat(200) })], live('c-000000000011'));
  assert.ok(parts.length >= 3);
  for (const p of parts) {
    assert.ok(p.content.includes(`\n## ${'H'.repeat(200)}\n`), 'in every part');
    assert.ok(p.content.length <= CLAIM_CHUNK_CHARS, `a part of ${p.content.length} characters overruns the ${CLAIM_CHUNK_CHARS} budget`);
  }
});

test('G3.5 (2): the exports never print a section per bullet', () => {
  const r = rec('c-000000000020', '- synthetic exported fact', { section: 'SYNTHETIC EXPORT HEADING' });
  const state = { v: 1, agent: 'a1', registryHash: '', ledgerHead: '', conflicts: [], claims: { [r.id]: { id: r.id, status: 'live', sightings: 1, firstAt: r.at, lastAt: r.at, pinned: false, reasons: [] } } };
  const v = createClaimViews([r], () => 0);
  assert.ok(!v.renderExportLine(r, state).includes('SYNTHETIC EXPORT HEADING'));
  assert.ok(!v.renderMemoryMd(state, { flags: {}, counters: {} }, 'complete').includes('SYNTHETIC EXPORT HEADING'));
});

// ——— (3) tails ———

test('G3.5 (3): a long claim is cut into EVEN parts, and each later part is led by the claim\'s first line', () => {
  const first = '- 2026-10-03 synthetic cut 1.1.80: the release gate ran three rounds on the relay';
  const text = `${first}\n${Array.from({ length: 10 }, (_, i) => `  round ${i}: the widget relay calibrated the crate and the gizmo`).join('\n')}\n  verdict: synthetic unauthorized.`;
  const budget = 460;
  const parts = claimParts(text, budget);
  assert.ok(parts.length >= 2, `${parts.length} parts`);
  const lead = claimLead(text);
  const sizes = parts.map((p, i) => (i === 0 ? p.length : p.length - lead.length - 1));   // the text each part holds
  assert.ok(Math.min(...sizes) >= Math.max(...sizes) / 2, `even parts, no contextless tail: ${sizes}`);
  assert.equal(lead, `${first} …`);
  for (const p of parts.slice(1)) assert.ok(p.startsWith(`${lead}\n`), 'a later part says what it is about');
  for (const p of parts) assert.ok(p.length <= budget, `part of ${p.length} > ${budget}`);
  const body = [parts[0], ...parts.slice(1).map((p) => p.slice(lead.length + 1))].join('\n');
  for (const line of text.split('\n')) assert.ok(body.includes(line.trim()), 'every line is kept');
  assert.deepEqual(claimParts('short synthetic claim', budget), ['short synthetic claim'], 'a short claim is one part, unled');
  const longFirst = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');   // over 100 characters
  const cut = claimLead(longFirst);
  assert.ok(cut.endsWith(' …') && cut.length <= 102 && longFirst.startsWith(cut.slice(0, -2)), `cut at a word: ${cut.length}`);
});
