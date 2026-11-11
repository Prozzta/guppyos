// BLOB-SETUP-GUIDE Part B: Settings -> Blob groups the set-up guide link, the user's OWN Groq key
// (the same groqApiKey the Voice tab edits) and the overlay settings. Saving the key there must not
// touch Free Flow's on/off or model, so existing configs keep their Voice settings.
require('./tools/own-job.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-blob-settings-'));
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { app: { getPath: () => userData } } };
const { readConfig, writeConfig } = loadTs('src/main/config.ts');
test.after(() => { require('./load-ts.cjs').closeConfigWatchers(); fs.rmSync(userData, { recursive: true, force: true }); });

const MODAL = 'src/renderer/src/components/SettingsModal.tsx';

test('NAV: Blob is its own Settings tab right after General, and renders BlobSection', () => {
  const ui = codeOnly(readSource(MODAL), 'SettingsModal.tsx');
  const nav = JSON.parse(ui.match(/const NAV_SECTIONS: Section\[\] = (\[[^\]]+\])/)[1].replace(/'/g, '"'));
  assert.equal(nav[0], 'General');
  assert.equal(nav[1], 'Blob');
  assert.match(ui, /activeSection === 'Blob' && \(\s*<BlobSection/);
  assert.doesNotMatch(ui, /<BlobSetting \/>/, 'the overlay settings moved out of General into the Blob tab');
  assert.match(codeOnly(readSource('src/renderer/src/components/BlobSection.tsx'), 'BlobSection.tsx'), /<BlobSetting \/>/);
});

test('KEY: the Blob tab saves only apiKey, and shares one draft with the Voice tab', () => {
  const ui = codeOnly(readSource(MODAL), 'SettingsModal.tsx');
  const save = ui.match(/const saveGroqKey = async \(\) => \{[\s\S]*?\n  \};/)[0];
  assert.match(save, /freeflowSetConfig\(\{ apiKey: groqKey \}\)/);
  assert.doesNotMatch(save, /enabled|model/, 'never sends Free Flow on/off or model');
  assert.match(ui, /<BlobSection\s+groqKey=\{groqKey\}\s+setGroqKey=\{setGroqKey\}/, 'same state as the Voice tab');
  assert.match(readSource(MODAL), /Groq API key — stored in main config/, 'the Voice tab still has the key field (mirrored)');
});

test('CONFIG: a key-only save keeps freeflowEnabled and freeflowModel; the handler writes only present fields', () => {
  writeConfig({ freeflowEnabled: false, freeflowModel: 'whisper-large-v3' });
  writeConfig({ groqApiKey: 'gsk_test' });
  const c = readConfig();
  assert.equal(c.groqApiKey, 'gsk_test');
  assert.equal(c.freeflowEnabled, false);
  assert.equal(c.freeflowModel, 'whisper-large-v3');
  const main = readSource('src/main/index.ts');
  const h = main.match(/ipcMain\.handle\('freeflow:setConfig'[\s\S]*?\n\}\);/)[0];
  assert.match(h, /if \(typeof p\.enabled === 'boolean'\) next\.freeflowEnabled/);
  assert.match(h, /if \(typeof p\.model === 'string'\) next\.freeflowModel/);
});

test('GUIDE: the link is the public set-up guide and passes openExternal\'s https-only rule', () => {
  const { BLOB_SETUP_GUIDE_URL } = loadTs('src/shared/blob.ts');
  assert.equal(BLOB_SETUP_GUIDE_URL, 'https://guppyos.com/blob/setup/');
  assert.match(BLOB_SETUP_GUIDE_URL, /^(x-apple\.systempreferences:|https:\/\/)/);
});

test('RENDER: the Blob tab shows the guide button, a hidden key field, the Groq privacy line and the overlay settings', () => {
  const stub = new Proxy({}, { get: () => () => Promise.resolve({}) });
  globalThis.window = globalThis.window || {};
  globalThis.window.cth = stub;
  const React = require('react');
  const { renderToStaticMarkup } = require('react-dom/server');
  const { BlobSection, BLOB_SECTION_COPY } = loadTs('src/renderer/src/components/BlobSection.tsx');
  const html = renderToStaticMarkup(React.createElement(BlobSection, {
    groqKey: 'gsk_x', setGroqKey() {}, showGroqKey: false, setShowGroqKey() {}, onSaveKey() {}, busy: false, note: ''
  }));
  assert.ok(html.includes('data-testid="blob-setup-guide"'));
  assert.ok(html.includes(BLOB_SECTION_COPY.guide));
  assert.match(html, /data-testid="blob-groq-key"[^>]*type="password"|type="password"[^>]*data-testid="blob-groq-key"/);
  assert.match(BLOB_SECTION_COPY.keyHelp, /sends the audio you record to Groq/);
  assert.ok(html.includes(BLOB_SECTION_COPY.keyHelp));
});

test('COPY: the no-key message and the composer hint point to Settings > Blob', () => {
  const { DICTATION_COPY } = loadTs('src/shared/dictation.ts');
  assert.match(DICTATION_COPY.noKey, /Settings > Blob/);
  const comp = readSource('src/renderer/src/components/MessageQueueComposer.tsx');
  assert.ok(comp.includes('Paste it into Settings → Blob → Groq API key'));
  assert.match(comp, /detail: \{ section: 'Blob' \}/);
});
