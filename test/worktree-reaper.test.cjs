'use strict';
/**
 * WORKTREE-REAPER (1.1.80 candidate): scripts/worktree-reaper.cjs.
 * - The planner is pure: one synthetic entry per KEEP/REAP rule.
 * - The fact collector and the apply step run on a REAL fixture under a temp folder: a git repo with
 *   tags v1.1.76..78, worktrees, folders, logs and junctions. Never the live _work.
 * - Ages are judged against a clock 48 h ahead, so the fixture is "old" without touching mtimes;
 *   a "recent" item gets an mtime 1 h before that clock.
 * Named mutants (census at the end, compiled from text, no file written), each must die:
 *   W1 recent-24h dropped          W2 current-release dropped     W3 newest-two-shipped dropped
 *   W4 junction-target dropped     W5 junction-target one pass    W6 uncommitted-changes dropped
 *   W7 unreachable-head dropped    W8 contains-git dropped        W9 git-repo dropped
 *   W10 no tombstone rename (an in-use folder is deleted)         W11 links not removed as links
 *   W12 a hash such as a170e parses as a version                  W13 a dry run applies
 *   (Creed's audit) W14 untracked-work dropped   W15 running-exe dropped from the plan
 *   W16 no running-exe re-list before the rename  W17 a bare repo is a plain folder
 *   W18 shipped from local tags (an unpushed tag counts)   W19 prune despite a partial worktree
 *   W20 --protect ignored
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');

const SRC = path.join(__dirname, '..', 'scripts', 'worktree-reaper.cjs');
const REAL = require(SRC);
const DAY = 24 * 60 * 60 * 1000;
for (const k of Object.keys(process.env)) if (k.startsWith('GIT_')) delete process.env[k];   // never the caller's repo
const JAIL = fs.mkdtempSync(path.join(os.tmpdir(), 'reaper-'));
test.after(() => fs.rmSync(JAIL, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

// ─── The pure planner ────────────────────────────────────────────────────────

const NOW = 10 * DAY;
const OLD = NOW - 3 * DAY;
const ROOT = path.resolve('/w');
function ent(name, kind, extra = {}) {
  return { name, path: path.join(ROOT, name), kind, newestMs: OLD, version: REAL.parseVersion(name), links: [], ...extra };
}
const wt = (name, w = {}, extra = {}) => ent(name, 'worktree', { worktree: { dirty: false, headOnRef: true, shippedAncestor: false, ...w }, ...extra });

function planChecks(R) {
  const entries = [
    ent('recent-170', 'folder', { newestMs: NOW - 60 * 60 * 1000 }),
    wt('rc-1179'), wt('jim-cut180'),
    wt('andy-cut178'), wt('andy-cut177'), wt('andy-cut176'),
    wt('fix-175', { dirty: true }), wt('detached-175', { headOnRef: false }),
    wt('topic-merged', { shippedAncestor: true }), wt('topic-open'),
    ent('creed-175', 'folder', { nestedGit: true }), ent('gate-175-run', 'folder'), ent('notes', 'folder'),
    ent('jim-178', 'repo'), ent('hive-backups', 'folder'), ent('_audit-md-kept', 'folder'),
    ent('old-170.log', 'log'), ent('x.md', 'other'),
    // a chain: kept 'shared-deps' links into 'gate-171', which links into 'gate-172'
    ent('shared-deps', 'folder', { links: [{ path: path.join(ROOT, 'shared-deps', 'nm'), target: path.join(ROOT, 'gate-171', 'nm') }] }),
    ent('gate-171', 'folder', { links: [{ path: path.join(ROOT, 'gate-171', 'nm', 'x'), target: path.join(ROOT, 'gate-172') }] }),
    ent('gate-172', 'folder'),
    wt('untracked-175', { untracked: 2 }),
    ent('gate-174-app', 'folder', { runningExe: path.join(ROOT, 'gate-174-app', 'win-unpacked', 'app.exe') }),
    ent('gate-173', 'folder')
  ];
  const plan = R.planReap({ root: ROOT, now: NOW, shipped: [78, 77, 76], entries }, { protect: [path.join(ROOT, 'gate-173', 'node_modules')] });
  const by = Object.fromEntries(plan.map((r) => [r.name, `${r.action}:${r.reason}`]));
  assert.equal(by['recent-170'], 'keep:recent-24h', 'W1: anything changed in the last 24 h is kept');
  assert.equal(by['rc-1179'], 'keep:current-release', 'W2: the rc newer than the newest shipped tag is kept');
  assert.equal(by['jim-cut180'], 'keep:current-release', 'W2: the next release is kept');
  assert.equal(by['andy-cut178'], 'keep:newest-two-shipped', 'W3: the newest shipped cut is kept');
  assert.equal(by['andy-cut177'], 'keep:newest-two-shipped', 'W3: the second newest shipped cut is kept');
  assert.equal(by['andy-cut176'], 'reap:shipped', 'the third newest shipped cut is reaped');
  assert.equal(by['fix-175'], 'keep:uncommitted-changes', 'W6: a worktree with uncommitted changes is kept');
  assert.equal(by['detached-175'], 'keep:unreachable-head', 'W7: a HEAD no branch or tag holds is kept');
  assert.equal(by['topic-merged'], 'reap:shipped', 'an unversioned worktree whose HEAD is in the newest tag is reaped');
  assert.equal(by['topic-open'], 'keep:not-shipped', 'unshipped work is kept');
  assert.equal(by['creed-175'], 'keep:contains-git', 'W8: a folder holding a repo or worktree is never deleted as a folder');
  assert.equal(by['gate-175-run'], 'reap:obsolete-build-folder');
  assert.equal(by['notes'], 'keep:unversioned-folder');
  assert.equal(by['jim-178'], 'keep:git-repo', 'W9: a clone is never reaped');
  assert.equal(by['hive-backups'], 'keep:keep-list');
  assert.equal(by['_audit-md-kept'], 'keep:keep-list', 'god boundary: _audit-md-kept');
  assert.equal(by['old-170.log'], 'reap:old-log');
  assert.equal(by['x.md'], 'keep:not-a-candidate');
  assert.equal(by['shared-deps'], 'keep:unversioned-folder');
  assert.equal(by['gate-171'], 'keep:junction-target', 'W4: a kept entry links into it');
  assert.equal(by['gate-172'], 'keep:junction-target', 'W5: a target kept for a link keeps ITS link targets (fixpoint)');
  assert.equal(by['untracked-175'], 'keep:untracked-work', 'W14: a worktree with new files nobody has added yet is kept');
  assert.equal(by['gate-174-app'], 'keep:running-exe', 'W15: a folder a running process was started from is kept');
  assert.equal(by['gate-173'], 'keep:junction-target', 'W20: --protect keeps what an outside link points into');
}

function parseChecks(R) {
  const cases = [['1.1.77', 77], ['release-1.1.77', 77], ['rc/1.1.79', 79], ['rc-1176', 76], ['andy-cut177', 77], ['fix/177-zt', 77],
    ['jim-179-model', 79], ['perf-149', 49], ['andy-te0', null], ['gate2-9d22b2e0', null], ['a170e', null], ['x-a170e9', null], ['', null]];
  for (const [s, v] of cases) assert.equal(R.parseVersion(s), v, `W12: parseVersion(${JSON.stringify(s)})`);
  assert.deepEqual(R.shippedVersions(['v1.1.76', 'v1.1.78', 'v1.1.77', 'v2.0.0', 'x']), [78, 77, 76]);
}

test('the planner: every KEEP and REAP rule, the junction-target fixpoint, god\'s boundaries', () => planChecks(REAL));
test('versions: names, branches and tags; a hash is not a version', () => parseChecks(REAL));

// ─── A real fixture ──────────────────────────────────────────────────────────

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, '-c', 'core.autocrlf=false', ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const link = (target, at) => fs.symlinkSync(target, at, process.platform === 'win32' ? 'junction' : 'dir');
const write = (p, s = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };

/** tmp/<n>/repo (tags v1.1.76..78) and tmp/<n>/work holding every kind of entry. */
function fixture() {
  const base = fs.mkdtempSync(path.join(JAIL, 'fx-'));
  const repo = path.join(base, 'repo'); const work = path.join(base, 'work');
  fs.mkdirSync(repo); fs.mkdirSync(work);
  git(repo, 'init', '-q', '-b', 'master');
  // a throwaway repo's own identity (repo-local config; never -c user.* or the caller's global one)
  git(repo, 'config', 'user.name', 'fixture'); git(repo, 'config', 'user.email', 'fixture@example.invalid');
  write(path.join(repo, 'a.txt'), '1'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'c1'); git(repo, 'tag', 'v1.1.76');
  write(path.join(repo, 'a.txt'), '2'); git(repo, 'commit', '-qam', 'c2'); git(repo, 'tag', 'v1.1.77');
  write(path.join(repo, 'a.txt'), '3'); git(repo, 'commit', '-qam', 'c3'); git(repo, 'tag', 'v1.1.78');
  // shipped = the tags on origin; a LOCAL-only v1.1.79 (an unpushed cut) must not count
  git(base, 'clone', '-q', '--bare', repo, path.join(base, 'origin.git')); git(repo, 'remote', 'add', 'origin', path.join(base, 'origin.git'));
  git(repo, 'tag', 'v1.1.79');
  // an ignored note (archived when its tree is reaped) vs untracked new work (keeps its tree)
  fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), 'notes.md\n');
  // git worktree add [-b <branch> | --detach] <path> <commit>
  const add = (name, ...args) => { const commit = args.pop(); git(repo, 'worktree', 'add', '-q', ...args, path.join(work, name), commit); };
  add('andy-cut175', '-b', 'release-1.1.75', 'v1.1.76');
  add('andy-cut177', '-b', 'release-1.1.77', 'v1.1.77');
  add('jim-cut179', '-b', 'rc/1.1.79', 'v1.1.78');
  add('andy-cut176', '-b', 'release-1.1.76', 'v1.1.76');
  add('dirty-175', '-b', 'fix/175-dirty', 'v1.1.76');
  add('detached-175', '--detach', 'v1.1.76');
  add('topic-merged', '-b', 'topic-a', 'v1.1.77');
  add('topic-open', '-b', 'topic-b', 'v1.1.78');
  add('untracked-175', '-b', 'fix/175-new', 'v1.1.76');
  write(path.join(work, 'untracked-175', 'src', 'new.ts'), 'export const x = 1;');
  write(path.join(work, 'dirty-175', 'a.txt'), 'edited');
  write(path.join(work, 'detached-175', 'b.txt')); git(path.join(work, 'detached-175'), 'add', '.'); git(path.join(work, 'detached-175'), 'commit', '-qm', 'lost');
  write(path.join(work, 'topic-open', 'b.txt')); git(path.join(work, 'topic-open'), 'add', '.'); git(path.join(work, 'topic-open'), 'commit', '-qm', 'open');
  // node_modules: real in andy-cut176 (a junction target of the kept rc tree); a junction in topic-merged
  write(path.join(work, 'andy-cut176', 'node_modules', 'dep', 'index.js'));
  link(path.join(work, 'andy-cut176', 'node_modules'), path.join(work, 'jim-cut179', 'node_modules'));
  write(path.join(work, 'shared-deps', 'dep', 'index.js'), 'KEEP ME');
  link(path.join(work, 'shared-deps'), path.join(work, 'topic-merged', 'node_modules'));
  write(path.join(work, 'topic-merged', 'notes.md'), 'untracked note');
  // folders and logs
  write(path.join(work, 'gate-175-run', 'run.txt')); write(path.join(work, 'gate-175-run', 'report.md'), 'R'); write(path.join(work, 'gate-175-run', 'sub', 'x.md'), 'X');
  write(path.join(work, 'gate-175-run', 'node_modules', 'pkg', 'README.md'), 'dep readme');
  fs.mkdirSync(path.join(work, 'creed-175', 'src'), { recursive: true }); git(path.join(work, 'creed-175', 'src'), 'init', '-q');
  write(path.join(work, 'notes', 'n.txt')); write(path.join(work, 'fresh-170', 'f.txt'));
  fs.mkdirSync(path.join(work, 'jim-178')); git(path.join(work, 'jim-178'), 'init', '-q');
  write(path.join(work, 'old-170.log')); write(path.join(work, 'suite-175.log')); write(path.join(work, 'creed-179-suite.log'));
  write(path.join(work, '_audit-md-kept', 'a.md'));
  // bare repos (a scrub mirror): at the top, and inside a versioned folder
  git(base, 'clone', '-q', '--bare', repo, path.join(work, 'mirror-175.git'));
  fs.mkdirSync(path.join(work, 'creed-174')); git(base, 'clone', '-q', '--bare', repo, path.join(work, 'creed-174', 'backup.git'));
  // a top-level link protects its target
  write(path.join(work, 'gate-174-linked', 'x.txt')); link(path.join(work, 'gate-174-linked'), path.join(work, 'latest'));
  const now = Date.now() + 2 * DAY;
  const recent = new Date(now - 60 * 60 * 1000);
  for (const p of [path.join(work, 'fresh-170', 'f.txt'), path.join(work, 'suite-175.log')]) fs.utimesSync(p, recent, recent);
  return { base, repo, work, now };
}

