'use strict';
require('./tools/own-job.cjs');
/**
 * FS-REMOVE-READDIR-GAP-108: the fs-handle addon's removeTree / removeTreeAsync, and how
 * src/main/fsSafeRemove.ts uses it. The fixed cases; the race is fs-remove-gap.test.cjs.
 * Runs on Windows, Linux and macOS under plain Node (the addon is N-API). Everything is under one
 * temp folder.
 *
 * MUTANTS (in resources/fs-handle/guppy-fs-handle.c, each needs a rebuild):
 *   C1 win32 child open without RT_OPEN_REPARSE_POINT / posix openat without O_NOFOLLOW
 *        -> "a link is removed as a link" (the victim is emptied or the open is followed)
 *   C2 the root check (link or file refused) taken out -> "the root must be a real folder"
 *   C3 keepRoot ignored                                -> "keepRoot empties the folder and leaves it"
 * MUTANTS (in src/main/fsSafeRemove.ts):
 *   F1 removerFor falls back to anything but the throw -> "with no addon ..."
 *   F2 the contract check dropped                      -> "loadRemover passes over ..."
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const TS = path.join(__dirname, '..', 'src/main/fsSafeRemove.ts');
const S = loadTs(TS);
const found = S.loadRemover();
const LINK = process.platform === 'win32' ? 'junction' : 'dir';
const jail = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'fs-remove-tree-'));
const native = (p) => path.toNamespacedPath(path.resolve(p));

test.after(() => {
  const walk = (p) => {
    const st = fs.lstatSync(p, { throwIfNoEntry: false });
    if (!st) return;
    if (st.isSymbolicLink()) { try { fs.unlinkSync(p); } catch { fs.rmdirSync(p); } return; }
    if (st.isDirectory()) { for (const nm of fs.readdirSync(p)) walk(path.join(p, nm)); fs.rmdirSync(p); return; }
    try { fs.unlinkSync(p); } catch { fs.chmodSync(p, 0o666); fs.unlinkSync(p); }
  };
  walk(jail);
});

const write = (p, text = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const listing = (d) => fs.readdirSync(d, { recursive: true }).map((f) => f.split(path.sep).join('/')).sort();

/** A tree with two links to a victim outside it, a link whose target is gone and a read-only file. */
function build(name) {
  const base = path.join(jail, name);
  const tree = path.join(base, 'tree');
  const victim = path.join(base, 'victim');
  write(path.join(victim, 'precious.txt'), 'live'); write(path.join(victim, 'sub', 'b.txt'));
  write(path.join(tree, 'a.txt')); write(path.join(tree, 'src', 'deep', 'b.txt')); write(path.join(tree, 'ünï cödé', 'c.txt'));
  write(path.join(tree, 'src', 'locked.bin')); fs.chmodSync(path.join(tree, 'src', 'locked.bin'), 0o444);
  fs.symlinkSync(victim, path.join(tree, 'top'), LINK);
  fs.symlinkSync(victim, path.join(tree, 'src', 'deep', 'nested'), LINK);
  const gone = path.join(base, 'gone'); fs.mkdirSync(gone);
  fs.symlinkSync(gone, path.join(tree, 'src', 'dangling'), LINK); fs.rmdirSync(gone);
  let links = 3;
  if (process.platform !== 'win32') { fs.symlinkSync(path.join(victim, 'precious.txt'), path.join(tree, 'file-link')); links++; }
  return { base, tree, victim, links };
}
const victimIntact = (fx) => {
  assert.deepEqual(listing(fx.victim), ['precious.txt', 'sub', 'sub/b.txt'], 'THE LINK TARGET SURVIVES WITH EVERYTHING IN IT');
  assert.equal(fs.readFileSync(path.join(fx.victim, 'precious.txt'), 'utf8'), 'live');
};

