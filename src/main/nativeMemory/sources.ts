/**
 * NATIVE-MEMORY section 1: WHICH files are memory. A versioned allow-list, not discovery.
 *
 * The MINE-SCOPE lesson: mine the durable notes agents and people write, not whatever an agent
 * happened to emit (test output, JSON evidence, copied skill files, screenshots). Eligible:
 *   1. agents/<id>/memory.md
 *   2. direct agents/<id>/*.md (durable deliverables; never recursive)
 *   3. top-level hive notes named in the god-approved list (default EMPTY)
 *   4. per-agent opt-ins of a nested deliverable by relative path (an exception list)
 * Lists 3 and 4 live in `<hive>/memory-sources.json`:
 *   { "topLevel": ["NOTE.md"], "include": { "<agent-id>": ["sub/dir/FILE.md"] }, "ledger": { "<agent-id>": "reader" } }
 *
 * CLAIM-LEDGER (W3, spec amendment A3). An agent whose effective ledger level (claims.ts
 * effectiveLevel over the setting, the manifest's `ledger` entry and this build) is reader or writer
 * AND that has a ledger (at least one monthly segment; an agent without one keeps its markdown):
 *   - gains a `claims` source, `agents/<id>/memory/claims` (its monthly segments, exact path; the
 *     walk stays non-recursive). Its content reaches the index from MAIN, verified (main holds the
 *     MAC key): the worker never reads ledger lines itself;
 *   - loses memory.md, memory-archive-*.md and memory-ledger-export-*.md as sources. The reconcile
 *     treats that as a removal, and a flip back restores them (G3.4).
 * In shadow nothing changes here: claims are not indexed.
 * Everything else is excluded by rule. Every EXCLUDED `.md` is reported by path, so its owner
 * can opt it in before cutover (Jim R4). Nothing here reads file CONTENT except to hash it.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { effectiveLevel, IMPLEMENTED_LEVEL, type LedgerLevel } from '../../shared/claims';

/** Bumped whenever the rules below change: it is recorded in the index and the report. */
export const ALLOW_LIST_VERSION = 2;
export const SOURCES_CONFIG_FILE = 'memory-sources.json';

/** Directories under an agent folder that are never walked for the excluded-`.md` report
 *  either (mail, and caches with thousands of files). */
const NEVER_WALK = new Set(['inbox', 'outbox', '.done', '.sent', 'node_modules', '.git', 'sessions']);
/** A file bigger than this is not memory (a pasted log): excluded by rule. */
export const MAX_SOURCE_BYTES = 2 * 1024 * 1024;

export type SourceKind = 'memory' | 'deliverable' | 'top-level' | 'include' | 'claims';

export interface SourceEntry {
  /** Relative to the hive root, forward slashes: the stable key. */
  path: string;
  abs: string;
  kind: SourceKind;
  /** The agent id for agent files, `hive` for top-level notes. */
  wing: string;
  /** `memory` for memory.md, else the file's stem (lower-cased). */
  room: string;
}

export interface SourcesConfig {
  topLevel: string[];
  include: Record<string, string[]>;
  /** CLAIM-LEDGER: per-agent ledger levels (raw; effectiveLevel validates them). */
  ledger?: Record<string, unknown>;
}

/** CLAIM-LEDGER: the files a flagged agent's ledger replaces as sources (A3, F5). */
export function ledgerReplaced(fileName: string): boolean {
  const n = fileName.toLowerCase();
  return n === 'memory.md' || /^memory-archive-.*\.md$/.test(n) || /^memory-ledger-export-.*\.md$/.test(n);
}

/** A ledger's monthly segment file name (claims/store.ts). */
const SEGMENT_FILE = /^\d{4}-\d{2}\.jsonl$/;

/** The relative path of an agent's claims source (its segment folder). */
export const claimsSourcePath = (agentId: string): string => `agents/${agentId}/memory/claims`;

export interface Discovery {
  allowListVersion: number;
  eligible: SourceEntry[];
  /** Every `.md` under agents/ (walked) or at the top level that is NOT eligible, by path. */
  excludedMd: string[];
  /** Configured entries that do not exist / are not allowed (a typo, a path escape). */
  rejectedConfig: string[];
  counts: { discovered: number; eligible: number; excludedByRule: number; unreadable: number };
  /** CLAIM-LEDGER: each agent's effective level, for agents above `off` only. */
  ledgerLevels: Record<string, LedgerLevel>;
}

