/**
 * ZERO-TOKEN-LIVENESS: the liveness chip on a Command Center agent card, and the floor summary.
 *
 * Renders shared/livenessView.ts and nothing else. The offered actions are BUTTONS: each handler is
 * called only from that button's onClick. This file has no effect hook and calls no handler while
 * rendering, so a re-render, a liveness edge or a periodic sample can never restart an agent or
 * re-offer mail (Jim L3; tests/command-center-liveness.test.cjs pins it).
 */
import type { LivenessClassification, LivenessV1 } from '@shared/livenessV1';
import { livenessChipView, livenessSummary, type LivenessAction, type LivenessTone } from '@shared/livenessView';

const TONE_STYLE: Record<LivenessTone, { bg: string; fg: string }> = {
  green: { bg: 'var(--cth-mint-light)', fg: 'var(--cth-ink-900)' },
  neutral: { bg: 'var(--cth-paper-200)', fg: 'var(--cth-ink-700)' },
  amber: { bg: 'var(--cth-lemon-light)', fg: 'var(--cth-ink-900)' },
  red: { bg: 'var(--cth-coral-light)', fg: 'var(--cth-ink-900)' },
  dark: { bg: 'var(--cth-ink-700)', fg: 'var(--cth-paper-100)' }
};

const ACTION_LABEL: Record<LivenessAction, string> = {
  inspect: 'inspect',
  'restart-continue': 'restart & continue',
  reoffer: 're-offer mail'
};

export interface LivenessChipProps {
  rec: LivenessV1 | undefined;
  now: number;
  /** Show the agent's terminal (no model work). */
  onInspect?: () => void;
  /** The existing Restart & Continue (starts model work: a click only). */
  onRestartContinue?: () => void;
  /** Re-offer waiting mail after the stuck-wake watchdog gave up (starts model work: a click only). */
  onReoffer?: () => void;
}

export function LivenessChip({ rec, now, onInspect, onRestartContinue, onReoffer }: LivenessChipProps) {
  if (!rec) return null;
  const view = livenessChipView(rec, now);
  const tone = TONE_STYLE[view.tone];
  const handlerFor = (action: LivenessAction): (() => void) | undefined =>
    action === 'inspect' ? onInspect : action === 'restart-continue' ? onRestartContinue : onReoffer;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span
        data-liveness={rec.classification}
        title={view.detail.join('\n')}
        style={{
          fontSize: 10, padding: '1px 5px', background: tone.bg, color: tone.fg,
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', whiteSpace: 'nowrap'
        }}
      >{view.label} · {view.duration}</span>
      {view.actions.map((action) => {
        const handler = handlerFor(action);
        if (!handler) return null;
        return (
          <button
            key={action}
            type="button"
            onClick={() => handler()}
            style={{ fontSize: 10, padding: '0 4px', cursor: 'pointer', border: '1px solid var(--cth-ink-300)', background: 'var(--cth-paper-100)' }}
          >{ACTION_LABEL[action]}</button>
        );
      })}
    </span>
  );
}

const SUMMARY_ORDER: LivenessClassification[] = ['BUSY_PROGRESSING', 'IDLE', 'SUSPECT', 'STUCK_WAKE', 'CRASHED', 'EXITED', 'UNKNOWN'];
const SUMMARY_LABEL: Record<LivenessClassification, string> = {
  BUSY_PROGRESSING: 'busy', IDLE: 'idle', SUSPECT: 'suspect', STUCK_WAKE: 'stuck', CRASHED: 'crashed', EXITED: 'exited', UNKNOWN: 'unknown'
};

/** "busy 3 · idle 4 · stuck 1": the floor's LIVE agents per classification. */
export function LivenessSummary({ records }: { records: readonly LivenessV1[] }) {
  const counts = livenessSummary(records);
  const parts = SUMMARY_ORDER.filter((c) => (counts[c] ?? 0) > 0).map((c) => `${SUMMARY_LABEL[c]} ${counts[c]}`);
  if (!parts.length) return null;
  return <div style={{ fontSize: 11, color: 'var(--cth-ink-500)', marginBottom: 4 }}>liveness: {parts.join(' · ')}</div>;
}
