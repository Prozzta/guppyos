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
 *
 * TERM-FONT-PICKER-DPR15-RACE: nothing here measures a face after a fixed delay, the starting
 * face included. A pick lands
 * when the face's load ends (terminalPool waits on loadTerminalFont), and how long that takes
 * is the machine's business: under a full suite the first load of a face took longer than the
 * 700 ms this scenario used to wait, so it measured the old face. pick() now waits on that
 * same load, then on the state it is about to measure. The first pick also HOLDS the load
 * (document.fonts.load is gated here; so does the start, for the starting face) for HELD_MS, longer than any delay the scenario ever
 * guessed, and reports what the terminals showed meanwhile: the old face and the old cell.
 */
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import fontsCss from '../../../src/renderer/src/design/fonts.css?raw';
import anyFontUrl from '../../../src/renderer/src/assets/fonts/jetbrains-mono/JetBrainsMono-Regular.woff2?url';
import { PtyTerminalView } from '../../../src/renderer/src/components/PtyTerminalView';
import { TerminalSetting } from '../../../src/renderer/src/components/TerminalSetting';
import { acquireTerminal } from '../../../src/renderer/src/components/terminalPool';
import { getTerminalFontSize, setTerminalFontSize } from '../../../src/renderer/src/components/terminalFontSize';
import {
  getTerminalFontFace, loadTerminalFont, terminalFontFamily, terminalFontReady, TERMINAL_FONT_FACES, type TerminalFontFace
} from '../../../src/renderer/src/components/terminalFont';

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
/** How long the first pick's font load is held shut: well past the 700 ms the scenario once waited. */
const HELD_MS = 1500;
// The gate on document.fonts.load: while gate.face is set, a load of that face does not even
// start until gate.open() is called, so the face cannot become usable behind the scenario's back.
const gate: { face: string | null; opened: Promise<void>; open: () => void } = { face: null, opened: Promise.resolve(), open: () => {} };
const realFontLoad = document.fonts.load.bind(document.fonts);
document.fonts.load = ((font: string, text?: string) => (
  gate.face && font.includes(`"${gate.face}"`) ? gate.opened.then(() => realFontLoad(font, text)) : realFontLoad(font, text)
)) as typeof document.fonts.load;
// The starting face's load is held shut from the start: the scenario lets it through itself, so
// its first measurement cannot depend on how long that load takes either.
gate.face = getTerminalFontFace();
gate.opened = new Promise<void>((r) => { gate.open = r; });
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
    const entry = acquireTerminal('pty-a');
    const pooled = acquireTerminal('pty-pooled'); // in the pool, never attached to a view
    // The first measurement is the same case as a pick: a terminal opened before the starting
    // face had loaded is measured again when that load ends (terminalPool, TERM-FONT-105), and
    // the section shows the stored font once it has read the config. Wait on those, not on a delay:
    // the load is held shut for HELD_MS first, then let through and waited on.
    await wait(HELD_MS);
    const startHeld = { face: initialFace, ready: terminalFontReady(initialFace) };
    gate.face = null;
    gate.open();
    await act(async () => { await loadTerminalFont(initialFace); });
    const started = () => terminalFontReady(initialFace) && entry.term.options.fontFamily === terminalFontFamily(initialFace)
      && pooled.term.options.fontFamily === terminalFontFamily(initialFace)
      && (settingsWrap.querySelector('select') as HTMLSelectElement | null)?.value === initialFace;
    for (let i = 0; i < 200 && !started(); i++) await wait(25);
    if (!started()) throw new Error(`the scenario did not start on ${initialFace}`);
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
    const change = (face: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, face);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const alertShown = () => !!settingsWrap.querySelector('[role="alert"]');
    /** The pick is over: `shown` is the face in use, loaded, and on both terminals (and the
     *  failed-save alert is up when one is expected). */
    const settled = (shown: TerminalFontFace, alert: boolean) => getTerminalFontFace() === shown && terminalFontReady(shown)
      && entry.term.options.fontFamily === terminalFontFamily(shown) && pooled.term.options.fontFamily === terminalFontFamily(shown)
      && (!alert || alertShown());
    /** Wait for a pick to land: first on the loads the pool itself waits on (however long they
     *  take), then on the settled state, which follows them within a few promise turns. */
    const landed = async (picked: TerminalFontFace, shown: TerminalFontFace = picked, alert = false) => {
      await act(async () => { await loadTerminalFont(picked); await loadTerminalFont(shown); });
      for (let i = 0; i < 200 && !settled(shown, alert); i++) await wait(25);
      if (!settled(shown, alert)) throw new Error(`the pick of ${picked} did not settle on ${shown}`);
    };
    const pick = async (face: TerminalFontFace, shown: TerminalFontFace = face, alert = false) => {
      await change(face);
      await landed(face, shown, alert);
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
    const cellNow = () => (entry.term as unknown as XtermCore)._core._renderService.dimensions.device.cell.width;
    const cellBeforePick = cellNow();
    let held: unknown = null;
    for (const face of TERMINAL_FONT_FACES.filter((f) => f !== initialFace)) {
      if (!held) {
        // The first pick, with its font load held shut: the pick is taken and saved, and every
        // terminal stays on the old face and cell until the load is let through.
        gate.face = face;
        gate.opened = new Promise<void>((r) => { gate.open = r; });
        const t0 = performance.now();
        await change(face);
        await wait(HELD_MS);
        held = {
          picked: face, face: getTerminalFontFace(), selectValue: select.value, stored: cfg.terminalFont ?? null,
          ready: terminalFontReady(), family: entry.term.options.fontFamily, pooledFamily: pooled.term.options.fontFamily,
          cellBefore: cellBeforePick, cell: cellNow(), heldMs: performance.now() - t0
        };
        gate.face = null;
        gate.open();
        await landed(face);
      } else await pick(face);
      rows.push(await measure(`picked ${face} at 16px, no size change`));
      await sweep(`picked ${face}`);
    }
    await pick(initialFace);
    rows.push(await measure('picked back at 16px, no size change'));
    await sweep(`picked ${initialFace}`);
    const savesAfterPicks = saves.map((s) => ({ ...s }));

    // A save that fails: the list and the terminals go back to what is stored.
    failSave = true;
    await pick('Martian Mono', initialFace, true);
    const failed = {
      face: getTerminalFontFace(), selectValue: select.value, family: entry.term.options.fontFamily,
      alert: settingsWrap.querySelector('[role="alert"]')?.textContent ?? null,
      saves: saves.length - savesAfterPicks.length, stored: cfg.terminalFont ?? null
    };

    // The colours toggle, same failing save: it goes back to what is stored.
    await act(async () => { coloring().click(); });
    await wait(100);
    const failedToggle = {
      label: coloring().textContent, saves: saves.length - savesAfterPicks.length,
      stored: cfg.terminalPatternColoring ?? null
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
    // The section reads the config, then the pool waits on the face's load: wait on those, not on a delay.
    const reshown = () => (settingsWrap.querySelector('select') as HTMLSelectElement | null)?.value === 'Cascadia Mono';
    for (let i = 0; i < 200 && !reshown(); i++) await wait(25);
    if (!reshown()) throw new Error('the re-opened section did not show the stored font');
    await landed('Cascadia Mono');
    select = settingsWrap.querySelector('select') as HTMLSelectElement;
    const reopened = {
      selectValue: select.value, face: getTerminalFontFace(), family: entry.term.options.fontFamily,
      pooledFamily: pooled.term.options.fontFamily, coloringLabel: coloring().textContent,
      saves: saves.length - savesAfterPicks.length
    };

    window.harness.report({
      ok: true, dpr: window.devicePixelRatio, faces: [...TERMINAL_FONT_FACES], initialFace, selector, rows,
      saves: savesAfterPicks, failed, failedToggle, toggled, reopened, held, startHeld
    });
  } catch (e) {
    window.harness.report({ ok: false, error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
  }
};
