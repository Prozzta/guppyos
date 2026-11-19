'use strict';
require('./tools/own-job.cjs');

/**
 * GIT-RUN-HARDEN-108: a git call Guppy makes on its own (status, log, the claims snapshot, a worktree
 * for an agent) must not run a program the repository names. A repo's config can name one for the
 * file-system monitor (run by `status`), for a diff text conversion (run by `log -p`) and as a hook
 * (run by `worktree add` and a checkout); the app's own environment can point git at another repo.
 *
 * Each case plants a program that writes a marker file, proves with a plain `git` that the plant
 * really runs on this machine, then calls the product and asserts no marker. Temp dirs only.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { rmTree } = require('./tools/rm-tree.cjs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const git = loadTs('src/main/git.ts');
const world = loadTs('src/main/claims/worldSnapshot.ts');
const { DerivedGit } = loadTs('src/main/claims/derivedGit.ts');
const gitSafe = loadTs('src/main/gitSafe.ts');
const { findExe, resolveExe } = loadTs('src/main/resolveExe.ts');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'grh108-'));
test.after(() => rmTree(ROOT, { maxRetries: 10, retryDelay: 50 }));
const raw = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const fwd = (p) => p.replace(/\\/g, '/');

/** A repo with two commits that change package.json's version, and a marker path beside it. */
function setup() {
  const base = fs.mkdtempSync(path.join(ROOT, 'case-'));
  const repo = path.join(base, 'repo');
  fs.mkdirSync(repo);
  raw(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'package.json'), '{\n  "version": "1.0.0"\n}\n');
  raw(repo, 'add', '.');
  raw(repo, 'commit', '-q', '-m', 'one');
  fs.writeFileSync(path.join(repo, 'package.json'), '{\n  "version": "1.0.1"\n}\n');
  raw(repo, 'commit', '-q', '-am', 'two');
  const marker = path.join(base, 'marker');
  /** Whether the planted program ran since the last look (the marker is removed by the look). */
  const ran = () => { const hit = fs.existsSync(marker); fs.rmSync(marker, { force: true }); return hit; };
  return { base, repo, marker, ran, head: raw(repo, 'rev-parse', 'HEAD').trim() };
}

const plantFsmonitor = (c) => raw(c.repo, 'config', 'core.fsmonitor', `echo hit > '${fwd(c.marker)}'; true`);
function plantTextconv(c) {
  fs.writeFileSync(path.join(c.repo, '.gitattributes'), 'package.json diff=planted\n');
  raw(c.repo, 'config', 'diff.planted.textconv', `echo hit > '${fwd(c.marker)}'; cat`);
}
function plantHook(c) {
  const hook = path.join(c.repo, '.git', 'hooks', 'post-checkout');
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, `#!/bin/sh\necho hit > '${fwd(c.marker)}'\n`, { mode: 0o755 });
}

test('GIT-RUN-HARDEN-108: a status read does not run the repo\'s file-system monitor program', async () => {
  const c = setup();
  plantFsmonitor(c);
  raw(c.repo, 'status', '--porcelain');
  assert.ok(c.ran(), 'the plant is live: a plain git status runs the program');

  const st = await git.getStatus(c.repo);
  assert.ok(!('error' in st), `getStatus answers (${st.error})`);
  assert.equal(c.ran(), false, 'git.ts getStatus ran the repo\'s core.fsmonitor program');

  const out = await world.runGit(c.repo, ['status', '--porcelain'], undefined, 5000);
  assert.equal(typeof out, 'string', 'the claims runner answers');
  assert.equal(c.ran(), false, 'the claims snapshot runner ran the repo\'s core.fsmonitor program');
});

test('GIT-RUN-HARDEN-108: a patch log does not run the repo\'s text conversion program', async () => {
  const c = setup();
  plantTextconv(c);
  raw(c.repo, 'log', '-p', '-U0', '--', 'package.json');
  assert.ok(c.ran(), 'the plant is live: a plain git log -p runs the program');

  const bumps = await new DerivedGit(c.repo).bumps();
  assert.equal(c.ran(), false, 'DerivedGit.bumps ran the repo\'s diff textconv program');
  assert.deepEqual([...bumps.keys()].sort(), ['1.0.0', '1.0.1'], 'and it still reads the version bumps');
});

