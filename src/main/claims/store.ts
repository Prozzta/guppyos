/**
 * CLAIM-LEDGER W1: the ledger store and write path (plan §3 W1; frozen types in shared/claims.ts).
 *
 * LAYOUT. One stream of records per agent, in monthly segments:
 *   agents/<id>/memory/claims/<YYYY-MM>.jsonl   (the month of the record's write time, UTC)
 *   agents/<id>/memory/claims.torn.jsonl        (quarantined torn tails)
 *   agents/<id>/memory/usage.jsonl              (the `used` verb; not chained)
 *   backups/claims/<id>/<YYYY-MM-DD>/           (a daily copy of the segments)
 * Closed months are never written again: an append goes to the month of its write time.
 *
 * ONE LINE = canonical JSON of one record + '\n', written with ONE write() of the complete line,
 * then fsync, then the ack (G1.1). Appends are serialised per agent in main (G1.2).
 *
 * THE CHAIN (F3, F13). `prev` = sha256 of the previous line (without its '\n'), across segments; ''
 * for an agent's first record. `mac` = HMAC-SHA256(key, prev + canonical(record without mac)) with
 * the key only main holds (keyProvider.ts). On read every prev and mac is checked. A break (a bad
 * prev, a bad mac, an unparseable line) makes THAT agent's ledger read-only, raises one
 * `claims-chain-broken` alert, and nothing is repaired: the Human decides.
 *
 * A TORN TAIL (bytes after the last '\n' of the newest segment) is the only thing repaired: it was
 * never acked (the ack follows the fsync of a complete line), so it is moved to claims.torn.jsonl
 * and cut from the segment, and a `claims-torn` row is logged. The reader never throws.
 *
 * A LOST KEY (C2). A missing key or a failed decrypt while any segment exists under ANY agent makes
 * every ledger read-only with ONE `claims-key-missing` alert; a key is created only when no segment
 * exists anywhere (first use). Recovery is `rekey()`, an explicit Human action: a new key, then per
 * agent a `rekey` event chained over the last record. The Human thereby ACCEPTS the records up to
 * targets[0] on the sha256 prev chain alone (their MACs cannot be checked any more); from the last
 * rekey on, every record verifies with the new key. An agent whose prev chain is itself broken, or
 * whose break is a MAC failure under a key that loads (a forgery, G1.8), is never rekeyed.
 *
 * WRITE-TIME RULES (plan W1):
 *   - `at` is clamped: at = min(claimed ?? wt, wt) (F2);
 *   - supersedes / retracts must name existing claims of this agent (B4; the ledger is append-only
 *     and names only existing ids, so no cycle can form);
 *   - THE INJECTION RULE: a `mail:` claim never supersedes, retracts or pins a non-mail claim; on a
 *     `single` key it is accepted as a claim and W2 records the R2-mail conflict (F2);
 *   - keys go through the registry (registry.ts);
 *   - secrets are redacted (redact.ts, B10);
 *   - text limits and sources by origin (claims.ts AppendOrigin): external origins refuse `source`
 *     and `legacy` and anything over 400 characters; only 'w6-internal' may reach 4000.
 */
import { randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { basename, join } from 'node:path';
import {
  CLAIM_KINDS, CLAIM_TEXT_MAX, CLAIM_TEXT_MAX_LEGACY, CLAIMS_ALERT_CHAIN_BROKEN, CLAIMS_ALERT_KEY_MISSING,
  EVENT_KINDS, LEDGER_RECORD_VERSION,
  type AppendOrigin, type AppendResult, type ChainBreak, type ClaimKind, type ClaimRec, type ClaimSource,
  type EventRec, type LedgerRec, type MacKeyProvider, type ReadResult, type RecordDraft, type Ref, type TornInfo,
  type UsageRec,
} from '../../shared/claims';
import { canonicalJson, keyIdOf, recordMac, sha256Hex } from './canonical';
import type { LedgerKeyRecord } from './keyProvider';
import { redactSecrets } from './redact';
import { normalizeTtl } from './ttl';
import { checkKey, loadRegistry, saveRegistry } from './registry';

/** The file operations an append uses; injectable so tests can spy on the order and simulate a crash. */
export interface LedgerIo {
  openSync(path: string, flags: string): number;
  writeSync(fd: number, buf: Uint8Array): number;
  fsyncSync(fd: number): void;
  closeSync(fd: number): void;
}

export interface ClaimStoreDeps {
  hiveRoot: string;
  keys: MacKeyProvider;
  /** Which key id this hive's ledgers are written under, kept by main in user-data (god 7dda19). */
  keyRecord: LedgerKeyRecord;
  now?: () => Date;
  /** A log.jsonl row. */
  log?: (row: Record<string, unknown>) => void;
  /** An alert for god and the Human (claims-chain-broken, claims-key-missing). */
  alert?: (row: Record<string, unknown>) => void;
  io?: LedgerIo;
  /** Record ids; tests may make them deterministic. */
  newId?: (t: 'claim' | 'event') => string;
  /** How long an idle append handle stays open (default FD_IDLE_MS). */
  fdIdleMs?: number;
}

const SEGMENT_RE = /^(\d{4})-(\d{2})\.jsonl$/;
const AGENT_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const ID_RE = /^[ce]-[0-9a-f]{12,32}$/;
const MAIL_SOURCE_RE = /^mail:[A-Za-z0-9._:-]{1,120}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const REF_TYPES = new Set<Ref['type']>(['file', 'commit', 'task', 'msg', 'url']);
const LIST_MAX = 20;
const FD_IDLE_MS = 30_000;
const REF_VALUE_MAX = 500;

const CLAIM_DRAFT_FIELDS = new Set(['t', 'kind', 'text', 'key', 'refs', 'ttl', 'pin', 'supersedes', 'retracts', 'at', 'source', 'legacy']);
const EVENT_DRAFT_FIELDS = new Set(['t', 'ev', 'targets', 'answer']);
const DRAFT_EVENTS = new Set(['accept', 'dismiss', 'reconcile-answer', 'revert', 'pin', 'unpin']);
const ANSWERS = new Set(['keep-both', 'supersedes', 'retract']);

/** What the store remembers about one record (for the write-time rules). */
interface Known { t: 'claim' | 'event'; source?: ClaimSource; kind?: ClaimKind }

interface AgentState {
  /** sha256 of the last line, '' when empty. */
  head: string;
  lastId: string | null;
  known: Map<string, Known>;
  /** The newest segment's file and its size after our last write (a change means someone else wrote). */
  tailFile: string | null;
  tailSize: number;
  segments: number;
  readOnly: ChainBreak | null;
}

export type ParsedLine = { offset: number; bytes: number; line: string; rec: LedgerRec | null };

export function monthOf(iso: string): string {
  return iso.slice(0, 7);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function charLen(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

export class ClaimStore {
  private readonly fs: LedgerIo;
  private readonly now: () => Date;
  private readonly state = new Map<string, AgentState>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly alerted = new Set<string>();
  private keyMissing = false;
  /** One open append handle per agent, on its newest segment: a close per append costs ~7 ms on
   *  Windows (an antivirus scan). Closed on a failure, a new month, a restore, close(), and after
   *  FD_IDLE_MS without an append (so an idle handle never pins an agent's folder). */
  private readonly fds = new Map<string, { file: string; fd: number; idle: ReturnType<typeof setTimeout> | null }>();
  /** The key once loaded (a decrypt per append would be a DPAPI call per append). */
  private key: Uint8Array | null = null;

  constructor(private readonly d: ClaimStoreDeps) {
    this.fs = d.io ?? nodeFs;
    this.now = d.now ?? (() => new Date());
  }

  // ---------------------------------------------------------------- paths

  agentDir(agentId: string): string { return join(this.d.hiveRoot, 'agents', agentId); }
  claimsDir(agentId: string): string { return join(this.agentDir(agentId), 'memory', 'claims'); }
  tornFile(agentId: string): string { return join(this.agentDir(agentId), 'memory', 'claims.torn.jsonl'); }
  usageFile(agentId: string): string { return join(this.agentDir(agentId), 'memory', 'usage.jsonl'); }
  backupDir(agentId: string, day: string): string { return join(this.d.hiveRoot, 'backups', 'claims', agentId, day); }

  /** The agent's segment files, oldest first. */
  segments(agentId: string): string[] {
    const dir = this.claimsDir(agentId);
    let names: string[] = [];
    try { names = nodeFs.readdirSync(dir).filter((n) => SEGMENT_RE.test(n)).sort(); } catch { names = []; }
    return names.map((n) => join(dir, n));
  }

  /** Does any agent have a claims segment? (C2: "first use" means none anywhere.) */
  anySegmentAnywhere(): boolean {
    let agents: string[] = [];
    try { agents = nodeFs.readdirSync(join(this.d.hiveRoot, 'agents')); } catch { return false; }
    return agents.some((a) => AGENT_RE.test(a) && this.segments(a).length > 0);
  }

  private log(row: Record<string, unknown>): void {
    try { this.d.log?.(row); } catch { /* best effort */ }
  }

  private alertOnce(dedup: string, row: Record<string, unknown>): void {
    if (this.alerted.has(dedup)) return;
    this.alerted.add(dedup);
    this.log(row);
    try { this.d.alert?.(row); } catch { /* best effort */ }
  }

  // ---------------------------------------------------------------- read

  /**
   * Read and verify an agent's ledger (plan API readLedger). Repairs a torn tail of the newest
   * segment, never drops an acked record, never throws. `chain` is 'ok' or the first break; any
   * break makes the agent read-only.
   */
  readLedger(agentId: string): ReadResult {
    try {
      return this.readInner(agentId);
    } catch (e) {
      const chain: ChainBreak = { brokenAt: 'read', reason: 'parse' };
      this.log({ kind: 'claims-read-failed', agentId, error: String(e).slice(0, 200) });
      return { records: [], torn: null, chain };
    }
  }

  private readInner(agentId: string): ReadResult {
    if (!AGENT_RE.test(agentId)) return { records: [], torn: null, chain: { brokenAt: 'agent', reason: 'parse' } };
    const files = this.segments(agentId);
    let torn: TornInfo | null = null;
    const lines: Array<ParsedLine & { file: string }> = [];
    let structural: ChainBreak | null = null;
    files.forEach((file, i) => {
      let buf = nodeFs.readFileSync(file);
      const last = i === files.length - 1;
      const end = buf.lastIndexOf(0x0a) + 1;
      if (end < buf.length) {
        if (last) {
          torn = this.quarantine(agentId, file, buf, end);
          buf = buf.subarray(0, end);
        } else if (!structural) {
          structural = { brokenAt: `${file}@${end}`, reason: 'parse' };
        }
      }
      let off = 0;
      while (off < buf.length) {
        const nl = buf.indexOf(0x0a, off);
        const stop = nl < 0 ? buf.length : nl;
        const line = buf.subarray(off, stop).toString('utf8');
        let rec: LedgerRec | null = null;
        try {
          const v = JSON.parse(line) as unknown;
          if (isObj(v) && typeof v.id === 'string' && (v.t === 'claim' || v.t === 'event')) rec = v as unknown as LedgerRec;
        } catch { rec = null; }
        lines.push({ file, offset: off, bytes: stop - off, line, rec });
        off = stop + 1;
      }
    });

    const records: LedgerRec[] = [];
    for (const l of lines) if (l.rec) records.push(l.rec);
    const chain = structural ?? this.verify(agentId, lines);
    this.adopt(agentId, lines, files, chain);
    return { records, torn, chain };
  }

  /** Move a torn tail out of the newest segment (never acked: G1.1). */
  private quarantine(agentId: string, file: string, buf: Buffer, end: number): TornInfo {
    const at = this.now().toISOString();
    const info: TornInfo = { segment: file, offset: end, bytes: buf.length - end, quarantinedTo: this.tornFile(agentId), at };
    nodeFs.mkdirSync(join(this.agentDir(agentId), 'memory'), { recursive: true });
    nodeFs.appendFileSync(info.quarantinedTo, JSON.stringify({ ...info, data: buf.subarray(end).toString('base64') }) + '\n');
    nodeFs.truncateSync(file, end);
    this.log({ kind: 'claims-torn', agentId, segment: file, offset: end, bytes: info.bytes });
    return info;
  }

  /** Check prev and mac over every line; the first break, or 'ok'. */
  private verify(agentId: string, lines: ParsedLine[]): 'ok' | ChainBreak {
    if (lines.length === 0) return 'ok';
    // MACs are checked from the last rekey on; before it the Human accepted the prev chain (C2).
    // A rekey line counts only when its OWN MAC verifies under this hive's key and it names that
    // key: a forged rekey is an ordinary line that fails its MAC (Jim F1, god 2f8991).
    const key = this.keys();
    let macFrom = 0;
    for (let i = lines.length - 1; i >= 0 && key; i--) {
      const r = lines[i].rec;
      if (r && r.t === 'event' && r.ev === 'rekey' && r.keyId === keyIdOf(key)
        && recordMac(key, r as unknown as Record<string, unknown>) === r.mac) { macFrom = i; break; }
    }
    let prev = '';
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      const where = l.rec?.id ?? `${i}@${l.offset}`;
      if (!l.rec) return { brokenAt: where, reason: 'parse' };
      if (l.rec.prev !== prev) return { brokenAt: where, reason: 'prev' };
      if (l.rec.agent !== agentId) return { brokenAt: where, reason: 'mac' };
      if (l.rec.t === 'event' && l.rec.ev === 'rekey') {
        const before = i > 0 ? lines[i - 1].rec : null;
        if (!before || l.rec.targets?.[0] !== before.id) return { brokenAt: where, reason: 'prev' };
      }
      if (i >= macFrom) {
        if (!key) return { brokenAt: where, reason: 'key-missing' };
        // keys() returns only THIS hive's ledger key (its id matches the user-data record), so a
        // MAC failure here is always an edit or a forgery, never a wrong key (god 7dda19).
        if (recordMac(key, l.rec as unknown as Record<string, unknown>) !== l.rec.mac) return { brokenAt: where, reason: 'mac' };
      }
      prev = sha256Hex(l.line);
    }
    return 'ok';
  }

  /**
   * This hive's ledger key, or null (and the floor-wide key-missing alert when a ledger exists).
   * KEY IDENTITY (god 7dda19): a key that loads is used only when its id equals the id main
   * recorded for this hive in user-data (keyRecord) when it created the key or the Human rekeyed.
   * Another key (another user-data folder, a replaced key file) or no record is key-missing, never
   * a reason to read MAC failures as forgeries or to trust them. With no ledger anywhere a loaded
   * key is adopted (first use).
   */
  private keys(): Uint8Array | null {
    if (this.key) return this.key;
    const k = this.d.keys.load();
    let reason: string = k.ok ? '' : k.reason;
    if (k.ok) {
      const expected = this.d.keyRecord.get(this.d.hiveRoot);
      if (expected === k.keyId) { this.keyMissing = false; this.key = k.key; return k.key; }
      if (!this.anySegmentAnywhere()) {
        this.d.keyRecord.set(this.d.hiveRoot, k.keyId);
        this.keyMissing = false; this.key = k.key; return k.key;
      }
      reason = expected ? 'the loaded key is not this ledger key' : 'no record of this ledger key';
    }
    this.keyMissing = true;
    if (this.anySegmentAnywhere()) {
      this.alertOnce('key-missing', { kind: CLAIMS_ALERT_KEY_MISSING, reason, to: ['god', 'human'] });
    }
    return null;
  }

  private adopt(agentId: string, lines: ParsedLine[], files: string[], chain: 'ok' | ChainBreak): void {
    const known = new Map<string, Known>();
    for (const l of lines) {
      const r = l.rec;
      if (!r) continue;
      if (r.t === 'claim') {
        known.set(r.id, { t: 'claim', source: r.source, kind: r.kind });
      } else known.set(r.id, { t: 'event' });
    }
    const last = lines.length ? lines[lines.length - 1] : null;
    const tailFile = files.length ? files[files.length - 1] : null;
    this.state.set(agentId, {
      head: last ? sha256Hex(last.line) : '',
      lastId: last?.rec?.id ?? null,
      known,
      tailFile,
      tailSize: tailFile ? nodeFs.statSync(tailFile).size : 0,
      segments: files.length,
      readOnly: chain === 'ok' ? null : chain,
    });
    if (chain !== 'ok' && chain.reason === 'key-missing') {
      this.alertOnce('key-missing', { kind: CLAIMS_ALERT_KEY_MISSING, reason: 'the key does not verify the ledger', agentId, to: ['god', 'human'] });
    } else if (chain !== 'ok') {
      this.alertOnce(`chain:${agentId}:${chain.brokenAt}:${chain.reason}`, {
        kind: CLAIMS_ALERT_CHAIN_BROKEN, agentId, brokenAt: chain.brokenAt, reason: chain.reason, to: ['god', 'human'],
      });
    }
  }

  /** The cached state, re-read when the files changed under us (another writer, a crash, a forgery). */
  private current(agentId: string): AgentState {
    const s = this.state.get(agentId);
    if (s) {
      const files = this.segments(agentId);
      const tail = files.length ? files[files.length - 1] : null;
      let size = -1;
      try { size = tail ? nodeFs.statSync(tail).size : 0; } catch { size = -1; }
      if (files.length === s.segments && tail === s.tailFile && size === s.tailSize) return s;
    }
    this.readInner(agentId);
    return this.state.get(agentId) as AgentState;
  }

  /** Is this agent's ledger read-only, and why? */
  readOnly(agentId: string): ChainBreak | null {
    const s = this.current(agentId);
    if (s.readOnly) return s.readOnly;
    return this.keyMissing && s.segments > 0 ? { brokenAt: s.lastId ?? 'key', reason: 'key-missing' } : null;
  }

  /** What the store knows about a record id of this agent (W1's endpoint: a retract's kind). */
  lookup(agentId: string, id: string): Known | null {
    return this.current(agentId).known.get(id) ?? null;
  }

  // ---------------------------------------------------------------- write

  private serial<T>(agentId: string, fn: () => T): Promise<T> {
    const prior = this.queues.get(agentId) ?? Promise.resolve();
    const next = prior.then(fn, fn);
    this.queues.set(agentId, next.catch(() => undefined));
    return next;
  }

  /** plan API appendRecord: validate, clamp, chain, one write + fsync, then the ack. */
  appendRecord(agentId: string, draft: RecordDraft, origin: AppendOrigin): Promise<AppendResult> {
    return this.serial(agentId, () => this.appendNow(agentId, draft, origin));
  }

  private appendNow(agentId: string, draft: RecordDraft, origin: AppendOrigin): AppendResult {
    if (!AGENT_RE.test(agentId)) return { ok: false, error: 'bad agent id' };
    let s: AgentState;
    try { s = this.current(agentId); } catch (e) { return { ok: false, error: `the ledger could not be read (${String(e).slice(0, 120)})` }; }
    if (s.readOnly) return { ok: false, error: `the ledger is read-only (${s.readOnly.reason} at ${s.readOnly.brokenAt}); the Human has been alerted` };
    let key = this.keys();
    if (!key) {
      if (this.anySegmentAnywhere()) return { ok: false, error: 'the ledger is read-only: its key is missing; the Human has been alerted' };
      const made = this.d.keys.create();
      if (!made.ok) return { ok: false, error: `no ledger key could be created (${made.reason})` };
      key = made.key;
      this.d.keyRecord.set(this.d.hiveRoot, made.keyId);
      this.key = made.key;
      this.keyMissing = false;
      this.log({ kind: 'claims-key-created', keyId: made.keyId });
    }

    const wtDate = this.now();
    const wt = wtDate.toISOString();
    const built = this.build(agentId, draft, origin, s, wt);
    if ('error' in built) return { ok: false, error: built.error, ...(built.didYouMean ? { didYouMean: built.didYouMean } : {}) };
    const rec = built.rec;
    rec.prev = s.head;
    rec.mac = recordMac(key, rec as unknown as Record<string, unknown>);
    const line = canonicalJson(rec);
    const bytes = Buffer.from(line + '\n', 'utf8');
    return this.writeLine(agentId, s, rec, line, bytes, built.registryAdded);
  }

  private writeLine(agentId: string, s: AgentState, rec: LedgerRec, line: string, bytes: Buffer, registryAdded: (() => void) | null): AppendResult {
    const dir = this.claimsDir(agentId);
    const file = join(dir, `${monthOf(rec.wt)}.jsonl`);
    try {
      let h = this.fds.get(agentId);
      if (h && h.file !== file) { this.closeFd(agentId); h = undefined; }
      if (!h) {
        nodeFs.mkdirSync(dir, { recursive: true });
        h = { file, fd: this.fs.openSync(file, 'a'), idle: null };
        this.fds.set(agentId, h);
      }
      if (h.idle) clearTimeout(h.idle);
      h.idle = setTimeout(() => this.closeFd(agentId), this.d.fdIdleMs ?? FD_IDLE_MS);
      h.idle.unref?.();
      const n = this.fs.writeSync(h.fd, bytes);
      if (n !== bytes.length) throw new Error(`short write ${n}/${bytes.length}`);
      this.fs.fsyncSync(h.fd);
    } catch (e) {
      this.closeFd(agentId);
      this.state.delete(agentId);   // re-read (and repair the torn tail) before the next append
      this.log({ kind: 'claims-append-failed', agentId, error: String(e).slice(0, 200) });
      return { ok: false, error: `the append failed (${String(e).slice(0, 120)}); nothing was acked` };
    }
    // Acked: remember it.
    s.head = sha256Hex(line);
    s.lastId = rec.id;
    s.known.set(rec.id, rec.t === 'claim' ? { t: 'claim', source: rec.source, kind: rec.kind } : { t: 'event' });
    if (s.tailFile !== file) { s.tailFile = file; s.segments += 1; }
    try { s.tailSize = nodeFs.statSync(file).size; } catch { this.state.delete(agentId); }
    if (registryAdded) registryAdded();
    this.backupIfDue(agentId, rec.wt);
    return { ok: true, id: rec.id };
  }

  private closeFd(agentId: string): void {
    const h = this.fds.get(agentId);
    if (!h) return;
    this.fds.delete(agentId);
    if (h.idle) clearTimeout(h.idle);
    try { this.fs.closeSync(h.fd); } catch { /* already gone */ }
  }

  /** Close every append handle (quit, hive change). Appends after it reopen. */
  close(): void {
    for (const a of [...this.fds.keys()]) this.closeFd(a);
  }

  private newId(t: 'claim' | 'event', s: AgentState): string {
    for (;;) {
      const id = this.d.newId ? this.d.newId(t) : `${t === 'claim' ? 'c' : 'e'}-${randomBytes(6).toString('hex')}`;
      if (!s.known.has(id)) return id;
    }
  }

  /** Validate a draft for its origin and build the record (without prev and mac). */
  private build(agentId: string, draft: RecordDraft, origin: AppendOrigin, s: AgentState, wt: string):
    { rec: LedgerRec; registryAdded: (() => void) | null } | { error: string; didYouMean?: string } {
    if (!isObj(draft)) return { error: 'the draft is not an object' };
    const external = origin !== 'w6-internal';
    if (draft.t === 'claim') return this.buildClaim(agentId, draft, origin, external, s, wt);
    if (draft.t === 'event') {
      if (origin === 'w6-internal') return { error: 'the import writes claims only' };
      for (const k of Object.keys(draft)) if (!EVENT_DRAFT_FIELDS.has(k)) return { error: `unknown field "${k}"` };
      if (!DRAFT_EVENTS.has(draft.ev)) return { error: `unsupported event "${String(draft.ev)}"` };
      const targets = this.idList(draft.targets, 'targets', s, draft.ev === 'revert' ? 'any' : 'claim');
      if ('error' in targets) return targets;
      if (targets.ids.length === 0) return { error: 'targets must name at least one record' };
      if (draft.answer !== undefined && (draft.ev !== 'reconcile-answer' || !ANSWERS.has(draft.answer))) return { error: 'bad answer' };
      if (draft.ev === 'reconcile-answer' && draft.answer === undefined) return { error: 'a reconcile answer needs answer' };
      const rec: EventRec = {
        v: LEDGER_RECORD_VERSION, id: this.newId('event', s), t: 'event', ev: draft.ev, at: wt, wt, agent: agentId,
        targets: targets.ids, by: origin === 'ui-ipc' ? 'human' : 'self', prev: '', mac: '',
        ...(draft.answer !== undefined ? { answer: draft.answer } : {}),
      };
      return { rec, registryAdded: null };
    }
    return { error: 't must be claim or event' };
  }

  private buildClaim(agentId: string, draft: Extract<RecordDraft, { t: 'claim' }>, origin: AppendOrigin, external: boolean, s: AgentState, wt: string):
    { rec: LedgerRec; registryAdded: (() => void) | null } | { error: string; didYouMean?: string } {
    for (const k of Object.keys(draft)) if (!CLAIM_DRAFT_FIELDS.has(k)) return { error: `unknown field "${k}"` };
    // Source and legacy by origin (god's final rule; claims.ts AppendOrigin).
    let source: ClaimSource;
    if (origin === 'ui-ipc') {
      if (draft.source !== undefined && draft.source !== 'human') return { error: 'the UI writes source human only' };
      source = 'human';
    } else if (origin === 'w6-internal') {
      if (draft.source !== undefined && draft.source !== 'legacy' && draft.source !== 'self') return { error: 'the import writes source legacy or self only' };
      source = draft.source ?? 'legacy';
      if (source === 'legacy' && draft.legacy === undefined) return { error: 'a legacy claim needs its legacy provenance' };
    } else {
      if (draft.source !== undefined && draft.source !== 'self' && !(typeof draft.source === 'string' && MAIL_SOURCE_RE.test(draft.source))) {
        return { error: 'refused: an agent claim is self or mail:<id>' };
      }
      source = draft.source ?? 'self';
    }
    if (external && draft.legacy !== undefined) return { error: 'refused: legacy provenance is set by the import only' };
    if (draft.legacy !== undefined) {
      const lg = draft.legacy as unknown;
      if (!isObj(lg) || typeof lg.file !== 'string' || !lg.file || lg.file.length > 300 || !Number.isInteger(lg.line) || (lg.line as number) < 0
        || typeof lg.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(lg.sha256)
        || Object.keys(lg).some((k) => !['file', 'line', 'sha256'].includes(k))) return { error: 'bad legacy provenance' };
    }
    if (!CLAIM_KINDS.includes(draft.kind)) return { error: `bad kind "${String(draft.kind)}"; one of ${CLAIM_KINDS.join(', ')}` };
    if (typeof draft.text !== 'string' || !draft.text.trim()) return { error: 'a claim needs text' };
    const max = origin === 'w6-internal' ? CLAIM_TEXT_MAX_LEGACY : CLAIM_TEXT_MAX;
    const len = charLen(draft.text);
    if (len > max) return { error: `refused: the text is ${len} characters, over the ${max}-character limit (never cut); split it into separate claims` };
    const mail = source.startsWith('mail:');
    if (mail && draft.pin) return { error: 'refused: a mail claim cannot be pinned' };
    if (draft.pin !== undefined && draft.pin !== true) return { error: 'pin is true or absent' };
    // at: clamped to the write time (F2).
    let at = wt;
    if (draft.at !== undefined) {
      if (typeof draft.at !== 'string' || !ISO_RE.test(draft.at) || Number.isNaN(Date.parse(draft.at))) return { error: 'bad at (an ISO date or time)' };
      const claimed = new Date(Date.parse(draft.at)).toISOString();
      at = claimed < wt ? claimed : wt;
    }
    // One TTL grammar (ttl.ts): input forms become task:<id> or until:<iso> at write time.
    const ttl = normalizeTtl(draft.ttl, wt);
    if ('error' in ttl) return { error: ttl.error };
    let refs: Ref[] | undefined;
    if (draft.refs !== undefined) {
      if (!Array.isArray(draft.refs) || draft.refs.length > LIST_MAX) return { error: `refs: a list of at most ${LIST_MAX}` };
      refs = [];
      for (const r of draft.refs as unknown[]) {
        if (!isObj(r) || !REF_TYPES.has(r.type as Ref['type']) || typeof r.value !== 'string' || !r.value || r.value.length > REF_VALUE_MAX || Object.keys(r).length !== 2) {
          return { error: 'bad ref: {type: file|commit|task|msg|url, value}' };
        }
        refs.push({ type: r.type as Ref['type'], value: r.value as string });
      }
    }
    const sup = this.idList(draft.supersedes, 'supersedes', s, 'claim');
    if ('error' in sup) return sup;
    const ret = this.idList(draft.retracts, 'retracts', s, 'claim');
    if ('error' in ret) return ret;
    if (mail) {
      // THE INJECTION RULE (F2): a mail claim never supersedes or retracts a non-mail claim.
      for (const id of [...sup.ids, ...ret.ids]) {
        const k = s.known.get(id);
        if (!k?.source?.startsWith('mail:')) return { error: `refused: a mail claim cannot supersede or retract ${id} (${k?.source ?? 'unknown'})` };
      }
    }
    let registryAdded: (() => void) | null = null;
    if (draft.key !== undefined) {
      let reg;
      try { reg = loadRegistry(this.d.hiveRoot); } catch (e) { return { error: `the key registry is unreadable (${String(e).slice(0, 120)})` }; }
      const c = checkKey(reg, draft.key, agentId, wt);
      if (!c.ok) return { error: c.error, ...(c.didYouMean ? { didYouMean: c.didYouMean } : {}) };
      if (c.added) {
        const key = draft.key;
        registryAdded = () => {
          try { saveRegistry(this.d.hiveRoot, reg); } catch (e) { this.log({ kind: 'claims-key-save-failed', key, error: String(e).slice(0, 120) }); }
          this.log({ kind: 'claims-key-added', agentId, key, cardinality: c.cardinality });
        };
      }
    }
    const red = redactSecrets(draft.text);
    const rec: ClaimRec = {
      v: LEDGER_RECORD_VERSION, id: this.newId('claim', s), t: 'claim', kind: draft.kind, at, wt, agent: agentId,
      text: red.text, source, prev: '', mac: '',
      ...(draft.key !== undefined ? { key: draft.key } : {}),
      ...(refs ? { refs } : {}),
      ...(sup.ids.length ? { supersedes: sup.ids } : {}),
      ...(ret.ids.length ? { retracts: ret.ids } : {}),
      ...(draft.ttl !== undefined ? { ttl: ttl.ttl } : {}),
      ...(draft.pin ? { pin: true as const } : {}),
      ...(red.redacted ? { redacted: true as const } : {}),
      ...(draft.legacy !== undefined ? { legacy: draft.legacy } : {}),
    };
    return { rec, registryAdded };
  }

  private idList(v: unknown, name: string, s: AgentState, want: 'claim' | 'any'): { ids: string[] } | { error: string } {
    if (v === undefined) return { ids: [] };
    if (!Array.isArray(v) || v.length > LIST_MAX) return { error: `${name}: a list of at most ${LIST_MAX} ids` };
    const ids: string[] = [];
    for (const id of v) {
      if (typeof id !== 'string' || !ID_RE.test(id)) return { error: `${name}: bad id "${String(id).slice(0, 40)}"` };
      const k = s.known.get(id);
      if (!k) return { error: `${name}: unknown id ${id} (not in this agent's ledger)` };
      if (want === 'claim' && k.t !== 'claim') return { error: `${name}: ${id} is not a claim` };
      if (ids.includes(id)) return { error: `${name}: ${id} twice` };
      ids.push(id);
    }
    return { ids };
  }

  // ---------------------------------------------------------------- rekey (C2, Human only)

  /**
   * The Human's Settings action after a lost key. Creates a new key, then appends to every agent's
   * ledger a `rekey` event chained over its last record. Refused for an agent whose prev chain is
   * broken or that has a MAC failure under a key that still loads (a forgery: G1.8). Never automatic.
   */
  async rekey(confirmedByHuman: true): Promise<{ ok: boolean; keyId?: string; rekeyed: string[]; refused: Array<{ agentId: string; why: string }> }> {
    if (confirmedByHuman !== true) return { ok: false, rekeyed: [], refused: [] };
    let agents: string[] = [];
    try { agents = nodeFs.readdirSync(join(this.d.hiveRoot, 'agents')).filter((a) => AGENT_RE.test(a) && this.segments(a).length > 0); } catch { agents = []; }
    const refused: Array<{ agentId: string; why: string }> = [];
    const eligible: string[] = [];
    for (const a of agents) {
      const r = this.readLedger(a);
      if (r.chain !== 'ok' && r.chain.reason !== 'key-missing') { refused.push({ agentId: a, why: `${r.chain.reason} at ${r.chain.brokenAt}` }); continue; }
      const pv = this.prevChainOnly(a);
      if (typeof pv === 'string') { refused.push({ agentId: a, why: pv }); continue; }
      eligible.push(a);
    }
    if (eligible.length === 0) {
      this.log({ kind: 'claims-rekey', keyId: null, rekeyed: [], refused });
      return { ok: false, rekeyed: [], refused };
    }
    const made = this.d.keys.create();
    if (!made.ok) return { ok: false, rekeyed: [], refused: [...refused, ...eligible.map((agentId) => ({ agentId, why: `no key (${made.reason})` }))] };
    this.keyMissing = false;
    this.d.keyRecord.set(this.d.hiveRoot, made.keyId);
    this.key = made.key;
    this.alerted.delete('key-missing');
    const rekeyed: string[] = [];
    for (const a of eligible) {
      const done = await this.serial(a, () => {
        // The new key cannot verify the old records (that is the point), so this step checks the
        // prev chain only, as the Human's acceptance does (C2), and never raises a MAC alert.
        const tail = this.prevChainOnly(a);
        if (typeof tail === 'string') return false;
        const files = this.segments(a);
        const s: AgentState = {
          head: tail.head, lastId: tail.lastId, known: new Map(tail.ids.map((id) => [id, { t: id.startsWith('c-') ? 'claim' as const : 'event' as const }])),
          tailFile: files[files.length - 1] ?? null, tailSize: 0, segments: files.length, readOnly: null,
        };
        const wt = this.now().toISOString();
        const rec: EventRec = {
          v: LEDGER_RECORD_VERSION, id: this.newId('event', s), t: 'event', ev: 'rekey', at: wt, wt, agent: a,
          targets: [s.lastId as string], by: 'human', keyId: made.keyId, prev: s.head, mac: '',
        };
        rec.mac = recordMac(made.key, rec as unknown as Record<string, unknown>);
        const line = canonicalJson(rec);
        const w = this.writeLine(a, s, rec, line, Buffer.from(line + '\n', 'utf8'), null);
        this.state.delete(a);
        return w.ok;
      });
      if (done) rekeyed.push(a); else refused.push({ agentId: a, why: 'the rekey append failed' });
    }
    this.log({ kind: 'claims-rekey', keyId: made.keyId, rekeyed, refused });
    return { ok: refused.length === 0, keyId: made.keyId, rekeyed, refused };
  }

  /** The tail (head hash, last id, every id) when every line parses and every prev matches; else why not. */
  private prevChainOnly(agentId: string): { head: string; lastId: string; ids: string[] } | string {
    let prev = '';
    let lastId: string | null = null;
    const ids: string[] = [];
    for (const file of this.segments(agentId)) {
      const text = nodeFs.readFileSync(file, 'utf8');
      if (text.length && !text.endsWith('\n')) return 'a torn tail';
      for (const line of text.split('\n')) {
        if (!line) continue;
        let rec: LedgerRec;
        try { rec = JSON.parse(line) as LedgerRec; } catch { return 'an unparseable line'; }
        if (rec.prev !== prev) return `prev breaks at ${rec.id}`;
        prev = sha256Hex(line);
        lastId = rec.id;
        ids.push(rec.id);
      }
    }
    if (!lastId) return 'an empty ledger';
    return { head: prev, lastId, ids };
  }

  // ---------------------------------------------------------------- usage, backups

  /** The `used` verb: one usage row (not chained; W2's world counters read it). */
  noteUsage(agentId: string, rec: Omit<UsageRec, 'at'>): { ok: true } | { ok: false; error: string } {
    if (!AGENT_RE.test(agentId)) return { ok: false, error: 'bad agent id' };
    if (!['view', 'hit', 'helped', 'hurt'].includes(rec.op)) return { ok: false, error: 'op is view, hit, helped or hurt' };
    if (typeof rec.claim !== 'string' || !ID_RE.test(rec.claim) || !this.lookup(agentId, rec.claim)) return { ok: false, error: 'unknown claim id' };
    const row: UsageRec = { at: this.now().toISOString(), claim: rec.claim, op: rec.op, ...(rec.turn ? { turn: String(rec.turn).slice(0, 80) } : {}), ...(rec.card ? { card: String(rec.card).slice(0, 80) } : {}) };
    nodeFs.mkdirSync(join(this.agentDir(agentId), 'memory'), { recursive: true });
    nodeFs.appendFileSync(this.usageFile(agentId), JSON.stringify(row) + '\n');
    return { ok: true };
  }

  /** A daily copy of the agent's segments (G1.7). Best effort: a failed backup never fails an append. */
  backupIfDue(agentId: string, wt: string): string | null {
    const day = wt.slice(0, 10);
    const dir = this.backupDir(agentId, day);
    try {
      if (nodeFs.existsSync(dir)) return null;
      const tmp = `${dir}.tmp-${process.pid}`;
      nodeFs.rmSync(tmp, { recursive: true, force: true });
      nodeFs.mkdirSync(tmp, { recursive: true });
      for (const f of this.segments(agentId)) nodeFs.copyFileSync(f, join(tmp, basename(f)));
      nodeFs.renameSync(tmp, dir);
      this.log({ kind: 'claims-backup', agentId, day });
      return dir;
    } catch (e) {
      this.log({ kind: 'claims-backup-failed', agentId, day, error: String(e).slice(0, 160) });
      return null;
    }
  }

  /**
   * Restore an agent's segments from a backup day (a Human action): the live segments move to
   * `claims.pre-restore-<stamp>/` (nothing is deleted), the backup's are copied in, and the ledger
   * is re-read and verified.
   */
  restoreBackup(agentId: string, day: string): ReadResult {
    const src = this.backupDir(agentId, day);
    if (!nodeFs.existsSync(src)) throw new Error(`no backup ${day} for ${agentId}`);
    this.closeFd(agentId);
    const dir = this.claimsDir(agentId);
    const aside = join(this.agentDir(agentId), 'memory', `claims.pre-restore-${this.now().toISOString().replace(/[:.]/g, '-')}`);
    if (nodeFs.existsSync(dir)) nodeFs.renameSync(dir, aside);
    nodeFs.mkdirSync(dir, { recursive: true });
    for (const n of nodeFs.readdirSync(src)) if (SEGMENT_RE.test(n)) nodeFs.copyFileSync(join(src, n), join(dir, n));
    this.state.delete(agentId);
    this.log({ kind: 'claims-restore', agentId, day, aside });
    return this.readLedger(agentId);
  }
}
