'use strict';

// Originally contributed by Vyapak Goyal (@gts-47) in #123, extended here with
// the dotted-path cases that the first version's dot-free fixtures could not
// catch.
//
// projectDir() resolves against os.homedir(): $HOME on POSIX, USERPROFILE on Windows. The
// redirect sets both and asserts it took, so no case can read the real ~/.claude.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { projectDir } = loadTs('src/main/transcript.ts');

/** projectDir() resolves against os.homedir() ($HOME on POSIX, USERPROFILE on Windows), so
 *  each case gets a throwaway home, set in BOTH, and never touches the real ~/.claude. */
function withHome(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-transcript-'));
  const prev = process.env.HOME;
  const prevProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    assert.equal(os.homedir(), home, 'home redirect failed: refusing to touch the real ~/.claude');
    return run(home, (key) => {
      const dir = path.join(home, '.claude/projects', key);
      fs.mkdirSync(dir, { recursive: true });
      return dir;
    });
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
    if (prevProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevProfile;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

test('an unseen cwd resolves to the CURRENT key, leading slash dashed', () => {
  withHome(() => {
    // The regression: this used to return 'Users-me-app', a directory Claude Code
    // has not written to in months, so every read came back empty and every
    // caller read empty as "no data yet".
    assert.equal(path.basename(projectDir('/Users/me/app')), '-Users-me-app');
  });
});

test('DOTS are dashed too, not just slashes', () => {
  withHome(() => {
    // The case a slash-only fix silently fails: Claude Code dashes EVERY
    // non-alphanumeric, so a version-numbered project directory keys as
    // MDv0-3-0. Dashing only the separators yields '-Users-me-MDv0.3.0', which
    // Claude Code never writes to — and because the legacy fallback then finds
    // the harness's own stale twin, the miss looks like a hit.
    assert.equal(
      path.basename(projectDir('/Users/me/Documents/MDv0.3.0')),
      '-Users-me-Documents-MDv0-3-0'
    );
  });
});

test('every other non-alphanumeric is dashed as well', () => {
  withHome(() => {
    assert.equal(
      path.basename(projectDir('/Users/me/my_proj (old)/v1.2')),
      '-Users-me-my-proj--old--v1-2'
    );
  });
});

test('the current directory wins even when a legacy twin exists', () => {
  withHome((_home, mkProject) => {
    // Both spellings exist on a machine that ran the old code: the harness itself
    // created the legacy twin by copying transcripts into it. Preferring the
    // legacy one would mean reading our own stale copies forever.
    const legacy = mkProject('Users-me-app');
    const current = mkProject('-Users-me-app');
    const resolved = projectDir('/Users/me/app');
    assert.equal(resolved, current);
    assert.notEqual(resolved, legacy);
  });
});

test('the dotted legacy twin loses to the dotted current spelling', () => {
  withHome((_home, mkProject) => {
    const legacy = mkProject('Users-me-MDv0.3.0');
    const current = mkProject('-Users-me-MDv0-3-0');
    const resolved = projectDir('/Users/me/MDv0.3.0');
    assert.equal(resolved, current);
    assert.notEqual(resolved, legacy);
  });
});

// The legacy spelling is a POSIX-only artefact (legacyProjectKey: on win32 the "legacy" key IS the
// current key, since Windows never had the old spelling), so a legacy-ONLY fallback exists on POSIX
// only. The win32 behaviour has its own test below.
const POSIX_LEGACY = { skip: process.platform === 'win32' ? 'legacy key spelling is POSIX-only (win32 has none)' : false };

test('a legacy-only install still resolves, so old transcripts stay readable', POSIX_LEGACY, () => {
  withHome((_home, mkProject) => {
    const legacy = mkProject('Users-me-app');
    assert.equal(projectDir('/Users/me/app'), legacy);
  });
});

test('a legacy-only install with dots resolves to its undashed twin', POSIX_LEGACY, () => {
  withHome((_home, mkProject) => {
    // The legacy key kept dots, so the fallback has to keep them too — deriving
    // it from the new key by stripping the leading dash would look for
    // 'Users-me-MDv0-3-0' and find nothing.
    const legacy = mkProject('Users-me-MDv0.3.0');
    assert.equal(projectDir('/Users/me/MDv0.3.0'), legacy);
  });
});

test('the real failing path resolves to the dir Claude Code actually writes', () => {
  withHome((_home, mkProject) => {
    // The exact cwd whose transcripts the condense step could not find (#123).
    const cwd = '/Users/vyapakgoyal/Documents/HarnessAgents';
    mkProject('-Users-vyapakgoyal-Documents-HarnessAgents');
    mkProject('Users-vyapakgoyal-Documents-HarnessAgents');
    assert.equal(
      path.basename(projectDir(cwd)),
      '-Users-vyapakgoyal-Documents-HarnessAgents'
    );
  });
});

test('a root cwd never resolves to the projects directory itself', () => {
  withHome((home, _mkProject) => {
    // legacyProjectKey('/') is the empty string, and path.join(root, '') is the
    // projects ROOT — which always exists, so an unguarded fallback would hand
    // back the directory holding EVERY project and seed the session file there.
    const resolved = projectDir('/');
    assert.notEqual(resolved, path.join(home, '.claude/projects'));
    assert.equal(path.basename(resolved), '-');
  });
});

test('win32: there is no legacy spelling, so a POSIX-style twin is never picked and the current key is used', {
  skip: process.platform === 'win32' ? false : 'win32-only behaviour'
}, () => {
  withHome((home, mkProject) => {
    mkProject('Users-me-app'); // what the POSIX legacy key would have been
    assert.equal(projectDir('/Users/me/app'), path.join(home, '.claude/projects', '-Users-me-app'));
  });
});
