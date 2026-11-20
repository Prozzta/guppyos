'use strict';
require('./tools/own-job.cjs');
/**
 * FLAKE-RIG-NODE-LOOKUP-UNDER-LOAD-108: the rules of the in-process win32 PATH search
 * (commandResolver.ts searchPathWin) that test/rig-node-lookup-inproc-108.test.cjs (Andy: no process,
 * parity with where.exe) does not reach.
 *
 * PART 1 (fake deps, any platform): what comes AFTER the PATH search is unchanged.
 *  - the five install-dir candidates are tried in their old order after a PATH miss;
 *  - a PATH hit beats every candidate;
 *  - inside one dir the first match in DIRECTORY order wins, a sub-directory is never a match, and a
 *    match that is not on disk (exists false) is passed over for the next one;
 *  - PATH and PATHEXT are read whatever the case of the variable's name (`Path`);
 *  - a dir named twice is listed once; a quoted entry and an empty entry are never listed.
 * PART 2 (the real file system and the real where.exe, win32 only): PATH entry shapes, measured on
 * this box 2026-11-20. where.exe resolves a relative entry against the current dir, takes `/` and
 * `..`, and ignores trailing spaces; an entry with a LEADING space finds nothing. The resolver gives
 * the same answer for each, and "finds nothing" is a plain miss, never UNKNOWN.
 * PART 3: resolveCliAsync (the models-refresh lookup) uses the same search: no process, every PATH
 * match collected, the old pick rule (.exe/.cmd/.bat first) and the old two fallbacks; POSIX unchanged.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { nodeEnv } = require('./tools/node-env.cjs');

const REPO = path.resolve(__dirname, '..');
const R = loadTs('src/main/commandResolver.ts');
const WIN = process.platform === 'win32';
const SYS32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');

// ─── PART 1: fake deps ───────────────────────────────────────────────────────────────

/** win32 deps over a fake disk. `dirs`: dir -> names in directory order (a name ending in `\` is a
 *  sub-directory). exec throws: nothing here may start a process. */
