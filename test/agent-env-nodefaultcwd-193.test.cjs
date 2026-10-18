'use strict';

/**
 * AGENT-ENV-NODEFAULTCWD-193. The Claude Code CLI sets NoDefaultCurrentDirectoryInExePath=1 for
 * every tool shell (a binary-planting guard: a bare program name no longer resolves through the
 * current directory). node-pty 1.1.0's deps/winpty/src/winpty.gyp runs two batch files by a bare
 * name (`cd shared && GetCommitHash.bat`, and UpdateGenVersion.bat), so `npm ci` failed in agent
 * shells at electron-rebuild unless the variable was unset. tools/patch-node-pty-winpty-gyp.cjs
 * qualifies both calls (`.\Name.bat`) before electron-rebuild and asserts the patched form as the
 * last postinstall step; release marker 13 checks the gyp and that the build ran through it.
 *
 * Fixture: node-pty 1.1.0's pristine winpty.gyp (two independent installs agree on its digest).
 * Git may check it out with CRLF, so the tests normalise it to the published LF bytes.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TOOL = path.join(ROOT, 'tools', 'patch-node-pty-winpty-gyp.cjs');
const pins = require(TOOL);
const PRISTINE = fs.readFileSync(path.join(__dirname, 'fixtures', 'agent-env-nodefaultcwd-193', 'winpty.gyp.pristine'), 'utf8').replace(/\r\n/g, '\n');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const win = process.platform === 'win32';

/** A scratch node-pty tree: package.json + deps/winpty/src/winpty.gyp (+ gen/GenVersion.h). */
function tree(gyp, { version = '1.1.0', gen = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndcwd193-'));
  const src = path.join(dir, 'node-pty', 'deps', 'winpty', 'src');
  fs.mkdirSync(path.join(src, 'gen'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node-pty', 'package.json'), JSON.stringify({ name: 'node-pty', version }));
  if (gyp !== null) fs.writeFileSync(path.join(src, 'winpty.gyp'), gyp);
  if (gen !== null) fs.writeFileSync(path.join(src, 'gen', 'GenVersion.h'), gen);
  return { dir, pty: path.join(dir, 'node-pty'), gyp: path.join(src, 'winpty.gyp') };
}
const run = (pty, ...args) => spawnSync(process.execPath, [TOOL, '--root', pty, ...args], { encoding: 'utf8' });
const rm = (t) => fs.rmSync(t.dir, { recursive: true, force: true });

test('the fixture is node-pty 1.1.0\'s pristine winpty.gyp, with both batch calls bare', () => {
  assert.equal(sha(PRISTINE), pins.WINPTY_GYP_PRISTINE_SHA256);
  assert.equal(pins.NODE_PTY_VERSION, '1.1.0');
  assert.deepEqual(pins.CALLS, ['GetCommitHash.bat', 'UpdateGenVersion.bat']);
  for (const bat of pins.CALLS) assert.ok(PRISTINE.includes(`cd shared && ${bat}`), bat);
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages['node_modules/node-pty'].version, pins.NODE_PTY_VERSION, 'the pins are for the locked node-pty');
});

test('pristine -> patched: both calls qualified with a doubled backslash (gyp reads Python literals), the pinned digest, nothing else changed', { skip: !win }, () => {
  const t = tree(PRISTINE);
  try {
    const r = run(t.pty);
    assert.equal(r.status, 0, r.stderr);
    const out = fs.readFileSync(t.gyp, 'utf8');
    assert.equal(sha(out), pins.WINPTY_GYP_PATCHED_SHA256);
    assert.ok(out.includes(`'<!(cmd /c "cd shared && .\\\\GetCommitHash.bat")'`));
    assert.ok(out.includes(`'<!(cmd /c "cd shared && .\\\\UpdateGenVersion.bat <(WINPTY_COMMIT_HASH)")'`));
    assert.equal(out.replace(/\.\\\\(GetCommitHash|UpdateGenVersion)\.bat/g, '$1.bat'), PRISTINE, 'only the two calls change');
  } finally { rm(t); }
});

test('idempotent: a second run is a no-op; --check passes only on the patched form', { skip: !win }, () => {
  const t = tree(PRISTINE);
  try {
    const before = run(t.pty, '--check');
    assert.equal(before.status, 1, 'a pristine (unpatched) gyp fails the check loudly');
    assert.match(before.stderr, /not the pinned patched form/);
    assert.equal(run(t.pty).status, 0);
    const again = run(t.pty);
    assert.equal(again.status, 0);
    assert.match(again.stdout, /already qualified/);
    assert.equal(run(t.pty, '--check').status, 0);
  } finally { rm(t); }
});

test('anything else fails and writes nothing: a changed gyp, a CRLF gyp, a partial patch, another node-pty, a missing gyp', { skip: !win }, () => {
  const cases = [
    ['changed', tree(PRISTINE.replace('UNICODE', 'UNICODEX')), /neither pristine/],
    ['crlf', tree(PRISTINE.replace(/\n/g, '\r\n')), /neither pristine/],
    ['partial', tree(PRISTINE.replace('cd shared && GetCommitHash.bat', 'cd shared && .\\\\GetCommitHash.bat')), /neither pristine/],
    ['version', tree(PRISTINE, { version: '1.2.0' }), /node-pty 1\.1\.0 required, got 1\.2\.0/],
    ['missing', tree(null), /winpty\.gyp missing/]
  ];
  for (const [name, t, why] of cases) {
    try {
      const before = fs.existsSync(t.gyp) ? fs.readFileSync(t.gyp, 'utf8') : null;
      const r = run(t.pty);
      assert.equal(r.status, 1, name);
      assert.match(r.stderr, why, name);
      assert.equal(fs.existsSync(t.gyp) ? fs.readFileSync(t.gyp, 'utf8') : null, before, `${name}: untouched`);
    } finally { rm(t); }
  }
});

test('LIVE: with NoDefaultCurrentDirectoryInExePath=1, cmd cannot run the bare call but runs the qualified one (the exact command strings from the gyp)', { skip: !win }, () => {
  const t = tree(PRISTINE);
  try {
    assert.equal(run(t.pty).status, 0);
    const patched = fs.readFileSync(t.gyp, 'utf8');
    // The gyp value as Python reads it: the doubled backslash is one.
    const cmdOf = (gyp) => /'WINPTY_COMMIT_HASH%': '<!\(cmd \/c "(.*?)"\)'/.exec(gyp)[1].replace(/\\\\/g, '\\');
    const bare = cmdOf(PRISTINE);
    const qualified = cmdOf(patched);
    assert.equal(bare, 'cd shared && GetCommitHash.bat');
    assert.equal(qualified, 'cd shared && .\\GetCommitHash.bat');
    const cwd = path.join(t.dir, 'src');
    fs.mkdirSync(path.join(cwd, 'shared'), { recursive: true });
    fs.writeFileSync(path.join(cwd, 'shared', 'GetCommitHash.bat'), '@echo off\r\necho ndcwd193-ran\r\n');
    const env = { ...process.env, NoDefaultCurrentDirectoryInExePath: '1' };
    const go = (c) => spawnSync('cmd.exe', ['/d', '/s', '/c', `"${c}"`], { cwd, env, encoding: 'utf8', windowsVerbatimArguments: true });
    const b = go(bare);
    assert.ok(!b.stdout.includes('ndcwd193-ran'), `the bare call must not resolve with the variable set: ${b.stdout}${b.stderr}`);
    assert.notEqual(b.status, 0);
    const q = go(qualified);
    assert.equal(q.status, 0, q.stderr);
    assert.ok(q.stdout.includes('ndcwd193-ran'), 'the qualified call runs with the variable set');
    // Control: without the variable the bare call resolves (so the variable is what broke it).
    const envOff = { ...process.env }; delete envOff.NoDefaultCurrentDirectoryInExePath;
    const c = spawnSync('cmd.exe', ['/d', '/s', '/c', `"${bare}"`], { cwd, env: envOff, encoding: 'utf8', windowsVerbatimArguments: true });
    assert.ok(c.stdout.includes('ndcwd193-ran'), `control: ${c.stderr}`);
  } finally { rm(t); }
});

test('postinstall: the gyp is patched before electron-rebuild, and --check is the last step (a skipped or undone patch fails the install)', () => {
  const steps = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts.postinstall.split('&&').map((s) => s.trim());
  const patch = steps.indexOf('node tools/patch-node-pty-winpty-gyp.cjs');
  const rebuild = steps.findIndex((s) => s.startsWith('electron-rebuild'));
  assert.ok(patch >= 0 && rebuild > patch, `patch (${patch}) must run before electron-rebuild (${rebuild})`);
  assert.equal(steps[steps.length - 1], 'node tools/patch-node-pty-winpty-gyp.cjs --check');
  assert.ok(steps.indexOf('node tools/patch-node-pty-race-fix.cjs') < rebuild, 'the #922 backport order is unchanged');
});

test('release marker 13: OK only for the patched gyp AND a GenVersion.h written by the qualified call; the bare-call build fails', () => {
  const markers = path.join(ROOT, 'scripts', 'release-markers.cjs');
  const line = (t) => {
    const r = spawnSync(process.execPath, [markers, path.join(t.dir), path.join(t.dir, 'models')], { encoding: 'utf8' });
    return (r.stdout.split(/\r?\n/).find((l) => l.endsWith('winpty.gyp batch calls qualified')) || '').slice(0, 5).trim();
  };
  const patched = PRISTINE.replace(/cd shared && (GetCommitHash|UpdateGenVersion)\.bat/g, 'cd shared && .\\\\$1.bat');
  assert.equal(sha(patched), pins.WINPTY_GYP_PATCHED_SHA256);
  const good = '// AUTO-GENERATED BY .\\UpdateGenVersion.bat 59ba0afe\nconst char GenVersion_Version[] = "0.4.4-dev";\n';
  const bareGen = '// AUTO-GENERATED BY UpdateGenVersion.bat 59ba0afe\nconst char GenVersion_Version[] = "0.4.4-dev";\n';
  const cases = [['OK', tree(patched, { gen: good })], ['FAIL', tree(patched, { gen: bareGen })], ['FAIL', tree(PRISTINE, { gen: good })], ['FAIL', tree(patched)]];
  for (const [want, t] of cases) {
    try { assert.equal(line(t), want); } finally { rm(t); }
  }
  assert.match(fs.readFileSync(markers, 'utf8'), /Prints ALL 13 MARKERS OK/);
});
