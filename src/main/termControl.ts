/**
 * GOD-TERMINAL-CONTROL M1: god drives any agent's terminal directly - reads the screen, types,
 * presses keys - as a person at the keyboard would. Design: agents/andy-mtuk4y4x/
 * GOD-TERMINAL-CONTROL-DESIGN.md (sections 2, 4, 5, 9, 11), Jim PASS 16:25Z.
 *
 * NOT the screen gate and NOT admission: nothing here asks whether the terminal looks ready.
 * God reads the screen and decides. What this module does enforce:
 *   - god only, checked at REQUEST time against the registry's godId (the hook broker has already
 *     proved the caller's id with its per-spawn token);
 *   - one action at a time per target, so a send's Enter can never land inside another call;
 *   - text is ONE raw write. A bracketed paste was measured to be no guard through ConPTY (16:30Z:
 *     a framed lone `?` still opens Claude's help, a framed `!x` still enters shell mode), so a
 *     lone `?` and a leading `!` or `/` are refused unless the caller passes raw: true;
 *   - control bytes never ride in text (keys are a separate, named action);
 *   - send's Enter waits for the echo to settle AND at least the provider's measured Enter gap
 *     (Codex reads an early Enter as a newline: CODEX-WAKE-161/162);
 *   - every action, refused ones included, is one log row with bounded screen tails.
 * Pure logic over injected deps: no electron, no node-pty (unit-testable).
 */
import type { AgentProvider } from '../shared/agentProvider';
import { automaticEnterGapMs } from '../shared/providerAutomation';
import { screenTail, type MirrorReading } from './terminalMirror';

export const TERM_TEXT_MAX = 16 * 1024;
export const TERM_KEYS_MAX = 16;
export const TERM_ROWS_MAX = 200;
/** The echo settles when the output generation has not moved for this long... */
export const TERM_SETTLE_QUIET_MS = 150;
/** ...or when this cap is reached (the provider's Enter gap may still add to it). */
export const TERM_SETTLE_CAP_MS = 1_500;
/** Between two keys: an Esc followed at once by another byte reads as an Alt chord. */
export const TERM_KEY_GAP_MS = 80;
/** The after-screen is read this long after the last write. */
export const TERM_AFTER_READ_MS = 400;
export const TERM_LOG_TEXT_MAX = 4 * 1024;
export const TERM_LOG_TAIL_ROWS = 12;

export type TermAction = 'read' | 'type' | 'keys' | 'send';
const ACTIONS: readonly TermAction[] = ['read', 'type', 'keys', 'send'];

export interface TermDeps {
  /** The registry's god id NOW (null: no god registered). */
  godId(): string | null;
  /** The live PTY id of a registered agent, or undefined. */
  ptyOf(agentId: string): string | undefined;
  providerOf(agentId: string): AgentProvider | null;
  readScreen(ptyId: string, rows?: number): Promise<MirrorReading | null>;
  /** MIRROR-STARTUP-196: why the mirrors are auto-off and when they re-arm, in words; null = not auto-off. */
  mirrorOff?(): string | null;
  /** Writes with origin GOD (the caller binds it; this module never chooses an origin). */
  write(ptyId: string, data: string): { ok: boolean; error?: string };
  outputGeneration(ptyId: string): number | undefined;
  log(row: Record<string, unknown>): void;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface TermReply { status: number; body: { ok: boolean; line: string; screen?: string[]; header?: string } }

/** CSI vs SS3 for the cursor keys follows DECCKM, as a real keyboard's does. */
function cursorKey(final: string, app: boolean): string { return app ? `\x1bO${final}` : `\x1b[${final}`; }

/** The named keys. Anything else is refused: an unknown name is never guessed at. */
export function keyBytes(name: string, appCursor: boolean): string | null {
  switch (name) {
    case 'enter': return '\r';
    case 'esc': return '\x1b';
    case 'tab': return '\t';
    case 'shift-tab': return '\x1b[Z';
    case 'backspace': return '\x7f';
    case 'space': return ' ';
    case 'ctrl-c': return '\x03';
    case 'ctrl-d': return '\x04';
    case 'ctrl-l': return '\x0c';
    case 'ctrl-u': return '\x15';
    case 'up': return cursorKey('A', appCursor);
    case 'down': return cursorKey('B', appCursor);
    case 'right': return cursorKey('C', appCursor);
    case 'left': return cursorKey('D', appCursor);
    case 'home': return cursorKey('H', appCursor);
    case 'end': return cursorKey('F', appCursor);
    case 'pgup': return '\x1b[5~';
    case 'pgdn': return '\x1b[6~';
    default: return /^[yn0-9]$/.test(name) ? name : null;
  }
}

/** ESC and everything a terminal would read as part of its sequence (CSI, OSC, DCS/PM/APC
 *  strings, and a two-byte escape), so no escape survives into typed text. */
const ESC_SEQUENCE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|[\]PX^_][^\x07\x1b]*(?:\x07|\x1b\\)?|[\s\S])?/g;
/** After ESC removal: every C0 except TAB and LF, DEL, and C1. These are keys, not text. */
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f\x80-\x9f]/;

