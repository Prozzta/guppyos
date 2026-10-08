/**
 * CL-M4-WP step 3 (design §2): deterministic replacement candidates for a new note.
 *
 * Pool, exactly the three product sources, each bounded to the window before the write (6 h):
 *   own          this agent's own claims with `wt` in the window (its ledger);
 *   search       claim ids this agent's own `memory search` returned in the window (searchLog.ts);
 *   working-set  ids in the working-set receipt at that time. The note path does not read a
 *                receipt today (claims/delivery.ts writes receipts.jsonl; nothing on the note path
 *                reads it, and a receipt's `at` is its ledger's last wt, not the delivery time),
 *                so the product wiring leaves this source unwired: it is reported EXCLUDED, never
 *                substituted by another receipt.
 * Only LIVE claims are offered (not superseded, superseded?, retracted or purged), and never the
 * new note itself. The query is the new note's text. Ranking: reciprocal-rank fusion, k = 60,
 * over a BM25 order (hive-wide document statistics, HiveCorpus) and a vector order of the pool;
 * ties by newest `wt`, then id. The top 3 OWN claims are the replace candidates; another agent's
 * claim in the overall top 3 is returned separately as a reference, never a target.
 *
 * The note CLI (Dwight, step 1) calls collectNoteCandidates; with no candidate it appends at once
 * (marked new), otherwise it shows the candidates and asks replace / separate / cancel.
 */

export type CandidateSource = 'own' | 'search' | 'working-set';
export const CANDIDATE_WINDOW_MS = 6 * 3600_000;
export const CANDIDATE_TOP = 3;
export const RRF_K = 60;
export const EXCERPT_CHARS = 80;

/** One claim that may enter the pool, as its ledger and derived state show it at collection time. */
export interface PoolClaim {
  id: string;
  /** The owning agent (whose ledger holds it). */
  owner: string;
  /** Write time, ISO. */
  wt: string;
  key?: string;
  text: string;
  /** Derived status at collection time; only 'live' is offered. */
  status: string;
}

/**
 * The score shape rankCandidates takes: two orders of pool ids, best first. `lexical` holds only
 * the ids BM25 matched (a pool claim sharing no query term is absent, as in an FTS5 MATCH);
 * `vector` normally holds every pool id by descending cosine similarity. An id in neither list
 * scores 0 and can only fill a place by the tie rule. Ids not in the pool are ignored.
 */
export interface CandidateScores { lexical: string[]; vector: string[] }

export interface RankedCandidate extends PoolClaim { score: number; rank: number }

/** RRF (k = 60) over the two orders; ties by newest wt, then id (ascending). Pure; top `top`. */
export function rankCandidates(pool: PoolClaim[], scores: CandidateScores, top = CANDIDATE_TOP, k0 = RRF_K): RankedCandidate[] {
  const inPool = new Set(pool.map((c) => c.id));
  const score = new Map<string, number>(pool.map((c) => [c.id, 0]));
  for (const order of [scores.lexical, scores.vector]) {
    let r = 0;
    const seen = new Set<string>();
    for (const id of order) {
      if (!inPool.has(id) || seen.has(id)) continue;
      seen.add(id);
      r += 1;
      score.set(id, (score.get(id) ?? 0) + 1 / (k0 + r));
    }
  }
  const byId = new Map(pool.map((c) => [c.id, c]));
  return [...byId.values()]
    .sort((a, b) => (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0) || Date.parse(b.wt) - Date.parse(a.wt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, Math.max(0, top))
    .map((c, i) => ({ ...c, score: score.get(c.id) ?? 0, rank: i + 1 }));
}

// ---------------------------------------------------------------- scoring

/** FTS5 unicode61-like tokens: letters/digits runs, lower-cased, diacritics removed. */
export function ftsTokens(text: string): string[] {
  return text.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** The query terms nativeMemory's ftsQuery uses (letters/digits/_ words, >1 char or with a digit,
 *  first 32, distinct), each split into its FTS5 tokens (an `a_b` phrase counts as its tokens). */
export function queryTerms(text: string): string[] {
  const words = (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((t) => t.length > 1 || /\d/.test(t)).slice(0, 32);
  return [...new Set(words.flatMap((w) => ftsTokens(w)))];
}

/** Corpus statistics BM25 uses: by default the pool itself; the study passes the whole bed. */
export interface Bm25Corpus { n: number; avgdl: number; df: Map<string, number> }

export function bm25Corpus(texts: string[]): Bm25Corpus {
  const df = new Map<string, number>();
  let total = 0;
  for (const t of texts) {
    const toks = ftsTokens(t);
    total += toks.length;
    for (const k of new Set(toks)) df.set(k, (df.get(k) ?? 0) + 1);
  }
  return { n: texts.length, avgdl: texts.length ? total / texts.length : 0, df };
}

/** Ids by FTS5-style BM25 (k1 1.2, b 0.75; idf floored at 1e-6, as FTS5), best first; non-matching docs omitted. */
export function bm25Order(query: string, docs: Array<{ id: string; text: string }>, corpus: Bm25Corpus = bm25Corpus(docs.map((d) => d.text))): string[] {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const k1 = 1.2;
  const b = 0.75;
  const scored: Array<{ id: string; s: number }> = [];
  for (const d of docs) {
    const toks = ftsTokens(d.text);
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    let s = 0;
    let matched = false;
    for (const q of terms) {
      const f = tf.get(q) ?? 0;
      if (!f) continue;
      matched = true;
      const n = corpus.df.get(q) ?? 0;
      const idf = Math.max(1e-6, Math.log((corpus.n - n + 0.5) / (n + 0.5)));
      s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * (toks.length / (corpus.avgdl || 1))));
    }
    if (matched) scored.push({ id: d.id, s });
  }
  return scored.sort((x, y) => y.s - x.s || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0)).map((x) => x.id);
}

