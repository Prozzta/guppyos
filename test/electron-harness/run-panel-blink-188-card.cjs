'use strict';
/** PANEL-BLINK-188 (b), rendered: the bottom dock's AgentCard (panel-blink-188-card.tsx) -> <out>/<label>-card-NN.png,
 *  <out>/<label>-card.json and a verdict: the WORKING card's dot runs cth-led and its opacity steps between 1 and
 *  0.35; the IDLE card's, and the hook-working-but-liveness-IDLE card's, run nothing and stay at 1.
 *  Jailed (APPDATA, LOCALAPPDATA, USERPROFILE, HOME under <out>/jail; HIVE_/AGENT_/MEMORY_/MUNDER_ scrubbed).
 *    node test/electron-harness/run-panel-blink-188-card.cjs --out <dir> [--label after] [--badge <PixelBadge.tsx>]
 *  --badge renders another PixelBadge (the base, for the before shots); exit 1 when the verdict fails. */
const { mkdirSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { runScenario } = require('./run.cjs');
const argOf = (k) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : null; };
const out = argOf('out') ? resolve(argOf('out')) : null;
if (!out) { console.error('--out <dir> is required'); process.exit(2); }
const label = argOf('label') || 'after';
(async () => {
  for (const k of Object.keys(process.env)) if (/^(HIVE_|AGENT_|MEMORY_|MUNDER_)/i.test(k)) delete process.env[k];
  const jail = join(out, 'jail');
  for (const d of ['AppData/Roaming', 'AppData/Local']) mkdirSync(join(jail, d), { recursive: true });
  const overrides = {};
  if (argOf('badge')) overrides[join(__dirname, '..', '..', 'src', 'renderer', 'src', 'components', 'PixelBadge.tsx')] = resolve(argOf('badge'));
  if (argOf('card')) overrides[join(__dirname, '..', '..', 'src', 'renderer', 'src', 'components', 'AgentCard.tsx')] = resolve(argOf('card'));
  const r = await runScenario(join(__dirname, 'scenarios', 'panel-blink-188-card.tsx'), {
    width: 720, height: 110, timeoutMs: 300_000,
    env: { HARNESS_SOURCE_OVERRIDES: JSON.stringify(overrides), APPDATA: join(jail, 'AppData/Roaming'), LOCALAPPDATA: join(jail, 'AppData/Local'), USERPROFILE: jail, HOME: jail }
  });
  if (!r.ok) { console.error(r.error); process.exit(1); }
  r.shots.forEach((u, k) => writeFileSync(join(out, `${label}-card-${String(k).padStart(2, '0')}.png`), Buffer.from(u.slice(u.indexOf(',') + 1), 'base64')));
  const fails = [];
  const want = { god: 'working', dwight: 'idle', jim: 'idle' };
  for (const c of r.cards) {
    if (c.label !== want[c.id]) fails.push(`${c.id}: the chip reads ${c.label}, not ${want[c.id]}`);
    const lit = new Set(c.opacity.map((o) => Math.round(o * 100) / 100));
    if (want[c.id] === 'working') {
      if (c.animationName !== 'cth-led' || !c.running.includes('cth-led')) fails.push(`${c.id}: working, but its dot runs ${c.animationName} [${c.running}]`);
      if (!(lit.has(1) && lit.has(0.35))) fails.push(`${c.id}: working, but its dot's opacity was only ${[...lit]}`);
    } else {
      if (c.running.length || c.animationName !== 'none') fails.push(`${c.id}: idle, but its dot runs ${c.animationName} [${c.running}]`);
      if (lit.size !== 1 || !lit.has(1)) fails.push(`${c.id}: idle, but its dot's opacity was ${[...lit]}`);
    }
  }
  const report = { label, cards: r.cards, fails };
  writeFileSync(join(out, `${label}-card.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
