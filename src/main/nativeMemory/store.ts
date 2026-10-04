/**
 * NATIVE-MEMORY sections 2 and 7: the derived index in one SQLite file (better-sqlite3 +
 * FTS5 + sqlite-vec). It is a CACHE of the Markdown sources: disposable, rebuilt by
 * re-embedding them, never imported from Chroma.
 *
 * Only the memory worker (a utility process) ever constructs this. Electron main never opens
 * the database, loads the extension or runs its SQL (spec section 3).
 *
 * Chunk-diff (Jim R7): a changed source keeps the rowid AND embedding of every chunk whose
 * content is unchanged; only new/changed chunks are embedded and inserted, vanished ones are
 * deleted, all in one transaction. Replace-by-source would rewrite every chunk of memory.md on
 * each append - the MINE-REGROWTH pattern - and a vec0 delete is not proven to reuse its slot.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import type BetterSqlite3 from 'better-sqlite3';
import { sha256 } from './sources';
import type { Chunk } from './chunker';
import { EMBED_DIM } from './embedder';
import type { ClaimChunk, SearchMode } from '../../shared/claims';

export const SCHEMA_VERSION = 2;

export type Db = BetterSqlite3.Database;

export interface StoreOpenOptions {
  /** better-sqlite3's constructor (injected: the app's Electron-ABI build). */
  Database: new (file: string, opts?: Record<string, unknown>) => Db;
  /** The sqlite-vec loadable library, and the SHA-256 it must have (verified BEFORE load). */
  vecPath: string;
  vecSha256: string | null;
}

export interface SourceMeta {
  path: string;
  sha256: string;
  kind: string;
  wing: string;
  room: string;
  mtimeMs: number;
  bytes: number;
}

export interface DiffPlan {
  path: string;
  /** Existing chunks that survive, with the ordinal they take in the new text. */
  keep: Array<{ chunkId: number; ordinal: number }>;
  /** New chunk texts to embed and insert. */
  add: Chunk[];
  /** Existing chunk ids to delete. */
  remove: number[];
  /** Every chunk the source had when the plan was made, as "id:contentSha". A rowid alone is
   *  not an identity: SQLite reuses the highest deleted rowids, so after another change the
   *  same ids can name different chunks. */
  expect: string[];
}

export interface SearchOptions {
  query: string;
  queryVec: Float32Array | null;
  wing?: string | null;
  room?: string | null;
  sinceMs?: number | null;
  beforeMs?: number | null;
  k: number;
  /** CLAIM-LEDGER read modes (A5): live (default), history (+ superseded, retracted), all (+ purged). */
  mode?: SearchMode;
  /** Claims only: a kind or a key (markdown chunks have neither). */
  kind?: string | null;
  key?: string | null;
}

export interface SearchHit {
  chunkId: number;
  wing: string;
  room: string;
  source: string;
  content: string;
  cosineSim: number | null;
  bm25: number | null;
  score: number;
  /** A claim chunk's claim (null for markdown chunks). */
  claim?: { id: string; status: string; kind: string; key: string | null; at: string } | null;
}

/**
 * CLAIM-LEDGER: a claim's VISIBILITY, from its ledger status. The default search returns `live`
 * only (no superseded, retracted or purged claim: G3.1), `--history` adds `history`, `--all` adds
 * `gone`. An unknown status is `history` (fail closed for the default view).
 */
export type Vis = 'live' | 'history' | 'gone';
export function visOf(status: string): Vis {
  if (status === 'live' || status === 'superseded?') return 'live';
  if (status === 'purged') return 'gone';
  return 'history';
}
const MODE_VIS: Record<SearchMode, readonly Vis[]> = { live: ['live'], history: ['live', 'history'], all: ['live', 'history', 'gone'] };
/** A SQL list of fixed literals (never user text). */
const visList = (mode: SearchMode): string => MODE_VIS[mode].map((v) => `'${v}'`).join(', ');

/** One claim chunk to index: ClaimChunk plus its part number within the claim. */
export type ClaimPart = ClaimChunk & { part: number };

/**
 * CL-S1 M3: what a claim part EMBEDS. A claim chunk's content is its `kind · key · date` header line
 * (claims/chunks.ts claimHeader) and then its text. The header stays in `content` (FTS, display,
 * contentSha256), but the vector is the text alone: MiniLM mean-pools every token, so the header's
 * tokens pulled a claim's vector away from its own words (bed: andy:157 fell from vector #7 to #23
 * and out of the history top 10). A content with no header line is embedded whole.
 */
