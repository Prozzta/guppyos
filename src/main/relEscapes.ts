import path, { type PlatformPath } from 'node:path';

/**
 * DOTDOT-PREFIX-FALSE-REFUSAL: whether a path.relative() result leaves its base folder. Compares
 * segments, not a string prefix: '..' or '..' + sep is a real parent step, but a name that merely
 * starts with two dots ('..notes', '..d') stays inside. An absolute result (another drive or UNC
 * share on win32) also leaves. `P` is the path flavour the relative path was made with.
 */
export function relEscapes(rel: string, P: PlatformPath = path): boolean {
  return rel === '..' || rel.startsWith(`..${P.sep}`) || P.isAbsolute(rel);
}
