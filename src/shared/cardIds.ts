/**
 * The one card-id rule (CL-M4: FORWARD's offer, the CHAINS panel, the m4-live harness), so the
 * three cannot drift. A card id is an upper-case hyphenated token like CL-M4-FORWARD-PATH or
 * POST-INSTALL-188; a `card.<id>` key names its card too.
 *
 * - default (full): the whole token. POST-INSTALL-188 and POST-INSTALL-189 are different cards
 *   (one check per release), and WAKE-155 is a card. A one-word name with a number (NAME-N) is a
 *   card only when the number is a 3-digit build number and the name is not a standard's
 *   (SHA-256, UTF-16): GATE-4, RC-1 and SHA-256 grouped unrelated notes on the real ledgers.
 *   The CHAINS panel groups on this.
 * - `dropBuild`: a trailing build number is dropped (TES-BUBBLE-NITS-189 -> TES-BUBBLE-NITS) and a
 *   token left without a hyphen is not a card (Jim's calibration rule, as FORWARD retrieves with it).
 */
const STANDARDS = new Set(['SHA', 'UTF', 'ISO', 'RFC', 'CVE', 'IEC', 'IEEE', 'MD', 'AES', 'RSA', 'TLS', 'HTTP', 'IPV', 'WIN', 'X']);

export function cardIds(text: string, key?: string, o: { dropBuild?: boolean } = {}): string[] {
  const fromKey = key?.startsWith('card.') ? key.slice(5).toUpperCase() : '';
  const toks = `${text} ${fromKey}`.match(/\b[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+\b/g) ?? [];
  if (o.dropBuild) return [...new Set(toks.map((t) => t.replace(/-\d+$/, '')).filter((t) => t.includes('-')))];
  return [...new Set(toks.filter((t) => {
    const m = /^([A-Z][A-Z0-9]*)-(\d+)$/.exec(t);
    return !m || (/^\d{3}$/.test(m[2]) && !STANDARDS.has(m[1]));
  }))];
}