export type TextCheck = { ok: true; text: string; strippedEscapes: number } | { ok: false; reason: string };

/** Typed text as ONE write, or why not. `provider` decides whether a newline may ride along. */
export function checkText(raw: unknown, provider: AgentProvider | null, allowRaw: boolean): TextCheck {
  if (typeof raw !== 'string' || raw.length === 0) return { ok: false, reason: 'no text (pipe it on stdin)' };
  if (raw.length > TERM_TEXT_MAX) return { ok: false, reason: `the text is over ${TERM_TEXT_MAX} characters` };
  let strippedEscapes = 0;
  const text = raw.replace(/\r\n/g, '\n').replace(ESC_SEQUENCE, () => { strippedEscapes += 1; return ''; });
  if (!text) return { ok: false, reason: 'nothing left after removing escape sequences' };
  if (CONTROL.test(text)) return { ok: false, reason: 'the text holds control characters; send keys with `term keys` instead' };
  if (!allowRaw) {
    if (text.trim() === '?') return { ok: false, reason: 'a lone "?" opens the help panel (it acts as a key, framed or not); pass --raw if that is meant' };
    // Jim 17:01Z: one write is not one read by the child (ConPTY/node-pty may split it), so a
    // leading "?" can land alone on the empty composer and open the help panel. Refused whole.
    if (text.startsWith('?')) return { ok: false, reason: 'a leading "?" can reach the prompt alone (a write may arrive in pieces) and open the help panel; start with a space or pass --raw' };
    if (/^[!/]/.test(text)) return { ok: false, reason: `a leading "${text[0]}" switches the prompt mode (shell or command); pass --raw if that is meant` };
    if (text.includes('\n') && provider !== 'claude') return { ok: false, reason: `multi-line text is measured only for claude, not ${provider ?? 'this provider'}; pass --raw to send it anyway` };
  }
  return { ok: true, text, strippedEscapes };
}

function header(r: MirrorReading): string {
  return `cursor ${r.cursor.x},${r.cursor.y}  ${r.cols}x${r.rows}${r.altScreen ? '  alt' : ''}  paste2004=${r.bracketedPaste ? 'on' : 'off'}${r.appCursor ? '  appcursor' : ''}`;
}

function clip(text: string): { text: string; length: number } {
  return { text: text.length > TERM_LOG_TEXT_MAX ? `${text.slice(0, TERM_LOG_TEXT_MAX)}…` : text, length: text.length };
}

export class TermControl {
  /** One action at a time per target agent. */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(private readonly deps: TermDeps) {}

  /** One `term` request from the hook broker. `callerId` is the id the broker's token proved. */
  handle(callerId: string, body: unknown): Promise<TermReply> {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const agent = typeof b.agent === 'string' ? b.agent : '';
    const action = typeof b.action === 'string' && (ACTIONS as readonly string[]).includes(b.action) ? b.action as TermAction : null;
    const refuse = (status: number, line: string): Promise<TermReply> => {
      this.logRow({ by: callerId, agent: agent || null, action: action ?? b.action ?? null, ok: false, error: line });
      return Promise.resolve({ status, body: { ok: false, line: `refused: ${line}` } });
    };
    const god = this.deps.godId();
    if (!god || callerId !== god) return refuse(403, 'term is god-only');
    if (!action) return refuse(400, `action must be one of ${ACTIONS.join(', ')}`);
    if (!agent) return refuse(400, 'agent: required');
    if (agent === callerId) return refuse(400, 'god cannot drive its own terminal');
    const ptyId = this.deps.ptyOf(agent);
    if (!ptyId) return refuse(404, `${agent} has no live terminal`);
    return this.slot(agent, () => this.run(callerId, agent, ptyId, action, b));
  }

  /** GTC M3: run `fn` as the agent's one action (god's `term` and the Human's message box share
   *  it, so the two never interleave on one terminal). */
  slot<T>(agent: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(agent) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    this.chains.set(agent, tail);
    void tail.then(() => { if (this.chains.get(agent) === tail) this.chains.delete(agent); });
    return run;
  }

  private logRow(row: Record<string, unknown>): void {
    try { this.deps.log({ kind: 'term', ...row }); } catch { /* logging never changes an outcome */ }
  }

