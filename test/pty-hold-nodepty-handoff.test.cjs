'use strict';
require('./tools/own-job.cjs');
/**
 * PTY-HOLD-NODEPTY-HANDOFF: the hold on a terminal's root is node-pty's own handle, handed over.
 *
 * PTY-KILL-PID-IDENTITY holds the root by a handle of Guppy's own so no kill can name a reused pid,
 * but it opened that handle BY PID, after node-pty's CreateProcess. node-pty closes its handle the
 * moment the root exits, so a root that died at once could lose its pid before the open (THE GAP).
 * Now the patched node-pty (tools/patch-node-pty-root-handle.cjs) duplicates the handle CreateProcess
 * returned, before its watcher thread exists, and the addon adopts that duplicate (procAdopt).
 *
 * What is tested:
 *   PINS     the installed node-pty is the patched one, source, JS and binary; undoing the patch
 *            text gives back the pinned inputs, so the patch is those lines and nothing else;
 *   TOOL     the patch tool on stated trees: applies, repeats as a no-op, refuses anything else and
 *            then writes nothing;
 *   MARKERS  the two release markers on stated trees;
 *   ADDON    procAdopt on real terminals of this file's own (node running a temp script);
 *   PRODUCT  holdRoot prefers the handoff and falls back to the open by pid, and pty.ts passes it.
 *
 * THE GAP FIXTURE: after the real spawn the test waits, synchronously, until the root has exited.
 * Nothing of JS runs meanwhile, so what follows is exactly "the root died before the hold".
 *
 * NO KILL IN THIS FILE REACHES A PROCESS IT DID NOT START: every taskkill is recorded, never run,
 * and the only processes ended are terminals this file spawned, through node-pty's own close.
 *
 * Mutants (each must die at the assertion that names its guarantee): see MUTANTS below. The C of
 * the patch and of the addon has no mutant runner; its guarantees are the ADDON tests.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { readSource } = require('./read-source.cjs');
const { tempDir } = require('./tools/test-temp.cjs');

const ROOT = path.join(__dirname, '..');
const PTYF = 'src/main/pty.ts';
const IDF = 'src/main/procIdentity.ts';
const WIN = process.platform === 'win32';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

const CAP_MS = 20_000;   // a failure bound for an event that never comes; no scenario waits it out
/** The whole file, counted from here (the heavy-slot wait is over by the time this line runs).
 *  Unref'd: it only ever fires in a process that something else keeps alive, a leaked terminal,
 *  handle or worker, and ends it as a failure instead of a stall.
 *  It runs on a thread of its own, because a timer of this thread is not enough here: Jim's C4
 *  (the addon closes node-pty's own handle) leaves this thread blocked inside node-pty's native
 *  code, where no timer of it ever fires (seen: the file sat for 7 minutes past a plain 120 s
 *  timer). process.exit in a worker ends only the worker, so the bound ends the process by pid. */
const FILE_CAP_MS = 120_000;
new (require('node:worker_threads').Worker)(`
  const d = require('node:worker_threads').workerData;
  setTimeout(() => {
    try { require('node:fs').writeSync(2, 'pty-hold-nodepty-handoff: still running after ' + d.ms + ' ms: a terminal, a handle or a worker was leaked, or the main thread is blocked\\n'); } catch { /* no stderr */ }
    process.kill(d.pid);
  }, d.ms);
`, { eval: true, workerData: { pid: process.pid, ms: FILE_CAP_MS } }).unref();
const within = (p, what) => {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`TIMED OUT waiting for ${what}`)), CAP_MS); })]).finally(() => clearTimeout(t));
};

let freshSeq = 0;
/** A new instance of the real identity module: its addon and its said-once latch are its own. */
const freshId = () => loadTs.fromText(IDF, `${readSource(IDF)}\n// fresh instance ${++freshSeq}: pty-hold-nodepty-handoff\n`);

function mutateText(rel, edits, tag) {
  let text = readSource(rel);
  for (const [from, to] of edits) {
    const hits = text.split(from).length - 1;
    assert.equal(hits, 1, `mutant ${tag}: edit target must match EXACTLY ONCE, matched ${hits}: ${JSON.stringify(from.slice(0, 80))}`);
    text = text.replace(from, () => to);
  }
  return text;
}

// ---------------------------------------------------------------------------------------------
// holdRoot's choice between the handoff and the open by pid: plain logic, a recording addon.
// ---------------------------------------------------------------------------------------------
const GOOD = { handoff: 'good' };
const BAD = { handoff: 'refused' };
/** Run `fn(id, calls, said)` with `addon` as the module's addon and console.error recorded. */
function withAddon(id, addon, fn) {
  const calls = [];
  const said = [];
  const dlopen = process.dlopen;
  const error = console.error;
  process.dlopen = (mod) => { mod.exports = addon(calls); };
  console.error = (...a) => { said.push(a.join(' ')); };
  try { return fn(id, calls, said); } finally { process.dlopen = dlopen; console.error = error; }
}
const recording = (calls) => ({
  procAdopt: (h, pid) => { calls.push(`adopt ${pid}`); if (h !== GOOD) throw new Error('refused by the addon'); return { how: 'adopted' }; },
  procOpen: (pid) => { calls.push(`open ${pid}`); return { how: 'opened' }; },
  procAlive: (h) => { calls.push(`alive ${h.how}`); return true; },
  procClose: (h) => { calls.push(`close ${h.how}`); }
});
const NOT_ADOPTED = /root handle was not adopted/;

const F = {
  choice: (mod) => withAddon(mod, recording, (id, calls, said) => {
    const a = id.holdRoot(4242, 'win32', GOOD);
    assert.deepEqual(calls, ['adopt 4242'], 'A HANDOFF IS ADOPTED AND THE PID IS NOT OPENED');
    assert.equal(a.alive(), true);
    a.release();
    assert.deepEqual(calls.slice(1), ['alive adopted', 'close adopted'], 'the hold asks and closes the adopted handle');
    assert.equal(said.filter((s) => NOT_ADOPTED.test(s)).length, 0, 'an adopted handoff says nothing');
    calls.length = 0;
    const b = id.holdRoot(4243, 'win32', BAD);
    assert.deepEqual(calls, ['adopt 4243', 'open 4243'], 'A REFUSED HANDOFF FALLS BACK TO THE OPEN BY PID');
    assert.ok(b && b.alive(), 'A REFUSED HANDOFF FALLS BACK TO THE OPEN BY PID: and that hold works');
    assert.match(said.join('\n'), /refused by the addon/, 'the fallback says why');
    calls.length = 0;
    assert.ok(id.holdRoot(4244, 'win32'), 'no handoff: opened by pid');
    assert.deepEqual(calls, ['open 4244'], 'no handoff: opened by pid, nothing adopted');
    id.holdRoot(4245, 'win32', BAD);
    assert.equal(said.filter((s) => NOT_ADOPTED.test(s)).length, 1, `THE FALLBACK IS SAID ONCE, not per terminal: ${said.length} lines`);
    calls.length = 0;
    assert.equal(id.holdRoot(4246, 'linux', GOOD), null, 'no hold off Windows');
    assert.equal(id.holdRoot(0, 'win32', GOOD), null, 'no hold without a pid');
    assert.deepEqual(calls, [], 'and the addon is not asked');
  }),
  oldAddon: (mod) => withAddon(mod, (calls) => { const a = recording(calls); delete a.procAdopt; return a; }, (id, calls, said) => {
    assert.ok(id.holdRoot(4250, 'win32', GOOD), 'AN ADDON WITHOUT procAdopt STILL HOLDS, by pid');
    assert.deepEqual(calls, ['open 4250']);
    assert.match(said.join('\n'), /lacks procAdopt/, 'and says which half is old');
  }),
  reader: (id) => {
    const h = { external: true };
    assert.equal(id.rootHandoff({ _agent: { _rootHandle: h } }), h, "ROOT HANDOFF READS node-pty's _agent._rootHandle");
    for (const none of [undefined, null, {}, { _agent: null }, { _agent: {} }, { _agent: { _rootHandle: null } }, 7]) {
      assert.equal(id.rootHandoff(none), undefined, `no handoff in ${JSON.stringify(none)}`);
    }
    const thrower = { get _agent() { throw new Error('no'); } };
    assert.equal(id.rootHandoff(thrower), undefined, 'a reader that throws is no handoff');
  }
};

