import { useCallback, useEffect, useState } from 'react';
import { PixelButton } from './PixelButton';
import type { MailObligationsAgent, MailObligationsSnapshot, UndeliveredMailReport } from '../../../preload';

/**
 * ZT-I1-MAIL §4.3 + §11.13 option B: the zero-token open-request list. Every `act:"request"`
 * message (and every `requires_reply` one) stays open until its recipient routes a reply, or the
 * Human closes it here. Data only: nothing on this surface wakes an agent. Also the §7.1 step-2
 * report (archived agents' unread mail moved to inbox/.undelivered), shown ONCE until dismissed.
 */

export const OBLIGATIONS_POLL_MS = 5_000;

export interface OpenRequestRow {
  /** The agent that owes the reply (the request's recipient). */
  agentId: string;
  agentName: string;
  id: string;
  from: string;
  subject: string;
  ageSec: number;
  state: string;
  /** request = act:"request"; reply = requires_reply (acted, not replied); both = either list. */
  kind: 'request' | 'reply' | 'both';
  missing: boolean;
}

/** Flatten the per-agent lists into one row per (agent, id), oldest first. Pure. */
export function openRequestRows(agents: MailObligationsAgent[] | null | undefined): OpenRequestRow[] {
  const rows = new Map<string, OpenRequestRow>();
  for (const a of Array.isArray(agents) ? agents : []) {
    const add = (o: MailObligationsAgent['openRequests'][number], kind: 'request' | 'reply'): void => {
      if (!o || typeof o.id !== 'string') return;
      const key = `${a.agentId}|${o.id}`;
      const prev = rows.get(key);
      if (prev) { if (prev.kind !== kind) prev.kind = 'both'; return; }
      rows.set(key, {
        agentId: a.agentId, agentName: a.name || a.agentId, id: o.id, from: String(o.from ?? ''),
        subject: String(o.subject ?? ''), ageSec: Number(o.ageSec) || 0, state: String(o.state ?? ''),
        kind, missing: o.missing === true
      });
    };
    for (const o of a.openRequests ?? []) add(o, 'request');
    for (const o of a.awaitingReply ?? []) add(o, 'reply');
  }
  return [...rows.values()].sort((x, y) => y.ageSec - x.ageSec);
}

/** The Command Center badge: distinct open obligations (full counts beyond the list bound). */
export function openRequestsBadgeCount(snap: MailObligationsSnapshot | null | undefined): number {
  let n = 0;
  for (const a of Array.isArray(snap?.agents) ? snap!.agents : []) {
    const ids = new Set([...(a.openRequests ?? []), ...(a.awaitingReply ?? [])].map((o) => o.id));
    n += Math.max(ids.size, Number(a.openRequestCount) || 0, Number(a.awaitingReplyCount) || 0);
  }
  return n;
}

/** "42s", "17m", "5h", "3d". */
export function formatObligationAge(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

/** The undelivered report to show now: only while unseen and non-empty. Pure. */
export function undeliveredToShow(r: UndeliveredMailReport | null | undefined): UndeliveredMailReport | null {
  return r && r.seenAt === null && Array.isArray(r.items) && r.items.length > 0 ? r : null;
}

const mono: React.CSSProperties = { fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-700)' };
const card: React.CSSProperties = {
  background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
  padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4
};
const tag: React.CSSProperties = {
  fontFamily: 'var(--cth-font-mono)', fontSize: 10, padding: '0 5px', textTransform: 'uppercase',
  letterSpacing: 0.5, boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)', color: 'var(--cth-ink-900)'
};

