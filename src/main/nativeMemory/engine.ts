/**
 * NATIVE-MEMORY section 3: the engine that lives INSIDE the memory worker (a utility process).
 * It is the only owner of the SQLite connection, sqlite-vec, ONNX Runtime, the source watcher
 * and the write queue. Electron main never does any of that (Jim R1-R3).
 *
 * ONE serialized queue, by priority: search > wake-up/status > changed-source ingest > initial
 * backfill > compaction. Long work is cut into steps (a backfill embeds EMBED_BATCH chunks per
 * step and then yields), so a search that arrives mid-backfill waits for one step, not for
 * the backfill. MEMORY-SEARCH-TIMEOUT-DURING-INDEX-189: onIndexing tells main while any indexing
 * runs (main then gives a search a longer budget), and a search whose deadline passed while it
 * was queued is answered expired without running.
 */
import { existsSync, readdirSync, readFileSync, statSync, watch as fsWatch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { chunkMarkdown, CHUNKER_VERSION, type Chunk } from './chunker';
import { discoverSources, ALLOW_LIST_VERSION, SOURCES_CONFIG_FILE, sha256, type Discovery, type SourceEntry } from './sources';
import { CLAIM_EMBED_VERSION, claimEmbedText, claimEmbedVersionKey, compactionDecision, NativeMemoryStore, type ClaimPart, type SearchHit } from './store';
import type { LedgerLevel, SearchMode } from '../../shared/claims';
import { hideStale } from '../claims/stale';
import { formatSearch, formatStatus, formatWakeUp, newestOrder, rankHits, WAKE_MAX_CHARS } from './format';
import { withHistoryCommands } from '../claims/historyPointer';
import { cardIdOfKey } from '../claims/get';
import { pinnedSection, pinnedStatus, type PinnedStatus } from '../memoryRollover';

export const PRIORITY = { search: 0, wake: 1, status: 1, ingest: 2, backfill: 3, compact: 4 } as const;
/** Chunks embedded per queue step before yielding (spec section 3: <= 8). ONE: a search that
 *  arrives mid-backfill waits for at most one step. Measured with the shipped worker on the full
 *  hive copy, an 8-chunk step put the engine-side wait's p95 at 255 ms and a 4-chunk step (~100 ms)
 *  still put the END-TO-END p95 during a backfill at 304 ms (the shim's own start is ~110-150 ms),
 *  over the Human's 250 ms speed gate. A 1-chunk step is ~25 ms. */
export const EMBED_BATCH = 1;
/** A source changed on disk is ingested this long after its LAST change (spec: >= 2 s). */
export const SOURCE_DEBOUNCE_MS = 2_000;
/** Drop the model after this long without an embed (Jim R2: idle unload). */
export const MODEL_IDLE_UNLOAD_MS = 10 * 60_000;
/** A reconcile that re-stats every source runs at most this often (a watcher can drop events). */
export const RECONCILE_EVERY_MS = 10 * 60_000;

export interface EmbedderLike {
  embed(texts: readonly string[]): Promise<Float32Array[]>;
  unload(): Promise<void>;
  readonly loaded: boolean;
}

export interface EngineDeps {
  hiveRoot: string;
  store: NativeMemoryStore;
  embedder: EmbedderLike;
  countTokens: (text: string) => number;
  now?: () => number;
  /** Non-recursive fs.watch; injected so tests can drive changes. Null = no watcher. */
  watch?: ((dir: string, onChange: (file: string) => void) => { close(): void }) | null;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  log?: (row: Record<string, unknown>) => void;
  /** Told when the idle timer drops the model (Jim N2: main then treats the next search as cold). */
  onModelUnload?: () => void;
  /** WARM-MEANS-MODEL-LOADED-189: told once per model load, at the first embed after start or after an
   *  idle unload (main then gives searches the warm budget, whatever op loaded it). */
  onModelLoaded?: () => void;
  /** Idle time before the model is dropped (default MODEL_IDLE_UNLOAD_MS; the speed bench
   *  shortens it to measure model-cold). */
  idleUnloadMs?: number;
  /** NATIVE-WAKEUP N1: how long a wake-up waits for its caller's own wing to be indexed (tests). */
  wakeWaitMs?: number;
  /** CLAIM-LEDGER: the Settings level (config claimLedger), for discovery's per-agent effective level. */
  claimLedger?: unknown;
  /** CLAIM-LEDGER: this build's highest level (tests); default IMPLEMENTED_LEVEL. */
  implementedLevel?: LedgerLevel;
  /** CLAIMS-HEAD-ANCHOR: the agents main holds an anchor for (A-2; discovery keeps them flagged). */
  anchored?: readonly string[];
  /** MEMORY-SEARCH-TIMEOUT-DURING-INDEX-189: told when indexing starts (the first claims sync,
   *  backfill or changed-source ingest) and when the last one ends, so main can give a search
   *  the indexing budget meanwhile. */
  onIndexing?: (on: boolean, kind: string) => void;
  /** Step 3 fix R2 (god bbcb4a): the current field values of the cards a search's hits name, from main's resolver
   *  (the ledgers live in main, not in the worker); absent, failing or slow = the hits print as before. */
  cardLead?: (cards: string[]) => Promise<Record<string, string[]>>;
}
/** R2: at most this many cards asked for per search. */
export const CARD_LEADS_MAX = 12;
/** The distinct card ids a search's hits name (claim keys `card.<id>[.field]`), in hit order, at most CARD_LEADS_MAX:
 *  the engine's card-lead ask and the L7 tool (claims90-search.cjs --hive) build the briefs from this one list. */
export const cardIdsOfHits = (hits: Array<Pick<SearchHit, 'claim'>>): string[] =>
  [...new Set(hits.map((h) => (h.claim?.key ? cardIdOfKey(h.claim.key) : null)).filter((c): c is string => !!c))].slice(0, CARD_LEADS_MAX);
/** The card briefs for these hits through the cardLead dep: none without a dep, on a throw or a non-object answer. */
export async function cardLeadsFor(hits: Array<Pick<SearchHit, 'claim'>>, cardLead: EngineDeps['cardLead']): Promise<Record<string, string[]>> {
  if (!cardLead) return {};
  const cards = cardIdsOfHits(hits);
  if (!cards.length) return {};
  try { const r = await cardLead(cards); return r && typeof r === 'object' ? r : {}; } catch { return {}; }
}

/** CLAIM-LEDGER: one agent's verified claim chunks, sent by main after an append (A6). */
export interface ClaimsSyncArgs { wing: string; path: string; head: string; chunks: ClaimPart[];
  /** The Settings level main holds now (W3-1): a sync never acts on a stale level. */
  claimLedger?: unknown }

/** NATIVE-WAKEUP N1 (Jim, god andyn1wait): the bound on a wake-up's wait for its own wing. */
export const WAKE_WAIT_MS = 5_000;

/** The anchored agents main sent: agent ids only, sorted, deduplicated, bounded. */
function anchoredList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((a): a is string => typeof a === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(a)))].sort().slice(0, 1000);
}

