/**
 * SCENARIO - PERF-151-NITS (after APP-SHALLOW-SELECTOR). The last whole-`agents` subscribers
 * that are always mounted (AgentStrip, CapacityDetailPanel, TaskDetailOverlay) now key on
 * primitives, and the two Jim nits N2/N3 are driven for real.
 *
 * Mounts the REAL App (production store, components, hooks); renders are counted per component
 * with the DevTools-style fiber walk in ./render-counter (imported first, before react-dom).
 *   A.  N real patches on a NON-selected agent: the strip, the capacity detail and the task detail
 *       render 0 times; exactly that agent's card entry renders N times (not every card).
 *   T.  with a task detail OPEN, the same ticks still render it 0 times; renaming an agent (a name
 *       the detail may show) renders it.
 *   U.  the id/name selectors, against the real store: equal across a tick, different on
 *       add/remove/reorder (id key) and rename (name key).
 *   N2. control strip: a control call that THROWS shows a wrapped error that stays until its
 *       dismiss is clicked; a confirmation is still one line that clears itself. Composer: a
 *       Free Flow error wraps and has a dismiss.
 *   N3. at the splitter minimum (320 px) with a 2-deep queue, every control in the composer's
 *       fixed header row lies inside the row (nothing clipped on the right).
 */
import { renderCounts, resetRenderCounts } from './render-counter';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { App } from '../../../src/renderer/src/App';
import { useStore, selectAgentIdKey, selectAgentNameKey, type Agent } from '../../../src/renderer/src/store/store';
import { freeflowRecorder } from '../../../src/renderer/src/freeflow/recorder';

declare global {
  interface Window {
    __harnessRun: () => Promise<void>;
    harness: { report: (payload: unknown) => void };
  }
}

