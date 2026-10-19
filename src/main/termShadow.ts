/**
 * GOD-TERMINAL-CONTROL: the shadow diff. Each screen-gate reading is also taken from the host that
 * did NOT answer the gate (the renderer's xterm or main's headless mirror; screenGate.ts), read
 * afterwards and never awaited, and the two are compared. It DECIDES NOTHING: the default source
 * flips to the mirror only on these counts (design section 13a, the flip bar).
 *
 * GTC M2: both readings. The erase oracle on onPromptRow, screenCount and promptTailMatches; the
 * Codex reading on its facts (shared/codexScreen.ts), promptTailMatches and the gate's own class.
 *
 * A comparison is only evidence when no output arrived between the gate's request and the second
 * read (outputGeneration unchanged); otherwise it is counted as `moving` and never as a disagreement.
 * A reading one host could not give is no comparison: it is counted on its own ('renderer null,
 * mirror answered' is a never-opened tab, the case M2 exists for; fixtures judge those).
 */
import type { AgentProvider } from '../shared/agentProvider';
import { classifyCodexComposer, type CodexScreenFacts } from '../shared/codexScreen';
import { classifyTuiComposer } from '../shared/tuiComposer';

export const SHADOW_FIELDS = ['header', 'startingAfterHeader', 'cursorRow', 'footer', 'tail'] as const;
/** GTC M2: the erase oracle's decision fields. */
export const NEEDLE_FIELDS = ['onPromptRow', 'screenCount', 'promptTailMatches'] as const;
/** At most one disagreement row per PTY in this window. */
export const SHADOW_ROW_GAP_MS = 5_000;
export const SHADOW_SUMMARY_MS = 10 * 60_000;

export type ReadingKind = 'needle' | 'codex';
export type ScreenHost = 'renderer' | 'mirror';
export type ShadowVerdict = 'agree' | 'disagree' | 'moving' | 'rendererNull' | 'mirrorNull' | 'bothNull';

/** One host's answer to a screen-gate request (automaticSubmit.ts ScreenReading). */
export interface GateReading {
  onPromptRow: boolean;
  screenCount: number;
  promptTailMatches?: boolean;
  codex?: CodexScreenFacts;
}

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

/** GTC M2: the decision fields on which the two hosts' readings differ. A Codex reading with no
 *  facts on one side differs on 'codex'; a different gate class is the field 'class'. */
export function readingDiff(kind: ReadingKind, provider: AgentProvider | null, renderer: GateReading, mirror: GateReading): string[] {
  if (kind === 'needle') return NEEDLE_FIELDS.filter((k) => renderer[k] !== mirror[k]);
  const out: string[] = renderer.promptTailMatches !== mirror.promptTailMatches ? ['promptTailMatches'] : [];
  if (!renderer.codex || !mirror.codex) return renderer.codex || mirror.codex ? [...out, 'codex'] : out;
  out.push(...factsDiff(renderer.codex, mirror.codex));
  if (gateClass(provider, renderer.codex) !== gateClass(provider, mirror.codex)) out.push('class');
  return out;
}

export interface ShadowSample {
  agentId: string | null;
  ptyId: string;
  provider: AgentProvider | null;
  kind: ReadingKind;
  /** The host whose reading the gate acted on. */
  answeredBy: ScreenHost;
  renderer: GateReading | null;
  mirror: GateReading | null;
  /** No output arrived between the gate request and the second host's read. */
  still: boolean;
}

type Counts = Record<ShadowVerdict, number>;
const zero = (): Counts => ({ agree: 0, disagree: 0, moving: 0, rendererNull: 0, mirrorNull: 0, bothNull: 0 });

export class ShadowDiff {
  private lastRowAt = new Map<string, number>();
  /** Per reading kind x provider (`codex/claude`): the flip bar counts each bucket on its own. */
  private counts = new Map<string, Counts>();
  private summaryAt: number;

  constructor(private readonly log: (row: Record<string, unknown>) => void, private readonly now: () => number) {
    this.summaryAt = now();
  }

  /** Returns the verdict it recorded. */
  record(s: ShadowSample): ShadowVerdict {
    const t = this.now();
    let verdict: ShadowVerdict;
    if (!s.renderer || !s.mirror) verdict = s.renderer ? 'mirrorNull' : s.mirror ? 'rendererNull' : 'bothNull';
    else if (!s.still) verdict = 'moving';
    else {
      const fields = readingDiff(s.kind, s.provider, s.renderer, s.mirror);
      verdict = fields.length === 0 ? 'agree' : 'disagree';
      if (verdict === 'disagree' && t - (this.lastRowAt.get(s.ptyId) ?? -Infinity) >= SHADOW_ROW_GAP_MS) {
        this.lastRowAt.set(s.ptyId, t);
        // The facts are already bounded (codexScreen cuts each row; footer/tail are capped).
        this.log({
          kind: 'term-shadow', reading: s.kind, answeredBy: s.answeredBy, agentId: s.agentId, ptyId: s.ptyId, provider: s.provider, fields,
          ...(s.kind === 'codex' && s.renderer.codex && s.mirror.codex
            ? { rendererClass: gateClass(s.provider, s.renderer.codex), mirrorClass: gateClass(s.provider, s.mirror.codex) }
            : {}),
          renderer: pick(s.renderer, fields), mirror: pick(s.mirror, fields)
        });
      }
    }
    const key = `${s.kind}/${s.provider ?? 'unknown'}`;
    const c = this.counts.get(key) ?? zero();
    c[verdict] += 1;
    this.counts.set(key, c);
    if (t - this.summaryAt >= SHADOW_SUMMARY_MS) {
      const total = zero();
      for (const v of this.counts.values()) for (const k of Object.keys(total) as ShadowVerdict[]) total[k] += v[k];
      this.log({ kind: 'term-shadow-summary', ...total, by: Object.fromEntries([...this.counts].sort(([a], [b]) => a.localeCompare(b))) });
      this.counts = new Map();
      this.summaryAt = t;
    }
    return verdict;
  }

  forget(ptyId: string): void { this.lastRowAt.delete(ptyId); }
}

/** The differing fields of one reading (the Codex facts' own keys from its facts, always with the
 *  tail so a real difference can be judged), bounded as the facts are. */
function pick(r: GateReading, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of fields) {
    if (k === 'class' || k === 'codex') continue;
    if ((NEEDLE_FIELDS as readonly string[]).includes(k)) out[k] = (r as unknown as Record<string, unknown>)[k];
    else if (r.codex) out[k] = (r.codex as unknown as Record<string, unknown>)[k];
  }
  if (r.codex) { out.cursorRow = r.codex.cursorRow; out.tail = r.codex.tail; }
  return out;
}
