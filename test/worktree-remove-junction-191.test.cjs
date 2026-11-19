'use strict';
require('./tools/own-job.cjs');

/**
 * WORKTREE-REMOVE-JUNCTION-191: stopping an isolated agent or worker must never delete anything
 * outside its worktree. `git worktree remove --force` (Git for Windows) recurses THROUGH a
 * junction and empties its target: on 2026-10-17 a removed worktree whose node_modules was a
 * junction emptied C:/Dunder/MunderDev/node_modules. removeWorktree now removes every link inside
 * the worktree as a LINK first (scripts/worktree-reaper.cjs removeLinks), and refuses the
 * force-remove when one cannot be removed. Every case runs in temp dirs only.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { rmTree } = require('./tools/rm-tree.cjs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const git = loadTs('src/main/git.ts');
const WIN = process.platform === 'win32';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wtj191-'));
test.after(() => rmTree(ROOT, { maxRetries: 10, retryDelay: 50 }));
const run = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8' });

/** A repo with one commit (node_modules ignored, as in Guppy's), a worktree of it, and two link
 *  targets OUTSIDE the worktree, each holding a sentinel file. */
function setup(t) {
  const base = fs.mkdtempSync(path.join(ROOT, 'case-'));
  assert.ok(base.startsWith(os.tmpdir()), 'temp dirs only');
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  run(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\nlinks/\n');
  run(repo, 'add', '.');
  run(repo, 'commit', '-q', '-m', 'init');
  const wt = path.join(base, 'wt');
  run(repo, 'worktree', 'add', '-q', '-b', 'agent', wt, 'main');
  const target = (name) => {
    const dir = path.join(base, name);
    fs.mkdirSync(path.join(dir, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'pkg', 'SENTINEL'), name);
    return dir;
  };
  t.after(() => rmTree(base, { maxRetries: 10, retryDelay: 50 }));
  return { base, repo, wt, target };
}
const sentinel = (dir) => path.join(dir, 'pkg', 'SENTINEL');

test('a junction in the worktree (node_modules -> a shared tree): removeWorktree removes the worktree, the target survives', async (t) => {
  const s = setup(t);
  const shared = s.target('shared-node_modules');
  fs.symlinkSync(shared, path.join(s.wt, 'node_modules'), 'junction');
  // a nested one too: a link anywhere inside, not only at the top
  fs.mkdirSync(path.join(s.wt, 'links', 'deep'), { recursive: true });
  const nested = s.target('nested-target');
  fs.symlinkSync(nested, path.join(s.wt, 'links', 'deep', 'j'), 'junction');

  const r = await git.removeWorktree(s.repo, s.wt);
  assert.equal(r.ok, true, r.error);
  assert.equal(fs.existsSync(sentinel(shared)), true, 'THE JUNCTION TARGET SURVIVES');
  assert.equal(fs.existsSync(sentinel(nested)), true, 'A NESTED JUNCTION TARGET SURVIVES');
  assert.equal(fs.existsSync(s.wt), false, 'the worktree is gone');
  assert.doesNotMatch(run(s.repo, 'worktree', 'list'), /[\\/]wt\b/, 'git no longer lists it');
});

test('a directory symlink in the worktree: the target survives', async (t) => {
  const s = setup(t);
  const target = s.target('symlink-target');
  try { fs.symlinkSync(target, path.join(s.wt, 'node_modules'), 'dir'); } catch (e) {
    if (e.code === 'EPERM') { t.skip('directory symlinks need Developer Mode or admin on this Windows'); return; }
    throw e;
  }
  const r = await git.removeWorktree(s.repo, s.wt);
  assert.equal(r.ok, true, r.error);
  assert.equal(fs.existsSync(sentinel(target)), true, 'THE SYMLINK TARGET SURVIVES');
  assert.equal(fs.existsSync(s.wt), false);
});

test('a link that cannot be removed as a link: the force-remove is REFUSED, nothing is deleted, the reason names it', async (t) => {
  const s = setup(t);
  const shared = s.target('shared');
  const link = path.join(s.wt, 'node_modules');
  fs.symlinkSync(shared, link, 'junction');
  const ops = { unlink: async () => { throw Object.assign(new Error('EBUSY: held'), { code: 'EBUSY' }); }, rmdir: async () => { throw Object.assign(new Error('EBUSY: held'), { code: 'EBUSY' }); } };
  const r = await git.removeWorktree(s.repo, s.wt, ops);
  assert.equal(r.ok, false);
  assert.equal(r.refused, true);
  assert.match(r.error, /node_modules/);
  assert.equal(fs.existsSync(sentinel(shared)), true, 'THE TARGET SURVIVES');
  assert.equal(fs.existsSync(path.join(s.wt, 'a.txt')), true, 'the worktree was not force-removed');
  assert.match(run(s.repo, 'worktree', 'list'), /[\\/]wt\b/, 'still registered');
});

test('unlink refuses the junction (EPERM): a NON-recursive rmdir removes the link alone, the target survives', async (t) => {
  const s = setup(t);
  const shared = s.target('shared');
  fs.symlinkSync(shared, path.join(s.wt, 'node_modules'), 'junction');
  const ops = { unlink: async () => { throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); }, rmdir: (p) => fs.promises.rmdir(p) };
  const r = await git.removeWorktree(s.repo, s.wt, ops);
  assert.equal(r.ok, true, r.error);
  assert.equal(fs.existsSync(sentinel(shared)), true, 'THE TARGET SURVIVES');
  assert.equal(fs.existsSync(s.wt), false);
});

