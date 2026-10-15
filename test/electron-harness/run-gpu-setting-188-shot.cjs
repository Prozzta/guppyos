'use strict';
/** GPU-SETTING-188, the Settings -> General -> Graphics section in each state (scenarios/gpu-setting-188.tsx)
 *  -> <out>/graphics-<state>.png and <out>/graphics-shots.json, with a verdict on what each shot shows.
 *  Jailed (APPDATA, LOCALAPPDATA, USERPROFILE, HOME under <out>/jail; HIVE_/AGENT_/MEMORY_/MUNDER_ scrubbed).
 *    node test/electron-harness/run-gpu-setting-188-shot.cjs --out <dir> */
const { mkdirSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { runScenario } = require('./run.cjs');
const argOf = (k) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : null; };
const out = argOf('out') ? resolve(argOf('out')) : null;
if (!out) { console.error('--out <dir> is required'); process.exit(2); }
const WANT = {
  'auto-gpu': { select: 'auto', indicator: /^Rendering: .+ \(GPU\)$/, restart: null },
  'cpu-cpu': { select: 'cpu', indicator: /^Rendering: software \(CPU\)$/, restart: null },
  'gpu-fallback': { select: 'gpu', indicator: /^Rendering: software \(CPU\): no usable GPU, fell back to the CPU$/, restart: null },
  restart: { select: 'cpu', indicator: /\(GPU\)$/, restart: /takes effect after a restart/ },
  confirm: { select: 'cpu', indicator: /\(GPU\)$/, restart: /Restarting stops 2 running agents\. Restart now\?/ }
};
(async () => {
  for (const k of Object.keys(process.env)) if (/^(HIVE_|AGENT_|MEMORY_|MUNDER_)/i.test(k)) delete process.env[k];
  const jail = join(out, 'jail');
  for (const d of ['AppData/Roaming', 'AppData/Local']) mkdirSync(join(jail, d), { recursive: true });
  const r = await runScenario(join(__dirname, 'scenarios', 'gpu-setting-188.tsx'), {
    width: 600, height: 400, timeoutMs: 120_000,
    env: { APPDATA: join(jail, 'AppData/Roaming'), LOCALAPPDATA: join(jail, 'AppData/Local'), USERPROFILE: jail, HOME: jail }
  });
  if (!r.ok) { console.error(r.error); process.exit(1); }
  const fails = [];
  for (const s of r.shots) {
    writeFileSync(join(out, `graphics-${s.name}.png`), Buffer.from(s.png.slice(s.png.indexOf(',') + 1), 'base64'));
    const w = WANT[s.name];
    if (s.view.select !== w.select) fails.push(`${s.name}: select ${s.view.select}, not ${w.select}`);
    if (!w.indicator.test(s.view.indicator || '')) fails.push(`${s.name}: indicator "${s.view.indicator}"`);
    if (w.restart === null ? s.view.restart !== null : !w.restart.test(s.view.restart || '')) fails.push(`${s.name}: restart row "${s.view.restart}"`);
  }
  if (r.restarts.length) fails.push(`restart was called (${r.restarts}) without the confirm being accepted`);
  writeFileSync(join(out, 'graphics-shots.json'), JSON.stringify({ real: r.real, realName: r.realName, views: r.shots.map((s) => ({ name: s.name, size: s.size, ...s.view })), fails }, null, 2));
  for (const s of r.shots) console.log(`${s.name}: ${s.view.indicator}${s.view.restart ? ' | ' + s.view.restart : ''}`);
  console.log(`real GPU name: ${r.real} (${r.realName})`);
  if (fails.length) { console.error('FAIL\n' + fails.join('\n')); process.exit(1); }
  console.log('PASS');
})().catch((e) => { console.error(e); process.exit(1); });