test('holdRoot adopts a handoff, falls back to the open by pid, and says the fallback once', () => F.choice(freshId()));
test('an addon built before the handoff still holds by pid', () => F.oldAddon(freshId()));
test("rootHandoff reads the handle node-pty kept, and nothing else", () => F.reader(freshId()));

// ---------------------------------------------------------------------------------------------
// watchKillSweep: which promise is "this kill's sweep". Plain logic, a recording terminal.
// ---------------------------------------------------------------------------------------------
test("watchKillSweep gives the list promise the kill asked for, and nothing when it asked for none", () => {
  const { watchKillSweep } = loadTs(PTYF);
  assert.equal(watchKillSweep({}).started(), null, 'no agent (another node-pty): nothing to wait for');
  assert.equal(watchKillSweep({ _agent: {} }).started(), null, 'no list helper: nothing to wait for');
  const list = Promise.resolve([1]);
  const calls = [];
  const agent = { _getConsoleProcessList(...a) { calls.push([this, a]); return list; } };
  const quiet = watchKillSweep({ _agent: agent });
  assert.equal(quiet.started(), null, 'A KILL THAT ASKED FOR NO LIST HAS NO SWEEP');
  const w = watchKillSweep({ _agent: agent });
  const got = agent._getConsoleProcessList('x');
  assert.equal(got, list, "node-pty gets its own promise back, so its kills chain on it first");
  assert.deepEqual(calls, [[agent, ['x']]], 'the helper is called once, as the agent, with its arguments');
  assert.equal(w.started(), list, 'THE SWEEP IS THE PROMISE THE KILL ASKED FOR');
  const sync = { _getConsoleProcessList: () => [1] };
  const s = watchKillSweep({ _agent: sync });
  assert.deepEqual(sync._getConsoleProcessList(), [1]);
  assert.equal(s.started(), null, 'a helper that returns no promise has nothing to wait for');
});

const MUTANTS = [
  { file: IDF, name: 'A2 a refused handoff holds nothing', edits: [['  if (!adopted) {\n    try { handle = addon.procOpen(pid); } catch { return null; }\n  }\n', '  if (!adopted) return null;\n']],
    run: (mod) => F.choice(mod), dies: /A REFUSED HANDOFF FALLS BACK TO THE OPEN BY PID/ },
  { file: IDF, name: 'A3 the pid is opened although the handoff was adopted', edits: [['  if (!adopted) {\n    try { handle = addon.procOpen(pid); }', '  {\n    try { handle = addon.procOpen(pid); }']],
    run: (mod) => F.choice(mod), dies: /A HANDOFF IS ADOPTED AND THE PID IS NOT OPENED/ },
  { file: IDF, name: 'A4 the fallback is said for every terminal', edits: [['  if (handoffFallbackSaid) return;\n', '']],
    run: (mod) => F.choice(mod), dies: /THE FALLBACK IS SAID ONCE/ },
  { file: IDF, name: 'A5 rootHandoff reads nothing', edits: [['const handle = agent?._rootHandle;', 'const handle = undefined;']],
    run: (mod) => F.reader(mod), dies: /ROOT HANDOFF READS/ }
];

