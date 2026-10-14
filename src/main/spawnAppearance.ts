// Spawn-request appearance sanitiser (TES looks, MunderDev 0bba1dc8): main passes a worker's
// theme-pack look to the renderer only as a small plain object of short strings.

/** A spawn request's appearance, passed on only as a small plain object of
 *  short strings (anything else is dropped; the renderer validates the rest). */
export function spawnAppearance(v: unknown): Record<string, unknown> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  try { if (JSON.stringify(v).length > 400) return undefined; } catch { return undefined; }
  const out: Record<string, unknown> = {};
  for (const k of ['theme', 'presetId', 'bodyId'] as const) {
    const x = (v as Record<string, unknown>)[k];
    if (typeof x === 'string' && x.length <= 40) out[k] = x;
  }
  const c = (v as Record<string, unknown>).colors;
  if (c && typeof c === 'object' && !Array.isArray(c)) {
    const colors: Record<string, string> = {};
    for (const p of ['skin', 'shirt', 'hair']) { const x = (c as Record<string, unknown>)[p]; if (typeof x === 'string' && x.length <= 16) colors[p] = x; }
    if (Object.keys(colors).length) out.colors = colors;
  }
  return Object.keys(out).length ? out : undefined;
}
