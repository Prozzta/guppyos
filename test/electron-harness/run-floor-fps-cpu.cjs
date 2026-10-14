'use strict';

/** TES-GUPPY-FPS: re-earn the office vs TES floor figures on demand (not in the suite: about 70 s,
 *  and the numbers are machine-bound):
 *    node test/electron-harness/run-floor-fps-cpu.cjs */
const { join } = require('node:path');
const { runScenario } = require('./run.cjs');

const TES = join(__dirname, '..', '..', 'themes', 'tes');
runScenario(join(__dirname, 'scenarios', 'floor-fps-cpu.tsx'),
  { timeoutMs: 120_000, env: { HARNESS_THEME_PACKS: JSON.stringify([{ dir: 'tes', from: TES }]) } })
  .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); })
  .catch((e) => { console.error(e); process.exit(1); });
