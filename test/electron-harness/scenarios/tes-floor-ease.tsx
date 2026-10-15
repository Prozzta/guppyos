/**
 * SCENARIO - TES-FLOOR-EASE-188, RENDERED: the real OfficeFloor draws the bundled tes pack with a
 * crew, on a synthetic clock (as floor-tes-shot.tsx), and the host box is resized twice so the
 * camera eases for a few hundred frames. Every CHECK_EVERY renders, after the frame is drawn:
 * - the scene RT holds exactly what a full depth sort draws at the same integer scale: 'below',
 *   then the people and EVERY static sorted together, then 'above' (diff 0);
 * - a reference with the people drawn over every static differs from it (the check has teeth:
 *   someone really stands behind a chair or console);
 * - on screen the people add nothing (the stage drawn without sortLayer is the same picture), so
 *   the scene quad is all there is, and that quad covers the scene bounds through the world;
 * - k is sceneScale of the device scale, the RT is bounds x k texels, and the floor RT was built
 *   once per change of k.
 * At ABOVE_AT a square is put in 'above' over a person: from then on the scene shows it over them.
 * Run by test/tes-floor-ease-188.test.cjs (HARNESS_DPR per case).
 */
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { Application, Matrix, RenderTexture, Sprite, Texture } from 'pixi.js';
import { OfficeFloor } from '../../../src/renderer/src/scene/office/OfficeFloor';
import { useStore } from '../../../src/renderer/src/store/store';
import { loadStationPack } from '../../../src/renderer/src/scene/themes/themeCatalog';
import { sceneScale } from '../../../src/renderer/src/scene/themes/staticCache';

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

const STEP_MS = 1000 / 60;
const RESIZES = [{ at: 160, w: 960, h: 640 }, { at: 320, w: 700, h: 470 }];
const FIRST_CHECK = 150, LAST = 720, CHECK_EVERY = 5, ABOVE_AT = 680;

let seed = 12345;
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

const pixelsOf = (app: any, rt: RenderTexture) => app.renderer.extract.pixels({ target: rt }).pixels as Uint8ClampedArray;
const diff = (a: Uint8ClampedArray, b: Uint8ClampedArray) => {
  if (a.length !== b.length) return -1;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) n++;
  return n;
};

/** The scene drawn directly at scale k: 'below', the sort layer, 'above'. With crewTop, every
 *  static first and the people after them all. The matrix is made here, not read from the floor. */
function reference(app: any, S: any, crewTop: boolean): Uint8ClampedArray {
  const k = S.k, b = S.bounds, r = app.renderer;
  const M = new Matrix(k, 0, 0, k, -b.x * k, -b.y * k);
  const rt = RenderTexture.create({ width: b.w * k, height: b.h * k, resolution: 1, scaleMode: 'nearest' });
  const bl = new Sprite(S.below);
  r.render({ container: bl, target: rt, clear: true, transform: M });
  const statics = new Set(S.statics.filter(Boolean));
  const kids: any[] = S.sortLayer.children;
  const was = kids.map((c) => c.visible), alpha = S.sortLayer.alpha;
  S.sortLayer.alpha = 1;
  if (!crewTop) {
    for (const c of kids) if (statics.has(c)) c.visible = true;
    r.render({ container: S.sortLayer, target: rt, clear: false, transform: M });
  } else {
    for (const c of kids) c.visible = statics.has(c);
    r.render({ container: S.sortLayer, target: rt, clear: false, transform: M });
    kids.forEach((c, i) => { c.visible = !statics.has(c) && was[i]; });
    r.render({ container: S.sortLayer, target: rt, clear: false, transform: M });
  }
  kids.forEach((c, i) => { c.visible = was[i]; });
  S.sortLayer.alpha = alpha;
  if (S.aboveRoot.children.length) r.render({ container: S.aboveRoot, target: rt, clear: false, transform: M });
  const px = pixelsOf(app, rt);
  bl.destroy(); rt.destroy(true);
  return px;
}

/** The stage as drawn, and the stage drawn with the sort layer left out. */
function screenDiff(app: any, S: any): number {
  const r = app.renderer;
  const rt = RenderTexture.create({ width: app.screen.width, height: app.screen.height, resolution: r.resolution, scaleMode: 'nearest' });
  r.render({ container: app.stage, target: rt, clear: true });
  const a = pixelsOf(app, rt);
  S.sortLayer.visible = false;
  r.render({ container: app.stage, target: rt, clear: true });
  S.sortLayer.visible = true;
  const b = pixelsOf(app, rt);
  rt.destroy(true);
  return diff(a, b);
}

