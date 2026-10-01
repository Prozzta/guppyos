import { useEffect, useState } from 'react';
import { SafeMarkdown } from './HumanQuestionCard';

/**
 * ZT-I4: the "Floor" panel next to the Kanban. It shows `hive/floor-digest.md`, the
 * harness's zero-token summary of the floor (decisions needed, work in flight with its
 * age, blocked and ask-me cards, flags, roster), exactly as god is pointed at it.
 * Read-only: the harness rewrites the file; nobody edits it.
 */
export function FloorDigestPanel({ pollMs = 10_000 }: { pollMs?: number }) {
  const [text, setText] = useState<string>('');
  useEffect(() => {
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const t = await window.cth.hiveFloorDigest();
        if (!cancelled) setText(typeof t === 'string' ? t : '');
      } catch { /* keep the last digest */ }
    };
    void poll();
    const iv = setInterval(() => { void poll(); }, pollMs);
    return () => { cancelled = true; clearInterval(iv); };
  }, [pollMs]);
  return (
    <div data-panel="floor-digest" style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px 12px', background: 'var(--cth-paper-100)' }}>
      {text
        ? <SafeMarkdown source={text} />
        : <div style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>No floor digest yet (the harness writes it every few minutes).</div>}
    </div>
  );
}
