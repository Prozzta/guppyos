'use strict';
require('./tools/own-job.cjs');
/**
 * SCHEME-DROP (1.1.87, the Human 2026-10-15): guppy:// is the only link scheme. Up to 1.1.86 the app
 * registered munderdifflin:// itself at every start (app.setAsDefaultProtocolClient writes
 * HKCU\Software\Classes\munderdifflin, shell\open\command = "<exe>" "%1"), so build/installer.nsh
 * deletes that key on install AND on uninstall, but only when its command runs a Guppy.exe.
 *
 * Static checks pin where the drop runs and that it can only touch that one HKCU key. The compiled
 * checks run makensis on harnesses: the command matcher is run on strings only (no registry), and
 * the drop itself is compiled (with -WX) but never run, so the tests write nothing to the registry.
 * The link behaviour (munderdifflin:// rejected) is in hire-link-scheme-183.test.cjs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'md-scheme-drop-'));
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
let tmpN = 0;
const tmp = (name) => { const d = path.join(tmpRoot, `${name}-${++tmpN}`); fs.mkdirSync(d, { recursive: true }); return d; };

const nsh = read('build/installer.nsh');
const macro = (name) => {
  const m = nsh.match(new RegExp(`^!macro ${name}\\b[^\\n]*\\n([\\s\\S]*?)^!macroend`, 'm'));
  assert.ok(m, `macro ${name}`);
  return m[1];
};

test('installer.nsh: the drop runs on install (customInstall) and on uninstall (customUnInstall)', () => {
  assert.match(macro('customInstall'), /^\s*!insertmacro guppyDropOldScheme$/m);
  assert.match(macro('customUnInstall'), /^\s*!insertmacro guppyDropOldScheme$/m);
  // electron-builder 25.1.8 inserts both hooks (pinned; re-read the templates on a version change).
  const tpl = (rel) => fs.readFileSync(path.join(ROOT, 'node_modules', 'app-builder-lib', 'templates', 'nsis', rel), 'utf8');
  assert.match(tpl('installSection.nsh'), /!ifmacrodef customInstall\r?\n\s+!insertmacro customInstall/);
  assert.match(tpl('uninstaller.nsh'), /!ifmacrodef customUnInstall\r?\n\s+!insertmacro customUnInstall/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'app-builder-lib', 'package.json'), 'utf8')).version, '25.1.8');
});

test('installer.nsh: only HKCU\\Software\\Classes\\munderdifflin, and only after the Guppy.exe check', () => {
  assert.match(nsh, /!ifndef GUPPY_OLD_SCHEME_KEY\n {2}!define GUPPY_OLD_SCHEME_KEY "Software\\Classes\\munderdifflin"\n!endif/,
    'the real key unless a harness sets it');
  const drop = macro('guppyDropOldScheme');
  assert.match(drop, /ReadRegStr \$0 HKCU "\$\{GUPPY_OLD_SCHEME_KEY\}\\shell\\open\\command" ""\n\s+\$\{IfNot\} \$\{Errors\}\n\s+!insertmacro guppyIsGuppyCommand \$0 \$1\n\s+\$\{If\} \$1 == "1"\n\s+DeleteRegKey HKCU "\$\{GUPPY_OLD_SCHEME_KEY\}"\n/);
  // Nothing else in the include deletes or writes registry values.
  assert.deepEqual(nsh.match(/^\s*(DeleteReg\w+|WriteReg\w+)\b.*$/gm).map((l) => l.trim()), ['DeleteRegKey HKCU "${GUPPY_OLD_SCHEME_KEY}"']);
  assert.doesNotMatch(nsh, /HKLM|HKCR|SHCTX|HKEY_/);
});

function nsisTools() {
  const cache = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache', 'nsis');
  if (!fs.existsSync(cache)) return null;
  const nsis = fs.readdirSync(cache).find((d) => /^nsis-\d/.test(d));
  const res = fs.readdirSync(cache).find((d) => /^nsis-resources-/.test(d));
  if (!nsis || !res) return null;
  const makensis = path.join(cache, nsis, 'makensis.exe');
  const plugins = path.join(cache, res, 'plugins', 'x86-unicode');
  return fs.existsSync(makensis) && fs.existsSync(path.join(plugins, 'WinShell.dll')) ? { makensis, plugins } : null;
}
const SKIP = process.platform !== 'win32' || !nsisTools() ? 'needs Windows + electron-builder\'s NSIS cache' : false;

/** Compile a harness with our include; `body` is the Section's lines. Returns the harness dir. */
function compile(body, defines = []) {
  const { makensis, plugins } = nsisTools();
  const dir = tmp('nsis');
  const nsi = path.join(dir, 'harness.nsi');
  fs.writeFileSync(nsi, [
    'Unicode true',
    `!addplugindir /x86-unicode "${plugins}"`,
    '!include LogicLib.nsh',
    'Name "guppy-scheme-drop-harness"',
    `OutFile "${path.join(dir, 'harness.exe')}"`,
    'RequestExecutionLevel user',
    'SilentInstall silent',
    '!define APP_ID "in.munderdiffl.app"',
    '!define APP_DESCRIPTION "harness"',
    ...defines,
    `!include "${path.join(ROOT, 'build', 'installer.nsh')}"`,
    'Section',
    ...body,
    'SectionEnd',
    ''
  ].join('\r\n'));
  const c = spawnSync(makensis, ['-WX', '/V2', '-DAPP_INSTALLER_STORE_FILE=munder-difflin-updater\\installer.exe', nsi],
    { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  assert.equal(c.status, 0, c.stdout + c.stderr);
  return dir;
}

// [command value, is it a Guppy.exe]
const CASES = [
  ['"C:\\Users\\a\\AppData\\Local\\Programs\\Guppy\\Guppy.exe" "%1"', true], // what Electron writes
  ['"C:\\Program Files\\Guppy\\GUPPY.EXE" "%1"', true], // any case
  ['"D:\\Apps\\Guppy.exe"', true], // no argument
  ['C:\\Guppy\\Guppy.exe "%1"', true], // unquoted, no space in the path
  ['"C:\\dev\\node_modules\\electron\\dist\\electron.exe" "C:\\dev\\guppy" "%1"', false], // a dev build
  ['"C:\\Users\\a\\AppData\\Local\\Programs\\Munder Difflin\\Munder Difflin.exe" "%1"', false], // 1.1.81
  ['"C:\\Other\\NotGuppy.exe" "%1"', false],
  ['"C:\\Other\\Guppy.exe.bak" "%1"', false],
  ['"C:\\Other\\app.exe" "C:\\x\\Guppy.exe" "%1"', false], // Guppy.exe only as an argument
  ['"C:\\x\\Guppy.exe', false], // unterminated quote
  ['Guppy.exe "%1"', false], // no folder
  ['C:\\Program Files\\Guppy\\Guppy.exe "%1"', false], // unquoted with a space: not ours to guess
  ['', false],
];

test('compiled: the matcher accepts a command that runs a Guppy.exe and nothing else (strings only, no registry)', { skip: SKIP, timeout: 120_000 }, () => {
  for (const [cmd] of CASES) assert.ok(!cmd.includes('`') && !cmd.includes('$'), cmd);
  const out = path.join(tmpRoot, `match-${++tmpN}.txt`);
  const dir = compile([
    `  FileOpen $9 "${out}" w`,
    ...CASES.flatMap(([cmd]) => [
      `  StrCpy $1 \`${cmd}\``,
      '  !insertmacro guppyIsGuppyCommand $1 $0',
      '  FileWrite $9 "$0,"',
    ]),
    // The registers the macro borrows come back unchanged.
    '  StrCpy $R0 r0',
    '  StrCpy $R4 r4',
    '  StrCpy $1 `"C:\\x\\Guppy.exe" "%1"`',
    '  !insertmacro guppyIsGuppyCommand $1 $0',
    '  FileWrite $9 "$R0$R4"',
    '  FileClose $9',
  ]);
  const r = spawnSync(path.join(dir, 'harness.exe'), ['/S'], { windowsHide: true, timeout: 60_000 });
  assert.equal(r.status, 0);
  assert.equal(fs.readFileSync(out, 'utf8'), CASES.map(([, ok]) => (ok ? '1,' : '0,')).join('') + 'r0r4');
});

test('compiled: the drop builds with -WX (a test key path; compiled only, never run)', { skip: SKIP, timeout: 120_000 }, () => {
  compile(['  !insertmacro guppyDropOldScheme'], ['!define GUPPY_OLD_SCHEME_KEY "Software\\GuppySchemeDropTest\\never-run"']);
});
