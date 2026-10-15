import { Container } from 'pixi.js';
import { wholeScale } from '../themes/framing';

// Simplified port of shahar061/the-office (office/engine/camera.ts).
// Phase targeting is dropped (we have no project phases); kept: fit-to-screen,
// map-edge clamping, smooth lerp, a manual focus(), and nudgeToward() used to
// pan toward the selected agent.
//
// TES-GUPPY-FRAMING: an optional frame (setFrame) replaces the whole map as what is fitted,
// centred and clamped to, and its dead bottom rows are left out of the fit. With no frame the
// frame IS the map with no dead band, so the office's numbers are exactly as before.
//
// TES-FLOOR-WHOLE-188: a frame with a keep box (and a settle) is drawn at a whole number n of
// device px per map px, the largest at which the keep box fits the pane: the zoom is n / DPR, set
// at once and never eased, and the map's origin always sits on a whole device px. So every art
// pixel is n x n device px on every frame. The frame's top meets the pane's top when its content
// fits (the hull runs on past the bottom edge); else the view is centred or clamped as before.
// The keep box always stays in view: only the hull, its rim and the upper wall are ever cut.

const LERP_SPEED = 0.08;
// TES-GUPPY-SETTLE: the rate LERP_SPEED was tuned at (the floor's 30 fps tick).
const EASE_HZ = 30;

/** TES-GUPPY-SETTLE: ease by elapsed time, not by tick, and land on the target once what is
 *  left would move the picture by under half a device pixel. `resolution` is device px per
 *  CSS px. Without it (the office) the camera eases per tick exactly as before. */
export interface CameraSettle {
  resolution: () => number;
}

/** TES-WALL-RESIZE-LINES-187: call `onChange(dpr)` each time the window's device pixel ratio
 *  changes after mount (UI zoom with Ctrl+= / Ctrl+-, or a move to a monitor with another scale),
 *  so a whole-device-pixel camera can follow it. A `(resolution: <dpr>dppx)` query matches only
 *  the ratio it was made for, so it is re-armed for each new one. Returns the cleanup. */
export function watchDevicePixelRatio(
  win: Pick<Window, 'matchMedia' | 'devicePixelRatio'>,
  onChange: (dpr: number) => void,
): () => void {
  let mq: MediaQueryList | null = null;
  const fire = (): void => {
    mq?.removeEventListener('change', fire);
    arm();
    onChange(win.devicePixelRatio || 1);
  };
  const arm = (): void => {
    mq = win.matchMedia(`(resolution: ${win.devicePixelRatio || 1}dppx)`);
    mq.addEventListener('change', fire);
  };
  arm();
  return () => {
    mq?.removeEventListener('change', fire);
    mq = null;
  };
}

type Keep = { x0: number; y0: number; x1: number; y1: number };

export class Camera {
  private container: Container;
  private currentX = 0;
  private currentY = 0;
  private currentZoom = 1;
  private targetX = 0;
  private targetY = 0;
  private targetZoom = 1;
  private viewWidth = 960;
  private viewHeight = 800;
  private mapWidth = 640;
  private mapHeight = 480;
  private manualOverride = false;
  /** The fitted rectangle, in map pixels (null: the whole map), and its clippable bottom rows. */
  private frame: { x: number; y: number; w: number; h: number; deadBottom: number; keep?: Keep } | null = null;

  private nudgeOffsetX = 0;
  private nudgeOffsetY = 0;
  private nudgeElapsed = 0;
  private nudgeDuration = 0;
  private readonly nudgeStrength = 0.4;

  private readonly settle: CameraSettle | null;

  constructor(container: Container, settle: CameraSettle | null = null) {
    this.container = container;
    this.settle = settle;
  }

  setMapSize(width: number, height: number): void {
    this.mapWidth = width;
    this.mapHeight = height;
  }

  /** Fit a part of the map instead of all of it (see TES-GUPPY-FRAMING above); null for the whole map. */
  setFrame(frame: { x: number; y: number; w: number; h: number; deadBottom: number; keep?: Keep } | null): void {
    this.frame = frame;
    if (!this.manualOverride) this.fitToScreen();
  }

  private box(): { x: number; y: number; w: number; h: number; deadBottom: number } {
    return this.frame ?? { x: 0, y: 0, w: this.mapWidth, h: this.mapHeight, deadBottom: 0 };
  }

  setViewSize(width: number, height: number): void {
    this.viewWidth = width;
    this.viewHeight = height;
    if (!this.manualOverride) this.fitToScreen();
  }

