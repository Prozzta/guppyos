// The floor for a 'stations' theme pack: the pack's map, drawn as Tiled
// stacks it, with agents walking to their stations and sitting there, sorted
// in depth with rails, consoles and chairs. Everything it decides (paths,
// seats, depth) comes from the pure modules beside it; this file only draws.

import { useEffect, useRef, useState } from 'react';
import { Application, Container, Rectangle, RenderTexture, Sprite, Texture } from 'pixi.js';
import 'pixi.js/unsafe-eval';
import { useStore, type Agent } from '@/store/store';
import { activityStatus, heavyActivity, type HeavyLockView } from '@shared/activityView';
import type { LivenessV1 } from '@shared/livenessV1';
import { Camera, watchDevicePixelRatio } from '../office/Camera';
import { installContextLossRecovery } from '../office/glRecovery';
import { applyFloorFrameBudget } from '../office/floorFrameBudget';
import { buildScenePlan, byDepth, chairOf, personKey, seatPose, sideFit, type SortedItem } from './compositor';
import { Crew, type CrewAgent, type Walker } from './crew';
import { seatRulesFrom } from './seatAllocator';
import type { LoadedPack } from './packs';
import type { Pixels } from './raster';
import { presetIdOf, readLook, resolveLook } from './looks';
import { lookColumn } from './lookArt';
import { teardownFloor } from './teardown';
import { cacheKeyOf, cacheStale, frontPicker, regionPicker, hasVisiblePixel, NEAR_MIN_SCALE, liveBoxes, screenCells, staticOrder, staticsCacheable, type Box } from './staticCache';
import type { ThemeLooks } from './themeCatalog';
import { floorFrame } from './framing';
import { BubbleLayer } from './BubbleLayer';
import { cloudAnchor, drawnSprite } from './cloudAnchor';
import { activityThought, createSayCursor, type BubbleSay } from './bubbleModel';
import { linePicker, type LinePicker } from './packLines';
import type { MessageAct } from '../office/MessageEnvelope';
import { coffeeProps, cupInHand, endedSays, freshSays, mugDepth, mugDx, mugPixels, pruneSaid, MUG_H, MUG_W, type CupPose } from './coffeeProps';

function texture(px: Pixels): Texture {
  const cv = document.createElement('canvas');
  cv.width = px.width; cv.height = px.height;
  const g = cv.getContext('2d')!;
  g.putImageData(new ImageData(new Uint8ClampedArray(px.data), px.width, px.height), 0, 0);
  const t = Texture.from(cv);
  t.source.scaleMode = 'nearest';
  return t;
}

/** IDLE-MEANS-IDLE (1.1.87): as on the office floor, an idle agent with a heavy job in the background
 *  works at its station, and one queued for (or holding a reservation on) the heavy slot waits there:
 *  both are at their desks to the Crew, so neither starts a coffee run. */
function crewAgents(pack: LoadedPack, agents: Agent[], liveness: Readonly<Record<string, LivenessV1 | undefined>>, heavyLock?: HeavyLockView | null): CrewAgent[] {
  const b = pack.manifest.builder, id = pack.manifest.id;
  return agents.map((a) => ({ id: a.id, status: activityStatus(a.status, liveness[a.id], heavyActivity(a.id, heavyLock)), orchestrator: !!a.isGod, presetId: presetIdOf(b, a, id) }));
}

function crewSays(events: ReadonlyArray<{ kind: string; id: string; with?: string; at: number }>, line?: LinePicker): BubbleSay[] {
  // Coffee lines (brew, sip) come from coffeeProps, once per coffee state, in the viewer's words.
  // TES-BUBBLES-188: with the pack's own lines, a chat is the viewer's gossip or cheer (said by the
  // one who started it) and an errand stop its errand or idle thought; these are the fallback.
  const lines: Record<string, string> = { chat: 'quick sync', errand: 'stepping away', gaveUp: 'back to work' };
  return events.flatMap((event) => {
    const key = `${event.kind}:${event.id}:${event.at}`;
    // The viewer's errand thoughts, its idle thought one time in four (2 of 8), its gossip or cheer.
    const kinds = event.kind === 'chat' ? ['gossip', 'cheer']
      : event.kind === 'errand' ? ['water', 'window', 'dispenser', 'fridge', 'shelf', 'bin', 'idle', 'idle'] : null;
    const packed = kinds && line?.(kinds, key);
    if (packed) return [{ key, id: event.id, text: packed, ttl: 2600 }];
    const text = lines[event.kind];
    if (!text) return [];
    const own: BubbleSay = { key, id: event.id, text, ttl: event.kind === 'sip' ? 3000 : 2600 };
    if (event.kind !== 'chat' || !event.with) return [own];
    return [own, { ...own, key: `${key}:${event.with}`, id: event.with }];
  });
}

