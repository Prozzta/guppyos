import { captureFromLoginShellAsync, isSafeCommandName } from './commandResolver';

// The user's interactive-shell PATH, so headless children (hidden claude) and agent PTYs see
// the same PATH the user's terminal does — Electron on macOS starts without the login-shell
// PATH, so a bare `claude` would otherwise fail with ENOENT in a packaged build.
//
// SYNC-CHILD-CALLS: command resolution moved to commandResolver.ts (resolveCommandAsync), and
// the login-shell capture is async there. Nothing in this module runs a synchronous child.

export { isSafeCommandName };

let cachedPath: Promise<string> | null = null;

/** The user's interactive-shell PATH, queried once (async) and cached for the session (as before, the
 *  process-PATH fallback is cached too). Windows
 *  has no interactive login-shell PATH problem — the process PATH is used directly, no child. */
export function userShellPathAsync(): Promise<string> {
  if (process.platform === 'win32') return Promise.resolve(process.env.PATH || '');
  if (cachedPath) return cachedPath;
  const p = captureFromLoginShellAsync('printf %s "$PATH"').then((raw) => {
    const shellPath = raw?.trim();
    // A PATH is a single colon-joined line. Anything multi-line is rc-file noise that slipped
    // the fence — fall back rather than hand the agent a corrupt PATH.
    const ok = !!shellPath && !shellPath.includes('\n');
    return ok ? shellPath : process.env.PATH || '';
  });
  cachedPath = p;
  return p;
}
