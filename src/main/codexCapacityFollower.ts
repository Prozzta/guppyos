/**
 * QUOTA-BACKOFF (A11): Codex capacity followed on the floor beat, not only on hooks.
 *
 * A Codex turn that hits the usage limit ends with no assistant message, and Codex sends no
 * Stop for such a turn - so the hook-driven read (HookServer.observeCodexCapacity) never sees
 * the 100% snapshot or the `usage_limit_exceeded` completion. This follower lets the beat read
 * them instead, under two cost rules (god, A21/A7):
 *
 *  - it reads ONLY the bytes appended since its stored offset. The first poll of a file reads a
 *    bounded tail (FOLLOWER_FIRST_TAIL_BYTES); after that an unchanged file costs one stat and no
 *    read, and a gap larger than FOLLOWER_MAX_READ_BYTES falls back to that bounded tail.
 *  - a rollout that cannot be found is not looked for again (a sync directory walk) on every
 *    beat: the miss is remembered per home and session for FOLLOWER_MISS_RETRY_MS.
 *  - the account scope (existsSync + realpath) is resolved once per binding, not per poll.
 *  - it is async end to end (injected async stat/read), so the beat never blocks on disk.
 *
 * A partial last line is carried over and completed on a later poll, never parsed as half a line.
 * State per home: file, offset, carry, the newest accepted snapshot (raw + normalized) and a
 * standing usage-limit hit (cleared by any later turn boundary).
 */
import { normalizeCodexRateLimits } from './capacityNormalize';
import {
  codexTurnBoundary,
  codexUsageLimitObservation,
  latestUsableRateLimits,
  type CodexUsageLimitHit
} from './codexRolloutCapacity';

type Observation = NonNullable<ReturnType<typeof normalizeCodexRateLimits>>;

export const FOLLOWER_FIRST_TAIL_BYTES = 256 * 1024;
/** One poll never reads more than this: a longer gap (a long stall) restarts from the tail. */
export const FOLLOWER_MAX_READ_BYTES = FOLLOWER_FIRST_TAIL_BYTES;
/** After a rollout lookup misses, the same home and session are not looked up again for this long. */
export const FOLLOWER_MISS_RETRY_MS = 60_000;

export interface CodexCapacityFollowerDeps {
  scopeOf: (codexHome: string) => string;
  /** Resolve the rollout file; called only when none is bound, the session changed, or it vanished. */
  findRollout: (codexHome: string, sessionId?: string) => string | null | Promise<string | null>;
  stat: (file: string) => Promise<{ size: number; mtimeMs: number }>;
  read: (file: string, position: number, length: number) => Promise<Buffer>;
  now?: () => number;
}

interface HomeState {
  file: string;
  sessionId: string | undefined;
  /** The account scope, resolved once when the file is bound. */
  scope: string;
  offset: number;
  carry: Buffer;
  snapshotRaw: unknown;
  snapshot: Observation | null;
  hit: CodexUsageLimitHit | null;
  /** The bytes before the first newline of a mid-file tail are a fragment, not a line. */
  skipHead: boolean;
}

export class CodexCapacityFollower {
  private readonly homes = new Map<string, HomeState>();
  private readonly inflight = new Set<string>();
  /** A lookup that found no rollout: not repeated before `until` unless the session changes. */
  private readonly misses = new Map<string, { sessionId: string | undefined; until: number }>();
  private readonly now: () => number;

