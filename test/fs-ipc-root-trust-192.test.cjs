'use strict';

/**
 * FS-IPC-ROOT-TRUST-192 - main decides which roots the fs:* IPC may open.
 *
 * fs:listDir / fs:readFile / fs:readBinary / fs:writeFile confine every path to a `root`
 * (safeResolve), but the root itself arrived from the renderer with only a string check. A
 * renderer that passed `C:\` or `/` could list, read and WRITE anything the user can: the
 * confinement confined nothing. Main now accepts a root only when it is, or lies inside, the
 * working folder of an agent main itself knows: one in the hive registry, one with a live
 * PTY, or one main spawned this run. The renderer's roster is not a source, because the
 * renderer writes it (roster:write).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { rootTrusted } = loadTs('src/main/fs.ts');
const INDEX = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');

function tree(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fs-root-trust-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const proj = path.join(base, 'proj');
  fs.mkdirSync(path.join(proj, 'src', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(proj, '..foo'));
  fs.mkdirSync(path.join(base, 'proj2'));
  fs.mkdirSync(path.join(base, 'outside'));
  return { base, proj };
}

test('a known cwd and any folder inside it are trusted', (t) => {
  assert.equal(typeof rootTrusted, 'function', 'fs.ts exports rootTrusted');
  const { proj } = tree(t);
  assert.equal(rootTrusted(proj, [proj]), true);
  assert.equal(rootTrusted(path.join(proj, 'src', 'deep'), [proj]), true);
  assert.equal(rootTrusted(proj + path.sep, [proj]), true, 'a trailing separator is the same folder');
  assert.equal(rootTrusted(path.join(proj, '..foo'), [proj]), true, 'a child whose name starts with .. is still inside');
  assert.equal(rootTrusted(proj, ['/nowhere/else', proj]), true, 'any one known cwd is enough');
});

test('a parent, a filesystem root, a sibling and a .. escape are refused', (t) => {
  assert.equal(typeof rootTrusted, 'function', 'fs.ts exports rootTrusted');
  const { base, proj } = tree(t);
  assert.equal(rootTrusted(base, [proj]), false, 'the parent of a cwd');
  assert.equal(rootTrusted(path.parse(proj).root, [proj]), false, 'the drive or filesystem root');
  assert.equal(rootTrusted(path.join(base, 'proj2'), [proj]), false, 'a sibling that shares the prefix');
  assert.equal(rootTrusted(path.join(proj, '..', 'outside'), [proj]), false, 'a .. escape');
  assert.equal(rootTrusted(proj, []), false, 'no agent is known');
  if (process.platform === 'win32') {
    const other = /^z:/i.test(proj) ? 'Y:\\' : 'Z:\\';
    assert.equal(rootTrusted(other, [proj]), false, 'another drive (relative() returns an absolute path)');
  }
});

test('bad input and bad known entries are refused, never thrown', (t) => {
  assert.equal(typeof rootTrusted, 'function', 'fs.ts exports rootTrusted');
  const { proj } = tree(t);
  for (const bad of [undefined, null, 42, '', 'relative/path', path.join(proj, 'a\0b')]) {
    assert.equal(rootTrusted(bad, [proj]), false, `root ${JSON.stringify(bad)}`);
  }
  assert.equal(rootTrusted(proj, ['', null, undefined, 'relative']), false, 'unusable known entries match nothing');
});

test('a link inside a known cwd that points outside it is refused', (t) => {
  assert.equal(typeof rootTrusted, 'function', 'fs.ts exports rootTrusted');
  const { base, proj } = tree(t);
  const link = path.join(proj, 'out-link');
  fs.symlinkSync(path.join(base, 'outside'), link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(rootTrusted(link, [proj]), false);
});

test('on a case-folding filesystem a different case is the same folder', { skip: process.platform !== 'win32' && process.platform !== 'darwin' }, (t) => {
  assert.equal(typeof rootTrusted, 'function', 'fs.ts exports rootTrusted');
  const { proj } = tree(t);
  assert.equal(rootTrusted(proj.toUpperCase(), [proj]), true);
  assert.equal(rootTrusted(path.join(proj, 'SRC'), [proj.toLowerCase()]), true);
  // A folder that does not exist yet keeps the case it was typed in (realpath fails). On
  // win32 path.relative compares case-insensitively anyway; on darwin the fold carries it.
  assert.equal(rootTrusted(path.join(proj.toUpperCase(), 'not-yet'), [proj]), true);
});

test('WIRING: every root-taking fs handler refuses an untrusted root before it touches the disk', () => {
  for (const [channel, call] of [
    ['fs:listDir', 'listDir(root, rel)'],
    ['fs:readFile', 'readFileText(root, rel)'],
    ['fs:readBinary', 'readFileBinary(root, rel)'],
    ['fs:writeFile', 'writeFileText(root, rel, content)'],
  ]) {
    const start = INDEX.indexOf(`ipcMain.handle('${channel}'`);
    assert.ok(start >= 0, `${channel} handler exists`);
    const body = INDEX.slice(start, INDEX.indexOf('\n});', start));
    const gate = body.indexOf('if (!fsRootKnown(root)) return { ok: false, error: FS_ROOT_REFUSED };');
    assert.ok(gate >= 0, `${channel} checks the root`);
    assert.ok(gate < body.indexOf(call), `${channel} checks the root before ${call}`);
  }
});

test('WIRING: the known roots are main-owned (registry, live PTYs, this run\'s spawns), never the roster', () => {
  const start = INDEX.indexOf('function fsRootKnown(');
  assert.ok(start >= 0, 'fsRootKnown exists');
  const body = INDEX.slice(start, INDEX.indexOf('\n}', start));
  assert.match(body, /fsSpawnedCwds/);
  assert.match(body, /ptyManager\.list\(\)/);
  assert.match(body, /hive\.registry\(\)\.agents/);
  assert.match(body, /rootTrusted\(root, known\)/);
  assert.doesNotMatch(body, /roster/);
  assert.match(INDEX, /const res = await ptyManager\.spawn\(opts, owner\);\r?\n  if \(res\.ok\) fsSpawnedCwds\.add\(opts\.cwd\);/,
    'a successful agent spawn records its cwd');
});
