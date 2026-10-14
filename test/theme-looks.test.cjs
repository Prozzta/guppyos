'use strict';

// Theme looks, part 2: durable per-theme looks, the builder's draft flow,
// fallbacks, and the one portrait route every census site goes through.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const H = require('./fixtures/themes/pack-helpers.cjs');

const L = loadTs('src/renderer/src/scene/themes/looks.ts');
const Mf = loadTs('src/renderer/src/scene/themes/manifest.ts');
const A = loadTs('src/renderer/src/scene/themes/seatAllocator.ts');

const manifest = Mf.validateManifest(JSON.parse(H.readPackDir(H.NEUTRAL)['theme.json'])).manifest;
const B = manifest.builder, COLS = 2, THEME = manifest.id;
const pack = { themeId: THEME, builder: B, sprite: manifest.spriteRenderer, columns: COLS };
const SIZE = { w: 18, h: 28 };
const clone = (v) => JSON.parse(JSON.stringify(v));

test('builder flow: body -> name -> colours -> presets, each step a live draft', () => {
  let d = L.startDraft(B, COLS);
  assert.deepEqual(d, { bodyId: 'light', colors: { skin: '#fad6b8', shirt: '#c0302c', hair: '#71413b' }, source: 'custom' }, 'Add starts at the pack default');
  d = L.pickBody(B, COLS, d, 'dark');
  assert.equal(d.bodyId, 'dark');
  assert.equal(d.colors.hair, '#242234', "the new body's own hair (not the old body's brown)");
  assert.equal(d.colors.shirt, '#c0302c', 'a colour both bodies allow is kept');
  d = L.setColour(B, COLS, d, 'shirt', '#123456');
  assert.equal(d.colors.shirt, '#123456', 'a custom colour (the pack allows them)');
  assert.equal(L.setColour(B, COLS, d, 'shirt', 'blue'), d, 'not a colour: no change');
  const p = L.pickPreset(B, COLS, d, 'pilot');
  assert.equal(p.name, 'Pilot', 'the preset suggests its label as the name');
  assert.deepEqual(p.draft, { bodyId: 'dark', colors: { skin: '#7b4d34', shirt: '#a07a1c', hair: '#242234' }, presetId: 'pilot', source: 'preset' });
  const recoloured = L.setColour(B, COLS, p.draft, 'shirt', '#285cc4');
  assert.equal(recoloured.presetId, 'pilot', 'a recoloured premade is still that premade (it keeps its seat)');
  assert.equal(recoloured.source, 'custom');
  assert.equal(L.pickBody(B, COLS, recoloured, 'light').presetId, undefined, 'another body is another character');
  assert.deepEqual(L.draftToLook(p.draft), { bodyId: 'dark', colors: p.draft.colors, presetId: 'pilot', source: 'preset', version: 1 });
});

test('swatch-only packs refuse custom colours', () => {
  const strict = { ...B, customColours: false };
  const d = L.startDraft(strict, COLS);
  assert.equal(L.setColour(strict, COLS, d, 'shirt', '#123456'), d);
  assert.equal(L.setColour(strict, COLS, d, 'shirt', '#a07a1c').colors.shirt, '#a07a1c');
  const r = L.resolveLook(strict, COLS, { bodyId: 'light', colors: { skin: '#fad6b8', shirt: '#123456', hair: '#71413b' }, source: 'custom', version: 1 }, 'x');
  assert.equal(r.colors.shirt, '#c0302c', 'a stored non-swatch colour falls back to the default');
  assert.equal(r.exact, false);
});

