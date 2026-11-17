/**
 * CLAIM-LEDGER W1 (F3, C2): where the ledger's MAC key lives.
 *
 * The app's provider keeps 32 random bytes encrypted with Electron safeStorage (DPAPI on Windows)
 * in a file under the app's user-data folder: never in an agent's env, never in a hive file.
 * `load()` never creates a key; `create()` makes one only when no key file exists (first use with no
 * ledger anywhere, or a Human rekey after the key file is gone). It never replaces a key file:
 * every floor of the user-data folder uses it (CLAIMS-REKEY-SHARED-KEY). safeStorage is passed in, so this module loads without Electron.
 *
 * SandboxKeyProvider holds a key in memory, for tests and the Electron-as-Node drills (safeStorage
 * is not usable before `app` is ready).
 */
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MacKeyLoad, MacKeyProvider } from '../../shared/claims';
import { provenStatKey, statKey } from '../statCacheKey';
import { keyIdOf } from './canonical';

export const MAC_KEY_FILE = 'claims-mac.key';
const KEY_BYTES = 32;

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(enc: Buffer): string;
}

/**
 * CLAIMS-REKEY-SHARED-KEY: every floor that runs from one user-data folder shares its key file and
 * its record files, and two app instances can write them at once. A read-modify-write of a shared
 * file runs under `<file>.lock` (exclusive create; a lock older than LOCK_STALE_MS is a dead
 * holder's and is broken). Throws when the lock stays busy past LOCK_WAIT_MS, like any write error.
 */
const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 10000;
const lockSleep = new Int32Array(new SharedArrayBuffer(4));
export function withUserDataLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd: number;
  for (;;) {
    try { fd = openSync(lock, 'wx'); break; } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // EPERM/EACCES: Windows, while the last holder's unlink is still pending.
      if (code !== 'EEXIST' && code !== 'EPERM' && code !== 'EACCES') throw e;
      try { if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) { unlinkSync(lock); continue; } } catch { /* gone or busy: retry */ }
      if (Date.now() > deadline) throw new Error(`the user-data lock stayed busy: ${lock}`);
      Atomics.wait(lockSleep, 0, 0, 5);
    }
  }
  try {
    try { writeSync(fd, String(process.pid)); } catch { /* the pid is a hint only */ }
    return fn();
  } finally {
    try { closeSync(fd); } catch { /* closed */ }
    try { unlinkSync(lock); } catch { /* best effort: a stale lock is broken later */ }
  }
}

export class SafeStorageKeyProvider implements MacKeyProvider {
  constructor(private readonly file: string, private readonly safe: SafeStorageLike) {}

  load(): MacKeyLoad {
    if (!this.safe.isEncryptionAvailable()) return { ok: false, reason: 'unavailable' };
    if (!existsSync(this.file)) return { ok: false, reason: 'missing' };
    try {
      const key = Buffer.from(this.safe.decryptString(readFileSync(this.file)), 'base64');
      if (key.length !== KEY_BYTES) return { ok: false, reason: 'decrypt-failed' };
      return { ok: true, key, keyId: keyIdOf(key) };
    } catch {
      return { ok: false, reason: 'decrypt-failed' };
    }
  }

  /**
   * CLAIMS-REKEY-SHARED-KEY: makes a key only when no key file exists. The file is shared by every
   * floor of this user-data folder, so an existing key is never replaced: one that loads is
   * returned as is, one that does not decrypt is refused ('decrypt-failed', the caller alerts).
   * The new file is linked in exclusively, so two instances that both found none end on one key.
   */
  create(): MacKeyLoad {
    if (!this.safe.isEncryptionAvailable()) return { ok: false, reason: 'unavailable' };
    if (existsSync(this.file)) return this.existing();
    const key = randomBytes(KEY_BYTES);
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, this.safe.encryptString(key.toString('base64')));
    try {
      linkSync(tmp, this.file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return this.existing();
      throw e;
    } finally {
      try { unlinkSync(tmp); } catch { /* gone */ }
    }
    return { ok: true, key, keyId: keyIdOf(key) };
  }

  private existing(): MacKeyLoad {
    const l = this.load();
    return l.ok || l.reason === 'unavailable' ? l : { ok: false, reason: 'decrypt-failed' };
  }
}

