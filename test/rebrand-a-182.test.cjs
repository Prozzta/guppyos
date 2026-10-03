'use strict';

/**
 * REBRAND-GUPPY part A (1.1.82, the Human 2026-10-03): the app and its exe become Guppy, the data
 * folder moves to <appData>/Guppy (copied once, never moved), the shortcuts and taskbar pins follow
 * the renamed exe on an in-app update, and the internal names that make it an in-place upgrade stay.
 *
 * Nothing here runs an installer or touches the real profile: the migration runs on temp folders,
 * and the shortcut macro is compiled into a tiny harness (no GUID, no registry, no uninstaller) that
 * only re-targets fake .lnk files in a temp folder.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `rebrand-a-${tag}-`));

const M = loadTs('src/main/userDataMigration.ts');
const { installerUrl, artifactPrefix, GUPPY_ARTIFACTS_FROM } = loadTs('src/shared/updateState.ts');
const { classifyCommand } = loadTs('src/main/heavyJob.ts');

// ── helpers ──────────────────────────────────────────────────────────────────

/** Every file under dir: relative path -> sha256 + mtime (the "never touched" proof). */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { out[path.relative(dir, p) + '/'] = 'dir'; walk(p); continue; }
      const st = fs.statSync(p);
      out[path.relative(dir, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') + '@' + st.mtimeMs;
    }
  };
  walk(dir);
  return out;
}

/** A 1.1.81-shaped userData: config, db, Chromium storage, locks and caches. */
function legacyFixture(appData) {
  const from = path.join(appData, 'munder-difflin');
  const w = (rel, data) => { fs.mkdirSync(path.dirname(path.join(from, rel)), { recursive: true }); fs.writeFileSync(path.join(from, rel), data); };
  w('config.json', JSON.stringify({
    harnessHome: 'C:\\Dunder',
    knowledgeDir: path.join(from, 'knowledge'),
    recentHives: ['C:\\Dunder', path.join(from, 'hives', 'old')],
    nested: { at: path.join(from.toUpperCase(), 'x') },
    sibling: from + '-dev\\keep-me'
  }, null, 2));
  w('harness.db', crypto.randomBytes(4096));
  w('Local Storage/leveldb/000003.log', 'ls-data');
  w('Partitions/agent/Cache/Cache_Data/data_0', 'nested-cache-kept');
  w('memory/store.bin', crypto.randomBytes(2048));
  w('lockfile', 'held by the running app');
  w('Cache/Cache_Data/index', 'top-level cache');
  w('GPUCache/data_1', 'gpu');
  return from;
}

// ── 1. userData migration ────────────────────────────────────────────────────

test('migration: a new user gets <appData>/Guppy with a fresh marker; the next start reads already', () => {
  const appData = tmp('fresh');
  const r = M.migrateUserData(appData);
  assert.equal(r.status, 'fresh');
  assert.equal(r.userData, path.join(appData, 'Guppy'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(appData, 'Guppy', M.MIGRATION_MARKER), 'utf8')).fresh, true);
  assert.equal(fs.existsSync(path.join(appData, 'munder-difflin')), false, 'no old folder is created');
  assert.equal(M.migrateUserData(appData).status, 'already');
});

test('migration: the old folder is COPIED to Guppy (locks and top-level caches left out) and never touched', () => {
  const appData = tmp('copy');
  const from = legacyFixture(appData);
  const before = snapshot(from);
  const r = M.migrateUserData(appData, { version: '1.1.82', platform: 'win32' });
  assert.equal(r.status, 'migrated', r.error);
  const to = path.join(appData, 'Guppy');
  assert.equal(r.userData, to);
  assert.deepEqual(snapshot(from), before, 'the source is byte-for-byte and mtime-for-mtime unchanged');
  assert.equal(fs.existsSync(path.join(appData, M.STAGING_DIR)), false, 'no staging folder is left');
  // the data came across
  for (const rel of ['harness.db', 'Local Storage/leveldb/000003.log', 'memory/store.bin', 'Partitions/agent/Cache/Cache_Data/data_0']) {
    assert.ok(fs.readFileSync(path.join(to, rel)).equals(fs.readFileSync(path.join(from, rel))), rel);
  }
  // locks and the caches Chromium rebuilds did not
  for (const rel of ['lockfile', 'Cache', 'GPUCache']) assert.equal(fs.existsSync(path.join(to, rel)), false, rel);
  // config.json: paths inside the old folder re-pointed (case-insensitive on Windows); others kept
  const cfg = JSON.parse(fs.readFileSync(path.join(to, 'config.json'), 'utf8'));
  assert.equal(cfg.harnessHome, 'C:\\Dunder');
  assert.equal(cfg.knowledgeDir, path.join(to, 'knowledge'));
  assert.deepEqual(cfg.recentHives, ['C:\\Dunder', path.join(to, 'hives', 'old')]);
  assert.equal(cfg.nested.at, to + '\\x');
  assert.equal(cfg.sibling, from + '-dev\\keep-me', 'a sibling folder with the same prefix is not inside the old one');
  assert.deepEqual(r.rewrote.sort(), ['knowledgeDir', 'nested.at', 'recentHives[1]']);
  // the marker
  const marker = JSON.parse(fs.readFileSync(path.join(to, M.MIGRATION_MARKER), 'utf8'));
  assert.equal(marker.from, from);
  assert.equal(marker.version, '1.1.82');
  assert.equal(marker.files, r.files);
  assert.ok(r.files >= 5 && r.bytes > 6000, JSON.stringify(r));
  // and the next start does nothing
  const again = M.migrateUserData(appData, { platform: 'win32' });
  assert.equal(again.status, 'already');
  assert.deepEqual(snapshot(from), before);
});