test('GIT-RUN-HARDEN-108: making a worktree and a checkout do not run the repo\'s hooks', async () => {
  const c = setup();
  plantHook(c);
  raw(c.repo, 'worktree', 'add', '-q', path.join(c.base, 'plain'), '-b', 'plain', 'main');
  assert.ok(c.ran(), 'the plant is live: a plain git worktree add runs the hook');

  const made = await git.addWorktree(c.repo, path.join(c.base, 'wt'), 'main');
  assert.deepEqual(made, { ok: true });
  assert.equal(c.ran(), false, 'addWorktree ran the repo\'s post-checkout hook');

  raw(c.repo, 'branch', 'side');
  const sw = await git.checkoutRef(c.repo, 'side', false);
  assert.equal(sw.ok, true, `checkoutRef answers (${sw.error})`);
  assert.equal(c.ran(), false, 'checkoutRef ran the repo\'s post-checkout hook');
});

test('GIT-RUN-HARDEN-108: GIT_* variables in the app\'s own environment do not redirect a call', async (t) => {
  const c = setup();
  const other = setup();
  raw(other.repo, 'switch', '-q', '-c', 'elsewhere');
  // A commit only `c` has: the two setups can make the same shas when they run in one second.
  raw(c.repo, 'commit', '-q', '--allow-empty', '-m', 'only here');
  const head = raw(c.repo, 'rev-parse', 'HEAD').trim();
  const keys = ['GIT_DIR', 'GIT_WORK_TREE'];
  const before = keys.map((k) => process.env[k]);
  t.after(() => keys.forEach((k, i) => { if (before[i] === undefined) delete process.env[k]; else process.env[k] = before[i]; }));
  process.env.GIT_DIR = path.join(other.repo, '.git');
  process.env.GIT_WORK_TREE = other.repo;

  const b = await git.getBranch(c.repo);
  assert.equal(b.current, 'main', 'git.ts reads the repo it was pointed at, not GIT_DIR\'s');
  const out = await world.runGit(c.repo, ['rev-parse', '--abbrev-ref', 'HEAD'], undefined, 5000);
  assert.equal(String(out).trim(), 'main', 'the claims snapshot runner reads the repo it was pointed at');
  assert.equal((await new DerivedGit(c.repo).message(head) ?? '').trim(), 'only here', 'DerivedGit reads the repo it was pointed at');
  // prefetch is the one caller of the stdin runner; what it found is what times() then holds.
  const viaStdin = new DerivedGit(c.repo);
  await viaStdin.prefetch([head]);
  assert.equal(viaStdin.commits.get(head), head, 'the stdin runner of DerivedGit reads the repo it was pointed at');
});

test('GIT-RUN-HARDEN-108: git.ts stops a call whose output passes the cap', async () => {
  const c = setup();
  fs.writeFileSync(path.join(c.repo, 'big.txt'), 'x'.repeat(200_000));
  raw(c.repo, 'add', '.');
  raw(c.repo, 'commit', '-q', '-m', 'big');
  assert.equal(typeof git.runGit, 'function', 'runGit takes a cap and is exported for this pin');
  const over = await git.runGit(c.repo, ['show', 'HEAD:big.txt'], 8000, 50_000);
  assert.equal(over.ok, false);
  assert.match(over.error, /more than 50000 bytes/);
  const under = await git.runGit(c.repo, ['show', 'HEAD:big.txt'], 8000, 500_000);
  assert.equal(under.ok && under.stdout.length, 200_000);
});