// ---------------------------------------------------------------------------------------------
// Windows: the patch, the markers, the addon, the gap.
// ---------------------------------------------------------------------------------------------
if (!WIN) {
  require('./tools/inert.cjs').announceInert('PTY-HOLD-NODEPTY-HANDOFF (Windows half)', 'the node-pty ConPTY patch, its markers and process handles are Windows only');
} else {
  const pins = require('../tools/node-pty-race-fix-pins.cjs');
  const NP = path.join(ROOT, 'node_modules', 'node-pty');
  const TOOL = path.join(ROOT, 'tools', 'patch-node-pty-root-handle.cjs');
  const RACE_TOOL = path.join(ROOT, 'tools', 'patch-node-pty-race-fix.cjs');
  const MARKERS = path.join(ROOT, 'scripts', 'release-markers.cjs');
  const CONPTY_NODE = path.join(NP, 'build', 'Release', 'conpty.node');
  const HINT = 'Run `npm run postinstall` in this tree (npm install does): it patches node-pty and rebuilds it.';
  const builtCc = fs.readFileSync(path.join(NP, 'src', 'win', 'conpty.cc'), 'utf8');
  const handoffJs = fs.readFileSync(path.join(NP, 'lib', 'windowsPtyAgent.js'), 'utf8');
  // The patch, undone by its own words: everything from its comment to the watcher's start, and the
  // property it sets; in the JS, its two lines.
  const race922Cc = builtCc
    .replace(/ {2}\/\/ GUPPY PTY-HOLD-NODEPTY-HANDOFF[\s\S]*?\n\n( {2}SetupExitCallback\(env, exitCallback, handle\);\n)/, '$1')
    .replace('  if (!rootHandle.IsUndefined()) {\n    marshal.Set("rootHandle", rootHandle);\n  }\n', '');
  // NODEPTY-PACKAGED-PROOF: the loader, and the same undone by its own words.
  const builtUtils = fs.readFileSync(path.join(NP, 'lib', 'utils.js'), 'utf8');
  const pristineUtils = builtUtils
    .replace(/ {4}\/\/ GUPPY NODEPTY-PACKAGED-PROOF[\s\S]*?\n {4}if \(guppyBuiltOnly\) \{\n[^\n]*\n {4}\}\n/, '')
    .replace(/ {4}if \(guppyBuiltOnly\) \{\n {8}throw new Error\("Guppy: [^\n]*\n {4}\}\n/, '');
  const pristineJs = handoffJs.split('\n').filter((l) => !/GUPPY PTY-HOLD-NODEPTY-HANDOFF|this\._rootHandle = connect\.rootHandle;/.test(l)).join('\n');

  const tree = (cc, js, { version = pins.NODE_PTY_VERSION, utils = pristineUtils } = {}) => {
    const dir = tempDir('phnh-tree-');
    fs.mkdirSync(path.join(dir, 'src', 'win'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'node-pty', version }));
    fs.writeFileSync(path.join(dir, 'src', 'win', 'conpty.cc'), cc);
    fs.writeFileSync(path.join(dir, 'lib', 'windowsPtyAgent.js'), js);
    fs.writeFileSync(path.join(dir, 'lib', 'utils.js'), utils);
    return dir;
  };
  const shas = (dir) => [['src', 'win', 'conpty.cc'], ['lib', 'windowsPtyAgent.js'], ['lib', 'utils.js']].map((rel) => sha(fs.readFileSync(path.join(dir, ...rel))));
  const DONE = [pins.CONPTY_CC_BUILT_SHA256, pins.AGENT_JS_HANDOFF_SHA256, pins.UTILS_JS_BUILT_ONLY_SHA256];
  const run = (tool, dir, ...args) => spawnSync(process.execPath, [tool, '--root', dir, ...args], { encoding: 'utf8' });

  test('PINS: the installed node-pty is the patched one, and the patch is only its own lines', () => {
    assert.equal(sha(builtCc), pins.CONPTY_CC_BUILT_SHA256, `conpty.cc is not the pinned handoff source. ${HINT}`);
    assert.equal(sha(handoffJs), pins.AGENT_JS_HANDOFF_SHA256, `windowsPtyAgent.js is not the pinned handoff form. ${HINT}`);
    assert.equal(sha(race922Cc), pins.CONPTY_CC_PATCHED_SHA256, 'conpty.cc without the handoff lines is the #922 form, byte for byte');
    assert.equal(sha(pristineJs), pins.AGENT_JS_PRISTINE_SHA256, 'windowsPtyAgent.js without the handoff lines is pristine 1.1.0, byte for byte');
    assert.equal(sha(builtUtils), pins.UTILS_JS_BUILT_ONLY_SHA256, `lib/utils.js is not the pinned built-only loader. ${HINT}`);
    assert.equal(sha(pristineUtils), pins.UTILS_JS_PRISTINE_SHA256, 'utils.js without the loader lines is pristine 1.1.0, byte for byte');
    assert.ok(pins.hasHandoffImports(CONPTY_NODE), `THE BINARY IS NOT BUILT FROM THE HANDOFF SOURCE: conpty.node does not import DuplicateHandle. ${HINT}`);
    assert.ok(pins.hasMutexImports(CONPTY_NODE), 'and it still carries #922');
    // The duplicate is made before the thread that can close the original exists, with query rights only.
    const dup = builtCc.indexOf('DuplicateHandle(GetCurrentProcess(), piClient.hProcess');
    const watcher = builtCc.indexOf('  SetupExitCallback(env, exitCallback, handle);');
    assert.ok(dup > 0 && watcher > dup, 'THE DUPLICATE IS MADE BEFORE THE WATCHER THREAD STARTS');
    assert.match(builtCc.slice(dup, watcher), /SYNCHRONIZE \| PROCESS_QUERY_LIMITED_INFORMATION, FALSE, 0\)/, 'query and wait rights only, not inheritable');
    assert.doesNotMatch(builtCc.slice(dup, watcher), /PROCESS_TERMINATE|PROCESS_ALL_ACCESS|DUPLICATE_SAME_ACCESS/, 'the handed-over handle cannot end the process');
  });

  test('TOOL: applies to the #922 tree, repeats as a no-op, and --check tells the two apart', () => {
    const dir = tree(race922Cc, pristineJs);
    const check0 = run(TOOL, dir, '--check');
    assert.equal(check0.status, 1, '--check fails on an unpatched tree');
    assert.deepEqual(shas(dir), [pins.CONPTY_CC_PATCHED_SHA256, pins.AGENT_JS_PRISTINE_SHA256, pins.UTILS_JS_PRISTINE_SHA256], '--check changes nothing');
    const first = run(TOOL, dir);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /applied the root-handle handoff to node-pty 1\.1\.0 \(3 file\(s\)\)/);
    assert.deepEqual(shas(dir), DONE, 'all three files are the pinned forms');
    const again = run(TOOL, dir);
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /already applied/);
    assert.deepEqual(shas(dir), DONE, 'a second run changes nothing');
    const check1 = run(TOOL, dir, '--check');
    assert.equal(check1.status, 0, check1.stderr);
    // npm rebuild / a second postinstall: the #922 tool meets the handoff source and leaves it.
    const race = run(RACE_TOOL, dir);
    assert.equal(race.status, 0, `THE #922 TOOL MUST ACCEPT THE HANDOFF SOURCE (a second postinstall): ${race.stderr}`);
    assert.deepEqual(shas(dir), DONE);
    // A tree with one file done (an interrupted run) is finished, not refused.
    const half = tree(builtCc, pristineJs);
    assert.equal(run(TOOL, half).status, 0);
    assert.deepEqual(shas(half), DONE);
    // A tree from before NODEPTY-PACKAGED-PROOF (the handoff applied, the loader not) is finished too.
    const older = tree(builtCc, handoffJs);
    const olderRun = run(TOOL, older);
    assert.match(olderRun.stdout, /\(1 file\(s\)\)/, olderRun.stderr);
    assert.deepEqual(shas(older), DONE);
  });

  test('TOOL: --check fails when any one file alone is unpatched, and names it (Jim T4)', () => {
    const cases = [
      ['only lib/windowsPtyAgent.js unpatched', tree(builtCc, pristineJs, { utils: builtUtils }), /windowsPtyAgent\.js is not the pinned root-handle form/],
      ['only src/win/conpty.cc unpatched', tree(race922Cc, handoffJs, { utils: builtUtils }), /conpty\.cc is not the pinned root-handle form/],
      ['only lib/utils.js unpatched (the prebuilt fallback is back)', tree(builtCc, handoffJs), /utils\.js is not the pinned root-handle form/]
    ];
    for (const [name, dir, why] of cases) {
      const before = shas(dir);
      const r = run(TOOL, dir, '--check');
      assert.notEqual(r.status, 0, `--CHECK MUST FAIL: ${name} (stdout: ${r.stdout})`);
      assert.equal(r.status, 1, `${name}: a refusal, not a crash: ${r.stderr}`);
      assert.match(r.stderr, why, `${name}: the file is named`);
      assert.deepEqual(shas(dir), before, `--check writes nothing: ${name}`);
    }
  });

  test('TOOL: anything it does not know is refused, and a refusal writes nothing', () => {
    const pristineCcLike = race922Cc.replace('#include <mutex>\n', '');
    const cases = [
      ['conpty.cc not the #922 form', tree(pristineCcLike, pristineJs), [], /conpty\.cc is neither the #922-patched form/],
      ['conpty.cc with CRLF', tree(race922Cc.replace(/\n/g, '\r\n'), pristineJs), [], /conpty\.cc is neither/],
      ['windowsPtyAgent.js changed', tree(race922Cc, pristineJs.replace('_innerPid', '_innerPidX')), [], /windowsPtyAgent\.js is neither pristine 1\.1\.0/],
      ['utils.js changed', tree(race922Cc, pristineJs, { utils: pristineUtils.replace('Check build, debug', 'Check  build, debug') }), [], /utils\.js is neither pristine 1\.1\.0/],
      ['another node-pty', tree(race922Cc, pristineJs, { version: '1.2.0' }), [], /node-pty 1\.1\.0 required, got 1\.2\.0/],
      ['an unknown argument', tree(race922Cc, pristineJs), ['--help'], /unknown argument "--help"/],
      ['--root without a value', tree(race922Cc, pristineJs), ['--root'], /unknown argument "--root"/]
    ];
    for (const [name, dir, args, why] of cases) {
      const before = shas(dir);
      const r = run(TOOL, dir, ...args);
      assert.equal(r.status, 1, `${name}: must fail`);
      assert.match(r.stderr, why, name);
      assert.deepEqual(shas(dir), before, `A REFUSAL WRITES NOTHING: ${name} (the other file was patchable)`);
    }
  });

  test('the postinstall runs the tool after #922 and before the rebuild, and checks it after', () => {
    const post = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts.postinstall.split(' && ');
    const at = (s) => post.indexOf(s);
    const apply = at('node tools/patch-node-pty-root-handle.cjs');
    assert.ok(apply > at('node tools/patch-node-pty-race-fix.cjs') && at('node tools/patch-node-pty-race-fix.cjs') >= 0, 'after the #922 patch (its input)');
    assert.ok(apply < at('electron-rebuild -f -o node-pty'), 'BEFORE THE REBUILD: a patch applied after it is not in the binary');
    assert.ok(at('node tools/record-node-pty-race-fix.cjs') > at('electron-rebuild -f -o node-pty'), 'the record is taken of the rebuilt binary');
    assert.ok(at('node tools/patch-node-pty-root-handle.cjs --check') > at('node tools/record-node-pty-race-fix.cjs'), 'and the install ends by checking the patch is there');
    const record = fs.readFileSync(path.join(ROOT, 'tools', 'record-node-pty-race-fix.cjs'), 'utf8');
    assert.match(record, /CONPTY_CC_BUILT_SHA256/, 'the record refuses a source without the handoff');
    assert.match(record, /hasHandoffImports/, 'and a binary without it');
  });

  test('MARKERS: the release markers fail a build without the handoff', () => {
    const bin = fs.readFileSync(CONPTY_NODE);
    const at = bin.indexOf(Buffer.from('DuplicateHandle\0', 'latin1'));
    assert.ok(at > 0, 'the import name is in the binary');
    const without = Buffer.from(bin);
    without[at] = 'X'.charCodeAt(0);   // a binary that imports "XuplicateHandle": parses, lacks the call
    const fake = ({ binary = bin, record = sha(binary), js = handoffJs, utils = builtUtils, marker = true }) => {
      const dir = tempDir('phnh-markers-');
      const np = path.join(dir, 'node-pty');
      fs.mkdirSync(path.join(np, 'build', 'Release'), { recursive: true });
      fs.mkdirSync(path.join(np, 'lib'), { recursive: true });
      fs.writeFileSync(path.join(np, 'package.json'), JSON.stringify({ name: 'node-pty', version: pins.NODE_PTY_VERSION }));
      fs.writeFileSync(path.join(np, 'build', 'Release', 'conpty.node'), binary);
      fs.writeFileSync(path.join(np, 'lib', 'windowsPtyAgent.js'), js);
      fs.writeFileSync(path.join(np, 'lib', 'utils.js'), utils);
      if (marker) fs.writeFileSync(path.join(np, pins.MARKER_FILE), JSON.stringify({ version: pins.NODE_PTY_VERSION, sourceSha256: pins.CONPTY_CC_BUILT_SHA256, files: { 'build/Release/conpty.node': { sha256: record } } }));
      const out = spawnSync(process.execPath, [MARKERS, dir, path.join(dir, 'models')], { encoding: 'utf8' }).stdout.split(/\r?\n/);
      const of = (label) => (out.find((l) => l.endsWith(label)) || '').slice(0, 5).trim();
      return [of('conpty.node built with the root-handle handoff'), of('windowsPtyAgent.js keeps the root handle'), of('node-pty loader takes built binaries only')];
    };
    assert.equal(pins.hasHandoffImports(CONPTY_NODE), true);
    assert.deepEqual(fake({}), ['OK', 'OK', 'OK'], 'the installed build passes both');
    assert.deepEqual(fake({ binary: without }), ['FAIL', 'OK', 'OK'], 'A BINARY WITHOUT DuplicateHandle FAILS, even with a matching record');
    assert.deepEqual(fake({ record: '0'.repeat(64) }), ['FAIL', 'OK', 'OK'], 'a binary that is not the recorded one fails');
    assert.deepEqual(fake({ marker: false }), ['FAIL', 'OK', 'OK'], 'no record fails');
    assert.deepEqual(fake({ js: pristineJs }), ['OK', 'FAIL', 'OK'], 'A windowsPtyAgent.js THAT DROPS THE HANDLE FAILS');
    assert.deepEqual(fake({ utils: pristineUtils }), ['OK', 'OK', 'FAIL'], 'A LOADER THAT FALLS BACK TO THE PREBUILT BINARY FAILS');
    assert.match(fs.readFileSync(MARKERS, 'utf8'), /Prints ALL 16 MARKERS OK/);
  });

  // ---- NODEPTY-PACKAGED-PROOF: the packaged check, and the loader ---------------------------
  // A packaged app in a temp dir: resources/app.asar (an index only, written by hand) and
  // resources/app.asar.unpacked/node_modules/node-pty with the installed build's own files.
  const CHECKER = path.join(ROOT, 'tools', 'check-packaged-node-pty.cjs');
  const NPP = 'node_modules/node-pty';
  const conptyBin = fs.readFileSync(CONPTY_NODE);
  const conptyWithout = (() => {
    const b = Buffer.from(conptyBin);
    b[b.indexOf(Buffer.from('DuplicateHandle\0', 'latin1'))] = 'X'.charCodeAt(0);
    return b;
  })();
  const asarOf = (list) => {
    const root = { files: {} };
    for (const [p, unpacked] of list) {
      const parts = p.split('/');
      let node = root;
      for (const part of parts.slice(0, -1)) { node.files[part] = node.files[part] || { files: {} }; node = node.files[part]; }
      node.files[parts[parts.length - 1]] = unpacked ? { size: 1, unpacked: true } : { size: 1, offset: '0' };
    }
    const json = Buffer.from(JSON.stringify(root));
    const head = Buffer.alloc(16);
    [4, json.length + 8, json.length + 4, json.length].forEach((n, i) => head.writeUInt32LE(n, i * 4));
    return Buffer.concat([head, json]);
  };
  /** extra: files on disk AND listed unpacked; diskOnly: on disk, not listed; asar(list): the list, a Buffer, or null for none. */
  const packaged = ({ version = pins.NODE_PTY_VERSION, js = handoffJs, utils = builtUtils, binary = conptyBin, record = sha(binary), marker = true, cc = null, extra = [], diskOnly = [], asar = (l) => l } = {}) => {
    const dir = tempDir('phnh-pkg-');
    const resources = path.join(dir, 'resources');
    const listed = [
      [`${NPP}/package.json`, JSON.stringify({ name: 'node-pty', version })],
      [`${NPP}/lib/windowsPtyAgent.js`, js],
      [`${NPP}/lib/utils.js`, utils],
      [`${NPP}/build/Release/conpty.node`, binary],
      ...(marker ? [[`${NPP}/${pins.MARKER_FILE}`, JSON.stringify({ version: pins.NODE_PTY_VERSION, sourceSha256: pins.CONPTY_CC_BUILT_SHA256, files: { 'build/Release/conpty.node': { sha256: record } } })]] : []),
      ...(cc === null ? [] : [[`${NPP}/src/win/conpty.cc`, cc]]),
      ...extra
    ];
    for (const [rel, bytes] of [...listed, ...diskOnly]) {
      const file = path.join(resources, 'app.asar.unpacked', ...rel.split('/'));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes);
    }
    const a = asar([['package.json', false], ['out/main/index.js', false], ...listed.map(([rel]) => [rel, true])]);
    if (a !== null) fs.writeFileSync(path.join(resources, 'app.asar'), Buffer.isBuffer(a) ? a : asarOf(a));
    return dir;
  };
  const failing = (mod, dir) => mod.inspect(dir).checks.map((c, i) => (c.ok ? null : i)).filter((i) => i !== null);
  const whyOf = (mod, dir, i) => mod.inspect(dir).checks[i].why;
  const stray = Buffer.from('a prebuilt binary');

  const P = {
    good(mod) {
      const dir = packaged();
      assert.deepEqual(mod.inspect(dir).checks.map((c) => c.ok), Array(8).fill(true), `a patched packaged app passes all 8: ${JSON.stringify(mod.inspect(dir).checks.filter((c) => !c.ok))}`);
      assert.deepEqual(failing(mod, path.join(dir, 'resources')), [], 'the resources folder may be named instead');
      assert.deepEqual(failing(mod, packaged({ cc: builtCc })), [], 'the patched source may ship');
      assert.deepEqual(failing(mod, packaged({ extra: [[`${NPP}/prebuilds/darwin-arm64/pty.node`, stray]] })), [], 'a prebuilt binary of another platform is not the Windows fallback');
    },
    files(mod) {
      assert.deepEqual(failing(mod, packaged({ version: '1.2.0' })), [0], 'another node-pty fails');
      const agent = packaged({ js: pristineJs });
      assert.deepEqual(failing(mod, agent), [1], 'AN UNPATCHED windowsPtyAgent.js FAILS THE PACKAGED CHECK');
      assert.match(whyOf(mod, agent, 1), /UNPATCHED 1\.1\.0 file: rootHandle is dropped/);
      const utils = packaged({ utils: pristineUtils });
      assert.deepEqual(failing(mod, utils), [2], 'AN UNPATCHED LOADER FAILS THE PACKAGED CHECK');
      assert.match(whyOf(mod, utils, 2), /UNPATCHED 1\.1\.0 loader: it falls back to prebuilds\/ silently/);
      const cc = packaged({ cc: race922Cc });
      assert.deepEqual(failing(mod, cc), [5], 'a shipped conpty.cc without the handoff fails');
    },
    binary(mod) {
      const wrong = packaged({ record: '0'.repeat(64) });
      assert.deepEqual(failing(mod, wrong), [3], 'A BINARY THAT IS NOT THE RECORDED BUILD FAILS');
      assert.match(whyOf(mod, wrong, 3), /the record says 000000000000/);
      const none = packaged({ marker: false });
      assert.deepEqual(failing(mod, none), [3], 'no record fails');
      assert.match(whyOf(mod, none, 3), /missing or unreadable/);
      const without = packaged({ binary: conptyWithout });
      assert.deepEqual(failing(mod, without), [4], 'A BINARY WITHOUT DuplicateHandle FAILS, even with a matching record');
      assert.match(whyOf(mod, without, 4), /does not import KERNEL32\.DLL!DuplicateHandle: it was not built from the patched source/);
    },
    strays(mod) {
      const shipped = packaged({ extra: [[`${NPP}/prebuilds/win32-x64/conpty.node`, stray]] });
      assert.deepEqual(failing(mod, shipped), [6, 7], 'A PREBUILT WINDOWS BINARY THAT SHIPS FAILS (on disk, and in the archive)');
      assert.match(whyOf(mod, shipped, 6), /1 file\(s\), first: node_modules\/node-pty\/prebuilds\/win32-x64\/conpty\.node/);
      assert.deepEqual(failing(mod, packaged({ diskOnly: [[`${NPP}/prebuilds/win32-arm64/pty.node`, stray]] })), [6], 'A PREBUILT WINDOWS FILE ON DISK FAILS, whatever its name');
      assert.deepEqual(failing(mod, packaged({ diskOnly: [['node_modules/other/conpty.node', stray]] })), [6], 'ANOTHER conpty.node ON DISK FAILS');
    },
    asar(mod) {
      const why = (asar, want, msg) => {
        const dir = packaged({ asar });
        assert.deepEqual(failing(mod, dir), [7], msg);
        assert.match(whyOf(mod, dir, 7), want, msg);
      };
      why((l) => l.map(([p, u]) => (p === `${NPP}/lib/utils.js` ? [p, false] : [p, u])), /1 node-pty file\(s\) are packed INSIDE app\.asar, first: node_modules\/node-pty\/lib\/utils\.js/, 'NODE-PTY PACKED INSIDE THE ARCHIVE FAILS: the app would load that copy');
      why((l) => [...l, ['node_modules/other/build/conpty.node', false]], /lists another conpty\.node: node_modules\/other\/build\/conpty\.node/, 'ANOTHER conpty.node IN THE ARCHIVE FAILS');
      why((l) => [...l, [`${NPP}/prebuilds/win32-x64/pty.node`, true]], /lists a prebuilt Windows binary: node_modules\/node-pty\/prebuilds\/win32-x64\/pty\.node/, 'A PREBUILT WINDOWS BINARY IN THE ARCHIVE FAILS');
      why((l) => l.filter(([p]) => !p.startsWith(`${NPP}/`)), /does not list node_modules\/node-pty\/package\.json/, 'an archive without node-pty fails');
      why(() => null, /app\.asar could not be read/, 'no archive fails');
      why(() => Buffer.from('not an asar at all, only some words'), /could not be read: not an asar archive/, 'a file that is not an archive fails');
      const empty = mod.inspect(tempDir('phnh-empty-'));
      assert.deepEqual(empty.checks.map((c) => [c.name, c.ok]), [['a packaged app', false]], 'a folder with no packaged app fails, by name');
    },
    report(mod) {
      const say = (dir) => { const lines = []; return [mod.report(dir, (l) => lines.push(l)), lines]; };
      const [ok, good] = say(packaged());
      assert.equal(ok, true);
      assert.equal(good[good.length - 1], 'PACKAGED NODE-PTY OK (8 checks)');
      const [bad, lines] = say(packaged({ utils: pristineUtils }));
      assert.equal(bad, false, 'REPORT RETURNS FALSE WHEN A CHECK FAILS');
      assert.equal(lines[lines.length - 1], 'PACKAGED NODE-PTY FAILED');
      assert.ok(lines.includes('FAIL lib/utils.js loads built binaries only: it is the UNPATCHED 1.1.0 loader: it falls back to prebuilds/ silently'), lines.join('\n'));
      assert.equal(lines.filter((l) => l.startsWith('OK   ')).length, 7);
    }
  };
  const checker = require(CHECKER);
  for (const name of Object.keys(P)) test(`PACKAGED: ${name}`, () => P[name](checker));

  test('PACKAGED: the tool runs it as --packaged, exits by the result, and writes nothing', () => {
    const everyFile = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
      .map((e) => path.join(e.parentPath || e.path, e.name)).sort().map((f) => `${f} ${sha(fs.readFileSync(f))}`);
    const cli = (...args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });
    const good = packaged();
    const before = everyFile(good);
    const ok = cli('--packaged', good);
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /PACKAGED NODE-PTY OK \(8 checks\)/);
    assert.deepEqual(everyFile(good), before, 'the check writes nothing');
    const bad = cli('--packaged', packaged({ utils: pristineUtils, extra: [[`${NPP}/prebuilds/win32-x64/conpty.node`, stray]] }));
    assert.equal(bad.status, 1, 'AN UNPATCHED PACKAGED APP EXITS 1');
    assert.match(bad.stdout, /FAIL lib\/utils\.js loads built binaries only/);
    assert.match(bad.stdout, /FAIL no prebuilt Windows binary of node-pty ships/);
    assert.match(bad.stdout, /PACKAGED NODE-PTY FAILED/);
    for (const args of [['--packaged', good, '--check'], ['--root', good, '--packaged', good], ['--packaged'], ['--packaged', good, '--packaged', good]]) {
      const r = cli(...args);
      assert.equal(r.status, 1, `refused: ${args.join(' ')}`);
      assert.match(r.stderr, /--packaged stands alone|unknown argument "--packaged"/, args.join(' '));
      assert.doesNotMatch(r.stdout, /PACKAGED NODE-PTY/, 'a refused call checks nothing');
    }
    assert.deepEqual(everyFile(good), before);
  });

  // The loader itself, in a process of its own: a node-pty with no built binary and a loadable
  // prebuilt one (Guppy's own addon under conpty.node's name; it stands for "a binary that loads").
  const ARCH_DIR = `prebuilds/${process.platform}-${process.arch}`;
  const loaderRun = (utilsText, { built = false } = {}) => {
    const dir = tempDir('phnh-loader-');
    const some = fs.readFileSync(path.join(ROOT, 'resources', 'fs-handle', 'bin', 'guppy_fs_handle.node'));
    for (const [rel, bytes] of [['lib/utils.js', utilsText], [`${ARCH_DIR}/conpty.node`, some], ...(built ? [['build/Release/conpty.node', some]] : [])]) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), bytes);
    }
    const script = "try { const r = require(process.argv[1]).loadNativeModule('conpty'); console.log('LOADED ' + r.dir + ' ' + typeof r.module.procOpen); } catch (e) { console.log('THREW ' + e.message); }";
    const r = spawnSync(process.execPath, ['-e', script, path.join(dir, 'lib', 'utils.js')], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const L = {
    loader(utilsText) {
      const out = loaderRun(utilsText);
      assert.match(out, /^THREW Guppy: node-pty native module conpty\.node did not load from build\/Release or build\/Debug\./, `WITH NO BUILT BINARY THE LOADER THROWS; IT DOES NOT TAKE THE PREBUILT ONE: ${out}`);
      assert.match(out, /never falls back to the unpatched prebuilt binary that node-pty ships/);
      assert.match(out, /run `npm run postinstall`; for an installed Guppy, reinstall it\. Cause: Error: Cannot find module/, 'it says what to do, and why the load failed');
      assert.equal(loaderRun(utilsText, { built: true }), 'LOADED ../build/Release/ function', 'the built binary loads');
    }
  };
  test('LOADER: with no built binary it throws and names the cause; the prebuilt binary is never taken', () => {
    L.loader(builtUtils);
    // Control: node-pty's own loader takes the prebuilt binary without a word. This is what is removed.
    assert.equal(loaderRun(pristineUtils), `LOADED ../${ARCH_DIR}/ function`, 'control: pristine 1.1.0 falls back');
  });

  test('WIRING: the build leaves the prebuilt Windows binaries out, and a cut runs the packaged check', () => {
    const yml = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
    const pats = yml.slice(yml.indexOf('\nfiles:'), yml.indexOf('\nextraResources:')).split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('- "!')).map((l) => l.slice(4, -1));
    const m = require(require.resolve('minimatch', { paths: [path.dirname(require.resolve('app-builder-lib/package.json'))] }));
    const minimatch = m.minimatch || m.default || m;
    const gone = (f) => pats.some((p) => minimatch(f, p, { dot: true }));
    for (const f of ['prebuilds/win32-x64/conpty.node', 'prebuilds/win32-x64/conpty/OpenConsole.exe', 'prebuilds/win32-arm64/pty.node', 'prebuilds/win32-x64/winpty-agent.exe']) {
      assert.ok(gone(`node_modules/node-pty/${f}`), `electron-builder.yml SHIPS A PREBUILT WINDOWS BINARY: ${f}`);
    }
    for (const f of ['build/Release/conpty.node', 'build/Release/conpty/OpenConsole.exe', 'build/Release/conpty/conpty.dll', 'build/Release/winpty-agent.exe', 'lib/utils.js', 'lib/windowsPtyAgent.js', 'package.json', pins.MARKER_FILE, 'prebuilds/darwin-arm64/pty.node']) {
      assert.ok(!gone(`node_modules/node-pty/${f}`), `electron-builder.yml DROPS A FILE THE APP NEEDS: ${f}`);
    }
    const cut = fs.readFileSync(path.join(ROOT, 'scripts', 'cut-cmd-natives.cjs'), 'utf8');
    const check = cut.slice(cut.indexOf('function check() {'), cut.indexOf('function gate() {'));
    const at = check.indexOf("path.join('tools', 'patch-node-pty-root-handle.cjs'),\n    '--packaged',\n    path.join('dist', 'win-unpacked')".replace(/\n/g, check.includes('\r\n') ? '\r\n' : '\n'));
    assert.ok(at > 0, 'A CUT RUNS --packaged ON dist/win-unpacked');
    assert.ok(at < check.indexOf("path.join('scripts', 'check-cut-natives.cjs')"), 'before the natives check');
    assert.equal((cut.match(/\bcheck\(\);/g) || []).length, 2, 'on both build paths (--dist-only and the full cut)');
  });

  const mutated = (text, edits, tag) => {
    for (const [from, to] of edits) {
      const hits = text.split(from).length - 1;
      assert.equal(hits, 1, `mutant ${tag}: edit target must match EXACTLY ONCE, matched ${hits}: ${JSON.stringify(from.slice(0, 80))}`);
      text = text.replace(from, () => to);
    }
    return text;
  };
  /** A mutant of the checker, loaded from a folder of its own; its pins are the real ones. */
  const checkerFrom = (text) => {
    const dir = tempDir('phnh-chk-');
    fs.writeFileSync(path.join(dir, 'node-pty-race-fix-pins.cjs'), `module.exports = require(${JSON.stringify(path.join(ROOT, 'tools', 'node-pty-race-fix-pins.cjs'))});\n`);
    fs.writeFileSync(path.join(dir, 'check-packaged-node-pty.cjs'), text);
    return require(path.join(dir, 'check-packaged-node-pty.cjs'));
  };
  const PACKAGED_MUTANTS = [
    { name: 'P1 any loader passes', edits: [['utilsSha === pins.UTILS_JS_BUILT_ONLY_SHA256,', 'true,']], run: P.files, dies: /AN UNPATCHED LOADER FAILS THE PACKAGED CHECK/ },
    { name: 'P2 prebuilt files on disk are not looked for', edits: [["add('no prebuilt Windows binary of node-pty ships', strays.length === 0,", "add('no prebuilt Windows binary of node-pty ships', true,"]], run: P.strays, dies: /A PREBUILT WINDOWS BINARY THAT SHIPS FAILS/ },
    { name: 'P3 node-pty inside the archive passes', edits: [[': packed.length ? ', ': false ? ']], run: P.asar, dies: /NODE-PTY PACKED INSIDE THE ARCHIVE FAILS/ },
    { name: 'P4 any windowsPtyAgent.js passes', edits: [['agentSha === pins.AGENT_JS_HANDOFF_SHA256,', 'true,']], run: P.files, dies: /AN UNPATCHED windowsPtyAgent\.js FAILS THE PACKAGED CHECK/ },
    { name: 'P5 the imports are not read', edits: [['binarySha !== null && lacks.length === 0,', 'binarySha !== null,']], run: P.binary, dies: /A BINARY WITHOUT DuplicateHandle FAILS/ },
    { name: 'P6 the record need not match the binary', edits: [[': recorded !== binarySha ? ', ': false ? ']], run: P.binary, dies: /A BINARY THAT IS NOT THE RECORDED BUILD FAILS/ },
    { name: 'P7 another conpty.node in the archive passes', edits: [[': others.length ? ', ': false ? ']], run: P.asar, dies: /ANOTHER conpty\.node IN THE ARCHIVE FAILS/ },
    { name: 'P8 the report always says OK', edits: [['const ok = checks.every((c) => c.ok);', 'const ok = true;']], run: P.report, dies: /REPORT RETURNS FALSE WHEN A CHECK FAILS/ },
    { name: 'P9 only prebuilds/ is searched on disk', edits: [[' || (p.endsWith(\'/conpty.node\') && p !== `${NP}/${BUILT}`));', ');']], run: P.strays, dies: /ANOTHER conpty\.node ON DISK FAILS/ },
    { name: 'P10 a prebuilt binary in the archive passes', edits: [[': prebuilt.length ? ', ': false ? ']], run: P.asar, dies: /A PREBUILT WINDOWS BINARY IN THE ARCHIVE FAILS/ },
    { name: 'P11 only conpty.node counts as prebuilt on disk', edits: [['WIN_PREBUILT.test(`/${p}`) || (p.endsWith', '(p.endsWith']], run: P.strays, dies: /A PREBUILT WINDOWS FILE ON DISK FAILS/ }
  ];
  test('MUTANT CENSUS (packaged check, loader): every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
    const source = fs.readFileSync(CHECKER, 'utf8');
    const dying = (name, fn, dies) => assert.throws(fn, (e) => {
      assert.match(String(e && e.message), dies, `${name}: died for the wrong reason: ${e && e.message}`);
      return true;
    }, `${name}: MUST DIE`);
    for (const mu of PACKAGED_MUTANTS) {
      await t.test(`mutant: ${mu.name}`, () => { const mod = checkerFrom(mutated(source, mu.edits, mu.name)); dying(mu.name, () => mu.run(mod), mu.dies); });
    }
    await t.test('mutant: L1 the loader keeps the prebuilt folder on Windows', () => {
      const text = mutated(builtUtils, [["        dirs = ['build/Release', 'build/Debug'];\n", '        dirs = dirs;\n']], 'L1');
      dying('L1', () => L.loader(text), /WITH NO BUILT BINARY THE LOADER THROWS; IT DOES NOT TAKE THE PREBUILT ONE/);
    });
    await t.test('mutant: L2 the loader throws node-pty\'s own words', () => {
      const text = mutated(builtUtils, [['    if (guppyBuiltOnly) {\n        throw new Error("Guppy: ', '    if (false) {\n        throw new Error("Guppy: ']], 'L2');
      dying('L2', () => L.loader(text), /WITH NO BUILT BINARY THE LOADER THROWS; IT DOES NOT TAKE THE PREBUILT ONE/);
    });
  });

  // ---- real terminals ----------------------------------------------------------------------
  const nodePty = require('node-pty');
  const addon = (() => { const mod = { exports: {} }; process.dlopen(mod, path.join(ROOT, 'resources', 'fs-handle', 'bin', 'guppy_fs_handle.node')); return mod.exports; })();
  const DIR = tempDir('phnh-');
  fs.writeFileSync(path.join(DIR, 'idle.js'), "process.stdout.write('phnh-root-up'); setInterval(() => {}, 1000);\n");
  fs.writeFileSync(path.join(DIR, 'gone.js'), '\n');
  // TEST-TEMP-LEAK-UNDER-LOAD: every real terminal of this file is spawned here, and its root
  // (cwd = DIR) is held by handle at once, from node-pty's handoff: a hold of this file's own, so a
  // root that dies before any other hold (THE GAP) is still held and its pid stays its own. DIR is
  // removed only once every root has EXITED (a close or an exit report does not wait for the
  // process), with no swallow: a root that will not exit, or a DIR that will not go, fails here.
  const { awaitHeldExit } = require('./tools/await-exit.cjs');
  const idHold = loadTs(IDF);
  const holds = [];
  const ptySpawn = nodePty.spawn;
  const realPtySpawn = function spawn(...a) {
    const proc = ptySpawn.apply(this, a);
    const hold = idHold.holdRoot(proc.pid, 'win32', idHold.rootHandoff(proc));
    assert.ok(hold, `the root is held by handle from node-pty's handoff. ${HINT}`);
    holds.push({ pid: proc.pid, hold });
    return proc;
  };
  test.after(async () => {
    for (const { pid, hold } of holds) { if (hold.alive()) { try { process.kill(pid); } catch { /* gone */ } } }
    try { await awaitHeldExit(holds); } finally { for (const h of holds) h.hold.release(); }
    fs.rmSync(DIR, { recursive: true, force: true });
  });
  const { armEarlyKill } = loadTs(PTYF);
  const pause = new Int32Array(new SharedArrayBuffer(4));

  /** Block this thread until the root under `pid` has exited. No JS runs meanwhile. The probe is
   *  the addon's open by pid, which refuses an exited process by saying so. */
  function blockUntilExited(pid) {
    const end = Date.now() + CAP_MS;
    for (;;) {
      let h;
      try { h = addon.procOpen(pid); } catch (e) {
        assert.match(String(e.message), /already exited/, `the root is gone for a reason other than its exit: ${e.message}`);
        return;
      }
      addon.procClose(h);
      assert.ok(Date.now() < end, 'TIMED OUT waiting for the root to exit');
      Atomics.wait(pause, 0, 0, 10);
    }
  }
  /** A real terminal whose root exits at once; returns with the root dead and nothing told to JS. */
  function spawnDeadRoot() {
    const proc = realPtySpawn(process.execPath, [path.join(DIR, 'gone.js')], { cols: 80, rows: 24, cwd: DIR, useConpty: true });
    // A root that printed nothing never makes its terminal "ready", and node-pty queues kill()
    // until then: the product's own arm makes dispose() below close it (PTY-EARLY-KILL-LEAK).
    assert.ok(armEarlyKill(proc, 'win32'), 'the terminal has the internals armEarlyKill needs');
    blockUntilExited(proc.pid);
    return proc;
  }
  const exitOf = (proc) => new Promise((resolve) => proc.onExit(resolve));
  /** node-pty leaves an exited terminal's input pipe and conout worker open until kill(): close
   *  them, or this file never ends. Only for a terminal whose exit has been reported. */
  const dispose = (proc) => { try { proc.kill(); } catch { /* closed */ } };
  const throwsLike = (fn, re, msg) => assert.throws(fn, (e) => { assert.match(String(e && e.message), re, msg); return true; }, msg);

  test('ADDON: a root that died before the hold is adopted by its own handle; by pid it is refused', async () => {
    const proc = spawnDeadRoot();
    const gone = exitOf(proc);
    const handoff = proc._agent._rootHandle;
    assert.equal(typeof handoff, 'object', `node-pty returned no root handle. ${HINT}`);
    throwsLike(() => addon.procOpen(proc.pid), /already exited/, 'THE GAP IS REAL: opened by pid, a root that died first is refused');
    const hold = addon.procAdopt(handoff, proc.pid);
    assert.equal(addon.procAlive(hold), false, 'the adopted hold says the root is dead');
    const second = addon.procAdopt(handoff, proc.pid);
    addon.procClose(second);
    assert.equal(addon.procAlive(hold), false, 'A HOLD IS ITS OWN HANDLE: closing another hold of the same handoff leaves it usable');
    addon.procClose(hold);
    addon.procClose(hold);
    throwsLike(() => addon.procAlive(hold), /closed/, 'a closed hold is closed');
    await within(gone, 'the exit of the dead root');
    const late = addon.procAdopt(handoff, proc.pid);
    assert.equal(addon.procAlive(late), false, "NODE-PTY'S COPY IS STILL ITS OWN after our holds were closed: adopted again after the exit");
    addon.procClose(late);
    // node-pty has reported the exit, so its own handle is closed, and every hold of ours is closed:
    // only the handed-over handle is left, and the pid is still the dead root's, not free.
    throwsLike(() => addon.procOpen(proc.pid), /already exited/, "THE PID STAYS THE ROOT'S WHILE THE TERMINAL KEEPS THE HANDOFF: it cannot be reused under node-pty's own kill()");
    dispose(proc);
  });

  test('ADDON: only the handle node-pty handed over is adopted, and only for its own pid', async () => {
    const proc = realPtySpawn(process.execPath, [path.join(DIR, 'idle.js')], { cols: 80, rows: 24, cwd: DIR, useConpty: true });
    const gone = exitOf(proc);
    try {
      let seen = '';
      await within(new Promise((resolve) => { const sub = proc.onData((d) => { seen += d; if (seen.includes('phnh-root-up')) { sub.dispose(); resolve(); } }); }), "the root's first output");
      const handoff = proc._agent._rootHandle;
      const hold = addon.procAdopt(handoff, proc.pid);
      assert.equal(addon.procAlive(hold), true, 'a running root reads alive');
      throwsLike(() => addon.procAdopt(handoff, process.pid), /not the process with that pid/, 'THE HANDLE ANSWERS FOR THE PID: another pid is refused');
      throwsLike(() => addon.procAdopt(handoff, 0), /positive integer/, 'pid 0');
      throwsLike(() => addon.procAdopt(handoff), /handed over/, 'no pid');
      for (const bad of [undefined, null, 7, 'h', {}, proc]) throwsLike(() => addon.procAdopt(bad, proc.pid), /handed over/, `not a handoff: ${typeof bad}`);
      throwsLike(() => addon.procAdopt(hold, proc.pid), /handed over/, 'A HOLD IS NOT A HANDOFF: the type tag tells a proc_hold pointer from a raw handle');
      throwsLike(() => addon.procAlive(handoff), /a hold from procOpen or procAdopt required/, 'A HANDOFF IS NOT A HOLD');
      throwsLike(() => addon.procClose(handoff), /a hold from procOpen or procAdopt required/, 'and cannot be closed as one');
      const byPid = addon.procOpen(proc.pid);
      assert.equal(addon.procAlive(byPid), true, 'the open by pid still works for a live child');
      proc.kill();
      await within(gone, 'the exit after the close');
      // node-pty reports 'exit' when the output pipe closes, and that follows the console's end,
      // not the root's. Measured 2026-11-17 with a root that is slow to finish exiting: kill()
      // returns, the console closed, while the root still reads alive, and the report comes about
      // 55 ms later. Under load the root's last steps can outlast that (seen once, full suite).
      // The root's own end is what the hold follows: wait for the kernel to say so.
      await within(new Promise((resolve) => { const t = setInterval(() => { if (!addon.procAlive(hold)) { clearInterval(t); resolve(); } }, 5); t.unref(); }), 'the root to end after kill() (THE HOLD FOLLOWS THE ROOT)');
      assert.equal(addon.procAlive(hold), false, 'THE HOLD FOLLOWS THE ROOT: dead once it exited');
      assert.equal(addon.procAlive(byPid), false);
      addon.procClose(hold);
      addon.procClose(byPid);
    } finally { try { proc.kill(); } catch { /* closed */ } }
  });

  // Every taskkill is recorded and never run.
  const cp = require('node:child_process');
  const { EventEmitter } = require('node:events');
  const realSpawn = cp.spawn;
  const sweeps = [];
  cp.spawn = function spawn(cmd, args, ...rest) {
    if (cmd !== 'taskkill') return realSpawn.call(this, cmd, args, ...rest);
    sweeps.push([...args]);
    const e = new EventEmitter();
    process.nextTick(() => e.emit('close', 0));
    return e;
  };

  const G = {
    /** holdRoot with the REAL addon in the gap. */
    identity: async (id) => {
      const proc = spawnDeadRoot();
      const gone = exitOf(proc);
      const hold = id.holdRoot(proc.pid, 'win32', id.rootHandoff(proc));
      const byPid = id.holdRoot(proc.pid, 'win32');
      try {
        assert.equal(byPid, null, 'the gap is real: by pid, holdRoot has nothing to hold');
        assert.ok(hold, 'A ROOT THAT DIED BEFORE THE HOLD IS HELD BY ITS OWN HANDLE');
        assert.equal(hold.alive(), false, 'and the hold says it is dead, so no sweep names its pid');
      } finally {
        if (hold) hold.release();
        await within(gone, 'the exit of the dead root');
        dispose(proc);
      }
    },
    /** The product's spawn, with the root dead before pty.ts reaches its hold. */
    spawn: async (Pty) => {
      const m = new Pty();
      const owner = { isDestroyed: () => false, send: () => {} };
      let letReport = () => {};
      let gone = null;
      let made = 0;
      let raw = null;
      let closedByProduct = false;
      nodePty.spawn = function spawn(...a) {
        made += 1;
        const proc = realPtySpawn.apply(this, a);
        raw = proc;
        gone = exitOf(proc);
        // Keep node-pty's exit report from the product until the assertions are done.
        const agent = proc._agent;
        const report = agent._$onProcessExit;
        let pending = null;
        let holding = true;
        agent._$onProcessExit = function onProcessExit(code) {
          if (holding) { pending = () => report.call(this, code); return undefined; }
          return report.call(this, code);
        };
        letReport = () => { holding = false; const p = pending; pending = null; if (p) p(); };
        blockUntilExited(proc.pid);
        return proc;
      };
      try {
        const r = await m.spawn({ id: 'phnh-gap', cwd: DIR, command: process.execPath, args: [path.join(DIR, 'gone.js')], cols: 80, rows: 24, env: {} }, owner);
        assert.ok(r.ok, `spawn: ${r.error}`);
        assert.equal(made, 1, "the product spawned through node-pty's spawn (the fixture saw it)");
        const session = m.sessions.get('phnh-gap');
        assert.ok(session, 'the session is there: its exit has not been reported');
        assert.ok(session.hold, 'THE GAP: a terminal whose root died before the hold still holds it, by the handle node-pty handed over');
        assert.equal(session.hold.alive(), false, 'THE GAP: and knows it is dead');
        assert.ok(m.kill('phnh-gap').ok, 'kill()');
        closedByProduct = true;
        assert.deepEqual(sweeps.filter((s) => s.includes(String(session.proc.pid))), [], 'THE GAP: kill() names no pid of a root that is dead');
      } finally {
        nodePty.spawn = realPtySpawn;
        letReport();
        if (gone) await within(gone, 'the exit of the dead root');
        if (raw && !closedByProduct) dispose(raw);
      }
    },
    /** The product's close of a live terminal, with node-pty's by-pid sweep in the test's hands:
     *  no helper is forked, the list arrives when the test says, and "kill each entry" is recorded. */
    sweep: async (Pty) => {
      const m = new Pty();
      const owner = { isDestroyed: () => false, send: () => {} };
      const order = [];
      let arrive = () => {};
      let raw = null;
      let gone = null;
      let up = null;
      let closedByProduct = false;
      nodePty.spawn = function spawn(...a) {
        const proc = realPtySpawn.apply(this, a);
        raw = proc;
        gone = exitOf(proc);
        let seen = '';
        up = new Promise((resolve) => { const sub = proc.onData((d) => { seen += d; if (seen.includes('phnh-root-up')) { sub.dispose(); resolve(); } }); });
        proc._agent._getConsoleProcessList = () => new Promise((resolve) => {
          order.push('asked');
          arrive = () => resolve({ forEach: () => { order.push('swept'); } });
        });
        return proc;
      };
      const turns = async () => { for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve)); };
      try {
        const r = await m.spawn({ id: 'phnh-sweep', cwd: DIR, command: process.execPath, args: [path.join(DIR, 'idle.js')], cols: 80, rows: 24, env: {} }, owner);
        assert.ok(r.ok, `spawn: ${r.error}`);
        const session = m.sessions.get('phnh-sweep');
        assert.ok(session && session.hold, 'the terminal holds its root');
        const release = session.hold.release;
        session.hold.release = () => { order.push('released'); return release(); };
        await within(up, "the root's first output");
        assert.ok(m.kill('phnh-sweep').ok, 'kill()');
        closedByProduct = true;
        // The close ends the root. Its exit is reported with the sweep still out.
        await within(gone, 'the exit after the close');
        await turns();
        assert.deepEqual(order, ['asked'], "THE HOLD OUTLIVES NODE-PTY'S SWEEP: nothing releases it while the by-pid list is still out, not the kill's own end and not the root's exit");
        assert.equal(session.hold.alive(), false, 'the root is dead, and its pid is still reserved by the hold');
        arrive();
        await turns();
        assert.deepEqual(order, ['asked', 'swept', 'released'], 'THE HOLD IS RELEASED WHEN THE SWEEP HAS RUN: after the kills of the list, once');
      } finally {
        nodePty.spawn = realPtySpawn;
        arrive();
        if (gone && closedByProduct) await within(gone, 'the exit of the closed terminal');
        if (raw && !closedByProduct) dispose(raw);
      }
    }
  };

  test('THE GAP, holdRoot: the root died before the hold and is held by its own handle', () => G.identity(freshId()));
  test('THE GAP, pty.ts: spawn hands node-pty\'s handle to the hold', () => G.spawn(loadTs(PTYF).PtyManager));
  test('pty.ts takes the hold in the spawn\'s own turn, from the handoff', () => {
    const src = readSource(PTYF);
    assert.match(src, /armEarlyKill\(proc\);\n(?: *\/\/[^\n]*\n)* *const hold = holdRoot\(proc\.pid, process\.platform, rootHandoff\(proc\)\);/, 'nothing but comments between the spawn\'s early-kill arm and the hold');
  });

  MUTANTS.push(
    { file: IDF, name: 'A1 holdRoot opens by pid although it was handed the handle (the code before this card)', edits: [['handle = addon.procAdopt(handoff, pid); adopted = true;', 'handle = addon.procOpen(pid); adopted = true;']],
      run: (mod) => G.identity(mod), dies: /A ROOT THAT DIED BEFORE THE HOLD IS HELD BY ITS OWN HANDLE/ },
    { file: PTYF, name: 'A6 spawn does not pass the handoff (the code before this card)', edits: [['holdRoot(proc.pid, process.platform, rootHandoff(proc))', 'holdRoot(proc.pid, process.platform)']],
      run: (mod) => G.spawn(mod.PtyManager), dies: /THE GAP: a terminal whose root died before the hold still holds it/ },
    { file: PTYF, name: "S1 node-pty's sweep is not a user of the hold (the code before this follow-up)", edits: [['    if (!pending) return;\n', '    return;\n']],
      run: (mod) => G.sweep(mod.PtyManager), dies: /THE HOLD OUTLIVES NODE-PTY'S SWEEP/ },
    { file: PTYF, name: 'S2 the sweep is counted, and dropped without waiting for it', edits: [['    pending.then(done, done);\n', '    done();\n']],
      run: (mod) => G.sweep(mod.PtyManager), dies: /THE HOLD OUTLIVES NODE-PTY'S SWEEP/ },
    { file: PTYF, name: "S3 the root's exit releases the hold whoever still uses it", edits: [['        if (!session.holdUsers) session.hold?.release();\n', '        session.hold?.release();\n']],
      run: (mod) => G.sweep(mod.PtyManager), dies: /THE HOLD OUTLIVES NODE-PTY'S SWEEP/ },
    { file: PTYF, name: 'S4 the hold is released when the list arrives, before the kills of it', edits: [['    try { s.proc.kill(); } catch { /* already gone */ }\n    // node-pty', '    const agent = (s.proc as any)._agent; const early = agent._getConsoleProcessList;\n    agent._getConsoleProcessList = () => { const p = early.call(agent); p.then(() => this.dropHold(s)); return p; };\n    try { s.proc.kill(); } catch { /* already gone */ }\n    // node-pty']],
      run: (mod) => G.sweep(mod.PtyManager), dies: /THE HOLD IS RELEASED WHEN THE SWEEP HAS RUN/ }
  );
  test("THE SWEEP, pty.ts: the hold is kept until node-pty's by-pid kill sweep has run", () => G.sweep(loadTs(PTYF).PtyManager));
}

test('MUTANT CENSUS: every mutant applies once and dies at the assertion that names its guarantee', async (t) => {
  for (const mu of MUTANTS) {
    await t.test(`mutant: ${mu.name}`, async () => {
      const mod = loadTs.fromText(mu.file, mutateText(mu.file, mu.edits, mu.name));
      await assert.rejects(async () => mu.run(mod), (e) => {
        assert.match(String(e && e.message), mu.dies, `${mu.name}: died for the wrong reason: ${e && e.message}`);
        return true;
      }, `${mu.name}: MUST DIE`);
    });
  }
});
