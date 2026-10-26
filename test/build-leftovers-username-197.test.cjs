'use strict';
// MUTANT-JOURNAL-GATE (god 5cc045/ed8032): this suite loads a file a census mutates in place (one load-ts never sees);
// refuse a tree a killed census left mutated, before anything is read.
require('./tools/mutant-runner-helper.cjs').gate(__filename);

/**
 * BUILD-LEFTOVERS-USERNAME-197 (Jim d449c6 INFO on the 1.1.96 cut, god b8a715). The 1.1.95 and 1.1.96
 * asars shipped node-pty's MSBuild leftovers (91 files: build/*.vcxproj, build/Release/*.{iobj,ipdb,
 * exp,lib}, build/**\/obj/**, node-addon-api/*.vcxproj and its Release/obj). 30 of them hold the build
 * machine's user folder, 18 only as UTF-16, so a latin1-only scan found 12. Here:
 * - electron-builder.yml's excludes, run through electron-builder's own minimatch, on the real 1.1.96
 *   paths: every leftover goes, the 5 runtime files stay;
 * - the release check scripts/verify-packaged-identity.cjs on asars packed the way electron-builder
 *   packs them (node-pty unpacked), with a PLANTED user name: latin1, UTF-16 at either byte offset;
 * - a census of mutants of the check.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { removeDir } = require('./tools/test-temp.cjs');
const Module = require('node:module');
const asar = require('@electron/asar');
const { readSource: read } = require('./read-source.cjs');

const CHECK_FILE = path.join(__dirname, '..', 'scripts', 'verify-packaged-identity.cjs');
const C = require(CHECK_FILE);

const PLANTED = 'plantedname7';
const plantedUser = () => ({ username: 'PlantedName7' });
const noEnv = {};

// The runtime files and a sample of every leftover class, as the 1.1.96 asar lists them.
const RUNTIME = ['conpty.node', 'conpty_console_list.node', 'pty.node', 'winpty.dll', 'winpty-agent.exe']
  .map((f) => `node_modules/node-pty/build/Release/${f}`);
const LEFTOVERS = [
  'node_modules/node-pty/build/conpty.vcxproj',
  'node_modules/node-pty/build/pty.vcxproj.filters',
  'node_modules/node-pty/build/Release/pty.iobj',
  'node_modules/node-pty/build/Release/pty.ipdb',
  'node_modules/node-pty/build/Release/winpty.exp',
  'node_modules/node-pty/build/Release/winpty.lib',
  'node_modules/node-pty/build/Release/obj/pty/pty.tlog/CL.command.1.tlog',
  'node_modules/node-pty/build/Release/obj/pty/pty.tlog/pty.lastbuildstate',
  'node_modules/node-pty/build/Release/obj/pty/src/win/path_util.nativecodeanalysis.xml',
  'node_modules/node-pty/build/deps/winpty/src/winpty-agent.vcxproj',
  'node_modules/node-pty/build/deps/winpty/src/Release/obj/winpty/winpty.dll.recipe',
  'node_modules/node-pty/node-addon-api/node_addon_api.vcxproj',
  'node_modules/node-pty/node-addon-api/node_addon_api_maybe.vcxproj.filters',
  'node_modules/node-pty/node-addon-api/Release/obj/node_addon_api_except/node_addon_api_except.recipe'
];
const KEEP = [...RUNTIME, 'node_modules/node-pty/lib/utils.js', 'node_modules/node-pty/package.json', 'out/main/index.js'];

function builderExcludes() {
  const yml = read('electron-builder.yml');
  const files = yml.slice(yml.indexOf('\nfiles:'), yml.indexOf('\nextraResources:'));
  return files.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('- "!')).map((l) => l.slice(4, -1));
}

function builderMinimatch() {
  const lib = path.dirname(require.resolve('app-builder-lib/package.json'));
  const m = require(require.resolve('minimatch', { paths: [lib] }));
  return m.minimatch || m.default || m;
}

const K = {};

K.excludes = () => {
  const minimatch = builderMinimatch();
  const pats = builderExcludes();
  const gone = (f) => pats.some((p) => minimatch(f, p, { dot: true }));
  for (const f of LEFTOVERS) assert.ok(gone(f), `electron-builder.yml LEAVES A BUILD LEFTOVER IN: ${f}`);
  for (const f of KEEP) assert.ok(!gone(f), `electron-builder.yml DROPS A RUNTIME FILE: ${f}`);
};

K.leftovers = (c = C) => {
  assert.deepEqual(c.leftoversOf(KEEP), [], 'THE RUNTIME FILES ARE NOT LEFTOVERS');
  for (const f of LEFTOVERS) assert.equal(c.leftoversOf([f]).length, 1, `A LEFTOVER IS FLAGGED: ${f}`);
  assert.equal(c.leftoversOf(['node_modules/other-native/build/Release/obj/x/x.tlog/CL.read.1.tlog']).length, 1, 'MSBUILD OUTPUT IS FLAGGED IN ANY MODULE');
  assert.equal(c.leftoversOf(['\\node_modules\\node-pty\\build\\pty.vcxproj']).length, 1, 'A WINDOWS LISTING PATH IS FLAGGED');
};

K.words = (c = C) => {
  const w = c.identityWords({ userInfo: plantedUser, env: { USERNAME: 'PLANTEDNAME7', USERPROFILE: 'C:\\Users\\Other9x', GUPPY_IDENTITY_WORDS: ' Extra-Word , ab,' } });
  assert.deepEqual(w.words, [PLANTED, 'other9x', 'extra-word'], 'THE USER NAME, THE PROFILE FOLDER AND THE EXTRA WORDS, ONCE EACH, LOWER CASE');
  assert.deepEqual(w.short, ['ab'], 'A SHORT WORD IS LEFT OUT, AND SAID');
  assert.deepEqual(c.identityWords({ userInfo: () => { throw new Error('no record'); }, env: noEnv }).words, [], 'NO USER RECORD IS NO WORD, NOT A CRASH');
};

K.hits = (c = C) => {
  const at = (s, enc) => Buffer.from(`x${s}y`, enc);
  assert.deepEqual(c.hitsIn(at('C:\\Users\\PlantedName7\\.electron-gyp', 'latin1'), [PLANTED]), [PLANTED], 'A LATIN1 USER NAME IS FOUND');
  assert.deepEqual(c.hitsIn(Buffer.from('C:\\Users\\PlantedName7', 'utf16le'), [PLANTED]), [PLANTED], 'A UTF-16 USER NAME IS FOUND');
  const odd = Buffer.concat([Buffer.from([0]), Buffer.from('C:\\Users\\PlantedName7', 'utf16le')]);
  assert.deepEqual(c.hitsIn(odd, [PLANTED]), [PLANTED], 'A UTF-16 USER NAME AT AN ODD OFFSET IS FOUND');
  assert.deepEqual(c.hitsIn(at('C:\\Users\\someone', 'latin1'), [PLANTED]), [], 'NO NAME, NO HIT');
};

async function pack(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blu197-'));
  t.after(async () => { try { asar.uncacheAll(); } catch { /* nothing cached */ } await removeDir(dir); });
  const src = path.join(dir, 'app');
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(src, rel)), { recursive: true });
    fs.writeFileSync(path.join(src, rel), body);
  }
  const out = path.join(dir, 'app.asar');
  // As electron-builder.yml's asarUnpack: node-pty lives beside the asar, and the listing still has it.
  await asar.createPackage(src, out, { unpack: '**/node_modules/node-pty/**' });
  return out;
}

