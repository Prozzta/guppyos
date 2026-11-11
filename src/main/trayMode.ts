/**
 * Windows-only close-to-tray policy. Electron is deliberately injected so its
 * lifecycle is testable without creating a native tray or quitting a test run.
 */
export interface TrayLike {
  setContextMenu(menu: unknown): void;
  on(event: 'click', listener: () => void): void;
  destroy(): void;
  isDestroyed?(): boolean;
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
      const icon = await this.d.icon();
      if (!this.wanted() || this.tray) return;
      const tray = this.d.createTray(icon);
      tray.on('click', () => this.open());
      tray.setContextMenu(this.d.buildMenu([
        { label: 'Open Guppy', click: () => this.open() },
        { label: 'Show Blob', click: () => this.d.toggleBlob() },
        { label: 'Quit Guppy', click: () => this.d.quit() }
      ]));
      this.tray = tray;
    } finally { this.creating = false; }
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