function collectChecks(R, fx) {
  const facts = R.collectFacts({ root: fx.work, repos: [fx.repo], now: fx.now, exes: [] });
  assert.deepEqual(facts.shipped, [78, 77, 76], 'W18: shipped = origin\'s tags; the local-only v1.1.79 does not count');
  const by = Object.fromEntries(R.planReap(facts).map((r) => [r.name, `${r.action}:${r.reason}`]));
  assert.equal(by['mirror-175.git'], 'keep:git-repo', 'W17: a bare repo is a repo');
  assert.equal(by['creed-174'], 'keep:contains-git', 'W17: a folder holding a bare repo holds git');
  assert.equal(by['untracked-175'], 'keep:untracked-work', 'W14: untracked new work keeps its tree');
  assert.deepEqual(by, {
    'untracked-175': 'keep:untracked-work', 'mirror-175.git': 'keep:git-repo', 'creed-174': 'keep:contains-git',
    'gate-174-linked': 'keep:junction-target', 'latest': 'keep:not-a-candidate',
    'andy-cut175': 'reap:shipped', 'andy-cut177': 'keep:newest-two-shipped', 'jim-cut179': 'keep:current-release',
    'andy-cut176': 'keep:junction-target', 'dirty-175': 'keep:uncommitted-changes', 'detached-175': 'keep:unreachable-head',
    'topic-merged': 'reap:shipped', 'topic-open': 'keep:not-shipped', 'shared-deps': 'keep:unversioned-folder',
    'gate-175-run': 'reap:obsolete-build-folder', 'creed-175': 'keep:contains-git', 'notes': 'keep:unversioned-folder',
    'fresh-170': 'keep:recent-24h', 'jim-178': 'keep:git-repo', 'old-170.log': 'reap:old-log', 'suite-175.log': 'keep:recent-24h',
    'creed-179-suite.log': 'keep:current-release', '_audit-md-kept': 'keep:keep-list'
  });
  return facts;
}