test('Add and Edit round-trip: a saved look survives the roster file and resolves the same', () => {
  const look = L.draftToLook(L.pickPreset(B, COLS, L.startDraft(B, COLS), 'pilot').draft);
  const agent = { id: 'a1', name: 'Pilot', character: 'jim', accent: 'coral', appearanceByTheme: { [THEME]: look } };
  const reloaded = JSON.parse(JSON.stringify([agent]))[0]; // the roster mirror is JSON
  assert.deepEqual(L.readLook(reloaded.appearanceByTheme[THEME]), look);
  assert.deepEqual(L.resolveLook(B, COLS, L.readLook(reloaded.appearanceByTheme[THEME]), 'a1'), L.resolveLook(B, COLS, look, 'a1'));
  // Edit starts from the saved look, and saving a change keeps every other theme's look
  const d = L.startDraft(B, COLS, L.readLook(reloaded.appearanceByTheme[THEME]), 'a1');
  assert.deepEqual(L.draftToLook(d), look);
  const other = { bodyId: 'x', colors: { skin: '#000000', shirt: '#000000', hair: '#000000' }, source: 'custom', version: 1 };
  const all = L.withLook({ 'other-pack': other, [THEME]: look }, THEME, L.draftToLook(L.setColour(B, COLS, d, 'hair', '#ececec')));
  assert.deepEqual(all['other-pack'], other);
  assert.equal(all[THEME].colors.hair, '#ececec');
});

test('Edit of an agent with no look starts from the look it is shown with (saving untouched changes nothing)', () => {
  for (const id of ['a', 'b', 'c', 'worker-17']) {
    const shown = L.resolveLook(B, COLS, null, id);
    const d = L.startDraft(B, COLS, null, id);
    assert.equal(d.bodyId, shown.body.id, id);
    assert.deepEqual(L.resolveLook(B, COLS, L.draftToLook(d), id).colors, shown.colors, id);
  }
});

test('theme switch and back: the Office identity and the pack look are both preserved', () => {
  const look = L.draftToLook(L.startDraft(B, COLS));
  const agent = { id: 'a1', name: 'Dana', character: 'pam', accent: 'teal', appearanceByTheme: { [THEME]: look } };
  const before = clone(agent);
  // Office: the portrait route paints the Office character, and nothing is written
  assert.deepEqual(L.portraitPlan('office', pack, { agent }, SIZE), { kind: 'office', character: 'pam' });
  // back on the pack: the same look
  const plan = L.portraitPlan(THEME, pack, { agent }, SIZE);
  assert.equal(plan.kind, 'pack');
  assert.equal(plan.body.id, look.bodyId);
  assert.deepEqual(plan.colors, look.colors);
  assert.deepEqual(agent, before, 'resolving never mutates the agent');
});

test('fallbacks: missing, unknown and invalid looks resolve to the manifest default without touching the record', () => {
  const none = L.resolveLook(B, COLS, null, 'agent-x');
  assert.equal(none.exact, false);
  assert.ok(['light', 'dark'].includes(none.body.id), 'no look: a stable body from the id');
  assert.equal(L.resolveLook(B, COLS, null, 'agent-x').body.id, none.body.id, 'stable');
  const stored = { bodyId: 'ghost', colors: { skin: 'nope', shirt: '#123456', hair: '' }, presetId: 'gone', source: 'preset', version: 1 };
  const copy = clone(stored);
  const r = L.resolveLook(B, COLS, stored, 'a');
  assert.equal(r.body.id, 'light', 'unknown body -> defaults.bodyId');
  assert.equal(r.colors.skin, '#fad6b8', "bad colour -> the body's own");
  assert.equal(r.colors.shirt, '#123456', 'a good colour is kept');
  assert.equal(r.presetId, undefined, 'a preset the pack no longer has');
  assert.equal(r.exact, false);
  assert.deepEqual(stored, copy);
  for (const junk of [null, 5, 'x', [], { colors: {} }, { bodyId: '' }]) assert.equal(L.readLook(junk), null, JSON.stringify(junk));
  assert.equal(L.readLook({ bodyId: 'light', colors: {}, source: 'hacked' }).source, 'custom');
});