/** The Crew keeps a bounded, append-only event list. Do not re-project its old entries per frame. */
export function newerCrewEvents<T extends { at: number }>(events: readonly T[], lastAt: number): readonly T[] {
  const first = events.findIndex((event) => event.at > lastAt);
  return first < 0 ? [] : events.slice(first);
}

/** Remove a rendered person and its bubble together. Kept separate so departure is testable. */
export function removeDepartedSprites(
  sprites: Map<string, { sprite: { destroy(): void } }>,
  ids: ReadonlySet<string>,
  bubbles: Pick<BubbleLayer, 'remove'>
): void {
  for (const [id, s] of sprites) if (!ids.has(id)) { s.sprite.destroy(); sprites.delete(id); bubbles.remove(id); }
}

/** A thought can exist before (or without) a sprite, so it still needs its own departure path. */
export function removeUnrenderedBubbles(
  bubbleIds: Set<string>,
  sprites: ReadonlyMap<string, unknown>,
  ids: ReadonlySet<string>,
  bubbles: Pick<BubbleLayer, 'remove'>
): void {
  for (const id of bubbleIds) if (!ids.has(id) && !sprites.has(id)) { bubbles.remove(id); bubbleIds.delete(id); }
}

/** Wire the preload bridge once and return the matching unmount cleanup. */
export function bindHiveBubbles(app: unknown, bubbles: Pick<BubbleLayer, 'handoff' | 'destroy'>): () => void {
  const offMessage = window.cth.onHiveMessage
        ? window.cth.onHiveMessage((event) => {
        for (const target of event.targets) {
          bubbles.handoff(event.from, target === 'human' ? '__human__' : target, event.act as MessageAct, event.needsHuman);
        }
      })
    : () => { /* A stale preload bridge simply disables handoff animation. */ };
  (app as any).__offMessage = offMessage;
  (app as any).__bubbleLayer = bubbles;
  return () => {
    const a = app;
    try { (a as any).__offMessage?.(); } catch { /* noop */ }
    try { (a as any).__bubbleLayer?.destroy?.(); } catch { /* noop */ }
  };
}

