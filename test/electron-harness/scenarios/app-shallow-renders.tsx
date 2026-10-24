/**
 * SCENARIO - APP-SHALLOW-SELECTOR (ACTIVITY-LAG-151 fix 4). HOW MANY RENDERS DOES A TICK ON
 * ANOTHER AGENT COST THE APP?
 *
 * Before: App subscribed to the whole `agents` array, so every REAL change to any agent
 * (status, action, progress, contextTokens: what hooks and the pty parser write all day)
 * re-rendered App and, through it, every child that was not memoised (the Pixi floor's
 * component, the capacity strip, the memory panel, ...). After: App reads primitives (count,
 * roster/pty key) and the heavy children are memo'd, so a tick on an agent you are not looking
 * at renders App zero times.
 *
 * Mounts the REAL App (production store, components, hooks) and counts renders per component
 * with the DevTools-style fiber walk in ./render-counter (imported first, before react-dom):
 *   A. N real patches on a NON-selected agent  -> App renders, floor renders, strip renders.
 *   B. N real patches on the SELECTED agent    -> App renders N (positive control: the counter
 *      is live and `selectedAgent` still delivers the fresh object), floor still 0 (memo).
 *   C. one agent added                          -> App renders (the count selector is live).
 *   U. the selectors themselves, against the real store: equal across a status/action/progress/
 *      runningTools/contextTokens patch, different on add/remove/reorder/ptyId/id change.
 */
import { renderCounts, resetRenderCounts } from './render-counter';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { App } from '../../../src/renderer/src/App';
import { useStore, selectAgentCount, selectRosterPtyKey, type Agent } from '../../../src/renderer/src/store/store';

declare global {
  interface Window {
    __harnessRun: () => Promise<void>;
    harness: { report: (payload: unknown) => void };
  }
}

(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-harness';
const config = { onboardingComplete: true, harnessHome: 'C:/harness-test-home', recentHomes: [] };
(window as unknown as { cth: unknown }).cth = new Proxy({}, {
  get: (_t, name: string) => {
    if (name === 'recovering') return true; // straight to the live floor, no HivePicker
    if (name === 'platform') return 'win32';
    if (name === 'arch') return 'x64';
    if (name === 'getConfig') return () => Promise.resolve({ ...config });
    if (name === 'takeRecoveryNotice') return () => Promise.resolve(null);
    if (name === 'listPtys') return () => Promise.resolve([]);
    if (name.startsWith('on')) return () => () => {};
    if (name.endsWith('Sync')) return () => null;
    return () => Promise.resolve(undefined);
  }
});

const N = 50;
const settle = (ms = 300) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const mk = (id: string, extra: Partial<Agent> = {}): Agent => ({
  id, name: id.toUpperCase(), character: 'michael', accent: 'blue', description: '', project: 'p', tmuxTarget: '', cwd: 'C:/x',
  status: 'idle', action: 'idle', progress: 0, ...extra
} as unknown as Agent);

/** N real, distinct patches on one agent, each its own store write (what a hook tick does). */
async function tick(id: string): Promise<void> {
  for (let i = 0; i < N; i++) {
    await act(async () => {
      useStore.getState().updateAgent(id, { status: i % 2 ? 'working' : 'idle', action: `tick ${i}`, progress: i, contextTokens: 1000 + i });
    });
  }
  await settle(150);
}
/** esbuild renames a `memo(function X` inner function to `X2` when the export is also `X`, so a
 *  component's renders are the sum over `X` and `X<digits>`. */
const of = (c: Record<string, number>, name: string) =>
  Object.entries(c).filter(([k]) => new RegExp(`^${name}\\d*$`).test(k)).reduce((a, [, v]) => a + v, 0);
const NAMES = ['App', 'OfficeFloor', 'CapacityStrip', 'MemoryPanel', 'CapacityDetailPanel', 'CapacityLimitBanner', 'TaskDetailOverlay', 'UpdateBadge', 'AgentStrip', 'AgentDetailPanel'];
const pick = (c: Record<string, number>) => ({
  ...Object.fromEntries(NAMES.map((n) => [n, of(c, n)])),
  total: Object.values(c).reduce((a, b) => a + b, 0)
});

function selectorPins() {
  const s = (agents: Agent[]) => ({ ...useStore.getState(), agents });
  const base = [mk('god', { isGod: true, ptyId: 'p0' }), mk('a1', { ptyId: 'p1' }), mk('a2')];
  const k0 = selectRosterPtyKey(s(base));
  const patched = base.map((a) => a.id === 'a2' ? { ...a, status: 'working', action: 'x', progress: 9, runningTools: [], contextTokens: 5 } as Agent : a);
  return {
    countSame: selectAgentCount(s(base)) === selectAgentCount(s(patched)),
    keySameOnTick: k0 === selectRosterPtyKey(s(patched)),
    keyOnAdd: k0 !== selectRosterPtyKey(s([...base, mk('a3')])),
    keyOnRemove: k0 !== selectRosterPtyKey(s(base.slice(0, 2))),
    keyOnReorder: k0 !== selectRosterPtyKey(s([base[1], base[0], base[2]])),
    keyOnPty: k0 !== selectRosterPtyKey(s(base.map((a) => a.id === 'a2' ? { ...a, ptyId: 'p2' } : a))),
    keyOnIdSwap: k0 !== selectRosterPtyKey(s(base.map((a) => a.id === 'a2' ? { ...a, id: 'zz' } : a))),
    countOnAdd: selectAgentCount(s([...base, mk('a3')])) === 4
  };
}

window.__harnessRun = async () => {
  try {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => { root.render(<App />); });
    await settle(600);
    // Seed the roster after the hive hooks settled so nothing replaces it; no ptyIds, so no
    // terminal pre-warm is attempted against the stub bridge.
    await act(async () => { useStore.setState({ agents: [mk('god', { isGod: true }), mk('a1'), mk('a2')], selectedId: 'a1' } as never); });
    await settle(600);
    const floorMounted = !!host.querySelector('canvas');

    // INT 1.1.102 (cap-199's perf-151-nits settle): under the CPU cap a late startup render landed
    // in phase A (App 1 for 50 ticks, every App child once). Wait for the census to go quiet first.
    for (let i = 0; ; i += 1) {
      resetRenderCounts();
      await settle(50);
      if (Object.keys(renderCounts()).length === 0) break;
      if (i === 19) throw new Error(`render census never settled: ${JSON.stringify(renderCounts())}`);
    }
    resetRenderCounts();
    await tick('a2');
    const a = renderCounts();
    resetRenderCounts();
    await tick('a1');
    const b = renderCounts();
    resetRenderCounts();
    await act(async () => { useStore.setState({ agents: [...useStore.getState().agents, mk('a3')] } as never); });
    await settle(150);
    const c = renderCounts();

    await act(async () => { root.unmount(); });
    host.remove();
    window.harness.report({ ok: true, N, floorMounted, phaseA: pick(a), phaseB: pick(b), phaseC: pick(c), rawA: a, rawB: b, pins: selectorPins() });
  } catch (e) {
    window.harness.report({ ok: false, error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
  }
};
