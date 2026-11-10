/** Prefer webm/opus (Groq-supported, Chromium default); fall back to whatever the
 *  platform offers. Returns '' to let MediaRecorder pick its default. Shared by the
 *  Free Flow recorder and GUPPY-DICTATION-P2's capture. */
export function pickMimeType(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  const supported = typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function';
  if (supported) {
    for (const c of candidates) {
      if (MediaRecorder.isTypeSupported(c)) return c;
    }
  }
  return '';
}
