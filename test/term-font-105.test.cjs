'use strict';
require('./tools/own-job.cjs');

/**
 * TERM-FONT-105. @xterm/addon-webgl 0.19.0 builds its canvas font strings with a leading space
 * for non-italic text (" normal 14px ..."). Chrome 156 (Electron 45) rejects that, ctx.font stays
 * "10px sans-serif", and every terminal glyph is drawn in a 10px proportional sans.
 * tools/patch-xterm-webgl-font.cjs drops the space (pinned by SHA-256); its --check runs near the
 * end of postinstall and FIRST in `npm run build`, so a masked or undone patch fails loudly.
 *
 * Fixture: none on disk. The installed addon is the patched form (postinstall); reversing the
 * pinned edits must give back the pinned pristine digest, which proves both pins at once.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'patch-xterm-webgl-font.cjs');
const ADDON = path.join(ROOT, 'node_modules', '@xterm', 'addon-webgl');
const pins = require(TOOL);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

const installed = {};
const pristine = {};
for (const [rel, pin] of Object.entries(pins.FILES)) {
  installed[rel] = fs.readFileSync(path.join(ADDON, rel), 'utf8');
  let s = installed[rel];
  for (const [before, after] of pin.edits) s = s.replace(after, () => before);
  pristine[rel] = s;
}

function tree(files, version = pins.ADDON_WEBGL_VERSION) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf105-'));
  fs.mkdirSync(path.join(dir, 'lib'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@xterm/addon-webgl', version }));
  for (const [rel, s] of Object.entries(files)) fs.writeFileSync(path.join(dir, rel), s);
  return dir;
}
const run = (dir, ...args) => spawnSync(process.execPath, [TOOL, '--root', dir, ...args], { encoding: 'utf8' });
const rm = (dir) => fs.rmSync(dir, { recursive: true, force: true });

test('the installed addon is the locked version, patched, and reverses to the pinned pristine digest', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/@xterm/addon-webgl'].version, pins.ADDON_WEBGL_VERSION);
  for (const [rel, pin] of Object.entries(pins.FILES)) {
    assert.equal(sha(installed[rel]), pin.patched, `${rel} installed form`);
    assert.equal(sha(pristine[rel]), pin.pristine, `${rel} pristine form`);
    for (const [before] of pin.edits) assert.equal(pristine[rel].split(before).length, 2, `${rel}: ${before} occurs once`);
  }
});

test('the patched template literals build font strings with no leading space; the pristine ones did', () => {
  // The same expressions as the pinned edits, evaluated with the values the addon passes.
  const atlasOld = (D, S, size, fam) => `${D} ${S} ${size}px ${fam}`;
  const atlasNew = (D, S, size, fam) => `${D ? D + ' ' : ''}${S} ${size}px ${fam}`;
  const getOld = (i, w) => `${i ? 'italic' : ''} ${w} 14px x`;
  const getNew = (i, w) => `${i ? 'italic ' : ''}${w} 14px x`;
  assert.match(atlasOld('', 'normal', 14, 'f'), /^ /);
  assert.match(getOld(false, 'normal'), /^ /);
  assert.equal(atlasNew('', 'normal', 14, 'f'), 'normal 14px f');
  assert.equal(atlasNew('italic', 'bold', 14, 'f'), 'italic bold 14px f');
  assert.equal(getNew(false, 'normal'), 'normal 14px x');
  assert.equal(getNew(true, 'bold'), 'italic bold 14px x');
  for (const [rel, pin] of Object.entries(pins.FILES)) {
    for (const [, after] of pin.edits) assert.ok(installed[rel].includes(after), `${rel} carries ${after}`);
  }
});

test('pristine -> patched -> no-op; --check fails on pristine and passes on patched', () => {
  const dir = tree(pristine);
  try {
    let r = run(dir, '--check');
    assert.equal(r.status, 1, 'check must fail on the pristine addon');
    assert.match(r.stderr, /10px sans-serif/);
    r = run(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /canvas font strings patched/);
    for (const [rel, pin] of Object.entries(pins.FILES)) assert.equal(sha(fs.readFileSync(path.join(dir, rel), 'utf8')), pin.patched);
    r = run(dir);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /already patched/);
    r = run(dir, '--check');
    assert.equal(r.status, 0, r.stderr);
  } finally { rm(dir); }
});

test('a different addon version or a changed file fails and writes nothing; a half-patched tree completes', () => {
  const v = tree(pristine, '0.20.0');
  try { assert.equal(run(v).status, 1); } finally { rm(v); }
  const half = tree({ ...pristine, 'lib/addon-webgl.mjs': installed['lib/addon-webgl.mjs'] });
  try {
    assert.equal(run(half, '--check').status, 1, 'one patched file is not enough');
    assert.equal(run(half).status, 0, 'the pristine file is patched, the patched one left');
    assert.equal(run(half, '--check').status, 0);
  } finally { rm(half); }
  const changed = tree({ ...pristine, 'lib/addon-webgl.mjs': pristine['lib/addon-webgl.mjs'] + '\n' });
  try {
    assert.equal(run(changed).status, 1);
    assert.equal(fs.readFileSync(path.join(changed, 'lib', 'addon-webgl.js'), 'utf8'), pristine['lib/addon-webgl.js'], 'all-or-nothing: no file written');
  } finally { rm(changed); }
});

test('postinstall patches first and checks just before the winpty --check; build starts with the check', () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts;
  const steps = scripts.postinstall.split('&&').map((s) => s.trim());
  assert.equal(steps[0], 'node tools/patch-xterm-webgl-font.cjs');
  assert.equal(steps[steps.length - 2], 'node tools/patch-xterm-webgl-font.cjs --check');
  assert.equal(steps[steps.length - 1], 'node tools/patch-node-pty-winpty-gyp.cjs --check');
  assert.equal(scripts.build.split('&&')[0].trim(), 'node tools/patch-xterm-webgl-font.cjs --check');
});

test('both terminal faces are bundled, not fetched: local @font-face per face and weight, no Google font, then Consolas, then monospace', () => {
  const R = (...p) => fs.readFileSync(path.join(ROOT, 'src', 'renderer', ...p), 'utf8');
  const css = R('src', 'design', 'fonts.css');
  const font = R('src', 'components', 'terminalFont.ts');
  const offered = JSON.parse(font.match(/TERMINAL_FONT_FACES = (\[[^\]]+\]) as const/)[1].replace(/'/g, '"'));
  assert.deepEqual(offered, ['JetBrains Mono', 'Martian Mono'], 'the two faces the selector offers, the default first');
  const fam = font.match(/return `([^`]+)`;\n}\n\nconst loaded/)[1];
  assert.equal(fam, '"${face}", Consolas, monospace', 'the face first, then Consolas, then monospace');
  const faces = [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map((m) => m[1]);
  for (const face of offered) {
    for (const w of ['400', '700']) {
      const f = faces.find((b) => b.includes(`font-family: "${face}"`) && b.includes(`font-weight: ${w}`));
      assert.ok(f, `${face} ${w}`);
      const url = f.match(/url\('([^']+)'\)/)[1];
      assert.doesNotMatch(url, /^https?:/);
      assert.ok(fs.statSync(path.join(ROOT, 'src', 'renderer', 'src', 'design', url)).size > 10000, url);
    }
  }
  assert.doesNotMatch(css, /https?:\/\/[^\s'"]*\.(woff2?|ttf|otf)|@import/, 'no face is fetched');
  assert.doesNotMatch(R('index.html'), /family=JetBrains/);
  const main = R('src', 'main.tsx');
  assert.ok(main.indexOf("'./design/fonts.css'") >= 0 && main.indexOf("'./design/fonts.css'") < main.indexOf("'./design/global.css'"));
  const pool = R('src', 'components', 'terminalPool.ts');
  assert.match(pool, /fontFamily: terminalFontFamily\(\),/, 'a new terminal is built with the chosen face');
  assert.doesNotMatch(pool, /options\.fontFamily = entry\.term\.options\.fontFamily/, 'the same-value re-apply is a no-op in xterm');
});

// ---- Jim's SHOULD on 35bbbf72: fix 2 had no runtime pin (all three call sites could go and the suite stayed green).
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');
const TF = loadTs('src/renderer/src/components/terminalFont.ts');

/** A Terminal double with xterm 5.5's option semantics: the setter fires (and re-measures the cell)
 *  only when the value CHANGES (`rawOptions[key] !== value`). */
