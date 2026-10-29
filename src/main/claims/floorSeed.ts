/**
 * CLAIMS-DEFAULT (god bb3f5b): a NEW floor starts on the claim ledger. When a hive is first created
 * (HiveManager.ensureHive, no registry.json yet), its memory-sources.json is seeded with
 * `ledgerDefault: "writer"` (C2), and, when the floor's project folder is a git repo, `derivedRepo`
 * naming it (C4), so the derived writer reads that project's commits and tags. An existing hive, or
 * one that already has a memory-sources.json, is never touched: its levels stay as they are.
 * A seeded floor without `derivedRepo` resolves its repo on every pass (floorRepo): the project folder
 * may be registered after the hive was made, or become a git repo later (CLAIMS-DEFAULT-ON-103).
 */
import { existsSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { LedgerLevel } from '../../shared/claims';
import { SOURCES_CONFIG_FILE } from '../nativeMemory/sources';

/** The level a new floor gives an agent with no entry of its own. */
export const NEW_FLOOR_LEDGER_DEFAULT: LedgerLevel = 'writer';

/** A folder is a git repo when it holds `.git` (a directory, or a worktree's `.git` file). */
export const isGitRepo = (folder: string): boolean => existsSync(join(folder, '.git'));

/** The memory-sources.json a new floor starts with. `projectFolder` is the floor's first registered repo. */
export function newFloorSources(projectFolder: string | null | undefined, isRepo: (folder: string) => boolean = isGitRepo): Record<string, unknown> {
  const repo = typeof projectFolder === 'string' && isAbsolute(projectFolder) && isRepo(projectFolder) ? projectFolder : null;
  return { topLevel: [], include: {}, ledger: {}, ledgerDefault: NEW_FLOOR_LEDGER_DEFAULT, ...(repo ? { derivedRepo: repo } : {}) };
}

/** C4: the repo the derived writer reads: the floor's `derivedRepo`, else config derivedClaimsRepo, else none. */
export function derivedRepoFor(floorRepo: unknown, configRepo: unknown): string | null {
  if (typeof floorRepo === 'string' && floorRepo.trim()) return floorRepo;
  return typeof configRepo === 'string' && configRepo.trim() ? configRepo : null;
}

/**
 * The repo the derived writer reads now: derivedRepoFor, else, on a seeded floor (one with ledgerDefault),
 * the project folder once it is a git repo. A floor without ledgerDefault (made before 1.1.103) reads only
 * derivedRepoFor, as before. A non-git project folder gives null: the writer then derives every fact that
 * needs no commit (cards, rulings, releases) and the mail index serves the done mails.
 */
export function floorRepo(floor: { ledgerDefault?: unknown; derivedRepo?: unknown } | null, configRepo: unknown, projectFolder: string | null | undefined, isRepo: (folder: string) => boolean = isGitRepo): string | null {
  const set = derivedRepoFor(floor?.derivedRepo, configRepo);
  if (set || !floor || floor.ledgerDefault === undefined) return set;
  return typeof projectFolder === 'string' && isAbsolute(projectFolder) && isRepo(projectFolder) ? projectFolder : null;
}

/** Write the new floor's memory-sources.json unless one exists. True when it was written. */
export function seedFloorSources(hiveRoot: string, projectFolder: string | null | undefined, isRepo: (folder: string) => boolean = isGitRepo): boolean {
  const file = join(hiveRoot, SOURCES_CONFIG_FILE);
  if (existsSync(file)) return false;
  writeFileSync(file, `${JSON.stringify(newFloorSources(projectFolder, isRepo), null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  return true;
}
