/**
 * The Windows dictation companion is deliberately a tiny process, rather than an npm native
 * module. It accepts JSON-lines on stdin, emits hook transitions on stdout, and is restarted on
 * the next request if Windows terminates it. Nothing starts it until the Stapler owner constructs
 * this wrapper; `kill()` is the shutdown path and never leaves a global hook behind.
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';

export const INPUT_HELPER_REQUEST_MS = 3_000;
export type InputEvent = 'down' | 'up';
export interface InputReply { ok?: boolean; error?: string; fallback?: boolean; op?: string }
export interface InputHelperChild {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  on(event: 'error' | 'exit', listener: () => void): unknown;
  kill(): boolean;
}
export type InputHelperSpawn = (exe: string) => InputHelperChild;

export function inputHelperPath(appPath: string, resourcesPath: string, packaged: boolean): string {
  return packaged ? join(resourcesPath, 'input', 'guppy-input.exe') : join(appPath, 'resources', 'input', 'bin', 'guppy-input.exe');
}

/** A line-oriented child wrapper; tests inject `spawn` and exercise restarts without Windows APIs. */
export class Win32InputHelper {
  private child: InputHelperChild | null = null;
  private buffer = '';
  private readonly pending: Array<(row: InputReply | null) => void> = [];
  private readonly listeners = new Set<(event: InputEvent) => void>();

  constructor(private readonly exe: () => string | null, private readonly start: InputHelperSpawn = (file) => spawn(file, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })) {}

  onEvent(listener: (event: InputEvent) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  private ensure(): InputHelperChild | null {
    if (this.child) return this.child;
    const exe = this.exe();
    if (!exe) return null;
    try {
      const child = this.start(exe); this.child = child; child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => this.read(chunk));
      child.on('error', () => this.dead(child)); child.on('exit', () => this.dead(child));
      child.stdin.on('error', () => this.dead(child));
      return child;
    } catch { return null; }
  }

  private read(chunk: string): void {
    this.buffer += chunk;
    let at: number;
    while ((at = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, at).trim(); this.buffer = this.buffer.slice(at + 1);
      let row: InputReply & { ev?: unknown };
      try { row = JSON.parse(line) as InputReply & { ev?: unknown }; } catch { row = {}; }
      if (row.ev === 'down' || row.ev === 'up') { for (const fn of this.listeners) try { fn(row.ev); } catch { /* listeners are isolated */ } }
      else this.pending.shift()?.(row);
    }
  }

  private dead(child: InputHelperChild): void {
    if (this.child !== child) return;
    this.child = null; this.buffer = '';
    while (this.pending.length) this.pending.shift()!(null);
  }

  request(row: Record<string, string>): Promise<InputReply | null> {
    const child = this.ensure(); if (!child) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, INPUT_HELPER_REQUEST_MS);
      timer.unref?.();
      this.pending.push((reply) => { if (!settled) { settled = true; clearTimeout(timer); resolve(reply); } });
      try { child.stdin.write(JSON.stringify(row) + '\n'); } catch { this.dead(child); }
    });
  }

  startHook(chord = 'Ctrl+Alt+Space'): Promise<InputReply | null> { return this.request({ op: 'hook', chord }); }
  stopHook(): Promise<InputReply | null> { return this.request({ op: 'unhook' }); }
  type(text: string): Promise<InputReply | null> { return this.request({ op: 'type', text }); }

  /** Stop the helper even when its pipe has already failed; a killed child unhooks on process exit. */
  kill(): void {
    const child = this.child; if (!child) return;
    this.dead(child); try { child.kill(); } catch { /* already gone */ }
  }
}
