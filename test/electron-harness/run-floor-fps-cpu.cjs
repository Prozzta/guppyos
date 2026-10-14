'use strict';

/** TES-GUPPY-FPS: re-earn the office vs TES floor figures on demand (not in the suite: about 70 s,
 *  and the numbers are machine-bound):
 *    node test/electron-harness/run-floor-fps-cpu.cjs [--plan <plan.ts>] [--station <StationFloor.tsx>]
 *  --plan swaps scenarios/floor-fps-cpu-plan.ts (box, runs, layers to hide); --station loads another
 *  StationFloor text in place of the source (e.g. an older commit's), resolved from the source's folder. */
const { join, resolve } = require('node:path');
const { runScenario } = require('./run.cjs');

const argOf = (n) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? resolve(process.argv[i + 1]) : null; };
const overrides = {};
if (argOf('plan')) overrides[join(__dirname, 'scenarios', 'floor-fps-cpu-plan.ts')] = argOf('plan');
if (argOf('station')) overrides[join(__dirname, '..', '..', 'src', 'renderer', 'src', 'scene', 'themes', 'StationFloor.tsx')] = argOf('station');
const TES = join(__dirname, '..', '..', 'themes', 'tes');
runScenario(join(__dirname, 'scenarios', 'floor-fps-cpu.tsx'),
  { timeoutMs: 600_000, env: { HARNESS_THEME_PACKS: JSON.stringify([{ dir: 'tes', from: TES }]), HARNESS_SOURCE_OVERRIDES: JSON.stringify(overrides) } })
  .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); })
  .catch((e) => { console.error(e); process.exit(1); });