test('REAL fixture: the facts (git worktrees, nested repos, links, ages) give the expected plan', () => {
  collectChecks(REAL, fixture());
});

function applyChecks(R) {
  const fx = fixture();
  const plan = R.planReap(R.collectFacts({ root: fx.work, repos: [fx.repo], now: fx.now, exes: [] }));
  const results = R.applyReap(plan, { root: fx.work, repos: [fx.repo], now: fx.now, exes: () => [] });
  const res = Object.fromEntries(results.map((r) => [r.name, r]));
  for (const n of ['andy-cut175', 'topic-merged', 'gate-175-run', 'old-170.log']) {
    assert.equal(res[n].result, 'deleted', `${n}: ${JSON.stringify(res[n])}`);
    assert.equal(fs.existsSync(path.join(fx.work, n)), false, `${n} is gone`);
  }
  assert.deepEqual(fs.readdirSync(fx.work).filter((n) => /\.reaping-/.test(n)), [], 'no tombstone left');
  assert.equal(res['topic-merged'].links, 1, 'W11: the node_modules junction was removed as a link');
  assert.equal(fs.readFileSync(path.join(fx.work, 'shared-deps', 'dep', 'index.js'), 'utf8'), 'KEEP ME', 'the junction target is intact');
  assert.ok(fs.existsSync(path.join(fx.work, 'andy-cut176', 'node_modules', 'dep', 'index.js')), 'the kept rc tree\'s junction target is intact');
  assert.equal(fs.readFileSync(path.join(fx.work, '_reaped-md', 'topic-merged', 'notes.md'), 'utf8'), 'untracked note', 'a worktree\'s untracked .md is archived');
  assert.equal(fs.readFileSync(path.join(fx.work, '_reaped-md', 'gate-175-run', 'sub', 'x.md'), 'utf8'), 'X', 'a folder\'s .md are archived with their paths');
  assert.equal(fs.existsSync(path.join(fx.work, '_reaped-md', 'gate-175-run', 'node_modules')), false, 'never a dependency\'s README');
  const list = git(fx.repo, 'worktree', 'list');
  assert.doesNotMatch(list, /andy-cut175|topic-merged/, 'the reaped worktrees were pruned from the repo');
  assert.match(list, /andy-cut177/);
  for (const n of ['andy-cut177', 'jim-cut179', 'andy-cut176', 'dirty-175', 'detached-175', 'topic-open', 'creed-175', 'fresh-170', 'jim-178', 'suite-175.log', 'notes', 'untracked-175', 'mirror-175.git', 'creed-174', 'gate-174-linked']) {
    assert.ok(fs.existsSync(path.join(fx.work, n)), `${n} is kept`);
  }
  assert.equal(fs.readFileSync(path.join(fx.work, 'dirty-175', 'a.txt'), 'utf8'), 'edited', 'uncommitted work untouched');
  assert.equal(git(fx.repo, 'rev-parse', 'release-1.1.75'), git(fx.repo, 'rev-parse', 'v1.1.76'), 'the branch of a reaped worktree is kept');
}
test('REAL fixture, --apply: the reaped entries are gone through a tombstone; links removed as links; targets, kept trees and .md notes intact; worktrees pruned', () => applyChecks(REAL));

