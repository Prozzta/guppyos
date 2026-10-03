/**
 * CLAIM-LEDGER W1 (F3, C2): where the ledger's MAC key lives.
 *
 * The app's provider keeps 32 random bytes encrypted with Electron safeStorage (DPAPI on Windows)
 * in a file under the app's user-data folder: never in an agent's env, never in a hive file.
 * `load()` never creates a key; `create()` makes a new one (first use with no ledger anywhere, or a
 * Human rekey). safeStorage is passed in, so this module loads without Electron.
 *
 * SandboxKeyProvider holds a key in memory, for tests and the Electron-as-Node drills (safeStorage
 * is not usable before `app` is ready).
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MacKeyLoad, MacKeyProvider } from '../../shared/claims';
import { keyIdOf } from './canonical';

export const MAC_KEY_FILE = 'claims-mac.key';
const KEY_BYTES = 32;

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(enc: Buffer): string;
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

  create(): MacKeyLoad {
    if (!this.safe.isEncryptionAvailable()) return { ok: false, reason: 'unavailable' };
    const key = randomBytes(KEY_BYTES);
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, this.safe.encryptString(key.toString('base64')));
    renameSync(tmp, this.file);
    return { ok: true, key, keyId: keyIdOf(key) };
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
  set(hiveRoot: string, keyId: string): void {
    const j = this.read();
    j.hives[hiveIdOf(hiveRoot)] = { keyId, at: new Date().toISOString() };
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(j, null, 2) + '\n');
    renameSync(tmp, this.file);
  }
}

/**
 * CLAIMS-HEAD-ANCHOR: each agent's ledger head (sha256 of its last line), kept by main in
 * user-data next to the key record, never in the hive or an agent folder. A ledger whose chain no
 * longer reaches its anchored head (deleted, restarted, truncated) is detected on read.
 */
export interface HeadAnchorStore {
  get(hiveRoot: string, agentId: string): { head: string; lastId: string } | null;
  set(hiveRoot: string, agentId: string, a: { head: string; lastId: string }): void;
}

export const HEAD_ANCHOR_FILE = 'claims-heads.json';

export class FileHeadAnchorStore implements HeadAnchorStore {
  constructor(private readonly file: string) {}
  private read(): { v: 1; hives: Record<string, Record<string, { head: string; lastId: string; at: string }>> } {
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8'));
      if (j && j.v === 1 && j.hives && typeof j.hives === 'object') return j;
    } catch { /* missing or unreadable: no anchors */ }
    return { v: 1, hives: {} };
  }
  get(hiveRoot: string, agentId: string): { head: string; lastId: string } | null {
    const e = this.read().hives[hiveIdOf(hiveRoot)]?.[agentId];
    return e && typeof e.head === 'string' ? { head: e.head, lastId: String(e.lastId ?? '') } : null;
  }
  set(hiveRoot: string, agentId: string, a: { head: string; lastId: string }): void {
    const j = this.read();
    const h = (j.hives[hiveIdOf(hiveRoot)] ??= {});
    h[agentId] = { head: a.head, lastId: a.lastId, at: new Date().toISOString() };
    mkdirSync(dirname(this.file), { recursive: true });
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
