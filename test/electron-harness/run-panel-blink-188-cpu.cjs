'use strict';

/** PANEL-BLINK-188 CPU: the TES floor with seven agents working and seated (panels blinking), priced as
 *  run-floor-fps-cpu.cjs prices it (fps, renderer and GPU-process CPU, GL calls per frame). Not in the
 *  suite (about 70 s, machine-bound). Jailed: APPDATA, LOCALAPPDATA, USERPROFILE, HOME under <out>/jail.
 *    node test/electron-harness/run-panel-blink-188-cpu.cjs --out <dir> [--station <StationFloor.tsx>]
 *  --station loads another StationFloor text (the base, without the panel layer) in place of the source. */
const { mkdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { runScenario } = require('./run.cjs');

const argOf = (n) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? resolve(process.argv[i + 1]) : null; };
const out = argOf('out');
if (!out) { console.error('--out <dir> is required'); process.exit(2); }
for (const k of Object.keys(process.env)) if (/^(HIVE_|AGENT_|MEMORY_|MUNDER_)/i.test(k)) delete process.env[k];
const jail = join(out, 'jail');
for (const d of ['AppData/Roaming', 'AppData/Local']) mkdirSync(join(jail, d), { recursive: true });
const overrides = {};
if (argOf('station')) overrides[join(__dirname, '..', '..', 'src', 'renderer', 'src', 'scene', 'themes', 'StationFloor.tsx')] = argOf('station');
const TES = join(__dirname, '..', '..', 'themes', 'tes');
runScenario(join(__dirname, 'scenarios', 'panel-blink-188-cpu.tsx'), {
  timeoutMs: 600_000,
  env: {
    HARNESS_THEME_PACKS: JSON.stringify([{ dir: 'tes', from: TES }]), HARNESS_SOURCE_OVERRIDES: JSON.stringify(overrides),
    APPDATA: join(jail, 'AppData/Roaming'), LOCALAPPDATA: join(jail, 'AppData/Local'), USERPROFILE: jail, HOME: jail
  }
})
  .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.ok ? 0 : 1); })
  .catch((e) => { console.error(e); process.exit(1); });
