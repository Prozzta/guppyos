'use strict';
/** CL-M4-CHAINS-PANEL: "possible duplicates" in Settings (scenarios/claims-chains-shots.tsx) at DPR 1 -> <out>/after-*.png,
 *  and with --before <base ClaimLedgerSettings.tsx> the same section as the base build had it -> <out>/before-*.png.
 *  Jailed (APPDATA, LOCALAPPDATA, USERPROFILE, HOME under <out>/jail; HIVE_/AGENT_/MEMORY_/MUNDER_ scrubbed).
 *    node test/electron-harness/run-claims-chains-shots.cjs --out <dir> [--before <file>] */
const { mkdirSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { runScenario } = require('./run.cjs');
const argOf = (k) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : null; };
const out = argOf('out') ? resolve(argOf('out')) : null;
if (!out) { console.error('--out <dir> is required'); process.exit(2); }
const before = argOf('before') ? resolve(argOf('before')) : null;
(async () => {
  for (const k of Object.keys(process.env)) if (/^(HIVE_|AGENT_|MEMORY_|MUNDER_)/i.test(k)) delete process.env[k];
  const jail = join(out, 'jail');
  for (const d of ['AppData/Roaming', 'AppData/Local']) mkdirSync(join(jail, d), { recursive: true });
  const panelSrc = join(__dirname, '..', '..', 'src', 'renderer', 'src', 'components', 'ClaimLedgerSettings.tsx');
  const r = await runScenario(join(__dirname, 'scenarios', 'claims-chains-shots.tsx'), {
    width: 1280, height: 800, timeoutMs: 120_000,
    env: {
      APPDATA: join(jail, 'AppData/Roaming'), LOCALAPPDATA: join(jail, 'AppData/Local'), USERPROFILE: jail, HOME: jail, HARNESS_DPR: '1',
      ...(before ? { HARNESS_SOURCE_OVERRIDES: JSON.stringify({ [panelSrc]: before }) } : {}),
    }
  });
  if (!r.ok) { console.error(r.error); process.exit(1); }
  const tag = before ? 'before' : 'after';
  if (r.before !== !!before) { console.error(`the ${tag} run rendered the ${r.before ? 'base' : 'duplicates'} section`); process.exit(1); }
  for (const s of r.shots) {
    writeFileSync(join(out, `${tag}-${s.name}.png`), Buffer.from(s.png.slice(s.png.indexOf(',') + 1), 'base64'));
    console.log(`${tag}-${s.name}.png ${s.size.width}x${s.size.height} dpr ${s.dpr}`);
    if (s.dpr !== 1 || s.size.width !== 1280 || s.size.height !== 800) { console.error('not a DPR-1 1280x800 shot'); process.exit(1); }
  }
  console.log(`bridge calls: ${r.calls.join(', ') || 'none'}`);
})().catch((e) => { console.error(e); process.exit(1); });
