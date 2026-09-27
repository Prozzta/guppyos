/**
 * CODEX-BLOAT-165 fix 2: the Codex tool-output cap (`tool_output_token_limit`) the app writes into
 * OUR per-agent Codex config.toml. Settings → Agents & Models; persisted as
 * `codexToolOutputTokenLimit` in the app config. Never written to the user's ~/.codex/config.toml.
 *
 * Verified on codex-cli 0.157.1 (CODEX-BLOAT-FIXES.md): the key is accepted by --strict-config
 * (a usize), and it bounds what the MODEL sees of each tool output on later requests. The unit is
 * Codex's estimated token (about 4 characters). An output over the cap keeps its beginning and end;
 * the middle is replaced by `…N tokens truncated…`. The model's own policy (10,000 for the current
 * models) still applies on top, which is why the maximum is 10,000. Codex reads config.toml
 * when it starts: a change reaches an agent at its next start.
 *
 * Pure; shared by main (validation, the config.toml writer) and the Settings control.
 */

export const CODEX_TOOL_OUTPUT_LIMIT_DEFAULT = 4000;
export const CODEX_TOOL_OUTPUT_LIMIT_MIN = 1000;
/** Codex's own policy truncates at 10,000 for every current model (models_cache.json), so a
 *  larger cap would change nothing (CB-165 audit F4). */
export const CODEX_TOOL_OUTPUT_LIMIT_MAX = 10000;

/** The stored setting: a token count, or 'off' (the key is omitted from our config.toml). */
export type CodexToolOutputLimitSetting = number | 'off';

/**
 * Normalise a stored or incoming value. 'off' stays 'off'; a finite number is rounded and clamped
 * to MIN..MAX; anything else is INVALID (null) and must not replace the stored value.
 */
export function normalizeCodexToolOutputLimit(v: unknown): CodexToolOutputLimitSetting | null {
  if (typeof v === 'string' && v.trim().toLowerCase() === 'off') return 'off';
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.min(CODEX_TOOL_OUTPUT_LIMIT_MAX, Math.max(CODEX_TOOL_OUTPUT_LIMIT_MIN, Math.round(v)));
}

/** What goes into the per-agent config.toml: a number, or null for "write no key". An absent or
 *  unreadable stored value falls back to the default rather than blocking a spawn. */
export function codexToolOutputLimitForConfig(v: unknown): number | null {
  if (v === undefined || v === null) return CODEX_TOOL_OUTPUT_LIMIT_DEFAULT;
  const n = normalizeCodexToolOutputLimit(v);
  if (n === null) return CODEX_TOOL_OUTPUT_LIMIT_DEFAULT;
  return n === 'off' ? null : n;
}

/** The Settings field's text → a value to save, or a message. Whole numbers only; out-of-range
 *  numbers are clamped (and the message says so); anything else is refused. */
export function parseCodexToolOutputLimitInput(text: string):
  { ok: true; value: number; clamped: boolean } | { ok: false; error: string } {
  const t = text.trim().replace(/[,_\s]/g, '');
  if (!/^\d+$/.test(t)) {
    return { ok: false, error: `Enter a whole number from ${CODEX_TOOL_OUTPUT_LIMIT_MIN} to ${CODEX_TOOL_OUTPUT_LIMIT_MAX}, or turn the cap off.` };
  }
  const raw = Number(t);
  const value = normalizeCodexToolOutputLimit(raw) as number;
  return { ok: true, value, clamped: value !== raw };
}
