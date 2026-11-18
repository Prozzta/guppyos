'use strict';
require('./tools/own-job.cjs');
// This suite loads worktree-reaper.cjs, which the mutant census may edit in place.
require('./tools/mutant-runner-helper.cjs').gate(__filename);

/**
 * ELECTRON-RMSYNC-REAPER-108: scripts/worktree-reaper.cjs deletes a tree without following a link.
 *
 * Agents run the reaper through $HIVE_NODE or the shim, which is Electron as Node. There a
 * recursive fs.rmSync deletes THROUGH a Windows junction and empties the folder it points at
 * (RUNTIME PIN in electron-rmsync-link-safe.test.cjs). The script used to rely on its removeLinks
 * pre-pass alone and then call a recursive rmSync; now the delete is a walk of its own
 * (removeTree) that removes a link as a link.
 *
 * The fixture is a folder to reap with a junction at its top and one nested, each pointing at a
 * victim outside it, a read-only file and a link whose target is gone. It is reaped four times:
 * the script as it is, and with the removeLinks pre-pass taken out, each in this process and in
 * the installed Guppy.exe as Node (worktree-reaper-link-safe-child.cjs). Everything is under one
 * temp folder; no git is run and nothing outside the temp folder is named.
 *
 * RED ON BASE: "no-prepass ... Electron" (the recursive rmSync empties both victims).
 * MUTANTS:
 *   R1 removeTree(tomb, ops) -> the recursive ops.rmSync    -> no-prepass, Electron; SOURCE
 *   R2 removeTree lstatSync -> statSync (follows the link)  -> no-prepass, both runtimes; SOURCE
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const child = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run, SRC } = require('./worktree-reaper-link-safe-child.cjs');

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

function check(base, variant, out) {
  const work = path.join(base, 'work');
  assert.equal(out.length, 1);
  assert.deepEqual({ name: out[0].name, result: out[0].result, error: out[0].error }, { name: 'old-tree', result: 'deleted', error: undefined }, JSON.stringify(out));
  assert.equal(out[0].links, variant === 'real' ? 3 : 0, 'the pre-pass counted the links (or was taken out)');
  assert.deepEqual(fs.readdirSync(work).sort(), ['_reaped-md'], 'the tree is gone and no tombstone is left');
  assert.equal(fs.readFileSync(path.join(work, '_reaped-md', 'old-tree', 'notes.md'), 'utf8'), 'a note', 'its .md was archived first');
  for (const name of VICTIMS) {
    const d = path.join(base, 'live', name);
    assert.deepEqual(fs.existsSync(d) ? fs.readdirSync(d, { recursive: true }).map((f) => f.split(path.sep).join('/')).sort() : 'gone',
      ['precious.txt', 'sub', 'sub/b.txt'], `THE LINK TARGET live/${name} SURVIVES WITH EVERYTHING IN IT`);
    assert.equal(fs.readFileSync(path.join(d, 'precious.txt'), 'utf8'), `live ${name}`);
  }
}

// The runner jails LOCALAPPDATA; the shared helper finds the installed app read-only or gives a skip reason.
const guppy = require('./tools/installed-guppy.cjs').installedGuppy();
const exe = guppy.exe;

for (const variant of ['real', 'no-prepass']) {
  test(`${variant}: the reaped tree's links are removed as links, their targets survive (this process)`, { skip: process.platform !== 'win32' }, () => {
    const base = path.join(jail, `${variant}-node`);
    build(base);
    check(base, variant, run(variant, base));
  });

  test(`${variant}: the reaped tree's links are removed as links, their targets survive, in the installed Electron as Node`, { skip: guppy.skip }, () => {
    const base = path.join(jail, `${variant}-electron`);
    build(base);
    assert.equal(fs.existsSync(exe), true, `installed Guppy executable missing: ${exe}`);
    const r = child.spawnSync(exe, [path.join(__dirname, 'worktree-reaper-link-safe-child.cjs'), variant, base],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 60_000, windowsHide: true });
    assert.equal(r.status, 0, `child exit ${r.status}: ${r.stderr || r.stdout}`);
    const res = JSON.parse(r.stdout);
    assert.equal(res.ok, true, res.error);
    assert.match(res.electron, /^\d+\./, 'the child really ran in Electron');
    check(base, variant, res.out);
  });
}

test('SOURCE: the reaper has no recursive rm, rmSync, rmdir or rmdirSync; applyReap deletes with removeTree', () => {
  const source = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.deepEqual(code.match(/\b(?:rm|rmSync|rmdir|rmdirSync)\s*\([^;]*\brecursive\b[^;]*/g) || [], [], 'no recursive remove call');
  assert.doesNotMatch(code, /\brmSync\b/, 'no rmSync at all');
  assert.equal(code.split('removeTree(tomb, ops);').length - 1, 1, 'applyReap deletes the tombstone with removeTree');
  const body = /function removeTree\(p, ops\) \{\n([\s\S]*?)\n\}\n/.exec(code);
  assert.ok(body, 'removeTree is there');
  assert.match(body[1], /ops\.lstatSync\(p\)/, 'it judges each entry with lstat');
  assert.doesNotMatch(body[1], /\bstatSync\(|realpath/, 'never a call that follows the link');
});
