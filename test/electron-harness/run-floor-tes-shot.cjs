'use strict';

/** TES-GUPPY-RASTER: deterministic TES floor screenshots on demand (floor-tes-shot.tsx), written as
 *  <out>/<w>x<h>/frame-<n>.png with their SHA-256, to compare two builds of StationFloor pixel for pixel
 *  at several boxes (so at fractional zooms, not only zoom 1):
 *    node test/electron-harness/run-floor-tes-shot.cjs --out <dir> [--station <StationFloor.tsx>] [--boxes 700x470,960x640,1290x850]
 *  --station loads another StationFloor text in place of the source (e.g. an older commit's). */
const { createHash } = require('node:crypto');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { runScenario } = require('./run.cjs');

const argAt = (n) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : null; };
const argOf = (n) => (argAt(n) ? resolve(argAt(n)) : null);
const out = argOf('out');
if (!out) { console.error('--out <dir> is required'); process.exit(2); }
const boxes = (argAt('boxes') || '700x470,960x640,1290x850').split(',').map((b) => b.split('x').map(Number));
const TES = join(__dirname, '..', '..', 'themes', 'tes');
const dpr = argAt('dpr');

(async () => {
  const report = [];
  for (const [w, h] of boxes) {
    const dir = join(out, `${w}x${h}`);
    mkdirSync(dir, { recursive: true });
    const boxModule = join(dir, 'box.ts');
    writeFileSync(boxModule, `export const BOX = { w: ${w}, h: ${h} };\n`);
    const overrides = { [join(__dirname, 'scenarios', 'floor-tes-shot-box.ts')]: boxModule };
    if (argOf('station')) overrides[join(__dirname, '..', '..', 'src', 'renderer', 'src', 'scene', 'themes', 'StationFloor.tsx')] = argOf('station');
    const r = await runScenario(join(__dirname, 'scenarios', 'floor-tes-shot.tsx'), {
      width: w + 40, height: h + 40, timeoutMs: 600_000,
      env: { HARNESS_THEME_PACKS: JSON.stringify([{ dir: 'tes', from: TES }]), HARNESS_SOURCE_OVERRIDES: JSON.stringify(overrides), ...(dpr ? { HARNESS_DPR: dpr } : {}) }
    });
    if (!r.ok) { console.error(`${w}x${h}: ${r.error}`); process.exit(1); }
    const shots = r.shots.map(({ frame, png }) => {
      const buf = Buffer.from(png.slice(png.indexOf(',') + 1), 'base64');
      writeFileSync(join(dir, `frame-${frame}.png`), buf);
      return { frame, sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
    });
    report.push({ box: r.box, stepMs: r.stepMs, shots });
  }
  console.log(JSON.stringify(report, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
