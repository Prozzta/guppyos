/**
 * BLOB-MESSAGE: main's side of 'blob:message:transcribe'. The app window sends the recorded clip;
 * it goes to the user's own Groq key through the dictation SttProvider (the key never leaves main)
 * and only the normalised transcript comes back. Free of any `electron` import (unit-tested).
 */
import { NO_GROQ_KEY, type SttProvider } from './stt';
import {
  BLOB_MESSAGE_COPY, BLOB_MESSAGE_MAX_AUDIO_BYTES, normalizeMessageTranscript, type BlobMessageTranscribeResult,
} from '../shared/blobMessage';

export async function transcribeBlobMessage(stt: SttProvider, arg: unknown): Promise<BlobMessageTranscribeResult> {
  const a = (arg ?? {}) as { audio?: unknown; mimeType?: unknown };
  const audio = a.audio instanceof ArrayBuffer || a.audio instanceof Uint8Array ? a.audio : undefined;
  if (!audio || audio.byteLength === 0) return { ok: false, error: BLOB_MESSAGE_COPY.noAudio };
  if (audio.byteLength > BLOB_MESSAGE_MAX_AUDIO_BYTES) return { ok: false, error: BLOB_MESSAGE_COPY.tooLarge };
  const ready = stt.ready();
  if (!ready.ok) return { ok: false, error: ready.error === NO_GROQ_KEY ? BLOB_MESSAGE_COPY.noKey : ready.error };
  const mimeType = typeof a.mimeType === 'string' ? a.mimeType.slice(0, 64) : 'audio/webm';
  const r = await stt.transcribe({ audio, mimeType, filename: mimeType.includes('ogg') ? 'message.ogg' : 'message.webm' });
  if (!r.ok) return { ok: false, error: r.error === NO_GROQ_KEY ? BLOB_MESSAGE_COPY.noKey : (r.error || BLOB_MESSAGE_COPY.failed) };
  const text = normalizeMessageTranscript(r.text);
  return text ? { ok: true, text } : { ok: false, error: BLOB_MESSAGE_COPY.noSpeech };
}
