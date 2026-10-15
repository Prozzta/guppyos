'use strict';

/** TES-FLOOR-COLLISION-188: the Captain's, Chair3/4/5's and Chair6's sitter coming in and sitting down
 *  (floor-tes-chairs-188-entry.tsx), written as <out>/<seat>-entry.png and <out>/<seat>-tail.png (4x strips;
 *  the tail is the last frames before the sit) and <out>/report.json (the filmed frames: render, walker position, seated). APPDATA, LOCALAPPDATA,
 *  USERPROFILE and HOME point into <out>/jail:
 *    node test/electron-harness/run-floor-tes-chairs-188-entry.cjs --out <dir> */
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
  const r = await runScenario(join(__dirname, 'scenarios', 'floor-tes-chairs-188-entry.tsx'), {
    width: 1040, height: 720, timeoutMs: 600_000,
    env: {
      HARNESS_THEME_PACKS: JSON.stringify([{ dir: 'tes', from: TES }]),
      APPDATA: join(jail, 'AppData/Roaming'), LOCALAPPDATA: join(jail, 'AppData/Local'), USERPROFILE: jail, HOME: jail
    }
  });
  if (!r.ok) { console.error(r.error); process.exit(1); }
  const png = (url) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
  for (const [k, v] of Object.entries(r.shots)) {
    writeFileSync(join(out, `${k.toLowerCase()}-entry.png`), png(v.strip));
    writeFileSync(join(out, `${k.toLowerCase()}-tail.png`), png(v.tail));
  }
  const report = { box: r.box, frame: r.frame, t: r.t, shots: Object.fromEntries(Object.entries(r.shots).map(([k, v]) => [k, { recorded: v.recorded, frames: v.frames, tailFrames: v.tailFrames }])) };
  writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch((e) => { console.error(e); process.exit(1); });
