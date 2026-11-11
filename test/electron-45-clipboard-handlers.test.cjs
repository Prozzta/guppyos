'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const clipboard = loadTs('src/main/clipboard.ts');

test('Electron 45 clipboard handlers await text copy/read and preserve failures', async () => {
  const calls = [];
  const stub = {
    writeText: async (text) => { calls.push(['write', text]); },
    readText: async () => { calls.push(['readText']); return 'copied'; },
    read: async () => []
  };
  assert.deepEqual(await clipboard.copyClipboardText(stub, 'new text'), { ok: true });
  assert.equal(await clipboard.readClipboardText(stub), 'copied');
  assert.deepEqual(calls, [['write', 'new text'], ['readText']]);
  assert.deepEqual(await clipboard.copyClipboardText(stub, 4), { ok: false, error: 'invalid text' });
  assert.equal(await clipboard.readClipboardText({ ...stub, readText: async () => { throw new Error('denied'); } }), '');
});

test('Electron 45 save-image handler reads ClipboardItem PNG bytes and rejects non-images', async () => {
  const png = new Uint8Array([137, 80, 78, 71]).buffer;
  const calls = [];
  const withPng = {
    writeText: async () => {}, readText: async () => '',
    read: async () => [{ types: ['text/plain'] }, {
      types: ['image/png'],
      getType: async (type) => { calls.push(type); return { arrayBuffer: async () => png }; }
    }]
  };
  assert.strictEqual(await clipboard.readClipboardPng(withPng), png);
  assert.deepEqual(calls, ['image/png']);
  assert.equal(await clipboard.readClipboardPng({ ...withPng, read: async () => [{ types: ['text/plain'] }] }), null);
});
