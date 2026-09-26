/**
 * MEMPALACE-REMOVAL (1.1.59): the OLD MemPalace data the app no longer uses, and the one way to
 * delete it (god's D2: only on the Human's explicit, confirmed request; never automatic).
 *
 * What counts as old data, all under the harness home:
 *   palace/                          the ChromaDB palace the legacy miner kept
 *   palace.mempalace-rebuild-*       staging / backup trees a repair left beside it
 *   palace.mempalace-backup-*
 *   .mempalace-mine-state.json       the legacy miner's fingerprints
 * The memory engine's index lives in userData, never here, so none of this is read any more.
 *
 * Delete is ALL OR NOTHING (Jim's note): every directory is first RENAMED aside, which Windows
 * refuses while any file inside is open (a stray legacy daemon holding chroma.sqlite3). If one
 * rename fails, the earlier ones are renamed back and the locked files are reported by path,
 * so a failed delete never leaves a half-deleted palace behind.
 */
import { existsSync, openSync, closeSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface LegacyPalaceInfo {
  /** Absolute paths that exist (directories and the state file). */
  paths: string[];
  bytes: number;
}

export type LegacyDeleteResult =
  | { ok: true; bytes: number; paths: string[] }
  | { ok: false; error: string; locked: string[] };

export interface FsDeps {
  exists: (p: string) => boolean;
  readdir: (p: string) => Array<{ name: string; dir: boolean }>;
  size: (p: string) => number;
  rename: (a: string, b: string) => void;
  rm: (p: string) => void;
  /** Throws when the file cannot be opened for writing (locked by another process). */
  probeWrite: (p: string) => void;
}

export const realFs: FsDeps = {
  exists: (p) => existsSync(p),
  readdir: (p) => readdirSync(p, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() })),
  size: (p) => statSync(p).size,
  rename: (a, b) => renameSync(a, b),
  rm: (p) => rmSync(p, { recursive: true, force: true }),
  probeWrite: (p) => closeSync(openSync(p, 'r+'))
};

/** Repair staging/backup trees, and anything an interrupted delete left moved aside. */
const SIBLING = /^palace\.(mempalace-(rebuild|backup)-|deleting-\d+$)|^\.mempalace-mine-state\.json\.deleting-\d+$/;
export const MINE_STATE_FILE = '.mempalace-mine-state.json';

/** The old-data paths that exist under `home` (the palace first). */
export function legacyPaths(home: string, fs: FsDeps = realFs): string[] {
  const out: string[] = [];
  const palace = join(home, 'palace');
  if (fs.exists(palace)) out.push(palace);
  let names: Array<{ name: string; dir: boolean }> = [];
  try { names = fs.readdir(home); } catch { names = []; }
  for (const e of names) if (SIBLING.test(e.name)) out.push(join(home, e.name));
  const state = join(home, MINE_STATE_FILE);
  if (fs.exists(state)) out.push(state);
  return out;
}

function treeFiles(p: string, fs: FsDeps, out: string[] = []): string[] {
  let es: Array<{ name: string; dir: boolean }>;
  try { es = fs.readdir(p); } catch { out.push(p); return out; }   // a file
  for (const e of es) {
    const q = join(p, e.name);
    if (e.dir) treeFiles(q, fs, out); else out.push(q);
  }
  return out;
}

/** What is there and how big, or null when there is no old data. Never throws. */
export function legacyPalaceInfo(home: string | null | undefined, fs: FsDeps = realFs): LegacyPalaceInfo | null {
  if (!home) return null;
  const paths = legacyPaths(home, fs);
  if (!paths.length) return null;
  let bytes = 0;
  for (const p of paths) for (const f of treeFiles(p, fs)) { try { bytes += fs.size(f); } catch { /* vanished */ } }
  return { paths, bytes };
}