function inUseChecks(R) {
  const fx = fixture();
  const plan = R.planReap(R.collectFacts({ root: fx.work, repos: [fx.repo], now: fx.now, exes: [] }));
  const busy = path.join(fx.work, 'gate-175-run');
  const ops = { ...fs, renameSync: (a, b) => { if (path.resolve(a) === busy) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return fs.renameSync(a, b); } };
  const res = Object.fromEntries(R.applyReap(plan, { root: fx.work, repos: [fx.repo], now: fx.now, ops, exes: () => [] }).map((r) => [r.name, r]));
  assert.equal(res['gate-175-run'].result, 'in-use', 'W10: a folder that cannot be renamed (an open file, a cwd) is kept');
  assert.ok(fs.existsSync(path.join(busy, 'run.txt')), 'and nothing in it was deleted');
  assert.equal(res['andy-cut175'].result, 'deleted', 'the others still go');
}
test('REAL fixture: an in-use folder (the tombstone rename fails) is kept whole', () => inUseChecks(REAL));

function dryRunChecks(R) {
  const fx = fixture();
  const lines = [];
  const { plan, results } = R.main(['--root', fx.work, '--repo', fx.repo, '--now', String(fx.now)], (s) => lines.push(s), { exes: () => [] });
  assert.equal(results, null, 'W13: no --apply, no apply');
  assert.ok(plan.some((r) => r.action === 'reap'), 'the dry run does find reapable entries');
  for (const r of plan) assert.ok(fs.existsSync(r.path), `${r.name} still exists after a dry run`);
  assert.match(lines[0], /^DRY RUN/);
}
test('the CLI is a DRY RUN by default: it lists, it deletes nothing', () => dryRunChecks(REAL));