test('migration: a failed copy keeps the OLD folder for this run, and the next start clears the staging and finishes', () => {
  const appData = tmp('resume');
  const from = legacyFixture(appData);
  const before = snapshot(from);
  const staging = path.join(appData, M.STAGING_DIR);
  const r = M.migrateUserData(appData, {
    copy: (a, b) => { fs.mkdirSync(b, { recursive: true }); fs.writeFileSync(path.join(b, 'half-copied'), 'x'); throw new Error('EBUSY: disk said no'); }
  });
  assert.equal(r.status, 'failed');
  assert.equal(r.userData, from, 'this run uses the old folder, so the user is not dropped into onboarding');
  assert.match(r.error, /EBUSY/);
  assert.equal(fs.existsSync(path.join(appData, 'Guppy')), false, 'no half-made Guppy folder');
  assert.ok(fs.existsSync(staging), 'the partial copy stays in staging only');
  const r2 = M.migrateUserData(appData);
  assert.equal(r2.status, 'migrated', r2.error);
  assert.equal(fs.existsSync(path.join(appData, 'Guppy', 'half-copied')), false, 'the old partial copy was cleared first');
  assert.equal(fs.existsSync(staging), false);
  assert.deepEqual(snapshot(from), before);
});

test('migration: a failure after the copy (rename refused) also falls back and recovers', () => {
  const appData = tmp('rename');
  legacyFixture(appData);
  // Make the rename fail: a FILE named Guppy.migrating cannot be the staging dir, and a file named
  // Guppy appearing mid-way is "in-use". Simulate with a copy that also creates the target.
  const r = M.migrateUserData(appData, {
    copy: (a, b, f) => { fs.cpSync(a, b, { recursive: true, filter: f }); fs.mkdirSync(path.join(appData, 'Guppy')); }
  });
  assert.equal(r.status, 'failed');
  assert.equal(r.userData, path.join(appData, 'munder-difflin'));
  // the foreign Guppy folder (no marker) is never overwritten from now on
  const r2 = M.migrateUserData(appData);
  assert.equal(r2.status, 'in-use');
  assert.equal(fs.readdirSync(path.join(appData, 'Guppy')).length, 0);
});

test('migration: an existing Guppy folder without the marker is never overwritten', () => {
  const appData = tmp('inuse');
  const from = legacyFixture(appData);
  fs.mkdirSync(path.join(appData, 'Guppy'));
  fs.writeFileSync(path.join(appData, 'Guppy', 'theirs.txt'), 'keep');
  const before = snapshot(from);
  const r = M.migrateUserData(appData);
  assert.equal(r.status, 'in-use');
  assert.equal(r.userData, path.join(appData, 'Guppy'));
  assert.deepEqual(fs.readdirSync(path.join(appData, 'Guppy')), ['theirs.txt']);
  assert.deepEqual(snapshot(from), before);
});

