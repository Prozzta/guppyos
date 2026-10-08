/**
 * READS-ROTATE-AT-SIZE pilot (1.1.81): Claude Code's OWN auto-compact window, set per agent.
 *
 * Every request re-reads the whole conversation, and god's grew to ~300k per request before the
 * app's context trigger (a 2-hour timer, 40% of a 1M window = 400k) ever fired (10-02: 142
 * requests, 24.5M reads). Claude Code 2.1.288 compacts by itself once the context passes its
 * auto-compact window, which `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (or the `autoCompactWindow`
 * setting) sets: "auto", or 100k-1M tokens. Claude picks the moment, mid-turn included, and our
 * hooks re-inject the mail the turn already surfaced at SessionStart(compact) (ZT-I1-MAIL 11.5).
 * Replayed on god's 10-02/03 session, a ~150k window saves about 40% billed-equivalent (Jim's
 * MIN-CONTEXT-TECH.md; Creed re-checked: 40-48%). The Human approved a god-only pilot (2026-10-03).
 *
 * READS-AUTOCOMPACT-ROLLOUT (1.1.84): the god pilot passed (re-read per request -60%, cost per
 * request -52%; Creed's after-run), so the window is now the default for EVERY Claude agent.
 *
 * Resolution, first match wins:
 *   1. the agent's own `autoCompactWindow` (registry: a number or "off");
 *   2. god only: the config's `godAutoCompactWindow` (the pilot's setting, kept: "off" still
 *      switches god off);
 *   3. the config's `claudeAutoCompactWindow` (every Claude agent; "off" = Claude's own "auto");
 *   4. AUTO_COMPACT_WINDOW_DEFAULT.
 * Unknown agent (no registry record): null. Only Claude spawns read this (Codex has its own
 * auto_compact_token_limit, codexAgentConfig.ts). Pure.
 */

export const AUTO_COMPACT_WINDOW_ENV = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW';
export const AUTO_COMPACT_WINDOW_DEFAULT = 150_000;
/** The pilot's name for the same default (god got it first). */
export const GOD_AUTO_COMPACT_WINDOW_DEFAULT = AUTO_COMPACT_WINDOW_DEFAULT;
/** The range Claude Code accepts ("100k to 1M tokens"). */
export const AUTO_COMPACT_WINDOW_MIN = 100_000;
export const AUTO_COMPACT_WINDOW_MAX = 1_000_000;

export type AutoCompactSetting = number | 'off';

/** A setting as written (a number of tokens, or "off"); anything else (out of range, a string
 *  that is not "off", NaN) is ignored, so a bad value can never reach Claude Code. */
export function normalizeAutoCompactWindow(v: unknown): AutoCompactSetting | undefined {
  if (v === 'off' || v === false) return 'off';
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  const n = Math.round(v);
  return n >= AUTO_COMPACT_WINDOW_MIN && n <= AUTO_COMPACT_WINDOW_MAX ? n : undefined;
}

/** The window (tokens) this agent's Claude Code gets, or null = leave Claude's own "auto". */
export interface AutoCompactConfig { godAutoCompactWindow?: unknown; claudeAutoCompactWindow?: unknown }

export function autoCompactWindowFor(
  agent: { isGod?: boolean; autoCompactWindow?: unknown } | null | undefined,
  cfg: AutoCompactConfig | null | undefined
): number | null {
  if (!agent) return null;
  const own = normalizeAutoCompactWindow(agent.autoCompactWindow);
  if (own !== undefined) return own === 'off' ? null : own;
  if (agent.isGod === true) {
    const god = normalizeAutoCompactWindow(cfg?.godAutoCompactWindow);
    if (god !== undefined) return god === 'off' ? null : god;
  }
  const floor = normalizeAutoCompactWindow(cfg?.claudeAutoCompactWindow);
  if (floor === 'off') return null;
  return floor ?? AUTO_COMPACT_WINDOW_DEFAULT;
}

export type AutoCompactSettingName = 'autoCompactWindow' | 'godAutoCompactWindow' | 'claudeAutoCompactWindow';

/** n1 (Creed): the settings that were SET but are invalid and so ignored (a typo would otherwise
 *  silently mean the 150k default, or Claude's "auto"). Only the ones that apply to this agent:
 *  a setting is reported only when nothing valid ahead of it in the resolution order decided. */
export function autoCompactWindowIgnored(
  agent: { isGod?: boolean; autoCompactWindow?: unknown } | null | undefined,
  cfg: AutoCompactConfig | null | undefined
): Array<{ setting: AutoCompactSettingName; value: string }> {
  const out: Array<{ setting: AutoCompactSettingName; value: string }> = [];
  if (!agent) return out;
  const shown = (v: unknown): string => String(typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 40);
  const steps: Array<[AutoCompactSettingName, unknown, boolean]> = [
    ['autoCompactWindow', agent.autoCompactWindow, true],
    ['godAutoCompactWindow', cfg?.godAutoCompactWindow, agent.isGod === true],
    ['claudeAutoCompactWindow', cfg?.claudeAutoCompactWindow, true],
  ];
  for (const [setting, v, applies] of steps) {
    if (!applies || v === undefined) continue;
    if (normalizeAutoCompactWindow(v) !== undefined) break;   // a valid setting decides; later ones are moot
    out.push({ setting, value: shown(v) });
  }
  return out;
}

/** What one compaction did, from the transcript: Claude's own `compact_boundary` record and the
 *  usage of the FIRST request after it (the request that pays for the smaller context). */