export function claimEmbedText(content: string): string {
  const nl = content.indexOf('\n');
  return nl < 0 ? content : content.slice(nl + 1);
}
/** The claim-vector recipe. Bumped from 1 (header + text) to 2 (claimEmbedText): an index whose
 *  wing was embedded under another version re-embeds that wing's claim parts once, at its next sync. */
export const CLAIM_EMBED_VERSION = 2;
export const claimEmbedVersionKey = (wing: string): string => `claim_embed_version:${wing}`;

export interface ClaimPlan {
  wing: string;
  /** Parts to embed and insert. */
  add: ClaimPart[];
  /** Claims whose indexed parts differ from the ledger's (a purge rewrite): all their parts go. */
  drop: string[];
  /** Status changes (no re-embed): claim id -> new status. */
  status: Array<{ claimId: string; status: string; at: string }>;
}

const f32 = (v: Float32Array): Buffer => Buffer.from(v.buffer, v.byteOffset, v.byteLength);

/** A conservative FTS5 query: each word of letters/digits/_ quoted, OR-ed. Nothing of the
 *  user's text reaches FTS5 syntax (no operators, no column filters, no NEAR). */
export function ftsQuery(text: string): string | null {
  const terms = (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((t) => t.length > 1 || /\d/.test(t)).slice(0, 32);
  if (!terms.length) return null;
  return [...new Set(terms)].map((t) => `"${t}"`).join(' OR ');
}

/** Reciprocal-rank fusion over two ranked id lists; ties broken by the vector rank, then id. */
export function rrf(lexical: number[], vector: number[], k0 = 60): Array<{ id: number; score: number }> {
  const score = new Map<number, number>();
  const vrank = new Map<number, number>();
  lexical.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (k0 + i + 1)));
  vector.forEach((id, i) => { score.set(id, (score.get(id) ?? 0) + 1 / (k0 + i + 1)); vrank.set(id, i); });
  return [...score.entries()]
    .map(([id, s]) => ({ id, score: s }))
    .sort((a, b) => b.score - a.score || (vrank.get(a.id) ?? 1e9) - (vrank.get(b.id) ?? 1e9) || a.id - b.id);
}

export class NativeMemoryStore {
  private constructor(readonly db: Db, readonly file: string) {}

