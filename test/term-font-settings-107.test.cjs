'use strict';
require('./tools/own-job.cjs');
/**
 * TERM-FONT-SETTINGS-107: the terminal font is a Settings choice (Settings, General, Terminal),
 * not a control in the terminal header. It is saved in config.json as `terminalFont`, applied
 * live to every open terminal of every window, and read back at the next start. The pattern
 * colours toggle sits in the same section, directly under the font list.
 *
 * The app config lives in a temp userData (electron's app.getPath is stubbed). The rendered
 * behaviour on a real xterm (live apply, a failed save, a re-opened section) is in
 * term-font-picker-harness.test.cjs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tfs107-data-'));
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { app: { getPath: () => userData } } };
test.after(() => { require('./load-ts.cjs').closeConfigWatchers(); fs.rmSync(userData, { recursive: true, force: true }); });

const { readConfig, writeConfig } = loadTs('src/main/config.ts');
const FONT_TS = 'src/renderer/src/components/terminalFont.ts';
const FACES = ['JetBrains Mono', 'Martian Mono', 'Cascadia Mono', 'Atkinson Hyperlegible Mono'];
let freshN = 0;
/** What a new app start does (App.tsx): a fresh terminalFont module, set from the config. */
function startApp() {
  const m = loadTs.fromText(FONT_TS, readSource(FONT_TS) + `\n// app start ${++freshN}\n`);
  m.setTerminalFontFace(m.parseTerminalFontFace(readConfig().terminalFont));
  return m;
}
const onDisk = () => JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'));

test('the terminal font is JetBrains Mono until picked; a pick is written to config.json and the next start uses it', () => {
  assert.equal(readConfig().terminalFont, 'JetBrains Mono', 'the default, with no config file');
  assert.equal(startApp().getTerminalFontFace(), 'JetBrains Mono');
  assert.deepEqual([...startApp().TERMINAL_FONT_FACES], FACES, 'the four faces offered, the default first');
  for (const face of [...FACES.slice(1), FACES[0]]) {
    assert.equal(writeConfig({ terminalFont: face }).terminalFont, face, 'what main sends to every window');
    assert.equal(onDisk().terminalFont, face, `${face} is in the file`);
    assert.equal(readConfig().terminalFont, face);
    const app = startApp();
    assert.equal(app.getTerminalFontFace(), face, `restart: ${face}, not the default`);
    assert.equal(app.terminalFontFamily(), `"${face}", Consolas, monospace`);
  }
});

test('saving the font leaves the colours toggle alone, and the reverse; a stored value that is not a face we ship starts as the default and is not rewritten', () => {
  writeConfig({ terminalFont: 'Cascadia Mono', terminalPatternColoring: true });
  writeConfig({ terminalPatternColoring: false });
  assert.equal(onDisk().terminalFont, 'Cascadia Mono');
  assert.equal(onDisk().terminalPatternColoring, false);
  writeConfig({ terminalFont: 'Atkinson Hyperlegible Mono' });
  assert.equal(onDisk().terminalPatternColoring, false);
  assert.equal(onDisk().terminalFont, 'Atkinson Hyperlegible Mono');
  writeConfig({ terminalFont: 'Comic Sans MS' });
  assert.equal(startApp().getTerminalFontFace(), 'JetBrains Mono', 'a hand-edited or retired face');
  assert.equal(onDisk().terminalFont, 'Comic Sans MS', 'reading it does not rewrite the file');
  writeConfig({ terminalFont: 'JetBrains Mono', terminalPatternColoring: true });
});

