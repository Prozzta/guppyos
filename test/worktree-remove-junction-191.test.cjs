'use strict';

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
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { readSource, codeOnly } = require('./read-source.cjs');

const git = loadTs('src/main/git.ts');
const WIN = process.platform === 'win32';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'wtj191-'));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
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
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
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

test('the worker scratch dir (rmSync recursive): a junction inside is removed as a link, its target survives', (t) => {
  // removeWorkerScratch deletes HIVE_ROOT/agents/<id> with rmSync({recursive}); Node removes a
  // junction/symlink there as a link. Pinned so a runtime change cannot reopen the hole silently.
  const s = setup(t);
  const shared = s.target('shared');
  const scratch = path.join(s.base, 'agents', 'worker-1');
  fs.mkdirSync(scratch, { recursive: true });
  fs.symlinkSync(shared, path.join(scratch, 'node_modules'), 'junction');
  fs.rmSync(scratch, { recursive: true, force: true });
  assert.equal(fs.existsSync(scratch), false);
  assert.equal(fs.existsSync(sentinel(shared)), true, 'THE TARGET SURVIVES');
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