/** Ids by descending cosine similarity to the query vector (vectors need not be normalised). */
export function cosineOrder(q: ArrayLike<number>, docs: Array<{ id: string; vec: ArrayLike<number> }>): string[] {
  const norm = (v: ArrayLike<number>): number => { let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * v[i]; return Math.sqrt(s) || 1; };
  const qn = norm(q);
  return docs
    .map((d) => { let s = 0; for (let i = 0; i < Math.min(q.length, d.vec.length); i++) s += q[i] * d.vec[i]; return { id: d.id, s: s / (qn * norm(d.vec)) }; })
    .sort((x, y) => y.s - x.s || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
    .map((x) => x.id);
}

export type Scorer = (query: string, pool: PoolClaim[]) => CandidateScores | Promise<CandidateScores>;

/**
 * BM25 plus cosine on `embed`. `corpus` gives the document statistics (Jim M1): the LIVE scorer
 * passes the hive-wide ones (HiveCorpus); left out, the pool's own are used, which floors every term
 * in a small pool (in a pool of 2, each term's idf is <= 0) and is for tests and studies only.
 */
export function makeLocalScorer(embed: (texts: string[]) => Promise<ArrayLike<number>[]>, corpus?: Bm25Corpus | (() => Bm25Corpus)): Scorer {
  return async (query, pool) => {
    if (!pool.length) return { lexical: [], vector: [] };
    const stats = typeof corpus === 'function' ? corpus() : corpus;
    const vecs = await embed([query, ...pool.map((c) => c.text)]);
    return {
      lexical: bm25Order(query, pool, stats),
      vector: cosineOrder(vecs[0], pool.map((c, i) => ({ id: c.id, vec: vecs[i + 1] })))
    };
  };
}

// ---------------------------------------------------------------- collection

/** A display-ready candidate (id / title / date / excerpt; owner; which sources offered it). */
export interface NoteCandidate {
  id: string;
  title: string;
  /** The claim's wt, ISO. */
  date: string;
  /** One line, at most EXCERPT_CHARS characters (an ellipsis marks a cut). */
  excerpt: string;
  owner: string;
  status: 'live';
  sources: CandidateSource[];
  rank: number;
  /** True: the writer's own claim, a valid `--supersedes` target. False: a REFERENCE only. */
  replaceable: boolean;
}

/** Why a source contributed nothing: `unwired` (no reader on this path), `error` (its reader threw). */
export interface ExcludedSource { source: CandidateSource; reason: 'unwired' | 'error' }

export interface CandidateResult {
  /** The writer's OWN claims, best first, at most `top`: the only replace targets. */
  candidates: NoteCandidate[];
  /**
   * Other agents' claims (from search hits) that rank within the overall top `top`: shown for
   * reference, never a replace target (`supersedes` is own-ledger only; Jim S1), at most `top`.
   */
  references: NoteCandidate[];
  excluded: ExcludedSource[];
  /** `rrf` normally; `recency` when the scorer failed (then: newest wt, then id). */
  ranking: 'rrf' | 'recency';
  /** Pool size after the live / self filters (for logs and the study). */
  pool: number;
}

export interface CandidateDeps {
  /** This agent's own claims written in [since, at] (ledger), with derived status. */
  ownClaims(agentId: string, since: Date, at: Date): PoolClaim[];
  /** Search hits (id + owning wing) this agent's searches returned in the window; absent = unwired. */
  searchHits?(agentId: string, at: Date): Array<{ id: string; wing: string }>;
  /** Ids in the working-set receipt in force at `at`; absent = unwired (the product today). */
  workingSetIds?(agentId: string, at: Date): Array<{ id: string; wing: string }>;
  /** Resolve hits to claims (any owner) with derived status; unknown ids are dropped. */
  resolve(hits: Array<{ id: string; wing: string }>): PoolClaim[];
  score: Scorer;
}

export interface CollectOptions {
  /** Ids never offered (the new note's own id, a draft's). */
  excludeIds?: string[];
  windowMs?: number;
  top?: number;
}

/** A one-line excerpt of at most `n` characters. */
export function excerptOf(text: string, n = EXCERPT_CHARS): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= n ? one : `${one.slice(0, n - 1).trimEnd()}…`;
}