interface Task { priority: number; seq: number; label: string; deadline?: number; run: () => Promise<void>; expire: () => void }

/** The step names a request's timing reports (indexed by priority). */
const PRIORITY_LABEL = ['search', 'wake-up/status', 'ingest', 'backfill', 'compact'];
/** Where a request's time went inside the worker: queued, running, and the step that was
 *  running when it was queued (main logs it on a degraded or late reply). */
export interface QueueTiming { waitMs: number; runMs: number; inFlight: string | null }
/** A request whose deadline passed while it was queued: answered, never run. */
export class QueueExpired extends Error {
  constructor(readonly timing: QueueTiming) { super('expired'); }
}

export interface SearchArgs { query: string; wing?: string | null; room?: string | null; results?: number; since?: string | null; before?: string | null;
  /** CLAIM-LEDGER read modes and claim filters (A5). */
  mode?: SearchMode; kind?: string | null; key?: string | null;
  /** CLAIMS-90 M1: the verbose (whole-chunk) text; the default is the compact text. */
  full?: boolean;
  /** CLAIMS-90 R2 (C90-GET): `--exact` scans text (chunks + PROTOCOL.md + board.md), no embedding; `--newest` orders newest first. */
  exact?: boolean;
  newest?: boolean;
  /** The asking agent's own wing (from its MEMORY_TOKEN): never a filter, only a backfill hint. */
  caller?: string | null }
export interface EngineReply { exit: number; text: string; json?: unknown }

/** T3 (god fe1140): in live mode a confirmed-superseded claim hit (the `prior` row) is dropped, so a stale value never sits
 *  beside the current one; `--history` / `--all` keep it, as does C90_HIDE_STALE=0. `prior?` (unconfirmed) and markdown stay. */
export function dropStale<T extends { claim?: { status: string } | null }>(hits: T[], mode: SearchMode | undefined, k: number, env: NodeJS.ProcessEnv = process.env): T[] {
  if ((mode ?? 'live') !== 'live' || !hideStale(env)) return hits.slice(0, k);
  return hits.filter((h) => !h.claim || h.claim.status !== 'superseded').slice(0, k);
}
/** The rows to fetch so k survive the drop (the store caps at 100). */
export const staleFetchK = (k: number, mode: SearchMode | undefined, env: NodeJS.ProcessEnv = process.env): number =>
  (mode ?? 'live') === 'live' && hideStale(env) ? Math.min(100, k * 2) : k;

