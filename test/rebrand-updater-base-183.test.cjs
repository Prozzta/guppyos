'use strict';
/**
 * REBRAND-UPDATER-BASE (1.1.83): the installer stores its differential-update base where the
 * updater looks for it. electron-builder 25.1.8 names the store "<package name>-updater" =
 * munder-difflin-updater (APP_INSTALLER_STORE_FILE, passed as -D on the makensis command line),
 * while app-update.yml says guppy-updater since 1.1.82 (afterPack), and electron-updater takes the
 * base from <updater cache>\installer.exe. So 1.1.82 always downloaded updates in full and left
 * ~218 MB in %LOCALAPPDATA%\munder-difflin-updater per install. build/installer.nsh (included
 * before the template) re-points the define and drops the old base once the new one exists.
 *
 * Static checks pin the electron-builder / electron-updater facts this rests on; the compiled
 * checks run makensis exactly as electron-builder does (-D define + our include first) on a
 * harness, and run the harness /S on FAKE folders. The real installer is never run here.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const NM = path.join(ROOT, 'node_modules');
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'md-updater-base-'));
test.after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
let tmpN = 0;
const tmp = (name) => { const d = path.join(tmpRoot, `${name}-${++tmpN}`); fs.mkdirSync(d, { recursive: true }); return d; };

test('electron-builder / electron-updater facts (pinned): the store follows the package name; the updater reads <cache>\\installer.exe', () => {
  const nsisTarget = fs.readFileSync(path.join(NM, 'app-builder-lib', 'out', 'targets', 'nsis', 'NsisTarget.js'), 'utf8');
  assert.match(nsisTarget, /defines\.APP_INSTALLER_STORE_FILE = `\$\{appInfo\.updaterCacheDirName\}\\\\\$\{builder_util_runtime_1\.CURRENT_APP_INSTALLER_FILE_NAME\}`;/);
  assert.match(nsisTarget, /args\.push\(`-D\$\{name\}=\$\{value\}`\);/, 'defines go on the makensis command line, before any script');
  assert.match(nsisTarget, /scriptGenerator\.include\(customInclude\);/, 'nsis.include is prepended to the template');
  const appInfo = fs.readFileSync(path.join(NM, 'app-builder-lib', 'out', 'appInfo.js'), 'utf8');
  assert.match(appInfo, /get updaterCacheDirName\(\) \{\s+return this\.sanitizedName\.toLowerCase\(\) \+ "-updater";/);
  assert.equal(JSON.parse(read('package.json')).name, 'munder-difflin', 'so the stock store is munder-difflin-updater');
  const inst = fs.readFileSync(path.join(NM, 'app-builder-lib', 'templates', 'nsis', 'include', 'installer.nsh'), 'utf8');
  assert.match(inst, /!insertmacro copyFile "\$EXEPATH" "\$LOCALAPPDATA\\\$\{APP_INSTALLER_STORE_FILE\}"/);
  const updater = fs.readFileSync(path.join(NM, 'electron-updater', 'out', 'AppUpdater.js'), 'utf8');
  assert.match(updater, /oldFile: path\.join\(this\.downloadedUpdateHelper\.cacheDir, oldInstallerFileName\)/);
  assert.match(updater, /const cacheDir = path\.join\(this\.app\.baseCachePath, dirName \|\| this\.app\.name\);/);
  const rt = fs.readFileSync(path.join(NM, 'builder-util-runtime', 'out', 'index.js'), 'utf8');
  assert.match(rt, /CURRENT_APP_INSTALLER_FILE_NAME = "installer\.exe"/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(NM, 'app-builder-lib', 'package.json'), 'utf8')).version, '25.1.8',
    're-read the templates before changing the electron-builder version');
});

test('build/installer.nsh: the store is re-pointed to the SAME folder app-update.yml names (afterPack)', () => {
  const nsh = read('build/installer.nsh');
  assert.match(nsh, /!define GUPPY_UPDATER_DIR "guppy-updater"\n!define GUPPY_OLD_UPDATER_DIR "munder-difflin-updater"\n!ifdef APP_INSTALLER_STORE_FILE\n {2}!undef APP_INSTALLER_STORE_FILE\n {2}!define APP_INSTALLER_STORE_FILE "\$\{GUPPY_UPDATER_DIR\}\\installer\.exe"\n!endif/);
  const after = read('build/afterPack-memory-prune.cjs');
  assert.match(after, /const GUPPY_UPDATER_CACHE = 'guppy-updater';/, 'app-update.yml and the installer name one folder');
  // The redefinition comes before anything else in the include uses it.
  assert.ok(nsh.indexOf('!undef APP_INSTALLER_STORE_FILE') < nsh.indexOf('!macro guppyDropOldUpdaterBase'));
});

test('build/installer.nsh: the old base is dropped only once the new one exists, by explicit names, from customInstall', () => {
  const nsh = read('build/installer.nsh');
  const m = nsh.slice(nsh.indexOf('!macro guppyDropOldUpdaterBase'), nsh.indexOf('!macroend', nsh.indexOf('!macro guppyDropOldUpdaterBase')));
  assert.match(m, /\$\{If\} \$\{FileExists\} "\$\{GUPPY_LOCALAPPDATA\}\\\$\{GUPPY_UPDATER_DIR\}\\installer\.exe"/);
  assert.doesNotMatch(m, /RMDir \/r|\/REBOOTOK/, 'never recursive, never at reboot');
  const deletes = [...m.matchAll(/^\s+(Delete|RMDir) "([^"]+)"/gm)].map((x) => `${x[1]} ${x[2]}`);
  assert.deepEqual(deletes, [
    'Delete ${GUPPY_LOCALAPPDATA}\\${GUPPY_OLD_UPDATER_DIR}\\installer.exe',
    'Delete ${GUPPY_LOCALAPPDATA}\\${GUPPY_OLD_UPDATER_DIR}\\pending\\update-info.json',
    'Delete ${GUPPY_LOCALAPPDATA}\\${GUPPY_OLD_UPDATER_DIR}\\pending\\*.exe',
    'RMDir ${GUPPY_LOCALAPPDATA}\\${GUPPY_OLD_UPDATER_DIR}\\pending',
    'RMDir ${GUPPY_LOCALAPPDATA}\\${GUPPY_OLD_UPDATER_DIR}'
  ]);
  const ci = nsh.slice(nsh.indexOf('!macro customInstall'));
  assert.match(ci, /\$\{if\} \$installMode == "all"\n\s+SetShellVarContext current\n\s+\$\{endif\}\n\s+!insertmacro guppyDropOldUpdaterBase\n\s+\$\{if\} \$installMode == "all"\n\s+SetShellVarContext all/);
  assert.match(nsh, /!ifndef GUPPY_LOCALAPPDATA\n {2}!define GUPPY_LOCALAPPDATA "\$LOCALAPPDATA"\n!endif/, 'the real folder unless a harness sets it');
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

/** Compile a harness the way electron-builder compiles the installer (-D store define, our include
 *  first) and run it silently: it writes the store define it saw and runs the cleanup on `local`. */
