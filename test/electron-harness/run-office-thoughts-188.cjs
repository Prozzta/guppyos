'use strict';

/** TES-BUBBLES-188 SHOULD-3: the plain office floor with thinking and working agents
 *  (office-thoughts-188.tsx), written as <out>/frame-NNN.png plus <out>/hashes.json (sha256 of each
 *  frame's pixels as PNG bytes). Run it on two builds and compare the hashes: equal means the office
 *  floor draws byte for byte the same. APPDATA, LOCALAPPDATA, USERPROFILE and HOME point into <out>/jail:
 *    node test/electron-harness/run-office-thoughts-188.cjs --out <dir> */
const { createHash } = require('node:crypto');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { runScenario } = require('./run.cjs');

const i = process.argv.indexOf('--out');
const out = i >= 0 ? resolve(process.argv[i + 1]) : null;
if (!out) { console.error('--out <dir> is required'); process.exit(2); }

(async () => {
  const jail = join(out, 'jail');
  for (const d of ['AppData/Roaming', 'AppData/Local']) mkdirSync(join(jail, d), { recursive: true });
  const r = await runScenario(join(__dirname, 'scenarios', 'office-thoughts-188.tsx'), {
    width: 1040, height: 720, timeoutMs: 600_000,
    env: { APPDATA: join(jail, 'AppData/Roaming'), LOCALAPPDATA: join(jail, 'AppData/Local'), USERPROFILE: jail, HOME: jail }
  });
  if (!r.ok) { console.error(r.error); process.exit(1); }
  const hashes = {};
  for (const shot of r.shots) {
    const png = Buffer.from(shot.png.slice(shot.png.indexOf(',') + 1), 'base64');
    const name = `frame-${String(shot.frame).padStart(3, '0')}.png`;
    writeFileSync(join(out, name), png);
    hashes[name] = createHash('sha256').update(png).digest('hex');
  }
  writeFileSync(join(out, 'hashes.json'), JSON.stringify(hashes, null, 2));
  console.log(`${r.shots.length} frames -> ${out}`);
})().catch((e) => { console.error(e); process.exit(1); });
