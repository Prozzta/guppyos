/**
 * SCENARIO - TERM-FONT-SETTINGS-107 (was TERM-FONT-JETBRAINS): the terminal font list in
 * Settings, on a REAL xterm with the REAL bundled faces. Mounts the Settings Terminal section
 * and a PtyTerminalView (plus one pooled terminal that is never attached), then drives the
 * section's <select> and the zoom store and reports, for each face and size, what xterm
 * measured (device cell width) beside what the face needs (advance and ink). window.cth is a
 * double whose config is an object here: what the section saves, and what a re-opened
 * section reads back.
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
import { TerminalSetting } from '../../../src/renderer/src/components/TerminalSetting';
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
let cfg: Record<string, unknown> = {};
const saves: Array<Record<string, unknown>> = [];
let failSave = false;
(window as unknown as { cth: unknown }).cth = new Proxy({}, {
  get: (_t, name: string) => {
    if (name === 'platform') return 'win32';
    if (name === 'recovering') return false;
    if (name === 'getConfig') return () => Promise.resolve({ ...cfg });
    if (name === 'updateConfig') return (patch: Record<string, unknown>) => {
      if (failSave) return Promise.reject(new Error('disk full'));
      saves.push({ ...patch });
      cfg = { ...cfg, ...patch };
      return Promise.resolve({ ...cfg });
    };
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
    const wrap = document.createElement('div');
    wrap.style.cssText = 'width:900px;height:500px';
    document.body.appendChild(wrap);
    const root = createRoot(wrap);
    await act(async () => { root.render(<div style={{ width: '100%', height: '100%', display: 'flex' }}><PtyTerminalView ptyId="pty-a" embedded /></div>); });
    const settingsWrap = document.createElement('div');
    settingsWrap.style.cssText = 'width:560px';
    document.body.appendChild(settingsWrap);
    let settingsRoot = createRoot(settingsWrap);
    await act(async () => { settingsRoot.render(<TerminalSetting config={{}} />); });
    await wait(900);
    const entry = acquireTerminal('pty-a');
    const pooled = acquireTerminal('pty-pooled'); // in the pool, never attached to a view
    entry.term.write('WWWWMMMMmmmm@@@@####iiii\r\n');

    let select = settingsWrap.querySelector('select') as HTMLSelectElement;
    const coloring = () => settingsWrap.querySelector('[data-terminal-coloring] button') as HTMLButtonElement;
    const selector = {
      options: [...select.options].map((o) => o.value),
      label: select.getAttribute('aria-label'),
      settingsSelects: settingsWrap.querySelectorAll('select').length,
      // The terminal view itself: no font control, the size buttons still there.
      headerSelects: wrap.querySelectorAll('select').length,
      headerZoomButtons: [...wrap.querySelectorAll('button')].filter((b) => b.title.startsWith('Zoom')).length,
      heading: (settingsWrap.querySelector('[data-terminal-setting]')?.firstElementChild as HTMLElement).textContent,
      coloringUnderFont: !!(select.compareDocumentPosition(coloring()) & Node.DOCUMENT_POSITION_FOLLOWING)
        && coloring().getBoundingClientRect().top >= select.getBoundingClientRect().bottom,
      coloringLabel: coloring().textContent
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
      const pooledDims = (pooled.term as unknown as XtermCore)._core._renderService.dimensions;
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
        stored: cfg.terminalFont ?? null,
        family: entry.term.options.fontFamily,
        pooledFamily: pooled.term.options.fontFamily,
        letterSpacing: entry.term.options.letterSpacing,
        pooledLetterSpacing: pooled.term.options.letterSpacing,
        cell: dims.device.cell.width,
        // A terminal no view shows keeps the size it was made with (a view applies the size when
        // it attaches) and has no WebGL renderer yet, so it is measured at its own size.
        pooledCell: pooledDims.device.cell.width,
        pooledSize: pooled.term.options.fontSize,
        pooledAdvance: (() => { ctx.font = `${pooled.term.options.fontSize}px "${face}"`; return ctx.measureText('W').width; })(),
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
    for (const face of TERMINAL_FONT_FACES.filter((f) => f !== initialFace)) {
      await pick(face);
      rows.push(await measure(`picked ${face} at 16px, no size change`));
      await sweep(`picked ${face}`);
    }
    await pick(initialFace);
    rows.push(await measure('picked back at 16px, no size change'));
    await sweep(`picked ${initialFace}`);
    const savesAfterPicks = saves.map((s) => ({ ...s }));

    // A save that fails: the list and the terminals go back to what is stored.
    failSave = true;
    await pick('Martian Mono');
    const failed = {
      face: getTerminalFontFace(), selectValue: select.value, family: entry.term.options.fontFamily,
      alert: settingsWrap.querySelector('[role="alert"]')?.textContent ?? null,
      saves: saves.length - savesAfterPicks.length, stored: cfg.terminalFont ?? null
    };
    failSave = false;

    // The colours toggle under the list saves its own key only.
    await act(async () => { coloring().click(); });
    await wait(100);
    const toggled = { label: coloring().textContent, save: saves[saves.length - 1], face: getTerminalFontFace() };

    // Settings closed, the config changed meanwhile (another window saved), Settings opened
    // again: the section shows what the file holds, and so do the terminals.
    await act(async () => { settingsRoot.unmount(); });
    cfg = { ...cfg, terminalFont: 'Cascadia Mono' };
    settingsRoot = createRoot(settingsWrap);
    await act(async () => { settingsRoot.render(<TerminalSetting config={{}} />); });
    await wait(900);
    select = settingsWrap.querySelector('select') as HTMLSelectElement;
    const reopened = {
      selectValue: select.value, face: getTerminalFontFace(), family: entry.term.options.fontFamily,
      pooledFamily: pooled.term.options.fontFamily, coloringLabel: coloring().textContent,
      saves: saves.length - savesAfterPicks.length
    };

    window.harness.report({
      ok: true, dpr: window.devicePixelRatio, faces: [...TERMINAL_FONT_FACES], initialFace, selector, rows,
      saves: savesAfterPicks, failed, toggled, reopened
    });
  } catch (e) {
    window.harness.report({ ok: false, error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
  }
};