test('the Settings section shows the stored font in a list of the four faces, with the colours toggle after it', () => {
  const ui = loadTs('src/renderer/src/components/TerminalSetting.tsx');
  const html = (config) => renderToStaticMarkup(React.createElement(ui.TerminalSetting, { config }));
  const options = (h) => [...h.matchAll(/<option value="([^"]*)"( selected="")?>([^<]*)<\/option>/g)].map((m) => [m[1], !!m[2], m[3]]);
  const first = html({});
  assert.deepEqual(options(first), FACES.map((f) => [f, f === 'JetBrains Mono', f]), 'no key: the default is selected');
  assert.equal((first.match(/<select/g) || []).length, 1);
  assert.match(first, /<select[^>]*aria-label="Terminal font"/);
  assert.ok(first.indexOf(ui.TERMINAL_COPY.heading) < first.indexOf('<select'), 'under a Terminal heading');
  assert.equal(ui.TERMINAL_COPY.heading, 'Terminal');
  const toggleAt = first.indexOf('data-terminal-coloring');
  assert.ok(toggleAt > first.indexOf('</select>'), 'the colours toggle comes after the font list');
  assert.ok(first.indexOf(ui.TERMINAL_COPY.coloringLabel) > first.indexOf('</select>') && first.indexOf(ui.TERMINAL_COPY.coloringLabel) < toggleAt);
  assert.match(first.slice(toggleAt), /^data-terminal-coloring=""><button[^>]*>on<\/button>/);
  for (const face of FACES) {
    assert.deepEqual(options(html({ terminalFont: face })).filter((o) => o[1]).map((o) => o[0]), [face]);
  }
  assert.deepEqual(options(html({ terminalFont: 'Comic Sans MS' })).filter((o) => o[1]).map((o) => o[0]), ['JetBrains Mono']);
  const off = html({ terminalPatternColoring: false });
  assert.match(off.slice(off.indexOf('data-terminal-coloring')), /^data-terminal-coloring=""><button[^>]*>off<\/button>/);
  assert.doesNotMatch(first, /role="alert"/);
});

