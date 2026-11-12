/**
 * BLOB-TRAY-TOASTS / BLOB-ORCH-MOOD image form: every Blob face rendered once to PNG.
 *
 * blobatar draws SVG and Electron's nativeImage cannot decode SVG, so the faces are rasterised in
 * one short-lived hidden window: sandboxed, no preload, its own in-memory session with every
 * request but data:/about: cancelled, destroyed in `finally`. It runs once, lazily after startup
 * (index.ts), so startup does no blob work. Until it succeeds (or if it fails) the tray keeps the
 * exe icon and toasts carry no image: a render failure is logged, never thrown.
 */
import { BLOB_FACES, BLOB_IDENTITY, BLOB_SAVE_SIZE, BLOB_TOAST_SIZE, BLOB_TRAY_SIZES, type BlobFace } from '../shared/blobFace';

export const BLOB_RENDER_SIZES: readonly number[] = [...BLOB_TRAY_SIZES, BLOB_TOAST_SIZE, BLOB_SAVE_SIZE];

export interface FaceRenderWindow {
  loadURL(url: string): Promise<unknown>;
  executeJavaScript(code: string): Promise<unknown>;
  destroy(): void;
  isDestroyed(): boolean;
}

export interface BlobFaceRendererDeps {
  /** An SVG data: URI of `face` at `size` px (blobatarSvg in production). */
  svgFor(face: BlobFace, size: number): Promise<string>;
  /** The hidden, sandboxed, network-less render window. */
  createWindow(): FaceRenderWindow;
  log?(row: Record<string, unknown>): void;
}

/** The SVG for one face, from blobatar (ESM: loaded on first use, never at startup). */
export async function blobatarSvg(face: BlobFace, size: number): Promise<string> {
  const [{ blobatarUri }, expressions] = await Promise.all([import('blobatar/uri'), import('blobatar/expression')]);
  const expression = (expressions as unknown as Record<string, unknown>)[face];
  if (!expression) throw new Error(`blobatar has no expression '${face}'`);
  return blobatarUri(BLOB_IDENTITY.name, {
    size,
    background: false,
    palette: { ...BLOB_IDENTITY.palette },
    traits: { ...BLOB_IDENTITY.traits },
    expression: expression as never,
  });
}

/** The page-side rasteriser: each [key, svgUri, size] drawn on a square canvas, returned as PNG data URLs. */
export function rasterScript(jobs: Array<[string, string, number]>): string {
  return `(async (jobs) => {
  const out = {};
  for (const [key, uri, size] of jobs) {
    const img = new Image();
    img.src = uri;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    c.getContext('2d').drawImage(img, 0, 0, size, size);
    out[key] = c.toDataURL('image/png');
  }
  return out;
})(${JSON.stringify(jobs)})`;
}

const keyOf = (face: BlobFace, size: number): string => `${face}@${size}`;

export class BlobFaceRenderer {
  private pngs: Map<string, string> | null = null;
  private running: Promise<boolean> | null = null;
  /** Tests: how many render windows were created and how many are still open. */
  readonly stats = { windows: 0, open: 0 };

  constructor(private readonly d: BlobFaceRendererDeps) {}

  ready(): boolean { return this.pngs !== null; }

  /** A face's PNG as a data URL, or null before the render succeeded. */
  png(face: BlobFace, size: number): string | null { return this.pngs?.get(keyOf(face, size)) ?? null; }

  /** Render every face at every size once. A failure resolves false (and may be retried). */
  render(): Promise<boolean> {
    if (this.pngs) return Promise.resolve(true);
    if (!this.running) this.running = this.run().finally(() => { this.running = null; });
    return this.running;
  }

  private async run(): Promise<boolean> {
    const started = Date.now();
    let win: FaceRenderWindow | null = null;
    try {
      const jobs: Array<[string, string, number]> = [];
      for (const face of BLOB_FACES) for (const size of BLOB_RENDER_SIZES) jobs.push([keyOf(face, size), await this.d.svgFor(face, size), size]);
      win = this.d.createWindow();
      this.stats.windows += 1; this.stats.open += 1;
      await win.loadURL('about:blank');
      const out = await win.executeJavaScript(rasterScript(jobs));
      const map = new Map<string, string>();
      for (const [key] of jobs) {
        const v = (out as Record<string, unknown> | null)?.[key];
        if (typeof v !== 'string' || !v.startsWith('data:image/png;base64,')) throw new Error(`no PNG for ${key}`);
        map.set(key, v);
      }
      this.pngs = map;
      this.d.log?.({ kind: 'blob-faces-rendered', faces: BLOB_FACES.length, sizes: BLOB_RENDER_SIZES.length, ms: Date.now() - started });
      return true;
    } catch (e) {
      this.d.log?.({ kind: 'blob-faces-render-failed', error: e instanceof Error ? e.message : String(e), ms: Date.now() - started });
      return false;
    } finally {
      if (win) {
        try { if (!win.isDestroyed()) win.destroy(); } catch { /* already gone */ }
        this.stats.open -= 1;
      }
    }
  }
}
