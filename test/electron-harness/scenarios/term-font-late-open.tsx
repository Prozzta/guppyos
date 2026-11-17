/**
 * SCENARIO - TERM-FONT-LATE-OPEN-COVERAGE-108: terminals opened AFTER the starting font load
 * has ended, on a REAL xterm with the REAL bundled faces.
 *
 * term-font-picker.tsx measures only terminals that exist when the app starts: they are opened
 * before the starting face has loaded, so the pool measures them again when the load ends. A
 * terminal opened later takes another path:
 *   LOADED  the face in use is already loaded when the terminal opens. Nothing measures it again,
 *           so the cell xterm measured at open() is the one it keeps: it must be the loaded
 *           face's, pad included.
 *   HELD    another face was picked and is still loading when the terminal opens (its load is
 *           held shut here, as in term-font-picker.tsx). The terminal is measured with a fallback
 *           at open(), and must be measured again when the load ends. For the terminal no view
 *           shows, only the pool's own wait at creation does that (a view's fit re-measures the
 *           terminal it shows).
 * Each leg opens one terminal in a view and one that no view shows.
 */
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import fontsCss from '../../../src/renderer/src/design/fonts.css?raw';
import anyFontUrl from '../../../src/renderer/src/assets/fonts/jetbrains-mono/JetBrainsMono-Regular.woff2?url';
import { PtyTerminalView } from '../../../src/renderer/src/components/PtyTerminalView';
import { acquireTerminal } from '../../../src/renderer/src/components/terminalPool';
import {
  getTerminalFontFace, loadTerminalFont, setTerminalFontFace, terminalFontFamily, terminalFontReady, type TerminalFontFace
} from '../../../src/renderer/src/components/terminalFont';

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
    if (name === 'getConfig') return () => Promise.resolve({});
    if (name === 'resizePty') return (id: string, cols: number, rows: number) => { resizes.push({ id, cols, rows }); return Promise.resolve({ ok: true }); };
    if (name === 'onPtyData' || name === 'onPtyExit' || name.startsWith('on')) return () => () => {};
    if (name.endsWith('Sync')) return () => null;
    return () => Promise.resolve({ ok: true });
  }
});

const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
/** How long the picked face's load is held shut. It opens by itself, on a timer. */
const HELD_MS = 1500;
const HELD_FACE: TerminalFontFace = 'Martian Mono';
const gate: { face: string | null; opened: Promise<void> } = { face: null, opened: Promise.resolve() };
const realFontLoad = document.fonts.load.bind(document.fonts);
document.fonts.load = ((font: string, text?: string) => (
  gate.face && font.includes(`"${gate.face}"`) ? gate.opened.then(() => realFontLoad(font, text)) : realFontLoad(font, text)
)) as typeof document.fonts.load;

type XtermCore = { _core: { _renderService: { dimensions: { device: { cell: { width: number } } } } } };
type Entry = ReturnType<typeof acquireTerminal>;

