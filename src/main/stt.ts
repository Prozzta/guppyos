/**
 * GUPPY-DICTATION-P2: speech-to-text behind a small provider interface. Today the only
 * implementation is Groq Whisper (the Free Flow path: the key stays in main). A worker-proxied or a
 * local engine can implement SttProvider and be swapped in without touching the dictation flow.
 *
 * Free of any `electron` import so it is unit-tested as a plain Node module.
 */
import { DEFAULT_GROQ_MODEL, transcribeWithGroq, type TranscribeOptions, type TranscribeResult } from './freeflow';

export interface SttRequest {
  audio: ArrayBuffer | Uint8Array;
  mimeType?: string;
  filename?: string;
  language?: string;
}

export interface SttProvider {
  readonly id: string;
  /** Whether a request could run now (e.g. a key is configured). Cheap; no network. */
  ready(): { ok: true } | { ok: false; error: string };
  /** Never throws. `text` is the raw transcript (the caller normalizes it). */
  transcribe(req: SttRequest): Promise<TranscribeResult>;
}

export interface GroqSttConfig { apiKey?: string; model?: string }

export const NO_GROQ_KEY = 'no Groq API key set';

/** Groq Whisper via Free Flow's transcribeWithGroq. The key is read from main's config per call. */
export class GroqSttProvider implements SttProvider {
  readonly id = 'groq';
  constructor(
    private readonly config: () => GroqSttConfig,
    private readonly call: (opts: TranscribeOptions) => Promise<TranscribeResult> = transcribeWithGroq,
  ) {}

  ready(): { ok: true } | { ok: false; error: string } {
    return this.config().apiKey ? { ok: true } : { ok: false, error: NO_GROQ_KEY };
  }

  async transcribe(req: SttRequest): Promise<TranscribeResult> {
    const cfg = this.config();
    if (!cfg.apiKey) return { ok: false, error: NO_GROQ_KEY };
    try {
      return await this.call({
        apiKey: cfg.apiKey,
        audio: req.audio,
        mimeType: req.mimeType,
        filename: req.filename,
        language: req.language,
        model: cfg.model || DEFAULT_GROQ_MODEL,
      });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}
