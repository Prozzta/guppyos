import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { HistoryItem } from '@shared/history';
import { PixelButton } from './PixelButton';
import {
  EMPTY_WINDOW,
  UNAVAILABLE_TEXT,
  applyNewer,
  applyOlder,
  applyTail,
  clockOf,
  visibleRange,
  type HistoryWindow
} from './historyModel';

/**
 * HISTORY-VIEW-169: an agent's conversation, read from its provider's OWN transcript.
 *
 * The terminal's scrollback is not a record of the conversation: resize repaints and
 * transcript replays pile stale frames into it (TERMINAL-SCROLLBACK-WHY.md). This tab
 * reads the transcript instead, so it shows each turn once, and it survives app restarts
 * and renderer reloads because it simply reads the file again.
 *
 * Read-only and virtualised: only rows in view (plus an overscan) are mounted, and the
 * model (historyModel.ts) keeps at most HISTORY_RETAIN_MAX items. It follows new turns
 * only while scrolled to the bottom.
 */

const POLL_MS = 2000;
const EST_ROW = 44;
const STICK_PX = 24;

const KIND_LABEL: Record<HistoryItem['kind'], string> = {
  user: 'USER', assistant: 'AGENT', tool: 'TOOL', system: 'SYSTEM'
};

/** One history row. Exported for render tests. */
export function HistoryRow({ item }: { item: HistoryItem }) {
  const clock = clockOf(item.at);
  const when = item.at !== null ? new Date(item.at).toLocaleString() : undefined;
  if (item.kind === 'system') {
    return (
      <div data-kind="system" style={{
        padding: '6px 10px', textAlign: 'center', fontSize: 11,
        color: 'var(--cth-ink-500)', fontFamily: 'var(--cth-font-ui)'
      }} title={when}>
        ── {item.text} ── {clock && <span style={{ fontFamily: 'var(--cth-font-mono)' }}>{clock}</span>}
      </div>
    );
  }
  if (item.kind === 'tool') {
    return (
      <div data-kind="tool" title={when} style={{
        display: 'flex', gap: 8, alignItems: 'baseline', padding: '2px 10px 2px 18px',
        fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-500)', minWidth: 0
      }}>
        <span aria-hidden style={{ flexShrink: 0 }}>›</span>
        <span style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.text}</span>
        {clock && <span style={{ flexShrink: 0 }}>{clock}</span>}
      </div>
    );
  }
  const user = item.kind === 'user';
  const box: CSSProperties = {
    margin: '6px 8px', padding: '6px 10px',
    background: user ? 'var(--cth-cream-100)' : 'var(--cth-paper-100)',
    boxShadow: `inset 3px 0 0 var(${user ? '--cth-sky' : '--cth-mint'}), inset 0 0 0 1px var(--cth-ink-100)`
  };
  return (
    <div data-kind={item.kind} style={box}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 2 }}>
        <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px', color: 'var(--cth-ink-700)' }}>
          {KIND_LABEL[item.kind]}
        </span>
        {clock && <span title={when} style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-500)' }}>{clock}</span>}
      </div>
      <div style={{
        fontSize: 13, lineHeight: '18px', color: 'var(--cth-ink-900)',
        whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', userSelect: 'text'
      }}>
        {item.text}
        {item.truncated && <span style={{ color: 'var(--cth-ink-500)', fontSize: 11 }}> (truncated)</span>}
      </div>
    </div>
  );
}

export interface HistoryListProps {
  win: HistoryWindow;
  /** The rows to mount, from visibleRange. */
  first: number;
  last: number;
  padTop: number;
  padBottom: number;
  loading: boolean;
  following: boolean;
  onLoadOlder?: () => void;
  onJumpLatest?: () => void;
}

