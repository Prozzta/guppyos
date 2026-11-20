/**
 * PTY-CONHOST-ORPHAN-OWNER-DEATH (option A): the start-up handshake of the bundled OpenConsole.
 *
 * Every Guppy PTY runs on node-pty's bundled OpenConsole (useConptyDll). At start-up it writes
 * `ESC[1t`, then a Primary Device Attributes query `ESC[c` (with `ESC[?1004h ESC[?9001h`), and does
 * not start the child until a DA1 answer comes or 3 s pass (measured 2026-11-20: spawn -> the
 * child's process start 3060 ms with no answer, 59 ms with one). The renderer's xterm.js would answer, but a terminal whose renderer is
 * not attached (a tab never opened, no window) has nobody, and terminalMirror never answers.
 *
 * So MAIN is the one responder for this query, for EVERY PTY: it answers as xterm.js does and takes
 * the query out of the stream, so the renderer never sees it and never answers it a second time.
 * A second answer is not harmless: OpenConsole passes it to the child as typed input (measured: a
 * late `ESC[?62;4;22c` arrived on the child's stdin).
 *
 * Only the start-up query is taken: the first `ESC[c` / `ESC[0c` that comes before any byte of the
 * child's own output. Once the child prints, or the query was taken, the stream passes untouched,
 * and a DA1 query the CHILD sends later reaches the renderer as before.
 */

/** xterm.js's own DA1 answer (VT100 with advanced video), what the renderer would send. */
export const DA1_ANSWER = '\x1b[?1;2c';

/** A whole control sequence: CSI (with params/intermediates) or OSC (BEL or ST ended). */
const CONTROL = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const DA1_QUERY = /\x1b\[0?c/;

export interface HandshakeStep {
  /** What goes on to the renderer and the mirror. */
  data: string;
  /** True when this chunk carried the start-up query: answer it with DA1_ANSWER. */
  answer: boolean;
  /** True while the handshake may still come (keep calling); false once it is over. */
  pending: boolean;
}

/** One output chunk of a PTY whose handshake is still pending. */
export function startupHandshake(chunk: string): HandshakeStep {
  const m = DA1_QUERY.exec(chunk);
  // Everything before the query must be control sequences only: else it is the child's output.
  const before = m ? chunk.slice(0, m.index) : chunk;
  const childOutput = before.replace(CONTROL, '').length > 0;
  if (m && !childOutput) {
    return { data: chunk.slice(0, m.index) + chunk.slice(m.index + m[0].length), answer: true, pending: false };
  }
  return { data: chunk, answer: false, pending: !childOutput };
}
