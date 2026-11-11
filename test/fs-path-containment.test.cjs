'use strict';
require('./tools/own-job.cjs');

/**
 * The workspace root is the confinement boundary for the file IPC: the renderer
 * may only reach files INSIDE the selected workspace.
 *
 * A purely lexical containment check cannot enforce that. `resolve`/`normalize`/
 * `relative` are string math — they know nothing about symlinks — while the
 * `readFile`/`writeFile`/`readdir` that runs afterwards is resolved by the
 * kernel, which DOES follow them. So a symlink planted inside the workspace
 * (agent-generated content and cloned repos both routinely contain them) reads
 * as an in-root relative name to the guard and as an external file to the sink.
 *
 * These tests pin the boundary against that: every escape below must be refused
 * by the shared guard, on every consumer of it, while ordinary in-workspace
 * reads and writes keep working.
 *
 * The boundary is the workspace, not "no symlinks at all" — a link to a target
 * that is itself inside the workspace is followed — so the legitimate case is
 * pinned here too, in both directions.
 *
 * LINK KINDS. Every escape is pinned once per kind of link the running user can
 * actually plant:
 *  - `symlink`: POSIX symlinks; on Windows, symlinks need the create-symlink
 *    privilege (an elevated shell or Developer Mode), which an ordinary user
 *    does not have, so creating one fails with EPERM.
 *  - `junction`: Windows directory junctions (mount-point reparse points). Any
 *    user can create one, with no privilege, so on an ordinary Windows account
 *    they are THE escape route; Node reports them as symbolic links to `lstat`
 *    and resolves them through `realpath`, which is what the guard relies on.
 * On Windows the junction kind always runs and the symlink kind runs only where
 * the user can create symlinks. A junction can only point at a directory, so the
 * junction variant of a "final component" case makes the final component itself
 * a junction out of the workspace and reaches a file through it one level down.
 * Every refusal asserts the GUARD's own error text, so a sink that fails for an
 * unrelated reason (EISDIR on a directory, ENOENT behind a dangling link) can
 * never pass for containment.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { readFileText, readFileBinary, writeFileText, listDir } = loadTs('src/main/fs.ts');
const { getDiff } = loadTs('src/main/git.ts');

const SECRET = 'external-secret-contents\n';
const ESCAPE = 'path escapes root';
const GIT_ESCAPE = 'path escapes repository root';
const IS_WIN = process.platform === 'win32';

/** Can this user create a symlink here? Probed once, in a temp dir of its own. */
function probeSymlink() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-containment-probe-'));
  try {
    fs.writeFileSync(path.join(dir, 'target.txt'), '');
    fs.symlinkSync(path.join(dir, 'target.txt'), path.join(dir, 'link.txt'));
    return { ok: true, code: null };
  } catch (e) {
    return { ok: false, code: e && e.code };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const SYMLINK_PROBE = probeSymlink();
const KINDS = IS_WIN ? (SYMLINK_PROBE.ok ? ['symlink', 'junction'] : ['junction']) : ['symlink'];

/**
 * The paths each escape uses, per link kind. `symlink` is the original layout;
 * `junction` is its directory-only equivalent (see the header).
 */
const CASES = {
  symlink: {
    finalText: 'innocent.txt',          // final component is a link to an external file
    finalBin: 'innocent.bin',
    intermediate: 'sub/deep.txt',        // a directory link as a path COMPONENT
    writeThrough: 'notes.txt',           // a link to an existing external file
    dangling: 'dangling.txt',            // a link whose external target does not exist yet
    danglingCreates: ['newly-created.txt'],
    listOutside: 'sub',
    diffOutside: 'innocent.txt',
    inWorkspaceDir: 'docs-link'
  },
  junction: {
    finalText: 'jout',                   // final component is a junction out of the workspace
    finalBin: 'jout',
    intermediate: 'sub/deep.txt',
    writeThrough: 'jout/overwrite-me.txt',
    dangling: 'dangling/newly-created.txt',
    danglingCreates: ['newdir', path.join('newdir', 'newly-created.txt')],
    listOutside: 'sub',
    diffOutside: 'jout/secret.txt',
    inWorkspaceDir: 'docs-link'
  }
};

/**
 * A throwaway workspace with an `outside` sibling standing in for the rest of
 * the user's filesystem. Every link here points at that sibling — no test
 * touches a real file outside its own temp dir.
 */
function makeWorkspace(kind) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-containment-'));
  const root = path.join(dir, 'workspace');
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(outside, 'dir'), { recursive: true });

  fs.writeFileSync(path.join(outside, 'secret.txt'), SECRET);
  fs.writeFileSync(path.join(outside, 'secret.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  fs.writeFileSync(path.join(outside, 'dir', 'deep.txt'), SECRET);
  fs.writeFileSync(path.join(outside, 'overwrite-me.txt'), 'original\n');

  // Ordinary, legitimate workspace content.
  fs.writeFileSync(path.join(root, 'real.txt'), 'in-workspace\n');
  fs.writeFileSync(path.join(root, 'docs', 'shot.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x02]));

  if (kind === 'symlink') {
    // (a) final-component symlinks to external targets
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'innocent.txt'));
    fs.symlinkSync(path.join(outside, 'secret.bin'), path.join(root, 'innocent.bin'));
    fs.symlinkSync(path.join(outside, 'overwrite-me.txt'), path.join(root, 'notes.txt'));
    // (b) an intermediate directory symlink — the escape is a path COMPONENT
    fs.symlinkSync(path.join(outside, 'dir'), path.join(root, 'sub'), 'dir');
    // (c) a DANGLING final symlink: its target does not exist yet, so a write
    //     through it CREATES the external file.
    fs.symlinkSync(path.join(outside, 'newly-created.txt'), path.join(root, 'dangling.txt'));
    // (d) links that stay INSIDE the workspace and point at something that exists.
    //     These are the legitimate case — node_modules and monorepo checkouts are
    //     full of them — and they must keep working.
    fs.symlinkSync(path.join(root, 'real.txt'), path.join(root, 'alias.txt'));
    fs.symlinkSync(path.join(root, 'docs'), path.join(root, 'docs-link'), 'dir');
  } else {
    // (a) a junction to the external directory itself: the final component of
    //     `jout` is the link, and `jout/<file>` reaches external files through it
    fs.symlinkSync(outside, path.join(root, 'jout'), 'junction');
    // (b) an intermediate junction
    fs.symlinkSync(path.join(outside, 'dir'), path.join(root, 'sub'), 'junction');
    // (c) a DANGLING junction: its external target does not exist yet, so
    //     `realpath` cannot see where it leads
    fs.symlinkSync(path.join(outside, 'newdir'), path.join(root, 'dangling'), 'junction');
    // (d) a junction that stays INSIDE the workspace
    fs.symlinkSync(path.join(root, 'docs'), path.join(root, 'docs-link'), 'junction');
  }

  return { dir, root, outside };
}

function withWorkspace(kind, fn) {
  const ws = makeWorkspace(kind);
  return Promise.resolve(fn(ws)).finally(() => fs.rmSync(ws.dir, { recursive: true, force: true }));
}

// ─── which link kinds this run covers ───────────────────────────────────────

test('every kind of link this user can plant is covered', () => {
  // No kind is dropped because creating it happened to fail: a symlink kind left
  // out on Windows must be one the OS refuses to this user (EPERM), and the
  // junction kind, which needs no privilege, always runs there.
  if (IS_WIN) {
    assert.ok(KINDS.includes('junction'), 'junctions need no privilege and must always be covered on Windows');
    if (!KINDS.includes('symlink')) {
      assert.equal(SYMLINK_PROBE.code, 'EPERM', 'symlinks may only be left out when this user cannot create them');
    }
  } else {
    assert.deepEqual(KINDS, ['symlink']);
  }
  test.diagnostic?.(`link kinds covered: ${KINDS.join(', ')}`);
});

for (const kind of KINDS) {
  const c = CASES[kind];

  // ─── reads ────────────────────────────────────────────────────────────────

  test(`[${kind}] a final-component link cannot be read as text`, () => withWorkspace(kind, async ({ root }) => {
    const res = await readFileText(root, c.finalText);
    assert.equal(res.ok, false, 'a link out of the workspace must not be readable');
    assert.equal(res.error, ESCAPE);
    assert.equal(res.content, undefined);
  }));

  test(`[${kind}] a final-component link cannot be read as bytes`, () => withWorkspace(kind, async ({ root }) => {
    const res = await readFileBinary(root, c.finalBin);
    assert.equal(res.ok, false, 'the binary reader shares the boundary and must refuse too');
    assert.equal(res.error, ESCAPE);
  }));

  test(`[${kind}] an intermediate directory link cannot be read through`, () => withWorkspace(kind, async ({ root }) => {
    const res = await readFileText(root, c.intermediate);
    assert.equal(res.ok, false, 'the escape can be any component, not just the last one');
    assert.equal(res.error, ESCAPE);
  }));

  // ─── writes ───────────────────────────────────────────────────────────────

  test(`[${kind}] a link cannot be written through`, () => withWorkspace(kind, async ({ root, outside }) => {
    const target = path.join(outside, 'overwrite-me.txt');
    const before = fs.readFileSync(target, 'utf8');
    const res = await writeFileText(root, c.writeThrough, 'clobbered\n');
    assert.equal(res.ok, false, 'writing through a link must be refused');
    assert.equal(res.error, ESCAPE);
    assert.equal(fs.readFileSync(target, 'utf8'), before, 'the external file must be untouched');
  }));

  test(`[${kind}] a dangling link cannot be used to create anything outside the workspace`, () =>
    withWorkspace(kind, async ({ root, outside }) => {
      // The link target does not exist, so `realpath` cannot see where this leads —
      // canonicalization alone would let the write through. Only an lstat walk
      // (and, on POSIX, an O_NOFOLLOW open) catches this one.
      const res = await writeFileText(root, c.dangling, 'created outside\n');
      assert.equal(res.ok, false, 'a dangling link is still a link');
      assert.equal(res.error, ESCAPE);
      for (const p of c.danglingCreates) {
        assert.equal(fs.existsSync(path.join(outside, p)), false, `${p}: nothing may be created outside the workspace`);
      }
    }));

  // ─── the other consumers of the same guard ────────────────────────────────

  test(`[${kind}] listDir cannot list a directory outside the workspace`, () => withWorkspace(kind, async ({ root }) => {
    const res = await listDir(root, c.listOutside);
    assert.equal(res.ok, false, 'the directory listing shares the boundary');
    assert.equal(res.error, ESCAPE);
  }));

  test(`[${kind}] the git diff path check refuses a link escape`, () => withWorkspace(kind, async ({ root }) => {
    const res = await getDiff(root, c.diffOutside);
    assert.equal(res.ok, false, 'git path operations validate against the same boundary');
    assert.equal(res.error, GIT_ESCAPE);
    assert.equal(res.working, undefined, 'the external file contents must never be returned');
  }));

  // ─── and ordinary workspace use still works ───────────────────────────────

  test(`[${kind}] ordinary in-workspace reads and writes still succeed`, () => withWorkspace(kind, async ({ root }) => {
    const text = await readFileText(root, 'real.txt');
    assert.equal(text.ok, true, text.ok ? '' : text.error);
    assert.equal(text.content, 'in-workspace\n');

    const bin = await readFileBinary(root, 'docs/shot.bin');
    assert.equal(bin.ok, true, bin.ok ? '' : bin.error);
    assert.equal(bin.size, 6);

    const created = await writeFileText(root, 'docs/new.txt', 'hello\n');
    assert.equal(created.ok, true, created.ok ? '' : created.error);
    assert.equal(fs.readFileSync(path.join(root, 'docs', 'new.txt'), 'utf8'), 'hello\n');

    const overwritten = await writeFileText(root, 'real.txt', 'replaced\n');
    assert.equal(overwritten.ok, true, overwritten.ok ? '' : overwritten.error);
    assert.equal(fs.readFileSync(path.join(root, 'real.txt'), 'utf8'), 'replaced\n');

    const listed = await listDir(root, 'docs');
    assert.equal(listed.ok, true, listed.ok ? '' : listed.error);
    assert.ok(listed.entries.some((e) => e.name === 'shot.bin'));
  }));

  test(`[${kind}] an in-workspace link to an in-workspace target is followed, not refused`, () =>
    withWorkspace(kind, async ({ root }) => {
      // The boundary is the workspace, not "no links at all": a link whose
      // target is itself inside the workspace reaches nothing the caller could not
      // already reach by its real name. Refusing it would make an ordinary
      // node_modules or monorepo checkout unbrowsable for no security gain. This
      // pins that so the policy cannot be flipped by accident.
      if (kind === 'symlink') {
        const viaLink = await readFileText(root, 'alias.txt');
        assert.equal(viaLink.ok, true, viaLink.ok ? '' : viaLink.error);
        assert.equal(viaLink.content, 'in-workspace\n');
        assert.equal(
          viaLink.path, path.join(fs.realpathSync(root), 'real.txt'),
          'the link resolves to the canonical path of its target, not to the link'
        );
      }

      const viaDir = await readFileBinary(root, `${c.inWorkspaceDir}/shot.bin`);
      assert.equal(viaDir.ok, true, viaDir.ok ? '' : viaDir.error);
      assert.equal(
        viaDir.path, path.join(fs.realpathSync(root), 'docs', 'shot.bin'),
        'a path through a directory link resolves to its target\'s canonical path'
      );

      const listed = await listDir(root, c.inWorkspaceDir);
      assert.equal(listed.ok, true, listed.ok ? '' : listed.error);
      assert.ok(listed.entries.some((e) => e.name === 'shot.bin'), 'a directory link lists its target');
    }));
}

test('the git diff read refuses a final component swapped for a symlink mid-call', {
  skip: IS_WIN ? 'needs a POSIX shell shim and symlinks' : false
}, () => withWorkspace('symlink', async ({ root, outside, dir }) => {
  // Validating a path and then reading it are two separate resolutions, and the
  // kernel redoes the lookup at open time. `getDiff` runs `git show HEAD:<path>`
  // between the two, so shadowing `git` with a script that plants the symlink
  // puts an attacker in exactly that window — deterministically, rather than
  // hoping to win a race. The read must refuse what it is handed, not trust that
  // the earlier check still holds.
  const target = path.join(root, 'real.txt');
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir);
  const shim = path.join(binDir, 'git');
  fs.writeFileSync(
    shim,
    `#!/bin/sh\nrm -f '${target}'\nln -s '${path.join(outside, 'secret.txt')}' '${target}'\nexit 1\n`
  );
  fs.chmodSync(shim, 0o755);

  const savedPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${savedPath}`;
  let res;
  try {
    res = await getDiff(root, 'real.txt');
  } finally {
    process.env.PATH = savedPath;
  }

  assert.equal(fs.lstatSync(target).isSymbolicLink(), true, 'the shim must have run inside the window');
  assert.equal(res.ok, true, res.ok ? '' : res.error);
  assert.equal(res.workingExists, false, 'a symlink is not the regular file the guard cleared');
  assert.equal(res.working, '', 'the external file contents must never reach the renderer');
}));

test('lexical traversal out of the root is still rejected', () => withWorkspace(KINDS[0], async ({ root, dir }) => {
  for (const rel of ['../outside/secret.txt', 'docs/../../outside/secret.txt', path.join(dir, 'outside', 'secret.txt')]) {
    const res = await readFileText(root, rel);
    assert.equal(res.ok, false, `${rel} must not be readable`);
    assert.equal(res.error, ESCAPE);
  }
}));
