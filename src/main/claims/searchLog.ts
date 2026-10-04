/**
 * CL-M4-WP step 3 (design §2, source 2): the per-agent, timestamped log of the claim ids that
 * agent's own `memory search` RETURNED, so a later `note` can offer them as candidates.
 *
 * `<hive>/agents/<id>/memory/search-results.jsonl`, one row per search that returned claims:
 * `{at, hits: [{id, wing}]}` (the wing is the claim's owner, whose ledger holds it). Ids only:
 * never the query or any hit text. Rows older than the retention bound (6 h) are dropped on every
 * write and ignored on every read. One file per agent, named by the caller's TOKEN agent (never a
 * body field), so agents never see each other's searches; the renderer's `human` queries are not
 * logged.
 */
import * as nodeFs from 'node:fs';
import { join } from 'node:path';

export const SEARCH_LOG_RETENTION_MS = 6 * 3600_000;
/** At most this many hits per search row (a search returns k hits; the CLI's k is small). */
export const SEARCH_LOG_MAX_HITS = 50;

const AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const ID_RE = /^[ce]-[0-9a-f]{12,32}$/;

export interface SearchLogHit { id: string; wing: string }
export interface SearchLogRow { at: string; hits: SearchLogHit[] }

export interface SearchLogDeps {
  hiveRoot: () => string;
  now?: () => Date;
  retentionMs?: number;
}

const validHit = (h: unknown): h is SearchLogHit => !!h && typeof h === 'object' &&
  typeof (h as SearchLogHit).id === 'string' && ID_RE.test((h as SearchLogHit).id) &&
  typeof (h as SearchLogHit).wing === 'string' && AGENT_RE.test((h as SearchLogHit).wing);

/** The claim hits in a `search` reply's json (redacted hits carry `claimId` and `wing`), in rank order, deduplicated. */
export function claimHitsOfSearchReply(json: unknown): SearchLogHit[] {
  if (!Array.isArray(json)) return [];
  const out: SearchLogHit[] = [];
  for (const h of json) {
    const r = h && typeof h === 'object' ? (h as Record<string, unknown>) : {};
    const hit = { id: r.claimId, wing: r.wing };
    if (validHit(hit) && !out.some((x) => x.id === hit.id)) out.push({ id: hit.id, wing: hit.wing });
    if (out.length >= SEARCH_LOG_MAX_HITS) break;
  }
  return out;
}

export class SearchResultLog {
  private readonly now: () => Date;
  private readonly retentionMs: number;

  constructor(private readonly d: SearchLogDeps) {
    this.now = d.now ?? (() => new Date());
    this.retentionMs = d.retentionMs ?? SEARCH_LOG_RETENTION_MS;
  }

  file(agentId: string): string { return join(this.d.hiveRoot(), 'agents', agentId, 'memory', 'search-results.jsonl'); }

  /** Rows inside the retention window ending at `at` (none after it), oldest first. A torn or foreign line is skipped. */
  private rows(agentId: string, at: number): SearchLogRow[] {
    let text: string;
    try { text = nodeFs.readFileSync(this.file(agentId), 'utf8'); } catch { return []; }
    const out: SearchLogRow[] = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      let r: unknown;
      try { r = JSON.parse(line); } catch { continue; }
      const row = r as Partial<SearchLogRow>;
      const t = typeof row.at === 'string' ? Date.parse(row.at) : NaN;
      if (!Number.isFinite(t) || t > at || at - t > this.retentionMs || !Array.isArray(row.hits)) continue;
      const hits = row.hits.filter(validHit);
      if (hits.length) out.push({ at: row.at as string, hits });
    }
    return out;
  }

  /**
   * Record one search's returned claim hits for `agentId`. Rewrites the file without the expired
   * rows (tmp + rename), so it never holds more than the window. Returns the hits logged.
   */
  record(agentId: string, searchJson: unknown): SearchLogHit[] {
    if (!AGENT_RE.test(agentId) || agentId === 'human') return [];
    const hits = claimHitsOfSearchReply(searchJson);
    if (!hits.length) return [];
    const now = this.now();
    const kept = this.rows(agentId, now.getTime());
    kept.push({ at: now.toISOString(), hits });
    const f = this.file(agentId);
    nodeFs.mkdirSync(join(this.d.hiveRoot(), 'agents', agentId, 'memory'), { recursive: true });
    const tmp = `${f}.tmp-${process.pid}`;
    nodeFs.writeFileSync(tmp, kept.map((r) => JSON.stringify(r)).join('\n') + '\n');
    nodeFs.renameSync(tmp, f);
    return hits;
  }

  /** The hits this agent's searches returned within the window ending at `at`: each id once, newest sighting first. */
  hitsSince(agentId: string, at: Date = this.now()): Array<SearchLogHit & { at: string }> {
    if (!AGENT_RE.test(agentId)) return [];
    const seen = new Map<string, SearchLogHit & { at: string }>();
    for (const r of this.rows(agentId, at.getTime()).reverse()) for (const h of r.hits) if (!seen.has(h.id)) seen.set(h.id, { ...h, at: r.at });
    return [...seen.values()];
  }
}
