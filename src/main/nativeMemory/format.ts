/**
 * NATIVE-MEMORY section 6: the `memory` command's text. `search` prints ranked hits;
 * `wake-up` follows the section-4 CONTENT contract in its frame (the "Wake-up text (~N
 * tokens):" header and the L0/L1 headings). PINNED-MEMORY adds an L0.5 block between them: the
 * agent's `## How I work (standing lessons)` section, verbatim, on its own budget.
 */
import type { SearchHit } from './store';
import { PINNED_SOFT_CAP_BYTES } from '../memoryRollover';

export interface SearchFlags {
  wing?: string | null;
  room?: string | null;
  since?: string | null;
  before?: string | null;
}

const base = (p: string): string => p.split('/').pop() ?? p;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** Python's str(float) for the scores the legacy CLI prints (`0.436`, `1.347`, `0.0`). */
function py(n: number): string {
  const r = round3(n);
  return Number.isInteger(r) ? `${r}.0` : String(r);
}

export function formatSearch(query: string, flags: SearchFlags, hits: SearchHit[]): string {
  if (!hits.length) return `\n  No results found for: "${query}"\n`;
  const L: string[] = [];
  L.push('', '='.repeat(60), `  Results for: "${query}"`);
  if (flags.wing) L.push(`  Wing: ${flags.wing}`);
  if (flags.room) L.push(`  Room: ${flags.room}`);
  if (flags.since) L.push(`  Since: ${flags.since}`);
  if (flags.before) L.push(`  Before: ${flags.before}`);
  L.push('='.repeat(60), '');
  hits.forEach((h, i) => {
    L.push(`  [${i + 1}] ${h.wing} / ${h.room}`);
    L.push(`      Source: ${base(h.source)}`);
    L.push(`      Match:  cosine_sim=${h.cosineSim === null ? '0.0' : py(h.cosineSim)}  bm25=${h.bm25 === null ? '0.0' : py(h.bm25)}`);
    L.push('');
    for (const line of h.content.trim().split('\n')) L.push(`      ${line}`);
    L.push('');
    L.push(`  ${'-'.repeat(56)}`);
  });
  L.push('');
  return L.join('\n') + '\n';
}

export interface WakeEntry { wing: string; room: string; source: string; content: string }

/** ~800 tokens: the legacy L1 cap was 3200 characters. */
export const WAKE_MAX_CHARS = 3200;
const SNIPPET = 400;
/** The L0.5 block's own budget (the pinned section's 6 KB soft cap); never taken from L1's. */
export const WAKE_PINNED_MAX_BYTES = 6 * 1024;

/** The pinned section's lines (its heading dropped: the block has its own), verbatim, capped. */
function pinnedBlock(pinned: string): string {
  const body = pinned.replace(/\r\n/g, '\n').replace(/^[^\n]*\n?/, '').replace(/\s+$/, '');
  const buf = Buffer.from(body, 'utf8');
  if (buf.length <= WAKE_PINNED_MAX_BYTES) return body;
  // The first 6 KB, cut at a line break when there is one (never inside a UTF-8 sequence).
  let cut = buf.lastIndexOf(0x0a, WAKE_PINNED_MAX_BYTES);
  if (cut <= 0) {
    cut = WAKE_PINNED_MAX_BYTES;
    while (cut > 0 && (buf[cut] & 0xc0) === 0x80) cut--;
  }
  return `${buf.subarray(0, cut).toString('utf8')}\n… (over 6 KB: read the rest in memory.md)`;
}

export function formatWakeUp(identity: string | null, entries: WakeEntry[], pinned: string | null = null): string {
  const parts: string[] = [];
  parts.push(identity && identity.trim()
    ? `## L0 — IDENTITY\n${identity.trim().slice(0, 800)}`
    : '## L0 — IDENTITY\nNo identity file for this wing (agents/<id>/identity.md).');
  parts.push('');
  const lessons = pinned ? pinnedBlock(pinned) : '';
  if (lessons.trim()) parts.push(`## L0.5 — HOW I WORK (standing lessons)\n${lessons}`, '');
  if (!entries.length) {
    parts.push('## L1 — No memories yet.');
  } else {
    const L = ['## L1 — ESSENTIAL STORY'];
    const byRoom = new Map<string, WakeEntry[]>();
    for (const e of entries) { const l = byRoom.get(e.room) ?? []; l.push(e); byRoom.set(e.room, l); }
    const rooms = [...byRoom.keys()].sort((a, b) => (a === 'memory' ? -1 : b === 'memory' ? 1 : a.localeCompare(b)));
    for (const room of rooms) {
      L.push('', `[${room}]`);
      for (const e of byRoom.get(room)!) {
        let s = e.content.trim().replace(/\n+/g, ' ');
        if (s.length > SNIPPET) s = `${s.slice(0, SNIPPET - 3)}...`;
        L.push(`  - ${s}  (${base(e.source)})`);
      }
    }
    parts.push(L.join('\n'));
  }
  const text = parts.join('\n');
  return `Wake-up text (~${Math.floor(text.length / 4)} tokens):\n${'='.repeat(50)}\n${text}\n`;
}

export function formatStatus(s: { sources: number; chunks: number; vectors: number; generation: number; dbBytes: number; perWing: Array<{ wing: string; chunks: number }>; memoryPinned?: Array<{ agent: string; present: boolean; bytes: number; lessons: number }> }): string {
  const L = [`Memory engine (native index): ${s.sources} sources, ${s.chunks} chunks, ${s.vectors} vectors, ${(s.dbBytes / 1048576).toFixed(1)} MB, generation ${s.generation}`];
  for (const w of s.perWing) L.push(`  WING: ${w.wing}  (${w.chunks} chunks)`);
  // PINNED-MEMORY migration check: each agent's "## How I work (standing lessons)" section.
  if (s.memoryPinned?.length) {
    L.push('memory-pinned (## How I work (standing lessons)):');
    for (const p of s.memoryPinned) {
      L.push(p.present
        ? `  ${p.agent}: ${p.lessons} lesson(s), ${p.bytes} B${p.bytes > PINNED_SOFT_CAP_BYTES ? '  (over 6 KB: merge and shorten)' : ''}${p.lessons === 0 ? '  (empty: move your method lessons here)' : ''}`
        : `  ${p.agent}: no section`);
    }
  }
  return L.join('\n') + '\n';
}
