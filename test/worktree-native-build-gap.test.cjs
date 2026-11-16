'use strict';
require('./tools/own-job.cjs');
// MUTANT-JOURNAL-GATE: this suite reads test/tools/run-tests.cjs, a file a census mutates in place.
require('./tools/mutant-runner-helper.cjs').gate(__filename);
// WORKTREE-NATIVE-BUILD-GAP: tools/worktree-setup.cjs finds and fills a fresh worktree's gaps
// (native builds, a TERM-FONT-105 patched xterm addon) without ever writing into a shared tree,
// and test/tools/run-tests.cjs refuses to start a suite on a gap.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const W = require('../tools/worktree-setup.cjs');

const REPO = path.join(__dirname, '..');
const quiet = () => {};
function jail(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wnbg-'));
  t.after(() => {
    // unlink links first so the rm never reaches a fixture target through one
    try { W.teardown(dir, { log: quiet }); } catch { /* best effort */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
function put(root, rel, text) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}
const isLink = (p) => fs.lstatSync(p).isSymbolicLink();

/** A fake spawnSync: the xterm --check passes only on a lib file that reads PATCHED, the patch
 *  writes PATCHED, a build tool writes its NATIVES output. Records every call. */
function fakeSpawn(root, calls = []) {
  return (cmd, args) => {
    calls.push(args.map((a) => (typeof a === 'string' ? a.replace(root, '<root>') : a)));
    const at = args.indexOf('--root');
    if (at >= 0) {
      const lib = path.join(args[at + 1], 'lib', 'addon-webgl.js');
      if (args.includes('--check')) return { status: fs.readFileSync(lib, 'utf8') === 'PATCHED' ? 0 : 1, stdout: '', stderr: '' };
      fs.writeFileSync(lib, 'PATCHED');
      return { status: 0, stdout: '', stderr: '' };
    }
    const n = W.NATIVES.find((x) => args[0] === path.join(root, x.build));
    if (n) { put(root, n.out, 'BUILT'); return { status: 0 }; }
    return { status: 9, stderr: `unexpected ${args.join(' ')}` };
  };
}
/** Every native built AND stamped from this tree's (fixture) sources: a complete, fresh native set. */
function builtNatives(root, text = 'x') {
  const stamp = {};
  for (const n of W.NATIVES) {
    if (!Object.keys(W.sourceDigests(root, n.dir)).length) put(root, `${n.dir}/src.txt`, `source of ${n.id}`);
    put(root, n.out, text);
    stamp[n.id] = W.sourcesDigest(root, n.dir);
  }
  fs.writeFileSync(path.join(root, W.STAMP), JSON.stringify(stamp));
}
function addon(root, text = 'PRISTINE') {
  put(root, 'node_modules/@xterm/addon-webgl/lib/addon-webgl.js', text);
  put(root, 'tools/patch-xterm-webgl-font.cjs', '// fake: the spawn is injected\n');
}

test('inspect names every gap of a fresh tree; natives only on the platforms that build them', (t) => {
  const root = jail(t);
  put(root, 'tools/patch-xterm-webgl-font.cjs', '//\n');
  const win = W.inspect(root, { platform: 'win32', spawnSyncFn: fakeSpawn(root) }).map((g) => g.id);
  assert.deepEqual(win, ['fs-handle', 'heavyjob', 'xterm'], 'a fresh Windows tree misses both natives and the addon');
  assert.deepEqual(W.inspect(root, { platform: 'linux', spawnSyncFn: fakeSpawn(root) }).map((g) => g.id), ['xterm'], 'Linux builds neither native');
  addon(root, 'PATCHED');
  builtNatives(root);
  assert.deepEqual(W.inspect(root, { platform: 'win32', spawnSyncFn: fakeSpawn(root) }), [], 'a complete tree has no gap');
});

test('preflight refuses a gap with the fix named; GUPPY_ALLOW_INCOMPLETE_TREE=1 runs anyway; no gap = go', () => {
  const gaps = () => [{ id: 'heavyjob', problem: 'resources/heavyjob/bin/guppy-heavyjob.exe is not built' }];
  const lines = [];
  assert.equal(W.preflight({ root: '.', env: {}, log: (l) => lines.push(l), inspectFn: gaps }), 2, 'a gap REFUSES the suite');
  assert.match(lines.join('\n'), /TREE GAP heavyjob/);
  assert.match(lines.join('\n'), /node tools\/worktree-setup\.cjs/, 'the refusal names the fix');
  const opt = [];
  const optedOut = [];
  assert.equal(W.preflight({ root: '.', env: { GUPPY_ALLOW_INCOMPLETE_TREE: '1' }, log: (l) => opt.push(l), inspectFn: gaps, optedOut }), 0, 'the opt-out runs');
  assert.match(opt.join('\n'), /TREE GAP heavyjob[\s\S]*running anyway/, 'the opt-out still prints the gaps');
  assert.deepEqual(optedOut, ['heavyjob'], 'the opt-out hands the gap ids back for the end-of-run line');
  assert.equal(W.optOutLine(optedOut), '[test-runner] INCOMPLETE TREE (opt-out): heavyjob');
  const refused = [];
  W.preflight({ root: '.', env: {}, log: quiet, inspectFn: gaps, optedOut: refused });
  assert.deepEqual(refused, [], 'a refusal is not an opt-out');
  assert.equal(W.preflight({ root: '.', env: {}, log: quiet, inspectFn: () => [] }), 0, 'no gap: go');
});

test('run-tests.cjs gates its CLI run on preflight before run(), repeats an opt-out after the summary, and only the CLI gates (fixtures calling run() are untouched)', () => {
  const src = fs.readFileSync(path.join(REPO, 'test', 'tools', 'run-tests.cjs'), 'utf8').replace(/\r\n/g, '\n');
  const main = src.slice(src.indexOf('if (require.main === module)'));
  const gate = main.search(/const treeSetup = require\('\.\.\/\.\.\/tools\/worktree-setup\.cjs'\);\s*const optedOut = \[\];\s*const gate = treeSetup\.preflight\(\{ root: repoRoot, optedOut \}\);\s*if \(gate\) process\.exit\(gate\);/);
  assert.ok(gate > 0, 'the CLI block calls preflight and exits on a refusal');
  assert.ok(gate < main.indexOf('run({'), 'the gate comes before the suite starts');
  const repeat = main.search(/if \(optedOut\.length\) process\.stderr\.write\(`\$\{treeSetup\.optOutLine\(optedOut\)\}\\n`\);\s*process\.exit\(code\);/);
  assert.ok(repeat > main.indexOf('run({'), 'the opt-out line is printed after the run, just before the exit');
  assert.equal(src.slice(0, src.indexOf('if (require.main === module)')).includes('worktree-setup'), false, 'run() itself does not gate');
});

test('--copy-from copies a native only when its sources are byte-identical; otherwise it builds', (t) => {
  const root = jail(t);
  const built = jail(t);
  addon(root, 'PATCHED');
  for (const r of [root, built]) {
    put(r, 'resources/heavyjob/guppy-heavyjob.cs', 'class A {}');
    put(r, 'resources/fs-handle/guppy-fs-handle.c', 'int a;');
    put(r, 'resources/fs-handle/binding.gyp', '{}');
  }
  builtNatives(built, 'FROM-BUILT'); // both stamped as built from the built tree's own sources
  put(built, 'resources/fs-handle/guppy-fs-handle.c', 'int b;'); // fs-handle sources differ from root's ...
  const stamp = JSON.parse(fs.readFileSync(path.join(built, W.STAMP), 'utf8'));
  stamp['fs-handle'] = W.sourcesDigest(built, 'resources/fs-handle'); // ... and its binary is fresh for them
  fs.writeFileSync(path.join(built, W.STAMP), JSON.stringify(stamp));
  const calls = [];
  const left = W.setup(root, { copyFrom: built, platform: 'win32', spawnSyncFn: fakeSpawn(root, calls), log: quiet });
  assert.deepEqual(left, [], 'no gap left');
  assert.equal(fs.readFileSync(path.join(root, 'resources/heavyjob/bin/guppy-heavyjob.exe'), 'utf8'), 'FROM-BUILT', 'identical sources: copied');
  assert.equal(fs.readFileSync(path.join(root, 'resources/fs-handle/bin/guppy_fs_handle.node'), 'utf8'), 'BUILT', 'different sources: NOT copied, built');
  assert.ok(calls.some((a) => a[0].endsWith('build-fs-handle.cjs')), 'the fs-handle build tool ran');
  assert.ok(!calls.some((a) => a[0].endsWith('build-heavyjob.cjs')), 'the copied native was not rebuilt');
  const mine = W.readStamp(root);
  assert.equal(mine.heavyjob, W.sourcesDigest(root, 'resources/heavyjob'), 'the copy is stamped with this tree\'s sources');
  assert.equal(mine['fs-handle'], W.sourcesDigest(root, 'resources/fs-handle'), 'the build is stamped too');
  assert.equal(W.sameSources(root, built, 'resources/heavyjob'), true);
  put(root, 'resources/heavyjob/extra.cs', 'x');
  assert.equal(W.sameSources(root, built, 'resources/heavyjob'), false, 'an extra source file is a difference');
  assert.equal(W.sameSources(root, built, 'resources/absent'), false, 'no sources is never "identical"');
});

test('--copy-from refuses a source binary its own tree does not stamp as fresh: it builds instead', (t) => {
  const root = jail(t);
  const built = jail(t);
  addon(root, 'PATCHED');
  for (const r of [root, built]) put(r, 'resources/heavyjob/guppy-heavyjob.cs', 'class A {}');
  builtNatives(built, 'FROM-BUILT');
  assert.equal(W.sameSources(root, built, 'resources/heavyjob'), true, 'identical sources ...');
  fs.rmSync(path.join(built, W.STAMP)); // ... but an unstamped binary may have been built from anything
  const calls = [];
  W.setup(root, { copyFrom: built, platform: 'win32', spawnSyncFn: fakeSpawn(root, calls), log: quiet });
  assert.equal(fs.readFileSync(path.join(root, 'resources/heavyjob/bin/guppy-heavyjob.exe'), 'utf8'), 'BUILT', 'unstamped source binary: not copied');
  assert.ok(calls.some((a) => a[0].endsWith('build-heavyjob.cjs')));
});

test('STALE native: editing the .cs after the build makes preflight refuse (2) until setup rebuilds it', (t) => {
  const root = jail(t);
  addon(root, 'PATCHED');
  put(root, 'resources/heavyjob/guppy-heavyjob.cs', 'class A {}');
  builtNatives(root);
  const insp = (r) => W.inspect(r, { platform: 'win32', spawnSyncFn: fakeSpawn(root) });
  assert.equal(W.preflight({ root, env: {}, log: quiet, inspectFn: insp }), 0, 'built from these sources: go');
  put(root, 'resources/heavyjob/guppy-heavyjob.cs', 'class A { int changed; }');
  const lines = [];
  assert.equal(W.preflight({ root, env: {}, log: (l) => lines.push(l), inspectFn: insp }), 2, 'an edited .cs REFUSES the suite');
  assert.match(lines.join('\n'), /TREE GAP heavyjob: resources\/heavyjob\/bin\/guppy-heavyjob\.exe is stale/);
  assert.deepEqual(insp(root).map((g) => g.id), ['heavyjob'], 'only the edited native is stale');
  const calls = [];
  assert.deepEqual(W.setup(root, { platform: 'win32', spawnSyncFn: fakeSpawn(root, calls), log: quiet }), [], 'setup rebuilds it');
  assert.ok(calls.some((a) => a[0].endsWith('build-heavyjob.cjs')));
  assert.equal(W.preflight({ root, env: {}, log: quiet, inspectFn: insp }), 0, 'rebuilt and restamped: go');
  fs.rmSync(path.join(root, W.STAMP));
  assert.deepEqual(insp(root).map((g) => g.id), ['fs-handle', 'heavyjob'], 'no stamp: every present native is stale');
});

test('a link BELOW a real addon-webgl (lib/ junctioned to a shared copy) is replaced by a local copy before the patch', (t) => {
  const shared = jail(t);
  const root = jail(t);
  const sharedLib = put(shared, 'lib/addon-webgl.js', 'PRISTINE');
  put(root, 'tools/patch-xterm-webgl-font.cjs', '//\n');
  builtNatives(root);
  put(root, `${W.ADDON}/package.json`, '{}');
  fs.symlinkSync(path.join(shared, 'lib'), path.join(root, W.ADDON, 'lib'), 'junction');
  const before = fs.readFileSync(sharedLib);
  const gaps = W.inspect(root, { platform: 'win32', spawnSyncFn: fakeSpawn(root) });
  assert.match(gaps[0].problem, /a link under it, resolves into another tree/, 'the gap names the shared link');
  assert.deepEqual(W.setup(root, { platform: 'win32', spawnSyncFn: fakeSpawn(root), log: quiet }), [], 'setup leaves no gap');
  assert.deepEqual(fs.readFileSync(sharedLib), before, 'THE SHARED lib FILE IS BYTE-UNCHANGED');
  assert.equal(isLink(path.join(root, W.ADDON, 'lib')), false, 'lib/ is a real local folder now');
  assert.equal(fs.readFileSync(path.join(root, W.ADDON, 'lib/addon-webgl.js'), 'utf8'), 'PATCHED');
  assert.deepEqual(W.linksUnder(path.join(root, W.ADDON)), [], 'no link is left under the addon');
});

/** A jail tree holding the REAL canonical build tool and the stamp helper it requires. */
function toolTree(t, tool) {
  const root = jail(t);
  for (const f of [tool, 'tools/worktree-setup.cjs']) put(root, f, fs.readFileSync(path.join(REPO, f), 'utf8'));
  return root;
}
const runTool = (root, tool) => require('node:child_process').spawnSync(process.execPath, [path.join(root, tool)], { cwd: root, encoding: 'utf8', windowsHide: true });
const gapOf = (root, id) => W.inspect(root, { platform: 'win32', spawnSyncFn: fakeSpawn(root) }).find((g) => g.id === id);

test('postinstall-style build: the real tools/build-fs-handle.cjs stamps its binary fresh; a source change after it reads stale', { skip: process.platform === 'linux' && 'no addon on Linux' }, (t) => {
  const root = toolTree(t, 'tools/build-fs-handle.cjs');
  put(root, 'resources/fs-handle/guppy-fs-handle.c', 'int a;');
  // node-gyp and electron resolve from the jail's own node_modules: a fake gyp that "builds" the addon
  put(root, 'node_modules/electron/package.json', JSON.stringify({ name: 'electron', version: '0.0.0' }));
  put(root, 'node_modules/node-gyp/bin/node-gyp.js', "require('fs').mkdirSync('build/Release',{recursive:true});require('fs').writeFileSync('build/Release/guppy_fs_handle.node','GYP');\n");
  const r = runTool(root, 'tools/build-fs-handle.cjs');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.readFileSync(path.join(root, 'resources/fs-handle/bin/guppy_fs_handle.node'), 'utf8'), 'GYP');
  assert.equal(W.readStamp(root)['fs-handle'], W.sourcesDigest(root, 'resources/fs-handle'), 'the build tool wrote its stamp');
  assert.equal(gapOf(root, 'fs-handle'), undefined, 'a canonical build leaves the native fresh');
  put(root, 'resources/fs-handle/guppy-fs-handle.c', 'int a; int b;');
  assert.equal(gapOf(root, 'fs-handle')?.stale, true, 'a source change after the build reads stale');
});

test('npm-run-build-style build: the real tools/build-heavyjob.cjs (csc) stamps on success only; a .cs change after it reads stale', { skip: process.platform !== 'win32' && 'csc is Windows-only' }, (t) => {
  const root = toolTree(t, 'tools/build-heavyjob.cjs');
  put(root, 'resources/heavyjob/guppy-heavyjob.cs', 'class P { static void Main() {} }');
  const bad = runTool(root, 'tools/build-heavyjob.cjs');
  put(root, 'resources/heavyjob/guppy-heavyjob.cs', 'class P { static void Main() { BROKEN } }');
  const broken = runTool(root, 'tools/build-heavyjob.cjs');
  assert.equal(bad.status, 0, bad.stdout + bad.stderr);
  assert.equal(broken.status, 1, 'a failed compile fails');
  assert.equal(gapOf(root, 'heavyjob')?.stale, true, 'a failed build stamps nothing: the old binary reads stale for the new sources');
  put(root, 'resources/heavyjob/guppy-heavyjob.cs', 'class P { static void Main() {} }');
  assert.equal(gapOf(root, 'heavyjob'), undefined, 'the successful build stamped its own sources: fresh');
  put(root, 'resources/heavyjob/guppy-heavyjob.cs', 'class P { static void Main() { int x = 1; } }');
  assert.equal(gapOf(root, 'heavyjob')?.stale, true, 'a .cs change after the build reads stale');
});

test('a junctioned shared node_modules: the tree gets its own patched addon, the shared tree is not written', (t) => {
  const shared = jail(t);
  const root = jail(t);
  put(shared, 'node_modules/left-pad/index.js', 'LP');
  put(shared, 'node_modules/.package-lock.json', '{"lock":1}');
  put(shared, 'node_modules/@xterm/xterm/lib/xterm.js', 'XT');
  put(shared, 'node_modules/@xterm/addon-webgl/lib/addon-webgl.js', 'PRISTINE');
  put(root, 'tools/patch-xterm-webgl-font.cjs', '//\n');
  builtNatives(root);
  fs.symlinkSync(path.join(shared, 'node_modules'), path.join(root, 'node_modules'), 'junction');
  const gaps = W.inspect(root, { platform: 'win32', spawnSyncFn: fakeSpawn(root) });
  assert.deepEqual(gaps.map((g) => g.id), ['xterm']);
  assert.match(gaps[0].problem, /resolves into another tree/, 'the gap says the addon is shared');

  assert.deepEqual(W.setup(root, { platform: 'win32', spawnSyncFn: fakeSpawn(root), log: quiet }), [], 'setup leaves no gap');
  const nm = path.join(root, 'node_modules');
  assert.equal(fs.readFileSync(path.join(shared, 'node_modules/@xterm/addon-webgl/lib/addon-webgl.js'), 'utf8'), 'PRISTINE', 'THE SHARED ADDON IS NOT PATCHED');
  assert.equal(isLink(nm), false, 'node_modules is a real folder now');
  assert.equal(isLink(path.join(nm, 'left-pad')), true, 'other packages stay junctions');
  assert.equal(fs.readFileSync(path.join(nm, '.package-lock.json'), 'utf8'), '{"lock":1}', 'top-level files are copied');
  assert.equal(isLink(path.join(nm, '@xterm')), false);
  assert.equal(isLink(path.join(nm, '@xterm', 'xterm')), true);
  assert.equal(isLink(path.join(nm, '@xterm', 'addon-webgl')), false, 'the addon is a real local copy');
  assert.equal(fs.readFileSync(path.join(nm, '@xterm/addon-webgl/lib/addon-webgl.js'), 'utf8'), 'PATCHED');
  assert.equal(W.resolvesInside(path.join(nm, '@xterm', 'addon-webgl'), root), true);
  assert.equal(W.resolvesInside(path.join(nm, 'left-pad'), root), false);

  assert.equal(W.teardown(root, { log: quiet }), 2, 'teardown unlinks left-pad, @xterm/xterm and nothing else');
  assert.equal(fs.existsSync(path.join(nm, '@xterm/addon-webgl/lib/addon-webgl.js')), true, 'the local addon copy is a real folder, kept');
  assert.equal(fs.readFileSync(path.join(shared, 'node_modules/left-pad/index.js'), 'utf8'), 'LP', 'teardown never reaches a link target');
  assert.equal(fs.readFileSync(path.join(shared, 'node_modules/@xterm/xterm/lib/xterm.js'), 'utf8'), 'XT');
});

test('a link straight to the addon becomes a local copy; a tree that owns its node_modules is patched in place', (t) => {
  const shared = jail(t);
  const root = jail(t);
  put(shared, 'addon-webgl/lib/addon-webgl.js', 'PRISTINE');
  put(root, 'tools/patch-xterm-webgl-font.cjs', '//\n');
  fs.mkdirSync(path.join(root, 'node_modules', '@xterm'), { recursive: true });
  fs.symlinkSync(path.join(shared, 'addon-webgl'), path.join(root, W.ADDON), 'junction');
  W.localizeXterm(root, { spawnSyncFn: fakeSpawn(root), log: quiet });
  assert.equal(fs.readFileSync(path.join(shared, 'addon-webgl/lib/addon-webgl.js'), 'utf8'), 'PRISTINE', 'the link target is not patched');
  assert.equal(isLink(path.join(root, W.ADDON)), false);
  assert.equal(fs.readFileSync(path.join(root, W.ADDON, 'lib/addon-webgl.js'), 'utf8'), 'PATCHED');

  const own = jail(t);
  addon(own, 'PRISTINE');
  W.localizeXterm(own, { spawnSyncFn: fakeSpawn(own), log: quiet });
  assert.equal(fs.readFileSync(path.join(own, W.ADDON, 'lib/addon-webgl.js'), 'utf8'), 'PATCHED', 'an owned addon is patched where it is');
});

test('the real patch tool, run by setup on a junctioned tree, patches only the local copy', (t) => {
  let src;
  try { src = path.dirname(require.resolve('@xterm/addon-webgl/package.json', { paths: [REPO] })); } catch { return t.skip('no @xterm/addon-webgl installed'); }
  const shared = jail(t);
  const root = jail(t);
  fs.cpSync(src, path.join(shared, 'node_modules', '@xterm', 'addon-webgl'), { recursive: true, dereference: true });
  fs.copyFileSync(path.join(REPO, 'tools', 'patch-xterm-webgl-font.cjs'), put(root, 'tools/patch-xterm-webgl-font.cjs', ''));
  builtNatives(root);
  fs.symlinkSync(path.join(shared, 'node_modules'), path.join(root, 'node_modules'), 'junction');
  const before = fs.readFileSync(path.join(shared, 'node_modules/@xterm/addon-webgl/lib/addon-webgl.js'));
  assert.deepEqual(W.setup(root, { platform: 'win32', log: quiet }), [], 'the real --check passes after setup');
  assert.deepEqual(fs.readFileSync(path.join(shared, 'node_modules/@xterm/addon-webgl/lib/addon-webgl.js')), before, 'the shared copy is byte-identical');
});

test('resolvesInside sees through links; an @xterm junction out of the tree is split, its addon copied, never patched through', (t) => {
  const other = jail(t);
  const root = jail(t);
  fs.mkdirSync(path.join(other, 'x'));
  fs.symlinkSync(path.join(other, 'x'), path.join(root, 'x'), 'junction');
  assert.equal(W.resolvesInside(path.join(root, 'x'), root), false);
  assert.equal(W.resolvesInside(root, root), true);
  addon(root, 'PRISTINE');
  fs.rmSync(path.join(root, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.symlinkSync(path.join(other, 'x'), path.join(root, 'node_modules', '@xterm'), 'junction');
  fs.mkdirSync(path.join(other, 'x', 'addon-webgl', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(other, 'x', 'addon-webgl', 'lib', 'addon-webgl.js'), 'PRISTINE');
  // @xterm is split, so the addon resolves outside only through the split's own junction: copied locally
  W.localizeXterm(root, { spawnSyncFn: fakeSpawn(root), log: quiet });
  assert.equal(fs.readFileSync(path.join(other, 'x', 'addon-webgl', 'lib', 'addon-webgl.js'), 'utf8'), 'PRISTINE', 'never patched through a link');
});