export class MemoryEngine {
  private queue: Task[] = [];
  private seq = 0;
  private current: Task | null = null;
  /** Claims syncs, backfills and changed-source ingests running now (onIndexing). */
  private indexingN = 0;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;
  private debounce = new Map<string, unknown>();
  private watchers: Array<{ close(): void }> = [];
  private unloadTimer: unknown = null;
  /** onModelLoaded has been told about the model loaded now. */
  private modelAnnounced = false;
  private lastReconcileAt = 0;
  /** The backfill in progress (one at a time; a second caller waits for the same one). */
  private backfilling: Promise<{ discovery: Discovery; embedded: number; removed: number }> | null = null;
  /** Paths whose ingest failed, with the error (the migration report's "failed"). */
  readonly failed = new Map<string, string>();
  /** NATIVE-WAKEUP-EMPTY-INDEX (b): wings a caller asked about. A backfill in progress takes their
   *  sources NEXT (checked before every source), so an agent's own memory is indexed first even
   *  when the backfill had already started without it (e.g. at app start). */
  private readonly preferredWings = new Set<string>();
  /** The sources the running backfill has not taken yet (N1: is a wing still waiting?). */
  private backfillRemaining: SourceEntry[] = [];
  /** Wake-ups waiting for a wing's last source to be committed. */
  private readonly wingWaiters = new Map<string, Array<() => void>>();

  /** Does the running backfill still have sources of this wing to take (or one in flight)? */
  private wingPending(wing: string): boolean {
    return !!this.backfilling && (this.backfillRemaining.some((e) => e.wing === wing) || this.inFlightWing === wing);
  }
  private inFlightWing: string | null = null;

