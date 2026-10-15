'use strict';

/** TES-BUBBLES-188 (d): the floor with every agent at work, a frame every 10 s or so (floor-tes-bubbles-188-strip.tsx),
 *  written as <out>/frame-NN.png and <out>/report.json (each frame's time and the ids showing a cloud).
 *  APPDATA, LOCALAPPDATA, USERPROFILE and HOME point into <out>/jail:
 *    node test/electron-harness/run-floor-tes-bubbles-188-strip.cjs --out <dir> */
const { mkdirSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { runScenario } = require('./run.cjs');

const i = process.argv.indexOf('--out');
const out = i >= 0 ? resolve(process.argv[i + 1]) : null;
if (!out) { console.error('--out <dir> is required'); process.exit(2); }
const TES = join(__dirname, '..', '..', 'themes', 'tes');

(async () => {
  const jail = join(out, 'jail');
  for (const d of ['AppData/Roaming', 'AppData/Local']) mkdirSync(join(jail, d), { recursive: true });
  const r = await runScenario(join(__dirname, 'scenarios', 'floor-tes-bubbles-188-strip.tsx'), {
    width: 1040, height: 720, timeoutMs: 600_000,
    env: {
      HARNESS_THEME_PACKS: JSON.stringify([{ dir: 'tes', from: TES }]),
      APPDATA: join(jail, 'AppData/Roaming'), LOCALAPPDATA: join(jail, 'AppData/Local'), USERPROFILE: jail, HOME: jail
    }
  });
  if (!r.ok) { console.error(r.error); process.exit(1); }
  const png = (url) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
  r.frames.forEach((f, n) => writeFileSync(join(out, `frame-${String(n).padStart(2, '0')}.png`), png(f.png)));
  const report = { box: r.box, seatedAt: r.seatedAt, frames: r.frames.map((f) => ({ t: f.t ?? f.at, clouds: f.clouds })) };
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
