/**
 * GTC M2: which host answers the screen gate's two readings (design doc section 13 + 13a).
 *
 *   'renderer'  today's path: the renderer's xterm answers over IPC (ScreenReadingBroker), and the
 *               mirror is read AFTER it for the shadow diff.
 *   'mirror'    main's headless mirror answers (always at the PTY grid, fed before the renderer,
 *               works for a tab never opened). Whenever it has no reading, the renderer is asked
 *               exactly as today, so the worst case is today's behaviour. The renderer is then
 *               read for the shadow diff with `shadow: true` (it never aligns or redraws).
 *
 * The source is read at EVERY request: a rollback is one config write, no restart. The gate gets
 * the answering host's promise; the shadow read is never awaited by it and never feeds it.
 */
import type { AgentProvider } from '../shared/agentProvider';
import type { MirrorGateNull } from './pty';
import type { GateReading, ReadingKind, ScreenHost, ShadowSample } from './termShadow';

export type ScreenGateSource = 'renderer' | 'mirror';
/** Why 'mirror' was asked and the renderer answered (Jim SHOULD 2): the mirrors are auto-off, they
 *  failed (calibration or make), config turned them off, this one was seeded by a re-arm (MUST 1),
 *  there is no such PTY, the mirror's read gave nothing, or the session or its mirror was replaced
 *  while the read drained (a race, not the mirrors being off: Jim INFO 2). */
export type ScreenFallback = 'auto-off' | 'failed' | 'config-off' | 'seeded' | 'no-pty' | 'unreadable' | 'replaced';
export const SCREEN_SOURCE_SUMMARY_MS = 10 * 60_000;

export interface ScreenGateDeps {
  source(): ScreenGateSource;
  renderer(ptyId: string, needle: string, expectedTail: string | undefined, codex: boolean, shadow: boolean): Promise<GateReading | null>;
  mirror(ptyId: string, kind: ReadingKind, needle: string, expectedTail: string | undefined): Promise<{ reading: GateReading | null; reason?: MirrorGateNull; ms?: number }>;
  /** Why no mirror exists right now (PtyManager only knows there is none). */
  whyNoMirror(): 'auto-off' | 'failed' | 'config-off';
  generation(ptyId: string): number | undefined;
  who(ptyId: string): { agentId: string | null; provider: AgentProvider | null };
  record(s: ShadowSample): unknown;
  log(row: Record<string, unknown>): void;
  now(): number;
}

/** A config value as a source: anything but 'mirror' is the renderer. */
export function screenGateSourceOf(v: unknown): ScreenGateSource {
  return v === 'mirror' ? 'mirror' : 'renderer';
}

export function fallbackReason(reason: MirrorGateNull | undefined, whyNoMirror: () => 'auto-off' | 'failed' | 'config-off'): ScreenFallback {
  if (reason === 'no-mirror') return whyNoMirror();
  return reason ?? 'unreadable';
}

export function createScreenGate(d: ScreenGateDeps): {
  needle(ptyId: string, needle: string, expectedTail?: string): Promise<GateReading | null>;
  codex(ptyId: string, expectedTail?: string): Promise<GateReading | null>;
  forget(ptyId: string): void;
} {
  const lastSource = new Map<string, string>();
  let counts: Record<string, number> = {};
  let summaryAt = d.now();
  /** Jim SHOULD 2: main's sync ms per mirror reading, by kind, for the summary (the cost guard sees parse time only). */
  let readMs: Record<string, { n: number; ms: number; max: number }> = {};
  const took = (kind: ReadingKind, ms: number | undefined): void => {
    if (typeof ms !== 'number' || !Number.isFinite(ms)) return;
    const s = (readMs[kind] ??= { n: 0, ms: 0, max: 0 });
    s.n++; s.ms += ms; s.max = Math.max(s.max, ms);
  };

  /** A `screen-source` row the first time per PTY and on every change; a 10-min summary. */
  const note = (ptyId: string, requested: ScreenGateSource, answeredBy: ScreenHost, fallback?: ScreenFallback): void => {
    const sig = `${requested}:${answeredBy}:${fallback ?? ''}`;
    if (lastSource.get(ptyId) !== sig) {
      lastSource.set(ptyId, sig);
      d.log({ kind: 'screen-source', ptyId, agentId: d.who(ptyId).agentId, requested, answeredBy, ...(fallback ? { fallback } : {}) });
    }
    const key = fallback ? `fallback:${fallback}` : answeredBy;
    counts[key] = (counts[key] ?? 0) + 1;
    const t = d.now();
    if (t - summaryAt >= SCREEN_SOURCE_SUMMARY_MS) {
      const reads = Object.fromEntries(Object.entries(readMs).map(([k, v]) => [k, { n: v.n, ms: Math.round(v.ms * 10) / 10, max: Math.round(v.max * 10) / 10 }]));
      d.log({ kind: 'screen-source-summary', ...counts, ...(Object.keys(reads).length ? { mirrorReadMs: reads } : {}) });
      counts = {};
      readMs = {};
      summaryAt = t;
    }
  };

  const read = async (kind: ReadingKind, ptyId: string, needle: string, expectedTail: string | undefined): Promise<GateReading | null> => {
    const codex = kind === 'codex';
    const gen0 = d.generation(ptyId);
    const still = (): boolean => gen0 !== undefined && d.generation(ptyId) === gen0;
    const shadow = (answeredBy: ScreenHost, renderer: GateReading | null, mirror: GateReading | null): void => {
      try { d.record({ ...d.who(ptyId), ptyId, kind, answeredBy, renderer, mirror, still: still() }); } catch { /* the shadow never affects the gate */ }
    };
    const requested = d.source();
    if (requested === 'mirror') {
      let m: { reading: GateReading | null; reason?: MirrorGateNull; ms?: number };
      try { m = await d.mirror(ptyId, kind, needle, expectedTail); } catch { m = { reading: null, reason: 'unreadable' }; }
      took(kind, m.ms);
      if (m.reading) {
        const mine = m.reading;
        note(ptyId, requested, 'mirror');
        void d.renderer(ptyId, needle, expectedTail, codex, true).then((r) => shadow('mirror', r, mine), () => undefined);
        return mine;
      }
      note(ptyId, requested, 'renderer', fallbackReason(m.reason, d.whyNoMirror));
      return d.renderer(ptyId, needle, expectedTail, codex, false);
    }
    note(ptyId, requested, 'renderer');
    const reading = d.renderer(ptyId, needle, expectedTail, codex, false);
    void reading.then(async (r) => {
      const m = await d.mirror(ptyId, kind, needle, expectedTail);
      took(kind, m.ms);
      shadow('renderer', r, m.reading);
    }).catch(() => { /* the shadow never affects the gate */ });
    return reading;
  };

  return {
    needle: (ptyId, needle, expectedTail) => read('needle', ptyId, needle, expectedTail),
    codex: (ptyId, expectedTail) => read('codex', ptyId, '', expectedTail),
    forget: (ptyId) => { lastSource.delete(ptyId); }
  };
}
