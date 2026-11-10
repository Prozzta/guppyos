/**
 * GUPPY-BLOB-P01: main-process controller for the Guppy blob overlay.
 *
 * The overlay is a small frameless, transparent, always-on-top window that never takes focus
 * (focusable:false, shown with showInactive) so the app the user is typing in keeps the caret: the
 * later dictation phase depends on that. A click on the blob opens the radial ring; the window
 * grows around the blob's centre while the ring is open and shrinks back when it closes.
 *
 * INVISIBLE: setContentProtection(true) on the overlay (and, opt-in, on the app's own windows).
 * On Windows 10 2004+ Electron sets WDA_EXCLUDEFROMCAPTURE, so a capture or a screen share leaves
 * the window out instead of showing it.
 *
 * SENDER GATE: the overlay has its own narrow preload (src/preload/blob.ts) and its own IPC
 * channels (`blob:overlay:*`), accepted only from the overlay's top frame. The app's own channels
 * that act as the Human (messageBox:deliver, claims-ui:*) use isAppWindowSender, which REFUSES the
 * overlay even though it is a BrowserWindow (the GUPPY-STAPLER-HOOKS sender-gate caveat: index.ts
 * routes its app-window gate through isAppWindowSender).
 *
 * Electron is injected (deps), so this module loads and is tested without it.
 */
import {
  BLOB_COMING_SOON, BLOB_DISABLED, BLOB_SLOTS, blobSettingsFrom, sanitizeBlobPatch,
  type BlobActionResult, type BlobConfigFields, type BlobPosition, type BlobSettings, type BlobSlot, type BlobStatus,
} from '../shared/blob';

export interface Rect { x: number; y: number; width: number; height: number }

/** The webContents surface the gate needs. */
export interface WebContentsLike {
  mainFrame: unknown;
  send(channel: string, ...args: unknown[]): void;
  isDestroyed?(): boolean;
}

/** The IPC event surface the gate needs. */
export interface IpcEventLike { sender: WebContentsLike; senderFrame: unknown }

export interface BlobWindowLike {
  webContents: WebContentsLike;
  isDestroyed(): boolean;
  isVisible(): boolean;
  showInactive(): void;
  hide(): void;
  destroy(): void;
  setContentProtection(on: boolean): void;
  setBounds(r: Rect): void;
  on(event: 'closed', fn: () => void): void;
}

export interface ProtectableWindow { isDestroyed(): boolean; setContentProtection(on: boolean): void }

export interface BlobOverlayDeps {
  /** Builds the real overlay BrowserWindow (index.ts): frameless, transparent, focusable:false. */
  createWindow(bounds: Rect): BlobWindowLike;
  globalShortcut: { register(accelerator: string, fn: () => void): boolean; unregister(accelerator: string): void };
  readConfig(): BlobConfigFields;
  writeConfig(patch: BlobConfigFields): void;
  /** The app's own windows (main + floors), for the invisibleMain option. */
  appWindows(): Iterable<ProtectableWindow>;
  /** Work area of the display nearest the point (or the primary display). */
  workArea(point?: { x: number; y: number }): Rect;
  /** The cursor in screen coordinates (drag follows main's own reading, never renderer numbers). */
  cursor(): { x: number; y: number };
  /** A hidden (harness) run never shows an overlay and never takes a global hotkey. */
  hidden: boolean;
  log?(row: Record<string, unknown>): void;
}

/** The collapsed blob and the open ring, in DIPs. */
export const BLOB_SIZE = 96;
export const RING_SIZE = 340;
const MARGIN = 24;

/** A sender is the app's own window, never the blob overlay (and only its top frame). */
export function isAppWindowSender(
  evt: IpcEventLike,
  hasWindow: (wc: WebContentsLike) => boolean,
  overlay: WebContentsLike | null,
): boolean {
  if (!evt || !evt.sender) return false;
  if (overlay && evt.sender === overlay) return false;
  return hasWindow(evt.sender) && evt.senderFrame === evt.sender.mainFrame;
}

/** A sender is the live blob overlay's top frame. */
export function isOverlaySender(evt: IpcEventLike, overlay: WebContentsLike | null): boolean {
  return !!overlay && !!evt && evt.sender === overlay && evt.senderFrame === overlay.mainFrame;
}

