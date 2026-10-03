/**
 * NATIVE-MEMORY section 3: the engine that lives INSIDE the memory worker (a utility process).
 * It is the only owner of the SQLite connection, sqlite-vec, ONNX Runtime, the source watcher
 * and the write queue. Electron main never does any of that (Jim R1-R3).
 *
 * ONE serialized queue, by priority: search > wake-up/status > changed-source ingest > initial
 * backfill > compaction. Long work is cut into steps (a backfill embeds at most 8 chunks per
 * step and then yields), so a search that arrives mid-backfill waits for one step, not for
 * the backfill.
 */
import { readdirSync, readFileSync, statSync, watch as fsWatch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { chunkMarkdown, CHUNKER_VERSION, type Chunk } from './chunker';
import { discoverSources, ALLOW_LIST_VERSION, SOURCES_CONFIG_FILE, sha256, type Discovery, type SourceEntry } from './sources';
import { compactionDecision, NativeMemoryStore, type ClaimPart, type SearchHit } from './store';
import type { LedgerLevel, SearchMode } from '../../shared/claims';
import { formatSearch, formatStatus, formatWakeUp, WAKE_MAX_CHARS } from './format';
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
  /** Idle time before the model is dropped (default MODEL_IDLE_UNLOAD_MS; the speed bench
   *  shortens it to measure model-cold). */
  idleUnloadMs?: number;
  /** NATIVE-WAKEUP N1: how long a wake-up waits for its caller's own wing to be indexed (tests). */
  wakeWaitMs?: number;
  /** CLAIM-LEDGER: the Settings level (config claimLedger), for discovery's per-agent effective level. */
  claimLedger?: unknown;
  /** CLAIM-LEDGER: this build's highest level (tests); default IMPLEMENTED_LEVEL. */
  implementedLevel?: LedgerLevel;
}

/** CLAIM-LEDGER: one agent's verified claim chunks, sent by main after an append (A6). */
export interface ClaimsSyncArgs { wing: string; path: string; head: string; chunks: ClaimPart[];
  /** The Settings level main holds now (W3-1): a sync never acts on a stale level. */
  claimLedger?: unknown }

/** NATIVE-WAKEUP N1 (Jim, god andyn1wait): the bound on a wake-up's wait for its own wing. */
export const WAKE_WAIT_MS = 5_000;

interface Task { priority: number; seq: number; run: () => Promise<void> }

export interface SearchArgs { query: string; wing?: string | null; room?: string | null; results?: number; since?: string | null; before?: string | null;
  /** CLAIM-LEDGER read modes and claim filters (A5). */
  mode?: SearchMode; kind?: string | null; key?: string | null;
  /** The asking agent's own wing (from its MEMORY_TOKEN): never a filter, only a backfill hint. */
  caller?: string | null }
export interface EngineReply { exit: number; text: string; json?: unknown }