test('migration: repointPath matches the folder itself and paths inside it only', () => {
  const from = 'C:\\Users\\u\\AppData\\Roaming\\munder-difflin';
  const to = 'C:\\Users\\u\\AppData\\Roaming\\Guppy';
  assert.equal(M.repointPath(from, from, to, 'win32'), to);
  assert.equal(M.repointPath(from + '\\', from, to, 'win32'), to);
  assert.equal(M.repointPath(from.toLowerCase() + '\\a\\b', from, to, 'win32'), to + '\\a\\b');
  assert.equal(M.repointPath(from + '/a', from, to, 'win32'), to + '/a');
  assert.equal(M.repointPath(from + '-dev\\a', from, to, 'win32'), null);
  assert.equal(M.repointPath('C:\\Dunder', from, to, 'win32'), null);
  assert.equal(M.repointPath('/home/u/.config/munder-difflin/x', '/home/u/.config/munder-difflin', '/home/u/.config/Guppy', 'linux'), '/home/u/.config/Guppy/x');
  assert.equal(M.repointPath('/home/u/.config/Munder-Difflin/x', '/home/u/.config/munder-difflin', '/home/u/.config/Guppy', 'linux'), null, 'case matters off Windows');
});

test('migration wiring (index.ts): before the single-instance lock and the crash reporter; not in a dev-isolated run or the smoke', () => {
  const src = read('src/main/index.ts');
  const at = src.indexOf('userDataMigration = migrateUserData(app.getPath(\'appData\')');
  assert.ok(at > 0, 'the migration runs in index.ts');
  assert.ok(at < src.indexOf('const crashReporterStart = startLocalCrashReporter('), 'before the crash reporter starts');
  assert.ok(at < src.indexOf('const gotInstanceLock = app.requestSingleInstanceLock();'), 'before the single-instance lock (keyed on userData)');
  assert.ok(at > src.indexOf("app.setPath('userData', smokeUserData)"), 'after the smoke/bench decided their own folder');
  const block = src.slice(src.lastIndexOf('\n', at - 200), src.indexOf('\n}\n', at));
  assert.match(block, /if \(!DEV_ISOLATION && !memorySmokeOut && !memoryBenchDir\) \{/);
  assert.match(block, /app\.setPath\('userData', userDataMigration\.userData\);/);
  assert.match(block, /app\.setPath\('sessionData', userDataMigration\.userData\);/);
  assert.match(block, /\[\['crashDumps', 'Crashpad'\], \['logs', 'logs'\]\][\s\S]{0,200}app\.setPath\(key, dir\)/, 'crash dumps and logs follow into the new folder');
  // nothing reads userData between the imports and here except the dev and smoke blocks
  const head = src.slice(0, at);
  const reads = head.split('\n').filter((l) => !/^\s*(\/\/|\*)/.test(l) && l.includes("app.getPath('userData')")).length;   // code lines, not comments
  assert.equal(reads, 1, 'only the dev block reads the default userData before the migration');
  // a dev-isolated run forbids both of Stable's folders
  assert.match(src, /devStableForbidden\.push\(stableGuppyUserData\);/);
  assert.match(src, /const stableGuppyUserData = join\(app\.getPath\('appData'\), USERDATA_DIR\);/);
  // the result is logged once the hive exists
  assert.match(src, /kind: 'userdata-migration'/);
  assert.equal(M.USERDATA_DIR, 'Guppy');
  assert.equal(M.LEGACY_USERDATA_DIR, 'munder-difflin');
});

// ── 2. the build identity ────────────────────────────────────────────────────

test('electron-builder.yml: Guppy name + exe; appId, scheme and 1.1.82 artifact names kept; no nsis.guid', () => {
  const y = read('electron-builder.yml');
  assert.match(y, /^appId: in\.munderdiffl\.app$/m);
  assert.match(y, /^productName: Guppy$/m);
  assert.match(y, /^executableName: Guppy$/m);
  assert.match(y, /^ {2}shortcutName: Guppy$/m);
  assert.match(y, /^ {2}include: build\/installer\.nsh$/m);
  assert.doesNotMatch(y, /^\s*guid:/m, 'the NSIS GUID must keep deriving from appId');
  assert.match(y, /schemes:\n\s+- guppy\n\s+- munderdifflin\n/);
  for (const a of ['Munder-Difflin-${version}-mac-${arch}.${ext}', 'Munder-Difflin-${version}-win-x64-setup.exe',
    'Munder-Difflin-${version}-win-x64-portable.exe', 'Munder-Difflin-${version}-linux-x86_64.AppImage']) {
    assert.ok(y.includes(`artifactName: ${a}`), a);
  }
  assert.doesNotMatch(y.replace(/^#.*$/gm, '').replace(/artifactName: .*$/gm, ''), /Munder Difflin/, 'no user-visible old name left in the builder config');
  assert.equal(JSON.parse(read('package.json')).name, 'munder-difflin', 'package name kept (Electron\'s default userData, the migration source)');
});

test('afterPack: app-update.yml gets updaterCacheDirName guppy-updater', () => {
  const { guppyUpdaterCache, GUPPY_UPDATER_CACHE } = require('../build/afterPack-memory-prune.cjs');
  assert.equal(GUPPY_UPDATER_CACHE, 'guppy-updater');
  const dir = tmp('yml');
  const yml = path.join(dir, 'app-update.yml');
  fs.writeFileSync(yml, 'owner: Prozzta\nrepo: guppyos\nprovider: github\nupdaterCacheDirName: munder-difflin-updater\n');
  guppyUpdaterCache(dir);
  assert.equal(fs.readFileSync(yml, 'utf8'), 'owner: Prozzta\nrepo: guppyos\nprovider: github\nupdaterCacheDirName: guppy-updater\n');
  guppyUpdaterCache(tmp('none'));   // no app-update.yml (a target without the updater): no-op
  fs.writeFileSync(yml, 'owner: Prozzta\n');
  assert.throws(() => guppyUpdaterCache(dir), /no updaterCacheDirName/);
  // the hook runs it for every platform, before the prune's early return
  const src = read('build/afterPack-memory-prune.cjs');
  assert.ok(src.indexOf('guppyUpdaterCache(resources);') < src.indexOf('if (!fs.existsSync(bin)) return;'));
});

// ── 3. shortcuts and pins on an in-app update ────────────────────────────────

const TEMPLATES = path.join(ROOT, 'node_modules', 'app-builder-lib', 'templates', 'nsis');
const tpl = (rel) => fs.readFileSync(path.join(TEMPLATES, rel), 'utf8').replace(/\r\n/g, '\n');

test('electron-builder NSIS (pinned): with a renamed exe the update RECREATES Start menu + desktop shortcuts on Guppy.exe', () => {
  const section = tpl('installSection.nsh');
  assert.match(section, /StrCpy \$appExe "\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}"/);
  // keepShortcuts only when the NEW exe already exists in the old folder: never, for a rename
  assert.match(section, /\$\{if\} \$R1 == "true"\n\s+\$\{andIf\} \$\{FileExists\} "\$appExe"\n\s+StrCpy \$keepShortcuts "true"/);
  assert.match(section, /!insertmacro addStartMenuLink \$keepShortcuts\n!insertmacro addDesktopLink \$keepShortcuts/);
  assert.ok(section.indexOf('!insertmacro customInstall') > section.indexOf('!insertmacro addDesktopLink'), 'customInstall runs after the stock shortcuts');
  // the old uninstaller gets --keep-shortcuts under the same FileExists "$appExe" test, so it deletes the old links
  const util = tpl('include/installUtil.nsh');
  assert.match(util, /\$\{andIf\} \$\{FileExists\} "\$appExe"\n\s+StrCpy \$0 "\$0 --keep-shortcuts"/);
  const un = tpl('uninstaller.nsh');
  assert.match(un, /\$\{ifNot\} \$\{isKeepShortcuts\}[\s\S]{0,200}Delete "\$oldDesktopLink"[\s\S]{0,200}Delete "\$oldStartMenuLink"/);
  // keepShortcuts false: a fresh link aimed at $appExe with the app's AUMID
  const inst = tpl('include/installer.nsh');
  assert.match(inst, /\$\{if\} \$keepShortcuts {2}== "false"[\s\S]{0,200}CreateShortCut "\$newStartMenuLink" "\$appExe"[\s\S]{0,120}WinShell::SetLnkAUMI "\$newStartMenuLink" "\$\{APP_ID\}"/);
  assert.match(inst, /\$\{if\} \$keepShortcuts == "false"\n\s+CreateShortCut "\$newDesktopLink" "\$appExe"[\s\S]{0,80}WinShell::SetLnkAUMI "\$newDesktopLink" "\$\{APP_ID\}"/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'app-builder-lib', 'package.json'), 'utf8')).version, '25.1.8',
    'the analysis above is of app-builder-lib 25.1.8: re-read the templates before changing the version');
});