/** The presentational list: header controls, spacers and the mounted rows. Exported for render tests. */
export function HistoryList({ win, first, last, padTop, padBottom, loading, following, onLoadOlder, onJumpLatest }: HistoryListProps) {
  if (win.unavailable) {
    return (
      <div style={{ padding: 16, fontSize: 13, color: 'var(--cth-ink-700)', textAlign: 'center' }}>
        {UNAVAILABLE_TEXT[win.unavailable]}
      </div>
    );
  }
  if (!win.fileId) {
    return <div style={{ padding: 16, fontSize: 13, color: 'var(--cth-ink-500)', textAlign: 'center' }}>{loading ? 'Loading history…' : 'No history yet.'}</div>;
  }
  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'center', padding: '6px 8px' }}>
        {win.atStart
          ? <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>Start of this session</span>
          : <PixelButton variant="ghost" size="sm" onClick={onLoadOlder} disabled={loading}>{loading ? 'Loading…' : 'Load older'}</PixelButton>}
      </div>
      {win.items.length === 0 && (
        <div style={{ padding: 16, fontSize: 13, color: 'var(--cth-ink-500)', textAlign: 'center' }}>No turns yet.</div>
      )}
      <div data-pad-top style={{ height: padTop }} />
      {win.items.slice(first, last).map((item) => (
        <div key={item.id} data-hid={item.id}><HistoryRow item={item} /></div>
      ))}
      <div style={{ height: padBottom }} />
      {!following && (
        <div style={{ position: 'sticky', bottom: 8, display: 'flex', justifyContent: 'center', pointerEvents: 'none' }}>
          <span style={{ pointerEvents: 'auto' }}>
            <PixelButton variant="secondary" size="sm" onClick={onJumpLatest}>Jump to latest</PixelButton>
          </span>
        </div>
      )}
    </>
  );
}

export interface HistoryViewProps {
  agentId: string;
}