function fakeTerm(fontSize) {
  const raw = { fontSize, fontFamily: 'f' };
  const t = { measures: 0, atlasCleared: 0, clearTextureAtlas() { t.atlasCleared++; } };
  t.options = new Proxy(raw, { set(o, k, v) { if (o[k] !== v) { o[k] = v; t.measures++; } return true; } });
  return t;
}

/** Each face's real advances, measured as xterm does (Chrome 156; Martian Mono from the packaged
 *  probe, JetBrains Mono from the term-font-picker harness scenario): 0.7em and 0.6em. */
const FACE_W = {
  'Martian Mono': { 10: 7, 12: 8.399993896484375, 14: 9.79998779296875, 16: 11.199996948242188 },
  'JetBrains Mono': { 10: 6, 12: 7.1999969482421875, 14: 8.399993896484375, 16: 9.599990844726562 }
};
const MARTIAN_W = FACE_W['Martian Mono'];
/** xterm 5.5's WebGL/DOM cell: floor(advance x dpr) + round(letterSpacing) device px. */
const xtermCell = (adv, dpr, ls) => Math.floor(adv * dpr) + Math.round(ls);

test('remeasureTerminalFont really re-measures (the same-value re-apply does not), keeps the size and clears the atlas', () => {
  const old = fakeTerm(12);
  old.options.fontFamily = old.options.fontFamily;
  old.options.fontSize = old.options.fontSize;
  assert.equal(old.measures, 0, 'the pre-105 re-apply never reached xterm');
  const t = fakeTerm(12);
  TF.remeasureTerminalFont(t);
  assert.ok(t.measures >= 1, 'at least one real option change, so xterm measures the cell again');
  assert.equal(t.options.fontSize, 12, 'size restored');
  assert.equal(t.atlasCleared, 1, 'glyph atlas re-rastered');
  assert.equal(t.options.letterSpacing, 1, 'the re-measure also sets the one-pixel cell pad (12px: 8.4 -> 9)');
});

