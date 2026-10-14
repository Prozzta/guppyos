'use strict';

/** TES-GUPPY-RASTER: deterministic TES floor screenshots on demand (floor-tes-shot.tsx), written as
 *  <out>/frame-<n>.png with their SHA-256, to compare two builds of StationFloor pixel for pixel:
 *    node test/electron-harness/run-floor-tes-shot.cjs --out <dir> [--station <StationFloor.tsx>]
 *  --station loads another StationFloor text in place of the source (e.g. an older commit's). */
const { createHash } = require('node:crypto');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { runScenario } = require('./run.cjs');

const argOf = (n) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? resolve(process.argv[i + 1]) : null; };
const out = argOf('out');
if (!out) { console.error('--out <dir> is required'); process.exit(2); }
const overrides = {};
if (argOf('station')) overrides[join(__dirname, '..', '..', 'src', 'renderer', 'src', 'scene', 'themes', 'StationFloor.tsx')] = argOf('station');
const TES = join(__dirname, '..', '..', 'themes', 'tes');
runScenario(join(__dirname, 'scenarios', 'floor-tes-shot.tsx'),
  { timeoutMs: 600_000, env: { HARNESS_THEME_PACKS: JSON.stringify([{ dir: 'tes', from: TES }]), HARNESS_SOURCE_OVERRIDES: JSON.stringify(overrides) } })
  .then((r) => {
    if (!r.ok) { console.error(r.error); process.exit(1); }
    mkdirSync(out, { recursive: true });
    const shots = r.shots.map(({ frame, png }) => {
      const buf = Buffer.from(png.slice(png.indexOf(',') + 1), 'base64');
      writeFileSync(join(out, `frame-${frame}.png`), buf);
      return { frame, sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
    });
    console.log(JSON.stringify({ box: r.box, stepMs: r.stepMs, shots }, null, 2));
  })
  .catch((e) => { console.error(e); process.exit(1); });
