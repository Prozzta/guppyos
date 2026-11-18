import { accessSync, constants, statSync } from 'node:fs';
import { posix, win32 } from 'node:path';

/**
 * GIT-RUN-HARDEN-108: the full path of a program the app runs by name.
 *
 * On Windows a bare name given to spawn is looked up in the child's working directory before PATH,
 * so `spawn('git', { cwd: repo })` runs a git.exe or git.com that the repo carries. A relative PATH
 * entry (".", "bin") has the same effect. So the name is looked up here, once, in the absolute
 * folders of PATH only, and the caller spawns the full path. The working directory is never searched.
 */
export interface FindExeOptions {
  platform?: NodeJS.Platform;
  /** The PATH value to search (default: the app's own). */
  path?: string;
  /** Windows: the extensions to try, in order (default: PATHEXT, else .COM;.EXE;.BAT;.CMD). */
  exts?: readonly string[];
  /** Whether `file` is a program that can be run (tests swap this). */
  isProgram?: (file: string) => boolean;
}

const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

function isProgramFile(file: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (platform !== 'win32') accessSync(file, constants.X_OK);
    return true;
  } catch { return false; }
}

/** A drive path (C:\x) or a network share (\\host\share): "C:x", "\x" and "x" all depend on where the process is. */
const isFixedFolder = (dir: string, platform: NodeJS.Platform): boolean =>
  platform === 'win32' ? /^[A-Za-z]:[\\/]/.test(dir) || /^[\\/]{2}[^\\/]/.test(dir) : dir.startsWith('/');

const envPath = (): string => process.env.PATH ?? process.env.Path ?? '';
const envExts = (): string[] => (process.env.PATHEXT || DEFAULT_PATHEXT).split(';').map((e) => e.trim()).filter((e) => e.startsWith('.'));

/** The first match for `name` in the absolute folders of PATH, or null. `name` is a bare file name. */
export function findExe(name: string, o: FindExeOptions = {}): string | null {
  if (name === '' || /[\\/:]/.test(name)) throw new Error(`resolveExe takes a bare program name, not a path: ${name}`);
  const platform = o.platform ?? process.platform;
  const win = platform === 'win32';
  const p = win ? win32 : posix;
  const isProgram = o.isProgram ?? ((file: string) => isProgramFile(file, platform));
  const exts = win ? [...(o.exts ?? envExts())] : [''];
  // A name that already ends in one of the extensions is tried as it is.
  const names = win && exts.some((e) => name.toLowerCase().endsWith(e.toLowerCase())) ? [name] : exts.map((e) => name + e);
  for (const raw of (o.path ?? envPath()).split(p.delimiter)) {
    const dir = raw.trim().replace(/^"(.*)"$/, '$1');
    if (!isFixedFolder(dir, platform)) continue;
    for (const n of names) {
      const file = p.join(dir, n);
      if (isProgram(file)) return file;
    }
  }
  return null;
}

const found = new Map<string, string>();

/**
 * The full path of `name`, looked up once per PATH value (a miss is not remembered, so a program
 * installed later is found). Throws when no absolute folder on PATH has it: nothing is run then.
 */
export function resolveExe(name: string, o: Pick<FindExeOptions, 'exts'> = {}): string {
  const path = envPath();
  const key = [name, (o.exts ?? envExts()).join(';'), path].join('\0');
  const hit = found.get(key);
  if (hit !== undefined) return hit;
  const file = findExe(name, { path, exts: o.exts });
  if (file === null) throw new Error(`${name} was not found in any absolute folder on PATH, so it was not run`);
  found.set(key, file);
  return file;
}