test('cell = floor(advance) + 1 at every size: never narrower than the glyph, air even when the advance is whole (10px -> 8)', () => {
  assert.deepEqual(Object.keys(FACE_W).sort(), [...TF.TERMINAL_FONT_FACES].sort(), 'a width table for every face offered');
  for (const [face, widths] of Object.entries(FACE_W)) {
    for (const dpr of [1, 1.25, 1.5, 2]) {
      for (const [px, adv] of Object.entries(widths)) {
        const cell = xtermCell(adv, dpr, TF.TERMINAL_CELL_PAD);
        assert.equal(cell, Math.floor(adv * dpr) + 1, `${face} px ${px} dpr ${dpr}`);
        assert.ok(cell > adv * dpr, `${face} px ${px} dpr ${dpr}: cell ${cell} wider than glyph ${adv * dpr}`);
      }
    }
  }
  assert.deepEqual([10, 12, 14, 16].map((px) => xtermCell(MARTIAN_W[px], 1, TF.TERMINAL_CELL_PAD)), [8, 9, 10, 12]);
  assert.deepEqual([10, 12, 14, 16].map((px) => xtermCell(FACE_W['JetBrains Mono'][px], 1, TF.TERMINAL_CELL_PAD)), [7, 8, 9, 10]);
  // Without the pad JetBrains Mono's cell is narrower than its glyph at 12, 14 and 16px (7 < 7.2).
  assert.deepEqual([10, 12, 14, 16].map((px) => xtermCell(FACE_W['JetBrains Mono'][px], 1, 0) >= FACE_W['JetBrains Mono'][px]), [true, false, false, false]);
  // The whole-number case: 10px is exactly 7.0 (and 20px exactly 14.0), and still gets its pixel.
  assert.equal(xtermCell(7, 1, TF.TERMINAL_CELL_PAD), 8);
  assert.equal(xtermCell(14, 1, TF.TERMINAL_CELL_PAD), 15);
  assert.equal(xtermCell(7, 2, TF.TERMINAL_CELL_PAD), 15, 'dpr 2: 14 device px + 1');
});

