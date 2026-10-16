/**
 * CLAIM-LEDGER W7: the Human's claim ledger UI (Settings > Memory & Knowledge).
 *
 *   - the ledger level (the Settings ceiling; main pushes it to the memory worker at once and, on a
 *     drop below writer, exports every writer agent's memory.md first);
 *   - per agent: the export button, Human-authored preferences, the claims with their status badges,
 *     and for one claim its history ("why does it believe this") with a revert per revertible step;
 *   - the purge, last and Human-only: the word typed here, then main's own confirm dialog.
 * Every write is main's (window.cth.claimsUi); this component only asks.
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { PixelButton } from './PixelButton';
import { claimHistory, statusBadge, UI_STATUSES, type LedgerUiAgentView, type LedgerUiClaim, type LedgerUiResult, type LedgerUiSummary } from '@shared/claimsUi';
import type { Status } from '@shared/claims';

const LEVELS = ['off', 'shadow', 'reader', 'writer'] as const;
const TEXT_MAX = 400;
const LIST_MAX = 200;
const PURGE_WORD = 'purge';

const heading: CSSProperties = { fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px', color: 'var(--cth-ink-500)', textTransform: 'uppercase', marginBottom: 10 };
const label: CSSProperties = { fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' };
const hint: CSSProperties = { fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' };
const box: CSSProperties = { border: '1px solid var(--cth-ink-300)', background: 'var(--cth-cream-100)', padding: 8 };
const input: CSSProperties = { width: '100%', boxSizing: 'border-box', fontSize: 12, lineHeight: '16px', padding: '4px 6px', border: '1px solid var(--cth-ink-300)', background: 'var(--cth-cream-50, #fff)', color: 'var(--cth-ink-900)', fontFamily: 'inherit' };

const toneColor = { ok: 'var(--cth-status-success)', warn: 'var(--cth-status-waiting)', muted: 'var(--cth-ink-500)', danger: 'var(--cth-status-blocked)' } as const;

export function StatusBadge({ status }: { status: Status }) {
  const b = statusBadge(status);
  return (
    <span data-status={status} style={{
      display: 'inline-block', flex: 'none', fontSize: 10, lineHeight: '14px', padding: '0 5px',
      border: `1px solid ${toneColor[b.tone]}`, color: toneColor[b.tone], whiteSpace: 'nowrap',
    }}>{b.label}</span>
  );
}

function Message({ result }: { result: { text: string; ok: boolean } | null }) {
  if (!result) return null;
  return <div role="status" style={{ ...hint, color: result.ok ? 'var(--cth-ink-700)' : 'var(--cth-status-blocked)', marginTop: 6 }}>{result.text}</div>;
}

const said = (r: LedgerUiResult, done: string): { text: string; ok: boolean } =>
  r.ok ? { text: r.note ? `${done} ${r.note}` : done, ok: true } : { text: r.error, ok: false };

export function ClaimLedgerSettings() {
  const api = window.cth.claimsUi;
  const [summary, setSummary] = useState<LedgerUiSummary | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [levelMsg, setLevelMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);

  const refresh = useCallback(async () => { try { setSummary(await api.summary()); } catch { setSummary(null); } }, [api]);
  useEffect(() => { void refresh(); }, [refresh]);

  const setLevel = async (level: string) => {
    setBusy('level'); setLevelMsg({ text: `Applying ${level}... (the memory worker re-reads every ledger; this can take a minute)`, ok: true });
    try { setLevelMsg(said(await api.setLevel(level), `The ledger level is now ${level}.`)); } finally { setBusy(null); void refresh(); }
  };

  const saved = summary?.saved ?? 'off';
  return (
    <div data-testid="claim-ledger-settings">
      <div style={heading}>Claim ledger</div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={label}>Ledger level</span>
          <span style={hint}>The most any agent may use. Each agent also needs its own entry in memory-sources.json.</span>
        </div>
        <div role="radiogroup" aria-label="Ledger level" style={{ display: 'flex', gap: 4, flex: 'none' }}>
          {LEVELS.map((l) => (
            <PixelButton key={l} size="sm" variant={saved === l ? 'primary' : 'secondary'} disabled={busy !== null || saved === l} onClick={() => void setLevel(l)}>{l}</PixelButton>
          ))}
        </div>
      </div>
      <Message result={levelMsg} />

      <div style={{ ...hint, marginTop: 12, marginBottom: 6 }}>Agents with a ledger</div>
      {!summary || summary.agents.length === 0
        ? <div style={hint}>No agent has a claim ledger yet.</div>
        : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {summary.agents.map((a) => (
              <div key={a.agentId} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0' }}>
                <span style={{ ...label, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{a.agentId}</span>
                <span style={hint}>{a.level} · {a.claims} claims</span>
                {a.readOnly && <span style={{ ...hint, color: 'var(--cth-status-blocked)' }}>read-only</span>}
                <PixelButton size="sm" variant={agentId === a.agentId ? 'primary' : 'secondary'} onClick={() => setAgentId(agentId === a.agentId ? null : a.agentId)}>
                  {agentId === a.agentId ? 'close' : 'open'}
                </PixelButton>
              </div>
            ))}
          </div>
        )}
      {agentId && <AgentLedger key={agentId} agentId={agentId} onChanged={refresh} />}
    </div>
  );
}

function AgentLedger({ agentId, onChanged }: { agentId: string; onChanged: () => void }) {
  const api = window.cth.claimsUi;
  const [view, setView] = useState<LedgerUiAgentView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Status | 'all'>('live');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [pref, setPref] = useState('');
  const [prefKey, setPrefKey] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const v = await api.view(agentId);
    if ('error' in v) { setError(v.error); setView(null); } else { setError(null); setView(v); }
  }, [api, agentId]);
  useEffect(() => { void load(); }, [load]);

  const act = async (fn: () => Promise<LedgerUiResult>, done: string) => {
    setBusy(true);
    try { const r = await fn(); setMsg(said(r, done)); if (r.ok) { await load(); onChanged(); } return r; } finally { setBusy(false); }
  };

  const shown = useMemo(() => {
    if (!view) return [];
    const q = query.trim().toLowerCase();
    return view.claims
      .filter((c) => (filter === 'all' || c.status === filter) && (!q || c.text.toLowerCase().includes(q) || c.id.includes(q) || (c.key ?? '').toLowerCase().includes(q)))
      .slice().reverse();
  }, [view, filter, query]);

  if (error) return <div style={{ ...box, marginTop: 10 }}><div style={{ ...hint, color: 'var(--cth-status-blocked)' }}>{error}</div></div>;
  if (!view) return <div style={{ ...box, marginTop: 10 }}><div style={hint}>Reading {agentId}'s ledger...</div></div>;
  const prefLen = [...pref].length;
  const readOnly = view.readOnly !== null;

  return (
    <div data-testid="claim-ledger-agent" style={{ ...box, marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ ...label, flex: 1 }}>{agentId} <span style={hint}>· {view.level}</span></span>
        <PixelButton size="sm" variant="secondary" disabled={busy || view.level !== 'writer'}
          title={view.level === 'writer' ? 'Replace memory.md with a complete export of this ledger' : 'Only a writer agent has an export'}
          onClick={() => void act(() => api.exportNow(agentId), 'memory.md exported.')}>export memory.md</PixelButton>
      </div>
      {readOnly && <div style={{ ...hint, color: 'var(--cth-status-blocked)' }}>This ledger is read-only ({view.readOnly}). Nothing can be written until the Human resolves it.</div>}

      {!readOnly && <div>
        <div style={{ ...hint, marginBottom: 4 }}>Add a preference (yours, kept as a Human claim in {agentId}'s ledger)</div>
        <textarea aria-label="Preference" value={pref} onChange={(e) => setPref(e.target.value)} rows={2} disabled={readOnly}
          placeholder="e.g. Always resolve the base from origin, never a local branch." style={{ ...input, resize: 'vertical' }} />
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
          <input aria-label="Preference key" value={prefKey} onChange={(e) => setPrefKey(e.target.value)} placeholder="pref.* key (optional)" style={{ ...input, width: 160 }} disabled={readOnly} />
          <span style={{ ...hint, flex: 1, color: prefLen > TEXT_MAX ? 'var(--cth-status-blocked)' : hint.color }}>
            {prefLen}/{TEXT_MAX}{prefLen > TEXT_MAX ? ': too long (it is refused, never cut)' : ''}
          </span>
          <PixelButton size="sm" disabled={busy || readOnly || !pref.trim() || prefLen > TEXT_MAX}
            onClick={() => void act(() => api.addPreference(agentId, pref, prefKey.trim() || undefined), 'Preference added.').then((r) => { if (r.ok) { setPref(''); setPrefKey(''); } })}>add preference</PixelButton>
        </div>
      </div>}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
        {(['all', ...UI_STATUSES] as const).map((s) => (
          <PixelButton key={s} size="sm" variant={filter === s ? 'primary' : 'ghost'} onClick={() => setFilter(s)}>
            {s} {s === 'all' ? view.claims.length : view.counts[s]}
          </PixelButton>
        ))}
        <input aria-label="Search claims" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="search" style={{ ...input, width: 140, marginLeft: 'auto' }} />
      </div>
      <Message result={msg} />

      <div role="list" style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 320, overflowY: 'auto' }}>
        {shown.length === 0 && <div style={hint}>No {filter === 'all' ? '' : `${filter} `}claims.</div>}
        {shown.slice(0, LIST_MAX).map((c) => (
          <ClaimRow key={c.id} c={c} open={open === c.id} onToggle={() => setOpen(open === c.id ? null : c.id)}>
            {open === c.id && <ClaimDetail view={view} claim={c} busy={busy} readOnly={readOnly}
              onRevert={(eventId) => void act(() => api.revert(agentId, eventId), 'Reverted.')}
              onPurge={(typed) => act(() => api.purge(agentId, [c.id], typed), 'Purged.')} />}
          </ClaimRow>
        ))}
        {shown.length > LIST_MAX && <div style={hint}>Showing the newest {LIST_MAX} of {shown.length}; search to narrow.</div>}
      </div>
    </div>
  );
}

function ClaimRow({ c, open, onToggle, children }: { c: LedgerUiClaim; open: boolean; onToggle: () => void; children?: React.ReactNode }) {
  return (
    <div role="listitem" data-claim={c.id} style={{ borderTop: '1px solid var(--cth-ink-200, var(--cth-ink-300))', padding: '4px 0' }}>
      <button type="button" onClick={onToggle} aria-expanded={open} style={{ all: 'unset', cursor: 'pointer', display: 'flex', gap: 6, alignItems: 'baseline', width: '100%' }}>
        <span style={{ flex: 'none', width: 80 }}><StatusBadge status={c.status} /></span>
        <span style={{ ...hint, flex: 'none', width: 104, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.kind}{c.source === 'human' ? ' · you' : ''}</span>
        <span style={{
          fontSize: 12, lineHeight: '16px', color: c.status === 'live' ? 'var(--cth-ink-900)' : 'var(--cth-ink-500)', flex: 1, minWidth: 0,
          overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: open ? 'unset' : 2, WebkitBoxOrient: 'vertical', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
        }}>{c.text}</span>
      </button>
      {children}
    </div>
  );
}

function ClaimDetail({ view, claim, busy, readOnly, onRevert, onPurge }: {
  view: LedgerUiAgentView; claim: LedgerUiClaim; busy: boolean; readOnly: boolean;
  onRevert: (eventId: string) => void; onPurge: (typed: string) => Promise<LedgerUiResult>;
}) {
  const h = useMemo(() => claimHistory(view, claim.id), [view, claim.id]);
  const [purging, setPurging] = useState(false);
  const [typed, setTyped] = useState('');
  return (
    <div data-testid="claim-detail" style={{ margin: '6px 0 4px 8px', paddingLeft: 8, borderLeft: '2px solid var(--cth-ink-300)', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={hint}>
        {claim.id} · written {claim.wt.slice(0, 16).replace('T', ' ')}Z{claim.key ? ` · key ${claim.key}` : ''}{claim.sightings ? ` · seen ${claim.sightings} more time${claim.sightings === 1 ? '' : 's'}` : ''}{claim.pinned ? ' · pinned' : ''}
        {claim.refs?.length ? ` · refs: ${claim.refs.map((r) => `${r.type} ${r.value}`).join(', ')}` : ''}
      </div>
      <div>
        <div style={{ ...hint, color: 'var(--cth-ink-700)', marginBottom: 2 }}>Why it believes this</div>
        <ol style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {h.items.map((it, i) => (
            <li key={`${it.id}-${i}`} style={{ fontSize: 12, lineHeight: '16px', color: it.reverted ? 'var(--cth-ink-500)' : 'var(--cth-ink-900)' }}>
              <span style={{ textDecoration: it.reverted ? 'line-through' : 'none' }}>{it.at.slice(0, 16).replace('T', ' ')}Z {it.text}</span>
              {it.reverted && <span style={hint}> (reverted)</span>}
              {it.revert && !readOnly && (
                <PixelButton size="sm" variant="ghost" disabled={busy} style={{ marginLeft: 6, height: 18 }} onClick={() => onRevert(it.revert as string)}>revert</PixelButton>
              )}
            </li>
          ))}
        </ol>
        {h.reasons.length > 0 && <div style={{ ...hint, marginTop: 2 }}>Status now: {h.status}, because {h.reasons.join('; ')}.</div>}
      </div>
      {claim.status !== 'purged' && !readOnly && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          {!purging
            ? <PixelButton size="sm" variant="destructive" disabled={busy} onClick={() => setPurging(true)}>purge...</PixelButton>
            : (<>
                <span style={{ ...hint, color: 'var(--cth-status-blocked)' }}>Erase this claim's text for good? Type <b>{PURGE_WORD}</b>:</span>
                <input aria-label="Type purge to confirm" value={typed} onChange={(e) => setTyped(e.target.value)} style={{ ...input, width: 90 }} autoFocus />
                <PixelButton size="sm" variant="destructive" disabled={busy || typed !== PURGE_WORD} onClick={() => void onPurge(typed).then((r) => { if (r.ok || r.cancelled) { setPurging(false); setTyped(''); } })}>purge</PixelButton>
                <PixelButton size="sm" variant="ghost" onClick={() => { setPurging(false); setTyped(''); }}>cancel</PixelButton>
              </>)}
        </div>
      )}
    </div>
  );
}
