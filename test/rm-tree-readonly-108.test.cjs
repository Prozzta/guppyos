'use strict';
require('./tools/own-job.cjs');
/**
 * ELECTRON-RM-READONLY-EPERM-108: a test's temp tree that holds read-only files is removed with
 * test/tools/rm-tree.cjs, never with a recursive fs remove.
 *
 * RUNTIME PIN  Under Electron (as Node too) on Windows, fs.rmSync(dir, { recursive: true, force: true })
 *              throws EPERM on a tree holding a read-only file; plain Node removes it. (Creed's
 *              repro.) If Electron changes, this pin goes red and says so.
 * RMTREE       rmTree removes such a tree on both runtimes: a file made read-only, and a real
 *              git repository (git writes its objects read-only). A link in the tree goes as a
 *              link: its target, and a read-only file in the target, are left as they were (no
 *              mode is changed through the link). A root that is a link is removed as a link.
 * FAIL CLOSED  With no usable remover rmTree throws and the tree stays. It tries again only on
 *              the open-handle codes, only as often as the caller asked.
 * CENSUS       Every .cjs under test/ that makes read-only files (the PRODUCERS patterns) holds
 *              no recursive fs remove. A site that must stay is in ALLOW with its reason.
 *
 * MUTANTS (test/tools/rm-tree.cjs):
 *   M1 the catch falls back to fs.rmSync(dir, { recursive, force })  -> FAIL CLOSED, and CENSUS (the helper)
 *   M2 a link root handed to safeRemoveTreeSync                      -> "a root that is a link"
 *   M3 AGAIN also holds EREMOVER_UNAVAILABLE                         -> FAIL CLOSED (no second try)
 *   M4 the retry count ignored (always tries again)                  -> "tries again only as often as asked"
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { rmTree, AGAIN } = require('./tools/rm-tree.cjs');

const WIN = process.platform === 'win32';
const ELECTRON = Boolean(process.versions.electron);
const LINK = WIN ? 'junction' : 'dir';
const jail = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'rm-tree-ro-'));
test.after(() => rmTree(jail));

let n = 0;
/** A folder with a read-only file two levels down. */
function readOnlyTree(name) {
  const dir = path.join(jail, `${name}-${++n}`);
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  const file = path.join(dir, 'sub', 'x');
  fs.writeFileSync(file, 'x');
  fs.chmodSync(file, 0o444);
  return { dir, file };
}
const readOnly = (file) => (fs.statSync(file).mode & 0o222) === 0;

test('RUNTIME PIN: a recursive rmSync on a tree with a read-only file: EPERM under Electron on Windows, removed under plain Node', () => {
  const { dir, file } = readOnlyTree('pin');
  assert.equal(readOnly(file), true, 'the fixture file is read-only');
  let error = null;
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { error = e; }
  if (WIN && ELECTRON) {
    assert.ok(error, 'Electron removed a read-only tree with rmSync: the runtime changed, look at ELECTRON-RM-READONLY-EPERM-108 again');
    assert.equal(error.code, 'EPERM');
    assert.equal(fs.existsSync(file), true, 'the read-only file is still there');
  } else {
    assert.equal(error, null, `plain Node removes it: ${error && error.message}`);
    assert.equal(fs.existsSync(dir), false);
  }
});

test('RMTREE: a tree with a read-only file is removed', () => {
  const { dir, file } = readOnlyTree('ro');
  assert.equal(readOnly(file), true);
  rmTree(dir);
  assert.equal(fs.existsSync(dir), false);
});

test('RMTREE: a real git repository (read-only objects) is removed', () => {
  const dir = path.join(jail, `repo-${++n}`);
  fs.mkdirSync(dir);
  const git = (args) => execFileSync('git', ['-c', 'user.name=syn', '-c', 'user.email=syn@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd: dir, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(dir, 'f.txt'), 'x');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'one']);
  const objects = [];
  const walk = (p) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const q = path.join(p, e.name); if (e.isDirectory()) walk(q); else objects.push(q); } };
  walk(path.join(dir, '.git', 'objects'));
  assert.ok(objects.some(readOnly), 'git wrote at least one read-only object, or this test proves nothing');
  rmTree(dir);
  assert.equal(fs.existsSync(dir), false);
});

test('RMTREE: a link in the tree goes as a link; its target and the read-only file in it are untouched', () => {
  const target = readOnlyTree('target');
  const { dir } = readOnlyTree('holder');
  fs.symlinkSync(target.dir, path.join(dir, 'sub', 'link'), LINK);
  rmTree(dir);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(fs.readFileSync(target.file, 'utf8'), 'x', 'THE LINK TARGET SURVIVES');
  assert.equal(readOnly(target.file), true, 'and its file is still read-only: no mode was changed through the link');
});

