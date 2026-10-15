/**
 * SCENARIO - PANEL-BLINK-188: the REAL OfficeFloor drawing the bundled tes pack. Seven agents WORKING
 * (hook status working, liveness BUSY_PROGRESSING) take their seats; then one is turned idle (status and
 * liveness) and another waiting (liveness still BUSY: it stays seated; its console holds amber). Every 240 ms of floor time (one panel step) the canvas is read back at every panel light
 * (panels.ts finds them, as the floor does) and each light's drawn colour reported, with a crop of the bridge.
 * The same scenario runs on the base floor (HARNESS_SOURCE_OVERRIDES) for the before/after.
 * Run on demand: node test/electron-harness/run-panel-blink-188.cjs --out <dir>
 */
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { Application, Container } from 'pixi.js';
import { OfficeFloor } from '../../../src/renderer/src/scene/office/OfficeFloor';
import { useStore } from '../../../src/renderer/src/store/store';
import { loadStationPack } from '../../../src/renderer/src/scene/themes/themeCatalog';
import { Crew } from '../../../src/renderer/src/scene/themes/crew';
import { buildScenePlan } from '../../../src/renderer/src/scene/themes/compositor';
import { findPanels, panelStates, type Panel, type PanelState } from '../../../src/renderer/src/scene/themes/panels';
import { PanelLayer } from '../../../src/renderer/src/scene/themes/PanelLayer';

declare global {
  interface Window {
    __harnessRun: () => Promise<void>;
    harness: { report: (payload: unknown) => void };
  }
}

(window as unknown as { cth: unknown }).cth = new Proxy({}, {
  get: (_t, name: string) => {
    if (name === 'platform') return 'win32';
    if (name === 'recovering') return false;
    if (name.startsWith('on')) return () => () => {};
    if (name.endsWith('Sync')) return () => null;
    if (/^(list|get)/.test(name)) return () => Promise.resolve([]);
    return () => Promise.resolve({ ok: true });
  }
});

const BOX = { w: 1000, h: 680 };
const STEP_MS = 1000 / 60;
const MAX_RENDERS = 9000;
const SETTLE = 60;                 // renders after everyone sat (1 s), and again after the idle switch
const AWAY = 240;                  // renders for the idle agent's status to land (4 s of floor time)
const WORKING_SHOTS = 5, IDLE_SHOTS = 7, EVERY = 15; // 15 renders = 250 ms: the 240 ms step moves 1 (sometimes 2) per shot
const ZOOM = 3, PAD = 6;

Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });

let seed = 188;
Math.random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

{
  let queue = new Map<number, FrameRequestCallback>();
  let seq = 0; let n = 0; let armed = false;
  performance.now = () => n * STEP_MS;
  const frame = () => {
    armed = false;
    n += 1;
    const run = queue; queue = new Map();
    for (const cb of run.values()) cb(n * STEP_MS);
  };
  window.requestAnimationFrame = (cb: FrameRequestCallback) => {
    queue.set(++seq, cb);
    if (!armed) { armed = true; window.setTimeout(frame, 0); }
    return seq;
  };
  window.cancelAnimationFrame = (id: number) => { queue.delete(id); };
}

let crew: Crew | null = null;
const tick = Crew.prototype.tick;
Crew.prototype.tick = function (this: Crew, dt: number) { crew = this; return tick.call(this, dt); };

// The floor's PanelLayer (absent on the base floor): its rasters (own() calls) and the frames each overlay showed,
// so "rastered once per group and frame" is checked on the real floor. Wrapped before its first update.
type LayerGuts = { own: (px: unknown) => unknown; lights: Array<{ tex: Map<unknown, unknown>; shown: unknown }> };
let layer: LayerGuts | null = null, rasters = 0;
const shownBy: Array<Set<unknown>> = [];
const update = PanelLayer.prototype.update;
PanelLayer.prototype.update = function (this: PanelLayer, ...a: Parameters<PanelLayer['update']>) {
  const g = this as unknown as LayerGuts;
  if (!layer) { layer = g; const own = g.own; g.own = (px) => { rasters += 1; return own(px); }; }
  update.apply(this, a);
  g.lights.forEach((L, i) => (shownBy[i] ||= new Set()).add(L.shown));
};

