/**
 * SECRETS-ATOMIC-SAVE-108: the file behind the integrations secret store, read and written so a
 * crash or a full disk in the middle of a save cannot cost the secrets already stored.
 *
 * Before this the store was one plain writeFileSync over the live file, and a file that did not
 * parse read as "no secrets": a save cut short left a torn file, and the next save after that wrote
 * a blob holding only the one new secret. Every other token was gone.
 *
 * Save:  the text goes to a sibling temp file (created 0600, never the live file), is flushed to
 *        disk (fsync), read back and compared, and only then renamed over the live file (the same
 *        rename the hive's authorities use). A reader sees the old file or the new one. After the
 *        live file is published the same text is published, the same way, as `<file>.good`.
 * Read:  the live file. If it is there but is not a secrets blob, the `.good` copy is used and one
 *        line says so (no secret text is ever logged). A missing live file is an empty store, with
 *        or without a `.good` copy: removing the file is how the store is emptied.
 * A file that could not be READ (EBUSY, EPERM, EACCES: a lock, not damage) is not a damaged file.
 *        A read still answers from `.good`, but a save refuses and leaves the file as it was: what
 *        is in it is not known, so it must not be replaced. A save also refuses when a damaged file
 *        cannot first be copied to `<file>.corrupt`. That copy is one file: a later one replaces it.
 * Not pinned: the folder flush after the rename (non-Windows only; this suite's box is Windows).
 *
 * Electron-free, so it is tested in plain Node (test/secrets-atomic-save.test.cjs).
 */
import { closeSync, copyFileSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { renameWithRetry } from './atomicJson';

export type SecretBlob = Record<string, string>;
type Warn = (line: string) => void;

/** The last-known-good copy of the secrets file `p`. */
export const goodPathFor = (p: string): string => `${p}.good`;
/** Where an unreadable secrets file is kept when a save is about to replace it. */
export const corruptPathFor = (p: string): string => `${p}.corrupt`;

/** The blob in `text`, or null when it is not one (not JSON, not a plain object, a non-string value). */
function parseBlob(text: string): SecretBlob | null {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  for (const v of Object.values(parsed)) if (typeof v !== 'string') return null;
  return parsed as SecretBlob;
}

type Read = { state: 'missing' } | { state: 'unreadable'; why: string } | { state: 'corrupt'; why: string } | { state: 'ok'; blob: SecretBlob };

function readOne(p: string): Read {
  let text: string;
  try { text = readFileSync(p, 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'missing' };
    return { state: 'unreadable', why: (e as NodeJS.ErrnoException).code ?? 'read failed' };
  }
  const blob = parseBlob(text);
  return blob ? { state: 'ok', blob } : { state: 'corrupt', why: 'not a secrets blob' };
}

/**
 * The stored blob. An unreadable live file is answered from the `.good` copy; with no usable copy
 * the answer is an empty blob. Either way `warn` gets one line naming the file (never its contents).
 */
export function readSecretFile(p: string, warn: Warn = console.error): SecretBlob {
  const main = readOne(p);
  if (main.state === 'ok') return main.blob;
  if (main.state === 'missing') return {};
  const good = readOne(goodPathFor(p));
  if (good.state === 'ok') {
    warn(`[integrations] ${basename(p)} is unreadable (${main.why}); using the last good copy ${basename(goodPathFor(p))}`);
    return good.blob;
  }
  warn(`[integrations] ${basename(p)} is unreadable (${main.why}) and there is no usable ${basename(goodPathFor(p))}: the stored secrets cannot be read`);
  return {};
}

/** Write `text` to a new 0600 temp file beside `p`, flush it, read it back, then rename it over `p`. */
function publish(p: string, text: string): void {
  const tmp = `${p}.tmp-${randomBytes(3).toString('hex')}`;
  try {
    const fd = openSync(tmp, 'wx', 0o600);
    try { writeFileSync(fd, text, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
    if (readFileSync(tmp, 'utf8') !== text) throw new Error(`read-back of ${basename(tmp)} is not what was written`);
    renameWithRetry(tmp, p);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* keep the save's own error */ }
    throw error;
  }
  if (process.platform !== 'win32') {
    // The rename is durable once its folder is flushed. Windows has no folder flush.
    try { const dir = openSync(dirname(p), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); } } catch { /* not every file system allows it */ }
  }
}

/**
 * Save `blob`. Throws, with the live file exactly as it was, if the text cannot be written, flushed,
 * read back or renamed, if the live file is there but could not be read, or if it is not a secrets
 * blob and could not be copied to `<file>.corrupt` (so its bytes are never lost to the save). If
 * only the `.good` copy cannot be written, the save stands (the
 * live file is the new one), the stale copy is removed so it can never answer a later read, and
 * `warn` gets one line.
 */
export function writeSecretFile(p: string, blob: SecretBlob, warn: Warn = console.error): void {
  mkdirSync(dirname(p), { recursive: true });
  const text = JSON.stringify(blob, null, 2);
  const live = readOne(p);
  if (live.state === 'unreadable') throw new Error(`${basename(p)} could not be read (${live.why}); not saved, so the secrets in it are not replaced`);
  if (live.state === 'corrupt') {
    try { copyFileSync(p, corruptPathFor(p)); } catch (e) {
      throw new Error(`${basename(p)} is not a secrets blob and could not be copied to ${basename(corruptPathFor(p))} (${(e as NodeJS.ErrnoException).code ?? 'copy failed'}); not saved`);
    }
  }
  publish(p, text);
  try { publish(goodPathFor(p), text); } catch (e) {
    try { rmSync(goodPathFor(p), { force: true }); } catch { /* reported below */ }
    warn(`[integrations] ${basename(p)} was saved, but its last good copy could not be written: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Empty the store: the `.good` copy goes first, so a stop in between leaves no copy that could bring the secrets back. */
export function removeSecretFile(p: string): void {
  rmSync(goodPathFor(p), { force: true });
  rmSync(p, { force: true });
}