export interface CompactHealth {
  /** The boundary record's uuid (each compaction is logged once). */
  uuid: string;
  /** "auto" (the window) or "manual" (a typed /compact, e.g. the app's trigger). */
  trigger: string | null;
  preTokens: number | null;
  postTokens: number | null;
  durationMs: number | null;
  at: string | null;
  /** The first request after the boundary: its context and its cost parts (tokens). */
  first: { context: number; input: number; cacheRead: number; cacheWrite: number; output: number; billedEquivalent: number } | null;
  /** READS-COMPACT-HEALTH (1.1.83): the compaction summary Claude wrote (its `isCompactSummary`
   *  record after the boundary), or null when it is not in the tail. */
  summary?: string | null;
  /** READS-COMPACT-HEALTH: ms from the agent's last request before the boundary to the boundary,
   *  or null. Over an hour the prompt cache has expired, so that compaction re-WRITES the context
   *  (Jim, 4eb6fec5 audit: about preTokens x 2 billed) instead of reading it. */
  idleBeforeMs?: number | null;
}

/** READS-COMPACT-HEALTH: Jim's 4eb6fec5 audit measured summaries at about 2.5 characters per token
 *  (chars/4 under-counts them by about 35%). */
export const SUMMARY_CHARS_PER_TOKEN = 2.5;
/** The prompt cache's lifetime: a compaction after a longer idle re-writes the context. */
export const CACHE_TTL_MS = 60 * 60 * 1000;

function textOf(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const parts = content.map((c) => (c && typeof c === 'object' && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : '')).filter(Boolean);
  return parts.length ? parts.join('\n') : null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** EVERY compaction in a transcript tail (JSONL), oldest first. One turn can hold several: a
 *  probe on Claude Code 2.1.288 (window 100k) compacted three times inside a single turn. `first`
 *  is null while no request has been answered after that boundary yet. Billed-equivalent as the
 *  app weighs it: input x1, cache reads x0.1, cache writes x2 (1-hour), output x1. */
export function compactHealthsFromTail(tail: string): CompactHealth[] {
  const lines = tail.split('\n');
  const out: CompactHealth[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].includes('"compact_boundary"')) continue;
    let r: Record<string, unknown>;
    try { r = JSON.parse(lines[i]) as Record<string, unknown>; } catch { continue; }
    if (r.type === 'system' && r.subtype === 'compact_boundary' && r.isSidechain !== true) out.push(healthAt(lines, i, r));
  }
  return out;
}

/** The LAST compaction in a transcript tail, or null when it has none. */
export function compactHealthFromTail(tail: string): CompactHealth | null {
  const all = compactHealthsFromTail(tail);
  return all.length ? all[all.length - 1] : null;
}

function healthAt(lines: readonly string[], at: number, rec: Record<string, unknown>): CompactHealth {
  const meta = (typeof rec.compactMetadata === 'object' && rec.compactMetadata !== null ? rec.compactMetadata : {}) as Record<string, unknown>;
  let first: CompactHealth['first'] = null;
  let summary: string | null = null;
  for (let i = at + 1; i < lines.length && (!first || summary === null); i += 1) {
    // The first request after THIS boundary, not one after a later boundary.
    if (lines[i].includes('"compact_boundary"')) break;
    const l = lines[i];
    if (summary === null && l.includes('"isCompactSummary"')) {
      try {
        const r = JSON.parse(l) as { isCompactSummary?: unknown; isSidechain?: unknown; message?: { content?: unknown } };
        if (r.isCompactSummary === true && r.isSidechain !== true) summary = textOf(r.message?.content) ?? '';
      } catch { /* a torn line */ }
      continue;
    }
    if (first) continue;
    if (!l.includes('"usage"')) continue;
    try {
      const r = JSON.parse(l) as { type?: unknown; isSidechain?: unknown; message?: { usage?: Record<string, unknown> } };
      const u = r.type === 'assistant' && r.isSidechain !== true ? r.message?.usage : undefined;
      if (!u) continue;
      const input = num(u.input_tokens) ?? 0; const cacheRead = num(u.cache_read_input_tokens) ?? 0;
      const cacheWrite = num(u.cache_creation_input_tokens) ?? 0; const output = num(u.output_tokens) ?? 0;
      first = { context: input + cacheRead + cacheWrite, input, cacheRead, cacheWrite, output, billedEquivalent: Math.round(input + 0.1 * cacheRead + 2 * cacheWrite + output) };
    } catch { /* a torn line */ }
  }
  const atText = typeof rec.timestamp === 'string' ? rec.timestamp : null;
  return {
    uuid: typeof rec.uuid === 'string' ? rec.uuid : `line-${at}`,
    trigger: typeof meta.trigger === 'string' ? meta.trigger : null,
    preTokens: num(meta.preTokens), postTokens: num(meta.postTokens), durationMs: num(meta.durationMs),
    at: atText,
    first,
    summary,
    idleBeforeMs: idleBefore(lines, at, atText)
  };
}

/** The gap from the agent's last request before line `at` (not past an earlier boundary) to `atText`. */
function idleBefore(lines: readonly string[], at: number, atText: string | null): number | null {
  const end = atText ? Date.parse(atText) : NaN;
  if (!Number.isFinite(end)) return null;
  for (let i = at - 1; i >= 0; i -= 1) {
    const l = lines[i];
    if (l.includes('"compact_boundary"')) return null;
    if (!l.includes('"assistant"') || !l.includes('"timestamp"')) continue;
    try {
      const r = JSON.parse(l) as { type?: unknown; isSidechain?: unknown; timestamp?: unknown };
      if (r.type !== 'assistant' || r.isSidechain === true || typeof r.timestamp !== 'string') continue;
      const t = Date.parse(r.timestamp);
      return Number.isFinite(t) ? Math.max(0, end - t) : null;
    } catch { /* a torn line */ }
  }
  return null;
}