const now = 1_800_000_000_000;
const ids = ['god', 'dwight', 'jim', 'andy', 'pam', 'kevin', 'creed'];
const agents = ids.map((id, i) => ({
  id, name: id, character: id === 'god' ? 'michael' : id, accent: 'sky', isGod: i === 0, status: 'working',
  description: '', project: 'Harness', tmuxTarget: '', cwd: 'C:/harness-test-home', action: `using Bash ${id}`, progress: 0, provider: 'claude', command: 'claude'
}));
const live = (id: string, classification: string) => ({
  agentId: id, incarnation: 1, lifecycle: 'LIVE', classification, classifiedSince: now - 60_000, reason: classification === 'IDLE' ? 'quiescent' : 'pty-traffic', evidence: { lastPtyTrafficAt: now - 500 }
});
const liveness = Object.fromEntries(ids.map((id) => [id, live(id, 'BUSY_PROGRESSING')]));

type Shot = { phase: 'working' | 'idle'; frame: number; t: number; crop: string; panels: Array<{ name: string; seat: string; state: PanelState; colours: string[] }> };
let panels: Panel[] = [];
let arts: string[][] = [];
let crop = { x: 0, y: 0, w: 0, h: 0 };
let renders = 0, seatedAt = 0, idleAt = 0, idleId = '', waitId = '';
const shots: Shot[] = [];
const states: PanelState[] = [];
let done: (() => void) | null = null;
const hex = (d: Uint8ClampedArray, k: number) => '#' + [d[k], d[k + 1], d[k + 2]].map((v) => v.toString(16).padStart(2, '0')).join('');

function shoot(app: Application, world: Container, phase: Shot['phase']) {
  const r = app.renderer.resolution, k = world.scale.x;
  const full = document.createElement('canvas');
  full.width = app.canvas.width; full.height = app.canvas.height;
  const fc = full.getContext('2d', { willReadFrequently: true })!;
  fc.drawImage(app.canvas, 0, 0);
  const img = fc.getImageData(0, 0, full.width, full.height).data;
  const at = (x: number, y: number) => {
    const g = world.toGlobal({ x: x + 0.5, y: y + 0.5 });
    const px = Math.floor(g.x * r), py = Math.floor(g.y * r);
    return px < 0 || py < 0 || px >= full.width || py >= full.height ? '' : hex(img, (py * full.width + px) * 4);
  };
  panelStates(panels, crew!.walkers(), states);
  const g = world.toGlobal({ x: crop.x, y: crop.y });
  const cv = document.createElement('canvas');
  cv.width = crop.w * ZOOM; cv.height = crop.h * ZOOM;
  const c2 = cv.getContext('2d')!;
  c2.imageSmoothingEnabled = false;
  c2.drawImage(app.canvas, g.x * r, g.y * r, crop.w * k * r, crop.h * k * r, 0, 0, cv.width, cv.height);
  shots.push({
    phase, frame: renders, t: Math.round(crew!.t), crop: cv.toDataURL('image/png'),
    panels: panels.map((p, i) => ({ name: p.name, seat: p.seat.name, state: states[i], colours: p.groups.flatMap((gr) => gr.lights.map((q) => at(q.x, q.y))) }))
  });
}

const proto = Application.prototype as unknown as { render: () => void };
const realRender = proto.render;
proto.render = function (this: Application) {
  realRender.call(this);
  renders += 1;
  const finish = () => { if (done) { done(); done = null; } };
  if (shots.length >= WORKING_SHOTS + IDLE_SHOTS || renders >= MAX_RENDERS) return finish();
  if (!crew || !panels.length) return;
  const world = ((this as unknown as { __bubbleLayer?: { container: Container } }).__bubbleLayer?.container.parent as Container | undefined);
  if (!world) return;
  const people = crew.walkers();
  if (!seatedAt) { const sit = people.filter((p) => p.seat); if (sit.length >= 5 && sit.every((p) => p.seated)) seatedAt = renders; return; }
  const since = renders - seatedAt - SETTLE;
  if (since < 0) return;
  if (shots.length < WORKING_SHOTS) { if (since % EVERY === 0) shoot(this, world, 'working'); return; }
  if (!idleAt) {
    // the sitter of the biggest chair console goes idle (status and liveness, as main reports it); the next one
    // goes waiting with liveness still BUSY (waiting is not the classifier's to override): seated, steady amber
    const seats = new Set(panels.map((p) => p.seat));
    const [p, q] = [...people].filter((w) => w.seat && seats.has(w.seat)).sort((a, b) => (panels.find((x) => x.seat === b.seat)!.lights) - (panels.find((x) => x.seat === a.seat)!.lights));
    idleId = p.id; waitId = q.id; idleAt = renders;
    useStore.setState({
      agents: agents.map((a) => (a.id === idleId ? { ...a, status: 'idle', action: '' } : a.id === waitId ? { ...a, status: 'waiting', action: 'waiting on god' } : a)),
      liveness: { ...liveness, [idleId]: live(idleId, 'IDLE') }
    } as never);
    return;
  }
  const after = renders - idleAt - AWAY;
  if (after >= 0 && after % EVERY === 0) shoot(this, world, 'idle');
};

