'use strict';
/**
 * RIG-DESYNC (1.1.76): the composer a rig "screen" reading may show, i.e. the stub's draft as of the
 * newest echo the host has RECEIVED (a real terminal shows only the bytes it applied).
 *
 * `shown` is the stub's [{ seq, draft }] window (seq 0 is the empty composer before any echo), `seen`
 * the newest echo number the host saw. Returns the draft, or null (NO reading) when that echo has
 * fallen out of the window: never '' there, which would read as an EMPTY composer (fail closed).
 * A stub without `shown` (an old one) has no echo numbers: its live draft.
 *
 * MAIL-RIG-G1-STALE-MIRROR-108: the stub writes composer.json BEFORE each echo, so every echo the
 * host saw is in the file's window unless the file is BEHIND (a write still refused, or given up
 * after COMPOSER_WRITE_GIVE_UP_MS while the echo still went out). Then the newest entry on disk is
 * an OLDER composer (often the empty one) and showing it would read as "the prompt row is empty"
 * for text the terminal shows. So seen > the newest seq on disk is null too (no reading).
 */
function screenDraftOf(shown, draft, seen) {
  if (!Array.isArray(shown)) return draft;
  let best = null;
  let newest = -Infinity;
  for (const s of shown) {
    if (s.seq > newest) newest = s.seq;
    if (s.seq <= seen && (!best || s.seq > best.seq)) best = s;
  }
  if (seen > newest) return null;
  return best ? best.draft : null;
}

module.exports = { screenDraftOf };