function runHarness(local) {
  const { makensis, plugins } = nsisTools();
  const dir = tmp('nsis');
  const out = path.join(dir, 'store.txt');
  const nsi = path.join(dir, 'harness.nsi');
  fs.writeFileSync(nsi, [
    'Unicode true',
    `!addplugindir /x86-unicode "${plugins}"`,
    '!include LogicLib.nsh',
    'Name "guppy-updater-base-harness"',
    `OutFile "${path.join(dir, 'harness.exe')}"`,
    'RequestExecutionLevel user',
    'SilentInstall silent',
    '!define APP_ID "in.munderdiffl.app"',
    '!define APP_DESCRIPTION "harness"',
    `!define GUPPY_LOCALAPPDATA "${local}"`,
    `!include "${path.join(ROOT, 'build', 'installer.nsh')}"`,
    'Section',
    `  FileOpen $0 "${out}" w`,
    '  FileWrite $0 "${APP_INSTALLER_STORE_FILE}"',
    '  FileClose $0',
    '  !insertmacro guppyDropOldUpdaterBase',
    'SectionEnd',
    ''
  ].join('\r\n'));
  // Exactly electron-builder's form: NsisTarget pushes -D<name>=<value> before the script.
  const c = spawnSync(makensis, ['-WX', '/V2', '-DAPP_INSTALLER_STORE_FILE=munder-difflin-updater\\installer.exe', nsi], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  assert.equal(c.status, 0, c.stdout + c.stderr);
  const r = spawnSync(path.join(dir, 'harness.exe'), ['/S'], { windowsHide: true, timeout: 60_000 });
  assert.equal(r.status, 0);
  return fs.readFileSync(out, 'utf8');
}

const put = (file, text = 'x') => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

test('compiled: with electron-builder\'s -D define the store becomes guppy-updater\\installer.exe; with the new base in place the old base and its pending update go', { skip: SKIP, timeout: 120_000 }, () => {
  const local = tmp('local');
  put(path.join(local, 'guppy-updater', 'installer.exe'), 'new base');
  put(path.join(local, 'munder-difflin-updater', 'installer.exe'), 'old base');
  put(path.join(local, 'munder-difflin-updater', 'pending', 'Munder-Difflin-1.1.82-win-x64-setup.exe'));
  put(path.join(local, 'munder-difflin-updater', 'pending', 'update-info.json'));
  assert.equal(runHarness(local), 'guppy-updater\\installer.exe');
  assert.equal(fs.existsSync(path.join(local, 'munder-difflin-updater')), false, 'the old folder is gone');
  assert.equal(fs.readFileSync(path.join(local, 'guppy-updater', 'installer.exe'), 'utf8'), 'new base', 'the new base is untouched');
});

test('compiled: no new base yet: nothing is deleted; a file we do not know keeps the old folder', { skip: SKIP, timeout: 120_000 }, () => {
  const none = tmp('local');
  put(path.join(none, 'munder-difflin-updater', 'installer.exe'), 'old base');
  runHarness(none);
  assert.equal(fs.readFileSync(path.join(none, 'munder-difflin-updater', 'installer.exe'), 'utf8'), 'old base');
  const other = tmp('local');
  put(path.join(other, 'guppy-updater', 'installer.exe'), 'new base');
  put(path.join(other, 'munder-difflin-updater', 'installer.exe'), 'old base');
  put(path.join(other, 'munder-difflin-updater', 'keep.txt'), 'not ours to judge');
  put(path.join(other, 'munder-difflin-updater', 'pending', 'notes.txt'), 'unknown');
  runHarness(other);
  assert.equal(fs.existsSync(path.join(other, 'munder-difflin-updater', 'installer.exe')), false);
  assert.equal(fs.readFileSync(path.join(other, 'munder-difflin-updater', 'keep.txt'), 'utf8'), 'not ours to judge');
  assert.equal(fs.readFileSync(path.join(other, 'munder-difflin-updater', 'pending', 'notes.txt'), 'utf8'), 'unknown');
});

test('compiled: a pending installer that is in use (a 1.1.81 updater runs it) stays; the rest goes', { skip: SKIP, timeout: 120_000 }, () => {
  const local = tmp('local');
  put(path.join(local, 'guppy-updater', 'installer.exe'), 'new base');
  put(path.join(local, 'munder-difflin-updater', 'installer.exe'), 'old base');
  const running = path.join(local, 'munder-difflin-updater', 'pending', 'Munder-Difflin-1.1.83-win-x64-setup.exe');
  put(running, 'running');
  // Exclusive (no FILE_SHARE_DELETE), as NSIS holds its own running exe: a delete fails.
  const fd = fs.openSync(running, fs.constants.O_RDONLY | fs.constants.UV_FS_O_EXLOCK);
  try {
    runHarness(local);
    assert.equal(fs.existsSync(running), true, 'in use: left alone');
    assert.equal(fs.existsSync(path.join(local, 'munder-difflin-updater', 'installer.exe')), false);
  } finally { fs.closeSync(fd); }
});