window.__harnessRun = async () => {
  try {
    const loaded = await loadStationPack('tes');
    if (!loaded.pack) throw new Error(`tes did not load: ${JSON.stringify(loaded.diagnostics)}`);
    const pack = loaded.pack;
    const box = document.createElement('div');
    box.style.cssText = `width:${BOX.w}px;height:${BOX.h}px;position:relative`;
    document.body.appendChild(box);
    const root = createRoot(box);
    const finished = new Promise<void>((r) => { done = r; });
    await act(async () => { useStore.setState({ officeTheme: 'tes', agents, liveness, messageQueues: {} } as never); root.render(<OfficeFloor />); });
    // the panels on the crew's own station map (so its seats are the walkers' seats), as the floor finds them
    while (!crew) await new Promise((r) => setTimeout(r, 20));
    const SM = crew.SM;
    const plan = buildScenePlan({ ...SM, store: pack.store });
    panels = findPanels(SM, pack.manifest.stations.layer, plan);
    // each light's own art colour (its owner's pixel): what the base floor draws there when nothing is in front
    const art = (owner: 'below' | 'above' | number, x: number, y: number) => {
      const it = typeof owner === 'number' ? plan.sorted[owner] : null;
      const p = it ? it.px! : owner === 'above' ? plan.above : plan.below, ox = it ? it.x : 0, oy = it ? it.y : 0;
      return hex(p.data as Uint8ClampedArray, ((y - oy) * p.width + (x - ox)) * 4);
    };
    arts = panels.map((p) => p.groups.flatMap((g) => g.lights.map((q) => art(g.owner, q.x, q.y))));
    const xs = panels.flatMap((p) => p.groups.flatMap((g) => [g.x, g.x + g.w])), ys = panels.flatMap((p) => p.groups.flatMap((g) => [g.y, g.y + g.h]));
    crop = { x: Math.min(...xs) - PAD, y: Math.min(...ys) - PAD, w: Math.max(...xs) - Math.min(...xs) + 2 * PAD, h: Math.max(...ys) - Math.min(...ys) + 2 * PAD };
    await finished;
    await act(async () => { root.unmount(); });
    // The strip: the crops side by side, 4 px apart.
    const imgs = await Promise.all(shots.map((s) => new Promise<HTMLImageElement>((res) => { const im = new Image(); im.onload = () => res(im); im.src = s.crop; })));
    const strip = document.createElement('canvas');
    strip.width = Math.max(1, imgs.length * (crop.w * ZOOM + 4) - 4); strip.height = crop.h * ZOOM;
    const sc = strip.getContext('2d')!;
    sc.fillStyle = '#ff00ff'; sc.fillRect(0, 0, strip.width, strip.height);
    imgs.forEach((im, i) => sc.drawImage(im, i * (crop.w * ZOOM + 4), 0));
    window.harness.report(shots.length === WORKING_SHOTS + IDLE_SHOTS
      ? { ok: true, strip: strip.toDataURL('image/png'), seatedAt, idleAt, idleId, waitId, seatsOf: Object.fromEntries(crew.walkers().map((w) => [w.id, w.seat?.name ?? null])), crop, panels: panels.map((p, i) => ({ name: p.name, seat: p.seat.name, lights: p.groups.flatMap((g) => g.lights), art: arts[i] })), shots,
        layer: layer ? { rasters, overlays: layer.lights.map((L, i) => ({ textures: L.tex.size, framesShown: shownBy[i].size })) } : null }
      : { ok: false, error: `${shots.length} shots in ${renders} renders (seatedAt ${seatedAt}, idleAt ${idleAt})` });
  } catch (e) {
    window.harness.report({ ok: false, error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
  }
};
