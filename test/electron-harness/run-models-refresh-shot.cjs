'use strict';

/** Writes the post-refresh Settings model-list screenshot:
 *   node test/electron-harness/run-models-refresh-shot.cjs --out <file.png> */
const { mkdirSync, writeFileSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');
const { runScenario } = require('./run.cjs');

const at = process.argv.indexOf('--out');
const out = at >= 0 ? resolve(process.argv[at + 1]) : null;
if (!out) { console.error('--out <file.png> is required'); process.exit(2); }

runScenario(join(__dirname, 'scenarios', 'models-refresh-button.tsx'), { timeoutMs: 120_000 }).then((report) => {
  if (!report.ok) { console.error(report.error); process.exit(1); }
  const png = report.screenshot?.png;
  if (typeof png !== 'string' || !png.startsWith('data:image/png;base64,')) throw new Error('scenario returned no PNG');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.from(png.slice(png.indexOf(',') + 1), 'base64'));
  console.log(JSON.stringify({ out, size: report.screenshot.size, after: report.after.claudeDefaults }, null, 2));
}).catch((error) => { console.error(error); process.exit(1); });