test('a subdirectory that cannot be read (EACCES), or an lstat that fails: REFUSED, nothing deleted (Jim SHOULD-1)', async (t) => {
  const s = setup(t);
  const shared = s.target('shared');
  fs.mkdirSync(path.join(s.wt, 'locked'));
  fs.symlinkSync(shared, path.join(s.wt, 'locked', 'node_modules'), 'junction');
  const locked = path.join(s.wt, 'locked');
  const eacces = (p) => Object.assign(new Error(`EACCES: permission denied, scandir '${p}'`), { code: 'EACCES' });
  const base = { unlink: (p) => fs.promises.unlink(p), rmdir: (p) => fs.promises.rmdir(p) };
  const r = await git.removeWorktree(s.repo, s.wt, { ...base, readdir: async (p) => { if (p === locked) throw eacces(p); return fs.promises.readdir(p); } });
  assert.equal(r.ok, false);
  assert.equal(r.refused, true);
  assert.match(r.error, /locked/);
  assert.equal(fs.existsSync(sentinel(shared)), true, 'THE TARGET SURVIVES');
  assert.equal(fs.existsSync(path.join(s.wt, 'a.txt')), true, 'the worktree was not force-removed');
  const r2 = await git.removeWorktree(s.repo, s.wt, { ...base, lstat: async (p) => { if (p === locked) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); return fs.promises.lstat(p); } });
  assert.equal(r2.refused, true, 'an lstat failure refuses too');
  assert.equal(fs.existsSync(sentinel(shared)), true);
  // ENOENT is not a failure: an entry gone mid-walk (or the whole worktree) is nothing to unlink
  const r3 = await git.removeWorktree(s.repo, s.wt, { ...base, lstat: async (p) => { if (p === path.join(s.wt, 'a.txt')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return fs.promises.lstat(p); } });
  assert.equal(r3.ok, true, r3.error);
  assert.equal(fs.existsSync(sentinel(shared)), true, 'and the normal path still removes the link as a link');
  assert.equal(fs.existsSync(s.wt), false);
});

test('the worker path (finalizeWorkerWorktree): a clean worker worktree with an ignored junction is gc-safe and removed, the target survives', async (t) => {
  const s = setup(t);
  const shared = s.target('shared');
  fs.symlinkSync(shared, path.join(s.wt, 'node_modules'), 'junction');
  // the gate finalizeWorkerWorktree runs first: an ignored junction is not "work"
  const work = await git.worktreeHasUnintegratedWork(s.wt, 'main');
  assert.equal(work.keep, false, work.detail);
  const gc = await git.worktreeIsGcSafe(s.wt, 'main');
  assert.equal(gc.gc, true, gc.detail);
  const r = await git.removeWorktree(s.repo, s.wt);
  assert.equal(r.ok, true, r.error);
  assert.equal(fs.existsSync(sentinel(shared)), true, 'THE TARGET SURVIVES');
  assert.equal(fs.existsSync(s.wt), false);
});

test('a worktree with no links, or already gone: removeWorktree behaves as before', async (t) => {
  const s = setup(t);
  assert.equal((await git.removeWorktree(s.repo, s.wt)).ok, true);
  assert.equal(fs.existsSync(s.wt), false);
  const again = await git.removeWorktree(s.repo, s.wt);
  assert.equal(again.ok, false, 'git still reports a missing worktree');
  assert.notEqual(again.refused, true, 'a missing worktree is not a link refusal');
});

