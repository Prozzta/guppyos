/**
 * IDLE-MEANS-IDLE (1.1.87): the boot snapshot and the pushed changes of one view from main, kept
 * in order. The snapshot is asked for once at mount; a push can arrive before its reply. A push is
 * always newer, so a snapshot that lands after any push is dropped (it would show, say, a released
 * agent still running in the background until the next change), and so is one that lands after
 * unmount. Pure: the caller wires the IPC.
 */
export function applySnapshotUnlessPushed<T>(apply: (view: T) => void): {
  snapshot: (view: T) => void;
  push: (view: T) => void;
  dispose: () => void;
} {
  let alive = true;
  let pushed = false;
  return {
    snapshot: (view) => { if (alive && !pushed) apply(view); },
    push: (view) => { pushed = true; apply(view); },
    dispose: () => { alive = false; }
  };
}
