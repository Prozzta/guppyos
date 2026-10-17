'use strict';

/**
 * CLAUDE-JSON-WIPE (1.1.91): ensureClaudePermissionsAccepted must never wipe the user's
 * global ~/.claude.json or ~/.claude/settings.json.
 *
 * WHAT HAPPENED. Through 1.1.90 a file that did not parse (a torn write by a running
 * `claude`, a hand edit) became `{}`, got the one key this function wants, and was written
 * back with a plain writeFileSync: oauthAccount, every project's allowedTools and the user's
 * own settings were gone, on every Claude spawn.
 *
 * THE RULES PINNED HERE.
 *  - A file that does not parse, or parses to the wrong shape, is left BYTE-IDENTICAL and the
 *    gate reports `refused` (the caller logs it; the spawn goes on with the per-agent flags).
 *  - A write goes to a temp file beside the REAL target (a symlink stays a symlink), keeps the
 *    file mode, re-reads the target right before the rename and gives up if it changed, and
 *    leaves a `.guppy-backup` copy of what it replaced.
 *  - Empty / whitespace / BOM files count as `{}` / their content (Andy F4).
 *  - On Windows the trust key uses forward slashes, the form the CLI looks up (Andy F10).
 *
 * EVERY TEST RUNS IN A TEMP HOME, asserted before the module loads and before every call:
 * this function writes the user's real global files when HOME is not redirected.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-safe-'));
const REAL_HOME = os.homedir();
function useHome(home) {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  assert.equal(os.homedir(), home, 'HOME redirect failed - aborting before touching ~/.claude');
  assert.notEqual(os.homedir(), REAL_HOME);
}
useHome(ROOT);
test.after(() => fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));

const userData = fs.mkdtempSync(path.join(ROOT, 'userdata-'));
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { app: { getPath: () => userData } } };
const loadTs = require('./load-ts.cjs');
const { ensureClaudePermissionsAccepted } = loadTs('src/main/config.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const WIN = process.platform === 'win32';
const trustKey = (cwd) => (WIN ? cwd.replaceAll('\\', '/') : cwd);

/** A fresh temp home with an agent cwd inside it. */
function home(t) {
  const h = fs.mkdtempSync(path.join(ROOT, 'home-'));
  useHome(h);
  const cwd = path.join(h, 'work', 'repo');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(h, '.claude'), { recursive: true });
  t.after(() => fs.rmSync(h, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return { h, cwd, settings: path.join(h, '.claude', 'settings.json'), cj: path.join(h, '.claude.json') };
}
const run = (env) => { assert.equal(os.homedir(), env.h); return ensureClaudePermissionsAccepted(env.cwd); };
const bytes = (p) => fs.readFileSync(p);
const leftovers = (dir) => fs.readdirSync(dir).filter((n) => n.includes('guppy-tmp'));

const GOOD_CJ = { numStartups: 7, oauthAccount: { emailAddress: 'x@example.com' }, projects: { '/other': { allowedTools: ['Bash'], hasTrustDialogAccepted: true } } };
const GOOD_SETTINGS = { theme: 'dark', model: 'opus' };

// ── 1. a file that does not parse stays byte-identical ─────────────────────────────────────

for (const [name, text] of [
  ['truncated', '{"numStartups": 7, "oauthAccount": {"emailAddress": "x@exa'],
  ['trailing garbage', '{"a":1}}'],
  ['null root', 'null'],
  ['number root', '42'],
  ['string root', '"str"'],
  ['array root', '[1,2]']
]) {
  test(`~/.claude.json ${name}: byte-identical, trust refused, no temp file`, (t) => {
    const env = home(t);
    fs.writeFileSync(env.cj, text);
    fs.writeFileSync(env.settings, JSON.stringify(GOOD_SETTINGS));
    const before = bytes(env.cj);
    const r = run(env);
    assert.deepEqual(bytes(env.cj), before, 'THE USER FILE IS UNTOUCHED');
    assert.equal(r.trust.status, 'refused');
    assert.equal(fs.existsSync(`${env.cj}.guppy-backup`), false);
    assert.deepEqual(leftovers(env.h), []);
    assert.equal(r.settings.status, 'written', 'the other gate is independent');
  });

  test(`~/.claude/settings.json ${name}: byte-identical, settings refused`, (t) => {
    const env = home(t);
    fs.writeFileSync(env.settings, text);
    const before = bytes(env.settings);
    const r = run(env);
    assert.deepEqual(bytes(env.settings), before, 'THE USER FILE IS UNTOUCHED');
    assert.equal(r.settings.status, 'refused');
    assert.deepEqual(leftovers(path.join(env.h, '.claude')), []);
    assert.equal(r.trust.status, 'written', 'the other gate is independent');
  });
}

// ── 2. a parsed file whose nested shape is wrong stays byte-identical ──────────────────────

test('projects null / array / string, and projects[cwd] a string: byte-identical (v1.1.74 made "abc" a char map)', (t) => {
  for (const projects of [null, [], 'x', 5]) {
    const env = home(t);
    fs.writeFileSync(env.cj, JSON.stringify({ numStartups: 1, projects }));
    const before = bytes(env.cj);
    assert.equal(run(env).trust.status, 'refused', `projects=${JSON.stringify(projects)}`);
    assert.deepEqual(bytes(env.cj), before);
  }
  for (const entry of ['abc', 7, [], null]) {
    const env = home(t);
    fs.writeFileSync(env.cj, JSON.stringify({ numStartups: 1, projects: { [trustKey(env.cwd)]: entry } }));
    const before = bytes(env.cj);
    assert.equal(run(env).trust.status, 'refused', `projects[cwd]=${JSON.stringify(entry)}`);
    assert.deepEqual(bytes(env.cj), before);
  }
});

// ── 3. a good write: merged, atomic, backed up ─────────────────────────────────────────────

test('a good ~/.claude.json gains only projects[cwd].hasTrustDialogAccepted; the old bytes are the backup', (t) => {
  const env = home(t);
  const text = JSON.stringify(GOOD_CJ, null, 2);
  fs.writeFileSync(env.cj, text);
  const r = run(env);
  assert.equal(r.trust.status, 'written');
  const after = JSON.parse(fs.readFileSync(env.cj, 'utf8'));
  assert.deepEqual(after, { ...GOOD_CJ, projects: { ...GOOD_CJ.projects, [trustKey(env.cwd)]: { hasTrustDialogAccepted: true } } });
  assert.equal(fs.readFileSync(`${env.cj}.guppy-backup`, 'utf8'), text, 'THE BACKUP IS THE FILE AS IT WAS');
  assert.deepEqual(leftovers(env.h), []);
  // Idempotent: a second call writes nothing.
  const once = bytes(env.cj);
  fs.rmSync(`${env.cj}.guppy-backup`);
  assert.equal(run(env).trust.status, 'satisfied');
  assert.deepEqual(bytes(env.cj), once);
  assert.equal(fs.existsSync(`${env.cj}.guppy-backup`), false, 'no write, no backup');
});

test('an existing projects[cwd] entry keeps its other keys', (t) => {
  const env = home(t);
  fs.writeFileSync(env.cj, JSON.stringify({ projects: { [trustKey(env.cwd)]: { allowedTools: ['Read'], hasTrustDialogAccepted: false } } }));
  assert.equal(run(env).trust.status, 'written');
  assert.deepEqual(JSON.parse(fs.readFileSync(env.cj, 'utf8')).projects[trustKey(env.cwd)], { allowedTools: ['Read'], hasTrustDialogAccepted: true });
});

test('a good settings.json gains the two bypass flags and keeps the user keys; backup written', (t) => {
  const env = home(t);
  const text = JSON.stringify(GOOD_SETTINGS);
  fs.writeFileSync(env.settings, text);
  assert.equal(run(env).settings.status, 'written');
  assert.deepEqual(JSON.parse(fs.readFileSync(env.settings, 'utf8')), { ...GOOD_SETTINGS, skipDangerousModePermissionPrompt: true, skipAutoPermissionPrompt: true });
  assert.equal(fs.readFileSync(`${env.settings}.guppy-backup`, 'utf8'), text);
  assert.equal(run(env).settings.status, 'satisfied');
});

test('fresh home (no files): both written, no backup of a file that never existed', (t) => {
  const env = home(t);
  fs.rmSync(path.join(env.h, '.claude'), { recursive: true });
  const r = run(env);
  assert.deepEqual([r.settings.status, r.trust.status], ['written', 'written']);
  assert.deepEqual(JSON.parse(fs.readFileSync(env.cj, 'utf8')), { projects: { [trustKey(env.cwd)]: { hasTrustDialogAccepted: true } } });
  assert.equal(fs.existsSync(`${env.cj}.guppy-backup`), false);
  assert.equal(fs.existsSync(`${env.settings}.guppy-backup`), false);
});

test('no cwd: the trust gate is skipped and ~/.claude.json is not created', (t) => {
  const env = home(t);
  assert.equal(os.homedir(), env.h);
  const r = ensureClaudePermissionsAccepted(undefined);
  assert.equal(r.trust.status, 'skipped');
  assert.equal(fs.existsSync(env.cj), false);
});

// ── 4. Andy F4: empty, whitespace-only and BOM files ───────────────────────────────────────

test('empty and whitespace-only files count as {}; a BOM is stripped and the keys kept', (t) => {
  for (const text of ['', '  \r\n\t']) {
    const env = home(t);
    fs.writeFileSync(env.cj, text);
    assert.equal(run(env).trust.status, 'written', JSON.stringify(text));
    assert.equal(JSON.parse(fs.readFileSync(env.cj, 'utf8')).projects[trustKey(env.cwd)].hasTrustDialogAccepted, true);
  }
  const env = home(t);
  fs.writeFileSync(env.cj, `\uFEFF${JSON.stringify(GOOD_CJ)}`);
  assert.equal(run(env).trust.status, 'written');
  assert.equal(JSON.parse(fs.readFileSync(env.cj, 'utf8')).oauthAccount.emailAddress, 'x@example.com');
});

// ── 5. Andy F3: the file changed under us (a running `claude` wrote it) ─────────────────────

test('a write by someone else between our read and our rename wins: ours is dropped, no temp left', (t) => {
  const env = home(t);
  fs.writeFileSync(env.cj, JSON.stringify(GOOD_CJ));
  const theirs = JSON.stringify({ ...GOOD_CJ, numStartups: 8 });
  const orig = fs.writeFileSync;
  let fired = false;
  fs.writeFileSync = function (p, ...rest) {
    const out = orig.call(this, p, ...rest);
    if (!fired && path.basename(String(p)).startsWith('.claude.json.guppy-tmp')) { fired = true; orig.call(fs, env.cj, theirs); }
    return out;
  };
  let r;
  try { r = run(env); } finally { fs.writeFileSync = orig; }
  assert.equal(fired, true, 'the race was injected');
  assert.equal(r.trust.status, 'refused');
  assert.equal(fs.readFileSync(env.cj, 'utf8'), theirs, 'THEIR WRITE SURVIVES');
  assert.deepEqual(leftovers(env.h), []);
});

test('a publish that cannot rename leaves the old file intact (the write is tmp + rename, never in place)', (t) => {
  const env = home(t);
  fs.writeFileSync(env.cj, JSON.stringify(GOOD_CJ));
  const before = bytes(env.cj);
  const orig = fs.renameSync;
  let calls = 0;
  fs.renameSync = function () { calls++; const e = new Error('EACCES: denied'); e.code = 'EACCES'; throw e; };
  let r;
  try { r = run(env); } finally { fs.renameSync = orig; }
  assert.ok(calls >= 1, 'the publish went through rename');
  assert.equal(r.trust.status, 'failed');
  assert.deepEqual(bytes(env.cj), before, 'THE USER FILE IS UNTOUCHED');
  assert.deepEqual(leftovers(env.h), []);
});

// ── 6. Andy F1/F2: a symlink stays a symlink; the mode is kept ─────────────────────────────

test('a symlinked ~/.claude.json: the link is kept and its target is updated', (t) => {
  const env = home(t);
  const realDir = fs.mkdtempSync(path.join(env.h, 'dotfiles-'));
  const real = path.join(realDir, 'claude.json');
  fs.writeFileSync(real, JSON.stringify(GOOD_CJ));
  try { fs.symlinkSync(real, env.cj, 'file'); } catch (e) {
    if (e.code === 'EPERM') { t.skip('symlinks need Developer Mode or admin on this Windows'); return; }
    throw e;
  }
  assert.equal(run(env).trust.status, 'written');
  assert.equal(fs.lstatSync(env.cj).isSymbolicLink(), true, 'THE LINK IS NOT REPLACED BY A FILE');
  assert.equal(JSON.parse(fs.readFileSync(real, 'utf8')).projects[trustKey(env.cwd)].hasTrustDialogAccepted, true);
  assert.deepEqual(leftovers(realDir), []);
});

test('a 0600 ~/.claude.json stays 0600 (POSIX)', { skip: WIN && 'no POSIX modes on Windows' }, (t) => {
  const env = home(t);
  fs.writeFileSync(env.cj, JSON.stringify(GOOD_CJ), { mode: 0o600 });
  fs.chmodSync(env.cj, 0o600);
  assert.equal(run(env).trust.status, 'written');
  assert.equal(fs.statSync(env.cj).mode & 0o777, 0o600);
  assert.equal(fs.statSync(`${env.cj}.guppy-backup`).mode & 0o777, 0o600, 'the backup holds oauthAccount too');
});

// ── 7. Andy F10: the key the CLI actually reads on Windows ─────────────────────────────────

test('on Windows the trust key is the forward-slash path (claude 2.1.302 j2(): replaceAll("\\\\","/"))', { skip: !WIN && 'Windows only' }, (t) => {
  const env = home(t);
  fs.writeFileSync(env.cj, JSON.stringify({ projects: { [env.cwd]: { hasTrustDialogAccepted: true } } }));
  assert.equal(run(env).trust.status, 'written', 'a backslash key alone is inert, so it does not satisfy the gate');
  const projects = JSON.parse(fs.readFileSync(env.cj, 'utf8')).projects;
  assert.equal(projects[env.cwd.replaceAll('\\', '/')].hasTrustDialogAccepted, true);
  assert.deepEqual(projects[env.cwd], { hasTrustDialogAccepted: true }, 'the old key is left as it was');
});

// ── 8. the per-agent --settings carries the bypass flags (a refused global file still spawns clean) ──

test('the per-agent settings file carries both bypass flags, with and without the broker', (t) => {
  const env = home(t);
  const harness = fs.mkdtempSync(path.join(env.h, 'harness-'));
  const hive = new HiveManager(() => harness);
  t.after(() => hive.dispose());
  for (const url of [null, `http://127.0.0.1:60971/hook/andy-mtuk4y4x/${'a'.repeat(32)}`]) {
    const s = hive.hookSettings('C:/hive/bin/cth-hook.cjs', env.cwd, {}, undefined, url, 'andy-mtuk4y4x');
    assert.equal(s.skipDangerousModePermissionPrompt, true, `broker=${!!url}`);
    assert.equal(s.skipAutoPermissionPrompt, true, `broker=${!!url}`);
  }
});

// ── 9. the caller logs a refusal (the spawn skips the write visibly) ────────────────────────

test('index.ts logs a claude-config-refused row when a gate is refused or fails', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  const at = src.indexOf('ensureClaudePermissionsAccepted(opts.cwd)');
  assert.ok(at > 0);
  const near = src.slice(at, at + 900);
  assert.match(near, /kind: 'claude-config-refused'/);
});
