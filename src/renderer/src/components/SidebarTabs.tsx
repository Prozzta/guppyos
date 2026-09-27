import { useEffect, useRef, useState } from 'react';
import { type SidebarTab } from '@/store/store';
import { type AccentColorName } from '@/design/tokens';
import { Icon, type IconName } from './Icon';

// v0.3.4: the files tab is gone — the per-agent IDE button (header) opens the
// full Monaco editor + file tree, which superseded the read-only browser.
const TABS: { key: SidebarTab; label: string; icon: IconName }[] = [
  { key: 'terminal', label: 'terminal', icon: 'terminal' },
  // HISTORY-VIEW-169: the conversation from the provider's own transcript (the terminal's
  // scrollback is frames and replays, not a record).
  { key: 'history',  label: 'history',  icon: 'clock' },
  { key: 'git',      label: 'git',      icon: 'code' },
  { key: 'messages', label: 'messages', icon: 'bell' },
  { key: 'traces',   label: 'traces',   icon: 'web' }
];

export interface SidebarTabsProps {
  current: SidebarTab;
  accent: AccentColorName;
  onChange: (tab: SidebarTab) => void;
}

/** Below this width the inactive tabs drop their words and keep their icons (the tip and
 *  aria-label still name them). Five labelled tabs need ~510px; the default sidebar is 420. */
export const TABS_COMPACT_BELOW = 520;

export function SidebarTabs({ current, accent, onChange }: SidebarTabsProps) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const el = rowRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setCompact(w < TABS_COMPACT_BELOW);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={rowRef} style={{
      display: 'flex',
      gap: 0,
      background: 'var(--cth-cream-200)',
      boxShadow: 'inset 0 -2px 0 var(--cth-ink-900)',
      flexShrink: 0
    }}>
      {TABS.map(t => {
        const active = current === t.key;
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            title={t.label}
            aria-label={t.label}
            style={{
              flex: compact && !active ? '0 1 auto' : 1,
              minWidth: 0,
              height: 36,
              padding: '0 10px',
              border: 'none',
              cursor: 'pointer',
              background: active ? 'var(--cth-cream-100)' : 'transparent',
              boxShadow: active
                ? `inset 0 -3px 0 var(--cth-${accent}), inset 1px 0 0 var(--cth-ink-900), inset -1px 0 0 var(--cth-ink-900)`
                : 'inset 0 0 0 0',
              fontFamily: 'var(--cth-font-display)',
              fontSize: 10,
              lineHeight: '14px',
              color: active ? 'var(--cth-ink-900)' : 'var(--cth-ink-500)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6
            }}
          >
            <Icon name={t.icon} />{compact && !active ? null : ` ${t.label.toUpperCase()}`}
          </button>
        );
      })}
    </div>
  );
}