/**
 * KEY IDENTITY (god 7dda19): which key id each hive's ledgers are written under. Main records it
 * when it creates a key (first use) and when the Human rekeys, in user-data next to the key, never
 * in the hive (an agent could rewrite a hive file to make a forgery read as a lost key). A MAC
 * failure under a key with the recorded id is a forgery; any other key is key-missing.
 */
export interface LedgerKeyRecord {
  get(hiveRoot: string): string | null;
  set(hiveRoot: string, keyId: string): void;
}

export const KEY_RECORD_FILE = 'claims-mac.hives.json';

/** A hive's id in the record: as the memory index names its file (mainWiring dbFileFor). */
export function hiveIdOf(hiveRoot: string): string {
  return createHash('sha256').update(hiveRoot.replace(/\\/g, '/').toLowerCase()).digest('hex').slice(0, 16);
}

export class FileLedgerKeyRecord implements LedgerKeyRecord {
  constructor(private readonly file: string) {}
  private read(): { v: 1; hives: Record<string, { keyId: string; at: string }> } {
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8'));
      if (j && j.v === 1 && j.hives && typeof j.hives === 'object') return j;
    } catch { /* missing or unreadable: no record */ }
    return { v: 1, hives: {} };
  }
  get(hiveRoot: string): string | null {
    const e = this.read().hives[hiveIdOf(hiveRoot)];
    return e && typeof e.keyId === 'string' ? e.keyId : null;
  }
  /** Under the user-data lock: the read and the rename are one step, so no other floor's entry is lost. */
  set(hiveRoot: string, keyId: string): void {
    withUserDataLock(this.file, () => {
      const j = this.read();
      j.hives[hiveIdOf(hiveRoot)] = { keyId, at: new Date().toISOString() };
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(j, null, 2) + '\n');
      renameSync(tmp, this.file);
    });
  }
}

/**
 * CLAIMS-HEAD-ANCHOR: each agent's ledger head (sha256 of its last line), kept by main in
 * user-data next to the key record, never in the hive or an agent folder. A ledger whose chain no
 * longer reaches its anchored head (deleted, restarted, truncated) is detected on read.
 */
/** CL-W7 B1: a purge's new head, recorded here (never in the agent folder) before its swap. */
export interface PendingAnchor { head: string; lastId: string }

export interface HeadAnchorStore {
  get(hiveRoot: string, agentId: string): { head: string; lastId: string; pending?: PendingAnchor } | null;
  set(hiveRoot: string, agentId: string, a: { head: string; lastId: string; pending?: PendingAnchor }): void;
  /** Every agent anchored for this hive (Jim A-2: main checks each, even with no segment left). */
  agents(hiveRoot: string): string[];
  /** LAG-MAIN-SYNC-FIXES: run `fn` against one revalidated snapshot (a census reads every agent's
   *  anchor; the file is checked once, not once per agent). A set() inside still writes through. */
  batch?<T>(fn: () => T): T;
}

export const HEAD_ANCHOR_FILE = 'claims-heads.json';

type AnchorFile = { v: 1; hives: Record<string, Record<string, { head: string; lastId: string; at: string; pending?: PendingAnchor }>> };

/**
 * LAG-MAIN-SYNC-FIXES item 2: the file used to be read and parsed on EVERY get/agents/set (110 KB,
 * ~25 times a minute, each a main-process stall under slow media). It now keeps the parsed map:
 *   - every read outside a batch stats the file and serves the map only when the stat key
 *     (mtime:ctime:size:ino) equals the key the map was read under: there is no time window, so a
 *     file changed by anyone (main, the backfill script, a Human's copy) is read again on the next
 *     call, exactly as before. A stale map can never answer for a newer file;
 *   - a map read within STAT_RACY_MS of the file's last change has no key (statCacheKey.ts: two
 *     same-size writes in one tick share a key), so the next call reads the disk;
 *   - set() drops the map: the next call reads what was written;
 *   - missing or unreadable: nothing is cached (no anchors, as before);
 *   - batch(fn): the census (checkAnchored, the roster) revalidates once and serves that snapshot
 *     for the rest of the synchronous call. A set() inside drops it as above.
 * The map is never handed out: get() and agents() build fresh values from it.
 */
