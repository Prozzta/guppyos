'use strict';

/** TES-GUPPY-FRAMING: full-window screenshots of the real App (scenarios/floor-framing-shot.tsx) on a
 *  TES or an Office project at 700x470, 960x640 and 1290x850, written as <out>/<theme>-<w>x<h>.png,
 *  with the framing numbers each shot reports printed as JSON:
 *    node test/electron-harness/run-floor-framing-shot.cjs --theme tes|office --out <dir> */
const { createHash } = require('node:crypto');
const { mkdirSync, writeFileSync, mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { runScenario } = require('./run.cjs');

const argOf = (n) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : null; };
const out = argOf('out') ? resolve(argOf('out')) : null;
const theme = argOf('theme') || 'tes';
if (!out || !/^[a-z0-9-]+$/.test(theme)) { console.error('--out <dir> is required; --theme tes|office'); process.exit(2); }
const themeFile = join(mkdtempSync(join(tmpdir(), 'framing-shot-')), 'floor-framing-theme.ts');
writeFileSync(themeFile, `export const SHOT_THEME: string = ${JSON.stringify(theme)};\n`);
const overrides = { [join(__dirname, 'scenarios', 'floor-framing-theme.ts')]: themeFile };
const TES = join(__dirname, '..', '..', 'themes', 'tes');
runScenario(join(__dirname, 'scenarios', 'floor-framing-shot.tsx'),
  { timeoutMs: 120_000, env: { HARNESS_THEME_PACKS: JSON.stringify([{ dir: 'tes', from: TES }]), HARNESS_SOURCE_OVERRIDES: JSON.stringify(overrides) } })
  .then((r) => {
    if (!r.ok) { console.error(r.error); process.exit(1); }
    mkdirSync(out, { recursive: true });
    const shots = r.shots.map(({ w, h, size, framing, png }) => {
      const buf = Buffer.from(png.slice(png.indexOf(',') + 1), 'base64');
      const file = join(out, `${theme}-${w}x${h}.png`);
      writeFileSync(file, buf);
      return { file, size, framing, sha256: createHash('sha256').update(buf).digest('hex') };
    });
    console.log(JSON.stringify({ theme, shots }, null, 2));
  })
  .catch((e) => { console.error(e); process.exit(1); });
