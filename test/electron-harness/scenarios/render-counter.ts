/**
 * RENDER COUNTER (APP-SHALLOW-SELECTOR): per-component render counts for a REAL React tree,
 * without touching the components. It installs the React DevTools global hook before react-dom
 * evaluates (import this module FIRST in a scenario), and on every commit walks the committed
 * fiber tree the way DevTools does: a function/memo component fiber carrying React's
 * PerformedWork flag rendered in that commit; a subtree whose `child` is the same object as the
 * previous commit's was not visited by React at all and is skipped (its stale flags are not
 * re-counted). Counts are keyed by component name.
 */
type Hook = { memoizedState: unknown; next: Hook | null };
type Fiber = { tag: number; flags: number; type: unknown; child: Fiber | null; sibling: Fiber | null; alternate: Fiber | null; memoizedProps?: Record<string, unknown> | null; memoizedState?: Hook | null };
const PerformedWork = 1; // react-dom 18: ReactFiberFlags
const COMPONENT_TAGS = new Set([0, 1, 2, 11, 14, 15]); // Function, Class, Indeterminate, ForwardRef, Memo, SimpleMemo

const counts: Record<string, number> = {};

/**
 * WHY a component rendered (APP-SHALLOW-LATE-RENDER-107), for the renders counted while a trace is
 * on: the props whose value changed and the hooks whose state changed against the fiber before
 * this commit, each hook by its index in the component's call order with the value before and
 * after. `mount` is a first render. An effect hook's record is rebuilt on every render and says
 * nothing, so it is left out; a parent's render shows as no prop and no hook changed.
 */
export type RenderCause = { name: string; ms: number; mount: boolean; props: string[]; hooks: string[] };
const causes: RenderCause[] = [];
let tracing = false;
const brief = (v: unknown): string => {
  let t: string;
  try { t = typeof v === 'function' ? 'fn' : JSON.stringify(v) ?? String(v); } catch { t = Object.prototype.toString.call(v); }
  return t.length > 80 ? `${t.slice(0, 77)}...` : t;
};
const isEffect = (v: unknown): boolean => !!v && typeof v === 'object' && 'create' in (v as object) && 'tag' in (v as object);
function causeOf(next: Fiber, name: string): RenderCause {
  const prev = next.alternate;
  const cause: RenderCause = { name, ms: Math.round(performance.now()), mount: !prev, props: [], hooks: [] };
  if (!prev) return cause;
  const a = prev.memoizedProps ?? {};
  const b = next.memoizedProps ?? {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (!Object.is(a[k], b[k])) cause.props.push(k);
  // Class components keep a plain state object here, not a hook list: only tags with hooks.
  if (next.tag === 1) return cause;
  let i = 0;
  for (let h = next.memoizedState ?? null, p = prev.memoizedState ?? null; h && p; h = h.next, p = p.next, i += 1) {
    if (Object.is(h.memoizedState, p.memoizedState) || isEffect(h.memoizedState)) continue;
    cause.hooks.push(`#${i}: ${brief(p.memoizedState)} -> ${brief(h.memoizedState)}`);
  }
  return cause;
}
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
    if (tracing) causes.push(causeOf(next, n));
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
/** Starts (and empties) or stops the trace of render causes. */
export function traceRenders(on: boolean): void { tracing = on; if (on) causes.length = 0; }
export function renderCauses(): RenderCause[] { return causes.map((c) => ({ ...c })); }
