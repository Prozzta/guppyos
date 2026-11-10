/**
 * GUPPY-DICTATION-P2: the main-process dictation flow.
 *
 *   helper 'down' -> capture.start (the app window records the mic) -> status listening
 *   helper 'up'   -> capture.stop  -> the window sends the clip (`onAudio`) -> SttProvider
 *                 -> normalizeTranscript -> helper.type (SendInput, clipboard fallback) -> ready
 *
 * Safety rules, each tested:
 * - nothing is ever typed for an empty, errored, stale (older session) or cancelled clip;
 * - a SYNTHETIC 'up' (the helper died mid-hold) cancels: the half clip is discarded;
 * - a tap shorter than MIN_HOLD_MS is discarded without a network call;
 * - turning the feature off mid-flight drops whatever is in flight;
 * - no key -> a clear message on the first hold, no recording;
 * - F1: the text is typed only into the window that was in front at chord-down (the helper
 *   refuses 'focus changed' otherwise); a hold with no known window types nothing;
 * - F2: a capture error while still listening is shown at once (not after the clip wait).
 *
 * Electron-free: helper, capture, STT, timers and the publish/notify sinks are injected.
 */
import { DICTATION_CHORD, DICTATION_COPY, DICTATION_MAX_AUDIO_BYTES, DICTATION_OFF, normalizeTranscript, type DictationAudioPayload, type DictationStatus } from '../shared/dictation';
import type { SttProvider } from './stt';
import type { HookState, InputEvent, InputEventInfo, InputReply } from './win32Input';

export const DICTATION_MIN_HOLD_MS = 300;
export const DICTATION_MAX_HOLD_MS = 120_000;
/** From release to the clip arriving from the window. */
export const DICTATION_AUDIO_WAIT_MS = 15_000;
/** How long an error stays on the blob before it goes back to ready. */
export const DICTATION_ERROR_MS = 4_000;

export interface DictationHelper {
  onEvent(fn: (event: InputEvent, info: InputEventInfo) => void): () => void;
  onHookState(fn: (state: HookState, error?: string) => void): () => void;
  startHook(chord?: string): Promise<InputReply | null>;
  stopHook(): Promise<InputReply | null>;
  /** `hwnd` is the window that was in front at chord-down; the helper types only into it. */
  type(text: string, hwnd: string): Promise<InputReply | null>;
  kill(): void;
}

export interface DictationCapture {
  /** Ask the app window to open the mic for `session`. */
  start(session: number): { ok: true } | { ok: false; error: string };
  /** Stop and send the clip for `session`. */
  stop(session: number): void;
  /** Stop and discard. */
  cancel(session: number): void;
}

export interface DictationTimers { set(fn: () => void, ms: number): unknown; clear(h: unknown): void }

export interface DictationDeps {
  helper: DictationHelper;
  stt: SttProvider;
  capture: DictationCapture;
  /** Windows, not a hidden run: otherwise the feature stays off and the helper is never started. */
  supported: boolean;
  publish(status: DictationStatus): void;
  /** A user-visible notice (e.g. a system notification) for problems the blob cannot spell out. */
  notify?(message: string): void;
  log?(row: Record<string, unknown>): void;
  now(): number;
  timers: DictationTimers;
}

type Phase = 'idle' | 'listening' | 'transcribing' | 'typing';

export class DictationController {
  private enabled = false;
  private hook: HookState = 'off';
  private hookError: string | undefined;
  private phase: Phase = 'idle';
  private session = 0;
  private startedAt = 0;
  private timer: unknown = null;
  private errorTimer: unknown = null;
  private error: string | null = null;
  private status: DictationStatus = DICTATION_OFF;
  private notifiedNoKey = false;
  private clipTaken = false;
  /** F1: the foreground window at this session's chord-down ('' = unknown: nothing is typed). */
  private target = '';

  constructor(private readonly d: DictationDeps) {
    d.helper.onEvent((ev, info) => { if (ev === 'down') this.onDown(info.hwnd); else this.onUp(info.synthetic === true); });
    d.helper.onHookState((s, err) => { this.hook = s; this.hookError = err; this.publish(); });
  }