  /** Resolve when the backfill has committed the wing's last source, or after `ms`. */
  private waitForWing(wing: string, ms: number): Promise<void> {
    if (!this.wingPending(wing)) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => { if (!done) { done = true; resolve(); } };
      const list = this.wingWaiters.get(wing) ?? [];
      list.push(finish);
      this.wingWaiters.set(wing, list);
      this.setTimer(finish, ms);
      // The whole backfill ending also releases the wait.
      void this.backfilling?.then(finish, finish);
    });
  }

  private wingDone(wing: string): void {
    if (this.backfillRemaining.some((e) => e.wing === wing)) return;
    for (const f of this.wingWaiters.get(wing) ?? []) f();
    this.wingWaiters.delete(wing);
  }

  /** Mark a caller's wing as wanted: the running (or next) backfill indexes it first. */
  preferWing(wing: string | null | undefined): void {
    if (typeof wing === 'string' && /^[A-Za-z0-9._-]{1,120}$/.test(wing)) this.preferredWings.add(wing);
  }
  stats = { embedded: 0, embedMs: 0, searches: 0 };

  constructor(private readonly d: EngineDeps) {
    this.now = d.now ?? Date.now;
    this.setTimer = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
    this.claimLedger = d.claimLedger;
    this.anchored = anchoredList(d.anchored);
  }

  // — the queue —

  private enqueue<T>(priority: number, fn: () => Promise<T>, o: { deadline?: number; timing?: (t: QueueTiming) => void } = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const at = this.now();
      const inFlight = this.current?.label ?? null;
      const timing = (start: number): QueueTiming => ({ waitMs: start - at, runMs: this.now() - start, inFlight });
      this.queue.push({
        priority, seq: this.seq++, label: PRIORITY_LABEL[priority] ?? String(priority), deadline: o.deadline,
        run: () => { const start = this.now(); return fn().then((v) => { o.timing?.(timing(start)); resolve(v); }, reject); },
        // Never ran: runMs is 0 by definition (one clock read; two could differ by a tick).
        expire: () => reject(new QueueExpired({ waitMs: this.now() - at, runMs: 0, inFlight }))
      });
      this.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      this.pump();
    });
  }

  private pump(): void {
    if (this.current) return;
    let t = this.queue.shift();
    // MEMORY-SEARCH-TIMEOUT-DURING-INDEX-189 (C): a request whose caller already gave up (its
    // deadline passed while it was queued) is answered expired, never run, so it costs the
    // requests behind it nothing.
    while (t && t.deadline !== undefined && this.now() > t.deadline) { t.expire(); t = this.queue.shift(); }
    if (!t) return;
    this.current = t;
    void t.run().finally(() => {
      this.current = null;
      // Yield to the event loop between steps: incoming messages (a search) are queued first.
      this.setTimer(() => this.pump(), 0);
    });
  }

  /** Run one indexing job, telling onIndexing when the first starts and the last ends (also
   *  when it throws). */
  private async indexing<T>(kind: string, fn: () => Promise<T>): Promise<T> {
    if (this.indexingN++ === 0) this.d.onIndexing?.(true, kind);
    try { return await fn(); } finally { if (--this.indexingN === 0) this.d.onIndexing?.(false, kind); }
  }

  /** Pending tasks by priority (diagnostics, tests). */
  queued(): number[] {
    return this.queue.map((t) => t.priority);
  }

  // — embedding —

  private async embed(texts: string[]): Promise<Float32Array[]> {
    const t0 = this.now();
    const v = await this.d.embedder.embed(texts);
    this.stats.embedded += texts.length;
    this.stats.embedMs += this.now() - t0;
    // Jim N3: an empty list returns early without loading the model, so it announces nothing.
    if (texts.length > 0 && !this.modelAnnounced) { this.modelAnnounced = true; this.d.onModelLoaded?.(); }
    if (this.unloadTimer) this.clearTimer(this.unloadTimer);
    this.unloadTimer = this.setTimer(() => { this.unloadTimer = null; this.modelAnnounced = false; void this.d.embedder.unload(); this.d.onModelUnload?.(); }, this.d.idleUnloadMs ?? MODEL_IDLE_UNLOAD_MS);
    return v;
  }

  // — requests —

  /** `deadline` (epoch ms): past it, the queued search is answered QueueExpired and not run.
   *  `timing` is told where the search's time went once it has run. */
  search(a: SearchArgs, o: { deadline?: number; timing?: (t: QueueTiming) => void } = {}): Promise<EngineReply> {
    // (b) The wing searched, else the caller's own, is wanted: index it first.
    this.preferWing(a.wing ?? a.caller ?? null);
    return this.enqueue(PRIORITY.search, async () => {
      this.stats.searches++;
      const sinceMs = a.since ? Date.parse(a.since) : null;
      const beforeMs = a.before ? Date.parse(a.before) : null;
      const k = a.results ?? 5;
      const fetchK = staleFetchK(k, a.mode);
      // CLAIMS-90 R2 (C90-GET): the JSON keeps its array shape; under --newest every row also carries both ranks
      // (rankNewest = the printed order, rankCurrent = the compact order) so one run scores both.
      const json = (hits: SearchHit[]): unknown[] => {
        if (!a.newest) return hits.map(redactHit);
        const cur = rankHits(a.query, hits);
        return newestOrder(a.query, hits).map((h, i) => ({ ...redactHit(h), rankNewest: i + 1, rankCurrent: cur.indexOf(h) + 1 }));
      };
      if (a.exact) {
        // Exact text: a substring scan of the chunks (no embedding, so it answers with the model unloaded), then
        // the hive's PROTOCOL.md and board.md read as text from the served root (board.md is outside the source
        // allow-list, so neither is relied on to be indexed). File lines belong to no wing: a wing/room/kind/key
        // filter leaves them out.
        const needle = exactNeedle(a.query);
        const chunks = needle ? this.d.store.searchExact({ query: needle, wing: a.wing ?? null, room: a.room ?? null, sinceMs, beforeMs, k: fetchK, mode: a.mode ?? 'live', kind: a.kind ?? null, key: a.key ?? null }) : [];
        const files = needle && !a.wing && !a.room && !a.kind && !a.key ? exactFileHits(this.d.hiveRoot, needle, k) : [];
        const all = servedHits([...dropStale(chunks, a.mode, k), ...files]);  // matched on raw text, rewritten for display
        return { exit: 0, text: formatSearch(a.query, a, all, await this.cardLeads(all)), json: json(all) };
      }
      const [qv] = await this.embed([a.query]);
      const hits = servedHits(dropStale(this.d.store.search({ query: a.query, queryVec: qv, wing: a.wing ?? null, room: a.room ?? null, sinceMs, beforeMs, k: fetchK, poolK: k, mode: a.mode ?? 'live', kind: a.kind ?? null, key: a.key ?? null }), a.mode, k));  // CLAIMS-90 HISTORY-PTR
      return { exit: 0, text: formatSearch(a.query, a, hits, await this.cardLeads(hits)), json: json(hits) };
    }, o);
  }

  /** Step 3 fix R2: the card briefs for the distinct cards the hits name (claim keys `card.<id>[.field]`), in hit order. */
  private cardLeads(hits: SearchHit[]): Promise<Record<string, string[]>> { return cardLeadsFor(hits, this.d.cardLead); }

  async wakeUp(wing: string | null, full = false): Promise<EngineReply> {
    // (b) A wake-up is the caller's (or an explicit) wing: index it first.
    this.preferWing(wing);
    // N1: a task-start wake-up on a still-filling index waits (bounded) for ITS wing's sources,
    // then answers with whatever is indexed. A search never waits.
    if (wing) await this.waitForWing(wing, this.d.wakeWaitMs ?? WAKE_WAIT_MS);
    return this.enqueue(PRIORITY.wake, async () => {
      let identity: string | null = null;
      let pinned: string | null = null;
      if (wing && /^[A-Za-z0-9._-]+$/.test(wing)) {
        try { identity = readFileSync(join(this.d.hiveRoot, 'agents', wing, 'identity.md'), 'utf8'); } catch { identity = null; }
        // PINNED-MEMORY: the standing lessons, read from memory.md itself (never ranked or cut up).
        try { pinned = pinnedSection(readFileSync(join(this.d.hiveRoot, 'agents', wing, 'memory.md'), 'utf8')); } catch { pinned = null; }
      }
      const entries = this.d.store.wakeUp(wing, WAKE_MAX_CHARS).map((e) => ({ ...e, content: withHistoryCommands(e.content) }));
      if (pinned) pinned = withHistoryCommands(pinned);
      // CLAIMS-90 M1: compact by default (under the condenser cap); `--full` is the whole text.
      return { exit: 0, text: formatWakeUp(identity, entries, pinned, { full }) };
    });
  }

  status(): Promise<EngineReply> {
    return this.enqueue(PRIORITY.status, async () => {
      const c = this.d.store.counts();
      const perWing = this.d.store.db.prepare('SELECT wing, count(*) AS chunks FROM chunks GROUP BY wing ORDER BY wing').all() as Array<{ wing: string; chunks: number }>;
      // PINNED-MEMORY: every agent's standing-lessons section, read from its memory.md (small files).
      const memoryPinned: PinnedStatus[] = [];
      try {
        for (const e of readdirSync(join(this.d.hiveRoot, 'agents'), { withFileTypes: true })) {
          if (!e.isDirectory() || !/^[A-Za-z0-9._-]+$/.test(e.name)) continue;
          let text: string | null = null;
          try { text = readFileSync(join(this.d.hiveRoot, 'agents', e.name, 'memory.md'), 'utf8'); } catch { continue; }
          memoryPinned.push(pinnedStatus(e.name, text));
        }
      } catch { /* no agents dir */ }
      const s = { ...c, dbBytes: this.d.store.fileBytes(), perWing, memoryPinned };
      return { exit: 0, text: formatStatus(s), json: { ...s, embedded: this.stats.embedded, failed: this.failed.size, modelLoaded: this.d.embedder.loaded } };
    });
  }

  // — ingestion —

  private readSource(e: SourceEntry): { meta: { path: string; sha256: string; kind: string; wing: string; room: string; mtimeMs: number; bytes: number }; text: string } | null {
    try {
      const buf = readFileSync(e.abs);
      const st = statSync(e.abs);
      return { meta: { path: e.path, sha256: sha256(buf), kind: e.kind, wing: e.wing, room: e.room, mtimeMs: st.mtimeMs, bytes: buf.length }, text: buf.toString('utf8') };
    } catch (err) {
      this.failed.set(e.path, String((err as Error).message ?? err));
      return null;
    }
  }

  /** Chunk-diff one source into the index, embedding its new chunks EMBED_BATCH at a time
   *  (each batch its own queue step). `priority` separates a changed-source ingest from the
   *  initial backfill. Returns the number of chunks embedded. */
  private async ingestEntry(e: SourceEntry, priority: number): Promise<number> {
    // CLAIM-LEDGER: a claims source is filled by main's verified syncs (syncClaims), never read here.
    if (e.kind === 'claims') return 0;
    const src = this.readSource(e);
    if (!src) return 0;
    if (this.d.store.sourceShas().get(e.path) === src.meta.sha256) return 0;
    const chunks = chunkMarkdown(src.text, this.d.countTokens);
    for (let attempt = 0; attempt < 2; attempt++) {
      const plan = this.d.store.planDiff(e.path, chunks);
      const vectors: Float32Array[] = [];
      for (let i = 0; i < plan.add.length; i += EMBED_BATCH) {
        const batch = plan.add.slice(i, i + EMBED_BATCH).map((c: Chunk) => c.content);
        vectors.push(...await this.enqueue(priority, () => this.embed(batch)));
      }
      const ok = await this.enqueue(priority, async () => this.d.store.applyDiff(src.meta, plan, vectors, this.now(), ALLOW_LIST_VERSION));
      if (ok) { this.failed.delete(e.path); return plan.add.length; }
    }
    this.failed.set(e.path, 'the source changed during two ingest attempts');
    return 0;
  }

  /** Reconcile the index with the allow-list: ingest new/changed sources, remove vanished ones.
   *  Resumable: a source is committed only when all its chunks are in, so an interrupted
   *  backfill just continues with the sources whose SHA does not match yet. */
  backfill(): Promise<{ discovery: Discovery; embedded: number; removed: number }> {
    if (this.backfilling) return this.backfilling;
    this.lastReconcileAt = this.now();
    this.d.store.setMeta('chunker_version', String(CHUNKER_VERSION));
    this.d.store.setMeta('allow_list_version', String(ALLOW_LIST_VERSION));
    const run = this.indexing('backfill', async () => {
      const discovery = this.discover();
      let embedded = 0;
      let removed = 0;
      const wanted = new Set(discovery.eligible.map((e) => e.path));
      const pending = this.claimsPending(discovery);
      for (const path of this.d.store.sourceShas().keys()) {
        if (!wanted.has(path) && !pending(path)) { await this.enqueue(PRIORITY.backfill, async () => this.d.store.removeSource(path)); removed++; }
      }
      // (b) Before EACH source, a preferred wing (a caller that asked meanwhile) goes first.
      const remaining = this.backfillRemaining = [...discovery.eligible];
      while (remaining.length) {
        const i = Math.max(0, remaining.findIndex((x) => this.preferredWings.has(x.wing)));
        const [e] = remaining.splice(i, 1);
        this.inFlightWing = e.wing;
        try { embedded += await this.ingestEntry(e, PRIORITY.backfill); }
        finally { this.inFlightWing = null; this.wingDone(e.wing); }
      }
      this.d.log?.({ kind: 'native-memory-backfill', eligible: discovery.eligible.length, embedded, removed, failed: this.failed.size });
      return { discovery, embedded, removed };
    }).finally(() => { this.backfilling = null; });
    this.backfilling = run;
    return run;
  }

  /** Discovery with the ledger levels (the setting from main, the manifest, this build). */
  private discover(): Discovery {
    return discoverSources(this.d.hiveRoot, undefined, { claimLedger: this.claimLedger, anchored: this.anchored, ...(this.d.implementedLevel ? { implemented: this.d.implementedLevel } : {}) });
  }

  /** CLAIM-LEDGER: the Settings level as main last told this worker (W3-1: it follows changes). */
  private claimLedger: unknown;
  /** CLAIMS-HEAD-ANCHOR: the anchored agents as main last told this worker (A-2). */
  private anchored: string[] = [];

  /**
   * W3-1 (Jim): main tells a running worker the current Settings level. A change reconciles at
   * once (a drop to shadow removes the claims and re-ingests memory.md; a raise swaps them), and
   * the call resolves only after that, so the next search already sees the new level.
   */
  async setClaimLedger(value: unknown, anchored?: unknown): Promise<{ changed: boolean; removed: number; embedded: number }> {
    const next = anchored === undefined ? this.anchored : anchoredList(anchored);
    const same = this.claimLedger === value && next.join(',') === this.anchored.join(',');
    this.claimLedger = value;
    this.anchored = next;
    if (same) return { changed: false, removed: 0, embedded: 0 };
    const r = await this.reconcileNow();
    return { changed: true, removed: r.removed, embedded: r.embedded };
  }

  /** A full reconcile now (after any running one): a level or manifest change. */
  async reconcileNow(): Promise<{ removed: number; embedded: number }> {
    if (this.backfilling) await this.backfilling.catch(() => undefined);
    const r = await this.backfill();
    return { removed: r.removed, embedded: r.embedded };
  }

  /** CL-READERWATCHER MUST-1 (Jim): a wing whose claims are a source but have never been applied
   *  (no claims source indexed yet) keeps its replaced markdown, so a search between the swap and
   *  the first claims sync still finds its notes. Returns a test for an indexed path. */
  private claimsPending(d: Discovery): (path: string) => boolean {
    const indexed = this.d.store.sourceShas();
    const wings = d.eligible.filter((e) => e.kind === 'claims' && !indexed.has(e.path)).map((e) => `agents/${e.wing}/`);
    return (path) => wings.some((w) => path.startsWith(w));
  }

  /** W3-1 (a): remove a wing's indexed sources that are no longer eligible (its markdown, once its
   *  claims are a source), so a claim never lands beside what it replaces. MUST-1: called in the
   *  queue step that applies the claims, so search sees the markdown or the claims, never neither. */
  private dropIneligible(wing: string, d: Discovery): number {
    const keep = new Set(d.eligible.map((e) => e.path));
    let n = 0;
    for (const p of this.d.store.sourceShas().keys()) {
      if (p.startsWith(`agents/${wing}/`) && !keep.has(p)) { this.d.store.removeSource(p); n++; }
    }
    return n;
  }

  // — CLAIM-LEDGER (W3) —

  private claimSyncs = new Map<string, Promise<unknown>>();

  /**
   * Index one agent's claim chunks as main sent them (verified, derived): embed only new parts,
   * update statuses in place (A4). Refused for an agent that is not reader or writer here (then its
   * claims are not a source, and the reconcile removes any that were). Serialised per agent.
   */
  syncClaims(a: ClaimsSyncArgs): Promise<{ embedded: number; dropped: number; statusChanges: number; roomChanges: number }> {
    const prior = this.claimSyncs.get(a.wing) ?? Promise.resolve();
    const run = prior.catch(() => undefined).then(() => this.indexing('claims-sync', async () => {
      // Indexed only while the agent's claims are a source (reader/writer AND a ledger exists), so a
      // claim never sits in the index beside the markdown it replaces.
      // A sync carries main's CURRENT Settings level: follow it first (W3-1), then check.
      if ('claimLedger' in a && this.claimLedger !== a.claimLedger) await this.setClaimLedger(a.claimLedger);
      const d = this.discover();
      if (!d.eligible.some((e) => e.kind === 'claims' && e.wing === a.wing)) throw new Error(`claims are not indexed for ${a.wing} (level ${d.ledgerLevels[a.wing] ?? 'off'})`);
      // CL-S1 M3: a wing embedded under an older claim-vector recipe re-embeds all its parts once.
      const plan = await this.enqueue(PRIORITY.ingest, async () => {
        const reembed = this.d.store.meta(claimEmbedVersionKey(a.wing)) !== String(CLAIM_EMBED_VERSION);
        return this.d.store.planClaims(a.wing, a.chunks, { reembed });
      });
      const vectors: Float32Array[] = [];
      for (let i = 0; i < plan.add.length; i += EMBED_BATCH) {
        // The vector is the claim's text, never its `kind · key · date` header (claimEmbedText).
        const batch = plan.add.slice(i, i + EMBED_BATCH).map((p) => claimEmbedText(p.content));
        vectors.push(...await this.enqueue(PRIORITY.ingest, () => this.embed(batch)));
      }
      // W3-1 (a) + MUST-1 (Jim): the replaced markdown leaves in the same queue step that applies the
      // claims (not at plan time: searches run between the embeds and would see neither).
      await this.enqueue(PRIORITY.ingest, async () => {
        this.d.store.applyClaims(a.path, plan, vectors, { head: a.head, nowMs: this.now(), manifestVersion: ALLOW_LIST_VERSION, embedVersion: CLAIM_EMBED_VERSION });
        this.dropIneligible(a.wing, this.discover());
      });
      this.d.log?.({ kind: 'claims-indexed', wing: a.wing, embedded: plan.add.length, dropped: plan.drop.length, statusChanges: plan.status.length, roomChanges: plan.rooms?.length ?? 0 });
      return { embedded: plan.add.length, dropped: plan.drop.length, statusChanges: plan.status.length, roomChanges: plan.rooms?.length ?? 0 };
    }));
    this.claimSyncs.set(a.wing, run.catch(() => undefined));
    return run;
  }

  /** CL-M4-WP step 3: vectors for main's note-candidate scorer. Through the queue at search
   *  priority (never beside a backfill's embedding) and the idle-unload timer (Jim S2). */
  embedTexts(texts: string[]): Promise<Float32Array[]> {
    return this.enqueue(PRIORITY.search, () => this.embed(texts));
  }

  /** R5 candidates for a just-appended claim (W3 side of R5CandidatesFn). */
  r5Candidates(wing: string, claimId: string, tau2: number): Promise<Array<{ b: string; cosine: number }>> {
    return this.enqueue(PRIORITY.search, async () => this.d.store.claimNeighbours(wing, claimId, tau2));
  }

  private manifestTimer: unknown = null;
  /** memory-sources.json changed: a full reconcile after SOURCE_DEBOUNCE_MS (W3-1). */
  manifestChanged(): void {
    if (this.manifestTimer) this.clearTimer(this.manifestTimer);
    this.manifestTimer = this.setTimer(() => { this.manifestTimer = null; void this.reconcileNow().catch(() => undefined); }, SOURCE_DEBOUNCE_MS);
  }

  /** A watched file changed: debounce, then ingest just that source (or remove it). */
  sourceChanged(absPath: string): void {
    const prev = this.debounce.get(absPath);
    if (prev) this.clearTimer(prev);
    this.debounce.set(absPath, this.setTimer(() => {
      this.debounce.delete(absPath);
      const d = this.discover();
      const e = d.eligible.find((x) => x.abs === absPath);
      if (e) { void this.indexing('ingest', () => this.ingestEntry(e, PRIORITY.ingest)); return; }
      // Not eligible (or gone): if it was indexed, remove it, unless its wing's claims are not
      // applied yet (MUST-1) and the file is still there.
      const rel = absPath.slice(this.d.hiveRoot.length + 1).split(/[\\/]/).join('/');
      if (this.claimsPending(d)(rel) && existsSync(absPath)) return;
      if (this.d.store.sourceShas().has(rel)) void this.enqueue(PRIORITY.ingest, async () => this.d.store.removeSource(rel));
    }, SOURCE_DEBOUNCE_MS));
  }

  /** Watch the allow-list only, NON-recursively: the agents dir (new agents), each agent dir,
   *  and the hive root (the top-level list). */
  startWatching(): void {
    const w = this.d.watch === undefined ? defaultWatch : this.d.watch;
    if (!w) return;
    const on = (dir: string) => (file: string): void => {
      if (/\.md$/i.test(file)) this.sourceChanged(join(dir, file));
      // W3-1: a manifest change (per-agent ledger levels, opt-ins) reconciles, debounced.
      else if (dir === this.d.hiveRoot && file === SOURCES_CONFIG_FILE) this.manifestChanged();
    };
    const agentsDir = join(this.d.hiveRoot, 'agents');
    const watched = new Set<string>();
    const watchAgent = (dir: string): void => {
      if (watched.has(dir)) return;
      watched.add(dir);
      try { this.watchers.push(w(dir, on(dir))); } catch { /* the reconcile covers it */ }
    };
    try { this.watchers.push(w(this.d.hiveRoot, on(this.d.hiveRoot))); } catch { /* ditto */ }
    try {
      this.watchers.push(w(agentsDir, (name) => { if (/^[A-Za-z0-9._-]+$/.test(name)) watchAgent(join(agentsDir, name)); }));
    } catch { /* no agents dir yet */ }
    for (const e of this.discover().eligible) {
      if (e.kind !== 'top-level' && e.kind !== 'claims') watchAgent(join(this.d.hiveRoot, ...e.path.split('/').slice(0, 2)));
    }
  }

  /** Idle tick: a periodic reconcile (a watcher can drop events), then compaction if due. */
  async idle(): Promise<void> {
    if (this.now() - this.lastReconcileAt >= RECONCILE_EVERY_MS) await this.backfill();
    await this.enqueue(PRIORITY.compact, async () => {
      this.d.store.checkpoint();
    });
  }

  /** The compaction decision for the current file (the worker performs the swap). */
  compactionDue(): 'none' | 'compact' | 'force' {
    const s = this.d.store;
    return compactionDecision(s.fileBytes(), s.liveEstimateBytes(), s.freelistRatio());
  }

  /**
   * Section 7 idle maintenance, as ONE compaction-priority queue step (so no search or ingest
   * runs across it): checkpoint, `VACUUM INTO` a same-volume staging file, verify it (integrity,
   * counts, generation), then close, keep the current file as the one retained prior, move the
   * staging file in, and reopen. Returns what happened.
   */
  compact(reopen: (file: string) => NativeMemoryStore, rename: (a: string, b: string) => void, remove: (f: string) => void, force = false): Promise<string> {
    return this.enqueue(PRIORITY.compact, async () => {
      const s = this.d.store;
      const decision = this.compactionDue();
      if (decision === 'none' && !force) return 'not-due';
      s.checkpoint();
      const staging = `${s.file}.compact-${this.now()}`;
      const opts = this.storeOpenOptions;
      if (!opts) return 'no-open-options';
      const v = s.vacuumInto(staging, opts);
      if (!v.ok) { try { remove(staging); } catch { /* best-effort */ } return `verify-failed:${v.why}`; }
      s.close();
      const prior = `${s.file}.prior`;
      try { remove(prior); } catch { /* none */ }
      for (const side of ['-wal', '-shm']) { try { remove(`${s.file}${side}`); } catch { /* none */ } }
      rename(s.file, prior);
      rename(staging, s.file);
      this.d.store = reopen(s.file);
      this.d.log?.({ kind: 'native-memory-compacted', decision });
      return `compacted:${decision}`;
    });
  }

  /** The live store (it changes across a compaction swap). */
  storeRef(): NativeMemoryStore {
    return this.d.store;
  }

  /** Set by the worker: how to open a staging copy for verification. */
  storeOpenOptions: import('./store').StoreOpenOptions | null = null;

  async close(): Promise<void> {
    for (const t of this.debounce.values()) this.clearTimer(t);
    this.debounce.clear();
    if (this.manifestTimer) { this.clearTimer(this.manifestTimer); this.manifestTimer = null; }
    for (const w of this.watchers) { try { w.close(); } catch { /* gone */ } }
    this.watchers = [];
    if (this.unloadTimer) this.clearTimer(this.unloadTimer);
    this.modelAnnounced = false;
    await this.d.embedder.unload();
  }
}