test('the worker scratch dir (removeWorkerScratch): the removal it makes takes a junction inside as a link, THE TARGET SURVIVES on Node and on Electron', async (t) => {
  // The safety claim (data loss if it fails), on whichever runtime runs this file: the suite runs it
  // under Node and under Electron as Node. index.ts cannot be loaded in a test, so this makes the one
  // call removeWorkerScratch makes on its folder, removePathLinkSafe(dir), and pins that the function
  // makes that call and no other removal.
  // RED-BEFORE: with removePathLinkSafe put back to a raw recursive rmSync the two sentinels are gone
  // under Electron; with removeWorkerScratch put back to a raw recursive rmSync the pin fails.
  const s = setup(t);
  const shared = s.target('shared');
  const nested = s.target('nested');
  const scratch = path.join(s.base, 'agents', 'worker-1');
  fs.mkdirSync(path.join(scratch, 'outbox'), { recursive: true });
  fs.writeFileSync(path.join(scratch, 'memory.md'), 'notes');
  fs.writeFileSync(path.join(scratch, 'outbox', 'm.json'), '{}');
  fs.symlinkSync(shared, path.join(scratch, 'node_modules'), 'junction');
  fs.mkdirSync(path.join(scratch, 'work', 'deep'), { recursive: true });
  fs.symlinkSync(nested, path.join(scratch, 'work', 'deep', 'j'), 'junction');

  await loadTs('src/main/linkSafeRemove.ts').removePathLinkSafe(scratch);
  assert.equal(fs.existsSync(scratch), false, 'the scratch dir is gone');
  assert.equal(fs.existsSync(sentinel(shared)), true, 'THE JUNCTION TARGET SURVIVES');
  assert.equal(fs.existsSync(sentinel(nested)), true, 'A NESTED JUNCTION TARGET SURVIVES');

  const src = codeOnly(readSource('src/main/index.ts')).replace(/\r\n/g, '\n');
  const a = src.indexOf('async function removeWorkerScratch(workerId: string): Promise<void> {');
  const b = src.indexOf('\n}\n', a);
  assert.ok(a >= 0 && b > a, 'index.ts has removeWorkerScratch');
  const body = src.slice(a, b);
  assert.match(body, /try \{ await removePathLinkSafe\(dir\); \}/, 'removeWorkerScratch removes its folder with removePathLinkSafe, awaited');
  assert.doesNotMatch(body, /\brm(Sync)?\(|\brmdir(Sync)?\(|\bunlink(Sync)?\(/, 'and with nothing else');
});

test('RUNTIME PIN (documentation only, no product code): a raw recursive rmSync removes a junction inside a folder as a link under Node, and deletes THROUGH it under Electron on Windows', (t) => {
  // Why removeWorkerScratch does not use rmSync({recursive}) (ELECTRON-RMSYNC-LINK-SAFE-108). The test
  // above is the safety claim; this one only records what each runtime's own rm does, so a change in
  // either runtime shows here. Node removes a junction/symlink as a link; Electron's fs, the runtime
  // the app runs on, empties the target.
  const throughLink = !!process.versions.electron && process.platform === 'win32';
  const s = setup(t);
  const shared = s.target('shared');
  const scratch = path.join(s.base, 'agents', 'worker-1');
  fs.mkdirSync(scratch, { recursive: true });
  fs.symlinkSync(shared, path.join(scratch, 'node_modules'), 'junction');
  fs.rmSync(scratch, { recursive: true, force: true });
  assert.equal(fs.existsSync(scratch), false);
  assert.equal(fs.existsSync(sentinel(shared)), !throughLink, throughLink ? 'ELECTRON DELETES THROUGH THE JUNCTION' : 'THE TARGET SURVIVES');
});

test('worker scratch closes watched children before recursive removal', () => {
  const src = codeOnly(readSource('src/main/index.ts'));
  const close = src.indexOf("hive.closeOutboxWatcher(join(dir, 'outbox'))");
  const reader = src.indexOf('readerWatchers.stop(workerId)');
  const rm = src.indexOf('await removePathLinkSafe(dir)');
  assert.ok(close >= 0 && close < rm, 'outbox watcher closes before the removal');
  assert.ok(reader >= 0 && reader < rm, 'reader watcher stops before the removal');
});

test('wiring: every removeWorktree caller in index.ts logs a worktree-remove-refused row on a refusal', () => {
  const src = codeOnly(readSource('src/main/index.ts'));
  const calls = src.match(/await removeWorktree\(|void removeWorktree\(/g) ?? [];
  assert.equal(calls.length, 3, 'teardown, finalize and the gc sweep');
  const logs = src.match(/noteWorktreeRemove\(/g) ?? [];
  assert.ok(logs.length >= 4, 'the helper and its 3 call sites');
  assert.match(src, /kind: 'worktree-remove-refused'/);
  // no other `git worktree remove` call in src/main
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'src', 'main'))) {
    if (!f.endsWith('.ts') || f === 'git.ts') continue;
    assert.doesNotMatch(codeOnly(readSource(`src/main/${f}`)), /'worktree',\s*'remove'/, f);
  }
});