test('RMTREE: a root that is a link is removed as a link, the target stays', () => {
  const target = readOnlyTree('root-target');
  const link = path.join(jail, `root-link-${++n}`);
  fs.symlinkSync(target.dir, link, LINK);
  rmTree(link);
  assert.equal(fs.lstatSync(link, { throwIfNoEntry: false }), undefined);
  assert.equal(fs.readFileSync(target.file, 'utf8'), 'x', 'THE LINK TARGET SURVIVES');
  assert.equal(readOnly(target.file), true);
});

test('RMTREE: a missing folder is fine; a plain file is refused and stays', () => {
  rmTree(path.join(jail, 'never-made'));
  const file = path.join(jail, `plain-${++n}.txt`);
  fs.writeFileSync(file, 'keep');
  assert.throws(() => rmTree(file), { code: 'EREFUSED' });
  assert.equal(fs.readFileSync(file, 'utf8'), 'keep');
});

test('FAIL CLOSED: with no usable remover rmTree throws, tries once, and the tree stays', () => {
  const { dir, file } = readOnlyTree('closed');
  let calls = 0; let pauses = 0;
  const remover = () => ({
    removeReparsePointSync() { throw new Error('not a link'); },
    safeRemoveTreeSync() { calls++; throw Object.assign(new Error('refused: link-safe remover unavailable (test)'), { code: 'EREMOVER_UNAVAILABLE' }); },
  });
  assert.throws(() => rmTree(dir, { maxRetries: 5, retryDelay: 1, remover, pause: () => { pauses++; } }), { code: 'EREMOVER_UNAVAILABLE' });
  assert.equal(calls, 1, 'an unavailable remover is not tried again');
  assert.equal(pauses, 0);
  assert.equal(fs.existsSync(file), true, 'nothing else removed the tree');
  assert.equal(AGAIN.has('EREMOVER_UNAVAILABLE'), false);
  assert.equal(AGAIN.has('EREFUSED'), false);
});

test('rmTree tries again only on an open-handle code, and only as often as asked', () => {
  const { dir } = readOnlyTree('again');
  const failing = (code, times) => {
    let calls = 0;
    return { calls: () => calls, remover: () => ({ safeRemoveTreeSync(d) { calls++; if (calls <= times) throw Object.assign(new Error(code), { code }); require('./load-ts.cjs')(require('./tools/rm-tree.cjs').REMOVER_TS).safeRemoveTreeSync(d); } }) };
  };
  const none = failing('EBUSY', 1);
  assert.throws(() => rmTree(dir, { remover: none.remover, pause: () => {} }), { code: 'EBUSY' }, 'no retry unless asked');
  assert.equal(none.calls(), 1);
  const short = failing('EBUSY', 3);
  assert.throws(() => rmTree(dir, { maxRetries: 2, remover: short.remover, pause: () => {} }), { code: 'EBUSY' });
  assert.equal(short.calls(), 3, 'maxRetries 2 is three tries');
  const other = failing('EIO', 1);
  assert.throws(() => rmTree(dir, { maxRetries: 5, remover: other.remover, pause: () => {} }), { code: 'EIO' });
  assert.equal(other.calls(), 1, 'another error is not tried again');
  const ok = failing('EPERM', 2);
  let pauses = 0;
  rmTree(dir, { maxRetries: 2, retryDelay: 7, remover: ok.remover, pause: (ms) => { assert.equal(ms, 7); pauses++; } });
  assert.equal(ok.calls(), 3);
  assert.equal(pauses, 2);
  assert.equal(fs.existsSync(dir), false);
});

