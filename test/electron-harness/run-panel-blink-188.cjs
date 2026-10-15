'use strict';

/** PANEL-BLINK-188, rendered: the TES floor's panel lights read back from the canvas (panel-blink-188-floor.tsx)
 *  -> <out>/<label>-strip.png (the bridge, a shot per 250 ms), <out>/<label>-NN.png, <out>/<label>.json, and a
 *  verdict: a working panel cycles PANEL_GREEN (each shot one 240 ms phase), the idle agent's holds amber, so
 *  does the seated waiting agent's (only working/thinking blink, as on the cards), an empty one is dark. A light counts when its drawn pixel is the frame's colour (a person in front covers some).
 *  Jailed: APPDATA, LOCALAPPDATA, USERPROFILE and HOME under <out>/jail; HIVE_/AGENT_/MEMORY_/MUNDER_ scrubbed.
 *    node test/electron-harness/run-panel-blink-188.cjs --out <dir> [--label after] [--station <StationFloor.tsx>]
 *  --station draws another floor (the base, for the before shots); exit 1 when the verdict fails. */
const { createHash } = require('node:crypto');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const loadTs = require('../load-ts.cjs');
const { runScenario } = require('./run.cjs');

const argOf = (k) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : null; };
const out = argOf('out') ? resolve(argOf('out')) : null;
if (!out) { console.error('--out <dir> is required'); process.exit(2); }
const label = argOf('label') || 'after';
const TES = join(__dirname, '..', '..', 'themes', 'tes');
const PN = loadTs('src/renderer/src/scene/themes/panels.ts');
const png = (url) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
const rgb = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
const near = (a, b) => !!a && rgb(a).every((v, i) => Math.abs(v - rgb(b)[i]) <= 3);
// At least this share of a panel's lights drawn in the frame's colour: the sitter covers part of their console
// (Chair2's covers 15 of its 36 lights, 0.583); the base floor, whose lights keep the art's colours, scores ~0.
const MIN = 0.5;

/** The frame a shot of a panel shows: the best-matching one of its state's frames, with the share of lights matched. */
function readPanel(state, colours, lights) {
  const frames = state === 'working' ? [0, 1, 2, 3, 4] : [state];
  let best = { frame: null, rate: -1 };
  for (const f of frames) {
    const rate = lights.filter((q, i) => near(colours[i], PN.lightColour(f, q.h))).length / lights.length;
    if (rate > best.rate) best = { frame: f, rate: Math.round(rate * 1000) / 1000 };
  }
  return best;
}

(async () => {
  for (const k of Object.keys(process.env)) if (/^(HIVE_|AGENT_|MEMORY_|MUNDER_)/i.test(k)) delete process.env[k];
  const jail = join(out, 'jail');
  for (const d of ['AppData/Roaming', 'AppData/Local']) mkdirSync(join(jail, d), { recursive: true });
  const overrides = {};
  if (argOf('station')) overrides[join(__dirname, '..', '..', 'src', 'renderer', 'src', 'scene', 'themes', 'StationFloor.tsx')] = resolve(argOf('station'));
  const r = await runScenario(join(__dirname, 'scenarios', 'panel-blink-188-floor.tsx'), {
    width: 1040, height: 720, timeoutMs: 600_000,
    env: {
      HARNESS_THEME_PACKS: JSON.stringify([{ dir: 'tes', from: TES }]), HARNESS_SOURCE_OVERRIDES: JSON.stringify(overrides),
      APPDATA: join(jail, 'AppData/Roaming'), LOCALAPPDATA: join(jail, 'AppData/Local'), USERPROFILE: jail, HOME: jail
    }
  });
  if (!r.ok) { console.error(r.error); process.exit(1); }
  const strip = r.shots.map((s) => png(s.crop));
  strip.forEach((b, k) => writeFileSync(join(out, `${label}-${String(k).padStart(2, '0')}.png`), b));
  writeFileSync(join(out, `${label}-strip.png`), png(r.strip));

  const lightsOf = Object.fromEntries(r.panels.map((p) => [p.name, p.lights]));
  const per = {};
  for (const s of r.shots) for (const p of s.panels) {
    const row = per[p.name] ||= { seat: p.seat, shots: [] };
    row.shots.push({ phase: s.phase, t: s.t, state: p.state, ...readPanel(p.state, p.colours, lightsOf[p.name]) });
  }
  const fails = [];
  const seen = { working: 0, idle: 0, empty: 0 };
  for (const [name, row] of Object.entries(per)) {
    for (const ph of ['working', 'idle']) {
      const sh = row.shots.filter((x) => x.phase === ph);
      const st = new Set(sh.map((x) => x.state));
      if (st.size !== 1) continue; // someone arrived or left between shots: no steady state to judge
      const state = sh[0].state;
      seen[state]++;
      if (sh.some((x) => x.rate < MIN)) fails.push(`${name} (${ph} phase, ${state}): a shot matched only ${Math.min(...sh.map((x) => x.rate))}`);
      // working: it moves on with the 240 ms step (a shot every 250 ms: one phase, now and then two)
      if (state === 'working' && new Set(sh.map((x) => x.frame)).size < Math.min(sh.length, 4)) fails.push(`${name} (${ph} phase): frames ${sh.map((x) => x.frame).join(',')} do not cycle`);
    }
  }
  const idleRow = Object.entries(per).find(([, row]) => row.shots.some((x) => x.phase === 'idle' && x.state === 'idle'));
  if (!idleRow) fails.push(`no panel went idle after ${r.idleId} did`);
  for (const k of ['working', 'idle', 'empty']) if (!seen[k]) fails.push(`no steady ${k} panel was judged`);
  // god's ruling: only working/thinking blink. The waiting agent keeps its seat, and its console holds amber.
  const waitSeat = r.seatsOf[r.waitId];
  const waitRow = Object.entries(per).find(([, row]) => row.seat === waitSeat);
  const waitShots = waitRow ? waitRow[1].shots.filter((x) => x.phase === 'idle') : [];
  if (!waitSeat || !waitRow) fails.push(`the waiting agent ${r.waitId} holds no panel seat (${waitSeat})`);
  else if (!waitShots.every((x) => x.state === 'idle' && x.frame === 'idle' && x.rate >= MIN)) fails.push(`${waitRow[0]} (${r.waitId} waiting): ${waitShots.map((x) => `${x.state}:${x.rate}`).join(' ')}, not steady amber`);
  const report = {
    label, seatedAt: r.seatedAt, idleAt: r.idleAt, idleId: r.idleId, waitId: r.waitId, waitPanel: waitRow && waitRow[0], seatsOf: r.seatsOf, crop: r.crop,
    distinctShots: new Set(strip.map((b) => createHash('sha256').update(b).digest('hex'))).size,
    judged: seen, fails, panels: per
  };
  writeFileSync(join(out, `${label}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ label, idleId: r.idleId, idlePanel: idleRow && idleRow[0], waitId: r.waitId, waitPanel: waitRow && waitRow[0], distinctShots: report.distinctShots, judged: seen, fails }));
  for (const [name, row] of Object.entries(per)) console.log(`${name.padEnd(8)} ${row.seat.padEnd(8)} ${row.shots.map((x) => `${x.state[0]}${x.frame === 'idle' || x.frame === 'empty' ? '' : x.frame}:${x.rate}`).join(' ')}`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
