'use strict';

/** PANEL-BLINK-188, rendered: the TES floor's panel lights read back from the canvas (panel-blink-188-floor.tsx),
 *  run twice in the same deterministic scene (seeded random, a fake clock): on the BASE floor (--base, the floor
 *  before the panel layer) and on this one. -> <out>/{before,after}-strip.png (the bridge, a shot per 250 ms),
 *  <out>/{before,after}-NN.png, <out>/{before,after}.json, and a verdict on the light level, not a share:
 *  - a light is COVERED in a shot when the base floor draws something other than its art there (a person or a
 *    cloud in front); a covered light must never read its own light colour (the lights stay behind; an opaque
 *    cover reads as on the base floor, a fading cloud blends);
 *  - every UNCOVERED light must read its frame's colour: a working panel cycles PANEL_GREEN (each shot one 240 ms
 *    phase), the idle agent's holds amber, so does the seated waiting agent's (only working/thinking blink, as on
 *    the cards), an empty one is dark;
 *  - the floor's PanelLayer rasters each overlay's texture once per frame it shows (own() calls = textures made).
 *  Jailed: APPDATA, LOCALAPPDATA, USERPROFILE and HOME under <out>/jail; HIVE_/AGENT_/MEMORY_/MUNDER_ scrubbed.
 *    node test/electron-harness/run-panel-blink-188.cjs --out <dir> --base <base StationFloor.tsx> [--station <StationFloor.tsx>]
 *  (git show 9f0bcd42:src/renderer/src/scene/themes/StationFloor.tsx > base.tsx). --layer <PanelLayer.ts> draws the
 *  new leg with another panel layer (a mutant census). Exit 1 when the verdict fails. */
const { createHash } = require('node:crypto');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const loadTs = require('../load-ts.cjs');
const { runScenario } = require('./run.cjs');

const argOf = (k) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : null; };
const out = argOf('out') ? resolve(argOf('out')) : null;
const base = argOf('base') ? resolve(argOf('base')) : null;
if (!out || !base) { console.error('--out <dir> and --base <base StationFloor.tsx> are required'); process.exit(2); }
const TES = join(__dirname, '..', '..', 'themes', 'tes');
const FLOOR = join(__dirname, '..', '..', 'src', 'renderer', 'src', 'scene', 'themes', 'StationFloor.tsx');
const LAYER = join(__dirname, '..', '..', 'src', 'renderer', 'src', 'scene', 'themes', 'PanelLayer.ts');
const PN = loadTs('src/renderer/src/scene/themes/panels.ts');
const png = (url) => Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
const rgb = (s) => [1, 3, 5].map((i) => parseInt(s.slice(i, i + 2), 16));
const near = (a, b) => !!a && !!b && rgb(a).every((v, i) => Math.abs(v - rgb(b)[i]) <= 3);

async function leg(label, station) {
  const jail = join(out, 'jail');
  for (const d of ['AppData/Roaming', 'AppData/Local']) mkdirSync(join(jail, d), { recursive: true });
  const r = await runScenario(join(__dirname, 'scenarios', 'panel-blink-188-floor.tsx'), {
    width: 1040, height: 720, timeoutMs: 600_000,
    env: {
      HARNESS_THEME_PACKS: JSON.stringify([{ dir: 'tes', from: TES }]),
      HARNESS_SOURCE_OVERRIDES: JSON.stringify({ ...(station ? { [FLOOR]: station } : {}), ...(label === 'after' && argOf('layer') ? { [LAYER]: resolve(argOf('layer')) } : {}) }),
      APPDATA: join(jail, 'AppData/Roaming'), LOCALAPPDATA: join(jail, 'AppData/Local'), USERPROFILE: jail, HOME: jail
    }
  });
  if (!r.ok) throw new Error(`${label}: ${r.error}`);
  const strip = r.shots.map((s) => png(s.crop));
  strip.forEach((b, k) => writeFileSync(join(out, `${label}-${String(k).padStart(2, '0')}.png`), b));
  writeFileSync(join(out, `${label}-strip.png`), png(r.strip));
  r.distinctShots = new Set(strip.map((b) => createHash('sha256').update(b).digest('hex'))).size;
  return r;
}

/** One panel in one shot: which lights are covered (by the base floor's read), the frame its uncovered lights show
 *  (the best of its state's frames), the share of uncovered lights that read it, and the covered lights that do not
 *  read the base floor's pixel. */
function judge(state, lights, art, now, was) {
  const covered = lights.map((_, i) => !near(was[i], art[i]));
  const open = lights.map((_, i) => i).filter((i) => !covered[i]);
  const frames = state === 'working' ? [0, 1, 2, 3, 4] : [state];
  let best = { frame: null, rate: open.length ? -1 : 1 };
  for (const f of frames) {
    if (!open.length) break;
    const rate = open.filter((i) => near(now[i], PN.lightColour(f, lights[i].h))).length / open.length;
    if (rate > best.rate) best = { frame: f, rate: Math.round(rate * 1000) / 1000 };
  }
  // a covered light leaks when it reads its own colour where the base floor reads something in front. (Not "differs
  // from the base": a fading cloud is translucent, so over a lit panel it blends with the light, not the art.)
  const lit = (i) => (best.frame === null ? frames : [best.frame]).some((f) => near(now[i], PN.lightColour(f, lights[i].h)));
  const leaks = lights.map((_, i) => i).filter((i) => covered[i] && !near(now[i], was[i]) && lit(i)).length;
  return { ...best, covered: covered.filter(Boolean).length, leaks };
}

