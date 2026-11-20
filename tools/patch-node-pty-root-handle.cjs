#!/usr/bin/env node
'use strict';

// PTY-HOLD-NODEPTY-HANDOFF: node-pty hands Guppy a handle to the terminal's root process.
//
// Why. Every tree kill names the root by pid, and a pid is only Guppy's while a handle to the
// root is open. PTY-KILL-PID-IDENTITY opens one (procOpen(pid), resources/fs-handle) in the
// spawn's own turn, but it opens it BY PID, after node-pty's CreateProcess. node-pty's own
// handle is closed by its watcher thread as soon as the root exits, and that thread starts
// inside PtyConnect: a root that dies at once can have its pid free, and reused, before
// procOpen runs. Only the handle CreateProcess returned is tied to the root with no gap.
//
// What. Two edits to node-pty 1.1.0, both applied before electron-rebuild:
//   src/win/conpty.cc        PtyConnect duplicates piClient.hProcess BEFORE it starts the watcher
//                            thread, and returns the duplicate as `rootHandle`: a type-tagged
//                            N-API external whose finalizer closes it. The duplicate carries
//                            SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION only and is not
//                            inheritable.
//   lib/windowsPtyAgent.js   keeps it as `_rootHandle` next to `_innerPid`.
// Guppy's addon (procAdopt) checks the tag and the pid and duplicates it again for its own hold,
// so neither side closes a handle the other owns.
//
// Strict like patch-node-pty-race-fix.cjs, by SHA-256 (tools/node-pty-race-fix-pins.cjs):
//   conpty.cc           #922-patched -> patch -> must equal CONPTY_CC_BUILT_SHA256
//                       already BUILT -> no-op;  anything else -> fail
//   windowsPtyAgent.js  pristine -> patch -> must equal AGENT_JS_HANDOFF_SHA256
//                       already patched -> no-op;  anything else -> fail
// So it runs AFTER patch-node-pty-race-fix.cjs and BEFORE electron-rebuild.
//
// NODEPTY-PACKAGED-PROOF adds a third edit and a mode.
//   lib/utils.js             node-pty's loader tries build/Release, build/Debug and then
//                            prebuilds/<platform>-<arch>, and swallows each failure. On Windows the
//                            prebuilt conpty.node is plain 1.1.0: no #922 lock, no rootHandle. A
//                            build that failed to load was replaced by it without a word. Patched,
//                            the loader never looks in prebuilds/ on Windows and its error says so.
//                            pristine -> patch -> must equal UTILS_JS_BUILT_ONLY_SHA256.
//   --packaged <dir>         change nothing; prove the patch on a PACKAGED app (dist/win-unpacked,
//                            or its resources folder): the unpacked node-pty beside app.asar is the
//                            patched one, its conpty.node is the recorded build and duplicates the
//                            root handle, no prebuilt Windows binary ships, and app.asar holds no
//                            second copy. Prints one line per check, then PACKAGED NODE-PTY OK
//                            (exit 0) or PACKAGED NODE-PTY FAILED (exit 1). Runs on any platform.
//
// PTY-EARLY-KILL-EPIPE-108 adds a fourth edit.
//   lib/worker/conoutSocketWorker.js   the output worker pipes the console's output to the data
//                            socket with no error listener on either end. A data socket destroyed
//                            before the worker's write gave EPIPE, uncaught in the worker, and the
//                            main thread threw it outside any caller. Patched, both ends have a
//                            listener: EPIPE or ECONNRESET on a destroyed socket is a quiet end,
//                            anything else is thrown as before. The edits are in the pins module.
//                            pristine -> patch -> must equal WORKER_JS_QUIET_SHA256.
//
// PTY-CONHOST-LEAK-NATIVE adds a second stage to conpty.cc, on top of the handoff.
//   src/win/conpty.cc        a terminal's console host (conhost.exe or OpenConsole.exe) lives until
//                            its pseudoconsole is closed. node-pty closed it only in kill, and only
//                            while the terminal's record was in the native list; the exit thread
//                            erases the record without closing, so every terminal whose root had
//                            ended kept its host until the app quit. Patched, the exit thread
//                            closes the pseudoconsole it drops (outside the lock, after the exit
//                            is reported), kill and the thread close it exactly once between
//                            them, and the module exports guppyClosesPseudoConsoleOnExit so that
//                            the built binary can be told from one without the close. The edits
//                            are in the pins module (CONPTY_CC_CLOSE_EDITS).
//                            #922-patched -> handoff + close -> must equal CONPTY_CC_BUILT_SHA256
//                            handoff form (a tree patched before this stage existed) -> close ->
//                            the same.
//
//   --check          change nothing; exit 1 unless all four files are in their patched form
//   --root <dir>     another node-pty tree (the self-test only)
// Any other argument is refused: this tool rewrites files, so it never guesses.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const pins = require('./node-pty-race-fix-pins.cjs');