test('the addon is built and reports the removeTree contract this code was written against', () => {
  assert.ok(found.addon, `no usable addon: ${found.reason}`);
  assert.equal(found.addon.removeTreeApi, S.REMOVE_TREE_API);
  assert.equal(S.REMOVE_TREE_API, 1);
});

test('removeTree: a link is removed as a link and counted, a read-only file goes, the folder is gone', () => {
  const fx = build('sync');
  assert.equal(found.addon.removeTree(native(fx.tree)), fx.links);
  assert.equal(fs.existsSync(fx.tree), false);
  victimIntact(fx);
});

test('removeTreeAsync: the same, as a promise', async () => {
  const fx = build('async');
  const p = found.addon.removeTreeAsync(native(fx.tree));
  assert.ok(p instanceof Promise);
  assert.equal(await p, fx.links);
  assert.equal(fs.existsSync(fx.tree), false);
  victimIntact(fx);
});

test('keepRoot empties the folder and leaves it', async () => {
  for (const [name, call] of [['keep-sync', (p) => found.addon.removeTree(p, true)], ['keep-async', (p) => found.addon.removeTreeAsync(p, true)]]) {
    const fx = build(name);
    assert.equal(await call(native(fx.tree)), fx.links);
    assert.deepEqual(fs.readdirSync(fx.tree), [], `${name}: empty, and still there`);
    victimIntact(fx);
  }
});

test('the root must be a real folder: a link or a file is refused and untouched, a missing one is ENOENT', async () => {
  const fx = build('root');
  const link = path.join(fx.base, 'root-link'); fs.symlinkSync(fx.victim, link, LINK);
  const file = path.join(fx.base, 'root-file'); write(file);
  for (const call of [(p) => found.addon.removeTree(p), (p) => found.addon.removeTreeAsync(p)]) {
    await assert.rejects(async () => call(native(link)), (e) => e.code === 'EREFUSED' && /refused: root is a reparse point/.test(e.message));
    await assert.rejects(async () => call(native(file)), (e) => e.code === 'EREFUSED' && /refused: root is not a directory/.test(e.message));
    await assert.rejects(async () => call(native(path.join(fx.base, 'nothing'))), (e) => e.code === 'ENOENT');
  }
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'the link is still there');
  assert.equal(fs.existsSync(file), true);
  victimIntact(fx);
});

test('a wide folder (several listings) and a deep one (past 260 characters) are removed whole', () => {
  const wide = path.join(jail, 'wide');
  fs.mkdirSync(wide);
  for (let i = 0; i < 3000; i++) fs.writeFileSync(path.join(wide, `a-rather-long-file-name-to-fill-the-listing-buffer-${i}.txt`), '');
  assert.equal(found.addon.removeTree(native(wide)), 0);
  assert.equal(fs.existsSync(wide), false);

  const deep = path.join(jail, 'deep');
  let p = deep;
  for (let i = 0; i < 60; i++) p = path.join(p, `level-${i}`);
  fs.mkdirSync(native(p), { recursive: true });
  fs.writeFileSync(native(path.join(p, 'bottom.txt')), 'x');
  assert.ok(p.length > 400);
  assert.equal(found.addon.removeTree(native(deep)), 0);
  assert.equal(fs.existsSync(deep), false);
});

test('safeRemoveTreeSync / safeRemoveTree: the tree goes, the targets stay; a link put in before the root goes is removed as a link', async () => {
  for (const [name, call] of [['ts-sync', (p, h) => S.safeRemoveTreeSync(p, h)], ['ts-async', (p, h) => S.safeRemoveTree(p, h)]]) {
    const fx = build(name);
    await call(fx.tree);
    assert.equal(fs.existsSync(fx.tree), false, name);
    victimIntact(fx);

    const again = build(`${name}-hook`);
    await call(again.tree, () => { fs.symlinkSync(again.victim, path.join(again.tree, 'late'), LINK); write(path.join(again.tree, 'late.txt')); });
    assert.equal(fs.existsSync(again.tree), false, `${name}: what arrived late went too`);
    victimIntact(again);

    const swap = build(`${name}-swap`);
    await assert.rejects(async () => call(swap.tree, () => { fs.rmdirSync(swap.tree); fs.symlinkSync(swap.victim, swap.tree, LINK); }),
      (e) => e.code === 'EREFUSED' && e.message === 'refused: root became a reparse point');
    assert.equal(fs.lstatSync(swap.tree).isSymbolicLink(), true, 'the link that took the root\'s place is left alone');
    victimIntact(swap);
  }
});

