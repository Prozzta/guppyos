/**
 * The Windows dictation companion is deliberately a tiny process, rather than an npm native
 * module. It accepts JSON-lines on stdin, emits hook transitions on stdout, and is restarted on
 * the next request if Windows terminates it. Nothing starts it until the Blob owner constructs
 * this wrapper; `kill()` is the shutdown path and never leaves a global hook behind.
 *
 * Restart safety (GUPPY-WIN32-HELPER S3): the wrapper remembers that a hook was wanted. When the
 * child dies (crash, Windows, or the request-timeout kill below), a 'down' that never got its 'up'
 * is closed with a SYNTHETIC 'up' (listeners must treat it as a cancel), and the hook is re-armed
 * on a fresh child with backoff, until `stopHook()`/`kill()`.
 *
 * Delivery caveat: SendInput into an elevated window (UIPI) is dropped by Windows yet reported as
 * inserted, so a `type` reply of ok:true means "handed to Windows", not "arrived".
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';

export const INPUT_HELPER_REQUEST_MS = 3_000;
/** `type` may wait up to 2 s for held modifiers, then paste (clipboard retries + a 0.6 s settle). */
export const INPUT_HELPER_TYPE_MS = 10_000;
/** Re-arm delays after a child death; the last one repeats. */
export const INPUT_HELPER_REARM_MS: readonly number[] = [250, 1_000, 4_000, 15_000, 30_000];
export type InputEvent = 'down' | 'up';
/** `hwnd`: the foreground window at a real 'down' (decimal), so `type` can refuse if focus moved (F1). */
export interface InputEventInfo { synthetic?: boolean; hwnd?: string }
export type HookState = 'armed' | 'rearming' | 'failed' | 'off';
/** `restored: false`: the paste happened but the previous clipboard could not be put back. */
export interface InputReply { ok?: boolean; error?: string; fallback?: boolean; restored?: boolean; op?: string }
export interface InputHelperChild {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  on(event: 'error' | 'exit', listener: () => void): unknown;
  kill(): boolean;
}
export type InputHelperSpawn = (exe: string) => InputHelperChild;
export interface InputHelperTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const realTimers: InputHelperTimers = {
  set: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export function inputHelperPath(appPath: string, resourcesPath: string, packaged: boolean): string {
  return packaged ? join(resourcesPath, 'input', 'guppy-input.exe') : join(appPath, 'resources', 'input', 'bin', 'guppy-input.exe');
}

/** A line-oriented child wrapper; tests inject `spawn` and timers and exercise restarts without Windows APIs. */
export class Win32InputHelper {
  private child: InputHelperChild | null = null;
  private buffer = '';
  /** Replies come from two helper threads (hook/unhook from the hook thread, the rest from the reader), so a
   *  reply is matched to the oldest pending request with the same op, not just to the oldest one. */
  private readonly pending: Array<{ op: string; settle: (row: InputReply | null) => void }> = [];
  private readonly listeners = new Set<(event: InputEvent, info: InputEventInfo) => void>();
  private readonly stateListeners = new Set<(state: HookState, error?: string) => void>();
  /** The chord the owner wants armed, or null. Survives child restarts. */
  private wanted: string | null = null;
  /** The last hook event delivered, to close an orphaned 'down' when the child dies. */
  private last: InputEvent = 'up';
  private rearmTimer: unknown = null;
  private rearmStep = 0;
  /** Bumped by every start/stop so a stale arm reply cannot flip the state. */
  private armSeq = 0;

  constructor(
    private readonly exe: () => string | null,
    private readonly start: InputHelperSpawn = (file) => spawn(file, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }),
    private readonly requestMs = INPUT_HELPER_REQUEST_MS,
    private readonly timers: InputHelperTimers = realTimers,
    private readonly typeMs = INPUT_HELPER_TYPE_MS,
  ) {}

  onEvent(listener: (event: InputEvent, info: InputEventInfo) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onHookState(listener: (state: HookState, error?: string) => void): () => void { this.stateListeners.add(listener); return () => this.stateListeners.delete(listener); }

  private ensure(): InputHelperChild | null {
    if (this.child) return this.child;
    const exe = this.exe();
    if (!exe) return null;
    try {
      const child = this.start(exe); this.child = child; child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { if (this.child === child) this.read(chunk); });
      child.on('error', () => this.dead(child)); child.on('exit', () => this.dead(child));
      child.stdin.on('error', () => this.dead(child));
      return child;
    } catch { return null; }
  }

  private emit(event: InputEvent, info: InputEventInfo): void {
    this.last = event;
    for (const fn of this.listeners) try { fn(event, info); } catch { /* listeners are isolated */ }
  }