const TAG = '[patch-node-pty-root-handle]';
const fail = (msg) => { console.error(`${TAG} FAILED: ${msg}`); process.exit(1); };

let check = false;
let packaged = null;
let rootGiven = false;
let root = path.join(__dirname, '..', 'node_modules', 'node-pty');
const argv = process.argv.slice(2);
const USAGE = '(usage: [--check] [--root <node-pty dir>] | --packaged <win-unpacked or resources dir>)';
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--check') check = true;
  else if (argv[i] === '--root' && typeof argv[i + 1] === 'string' && argv[i + 1] !== '') { root = path.resolve(argv[i + 1]); rootGiven = true; i += 1; }
  else if (argv[i] === '--packaged' && packaged === null && typeof argv[i + 1] === 'string' && argv[i + 1] !== '') { packaged = path.resolve(argv[i + 1]); i += 1; }
  else fail(`unknown argument ${JSON.stringify(argv[i])} ${USAGE}`);
}
if (packaged !== null && (check || rootGiven)) fail(`--packaged stands alone ${USAGE}`);
if (packaged !== null) process.exit(require('./check-packaged-node-pty.cjs').report(packaged) ? 0 : 1);
if (process.platform !== 'win32') process.exit(0);

const pkgPath = path.join(root, 'package.json');
if (!fs.existsSync(pkgPath)) fail(`node-pty package.json missing at ${pkgPath}`);
const version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
if (version !== pins.NODE_PTY_VERSION) fail(`node-pty ${pins.NODE_PTY_VERSION} required, got ${version}; re-derive the root-handle patch before changing the dependency`);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