export interface LedgerDiscovery {
  /** The Settings value (config `claimLedger`). */
  claimLedger?: unknown;
  /** This build's highest level (tests); default IMPLEMENTED_LEVEL. */
  implemented?: LedgerLevel;
  /** CLAIMS-HEAD-ANCHOR (Jim A-2): agents main holds an anchor for. Such an agent still has a
   *  ledger when its segments are gone (deleted), so its markdown stays out of search. */
  anchored?: readonly string[];
}

const rel = (root: string, abs: string): string => relative(root, abs).split(sep).join('/');

/** A relative path that stays inside its base: no absolute path, no `..`, no drive, `.md` only. */
export function safeRelativeMd(p: unknown): string | null {
  if (typeof p !== 'string' || !p || p.length > 400) return null;
  const n = p.replace(/\\/g, '/');
  if (n.startsWith('/') || /^[a-zA-Z]:/.test(n) || n.split('/').some((s) => s === '..' || s === '' || s === '.')) return null;
  return /\.md$/i.test(n) ? n : null;
}

export function readSourcesConfig(hiveRoot: string): SourcesConfig {
  const empty: SourcesConfig = { topLevel: [], include: {} };
  const file = join(hiveRoot, SOURCES_CONFIG_FILE);
  if (!existsSync(file)) return empty;
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as Partial<SourcesConfig>;
    const ledger: Record<string, unknown> = {};
    if (j.ledger && typeof j.ledger === 'object' && !Array.isArray(j.ledger)) for (const [k, v] of Object.entries(j.ledger)) ledger[k] = v;
    const topLevel = Array.isArray(j.topLevel) ? j.topLevel.filter((x): x is string => typeof x === 'string') : [];
    const include: Record<string, string[]> = {};
    if (j.include && typeof j.include === 'object') {
      for (const [k, v] of Object.entries(j.include)) if (Array.isArray(v)) include[k] = v.filter((x): x is string => typeof x === 'string');
    }
    return { topLevel, include, ledger };
  } catch {
    return empty;
  }
}

const AGENT_ID = /^[A-Za-z0-9._-]+$/;

/** The room of an indexed Markdown file: `memory` for memory.md, else its name without .md, lowercased. */
export function roomOf(fileName: string): string {
  return fileName.toLowerCase() === 'memory.md' ? 'memory' : fileName.replace(/\.md$/i, '').toLowerCase();
}

function isFileWithin(abs: string, maxBytes: number): 'ok' | 'too-big' | 'unreadable' | 'missing' {
  try {
    const st = statSync(abs);
    if (!st.isFile()) return 'missing';
    return st.size > maxBytes ? 'too-big' : 'ok';
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
  }
}

/**
 * NATIVEMEM-SOURCES-LOCALE-SORT: an ORDINAL (UTF-16 code unit) comparator, the order `.sort()`
 * gives. `localeCompare` follows the machine's ICU locale (case-insensitive first, punctuation
 * weighted differently), so the same files came out in a different order on another locale or
 * Node build (Creed: 8 of 15 pairs disagreed on case and underscore names). Ordinal is the same
 * everywhere and keeps the intended `memory-archive-*.md` before `memory.md` ('-' < '.').
 * Jim S1: case-folded first (`toLowerCase` uses Unicode's default mapping, not the locale), the raw
 * code units only as the tie-break, so a `MEMORY.md` (still the memory room) stays after its
 * `Memory-Archive-*.md` instead of jumping ahead as an upper-case name would.
 */
export function ordinal(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x !== y) return x < y ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Walk every `.md` below `dir` (for the excluded report only), skipping mail and caches. */
function walkMd(dir: string, out: string[], depth = 0): void {
  if (depth > 8) return;
  let ents: import('node:fs').Dirent[];
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!NEVER_WALK.has(e.name)) walkMd(p, out, depth + 1); }
    else if (e.isFile() && /\.md$/i.test(e.name)) out.push(p);
  }
}