test('applyTerminalFontSize carries the pad at every size, 10px included', () => {
  const t = fakeTerm(12);
  for (const px of [10, 12, 14, 16, 10]) {
    TF.applyTerminalFontSize(t, px);
    assert.equal(t.options.fontSize, px);
    assert.equal(t.options.letterSpacing, 1, `${px}px keeps the one-pixel pad`);
  }
});

test('every terminal size change goes through the pad: pool construction, zoom, font-load and attach paths', () => {
  const pool = codeOnly(readSource('src/renderer/src/components/terminalPool.ts'), 'terminalPool.ts');
  assert.match(pool, /new Terminal\(\{[\s\S]*?fontSize,\s*letterSpacing: TERMINAL_CELL_PAD,/);
  const view = codeOnly(readSource('src/renderer/src/components/PtyTerminalView.tsx'), 'PtyTerminalView.tsx');
  assert.doesNotMatch(view, /options\.fontSize\s*=/, 'no raw fontSize write that would skip the pad');
  assert.equal((view.match(/applyTerminalFontSize\(entry\.term, /g) || []).length, 3);
});

function withFonts(faces, loadResult, fn) {
  const prev = globalThis.document;
  globalThis.document = { fonts: Object.assign(faces, { check: () => true, load: async () => loadResult }) };
  try { return fn(); } finally { globalThis.document = prev; }
}

test('terminalFontReady needs the BUNDLED faces loaded; document.fonts.check (true for an undeclared family) is not enough', () => {
  const face = (family, weight, status) => ({ family, weight, status });
  assert.equal(TF.getTerminalFontFace(), 'JetBrains Mono', 'no window here, so the module holds the default');
  assert.equal(withFonts([], [], () => TF.terminalFontReady()), false, 'no @font-face (fonts.css missing): not ready, so the loud load runs');
  for (const name of TF.TERMINAL_FONT_FACES) {
    const other = TF.TERMINAL_FONT_FACES.find((f) => f !== name);
    assert.equal(withFonts([face(`"${name}"`, '400', 'loaded')], [], () => TF.terminalFontReady(name)), false, `${name}: bold missing`);
    assert.equal(withFonts([face(name, '400', 'loaded'), face(name, '700', 'unloaded')], [], () => TF.terminalFontReady(name)), false, `${name}: bold not loaded yet`);
    assert.equal(withFonts([face(`"${name}"`, '400', 'loaded'), face(`"${name}"`, '700', 'loaded')], [], () => TF.terminalFontReady(name)), true, name);
    assert.equal(withFonts([face(other, '400', 'loaded'), face(other, '700', 'loaded')], [], () => TF.terminalFontReady(name)), false, `${name} is not ready because ${other} is`);
  }
  const jb = [face('JetBrains Mono', '400', 'loaded'), face('JetBrains Mono', '700', 'loaded')];
  assert.equal(withFonts(jb, [], () => TF.terminalFontReady()), true, 'with no argument it answers for the chosen face');
});

test('loadTerminalFont rejects loudly when the bundled face is missing', async () => {
  const errors = [];
  const prevErr = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  const prev = globalThis.document;
  globalThis.document = { fonts: { load: async () => [] } };
  try {
    const fresh = loadTs.fromText('src/renderer/src/components/terminalFont.ts', readSource('src/renderer/src/components/terminalFont.ts') + '\n// fresh module state\n');
    await assert.rejects(fresh.loadTerminalFont(), /not bundled/);
    await new Promise((r) => setImmediate(r));
    assert.ok(errors.some((e) => /terminalFont/.test(e) && /not bundled/.test(e)), errors.join('\n'));
  } finally { globalThis.document = prev; console.error = prevErr; }
});

test('fix 2 is wired at all three call sites: acquireTerminal (after the face loads), reflowTerminal, PtyTerminalView', () => {
  const pool = codeOnly(readSource('src/renderer/src/components/terminalPool.ts'), 'terminalPool.ts');
  const body = (src, head) => { const i = src.indexOf(head); assert.ok(i >= 0, head); const j = src.indexOf('\n}\n', i); return src.slice(i, j); };
  const acquire = body(pool, 'export function acquireTerminal(');
  assert.match(acquire, /openTerminalOnce\(entry\);[\s\S]*?if \(!terminalFontReady\(\)\)[\s\S]*?loadTerminalFont\(\)\.then\([\s\S]*?remeasureTerminalFont\(entry\.term\);[\s\S]*?reflowTerminal\(ptyId\)/);
  assert.match(acquire, /pool\.get\(ptyId\) !== entry \|\| entry\.exited/, 'a recycled or exited entry is left alone');
  assert.match(body(pool, 'export function reflowTerminal('), /remeasureTerminalFont\(entry\.term\)/);
  const view = codeOnly(readSource('src/renderer/src/components/PtyTerminalView.tsx'), 'PtyTerminalView.tsx');
  assert.match(view, /if \(!terminalFontReady\(\)\) \{\s*loadTerminalFont\(\)\s*\.then\(\(\) => \{[\s\S]*?remeasureTerminalFont\(entry\.term\);[\s\S]*?tryFit\(true\)/);
});

test('Martian Mono is the unmodified upstream release, with its OFL text and an ATTRIBUTION entry', () => {
  const dir = path.join(ROOT, 'src', 'renderer', 'src', 'assets', 'fonts', 'martian-mono');
  // sha256 of the files inside martian-mono-1.1.0-woff2.zip (github.com/evilmartians/mono, v1.1.0).
  const pinned = {
    'MartianMono-StdRg.woff2': '5253fe61c5aecbcf8ea63cf4e61fe563c9f6bf0a05eeb311a5bac21617246054',
    'MartianMono-StdBd.woff2': '4510942de3a96564d8f7e14de5b7352ae03cb72251d6943bfb71b28eda7df5e0'
  };
  for (const [f, sha] of Object.entries(pinned)) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex'), sha, f);
  }
  assert.deepEqual(fs.readdirSync(dir).sort(), ['MartianMono-StdBd.woff2', 'MartianMono-StdRg.woff2', 'OFL.txt']);
  const ofl = fs.readFileSync(path.join(dir, 'OFL.txt'), 'utf8');
  assert.match(ofl, /^Copyright 2021 The Martian Mono Project Authors/);
  assert.match(ofl, /SIL OPEN FONT LICENSE Version 1\.1/);
  const attr = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'src', 'assets', 'ATTRIBUTION.md'), 'utf8');
  assert.match(attr, /## Terminal font: Martian Mono[\s\S]*1\.1\.0[\s\S]*evilmartians\/mono[\s\S]*SIL Open Font License 1\.1/);
});

// ---- TERM-FONT-JETBRAINS: the face is the user's pick (JetBrains Mono unless they chose), stored like the size.
const FONT_TS = 'src/renderer/src/components/terminalFont.ts';
let freshN = 0;
/** A fresh terminalFont module (a new app start) over a fake window.localStorage. */
function startApp(store, fn, storage) {
  const prev = globalThis.window;
  const writes = [];
  globalThis.window = { localStorage: storage || {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setItem: (k, v) => { writes.push([k, v]); store[k] = v; }
  } };
  try {
    return fn(loadTs.fromText(FONT_TS, readSource(FONT_TS) + `\n// app start ${++freshN}\n`), writes);
  } finally { globalThis.window = prev; }
}

test('JetBrains Mono is the terminal face for anyone who has not picked, or whose stored pick is not a face we ship', () => {
  startApp({}, (m, writes) => {
    assert.equal(m.DEFAULT_TERMINAL_FONT_FACE, 'JetBrains Mono');
    assert.equal(m.getTerminalFontFace(), 'JetBrains Mono');
    assert.equal(m.terminalFontFamily(), '"JetBrains Mono", Consolas, monospace');
    assert.deepEqual(writes, [], 'reading the default stores nothing');
  });
  for (const junk of ['Comic Sans MS', '', 'martian mono', 'null']) {
    startApp({ 'cth.ptyFontFace': junk }, (m) => assert.equal(m.getTerminalFontFace(), 'JetBrains Mono', JSON.stringify(junk)));
  }
  // The size key is a different key: a stored size is never read as a face.
  startApp({ 'cth.ptyFontSize': 'Martian Mono' }, (m) => assert.equal(m.getTerminalFontFace(), 'JetBrains Mono'));
  const broken = { getItem() { throw new Error('storage blocked'); }, setItem() { throw new Error('storage blocked'); } };
  startApp({}, (m) => {
    assert.equal(m.getTerminalFontFace(), 'JetBrains Mono');
    assert.equal(m.setTerminalFontFace('Martian Mono'), 'Martian Mono', 'the pick still applies for this run');
  }, broken);
});

test('a pick is stored under cth.ptyFontFace and read back by the next app start', () => {
  const store = {};
  startApp(store, (m, writes) => {
    assert.equal(m.setTerminalFontFace('Martian Mono'), 'Martian Mono');
    assert.equal(m.getTerminalFontFace(), 'Martian Mono');
    assert.equal(m.terminalFontFamily(), '"Martian Mono", Consolas, monospace');
    assert.equal(m.terminalFontFamily('JetBrains Mono'), '"JetBrains Mono", Consolas, monospace', 'a named face, whatever is chosen');
    assert.deepEqual(writes, [['cth.ptyFontFace', 'Martian Mono']]);
  });
  assert.deepEqual(store, { 'cth.ptyFontFace': 'Martian Mono' });
  startApp(store, (m, writes) => {
    assert.equal(m.getTerminalFontFace(), 'Martian Mono', 'restart: the stored pick, not the default');
    m.setTerminalFontFace('JetBrains Mono');
    assert.deepEqual(writes, [['cth.ptyFontFace', 'JetBrains Mono']], 'picking the default back is stored too');
  });
  startApp(store, (m) => assert.equal(m.getTerminalFontFace(), 'JetBrains Mono'));
});

test('subscribers hear each real change once; an unknown or unchanged face is a no-op (no write, no notify)', () => {
  startApp({}, (m, writes) => {
    let heard = 0;
    const seen = [];
    const off = m.subscribeTerminalFontFace(() => { heard++; seen.push(m.getTerminalFontFace()); });
    assert.equal(m.setTerminalFontFace('JetBrains Mono'), 'JetBrains Mono');
    assert.equal(m.setTerminalFontFace('Courier New'), 'JetBrains Mono');
    assert.equal(heard, 0);
    assert.deepEqual(writes, []);
    m.setTerminalFontFace('Martian Mono');
    m.setTerminalFontFace('Martian Mono');
    m.setTerminalFontFace('JetBrains Mono');
    assert.deepEqual(seen, ['Martian Mono', 'JetBrains Mono'], 'the listener reads the new face');
    off();
    m.setTerminalFontFace('Martian Mono');
    assert.equal(heard, 2, 'unsubscribed');
    assert.equal(writes.length, 3);
  });
});

test('applyTerminalFontFace switches the family and carries the one-pixel pad; xterm re-measures on the change', () => {
  for (const face of TF.TERMINAL_FONT_FACES) {
    const t = fakeTerm(12);
    TF.applyTerminalFontFace(t, face);
    assert.equal(t.options.fontFamily, `"${face}", Consolas, monospace`);
    assert.equal(t.options.letterSpacing, 1);
    assert.equal(t.options.fontSize, 12, 'the size is left alone');
    assert.ok(t.measures >= 1);
  }
});

test('loadTerminalFont loads the regular and bold of the face asked for, once per face', async () => {
  const asked = [];
  const prev = globalThis.document;
  globalThis.document = { fonts: { load: async (font) => { asked.push(font); return [{}]; } } };
  try {
    const fresh = loadTs.fromText(FONT_TS, readSource(FONT_TS) + `\n// app start ${++freshN}\n`);
    await fresh.loadTerminalFont();
    assert.deepEqual(asked, ['14px "JetBrains Mono"', 'bold 14px "JetBrains Mono"'], 'the chosen face by default');
    await fresh.loadTerminalFont('Martian Mono');
    await fresh.loadTerminalFont('JetBrains Mono');
    await fresh.loadTerminalFont('Martian Mono');
    assert.deepEqual(asked.slice(2), ['14px "Martian Mono"', 'bold 14px "Martian Mono"'], 'each face is loaded once');
  } finally { globalThis.document = prev; }
});

test('the pick is wired: the pool applies it to every terminal after the face loads, the header shows the selector beside the size buttons', () => {
  const pool = codeOnly(readSource('src/renderer/src/components/terminalPool.ts'), 'terminalPool.ts');
  const at = pool.indexOf('export function applyTerminalFontFaceToPool(');
  assert.ok(at > 0);
  const fn = pool.slice(at, pool.indexOf('\n}\n', at));
  assert.match(fn, /const face = getTerminalFontFace\(\);\s*return loadTerminalFont\(face\)\.then\(\(\) => \{\s*if \(getTerminalFontFace\(\) !== face\) return;[^\n]*\s*for \(const \[ptyId, entry\] of pool\) \{\s*applyTerminalFontFace\(entry\.term, face\);\s*reflowTerminal\(ptyId\);\s*\}/,
    'load first, drop a superseded pick, then family + pad and a refit for EVERY pooled terminal');
  assert.match(pool, /\nsubscribeTerminalFontFace\(\(\) => \{ void applyTerminalFontFaceToPool\(\); \}\);/);
  assert.equal((pool.match(/options\.fontFamily\s*=/g) || []).length, 0, 'no raw fontFamily write that would skip the pad or the load');
  const view = codeOnly(readSource('src/renderer/src/components/PtyTerminalView.tsx'), 'PtyTerminalView.tsx');
  assert.match(view, /const fontFace = useTerminalFontFace\(\);/);
  const sel = view.indexOf('<select');
  assert.ok(sel > 0 && view.indexOf('<select', sel + 1) < 0, 'one selector');
  const tag = view.slice(sel, view.indexOf('</select>', sel));
  assert.match(tag, /value=\{fontFace\}/);
  assert.match(tag, /onChange=\{\(e\) => setTerminalFontFace\(e\.target\.value\)\}/);
  assert.match(tag, /aria-label="Terminal font"/);
  assert.match(tag, /TERMINAL_FONT_FACES\.map\(/, 'one option per face offered, from the same list');
  assert.doesNotMatch(view, /options\.fontFamily\s*=/);
});