window.__harnessRun = async () => {
  try {
    const assets = anyFontUrl.replace(/fonts\/jetbrains-mono\/.*$/, '');
    const style = document.createElement('style');
    style.textContent = fontsCss.replace(/url\('\.\.\/assets\//g, `url('${assets}`);
    document.head.appendChild(style);

    const ctx = document.createElement('canvas').getContext('2d')!;
    const ptyGrid = (id: string) => [...resizes].reverse().find((r) => r.id === id);
    /** Mount a terminal view for `id` now and wait until the pty has heard the grid xterm has. */
    const openView = async (id: string): Promise<Entry> => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'width:900px;height:300px';
      document.body.appendChild(wrap);
      await act(async () => { createRoot(wrap).render(<div style={{ width: '100%', height: '100%', display: 'flex' }}><PtyTerminalView ptyId={id} embedded /></div>); });
      const entry = acquireTerminal(id);
      for (let i = 0; i < 100 && ptyGrid(id)?.cols !== entry.term.cols; i++) await wait(50);
      return entry;
    };
    const cellOf = (entry: Entry) => (entry.term as unknown as XtermCore)._core._renderService.dimensions.device.cell.width;
    /** What xterm holds for a terminal, beside what `face` needs at the terminal's own size. */
    const read = (id: string, entry: Entry, face: TerminalFontFace) => {
      const size = entry.term.options.fontSize ?? 0;
      ctx.font = `${size}px "${face}"`;
      return {
        id, face, size,
        family: entry.term.options.fontFamily,
        letterSpacing: entry.term.options.letterSpacing,
        cell: cellOf(entry),
        advance: ctx.measureText('W').width,
        cols: entry.term.cols,
        ptyCols: ptyGrid(id)?.cols ?? null
      };
    };

    // The app starts: one terminal, and the starting face loads to its end.
    const initialFace = getTerminalFontFace();
    const first = await openView('pty-start');
    await act(async () => { await loadTerminalFont(initialFace); });
    const started = () => terminalFontReady(initialFace) && first.term.options.fontFamily === terminalFontFamily(initialFace);
    for (let i = 0; i < 200 && !started(); i++) await wait(25);
    if (!started()) throw new Error(`the scenario did not start on ${initialFace}`);
    await wait(100);

    // LOADED: both terminals open with the face already loaded.
    const loadedReadyAtOpen = terminalFontReady(initialFace);
    const lateView = await openView('pty-late');
    const latePooled = acquireTerminal('pty-late-pooled'); // in the pool, never attached to a view
    const loaded = {
      readyAtOpen: loadedReadyAtOpen,
      start: read('pty-start', first, initialFace),
      view: read('pty-late', lateView, initialFace),
      pooled: read('pty-late-pooled', latePooled, initialFace)
    };

    // HELD: another face is picked and its load is held shut; both terminals open a third of the
    // way into the hold. The hold opens by itself HELD_MS after the pick.
    gate.face = HELD_FACE;
    gate.opened = new Promise<void>((r) => { setTimeout(() => { gate.face = null; r(); }, HELD_MS); });
    const t0 = performance.now();
    await act(async () => { setTerminalFontFace(HELD_FACE); });
    await wait(HELD_MS / 3);
    const heldReadyAtOpen = terminalFontReady(HELD_FACE);
    // The terminal no view shows opens FIRST: it is then the first thing in the page to use the
    // picked face, so xterm measures it with a fallback (a face the browser has not fetched yet
    // is fetched on first use, and the regular weight of a bundled face arrives within
    // milliseconds: a terminal opened after another one would already be measured with it).
    const heldPooled = acquireTerminal('pty-held-pooled');
    const pooledCellAtOpen = cellOf(heldPooled);
    const heldView = await openView('pty-held');
    const during = {
      readyAtOpen: heldReadyAtOpen,
      readyAfterOpen: terminalFontReady(HELD_FACE),
      startFamily: first.term.options.fontFamily,
      viewFamily: heldView.term.options.fontFamily,
      pooledFamily: heldPooled.term.options.fontFamily,
      pooledCellAtOpen,
      pooledSize: heldPooled.term.options.fontSize ?? 0
    };
    // The load ends: wait on the load the pool itself waits on, then on the state it leaves.
    await act(async () => { await loadTerminalFont(HELD_FACE); });
    const all: Array<[string, Entry]> = [['pty-start', first], ['pty-late', lateView], ['pty-late-pooled', latePooled], ['pty-held', heldView], ['pty-held-pooled', heldPooled]];
    const landed = () => terminalFontReady(HELD_FACE) && all.every(([, e]) => e.term.options.fontFamily === terminalFontFamily(HELD_FACE));
    for (let i = 0; i < 200 && !landed(); i++) await wait(25);
    if (!landed()) throw new Error(`the pick of ${HELD_FACE} did not land on every terminal`);
    await wait(100);
    for (const [id, e] of all) {
      if (id.endsWith('-pooled')) continue;
      for (let i = 0; i < 100 && ptyGrid(id)?.cols !== e.term.cols; i++) await wait(50);
    }
    const held = {
      landedMs: performance.now() - t0,
      during,
      after: all.map(([id, e]) => ({ ...read(id, e, HELD_FACE), attached: !id.endsWith('-pooled') }))
    };

    window.harness.report({ ok: true, dpr: window.devicePixelRatio, initialFace, heldFace: HELD_FACE, loaded, held });
  } catch (e) {
    window.harness.report({ ok: false, error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) });
  }
};