test('a preset look drives seat affinity: the Human rule via the builder record', () => {
  const look = L.draftToLook(L.pickPreset(B, COLS, L.startDraft(B, COLS), 'pilot').draft);
  const agents = [{ id: 'g1' }, { id: 'p1', appearanceByTheme: { [THEME]: look } }];
  const alloc = new A.SeatAllocator(A.seatRulesFrom(manifest));
  alloc.join({ id: 'g1', presetId: L.presetIdOf(B, agents[0], THEME) });
  assert.equal(alloc.seat('g1'), 'Beta');
  alloc.join({ id: 'p1', presetId: L.presetIdOf(B, agents[1], THEME) });
  assert.equal(alloc.seat('p1'), 'Beta', 'the pilot preset takes its seat');
  assert.equal(alloc.seat('g1'), 'Gamma', 'the generic moves on');
  assert.equal(L.presetIdOf(B, agents[1], 'other-pack'), undefined, 'a look is per theme');
});

test('spawn requests: a preset, body or colours become a look; junk is ignored', () => {
  assert.deepEqual(L.lookFromRequest(B, { presetId: 'pilot' }).presetId, 'pilot');
  const x = L.lookFromRequest(B, { bodyId: 'dark', colors: { shirt: '#a07a1c', hair: 'blond' } });
  assert.equal(x.bodyId, 'dark');
  assert.equal(x.colors.shirt, '#a07a1c');
  assert.equal(x.colors.hair, '#242234');
  assert.equal(L.lookFromRequest(B, { presetId: 'ghost', bodyId: 'ghost' }), null);
  assert.equal(L.lookFromRequest(undefined, { presetId: 'pilot' }), null, 'the office has no builder');
  assert.equal(L.lookFromRequest(B, 'pilot'), null);
});

// ─── Portrait census: one route for every site ───────────────────────────────

test('portrait plan: agent, draft and sample under a pack; everything Office under the office', () => {
  const look = L.draftToLook(L.pickPreset(B, COLS, L.startDraft(B, COLS), 'pilot').draft);
  const agent = { id: 'a1', character: 'jim', appearanceByTheme: { [THEME]: look } };
  const a = L.portraitPlan(THEME, pack, { agent }, SIZE);
  assert.equal(a.kind, 'pack');
  assert.equal(a.body.id, 'dark');
  assert.equal(a.row, manifest.spriteRenderer.rows.down, 'the front frame');
  assert.deepEqual(a.crop, [7, 4, 18, 28], "dark has no portrait box: the default, the card's size at the frame's bottom centre");
  assert.deepEqual([a.sx, a.sy], [32, 0]);
  const lightAgent = { id: 'a2', character: 'jim', appearanceByTheme: { [THEME]: L.draftToLook(L.startDraft(B, COLS)) } };
  assert.deepEqual(L.portraitPlan(THEME, pack, { agent: lightAgent }, SIZE).crop, [7, 4, 18, 28], "the body's declared box");
  const draft = L.setColour(B, COLS, L.startDraft(B, COLS), 'hair', '#ececec');
  assert.equal(L.portraitPlan(THEME, pack, { draft, character: 'jim' }, SIZE).colors.hair, '#ececec', 'the live draft');
  const sample = L.portraitPlan(THEME, pack, { sample: true, character: 'michael' }, SIZE);
  assert.equal(sample.kind, 'pack');
  assert.equal(sample.colors.hair, '#ececec', "the manifest's sample (the medic preset)");
  // The Office cast pickers pass a character only: always the Office art, under any theme
  assert.deepEqual(L.portraitPlan(THEME, pack, { character: 'dwight' }, SIZE), { kind: 'office', character: 'dwight' });
  // Under the office (or before/without a usable pack) every subject is the Office character
  for (const s of [{ agent }, { draft, character: 'jim' }, { sample: true, character: 'michael' }]) {
    assert.equal(L.portraitPlan('office', pack, s, SIZE).kind, 'office');
    assert.equal(L.portraitPlan(THEME, null, s, SIZE).kind, 'office', 'pack not usable: Office');
    assert.equal(L.portraitPlan(THEME, { ...pack, themeId: 'other' }, s, SIZE).kind, 'office', 'a stale pack is never used');
  }
  // archived agents carry the same record, so they regenerate the same card
  const archived = JSON.parse(JSON.stringify(agent));
  assert.deepEqual(L.portraitPlan(THEME, pack, { agent: archived }, SIZE), a);
});