/** StationFloor's liveness-aware input for its shared thought-cloud layer. */
function bubbleThoughts(agents: Agent[], liveness: Readonly<Record<string, LivenessV1 | undefined>>, heavyLock?: HeavyLockView | null) {
  return agents.map((agent) => ({ id: agent.id, thought: activityThought(agent, liveness[agent.id], heavyActivity(agent.id, heavyLock)) }));
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
        resolution: window.devicePixelRatio || 1,
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
      const plan = buildScenePlan({ ...SM, store: pack.store });
      // Every texture made here is destroyed on unmount.
      const owned: Texture[] = [];
      const own = (px: Pixels) => { const t = texture(px); owned.push(t); return t; };
      const staticTex = plan.sorted.map((it) => (it.px ? own(it.px) : null));
      const staticSprite = (i: number) => {
        const it = plan.sorted[i], s = new Sprite(staticTex[i]!);
        s.position.set(it.x, it.y);
        s.alpha = it.opacity;
        return s;
      };
      const staticBox = plan.sorted.map((it): Box | null => (it.px ? { x: it.x, y: it.y, w: it.px.width, h: it.px.height } : null));
      const below = new Sprite(own(plan.below));
      const sortLayer = new Container();
      sortLayer.sortableChildren = true;
      const statics = plan.sorted.map((it, i) => {
        if (!it.px) return null;
        const s = staticSprite(i);
        sortLayer.addChild(s);
        return s;
      });

      // TES-GUPPY-RASTER: 'below' and the statics are drawn, by the very same sprites, into a
      // screen-sized cache once the picture they make holds still; each frame copies its reachable
      // cells 1:1, then redraws each rect around the people, clipped to it, with the statics that
      // can draw there (staticCache.ts). While the picture changes, and for partial alpha,
      // everything is drawn directly as before.
      const cached = staticsCacheable(plan);
      const order = staticOrder(plan.sorted);
      const pickFront = cached ? frontPicker(plan.sorted, order, plan.below.width, plan.below.height) : null;
      const pickRegion = cached ? regionPicker(plan.sorted, plan.below.width, plan.below.height) : null;
      const CELL = 32;
      const cacheLayer = new Container();
      // As in the stage, the world's transform is a child's, so its vertices are made the same way
      // (a rendered root's own transform would go to the GPU as a uniform instead).
      const cacheRoot = new Container();
      const cacheWorld = cacheRoot.addChild(new Container());
      const cells = new Map<number, Sprite>();
      // The rects' copy of the cache: the whole of it in one quad, read back mirrored as the cells
      // are; the scissor keeps it to the rect, so a rect never walks the cells.
      let passCache: Sprite | null = null;
      let rt: RenderTexture | null = null;
      let cacheKey: string | null = null, lastKey: string | null = null, lastExact: string | null = null;
      const noLive: boolean[] = [];
      // The rects redrawn around the people this frame, the statics shown in them, and what the
      // main pass shows.
      let passes: Box[] = [];
      let passOn: boolean[] = [];
      let mainFront: boolean[] | null = null, inPass = false;
      let cacheBoxes: Box[] = [];
      const cacheStatics: Array<Sprite | null> = plan.sorted.map(() => null);
      const belowDirect = new Sprite(below.texture);
      world.addChild(belowDirect);
      if (cached) {
        cacheWorld.addChild(below);
        for (const i of order) if (staticTex[i]) cacheStatics[i] = cacheWorld.addChild(staticSprite(i));
        cacheBoxes = [...liveBoxes(plan.below, 0, 0, CELL), ...plan.sorted.flatMap((it) => (it.px ? liveBoxes(it.px, it.x, it.y, 8) : []))];
        app.stage.addChild(cacheLayer);
      }
      world.addChild(sortLayer);
      if (!cached || hasVisiblePixel(plan.above)) world.addChild(new Sprite(own(plan.above)));
      // The map is cacheable; its clouds and envelopes are deliberately live above the people.
      const bubbles = new BubbleLayer({ width: SM.PW, height: SM.PH });
      world.addChild(bubbles.container);
      (app as any).__bubbleLayer = bubbles;
      app.stage.addChild(world);
      const dropCells = () => {
        for (const s of cells.values()) s.destroy({ texture: true, textureSource: false });
        cells.clear();
      };
      const refreshCache = (liveStatics: boolean[]) => {
        cacheStatics.forEach((s, i) => { if (s) s.visible = !liveStatics[i]; });
        const r = app.renderer.resolution, W = app.canvas.width, H = app.canvas.height;
        if (!rt || cacheStale(rt, W, H, r)) {
          dropCells();
          passCache?.destroy({ texture: true, textureSource: false });
          passCache = null;
          rt?.destroy(true);
          rt = RenderTexture.create({ width: W / r, height: H / r, resolution: r, scaleMode: 'nearest' });
          const none = new Container();
          app.renderer.render({ container: none, target: rt, clear: true }); // gives it a framebuffer
          none.destroy();
        }
        // The cache is drawn on the canvas itself, over the background, by the canvas's own
        // arithmetic (a render texture's flipped projection tips a few rounding ties the other
        // way), then copied out bottom row first; each cell reads it back mirrored. The frame's
        // own render then draws over the canvas as always.
        cacheWorld.position.copyFrom(world.position);
        cacheWorld.scale.copyFrom(world.scale);
        app.renderer.render({ container: cacheRoot, clear: true });
        // A blit, not copyTexSubImage2D: the canvas has no alpha channel and the cache has one.
        const targets = app.renderer.renderTarget as any;
        const gl = (app.renderer as any).gl as WebGL2RenderingContext;
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, targets.getGpuRenderTarget(targets.getRenderTarget(rt)).framebuffer);
        gl.blitFramebuffer(0, 0, W, H, 0, 0, W, H, gl.COLOR_BUFFER_BIT, gl.NEAREST);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        const live = new Set<number>();
        for (const c of screenCells(cacheBoxes, world.scale.x * r, world.x * r, world.y * r, W, H, CELL)) {
          const id = c.y * W + c.x;
          live.add(id);
          if (cells.has(id)) continue;
          const s = new Sprite(new Texture({ source: rt.source, frame: new Rectangle(c.x / r, (H - c.y - c.h) / r, c.w / r, c.h / r) }));
          s.position.set(c.x / r, (c.y + c.h) / r);
          s.scale.y = -1;
          cacheLayer.addChild(s);
          cells.set(id, s);
        }
        for (const [id, s] of cells) s.visible = live.has(id);
        if (!passCache) {
          passCache = new Sprite(new Texture({ source: rt.source, frame: new Rectangle(0, 0, W / r, H / r) }));
          passCache.position.set(0, H / r);
          passCache.scale.y = -1;
          passCache.visible = false;
          app.stage.addChildAt(passCache, app.stage.getChildIndex(cacheLayer) + 1);
        }
      };
      // After the frame's own render (still inside it, so before the canvas is shown or read), each
      // rect around a person is drawn again, scissored to it: cleared, the cache, then in depth order
      // the people and the statics that can draw in any rect. A static picked for another rect has
      // no opaque pixel in this one, so it draws nothing here; with one set for all rects, Pixi
      // builds the rects' instructions once and replays them per rect. Rects may overlap: each is
      // drawn whole. Outside them the frame holds the cache (and any live statics), where no person
      // can draw.
      const postrender = {
        postrender: (o: { container: unknown }) => {
          if (inPass || o.container !== app.stage || !passes.length) return;
          const gl = (app.renderer as any).gl as WebGL2RenderingContext;
          const H = app.canvas.height;
          inPass = true;
          try {
            // The people stay visible after the passes: between frames, when pointer events are
            // dispatched, Pixi prunes invisible sprites from hit tests (onTick hides them again
            // before the next main pass).
            for (const s of sprites.values()) s.sprite.visible = true;
            for (const c of cups.values()) c.sprite.visible = true;
            cacheLayer.visible = false;
            if (passCache) passCache.visible = true;
            gl.enable(gl.SCISSOR_TEST);
            statics.forEach((s, i) => { if (s) s.visible = passOn[i]; });
            for (const p of passes) {
              gl.scissor(p.x, H - p.y - p.h, p.w, p.h);
              app.renderer.render({ container: app.stage, clear: true });
            }
          } finally {
            gl.disable(gl.SCISSOR_TEST);
            cacheLayer.visible = true;
            if (passCache) passCache.visible = false;
            statics.forEach((s, i) => { if (s) s.visible = mainFront ? mainFront[i] : true; });
            inPass = false;
          }
        },
      };
      if (cached) app.renderer.runners.postrender.add(postrender);
      // Freed on unmount before the app is destroyed, each step on its own (teardown.ts).
      (app as any).__free = [
        () => app.renderer.runners.postrender.remove(postrender),
        dropCells,
        () => rt?.destroy(true),
        () => cacheRoot.destroy({ children: true }),
        () => { for (const t of owned) t.destroy(true); }, // read at unmount: textures made later are in it
      ];

      const sheetPx = pack.store.get(pack.sheet)!;
      const cols = Math.max(1, Math.floor(sheetPx.width / fw));
      const looks: ThemeLooks = { themeId: pack.manifest.id, label: pack.manifest.label, builder: pack.manifest.builder, sprite: R, columns: cols, sheet: sheetPx };
      // One texture per look (the body's column in the agent's colours), one frame texture per look and row.
      const lookTex = new Map<string, Texture>();
      const frames = new Map<string, Texture>();
      const lookOf = (a: Agent) => {
        const r = resolveLook(looks.builder, cols, readLook(a.appearanceByTheme?.[looks.themeId]), a.id);
        const key = [r.body.id, r.colors.skin, r.colors.shirt, r.colors.hair].join('|');
        if (!lookTex.has(key)) {
          const t = Texture.from(lookColumn(looks, r.body, r.colors));
          t.source.scaleMode = 'nearest';
          lookTex.set(key, t);
        }
        return { key, col: r.body.column };
      };
      const frame = (look: string, row: number) => {
        const k = `${look}:${row}`;
        let f = frames.get(k);
        if (!f) { f = new Texture({ source: lookTex.get(look)!.source, frame: new Rectangle(0, row * fh, fw, fh) }); frames.set(k, f); }
        return f;
      };
      const stand = { down: R.rows.down, up: R.rows.up, left: R.rows.left, right: R.rows.right };
      // COFFEE-NEVER-186: the viewer's mug, in the hand (anchored to the frame's hand pixels, read
      // off the pack's sheet) and parked at a station, sorted with what it stands on.
      const mugTex = { right: own(mugPixels(false)), left: own(mugPixels(true)) };
      const hands = new Map<string, CupPose | null>();
      const handOf = (col: number, dir: Walker['dir']) => {
        const k = `${col}|${dir}`;
        if (!hands.has(k)) hands.set(k, cupInHand(sheetPx, col * fw, stand[dir] * fh, fw, fh, dir));
        return hands.get(k)!;
      };
      const cups = new Map<string, { sprite: Sprite; back: boolean }>();
      const mugs = new Map<string, { sprite: Sprite; foot: number; rank: number }>();
      const said = new Map<string, string>();
      const sit = { down: R.rows.sitDown, up: R.rows.sitUp, left: R.rows.sitLeft, right: R.rows.sitRight };

      // TES-GUPPY-SETTLE: eased by time and landed exactly, so a slow frame rate cannot keep the
      // picture moving (and the cache off) for long.
      const camera = new Camera(world, { resolution: () => app.renderer.resolution });
      camera.setMapSize(SM.PW, SM.PH);
      // TES-GUPPY-FRAMING: fit the pack's art (centred, its dead bottom band clippable), not the whole map.
      camera.setFrame(floorFrame(pack.manifest.id, SM.PW, SM.PH));
      camera.setViewSize(app.screen.width, app.screen.height);
      camera.fitToScreen();

      const cd = pack.manifest.coffee?.cooldown;
      const crew = new Crew(SM, seatRulesFrom(pack.manifest, SM.seatOrder.map((s) => s.name)), Math.random, cd ? { coffeeGap: [cd[0] * 1000, cd[1] * 1000] } : {});
      const sprites = new Map<string, { sprite: Sprite; col: number; look: string }>();
      const fits = new Map<string, number | null>();
      const sayCursor = createSayCursor();
      const packLines = linePicker(pack.lines);
      const bubbleIds = new Set<string>();
      const sync = () => {
        const { agents, liveness, heavyLock } = useStore.getState();
        crew.sync(crewAgents(pack, agents, liveness, heavyLock));
        const ids = new Set(agents.map((a) => a.id));
        const thoughts = new Map(bubbleThoughts(agents, liveness, heavyLock).map((item) => [item.id, item.thought]));
        removeUnrenderedBubbles(bubbleIds, sprites, ids, bubbles);
        removeDepartedSprites(sprites, ids, bubbles);
        for (const a of agents) {
          const thought = thoughts.get(a.id) ?? null;
          bubbles.setThought(a.id, thought ? { text: thought.text, tool: thought.tool } : null);
          bubbleIds.add(a.id);
          const l = lookOf(a), have = sprites.get(a.id);
          if (have) { have.col = l.col; have.look = l.key; continue; } // a look edited in Add/Edit shows at once
          const sp = new Sprite(frame(l.key, R.rows.down));
          sp.eventMode = 'static';
          sp.cursor = 'pointer';
          sp.on('pointertap', (ev) => { ev.stopPropagation(); useStore.getState().select(a.id); });
          sortLayer.addChild(sp);
          sprites.set(a.id, { sprite: sp, col: l.col, look: l.key });
        }
      };
      sync();

      let clock = 0;
      // The camera's clock: the time between this floor's own ticks (the ticker's deltaMS is capped
      // at 100 ms, and under the frame budget it spans one display frame, not one floor tick).
      let lastTickAt = performance.now();
      let lastDepth: string | null = null;
      let lastCrewEventAt = -1;
      const place = (p: Walker, s: { sprite: Sprite; col: number; look: string }): { foot: number; rank: number; anchor: { x: number; y: number } } => {
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
        s.sprite.texture = frame(s.look, (seated ? sit : stand)[p.dir]);
        const drawn = drawnSprite(p, pose, fw, fh, clock);
        s.sprite.position.set(drawn.x, drawn.y);
        // TES-BUBBLES-188: the cloud hangs from the sprite as drawn (the seat pose), not the walker's point.
        return { ...personKey(p.y, ch, pose), anchor: cloudAnchor(drawn, fw, fh) };
      };

      const onTick = (tk: { deltaMS: number }) => {
        const dt = Math.min(80, tk.deltaMS);
        clock += dt;
        crew.tick(dt);
        // The camera eases by all the time that passed, however long the frame took: a stalled
        // frame (the GPU busy for seconds) must not leave the camera behind.
        const now = performance.now();
        camera.update(Math.max(0, now - lastTickAt) / 1000);
        lastTickAt = now;
        const people: Array<{ foot: number; rank: number; sprite: Sprite; id: string }> = [];
        const anchors: Array<{ id: string; x: number; y: number }> = [];
        for (const p of crew.walkers()) {
          const s = sprites.get(p.id);
          if (s) {
            const { foot, rank, anchor } = place(p, s);
            people.push({ foot, rank, sprite: s.sprite, id: p.id });
            anchors.push({ id: p.id, ...anchor });
          }
        }
        if (SM.entrance) anchors.push({ id: '__human__', x: SM.entrance[0], y: SM.entrance[1] });
        const freshEvents = newerCrewEvents(crew.events, lastCrewEventAt);
        if (freshEvents.length) {
          bubbles.consumeSays(crewSays(freshEvents, packLines), sayCursor);
          lastCrewEventAt = freshEvents[freshEvents.length - 1].at;
        }
        const holding = new Set<string>(), parked = new Set<string>();
        const coffee = coffeeProps(crew, packLines);
        pruneSaid(said, crew.walkers().map((p) => p.id));
        for (const item of freshSays(coffee, said)) bubbles.say(item.id, item.text, { ttl: item.ttl, key: item.key });
        for (const [id, key] of endedSays(coffee, said)) bubbles.unsay(id, key);
        for (const item of coffee) {
          if (item.kind === 'say') continue;
          if (item.kind === 'cup') {
            const s = sprites.get(item.id), pose = s ? handOf(s.col, item.dir) : null;
            if (!s || !pose) continue;
            let c = cups.get(item.id);
            if (!c) { c = { sprite: sortLayer.addChild(new Sprite(mugTex.right)), back: false }; cups.set(item.id, c); }
            c.sprite.texture = pose.left ? mugTex.left : mugTex.right;
            c.sprite.position.set(s.sprite.x + pose.x + mugDx(pose.left), s.sprite.y + pose.y - MUG_H);
            c.back = pose.back;
            holding.add(item.id);
          } else {
            let m = mugs.get(item.owner);
            if (!m) { m = { sprite: sortLayer.addChild(new Sprite(mugTex.right)), foot: 0, rank: 0 }; mugs.set(item.owner, m); }
            if (m.sprite.x !== item.x + mugDx(false) || m.sprite.y !== item.y - MUG_H) {
              m.sprite.position.set(item.x + mugDx(false), item.y - MUG_H);
              Object.assign(m, mugDepth(item.x, item.y, plan.sorted));
            }
            parked.add(item.owner);
          }
        }
        for (const [id, c] of cups) if (!holding.has(id)) { c.sprite.destroy(); cups.delete(id); }
        for (const [id, m] of mugs) if (!parked.has(id)) { m.sprite.destroy(); mugs.delete(id); }
        // Keep these live even when the people/station depth is unchanged and the map is cached.
        bubbles.update(dt, anchors, world.scale.x);
        if (cached) {
          const r = app.renderer.resolution;
          const k = cacheKeyOf({ w: plan.below.width, h: plan.below.height }, staticBox, world.scale.x, world.scale.y, world.x, world.y, r);
          const view = `${app.canvas.width}x${app.canvas.height}@${r}:`;
          // Once the GPU's float32 input holds, even an edge on a tie rounds as it did: cache it all.
          const exact = k.exact === null ? null : view + k.exact;
          const settled = exact !== null && exact === lastExact;
          lastExact = exact;
          const key = settled ? exact! : view + k.key, live = settled ? noLive : k.live;
          // Cache a picture once it has held for a tick; draw directly while it changes.
          if (key !== cacheKey && key === lastKey) { refreshCache(live); cacheKey = key; }
          lastKey = key;
          const useCache = key === cacheKey && world.scale.x * r >= NEAR_MIN_SCALE && world.scale.y * r >= NEAR_MIN_SCALE;
          cacheLayer.visible = useCache;
          belowDirect.visible = !useCache;
          // The main pass: the cache, and over it only the live statics (and those over them); the
          // people and the statics near them are drawn in their rects (postrender). The parked mugs stay
          // in the main pass, so the statics in front of one are redrawn over it.
          mainFront = useCache ? pickFront!([...mugs.values()].map((m) => ({ x: m.sprite.x, y: m.sprite.y, w: MUG_W, h: MUG_H })), live) : null;
          statics.forEach((s, i) => { if (s) s.visible = mainFront ? mainFront[i] : true; });
          for (const s of sprites.values()) s.sprite.visible = !useCache;
          for (const c of cups.values()) c.sprite.visible = !useCache; // drawn with their person, in the rects
          passes = [];
          if (useCache) {
            const kx = world.scale.x, ky = world.scale.y, W = app.canvas.width, H = app.canvas.height;
            passOn = statics.map(() => false);
            for (const s of sprites.values()) {
              const X0 = Math.max(0, Math.floor((s.sprite.x * kx + world.x) * r) - 1), X1 = Math.min(W, Math.ceil(((s.sprite.x + fw) * kx + world.x) * r) + 1);
              const Y0 = Math.max(0, Math.floor((s.sprite.y * ky + world.y) * r) - 1), Y1 = Math.min(H, Math.ceil(((s.sprite.y + fh) * ky + world.y) * r) + 1);
              if (X1 <= X0 || Y1 <= Y0) continue;
              const rect = { x: X0, y: Y0, w: X1 - X0, h: Y1 - Y0 };
              passes.push(rect);
              pickRegion!({ x: (rect.x / r - world.x) / kx, y: (rect.y / r - world.y) / ky, w: rect.w / r / kx, h: rect.h / r / ky }).forEach((on, i) => { if (on) passOn[i] = true; });
            }
          }
        }
        // The statics never move: the depth order changes only when a person's key (or the crew) does.
        const depth = people.map((q) => `${q.id}:${q.foot}:${q.rank}:${cups.get(q.id)?.back ?? '-'}`).join('|') + '#' + [...mugs].map(([id, m]) => `${id}:${m.foot}:${m.rank}`).join('|');
        if (depth === lastDepth) return;
        lastDepth = depth;
        const items: Array<{ foot: number; rank: number; sprite: Sprite | null; id?: string }> = plan.sorted.map((it, i) => ({ foot: it.foot, rank: it.rank, sprite: statics[i] }));
        for (const q of people) items.push(q);
        for (const m of mugs.values()) items.push(m);
        items.sort(byDepth);
        items.forEach((it, i) => {
          if (!it.sprite) return;
          it.sprite.zIndex = i;
          // A mug in the hand: just in front of its person, or just behind when they face away.
          const c = it.id !== undefined ? cups.get(it.id) : undefined;
          if (c) c.sprite.zIndex = i + (c.back ? -0.5 : 0.5);
        });
      };
      app.ticker.add(onTick);
      // LAG-150, as OfficeFloor: rAF runs at the display rate (165 fps measured); the floor needs 30.
      applyFloorFrameBudget(app.ticker);
      if (pausedRef.current) app.ticker.stop();

      let lastSelected: string | null = useStore.getState().selectedId;
      (app as any).__unsub = useStore.subscribe((s, prev) => {
        if (s.agents !== prev.agents || s.liveness !== prev.liveness || s.heavyLock !== prev.heavyLock) sync();
        if (s.selectedId !== lastSelected) {
          lastSelected = s.selectedId;
          const p = s.selectedId ? crew.get(s.selectedId) : undefined;
          if (p) camera.nudgeToward(p.x, p.y);
        }
      });
      (app as any).__disposeHiveBubbles = bindHiveBubbles(app, bubbles);
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
      // TES-WALL-RESIZE-LINES-187: the camera snaps to the renderer's device-pixel grid, so the
      // renderer follows a DPR change after mount (UI zoom, a monitor move), then the camera.
      (app as any).__dpr = watchDevicePixelRatio(window, (dpr) => {
        if (!app.renderer) return;
        app.renderer.resolution = dpr;
        const width = host.clientWidth, height = host.clientHeight;
        if (width === 0 || height === 0) return;
        app.renderer.resize(width, height);
        camera.setViewSize(width, height);
      });
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
        try { (a as any).__dpr?.(); } catch { /* noop */ }
        try { (a as any).__unsub?.(); } catch { /* noop */ }
        try { (a as any).__disposeHiveBubbles?.(); } catch { /* noop */ }
        teardownFloor(a, (a as any).__free ?? []);
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