  current(): DictationStatus { return this.status; }

  /** Turn the feature on or off (blob enabled AND dictation enabled). Idempotent. */
  apply(on: boolean): DictationStatus {
    const want = on && this.d.supported;
    if (want && !this.enabled) {
      this.enabled = true;
      this.hook = 'off'; this.hookError = undefined;   // arming: shown as ready until the helper says otherwise
      void this.d.helper.startHook(DICTATION_CHORD).then((r) => {
        if (!this.enabled) return;
        if (r?.ok) this.hook = 'armed';
        else if (this.hook !== 'armed') { this.hook = 'failed'; this.hookError = r?.error; }
        this.publish();
      });
    } else if (!want && this.enabled) {
      this.enabled = false;
      this.abandon();
      void this.d.helper.stopHook();
      this.d.helper.kill();
      this.hook = 'off';
    }
    this.publish();
    return this.status;
  }

  /** Re-evaluate (e.g. the Groq key was added or removed). */
  refresh(): DictationStatus { if (this.d.stt.ready().ok) this.notifiedNoKey = false; this.publish(); return this.status; }

  dispose(): void {
    this.enabled = false;
    this.abandon();
    this.d.helper.kill();
    this.hook = 'off';
    this.publish();
  }

  /** The window's clip for `session`. Returns false when it was not expected (stale or off). */
  onAudio(p: DictationAudioPayload): boolean {
    if (!this.enabled || this.clipTaken || !p || p.session !== this.session) return false;
    // F2: the mic failed (denied, busy) while the chord is still held: say why now, not after the clip wait.
    if (this.phase === 'listening' && typeof p.error === 'string' && p.error) {
      this.clearTimer();
      this.d.capture.cancel(this.session);
      this.fail(p.error);   // phase idle: the release, and any later payload for this session, are ignored
      return true;
    }
    if (this.phase !== 'transcribing') return false;
    this.clipTaken = true;   // one clip per session: a repeat can never transcribe (and type) twice
    this.clearTimer();
    const session = this.session;
    if (p.error || !p.audio) { this.fail(p.error || 'nothing recorded'); return true; }
    if (p.audio.byteLength === 0) { this.fail('nothing recorded'); return true; }
    if (p.audio.byteLength > DICTATION_MAX_AUDIO_BYTES) { this.fail(DICTATION_COPY.tooLarge); return true; }   // Groq's upload limit
    void this.d.stt.transcribe({ audio: p.audio, mimeType: p.mimeType, filename: `dictation.${(p.mimeType || '').includes('ogg') ? 'ogg' : 'webm'}` })
      .then((r) => this.onTranscript(session, r.ok ? r.text : undefined, r.ok ? undefined : r.error));
    return true;
  }

  // ---------------------------------------------------------------- internals

  private onDown(hwnd: string | undefined): void {
    if (!this.enabled || this.phase !== 'idle') return;
    const ready = this.d.stt.ready();
    if (!ready.ok) {
      this.fail(DICTATION_COPY.noKey);
      if (!this.notifiedNoKey) { this.notifiedNoKey = true; this.d.notify?.(DICTATION_COPY.noKey); }
      return;
    }
    const session = ++this.session;
    this.clipTaken = false;
    this.target = typeof hwnd === 'string' && /^[1-9][0-9]*$/.test(hwnd) ? hwnd : '';
    const r = this.d.capture.start(session);
    if (!r.ok) { this.fail(r.error); return; }
    this.clearError();
    this.phase = 'listening';
    this.startedAt = this.d.now();
    this.setTimer(() => { if (this.session === session && this.phase === 'listening') this.onUp(false); }, DICTATION_MAX_HOLD_MS);
    this.publish();
  }