function fake({ env = {}, dirs = {}, onDisk = [] } = {}) {
  const listed = [];
  const d = {
    platform: 'win32', env,
    exists: (p) => onDisk.includes(p),
    exec: () => { throw new Error('a win32 lookup must not start a process'); },
    listDir: async (dir) => {
      listed.push(dir);
      if (!Object.prototype.hasOwnProperty.call(dirs, dir)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return dirs[dir].map((n) => (n.endsWith('\\') ? { name: n.slice(0, -1), dir: true } : { name: n, dir: false }));
    }
  };
  return { d, listed };
}

const ENV = { APPDATA: 'C:\\AD', LOCALAPPDATA: 'C:\\LAD', USERPROFILE: 'C:\\U', PATH: 'C:\\bin', PATHEXT: '.COM;.EXE;.BAT;.CMD' };
const CANDIDATES = [
  'C:\\AD\\npm\\codex.cmd',
  'C:\\AD\\npm\\codex',
  'C:\\LAD\\Programs\\claude\\codex.exe',
  'C:\\U\\.claude\\local\\codex.cmd',
  'C:\\U\\.claude\\local\\codex'
];

test('candidates: after a PATH miss the five install dirs are tried in the old order, each one found', async () => {
  for (let i = 0; i < CANDIDATES.length; i++) {
    const { d, listed } = fake({ env: ENV, dirs: { 'C:\\bin': ['other.exe'] }, onDisk: CANDIDATES.slice(i) });
    assert.deepEqual(await R.lookupCommandAsync('codex', d), { path: CANDIDATES[i], found: true }, `candidate ${i + 1} is the first one on disk`);
    assert.deepEqual(listed, ['C:\\bin'], 'PATH was searched first');
  }
  assert.deepEqual(await R.lookupCommandAsync('codex', fake({ env: ENV, dirs: { 'C:\\bin': [] } }).d), { path: 'codex', found: false }, 'none on disk: a plain miss');
  const home = fake({ env: { ...ENV, USERPROFILE: undefined, HOME: 'C:\\H' }, dirs: { 'C:\\bin': [] }, onDisk: ['C:\\H\\.claude\\local\\codex.cmd'] });
  assert.deepEqual(await R.lookupCommandAsync('codex', home.d), { path: 'C:\\H\\.claude\\local\\codex.cmd', found: true }, 'HOME stands in for USERPROFILE, as before');
});

test('candidates: a PATH hit beats every install-dir candidate', async () => {
  const { d } = fake({ env: ENV, dirs: { 'C:\\bin': ['codex.cmd'] }, onDisk: ['C:\\bin\\codex.cmd', ...CANDIDATES] });
  assert.deepEqual(await R.lookupCommandAsync('codex', d), { path: 'C:\\bin\\codex.cmd', found: true });
});

test('one dir: directory order, not PATHEXT order; a sub-directory and the extensionless shim are never the hit; a match not on disk is passed over', async () => {
  const all = ['C:\\bin\\codex', 'C:\\bin\\codex.exe', 'C:\\bin\\codex.cmd', 'C:\\bin\\codex.bat', 'C:\\b2\\codex.cmd'];
  const order = fake({ env: ENV, dirs: { 'C:\\bin': ['codex', 'codex.exe', 'codex.cmd'] }, onDisk: all });
  assert.deepEqual(await R.lookupCommandAsync('codex', order.d), { path: 'C:\\bin\\codex.exe', found: true }, 'the extensionless shim is skipped; .exe is the first listed match');
  const cmdFirst = fake({ env: { ...ENV, PATHEXT: '.EXE;.CMD' }, dirs: { 'C:\\bin': ['codex', 'codex.cmd', 'codex.exe'] }, onDisk: all });
  assert.deepEqual(await R.lookupCommandAsync('codex', cmdFirst.d), { path: 'C:\\bin\\codex.cmd', found: true }, '.cmd is listed first, though PATHEXT names .EXE first');
  const sub = fake({ env: { ...ENV, PATH: 'C:\\bin;C:\\b2' }, dirs: { 'C:\\bin': ['codex.exe\\', 'codex'], 'C:\\b2': ['CODEX.CMD'] }, onDisk: ['C:\\bin\\codex.exe', 'C:\\bin\\codex', 'C:\\b2\\CODEX.CMD'] });
  assert.deepEqual(await R.lookupCommandAsync('codex', sub.d), { path: 'C:\\b2\\CODEX.CMD', found: true }, 'the sub-directory and the shim are skipped; the name keeps the case the directory gives');
  const gone = fake({ env: ENV, dirs: { 'C:\\bin': ['codex.exe', 'codex.bat'] }, onDisk: ['C:\\bin\\codex.bat'] });
  assert.deepEqual(await R.lookupCommandAsync('codex', gone.d), { path: 'C:\\bin\\codex.bat', found: true }, 'exists() false (an App Execution Alias): the next match');
  const ext = fake({ env: ENV, dirs: { 'C:\\bin': ['codex.ps1', 'codex.cmd.bak', 'xcodex.cmd'] }, onDisk: ['C:\\bin\\codex.ps1', 'C:\\bin\\codex.cmd.bak', 'C:\\bin\\xcodex.cmd'] });
  assert.deepEqual(await R.lookupCommandAsync('codex', ext.d), { path: 'codex', found: false }, 'only <name> + one PATHEXT extension matches');
});

test('env: PATH and PATHEXT are read whatever the case of the name; no PATHEXT means .COM;.EXE;.BAT;.CMD', async () => {
  const mixed = fake({ env: { Path: 'C:\\bin', PathExt: '.ps1' }, dirs: { 'C:\\bin': ['codex.cmd', 'codex.ps1'] }, onDisk: ['C:\\bin\\codex.cmd', 'C:\\bin\\codex.ps1'] });
  assert.deepEqual(await R.lookupCommandAsync('codex', mixed.d), { path: 'C:\\bin\\codex.ps1', found: true });
  const dflt = fake({ env: { Path: 'C:\\bin' }, dirs: { 'C:\\bin': ['codex.ps1', 'codex.bat'] }, onDisk: ['C:\\bin\\codex.ps1', 'C:\\bin\\codex.bat'] });
  assert.deepEqual(await R.lookupCommandAsync('codex', dflt.d), { path: 'C:\\bin\\codex.bat', found: true });
});

test('entries: a dir named twice is listed once; quoted and empty entries are never listed; the search stops at the hit', async () => {
  const { d, listed } = fake({ env: { ...ENV, PATH: ';C:\\a;;c:\\A\\;"C:\\q";C:\\a ;C:\\b;C:\\c' }, dirs: { 'C:\\a': [], 'C:\\q': ['codex.cmd'], '"C:\\q"': ['codex.cmd'], 'C:\\b': ['codex.cmd'], 'C:\\c': ['codex.cmd'] }, onDisk: ['C:\\q\\codex.cmd', 'C:\\b\\codex.cmd', 'C:\\c\\codex.cmd'] });
  assert.deepEqual(await R.lookupCommandAsync('codex', d), { path: 'C:\\b\\codex.cmd', found: true });
  assert.deepEqual(listed, ['C:\\a', 'C:\\b'], 'C:\\a once (the trailing backslash, the other case and the trailing space are the same dir); the quoted one never; C:\\c not reached');
});

// ─── PART 2: the real file system against the real where.exe ─────────────────────────

const CHILD = [
  "const [repo, name] = process.argv.slice(1);",
  "const R = require(repo + '/test/load-ts.cjs')('src/main/commandResolver.ts');",
  "R.lookupCommandAsync(name).then((r) => process.stdout.write(JSON.stringify(r)));"
].join('\n');
// nodeEnv: under the Electron leg process.execPath is electron.exe, and a child env without ELECTRON_RUN_AS_NODE starts a real app.
const run = (file, args, env, cwd) => new Promise((res) => execFile(file, args, { windowsHide: true, maxBuffer: 1 << 20, env: nodeEnv(env), cwd }, (err, stdout, stderr) => res({ code: err ? err.code : 0, stdout: String(stdout), stderr: String(stderr) })));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lkps-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const mk = (rel) => { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, '@echo off\r\n'); return p; };
  const empty = path.join(root, 'empty');
  fs.mkdirSync(empty, { recursive: true });
  const env = (entries) => ({
    PATH: [...entries, SYS32].join(';'), PATHEXT: '.EXE;.CMD',
    SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir(),
    APPDATA: empty, LOCALAPPDATA: empty, USERPROFILE: empty, HOME: empty
  });
  return { root, mk, env };
}