const CONPTY_EDITS = [
  ['duplicate before the watcher thread',
    '  SetupExitCallback(env, exitCallback, handle);\n' +
    '\n' +
    '  // Return\n' +
    '  auto marshal = Napi::Object::New(env);\n' +
    '  marshal.Set("pid", Napi::Number::New(env, piClient.dwProcessId));\n' +
    '  return marshal;\n',
    '  // GUPPY PTY-HOLD-NODEPTY-HANDOFF (tools/patch-node-pty-root-handle.cjs): hand the caller a\n' +
    '  // handle to the root that comes from CreateProcess itself. It is duplicated here, BEFORE the\n' +
    '  // watcher thread exists: that thread closes hShell as soon as the root exits, and from then\n' +
    '  // on the pid can belong to another process. While this duplicate is open it cannot. The\n' +
    '  // external owns the duplicate (its finalizer closes it); a caller that wants to keep the\n' +
    '  // process past the external duplicates it again. No handle: no rootHandle property.\n' +
    '  Napi::Value rootHandle = env.Undefined();\n' +
    '  HANDLE hRootHandoff = nullptr;\n' +
    '  if (DuplicateHandle(GetCurrentProcess(), piClient.hProcess, GetCurrentProcess(), &hRootHandoff,\n' +
    '                      SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, 0) && hRootHandoff) {\n' +
    '    static const napi_type_tag guppyRootHandoffTag = { 0x4755505059524f4fULL, 0x5448414e444f4646ULL };\n' +
    '    napi_value external = nullptr;\n' +
    '    if (napi_create_external(env, hRootHandoff, [](napi_env, void* data, void*) {\n' +
    '          CloseHandle(static_cast<HANDLE>(data));\n' +
    '        }, nullptr, &external) != napi_ok) {\n' +
    '      CloseHandle(hRootHandoff);\n' +
    '    } else if (napi_type_tag_object(env, external, &guppyRootHandoffTag) == napi_ok) {\n' +
    '      rootHandle = Napi::Value(env, external);\n' +
    '    }\n' +
    '  }\n' +
    '\n' +
    '  SetupExitCallback(env, exitCallback, handle);\n' +
    '\n' +
    '  // Return\n' +
    '  auto marshal = Napi::Object::New(env);\n' +
    '  marshal.Set("pid", Napi::Number::New(env, piClient.dwProcessId));\n' +
    '  if (!rootHandle.IsUndefined()) {\n' +
    '    marshal.Set("rootHandle", rootHandle);\n' +
    '  }\n' +
    '  return marshal;\n']
];
const AGENT_EDITS = [
  // PTY-CONHOST-LEAK-NATIVE: the native exit report has a second argument (close not started).
  ['the exit report carries whether the close was started',
    'function (c) { return _this._$onProcessExit(c); });\n',
    'function (c, guppyCloseUnstarted) { return _this._$onProcessExit(c, guppyCloseUnstarted); });\n'],
  ['the exit handler takes it',
    '    WindowsPtyAgent.prototype._$onProcessExit = function (exitCode) {\n' +
    '        var _this = this;\n' +
    '        this._exitCode = exitCode;\n',
    '    WindowsPtyAgent.prototype._$onProcessExit = function (exitCode, guppyCloseUnstarted) {\n' +
    '        var _this = this;\n' +
    '        this._exitCode = exitCode;\n' +
    '        // GUPPY PTY-CONHOST-LEAK-NATIVE (tools/patch-node-pty-root-handle.cjs): the output worker\n' +
    '        // ends by itself when the console host closes its end, and the host closes it when the\n' +
    '        // pseudoconsole is closed. The native side says here when that close could not be\n' +
    '        // started: the host then stays, and the worker would wait for it for ever (one thread\n' +
    '        // and two pipes more, and a loop that never empties). So the worker is ended here,\n' +
    '        // after its flush time, as node-pty ends it on a kill.\n' +
    '        if (guppyCloseUnstarted === true) {\n' +
    '            this._conoutSocketWorker.dispose();\n' +
    '        }\n'],
  ['keep the handle next to the pid',
    '            this._innerPid = connect.pid;\n',
    '            this._innerPid = connect.pid;\n' +
    '            // GUPPY PTY-HOLD-NODEPTY-HANDOFF (tools/patch-node-pty-root-handle.cjs): the root\'s own handle.\n' +
    '            this._rootHandle = connect.rootHandle;\n'],
  // PTY-CONHOST-LEAK-NATIVE: on the bundled console host (useConptyDll) node-pty reports the exit
  // only when the host closes the output pipe. A paused reader would wait for ever.
  ['the bundled host: a process gone with its output paused ends the output socket',
    '            this._outSocket.on(\'data\', function () { return _this._flushDataAndCleanUp(); });\n' +
    '        }\n',
    '            this._outSocket.on(\'data\', function () { return _this._flushDataAndCleanUp(); });\n' +
    '        }\n' +
    '        else {\n' +
    '            // GUPPY PTY-CONHOST-LEAK-NATIVE (tools/patch-node-pty-root-handle.cjs): on the bundled\n' +
    '            // console host the exit is reported when the host closes the output pipe, and the\n' +
    '            // host closes it only once its output has been read. A terminal whose reader has\n' +
    '            // paused would never report its exit, and its host would stay. So with the process\n' +
    '            // gone and the output paused (now, or later), the output socket ends here: the exit\n' +
    '            // is reported, and the output worker reads the rest and throws it away.\n' +
    '            // THIS ASSUMES NOBODY PAUSES THE OUTPUT FOR FLOW CONTROL: once the process is gone,\n' +
    '            // any pause, a short one included, ends the socket, and output not yet taken is\n' +
    '            // lost. Guppy never pauses a terminal\'s output (no .pause() in src/main), and it\n' +
    '            // does not use the bundled host today (pty.ts never sets useConptyDll).\n' +
    '            var guppyUnread = function () { _this._outSocket.destroy(); };\n' +
    '            if (this._outSocket.readableFlowing === false) {\n' +
    '                guppyUnread();\n' +
    '            }\n' +
    '            else {\n' +
    '                this._outSocket.once(\'pause\', guppyUnread);\n' +
    '            }\n' +
    '        }\n']
];
// NODEPTY-PACKAGED-PROOF: on Windows the loader takes the binaries built in this tree, or throws.
const UTILS_EDITS = [
  ['never look in prebuilds/ on Windows',
    '    var dirs = [\'build/Release\', \'build/Debug\', "prebuilds/" + process.platform + "-" + process.arch];\n',
    '    var dirs = [\'build/Release\', \'build/Debug\', "prebuilds/" + process.platform + "-" + process.arch];\n' +
    '    // GUPPY NODEPTY-PACKAGED-PROOF (tools/patch-node-pty-root-handle.cjs): on Windows only the\n' +
    '    // binaries built in this tree, from the source Guppy patches, may load. The prebuilt ones are\n' +
    '    // plain node-pty (no #922 lock, no root handle), and this loop swallows every failure: a\n' +
    '    // build that did not load would be replaced by them without a word.\n' +
    '    var guppyBuiltOnly = process.platform === \'win32\';\n' +
    '    if (guppyBuiltOnly) {\n' +
    '        dirs = [\'build/Release\', \'build/Debug\'];\n' +
    '    }\n'],
  ['say so when the built binary does not load',
    '    throw new Error("Failed to load native module: " + name + ".node, checked: " + dirs.join(\', \') + ": " + lastError);\n',
    '    if (guppyBuiltOnly) {\n' +
    '        throw new Error("Guppy: node-pty native module " + name + ".node did not load from " + dirs.join(\' or \') + ". Guppy patches node-pty and builds it at install, and it never falls back to the unpatched prebuilt binary that node-pty ships. In a source tree run `npm run postinstall`; for an installed Guppy, reinstall it. Cause: " + lastError);\n' +
    '    }\n' +
    '    throw new Error("Failed to load native module: " + name + ".node, checked: " + dirs.join(\', \') + ": " + lastError);\n']
];

