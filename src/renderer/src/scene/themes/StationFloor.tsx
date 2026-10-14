// The floor for a 'stations' theme pack: the pack's map, drawn as Tiled
// stacks it, with agents walking to their stations and sitting there, sorted
// in depth with rails, consoles and chairs. Everything it decides (paths,
// seats, depth) comes from the pure modules beside it; this file only draws.

import { useEffect, useRef, useState } from 'react';
import { Application, Container, Rectangle, Sprite, Texture } from 'pixi.js';
import 'pixi.js/unsafe-eval';
import { useStore, type Agent } from '@/store/store';
import { Camera } from '../office/Camera';
import { installContextLossRecovery } from '../office/glRecovery';
import { buildScenePlan, byDepth, chairOf, personKey, seatPose, sideFit, type SortedItem } from './compositor';
import { Crew, type CrewAgent, type Walker } from './crew';
import { seatRulesFrom } from './seatAllocator';
import type { LoadedPack } from './packs';
import type { Pixels } from './raster';

function texture(px: Pixels): Texture {
  const cv = document.createElement('canvas');
  cv.width = px.width; cv.height = px.height;
  const g = cv.getContext('2d')!;
  g.putImageData(new ImageData(new Uint8ClampedArray(px.data), px.width, px.height), 0, 0);
  const t = Texture.from(cv);
  t.source.scaleMode = 'nearest';
  return t;
}

