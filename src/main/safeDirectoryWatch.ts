/**
 * A non-polling directory watch which cannot survive the directory it watches.
 *
 * On Windows/libuv 1.51 (Node 22+), deleting a watched directory can leave an
 * fs.watch handle live without an error event, spinning a CPU core. Checking
 * existence only at delivery time keeps this event-driven.
 */
import { existsSync, watch, type FSWatcher } from 'node:fs';

export type DirectoryWatchListener = (event: string, filename: string | null) => void;

/** Watch `dir`, closing the native handle when it disappears or reports an error. */
export function watchDirectorySafely(dir: string, listener: DirectoryWatchListener): FSWatcher {
  let watcher: FSWatcher | null = null;
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    try { watcher?.close(); } catch { /* already closed */ }
  };
  const gone = (): boolean => {
    if (existsSync(dir)) return false;
    close();
    return true;
  };
  watcher = watch(dir, { persistent: false }, (event, filename) => {
    // A listener may synchronously archive the watched directory.
    if (gone()) return;
    listener(event, filename === null ? null : String(filename));
    gone();
  });
  watcher.on('error', close);
  return watcher;
}