// ---- CENSUS ----
const TEST_DIR = __dirname;
/** What makes read-only files in a test tree. A file matching any of these is a producer. */
const PRODUCERS = [
  { name: 'git init', re: /(?<!:\s*)['"]init['"]\s*[,\]]|\bgit init\b/ }, // not an object value (`subtype: 'init'`)
  { name: 'git clone', re: /['"]clone['"]\s*,|\bgit clone\b/ },
  { name: 'chmod to a read-only mode', re: /chmodSync\([^)]*0o[45][0-7]{2}\b|mode:\s*0o[45][0-7]{2}\b/ },
  { name: 'attrib +R / IsReadOnly', re: /attrib(\.exe)?['"]?,?\s*\[?\s*['"]\+[rR]|IsReadOnly\s*=\s*\$true/ },
];
/** { file (under test/, forward slashes), call (the arguments, whitespace collapsed), reason }. */
const ALLOW = [
  { file: 'rm-tree-readonly-108.test.cjs', call: 'dir, { recursive: true, force: true }', reason: 'the RUNTIME PIN: the raw remove is the thing under test' },
  { file: 'worktree-remove-junction-191.test.cjs', call: 'scratch, { recursive: true, force: true }', reason: 'pins what a raw rmSync does to a junction; the scratch folder holds no read-only file' },
  { file: 'related-tests-198.test.cjs', call: 'baseTree, { recursive: true, force: true }', reason: 'a mutant search string: text of scripts/related-tests.cjs, not a call in the test' },
];

function argsAt(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  return null;
}
/** `text` with its comment lines blanked (line numbers kept). */
const code = (text) => text.replace(/^[ \t]*(?:\/\/|\/?\*).*$/gm, '');
/** The recursive fs removes called in `text`, comment lines left out: { line, call }. */
function recursiveRemoves(raw) {
  const text = code(raw);
  const out = [];
  for (const m of text.matchAll(/\b(?:rmSync|rm|rmdirSync|rmdir)\(/g)) {
    const args = argsAt(text, m.index + m[0].length - 1);
    if (args === null || !/\brecursive\b/.test(args)) continue;
    out.push({ line: text.slice(0, m.index).split('\n').length, call: args.replace(/\s+/g, ' ').trim() });
  }
  return out;
}
function cjsFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) cjsFiles(p, out);
    else if (e.name.endsWith('.cjs')) out.push(p);
  }
  return out;
}

test('CENSUS: the patterns read what they are meant to read', () => {
  const producer = (s) => PRODUCERS.filter((p) => p.re.test(s)).map((p) => p.name);
  assert.deepEqual(producer("git(['init', '-q', '-b', 'main']);"), ['git init']);
  assert.deepEqual(producer("execFileSync('git', ['init'], o)"), ['git init']);
  assert.deepEqual(producer("sh('git init -q')"), ['git init']);
  assert.deepEqual(producer("git(['clone', '-q', a, b])"), ['git clone']);
  assert.deepEqual(producer('fs.chmodSync(archive, 0o444);'), ['chmod to a read-only mode']);
  assert.deepEqual(producer('fs.writeFileSync(f, x, { mode: 0o400 })'), ['chmod to a read-only mode']);
  assert.deepEqual(producer("spawnSync('attrib', ['+R', f])"), ['attrib +R / IsReadOnly']);
  assert.deepEqual(producer("fs.chmodSync(script, 0o755); const o = { type: 'system', subtype: 'init', id: 1 };"), [], 'an executable mode and an init that is not a git argument are not producers');
  const RM = 'rmSync'; // spelled apart, or this file's own census would read the fixture as a call
  const P = 'rm';
  assert.deepEqual(recursiveRemoves(`a;\nfs.${RM}(d, { recursive: true, force: true });\nfs.${RM}(f);\n// fs.${RM}(c, { recursive: true });\nawait fsp.${P}(x, {\n  recursive: true });`).map((r) => `${r.line}:${r.call}`),
    ['2:d, { recursive: true, force: true }', '5:x, { recursive: true }']);
});

test('CENSUS: no file under test/ that makes read-only files holds a recursive fs remove (use test/tools/rm-tree.cjs)', () => {
  const found = [];
  const used = new Set();
  let producers = 0;
  for (const p of cjsFiles(TEST_DIR)) {
    const text = fs.readFileSync(p, 'utf8');
    const file = path.relative(TEST_DIR, p).replace(/\\/g, '/');
    const kinds = PRODUCERS.filter((k) => k.re.test(text)).map((k) => k.name);
    if (!kinds.length) continue;
    producers++;
    for (const r of recursiveRemoves(text)) {
      const allowed = ALLOW.findIndex((a) => a.file === file && a.call === r.call);
      if (allowed >= 0) { used.add(allowed); continue; }
      found.push(`${file}:${r.line} rm(${r.call}) [${kinds.join(', ')}]`);
    }
  }
  assert.ok(producers >= 19, `the census read only ${producers} producer files: the patterns stopped matching`);
  assert.deepEqual(found, [], `these trees can hold read-only files; a recursive fs remove of them fails under Electron:\n${found.join('\n')}`);
  assert.deepEqual(ALLOW.map((a, i) => (used.has(i) ? null : `${a.file}: ${a.call}`)).filter(Boolean), [], 'every ALLOW entry matches a site');
});

test('CENSUS: the helper holds no recursive fs remove and changes no mode', () => {
  const text = code(fs.readFileSync(path.join(TEST_DIR, 'tools', 'rm-tree.cjs'), 'utf8'));
  assert.deepEqual(recursiveRemoves(text), []);
  assert.equal(/\b(?:rmSync|rmdirSync|unlinkSync|chmodSync|chmod|rm)\(/.test(text), false, 'it removes through src/main/fsSafeRemove.ts only');
});