  private async run(by: string, agent: string, ptyId: string, action: TermAction, b: Record<string, unknown>): Promise<TermReply> {
    const provider = this.deps.providerOf(agent);
    if (action === 'read') {
      const rows = Number.isInteger(b.rows) && (b.rows as number) > 0 ? Math.min(b.rows as number, TERM_ROWS_MAX) : undefined;
      const r = await this.deps.readScreen(ptyId, rows);
      if (!r) {
        const off = (() => { try { return this.deps.mirrorOff?.() ?? null; } catch { return null; } })();
        this.logRow({ by, agent, action, ok: false, error: 'no screen mirror' });
        return { status: 503, body: { ok: false, line: `refused: no screen mirror for ${agent} (${off ?? 'the mirror is off or failed'})` } };
      }
      this.logRow({ by, agent, action, ok: true, rows: r.lines.length, mode2004: r.bracketedPaste });
      return { status: 200, body: { ok: true, line: `${agent}: ${header(r)}`, header: header(r), screen: r.lines } };
    }

    let writes: Array<{ data: string; gapBeforeMs: number }>;
    let logged: Record<string, unknown>;
    const before = await this.deps.readScreen(ptyId);
    if (action === 'keys') {
      const names = Array.isArray(b.keys) ? b.keys : [];
      if (names.length === 0 || names.length > TERM_KEYS_MAX || !names.every((k) => typeof k === 'string')) {
        this.logRow({ by, agent, action, ok: false, error: 'bad keys' });
        return { status: 400, body: { ok: false, line: `refused: keys: 1 to ${TERM_KEYS_MAX} key names` } };
      }
      const bytes = (names as string[]).map((k) => keyBytes(k, before?.appCursor === true));
      const bad = (names as string[]).filter((_, i) => bytes[i] === null);
      if (bad.length) {
        this.logRow({ by, agent, action, keys: names, ok: false, error: `unknown key ${bad.join(', ')}` });
        return { status: 400, body: { ok: false, line: `refused: unknown key(s) ${bad.join(', ')}` } };
      }
      writes = (bytes as string[]).map((data, i) => ({ data, gapBeforeMs: i === 0 ? 0 : TERM_KEY_GAP_MS }));
      logged = { keys: names };
    } else {
      const checked = checkText(b.text, provider, b.raw === true);
      if (!checked.ok) {
        this.logRow({ by, agent, action, ...(typeof b.text === 'string' ? { text: clip(b.text).text, textLength: b.text.length } : {}), ok: false, error: checked.reason });
        return { status: 400, body: { ok: false, line: `refused: ${checked.reason}` } };
      }
      writes = [{ data: checked.text, gapBeforeMs: 0 }];
      const c = clip(checked.text);
      logged = { text: c.text, textLength: c.length, raw: b.raw === true, ...(checked.strippedEscapes ? { strippedEscapes: checked.strippedEscapes } : {}) };
    }

    let enterGapMs: number | null = null;
    for (const w of writes) {
      if (w.gapBeforeMs) await this.deps.sleep(w.gapBeforeMs);
      const r = this.deps.write(ptyId, w.data);
      if (!r.ok) return this.finish(by, agent, ptyId, action, logged, before, false, `write failed: ${r.error ?? 'unknown'}`);
    }
    if (action === 'send') {
      const typedAt = this.deps.now();
      await this.settle(ptyId);
      const textLength = (logged.textLength as number) ?? 0;
      enterGapMs = Math.max(TERM_SETTLE_QUIET_MS, automaticEnterGapMs(provider ?? 'custom', textLength) ?? 0);
      const waited = this.deps.now() - typedAt;
      if (waited < enterGapMs) await this.deps.sleep(enterGapMs - waited);
      const r = this.deps.write(ptyId, '\r');
      if (!r.ok) return this.finish(by, agent, ptyId, action, { ...logged, enterGapMs }, before, false, `the Enter write failed: ${r.error ?? 'unknown'}`);
    }
    return this.finish(by, agent, ptyId, action, enterGapMs === null ? logged : { ...logged, enterGapMs }, before, true);
  }

  /** Until the output generation stops moving for TERM_SETTLE_QUIET_MS, at most TERM_SETTLE_CAP_MS. */
  async settle(ptyId: string): Promise<void> {
    const start = this.deps.now();
    let gen = this.deps.outputGeneration(ptyId);
    let quietSince = start;
    while (this.deps.now() - start < TERM_SETTLE_CAP_MS) {
      await this.deps.sleep(25);
      const g = this.deps.outputGeneration(ptyId);
      if (g === undefined) return;
      if (g !== gen) { gen = g; quietSince = this.deps.now(); continue; }
      if (this.deps.now() - quietSince >= TERM_SETTLE_QUIET_MS) return;
    }
  }

  private async finish(by: string, agent: string, ptyId: string, action: TermAction, logged: Record<string, unknown>, before: MirrorReading | null, ok: boolean, error?: string): Promise<TermReply> {
    await this.deps.sleep(TERM_AFTER_READ_MS);
    const after = await this.deps.readScreen(ptyId);
    this.logRow({
      by, agent, action, ...logged, ok, ...(error ? { error } : {}),
      mode2004: after?.bracketedPaste ?? before?.bracketedPaste ?? null,
      cursor: after ? after.cursor : null,
      before: screenTail(before, TERM_LOG_TAIL_ROWS),
      after: screenTail(after, TERM_LOG_TAIL_ROWS),
      ...(before ? {} : { mirror: 'off' })
    });
    if (!ok) return { status: 500, body: { ok: false, line: `refused: ${error}` } };
    const what = action === 'keys' ? `keys ${(logged.keys as string[]).join(' ')}` : `${action} ${logged.textLength} chars${action === 'send' ? ` + Enter after ${logged.enterGapMs} ms` : ''}`;
    return { status: 200, body: { ok: true, line: `${agent}: ${what}`, ...(after ? { header: header(after), screen: screenTail(after, TERM_LOG_TAIL_ROWS) } : {}) } };
  }
}
