'use strict';
/**
 * RIG-DESYNC (1.1.76): the composer a rig "screen" reading may show, i.e. the stub's draft as of the
 * newest echo the host has RECEIVED (a real terminal shows only the bytes it applied).
 *
 * `shown` is the stub's [{ seq, draft }] window (seq 0 is the empty composer before any echo), `seen`
 * the newest echo number the host saw. Returns the draft, or null (NO reading) when that echo has
 * fallen out of the window: never '' there, which would read as an EMPTY composer (fail closed).
 * A stub without `shown` (an old one) has no echo numbers: its live draft.
 */
function screenDraftOf(shown, draft, seen) {
  if (!Array.isArray(shown)) return draft;
  let best = null;
  for (const s of shown) if (s.seq <= seen && (!best || s.seq > best.seq)) best = s;
  return best ? best.draft : null;
}

module.exports = { screenDraftOf };