  /** Open (creating) the index. Verifies the extension's SHA-256 before loading it. Throws on a
   *  digest mismatch: a changed DLL is never loaded. */
  static open(file: string, o: StoreOpenOptions): NativeMemoryStore {
    if (o.vecSha256) {
      const got = sha256(readFileSync(o.vecPath));
      if (got !== o.vecSha256) throw new Error(`native-memory: vec0 digest mismatch (${got})`);
    }
    const db = new o.Database(file);
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('foreign_keys = ON');
      db.pragma('busy_timeout = 5000');
      db.pragma('synchronous = NORMAL');
      db.pragma(`journal_size_limit = ${8 * 1024 * 1024}`);
      db.loadExtension(o.vecPath);
      const s = new NativeMemoryStore(db, file);
      s.ensureSchema();
      return s;
    } catch (e) {
      // A corrupt file can fail AFTER the handle opened: close it, or the quarantine rename
      // that follows is EBUSY on Windows.
      try { db.close(); } catch { /* already closed */ }
      throw e;
    }
  }

  /** `PRAGMA quick_check`: true when the file is sound. */
  quickCheck(): boolean {
    try {
      const rows = this.db.pragma('quick_check') as Array<Record<string, string>>;
      return rows.length === 1 && Object.values(rows[0])[0] === 'ok';
    } catch {
      return false;
    }
  }

  close(): void {
    try { this.db.pragma('wal_checkpoint(TRUNCATE)'); } catch { /* closing anyway */ }
    this.db.close();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sources(
        source_id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, sha256 TEXT NOT NULL,
        allowed_kind TEXT NOT NULL, wing TEXT NOT NULL, room TEXT NOT NULL,
        mtime_ms INTEGER NOT NULL, bytes INTEGER NOT NULL, indexed_at INTEGER NOT NULL,
        manifest_version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks(
        chunk_id INTEGER PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(source_id),
        ordinal INTEGER NOT NULL, wing TEXT NOT NULL, room TEXT NOT NULL, content TEXT NOT NULL,
        content_sha256 TEXT NOT NULL, filed_at INTEGER NOT NULL, claim_id TEXT, claim_part INTEGER,
        UNIQUE(source_id, ordinal));
      CREATE INDEX IF NOT EXISTS chunks_claim ON chunks(claim_id);
      CREATE INDEX IF NOT EXISTS chunks_wing_room ON chunks(wing, room);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(content, content='chunks', content_rowid='chunk_id');
      CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
        INSERT INTO chunks_fts(rowid, content) VALUES (new.chunk_id, new.content); END;
      CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES ('delete', old.chunk_id, old.content); END;
      CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE OF content ON chunks BEGIN
        INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES ('delete', old.chunk_id, old.content);
        INSERT INTO chunks_fts(rowid, content) VALUES (new.chunk_id, new.content); END;
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(embedding float[${EMBED_DIM}] distance_metric=cosine, vis text);
      CREATE TABLE IF NOT EXISTS index_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS claims(
        claim_id TEXT NOT NULL, part INTEGER NOT NULL, wing TEXT NOT NULL, kind TEXT NOT NULL, ckey TEXT,
        at TEXT NOT NULL, content TEXT NOT NULL, content_sha256 TEXT NOT NULL, PRIMARY KEY(claim_id, part));
      CREATE TRIGGER IF NOT EXISTS claims_no_update BEFORE UPDATE ON claims BEGIN
        SELECT RAISE(ABORT, 'claims is append-only'); END;
      CREATE TRIGGER IF NOT EXISTS claims_no_delete BEFORE DELETE ON claims
        WHEN (SELECT value FROM index_meta WHERE key = 'claims_delete_ok') IS NOT '1' BEGIN
        SELECT RAISE(ABORT, 'claims is append-only'); END;
      CREATE TABLE IF NOT EXISTS claim_status(claim_id TEXT PRIMARY KEY, status TEXT NOT NULL, vis TEXT NOT NULL, at TEXT NOT NULL);`);
    this.setMetaIfAbsent('schema_version', String(SCHEMA_VERSION));
    this.setMetaIfAbsent('generation', '0');
  }

  meta(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM index_meta WHERE key = ?').get(key) as { value: string } | undefined;
    return r ? r.value : null;
  }
  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO index_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
  private setMetaIfAbsent(key: string, value: string): void {
    this.db.prepare('INSERT OR IGNORE INTO index_meta(key, value) VALUES (?, ?)').run(key, value);
  }

  /** The indexed sources: path -> sha256 (the reconcile's view). */
  sourceShas(): Map<string, string> {
    const rows = this.db.prepare('SELECT path, sha256 FROM sources').all() as Array<{ path: string; sha256: string }>;
    return new Map(rows.map((r) => [r.path, r.sha256]));
  }

  /** Plan a chunk-diff of `path` to `chunks`: match existing chunks by content SHA (as a
   *  multiset, in order), keep them, add the rest, remove what is left over. */
  planDiff(path: string, chunks: Chunk[]): DiffPlan {
    const existing = this.db.prepare('SELECT chunk_id, content_sha256 FROM chunks WHERE source_id = ? ORDER BY ordinal').all(path) as Array<{ chunk_id: number; content_sha256: string }>;
    const pool = new Map<string, number[]>();
    for (const e of existing) { const l = pool.get(e.content_sha256) ?? []; l.push(e.chunk_id); pool.set(e.content_sha256, l); }
    const keep: DiffPlan['keep'] = [];
    const add: Chunk[] = [];
    for (const c of chunks) {
      const l = pool.get(c.contentSha);
      if (l && l.length) keep.push({ chunkId: l.shift()!, ordinal: c.ordinal });
      else add.push(c);
    }
    const remove = [...pool.values()].flat();
    const expect = existing.map((e) => `${e.chunk_id}:${e.content_sha256}`).sort();
    return { path, keep, add, remove, expect };
  }

  /** Apply a plan with the embeddings of `plan.add` (same order), atomically. Returns false
   *  (and changes nothing) when the source's chunks moved since the plan was made. */
  applyDiff(meta: SourceMeta, plan: DiffPlan, embeddings: Float32Array[], nowMs: number, manifestVersion: number): boolean {
    if (embeddings.length !== plan.add.length) throw new Error('applyDiff: embeddings/add length mismatch');
    const tx = this.db.transaction((): boolean => {
      const cur = (this.db.prepare('SELECT chunk_id, content_sha256 FROM chunks WHERE source_id = ?').all(plan.path) as Array<{ chunk_id: number; content_sha256: string }>)
        .map((r) => `${r.chunk_id}:${r.content_sha256}`).sort();
      if (cur.length !== plan.expect.length || cur.some((x, i) => x !== plan.expect[i])) return false;
      this.db.prepare(`INSERT INTO sources(source_id, path, sha256, allowed_kind, wing, room, mtime_ms, bytes, indexed_at, manifest_version)
        VALUES (@p, @p, @sha, @kind, @wing, @room, @mtime, @bytes, @now, @mv)
        ON CONFLICT(source_id) DO UPDATE SET sha256 = excluded.sha256, allowed_kind = excluded.allowed_kind, wing = excluded.wing,
          room = excluded.room, mtime_ms = excluded.mtime_ms, bytes = excluded.bytes, indexed_at = excluded.indexed_at,
          manifest_version = excluded.manifest_version`)
        .run({ p: meta.path, sha: meta.sha256, kind: meta.kind, wing: meta.wing, room: meta.room, mtime: Math.round(meta.mtimeMs), bytes: meta.bytes, now: nowMs, mv: manifestVersion });
      const delChunk = this.db.prepare('DELETE FROM chunks WHERE chunk_id = ?');
      const delVec = this.db.prepare('DELETE FROM chunks_vec WHERE rowid = ?');
      for (const id of plan.remove) { delVec.run(BigInt(id)); delChunk.run(id); }
      // Two-phase renumber: park every kept chunk on a negative ordinal first, so moving one
      // onto an ordinal another still holds never trips UNIQUE(source_id, ordinal).
      const setOrd = this.db.prepare('UPDATE chunks SET ordinal = ?, wing = ?, room = ? WHERE chunk_id = ?');
      for (const k of plan.keep) setOrd.run(-1 - k.ordinal, meta.wing, meta.room, k.chunkId);
      for (const k of plan.keep) setOrd.run(k.ordinal, meta.wing, meta.room, k.chunkId);
      const ins = this.db.prepare('INSERT INTO chunks(source_id, ordinal, wing, room, content, content_sha256, filed_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
      const insVec = this.db.prepare("INSERT INTO chunks_vec(rowid, embedding, vis) VALUES (?, ?, 'live')");
      plan.add.forEach((c, i) => {
        const info = ins.run(meta.path, c.ordinal, meta.wing, meta.room, c.content, c.contentSha, Math.round(meta.mtimeMs));
        // BigInt rowid: the sqlite-vec + ONNX co-load regression (spec section 3, issue #270).
        insVec.run(BigInt(info.lastInsertRowid), f32(embeddings[i]));
      });
      this.bumpGeneration();
      return true;
    });
    return tx.immediate();
  }

  /** Remove a source and all its chunks from both indexes, atomically. */
  removeSource(path: string): void {
    this.db.transaction(() => {
      // CLAIM-LEDGER: a claims source takes its claims and statuses with it (the flip back, G3.4).
      const claimIds = (this.db.prepare('SELECT DISTINCT claim_id FROM chunks WHERE source_id = ? AND claim_id IS NOT NULL').all(path) as Array<{ claim_id: string }>).map((r) => r.claim_id);
      for (const id of claimIds) this.dropClaim(id);
      const ids = (this.db.prepare('SELECT chunk_id FROM chunks WHERE source_id = ?').all(path) as Array<{ chunk_id: number }>).map((r) => r.chunk_id);
      const delVec = this.db.prepare('DELETE FROM chunks_vec WHERE rowid = ?');
      for (const id of ids) delVec.run(BigInt(id));
      this.db.prepare('DELETE FROM chunks WHERE source_id = ?').run(path);
      this.db.prepare('DELETE FROM sources WHERE source_id = ?').run(path);
      this.bumpGeneration();
    }).immediate();
  }

  private bumpGeneration(): void {
    this.setMeta('generation', String(Number(this.meta('generation') ?? '0') + 1));
  }

  /** Hybrid search: FTS5 BM25 and cosine KNN, each over max(4k, 40) candidates, filtered by
   *  wing/room/date BEFORE fusion, fused by RRF. One read snapshot for the whole query. */
  search(o: SearchOptions): SearchHit[] {
    const k = Math.max(1, Math.min(100, Math.floor(o.k)));
    const cand = Math.max(4 * k, 40);
    const mode: SearchMode = o.mode === 'history' || o.mode === 'all' ? o.mode : 'live';
    // CLAIM-LEDGER: a claim chunk is returned only when its claim's visibility is in the mode
    // (a claim chunk without a status row is never returned: fail closed). Markdown chunks
    // (claim_id NULL) are unaffected. The same filter is in BOTH branches (G3.1).
    const visFilter = mode === 'all' ? '1' : `(c.claim_id IS NULL OR cs.vis IN (${visList(mode)}))`;
    const filt = ['(@wing IS NULL OR c.wing = @wing)', '(@room IS NULL OR c.room = @room)', '(@since IS NULL OR c.filed_at >= @since)', '(@before IS NULL OR c.filed_at < @before)',
      '(@kind IS NULL OR cl.kind = @kind)', '(@key IS NULL OR cl.ckey = @key)', visFilter].join(' AND ');
    const joins = 'LEFT JOIN claim_status cs ON cs.claim_id = c.claim_id LEFT JOIN claims cl ON cl.claim_id = c.claim_id AND cl.part = c.claim_part';
    const params = { wing: o.wing ?? null, room: o.room ?? null, since: o.sinceMs ?? null, before: o.beforeMs ?? null, kind: o.kind ?? null, key: o.key ?? null };
    const filtered = params.wing !== null || params.room !== null || params.since !== null || params.before !== null || params.kind !== null || params.key !== null;
    const read = this.db.transaction(() => {
      const fq = ftsQuery(o.query);
      const lex = fq
        ? (this.db.prepare(`SELECT c.chunk_id AS id, bm25(chunks_fts) AS s FROM chunks_fts JOIN chunks c ON c.chunk_id = chunks_fts.rowid ${joins}
            WHERE chunks_fts MATCH @q AND ${filt} ORDER BY s LIMIT @n`).all({ ...params, q: fq, n: cand }) as Array<{ id: number; s: number }>)
        : [];
      let vec: Array<{ id: number; d: number }> = [];
      if (o.queryVec) {
        const qv = f32(o.queryVec);
        vec = filtered
          // Filtered: an exact scan of the filtered rows (vec0 KNN cannot pre-filter by a joined column).
          ? this.db.prepare(`SELECT c.chunk_id AS id, vec_distance_cosine(v.embedding, @qv) AS d FROM chunks c JOIN chunks_vec v ON v.rowid = c.chunk_id ${joins}
              WHERE ${filt} ORDER BY d LIMIT @n`).all({ ...params, qv, n: cand }) as Array<{ id: number; d: number }>
          // Unfiltered: the KNN fast path; the vec0 metadata column filters INSIDE the KNN (W3 spike:
          // k results even when every nearer row is hidden), so no over-fetch is needed (G3.1c).
          : this.db.prepare(`SELECT rowid AS id, distance AS d FROM chunks_vec WHERE embedding MATCH @qv AND k = @n${mode === 'all' ? '' : ` AND vis IN (${visList(mode)})`} ORDER BY distance`)
            .all({ qv, n: cand }) as Array<{ id: number; d: number }>;
      }
      const fusedAll = rrf(lex.map((r) => r.id), vec.map((r) => r.id));
      const bm = new Map(lex.map((r) => [r.id, r.s]));
      const dist = new Map(vec.map((r) => [r.id, r.d]));
      const row = this.db.prepare(`SELECT c.chunk_id, c.wing, c.room, c.source_id, c.content, c.claim_id, cs.status, cl.kind, cl.ckey, cl.at
        FROM chunks c ${joins} WHERE c.chunk_id = ?`);
      type Row = { chunk_id: number; wing: string; room: string; source_id: string; content: string; claim_id: string | null; status: string | null; kind: string | null; ckey: string | null; at: string | null };
      const allowed = new Set<string>(MODE_VIS[mode]);
      // Fail closed in BOTH branches (Jim W3-2): a claim chunk is returned only when its status row
      // exists and its visibility is in the mode (the KNN fast path filters on the vec0 column, so
      // this is the check that a missing or stale status row cannot slip past).
      const rows: Array<{ f: { id: number; score: number }; r: Row }> = [];
      for (const f of fusedAll) {
        if (rows.length >= k) break;
        const r = row.get(f.id) as Row | undefined;
        if (!r) continue;
        if (r.claim_id && mode !== 'all' && (r.status === null || !allowed.has(visOf(r.status)))) continue;
        rows.push({ f, r });
      }
      return rows.map(({ f, r }) => {
        const d = dist.get(f.id);
        const b = bm.get(f.id);
        return {
          chunkId: r.chunk_id, wing: r.wing, room: r.room, source: r.source_id, content: r.content,
          cosineSim: d === undefined ? null : 1 - d,
          bm25: b === undefined ? null : -b,
          score: f.score,
          claim: r.claim_id ? { id: r.claim_id, status: r.status ?? 'unknown', kind: r.kind ?? '', key: r.ckey, at: r.at ?? '' } : null
        };
      });
    });
    return read.deferred();
  }

  // — CLAIM-LEDGER (W3) —

  /** Plan the sync of one agent's claim chunks (as main sent them, verified and derived): which
   *  parts are new (to embed), which claims' text changed (a purge rewrite: drop and re-add), and
   *  which statuses changed (rows only, never a re-embed: A4). `reembed`: the wing's vectors were made
   *  under another CLAIM_EMBED_VERSION, so every claim it keeps is dropped and re-added (one pass). */
  planClaims(wing: string, parts: ClaimPart[], opts: { reembed?: boolean } = {}): ClaimPlan {
    const have = new Map<string, Map<number, string>>();
    for (const r of this.db.prepare('SELECT claim_id, part, content_sha256 FROM claims WHERE wing = ?').all(wing) as Array<{ claim_id: string; part: number; content_sha256: string }>) {
      const m = have.get(r.claim_id) ?? new Map<number, string>();
      m.set(r.part, r.content_sha256);
      have.set(r.claim_id, m);
    }
    const status = new Map((this.db.prepare(`SELECT s.claim_id, s.status FROM claim_status s JOIN claims c ON c.claim_id = s.claim_id AND c.part = 0 WHERE c.wing = ?`).all(wing) as Array<{ claim_id: string; status: string }>)
      .map((r) => [r.claim_id, r.status]));
    const incoming = new Map<string, ClaimPart[]>();
    for (const p of parts) { const l = incoming.get(p.claimId) ?? []; l.push(p); incoming.set(p.claimId, l); }
    const drop = new Set<string>();
    const add: ClaimPart[] = [];
    // A claim present in the index but not sent (purged, or past a chain break) goes.
    for (const id of have.keys()) if (!incoming.has(id)) drop.add(id);
    for (const [id, ps] of incoming) {
      const h = have.get(id);
      if (!opts.reembed && h && h.size === ps.length && ps.every((p) => h.get(p.part) === p.contentSha256)) continue;
      if (h) drop.add(id);
      add.push(...ps);
    }
    const st: ClaimPlan['status'] = [];
    for (const [id, ps] of incoming) {
      if (!add.some((p) => p.claimId === id) && status.get(id) !== ps[0].status) st.push({ claimId: id, status: ps[0].status, at: ps[0].at });
    }
    return { wing, add, drop: [...drop], status: st };
  }

  /** Apply a claim plan with the embeddings of `plan.add` (same order), atomically. */
  applyClaims(sourcePath: string, plan: ClaimPlan, embeddings: Float32Array[], meta: { head: string; nowMs: number; manifestVersion: number; embedVersion?: number }): void {
    if (embeddings.length !== plan.add.length) throw new Error('applyClaims: embeddings/add length mismatch');
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO sources(source_id, path, sha256, allowed_kind, wing, room, mtime_ms, bytes, indexed_at, manifest_version)
        VALUES (@p, @p, @sha, 'claims', @wing, 'claims', @now, 0, @now, @mv)
        ON CONFLICT(source_id) DO UPDATE SET sha256 = excluded.sha256, indexed_at = excluded.indexed_at, manifest_version = excluded.manifest_version`)
        .run({ p: sourcePath, sha: meta.head, wing: plan.wing, now: meta.nowMs, mv: meta.manifestVersion });
      for (const id of plan.drop) this.dropClaim(id);
      let ord = ((this.db.prepare('SELECT max(ordinal) AS m FROM chunks WHERE source_id = ?').get(sourcePath) as { m: number | null }).m ?? -1) + 1;
      const insClaim = this.db.prepare('INSERT INTO claims(claim_id, part, wing, kind, ckey, at, content, content_sha256) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      const insChunk = this.db.prepare('INSERT INTO chunks(source_id, ordinal, wing, room, content, content_sha256, filed_at, claim_id, claim_part) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
      const insVec = this.db.prepare('INSERT INTO chunks_vec(rowid, embedding, vis) VALUES (?, ?, ?)');
      const setStatus = this.db.prepare('INSERT INTO claim_status(claim_id, status, vis, at) VALUES (?, ?, ?, ?) ON CONFLICT(claim_id) DO UPDATE SET status = excluded.status, vis = excluded.vis, at = excluded.at');
      plan.add.forEach((p, i) => {
        insClaim.run(p.claimId, p.part, plan.wing, p.kind, p.ckey, p.at, p.content, p.contentSha256);
        const info = insChunk.run(sourcePath, ord++, plan.wing, 'claims', p.content, p.contentSha256, Date.parse(p.at) || meta.nowMs, p.claimId, p.part);
        insVec.run(BigInt(info.lastInsertRowid), f32(embeddings[i]), visOf(p.status));
        if (p.part === 0) setStatus.run(p.claimId, p.status, visOf(p.status), p.at);
      });
      // A status change updates the status row AND the vec0 metadata of every chunk of the claim
      // (a multi-part claim hides all its parts: god's (b)). Never a re-embed.
      const chunksOf = this.db.prepare('SELECT chunk_id FROM chunks WHERE claim_id = ?');
      const setVis = this.db.prepare('UPDATE chunks_vec SET vis = ? WHERE rowid = ?');
      for (const s of plan.status) {
        setStatus.run(s.claimId, s.status, visOf(s.status), s.at);
        for (const r of chunksOf.all(s.claimId) as Array<{ chunk_id: number }>) setVis.run(visOf(s.status), BigInt(r.chunk_id));
      }
      // The wing's vectors are now all of this recipe (in the same transaction as the re-embed).
      if (meta.embedVersion !== undefined) this.setMeta(claimEmbedVersionKey(plan.wing), String(meta.embedVersion));
      if (plan.add.length || plan.drop.length || plan.status.length) this.bumpGeneration();
    }).immediate();
  }

  /** Remove one claim from every table (the append-only trigger is opened for this delete only). */
  private dropClaim(claimId: string): void {
    const ids = (this.db.prepare('SELECT chunk_id FROM chunks WHERE claim_id = ?').all(claimId) as Array<{ chunk_id: number }>).map((r) => r.chunk_id);
    const delVec = this.db.prepare('DELETE FROM chunks_vec WHERE rowid = ?');
    for (const id of ids) delVec.run(BigInt(id));
    this.db.prepare('DELETE FROM chunks WHERE claim_id = ?').run(claimId);
    this.setMeta('claims_delete_ok', '1');
    try { this.db.prepare('DELETE FROM claims WHERE claim_id = ?').run(claimId); } finally { this.setMeta('claims_delete_ok', '0'); }
    this.db.prepare('DELETE FROM claim_status WHERE claim_id = ?').run(claimId);
  }

  /**
   * R5 candidates (god 1f7b07, freeze a881388e): same-agent LIVE claims whose cosine to the given
   * claim is >= tau2, excluding the claim itself and any claim on the same key (a typed-slot match
   * is R2's). One pair per other claim, at its best part. Never for an unindexed claim.
   */
  claimNeighbours(wing: string, claimId: string, tau2: number, k = 10): Array<{ b: string; cosine: number }> {
    const me = this.db.prepare('SELECT c.chunk_id, cl.ckey FROM chunks c JOIN claims cl ON cl.claim_id = c.claim_id AND cl.part = c.claim_part WHERE c.claim_id = ? ORDER BY c.claim_part').all(claimId) as Array<{ chunk_id: number; ckey: string | null }>;
    if (!me.length) return [];
    const best = new Map<string, number>();
    for (const m of me) {
      const v = this.db.prepare('SELECT embedding FROM chunks_vec WHERE rowid = ?').get(BigInt(m.chunk_id)) as { embedding: Buffer } | undefined;
      if (!v) continue;
      const rows = this.db.prepare(`SELECT c.claim_id AS id, cl.ckey AS ckey, vec_distance_cosine(vv.embedding, @qv) AS d
        FROM chunks c JOIN chunks_vec vv ON vv.rowid = c.chunk_id JOIN claims cl ON cl.claim_id = c.claim_id AND cl.part = c.claim_part
        JOIN claim_status cs ON cs.claim_id = c.claim_id
        WHERE c.wing = @wing AND c.claim_id IS NOT NULL AND c.claim_id <> @id AND cs.vis = 'live' ORDER BY d LIMIT @n`)
        .all({ qv: v.embedding, wing, id: claimId, n: Math.max(4 * k, 40) }) as Array<{ id: string; ckey: string | null; d: number }>;
      for (const r of rows) {
        const cos = 1 - r.d;
        if (cos < tau2 || (me[0].ckey !== null && r.ckey === me[0].ckey)) continue;
        if (!best.has(r.id) || (best.get(r.id) as number) < cos) best.set(r.id, cos);
      }
    }
    return [...best.entries()].map(([b, cosine]) => ({ b, cosine })).sort((x, y) => y.cosine - x.cosine || (x.b < y.b ? -1 : 1)).slice(0, k);
  }

  /** Wake-up content (spec section 4 contract, NOT legacy overlap): for the wing, the newest
   *  entries of its memory.md, then its most recently filed other chunks, within `maxChars`. */
  wakeUp(wing: string | null, maxChars = 3200): Array<{ wing: string; room: string; source: string; content: string }> {
    const out: Array<{ wing: string; room: string; source: string; content: string }> = [];
    let used = 0;
    const take = (rows: Array<{ wing: string; room: string; source_id: string; content: string }>): void => {
      for (const r of rows) {
        const cost = r.content.length + 64;
        if (used + cost > maxChars) continue;
        out.push({ wing: r.wing, room: r.room, source: r.source_id, content: r.content });
        used += cost;
      }
    };
    const w = wing ?? null;
    // Newest memory.md entries first (the tail of the file is the newest).
    take(this.db.prepare(`SELECT wing, room, source_id, content FROM chunks WHERE room = 'memory' AND claim_id IS NULL AND (@w IS NULL OR wing = @w)
      ORDER BY filed_at DESC, ordinal DESC LIMIT 12`).all({ w }) as Array<{ wing: string; room: string; source_id: string; content: string }>);
    // Then the most recently filed deliverable chunks.
    take(this.db.prepare(`SELECT wing, room, source_id, content FROM chunks WHERE room <> 'memory' AND claim_id IS NULL AND (@w IS NULL OR wing = @w)
      ORDER BY filed_at DESC, ordinal ASC LIMIT 12`).all({ w }) as Array<{ wing: string; room: string; source_id: string; content: string }>);
    return out;
  }

  counts(): { sources: number; chunks: number; vectors: number; generation: number } {
    const one = (sql: string): number => (this.db.prepare(sql).get() as { n: number }).n;
    return {
      sources: one('SELECT count(*) AS n FROM sources'),
      chunks: one('SELECT count(*) AS n FROM chunks'),
      vectors: one('SELECT count(*) AS n FROM chunks_vec'),
      generation: Number(this.meta('generation') ?? '0')
    };
  }

  /** Bytes the live content needs (pages in use), for the compaction policy. */
  liveEstimateBytes(): number {
    const page = Number(this.db.pragma('page_size', { simple: true }));
    const pages = Number(this.db.pragma('page_count', { simple: true }));
    const free = Number(this.db.pragma('freelist_count', { simple: true }));
    return (pages - free) * page;
  }

  fileBytes(): number {
    let n = 0;
    for (const f of [this.file, `${this.file}-wal`]) { try { n += statSync(f).size; } catch { /* absent */ } }
    return n;
  }

  freelistRatio(): number {
    const pages = Number(this.db.pragma('page_count', { simple: true }));
    const free = Number(this.db.pragma('freelist_count', { simple: true }));
    return pages ? free / pages : 0;
  }

  /** Idle maintenance step 1: checkpoint the WAL back to zero. */
  checkpoint(): void {
    this.db.pragma('wal_checkpoint(TRUNCATE)');
  }

  /** Idle maintenance step 2: `VACUUM INTO` a same-volume staging file and verify it. The swap
   *  is the worker's (it must drain readers and reopen). Returns the verified staging path. */
  vacuumInto(staging: string, o: StoreOpenOptions): { ok: boolean; why?: string } {
    if (existsSync(staging)) return { ok: false, why: 'staging exists' };
    const before = this.counts();
    this.db.prepare('VACUUM INTO ?').run(staging);
    const copy = NativeMemoryStore.open(staging, o);
    try {
      if (!copy.quickCheck()) return { ok: false, why: 'integrity' };
      const integrity = copy.db.pragma('integrity_check') as Array<Record<string, string>>;
      if (!(integrity.length === 1 && Object.values(integrity[0])[0] === 'ok')) return { ok: false, why: 'integrity' };
      const after = copy.counts();
      if (after.sources !== before.sources || after.chunks !== before.chunks || after.vectors !== before.vectors || after.generation !== before.generation) {
        return { ok: false, why: 'counts' };
      }
      return { ok: true };
    } finally {
      copy.db.close();
    }
  }
}

/** Section 7 (Jim R8): compact when the file is >= 2x the live estimate AND >= 16 MiB, or the
 *  freelist is >= 25%. Past 8x the live estimate it is a health event and the next idle
 *  maintenance is forced. */
export function compactionDecision(fileBytes: number, liveBytes: number, freelistRatio: number): 'none' | 'compact' | 'force' {
  const live = Math.max(1, liveBytes);
  if (fileBytes >= 8 * live && fileBytes >= 16 * 1024 * 1024) return 'force';
  if ((fileBytes >= 2 * live && fileBytes >= 16 * 1024 * 1024) || freelistRatio >= 0.25) return 'compact';
  return 'none';
}