(globalThis as unknown as { __APP_VERSION__: string }).__APP_VERSION__ = '0.0.0-harness';
const config = { onboardingComplete: true, harnessHome: 'C:/harness-test-home', recentHomes: [] };
const LONG_ERROR = 'the control socket for this agent closed before the request was acknowledged (ECONNRESET after 3 retries over 12 s); the agent is still running and can be stopped from its terminal';
let haltMode: 'ok' | 'throw' = 'ok';
(window as unknown as { cth: unknown }).cth = new Proxy({}, {
  get: (_t, name: string) => {
    if (name === 'recovering') return true; // straight to the live floor, no HivePicker
    if (name === 'platform') return 'win32';
    if (name === 'arch') return 'x64';
    if (name === 'getConfig') return () => Promise.resolve({ ...config });
    if (name === 'takeRecoveryNotice') return () => Promise.resolve(null);
    if (name === 'listPtys') return () => Promise.resolve([]);
    if (name === 'controlSnapshot') return () => Promise.resolve(null);
    if (name === 'controlHalt') return () => (haltMode === 'throw' ? Promise.reject(new Error(LONG_ERROR)) : Promise.resolve(null));
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
/** esbuild renames a `memo(function X` inner function to `X2` when the export is also `X`. */
const of = (c: Record<string, number>, name: string) =>
  Object.entries(c).filter(([k]) => new RegExp(`^${name}\\d*$`).test(k)).reduce((a, [, v]) => a + v, 0);
const NAMES = ['App', 'AgentStrip', 'StripAgent', 'AgentCard', 'CapacityDetailPanel', 'TaskDetailOverlay', 'OfficeFloor', 'CapacityStrip'];
const pick = (c: Record<string, number>) => ({
  ...Object.fromEntries(NAMES.map((n) => [n, of(c, n)])),
  total: Object.values(c).reduce((a, b) => a + b, 0)
});

function selectorPins() {
  const s = (agents: Agent[]) => ({ ...useStore.getState(), agents });
  const base = [mk('god', { isGod: true }), mk('a1'), mk('a2')];
  const id0 = selectAgentIdKey(s(base));
  const nm0 = selectAgentNameKey(s(base));
  const patched = base.map((a) => a.id === 'a2' ? { ...a, status: 'working', action: 'x', progress: 9, contextTokens: 5, ptyId: 'p9' } as Agent : a);
  const renamed = base.map((a) => a.id === 'a2' ? { ...a, name: 'Zed' } as Agent : a);
  return {
    idSameOnTick: id0 === selectAgentIdKey(s(patched)),
    idSameOnRename: id0 === selectAgentIdKey(s(renamed)),
    idOnAdd: id0 !== selectAgentIdKey(s([...base, mk('a3')])),
    idOnRemove: id0 !== selectAgentIdKey(s(base.slice(0, 2))),
    idOnReorder: id0 !== selectAgentIdKey(s([base[1], base[0], base[2]])),
    nameSameOnTick: nm0 === selectAgentNameKey(s(patched)),
    nameOnRename: nm0 !== selectAgentNameKey(s(renamed)),
    nameOnAdd: nm0 !== selectAgentNameKey(s([...base, mk('a3')]))
  };
}

const q = <T extends Element>(sel: string, root: ParentNode = document): T | null => root.querySelector<T>(sel);
const rect = (el: Element) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
const click = (el: Element | null) => act(async () => { (el as HTMLElement | null)?.click(); });

window.__harnessRun = async () => {
  try {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => { root.render(<App />); });
    await settle(600);
    // Seed the roster after the hive hooks settled so nothing replaces it; no ptyIds yet, so
    // no terminal is built against the stub bridge during the render census.
    await act(async () => { useStore.setState({ agents: [mk('god', { isGod: true }), mk('a1'), mk('a2')], selectedId: 'a1' } as never); });
    await settle(600);
    const floorMounted = !!host.querySelector('canvas');

    // A. ticks on a non-selected agent.
    resetRenderCounts();
    await tick('a2');
    const a = renderCounts();

    // T. the task detail is OPEN (no such card on the stub ledger, so it renders nothing, but it
    // is subscribed): ticks still cost it 0; a rename costs it a render.
    await act(async () => { useStore.getState().openTaskDetail('T-1'); });
    await settle(200);
    resetRenderCounts();
    await tick('a2');
    const tOpenTicks = pick(renderCounts());
    resetRenderCounts();
    await act(async () => { useStore.getState().updateAgent('a2', { name: 'ZED' }); });
    await settle(150);
    const tRename = pick(renderCounts());
    await act(async () => { useStore.getState().closeTaskDetail(); });
    await settle(100);

    // N2 (control strip): a real pty makes a1 a live worker, so the sidebar shows its control
    // strip and composer.
    await act(async () => { useStore.getState().updateAgent('a1', { ptyId: 'p1' }); });
    await settle(900);
    const stopBtn = q('[aria-label="Stop this agent after the current step"]')?.closest('button') ?? null;
    haltMode = 'throw';
    await click(stopBtn);
    await settle(300);
    const err = q<HTMLElement>('[data-control-flash="error"]');
    const errShown = !!err;
    const errInfo = err ? {
      role: err.getAttribute('role'), text: err.textContent ?? '', height: rect(err).height,
      whiteSpace: getComputedStyle(err).whiteSpace, pointerEvents: getComputedStyle(err).pointerEvents,
      lineHeight: getComputedStyle(err).lineHeight, hasDismiss: !!q('[aria-label="Dismiss this error"]', err)
    } : null;
    await settle(2500);
    const errStillShownAfter2s5 = !!q('[data-control-flash="error"]');
    await click(q('[aria-label="Dismiss this error"]'));
    await settle(100);
    const errAfterDismiss = !!q('[data-control-flash="error"]');
    haltMode = 'ok';
    await click(stopBtn);
    await settle(200);
    const ok = q<HTMLElement>('[data-control-flash="ok"]');
    const okInfo = ok ? { role: ok.getAttribute('role'), whiteSpace: getComputedStyle(ok).whiteSpace, text: ok.textContent ?? '' } : null;
    await settle(2200);
    const okAfter2s = !!q('[data-control-flash="ok"]');

    // N2 (composer): a Free Flow error with no agent (the recorder's own guard) must show as a
    // wrapped, dismissable hint.
    await act(async () => { useStore.setState({ freeflowEnabled: true } as never); });
    await act(async () => { await freeflowRecorder.start(''); });
    await settle(200);
    const ffErr = q<HTMLElement>('[data-ff-hint="error"]');
    const ffInfo = ffErr ? { role: ffErr.getAttribute('role'), text: ffErr.textContent ?? '', whiteSpace: getComputedStyle(ffErr).whiteSpace, hasDismiss: !!q('[aria-label="Dismiss this voice error"]', ffErr) } : null;
    await click(q('[aria-label="Dismiss this voice error"]'));
    await settle(100);
    const ffAfterDismiss = !!q('[data-ff-hint]');

    // N3: the splitter minimum with a 2-deep queue (count chip + status + "clear all").
    await act(async () => { useStore.getState().setSidebarWidth(320); });
    await act(async () => { useStore.getState().enqueueMessage('a1', 'first queued message'); useStore.getState().enqueueMessage('a1', 'second queued message'); });
    await settle(500);
    const row = q<HTMLElement>('[data-fixed-row]');
    const rowRect = row ? rect(row) : null;
    const rowChildren = row ? Array.from(row.children).map((el) => ({ tag: el.tagName, text: (el.textContent ?? '').slice(0, 40), ...rect(el) })) : [];
    const sidebarWidth = useStore.getState().sidebarWidth;

    await act(async () => { root.unmount(); });
    host.remove();
    window.harness.report({
      ok: true, N, floorMounted,
      phaseA: pick(a), rawA: a, tOpenTicks, tRename, pins: selectorPins(),
      n2: { stopBtnFound: !!stopBtn, errShown, errInfo, errStillShownAfter2s5, errAfterDismiss, okInfo, okAfter2s, ffInfo, ffAfterDismiss },
      n3: { sidebarWidth, rowRect, rowChildren }
    });
  } catch (e) {
    window.harness.report({ ok: false, error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
  }
};