/** A short title: the key when there is one, else the first words of the text. */
export function titleOf(c: Pick<PoolClaim, 'key' | 'text'>): string {
  return c.key ? c.key : excerptOf(c.text, 48);
}

export async function collectNoteCandidates(d: CandidateDeps, agentId: string, text: string, at: Date, o: CollectOptions = {}): Promise<CandidateResult> {
  const windowMs = o.windowMs ?? CANDIDATE_WINDOW_MS;
  const since = new Date(at.getTime() - windowMs);
  const excluded: ExcludedSource[] = [];
  const sources = new Map<string, Set<CandidateSource>>();
  const claims = new Map<string, PoolClaim>();
  const add = (src: CandidateSource, list: PoolClaim[]): void => {
    for (const c of list) {
      if (!claims.has(c.id)) claims.set(c.id, c);
      (sources.get(c.id) ?? sources.set(c.id, new Set()).get(c.id)!).add(src);
    }
  };
  try { add('own', d.ownClaims(agentId, since, at).filter((c) => { const t = Date.parse(c.wt); return t >= since.getTime() && t <= at.getTime(); })); }
  catch { excluded.push({ source: 'own', reason: 'error' }); }
  for (const [src, read] of [['search', d.searchHits], ['working-set', d.workingSetIds]] as const) {
    if (!read) { excluded.push({ source: src, reason: 'unwired' }); continue; }
    try { add(src, d.resolve(read.call(d, agentId, at))); } catch { excluded.push({ source: src, reason: 'error' }); }
  }
  const skip = new Set(o.excludeIds ?? []);
  const pool = [...claims.values()].filter((c) => c.status === 'live' && !skip.has(c.id) && Date.parse(c.wt) <= at.getTime());
  let ranking: CandidateResult['ranking'] = 'rrf';
  let scores: CandidateScores;
  try { scores = pool.length ? await d.score(text, pool) : { lexical: [], vector: [] }; } catch { scores = { lexical: [], vector: [] }; ranking = 'recency'; }
  const top = Math.max(0, o.top ?? CANDIDATE_TOP);
  const ranked = rankCandidates(pool, scores, pool.length);
  const show = (c: RankedCandidate, rank: number): NoteCandidate => ({
    id: c.id, title: titleOf(c), date: c.wt, excerpt: excerptOf(c.text), owner: c.owner, status: 'live' as const,
    sources: (['own', 'search', 'working-set'] as const).filter((s) => sources.get(c.id)?.has(s)), rank, replaceable: c.owner === agentId
  });
  return {
    // Replace targets: the writer's own claims only, best first (Jim S1).
    candidates: ranked.filter((c) => c.owner === agentId).slice(0, top).map((c, i) => show(c, i + 1)),
    // Another agent's claim is shown only where it ranks in the overall top, and only for reference.
    references: ranked.slice(0, top).filter((c) => c.owner !== agentId).map((c, i) => show(c, i + 1)),
    excluded,
    ranking,
    pool: pool.length
  };
}

// ---------------------------------------------------------------- product wiring

