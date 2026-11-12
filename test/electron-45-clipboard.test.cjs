/* Electron 45: Electron 44 made clipboard access asynchronous and removed the
 * synchronous/image helpers. Keep the main/preload boundary on the supported API. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'src', 'main', 'index.ts'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src', 'preload', 'index.ts'), 'utf8');
const terminalPool = fs.readFileSync(path.join(root, 'src', 'renderer', 'src', 'components', 'terminalPool.ts'), 'utf8');
const clipboardHandlers = fs.readFileSync(path.join(root, 'src', 'main', 'clipboard.ts'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const builder = fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8');

test('Electron rebuild tooling is pinned and better-sqlite3 is on the Node 24 line', () => {
  assert.equal(pkg.devDependencies.electron, '45.3.0');
  assert.equal(pkg.devDependencies['@electron/rebuild'], '4.2.1');
  assert.equal(pkg.dependencies['better-sqlite3'], '13.0.3');
  // Guppy's install-script policy may deliberately skip dependency lifecycle
  // scripts, so our root lifecycle installs Electron before rebuilding addons.
  assert.match(pkg.scripts.postinstall, /node node_modules\/electron\/install\.js/);
  assert.match(pkg.scripts.postinstall, /electron-rebuild -f/);
  assert.match(builder, /node_modules\/better-sqlite3\/\*\*/);
});

test('Electron 45 clipboard IPC uses the promise-only main-process API', () => {
  assert.match(main, /copyClipboardText\(clipboard, text\)/);
  assert.match(main, /readClipboardText\(clipboard\)/);
  assert.match(main, /readClipboardPng\(clipboard\)/);
  assert.match(clipboardHandlers, /await clipboard\.writeText\(text\)/);
  assert.match(clipboardHandlers, /await clipboard\.readText\(\)/);
  assert.match(clipboardHandlers, /await clipboard\.read\(\)[\s\S]*?getType\('image\/png'\)[\s\S]*?arrayBuffer\(\)/);
  assert.doesNotMatch(main, /clipboard\.readImage\(|app:readClipboardSync|sendSync/);
});

test('sandboxed preload keeps the async bridge; shortcut stays native and right-click is explicit', () => {
  assert.match(preload, /readClipboard: \(\): Promise<string> =>\s*ipcRenderer\.invoke\('app:readClipboard'\)/);
  assert.doesNotMatch(preload, /readClipboardSync:|app:readClipboardSync/);
  assert.doesNotMatch(terminalPool, /readClipboardSync|paste-sync/);
  assert.match(terminalPool, /key === 'v' && ev\.shiftKey\)[\s\S]*?return true;/);
  assert.match(terminalPool, /host\.addEventListener\('contextmenu',[\s\S]*?ev\.preventDefault\(\)[\s\S]*?pasteClipboard\(\)/);
  assert.match(terminalPool, /window\.cth\.readClipboard\(\)\.then\([\s\S]*?markHumanOrigin\(ptyId, 'paste-async'\)/);
});

test('Electron harness bridge fixtures expose no removed synchronous clipboard API', () => {
  const scenarios = path.join(root, 'test', 'electron-harness', 'scenarios');
  for (const file of fs.readdirSync(scenarios).filter((name) => name.endsWith('.ts'))) {
    assert.doesNotMatch(fs.readFileSync(path.join(scenarios, file), 'utf8'), /readClipboardSync/,
      `${file} must match Electron 45's promise-only clipboard bridge`);
  }
});

test('Electron 45 display-capture permission is denied until Guppy owns a capture feature', () => {
  assert.match(main, /if \(permission === 'display-capture'\) \{\s*callback\(false\);\s*return;\s*\}/);
});