test('build/installer.nsh: customInstall re-targets old-exe links in the pin folder, desktop and Start menu', () => {
  const nsh = read('build/installer.nsh');
  assert.match(nsh, /!macro customInstall\n\s+!insertmacro guppyRetargetLinks "\$\{GUPPY_PIN_DIR\}"\n\s+!insertmacro guppyRetargetLinks "\$DESKTOP"\n\s+!insertmacro guppyRetargetLinks "\$SMPROGRAMS"/);
  assert.match(nsh, /!define GUPPY_PIN_DIR "\$APPDATA\\Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar"/);
  assert.match(nsh, /\$\{AndIf\} \$3 == "\$INSTDIR\\\$\{GUPPY_OLD_EXE\}"/, 'only links aimed at the old exe in THIS install folder');
  assert.match(nsh, /CreateShortCut "\$\{DIR\}\\\$1" "\$appExe"/, 'same file name, new target');
  assert.match(nsh, /WinShell::SetLnkAUMI "\$\{DIR\}\\\$1" "\$\{APP_ID\}"/);
  // REBRAND-UPDATER-BASE (1.1.83) adds a cleanup macro that deletes; the re-target macro still deletes nothing.
  const retarget = nsh.slice(nsh.indexOf('!macro guppyRetargetLinks'), nsh.indexOf('!macroend', nsh.indexOf('!macro guppyRetargetLinks')));
  assert.ok(retarget.length > 200);
  assert.doesNotMatch(retarget, /WriteReg|DeleteReg|RMDir|Delete "/, 'the macro writes no registry and deletes nothing');
  assert.doesNotMatch(nsh, /WriteReg|DeleteReg/, 'the include writes no registry');
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

const ps = (script, env) => spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
  { env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
const makeLnk = (lnk, target) => assert.equal(ps('$s=(New-Object -ComObject WScript.Shell).CreateShortcut($env:L); $s.TargetPath=$env:T; $s.Save()', { L: lnk, T: target }).status, 0);
const lnkTarget = (lnk) => ps('[Console]::Out.Write((New-Object -ComObject WScript.Shell).CreateShortcut($env:L).TargetPath)', { L: lnk }).stdout;

test('build/installer.nsh, compiled and run on fake links: the pin to the old exe is re-aimed; others are left alone', { skip: process.platform !== 'win32' || !nsisTools() ? 'needs Windows + electron-builder\'s NSIS cache' : false, timeout: 120_000 }, () => {
  const { makensis, plugins } = nsisTools();
  const dir = tmp('nsis');
  const inst = path.join(dir, 'Programs', 'Munder Difflin');
  const pins = path.join(dir, 'pins');
  fs.mkdirSync(inst, { recursive: true });
  fs.mkdirSync(pins);
  const oldExe = path.join(inst, 'Munder Difflin.exe');
  makeLnk(path.join(pins, 'Munder Difflin.lnk'), oldExe);                                    // the real pin
  makeLnk(path.join(pins, 'Munder Difflin (2).lnk'), oldExe.toUpperCase());                   // a second one, other case
  makeLnk(path.join(pins, 'Munder Difflin portable.lnk'), path.join(dir, 'Downloads', 'Munder-Difflin-1.1.81-win-x64-portable.exe'));
  makeLnk(path.join(pins, 'Notepad.lnk'), oldExe);                                             // not ours by name
  const nsi = path.join(dir, 'harness.nsi');
  fs.writeFileSync(nsi, [
    'Unicode true',
    `!addplugindir /x86-unicode "${plugins}"`,
    '!include LogicLib.nsh',
    'Name "guppy-retarget-harness"',
    `OutFile "${path.join(dir, 'harness.exe')}"`,
    'RequestExecutionLevel user',
    'SilentInstall silent',
    '!define APP_ID "in.munderdiffl.app"',
    '!define APP_DESCRIPTION "harness"',
    'Var appExe',
    `!include "${path.join(ROOT, 'build', 'installer.nsh')}"`,
    'Section',
    `  StrCpy $INSTDIR "${inst}"`,
    '  StrCpy $appExe "$INSTDIR\\Guppy.exe"',
    `  !insertmacro guppyRetargetLinks "${pins}"`,
    'SectionEnd',
    ''
  ].join('\r\n'));
  const c = spawnSync(makensis, ['/V2', nsi], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  assert.equal(c.status, 0, c.stdout + c.stderr);
  const r = spawnSync(path.join(dir, 'harness.exe'), ['/S'], { windowsHide: true, timeout: 60_000 });
  assert.equal(r.status, 0);
  const guppy = path.join(inst, 'Guppy.exe');
  assert.equal(lnkTarget(path.join(pins, 'Munder Difflin.lnk')).toLowerCase(), guppy.toLowerCase());
  assert.equal(lnkTarget(path.join(pins, 'Munder Difflin (2).lnk')).toLowerCase(), guppy.toLowerCase());
  assert.match(lnkTarget(path.join(pins, 'Munder Difflin portable.lnk')), /portable\.exe$/, 'a pin of another copy is not touched');
  assert.equal(lnkTarget(path.join(pins, 'Notepad.lnk')).toLowerCase(), oldExe.toLowerCase(), 'only Munder Difflin*.lnk are considered');
  assert.deepEqual(fs.readdirSync(pins).sort(), ['Munder Difflin (2).lnk', 'Munder Difflin portable.lnk', 'Munder Difflin.lnk', 'Notepad.lnk'], 'same file names: the pins stay put');
});

// ── 4. everything else that names the exe or the artifacts ───────────────────

test('heavyJob: the app exe run as Node is recognised under both names', () => {
  for (const exe of ['"Guppy.exe"', 'Guppy', '"Munder Difflin.exe"']) {
    assert.equal(classifyCommand(`${exe} --native-memory-bench=C:/t`).kind, 'bench', exe);
  }
});

test('installerUrl: Munder-Difflin-* up to 1.1.82, Guppy-* from 1.1.83', () => {
  assert.equal(GUPPY_ARTIFACTS_FROM, '1.1.83');
  const u = (v, p = 'win32', a = 'x64') => installerUrl(v, p, a).replace('https://github.com/Prozzta/guppyos/releases/download/', '');
  assert.equal(u('1.1.81'), 'v1.1.81/Munder-Difflin-1.1.81-win-x64-setup.exe');
  assert.equal(u('v1.1.82'), 'v1.1.82/Munder-Difflin-1.1.82-win-x64-setup.exe');
  assert.equal(u('1.1.83'), 'v1.1.83/Guppy-1.1.83-win-x64-setup.exe');
  assert.equal(u('1.2.0', 'darwin', 'arm64'), 'v1.2.0/Guppy-1.2.0-mac-arm64.dmg');
  assert.equal(u('2.0.0', 'linux'), 'v2.0.0/Guppy-2.0.0-linux-x86_64.AppImage');
  assert.equal(u('0.5.0-beta.1', 'darwin', 'arm64'), 'v0.5.0-beta.1/Munder-Difflin-0.5.0-beta.1-mac-arm64.dmg');
  assert.equal(artifactPrefix('1.1.83-beta.1'), 'Guppy');
  assert.equal(artifactPrefix('not-a-version'), 'Munder-Difflin');
});

test('check-release-links: Prozzta/guppyos, and electron-builder.yml makes the names the app links to', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'check-release-links.cjs')], { encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Prozzta\/guppyos/);
  const src = read('tools/check-release-links.cjs');
  assert.doesNotMatch(src.replace(/^\s*\*.*$/gm, ''), /chaitanyagiri/, 'no upstream repository in the code');
  const links = require('../tools/check-release-links.cjs');
  assert.equal(links.prefixFor('1.1.82'), 'Munder-Difflin');
  assert.equal(links.prefixFor('1.1.83'), 'Guppy');
  for (const v of ['1.1.82', '1.1.83', '1.3.0']) assert.equal(links.prefixFor(v), artifactPrefix(v), `the checker and the app agree at ${v}`);
});

test('packaged canaries + layer-b: the exe is Guppy.exe (old name still found); Guppy\'s live paths are protected', () => {
  for (const f of ['test/tools/packaged-condense-canary.cjs', 'test/tools/packaged-wake-canary.cjs']) {
    assert.match(read(f), /const APP_EXE = \['Guppy\.exe', 'Munder Difflin\.exe'\]/, f);
  }
  const lb = read('test/tools/layer-b-run.cjs');
  for (const p of ["path.join(appData, 'Guppy')", "path.join(localAppData, 'Programs', 'Guppy')", "path.join(localAppData, 'guppy-updater')",
    "path.join(appData, 'munder-difflin')", "path.join(localAppData, 'Programs', 'Munder Difflin')"]) assert.ok(lb.includes(p), p);
  assert.equal(lb.split('/munder difflin|guppy/i.test(').length - 1, 3);
});

// ── 5. Jim's audit: B1 (Open at login), n2 (start race), n3 (afterPack call), icon title ─────

const L = loadTs('src/main/loginItemRename.ts');
const INSTALL = 'C:\\Users\\u\\AppData\\Local\\Programs\\Munder Difflin';
const NEW_EXE = INSTALL + '\\Guppy.exe';
const OLD_EXE = INSTALL + '\\Munder Difflin.exe';

/** A stub of Electron's Windows login items: Run values by name; `get` reads ours (or, with
 *  anyName, any value: the case of an old entry under a different value name). */
function loginStub(values, { name = 'in.munderdiffl.app', anyName = false } = {}) {
  const calls = [];
  return {
    values, calls,
    getLoginItemSettings(o = {}) {
      const p = o.path ?? NEW_EXE;
      return { openAtLogin: anyName ? Object.values(values).includes(p) : values[name] === p };
    },
    setLoginItemSettings(o) {
      calls.push(o);
      const p = o.path ?? NEW_EXE;
      if (o.openAtLogin) { values[name] = p; return; }
      for (const [k, v] of Object.entries(values)) if (v === p && (anyName || k === name)) delete values[k];
    }
  };
}

test('B1: an Open-at-login entry for the old exe moves to Guppy.exe (same value name: one rewrite)', () => {
  const app = loginStub({ 'in.munderdiffl.app': OLD_EXE });
  assert.equal(L.carryLoginItem(app, NEW_EXE, { platform: 'win32', packaged: true }), 'moved');
  assert.deepEqual(app.values, { 'in.munderdiffl.app': NEW_EXE });
  assert.deepEqual(app.calls, [{ openAtLogin: true }], 'the old value is not removed separately when the name is the same');
  assert.equal(app.getLoginItemSettings().openAtLogin, true, 'the toggle reads on again');
  assert.equal(L.carryLoginItem(app, NEW_EXE, { platform: 'win32', packaged: true }), 'none', 'idempotent');
});

test('B1: an old entry under a different value name is turned off after ours is on', () => {
  const app = loginStub({ 'munder-difflin': OLD_EXE }, { name: 'in.munderdiffl.app', anyName: true });
  assert.equal(L.carryLoginItem(app, NEW_EXE, { platform: 'win32', packaged: true }), 'moved');
  assert.deepEqual(app.values, { 'in.munderdiffl.app': NEW_EXE });
  assert.deepEqual(app.calls, [{ openAtLogin: true }, { openAtLogin: false, path: OLD_EXE }]);
});

test('B1: nothing happens without an old entry, off Windows, unpackaged, or when still running the old exe', () => {
  const none = loginStub({});
  assert.equal(L.carryLoginItem(none, NEW_EXE, { platform: 'win32', packaged: true }), 'none');
  assert.deepEqual(none.calls, []);
  const other = loginStub({ 'in.munderdiffl.app': 'D:\\elsewhere\\Munder Difflin.exe' });
  assert.equal(L.carryLoginItem(other, NEW_EXE, { platform: 'win32', packaged: true }), 'none', 'another folder\'s entry is not ours');
  for (const [execPath, o] of [[NEW_EXE, { platform: 'darwin', packaged: true }], [NEW_EXE, { platform: 'win32', packaged: false }], [OLD_EXE, { platform: 'win32', packaged: true }]]) {
    const app = loginStub({ 'in.munderdiffl.app': OLD_EXE });
    assert.equal(L.carryLoginItem(app, execPath, o), 'skipped');
    assert.deepEqual(app.calls, []);
  }
});

test('B1 wiring: index.ts carries the login item on every Stable start, packaged only, and logs a move', () => {
  const src = read('src/main/index.ts');
  assert.match(src, /if \(!DEV_ISOLATION\) \{\n\s+try \{\n\s+if \(carryLoginItem\(app, process\.execPath, \{ packaged: app\.isPackaged \}\) === 'moved'\) hive\.appendLog\(\{ kind: 'login-item-moved'/);
});

test('n2: a second start never copies at once or clears a live staging folder: it waits and uses the result', () => {
  const appData = tmp('race');
  const from = legacyFixture(appData);
  const before = snapshot(from);
  const staging = path.join(appData, M.STAGING_DIR);
  fs.mkdirSync(staging);
  fs.writeFileSync(path.join(staging, 'being-copied'), 'by the first start');
  fs.writeFileSync(path.join(appData, M.MIGRATION_LOCK), '{"pid":1}');          // the first start holds the lock
  // it does not finish in time: the second falls back to the old folder, touching nothing
  const busy = M.migrateUserData(appData, { lockWaitMs: 300, sleep: () => {} });
  assert.equal(busy.status, 'busy');
  assert.equal(busy.userData, from);
  assert.ok(fs.existsSync(path.join(staging, 'being-copied')), 'the live staging folder is not cleared');
  assert.ok(fs.existsSync(path.join(appData, M.MIGRATION_LOCK)), 'nor its lock');
  // it finishes while we wait: the second uses its folder
  let n = 0;
  const waited = M.migrateUserData(appData, { lockWaitMs: 5000, sleep: () => {
    if (++n === 3) { fs.renameSync(staging, path.join(appData, 'Guppy')); fs.writeFileSync(path.join(appData, 'Guppy', M.MIGRATION_MARKER), '{}'); fs.unlinkSync(path.join(appData, M.MIGRATION_LOCK)); }
  } });
  assert.equal(waited.status, 'waited');
  assert.equal(waited.userData, path.join(appData, 'Guppy'));
  assert.deepEqual(snapshot(from), before);
});

test('n2: a stale lock (a start that died mid-copy) is taken over; the lock is released after success and after failure', () => {
  const appData = tmp('stale');
  legacyFixture(appData);
  const lock = path.join(appData, M.MIGRATION_LOCK);
  fs.writeFileSync(lock, '{"pid":1}');
  const old = new Date(Date.now() - M.LOCK_STALE_MS - 60_000);
  fs.utimesSync(lock, old, old);
  const fail = M.migrateUserData(appData, { pidAlive: () => false, copy: () => { throw new Error('disk full'); } });
  assert.equal(fail.status, 'failed');
  assert.equal(fs.existsSync(lock), false, 'released after a failure');
  const ok = M.migrateUserData(appData);
  assert.equal(ok.status, 'migrated', ok.error);
  assert.equal(fs.existsSync(lock), false, 'released after success');
  assert.equal(M.LOCK_STALE_MS >= 60_000 && M.LOCK_WAIT_MS >= 10_000, true);
});

test('n4: an OLD lock whose holder is still running is never taken over; a dead holder\'s is', () => {
  const appData = tmp('n4');
  const from = legacyFixture(appData);
  const before = snapshot(from);
  const lock = path.join(appData, M.MIGRATION_LOCK);
  const staging = path.join(appData, M.STAGING_DIR);
  const old = new Date(Date.now() - M.LOCK_STALE_MS - 60_000);
  const holdLock = (pid) => { fs.writeFileSync(lock, JSON.stringify({ pid, at: 0 })); fs.utimesSync(lock, old, old); };
  // a slow first start (this very process: alive) is mid-copy, its lock older than the stale age
  fs.mkdirSync(staging);
  fs.writeFileSync(path.join(staging, 'being-copied'), 'live');
  holdLock(process.pid);
  const third = M.migrateUserData(appData, { lockWaitMs: 200, sleep: () => {} });   // the real pidAlive
  assert.equal(third.status, 'busy', 'a live holder keeps its lock however old it is');
  assert.equal(third.userData, from);
  assert.ok(fs.existsSync(path.join(staging, 'being-copied')), 'the LIVE staging folder is not cleared');
  assert.ok(fs.existsSync(lock));
  // the holder died: its old lock is taken over and the copy completes
  const dead = spawnSync(process.execPath, ['-e', '0']).pid;
  assert.equal(M.pidAlive(dead), false, 'an exited process reads as gone');
  assert.equal(M.pidAlive(process.pid), true);
  holdLock(dead);
  const r = M.migrateUserData(appData);
  assert.equal(r.status, 'migrated', r.error);
  assert.equal(fs.existsSync(path.join(appData, 'Guppy', 'being-copied')), false, 'the dead start\'s partial copy was cleared first');
  assert.equal(fs.existsSync(lock), false);
  assert.deepEqual(snapshot(from), before);
  // a young lock is honoured even when its pid reads as gone (age is still a condition)
  const appData2 = tmp('n4b');
  legacyFixture(appData2);
  fs.writeFileSync(path.join(appData2, M.MIGRATION_LOCK), JSON.stringify({ pid: dead }));
  assert.equal(M.migrateUserData(appData2, { lockWaitMs: 200, sleep: () => {}, pidAlive: () => false }).status, 'busy');
  // an unreadable old lock falls back to age alone
  fs.writeFileSync(path.join(appData2, M.MIGRATION_LOCK), 'not json');
  fs.utimesSync(path.join(appData2, M.MIGRATION_LOCK), old, old);
  assert.equal(M.migrateUserData(appData2).status, 'migrated');
});

test('n3: the afterPack hook really calls guppyUpdaterCache, and before the prune\'s early return', () => {
  const src = read('build/afterPack-memory-prune.cjs');
  const call = src.indexOf('  guppyUpdaterCache(resources);\n');
  assert.ok(call > src.indexOf('exports.default = async function afterPack(context) {'), 'called inside the hook');
  assert.ok(call < src.indexOf('if (!fs.existsSync(bin)) return;'), 'before the early return');
});

test('icon: build/icon.svg and its generator name Guppy', () => {
  for (const f of ['build/icon.svg', 'tools/make-logo.cjs']) {
    assert.match(read(f), /<!-- Guppy — the brand mark[\s\S]{0,300}<title>Guppy<\/title>/, f);
  }
  assert.doesNotMatch(read('build/icon.svg'), /Munder Difflin/);
});