  constructor(private readonly deps: CodexCapacityFollowerDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * Read what was appended since the last poll. Resolves to a capacity observation when the
   * appended lines change the reading (a new usable snapshot, or a usage-limit completion),
   * else null. Single-flight per home: an overlapping poll resolves null without reading.
   */
  async poll(codexHome: string, opts: { sessionId?: string } = {}): Promise<Observation | null> {
    if (this.inflight.has(codexHome)) return null;
    this.inflight.add(codexHome);
    try {
      return await this.pollOnce(codexHome, opts.sessionId);
    } catch {
      return null;
    } finally {
      this.inflight.delete(codexHome);
    }
  }

  forget(codexHome: string): void { this.homes.delete(codexHome); this.misses.delete(codexHome); }

  private async pollOnce(codexHome: string, sessionId: string | undefined): Promise<Observation | null> {
    let st = this.homes.get(codexHome);
    if (st && sessionId && st.sessionId !== sessionId) st = undefined;
    let size: number;
    if (st) {
      try { size = (await this.deps.stat(st.file)).size; } catch { st = undefined; size = -1; }
    } else size = -1;
    if (!st) {
      const miss = this.misses.get(codexHome);
      if (miss && miss.sessionId === sessionId && this.now() < miss.until) return null;
      const file = await this.deps.findRollout(codexHome, sessionId);
      if (!file) {
        this.homes.delete(codexHome);
        this.misses.set(codexHome, { sessionId, until: this.now() + FOLLOWER_MISS_RETRY_MS });
        return null;
      }
      this.misses.delete(codexHome);
      size = (await this.deps.stat(file)).size;
      st = { file, sessionId, scope: this.deps.scopeOf(codexHome), offset: -1, carry: Buffer.alloc(0), snapshotRaw: null, snapshot: null, hit: null, skipHead: false };
      this.homes.set(codexHome, st);
    }
    if (st.offset < 0 || size < st.offset || size - st.offset > FOLLOWER_MAX_READ_BYTES) {
      // A new binding, the file shrank (replaced), or a gap too long to read in one poll: start
      // again from a bounded tail.
      st.offset = Math.max(0, size - FOLLOWER_FIRST_TAIL_BYTES);
      st.skipHead = st.offset > 0;
      st.carry = Buffer.alloc(0);
      st.snapshotRaw = null; st.snapshot = null; st.hit = null;
    }
    if (size === st.offset) return null;
    const buf = await this.deps.read(st.file, st.offset, size - st.offset);
    st.offset += buf.length;
    let data = st.carry.length ? Buffer.concat([st.carry, buf]) : buf;
    const lastNl = data.lastIndexOf(0x0a);
    if (lastNl < 0) { st.carry = Buffer.from(data); return null; }
    st.carry = Buffer.from(data.subarray(lastNl + 1));
    data = data.subarray(0, lastNl);
    const lines = data.toString('utf8').split('\n');
    // A tail that starts mid-file starts mid-line: that fragment is not a line.
    if (st.skipHead) { lines.shift(); st.skipHead = false; }
    return this.ingest(codexHome, st, lines);
  }

  private ingest(codexHome: string, st: HomeState, lines: readonly string[]): Observation | null {
    const scope = st.scope;
    const streamId = `codex-rollout:${st.file}`;
    const receivedAt = this.now();
    let newSnapshot = false;
    let newHit = false;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      const b = codexTurnBoundary(line);
      if (b) {
        // A later turn boundary voids the hit here but reports nothing: the follower never lifts a
        // LIMITED reading itself. Admission refuses while LIMITED; the next snapshot or the reset does.
        if (b.kind === 'hit') { st.hit = b.hit; newHit = true; } else { st.hit = null; newHit = false; }
        continue;
      }
      if (!line.includes('rate_limits')) continue;
      let acceptedRaw: unknown = null;
      const o = latestUsableRateLimits(line, (rateLimits, observedAt, sequence) => {
        const n = normalizeCodexRateLimits({
          rateLimits, accountScope: scope, streamId, sourceSequence: sequence,
          observedAt, receivedAt, source: 'codex-rollout'
        });
        if (n) acceptedRaw = rateLimits;
        return n;
      });
      if (o) { st.snapshot = o; st.snapshotRaw = acceptedRaw; newSnapshot = true; }
    }
    if (!newSnapshot && !newHit) return null;
    const hit = st.hit;
    if (hit && (!st.snapshot || hit.observedAt >= st.snapshot.observedAt)) {
      return codexUsageLimitObservation({ snapshotRaw: st.snapshotRaw, hit, accountScope: scope, streamId, receivedAt }) ?? st.snapshot;
    }
    return newSnapshot ? st.snapshot : null;
  }
}
