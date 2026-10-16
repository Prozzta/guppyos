'use strict';

/** CARDS-TAB-190 screenshots (hidden harness, isolated paths, synthetic ledger, no live floor):
 *   node test/electron-harness/run-cards-tab-190-shot.cjs --out <dir> */
const { createHash } = require('node:crypto');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { runScenario } = require('./run.cjs');

const at = process.argv.indexOf('--out');
const out = at >= 0 ? resolve(process.argv[at + 1]) : null;
if (!out) { console.error('--out <dir> is required'); process.exit(2); }

runScenario(join(__dirname, 'scenarios', 'cards-tab-190-shot.tsx'), { width: 1100, height: 900, timeoutMs: 180_000 }).then((report) => {
  if (!report.ok) { console.error(report.error); process.exit(1); }
  mkdirSync(out, { recursive: true });
  const shots = Object.keys(report).filter((k) => k !== 'ok').map((kind) => {
    const shot = report[kind];
    const bytes = Buffer.from(shot.png.slice(shot.png.indexOf(',') + 1), 'base64');
    const file = join(out, `cards-${kind}.png`);
    writeFileSync(file, bytes);
    return { kind, file, size: shot.size, cards: shot.census.cards, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  console.log(JSON.stringify({ shots }, null, 2));
}).catch((error) => { console.error(error); process.exit(1); });