/** The list. Pure: the container owns the IPC. `confirming` is the row awaiting a second click. */
export function OpenRequestsView({ rows, confirming, closing, onClose }: {
  rows: OpenRequestRow[];
  confirming?: string | null;
  closing?: Record<string, boolean>;
  onClose?: (row: OpenRequestRow) => void;
}) {
  return (
    <div data-open-requests="" style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 14px 16px', overflow: 'auto' }}>
      <p style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-700)', margin: 0 }}>
        Requests still waiting for a reply. They close when the recipient replies (in_reply_to). Closing one here
        only takes it off this list; no message is sent and no agent is woken.
      </p>
      {rows.length === 0 ? (
        <div style={{ ...card, fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-700)' }}>No open requests.</div>
      ) : rows.map((r) => {
        const key = `${r.agentId}|${r.id}`;
        const busy = !!closing?.[key];
        return (
          <div key={key} data-open-request={key} style={card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
              <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, fontWeight: 600, color: 'var(--cth-ink-900)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {r.subject || '(no subject)'}
              </span>
              {onClose && (
                <PixelButton size="sm" variant={confirming === key ? 'destructive' : 'secondary'} disabled={busy}
                  title="Take it off the open-request list without a reply. No message is sent."
                  onClick={() => onClose(r)}>
                  {busy ? 'closing…' : confirming === key ? 'confirm close' : 'close'}
                </PixelButton>
              )}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 12px', alignItems: 'center', ...mono }}>
              <span title="message id">{r.id}</span>
              <span title="from → the agent that owes the reply">{r.from} → {r.agentName}</span>
              <span title="time since delivery">{formatObligationAge(r.ageSec)}</span>
              <span style={tag}>{r.kind === 'reply' ? 'reply expected' : r.kind === 'both' ? 'request · reply expected' : 'request'}</span>
              {r.missing && <span data-missing="" style={{ ...tag, color: 'var(--cth-status-blocked)' }} title="The message file was lost; the sender may need to resend it.">missing</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** §7.1 step 2, shown once: the archived agents' unread mail. Pure. */
export function UndeliveredMailBannerView({ report, onDismiss }: { report: UndeliveredMailReport | null | undefined; onDismiss?: () => void }) {
  const r = undeliveredToShow(report);
  if (!r) return null;
  const byAgent = new Map<string, number>();
  for (const i of r.items) byAgent.set(i.agentId, (byAgent.get(i.agentId) ?? 0) + 1);
  return (
    <div role="status" data-undelivered-report="" style={{
      margin: '6px 8px 0', padding: '8px 10px', background: 'var(--cth-paper-100)',
      boxShadow: 'inset 0 0 0 1.5px var(--cth-ink-300)', display: 'flex', flexDirection: 'column', gap: 4,
      fontFamily: 'var(--cth-font-ui)', color: 'var(--cth-ink-900)'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 700 }}>
          {r.items.length} unread message{r.items.length === 1 ? '' : 's'} to archived agents {r.items.length === 1 ? 'was' : 'were'} set aside
        </span>
        {onDismiss && <PixelButton size="sm" variant="secondary" onClick={onDismiss}>dismiss</PixelButton>}
      </div>
      <span style={{ fontSize: 11, color: 'var(--cth-ink-700)' }}>
        The upgrade moved them to each agent's inbox/.undelivered folder; nothing was woken. Resend what still matters to an active agent or god.
      </span>
      <ul style={{ margin: 0, paddingLeft: 16, ...mono }}>
        {[...byAgent.entries()].map(([agentId, n]) => <li key={agentId}>{agentId}: {n}</li>)}
        {r.items.slice(0, 8).map((i) => (
          <li key={i.file} style={{ listStyle: 'none', marginLeft: -16 }} title={i.file}>
            {i.id} · {i.from ?? '?'} → {i.agentId}{i.subject ? ` · ${i.subject}` : ''}
          </li>
        ))}
        {r.items.length > 8 && <li style={{ listStyle: 'none', marginLeft: -16 }}>… and {r.items.length - 8} more (state/mail/undelivered-report.json)</li>}
      </ul>
    </div>
  );
}

/** One poll of main's open-request view, shared by the badge, the tab and the banner. */
export function useMailObligations(pollMs = OBLIGATIONS_POLL_MS): { snap: MailObligationsSnapshot | null; refresh: () => void } {
  const [snap, setSnap] = useState<MailObligationsSnapshot | null>(null);
  const refresh = useCallback(() => {
    window.cth.hiveMailObligations()
      .then((s) => { if (s && typeof s === 'object') setSnap(s); })
      .catch(() => { /* main not ready */ });
  }, []);
  useEffect(() => {
    refresh();
    const t = window.setInterval(refresh, pollMs);
    return () => window.clearInterval(t);
  }, [refresh, pollMs]);
  return { snap, refresh };
}

/** The tab body: the list plus its one action, the explicit close (two clicks). */
export function OpenRequestsTab({ snap, refresh }: { snap: MailObligationsSnapshot | null; refresh: () => void }) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [closing, setClosing] = useState<Record<string, boolean>>({});
  const onClose = useCallback((r: OpenRequestRow) => {
    const key = `${r.agentId}|${r.id}`;
    if (confirming !== key) { setConfirming(key); return; }
    setConfirming(null);
    setClosing((c) => ({ ...c, [key]: true }));
    window.cth.hiveCloseObligation(r.agentId, r.id)
      .catch(() => { /* the row stays; the next poll tells the truth */ })
      .finally(() => { setClosing((c) => { const n = { ...c }; delete n[key]; return n; }); refresh(); });
  }, [confirming, refresh]);
  return <OpenRequestsView rows={openRequestRows(snap?.agents)} confirming={confirming} closing={closing} onClose={onClose} />;
}

/** The once-only banner container: dismissing persists in main (`seenAt`). */
export function UndeliveredMailBanner({ snap, refresh }: { snap: MailObligationsSnapshot | null; refresh: () => void }) {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;
  return (
    <UndeliveredMailBannerView report={snap?.undelivered} onDismiss={() => {
      setDismissed(true);
      void window.cth.hiveUndeliveredSeen().catch(() => { /* shown again next start */ }).finally(refresh);
    }} />
  );
}