  private state(s: HookState, error?: string): void {
    for (const fn of this.stateListeners) try { fn(s, error); } catch { /* listeners are isolated */ }
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let at: number;
    while ((at = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, at).trim(); this.buffer = this.buffer.slice(at + 1);
      let row: InputReply & { ev?: unknown; hwnd?: unknown };
      try { row = JSON.parse(line) as InputReply & { ev?: unknown; hwnd?: unknown }; } catch { row = {}; }
      if (row.ev === 'down') this.emit('down', typeof row.hwnd === 'string' ? { hwnd: row.hwnd } : {});
      else if (row.ev === 'up') this.emit('up', {});
      else {
        const byOp = typeof row.op === 'string' && row.op ? this.pending.findIndex((p) => p.op === row.op) : -1;
        const at2 = byOp >= 0 ? byOp : 0;
        if (this.pending.length) this.pending.splice(at2, 1)[0].settle(row);
      }
    }
  }

  private dead(child: InputHelperChild): void {
    if (this.child !== child) return;
    this.child = null; this.buffer = '';
    while (this.pending.length) this.pending.shift()!.settle(null);
    // A hold in progress can never get its real 'up' now: close it, so a recording cannot stick.
    if (this.last === 'down') this.emit('up', { synthetic: true });
    if (this.wanted !== null) this.scheduleRearm();
  }

  private scheduleRearm(): void {
    if (this.rearmTimer !== null || this.wanted === null) return;
    const ms = INPUT_HELPER_REARM_MS[Math.min(this.rearmStep, INPUT_HELPER_REARM_MS.length - 1)];
    this.rearmStep++;
    this.state('rearming');
    this.rearmTimer = this.timers.set(() => { this.rearmTimer = null; if (this.wanted !== null) void this.arm(); }, ms);
  }

  private cancelRearm(): void {
    if (this.rearmTimer !== null) { this.timers.clear(this.rearmTimer); this.rearmTimer = null; }
  }

  private async arm(): Promise<InputReply | null> {
    const chord = this.wanted; if (chord === null) return null;
    const seq = ++this.armSeq;
    const reply = await this.request({ op: 'hook', chord });
    if (seq !== this.armSeq || this.wanted !== chord) return reply;   // superseded by a stop or a newer start
    if (reply?.ok) { this.rearmStep = 0; this.state('armed'); }
    else if (reply) { this.state('failed', reply.error || 'hook failed'); this.scheduleRearm(); }   // the child lives but refused
    else if (!this.exe()) this.state('failed', 'input helper not found');   // nothing to restart
    // reply null otherwise: the child died or timed out; dead() has already scheduled the re-arm.
    else if (!this.child) this.scheduleRearm();
    return reply;
  }

  request(row: Record<string, string>, ms = this.requestMs): Promise<InputReply | null> {
    const child = this.ensure(); if (!child) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      // A late reply cannot remain in the FIFO: kill this child so the next request starts with a
      // fresh protocol stream rather than consuming an answer intended for an expired request.
      const timer = this.timers.set(() => { if (!settled) { settled = true; resolve(null); this.dead(child); try { child.kill(); } catch { /* gone */ } } }, ms);
      this.pending.push({ op: row.op ?? '', settle: (reply) => { if (!settled) { settled = true; this.timers.clear(timer); resolve(reply); } } });
      try { child.stdin.write(JSON.stringify(row) + '\n'); } catch { this.dead(child); }
    });
  }

  /** Arm the hold-to-talk hook and keep it armed across helper restarts until stopHook()/kill(). */
  startHook(chord = 'Ctrl+Alt+Space'): Promise<InputReply | null> {
    this.cancelRearm(); this.rearmStep = 0;
    this.wanted = chord;
    return this.arm();
  }

  stopHook(): Promise<InputReply | null> {
    this.wanted = null; this.armSeq++; this.cancelRearm();
    this.state('off');
    if (!this.child) return Promise.resolve({ ok: true, op: 'unhook' });
    return this.request({ op: 'unhook' });
  }

  /** Types only into `hwnd` (the foreground window at chord-down): the helper refuses 'focus changed' otherwise. */
  type(text: string, hwnd: string): Promise<InputReply | null> { return this.request({ op: 'type', text, hwnd }, this.typeMs); }

  /** Stop the helper even when its pipe has already failed; a killed child unhooks on process exit. */
  kill(): void {
    this.wanted = null; this.armSeq++; this.cancelRearm();
    const child = this.child; if (!child) return;
    this.dead(child); try { child.kill(); } catch { /* already gone */ }
  }
}