/** where.exe's own first PATHEXT line (the old rule), then the resolver's answer in a child with the
 *  same env and cwd. `expect`: the full path both must give, or null for "found nothing". */
async function both(name, env, cwd, expect, why) {
  const w = await run(path.join(SYS32, 'where.exe'), [name], env, cwd);
  assert.ok(w.code === 0 || w.code === 1, `where.exe failed (${w.code}): ${w.stderr}`);
  const lines = w.stdout.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const pick = lines.find((p) => /\.(exe|cmd)$/i.test(p) && fs.existsSync(p)) ?? null;
  assert.equal(pick, expect, `fixture, where.exe's pick (${why}); it listed ${JSON.stringify(lines)}`);
  const c = await run(process.execPath, ['-e', CHILD, REPO, name], env, cwd);
  assert.equal(c.code, 0, `resolver child failed: ${c.stderr}`);
  assert.deepEqual(JSON.parse(c.stdout), expect ? { path: expect, found: true } : { path: name, found: false }, why);
}

test('real fs: a relative PATH entry is searched against the current dir, like where.exe (sub, .\\sub, ..\\other)', { skip: !WIN && 'win32 only' }, async (t) => {
  const { root, mk, env } = fixture(t);
  const inSub = mk('cwd\\sub\\lkra.exe');
  const inOther = mk('other\\lkrb.cmd');
  const cwd = path.join(root, 'cwd');
  await both('lkra', env(['sub']), cwd, inSub, 'a bare relative entry');
  await both('lkra', env(['.\\sub']), cwd, inSub, 'a .\\ entry');
  await both('lkrb', env(['..\\other']), cwd, inOther, 'a ..\\ entry');
});

test('real fs: forward slashes, .. inside an entry, two trailing backslashes and a trailing space are the same dir, like where.exe', { skip: !WIN && 'win32 only' }, async (t) => {
  const { root, mk, env } = fixture(t);
  const hit = mk('p\\lkrc.exe');
  const cwd = path.join(root, 'empty');
  const p = path.join(root, 'p');
  await both('lkrc', env([p.replace(/\\/g, '/')]), cwd, hit, 'forward slashes');
  await both('lkrc', env([path.join(root, 'empty') + '\\..\\p']), cwd, hit, '.. inside the entry');
  await both('lkrc', env([p + '\\\\']), cwd, hit, 'two trailing backslashes');
  await both('lkrc', env([p + ' ']), cwd, hit, 'a trailing space');
});

