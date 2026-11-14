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

test('the terminal face is bundled, not fetched: local @font-face per weight, no Google JetBrains Mono, Consolas before monospace', () => {
  const R = (...p) => fs.readFileSync(path.join(ROOT, 'src', 'renderer', ...p), 'utf8');
  const css = R('src', 'design', 'fonts.css');
  const font = R('src', 'components', 'terminalFont.ts');
  const face = font.match(/TERMINAL_FONT_FACE = '([^']+)'/)[1];
  const fam = font.match(/TERMINAL_FONT_FAMILY = `([^`]+)`/)[1];
  assert.ok(fam.indexOf('Consolas') > 0 && fam.indexOf('Consolas') < fam.indexOf('monospace'), fam);
  const faces = [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map((m) => m[1]);
  for (const w of ['400', '700']) {
    const f = faces.find((b) => b.includes(`font-family: "${face}"`) && b.includes(`font-weight: ${w}`));
    assert.ok(f, `${face} ${w}`);
    const url = f.match(/url\('([^']+)'\)/)[1];
    assert.doesNotMatch(url, /^https?:/);
    assert.ok(fs.statSync(path.join(ROOT, 'src', 'renderer', 'src', 'design', url)).size > 10000, url);
  }
  assert.doesNotMatch(R('index.html'), /family=JetBrains/);
  const main = R('src', 'main.tsx');
  assert.ok(main.indexOf("'./design/fonts.css'") >= 0 && main.indexOf("'./design/fonts.css'") < main.indexOf("'./design/global.css'"));
  const pool = R('src', 'components', 'terminalPool.ts');
  assert.match(pool, /fontFamily: TERMINAL_FONT_FAMILY/);
  assert.doesNotMatch(pool, /options\.fontFamily = entry\.term\.options\.fontFamily/, 'the same-value re-apply is a no-op in xterm');
});
