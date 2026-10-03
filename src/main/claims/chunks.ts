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
 */
import type { ClaimChunk, ClaimRec, ClaimsState, LedgerRec } from '../../shared/claims';
import { chunkMarkdown } from '../nativeMemory/chunker';
import { sha256Hex } from './canonical';

export const CLAIM_CHUNK_CHARS = 500;
const charTokens = (t: string): number => Math.ceil(t.length / 2.5);

export function claimHeader(r: Pick<ClaimRec, 'kind' | 'key' | 'at'>): string {
  return `${r.kind} · ${r.key ?? '-'} · ${r.at.slice(0, 10)}`;
}

/** plan API chunksFor(records, state): the claim chunks, in ledger order. */
export function chunksFor(records: LedgerRec[], state: ClaimsState): ClaimChunk[] {
  const out: ClaimChunk[] = [];
  for (const r of records) {
    if (r.t !== 'claim') continue;
    const st = state.claims[r.id];
    if (!st) continue;
    const header = claimHeader(r);
    const budget = Math.max(64, CLAIM_CHUNK_CHARS - header.length - 1);
    const pieces = r.text.length <= budget ? [r.text] : chunkMarkdown(r.text, charTokens, Math.floor(budget / 2.5)).map((c) => c.content);
    for (const p of pieces.length ? pieces : [r.text]) {
      const content = `${header}\n${p}`;
      out.push({ claimId: r.id, wing: r.agent, kind: r.kind, ckey: r.key ?? null, at: r.at, status: st.status, content, contentSha256: sha256Hex(content) });
    }
  }
  return out;
}

/** Number each claim's chunks 0, 1, ... in order (the index keys parts by claim id and part). */
export function withParts(chunks: ClaimChunk[]): Array<ClaimChunk & { part: number }> {
  const n = new Map<string, number>();
  return chunks.map((c) => {
    const part = n.get(c.claimId) ?? 0;
    n.set(c.claimId, part + 1);
    return { ...c, part };
  });
}
