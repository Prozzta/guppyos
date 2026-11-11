'use strict';
// GUPPY-DICTATION-P2: hold-to-talk dictation. Every helper, capture, STT provider and timer here is
// a fake: no test types into the real focused window, arms a global hook, opens a mic or calls Groq.
require('./tools/own-job.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const D = loadTs('src/main/dictation.ts');
const S = loadTs('src/main/stt.ts');
const SD = loadTs('src/shared/dictation.ts');
const B = loadTs('src/shared/blob.ts');
const C = loadTs('src/renderer/src/freeflow/dictationCapture.ts');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const flush = () => new Promise((r) => setImmediate(r));

function fakeTimers() {
  let seq = 0; const live = new Map();
  return {
    set(fn, ms) { const id = ++seq; live.set(id, { fn, ms }); return id; },
    clear(id) { live.delete(id); },
    fire(ms) { for (const [id, t] of [...live]) if (t.ms === ms) { live.delete(id); t.fn(); } },
    has(ms) { return [...live.values()].some((t) => t.ms === ms); },
  };
}

function rig(opts = {}) {
  const ev = new Set(); const st = new Set();
  const calls = { startHook: [], stopHook: 0, kill: 0, typed: [], typedInto: [], capture: [], notify: [], published: [], stt: [] };
  const helper = {
    onEvent: (fn) => { ev.add(fn); return () => ev.delete(fn); },
    onHookState: (fn) => { st.add(fn); return () => st.delete(fn); },
    startHook: async (chord) => { calls.startHook.push(chord); return opts.hookReply === undefined ? { ok: true, op: 'hook' } : opts.hookReply; },
    stopHook: async () => { calls.stopHook++; return { ok: true }; },
    type: async (text, hwnd) => { calls.typed.push(text); calls.typedInto.push(hwnd); return opts.typeReply === undefined ? { ok: true, fallback: false } : opts.typeReply; },
    kill: () => { calls.kill++; },
  };
  let key = opts.key === undefined ? 'gsk_test' : opts.key;
  let sttReply = opts.stt || { ok: true, text: 'hello world' };
  let sttResolve = null;
  const stt = {
    id: 'fake',
    ready: () => (key ? { ok: true } : { ok: false, error: 'no key' }),
    transcribe: (req) => { calls.stt.push(req); if (opts.holdStt) return new Promise((r) => { sttResolve = r; }); return Promise.resolve(sttReply); },
  };
  const capture = {
    start: (s) => { calls.capture.push(['start', s]); return opts.captureFail ? { ok: false, error: opts.captureFail } : { ok: true }; },
    stop: (s) => calls.capture.push(['stop', s]),
    cancel: (s) => calls.capture.push(['cancel', s]),
  };
  let now = 1000;
  const timers = fakeTimers();
  const ctl = new D.DictationController({
    helper, stt, capture, supported: opts.supported !== false,
    publish: (s) => calls.published.push(s), notify: (m) => calls.notify.push(m),
    now: () => now, timers,
  });
  return {
    ctl, calls, timers,
    down: (info = { hwnd: '4242' }) => { for (const f of ev) f('down', info); },
    up: (info = {}) => { for (const f of ev) f('up', info); },
    hookState: (s, e) => { for (const f of st) f(s, e); },
    advance: (ms) => { now += ms; },
    setKey: (k) => { key = k; },
    setStt: (r) => { sttReply = r; },
    resolveStt: (r) => sttResolve(r),
    pendingStt: () => sttResolve,
    audio: (session, extra = {}) => ctl.onAudio({ session, audio: new Uint8Array([1, 2, 3]).buffer, mimeType: 'audio/webm', ...extra }),
  };
}

async function holdAndRelease(r, ms = 1200) {
  r.down(); r.advance(ms); r.up();
  const session = r.calls.capture.find((c) => c[0] === 'start')[1];
  return session;
}

test('off by default: no hook, no helper, and the blob setting defaults to false', async () => {
  const r = rig();
  assert.equal(r.ctl.current().state, 'off');
  assert.equal(r.calls.startHook.length, 0);
  assert.equal(B.blobSettingsFrom({}).dictation, false);
  assert.equal(B.blobSettingsFrom({ blobDictation: 'yes' }).dictation, false, 'only a real true enables it');
  assert.deepEqual(B.sanitizeBlobPatch({ dictation: true }), { ok: true, fields: { blobDictation: true } });
  r.down(); r.advance(2000); r.up();
  assert.deepEqual(r.calls.capture, [], 'a hold while off records nothing');
});

test('enabling arms Ctrl+Alt+Space once; disabling unhooks and kills the helper', async () => {
  const r = rig();
  r.ctl.apply(true); r.ctl.apply(true); await flush();
  assert.deepEqual(r.calls.startHook, ['Ctrl+Alt+Space']);
  assert.equal(r.ctl.current().state, 'ready');
  r.ctl.apply(false); await flush();
  assert.equal(r.calls.stopHook, 1); assert.equal(r.calls.kill, 1);
  assert.equal(r.ctl.current().state, 'off');
});

test('not supported (non-Windows or a hidden run): apply(true) never starts the helper', async () => {
  const r = rig({ supported: false });
  r.ctl.apply(true); await flush();
  assert.equal(r.calls.startHook.length, 0);
  assert.equal(r.ctl.current().state, 'off');
});

test('hold -> listening -> release -> transcribing -> the normalized transcript is typed once', async () => {
  const r = rig({ stt: { ok: true, text: '  Hello,\nworld.\r\n  Send\tthis ' } });
  r.ctl.apply(true); await flush();
  r.down();
  assert.equal(r.ctl.current().state, 'listening');
  r.advance(1500); r.up();
  assert.equal(r.ctl.current().state, 'transcribing');
  const session = r.calls.capture[0][1];
  assert.deepEqual(r.calls.capture, [['start', session], ['stop', session]]);
  assert.equal(r.audio(session), true);
  await flush(); await flush();
  assert.deepEqual(r.calls.typed, ['Hello, world. Send this'], 'no newline or tab is ever typed (an Enter could submit a chat box)');
  assert.equal(r.ctl.current().state, 'ready');
  const states = r.calls.published.map((s) => s.state);
  for (const s of ['listening', 'transcribing', 'typing', 'ready']) assert.ok(states.includes(s), `published ${s}`);
});

test('nothing is typed for an empty transcript, an STT error, or a failed recording', async () => {
  for (const [label, setup, expect] of [
    ['whitespace-only transcript', (r) => r.setStt({ ok: true, text: ' \n\t ' }), SD.DICTATION_COPY.noSpeech],
    ['groq error', (r) => r.setStt({ ok: false, error: 'Groq 401: invalid_api_key' }), 'Groq 401: invalid_api_key'],
  ]) {
    const r = rig(); setup(r);
    r.ctl.apply(true); await flush();
    const session = await holdAndRelease(r);
    r.audio(session); await flush(); await flush();
    assert.deepEqual(r.calls.typed, [], label);
    assert.equal(r.ctl.current().state, 'error', label);
    assert.equal(r.ctl.current().message, expect, label);
    r.timers.fire(D.DICTATION_ERROR_MS);
    assert.equal(r.ctl.current().state, 'ready', `${label}: the error clears`);
  }
  const r = rig();
  r.ctl.apply(true); await flush();
  const session = await holdAndRelease(r);
  r.ctl.onAudio({ session, error: 'microphone permission denied' }); await flush();
  assert.deepEqual(r.calls.stt, [], 'a capture error never reaches STT');
  assert.deepEqual(r.calls.typed, []);
  assert.equal(r.ctl.current().message, 'microphone permission denied');
  const r2 = rig();
  r2.ctl.apply(true); await flush();
  const s2 = await holdAndRelease(r2);
  r2.ctl.onAudio({ session: s2, audio: new ArrayBuffer(0) }); await flush();
  assert.deepEqual(r2.calls.stt, []); assert.deepEqual(r2.calls.typed, []);
});

test('no Groq key: a clear message (blob + one notification), no recording, no network', async () => {
  const r = rig({ key: '' });
  r.ctl.apply(true); await flush();
  assert.equal(r.ctl.current().state, 'unavailable');
  assert.equal(r.ctl.current().message, SD.DICTATION_COPY.noKey);
  r.down(); r.advance(1000); r.up();
  r.down(); r.advance(1000); r.up();
  assert.deepEqual(r.calls.capture, [], 'the mic is never opened');
  assert.deepEqual(r.calls.stt, []);
  assert.deepEqual(r.calls.notify, [SD.DICTATION_COPY.noKey], 'notified once, not on every hold');
  assert.equal(r.ctl.current().state, 'error');
  r.setKey('gsk_new'); r.timers.fire(D.DICTATION_ERROR_MS); r.ctl.refresh();
  assert.equal(r.ctl.current().state, 'ready', 'adding the key (freeflow:setConfig -> refresh) makes it ready');
  assert.match(read('src/main/index.ts'), /writeConfig\(next\);\r?\n\s*dictation\.refresh\(\);/, 'freeflow:setConfig refreshes dictation');
});

test('a SYNTHETIC up (helper died mid-hold) cancels: no stop, no STT, nothing typed', async () => {
  const r = rig();
  r.ctl.apply(true); await flush();
  r.down(); r.advance(2000); r.up({ synthetic: true });
  const session = r.calls.capture[0][1];
  assert.deepEqual(r.calls.capture, [['start', session], ['cancel', session]]);
  assert.equal(r.audio(session), false, 'a late clip for the cancelled session is refused');
  await flush();
  assert.deepEqual(r.calls.stt, []); assert.deepEqual(r.calls.typed, []);
  assert.equal(r.ctl.current().message, SD.DICTATION_COPY.interrupted);
});

test('a tap shorter than the minimum hold is discarded without a network call', async () => {
  const r = rig();
  r.ctl.apply(true); await flush();
  r.down(); r.advance(D.DICTATION_MIN_HOLD_MS - 1); r.up();
  const session = r.calls.capture[0][1];
  assert.deepEqual(r.calls.capture, [['start', session], ['cancel', session]]);
  assert.equal(r.ctl.current().state, 'ready');
});

test('stale and foreign clips are dropped; turning off mid-transcription types nothing', async () => {
  const r = rig({ holdStt: true });
  r.ctl.apply(true); await flush();
  const session = await holdAndRelease(r);
  assert.equal(r.audio(session + 1), false, 'a clip for another session is refused');
  assert.equal(r.ctl.onAudio(null), false);
  assert.equal(r.audio(session), true);
  assert.equal(r.audio(session), false, 'the same clip twice is refused');
  r.ctl.apply(false);
  r.resolveStt({ ok: true, text: 'too late' }); await flush(); await flush();
  assert.deepEqual(r.calls.typed, [], 'nothing typed after the feature was turned off');
});

test('an off/on toggle mid-transcription: the old transcript never types into the new session', async () => {
  const r = rig({ holdStt: true });
  const resolvers = [];
  r.ctl.apply(true); await flush();
  const s1 = await holdAndRelease(r);
  assert.equal(r.audio(s1), true);
  resolvers.push(r.pendingStt());
  const first = r.calls.stt.length;
  r.ctl.apply(false); r.ctl.apply(true); await flush();
  r.down(); r.advance(1200); r.up();
  const s2 = r.calls.capture.filter((c) => c[0] === 'start').at(-1)[1];
  assert.notEqual(s2, s1);
  assert.equal(r.audio(s2), true, 'the new session is transcribing its own clip');
  assert.equal(r.calls.stt.length, first + 1);
  resolvers[0]({ ok: true, text: 'old session text' }); await flush(); await flush();
  assert.deepEqual(r.calls.typed, [], 'the superseded transcript is dropped even though a session is transcribing');
  r.resolveStt({ ok: true, text: 'new session text' }); await flush(); await flush();
  assert.deepEqual(r.calls.typed, ['new session text']);
});

test('a new hold is ignored while the previous one is still transcribing', async () => {
  const r = rig({ holdStt: true });
  r.ctl.apply(true); await flush();
  const session = await holdAndRelease(r);
  r.audio(session);
  r.down(); r.advance(1000); r.up();
  assert.equal(r.calls.capture.filter((c) => c[0] === 'start').length, 1);
  r.resolveStt({ ok: true, text: 'first' }); await flush(); await flush();
  assert.deepEqual(r.calls.typed, ['first']);
});

test('max hold auto-stops; a clip that never arrives times out with nothing typed', async () => {
  const r = rig();
  r.ctl.apply(true); await flush();
  r.down(); r.advance(D.DICTATION_MAX_HOLD_MS);
  r.timers.fire(D.DICTATION_MAX_HOLD_MS);
  const session = r.calls.capture[0][1];
  assert.deepEqual(r.calls.capture, [['start', session], ['stop', session]]);
  assert.equal(r.ctl.current().state, 'transcribing');
  r.timers.fire(D.DICTATION_AUDIO_WAIT_MS);
  assert.equal(r.ctl.current().message, SD.DICTATION_COPY.timeout);
  assert.equal(r.audio(session), false, 'the clip after the timeout is refused');
  await flush(); assert.deepEqual(r.calls.typed, []);
});

test('the capture window missing, a failed type, and a failed hook are reported', async () => {
  const r = rig({ captureFail: SD.DICTATION_COPY.noWindow });
  r.ctl.apply(true); await flush();
  r.down();
  assert.equal(r.ctl.current().state, 'error'); assert.equal(r.ctl.current().message, SD.DICTATION_COPY.noWindow);
  const t = rig({ typeReply: { ok: false, error: 'modifier keys still held' } });
  t.ctl.apply(true); await flush();
  const s = await holdAndRelease(t); t.audio(s); await flush(); await flush(); await flush();
  assert.equal(t.ctl.current().state, 'error'); assert.match(t.ctl.current().message, /modifier keys still held/);
  const h = rig({ hookReply: { ok: false, error: 'SetWindowsHookEx failed (5)' } });
  h.ctl.apply(true); await flush();
  assert.equal(h.ctl.current().state, 'unavailable'); assert.match(h.ctl.current().message, /SetWindowsHookEx failed \(5\)/);
  h.hookState('rearming');
  assert.equal(h.ctl.current().message, SD.DICTATION_COPY.rearming);
  h.hookState('armed');
  assert.equal(h.ctl.current().state, 'ready');
  h.hookState('failed', 'input helper not found');
  assert.equal(h.ctl.current().message, SD.DICTATION_COPY.helperMissing);
});

test('normalizeTranscript strips every control and line-separator character and caps the length', () => {
  assert.equal(SD.normalizeTranscript('a b c\u0085d\u0007e\u007ff'), 'a b c d e f');
  assert.equal(SD.normalizeTranscript('a   b'), 'a b');
  assert.equal(SD.normalizeTranscript(null), '');
  assert.equal(SD.normalizeTranscript('x'.repeat(SD.DICTATION_MAX_CHARS + 50)).length, SD.DICTATION_MAX_CHARS);
  assert.equal(SD.normalizeTranscript('café 日本 😀'), 'café 日本 😀', 'non-ASCII survives');
});

test('GroqSttProvider: key read from config per call, model passed, no key -> no call', async () => {
  let cfg = {}; const seen = [];
  const p = new S.GroqSttProvider(() => cfg, async (o) => { seen.push(o); return { ok: true, text: 't' }; });
  assert.equal(p.id, 'groq');
  assert.deepEqual(p.ready(), { ok: false, error: S.NO_GROQ_KEY });
  assert.deepEqual(await p.transcribe({ audio: new Uint8Array([1]) }), { ok: false, error: S.NO_GROQ_KEY });
  assert.equal(seen.length, 0);
  cfg = { apiKey: 'gsk_x', model: 'whisper-large-v3' };
  assert.deepEqual(p.ready(), { ok: true });
  await p.transcribe({ audio: new Uint8Array([1]), mimeType: 'audio/webm' });
  assert.equal(seen[0].apiKey, 'gsk_x'); assert.equal(seen[0].model, 'whisper-large-v3');
  cfg = { apiKey: 'gsk_x' }; await p.transcribe({ audio: new Uint8Array([1]) });
  assert.equal(seen[1].model, 'whisper-large-v3-turbo');
  const thrower = new S.GroqSttProvider(() => ({ apiKey: 'k' }), async () => { throw new Error('boom'); });
  assert.deepEqual(await thrower.transcribe({ audio: new Uint8Array([1]) }), { ok: false, error: 'boom' });
});

// ---------------------------------------------------------------- renderer capture (fake mic)

function captureRig({ deny = false } = {}) {
  const sent = []; const tracks = []; const recs = []; let open = null;
  const handle = C.createDictationCapture({
    getUserMedia: () => new Promise((res, rej) => { open = { res: () => { const t = { stopped: false, stop() { this.stopped = true; } }; tracks.push(t); res({ getTracks: () => [t] }); }, rej }; if (deny) rej(Object.assign(new Error('x'), { name: 'NotAllowedError' })); }),
    makeRecorder: () => { const r = { mimeType: 'audio/webm;codecs=opus', ondataavailable: null, onstop: null, started: false, start() { this.started = true; }, stop() { this.ondataavailable?.({ data: new Blob([new Uint8Array([9, 9])]) }); this.onstop?.(); } }; recs.push(r); return r; },
    pickMime: () => 'audio/webm;codecs=opus',
    send: (p) => { sent.push(p); },
  });
  return { handle, sent, tracks, recs, openMic: () => open.res() };
}

test('capture: start/stop sends one clip for the session and releases the mic', async () => {
  const c = captureRig();
  c.handle({ op: 'start', session: 4 }); c.openMic(); await flush();
  assert.equal(c.recs[0].started, true);
  c.handle({ op: 'stop', session: 4 }); await flush(); await flush();
  assert.equal(c.sent.length, 1); assert.equal(c.sent[0].session, 4); assert.equal(c.sent[0].mimeType, 'audio/webm');
  assert.equal(c.sent[0].audio.byteLength, 2);
  assert.equal(c.tracks[0].stopped, true, 'the mic is released');
});

test('capture: cancel sends nothing; stop before the mic opened sends an error, never a clip', async () => {
  const c = captureRig();
  c.handle({ op: 'start', session: 1 }); c.openMic(); await flush();
  c.handle({ op: 'cancel', session: 1 }); await flush(); await flush();
  assert.deepEqual(c.sent, []); assert.equal(c.tracks[0].stopped, true);
  const e = captureRig();
  e.handle({ op: 'start', session: 2 }); e.handle({ op: 'stop', session: 2 }); e.openMic(); await flush(); await flush();
  assert.equal(e.recs.length, 0, 'no recorder was started');
  assert.deepEqual(e.sent, [{ session: 2, error: 'released before the microphone opened' }]);
  assert.equal(e.tracks[0].stopped, true);
  const x = captureRig();
  x.handle({ op: 'start', session: 3 }); x.handle({ op: 'cancel', session: 3 }); x.openMic(); await flush();
  assert.deepEqual(x.sent, []); assert.equal(x.tracks[0].stopped, true);
  const w = captureRig();
  w.handle({ op: 'start', session: 5 }); w.openMic(); await flush();
  w.handle({ op: 'stop', session: 6 }); await flush();
  assert.deepEqual(w.sent, [], 'a stop for another session is ignored');
});

test('capture: a denied mic reports the reason', async () => {
  const c = captureRig({ deny: true });
  c.handle({ op: 'start', session: 7 }); await flush();
  assert.deepEqual(c.sent, [{ session: 7, error: 'microphone permission denied' }]);
});

// ---------------------------------------------------------------- wiring pins

test('wiring: the clip is accepted only from the app window that was asked to record', () => {
  const src = read('src/main/index.ts');
  assert.match(src, /ipcMain\.handle\('dictation:audio', \(evt, arg: unknown\) => \{\r?\n\s*if \(!ledgerUiSender\(evt\) \|\| !dictationTarget \|\| evt\.sender !== dictationTarget\) return \{ ok: false/);
  assert.match(src, /supported: process\.platform === 'win32' && !DEV_HIDDEN,/, 'never in a hidden run, never off Windows');
  assert.match(src, /onApplied: \(s\) => \{ dictation\.apply\(s\.enabled && s\.dictation\); \}/, 'dictation needs the blob AND its own toggle');
  assert.match(src, /\|\| \(cfg\.blobEnabled === true && cfg\.blobDictation === true\)/, 'the mic gate opens for dictation only while it is on');
  assert.match(src, /try \{ dictation\.dispose\(\); \} catch/, 'quit kills the helper');
  const blob = read('src/main/blobOverlay.ts');
  assert.match(blob, /setDictationStatus\(s: DictationStatus\): void \{\r?\n\s*this\.dictation = s;\r?\n\s*this\.push\(\);/);
  const pre = read('src/preload/blob.ts');
  assert.doesNotMatch(pre, /dictation/, 'the overlay preload gains nothing: it only shows the state main pushes');
});

// ---------------------------------------------------------------- fixup 1: F1, F2, nits
test('F1: the transcript is typed only into the window that was in front at chord-down', async () => {
  const r = rig();
  r.ctl.apply(true); await flush();
  r.down({ hwnd: '111' }); r.advance(1200); r.up();
  const s1 = r.calls.capture.find((c) => c[0] === 'start')[1];
  r.audio(s1); await flush(); await flush();
  assert.deepEqual(r.calls.typedInto, ['111'], 'type names the chord-down window');
  r.down({ hwnd: '222' }); r.advance(1200); r.up();
  r.audio(r.calls.capture.filter((c) => c[0] === 'start').at(-1)[1]); await flush(); await flush();
  assert.deepEqual(r.calls.typedInto, ['111', '222'], 'each session uses its own window');
});

test('F1: a refused focus check, or a down with no usable window, types nothing and says why', async () => {
  for (const reply of [{ ok: false, op: 'type', error: 'focus changed' }, { ok: false, op: 'type', error: 'no target window' }]) {
    const r = rig({ typeReply: reply });
    r.ctl.apply(true); await flush();
    const s = await holdAndRelease(r); r.audio(s); await flush(); await flush();
    assert.equal(r.ctl.current().state, 'error');
    assert.equal(r.ctl.current().message, SD.DICTATION_COPY.focusChanged, reply.error);
  }
  for (const info of [{}, { hwnd: '' }, { hwnd: '0' }, { hwnd: 'abc' }, { hwnd: 42 }]) {
    const r = rig();
    r.ctl.apply(true); await flush();
    r.down(info); r.advance(1200); r.up();
    const s = r.calls.capture.find((c) => c[0] === 'start')[1];
    r.audio(s); await flush(); await flush();
    assert.deepEqual(r.calls.typed, [], `no type call for ${JSON.stringify(info)}`);
    assert.equal(r.ctl.current().message, SD.DICTATION_COPY.focusChanged);
  }
});

test('F2: a capture error while still listening is shown at once; the release then does nothing', async () => {
  const r = rig();
  r.ctl.apply(true); await flush();
  r.down(); r.advance(100);
  const s = r.calls.capture.find((c) => c[0] === 'start')[1];
  assert.equal(r.audio(s + 1, { audio: undefined, error: 'microphone permission denied' }), false, 'a stale session error is refused');
  assert.equal(r.audio(s, { audio: undefined }), false, 'a clip without an error is not accepted while listening');
  assert.equal(r.ctl.current().state, 'listening');
  assert.equal(r.audio(s, { audio: undefined, error: 'microphone permission denied' }), true);
  assert.deepEqual(r.ctl.current(), { state: 'error', message: 'microphone permission denied', chord: SD.DICTATION_CHORD });
  assert.ok(r.calls.capture.some((c) => c[0] === 'cancel' && c[1] === s), 'the recording is cancelled');
  assert.equal(r.timers.has(D.DICTATION_MAX_HOLD_MS), false, 'the max-hold timer is cleared');
  r.advance(1500); r.up();
  assert.equal(r.calls.capture.some((c) => c[0] === 'stop'), false, 'the later release does not ask for a clip');
  assert.equal(r.timers.has(D.DICTATION_AUDIO_WAIT_MS), false, 'and does not wait 15 s for one');
  assert.equal(r.audio(s, { audio: undefined, error: 'again' }), false, 'one result per session');
  assert.equal(r.calls.stt.length, 0); assert.deepEqual(r.calls.typed, []);
});

test('nit: a clip over Groq\'s 25 MB limit is refused before any upload', async () => {
  const r = rig();
  r.ctl.apply(true); await flush();
  const s = await holdAndRelease(r);
  assert.equal(r.ctl.onAudio({ session: s, audio: { byteLength: SD.DICTATION_MAX_AUDIO_BYTES + 1 }, mimeType: 'audio/webm' }), true);
  assert.equal(r.calls.stt.length, 0, 'no network call');
  assert.equal(r.ctl.current().message, SD.DICTATION_COPY.tooLarge);
  const ok = rig(); ok.ctl.apply(true); await flush();
  const s2 = await holdAndRelease(ok);
  ok.ctl.onAudio({ session: s2, audio: { byteLength: SD.DICTATION_MAX_AUDIO_BYTES }, mimeType: 'audio/webm' });
  assert.equal(ok.calls.stt.length, 1, 'exactly the limit is still sent');
  assert.equal(SD.DICTATION_MAX_AUDIO_BYTES, 25 * 1024 * 1024);
});

test('nit: the length cap never splits a surrogate pair; C1 controls become spaces', () => {
  const emoji = String.fromCodePoint(0x1f600);
  const cut = SD.normalizeTranscript('a'.repeat(SD.DICTATION_MAX_CHARS - 1) + emoji + 'tail');
  assert.equal(cut, 'a'.repeat(SD.DICTATION_MAX_CHARS - 1), 'the half emoji is dropped, not typed');
  const whole = SD.normalizeTranscript('a'.repeat(SD.DICTATION_MAX_CHARS - 2) + emoji + 'tail');
  assert.equal(whole, 'a'.repeat(SD.DICTATION_MAX_CHARS - 2) + emoji, 'a pair that fits is kept');
  for (const code of [0x80, 0x85, 0x90, 0x9b, 0x9f]) assert.equal(SD.normalizeTranscript(`x${String.fromCharCode(code)}y`), 'x y', `U+${code.toString(16)}`);
  assert.equal(SD.normalizeTranscript('caf' + String.fromCharCode(0xe9)), 'caf' + String.fromCharCode(0xe9), 'Latin-1 letters are kept');
});

test('BLOB-GAZE: focusPoint() is the chord-down focus during a session and null when idle', async () => {
  const r = rig({ stt: { ok: true, text: 'hi' } });
  r.ctl.apply(true); await flush();
  assert.equal(r.ctl.focusPoint(), null, 'idle: none');
  r.down({ hwnd: '4242', focus: { x: 120, y: 340, kind: 'caret' } });
  assert.deepEqual(r.ctl.focusPoint(), { x: 120, y: 340, kind: 'caret' });
  r.advance(1500); r.up();
  const session = r.calls.capture[0][1];
  r.audio(session); await flush(); await flush();
  assert.equal(r.ctl.current().state, 'ready');
  assert.equal(r.ctl.focusPoint(), null, 'back to idle: the eyes return to the cursor');
  r.down({ hwnd: '4242' });
  assert.equal(r.ctl.focusPoint(), null, 'a down without a point gives none (no stale point)');
});
