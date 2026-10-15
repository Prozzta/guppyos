'use strict';

/** COFFEE-NEVER-186: TES coffee screenshots on demand (floor-tes-coffee-shot.tsx): the first frame
 *  with a mug in the hand in each facing, a parked mug and a coffee line, each whole and as a 6x crop
 *  around the mug, written as <out>/<label>.png and <out>/<label>-crop.png with a report.json:
 *    node test/electron-harness/run-floor-tes-coffee-shot.cjs --out <dir> */
const { mkdirSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { runScenario } = require('./run.cjs');

const i = process.argv.indexOf('--out');
const out = i >= 0 ? resolve(process.argv[i + 1]) : null;
if (!out) { console.error('--out <dir> is required'); process.exit(2); }
const TES = join(__dirname, '..', '..', 'themes', 'tes');

(async () => {
  mkdirSync(out, { recursive: true });
  const r = await runScenario(join(__dirname, 'scenarios', 'floor-tes-coffee-shot.tsx'), {
    width: 1000, height: 680, timeoutMs: 900_000,
    env: { HARNESS_THEME_PACKS: JSON.stringify([{ dir: 'tes', from: TES }]) }
  });
  if (!r.ok) { console.error(r.error); process.exit(1); }
  const png = (url) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
  const report = { box: r.box, renders: r.renders, missing: r.missing, shots: [] };
  for (const s of r.shots) {
    const name = s.label.replace(':', '-');
    writeFileSync(join(out, `${name}.png`), png(s.png));
    if (s.crop) writeFileSync(join(out, `${name}-crop.png`), png(s.crop));
    report.shots.push({ label: s.label, frame: s.frame, t: s.t, at: s.at, text: s.text });
  }
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