test('GIT-RUN-HARDEN-108: a log read does not run the repo\'s signature-check program', async () => {
  const c = setup();
  // Stands in for gpg: it writes the marker, then answers a signing call and a verify call.
  const prog = path.join(c.base, 'sig.sh');
  fs.writeFileSync(prog, [
    '#!/bin/sh',
    `echo hit > '${fwd(c.marker)}'`,
    'for a in "$@"; do case "$a" in --verify) echo "[GNUPG:] GOODSIG 0 t"; exit 0;; esac; done',
    'echo "[GNUPG:] SIG_CREATED " >&2',
    'printf -- "-----BEGIN PGP SIGNATURE-----\n\nabc\n-----END PGP SIGNATURE-----\n"',
    '',
  ].join('\n'), { mode: 0o755 });
  raw(c.repo, 'config', 'gpg.program', fwd(prog));
  raw(c.repo, 'commit', '-q', '-S', '--allow-empty', '-m', 'signed');
  assert.ok(c.ran(), 'the stand-in signed the commit');
  raw(c.repo, 'config', 'log.showSignature', 'true');
  raw(c.repo, 'log', '-1', '--format=%s');
  assert.ok(c.ran(), 'the plant is live: a plain git log runs the program');

  const log = await git.getLog(c.repo, 5);
  assert.ok(Array.isArray(log) && log.length === 3, `getLog answers (${log.error})`);
  assert.equal(c.ran(), false, 'git.ts getLog ran the repo\'s gpg.program');
});