test('real fs: an entry with a LEADING space or in quotes finds nothing, and that is a plain miss (never UNKNOWN)', { skip: !WIN && 'win32 only' }, async (t) => {
  const { root, mk, env } = fixture(t);
  mk('p\\lkrd.exe');
  const cwd = path.join(root, 'empty');
  const p = path.join(root, 'p');
  await both('lkrd', env([' ' + p]), cwd, null, 'a leading space');
  await both('lkrd', env([`"${p}"`]), cwd, null, 'a quoted entry');
  await both('lkrd', env([p + '\\nope', path.join(root, 'p', 'lkrd.exe')]), cwd, null, 'a missing dir and a file as an entry');
});

// ─── PART 3: resolveCliAsync (the models-refresh lookup) on the same PATH search ─────
// It took where.exe's whole list and picked .exe/.cmd/.bat first, then the rest, the first one on
// disk. The list now comes from the PATH dirs in process; the pick rule and the two install-dir
// fallbacks are the old ones.

const CLI_ENV = { LOCALAPPDATA: 'C:\\LAD', APPDATA: 'C:\\AD', PATH: 'C:\\a;C:\\b', PATHEXT: '.COM;.EXE;.BAT;.CMD;.PS1' };

test('resolveCliAsync (win32): no process is started; every PATH dir is listed', async () => {
  const { d, listed } = fake({ env: CLI_ENV, dirs: { 'C:\\a': ['agy.exe'], 'C:\\b': ['agy.cmd'] }, onDisk: ['C:\\a\\agy.exe', 'C:\\b\\agy.cmd'] });
  assert.equal(await R.resolveCliAsync(d, 'agy'), 'C:\\a\\agy.exe', 'exec throws in this fake: a where.exe start would have thrown or returned null');
  assert.deepEqual(listed, ['C:\\a', 'C:\\b'], 'like where.exe it collects every match before it picks');
});

test('resolveCliAsync (win32): the pick rule is the old one - .exe/.cmd/.bat first across ALL dirs, then the rest, first on disk', async () => {
  const dirs = { 'C:\\a': ['agy', 'agy.ps1'], 'C:\\b': ['agy.bat', 'agy.cmd'] };
  const all = ['C:\\a\\agy', 'C:\\a\\agy.ps1', 'C:\\b\\agy.bat', 'C:\\b\\agy.cmd'];
  const at = (onDisk) => R.resolveCliAsync(fake({ env: CLI_ENV, dirs, onDisk }).d, 'agy');
  assert.equal(await at(all), 'C:\\b\\agy.bat', 'a .bat in a LATER dir beats the extensionless shim and the .ps1 in an earlier one');
  assert.equal(await at(all.filter((p) => p !== 'C:\\b\\agy.bat')), 'C:\\b\\agy.cmd', 'a preferred match that is not on disk is passed over');
  assert.equal(await at(['C:\\a\\agy', 'C:\\a\\agy.ps1']), 'C:\\a\\agy', 'no .exe/.cmd/.bat on disk: the rest, in where.exe order');
  assert.equal(await at(['C:\\a\\agy.ps1']), 'C:\\a\\agy.ps1');
  assert.equal(await at([]), null, 'nothing on disk: not found');
  const sub = fake({ env: CLI_ENV, dirs: { 'C:\\a': ['agy.exe\\','AGY.CMD'] }, onDisk: ['C:\\a\\agy.exe', 'C:\\a\\AGY.CMD'] });
  assert.equal(await R.resolveCliAsync(sub.d, 'agy'), 'C:\\a\\AGY.CMD', 'a sub-directory is never a match; the name keeps its case on disk');
});