function recheckChecks(R) {
  const fx = fixture();
  const plan = R.planReap(R.collectFacts({ root: fx.work, repos: [fx.repo], now: fx.now, exes: [] }));
  // an app started from gate-175-run AFTER the plan was made (Windows still renames such a folder)
  const exe = path.join(fx.work, 'gate-175-run', 'win-unpacked', 'app.exe');
  const res = Object.fromEntries(R.applyReap(plan, { root: fx.work, repos: [fx.repo], now: fx.now, exes: () => [exe] }).map((r) => [r.name, r]));
  assert.equal(res['gate-175-run'].result, 'in-use', 'W16: the running exes are re-listed before the rename');
  assert.ok(fs.existsSync(path.join(fx.work, 'gate-175-run', 'run.txt')), 'and nothing in it was deleted');
  assert.equal(res['andy-cut175'].result, 'deleted', 'the others still go');
}
test('REAL fixture: an exe that started after the plan keeps its folder (re-listed at apply)', () => recheckChecks(REAL));

function partialChecks(R) {
  const fx = fixture();
  const plan = R.planReap(R.collectFacts({ root: fx.work, repos: [fx.repo], now: fx.now, exes: [] }));
  const ops = { ...fs, rmSync: (p, o) => { if (path.basename(p).startsWith('andy-cut175.reaping-')) throw Object.assign(new Error('locked'), { code: 'EBUSY' }); return fs.rmSync(p, o); } };
  const results = R.applyReap(plan, { root: fx.work, repos: [fx.repo], now: fx.now, ops, exes: () => [] });
  const res = Object.fromEntries(results.map((r) => [r.name, r]));
  assert.equal(res['andy-cut175'].result, 'partial');
  assert.equal(res['(git worktree prune)'] && res['(git worktree prune)'].result, 'skipped', 'W19: no prune while a worktree is partial');
  assert.match(git(fx.repo, 'worktree', 'list'), /andy-cut175/, 'W19: the partial worktree\'s admin entry survives');
}
test('REAL fixture: a partial worktree is not orphaned by git worktree prune', () => partialChecks(REAL));

