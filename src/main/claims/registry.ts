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
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KeyRegistry } from '../../shared/claims';
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
  ],
  keys: {},
};

const KEY_RE = /^[a-z0-9][a-z0-9_-]*(?:\.[a-z0-9][a-z0-9_-]*){1,7}$/;
export const KEY_MAX = 120;

export type KeyCheck =
  | { ok: true; cardinality: 'single' | 'multi'; added: boolean }
  | { ok: false; error: string; didYouMean?: string };

export function registryPath(hiveRoot: string): string {
  return join(hiveRoot, KEY_REGISTRY_FILE);
}

/** The registry on disk, or the default when the file is missing. A corrupt file is an error
 *  (never silently replaced: it would fork every slot). */
export function loadRegistry(hiveRoot: string): KeyRegistry {
  const p = registryPath(hiveRoot);
  if (!existsSync(p)) return structuredClone(DEFAULT_KEY_REGISTRY);
  const raw = JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, '')) as KeyRegistry;
  if (!raw || raw.v !== 1 || !Array.isArray(raw.namespaces) || typeof raw.keys !== 'object' || raw.keys === null) {
    throw new Error(`${KEY_REGISTRY_FILE} is not a v1 key registry`);
  }
  return raw;
}

export function saveRegistry(hiveRoot: string, reg: KeyRegistry): void {
  const p = registryPath(hiveRoot);
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n', 'utf8');
  renameSync(tmp, p);
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
  const near = nearMiss(reg, key);
  if (near) return { ok: false, error: `unknown key "${key}"; did you mean "${near}"?`, didYouMean: near };
  const ns = namespaceFor(reg, key, agentId);
  if (!ns) {
    const spaces = reg.namespaces.map((n) => n.pattern.replace('<id>', agentId)).join(', ');
    return { ok: false, error: `key "${key}" is under no namespace; use one of: ${spaces}` };
  }
  reg.keys[key] = { cardinality: ns.cardinality, addedAt: nowIso, addedBy: agentId };
  return { ok: true, cardinality: ns.cardinality, added: true };
}
