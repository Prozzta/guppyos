/**
 * CLAIM-LEDGER W1: the key registry, `<hive>/memory-keys.json` (B13).
 *
 * A claim's `key` names the slot it fills (`release.current`, `agent.andy-x.editor`). The registry
 * says which slots exist and whether a slot holds ONE live value (`single`: a newer claim on it
 * supersedes, W2 R2) or many (`multi`: never supersedes).
 *   - A registered key is accepted.
 *   - A NEW key that is a near miss of a registered one (edit distance <= 2, or equal once `-`/`_`
 *     are ignored) is refused with a suggestion, so typos do not fork a slot.
 *   - Otherwise a new key under a namespace is added (with the namespace's cardinality) and logged.
 *   - A key under no namespace is refused.
 * `agent.<id>.*` matches only the writing agent's own id.
 * CL-M4-FORWARD-PATH: `card.<card id>` keys a card's notes (card.cl-m4-forward-path). It is MULTI, so
 * a newer note never supersedes an older one by rule (Jim's calibration: a same-card or same-key rule
 * removes true facts); the note offer lists same-key claims first and the writer chooses. Card ids are
 * distinct names (CL-W7 and CL-W8), so a new card key is never refused as a near miss.
 */
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DERIVED_AGENT_ID, type KeyRegistry } from '../../shared/claims';
import { canonicalJson, sha256Hex } from './canonical';

export const KEY_REGISTRY_FILE = 'memory-keys.json';

export const DEFAULT_KEY_REGISTRY: KeyRegistry = {
  v: 1,
  namespaces: [
    { pattern: 'agent.<id>.*', cardinality: 'single' },
    { pattern: 'release.*', cardinality: 'single' },
    { pattern: 'project.*', cardinality: 'single' },
    { pattern: 'pref.*', cardinality: 'single' },
    { pattern: 'list.*', cardinality: 'multi' },
    // CLAIMS-90 step 1: the merge claim of a branch no card owns (branch.<name>.*).
    { pattern: 'branch.*', cardinality: 'single' },
    { pattern: 'card.*', cardinality: 'multi' },
  ],
  keys: {},
};

const KEY_RE = /^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*){1,7}$/;
export const KEY_MAX = 120;
/** CL-M4-FORWARD-PATH: the namespace of card keys. */
export const CARD_KEY_PREFIX = 'card.';

export type KeyCheck =
  | { ok: true; cardinality: 'single' | 'multi'; added: boolean }
  | { ok: false; error: string; didYouMean?: string };

export function registryPath(hiveRoot: string): string {
  return join(hiveRoot, KEY_REGISTRY_FILE);
}

/** The registry on disk, or the default when the file is missing. A corrupt file is an error
 *  (never silently replaced: it would fork every slot). Keys a KeyRegistryWriter holds unsaved are saved first,
 *  so a reader sees every acked key (STARTUP-FREEZE-104 A9). */
export function loadRegistry(hiveRoot: string): KeyRegistry {
  flushRegistryWrites(hiveRoot);
  return readRegistryFile(hiveRoot);
}

function readRegistryFile(hiveRoot: string): KeyRegistry {
  const p = registryPath(hiveRoot);
  if (!existsSync(p)) return structuredClone(DEFAULT_KEY_REGISTRY);
  const raw = JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, '')) as KeyRegistry;
  if (!raw || raw.v !== 1 || !Array.isArray(raw.namespaces) || typeof raw.keys !== 'object' || raw.keys === null) {
    throw new Error(`${KEY_REGISTRY_FILE} is not a v1 key registry`);
  }
  // A registry saved before a built-in namespace existed gains it (additive: such keys were refused).
  for (const ns of DEFAULT_KEY_REGISTRY.namespaces) {
    if (!raw.namespaces.some((n) => n.pattern === ns.pattern)) raw.namespaces.push({ ...ns });
  }
  return raw;
}

/** STARTUP-FREEZE-104 (Jim, A3 gate): the parsed registry, kept per path while the file keeps the size and mtime it
 *  was read with (1.87 MB at 10x was read 73 times a minute). The racy rule: a read within RACY_MS of the file's
 *  mtime is not kept (a same-size write in the same tick would look unchanged). */