export class FileHeadAnchorStore implements HeadAnchorStore {
  private cache: { key: string | null; j: AnchorFile } | null = null;
  private depth = 0;
  private batchFresh = false;
  constructor(private readonly file: string, private readonly wall: () => number = Date.now) {}
  private read(): AnchorFile {
    const c = this.cache;
    if (c && this.depth > 0 && this.batchFresh) return c.j;
    let st: ReturnType<typeof statSync>;
    try { st = statSync(this.file); } catch { this.cache = null; return { v: 1, hives: {} }; }
    if (c && c.key !== null && c.key === statKey(st)) { if (this.depth > 0) this.batchFresh = true; return c.j; }
    this.cache = null;
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8'));
      if (j && j.v === 1 && j.hives && typeof j.hives === 'object') {
        // The key is the stat taken BEFORE the read: a write between them leaves a key older than
        // the content, so the next call reads again (never the other way round).
        this.cache = { key: provenStatKey(st, this.wall()), j };
        if (this.depth > 0) this.batchFresh = true;
        return j;
      }
    } catch { /* missing or unreadable: no anchors */ }
    return { v: 1, hives: {} };
  }
  batch<T>(fn: () => T): T {
    if (this.depth === 0) this.batchFresh = false;
    this.depth++;
    // batchFresh is only read while depth > 0, and the next outermost batch starts it false.
    try { return fn(); } finally { this.depth--; }
  }
  get(hiveRoot: string, agentId: string): { head: string; lastId: string; pending?: PendingAnchor } | null {
    const e = this.read().hives[hiveIdOf(hiveRoot)]?.[agentId];
    if (!e || typeof e.head !== 'string') return null;
    const p = e.pending;
    const pending = p && typeof p.head === 'string' && p.head ? { head: p.head, lastId: String(p.lastId ?? '') } : undefined;
    return { head: e.head, lastId: String(e.lastId ?? ''), ...(pending ? { pending } : {}) };
  }
  agents(hiveRoot: string): string[] {
    const h = this.read().hives[hiveIdOf(hiveRoot)] ?? {};
    return Object.keys(h).filter((a) => typeof h[a]?.head === 'string' && (h[a].head !== '' || !!h[a].pending));
  }
  /** Under the user-data lock (CLAIMS-REKEY-SHARED-KEY), like the key record. */
  set(hiveRoot: string, agentId: string, a: { head: string; lastId: string; pending?: PendingAnchor }): void {
    withUserDataLock(this.file, () => this.setLocked(hiveRoot, agentId, a));
  }
  private setLocked(hiveRoot: string, agentId: string, a: { head: string; lastId: string; pending?: PendingAnchor }): void {
    // Under the lock the map is read from disk, never a cached or batch snapshot: another instance
    // may have written since, and its entries must survive this write.
    this.cache = null;
    this.batchFresh = false;
    // A copy: the cached map is never edited (a failed write must not leave it ahead of the file).
    // The read just cached the pre-write map; drop it so the next read sees this write.
    const j = structuredClone(this.read());
    this.cache = null;
    this.batchFresh = false;
    const h = (j.hives[hiveIdOf(hiveRoot)] ??= {});
    h[agentId] = { head: a.head, lastId: a.lastId, at: new Date().toISOString(), ...(a.pending ? { pending: { head: a.pending.head, lastId: a.pending.lastId } } : {}) };
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(j, null, 2));
    renameSync(tmp, this.file);
  }
}

export class SandboxKeyProvider implements MacKeyProvider {
  private key: Buffer | null;
  constructor(key?: Uint8Array | null) { this.key = key ? Buffer.from(key) : null; }
  load(): MacKeyLoad {
    return this.key ? { ok: true, key: this.key, keyId: keyIdOf(this.key) } : { ok: false, reason: 'missing' };
  }
  create(): MacKeyLoad {
    this.key = randomBytes(KEY_BYTES);
    return { ok: true, key: this.key, keyId: keyIdOf(this.key) };
  }
  /** Tests: lose the key. */
  drop(): void { this.key = null; }
}