export class MemoryEngine {
  private queue: Task[] = [];
  private seq = 0;
  private running = false;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;
  private debounce = new Map<string, unknown>();
  private watchers: Array<{ close(): void }> = [];
  private unloadTimer: unknown = null;
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
  }

  // — the queue —

  private enqueue<T>(priority: number, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ priority, seq: this.seq++, run: () => fn().then(resolve, reject) });
      this.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
      this.pump();
    });
  }

  private pump(): void {
    if (this.running) return;
    const t = this.queue.shift();
    if (!t) return;
    this.running = true;
    void t.run().finally(() => {
      this.running = false;
      // Yield to the event loop between steps: incoming messages (a search) are queued first.
      this.setTimer(() => this.pump(), 0);
    });
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
    if (this.unloadTimer) this.clearTimer(this.unloadTimer);
    this.unloadTimer = this.setTimer(() => { this.unloadTimer = null; void this.d.embedder.unload(); this.d.onModelUnload?.(); }, this.d.idleUnloadMs ?? MODEL_IDLE_UNLOAD_MS);
    return v;
  }

  // — requests —

  search(a: SearchArgs): Promise<EngineReply> {
    // (b) The wing searched, else the caller's own, is wanted: index it first.
    this.preferWing(a.wing ?? a.caller ?? null);
    return this.enqueue(PRIORITY.search, async () => {
      this.stats.searches++;
      const sinceMs = a.since ? Date.parse(a.since) : null;
      const beforeMs = a.before ? Date.parse(a.before) : null;
      const [qv] = await this.embed([a.query]);
      const hits = this.d.store.search({ query: a.query, queryVec: qv, wing: a.wing ?? null, room: a.room ?? null, sinceMs, beforeMs, k: a.results ?? 5, mode: a.mode ?? 'live', kind: a.kind ?? null, key: a.key ?? null });
      return { exit: 0, text: formatSearch(a.query, a, hits), json: hits.map(redactHit) };
    });
  }

  async wakeUp(wing: string | null): Promise<EngineReply> {
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
      const entries = this.d.store.wakeUp(wing, WAKE_MAX_CHARS);
      return { exit: 0, text: formatWakeUp(identity, entries, pinned) };
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
    const run = (async () => {
      const discovery = this.discover();
      let embedded = 0;
      let removed = 0;
      const wanted = new Set(discovery.eligible.map((e) => e.path));
      for (const path of this.d.store.sourceShas().keys()) {
        if (!wanted.has(path)) { await this.enqueue(PRIORITY.backfill, async () => this.d.store.removeSource(path)); removed++; }
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
    })().finally(() => { this.backfilling = null; });
    this.backfilling = run;
    return run;
  }

  /** Discovery with the ledger levels (the setting from main, the manifest, this build). */
  private discover(): Discovery {
    return discoverSources(this.d.hiveRoot, undefined, { claimLedger: this.claimLedger, ...(this.d.implementedLevel ? { implemented: this.d.implementedLevel } : {}) });
  }

  /** CLAIM-LEDGER: the Settings level as main last told this worker (W3-1: it follows changes). */
  private claimLedger: unknown;

  /**
   * W3-1 (Jim): main tells a running worker the current Settings level. A change reconciles at
   * once (a drop to shadow removes the claims and re-ingests memory.md; a raise swaps them), and
   * the call resolves only after that, so the next search already sees the new level.
   */
  async setClaimLedger(value: unknown): Promise<{ changed: boolean; removed: number; embedded: number }> {
    const same = this.claimLedger === value;
    this.claimLedger = value;
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

  /** W3-1 (a): remove a wing's indexed sources that are no longer eligible (its markdown, once its
   *  claims are a source), so a claim never lands beside what it replaces. */
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
  syncClaims(a: ClaimsSyncArgs): Promise<{ embedded: number; dropped: number; statusChanges: number }> {
    const prior = this.claimSyncs.get(a.wing) ?? Promise.resolve();
    const run = prior.catch(() => undefined).then(async () => {
      // Indexed only while the agent's claims are a source (reader/writer AND a ledger exists), so a
      // claim never sits in the index beside the markdown it replaces.
      // A sync carries main's CURRENT Settings level: follow it first (W3-1), then check.
      if ('claimLedger' in a && this.claimLedger !== a.claimLedger) await this.setClaimLedger(a.claimLedger);
      const d = this.discover();
      if (!d.eligible.some((e) => e.kind === 'claims' && e.wing === a.wing)) throw new Error(`claims are not indexed for ${a.wing} (level ${d.ledgerLevels[a.wing] ?? 'off'})`);
      // W3-1 (a): the replaced markdown leaves in the same queue step that plans the claims.
      const plan = await this.enqueue(PRIORITY.ingest, async () => { this.dropIneligible(a.wing, this.discover()); return this.d.store.planClaims(a.wing, a.chunks); });
      const vectors: Float32Array[] = [];
      for (let i = 0; i < plan.add.length; i += EMBED_BATCH) {
        const batch = plan.add.slice(i, i + EMBED_BATCH).map((p) => p.content);
        vectors.push(...await this.enqueue(PRIORITY.ingest, () => this.embed(batch)));
      }
      await this.enqueue(PRIORITY.ingest, async () => this.d.store.applyClaims(a.path, plan, vectors, { head: a.head, nowMs: this.now(), manifestVersion: ALLOW_LIST_VERSION }));
      this.d.log?.({ kind: 'claims-indexed', wing: a.wing, embedded: plan.add.length, dropped: plan.drop.length, statusChanges: plan.status.length });
      return { embedded: plan.add.length, dropped: plan.drop.length, statusChanges: plan.status.length };
    });
    this.claimSyncs.set(a.wing, run.catch(() => undefined));
    return run;
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
      const e = this.discover().eligible.find((x) => x.abs === absPath);
      if (e) { void this.ingestEntry(e, PRIORITY.ingest); return; }
      // Not eligible (or gone): if it was indexed, remove it.
      const rel = absPath.slice(this.d.hiveRoot.length + 1).split(/[\\/]/).join('/');
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
    await this.d.embedder.unload();
  }
}

function defaultWatch(dir: string, onChange: (file: string) => void): FSWatcher {
  return fsWatch(dir, { persistent: false }, (_ev, f) => { if (f) onChange(String(f)); });
}

/** Shadow diagnostics and JSON output carry no content: ids, sources, ranks, scores. */
export function redactHit(h: SearchHit): Record<string, unknown> {
  return { chunkId: h.chunkId, wing: h.wing, room: h.room, source: h.source, cosineSim: h.cosineSim, bm25: h.bm25,
    ...(h.claim ? { claimId: h.claim.id, status: h.claim.status } : {}) };
}