/** A stable sheet column for an agent: its preset's body, else a hash of its id. */
function bodyColumn(pack: LoadedPack, a: Agent, cols: number): number {
  const b = pack.manifest.builder;
  const preset = presetOf(a);
  const bodyId = preset ? b?.presets?.find((p) => p.id === preset)?.bodyId : undefined;
  const body = bodyId ? b?.bodies?.find((x) => x.id === bodyId) : undefined;
  if (body) return body.column;
  const list = b?.bodies?.length ? b.bodies.map((x) => x.column) : Array.from({ length: cols }, (_, i) => i);
  let h = 0;
  for (const c of a.id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return list[h % list.length];
}

/** The builder preset an agent was made from (set by the appearance builder, when it lands). */
function presetOf(a: Agent): string | undefined {
  return (a as Agent & { appearance?: { presetId?: string } }).appearance?.presetId;
}

function crewAgents(agents: Agent[]): CrewAgent[] {
  return agents.map((a) => ({ id: a.id, status: a.status, orchestrator: !!a.isGod, presetId: presetOf(a) }));
}

export function StationFloor({ pack }: { pack: LoadedPack }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const appRef = useRef<Application | null>(null);
  const mountIdRef = useRef(0);
  const [glGeneration, setGlGeneration] = useState(0);
  const fullscreenAgentId = useStore((s) => s.fullscreenAgentId);
  const ideOpen = useStore((s) => s.ideOpen);
  const [docHidden, setDocHidden] = useState(() => document.hidden);
  useEffect(() => {
    const onVis = () => setDocHidden(document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);
  const paused = !!fullscreenAgentId || ideOpen || docHidden;
  const pausedRef = useRef(paused);
  useEffect(() => {
    pausedRef.current = paused;
    const ticker = appRef.current?.ticker;
    if (!ticker) return;
    if (paused) ticker.stop(); else ticker.start();
  }, [paused]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    while (host.firstChild) host.removeChild(host.firstChild);
    const mountId = ++mountIdRef.current;
    const app = new Application();
    appRef.current = app;
    const SM = pack.scene, R = pack.manifest.spriteRenderer, fw = R.frameWidth, fh = R.frameHeight;

    const init = async () => {
      await app.init({
        background: pack.manifest.palette.background,
        antialias: false,
        roundPixels: true,
        resolution: Math.max(window.devicePixelRatio || 1, 2),
        autoDensity: true,
        width: host.clientWidth || 800,
        height: host.clientHeight || 600,
      });
      if (mountIdRef.current !== mountId) { safeDestroy(app); return; }
      while (host.firstChild) host.removeChild(host.firstChild);
      host.appendChild(app.canvas);
      (app as any).__glRecovery = installContextLossRecovery(app.canvas, {
        onRebuild: () => { if (mountIdRef.current === mountId) setGlGeneration((n) => n + 1); },
        onGiveUp: () => { if (mountIdRef.current === mountId) host.appendChild(floorNote(GPU_LOST)); },
      });

      const world = new Container();
      app.stage.addChild(world);
      const plan = buildScenePlan({ ...SM, store: pack.store });
      world.addChild(new Sprite(texture(plan.below)));
      const sortLayer = new Container();
      sortLayer.sortableChildren = true;
      world.addChild(sortLayer);
      const statics = plan.sorted.map((it) => {
        if (!it.px) return null;
        const s = new Sprite(texture(it.px));
        s.position.set(it.x, it.y);
        s.alpha = it.opacity;
        sortLayer.addChild(s);
        return s;
      });
      world.addChild(new Sprite(texture(plan.above)));

      const sheetPx = pack.store.get(pack.sheet)!;
      const sheet = texture(sheetPx);
      const cols = Math.max(1, Math.floor(sheetPx.width / fw));
      const frames = new Map<string, Texture>();
      const frame = (col: number, row: number) => {
        const k = `${col}:${row}`;
        let f = frames.get(k);
        if (!f) { f = new Texture({ source: sheet.source, frame: new Rectangle(col * fw, row * fh, fw, fh) }); frames.set(k, f); }
        return f;
      };
      const stand = { down: R.rows.down, up: R.rows.up, left: R.rows.left, right: R.rows.right };
      const sit = { down: R.rows.sitDown, up: R.rows.sitUp, left: R.rows.sitLeft, right: R.rows.sitRight };

      const camera = new Camera(world);
      camera.setMapSize(SM.PW, SM.PH);
      camera.setViewSize(app.screen.width, app.screen.height);
      camera.fitToScreen();

      const cd = pack.manifest.coffee?.cooldown;
      const crew = new Crew(SM, seatRulesFrom(pack.manifest, SM.seatOrder.map((s) => s.name)), Math.random, cd ? { coffeeGap: [cd[0] * 1000, cd[1] * 1000] } : {});
      const sprites = new Map<string, { sprite: Sprite; col: number }>();
      const fits = new Map<string, number | null>();
      const sync = () => {
        const agents = useStore.getState().agents;
        crew.sync(crewAgents(agents));
        const ids = new Set(agents.map((a) => a.id));
        for (const [id, s] of sprites) if (!ids.has(id)) { s.sprite.destroy(); sprites.delete(id); }
        for (const a of agents) if (!sprites.has(a.id)) {
          const sp = new Sprite(frame(0, R.rows.down));
          sp.eventMode = 'static';
          sp.cursor = 'pointer';
          sp.on('pointertap', (ev) => { ev.stopPropagation(); useStore.getState().select(a.id); });
          sortLayer.addChild(sp);
          sprites.set(a.id, { sprite: sp, col: bodyColumn(pack, a, cols) });
        }
      };
      sync();

      let clock = 0;
      const place = (p: Walker, s: { sprite: Sprite; col: number }): { foot: number; rank: number } => {
        const ch: SortedItem | null = p.seated && p.seat ? chairOf(p.seat, plan.sorted) : null;
        let pose = null;
        if (ch && p.seat) {
          const dir = p.dir;
          let fit: number | null = null;
          if (dir === 'left' || dir === 'right') {
            const key = `${ch.chair!.o.gid}|${ch.chair!.B.w}x${ch.chair!.B.h}|${s.col}|${dir}`;
            if (!fits.has(key)) fits.set(key, sideFit(pack.store, ch.chair!.B, { sheet: sheetPx, sx: s.col * fw, sy: sit[dir] * fh, fw, fh }, dir));
            fit = fits.get(key)!;
          }
          pose = seatPose(ch, dir, fw, fh, fit);
        }
        const seated = !!(p.seated && p.seat);
        s.sprite.texture = frame(s.col, (seated ? sit : stand)[p.dir]);
        if (seated && pose) s.sprite.position.set(Math.round(pose.x - fw / 2), Math.round(pose.y));
        else if (seated && p.seat) s.sprite.position.set(Math.round(p.seat.x - fw / 2), Math.round(p.seat.y - fh));
        else {
          const bob = p.moving && Math.floor(clock / 180) % 2 ? -1 : 0;
          s.sprite.position.set(Math.round(p.x - fw / 2), Math.round(p.y - fh) + bob);
        }
        return personKey(p.y, ch, pose);
      };

      const onTick = (tk: { deltaMS: number }) => {
        const dt = Math.min(80, tk.deltaMS);
        clock += dt;
        crew.tick(dt);
        camera.update(dt / 1000);
        const items: Array<{ foot: number; rank: number; sprite: Sprite | null }> = plan.sorted.map((it, i) => ({ foot: it.foot, rank: it.rank, sprite: statics[i] }));
        for (const p of crew.walkers()) {
          const s = sprites.get(p.id);
          if (s) items.push({ ...place(p, s), sprite: s.sprite });
        }
        items.sort(byDepth);
        items.forEach((it, i) => { if (it.sprite) it.sprite.zIndex = i; });
      };
      app.ticker.add(onTick);
      if (pausedRef.current) app.ticker.stop();

      let lastSelected: string | null = useStore.getState().selectedId;
      (app as any).__unsub = useStore.subscribe((s, prev) => {
        if (s.agents !== prev.agents) sync();
        if (s.selectedId !== lastSelected) {
          lastSelected = s.selectedId;
          const p = s.selectedId ? crew.get(s.selectedId) : undefined;
          if (p) camera.nudgeToward(p.x, p.y);
        }
      });
      const resize = new ResizeObserver((entries) => {
        for (const e of entries) {
          const { width, height } = e.contentRect;
          if (width === 0 || height === 0) continue;
          app.renderer?.resize(width, height);
          camera.setViewSize(width, height);
        }
      });
      resize.observe(host);
      (app as any).__resize = resize;
    };

    // Guppy's floors do not retry a failed init (OfficeFloor does the same).
    init().catch((err) => {
      if (mountIdRef.current !== mountId) return;
      console.error('[StationFloor] init failed:', err);
      host.appendChild(floorNote('The floor failed to start:\n' + (err?.message || String(err))));
    });

    return () => {
      mountIdRef.current++;
      const a = appRef.current;
      if (a) {
        (a as any).__glRecovery?.();
        (a as any).__resize?.disconnect?.();
        try { (a as any).__unsub?.(); } catch { /* noop */ }
        safeDestroy(a);
      }
      appRef.current = null;
      while (host.firstChild) host.removeChild(host.firstChild);
    };
  }, [pack, glGeneration]);

  return (
    <div
      ref={hostRef}
      style={{ width: '100%', height: '100%', boxShadow: 'var(--cth-panel-border)', overflow: 'hidden', imageRendering: 'pixelated', background: pack.manifest.palette.background }}
    />
  );
}

/** OfficeFloor's own words for a lost GPU context. */
const GPU_LOST =
  'The office floor lost its GPU context.\n\n' +
  'Too many terminals are using the GPU at once.\n' +
  'Close a few agent terminals, or restart the app, to bring it back.';

function floorNote(text: string): HTMLDivElement {
  const note = document.createElement('div');
  note.style.cssText =
    'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;' +
    'padding:24px;color:#ffd0b5;font-family:monospace;font-size:13px;text-align:center;white-space:pre-wrap;';
  note.textContent = text;
  return note;
}
function safeDestroy(app: Application) {
  try { app.ticker?.stop(); } catch { /* noop */ }
  try { app.destroy(true, { children: true }); } catch { /* noop */ }
}