  private onUp(synthetic: boolean): void {
    if (this.phase !== 'listening') return;
    this.clearTimer();
    const session = this.session;
    if (synthetic) {
      this.d.capture.cancel(session); this.phase = 'idle';
      this.fail(DICTATION_COPY.interrupted);
      return;
    }
    if (this.d.now() - this.startedAt < DICTATION_MIN_HOLD_MS) {
      this.d.capture.cancel(session); this.phase = 'idle';   // a tap: nothing to say, no network call
      this.publish();
      return;
    }
    this.phase = 'transcribing';
    this.d.capture.stop(session);
    this.setTimer(() => { if (this.session === session && this.phase === 'transcribing') { this.phase = 'idle'; this.fail(DICTATION_COPY.timeout); } }, DICTATION_AUDIO_WAIT_MS);
    this.publish();
  }

  private onTranscript(session: number, raw: string | undefined, error: string | undefined): void {
    if (!this.enabled || session !== this.session || this.phase !== 'transcribing') return;   // superseded: never typed
    if (error !== undefined) { this.phase = 'idle'; this.fail(error); return; }
    const text = normalizeTranscript(raw);
    if (!text) { this.phase = 'idle'; this.fail(DICTATION_COPY.noSpeech); return; }
    const target = this.target;
    if (!target) { this.phase = 'idle'; this.fail(DICTATION_COPY.focusChanged); return; }   // F1: no known window, nothing typed
    this.phase = 'typing';
    this.publish();
    void this.d.helper.type(text, target).then((r) => {
      if (session !== this.session) return;
      this.phase = 'idle';
      if (r?.ok) { this.d.log?.({ kind: 'dictation-typed', chars: text.length, fallback: r.fallback === true, restored: r.restored !== false }); this.clearError(); this.publish(); }
      else if (r?.error === 'focus changed' || r?.error === 'no target window') this.fail(DICTATION_COPY.focusChanged);
      else this.fail(r?.error ? `${DICTATION_COPY.typeFailed} (${r.error})` : DICTATION_COPY.typeFailed);
    });
  }

  /** Drop whatever is in flight; a late clip or transcript for it is ignored. */
  private abandon(): void {
    this.clearTimer();
    if (this.phase === 'listening' || this.phase === 'transcribing') this.d.capture.cancel(this.session);
    this.session++;
    this.phase = 'idle';
    this.clearError();
  }

  private fail(message: string): void {
    this.phase = 'idle';
    this.error = message;
    this.d.log?.({ kind: 'dictation-error', message });
    if (this.errorTimer !== null) this.d.timers.clear(this.errorTimer);
    this.errorTimer = this.d.timers.set(() => { this.errorTimer = null; this.error = null; this.publish(); }, DICTATION_ERROR_MS);
    this.publish();
  }

  private clearError(): void {
    if (this.errorTimer !== null) { this.d.timers.clear(this.errorTimer); this.errorTimer = null; }
    this.error = null;
  }

  private setTimer(fn: () => void, ms: number): void { this.clearTimer(); this.timer = this.d.timers.set(() => { this.timer = null; fn(); }, ms); }
  private clearTimer(): void { if (this.timer !== null) { this.d.timers.clear(this.timer); this.timer = null; } }

  private compute(): DictationStatus {
    const chord = DICTATION_CHORD;
    if (!this.enabled) return DICTATION_OFF;
    if (this.phase === 'listening') return { state: 'listening', chord };
    if (this.phase === 'transcribing') return { state: 'transcribing', chord };
    if (this.phase === 'typing') return { state: 'typing', chord };
    if (this.error) return { state: 'error', message: this.error, chord };
    if (this.hook === 'failed') return { state: 'unavailable', message: this.hookError === 'input helper not found' ? DICTATION_COPY.helperMissing : `${DICTATION_COPY.hookFailed}${this.hookError ? ` (${this.hookError})` : ''}`, chord };
    if (this.hook === 'rearming') return { state: 'unavailable', message: DICTATION_COPY.rearming, chord };
    const ready = this.d.stt.ready();
    if (!ready.ok) return { state: 'unavailable', message: DICTATION_COPY.noKey, chord };
    return { state: 'ready', chord };
  }

  private publish(): void {
    const next = this.compute();
    const prev = this.status;
    this.status = next;
    if (prev.state !== next.state || prev.message !== next.message) { try { this.d.publish(next); } catch { /* a closing overlay */ } }
  }
}
