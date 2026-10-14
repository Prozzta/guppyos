'use strict';

/** Writes comparable production-dialog screenshots for the Office and TES Add
 * Agent identity pickers:
 *   node test/electron-harness/run-add-agent-theme-shot.cjs --out <dir> */
const { createHash } = require('node:crypto');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { runScenario } = require('./run.cjs');

const at = process.argv.indexOf('--out');
const out = at >= 0 ? resolve(process.argv[at + 1]) : null;
if (!out) { console.error('--out <dir> is required'); process.exit(2); }
const TES = join(__dirname, '..', '..', 'themes', 'tes');

runScenario(join(__dirname, 'scenarios', 'add-agent-theme-shot.tsx'), {
  width: 1120,
  height: 820,
  timeoutMs: 120_000,
  env: { HARNESS_THEME_PACKS: JSON.stringify([{ dir: 'tes', from: TES }]) }
}).then((report) => {
  if (!report.ok) { console.error(report.error); process.exit(1); }
  mkdirSync(out, { recursive: true });
  const shots = ['office', 'tes'].map((theme) => {
    const shot = report[theme];
    const bytes = Buffer.from(shot.png.slice(shot.png.indexOf(',') + 1), 'base64');
    const file = join(out, `add-agent-${theme}.png`);
    writeFileSync(file, bytes);
    return { theme, file, size: shot.size, census: shot.census, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  console.log(JSON.stringify({ shots }, null, 2));
}).catch((error) => { console.error(error); process.exit(1); });