(async () => {
  for (const k of Object.keys(process.env)) if (/^(HIVE_|AGENT_|MEMORY_|MUNDER_)/i.test(k)) delete process.env[k];
  const B = await leg('before', base);
  const A = await leg('after', argOf('station') ? resolve(argOf('station')) : null);
  const fails = [];
  // the two legs must be the same scene, shot for shot
  if (A.shots.length !== B.shots.length || A.shots.some((s, k) => s.frame !== B.shots[k].frame || s.t !== B.shots[k].t)) fails.push('the base and the new legs did not shoot the same frames');
  if (JSON.stringify(A.seatsOf) !== JSON.stringify(B.seatsOf) || A.idleId !== B.idleId || A.waitId !== B.waitId) fails.push('the base and the new legs did not seat the same people');

  const info = Object.fromEntries(A.panels.map((p) => [p.name, p]));
  const per = {}, before = {};
  A.shots.forEach((s, k) => s.panels.forEach((p, j) => {
    const was = B.shots[k] ? B.shots[k].panels[j].colours : [];
    const row = per[p.name] ||= { seat: p.seat, lights: info[p.name].lights.length, shots: [] };
    row.shots.push({ phase: s.phase, t: s.t, state: p.state, ...judge(p.state, info[p.name].lights, info[p.name].art, p.colours, was) });
    // the base floor, judged the same way against itself: its lights never take a frame's colour
    (before[p.name] ||= []).push(judge(p.state, info[p.name].lights, info[p.name].art, was, was).rate);
  }));
  const seen = { working: 0, idle: 0, empty: 0 };
  for (const [name, row] of Object.entries(per)) {
    for (const x of row.shots) if (x.leaks) fails.push(`${name} @${x.t}: ${x.leaks} of its ${x.covered} covered lights drawn over what is in front`);
    for (const ph of ['working', 'idle']) {
      const sh = row.shots.filter((x) => x.phase === ph);
      if (new Set(sh.map((x) => x.state)).size !== 1) continue; // someone arrived or left between shots: no steady state
      const state = sh[0].state;
      seen[state]++;
      const off = sh.filter((x) => x.rate !== 1);
      if (off.length) fails.push(`${name} (${ph} phase, ${state}): uncovered lights read ${off.map((x) => x.rate).join(',')} of the frame, not all`);
      // working: it moves on with the 240 ms step (a shot every 250 ms: one phase, now and then two)
      if (state === 'working' && new Set(sh.map((x) => x.frame)).size < Math.min(sh.length, 4)) fails.push(`${name} (${ph} phase): frames ${sh.map((x) => x.frame).join(',')} do not cycle`);
    }
  }
  const idleRow = Object.entries(per).find(([, row]) => row.shots.some((x) => x.phase === 'idle' && x.state === 'idle'));
  if (!idleRow) fails.push(`no panel went idle after ${A.idleId} did`);
  for (const k of ['working', 'idle', 'empty']) if (!seen[k]) fails.push(`no steady ${k} panel was judged`);
  if (!Object.values(per).some((row) => row.shots.some((x) => x.covered))) fails.push('no light was covered: the depth was not tested');
  // god's ruling: only working/thinking blink. The waiting agent keeps its seat, and its console holds amber.
  const waitSeat = A.seatsOf[A.waitId];
  const waitRow = Object.entries(per).find(([, row]) => row.seat === waitSeat);
  const waitShots = waitRow ? waitRow[1].shots.filter((x) => x.phase === 'idle') : [];
  if (!waitSeat || !waitRow) fails.push(`the waiting agent ${A.waitId} holds no panel seat (${waitSeat})`);
  else if (!waitShots.every((x) => x.state === 'idle' && x.frame === 'idle' && x.rate === 1)) fails.push(`${waitRow[0]} (${A.waitId} waiting): ${waitShots.map((x) => `${x.state}:${x.rate}`).join(' ')}, not steady amber`);
  // rastered once: every texture the layer made is one an overlay showed, and own() made each once
  const L = A.layer;
  if (!L) fails.push('the floor built no PanelLayer');
  else {
    const made = L.overlays.reduce((n, o) => n + o.textures, 0);
    if (L.rasters !== made) fails.push(`the layer rastered ${L.rasters} times for ${made} textures`);
    L.overlays.forEach((o, i) => { if (o.textures !== o.framesShown || o.textures > 7) fails.push(`overlay ${i}: ${o.textures} textures for ${o.framesShown} frames shown`); });
  }
  const summary = { idleId: A.idleId, idlePanel: idleRow && idleRow[0], waitId: A.waitId, waitPanel: waitRow && waitRow[0], judged: seen, layer: L && { rasters: L.rasters, overlays: L.overlays.length }, fails };
  writeFileSync(join(out, 'before.json'), JSON.stringify({ label: 'before', distinctShots: B.distinctShots, seatsOf: B.seatsOf, uncoveredFrameRate: before }, null, 2));
  writeFileSync(join(out, 'after.json'), JSON.stringify({ label: 'after', distinctShots: A.distinctShots, seatsOf: A.seatsOf, crop: A.crop, ...summary, panels: per }, null, 2));
  console.log(JSON.stringify(summary));
  const cell = (x) => `${x.state[0]}${x.frame === 'idle' || x.frame === 'empty' || x.frame === null ? '' : x.frame}:${x.rate}${x.covered ? `/c${x.covered}` : ''}${x.leaks ? `!${x.leaks}` : ''}`;
  for (const [name, row] of Object.entries(per)) console.log(`${name.padEnd(8)} ${row.seat.padEnd(8)} n${String(row.lights).padEnd(3)} ${row.shots.map(cell).join(' ')}`);
  console.log(`before (base floor, uncovered lights reading a frame's colour): ${Object.entries(before).map(([n, r]) => `${n} ${Math.max(...r)}`).join(', ')}`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
