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
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const git = loadTs('src/main/git.ts');
const world = loadTs('src/main/claims/worldSnapshot.ts');
const { DerivedGit } = loadTs('src/main/claims/derivedGit.ts');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'grh108-'));
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
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