test('loadRemover passes over a missing build, one that does not load and one with another contract, and says why', () => {
  const junk = path.join(jail, 'junk.node'); fs.writeFileSync(junk, 'not a module');
  const none = S.loadRemover([path.join(jail, 'missing.node')]);
  assert.equal(none.addon, null); assert.equal(none.reason, 'no guppy_fs_handle.node build found');
  const bad = S.loadRemover([junk]);
  assert.equal(bad.addon, null); assert.ok(bad.reason.startsWith(`${junk}: `), bad.reason);
  assert.equal(S.loadRemover([path.join(jail, 'missing.node'), junk, found.from]).from, found.from, 'the next candidate is tried');
  const fake = { removeTree() { return 0; }, removeTreeAsync: async () => 0 };
  for (const [exports, said] of [[fake, 'undefined'], [{ ...fake, removeTreeApi: 2 }, '2']]) {
    const got = S.loadRemover([junk], () => exports);
    assert.equal(got.addon, null, 'a build with another contract is not used');
    assert.equal(got.reason, `${junk}: removeTree contract ${said}, need 1`);
  }
  assert.equal(S.loadRemover([junk], () => ({ ...fake, removeTreeApi: 1 })).from, junk, 'the matching contract is used');
});

test('removerCandidates: this tree\'s build, then an installed Guppy', () => {
  const c = S.removerCandidates({ GUPPY_PACKAGED_EXE: path.join(jail, 'app', 'Guppy.exe'), LOCALAPPDATA: path.join(jail, 'local') });
  assert.ok(c.includes(path.join(__dirname, '..', 'resources', 'fs-handle', 'bin', 'guppy_fs_handle.node')));
  assert.ok(c.includes(path.join(jail, 'app', 'resources', 'fs-handle', 'guppy_fs_handle.node')), 'next to GUPPY_PACKAGED_EXE');
  if (process.platform === 'win32') assert.ok(c.includes(path.join(jail, 'local', 'Programs', 'Guppy', 'resources', 'fs-handle', 'guppy_fs_handle.node')));
  assert.ok(c.indexOf(path.join(__dirname, '..', 'resources', 'fs-handle', 'bin', 'guppy_fs_handle.node')) < c.indexOf(path.join(jail, 'app', 'resources', 'fs-handle', 'guppy_fs_handle.node')));
});

test('with no addon a tree delete is refused: nothing is removed, one line per tree, counted; there is no JS walk', async (t) => {
  // The same source with no place to find a build (compiled from text; no file is written).
  const source = fs.readFileSync(TS, 'utf8');
  const at = 'const got = loadRemover(); // not cached while it fails: a build can appear later';
  assert.equal(source.split(at).length - 1, 1);
  const N = loadTs.fromText(TS, source.replace(at, () => 'const got = loadRemover([]);'));
  const lines = [];
  t.mock.method(console, 'error', (l) => lines.push(String(l)));
  const fx = build('no-addon');
  const before = listing(fx.tree);
  assert.throws(() => N.safeRemoveTreeSync(fx.tree), (e) => e.code === 'EREMOVER_UNAVAILABLE' && /^refused: link-safe remover unavailable \(no guppy_fs_handle\.node build found\)$/.test(e.message));
  await assert.rejects(() => N.safeRemoveTree(fx.tree), (e) => e.code === 'EREMOVER_UNAVAILABLE');
  assert.deepEqual(listing(fx.tree), before, 'the tree is exactly as it was');
  victimIntact(fx);
  assert.deepEqual(N.removerRefusals(), { count: 2, reason: 'no guppy_fs_handle.node build found' });
  assert.equal(lines.length, 2, 'one line per refused tree');
  assert.ok(lines.every((l) => l.startsWith(`[fsSafeRemove] REFUSED to remove ${fx.tree}: `)), lines.join(' | '));
  assert.deepEqual(S.removerRefusals(), { count: 0, reason: '' }, 'the real module refused nothing in this file');
});