/** Delete every old-data path, all or nothing (see the header). */
export function deleteLegacyPalace(home: string, fs: FsDeps = realFs, now = Date.now()): LegacyDeleteResult {
  const info = legacyPalaceInfo(home, fs);
  if (!info) return { ok: true, bytes: 0, paths: [] };
  const moved: Array<[string, string]> = [];
  for (const p of info.paths) {
    const aside = `${p}.deleting-${now}`;
    try {
      fs.rename(p, aside);
      moved.push([p, aside]);
    } catch (e) {
      for (const [orig, tmp] of moved.reverse()) { try { fs.rename(tmp, orig); } catch { /* reported below */ } }
      const locked: string[] = [];
      for (const f of treeFiles(p, fs)) { try { fs.probeWrite(f); } catch { locked.push(f); } }
      const code = (e as NodeJS.ErrnoException)?.code ?? String(e);
      return { ok: false, error: `could not move ${p} aside (${code}): nothing was deleted`, locked: locked.length ? locked : [p] };
    }
  }
  for (const [, aside] of moved) { try { fs.rm(aside); } catch { /* moved aside: the next attempt finds nothing to delete */ } }
  return { ok: true, bytes: info.bytes, paths: info.paths };
}

// ── god's D3: a legacy daemon 1.1.58 left running ─────────────────────────────────────────────

export interface ProcLike { pid: number; parentPid: number; commandLine: string }

const norm = (p: string): string => p.replace(/^["']|["']$/g, '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/**
 * OUR legacy daemon's processes: an executable that is python or mempalace (never, say, an
 * agent whose prompt merely mentions the text) running `mempalace.daemon serve` (or
 * `mempalace ... daemon serve`) with `--palace` = this hive's palace. On this floor it is
 * `...\uv\tools\mempalace\Scripts\python.exe -m mempalace.daemon serve --palace C:\Dunder\palace`
 * (a launcher and its child). Returns the ROOTS only (a match whose parent is not a match):
 * killing a root's tree takes its children with it.
 */
export function legacyDaemonRoots(rows: readonly ProcLike[], palacePath: string): ProcLike[] {
  const want = norm(palacePath);
  const matches = rows.filter((r) => {
    const cmd = r.commandLine ?? '';
    const exe = /^\s*(?:"([^"]+)"|(\S+))/.exec(cmd);
    const base = (exe?.[1] ?? exe?.[2] ?? '').replace(/\\/g, '/').split('/').pop()!.toLowerCase();
    if (!/^(python[\d.]*|pythonw|mempalace)(\.exe)?$/.test(base)) return false;
    if (!/(-m\s+mempalace\.daemon|mempalace(\.exe)?["']?\s+(?:\S+\s+)*daemon)\s+serve\b/i.test(cmd)) return false;
    const m = /--palace(?:=|\s+)("[^"]+"|'[^']+'|\S+)/.exec(cmd);
    return !!m && norm(m[1]) === want;
  });
  const pids = new Set(matches.map((r) => r.pid));
  return matches.filter((r) => !pids.has(r.parentPid));
}

export interface StopDaemonDeps {
  probe: () => Promise<ProcLike[] | null>;
  kill: (pids: number[]) => Promise<void>;
  log: (row: Record<string, unknown>) => void;
}

/** Stop our leftover legacy daemon ONCE (async, bounded by its deps), and say so: one
 *  `legacy-daemon-stopped` row, or `legacy-daemon-running` with the pids when it survives.
 *  Nothing when there is none, or when processes cannot be listed (not Windows). */
export async function stopLegacyDaemon(palacePath: string | null, d: StopDaemonDeps): Promise<'none' | 'stopped' | 'running'> {
  if (!palacePath) return 'none';
  const rows = await d.probe().catch(() => null);
  if (!rows) return 'none';
  const roots = legacyDaemonRoots(rows, palacePath);
  if (!roots.length) return 'none';
  const pids = roots.map((r) => r.pid);
  await d.kill(pids).catch(() => undefined);
  const after = await d.probe().catch(() => null);
  const left = after ? legacyDaemonRoots(after, palacePath).map((r) => r.pid) : pids;
  if (left.length) { d.log({ kind: 'legacy-daemon-running', pids: left, palace: palacePath }); return 'running'; }
  d.log({ kind: 'legacy-daemon-stopped', pids, palace: palacePath });
  return 'stopped';
}