const CLEAN = Object.fromEntries([...KEEP.map((f) => [f, 'ok']), ['package.json', '{}']]);

K.packed = async (t, c = C) => {
  const clean = c.verify(await pack(t, CLEAN), { userInfo: plantedUser, env: noEnv });
  assert.deepEqual([clean.ok, clean.problems], [true, []], 'A CLEAN BUILD PASSES, FOLDERS INCLUDED');
  assert.equal(clean.scanned, Object.keys(CLEAN).length, 'EVERY FILE IS SCANNED, THE UNPACKED ONES TOO');

  const tlog = 'node_modules/node-pty/build/Release/obj/pty/pty.tlog/CL.command.1.tlog';
  const planted = await pack(t, { ...CLEAN, [tlog]: Buffer.from('\ufeffC:\\USERS\\PLANTEDNAME7\\.ELECTRON-GYP\\20.0.0', 'utf16le') });
  const r = c.verify(planted, { userInfo: plantedUser, env: noEnv });
  assert.equal(r.ok, false);
  assert.ok(r.problems.includes(`native build leftover ${tlog}`), 'THE PLANTED LEFTOVER IS FLAGGED');
  assert.ok(r.problems.includes(`identity word #1 in ${tlog}`), 'THE SCAN CATCHES A PLANTED USER NAME IN AN UNPACKED UTF-16 FILE');
  assert.ok(!r.problems.join('\n').toLowerCase().includes(PLANTED), 'THE REPORT NEVER PRINTS THE WORD');

  const inCode = c.verify(await pack(t, { ...CLEAN, 'out/main/index.js': 'const home = "C:/Users/PlantedName7";' }), { userInfo: plantedUser, env: noEnv });
  assert.deepEqual(inCode.problems, ['identity word #1 in out/main/index.js'], 'THE SCAN COVERS PACKED FILES, NOT ONLY LEFTOVERS');

  const none = c.verify(await pack(t, CLEAN), { userInfo: () => ({ username: '' }), env: noEnv });
  assert.equal(none.ok, false, 'NO WORD TO SCAN FOR FAILS CLOSED');
};

