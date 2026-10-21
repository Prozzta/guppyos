/**
 * RENDER COUNTER (APP-SHALLOW-SELECTOR): per-component render counts for a REAL React tree,
 * without touching the components. It installs the React DevTools global hook before react-dom
 * evaluates (import this module FIRST in a scenario), and on every commit walks the committed
 * fiber tree the way DevTools does: a function/memo component fiber carrying React's
 * PerformedWork flag rendered in that commit; a subtree whose `child` is the same object as the
 * previous commit's was not visited by React at all and is skipped (its stale flags are not
 * re-counted). Counts are keyed by component name.
 */
type Fiber = { tag: number; flags: number; type: unknown; child: Fiber | null; sibling: Fiber | null; alternate: Fiber | null };
const PerformedWork = 1; // react-dom 18: ReactFiberFlags
const COMPONENT_TAGS = new Set([0, 1, 2, 11, 14, 15]); // Function, Class, Indeterminate, ForwardRef, Memo, SimpleMemo

const counts: Record<string, number> = {};
function nameOf(type: unknown): string {
  const t = type as { displayName?: string; name?: string; type?: unknown; render?: unknown } | null;
  if (!t) return '(anon)';
  if (typeof t === 'function') return (t as { displayName?: string; name?: string }).displayName || t.name || '(anon)';
  if (t.type) return nameOf(t.type);
  if (t.render) return nameOf(t.render);
  return t.displayName || '(anon)';
}
function walk(next: Fiber, prev: Fiber | null): void {
  if (COMPONENT_TAGS.has(next.tag) && (next.flags & PerformedWork) !== 0) {
    const n = nameOf(next.type);
    counts[n] = (counts[n] ?? 0) + 1;
  }
  if (prev && next.child === prev.child) return; // untouched subtree
  for (let c = next.child; c; c = c.sibling) walk(c, c.alternate);
}

(globalThis as unknown as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
  isDisabled: false,
  supportsFiber: true,
  renderers: new Map(),
  inject: () => 1,
  onCommitFiberRoot: (_id: number, root: { current: Fiber }) => { walk(root.current, root.current.alternate); },
  onCommitFiberUnmount: () => {},
  onPostCommitFiberRoot: () => {},
  checkDCE: () => {}
};

/** Snapshot of the counts since the last reset (a plain copy). */
export function renderCounts(): Record<string, number> { return { ...counts }; }
export function resetRenderCounts(): void { for (const k of Object.keys(counts)) delete counts[k]; }