export function discoverSources(hiveRoot: string, config: SourcesConfig = readSourcesConfig(hiveRoot), ledgerOpts: LedgerDiscovery = {}): Discovery {
  const ledgerLevels: Record<string, LedgerLevel> = {};
  const eligible: SourceEntry[] = [];
  const excluded: string[] = [];
  const rejected: string[] = [];
  let unreadable = 0;
  const seen = new Set<string>();
  const add = (abs: string, kind: SourceKind, wing: string, name: string): void => {
    const status = isFileWithin(abs, MAX_SOURCE_BYTES);
    const r = rel(hiveRoot, abs);
    if (status === 'unreadable') { unreadable++; excluded.push(r); return; }
    if (status !== 'ok') { excluded.push(r); return; }
    if (seen.has(r)) return;
    seen.add(r);
    eligible.push({ path: r, abs, kind, wing, room: roomOf(name) });
  };
  const allMd: string[] = [];
  const agentsDir = join(hiveRoot, 'agents');
  let agents: string[] = [];
  try { agents = readdirSync(agentsDir, { withFileTypes: true }).filter((d) => d.isDirectory() && AGENT_ID.test(d.name)).map((d) => d.name).sort(); } catch { /* no agents yet */ }
  for (const id of agents) {
    const dir = join(agentsDir, id);
    walkMd(dir, allMd);
    const level = effectiveLevel(ledgerOpts.claimLedger, config.ledger?.[id], ledgerOpts.implemented ?? IMPLEMENTED_LEVEL).level;
    if (level !== 'off') ledgerLevels[id] = level;
    // Only an agent that HAS a ledger (a monthly segment) swaps its markdown for claims: an agent
    // with none yet (a new hire, an unimported one) keeps memory.md, so nothing it wrote vanishes.
    const claimsDir = join(dir, 'memory', 'claims');
    let hasLedger = false;
    if (level === 'reader' || level === 'writer') {
      try { hasLedger = readdirSync(claimsDir).some((n) => SEGMENT_FILE.test(n)); } catch { hasLedger = false; }
      // A deleted ledger does not swap the markdown back in: main's anchor says it existed (A-2).
      if (!hasLedger && ledgerOpts.anchored?.includes(id)) hasLedger = true;
    }
    const flagged = hasLedger;
    if (flagged) {
      const r = claimsSourcePath(id);
      seen.add(r);
      eligible.push({ path: r, abs: claimsDir, kind: 'claims', wing: id, room: 'claims' });
    }
    let files: import('node:fs').Dirent[] = [];
    try { files = readdirSync(dir, { withFileTypes: true }); } catch { unreadable++; continue; }
    for (const f of files.filter((x) => x.isFile() && /\.md$/i.test(x.name)).sort((a, b) => ordinal(a.name, b.name))) {
      if (flagged && ledgerReplaced(f.name)) continue;   // reported as excluded below
      add(join(dir, f.name), f.name.toLowerCase() === 'memory.md' ? 'memory' : 'deliverable', id, f.name);
    }
    for (const p of config.include[id] ?? []) {
      const safe = safeRelativeMd(p);
      const abs = safe ? join(dir, ...safe.split('/')) : '';
      if (!safe || !existsSync(abs)) { rejected.push(`agents/${id}/${String(p)}`); continue; }
      add(abs, 'include', id, safe.split('/').pop()!);
    }
  }
  // Top level: only the approved list; every other top-level .md is reported as excluded.
  let top: string[] = [];
  try { top = readdirSync(hiveRoot, { withFileTypes: true }).filter((d) => d.isFile() && /\.md$/i.test(d.name)).map((d) => d.name).sort(); } catch { /* none */ }
  for (const name of top) allMd.push(join(hiveRoot, name));
  for (const p of config.topLevel) {
    const safe = safeRelativeMd(p);
    if (!safe || safe.includes('/') || safe.toLowerCase() === 'board.md' || !existsSync(join(hiveRoot, safe))) { rejected.push(String(p)); continue; }
    add(join(hiveRoot, safe), 'top-level', 'hive', safe);
  }
  const eligibleSet = new Set(eligible.map((e) => e.path));
  for (const abs of allMd) {
    const r = rel(hiveRoot, abs);
    if (!eligibleSet.has(r) && !excluded.includes(r)) excluded.push(r);
  }
  excluded.sort();
  return {
    allowListVersion: ALLOW_LIST_VERSION,
    eligible,
    excludedMd: excluded,
    rejectedConfig: rejected,
    counts: { discovered: allMd.length, eligible: eligible.length, excludedByRule: excluded.length - unreadable, unreadable },
    ledgerLevels
  };
}

export function sha256(buf: Buffer | string): string {
  return createHash('sha256').update(buf).digest('hex');
}