test('portrait placement: the crop fills the card, square pixels, standing on the bottom edge', () => {
  assert.deepEqual(L.portraitPlacement([7, 4, 18, 28], 18, 28), { dx: 0, dy: 0, dw: 18, dh: 28 });
  assert.deepEqual(L.portraitPlacement([7, 4, 18, 28], 36, 56), { dx: 0, dy: 0, dw: 36, dh: 56 });
  assert.deepEqual(L.portraitPlacement([0, 0, 32, 32], 18, 28), { dx: 0, dy: 10, dw: 18, dh: 18 });
  assert.deepEqual(L.defaultCrop(32, 32, 18, 28), [7, 4, 18, 28]);
  assert.deepEqual(L.defaultCrop(16, 16, 18, 28), [0, 0, 16, 16]);
});

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

test('census: every SpritePortrait site goes through the one route with the right subject', () => {
  const sites = [
    ['src/renderer/src/components/AgentCard.tsx', /<SpritePortrait agent=\{\{ id: agentId, character, appearanceByTheme \}\} scale=\{2\} \/>/],
    ['src/renderer/src/components/AgentDetailPanel.tsx', /<SpritePortrait agent=\{agent\} scale=\{1\} \/>/],
    ['src/renderer/src/components/CommandCenterPanel.tsx', /<SpritePortrait agent=\{agent\} scale=\{1\} \/>/],
    ['src/renderer/src/components/FullscreenTerminal.tsx', /<SpritePortrait agent=\{agent\} scale=\{scale\.portraitScale\} \/>/],
    ['src/renderer/src/components/AddAgentModal.tsx', /<SpritePortrait character=\{c\.name\} scale=\{2\} \/>/],
    ['src/renderer/src/components/EditAgentModal.tsx', /<SpritePortrait character=\{c\.name\} scale=\{1\.5\} \/>/],
  ];
  for (const [f, re] of sites) assert.match(read(f), re, f);
  const cc = read('src/renderer/src/components/CommandCenterPanel.tsx');
  assert.equal((cc.match(/<SpritePortrait agent=\{a\} scale=\{1\} \/>/g) || []).length, 2, 'live row and archive row');
  const ob = read('src/renderer/src/components/OnboardingWizard.tsx');
  assert.equal((ob.match(/<SpritePortrait sample character="michael" scale=\{2\} \/>/g) || []).length, 2, 'both onboarding samples');
  assert.match(read('src/renderer/src/components/AgentStrip.tsx'), /agentId=\{a\.id\}\s+appearanceByTheme=\{a\.appearanceByTheme\}/);
  // nobody calls the Office painter except SpritePortrait itself
  const comps = fs.readdirSync(path.join(__dirname, '../src/renderer/src/components')).filter((f) => f.endsWith('.tsx'));
  for (const f of comps) if (f !== 'SpritePortrait.tsx') assert.doesNotMatch(read('src/renderer/src/components/' + f), /paintCastPortrait/, f);
  const sp = read('src/renderer/src/components/SpritePortrait.tsx');
  assert.match(sp, /portraitPlan\(/);
  assert.match(sp, /paintCastPortrait\(octx, character, scale\)/, 'the Office path is the unchanged painter');
  // the async Office paint lands only while its effect is current (never over a newer pack paint)
  assert.match(sp, /\.then\(\(\) => \{\s+if \(!live\) return;/);
  assert.match(sp, /return \(\) => \{ live = false; \};/);
});

test.skip('legacy Add picker assertion superseded by the pack-capability coverage below', () => {
  const add = read('src/renderer/src/components/AddAgentModal.tsx');
  assert.match(add, /const isTesTheme = officeTheme === 'tes';/);
  assert.match(add, /useState\(pendingHire\?\.name \?\? \(isTesTheme \? 'Crewmate' : 'Jim'\)\)/, 'TES starts with no Office-character name');
  assert.match(add, /\{!isTesTheme && \(\s*<Row label="Character">[\s\S]*?OFFICE_CAST\.map/, 'TES cannot render Office cast tiles');
  assert.match(add, /data-office-character-picker/, 'the Office picker has a direct visual-census hook');
  assert.match(add, /<ThemeLookBuilder[\s\S]*?officeCharacterVisible=\{!isTesTheme\}/, 'TES builder is the visible picker');
  assert.match(add, /const \[character, setCharacter\] = useState<OfficeCharacterName>\(knownCharacter\(/, 'new agents retain a valid Office fallback');
  assert.match(add, /appearanceByTheme: \{ \[looks\.themeId\]: draftToLook\(lookDraft\) \}/, 'new agents save their visible pack look');
  assert.match(add, /looks\?\.builder\s*\?/, 'the draft exists only when the manifest declares a builder');
  const edit = read('src/renderer/src/components/EditAgentModal.tsx');
  const i = edit.indexOf('<Row label="Character">'), j = edit.indexOf('<ThemeLookBuilder'), k = edit.indexOf('<Row label="Color">');
  assert.ok(i > 0 && j > i && k > j, 'Edit remains Character row, then builder, then Color');
  assert.match(edit, /\{looks && lookDraft && \(\s*<ThemeLookBuilder/, 'Edit builder only exists with a pack builder');
  assert.match(edit, /withLook\(agent\.appearanceByTheme, looks\.themeId, draftToLook\(lookDraftState\.draft\)\)/, 'Edit keeps the other themes');
  assert.doesNotMatch(edit, /onPreset/, 'Edit never renames from a preset');
  const builder = read('src/renderer/src/components/ThemeLookBuilder.tsx');
  assert.match(builder, /officeCharacterVisible\?: boolean/);
  assert.match(builder, /officeCharacterVisible = true/);
  assert.match(builder, /Choose this agent’s TES look\./, 'TES copy has no Office-character reference');
});

test('Add and Edit hide the Office picker when a pack declares a look builder', () => {
  const add = read('src/renderer/src/components/AddAgentModal.tsx');
  assert.match(add, /const hasThemeLookBuilder = Boolean\(looks\?\.builder\);/);
  assert.match(add, /const showOfficeCharacterPicker = looks !== undefined && !hasThemeLookBuilder;/);
  assert.match(add, /officeTheme === OFFICE_THEME_ID \? 'Jim' : 'Crewmate'/, 'a pack starts with no Office-character name');
  assert.match(add, /\{showOfficeCharacterPicker && \(\s*<Row label="Character">[\s\S]*?OFFICE_CAST\.map/, 'a pack cannot render Office cast tiles');
  assert.match(add, /data-office-character-picker/, 'the Office picker has a direct visual-census hook');
  assert.match(add, /<ThemeLookBuilder[\s\S]*?officeCharacterVisible=\{showOfficeCharacterPicker\}/, 'the pack builder is the visible picker');
  assert.match(add, /hint: 'name · look · color'/, 'the pack identity hint omits character');
  assert.match(add, /const \[character, setCharacter\] = useState<OfficeCharacterName>\(knownCharacter\(/, 'new agents retain a valid Office fallback');
  assert.match(add, /appearanceByTheme: \{ \[looks\.themeId\]: draftToLook\(lookDraft\) \}/, 'new agents save their visible pack look');
  assert.match(add, /looks\?\.builder\s*\?/, 'the draft exists only when the manifest declares a builder');
  const edit = read('src/renderer/src/components/EditAgentModal.tsx');
  assert.match(edit, /const hasThemeLookBuilder = Boolean\(looks\?\.builder\);/);
  assert.match(edit, /const showOfficeCharacterPicker = looks !== undefined && !hasThemeLookBuilder;/);
  assert.match(edit, /\{showOfficeCharacterPicker && \(\s*<Row label="Character">[\s\S]*?OFFICE_CAST\.map/, 'Edit uses the same capability gate');
  assert.match(edit, /hint=\{hasThemeLookBuilder \? 'name · look · color' : 'name · character · color'\}/, 'Edit names the visible controls');
  assert.match(edit, /<ThemeLookBuilder[\s\S]*?officeCharacterVisible=\{showOfficeCharacterPicker\}/, 'Edit hides stale Office copy with its picker');
  assert.match(edit, /\{looks && lookDraft && \(\s*<ThemeLookBuilder/, 'Edit builder only exists with a pack builder');
  assert.match(edit, /withLook\(agent\.appearanceByTheme, looks\.themeId, draftToLook\(lookDraftState\.draft\)\)/, 'Edit keeps the other themes');
  assert.match(edit, /setCharacter\(agent\.character\);/, 'Edit keeps its saved Office-compatible fallback');
  assert.doesNotMatch(edit, /onPreset/, 'Edit never renames from a preset');
  const builder = read('src/renderer/src/components/ThemeLookBuilder.tsx');
  assert.match(builder, /officeCharacterVisible\?: boolean/);
  assert.match(builder, /officeCharacterVisible = true/);
  assert.match(builder, /looks\.label/, 'pack copy names the pack rather than TES');
});

test('the floor uses the same looks: body, colours and preset seat from appearanceByTheme', () => {
  const s = read('src/renderer/src/scene/themes/StationFloor.tsx');
  assert.match(s, /resolveLook\(looks\.builder, cols, readLook\(a\.appearanceByTheme\?\.\[looks\.themeId\]\), a\.id\)/);
  assert.match(s, /presetIdOf\(b, a, id\)/);
  assert.doesNotMatch(s, /appearance\?\.presetId/, 'the PR-b placeholder is gone');
});

test('fallbacks pin the manifest default body (not the first), the body portrait row, readLook caps and the hash spread', () => {
  const B2 = { ...B, defaults: { ...B.defaults, bodyId: 'dark' } };
  assert.equal(L.resolveLook(B2, COLS, { bodyId: 'gone', colors: {}, source: 'custom', version: 1 }, 'x').body.id, 'dark', 'unknown body -> the manifest default');
  assert.equal(L.startDraft(B2, COLS).bodyId, 'dark', 'Add starts at the manifest default');
  const B3 = { ...B, bodies: B.bodies.map((b) => (b.id === 'dark' ? { ...b, portrait: { row: 2 } } : b)) };
  const plan = L.portraitPlan(THEME, { ...pack, builder: B3 }, { draft: { bodyId: 'dark', colors: { skin: '', shirt: '', hair: '' }, source: 'custom' }, character: 'jim' }, SIZE);
  assert.deepEqual([plan.row, plan.sx, plan.sy], [2, 32, 64], 'the body portrait row is used');
  assert.equal(L.readLook({ bodyId: 'x'.repeat(41) }), null, 'a body id over 40 chars is not a look');
  assert.equal(L.readLook({ bodyId: 'x'.repeat(40) }).bodyId, 'x'.repeat(40));
  const picked = new Set(Array.from({ length: 26 }, (_, i) => L.hashPick(String.fromCharCode(97 + i) + '-agent', B.bodies).id));
  assert.equal(picked.size, 2, 'unstyled agents spread over the bodies');
});

test('spawn requests apply the preset before the body: a body change drops the preset', () => {
  const both = L.lookFromRequest(B, { presetId: 'pilot', bodyId: 'light' });
  assert.equal(both.bodyId, 'light');
  assert.equal(both.presetId, undefined);
  // the hive's spawn wire reads the theme a request names before the active one
  const hive = fs.readFileSync(path.join(__dirname, '../src/renderer/src/hooks/useHive.ts'), 'utf8');
  assert.match(hive, /const lookTheme = rec\.appearance\?\.theme \?\? useStore\.getState\(\)\.officeTheme;/);
  assert.match(hive, /lookFromRequest\(themeBuilder\(lookTheme\)/);
});