export class BlobOverlayController {
  private win: BlobWindowLike | null = null;
  private settings: BlobSettings;
  private registered: string | null = null;
  private ringOpen = false;
  /** Collapsed top-left; follows drags. */
  private pos: BlobPosition | null = null;
  private drag: { startCursor: { x: number; y: number }; startPos: BlobPosition } | null = null;

  constructor(private readonly d: BlobOverlayDeps) {
    this.settings = blobSettingsFrom(d.readConfig());
  }

  /** The overlay's webContents, for the sender gates (null when there is no overlay). */
  overlayContents(): WebContentsLike | null {
    return this.win && !this.win.isDestroyed() ? this.win.webContents : null;
  }

  status(): BlobStatus {
    return {
      ...this.settings,
      position: this.pos ?? this.settings.position,
      hotkeyRegistered: this.registered !== null,
      visible: !!this.win && !this.win.isDestroyed() && this.win.isVisible(),
    };
  }

  /** (Re)read the config and make the overlay, hotkey and protection match it. */
  apply(): BlobStatus {
    this.settings = blobSettingsFrom(this.d.readConfig());
    const s = this.settings;
    const on = s.enabled && !this.d.hidden;
    for (const w of this.d.appWindows()) this.protect(w, s.invisibleMain);
    if (!on) {
      this.unregisterHotkey();
      this.destroyWindow();
      return this.status();
    }
    if (!this.win || this.win.isDestroyed()) this.createWindow();
    if (this.win) this.protect(this.win, s.invisible);
    if (this.registered !== s.hotkey) {
      this.unregisterHotkey();
      if (s.hotkey) {
        let ok = false;
        try { ok = this.d.globalShortcut.register(s.hotkey, () => this.toggleVisible()); } catch { ok = false; }
        if (ok) this.registered = s.hotkey;
        else this.d.log?.({ kind: 'blob-hotkey-unavailable', hotkey: s.hotkey });
      }
    }
    this.push();
    return this.status();
  }

  /** A Settings patch (already from an app window). */
  setConfig(patch: unknown): { ok: true; status: BlobStatus } | { ok: false; error: string } {
    const r = sanitizeBlobPatch(patch);
    if (!r.ok) return r;
    if (Object.keys(r.fields).length > 0) this.d.writeConfig(r.fields);
    return { ok: true, status: this.apply() };
  }

  /** New app windows get the current invisibleMain setting. */
  protectAppWindow(w: ProtectableWindow): void {
    this.protect(w, this.settings.invisibleMain);
  }

  toggleVisible(): void {
    if (!this.win || this.win.isDestroyed()) return;
    if (this.win.isVisible()) { this.setRing(false); this.win.hide(); } else this.win.showInactive();
    this.push();
  }

  action(slot: unknown): BlobActionResult {
    if (typeof slot !== 'string' || !(BLOB_SLOTS as readonly string[]).includes(slot)) return { ok: false, error: 'unknown slot' };
    const s = slot as BlobSlot;
    if (BLOB_DISABLED.includes(s)) return { ok: true, slot: s, state: 'disabled' };
    if (BLOB_COMING_SOON.includes(s)) return { ok: true, slot: s, state: 'coming-soon' };
    if (s === 'invisible') {
      this.d.writeConfig({ blobInvisible: !this.settings.invisible });
      this.settings = blobSettingsFrom(this.d.readConfig());
      if (this.win && !this.win.isDestroyed()) this.protect(this.win, this.settings.invisible);
      this.d.log?.({ kind: 'blob-invisible', on: this.settings.invisible });
    } else if (s === 'close') {
      this.setRing(false);
    }
    this.push();
    return { ok: true, slot: s, state: 'done', status: this.status() };
  }

  setRing(open: unknown): BlobStatus {
    const want = open === true;
    if (want !== this.ringOpen) {
      this.ringOpen = want;
      this.place();
    }
    return this.status();
  }

  dragStart(): void {
    this.drag = { startCursor: this.d.cursor(), startPos: this.currentPos() };
  }

  dragMove(): void {
    if (!this.drag) return;
    const c = this.d.cursor();
    this.pos = { x: this.drag.startPos.x + c.x - this.drag.startCursor.x, y: this.drag.startPos.y + c.y - this.drag.startCursor.y };
    this.place();
  }

