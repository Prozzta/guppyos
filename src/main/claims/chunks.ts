/**
 * CLAIM-LEDGER W3: claim chunks (plan §2 ChunksForFn; spec amendment A4 D1-a). Pure, in main.
 *
 * One claim is one chunk: `kind · key · date` then the text. A claim over the chunk budget (only
 * a long legacy claim can be: an agent's note is at most 400 characters) becomes several chunks
 * with the SAME claimId, cut by the existing chunker at paragraph, line or word boundaries, each
 * carrying the header. Events are not chunks. A claim with no derived state is not chunked (fail
 * closed: nothing reaches the index that derive() has not judged).
 *
 * Main has no tokenizer, so the budget is in characters: CLAIM_CHUNK_CHARS (~2.5 characters per
 * wordpiece, under the chunker's 200-wordpiece budget and MiniLM's 256-wordpiece window).
 *
 * G3.5 (Jim's parity report, findings 1 and 3):
 * - ROOM: a claim chunk is filed in the room its text would have had as Markdown, so a room-scoped
 *   search keeps legacy parity. A legacy claim takes the room of its legacy file (an archive's
 *   `memory-archive-<date>`, memory.md's `memory`, as sources.ts names them); any other claim is a
 *   note an older build would have appended to memory.md: `memory`.
 * - HEADING: a claim with a `section` (W6) carries it as `## <section>` after the header line, in
 *   every part, inside the budget.
 * - NO CONTEXTLESS TAIL: a long claim is cut into EVEN parts (the greedy pack left a tail of a few
 *   words: 132 of the bed's 416 split entries ended in under 80 characters), and every part after
 *   the first starts with the claim's LEAD (its first line, at most CLAIM_LEAD_CHARS, then " …"), so a
 *   part read or embedded alone still says what it is about, as a Markdown chunk carries its heading.
 */
import type { ClaimChunk, ClaimRec, ClaimsState, LedgerRec } from '../../shared/claims';
import { chunkMarkdown } from '../nativeMemory/chunker';
import { roomOf } from '../nativeMemory/sources';
import { sha256Hex } from './canonical';

export const CLAIM_CHUNK_CHARS = 500;
/** The longest lead (a claim's first line) a later part repeats for context. */
export const CLAIM_LEAD_CHARS = 100;
const charTokens = (t: string): number => Math.ceil(t.length / 2.5);

/** A claim chunk as the index files it: ClaimChunk plus its room (an extra field; the frozen type is unchanged). */
export type RoomedClaimChunk = ClaimChunk & { room: string };

export function claimHeader(r: Pick<ClaimRec, 'kind' | 'key' | 'at'>): string {
  return `${r.kind} · ${r.key ?? '-'} · ${r.at.slice(0, 10)}`;
}

/** The room a claim's chunks are filed in (legacy parity, G3.5 finding 1). */
export function claimRoom(r: Pick<ClaimRec, 'legacy'>): string {
  const file = r.legacy?.file;
  return file && !/[\\/]/.test(file) ? roomOf(file) : 'memory';
}

/** A claim's lead: its first non-blank line, cut at a word to CLAIM_LEAD_CHARS, then " …". */
export function claimLead(text: string): string {
  const first = (text.split('\n').find((l) => l.trim()) ?? '').trim();
  if (first.length <= CLAIM_LEAD_CHARS) return `${first} …`;
  const cut = first.slice(0, CLAIM_LEAD_CHARS);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > CLAIM_LEAD_CHARS / 2 ? cut.slice(0, sp) : cut).trimEnd()} …`;
}

const pack = (text: string, chars: number): string[] => chunkMarkdown(text, charTokens, Math.floor(chars / 2.5)).map((c) => c.content);

/** A claim's parts within `budget` characters: even sizes, each part after the first led by the claim's lead. */
export function claimParts(text: string, budget: number): string[] {
  if (text.length <= budget) return [text];
  const lead = claimLead(text);
  const room = Math.max(64, budget - lead.length - 1);   // what a later part may hold besides its lead
  let parts = pack(text, room);
  if (parts.length > 1) {
    // Even out: the smallest budget that still gives the same number of parts (no tail of a few words).
    const n = parts.length;
    for (let b = Math.ceil(text.length / n); b < room; b = Math.ceil(b * 1.05) + 1) {
      const p = pack(text, b);
      if (p.length === n) { parts = p; break; }
    }
  }
  return parts.map((p, i) => (i === 0 ? p : `${lead}\n${p}`));
}

/** plan API chunksFor(records, state): the claim chunks, in ledger order. */
export function chunksFor(records: LedgerRec[], state: ClaimsState): RoomedClaimChunk[] {
  const out: RoomedClaimChunk[] = [];
  for (const r of records) {
    if (r.t !== 'claim') continue;
    const st = state.claims[r.id];
    if (!st) continue;
    const header = claimHeader(r);
    // G3.5: the W6 heading as a heading line after the header (searchable and embedded, as a Markdown
    // chunk carries its heading; claimEmbedText drops only the kind · key · date line).
    const heading = r.section ? `## ${r.section}\n` : '';
    const budget = Math.max(64, CLAIM_CHUNK_CHARS - header.length - 1 - heading.length);
    const pieces = claimParts(r.text, budget);
    const room = claimRoom(r);
    for (const p of pieces.length ? pieces : [r.text]) {
      const content = `${header}\n${heading}${p}`;
      out.push({ claimId: r.id, wing: r.agent, kind: r.kind, ckey: r.key ?? null, at: r.at, status: st.status, content, contentSha256: sha256Hex(content), room });
    }
  }
  return out;
}

/** Number each claim's chunks 0, 1, ... in order (the index keys parts by claim id and part). */
export function withParts<T extends ClaimChunk>(chunks: T[]): Array<T & { part: number }> {
  const n = new Map<string, number>();
  return chunks.map((c) => {
    const part = n.get(c.claimId) ?? 0;
    n.set(c.claimId, part + 1);
    return { ...c, part };
  });
}