// kg-core.cjs is plain CommonJS with its own copy of the loader and the refusal (it cannot load the
// .ts module), so both are pinned here as well: nothing above reaches them.
const KG = require('../src/main/kg-core.cjs');

test('kg-core: its loader passes over a build with another contract and says why; the matching one is used', () => {
  const junk = path.join(jail, 'kg-junk.node'); fs.writeFileSync(junk, 'not a module');
  const none = KG.loadRemover([path.join(jail, 'missing.node')]);
  assert.equal(none.removeTree, null); assert.equal(none.reason, 'no guppy_fs_handle.node build found');
  for (const [exports, said] of [[{ removeTree() { return 0; } }, 'undefined'], [{ removeTree() { return 0; }, removeTreeApi: 2 }, '2']]) {
    const got = KG.loadRemover([junk], () => exports);
    assert.equal(got.removeTree, null, 'a build with another contract is not used');
    assert.equal(got.reason, `${junk}: removeTree contract ${said}, need 1`);
  }
  const ok = KG.loadRemover([junk], () => ({ removeTree() { return 0; }, removeTreeApi: 1 }));
  assert.equal(ok.from, junk); assert.equal(typeof ok.removeTree, 'function');
});

test('kg-core: a doc folder is deleted only by the addon; with no addon it is kept, one line, EREMOVER_UNAVAILABLE', (t) => {
  const lines = [];
  t.mock.method(process.stderr, 'write', (l) => { lines.push(String(l)); return true; });
  const fx = build('kg-no-addon');
  const before = listing(fx.tree);
  assert.throws(() => KG.removeDocDir(fx.tree, () => ({ removeTree: null, reason: 'none here' })),
    (e) => e.code === 'EREMOVER_UNAVAILABLE' && e.path === fx.tree && e.message === 'refused: link-safe remover unavailable (none here)');
  assert.deepEqual(listing(fx.tree), before, 'the tree is exactly as it was');
  assert.deepEqual(lines, [`[kg] REFUSED to remove ${fx.tree}: the link-safe remover (fs-handle addon) is unavailable: none here\n`]);
  // The folder goes to the loaded remover and to nothing else: one that does nothing leaves the tree whole.
  const asked = [];
  KG.removeDocDir(fx.tree, () => ({ removeTree: (p) => { asked.push(p); return 0; }, from: 'stub' }));
  assert.deepEqual(asked, [fx.tree]);
  assert.deepEqual(listing(fx.tree), before, 'no other delete ran');
  victimIntact(fx);
  // And the real one removes it, the targets stay.
  KG.removeDocDir(fx.tree);
  assert.equal(fs.existsSync(fx.tree), false);
  victimIntact(fx);
});

test('SOURCE: fsSafeRemove deletes a tree only through the addon', () => {
  const code = fs.readFileSync(TS, 'utf8').replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const body = (name) => { const m = new RegExp(`export (?:async )?function ${name}\\([^\\n]*\\n([\\s\\S]*?)\\n}\\n`).exec(code); assert.ok(m, name); return m[1]; };
  for (const name of ['safeRemoveTreeSync', 'safeRemoveTree']) {
    assert.doesNotMatch(body(name), /lstat|readdir|unlink|rmdir|\brm\b/, `${name} makes no file call of its own`);
    assert.match(body(name), /const addon = removerFor\(path\);/, `${name} gets the addon or throws`);
  }
});
