'use strict';

/** TES-SCENE-BOUNCE-188: the real App, a tall narrow TES floor, roster cards clicked
 *  (scenarios/tes-scene-bounce.tsx). Prints, per click, how far the floor's origin (device px)
 *  and the pane moved from where they stood before the click:
 *    node test/electron-harness/run-tes-scene-bounce.cjs [--size W,H,sidebar] [--dpr r] [--out dir] */
const { mkdirSync, writeFileSync, mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { runScenario } = require('./run.cjs');

const argOf = (n) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : null; };
const size = (argOf('size') || '1265,790,720').split(',').map(Number);
const dpr = argOf('dpr') || '1';
const out = argOf('out') ? resolve(argOf('out')) : null;
const sizeFile = join(mkdtempSync(join(tmpdir(), 'scene-bounce-')), 'tes-scene-bounce-size.ts');
writeFileSync(sizeFile, `export const BOUNCE_SIZE: [number, number, number] = ${JSON.stringify(size)};\n`);
const overrides = { [join(__dirname, 'scenarios', 'tes-scene-bounce-size.ts')]: sizeFile };
const TES = join(__dirname, '..', '..', 'themes', 'tes');

/** Per click: the rested frame (the last before the click), the most the origin and the pane moved. */
function summary(r) {
  return r.clicks.map(({ who, found, selected, frames }) => {
    const f0 = frames[0];
    if (!f0) return { who, found, selected, frames: 0 };
    let dx = 0, dy = 0, up = 0, dn = 0, pane = 0;
    const ns = new Set();
    for (const f of frames) {
      dx = Math.max(dx, Math.abs(f.ox - f0.ox)); dy = Math.max(dy, Math.abs(f.oy - f0.oy));
      up = Math.max(up, f0.oy - f.oy); ns.add(f.n);
      pane = Math.max(pane, Math.abs(f.paneTop - f0.paneTop) + Math.abs(f.paneH - f0.paneH), Math.abs(f.canvasTop - f0.canvasTop) + Math.abs(f.canvasH - f0.canvasH));
    }
    const last = frames[frames.length - 1];
    return { who, found, selected, frames: frames.length, rest: [f0.n, f0.ox, f0.oy, f0.paneTop, f0.paneH], maxDx: dx, maxDy: dy, maxUp: up, paneMoved: pane, nSeen: [...ns], back: last.ox === f0.ox && last.oy === f0.oy };
  });
}

runScenario(join(__dirname, 'scenarios', 'tes-scene-bounce.tsx'),
  { timeoutMs: 120_000, env: { HARNESS_DPR: dpr, HARNESS_THEME_PACKS: JSON.stringify([{ dir: 'tes', from: TES }]), HARNESS_SOURCE_OVERRIDES: JSON.stringify(overrides) } })
  .then((r) => {
    if (!r.ok) { console.error(r.error); process.exit(1); }
    if (out) {
      mkdirSync(out, { recursive: true });
      const tag = `${size.join('x')}@${dpr}`;
      writeFileSync(join(out, `bounce-${tag}.png`), Buffer.from(r.png.slice(r.png.indexOf(',') + 1), 'base64'));
      writeFileSync(join(out, `bounce-${tag}.json`), JSON.stringify(r.clicks, null, 1));
    }
    console.log(JSON.stringify({ size, dpr: r.dpr, clicks: summary(r) }, null, 1));
  })
  .catch((e) => { console.error(e); process.exit(1); });