const targets = [
  { rel: ['src', 'win', 'conpty.cc'], from: pins.CONPTY_CC_PATCHED_SHA256, fromName: 'the #922-patched form (run patch-node-pty-race-fix.cjs first)', to: pins.CONPTY_CC_BUILT_SHA256, edits: [...CONPTY_EDITS, ...pins.CONPTY_CC_CLOSE_EDITS],
    // A tree patched before PTY-CONHOST-LEAK-NATIVE has the handoff already: only the close is added.
    also: [{ from: pins.CONPTY_CC_HANDOFF_SHA256, edits: pins.CONPTY_CC_CLOSE_EDITS }] },
  { rel: ['lib', 'windowsPtyAgent.js'], from: pins.AGENT_JS_PRISTINE_SHA256, fromName: 'pristine 1.1.0', to: pins.AGENT_JS_HANDOFF_SHA256, edits: AGENT_EDITS },
  { rel: ['lib', 'utils.js'], from: pins.UTILS_JS_PRISTINE_SHA256, fromName: 'pristine 1.1.0', to: pins.UTILS_JS_BUILT_ONLY_SHA256, edits: UTILS_EDITS },
  { rel: ['lib', 'worker', 'conoutSocketWorker.js'], from: pins.WORKER_JS_PRISTINE_SHA256, fromName: 'pristine 1.1.0', to: pins.WORKER_JS_QUIET_SHA256, edits: pins.WORKER_JS_EDITS }
];

// Decide everything first, write afterwards: a refusal leaves every file as it was.
const writes = [];
for (const t of targets) {
  const name = t.rel.join('/');
  const file = path.join(root, ...t.rel);
  if (!fs.existsSync(file)) fail(`node-pty ${name} missing`);
  let source = fs.readFileSync(file, 'utf8');
  const inputSha = sha(source);
  if (inputSha === t.to) continue;
  if (check) fail(`${name} is not the pinned root-handle form (sha256 ${inputSha})`);
  const input = [{ from: t.from, edits: t.edits }, ...(t.also || [])].find((i) => i.from === inputSha);
  if (!input) fail(`${name} is neither ${t.fromName} nor the pinned root-handle form (sha256 ${inputSha})`);
  for (const [label, before, after] of input.edits) {
    const at = source.indexOf(before);
    if (at < 0 || source.indexOf(before, at + 1) >= 0) fail(`${name} patch point missing or not unique: ${label}`);
    source = source.slice(0, at) + after + source.slice(at + before.length);
  }
  const outSha = sha(source);
  if (outSha !== t.to) fail(`patched ${name} sha256 ${outSha} != pinned ${t.to}`);
  writes.push([file, source]);
}
for (const [file, source] of writes) fs.writeFileSync(file, source, 'utf8');
if (check) console.log(`${TAG} node-pty hands over the root handle, closes the pseudoconsole of an ended terminal, loads built binaries only and its output worker handles socket errors (conpty.cc, windowsPtyAgent.js, utils.js, worker/conoutSocketWorker.js)`);
else if (writes.length === 0) console.log(`${TAG} root-handle handoff already applied`);
else console.log(`${TAG} applied the root-handle handoff to node-pty ${version} (${writes.length} file(s))`);
