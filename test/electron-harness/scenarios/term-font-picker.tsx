/**
 * SCENARIO - TERM-FONT-JETBRAINS: the terminal font selector, on a REAL xterm with the REAL
 * bundled faces. Mounts a PtyTerminalView (plus one pooled terminal that is never attached),
 * then drives the header's <select> and the zoom store and reports, for each face and size,
 * what xterm measured (device cell width) beside what the face needs (advance and ink).
 *
 * design/fonts.css is loaded as text and its `../assets/` urls are pointed at the source
 * tree: the harness injects CSS as a <style> tag, so the urls would otherwise resolve
 * against page.html and no face would load.
 */
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import fontsCss from '../../../src/renderer/src/design/fonts.css?raw';
import anyFontUrl from '../../../src/renderer/src/assets/fonts/jetbrains-mono/JetBrainsMono-Regular.woff2?url';
import { PtyTerminalView } from '../../../src/renderer/src/components/PtyTerminalView';
import { acquireTerminal } from '../../../src/renderer/src/components/terminalPool';
import { getTerminalFontSize, setTerminalFontSize } from '../../../src/renderer/src/components/terminalFontSize';
import { getTerminalFontFace, terminalFontReady, TERMINAL_FONT_FACES } from '../../../src/renderer/src/components/terminalFont';

declare global {
  interface Window {
    __harnessRun: () => Promise<void>;
    harness: { report: (payload: unknown) => void };
  }
}

const resizes: Array<{ id: string; cols: number; rows: number }> = [];
(window as unknown as { cth: unknown }).cth = new Proxy({}, {
  get: (_t, name: string) => {
    if (name === 'platform') return 'win32';
    if (name === 'recovering') return false;
    if (name === 'resizePty') return (id: string, cols: number, rows: number) => { resizes.push({ id, cols, rows }); return Promise.resolve({ ok: true }); };
    if (name === 'onPtyData' || name === 'onPtyExit' || name.startsWith('on')) return () => () => {};
    if (name.endsWith('Sync')) return () => null;
    return () => Promise.resolve({ ok: true });
  }
});

const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const INK_CHARS = ['W', 'M', 'm', '@', '#', '%', '&', 'w', 'Q'];

type XtermCore = { _core: { _renderService: { dimensions: { device: { cell: { width: number; height: number } }; css: { cell: { width: number } } } } } };

window.__harnessRun = async () => {
  try {
    const assets = anyFontUrl.replace(/fonts\/jetbrains-mono\/.*$/, '');
    const style = document.createElement('style');
    style.textContent = fontsCss.replace(/url\('\.\.\/assets\//g, `url('${assets}`);
    document.head.appendChild(style);

    const initialFace = getTerminalFontFace();
    const initialStored = window.localStorage.getItem('cth.ptyFontFace');
    const wrap = document.createElement('div');
    wrap.style.cssText = 'width:900px;height:500px';
    document.body.appendChild(wrap);
    const root = createRoot(wrap);
    await act(async () => { root.render(<div style={{ width: '100%', height: '100%', display: 'flex' }}><PtyTerminalView ptyId="pty-a" embedded /></div>); });
    await wait(900);
    const entry = acquireTerminal('pty-a');
    const pooled = acquireTerminal('pty-pooled'); // in the pool, never attached to a view
    entry.term.write('WWWWMMMMmmmm@@@@####iiii\r\n');

    const select = wrap.querySelector('select') as HTMLSelectElement;
    const header = select.parentElement as HTMLElement;
    const zoomOut = [...header.querySelectorAll('button')].find((b) => b.title.startsWith('Zoom out')) as HTMLButtonElement;
    const selector = {
      options: [...select.options].map((o) => o.value),
      beforeZoomButtons: !!(select.compareDocumentPosition(zoomOut) & Node.DOCUMENT_POSITION_FOLLOWING),
      sameRow: Math.abs(select.getBoundingClientRect().top - zoomOut.getBoundingClientRect().top) <= 2
        && select.getBoundingClientRect().height === zoomOut.getBoundingClientRect().height,
      gapPx: zoomOut.getBoundingClientRect().left - select.getBoundingClientRect().right
    };
    const pick = async (face: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, face);
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      await wait(700);
    };

    const ctx = document.createElement('canvas').getContext('2d')!;
    // The pty hears a new grid through a settle timer (ptyResizeCoalescer), so wait for the
    // grid it was last told to be the grid xterm has, instead of guessing a delay.
    const ptyGrid = () => [...resizes].reverse().find((r) => r.id === 'pty-a');
    const measure = async (step: string) => {
      for (let i = 0; i < 100 && ptyGrid()?.cols !== entry.term.cols; i++) await wait(50);
      const face = getTerminalFontFace();
      const size = getTerminalFontSize();
      const dims = (entry.term as unknown as XtermCore)._core._renderService.dimensions;
      ctx.font = `${size}px "${face}"`;
      const advance = ctx.measureText('W').width;
      let inkLeft = 0;
      let inkRight = 0;
      for (const ch of INK_CHARS) {
        const m = ctx.measureText(ch);
        inkLeft = Math.max(inkLeft, m.actualBoundingBoxLeft);
        inkRight = Math.max(inkRight, m.actualBoundingBoxRight);
      }
      return {
        step, face, size,
        ready: terminalFontReady(),
        selectValue: select.value,
        stored: window.localStorage.getItem('cth.ptyFontFace'),
        family: entry.term.options.fontFamily,
        pooledFamily: pooled.term.options.fontFamily,
        letterSpacing: entry.term.options.letterSpacing,
        pooledLetterSpacing: pooled.term.options.letterSpacing,
        cell: dims.device.cell.width,
        cssCell: dims.css.cell.width,
        advance, inkLeft, inkRight,
        cols: entry.term.cols,
        ptyCols: ptyGrid()?.cols ?? null
      };
    };

    const rows: unknown[] = [];
    const sweep = async (step: string) => {
      for (const size of [10, 12, 14, 16]) {
        await act(async () => { setTerminalFontSize(size); });
        await wait(300);
        rows.push(await measure(step));
      }
    };
    await sweep('default');
    await pick('Martian Mono');
    rows.push(await measure('picked at 16px, no size change'));
    await sweep('picked Martian Mono');
    await pick('JetBrains Mono');
    rows.push(await measure('picked back at 16px, no size change'));
    await sweep('picked JetBrains Mono');

    window.harness.report({
      ok: true, dpr: window.devicePixelRatio, faces: [...TERMINAL_FONT_FACES], initialFace, initialStored, selector, rows
    });
  } catch (e) {
    window.harness.report({ ok: false, error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
  }
};
