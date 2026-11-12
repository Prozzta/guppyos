'use strict';
// BLOB-MESSAGE: record a message from the blob's ring -> transcribe with the user's own Groq key ->
// pick an agent -> send. Every STT provider here is a fake: no test opens a mic or calls Groq.
require('./tools/own-job.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const M = loadTs('src/main/blobMessage.ts');
const SM = loadTs('src/shared/blobMessage.ts');
const S = loadTs('src/main/stt.ts');
const B = loadTs('src/shared/blob.ts');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

function fakeStt(opts = {}) {
  const calls = [];
  return {
    calls,
    id: 'fake',
    ready: () => (opts.key === false ? { ok: false, error: S.NO_GROQ_KEY } : { ok: true }),
    transcribe: async (req) => { calls.push(req); return opts.reply ?? { ok: true, text: '  hello\r\nworld  ' }; },
  };
}
const clip = (n = 16) => new Uint8Array(n).fill(1);

test('transcribe: a clip goes to the provider once and the transcript comes back normalised', async () => {
  const stt = fakeStt();
  const r = await M.transcribeBlobMessage(stt, { audio: clip(), mimeType: 'audio/webm;codecs=opus' });
  assert.deepEqual(r, { ok: true, text: 'hello\nworld' });
  assert.equal(stt.calls.length, 1);
  assert.equal(stt.calls[0].mimeType, 'audio/webm;codecs=opus');
  assert.equal(stt.calls[0].filename, 'message.webm');
  assert.equal(stt.calls[0].audio.byteLength, 16);
});

test('transcribe: no key, no audio, too large and no speech never reach Groq or fail with plain copy', async () => {
  let stt = fakeStt({ key: false });
  assert.deepEqual(await M.transcribeBlobMessage(stt, { audio: clip() }), { ok: false, error: SM.BLOB_MESSAGE_COPY.noKey });
  assert.equal(stt.calls.length, 0);
  stt = fakeStt();
  for (const bad of [undefined, null, {}, { audio: 'x' }, { audio: [1, 2] }, { audio: new Uint8Array(0) }]) {
    assert.deepEqual(await M.transcribeBlobMessage(stt, bad), { ok: false, error: SM.BLOB_MESSAGE_COPY.noAudio }, JSON.stringify(bad));
  }
  assert.deepEqual(await M.transcribeBlobMessage(stt, { audio: new Uint8Array(SM.BLOB_MESSAGE_MAX_AUDIO_BYTES + 1) }), { ok: false, error: SM.BLOB_MESSAGE_COPY.tooLarge });
  assert.equal(stt.calls.length, 0, 'nothing invalid reaches the provider');
  assert.deepEqual(await M.transcribeBlobMessage(fakeStt({ reply: { ok: true, text: ' \n ' } }), { audio: clip() }), { ok: false, error: SM.BLOB_MESSAGE_COPY.noSpeech });
  assert.deepEqual(await M.transcribeBlobMessage(fakeStt({ reply: { ok: false, error: 'Groq 500' } }), { audio: clip() }), { ok: false, error: 'Groq 500' });
  assert.deepEqual(await M.transcribeBlobMessage(fakeStt({ reply: { ok: false } }), { audio: clip() }), { ok: false, error: SM.BLOB_MESSAGE_COPY.failed });
});

test('transcribe: the real GroqSttProvider without a key refuses before any call', async () => {
  let called = 0;
  const p = new S.GroqSttProvider(() => ({}), async () => { called++; return { ok: true, text: 'x' }; });
  assert.deepEqual(await M.transcribeBlobMessage(p, { audio: clip() }), { ok: false, error: SM.BLOB_MESSAGE_COPY.noKey });
  assert.equal(called, 0);
});

test('shared: five-minute cap, Groq size cap, clock and transcript normalising', () => {
  assert.equal(SM.BLOB_MESSAGE_MAX_MS, 300000);
  assert.equal(SM.BLOB_MESSAGE_MAX_AUDIO_BYTES, 25 * 1024 * 1024);
  assert.equal(SM.formatMessageClock(0), '0:00');
  assert.equal(SM.formatMessageClock(61500), '1:01');
  assert.equal(SM.formatMessageClock(300000), '5:00');
  assert.equal(SM.formatMessageClock(NaN), '0:00');
  assert.equal(SM.normalizeMessageTranscript('a\tb\u0000c  d \r\n\r\n\r\n e\u2028f'), 'a b c d\n\ne\nf');
  assert.equal(SM.normalizeMessageTranscript(7), '');
  const long = SM.normalizeMessageTranscript('x'.repeat(SM.BLOB_MESSAGE_MAX_CHARS - 1) + '\ud83d\ude00');
  assert.equal(long.length, SM.BLOB_MESSAGE_MAX_CHARS - 1, 'never ends on half a surrogate pair');
});

test('wiring pins: app-window-only IPC, shared provider, dialog registered, message no longer coming soon', () => {
  const main = read('src/main/index.ts');
  assert.match(main, /ipcMain\.handle\('blob:message:transcribe', async \(evt, arg: unknown\) => \{\n?\s*if \(!ledgerUiSender\(evt\)\) return/, 'gated on ledgerUiSender (the overlay is refused)');
  assert.match(main, /transcribeBlobMessage\(groqStt, arg\)/);
  assert.match(main, /stt: groqStt,/, 'dictation and messages share one provider (the user\'s own key)');
  assert.doesNotMatch(main, /blob-message-transcribe'[^\n]*text/, 'the log never carries the transcript');
  const pre = read('src/preload/index.ts');
  assert.match(pre, /blobMessageTranscribe:[\s\S]{0,200}ipcRenderer\.invoke\('blob:message:transcribe', arg\)/);
  assert.doesNotMatch(read('src/preload/blob.ts'), /blob:message:transcribe/, 'the overlay preload has no route to it');
  assert.match(read('src/renderer/src/blob/BlobAppDialogs.tsx'), /message: BlobMessageDialog/);
  const dlg = read('src/renderer/src/blob/BlobMessageDialog.tsx');
  assert.match(dlg, /BLOB_MESSAGE_MAX_MS/, 'the recorder stops itself at the cap');
  assert.match(dlg, /blobMessageTranscribe/, 'audio leaves only through Transcribe');
  assert.match(dlg, /sendToAgent\(agent, text\)/, 'sends through the shared picker (the Human\'s queue)');
  assert.doesNotMatch(dlg, /writeFile|localStorage|indexedDB/, 'the audio is never stored');
  assert.equal(B.BLOB_COMING_SOON.includes('message'), false);
});