test('resolveCliAsync (win32): after a PATH miss the two install-dir fallbacks, in the old order; a PATH hit beats both', async () => {
  const fallbacks = ['C:\\LAD\\agy\\bin\\agy.exe', 'C:\\AD\\npm\\agy.cmd'];
  const miss = { 'C:\\a': ['other.exe'], 'C:\\b': [] };
  assert.equal(await R.resolveCliAsync(fake({ env: CLI_ENV, dirs: miss, onDisk: fallbacks }).d, 'agy'), fallbacks[0]);
  assert.equal(await R.resolveCliAsync(fake({ env: CLI_ENV, dirs: miss, onDisk: [fallbacks[1]] }).d, 'agy'), fallbacks[1]);
  assert.equal(await R.resolveCliAsync(fake({ env: CLI_ENV, dirs: miss }).d, 'agy'), null);
  assert.equal(await R.resolveCliAsync(fake({ env: CLI_ENV, dirs: { 'C:\\a': [], 'C:\\b': ['agy.cmd'] }, onDisk: ['C:\\b\\agy.cmd', ...fallbacks] }).d, 'agy'), 'C:\\b\\agy.cmd');
});

test('resolveCliAsync (win32): a PATH dir that cannot be listed adds nothing and never throws; a bad name lists nothing', async () => {
  const f = fake({ env: CLI_ENV, dirs: { 'C:\\b': ['agy.cmd'] }, onDisk: ['C:\\b\\agy.cmd'] });
  const inner = f.d.listDir;
  f.d.listDir = async (dir) => { if (dir === 'C:\\a') { f.listed.push(dir); throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } return inner(dir); };
  assert.equal(await R.resolveCliAsync(f.d, 'agy'), 'C:\\b\\agy.cmd', 'the dirs that can be listed are still searched');
  const none = fake({ env: { ...CLI_ENV, PATH: 'C:\\a' } });
  none.d.listDir = async () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); };
  assert.equal(await R.resolveCliAsync(none.d, 'agy'), null);
  const bad = fake({ env: CLI_ENV, dirs: { 'C:\\a': ['Bad;Name.exe'] }, onDisk: ['C:\\a\\Bad;Name.exe'] });
  assert.equal(await R.resolveCliAsync(bad.d, 'Bad;Name'), null);
  assert.deepEqual(bad.listed, [], 'refused before any dir is read');
});

test('resolveCliAsync (POSIX): unchanged - still `$SHELL -lc command -v`, the last line on disk', async () => {
  const calls = [];
  const d = {
    platform: 'linux', env: { SHELL: '/bin/zsh', HOME: '/h' }, exists: (p) => p === '/usr/bin/agy',
    listDir: async () => { throw new Error('POSIX must not list PATH dirs'); },
    exec: (file, args, opts, cb) => { calls.push([file, args]); setImmediate(() => cb(null, 'motd\n/usr/bin/agy\n')); }
  };
  assert.equal(await R.resolveCliAsync(d, 'agy'), '/usr/bin/agy');
  assert.deepEqual(calls, [['/bin/zsh', ['-lc', 'command -v agy']]]);
});

const CLI_CHILD = [
  "const [repo, name] = process.argv.slice(1);",
  "const R = require(repo + '/test/load-ts.cjs')('src/main/commandResolver.ts');",
  "const d = { ...R.nodeResolverDeps(), exec: () => { throw new Error('no process'); } };",
  "R.resolveCliAsync(d, name).then((r) => process.stdout.write(JSON.stringify(r)));"
].join('\n');

test('real fs: resolveCliAsync gives what the old rule gave on where.exe\'s own list, with no process', { skip: !WIN && 'win32 only' }, async (t) => {
  const { root, mk, env } = fixture(t);
  mk('a\\lkcli');
  mk('a\\lkcli.cmd.txt');
  const cmd = mk('b\\lkcli.cmd');
  const cwd = path.join(root, 'empty');
  const e = env([path.join(root, 'a'), path.join(root, 'b')]);
  const w = await run(path.join(SYS32, 'where.exe'), ['lkcli'], e, cwd);
  const lines = w.stdout.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  assert.deepEqual(lines, [path.join(root, 'a', 'lkcli'), cmd], 'fixture: where.exe lists the extensionless shim first, then the .cmd');
  const old = [...lines.filter((l) => /\.(exe|cmd|bat)$/i.test(l)), ...lines.filter((l) => !/\.(exe|cmd|bat)$/i.test(l))].find((p) => fs.existsSync(p));
  const c = await run(process.execPath, ['-e', CLI_CHILD, REPO, 'lkcli'], e, cwd);
  assert.equal(c.code, 0, `resolver child failed: ${c.stderr}`);
  assert.equal(JSON.parse(c.stdout), old);
  assert.equal(old, cmd);
});
