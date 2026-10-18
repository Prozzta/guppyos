/**
 * GOD-TERMINAL-CONTROL M1: the shadow diff. Every screen-gate reading the renderer answers is
 * compared with the same facts (shared/codexScreen.ts extractCodexScreen) read from main's headless
 * mirror, and judged by the same classifier the gate uses. It DECIDES NOTHING: M2 moves the gate onto
 * the mirror only after these rows show the two agree on the live floor.
 *
 * A comparison is only evidence when no output arrived between the gate's request and the mirror
 * read (outputGeneration unchanged); otherwise it is counted as `moving` and never as a disagreement.
 */
import type { AgentProvider } from '../shared/agentProvider';
import { classifyCodexComposer, type CodexScreenFacts } from '../shared/codexScreen';
import { classifyTuiComposer } from '../shared/tuiComposer';

export const SHADOW_FIELDS = ['header', 'startingAfterHeader', 'cursorRow', 'footer', 'tail'] as const;
/** At most one disagreement row per PTY in this window. */
export const SHADOW_ROW_GAP_MS = 5_000;
export const SHADOW_SUMMARY_MS = 10 * 60_000;

/** The fields on which two readings of the same bytes differ. */
export function factsDiff(a: CodexScreenFacts, b: CodexScreenFacts): string[] {
  const out: string[] = [];
  for (const k of SHADOW_FIELDS) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(k);
  return out;
}

/** The gate's own class for these facts: Codex's composer classifier, or the TUI one for claude/agy. */
export function gateClass(provider: AgentProvider | null, f: CodexScreenFacts): string {
  if (provider === 'codex') return classifyCodexComposer(f).cls;
  if (provider === 'claude' || provider === 'antigravity') return classifyTuiComposer(provider, f).cls;
  return 'n/a';
}

export interface ShadowSample {
  agentId: string | null;
  ptyId: string;
  provider: AgentProvider | null;
  gate: CodexScreenFacts;
  mirror: CodexScreenFacts;
  /** No output arrived between the gate request and the mirror read. */
  still: boolean;
}

export class ShadowDiff {
  private lastRowAt = new Map<string, number>();
  private counts = { agree: 0, disagree: 0, moving: 0 };
  private summaryAt: number;

  constructor(private readonly log: (row: Record<string, unknown>) => void, private readonly now: () => number) {
    this.summaryAt = now();
  }

  /** Returns the verdict it recorded. */
  record(s: ShadowSample): 'agree' | 'disagree' | 'moving' {
    const t = this.now();
    let verdict: 'agree' | 'disagree' | 'moving';
    if (!s.still) verdict = 'moving';
    else {
      const fields = factsDiff(s.gate, s.mirror);
      const gc = gateClass(s.provider, s.gate);
      const mc = gateClass(s.provider, s.mirror);
      verdict = fields.length === 0 && gc === mc ? 'agree' : 'disagree';
      if (verdict === 'disagree' && t - (this.lastRowAt.get(s.ptyId) ?? -Infinity) >= SHADOW_ROW_GAP_MS) {
        this.lastRowAt.set(s.ptyId, t);
        // The facts are already bounded (codexScreen cuts each row; footer/tail are capped).
        this.log({ kind: 'term-shadow', agentId: s.agentId, ptyId: s.ptyId, provider: s.provider, fields, gateClass: gc, mirrorClass: mc, gate: pick(s.gate, fields), mirror: pick(s.mirror, fields) });
      }
    }
    this.counts[verdict] += 1;
    if (t - this.summaryAt >= SHADOW_SUMMARY_MS) {
      this.log({ kind: 'term-shadow-summary', ...this.counts });
      this.counts = { agree: 0, disagree: 0, moving: 0 };
      this.summaryAt = t;
    }
    return verdict;
  }

  forget(ptyId: string): void { this.lastRowAt.delete(ptyId); }
}

function pick(f: CodexScreenFacts, fields: string[]): Record<string, unknown> {
  const keys = fields.length ? fields : ['cursorRow'];
  return Object.fromEntries(keys.map((k) => [k, (f as unknown as Record<string, unknown>)[k]]));
}
