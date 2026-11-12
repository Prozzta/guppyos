/**
 * BLOB-MESSAGE: record a voice message from the blob's ring, play it back, transcribe it with the
 * user's own Groq key (the dictation SttProvider), edit the text, pick an agent and send it through
 * the Human's message queue. The audio lives only in the dialog's memory and goes to Groq only when
 * the user presses Transcribe; nothing is written to disk.
 *
 * Pure: shared by main (validation) and the renderer dialog.
 */
import { DICTATION_MAX_AUDIO_BYTES } from './dictation';

/** The longest message: recording stops itself at five minutes. */
export const BLOB_MESSAGE_MAX_MS = 5 * 60 * 1000;
/** Groq's upload limit (the same cap dictation uses); five minutes of webm/opus is about 5 MB. */
export const BLOB_MESSAGE_MAX_AUDIO_BYTES = DICTATION_MAX_AUDIO_BYTES;
/** Longest transcript kept (a five-minute message is far below it). */
export const BLOB_MESSAGE_MAX_CHARS = 20_000;

export const BLOB_MESSAGE_COPY = {
  noKey: 'Transcribing needs a Groq API key: add one under Settings > Blob.',
  noAudio: 'Nothing was recorded.',
  tooLarge: 'The recording is too large to transcribe.',
  noSpeech: 'No speech was detected.',
  noMic: 'The microphone could not be opened.',
  failed: 'The message could not be transcribed.',
} as const;

/**
 * The transcript as an editable message: control characters other than line breaks become spaces,
 * line breaks are normalised to \n, space runs collapse, the ends are trimmed and the length capped.
 */
export function normalizeMessageTranscript(text: unknown): string {
  if (typeof text !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/\r\n?|[\u2028\u2029]/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/[ \u00a0]{2,}/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (flat.length <= BLOB_MESSAGE_MAX_CHARS) return flat;
  let cut = flat.slice(0, BLOB_MESSAGE_MAX_CHARS);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut.trimEnd();
}

/** "m:ss" for the recorder's clock. */
export function formatMessageClock(ms: number): string {
  const s = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export type BlobMessageTranscribeResult = { ok: true; text: string } | { ok: false; error: string };