  /** TES-FLOOR-WHOLE-188: the whole device scale n and the resolution, or null when not whole. */
  private whole(): { n: number; r: number; keep: Keep } | null {
    const keep = this.frame?.keep, r = this.settle?.resolution() ?? 0;
    if (!keep || !Number.isFinite(r) || r <= 0) return null;
    return { n: wholeScale(keep, Math.round(this.viewWidth * r), Math.round(this.viewHeight * r)), r, keep };
  }

  private getMinZoom(): number {
    if (this.viewWidth === 0 || this.viewHeight === 0) return 1;
    const w = this.whole();
    if (w) return w.n / w.r;
    const b = this.box();
    const minZoom = Math.min(this.viewWidth / b.w, this.viewHeight / (b.h - b.deadBottom));
    // Keep the camera's fit exact.  Raster alignment belongs to StationFloor's single cached
    // composite, not the camera: flooring here leaves a large, visible margin at DPR 1.
    const resolution = this.settle?.resolution() ?? 0;
    if (!Number.isFinite(resolution) || resolution <= 0) return minZoom;
    return Math.max(1 / resolution, minZoom);
  }

  /** Fit the whole map (or the frame, its content centred) to the viewport. */
  fitToScreen(): void {
    this.manualOverride = false;
    const b = this.box();
    this.targetX = b.x + b.w / 2;
    this.targetY = b.y + (b.h - b.deadBottom) / 2;
    this.targetZoom = this.getMinZoom();
  }

  /** Pan/zoom toward a world point (used when an agent is selected). */
  focusOn(worldX: number, worldY: number, zoom?: number): void {
    this.manualOverride = true;
    this.targetX = worldX;
    this.targetY = worldY;
    this.targetZoom = Math.max(this.getMinZoom(), Math.min(4, zoom ?? this.currentZoom));
  }

  /** A gentle, decaying pan toward a world point without taking manual control. */
  nudgeToward(worldX: number, worldY: number, duration = 1200): void {
    if (this.manualOverride) return;
    this.nudgeOffsetX = (worldX - this.targetX) * this.nudgeStrength;
    this.nudgeOffsetY = (worldY - this.targetY) * this.nudgeStrength;
    this.nudgeElapsed = 0;
    this.nudgeDuration = duration / 1000;
  }

  update(dt: number): void {
    if (this.settle) {
      this.settleStep(dt);
    } else {
      this.currentX += (this.targetX - this.currentX) * LERP_SPEED;
      this.currentY += (this.targetY - this.currentY) * LERP_SPEED;
      this.currentZoom += (this.targetZoom - this.currentZoom) * LERP_SPEED;

      if (this.nudgeDuration > 0) {
        this.nudgeElapsed += dt;
        const t = Math.min(this.nudgeElapsed / this.nudgeDuration, 1);
        const ease = 1 - t;
        this.currentX += this.nudgeOffsetX * ease;
        this.currentY += this.nudgeOffsetY * ease;
        if (t >= 1) {
          this.nudgeDuration = 0;
          this.nudgeOffsetX = 0;
          this.nudgeOffsetY = 0;
        }
      }
    }

    const w = this.whole();
    if (w) { this.placeWhole(w.n, w.r, w.keep); return; }

    this.container.scale.set(this.currentZoom);
    this.container.x = this.viewWidth / 2 - this.currentX * this.currentZoom;
    this.container.y = this.viewHeight / 2 - this.currentY * this.currentZoom;

    // Centre the frame's content when it fits (the dead band hangs below it); else keep the view
    // inside the frame. With no frame, b is the map at 0,0 with no dead band.
    const b = this.box();
    const z = this.currentZoom, left = -b.x * z || 0, top = -b.y * z || 0;
    const scaledW = b.w * z;
    const scaledH = b.h * z;
    const contentH = (b.h - b.deadBottom) * z;
    if (scaledW <= this.viewWidth) {
      this.container.x = left + (this.viewWidth - scaledW) / 2;
    } else {
      this.container.x = Math.min(left, Math.max(left + this.viewWidth - scaledW, this.container.x));
    }
    if (contentH <= this.viewHeight) {
      // The frame's dead-bottom rows are a hull below the playable deck. When whole-pixel
      // scaling leaves vertical space, put it above the deck: centring would reveal background
      // below the hull, whereas this leaves the hull continuing past the panel's bottom edge.
      this.container.y = this.settle && b.deadBottom > 0
        ? top + this.viewHeight - contentH
        : top + (this.viewHeight - contentH) / 2;
    } else {
      this.container.y = Math.min(top, Math.max(top + this.viewHeight - scaledH, this.container.y));
    }

  }

