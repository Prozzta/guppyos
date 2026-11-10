import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactElement } from 'react';
import { Blobatar } from 'blobatar/react';
import { happy, idle, shy, surprised, thinking, unsure, type Expression } from 'blobatar/expression';
// shy: the brief reaction when the blob hides itself from shares; thinking when it shows again.
import { BLOB_COMING_SOON, BLOB_DISABLED, type BlobOverlayApi, type BlobOverlayStatus, type BlobSlot } from '../../../shared/blob';
import { RING_SLOTS, ringSlotPosition } from './ring';

declare global { interface Window { blob?: BlobOverlayApi } }

/** Pointer travel (px) that turns a press into a drag instead of a click. */
const DRAG_THRESHOLD = 4;
const TOAST_MS = 1600;

/** The reference's bright yellow blob. blobatar's own swatches are contrast-muted (OKLCH hue 90
 *  gives #c9a32e), so the head and eye colours are pinned; the name only seeds the rest. */
const BLOB_NAME = 'guppy';
const BLOB_PALETTE = { head: '#ffd84a', eye: '#1a1320' };
const BLOB_TRAITS = { shape: 0.05 };

function Icon({ slot, invisible }: { slot: BlobSlot; invisible: boolean }): ReactElement {
  const p = { width: 26, height: 26, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  switch (slot) {
    case 'screenshot':
      return <svg {...p}><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M9 12h6" /></svg>;
    case 'meeting':
      return <svg {...p}><rect x="3" y="6" width="13" height="12" rx="2" /><path d="m16 10 5-3v10l-5-3" /></svg>;
    case 'invisible':
      return invisible
        ? <svg {...p}><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /><path d="M4 4l16 16" /></svg>
        : <svg {...p}><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></svg>;
    case 'close':
      return <svg {...p}><path d="M7 7l10 10M17 7 7 17" /></svg>;
    case 'screen':
      return <svg {...p}><rect x="3" y="4" width="18" height="12" rx="1.5" /><path d="M8 20h8M12 16v4" /></svg>;
    case 'message':
      return <svg {...p}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>;
  }
}

const LABEL: Record<BlobSlot, string> = {
  screenshot: 'Screenshot',
  meeting: 'Record meeting',
  invisible: 'Invisible',
  close: 'Close',
  screen: 'Screen (not available)',
  message: 'Record message',
};

/** Not `shy` anywhere here: its heat tints the pinned yellow head peach. */
const DICT_EXPR: Record<string, Expression | undefined> = {
  listening: surprised,
  transcribing: thinking,
  typing: happy,
  error: unsure,
  unavailable: unsure,
};

export function BlobApp(): ReactElement {
  const api = window.blob;
  const [status, setStatus] = useState<BlobOverlayStatus | null>(null);
  const [ringOpen, setRingOpen] = useState(false);
  const [toast, setToast] = useState<{ slot: BlobSlot; text: string } | null>(null);
  const [expr, setExpr] = useState<Expression>(idle);
  const press = useRef<{ x: number; y: number; dragging: boolean; raf: number } | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!api) return;
    void api.status().then((r) => { if (r.ok) setStatus(r.status); });
    return api.onStatus((s) => { setStatus(s); if (typeof s.ringOpen === 'boolean') setRingOpen(s.ringOpen); });
  }, [api]);

  const invisible = status?.invisible === true;
  // GUPPY-DICTATION-P2: the face and halo follow dictation; a ring reaction (toast) still wins.
  const dict = status?.dictationStatus;
  const dictState = dict && dict.state !== 'off' && dict.state !== 'ready' ? dict.state : null;
  const dictExpr = DICT_EXPR[dictState ?? ''];
  const dictTitle = dict?.message ?? (dictState === 'listening' ? 'Listening... release to type' : dict?.state === 'ready' ? `Blob (hold ${dict.chord} to dictate)` : 'Blob');
  // Back to idle once a reaction's toast is gone. Not `shy` while invisible: shy's heat tints the
  // yellow head peach, and invisible is the default, so the blob would blush all the time.
  useEffect(() => { if (!toast) setExpr(idle); }, [toast]);

  const openRing = useCallback(async (open: boolean) => {
    if (!api) return;
    // Grow the window first, then draw the ring into it (and the reverse on close).
    if (open) { await api.ring(true); setRingOpen(true); }
    else { setRingOpen(false); setToast(null); await api.ring(false); }
  }, [api]);

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    if (e.button !== 0 || !api) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    press.current = { x: e.screenX, y: e.screenY, dragging: false, raf: 0 };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    const p = press.current;
    if (!p || !api) return;
    if (!p.dragging && Math.hypot(e.screenX - p.x, e.screenY - p.y) >= DRAG_THRESHOLD) {
      p.dragging = true;
      void api.drag('start');
    }
    if (p.dragging && !p.raf) {
      p.raf = requestAnimationFrame(() => { if (press.current) press.current.raf = 0; void api.drag('move'); });
    }
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLButtonElement>): void => {
    const p = press.current;
    press.current = null;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* released */ }
    if (!p || !api) return;
    if (p.raf) cancelAnimationFrame(p.raf);
    if (p.dragging) { void api.drag('move').then(() => api.drag('end')); return; }
    void openRing(!ringOpen);
  };

  const onSlot = async (slot: BlobSlot): Promise<void> => {
    if (!api) return;
    const r = await api.action(slot);
    if (!r.ok) return;
    window.clearTimeout(toastTimer.current);
    if (r.state === 'coming-soon') {
      setToast({ slot, text: 'Coming soon' });
      setExpr(unsure);
      toastTimer.current = window.setTimeout(() => setToast(null), TOAST_MS);
    } else if (r.state === 'done') {
      setStatus(r.status);
      if (slot === 'close') { setRingOpen(false); setToast(null); }
      if (slot === 'invisible') {
        setToast({ slot, text: r.status.invisible ? 'Hidden from shares' : 'Visible in shares' });
        setExpr(r.status.invisible ? shy : thinking);
        toastTimer.current = window.setTimeout(() => setToast(null), TOAST_MS);
      }
    }
  };

  return (
    <div className={`blob-stage${ringOpen ? ' is-open' : ''}${dictState ? ` dict-${dictState}` : ''}`} data-dictation={dict?.state ?? 'off'}>
      {ringOpen && (
        <div className="blob-ring" role="menu" aria-label="Blob actions">
          <div className="blob-ring-track" aria-hidden />
          {RING_SLOTS.map((slot) => {
            const pos = ringSlotPosition(slot);
            const disabled = BLOB_DISABLED.includes(slot);
            const soon = BLOB_COMING_SOON.includes(slot);
            const active = slot === 'invisible' && invisible;
            return (
              <button
                key={slot}
                type="button"
                role="menuitem"
                className={`blob-slot slot-${slot}${disabled ? ' is-disabled' : ''}${soon ? ' is-soon' : ''}${active ? ' is-active' : ''}`}
                style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
                aria-disabled={disabled || undefined}
                aria-pressed={slot === 'invisible' ? active : undefined}
                title={soon ? `${LABEL[slot]} (coming soon)` : LABEL[slot]}
                onClick={() => { if (!disabled) void onSlot(slot); }}
              >
                <Icon slot={slot} invisible={invisible} />
                {toast?.slot === slot && <span className="blob-toast" role="status">{toast.text}</span>}
              </button>
            );
          })}
        </div>
      )}
      <button
        type="button"
        className="blob-face"
        aria-label={ringOpen ? 'Close Blob actions' : 'Open Blob actions'}
        title={dictTitle}
        aria-expanded={ringOpen}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          // A cancelled drag still ends in main, so the position is saved and main drops its drag.
          const p = press.current;
          press.current = null;
          if (p?.raf) cancelAnimationFrame(p.raf);
          if (p?.dragging && api) void api.drag('end');
        }}
      >
        <Blobatar name={BLOB_NAME} palette={BLOB_PALETTE} background={false} traits={BLOB_TRAITS} animate="always" expression={toast ? expr : dictExpr ?? expr} size={88} title={dictTitle} />
      </button>
    </div>
  );
}