function defaultWatch(dir: string, onChange: (file: string) => void): FSWatcher {
  return fsWatch(dir, { persistent: false }, (_ev, f) => { if (f) onChange(String(f)); });
}

/** Shadow diagnostics and JSON output carry no content: ids, sources, ranks, scores. */
/** CLAIMS-90 R2: the exact-text needle: trimmed, matching outer quotes dropped, whitespace folded, lower-cased,
 *  markdown emphasis (`**`) and backticks dropped (god 6f7b2c: exact ignores markup on every source). */
export function exactNeedle(q: string): string {
  let s = q.trim().replace(/\s+/g, ' ');
  const m = /^(["'`])(.*)\1$/.exec(s);
  if (m) s = m[2].trim();
  return stripMarkup(s.toLowerCase());
}

/** The markup `--exact` ignores on both sides (needle and text): `**` and backticks. Mirrors store.searchExact's SQL. */
export const stripMarkup = (s: string): string => s.replace(/\*\*/g, '').replace(/`/g, '');

/** The hive files `--exact` reads as text from the served root (god 8218c8: PROTOCOL.md and board.md, the D5 rows). */
export const EXACT_TEXT_FILES = ['PROTOCOL.md', 'board.md'] as const;

/**
 * CLAIMS-90 R2: the lines of PROTOCOL.md and board.md that hold the needle, as hits whose source is `<file>:<line>`
 * (wing `hive`, room `docs`, no claim), at most `k` per file, in file order. A missing file is no hit.
 */
/** CLAIMS-90 HISTORY-PTR: every served hit (semantic, bm25 or --exact file line) shows old memory.md anchors as commands. */
export const servedHits = (hits: SearchHit[]): SearchHit[] => hits.map((h) => ({ ...h, content: withHistoryCommands(h.content) }));

export function exactFileHits(hiveRoot: string, needle: string, k: number): SearchHit[] {
  const out: SearchHit[] = [];
  for (const file of EXACT_TEXT_FILES) {
    let text: string; let filedAt = 0;
    try { const p = join(hiveRoot, file); text = readFileSync(p, 'utf8'); filedAt = Math.floor(statSync(p).mtimeMs); } catch { continue; }
    const lines = text.split(/\r?\n/);
    let n = 0;
    for (let i = 0; i < lines.length && n < k; i++) {
      if (!stripMarkup(lines[i].toLowerCase()).includes(needle)) continue;
      n++;
      out.push({ chunkId: -(out.length + 1), wing: 'hive', room: 'docs', source: `${file}:${i + 1}`, content: lines[i].trim(), cosineSim: null, bm25: null, score: 0, claim: null, filedAt });
    }
  }
  return out;
}

export function redactHit(h: SearchHit): Record<string, unknown> {
  return { chunkId: h.chunkId, wing: h.wing, room: h.room, source: h.source, cosineSim: h.cosineSim, bm25: h.bm25,
    ...(h.claim ? { claimId: h.claim.id, status: h.claim.status } : {}) };
}
