'use strict';
// CL-W6-VIEW-SECTION: in a GENERATED memory.md, W4's own headings (the title, "How I work",
// "Working set", "All claims") give a bullet the agent appends below them no `section`. A heading
// the agent writes itself keeps its section, and so does every heading of a legacy (not generated)
// memory.md. All text here is invented.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'md-claims-viewsec-'));
const prior = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
process.env.HOME = JAIL; process.env.USERPROFILE = JAIL;
assert.equal(os.homedir(), JAIL, 'HOME must be jailed before any product code loads');
test.after(() => {
  for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(JAIL, { recursive: true, force: true });
});

const loadTs = require('./load-ts.cjs');
const M = loadTs('src/main/claims/migrate.ts');
const G = loadTs('src/main/claims/generated.ts');
const { createClaimViews } = loadTs('src/main/claims/views.ts');

const AT = '2026-10-03T00:00:00.000Z';
const rec = (id, kind, text) => ({ v: 1, id, t: 'claim', kind, text, source: 'self', at: AT, wt: AT, agent: 'a1', prev: '', mac: 'm' });
const RECS = [
  rec('c-0000000000a1', 'lesson', 'synthetic lesson: run the focused tests before the suite'),
  rec('c-0000000000a2', 'fact', 'synthetic fact: the relay listens on port 4471'),
];
const STATE = { v: 1, agent: 'a1', registryHash: '', ledgerHead: '', conflicts: [],
  claims: Object.fromEntries(RECS.map((r) => [r.id, { id: r.id, status: 'live', sightings: 1, firstAt: AT, lastAt: AT, pinned: false, reasons: [] }])) };
const WORLD = { flags: {}, counters: {} };
const KNOWN = new Set(RECS.map((r) => r.id));
const render = (mode) => createClaimViews(RECS, () => 1).renderMemoryMd(STATE, WORLD, mode);

test('every heading a generated view holds is a view heading (both modes), so the list cannot drift from W4', () => {
  for (const mode of ['view', 'complete']) {
    const md = render(mode);
    assert.ok(G.isGeneratedMemory(md), `${mode}: starts with the marker`);
    const headings = md.split('\n').filter((l) => /^#{1,6} /.test(l)).map((l) => l.replace(/^#+ /, ''));
    assert.ok(headings.length >= 2, `${mode}: renders headings`);
    for (const h of headings) assert.ok(G.isGeneratedViewHeading(h), `${mode}: "${h}" is not in GENERATED_VIEW_HEADINGS`);
  }
  assert.ok(render('view').includes('\n## Working set\n'), 'the view holds the Working set heading this card is about');
});

test('a bullet appended under a generated view heading gets no section; an agent heading below keeps its own', () => {
  for (const mode of ['view', 'complete']) {
    const md = render(mode)
      + '- 2026-10-04 synthetic appended note under the view\n'
      + '\n## Synthetic agent heading\n- 2026-10-04 synthetic note under the agent heading\n';
    const drafts = M.parseNewBullets(md, KNOWN);
    assert.deepEqual(drafts.map((d) => d.text), ['- 2026-10-04 synthetic appended note under the view', '- 2026-10-04 synthetic note under the agent heading'], `${mode}: only the two new bullets`);
    assert.equal(drafts[0].section, undefined, `${mode}: no section from the view's last heading`);
    assert.ok(!('section' in drafts[0]), `${mode}: the field is absent, not empty`);
    assert.equal(drafts[1].section, 'Synthetic agent heading', `${mode}: the agent's own heading is kept`);
  }
});

test('each view heading yields no section, and a non-view heading in a generated file keeps its section', () => {
  const head = G.GENERATED_MEMORY_MARKER + '\n# Memory — a1\n';
  const md = head + '- synthetic bullet under the title\n'
    + G.GENERATED_VIEW_HEADINGS.map((h, i) => `\n## ${h}\n- synthetic bullet ${i} under a view heading\n`).join('')
    + '\n## Working set notes\n- synthetic bullet under a lookalike agent heading\n';
  const drafts = M.parseNewBullets(md, new Set());
  assert.equal(drafts.length, G.GENERATED_VIEW_HEADINGS.length + 2);
  assert.deepEqual(drafts.slice(0, -1).map((d) => d.section), drafts.slice(0, -1).map(() => undefined));
  assert.equal(drafts.at(-1).section, 'Working set notes', 'only an exact view heading is scaffolding');
});

test('a legacy (not generated) memory.md keeps every heading as a section, view-named ones included', () => {
  const md = '# Memory — a1\n- synthetic bullet under the title\n\n## Working set\n- synthetic bullet under a hand-written Working set\n';
  assert.ok(!G.isGeneratedMemory(md));
  const drafts = M.parseNewBullets(md, new Set());
  assert.deepEqual(drafts.map((d) => d.section), ['Memory — a1', 'Working set']);
});
