/**
 * Windows-only close-to-tray policy. Electron is deliberately injected so its
 * lifecycle is testable without creating a native tray or quitting a test run.
 */
export interface TrayLike {
  setContextMenu(menu: unknown): void;
  on(event: 'click', listener: () => void): void;
  destroy(): void;
  isDestroyed?(): boolean;
  /** BLOB-TRAY-TOASTS: swap the icon in place (the Blob's face). */
  setImage?(icon: unknown): void;
  /** BLOB-ORCH-MOOD: the hover text (trayTip). */
  setToolTip?(tip: string): void;
}

export interface TrayWindowLike {
  isDestroyed(): boolean;
  hide(): void;
  show(): void;
  restore(): void;
  focus(): void;
  isMinimized(): boolean;
}

export interface TrayCloseEventLike { preventDefault(): void; }
export interface TrayMenuItem { label: string; click: () => void; }

export interface TrayModeDeps {
  platform(): string;
  enabled(): boolean;
  icon(): Promise<unknown>;
  createTray(icon: unknown): TrayLike;
  buildMenu(items: TrayMenuItem[]): unknown;
  toggleBlob(): void;
  quit(): void;
}

export class TrayModeController {
  private tray: TrayLike | null = null;
  private creating = false;
  /** The primary window, never a most-recently-focused Floor window. */
  private primary: TrayWindowLike | null = null;
  /** BLOB-TRAY-TOASTS: the Blob face the tray shows; null = the exe icon (faces not rendered, or failed). */
  private face: unknown = null;
  /** BLOB-ORCH-MOOD: the tooltip the tray shows (trayTip); null = none set yet. */
  private tip: string | null = null;

  constructor(private readonly d: TrayModeDeps) {}

  private wanted(): boolean { return this.d.platform() === 'win32' && this.d.enabled(); }

  setPrimaryWindow(win: TrayWindowLike): void { this.primary = win; }

  /** Reconcile a live Settings change. The icon is async on Windows because it
   * comes from the installed Guppy executable, not a second artwork asset. */
  async sync(): Promise<void> {
    if (!this.wanted()) { this.dispose(); return; }
    if (this.tray || this.creating) return;
    this.creating = true;
    try {
      const icon = this.face ?? await this.d.icon();
      if (!this.wanted() || this.tray) return;
      const tray = this.d.createTray(this.face ?? icon);
      tray.on('click', () => this.open());
      tray.setContextMenu(this.d.buildMenu([
        { label: 'Open Guppy', click: () => this.open() },
        { label: 'Show Blob', click: () => this.d.toggleBlob() },
        { label: 'Quit Guppy', click: () => this.d.quit() }
      ]));
      if (this.tip !== null) { try { tray.setToolTip?.(this.tip); } catch { /* best-effort */ } }
      this.tray = tray;
    } finally { this.creating = false; }
  }

  /** BLOB-TRAY-TOASTS: show `icon` (a Blob face) on the tray now and on any tray created later.
   *  A failing swap keeps the icon the tray already has. */
  setFace(icon: unknown): void {
    if (icon === null || icon === undefined || icon === this.face) return;
    this.face = icon;
    const tray = this.tray;
    if (!tray || (tray.isDestroyed && tray.isDestroyed())) return;
    try { tray.setImage?.(icon); } catch { /* keep the current icon */ }
  }

  /** BLOB-ORCH-MOOD: show `tip` as the tray's hover text now and on any tray created later. */
  setTip(tip: string): void {
    if (tip === this.tip) return;
    this.tip = tip;
    const tray = this.tray;
    if (!tray || (tray.isDestroyed && tray.isDestroyed())) return;
    try { tray.setToolTip?.(tip); } catch { /* keep the current tip */ }
  }

  /** Returns true exactly when the close became a hide. */
  hideOnClose(event: TrayCloseEventLike, win: TrayWindowLike, quitting: boolean): boolean {
    // A tray must already exist before hiding. If obtaining the native icon or
    // constructing a Tray failed, retain Electron's normal close/PTY-warning
    // route instead of stranding a hidden app without a recovery affordance.
    if (quitting || !this.wanted() || !this.tray || win.isDestroyed()) return false;
    this.primary = win;
    event.preventDefault();
    win.hide();
    return true;
  }

  open(): void {
    const win = this.primary;
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  dispose(): void {
    const tray = this.tray;
    this.tray = null;
    if (!tray) return;
    try { if (!tray.isDestroyed || !tray.isDestroyed()) tray.destroy(); } catch { /* best-effort */ }
  }
}
