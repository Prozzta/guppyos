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
  assert.deepEqual(W.inspect(root, { platform: 'linux', spawnSyncFn: fakeSpawn(root) }).map((g) => g.id), ['fs-handle', 'xterm'], 'Linux builds the fs-handle addon (the link-safe tree delete), not heavyjob');
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

test('run-tests.cjs gates its CLI run on preflight before run(), repeats an opt-out at exit (after the summary), and only the CLI gates (fixtures calling run() are untouched)', () => {
  const src = fs.readFileSync(path.join(REPO, 'test', 'tools', 'run-tests.cjs'), 'utf8').replace(/\r\n/g, '\n');
  const main = src.slice(src.indexOf('if (require.main === module)'));
  const gate = main.search(/const treeSetup = require\('\.\.\/\.\.\/tools\/worktree-setup\.cjs'\);\s*const optedOut = \[\];\s*const gate = treeSetup\.preflight\(\{ root: repoRoot, optedOut \}\);\s*if \(gate\) process\.exit\(gate\);/);
  assert.ok(gate > 0, 'the CLI block calls preflight and exits on a refusal');
  assert.ok(gate < main.indexOf('run({'), 'the gate comes before the suite starts');
  const repeat = main.search(/if \(optedOut\.length\) process\.once\('exit', \(\) => fs\.writeSync\(2, `\$\{treeSetup\.optOutLine\(optedOut\)\}\\n`\)\);/);
  assert.ok(repeat > gate && repeat < main.indexOf('run({'), 'the opt-out repeat is an exit hook registered once the gate passed, so it prints after the summary');
  assert.match(main, /require\('\.\/ps-env\.cjs'\)\.sweepPsTempDirs\(\);\s*process\.exit\(code\);/, 'nothing sits between the temp-folder sweep and the exit');
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

test('postinstall-style build: the real tools/build-fs-handle.cjs stamps its binary fresh; a source change after it reads stale', (t) => {
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

test('the stamp records the sources the build STARTED from: a source edited during the build (after the digest) reads stale', (t) => {
  // A -r hook makes the tool's first spawnSync (node-gyp / csc) append to the source first: the
  // digest must already have been taken, so the recorded stamp no longer matches the sources.
  const cases = [['fs-handle', 'tools/build-fs-handle.cjs', 'resources/fs-handle/guppy-fs-handle.c', 'int a;']];
  if (process.platform === 'win32') cases.push(['heavyjob', 'tools/build-heavyjob.cjs', 'resources/heavyjob/guppy-heavyjob.cs', 'class P { static void Main() {} }']);
  for (const [id, tool, src, text] of cases) {
    const root = toolTree(t, tool);
    put(root, src, text);
    put(root, 'node_modules/electron/package.json', JSON.stringify({ name: 'electron', version: '0.0.0' }));
    put(root, 'node_modules/node-gyp/bin/node-gyp.js', "require('fs').mkdirSync('build/Release',{recursive:true});require('fs').writeFileSync('build/Release/guppy_fs_handle.node','GYP');\n");
    const hook = put(root, 'mid-build-edit.cjs', `const cp = require('child_process'); const fs = require('fs');
const real = cp.spawnSync; let done = false;
cp.spawnSync = function () { if (!done) { done = true; fs.appendFileSync(${JSON.stringify(path.join(root, src))}, '\\n// edited mid-build\\n'); } return real.apply(this, arguments); };
`);
    const r = require('node:child_process').spawnSync(process.execPath, ['-r', hook, path.join(root, tool)], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(r.status, 0, `${id}: ${r.stdout}${r.stderr}`);
    assert.match(fs.readFileSync(path.join(root, src), 'utf8'), /edited mid-build/, `${id}: the hook edited the source during the build`);
    assert.ok(W.readStamp(root)[id], `${id}: the build stamped`);
    assert.notEqual(W.readStamp(root)[id], W.sourcesDigest(root, path.dirname(src)), `${id}: the stamp is the pre-build digest, not the edited sources'`);
    assert.equal(gapOf(root, id)?.stale, true, `${id}: a source edited mid-build reads STALE`);
  }
});

test('a junctioned shared node_modules is refused untouched: no link is created, the shared tree is not written, the fix is npm ci', (t) => {
  const shared = jail(t);
  const root = jail(t);
  put(shared, 'node_modules/left-pad/index.js', 'LP');
  put(shared, 'node_modules/@xterm/xterm/lib/xterm.js', 'XT');
  put(shared, 'node_modules/@xterm/addon-webgl/lib/addon-webgl.js', 'PRISTINE');
  put(root, 'tools/patch-xterm-webgl-font.cjs', '//\n');
  builtNatives(root);
  fs.symlinkSync(path.join(shared, 'node_modules'), path.join(root, 'node_modules'), 'junction');
  const gaps = W.inspect(root, { platform: 'win32', spawnSyncFn: fakeSpawn(root) });
  assert.deepEqual(gaps.map((g) => g.id), ['xterm']);
  assert.match(gaps[0].problem, /resolves into another tree.*npm ci/, 'the gap says the addon is shared and names the fix');

  const left = W.setup(root, { platform: 'win32', spawnSyncFn: fakeSpawn(root), log: quiet });
  assert.deepEqual(left.map((g) => g.id), ['xterm'], 'setup cannot fix a shared node_modules: the gap stays');
  assert.equal(fs.readFileSync(path.join(shared, 'node_modules/@xterm/addon-webgl/lib/addon-webgl.js'), 'utf8'), 'PRISTINE', 'THE SHARED ADDON IS NOT PATCHED');
  assert.equal(isLink(path.join(root, 'node_modules')), true, 'node_modules is left as it was');
  assert.deepEqual(fs.readdirSync(path.join(shared, 'node_modules')).sort(), ['@xterm', 'left-pad'], 'nothing is written into the shared tree');
  assert.equal(W.linksUnder(root).length, 1, 'setup created no link: the one the test made is the only one');
  assert.equal(W.localizeXterm(root, { spawnSyncFn: fakeSpawn(root), log: quiet }), false, 'localizeXterm refuses directly too');

  assert.equal(W.teardown(root, { log: quiet }), 1, 'teardown unlinks the one link and nothing else');
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
  assert.equal(W.localizeXterm(root, { spawnSyncFn: fakeSpawn(root), log: quiet }), true);
  assert.equal(fs.readFileSync(path.join(shared, 'addon-webgl/lib/addon-webgl.js'), 'utf8'), 'PRISTINE', 'the link target is not patched');
  assert.equal(isLink(path.join(root, W.ADDON)), false);
  assert.deepEqual(W.linksUnder(root), [], 'the link was replaced by a copy and no link was created');
  assert.equal(fs.readFileSync(path.join(root, W.ADDON, 'lib/addon-webgl.js'), 'utf8'), 'PATCHED');

  const own = jail(t);
  addon(own, 'PRISTINE');
  W.localizeXterm(own, { spawnSyncFn: fakeSpawn(own), log: quiet });
  assert.equal(fs.readFileSync(path.join(own, W.ADDON, 'lib/addon-webgl.js'), 'utf8'), 'PATCHED', 'an owned addon is patched where it is');
});

test('the real patch tool, run by setup on a tree whose addon is a link, patches only the local copy and leaves no link', (t) => {
  let src;
  try { src = path.dirname(require.resolve('@xterm/addon-webgl/package.json', { paths: [REPO] })); } catch { return t.skip('no @xterm/addon-webgl installed'); }
  const shared = jail(t);
  const root = jail(t);
  fs.cpSync(src, path.join(shared, 'addon-webgl'), { recursive: true, dereference: true });
  // This repo's own addon is already patched: undo the pinned edits so the shared copy is pristine
  // and setup really has to patch (otherwise --check passes and nothing runs).
  const { FILES } = require(path.join(REPO, 'tools', 'patch-xterm-webgl-font.cjs'));
  const sha = (b) => require('node:crypto').createHash('sha256').update(b).digest('hex');
  for (const [rel, pin] of Object.entries(FILES)) {
    const file = path.join(shared, 'addon-webgl', rel);
    let text = fs.readFileSync(file, 'utf8');
    if (sha(text) === pin.patched) for (const [before, after] of pin.edits) text = text.replace(after, () => before);
    fs.writeFileSync(file, text);
    assert.equal(sha(text), pin.pristine, `${rel}: the fixture's shared copy is pristine`);
  }
  fs.copyFileSync(path.join(REPO, 'tools', 'patch-xterm-webgl-font.cjs'), put(root, 'tools/patch-xterm-webgl-font.cjs', ''));
  builtNatives(root);
  fs.mkdirSync(path.join(root, 'node_modules', '@xterm'), { recursive: true });
  fs.symlinkSync(path.join(shared, 'addon-webgl'), path.join(root, W.ADDON), 'junction');
  const before = fs.readFileSync(path.join(shared, 'addon-webgl/lib/addon-webgl.js'));
  assert.deepEqual(W.setup(root, { platform: 'win32', log: quiet }), [], 'the real --check passes after setup');
  assert.deepEqual(fs.readFileSync(path.join(shared, 'addon-webgl/lib/addon-webgl.js')), before, 'the shared copy is byte-identical (still pristine)');
  assert.equal(sha(fs.readFileSync(path.join(root, W.ADDON, 'lib/addon-webgl.js'), 'utf8')), FILES['lib/addon-webgl.js'].patched, 'the local copy is the pinned patched form');
  assert.deepEqual(W.linksUnder(root), [], 'no link left or created');
});

test('resolvesInside sees through links; an @xterm junction out of the tree is refused, nothing written, never patched through', (t) => {
  const other = jail(t);
  const root = jail(t);
  fs.mkdirSync(path.join(other, 'x'));
  fs.symlinkSync(path.join(other, 'x'), path.join(root, 'x'), 'junction');
  assert.equal(W.resolvesInside(path.join(root, 'x'), root), false);
  assert.equal(W.resolvesInside(root, root), true);
  fs.rmSync(path.join(root, 'x'));
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.symlinkSync(path.join(other, 'x'), path.join(root, 'node_modules', '@xterm'), 'junction');
  fs.mkdirSync(path.join(other, 'x', 'addon-webgl', 'lib'), { recursive: true });
  fs.writeFileSync(path.join(other, 'x', 'addon-webgl', 'lib', 'addon-webgl.js'), 'PRISTINE');
  assert.equal(W.localizeXterm(root, { spawnSyncFn: fakeSpawn(root), log: quiet }), false, 'refused');
  assert.equal(fs.readFileSync(path.join(other, 'x', 'addon-webgl', 'lib', 'addon-webgl.js'), 'utf8'), 'PRISTINE', 'never patched through a link');
  assert.equal(isLink(path.join(root, 'node_modules', '@xterm')), true, '@xterm is left as it was');
  assert.deepEqual(fs.readdirSync(path.join(other, 'x')), ['addon-webgl'], 'nothing written into the other tree');
  assert.equal(W.linksUnder(root).length, 1, 'no link created');
});

// SUITE-LOAD-FLAKES-106H: a tree whose node_modules is a junction into an older tree ran the suite
// on a node-pty without the PTY-HOLD-NODEPTY-HANDOFF patch. The preflight did not look, and
// pty-hold-nodepty-handoff went red in 10 tests that read as a defect in that file.
/** A node-pty fixture: `source` is what the fake --check reads, `binary` the built conpty.node (or none). */
function nodePty(base, { source = 'HANDOFF', binary = 'MZ..DuplicateHandle..' } = {}) {
  put(base, 'node_modules/node-pty/src/win/conpty.cc', source);
  if (binary !== null) put(base, 'node_modules/node-pty/build/Release/conpty.node', binary);
}
/** fakeSpawn, plus the node-pty --check: it passes only on a source that reads HANDOFF. */
function fakeSpawnPty(root, calls = []) {
  const rest = fakeSpawn(root, calls);
  return (cmd, args) => {
    if (args[0] !== path.join(root, W.NODE_PTY_PATCH)) return rest(cmd, args);
    calls.push(args.map((a) => (typeof a === 'string' ? a.replace(root, '<root>') : a)));
    assert.deepEqual(args.slice(1, 3), ['--check', '--root'], 'THE NODE-PTY TOOL IS ONLY EVER ASKED TO CHECK: it rewrites files otherwise');
    return { status: fs.readFileSync(path.join(args[3], 'src', 'win', 'conpty.cc'), 'utf8') === 'HANDOFF' ? 0 : 1, stdout: '', stderr: '' };
  };
}
function ptyTree(t, opts) {
  const root = jail(t);
  builtNatives(root);
  addon(root, 'PATCHED');
  put(root, W.NODE_PTY_PATCH, '// fake: the spawn is injected\n');
  if (opts !== null) nodePty(root, opts);
  return root;
}
const ids = (root, platform = 'win32', calls = []) => W.inspect(root, { platform, spawnSyncFn: fakeSpawnPty(root, calls) }).map((g) => g.id);

test('NODE-PTY GAP: an unpatched node-pty, or a patched one whose binary was not rebuilt, is a gap; the installed form is none', (t) => {
  assert.deepEqual(ids(ptyTree(t, {})), [], 'patched source and a binary that imports DuplicateHandle: complete');

  const unpatched = ptyTree(t, { source: 'RACE-FIX ONLY' });
  const gap = W.inspect(unpatched, { platform: 'win32', spawnSyncFn: fakeSpawnPty(unpatched) });
  assert.deepEqual(gap.map((g) => g.id), ['node-pty'], 'AN UNPATCHED NODE-PTY IS A GAP');
  assert.match(gap[0].problem, /node-pty is not PTY-HOLD-NODEPTY-HANDOFF patched \(run `npm run postinstall` in this tree\)/);

  const stale = ptyTree(t, { binary: 'MZ..an older build..' });
  const g2 = W.inspect(stale, { platform: 'win32', spawnSyncFn: fakeSpawnPty(stale) });
  assert.deepEqual(g2.map((g) => g.id), ['node-pty'], 'A PATCHED SOURCE WITH AN OLD BINARY IS A GAP: the suite runs the binary');
  assert.match(g2[0].problem, /conpty\.node was not rebuilt from the patched source/);
  assert.deepEqual(ids(ptyTree(t, { binary: null })), ['node-pty'], 'no binary at all is the same gap');

  assert.deepEqual(ids(unpatched, 'linux'), [], 'the patch is Windows-only: no gap elsewhere');
  assert.deepEqual(ids(ptyTree(t, null)), [], 'no node-pty folder: not this check (a tree with no node_modules is the xterm gap)');
  const older = ptyTree(t, { source: 'RACE-FIX ONLY' });
  fs.rmSync(path.join(older, W.NODE_PTY_PATCH));
  assert.deepEqual(ids(older), [], 'a base from before the patch has no tool and no gap');
});

test('NODE-PTY GAP: a junction into an older tree is named as shared; setup reports it and writes nothing; the preflight stops the suite', (t) => {
  const shared = jail(t);
  const root = jail(t);
  put(shared, 'node_modules/@xterm/addon-webgl/lib/addon-webgl.js', 'PATCHED');
  nodePty(shared, { source: 'RACE-FIX ONLY', binary: 'MZ..an older build..' });
  builtNatives(root);
  put(root, 'tools/patch-xterm-webgl-font.cjs', '//\n');
  put(root, W.NODE_PTY_PATCH, '//\n');
  fs.symlinkSync(path.join(shared, 'node_modules'), path.join(root, 'node_modules'), 'junction');

  const gaps = W.inspect(root, { platform: 'win32', spawnSyncFn: fakeSpawnPty(root) });
  assert.deepEqual(gaps.map((g) => g.id), ['node-pty'], 'the xterm patch is there, so node-pty is the ONLY gap: what the 106h tree looked like');
  assert.match(gaps[0].problem, /resolves into another tree.*npm ci/, 'the gap names the shared tree and the fix');

  const calls = [];
  const left = W.setup(root, { platform: 'win32', spawnSyncFn: fakeSpawnPty(root, calls), log: quiet });
  assert.deepEqual(left.map((g) => g.id), ['node-pty'], 'setup cannot fix it: the gap stays');
  assert.ok(calls.length > 0 && calls.every((c) => c[1] === '--check'), 'setup only checked');
  assert.equal(fs.readFileSync(path.join(shared, 'node_modules/node-pty/src/win/conpty.cc'), 'utf8'), 'RACE-FIX ONLY', 'THE SHARED NODE-PTY IS NOT PATCHED');
  assert.equal(fs.readFileSync(path.join(shared, 'node_modules/node-pty/build/Release/conpty.node'), 'utf8'), 'MZ..an older build..');

  const lines = [];
  const code = W.preflight({ root, env: {}, log: (l) => lines.push(l), inspectFn: (r) => W.inspect(r, { platform: 'win32', spawnSyncFn: fakeSpawnPty(r) }) });
  assert.notEqual(code, 0, 'THE SUITE DOES NOT START ON AN UNPATCHED NODE-PTY');
  assert.ok(lines.some((l) => /TREE GAP node-pty: /.test(l)), lines.join(' | '));
});

test('NODE-PTY GAP: the real patch tool takes the check as inspect sends it, and fails a node-pty that is not the pinned form', { skip: process.platform !== 'win32' && 'the tool is a no-op off Windows' }, (t) => {
  const root = jail(t);
  for (const f of [W.NODE_PTY_PATCH, 'tools/node-pty-race-fix-pins.cjs']) put(root, f, fs.readFileSync(path.join(REPO, f)));
  const pins = require('../tools/node-pty-race-fix-pins.cjs');
  put(root, 'node_modules/node-pty/package.json', JSON.stringify({ name: 'node-pty', version: pins.NODE_PTY_VERSION }));
  put(root, 'node_modules/node-pty/src/win/conpty.cc', '// not the pinned source\n');
  put(root, 'node_modules/node-pty/lib/windowsPtyAgent.js', '// not the pinned agent\n');
  put(root, 'node_modules/node-pty/build/Release/conpty.node', 'MZ..DuplicateHandle..');
  const state = W.nodePtyState(root, { platform: 'win32' });
  assert.equal(state.ok, false, 'the real --check exits nonzero');
  assert.match(state.problem, /not PTY-HOLD-NODEPTY-HANDOFF patched/);
  assert.equal(fs.readFileSync(path.join(root, 'node_modules/node-pty/src/win/conpty.cc'), 'utf8'), '// not the pinned source\n', 'the check changed nothing');
});