  /** Ends a drag and persists where the blob was left. */
  dragEnd(): void {
    if (!this.drag) return;
    this.drag = null;
    const p = this.currentPos();
    this.d.writeConfig({ blobPosition: p });
    this.settings = { ...this.settings, position: p };
  }

  dispose(): void {
    this.unregisterHotkey();
    this.destroyWindow();
  }

  // ---------------------------------------------------------------- internals

  private protect(w: ProtectableWindow, on: boolean): void {
    try { if (!w.isDestroyed()) w.setContentProtection(on); } catch { /* a closing window */ }
  }

  private currentPos(): BlobPosition {
    if (this.pos) return this.pos;
    if (this.settings.position) return this.settings.position;
    const wa = this.d.workArea();
    return { x: wa.x + wa.width - BLOB_SIZE - MARGIN, y: wa.y + wa.height - BLOB_SIZE - MARGIN };
  }

  private bounds(): Rect {
    const p = this.currentPos();
    if (!this.ringOpen) return { x: p.x, y: p.y, width: BLOB_SIZE, height: BLOB_SIZE };
    const off = Math.round((RING_SIZE - BLOB_SIZE) / 2);
    return { x: p.x - off, y: p.y - off, width: RING_SIZE, height: RING_SIZE };
  }

  private place(): void {
    if (this.win && !this.win.isDestroyed()) this.win.setBounds(this.bounds());
  }

  private createWindow(): void {
    this.pos = this.currentPos();
    this.ringOpen = false;
    const w = this.d.createWindow(this.bounds());
    this.win = w;
    w.on('closed', () => { if (this.win === w) this.win = null; });
  }

  private destroyWindow(): void {
    const w = this.win;
    this.win = null;
    this.ringOpen = false;
    this.drag = null;
    if (w && !w.isDestroyed()) { try { w.destroy(); } catch { /* gone */ } }
  }

  private unregisterHotkey(): void {
    if (this.registered === null) return;
    try { this.d.globalShortcut.unregister(this.registered); } catch { /* not held */ }
    this.registered = null;
  }

  private push(): void {
    const wc = this.overlayContents();
    if (!wc) return;
    try { if (!wc.isDestroyed?.()) wc.send('blob:status', { ...this.status(), ringOpen: this.ringOpen }); } catch { /* closing */ }
  }
}

/** The ipcMain surface the registration needs. */
export interface IpcMainLike { handle(channel: string, fn: (evt: IpcEventLike, ...args: unknown[]) => unknown): void }

export const REFUSED_NOT_OVERLAY = { ok: false as const, error: 'refused: not from the blob overlay' };
export const REFUSED_NOT_APP = { ok: false as const, error: 'refused: not from the app window' };

/**
 * The blob's IPC. `blob:overlay:*` only from the overlay's top frame; `blob:status` and
 * `blob:setConfig` only from an app window (never the overlay: it must not change its own settings).
 */
export function registerBlobIpc(ipc: IpcMainLike, ctl: BlobOverlayController, isAppSender: (evt: IpcEventLike) => boolean): void {
  const overlayOnly = (fn: (...args: unknown[]) => unknown) => (evt: IpcEventLike, ...args: unknown[]) =>
    (isOverlaySender(evt, ctl.overlayContents()) ? fn(...args) : REFUSED_NOT_OVERLAY);
  ipc.handle('blob:overlay:status', overlayOnly(() => ({ ok: true, status: ctl.status() })));
  ipc.handle('blob:overlay:action', overlayOnly((slot) => ctl.action(slot)));
  ipc.handle('blob:overlay:ring', overlayOnly((open) => ({ ok: true, status: ctl.setRing(open) })));
  ipc.handle('blob:overlay:drag', overlayOnly((phase) => {
    if (phase === 'start') ctl.dragStart();
    else if (phase === 'move') ctl.dragMove();
    else if (phase === 'end') ctl.dragEnd();
    else return { ok: false, error: 'bad phase' };
    return { ok: true };
  }));
  ipc.handle('blob:status', (evt) => (isAppSender(evt) ? { ok: true, status: ctl.status() } : REFUSED_NOT_APP));
  ipc.handle('blob:setConfig', (evt, patch) => (isAppSender(evt) ? ctl.setConfig(patch) : REFUSED_NOT_APP));
}