test('GIT-RUN-HARDEN-108: the shared helper names every switch, and keeps only the config-file variables', () => {
  // The pager only starts on a terminal, which a test has not got: its switch is pinned by name here.
  const safe = loadTs('src/main/gitSafe.ts');
  const args = safe.gitSafeArgs(['log', '-1']);
  const sub = args.indexOf('log');
  const config = args.slice(0, sub).filter((a) => a !== '-c').map((a) => a.split('=')[0]).sort();
  assert.deepEqual(config, ['core.fsmonitor', 'core.hooksPath', 'core.pager', 'log.showSignature']);
  assert.ok(args.includes('core.pager=cat') && args.includes('core.fsmonitor=false') && args.includes('log.showSignature=false'));
  assert.deepEqual(args.slice(sub), ['log', '--no-ext-diff', '--no-textconv', '-1']);
  for (const s of ['diff', 'show', 'diff-tree']) assert.deepEqual(safe.gitSafeCommand([s, 'x']), [s, '--no-ext-diff', '--no-textconv', 'x']);
  assert.deepEqual(safe.gitSafeCommand(['status', '--porcelain']), ['status', '--porcelain'], 'status takes no diff flag');
  assert.deepEqual(safe.gitSafeCommand([]), []);

  const env = safe.gitSafeEnv({ PATH: 'p', GIT_DIR: 'd', git_work_tree: 'w', GIT_EXTERNAL_DIFF: 'e', GIT_CONFIG_COUNT: '1', GIT_CONFIG_GLOBAL: 'g', GIT_CONFIG_SYSTEM: 's', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '1' });
  assert.deepEqual(env, { PATH: 'p', GIT_CONFIG_GLOBAL: 'g', GIT_CONFIG_SYSTEM: 's', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' });
});

// ---- Filter drivers (clean / smudge) the repo's own config defines ----

/** A shell program that writes `marker` and passes the content through. */
const passThrough = (marker) => `echo hit > '${fwd(marker)}'; cat`;
/** Commit an attribute that sends package.json through filter `driver`, then leave package.json changed
 *  so a status read has to clean it. Call before the driver is defined. */
function useFilter(c, driver) {
  fs.writeFileSync(path.join(c.repo, '.gitattributes'), `package.json filter=${driver}\n`);
  raw(c.repo, 'add', '.gitattributes');
  raw(c.repo, 'commit', '-q', '-m', 'attributes');
  fs.writeFileSync(path.join(c.repo, 'package.json'), '{\n  "version": "1.0.2"\n}\n');
}
/** Point git at `file` as the person's own (global) config for this test. */
function useGlobalConfig(t, file) {
  const before = process.env.GIT_CONFIG_GLOBAL;
  t.after(() => { if (before === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = before; });
  process.env.GIT_CONFIG_GLOBAL = file;
}

test('GIT-RUN-HARDEN-108: a status read and a new worktree do not run a filter driver from the repo\'s config', async () => {
  const c = setup();
  useFilter(c, 'planted');
  raw(c.repo, 'config', 'filter.planted.clean', passThrough(c.marker));
  raw(c.repo, 'config', 'filter.planted.smudge', passThrough(c.marker));
  raw(c.repo, 'status', '--porcelain');
  assert.ok(c.ran(), 'the plant is live: a plain git status runs the clean program');
  raw(c.repo, 'worktree', 'add', '-q', path.join(c.base, 'plain'), '-b', 'plain', 'main');
  assert.ok(c.ran(), 'the plant is live: a plain git worktree add runs the smudge program');

  const st = await git.getStatus(c.repo);
  assert.ok(!('error' in st), `getStatus answers (${st.error})`);
  assert.equal(c.ran(), false, 'git.ts getStatus ran the repo\'s filter clean program');

  const out = await world.runGit(c.repo, ['status', '--porcelain'], undefined, 5000);
  assert.equal(typeof out, 'string', 'the claims runner answers');
  assert.equal(c.ran(), false, 'the claims snapshot runner ran the repo\'s filter clean program');

  const made = await git.addWorktree(c.repo, path.join(c.base, 'wt'), 'main');
  assert.deepEqual(made, { ok: true });
  assert.equal(c.ran(), false, 'addWorktree ran the repo\'s filter smudge program');
});

test('GIT-RUN-HARDEN-108: a filter driver in a file the repo\'s config includes is not run', async () => {
  const c = setup();
  useFilter(c, 'planted');
  const inc = path.join(c.base, 'inc.cfg');
  raw(c.repo, 'config', '--file', inc, 'filter.planted.clean', passThrough(c.marker));
  raw(c.repo, 'config', 'include.path', fwd(inc));
  raw(c.repo, 'status', '--porcelain');
  assert.ok(c.ran(), 'the plant is live: a plain git status runs the included program');

  const st = await git.getStatus(c.repo);
  assert.ok(!('error' in st), `getStatus answers (${st.error})`);
  assert.equal(c.ran(), false, 'getStatus ran a filter from a file included by the repo\'s config');
});

test('GIT-RUN-HARDEN-108: a filter driver in the per-worktree config is not run', async () => {
  const c = setup();
  useFilter(c, 'planted');
  raw(c.repo, 'config', 'extensions.worktreeConfig', 'true');
  raw(c.repo, 'config', '--worktree', 'filter.planted.clean', passThrough(c.marker));
  raw(c.repo, 'status', '--porcelain');
  assert.ok(c.ran(), 'the plant is live: a plain git status runs the config.worktree program');

  const st = await git.getStatus(c.repo);
  assert.ok(!('error' in st), `getStatus answers (${st.error})`);
  assert.equal(c.ran(), false, 'getStatus ran a filter from the repo\'s config.worktree');
});

test('GIT-RUN-HARDEN-108: a repo that redefines the person\'s own filter driver gets the person\'s one back', async (t) => {
  const c = setup();
  useFilter(c, 'lfslike');
  const globalFile = path.join(c.base, 'global.cfg');
  const globalMarker = path.join(c.base, 'global-marker');
  const globalRan = () => { const hit = fs.existsSync(globalMarker); fs.rmSync(globalMarker, { force: true }); return hit; };
  raw(c.repo, 'config', '--file', globalFile, 'filter.lfslike.clean', passThrough(globalMarker));
  useGlobalConfig(t, globalFile);
  raw(c.repo, 'config', 'filter.lfslike.clean', passThrough(c.marker));
  raw(c.repo, 'status', '--porcelain');
  assert.ok(c.ran(), 'the plant is live: the repo\'s definition wins in a plain git status');
  assert.equal(globalRan(), false, 'and the person\'s one is shadowed by it');

  const st = await git.getStatus(c.repo);
  assert.ok(!('error' in st), `getStatus answers (${st.error})`);
  assert.equal(c.ran(), false, 'getStatus ran the repo\'s redefinition of a global filter driver');
  assert.ok(globalRan(), 'the person\'s own driver ran in its place');
});

test('GIT-RUN-HARDEN-108: a filter driver only the person\'s own config defines (Git LFS style) stays on', async (t) => {
  const c = setup();
  useFilter(c, 'lfslike');
  const globalFile = path.join(c.base, 'global.cfg');
  raw(c.repo, 'config', '--file', globalFile, 'filter.lfslike.clean', passThrough(c.marker));
  raw(c.repo, 'config', '--file', globalFile, 'filter.lfslike.smudge', passThrough(c.marker));
  raw(c.repo, 'config', '--file', globalFile, 'filter.lfslike.required', 'true');
  useGlobalConfig(t, globalFile);

  const st = await git.getStatus(c.repo);
  assert.ok(!('error' in st), `getStatus answers (${st.error})`);
  assert.ok(c.ran(), 'getStatus still runs the person\'s clean program');
  const made = await git.addWorktree(c.repo, path.join(c.base, 'wt'), 'main');
  assert.deepEqual(made, { ok: true });
  assert.ok(c.ran(), 'addWorktree still runs the person\'s smudge program');
});

test('GIT-RUN-HARDEN-108: which calls read the repo\'s filter drivers first, and what the read turns into', () => {
  const safe = loadTs('src/main/gitSafe.ts');
  for (const a of [['status', '--porcelain'], ['diff', '--quiet'], ['switch', 'x'], ['worktree', 'add', 'p'], ['checkout', 'x'], ['cat-file', '--filters', 'HEAD:f'], ['cat-file', '--textconv', 'HEAD:f'], ['made-up'], []]) {
    assert.equal(safe.gitRunsFilters(a), true, `${a.join(' ')} can run a filter`);
  }
  for (const a of [['rev-parse', 'HEAD'], ['rev-list', 'HEAD'], ['merge-base', 'a', 'b'], ['for-each-ref'], ['diff-tree', '-p', 'x'], ['log', '-p'], ['show', 'HEAD:f'], ['branch', '-a'], ['cat-file', '-s', 'x'], ['cat-file', '--batch-check']]) {
    assert.equal(safe.gitRunsFilters(a), false, `${a.join(' ')} reads objects only`);
  }

  const rec = (scope, key, value) => `${scope}\0file:x\0${key}\n${value}\0`;
  const listing = rec('system', 'filter.sys.clean', 'sys-clean')
    + rec('global', 'filter.lfs.clean', 'lfs clean -- %f') + rec('global', 'filter.lfs.required', 'true')
    + rec('global', 'filter.both.clean', 'mine') + rec('local', 'filter.both.clean', 'theirs') + rec('local', 'filter.both.process', 'theirs-p')
    + rec('worktree', 'filter.a.b=c.smudge', 'w') + rec('command', 'filter.cmd.required', 'true');
  assert.deepEqual(safe.repoFilterOverrides(listing), [
    ['filter.both.clean', 'mine'], ['filter.both.smudge', ''], ['filter.both.process', ''], ['filter.both.required', 'false'],
    ['filter.a.b=c.clean', ''], ['filter.a.b=c.smudge', ''], ['filter.a.b=c.required', 'false'],
    ['filter.cmd.clean', ''], ['filter.cmd.smudge', ''], ['filter.cmd.required', 'false'],
  ], 'only drivers with a setting from outside system/global are overridden; sys and lfs are left alone');
  // An empty process setting also stops clean and smudge, so it is written only where it has to be.
  assert.deepEqual(safe.repoFilterOverrides(rec('global', 'filter.p.process', 'mine-p') + rec('global', 'filter.p.required', 'true') + rec('local', 'filter.p.process', 'theirs-p')),
    [['filter.p.clean', ''], ['filter.p.smudge', ''], ['filter.p.process', 'mine-p'], ['filter.p.required', 'true']]);
  assert.deepEqual(safe.repoFilterOverrides(''), []);
});

test('GIT-RUN-HARDEN-108: derivedGit.ts, which does not read the filter drivers, makes object-only calls', () => {
  const safe = loadTs('src/main/gitSafe.ts');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'claims', 'derivedGit.ts'), 'utf8');
  const subs = [...src.matchAll(/await git(?:Stdin)?\(this\.repo, \['([a-z-]+)'((?:, '[^']*')*)/g)];
  assert.equal(subs.length, [...src.matchAll(/await git(?:Stdin)?\(/g)].length, 'every call in the file is read by this scan');
  assert.ok(subs.length >= 15);
  for (const m of subs) {
    const args = [m[1], ...[...m[2].matchAll(/'([^']*)'/g)].map((x) => x[1])];
    assert.equal(safe.gitRunsFilters(args), false, `derivedGit runs "git ${args.join(' ')}", which can run a filter`);
  }
});

test('GIT-RUN-HARDEN-108: when the repo\'s filter drivers cannot be read, the call is not made', async () => {
  const c = setup();
  useFilter(c, 'planted');
  raw(c.repo, 'config', 'filter.planted.clean', passThrough(c.marker));
  // A config file git cannot parse: the read exits with an error, and so does not say what the repo defines.
  fs.appendFileSync(path.join(c.repo, '.git', 'config'), '[broken\n');
  const r = await git.runGit(c.repo, ['status', '--porcelain']);
  assert.equal(r.ok, false);
  assert.match(r.error, /could not list the repo's filter drivers/);
  assert.equal(await world.runGit(c.repo, ['status', '--porcelain'], undefined, 5000), null);
  assert.equal(c.ran(), false);
});

// ---- A program named git in the folder itself ----

const winOnly = { skip: process.platform !== 'win32' && 'only Windows looks a bare program name up in the working directory' };

/**
 * Windows skips the working directory when the STARTING process has NoDefaultCurrentDirectoryInExePath set. Agent
 * shells here set it; the packaged app does not. These tests run as the app does, with the variable absent.
 */
function asTheAppRuns(t) {
  const NAME = 'NoDefaultCurrentDirectoryInExePath';
  const had = Object.prototype.hasOwnProperty.call(process.env, NAME) ? process.env[NAME] : undefined;
  delete process.env[NAME];
  t.after(() => { if (had !== undefined) process.env[NAME] = had; });
}

/** Put a console program that is not git into `dir` under `name`, and prove a bare `git` there runs it. */
function plantProgram(dir, name) {
  fs.copyFileSync(path.join(process.env.SystemRoot, 'System32', 'whoami.exe'), path.join(dir, name));
  let out = '';
  try { out = execFileSync('git', ['/user', '/fo', 'csv', '/nh'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch { /* git itself refuses these arguments */ }
  // whoami answers with the account's SID. The text is never printed: only whether it has that shape.
  assert.ok(/S-1-5-\d+/.test(out), `the plant is live: a bare "git" started in the folder runs ${name}`);
}

for (const name of ['git.exe', 'git.com']) {
  test(`GIT-RUN-HARDEN-108: a ${name} in the repo folder is not run in place of git`, winOnly, async (t) => {
    asTheAppRuns(t);
    const c = setup();
    // A filter driver from the repo's config. If the read of the filter drivers runs the planted
    // program, it learns of none (the plant exits 1, git's "no such key") and the driver is left on.
    useFilter(c, 'planted');
    raw(c.repo, 'config', 'filter.planted.clean', passThrough(c.marker));
    raw(c.repo, 'status', '--porcelain');
    assert.ok(c.ran(), 'the plant is live: a plain git status runs the clean program');
    const headNow = raw(c.repo, 'rev-parse', 'HEAD').trim();
    plantProgram(c.repo, name);

    const inside = await git.runGit(c.repo, ['rev-parse', '--is-inside-work-tree']);
    assert.ok(inside.ok, `git.ts runGit ran the repo's ${name}, not git (${inside.error})`);
    assert.equal(inside.stdout.trim(), 'true');

    // A call that reads the repo's filter drivers first: that read must reach git too.
    const st = await git.runGit(c.repo, ['status', '--porcelain']);
    assert.ok(st.ok, `a status read ran the repo's ${name}, not git (${st.error})`);
    assert.ok(st.stdout.includes(`?? ${name}`), 'git itself lists the planted file as untracked');
    assert.equal(c.ran(), false, `git.ts read the repo's filter drivers with the repo's ${name}, not git: the driver ran`);

    const head = await world.runGit(c.repo, ['rev-parse', 'HEAD'], undefined, 5000);
    assert.equal(head === null ? null : head.trim(), headNow, `the claims snapshot runner ran the repo's ${name}, not git`);
    const worldStatus = await world.runGit(c.repo, ['status', '--porcelain'], undefined, 5000);
    assert.equal(typeof worldStatus, 'string', `the claims snapshot runner's status read ran the repo's ${name}, not git`);
    assert.equal(c.ran(), false, `the claims snapshot runner read the repo's filter drivers with the repo's ${name}, not git: the driver ran`);
  });
}

test('GIT-RUN-HARDEN-108: a git.exe in the app\'s own working directory is not run by the derived-facts reader', winOnly, async (t) => {
  asTheAppRuns(t);
  const c = setup();
  const launchedIn = fs.mkdtempSync(path.join(ROOT, 'cwd-'));
  plantProgram(launchedIn, 'git.exe');
  const before = process.cwd();
  process.chdir(launchedIn);
  try {
    const d = new DerivedGit(c.repo);
    assert.equal(await d.ok(), true, 'derivedGit ran the git.exe in the working directory, not git');
    // The second way derivedGit starts git: the batch read that is fed on stdin.
    await d.prefetch([c.head]);
    assert.equal(await d.commitOf(c.head), c.head, 'the batch read ran the git.exe in the working directory, not git');
  } finally { process.chdir(before); }
});

// ---- The program's full path ----

test('GIT-RUN-HARDEN-108: a program is looked up in the absolute folders of PATH only, in PATHEXT order', () => {
  const have = (...files) => { const set = new Set(files.map((f) => f.toLowerCase())); return (f) => set.has(f.toLowerCase()); };
  const win = (pathValue, files, exts = ['.COM', '.EXE', '.BAT', '.CMD'], name = 'git') => findExe(name, { platform: 'win32', path: pathValue, exts, isProgram: have(...files) });

  assert.equal(win('C:\\a;C:\\b', ['C:\\b\\git.EXE']), 'C:\\b\\git.EXE');
  // Folders that depend on where the process is: none is searched, whatever they hold.
  for (const dir of ['.', '', 'bin', '.\\bin', '..', '\\tools', 'C:', 'C:tools', '/tools']) {
    const planted = dir === '' ? 'git.EXE' : dir + '\\git.EXE';
    assert.equal(win(dir + ';C:\\real', [planted, 'git.EXE', 'C:\\real\\git.EXE']), 'C:\\real\\git.EXE', 'PATH entry "' + dir + '" was searched');
    assert.equal(win(dir, [planted, 'git.EXE']), null, 'PATH entry "' + dir + '" was searched');
  }
  assert.equal(win('C:/fwd', ['C:\\fwd\\git.EXE']), 'C:\\fwd\\git.EXE', 'a drive path with forward slashes is absolute');
  assert.equal(win('\\\\host\\share\\bin', ['\\\\host\\share\\bin\\git.EXE']), '\\\\host\\share\\bin\\git.EXE', 'a network share is absolute');
  assert.equal(win('"C:\\Program Files\\Git\\cmd"', ['C:\\Program Files\\Git\\cmd\\git.EXE']), 'C:\\Program Files\\Git\\cmd\\git.EXE', 'a quoted entry');
  // The first folder that has any of the names wins; inside one folder the extensions go in order.
  assert.equal(win('C:\\a;C:\\b', ['C:\\a\\git.CMD', 'C:\\b\\git.COM']), 'C:\\a\\git.CMD');
  assert.equal(win('C:\\a', ['C:\\a\\git.CMD', 'C:\\a\\git.EXE', 'C:\\a\\git.BAT']), 'C:\\a\\git.EXE');
  assert.equal(win('C:\\a', ['C:\\a\\git.CMD', 'C:\\a\\git.EXE'], ['.CMD', '.EXE']), 'C:\\a\\git.CMD');
  assert.equal(win('C:\\a', ['C:\\a\\git.CMD'], ['.com', '.exe']), null, 'only the extensions asked for');
  assert.equal(win('C:\\a', ['C:\\a\\git']), null, 'on Windows a file with no extension is not a program');
  assert.equal(win('C:\\a', ['C:\\a\\npm.cmd', 'C:\\a\\npm.cmd.EXE'], undefined, 'npm.cmd'), 'C:\\a\\npm.cmd', 'a name that has its extension is tried as it is');

  const nix = (pathValue, files) => findExe('git', { platform: 'linux', path: pathValue, isProgram: have(...files) });
  assert.equal(nix('bin:.::/usr/bin', ['bin/git', './git', 'git', '/usr/bin/git']), '/usr/bin/git');
  assert.equal(nix('bin:.:', ['bin/git', './git', 'git']), null);

  for (const bad of ['', 'C:\\x\\git', 'bin/git', '.\\git', 'C:git']) assert.throws(() => findExe(bad, { platform: 'win32', path: 'C:\\a', isProgram: () => true }), /bare program name/);
});

test('GIT-RUN-HARDEN-108: every call is the full path of git, started in git\'s own folder, with the repo as -C', async () => {
  const c = setup();
  const { program, cwd } = gitSafe.gitProgram();
  assert.ok(path.isAbsolute(program), program);
  assert.equal(resolveExe('git', { exts: ['.com', '.exe'] }), program, 'the same lookup');
  assert.equal(cwd, path.dirname(program));
  assert.ok(fs.statSync(program).isFile());
  for (const args of [['rev-parse', 'HEAD'], ['status', '--porcelain']]) {
    const call = await gitSafe.gitSafeCall(c.repo, args);
    assert.equal(call.program, program);
    assert.equal(call.cwd, cwd, 'not the repo');
    assert.deepEqual(call.args.slice(0, 2), ['-C', path.resolve(c.repo)]);
  }
  // A relative repo path means what it meant as a working directory: relative to the app's own.
  const before = process.cwd();
  process.chdir(c.base);
  try {
    assert.deepEqual((await gitSafe.gitSafeCall('repo', ['rev-parse', 'HEAD'])).args.slice(0, 2), ['-C', c.repo]);
    assert.equal((await git.runGit('repo', ['rev-parse', 'HEAD'])).stdout.trim(), c.head);
    assert.equal(await new DerivedGit('repo').ok(), true);
  } finally { process.chdir(before); }
});

test('GIT-RUN-HARDEN-108: with no git in an absolute folder of PATH, no call is made and the error says so', async (t) => {
  asTheAppRuns(t);
  const c = setup();
  const empty = fs.mkdtempSync(path.join(ROOT, 'nogit-'));
  // The only git in reach is a plant in the repo and one in a relative PATH entry.
  if (process.platform === 'win32') plantProgram(c.repo, 'git.exe');
  const saved = process.env.PATH;
  t.after(() => { process.env.PATH = saved; });
  process.env.PATH = ['.', empty].join(path.delimiter);
  const before = process.cwd();
  process.chdir(c.repo);
  try {
    const said = /git was not found in any absolute folder on PATH, so it was not run/;
    assert.throws(() => gitSafe.gitProgram(), said);
    const r = await git.runGit(c.repo, ['rev-parse', 'HEAD']);
    assert.equal(r.ok, false);
    assert.match(r.error, said);
    assert.equal(await world.runGit(c.repo, ['rev-parse', 'HEAD'], undefined, 5000), null);
    await assert.rejects(new DerivedGit(c.repo).ok(), said);
  } finally { process.chdir(before); process.env.PATH = saved; }
  // A miss is not remembered: git is found again once PATH has it.
  assert.equal((await git.runGit(c.repo, ['rev-parse', 'HEAD'])).ok, true);
});

test('GIT-RUN-HARDEN-108: every start of git names its full path, git\'s own folder, and no console window', async (t) => {
  const c = setup();
  const cp = require('node:child_process');
  const real = { spawn: cp.spawn, execFile: cp.execFile };
  const seen = [];
  t.after(() => Object.assign(cp, real));
  for (const how of ['spawn', 'execFile']) {
    cp[how] = (file, args, opts, ...rest) => { seen.push({ how, file, opts }); return real[how](file, args, opts, ...rest); };
  }
  try {
    assert.equal((await git.runGit(c.repo, ['status', '--porcelain'])).ok, true); // the filter read (execFile) + the call (spawn)
    assert.equal((await world.runGit(c.repo, ['rev-parse', 'HEAD'], undefined, 5000)).trim(), c.head);
    const d = new DerivedGit(c.repo);
    assert.equal(await d.ok(), true); // execFile
    await d.prefetch([c.head]); // spawn, fed on stdin
  } finally { Object.assign(cp, real); }
  const { program, cwd } = gitSafe.gitProgram();
  assert.ok(seen.filter((x) => x.how === 'spawn').length >= 3 && seen.filter((x) => x.how === 'execFile').length >= 2, JSON.stringify(seen.map((x) => x.how)));
  for (const x of seen) {
    assert.equal(x.file, program, x.how + ' did not start git by its full path');
    assert.equal(x.opts.cwd, cwd, x.how + ' was not started in git\'s own folder');
    assert.equal(x.opts.windowsHide, true, x.how + ' can show a console window');
  }
});