const out = {
  checks: 0, easingChecks: 0, sceneDiffMax: 0, teethLast: 0, teethMin: Infinity, screenDiffMax: 0,
  quadErrMax: 0, kBad: 0, rtBad: 0, kSeen: [] as number[], builds: 0, aboveChecks: 0, aboveBad: 0,
  alphaBad: 0, sceneFirst: true, rebuilds: 0, leaked: 0, errors: [] as string[]
};
let renders = 0;
let done: (() => void) | null = null;
let hostBox: HTMLDivElement | null = null;
let lastScale = NaN;
let lastRts: any[] = [];
let aboveBox: { x: number; y: number; w: number; h: number } | null = null;
const proto = Application.prototype as unknown as { render: () => void };
const realRender = proto.render;
proto.render = function (this: any) {
  realRender.call(this);
  renders += 1;
  const app = this, S = app.__tesScene;
  try {
    if (S && S.rt) {
      const k = S.k;
      if (out.kSeen[out.kSeen.length - 1] !== k) out.kSeen.push(k);
      out.builds = app.__tesStaticCacheBuilds ?? 0;
      // A rebuild frees the RTs it replaces.
      if (lastRts.length && (lastRts[0] !== S.rt || lastRts[1] !== S.floor)) { out.rebuilds++; if (!lastRts.every((t) => t.destroyed)) out.leaked++; }
      lastRts = [S.rt, S.floor];
      if (S.sortLayer.alpha !== 0) out.alphaBad++;
      const kids: any[] = S.world.children;
      if (!(kids.indexOf(S.sceneSprite) >= 0 && kids.indexOf(S.sceneSprite) < kids.indexOf(S.sortLayer))) out.sceneFirst = false;
      const easing = S.world.scale.x !== lastScale;
      lastScale = S.world.scale.x;
      if (renders >= FIRST_CHECK && renders % CHECK_EVERY === 0) {
        out.checks++;
        if (easing) out.easingChecks++;
        if (k !== sceneScale(S.world.scale.x * app.renderer.resolution, S.bounds)) out.kBad++;
        if (S.rt.width !== S.bounds.w * k || S.rt.height !== S.bounds.h * k || S.sceneSprite.texture !== S.rt) out.rtBad++;
        // The quad covers the scene bounds through the world's transform.
        const g = S.sceneSprite.getBounds(), p0 = S.world.toGlobal({ x: S.bounds.x, y: S.bounds.y }), p1 = S.world.toGlobal({ x: S.bounds.x + S.bounds.w, y: S.bounds.y + S.bounds.h });
        out.quadErrMax = Math.max(out.quadErrMax, Math.abs(g.x - p0.x), Math.abs(g.y - p0.y), Math.abs(g.x + g.width - p1.x), Math.abs(g.y + g.height - p1.y));
        const scene = pixelsOf(app, S.rt);
        const d = diff(scene, reference(app, S, false));
        out.sceneDiffMax = d < 0 ? Infinity : Math.max(out.sceneDiffMax, d);
        const t = diff(scene, reference(app, S, true));
        out.teethLast = t; out.teethMin = Math.min(out.teethMin, t);
        out.screenDiffMax = Math.max(out.screenDiffMax, screenDiff(app, S));
        if (aboveBox) {
          // The square's centre texel: magenta in the scene, not in a draw with the people after 'above'.
          out.aboveChecks++;
          const W = S.bounds.w * k, cx = Math.floor((aboveBox.x + aboveBox.w / 2 - S.bounds.x) * k), cy = Math.floor((aboveBox.y + aboveBox.h / 2 - S.bounds.y) * k);
          const i = (cy * W + cx) * 4;
          if (!(scene[i] === 255 && scene[i + 1] === 0 && scene[i + 2] === 255 && scene[i + 3] === 255)) out.aboveBad++;
        }
      }
      if (renders === ABOVE_AT) {
        const statics = new Set(S.statics.filter(Boolean));
        const person = S.sortLayer.children.find((c: any) => !statics.has(c) && c.visible && c.width > 4);
        if (!person) out.errors.push('no person for the above check');
        else {
          const lb = person.getLocalBounds();
          aboveBox = { x: person.x + lb.x, y: person.y + lb.y, w: lb.width, h: lb.height };
          const sq = new Sprite(Texture.WHITE);
          sq.tint = 0xff00ff;
          sq.position.set(aboveBox.x, aboveBox.y);
          sq.width = aboveBox.w; sq.height = aboveBox.h;
          S.aboveRoot.addChild(sq);
        }
      }
    }
  } catch (e) { out.errors.push(e instanceof Error ? e.message : String(e)); }
  const rz = RESIZES.find((q) => q.at === renders);
  if (rz && hostBox) { hostBox.style.width = rz.w + 'px'; hostBox.style.height = rz.h + 'px'; }
  if (renders >= LAST && done) { done(); done = null; }
};

const agents = [
  { id: 'god', name: 'Michael', character: 'michael', accent: 'gold', isGod: true, status: 'working' },
  { id: 'dwight', name: 'Dwight', character: 'dwight', accent: 'mint', status: 'working' },
  { id: 'jim', name: 'Jim', character: 'jim', accent: 'sky', status: 'idle' },
  { id: 'andy', name: 'Andy', character: 'andy', accent: 'coral', status: 'idle' },
  { id: 'pam', name: 'Pam', character: 'pam', accent: 'rose', status: 'working' }
].map((a) => ({ description: '', project: 'Harness', tmuxTarget: '', cwd: 'C:/harness-test-home', action: 'awaiting', progress: 0, provider: 'claude', command: 'claude', ptyId: `pty-${a.id}`, ...a }));

window.__harnessRun = async () => {
  try {
    const loaded = await loadStationPack('tes');
    if (!loaded.pack) throw new Error(`tes did not load: ${JSON.stringify(loaded.diagnostics)}`);
    const box = document.createElement('div');
    box.style.cssText = 'width:560px;height:555px;position:relative';
    document.body.appendChild(box);
    hostBox = box;
    const root = createRoot(box);
    const finished = new Promise<void>((r) => { done = r; });
    await act(async () => { useStore.setState({ officeTheme: 'tes', agents, messageQueues: {} } as never); root.render(<OfficeFloor />); });
    await finished;
    await act(async () => { root.unmount(); });
    window.harness.report({ ok: true, dpr: window.devicePixelRatio, renders, ...out });
  } catch (e) {
    window.harness.report({ ok: false, error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
  }
};
