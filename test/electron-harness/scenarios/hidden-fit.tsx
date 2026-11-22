/**
 * SCENARIO - MEMSPIKE-168: a PtyTerminalView mounted inside a display:none wrapper (an inactive
 * tab) must not resize its pty to a phantom grid, neither on mount nor on a font-size change.
 * Once revealed, the ResizeObserver fits it to the real host and resizes the pty exactly then.
 *
 * The after-show half WAITS FOR THE EVENT it asserts (a resizePty call after the afterFontChange
 * mark) and has no clock of its own: the harness's timeoutMs is its only bound. It used to read the
 * list a fixed 900 ms after display:block, and the resize reaches the pty through a ResizeObserver
 * callback (which needs a rendering frame from this never-shown window) and then a 150 ms settle
 * timer (ptyResizeCoalescer.ts), so a loaded machine read an empty list (FLAKE-HIDDEN-FIT-168).
 * The report carries the time from display:block to the first observer callback that saw a size
 * and to the send, so a slow run names the late link.
 */
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { PtyTerminalView } from '../../../src/renderer/src/components/PtyTerminalView';
import { setTerminalFontSize } from '../../../src/renderer/src/components/terminalFontSize';

declare global {
  interface Window {
    __harnessRun: () => Promise<void>;
    harness: { report: (payload: unknown) => void; progress: (payload: unknown) => void };
  }
}

// Every ResizeObserver callback in the page, timed. Installed before the view mounts, so the
// view's own observer is one of them; the product code is untouched.
const observerCalls: Array<{ at: number; width: number; height: number }> = [];
const NativeResizeObserver = window.ResizeObserver;
window.ResizeObserver = class extends NativeResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    super((entries, observer) => {
      const rect = entries[entries.length - 1]?.contentRect;
      observerCalls.push({ at: performance.now(), width: rect?.width ?? 0, height: rect?.height ?? 0 });
      callback(entries, observer);
    });
  }
};

const sentAt: number[] = [];
const resizes: Array<{ id: string; cols: number; rows: number }> = [];
(window as unknown as { cth: unknown }).cth = new Proxy({}, {
  get: (_t, name: string) => {
    if (name === 'platform') return 'win32';
    if (name === 'recovering') return false;
    if (name === 'resizePty') return (id: string, cols: number, rows: number) => { sentAt.push(performance.now()); resizes.push({ id, cols, rows }); return Promise.resolve({ ok: true }); };
    if (name === 'onPtyData' || name === 'onPtyExit' || name.startsWith('on')) return () => () => {};
    if (name.endsWith('Sync')) return () => null;
    return () => Promise.resolve({ ok: true });
  }
});

const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

window.__harnessRun = async () => {
  try {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:none;width:600px;height:400px';
    document.body.appendChild(wrap);
    const root = createRoot(wrap);
    await act(async () => { root.render(<div style={{ width: '100%', height: '100%', display: 'flex' }}><PtyTerminalView ptyId="pty-hidden" embedded /></div>); });
    await wait(600);
    const afterMount = resizes.length;
    await act(async () => { setTerminalFontSize(15); });
    await wait(600);
    const afterFontChange = resizes.length;
    const shownAt = performance.now();
    wrap.style.display = 'block';
    const sinceShow = (at: number | undefined) => (at === undefined ? null : Math.round(at - shownAt));
    const firstSized = () => observerCalls.find((c) => c.at >= shownAt && c.width > 0 && c.height > 0)?.at;
    // No clock here: the scenario ends on the resize or on the harness's own timeout, whose error
    // then carries the last step below.
    for (let turn = 0; resizes.length === afterFontChange; turn++) {
      if (turn % 40 === 0) {
        window.harness.progress({
          phase: 'scenario',
          step: `waiting for the after-show resizePty: ${sinceShow(performance.now())} ms since display:block, observer callback with a size at ${sinceShow(firstSized())} ms`
        });
      }
      await wait(25);
    }
    const shown = resizes.slice(afterFontChange);
    window.harness.report({
      ok: true, afterMount, afterFontChange, shown,
      showToObserverMs: sinceShow(firstSized()),
      showToSendMs: sinceShow(sentAt[afterFontChange])
    });
  } catch (e) {
    window.harness.report({ ok: false, error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
  }
};
