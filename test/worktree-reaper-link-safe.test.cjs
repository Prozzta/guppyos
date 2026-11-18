'use strict';
require('./tools/own-job.cjs');

/**
 * ELECTRON-RMSYNC-REAPER-108, FS-REMOVE-READDIR-GAP-108: scripts/worktree-reaper.cjs deletes a
 * tree without following a link.
 *
 * Agents run the reaper through $HIVE_NODE or the shim, which is Electron as Node. There a
 * recursive fs.rmSync deletes THROUGH a Windows junction and empties the folder it points at
 * (RUNTIME PIN in electron-rmsync-link-safe.test.cjs), and a JS walk on paths can be made to
 * follow a link that appears between two of its calls. So the delete is the fs-handle addon's
 * removeTree, and without the addon the tree is kept: there is no JS walk.
 *
 * The fixture is a folder to reap with a junction at its top and one nested, each pointing at a
 * victim outside it, a read-only file and a link whose target is gone. It is reaped four times:
 * the script as it is, and with a remover that found no build, each in this process and in the
 * installed Guppy.exe as Node (worktree-reaper-link-safe-child.cjs). Everything is under one
 * temp folder; no git is run and nothing outside the temp folder is named.
 *
 * MUTANTS:
 *   R1 rm.removeTree(p) in removeEntry -> ops.rmSync(p, { recursive: true, force: true })
 *        -> real, Electron (both victims emptied); links count; SOURCE
 *   R2 the refusal in applyReap -> if (false)           -> no-addon, both runtimes
 *   R3 removeEntry's lstatSync -> statSync              -> SOURCE
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const child = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, SRC, NO_ADDON } = require('./worktree-reaper-link-safe-child.cjs');

const jail = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'reaper-link-safe-'));

// The jail holds junctions when a test fails half way: remove them as links before the folder.
test.after(() => {
  const walk = (p) => {
    const st = fs.lstatSync(p);
    if (st.isSymbolicLink()) { try { fs.rmdirSync(p); } catch { fs.unlinkSync(p); } return; }
    if (st.isDirectory()) for (const n of fs.readdirSync(p)) walk(path.join(p, n));
  };
  walk(jail);
  fs.rmSync(jail, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const write = (p, text) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); };
const link = (target, at) => { fs.mkdirSync(path.dirname(at), { recursive: true }); fs.symlinkSync(target, at, 'junction'); };
const VICTIMS = ['top', 'nested'];

function build(base) {
  const tree = path.join(base, 'work', 'old-tree');
  for (const name of VICTIMS) {
    const d = path.join(base, 'live', name);
    write(path.join(d, 'precious.txt'), `live ${name}`); write(path.join(d, 'sub', 'b.txt'), 'b');
  }
  write(path.join(tree, 'a.txt'), 'a');
  write(path.join(tree, 'src', 'deep', 'b.txt'), 'b');
  write(path.join(tree, 'notes.md'), 'a note');
  write(path.join(tree, 'src', 'locked.bin'), 'read-only'); fs.chmodSync(path.join(tree, 'src', 'locked.bin'), 0o444);
  link(path.join(base, 'live', 'top'), path.join(tree, 'node_modules'));
  link(path.join(base, 'live', 'nested'), path.join(tree, 'src', 'deep', 'assets'));
  const goneTarget = path.join(base, 'live', 'gone'); fs.mkdirSync(goneTarget, { recursive: true });
  link(goneTarget, path.join(tree, 'src', 'dangling')); fs.rmdirSync(goneTarget);
}

function victimsIntact(base) {
  for (const name of VICTIMS) {
    const d = path.join(base, 'live', name);
    assert.deepEqual(fs.existsSync(d) ? fs.readdirSync(d, { recursive: true }).map((f) => f.split(path.sep).join('/')).sort() : 'gone',
      ['precious.txt', 'sub', 'sub/b.txt'], `THE LINK TARGET live/${name} SURVIVES WITH EVERYTHING IN IT`);
    assert.equal(fs.readFileSync(path.join(d, 'precious.txt'), 'utf8'), `live ${name}`);
  }
}

function check(base, variant, out) {
  const work = path.join(base, 'work');
  assert.equal(out.length, 1);
  if (variant === 'no-addon') {
    // Kept exactly as it was: not renamed, not archived, nothing in it touched.
    assert.deepEqual(out[0], { name: 'old-tree', result: 'refused', error: `addon unavailable: ${NO_ADDON.reason}` });
    assert.deepEqual(fs.readdirSync(work), ['old-tree'], 'no tombstone and no archive');
    const tree = path.join(work, 'old-tree');
    assert.deepEqual(fs.readdirSync(tree).sort(), ['a.txt', 'node_modules', 'notes.md', 'src']);
    assert.deepEqual(fs.readdirSync(path.join(tree, 'src')).sort(), ['dangling', 'deep', 'locked.bin']);
    for (const l of ['node_modules', 'src/deep/assets', 'src/dangling']) assert.equal(fs.lstatSync(path.join(tree, l)).isSymbolicLink(), true, `${l} is still a link`);
    victimsIntact(base);
    return;
  }
  assert.deepEqual({ name: out[0].name, result: out[0].result, error: out[0].error }, { name: 'old-tree', result: 'deleted', error: undefined }, JSON.stringify(out));
  assert.equal(out[0].links, 3, 'the remover counted the links it removed as links');
  assert.deepEqual(fs.readdirSync(work).sort(), ['_reaped-md'], 'the tree is gone and no tombstone is left');
  assert.equal(fs.readFileSync(path.join(work, '_reaped-md', 'old-tree', 'notes.md'), 'utf8'), 'a note', 'its .md was archived first');
  victimsIntact(base);
}

const exe = process.env.GUPPY_PACKAGED_EXE || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Guppy', 'Guppy.exe');

const TITLE = { real: "real: the reaped tree's links are removed as links, their targets survive", 'no-addon': 'no-addon: the tree is refused and kept as it was, links and targets untouched' };
for (const variant of ['real', 'no-addon']) {
  test(`${TITLE[variant]} (this process)`, { skip: process.platform !== 'win32' }, () => {
    const base = path.join(jail, `${variant}-node`);
    build(base);
    check(base, variant, run(variant, base));
  });

  test(`${TITLE[variant]}, in the installed Electron as Node`, { skip: process.platform !== 'win32' }, () => {
    const base = path.join(jail, `${variant}-electron`);
    build(base);
    assert.equal(fs.existsSync(exe), true, `installed Guppy executable missing: ${exe}`);
    const r = child.spawnSync(exe, [path.join(__dirname, 'worktree-reaper-link-safe-child.cjs'), variant, base],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 0, `child exit ${r.status}: ${r.stderr || r.stdout}`);
    const res = JSON.parse(r.stdout);
    assert.equal(res.ok, true, res.error);
    assert.match(res.electron, /^\d+\./, 'the child really ran in Electron');
    check(base, variant, res.out);
  });
}

test('SOURCE: the reaper has no recursive rm, no rmSync and no tree walk of its own; a folder goes to the addon', () => {
  const source = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.deepEqual(code.match(/\b(?:rm|rmSync|rmdir|rmdirSync)\s*\([^;]*\brecursive\b[^;]*/g) || [], [], 'no recursive remove call');
  assert.doesNotMatch(code, /\brmSync\b/, 'no rmSync at all');
  assert.doesNotMatch(code, /function removeTree\(|function removeLinks\(/, 'the JS walk and the link pre-pass are gone');
  assert.equal(code.split('links = removeEntry(tomb, ops, ').length - 1, 1, 'applyReap deletes the tombstone with removeEntry');
  const body = /function removeEntry\(p, ops, remover\) \{\n([\s\S]*?)\n\}\n/.exec(code);
  assert.ok(body, 'removeEntry is there');
  assert.match(body[1], /const st = ops\.lstatSync\(p\);/, 'it judges the entry with lstat');
  assert.doesNotMatch(body[1], /\bstatSync\(|realpath|readdir/, 'never a call that follows the link, and no listing: the addon lists');
  assert.equal(body[1].split('rm.removeTree(p)').length - 1, 1, 'a real folder is deleted by the addon, in one place');
  assert.match(body[1], /if \(!rm\.removeTree\) throw /, 'and never without it');
});