/** A verified ledger view: its claim records and each claim's derived status. */
export interface LedgerView {
  claims: Array<{ id: string; agent: string; wt: string; key?: string; text: string }>;
  status(id: string): string | undefined;
}

export interface LedgerCandidateInputs {
  /** The agent's verified ledger prefix and derived state; null when unreadable (not verified). */
  ledger(agentId: string): LedgerView | null;
  /** The search-result log (source 2); absent = unwired. */
  searchLog?: { hitsSince(agentId: string, at: Date): Array<{ id: string; wing: string }> };
  score: Scorer;
}

/** CandidateDeps over the ledgers. Working-set (source 3) stays unwired: see the header. */
export function ledgerCandidateDeps(i: LedgerCandidateInputs): CandidateDeps {
  const pc = (v: LedgerView, c: LedgerView['claims'][number]): PoolClaim => ({
    id: c.id, owner: c.agent, wt: c.wt, ...(c.key ? { key: c.key } : {}), text: c.text, status: v.status(c.id) ?? 'unknown'
  });
  return {
    // The window is applied once, in collectNoteCandidates (Jim S3).
    ownClaims(agentId) {
      const v = i.ledger(agentId);
      if (!v) throw new Error('ledger not verified');
      return v.claims.map((c) => pc(v, c));
    },
    ...(i.searchLog ? { searchHits: (agentId: string, at: Date) => i.searchLog!.hitsSince(agentId, at) } : {}),
    resolve(hits) {
      const out: PoolClaim[] = [];
      const views = new Map<string, LedgerView | null>();
      for (const h of hits) {
        if (!views.has(h.wing)) views.set(h.wing, i.ledger(h.wing));
        const v = views.get(h.wing);
        const c = v?.claims.find((x) => x.id === h.id);
        if (v && c) out.push(pc(v, c));
      }
      return out;
    },
    score: i.score
  };
}

/**
 * The live `embed` for makeLocalScorer: the memory worker's MiniLM (main has no embedder). A failed
 * request throws, so collectNoteCandidates falls back to recency ranking (`ranking: 'recency'`).
 * Texts are embedded as claims are (the text alone) and sent in batches the worker accepts.
 */
export function embedViaWorker(request: (texts: string[]) => Promise<{ ok: boolean; json?: unknown; error?: string }>, batch = 64): (texts: string[]) => Promise<ArrayLike<number>[]> {
  return async (texts) => {
    const out: ArrayLike<number>[] = [];
    for (let i = 0; i < texts.length; i += batch) {
      const part = texts.slice(i, i + batch).map((t) => t.slice(0, 2000));
      const r = await request(part);
      if (!r.ok || !Array.isArray(r.json) || r.json.length !== part.length) throw new Error(`embed failed: ${r.error ?? 'bad reply'}`);
      out.push(...(r.json as number[][]));
    }
    return out;
  };
}

/**
 * Hive-wide BM25 statistics for the live scorer (Jim M1): document frequencies over every agent's
 * LIVE claims, as the FTS index takes them over its whole table, not over a pool of a few claims.
 * Per-agent statistics are cached by a ledger signature, so a note re-counts only changed ledgers.
 */
export class HiveCorpus {
  private readonly per = new Map<string, { sig: string; n: number; tokens: number; df: Map<string, number> }>();

  constructor(private readonly d: { agents: () => string[]; ledger: (agentId: string) => LedgerView | null }) {}

  corpus(): Bm25Corpus {
    const agents = new Set(this.d.agents());
    for (const a of [...this.per.keys()]) if (!agents.has(a)) this.per.delete(a);
    let n = 0;
    let tokens = 0;
    const df = new Map<string, number>();
    for (const a of agents) {
      const v = this.d.ledger(a);
      if (!v) { this.per.delete(a); continue; }
      const live = v.claims.filter((c) => v.status(c.id) === 'live');
      const sig = `${v.claims.length}|${v.claims[v.claims.length - 1]?.id ?? ''}|${live.map((c) => c.id).join(',')}`;
      let s = this.per.get(a);
      if (!s || s.sig !== sig) {
        const c = bm25Corpus(live.map((x) => x.text));
        s = { sig, n: c.n, tokens: c.avgdl * c.n, df: c.df };
        this.per.set(a, s);
      }
      n += s.n;
      tokens += s.tokens;
      for (const [k, x] of s.df) df.set(k, (df.get(k) ?? 0) + x);
    }
    return { n, avgdl: n ? tokens / n : 0, df };
  }
}