  /** TES-FLOOR-WHOLE-188: place the map at n device px per map px, on whole device px. Each axis
   *  works as update() does (centred when the frame fits, else the eased point clamped inside the
   *  frame; vertically the frame's top at the pane's top when its content fits), then the keep
   *  box is clamped into the pane (centred on it if it cannot fit, at n = 1). */
  private placeWhole(n: number, r: number, keep: Keep): void {
    this.currentZoom = this.targetZoom = n / r;
    const b = this.box();
    const W = Math.round(this.viewWidth * r), H = Math.round(this.viewHeight * r);
    const fit = (o: number, lo: number, hi: number) => (lo <= hi ? Math.min(hi, Math.max(lo, o)) : (lo + hi) / 2);
    let x = b.w * n <= W
      ? (W - b.w * n) / 2 - b.x * n
      : fit(W / 2 - this.currentX * n, W - (b.x + b.w) * n, -b.x * n);
    let y = (b.h - b.deadBottom) * n <= H
      ? -b.y * n
      : fit(H / 2 - this.currentY * n, H - (b.y + b.h) * n, -b.y * n);
    x = Math.round(fit(x, -keep.x0 * n, W - (keep.x1 + 1) * n));
    y = Math.round(fit(y, -keep.y0 * n, H - (keep.y1 + 1) * n));
    this.container.scale.set(n / r);
    this.container.x = x / r;
    this.container.y = y / r;
  }

  /** TES-GUPPY-SETTLE: the per-tick ease as the motion it approximates, solved exactly over dt.
   *  Between ticks the office pulls by LERP_SPEED toward the target (a decay at rate lam per
   *  second) and adds the nudge times (1 - t) (a push of EASE_HZ * offset * (1 - t) per second);
   *  per axis u' = -lam * u + a + b * s over the step, u = current - target. Then it lands on the
   *  target once what is left would move any point of the frame by under half a device pixel. */
  private settleStep(dt: number): void {
    // A bad clock (negative, NaN or infinite) must not throw the camera off: it stands still.
    if (!Number.isFinite(dt) || dt < 0) dt = 0;
    const lam = -EASE_HZ * Math.log(1 - LERP_SPEED);
    this.currentZoom = this.targetZoom + (this.currentZoom - this.targetZoom) * Math.exp(-lam * dt);
    let ux = this.currentX - this.targetX, uy = this.currentY - this.targetY;
    let rest = dt;
    if (this.nudgeDuration > 0) {
      const D = this.nudgeDuration, h = Math.min(rest, Math.max(0, D - this.nudgeElapsed));
      const e = Math.exp(-lam * h), E1 = (1 - e) / lam, Es = (h - E1) / lam;
      const t0 = this.nudgeElapsed / D;
      const push = (o: number) => EASE_HZ * o * ((1 - t0) * E1 - Es / D);
      ux = ux * e + push(this.nudgeOffsetX);
      uy = uy * e + push(this.nudgeOffsetY);
      this.nudgeElapsed += h;
      rest -= h;
      if (this.nudgeElapsed >= D) {
        this.nudgeDuration = 0;
        this.nudgeOffsetX = 0;
        this.nudgeOffsetY = 0;
      }
    }
    const e = Math.exp(-lam * rest);
    this.currentX = this.targetX + ux * e;
    this.currentY = this.targetY + uy * e;

    if (this.nudgeDuration > 0 || !this.settle) return;
    // A map point m of the frame sits at view/2 + (m - current) * zoom, or (centred or clamped in
    // update) at (m - b.x) * zoom plus a zoom-free or half-frame term: what is left moves any of
    // them by at most this.
    const b = this.box(), z = Math.max(this.currentZoom, this.targetZoom);
    const left = (Math.abs(this.targetX - this.currentX) + Math.abs(this.targetY - this.currentY)) * z
      + Math.abs(this.targetZoom - this.currentZoom) * (Math.abs(b.x) + b.w + Math.abs(b.y) + b.h + Math.abs(this.currentX) + Math.abs(this.currentY));
    if (left * this.settle.resolution() < 0.5) {
      this.currentX = this.targetX;
      this.currentY = this.targetY;
      this.currentZoom = this.targetZoom;
    }
  }
}
