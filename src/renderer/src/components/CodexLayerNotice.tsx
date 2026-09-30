/**
 * CODEX-TRUST-LAYER (1.1.76, the Human's ruling): a Codex agent whose project folder carries its
 * own codex MCP servers, hooks or command rules that only OUR trust seed would load is NOT started
 * (they would run unreviewed: MCP servers as soon as the agent starts, hooks on its first turn;
 * in auto mode unsandboxed). Main says so here, with the reason, whatever path spawned the agent
 * (Add Agent, restore, autorevive, restart), and one click allows the folder: the opt-in text
 * says plainly that the folder's hooks and MCP servers then run unreviewed (Jim R3). A folder the
 * user's own codex trust list trusts, or one already allowed, starts with a warning shown here.
 */
import { useEffect, useState } from 'react';
import type { CodexLayerNoticeView } from '../../../preload';

export const CODEX_LAYER_COPY = {
  refusedTitle: 'Codex agent not started',
  warnTitle: 'Codex agent started with unreviewed project config',
  allow: 'Allow this folder',
  allowHint: 'Allowing it means the hooks and MCP servers in this folder will run unreviewed in hive Codex agents (in auto mode, unsandboxed). You can withdraw it in Settings.',
  allowedThen: 'Allowed. Start the agent again (Restart, or restore the team) and it starts with a warning.',
  dismiss: 'OK'
};

/** The notices as the banner shows them: refusals first, newest first. Pure (tested). */
export function orderCodexLayerNotices(ns: readonly CodexLayerNoticeView[]): CodexLayerNoticeView[] {
  return [...ns].sort((a, b) => (a.action === b.action ? b.at - a.at : a.action === 'refuse' ? -1 : 1));
}

export function CodexLayerNotice() {
  const [notices, setNotices] = useState<CodexLayerNoticeView[]>([]);
  const [allowed, setAllowed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void window.cth.codexLayerNotices?.().then((n) => { if (alive) setNotices(n); }).catch(() => { /* older main */ });
    const off = window.cth.onCodexLayerNotices?.((n) => setNotices(n));
    return () => { alive = false; off?.(); };
  }, []);
  if (!notices.length && !allowed) return null;
  const allow = async (key: string) => {
    const r = await window.cth.codexLayerAllow(key).catch((e: unknown) => ({ ok: false, error: String(e) }));
    if (r.ok) { setAllowed(key); setError(null); } else setError(r.error ?? 'Could not allow the folder.');
  };
  return (
    <div
      role="alert"
      data-testid="codex-layer-notice"
      style={{
        position: 'fixed', right: 16, top: 48, zIndex: 1000, maxWidth: 460, maxHeight: '60vh', overflowY: 'auto',
        padding: '10px 12px', background: 'var(--cth-paper-100, #fff)', color: 'var(--cth-ink-900, #1d1d1b)',
        border: '2px solid var(--cth-ink-900, #1d1d1b)', boxShadow: '4px 4px 0 var(--cth-ink-900, #1d1d1b)',
        fontFamily: 'var(--cth-font-ui, system-ui)', fontSize: 12.5, lineHeight: 1.5, display: 'flex', flexDirection: 'column', gap: 10
      }}
    >
      {allowed && (
        <div data-testid="codex-layer-allowed">
          {CODEX_LAYER_COPY.allowedThen}
          <button type="button" onClick={() => setAllowed(null)} style={{ marginLeft: 8, fontSize: 12 }}>{CODEX_LAYER_COPY.dismiss}</button>
        </div>
      )}
      {error && <div style={{ color: 'var(--cth-status-blocked)' }}>{error}</div>}
      {orderCodexLayerNotices(notices).map((n) => (
        <div key={`${n.at}-${n.agentId}`} data-codex-layer-action={n.action}>
          <strong>{n.action === 'refuse' ? CODEX_LAYER_COPY.refusedTitle : CODEX_LAYER_COPY.warnTitle}{n.agentId ? `: ${n.agentId}` : ''}</strong>
          <div style={{ fontFamily: 'var(--cth-font-mono, monospace)', fontSize: 11.5 }}>{n.folder}</div>
          <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{n.reason}</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 4, alignItems: 'center', flexWrap: 'wrap' }}>
            {n.action === 'refuse' && n.optInKey && (
              <button type="button" onClick={() => void allow(n.optInKey)} style={{ fontSize: 12 }}>{CODEX_LAYER_COPY.allow}</button>
            )}
            <button type="button" onClick={() => void window.cth.codexLayerDismiss(n.at)} style={{ fontSize: 12 }}>{CODEX_LAYER_COPY.dismiss}</button>
          </div>
          {n.action === 'refuse' && n.optInKey && <div style={{ fontSize: 11.5, color: 'var(--cth-ink-500)' }}>{CODEX_LAYER_COPY.allowHint}</div>}
        </div>
      ))}
    </div>
  );
}

/** Settings: the folders allowed so far, each withdrawable. */
export function CodexLayerOptInsSetting() {
  const [keys, setKeys] = useState<string[]>([]);
  useEffect(() => {
    void window.cth.getConfig().then((c) => setKeys(Array.isArray(c?.codexLayerOptIns) ? c.codexLayerOptIns : [])).catch(() => { /* none */ });
  }, []);
  const revoke = async (k: string) => {
    await window.cth.codexLayerRevoke(k).catch(() => ({ ok: false }));
    const c = await window.cth.getConfig().catch(() => null);
    setKeys(Array.isArray(c?.codexLayerOptIns) ? c.codexLayerOptIns : []);
  };
  return (
    <div data-codex-layer-optins="" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ fontSize: 13, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>Folders whose codex project config may run unreviewed</span>
      {keys.length === 0 && <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>None. A Codex agent in a folder with its own codex hooks, MCP servers or command rules is not started until you allow that folder.</span>}
      {keys.map((k) => (
        <div key={k} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ fontFamily: 'var(--cth-font-mono, monospace)', fontSize: 11.5, wordBreak: 'break-all' }}>{k}</span>
          <button type="button" onClick={() => void revoke(k)} style={{ fontSize: 12 }}>Withdraw</button>
        </div>
      ))}
    </div>
  );
}