test('the section saves each control under its own key and applies it live; Settings renders it between Capacity and Graphics, once', () => {
  const ui = codeOnly(readSource('src/renderer/src/components/TerminalSetting.tsx'), 'TerminalSetting.tsx');
  assert.match(ui, /setTerminalFontFace\(next\);\s*try \{ await window\.cth\.updateConfig\(\{ terminalFont: next \}\); \}\s*catch \{\s*setFont\(prev\);[\s\S]*?if \(getTerminalFontFace\(\) === next\) setTerminalFontFace\(prev\);\s*setError\(TERMINAL_COPY\.fontFailed\);/,
    'apply, save the font key only, and put both back when the save fails');
  assert.match(ui, /setTerminalPatternColoringEnabled\(next\);\s*try \{ await window\.cth\.updateConfig\(\{ terminalPatternColoring: next \}\); \}/);
  assert.match(ui, /updateConfig\(\{ terminalPatternColoring: next \}\); \}\s*catch \{ setColoring\(!next\); setTerminalPatternColoringEnabled\(!next\); \}/,
    'a colours save that fails puts the toggle and the live colouring back');
  assert.equal((ui.match(/updateConfig\(/g) || []).length, 2, 'two saves, one per control');
  assert.doesNotMatch(ui, /localStorage/);
  const modal = codeOnly(readSource('src/renderer/src/components/SettingsModal.tsx'), 'SettingsModal.tsx');
  assert.equal((modal.match(/<TerminalSetting /g) || []).length, 1);
  const at = modal.indexOf('<TerminalSetting config={config} />');
  assert.ok(at > modal.indexOf('<CapacityDisplaySetting ') && at < modal.indexOf('<GraphicsSetting />'), 'in General, between Capacity and Graphics');
  assert.doesNotMatch(modal, /terminalPatternColoring|setTerminalPatternColoringEnabled|terminalFont\b/, 'the modal keeps no terminal control of its own');
});

test('a pick reaches every window: main broadcasts the saved face, preload relays it, the app applies it and the saved face at start', () => {
  const main = codeOnly(readSource('src/main/index.ts'), 'index.ts');
  assert.match(main, /const next = writeConfig\(patch\);[\s\S]{0,900}?if \(typeof patch\?\.terminalFont === 'string'\) \{\s*for \(const w of BrowserWindow\.getAllWindows\(\)\) \{ try \{ if \(!w\.isDestroyed\(\)\) w\.webContents\.send\('terminal:fontChanged', next\.terminalFont\); \}/,
    'after the write, the SAVED value, to all windows');
  const preload = codeOnly(readSource('src/preload/index.ts'), 'index.ts');
  assert.match(preload, /onTerminalFontChanged: \(cb: \(face: string\) => void\): \(\(\) => void\) => \{\s*const listener = \(_e: IpcRendererEvent, face: string\) => cb\(face\);\s*ipcRenderer\.on\('terminal:fontChanged', listener\);\s*return \(\) => ipcRenderer\.removeListener\('terminal:fontChanged', listener\);/);
  const app = codeOnly(readSource('src/renderer/src/App.tsx'), 'App.tsx');
  assert.match(app, /window\.cth\.getConfig\(\)\.then\(c => \{[\s\S]{0,400}?setTerminalFontFace\(parseTerminalFontFace\(c\.terminalFont\)\);/, 'the saved face at start');
  assert.match(app, /useEffect\(\(\) => window\.cth\.onTerminalFontChanged\(\(face\) => setTerminalFontFace\(parseTerminalFontFace\(face\)\)\), \[\]\);/, 'and on a pick in any window; the unsubscribe is the effect cleanup');
  const config = codeOnly(readSource('src/main/config.ts'), 'config.ts');
  assert.match(config, /\n  terminalFont\?: string;/);
  assert.match(config, /\n  terminalFont: 'JetBrains Mono',/);
});

test('each terminal face maps its weights to its own files: regular text is never drawn from a bold file', () => {
  const css = readSource('src/renderer/src/design/fonts.css');
  const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]).map((b) => [
    (/font-family:\s*"([^"]+)"/.exec(b) || [])[1], Number((/font-weight:\s*(\d+)/.exec(b) || [])[1]),
    (/font-style:\s*(\w+)/.exec(b) || [])[1], (/src:\s*url\('\.\.\/assets\/fonts\/([^']+)'\) format\('woff2'\);/.exec(b) || [])[1]
  ]).filter((f) => FACES.includes(f[0]));
  assert.deepEqual(faces, [
    ['Martian Mono', 400, 'normal', 'martian-mono/MartianMono-StdRg.woff2'],
    ['Martian Mono', 700, 'normal', 'martian-mono/MartianMono-StdBd.woff2'],
    ['JetBrains Mono', 400, 'normal', 'jetbrains-mono/JetBrainsMono-Regular.woff2'],
    ['JetBrains Mono', 500, 'normal', 'jetbrains-mono/JetBrainsMono-Medium.woff2'],
    ['JetBrains Mono', 700, 'normal', 'jetbrains-mono/JetBrainsMono-Bold.woff2'],
    ['Cascadia Mono', 400, 'normal', 'cascadia-mono/CascadiaMono-Regular.woff2'],
    ['Cascadia Mono', 700, 'normal', 'cascadia-mono/CascadiaMono-Bold.woff2'],
    ['Atkinson Hyperlegible Mono', 400, 'normal', 'atkinson-hyperlegible-mono/AtkinsonHyperlegibleMono-Regular.woff2'],
    ['Atkinson Hyperlegible Mono', 700, 'normal', 'atkinson-hyperlegible-mono/AtkinsonHyperlegibleMono-Bold.woff2']
  ]);
});

test('the terminal header has no font control: the size buttons only, as in v1.1.106', () => {
  const view = codeOnly(readSource('src/renderer/src/components/PtyTerminalView.tsx'), 'PtyTerminalView.tsx');
  assert.doesNotMatch(view, /<select|<option/);
  assert.doesNotMatch(view, /useTerminalFontFace|setTerminalFontFace|TERMINAL_FONT_FACES|Terminal font/);
  assert.match(view, /import \{ loadTerminalFont, remeasureTerminalFont, applyTerminalFontSize, terminalFontReady \} from '\.\/terminalFont';/);
  for (const title of ['Zoom out (Cmd -)', 'Zoom in (Cmd +)']) assert.ok(view.includes(`title="${title}"`), title);
  assert.doesNotMatch(codeOnly(readSource(FONT_TS), 'terminalFont.ts'), /useTerminalFontFace|useSyncExternalStore|localStorage/);
});