test('REAL process (Windows): a folder a running exe was started from is kept, at plan and at apply', { skip: process.platform !== 'win32' }, async () => {
  const fx = fixture();
  const exe = path.join(fx.work, 'gate-174-run', 'bin', 'node.exe');
  fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.copyFileSync(process.execPath, exe);
  const { spawn } = require('node:child_process');
  const child = spawn(exe, ['-e', 'setTimeout(() => {}, 60000)'], { cwd: fx.base, windowsHide: true, stdio: 'ignore' });
  try {
    await new Promise((r, j) => { child.once('spawn', r); child.once('error', j); });
    const facts = REAL.collectFacts({ root: fx.work, repos: [fx.repo], now: fx.now });   // the real process list
    const row = REAL.planReap(facts).find((r) => r.name === 'gate-174-run');
    assert.equal(`${row.action}:${row.reason}`, 'keep:running-exe');
    const forced = [{ ...row, action: 'reap' }];
    const [res] = REAL.applyReap(forced, { root: fx.work, now: fx.now });   // the real re-list
    assert.equal(res.result, 'in-use');
    assert.ok(fs.existsSync(exe));
  } finally {
    child.kill();
    await new Promise((r) => (child.exitCode !== null || child.signalCode !== null ? r() : child.once('exit', r)));
  }
});

