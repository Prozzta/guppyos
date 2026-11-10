/**
 * GUPPY-DICTATION-P2: the app window's half of system-wide dictation. Main (which owns the
 * hold-to-talk hook) sends `start`/`stop`/`cancel` for a numbered session; this records the mic
 * with MediaRecorder and sends the clip back for that session. The transcript never comes here:
 * main types it into whichever app has focus.
 *
 * A stop that lands while the mic is still opening, or a cancel at any point, never produces a
 * clip. Electron/DOM pieces are injected so the session logic is tested in plain Node.
 */
import type { DictationAudioPayload, DictationCaptureCommand } from '../../../shared/dictation';
import { pickMimeType } from './mime';

export interface RecorderLike {
  mimeType: string;
  ondataavailable: ((ev: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  start(): void;
  stop(): void;
}

export interface CaptureEnv {
  getUserMedia(): Promise<MediaStream>;
  makeRecorder(stream: MediaStream, mimeType: string): RecorderLike;
  pickMime(): string;
  send(p: DictationAudioPayload): Promise<unknown> | void;
}

interface Session {
  id: number;
  want: 'run' | 'stop' | 'cancel';
  stream: MediaStream | null;
  rec: RecorderLike | null;
  chunks: Blob[];
}

export function createDictationCapture(env: CaptureEnv): (cmd: DictationCaptureCommand) => void {
  let cur: Session | null = null;

  const release = (s: Session): void => {
    try { s.stream?.getTracks().forEach((t) => t.stop()); } catch { /* noop */ }
    s.stream = null;
  };
  const send = (p: DictationAudioPayload): void => { try { void env.send(p); } catch { /* main is gone */ } };

  async function finish(s: Session): Promise<void> {
    release(s);
    if (cur === s) cur = null;
    if (s.want === 'cancel') return;
    const type = s.rec?.mimeType || 'audio/webm';
    const blob = new Blob(s.chunks, { type });
    s.chunks = [];
    if (blob.size === 0) { send({ session: s.id, error: 'nothing recorded' }); return; }
    send({ session: s.id, audio: await blob.arrayBuffer(), mimeType: type.split(';')[0] });
  }

  async function start(id: number): Promise<void> {
    if (cur) cancel(cur.id);   // a leftover session never mixes into this one
    const s: Session = { id, want: 'run', stream: null, rec: null, chunks: [] };
    cur = s;
    let stream: MediaStream;
    try {
      stream = await env.getUserMedia();
    } catch (e) {
      if (cur === s) cur = null;
      if (s.want !== 'cancel') {
        const name = e && typeof e === 'object' && 'name' in e ? String((e as { name: unknown }).name) : '';
        send({ session: id, error: name === 'NotAllowedError' ? 'microphone permission denied' : 'could not open microphone' });
      }
      return;
    }
    s.stream = stream;
    if (s.want !== 'run') {
      // Released (or cancelled) before the mic opened: there is nothing worth transcribing.
      release(s);
      if (cur === s) cur = null;
      if (s.want === 'stop') send({ session: id, error: 'released before the microphone opened' });
      return;
    }
    let rec: RecorderLike;
    try { rec = env.makeRecorder(stream, env.pickMime()); } catch {
      release(s); if (cur === s) cur = null;
      send({ session: id, error: 'recording not supported' });
      return;
    }
    s.rec = rec;
    rec.ondataavailable = (ev) => { if (ev.data && ev.data.size > 0) s.chunks.push(ev.data); };
    rec.onstop = () => { void finish(s); };
    rec.start();
  }

  function stop(id: number): void {
    const s = cur; if (!s || s.id !== id) return;
    s.want = 'stop';
    if (s.rec) { try { s.rec.stop(); } catch { /* already stopped */ } }
  }

  function cancel(id: number): void {
    const s = cur; if (!s || s.id !== id) return;
    s.want = 'cancel';
    cur = null;
    if (s.rec) { try { s.rec.stop(); } catch { /* already stopped */ } }
    release(s);
  }

  return (cmd) => {
    if (!cmd || typeof cmd.session !== 'number') return;
    if (cmd.op === 'start') void start(cmd.session);
    else if (cmd.op === 'stop') stop(cmd.session);
    else if (cmd.op === 'cancel') cancel(cmd.session);
  };
}

/** Wire the capture to this window (called once by App). Returns the unsubscribe. */
export function installDictationCapture(): () => void {
  const api = (typeof window !== 'undefined' ? window.cth : undefined) as
    | { onDictationCapture?: (cb: (cmd: DictationCaptureCommand) => void) => () => void; dictationAudio?: (p: DictationAudioPayload) => Promise<unknown> }
    | undefined;
  if (!api?.onDictationCapture || !api.dictationAudio) return () => {};
  const send = api.dictationAudio;
  const handle = createDictationCapture({
    getUserMedia: () => navigator.mediaDevices.getUserMedia({ audio: true }),
    makeRecorder: (stream, mimeType) => (mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)) as unknown as RecorderLike,
    pickMime: pickMimeType,
    send: (p) => send(p),
  });
  return api.onDictationCapture(handle);
}