const RACY_MS = 2000;
const shared = new Map<string, { size: number; mtimeMs: number; reg: KeyRegistry }>();
function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o as object)) deepFreeze(v); }
  return o;
}
/** loadRegistry for READERS: one frozen object while the file is unchanged. A caller that edits the registry
 *  (checkKey before saveRegistry) uses loadRegistry, which returns its own copy. */
export function loadRegistryShared(hiveRoot: string): KeyRegistry {
  flushRegistryWrites(hiveRoot);
  const p = registryPath(hiveRoot);
  let st: { size: number; mtimeMs: number } | null = null;
  try { const s = statSync(p); st = { size: s.size, mtimeMs: s.mtimeMs }; } catch { st = null; }
  const hit = shared.get(p);
  if (st && hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.reg;
  const reg = deepFreeze(loadRegistry(hiveRoot));
  if (st && Date.now() - st.mtimeMs >= RACY_MS) shared.set(p, { ...st, reg });
  else shared.delete(p);
  return reg;
}

export function saveRegistry(hiveRoot: string, reg: KeyRegistry): void {
  const p = registryPath(hiveRoot);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n', 'utf8');
  renameSync(tmp, p);
}

/** STARTUP-FREEZE-104 A9 (Jim's 10x gate of 5b4db994): how long added keys wait to be saved together. */
export const REGISTRY_SAVE_MS = 1_000;

/** Unsaved keys per registry path: a reader of the registry (loadRegistry, loadRegistryShared, the raw text read)
 *  saves them first. */
const pendingWrites = new Map<string, () => void>();

/** Save the keys a KeyRegistryWriter holds for this hive, if any. Cheap when there are none. */
export function flushRegistryWrites(hiveRoot: string): void {
  pendingWrites.get(registryPath(hiveRoot))?.();
}

type KeyEntry = KeyRegistry['keys'][string];
type FileStamp = { size: number; mtimeMs: number } | 'missing';

/**
 * STARTUP-FREEZE-104 A9: the key registry the claims store checks and adds keys against.
 *
 * Before: every claim with a new key parsed memory-keys.json into its own copy and wrote the whole file back
 * (1.87 MB growing to 4.08 MB at 10x; about 6,300 adds on a cold start = about 19 GB parsed and written on main).
 * Now one working copy is kept while the file keeps the size and mtime it was read or written with; a key is
 * added in memory when its claim is acked, and the adds are saved together, at most once per REGISTRY_SAVE_MS,
 * with the same atomic tmp + rename. Any registry reader, and the store's close(), saves them first.
 *
 * Unchanged: the check (checkKey on the file's keys plus the acked unsaved ones), a key enters only when its
 * claim is acked, one claims-key-added row per add, and a failed save drops the unsaved keys (the next claim
 * that uses one adds it again), as a failed save did before. A file changed by another writer is re-read and
 * the unsaved keys are put back on top before the save.
 * New: a key acked less than REGISTRY_SAVE_MS before a crash is not on disk; the next claim with it adds it again.
 */
export class KeyRegistryWriter {
  private reg: KeyRegistry | null = null;
  /** The file `reg` was read from or written as; null = re-read before use (a read within RACY_MS of mtime). */
  private stamp: FileStamp | null = null;
  private unsaved = new Map<string, KeyEntry>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly path: string;

  constructor(private readonly hiveRoot: string, private readonly onSaveFailed: (keys: string[], error: unknown) => void,
    private readonly saveMs = REGISTRY_SAVE_MS) {
    this.path = registryPath(hiveRoot);
  }

  private statFile(): FileStamp | null {
    try { const st = statSync(this.path); return { size: st.size, mtimeMs: st.mtimeMs }; }
    catch (e) { return (e as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : null; }
  }

  private static same(a: FileStamp | null, b: FileStamp | null): boolean {
    if (!a || !b) return false;
    if (a === 'missing' || b === 'missing') return a === b;
    return a.size === b.size && a.mtimeMs === b.mtimeMs;
  }

  /** The file's registry plus the acked unsaved keys. Throws when the file is unreadable (as loadRegistry). */
  private working(): KeyRegistry {
    const now = this.statFile();
    if (this.reg && KeyRegistryWriter.same(this.stamp, now)) return this.reg;
    this.reg = null;
    const reg = readRegistryFile(this.hiveRoot);
    for (const [k, e] of this.unsaved) reg.keys[k] = e;
    this.reg = reg;
    this.stamp = now !== null && (now === 'missing' || Date.now() - now.mtimeMs >= RACY_MS) ? now : null;
    return reg;
  }

  /** checkKey against the working registry. An added entry is returned and NOT kept: commit() keeps it once its
   *  claim is acked. Throws when the registry is unreadable. */
  check(key: string, agentId: string, nowIso: string): KeyCheck & { entry?: KeyEntry } {
    const reg = this.working();
    const c = checkKey(reg, key, agentId, nowIso);
    if (!c.ok || !c.added) return c;
    const entry = reg.keys[key];
    delete reg.keys[key];
    return { ...c, entry };
  }

  /** The claim that added `key` is acked: keep the key, and save within saveMs. */
  commit(key: string, entry: KeyEntry): void {
    this.unsaved.set(key, entry);
    if (this.reg) this.reg.keys[key] = entry;
    pendingWrites.set(this.path, () => this.flush());
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.saveMs);
    this.timer.unref?.();
  }

  /** Save the acked unsaved keys now (atomic tmp + rename). */
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    pendingWrites.delete(this.path);
    if (this.unsaved.size === 0) return;
    const keys = [...this.unsaved.keys()];
    try {
      saveRegistry(this.hiveRoot, this.working());
      this.stamp = this.statFile();
    } catch (e) {
      this.reg = null;
      this.stamp = null;
      this.unsaved.clear();
      this.onSaveFailed(keys, e);
      return;
    }
    this.unsaved.clear();
  }
}

