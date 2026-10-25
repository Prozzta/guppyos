/**
 * CLAIMS-90 R2 (d): the write-time supersede rule. A `card.*` key is multi (an agent keeps several
 * distinct facts about one card under it), so a new note never retires a same-key claim just for its
 * key. It retires the writer's OWN live same-key claim when it RESTATES that claim's attribute: the
 * two texts are the same once their value words are masked (shas, versions, dates and times,
 * numbers), so only a value changed ("Card X pushed at abc1234" -> "Card X pushed at def5678").
 * Another agent's claims are never touched. Pure; the endpoint applies it, a replay counts it.
 */

const VALUE_RE = /\b\d{4}-\d\d-\d\d(?:[t ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?z?)?\b|(?<![0-9a-z])[0-9a-f]{7,40}(?![0-9a-z])|\bv?\d+(?:\.\d+)+\b|\b\d+\b/g;
const isSha = (w: string): boolean => /^[0-9a-f]{7,40}$/.test(w) && /[0-9]/.test(w) && /[a-f]/.test(w);

/** The text's words with each value word replaced by a class marker, and the value words. */
export function maskValues(text: string): { words: string[]; values: string[] } {
  const values: string[] = [];
  const masked = text.toLowerCase().replace(VALUE_RE, (m) => {
    if (/^[0-9a-f]{7,40}$/.test(m) && !isSha(m) && !/^\d+$/.test(m)) return m;   // a hex-looking word that is no sha
    values.push(m);
    return /^\d{4}-/.test(m) ? ' vdate ' : isSha(m) ? ' vsha ' : /\./.test(m) ? ' vver ' : ' vnum ';
  });
  const words = masked.replace(/[^a-z0-9#]+/g, ' ').trim().split(' ').filter(Boolean);
  return { words, values };
}

/** Min words a text needs (masked) before a restatement counts; shorter texts are too generic. */
export const RESTATE_MIN_WORDS = 5;

/**
 * True when `newer` restates `older`: the same words in the same order after masking, at least
 * RESTATE_MIN_WORDS of them, at least one value word, and the values differ.
 */
export function restates(newer: string, older: string): boolean {
  const a = maskValues(newer);
  const b = maskValues(older);
  if (a.words.length < RESTATE_MIN_WORDS || a.words.length !== b.words.length) return false;
  if (a.values.length !== b.values.length) return false;   // no value word: both join to "", not a change
  for (let i = 0; i < a.words.length; i++) if (a.words[i] !== b.words[i]) return false;
  return a.values.join('\u0000') !== b.values.join('\u0000');
}

/** The ids of `live` (the writer's own live same-key claims) that `text` restates. */
export function restatedIds(text: string, live: ReadonlyArray<{ id: string; text: string }>): string[] {
  return live.filter((c) => restates(text, c.text)).map((c) => c.id).slice(0, 20);
}