test('the CLI refuses a missing --root/--repo and an unknown flag', () => {
  assert.throws(() => REAL.main(['--repo', 'x'], () => {}), /usage/);
  assert.throws(() => REAL.main(['--root', 'x', '--repo', 'y', '--force'], () => {}), /unknown argument: --force/);
});

// ─── Mutant census ───────────────────────────────────────────────────────────

const MUTANTS = [
  ['W1 recent-24h dropped', "    if (!(e.newestMs <= cutoff)) return ['keep', 'recent-24h'];\n", '', planChecks],
  ['W2 current-release dropped', "    if (e.version !== null && latest !== null && e.version > latest) return ['keep', 'current-release'];\n", '', planChecks],
  ['W3 newest-two-shipped dropped', "    if (e.version !== null && newestTwo.has(e.version)) return ['keep', 'newest-two-shipped'];\n", '', planChecks],
  ['W4 junction-target dropped', "{ r.action = 'keep'; r.reason = 'junction-target'; changed = true; }", '{ changed = false; }', planChecks],
  ['W5 junction-target one pass', "r.reason = 'junction-target'; changed = true; }", "r.reason = 'junction-target'; }", planChecks],
  ['W6 uncommitted-changes dropped', "      if (w.dirty) return ['keep', 'uncommitted-changes'];\n", '', planChecks],
  ['W7 unreachable-head dropped', "      if (!w.headOnRef) return ['keep', 'unreachable-head'];\n", '', planChecks],
  ['W8 contains-git dropped', "    if (e.nestedGit) return ['keep', 'contains-git'];\n", '', planChecks],
  ['W9 git-repo dropped', "    if (e.kind === 'repo') return ['keep', 'git-repo'];\n", '', planChecks],
  ['W10 no tombstone rename', 'if (tomb !== e.path) ops.renameSync(e.path, tomb);', '', inUseChecks],
  ['W11 links not removed as links', 'links = removeLinks(tomb, ops);', 'links = 0;', applyChecks],
  ['W12 a hash parses as a version', "m = /(?:^|[^0-9.])1(\\d{2})(?=$|[-_./])/.exec(s);", "m = /(?:^|[^0-9.])1(\\d{2})/.exec(s);", parseChecks],
  ['W13 a dry run applies', 'const results = o.apply ? applyReap(', 'const results = true ? applyReap(', dryRunChecks],
  ['W14 untracked-work dropped', "      if (w.untracked) return ['keep', 'untracked-work'];\n", '', planChecks],
  ['W15 running-exe dropped', "    if (e.runningExe) return ['keep', 'running-exe'];\n", '', planChecks],
  ['W16 no re-list at apply', "    if (exe) { results.push(", "    if (false) { results.push(", recheckChecks],
  ['W17 a bare repo is a plain folder', ' || isBare(p)) kind', ') kind', (R) => collectChecks(R, fixture())],
  ['W18 shipped from local tags', "  if (!remotes.includes('origin')) return", '  return', (R) => collectChecks(R, fixture())],
  ['W19 prune despite a partial worktree', "    if (partialWt) results.push(", "    if (false) results.push(", partialChecks],
  ['W20 --protect ignored', '[...(opts.protect || []), ...rows', '[...rows', planChecks]
];

function compile(text) {
  const m = new Module(SRC, module);
  m.filename = SRC; m.paths = Module._nodeModulePaths(path.dirname(SRC));
  m._compile(text, SRC);
  return m.exports;
}

test('MUTANT CENSUS WORKTREE-REAPER: W1-W13 each apply once and die at their named check', async (t) => {
  const source = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
  for (const [name, from, to, killer] of MUTANTS) {
    await t.test(name, () => {
      assert.equal(source.split(from).length - 1, 1, `${name}: the edit applies exactly once`);
      const R = compile(source.replace(from, () => to));
      let died = null;
      try { killer(R); } catch (e) { died = e; }
      assert.ok(died instanceof assert.AssertionError, `SURVIVED: ${name}${died ? ` (died of ${died.message})` : ''}`);
    });
  }
});