export function registryHash(reg: KeyRegistry): string {
  return sha256Hex(canonicalJson(reg));
}

function namespaceFor(reg: KeyRegistry, key: string, agentId: string): KeyRegistry['namespaces'][number] | null {
  let best: KeyRegistry['namespaces'][number] | null = null;
  let bestLen = -1;
  for (const ns of reg.namespaces) {
    const prefix = ns.pattern.replace(/\*$/, '').replace('<id>', agentId);
    if (!ns.pattern.endsWith('.*')) continue;
    if (key.startsWith(prefix) && key.length > prefix.length && prefix.length > bestLen) { best = ns; bestLen = prefix.length; }
  }
  return best;
}

export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

const squash = (k: string): string => k.replace(/[-_]/g, '');

/** The nearest registered key that `key` is a near miss of, or null. */
export function nearMiss(reg: KeyRegistry, key: string): string | null {
  let best: string | null = null;
  let bestD = Infinity;
  for (const k of Object.keys(reg.keys).sort()) {
    if (k === key) return null;
    const d = squash(k) === squash(key) ? 0 : editDistance(k, key);
    if (d <= 2 && d < bestD) { best = k; bestD = d; }
  }
  return best;
}

/** Check a key for `agentId`; on `added` the caller saves the registry (the entry is already in `reg`). */
export function checkKey(reg: KeyRegistry, key: string, agentId: string, nowIso: string): KeyCheck {
  if (typeof key !== 'string' || key.length > KEY_MAX || !KEY_RE.test(key)) {
    return { ok: false, error: `bad key "${String(key).slice(0, 60)}": lower-case dotted words, like release.current (at most ${KEY_MAX} characters)` };
  }
  const known = reg.keys[key];
  if (known) return { ok: true, cardinality: known.cardinality, added: false };
  // CLAIMS-90 M5: the derived writer's keys are built from versions and ids, never typed, and
  // release.1.1.97 is one edit from release.1.1.98: no near-miss check for them.
  const near = key.startsWith(CARD_KEY_PREFIX) || agentId === DERIVED_AGENT_ID ? null : nearMiss(reg, key);
  if (near) return { ok: false, error: `unknown key "${key}"; did you mean "${near}"?`, didYouMean: near };
  const ns = namespaceFor(reg, key, agentId);
  if (!ns) {
    const spaces = reg.namespaces.map((n) => n.pattern.replace('<id>', agentId)).join(', ');
    return { ok: false, error: `key "${key}" is under no namespace; use one of: ${spaces}` };
  }
  reg.keys[key] = { cardinality: ns.cardinality, addedAt: nowIso, addedBy: agentId };
  return { ok: true, cardinality: ns.cardinality, added: true };
}