export function HistoryView({ agentId }: HistoryViewProps) {
  const [win, setWin] = useState<HistoryWindow>(EMPTY_WINDOW);
  const [loading, setLoading] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);
  const [atBottom, setAtBottom] = useState(true);
  const [, setMeasureTick] = useState(0);

  const scroller = useRef<HTMLDivElement | null>(null);
  const winRef = useRef(win);
  winRef.current = win;
  const busy = useRef(false);
  const stick = useRef(true);
  const heights = useRef(new Map<string, number>());
  const widthRef = useRef(0);
  // Set before an older page is prepended: the row that was first on screen, and how far
  // below the viewport's top it sat. Held until that row is mounted and measured in place.
  const anchor = useRef<{ id: string; delta: number; until: number } | null>(null);

  const loadTail = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    try {
      const page = await window.cth.historyPage({ agentId });
      heights.current.clear();
      stick.current = true;
      setAtBottom(true);
      setWin(applyTail(page));
    } catch {
      setWin({ ...EMPTY_WINDOW, unavailable: 'unreadable' });
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, [agentId]);

  const loadOlder = useCallback(async () => {
    const w = winRef.current;
    if (busy.current || w.atStart || !w.fileId) return;
    busy.current = true;
    setLoading(true);
    let reload = false;
    try {
      const page = await window.cth.historyPage({ agentId, before: w.start });
      const next = applyOlder(winRef.current, page);
      if (next === 'reload') reload = true;
      else {
        const el = scroller.current;
        if (el) {
          const row = [...el.querySelectorAll<HTMLElement>('[data-hid]')].find((r) => r.offsetTop + r.offsetHeight > el.scrollTop);
          anchor.current = row ? { id: row.dataset.hid!, delta: row.offsetTop - el.scrollTop, until: Date.now() + 1500 } : null;
        }
        stick.current = false;
        setWin(next);
      }
    } catch { /* keep what is shown */ } finally {
      busy.current = false;
      setLoading(false);
    }
    if (reload) void loadTail();
  }, [agentId, loadTail]);

  // At the live end already: just scroll down. Otherwise the tail is reloaded.
  const jumpLatest = useCallback(() => {
    const el = scroller.current;
    if (winRef.current.live && el) {
      stick.current = true;
      setAtBottom(true);
      el.scrollTop = el.scrollHeight;
      setScrollTop(el.scrollTop);
      return;
    }
    void loadTail();
  }, [loadTail]);

  // First load, and a fresh start whenever the agent changes. Dropped on unmount.
  useEffect(() => {
    setWin(EMPTY_WINDOW);
    heights.current.clear();
    void loadTail();
  }, [loadTail]);

  // Follow: a size-checked poll while mounted. No source yet → retry the tail.
  useEffect(() => {
    const t = setInterval(() => {
      const w = winRef.current;
      if (busy.current) return;
      if (!w.fileId) { void loadTail(); return; }
      if (!w.live) return;
      busy.current = true;
      window.cth.historyPage({ agentId, after: w.end }).then((page) => {
        busy.current = false;
        const next = applyNewer(winRef.current, page);
        if (next === 'reload') { void loadTail(); return; }
        if (next !== winRef.current) setWin(next);
      }, () => { busy.current = false; });
    }, POLL_MS);
    return () => clearInterval(t);
  }, [agentId, loadTail]);

  // Viewport size; a width change invalidates measured heights.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== widthRef.current) { widthRef.current = el.clientWidth; heights.current.clear(); setMeasureTick((n) => n + 1); }
      setViewport(el.clientHeight);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // After each render: measure mounted rows, then keep the scroll position right.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let changed = false;
    el.querySelectorAll<HTMLElement>('[data-hid]').forEach((row) => {
      const id = row.dataset.hid!;
      const h = row.offsetHeight;
      if (h > 0 && Math.abs((heights.current.get(id) ?? -1) - h) > 0.5) { heights.current.set(id, h); changed = true; }
    });
    const a = anchor.current;
    if (a) {
      const items = winRef.current.items;
      const idx = items.findIndex((i) => i.id === a.id);
      if (idx < 0 || Date.now() > a.until) anchor.current = null;
      else {
        // In the DOM when mounted; otherwise from the (partly estimated) heights above it.
        const row = el.querySelector<HTMLElement>(`[data-hid="${CSS.escape(a.id)}"]`);
        const pad = el.querySelector<HTMLElement>('[data-pad-top]');
        let top = pad ? pad.offsetTop : 0;
        if (row) top = row.offsetTop;
        else for (let i = 0; i < idx; i += 1) top += heights.current.get(items[i].id) ?? EST_ROW;
        const want = Math.max(0, top - a.delta);
        if (Math.abs(el.scrollTop - want) >= 1) el.scrollTop = want;
        if (row && !changed) anchor.current = null;
      }
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
    // Programmatic scrolls update the virtual window now, not on a later scroll event.
    if (Math.abs(el.scrollTop - scrollTop) >= 1) setScrollTop(el.scrollTop);
    if (changed) setMeasureTick((n) => n + 1);
  });

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
    stick.current = bottom;
    if (bottom !== atBottom) setAtBottom(bottom);
    setScrollTop(el.scrollTop);
  };

  const hs = win.items.map((i) => heights.current.get(i.id) ?? EST_ROW);
  const range = visibleRange(hs, scrollTop, viewport || 600);
  // Following means: the window reaches the live end AND the view is at the bottom.
  const following = win.live && atBottom;

  return (
    <div
      ref={scroller}
      onScroll={onScroll}
      data-history-view
      style={{
        flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
        background: 'var(--cth-paper-200)', position: 'relative'
      }}
    >
      <HistoryList
        win={win}
        first={range.first}
        last={range.last}
        padTop={range.padTop}
        padBottom={range.padBottom}
        loading={loading}
        following={following || !win.fileId}
        onLoadOlder={() => void loadOlder()}
        onJumpLatest={jumpLatest}
      />
    </div>
  );
}