// --- the census: each mutant of the check must fail its killer ---
const SRC = fs.readFileSync(CHECK_FILE, 'utf8').replace(/\r\n/g, '\n');
function mutate(edits) {
  let s = SRC;
  for (const [from, to] of edits) {
    assert.ok(s.includes(from), `mutant target not found: ${from}`);
    s = s.replace(from, to);
  }
  const m = new Module(CHECK_FILE, module);
  m.filename = CHECK_FILE;
  m.paths = Module._nodeModulePaths(path.dirname(CHECK_FILE));
  m._compile(s, CHECK_FILE);
  return m.exports;
}

const MUTANTS = [
  { name: 'no UTF-16 scan', edits: [['latin.includes(w) || wide.includes(w) || odd.includes(w)', 'latin.includes(w)']], killer: 'hits', dies: /A UTF-16 USER NAME IS FOUND/ },
  { name: 'UTF-16 at an even offset only', edits: [['|| odd.includes(w)', '']], killer: 'hits', dies: /AT AN ODD OFFSET/ },
  { name: 'the whole of node-pty/build ships', edits: [['if (f.startsWith(PTY_BUILD) && !RUNTIME.test(f))', 'if (false)']], killer: 'leftovers', dies: /A LEFTOVER IS FLAGGED/ },
  { name: 'MSBuild output only in node-pty', edits: [["else if (f.startsWith('node_modules/') && MSBUILD.test(f))", 'else if (false)']], killer: 'leftovers', dies: /A LEFTOVER IS FLAGGED: node_modules\/node-pty\/node-addon-api|MSBUILD OUTPUT IS FLAGGED IN ANY MODULE/ },
  { name: 'listing paths not normalised', edits: [['for (const f of files.map(norm))', 'for (const f of files)']], killer: 'leftovers', dies: /A WINDOWS LISTING PATH IS FLAGGED/ },
  { name: 'the profile folder is not a word', edits: [['env.USERPROFILE && path.win32.basename(env.USERPROFILE), ', '']], killer: 'words', dies: /THE PROFILE FOLDER/ },
  { name: 'no extra words', edits: [["...String(env.GUPPY_IDENTITY_WORDS || '').split(',')", '']], killer: 'words', dies: /THE EXTRA WORDS/ },
  { name: 'folders are scanned as files', edits: [['files = files.filter((f) => !isDir(f));', '']], killer: 'packed', dies: /A CLEAN BUILD PASSES, FOLDERS INCLUDED/ },
  { name: 'forward-slash extract', edits: [["asar.extractFile(asarPath, f.replace(/^[\\\\/]/, ''))", 'asar.extractFile(asarPath, norm(f))']], killer: 'packed', dies: /EVERY FILE IS SCANNED|THE SCAN CATCHES/ },
  { name: 'the word is printed', edits: [['`identity word #${words.indexOf(w) + 1} in ${norm(f)}`', '`identity word ${w} in ${norm(f)}`']], killer: 'packed', dies: /THE SCAN CATCHES|THE REPORT NEVER PRINTS/ },
  { name: 'no word passes', edits: [["if (!words.length) problems.push('no identity word to scan for (no user name found)');", '']], killer: 'packed', dies: /NO WORD TO SCAN FOR FAILS CLOSED/ }
];

test('electron-builder.yml: the excludes drop every node-pty build leftover and keep its 5 runtime files', () => K.excludes());
test('leftoversOf: only build/Release/<name>.{node,dll,exe} may ship from node-pty/build; MSBuild output nowhere', () => K.leftovers());
test('identityWords: the user name, the profile folder and GUPPY_IDENTITY_WORDS, short words left out', () => K.words());
test('hitsIn: latin1 and UTF-16 at either offset', () => K.hits());
test('verify on packed asars: a planted user name is caught in an unpacked UTF-16 leftover and in packed code, never printed', (t) => K.packed(t));

test('census: every mutant of the check is killed', { timeout: 60_000 }, async (t) => {
  for (const m of MUTANTS) {
    await t.test(`mutant: ${m.name}`, async (tt) => {
      const c = mutate(m.edits);
      await assert.rejects(async () => { await K[m.killer](...(m.killer === 'packed' ? [tt, c] : [c])); }, m.dies);
    });
  }
});
