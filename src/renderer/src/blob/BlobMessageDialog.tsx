/**
 * BLOB-MESSAGE: the "record a message" dialog the blob's ring opens in the Guppy window.
 * Record (up to five minutes) -> play back -> Transcribe (the user's own Groq key, in main) ->
 * edit the text -> pick an agent -> Send (the Human's message queue). The audio stays in this
 * dialog's memory and is dropped on close; it leaves the machine only when Transcribe is pressed.
 */
import { useEffect, useRef, useState } from 'react';
import { BLOB_MESSAGE_COPY, BLOB_MESSAGE_MAX_MS, formatMessageClock } from '@shared/blobMessage';
import { pickMimeType } from '../freeflow/mime';
import { AgentPicker, defaultPick, sendToAgent, usePickerOptions } from './AgentPickerField';

type Phase = 'idle' | 'opening' | 'recording' | 'recorded' | 'transcribing';

export function BlobMessageDialog(props: { onClose(): void }): JSX.Element {
  const opts = usePickerOptions();
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [clip, setClip] = useState<{ blob: Blob; url: string } | null>(null);
  const [text, setText] = useState('');
  const [agent, setAgent] = useState<string | null>(() => defaultPick(opts));
  const [error, setError] = useState<string | null>(null);
  const rec = useRef<{ recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; started: number; tick: number; cap: number } | null>(null);
  const alive = useRef(true);

  useEffect(() => { if (agent == null) setAgent(defaultPick(opts)); }, [opts, agent]);

  const stopTracks = (s: MediaStream): void => { try { s.getTracks().forEach((t) => t.stop()); } catch { /* noop */ } };
  const dropRecording = (): void => {
    const r = rec.current; rec.current = null;
    if (!r) return;
    clearInterval(r.tick); clearTimeout(r.cap);
    r.recorder.ondataavailable = null; r.recorder.onstop = null;
    try { if (r.recorder.state !== 'inactive') r.recorder.stop(); } catch { /* noop */ }
    stopTracks(r.stream);
  };
  // Closing drops everything: the mic, the recording and the clip's object URL.
  useEffect(() => () => { alive.current = false; dropRecording(); }, []);
  useEffect(() => () => { if (clip) URL.revokeObjectURL(clip.url); }, [clip]);

  async function startRecording(): Promise<void> {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) { setError(BLOB_MESSAGE_COPY.noMic); return; }
    setPhase('opening');
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch {
      if (alive.current) { setPhase(clip ? 'recorded' : 'idle'); setError(BLOB_MESSAGE_COPY.noMic); }
      return;
    }
    if (!alive.current) { stopTracks(stream); return; }
    const mimeType = pickMimeType();
    let recorder: MediaRecorder;
    try { recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream); } catch {
      stopTracks(stream); setPhase(clip ? 'recorded' : 'idle'); setError(BLOB_MESSAGE_COPY.noMic); return;
    }
    const chunks: Blob[] = [];
    recorder.ondataavailable = (ev) => { if (ev.data && ev.data.size > 0) chunks.push(ev.data); };
    recorder.onstop = () => {
      const r = rec.current; rec.current = null;
      if (r) { clearInterval(r.tick); clearTimeout(r.cap); stopTracks(r.stream); }
      if (!alive.current) return;
      if (!chunks.length) { setPhase('idle'); setError(BLOB_MESSAGE_COPY.noAudio); return; }
      const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
      setClip({ blob, url: URL.createObjectURL(blob) });
      setText('');
      setPhase('recorded');
    };
    const started = Date.now();
    rec.current = {
      recorder, stream, chunks, started,
      tick: window.setInterval(() => setElapsed(Date.now() - started), 250),
      cap: window.setTimeout(() => stopRecording(), BLOB_MESSAGE_MAX_MS),
    };
    setElapsed(0);
    recorder.start(1000);
    setPhase('recording');
  }

  function stopRecording(): void {
    const r = rec.current;
    if (!r) return;
    clearInterval(r.tick); clearTimeout(r.cap);
    setElapsed(Math.min(Date.now() - r.started, BLOB_MESSAGE_MAX_MS));
    try { r.recorder.stop(); } catch { dropRecording(); setPhase('idle'); }
  }

  async function transcribe(): Promise<void> {
    if (!clip) return;
    setError(null);
    setPhase('transcribing');
    let r: { ok: boolean; text?: string; error?: string };
    try { r = await window.cth.blobMessageTranscribe({ audio: await clip.blob.arrayBuffer(), mimeType: clip.blob.type }); } catch {
      r = { ok: false, error: BLOB_MESSAGE_COPY.failed };
    }
    if (!alive.current) return;
    setPhase('recorded');
    if (r.ok && r.text) setText(r.text); else setError(r.error || BLOB_MESSAGE_COPY.failed);
  }

  function send(): void {
    setError(null);
    const r = sendToAgent(agent, text);
    if (r.ok) props.onClose(); else setError(r.error);
  }

  const busy = phase === 'opening' || phase === 'transcribing';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" role="dialog" aria-modal="true" aria-label="Record a message"
      onKeyDown={(e) => { if (e.key === 'Escape') props.onClose(); }}>
      <div className="w-[min(32rem,92vw)] rounded-lg border border-white/15 bg-neutral-900 p-4 text-neutral-100 shadow-xl flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Record a message</h2>
          <button type="button" className="text-sm opacity-70 hover:opacity-100" onClick={props.onClose} aria-label="Close">Close</button>
        </div>
        <div className="flex items-center gap-3">
          {phase === 'recording'
            ? <button type="button" className="rounded bg-red-600 px-3 py-1 text-sm" onClick={stopRecording}>Stop</button>
            : <button type="button" className="rounded bg-white/10 px-3 py-1 text-sm disabled:opacity-50" disabled={busy} onClick={() => { void startRecording(); }}>
                {clip ? 'Record again' : 'Record'}
              </button>}
          <span className="font-mono text-sm tabular-nums" aria-live="polite">
            {formatMessageClock(elapsed)} / {formatMessageClock(BLOB_MESSAGE_MAX_MS)}
          </span>
          {phase === 'recording' && <span className="text-xs text-red-400">Recording</span>}
        </div>
        {clip && phase !== 'recording' && (
          <>
            <audio controls src={clip.url} className="w-full" />
            <div className="flex items-center gap-2">
              <button type="button" className="rounded bg-white/10 px-3 py-1 text-sm disabled:opacity-50" disabled={busy} onClick={() => { void transcribe(); }}>
                {phase === 'transcribing' ? 'Transcribing...' : 'Transcribe'}
              </button>
              <span className="text-xs opacity-60">Sends the audio to Groq with your own key.</span>
            </div>
          </>
        )}
        <textarea
          className="min-h-[6rem] rounded border border-white/20 bg-black/30 p-2 text-sm"
          aria-label="Message"
          placeholder="Transcribe the recording, or type the message."
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        {error && <p className="text-sm text-red-400" role="alert">{error}</p>}
        <div className="flex items-center justify-between gap-2">
          <AgentPicker value={agent} onChange={setAgent} disabled={busy} />
          <button type="button" className="rounded bg-blue-600 px-3 py-1 text-sm disabled:opacity-50"
            disabled={busy || phase === 'recording' || !text.trim() || !agent} onClick={send}>Send</button>
        </div>
      </div>
    </div>
  );
}
