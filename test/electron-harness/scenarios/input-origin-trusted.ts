/**
 * SCENARIO - MODEL-NOT-KEPT-191 T1. A person's keystroke, not a script's.
 *
 * input-origin.ts drives xterm with `dispatchEvent(new KeyboardEvent(...))`. That event is
 * untrusted, and a script dispatch runs NO microtask checkpoint between listeners, so a window
 * closed by `queueMicrotask` in the capture listener is still open when xterm's handler emits.
 * A real key is a trusted dispatch: the browser runs a checkpoint after EACH listener callback.
 * Here the keys come from main through Chromium's input pipeline (`harness.key`, which is
 * `webContents.sendInputEvent`), and the instrument is the same as input-origin.ts: the
 * production terminalPool with a bridge stub that records the origin each byte left with.
 */
import { acquireTerminal, attachTerminal } from '../../../src/renderer/src/components/terminalPool';

declare global {
  interface Window {
    __harnessRun: () => Promise<void>;
    harness: { report: (payload: unknown) => void; key: (keyCode: string, char?: string) => Promise<boolean> };
    cth: Record<string, unknown>;
  }
}

interface Sent { id: string; data: string; origin: string }
const sent: Sent[] = [];
/** The pool's pty-output subscriber, kept so an arm can deliver program output itself. */
const ptyData = new Map<string, (chunk: unknown) => void>();

function installBridgeStub(): void {
  const unsub = () => () => { /* nothing subscribed */ };
  window.cth = {
    onPtyData: (id: string, cb: (chunk: unknown) => void) => { ptyData.set(id, cb); return () => { ptyData.delete(id); }; },
    onPtyExit: unsub(), onPtyRelaunch: unsub(),
    writePty: (id: string, data: string, origin: string) => { sent.push({ id, data, origin }); return Promise.resolve({ ok: true }); },
    redrawPty: () => { /* no pty */ }, resizePty: () => { /* no pty */ },
    copyToClipboard: () => { /* unused */ },
    readClipboard: () => Promise.resolve(''), readClipboardSync: () => '',
    statAbs: () => Promise.resolve(null), revealPath: () => Promise.resolve(),
    reportTerminalInputState: () => Promise.resolve({ ok: true })
  };
}

const tick = () => new Promise<void>((r) => { setTimeout(r, 0); });

window.__harnessRun = async () => {
  const result: Record<string, unknown> = {};
  try {
    installBridgeStub();
    const root = document.getElementById('root')!;
    const entry = acquireTerminal('trusted');
    attachTerminal(entry, root);
    const term = entry.term;
    const ta = term.textarea!;
    for (let i = 0; i < 20 && entry.inputSelfTest === 'unknown'; i++) await tick();
    result.selfTest = entry.inputSelfTest;
    // Every keydown that reaches the page, as the page sees it: proves the keys are trusted.
    const trusted: boolean[] = [];
    window.addEventListener('keydown', (e) => { trusted.push(e.isTrusted); }, { capture: true });
    term.focus();
    result.focused = document.activeElement === ta;

    // The keys a person presses to switch a model in a TUI picker: a letter, an arrow, Enter.
    const keys: { name: string; keyCode: string; char?: string }[] = [
      { name: 'letter', keyCode: 'm', char: 'm' },
      { name: 'right', keyCode: 'Right' },
      { name: 'enter', keyCode: 'Return', char: '\r' }
    ];
    const out: Record<string, { origin: string[]; data: string[] }> = {};
    for (const k of keys) {
      sent.length = 0;
      await window.harness.key(k.keyCode, k.char);
      await tick();
      out[k.name] = { origin: sent.map((s) => s.origin), data: sent.map((s) => s.data) };
    }
    result.keys = out;
    result.trusted = trusted.slice();

    // The twelve protocol replies (InputHandler.ts DA1/DA2/DECRQM ansi+dec/DSR/CPR/DECXCPR/
    // XTWINOPS/DECRQSS, Terminal.ts OSC colour reports), each QUERIED FROM INSIDE a trusted
    // key's dispatch, the closest a reply can get to a human window. The window now lasts
    // the whole dispatch, so this is where a leak would show. Parsing runs on a later task
    // (WriteBuffer setTimeout), so every reply must still leave as CONTROL; the key, HUMAN.
    const queries = ['\x1b[c', '\x1b[>c', '\x1b[1$p', '\x1b[?1$p', '\x1b[5n', '\x1b[6n', '\x1b[?6n',
      '\x1b[18t', '\x1bP$qm\x1b\\', '\x1b]10;?\x1b\\', '\x1b]11;?\x1b\\', '\x1b]4;1;?\x1b\\'];
    sent.length = 0;
    window.addEventListener('keydown', () => { for (const q of queries) term.write(q); }, { capture: true, once: true });
    await window.harness.key('x', 'x');
    await new Promise<void>((r) => { term.write('', () => r()); });
    await new Promise<void>((r) => { setTimeout(r, 100); });
    result.replies = sent.map((s) => ({ origin: s.origin, data: s.data }));
    result.queries = queries.length;

    // Program output delivered INSIDE the key's dispatch, after xterm's handler emitted (xterm's
    // keydown is a CAPTURE listener on the textarea; a capture listener added there after it
    // runs right after it, which its stopPropagation does not prevent). xterm parses the first write after user input
    // synchronously, so without endInputWindowForOutput this CPR reply leaves as HUMAN.
    // Kills: "drop the output guard in the pool's onPtyData".
    sent.length = 0;
    const deliver = ptyData.get('trusted')!;
    let delivered = false;
    ta.addEventListener('keydown', () => { delivered = true; deliver('\x1b[6n'); }, { capture: true, once: true });
    await window.harness.key('Right');
    await new Promise<void>((r) => { term.write('', () => r()); });
    await new Promise<void>((r) => { setTimeout(r, 100); });
    result.deliveredInDispatch = delivered;
    result.selfTestAfter = entry.inputSelfTest;
    result.outputInDispatch = sent.map((s) => ({ origin: s.origin, data: s.data }));
    result.ok = true;
  } catch (e) {
    result.ok = false;
    result.error = String((e as Error)?.stack ?? e);
  }
  window.harness.report(result);
};
