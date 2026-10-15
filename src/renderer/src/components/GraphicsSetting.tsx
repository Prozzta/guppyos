/**
 * GPU-SETTING-188 — Settings → General → Graphics (the rules: src/shared/graphicsMode.ts).
 *
 * Its own section with its own save lifecycle, like CapacityDisplaySetting: it reads main's graphics
 * status, saves only the mode, and saves nothing else. The mode is applied by main at startup, so a
 * change is saved at once and takes effect after a restart: the section says so and offers one, and
 * asks first when agents are running (a restart stops them). The indicator shows what is ACTUALLY
 * rendering (the WebGL renderer a floor got, and Chromium's GPU compositing in main), never the
 * setting's wish: a GPU choice that fell back to the CPU says so.
 */
import { useEffect, useState } from 'react';
import { PixelButton } from './PixelButton';
import {
  DEFAULT_GRAPHICS_MODE, GRAPHICS_MODES, parseGraphicsMode, renderingLabel,
  type GraphicsMode, type GraphicsStatusView
} from '@shared/graphicsMode';
import { currentRendererName } from '../scene/graphicsProbe';

export const GRAPHICS_COPY = {
  heading: 'Graphics',
  label: 'Guppy draws with',
  options: {
    auto: 'Auto (graphics card when available)',
    gpu: 'GPU (prefer the graphics card)',
    cpu: 'CPU only (no graphics card)'
  } as Record<GraphicsMode, string>,
  help: 'This applies to all of Guppy (terminals, office and floor), from the next start. Auto uses the graphics '
    + 'card when one is available and falls back to the CPU. GPU also asks for the faster graphics card on a PC '
    + 'that has two; if it is missing or unsupported, Guppy still falls back to the CPU and says so here. CPU only '
    + 'turns the graphics card off for the whole app: for a PC without one, or a graphics driver that misbehaves.',
  restartNeeded: (mode: GraphicsMode) => `Saved. "${GRAPHICS_COPY.options[mode]}" takes effect after a restart.`,
  restartNow: 'restart now',
  confirm: (n: number) => `Restarting stops ${n} running agent${n === 1 ? '' : 's'}. Restart now?`,
  confirmYes: 'restart',
  confirmNo: 'later',
  failed: 'The Graphics setting could not be saved. The current one is unchanged.'
};

/** How often the open section re-reads main's status (one IPC call, no WebGL context). */
export const GRAPHICS_REFRESH_MS = 10_000;

/** Pure: whether the saved mode waits for a restart (it differs from the one this run started with). */
export function restartPending(s: Pick<GraphicsStatusView, 'applied' | 'stored'> | null): boolean {
  return !!s && s.applied !== s.stored;
}

export function GraphicsSetting() {
  const [status, setStatus] = useState<GraphicsStatusView | null>(null);
  const [renderer, setRenderer] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // main's status now and again while the section is open: Chromium's compositing is read fresh
    // each time, so a GPU-process fallback mid-run shows (Jim S1). The renderer is read once.
    const refresh = () => { void window.cth.graphicsStatus().then(setStatus).catch(() => { /* indicator stays as it is */ }); };
    refresh();
    setRenderer(currentRendererName());
    const timer = window.setInterval(refresh, GRAPHICS_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, []);

  const stored = status?.stored ?? DEFAULT_GRAPHICS_MODE;
  const choose = (value: string) => {
    const mode = parseGraphicsMode(value);
    if (!mode || mode === stored) return;
    setError(null);
    setConfirming(false);
    void window.cth.setGraphicsMode(mode).then(setStatus).catch(() => setError(GRAPHICS_COPY.failed));
  };
  const restart = async () => {
    if (!confirming) {
      // Jim N1: count the running agents now, not when the section opened; a failed read confirms.
      const fresh = await window.cth.graphicsStatus().catch(() => null);
      if (fresh) setStatus(fresh);
      if (!fresh || fresh.runningAgents > 0) { setConfirming(true); return; }
    }
    void window.cth.restartForGraphics();
  };

  return (
    <div data-graphics-setting="">
      <div style={{
        fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
        color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 10
      }}>
        {GRAPHICS_COPY.heading}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--cth-ink-900)' }}>
          {GRAPHICS_COPY.label}
          <select
            aria-label="Graphics"
            data-graphics-mode=""
            value={stored}
            onChange={(e) => choose(e.target.value)}
            style={{ fontSize: 12, padding: '2px 6px' }}>
            {GRAPHICS_MODES.map((m) => <option key={m} value={m}>{GRAPHICS_COPY.options[m]}</option>)}
          </select>
        </label>
        <span data-graphics-indicator="" style={{ fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)', fontFamily: 'var(--cth-font-mono, monospace)' }}>
          {status ? renderingLabel(renderer, status) : 'Rendering: …'}
        </span>
        {restartPending(status) && (
          <div data-graphics-restart="" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--cth-ink-900)' }}>
            <span>{confirming && status ? GRAPHICS_COPY.confirm(status.runningAgents) : GRAPHICS_COPY.restartNeeded(stored)}</span>
            <PixelButton variant="secondary" size="sm" onClick={restart}>{confirming ? GRAPHICS_COPY.confirmYes : GRAPHICS_COPY.restartNow}</PixelButton>
            {confirming && <PixelButton variant="secondary" size="sm" onClick={() => setConfirming(false)}>{GRAPHICS_COPY.confirmNo}</PixelButton>}
          </div>
        )}
        {error && <span role="alert" style={{ fontSize: 12, color: 'var(--cth-status-blocked)' }}>{error}</span>}
        <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>{GRAPHICS_COPY.help}</span>
      </div>
    </div>
  );
}
