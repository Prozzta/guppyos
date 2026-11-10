/**
 * GUPPY-DICTATION-P2: system-wide hold-to-talk dictation. Hold Ctrl+Alt+Space in any app, the
 * blob shows it is listening, release, and the transcript is typed into the focused field.
 *
 * Pure: shared by main (the controller), the blob overlay and the Settings section.
 */

/** The hold-to-talk chord (the helper's syntax). Distinct from the blob's show/hide hotkey. */
export const DICTATION_CHORD = 'Ctrl+Alt+Space';

/**
 * off          — the feature is off (the default), not on Windows, or a hidden run
 * unavailable  — on, but it cannot run now (no Groq key, the helper or its hook is down); see message
 * ready        — armed: hold the chord to talk
 * listening    — the chord is held and the mic records
 * transcribing — released; the clip is with the speech-to-text provider
 * typing       — the transcript is being typed into the focused field
 * error        — the last attempt failed (nothing was typed); back to ready shortly
 */
export type DictationState = 'off' | 'unavailable' | 'ready' | 'listening' | 'transcribing' | 'typing' | 'error';

export interface DictationStatus {
  state: DictationState;
  /** A human-readable reason for unavailable/error (never contains a key). */
  message?: string;
  chord: string;
}

export const DICTATION_OFF: DictationStatus = { state: 'off', chord: DICTATION_CHORD };

export const DICTATION_COPY = {
  noKey: 'Dictation needs a Groq API key: add one under Settings > Free Flow.',
  noWindow: 'Dictation needs the Guppy window open (it records the mic).',
  hookFailed: 'The Ctrl+Alt+Space hook could not be armed.',
  helperMissing: 'The Windows input helper is missing from this build.',
  rearming: 'Reconnecting the keyboard helper...',
  interrupted: 'Dictation was interrupted (the keyboard helper restarted); nothing was typed.',
  noSpeech: 'No speech detected; nothing was typed.',
  timeout: 'The recording never arrived; nothing was typed.',
  typeFailed: 'The transcript could not be typed.',
  focusChanged: 'Focus changed before typing; nothing was typed.',
  tooLarge: 'The recording is too large to transcribe; nothing was typed.',
} as const;

/** Longest transcript we type (a 2-minute clip is far below it). */
export const DICTATION_MAX_CHARS = 4_000;

/** Groq's upload limit; a 2-minute webm/opus clip is about 2 MB. Larger clips are refused in main. */
export const DICTATION_MAX_AUDIO_BYTES = 25 * 1024 * 1024;

/**
 * The text that may be typed: every line break, tab and other control character becomes a space
 * (an Enter typed into a chat box would SEND it; dictation never submits anything), runs of spaces
 * collapse, and the ends are trimmed. Returns '' when nothing typeable is left.
 */
export function normalizeTranscript(text: unknown): string {
  if (typeof text !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/[ \u00a0]{2,}/g, ' ').trim();
  if (flat.length <= DICTATION_MAX_CHARS) return flat;
  let cut = flat.slice(0, DICTATION_MAX_CHARS);
  // Never end on half a surrogate pair (an emoji cut in two would type a lone, invalid half).
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut.trimEnd();
}

/** What main asks the app window's capture to do (`dictation:capture`). */
export interface DictationCaptureCommand { op: 'start' | 'stop' | 'cancel'; session: number }

/** What the app window sends back (`dictation:audio`). */
export interface DictationAudioPayload {
  session: number;
  audio?: ArrayBuffer | Uint8Array;
  mimeType?: string;
  error?: string;
}
