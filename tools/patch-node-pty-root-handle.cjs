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
//   --check          change nothing; exit 1 unless both files are in their patched form
//   --root <dir>     another node-pty tree (the self-test only)
// Any other argument is refused: this tool rewrites files, so it never guesses.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const pins = require('./node-pty-race-fix-pins.cjs');

const TAG = '[patch-node-pty-root-handle]';
const fail = (msg) => { console.error(`${TAG} FAILED: ${msg}`); process.exit(1); };

let check = false;
let root = path.join(__dirname, '..', 'node_modules', 'node-pty');
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--check') check = true;
  else if (argv[i] === '--root' && typeof argv[i + 1] === 'string' && argv[i + 1] !== '') { root = path.resolve(argv[i + 1]); i += 1; }
  else fail(`unknown argument ${JSON.stringify(argv[i])} (usage: [--check] [--root <node-pty dir>])`);
}
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
  ['keep the handle next to the pid',
    '            this._innerPid = connect.pid;\n',
    '            this._innerPid = connect.pid;\n' +
    '            // GUPPY PTY-HOLD-NODEPTY-HANDOFF (tools/patch-node-pty-root-handle.cjs): the root\'s own handle.\n' +
    '            this._rootHandle = connect.rootHandle;\n']
];

const targets = [
  { rel: ['src', 'win', 'conpty.cc'], from: pins.CONPTY_CC_PATCHED_SHA256, fromName: 'the #922-patched form (run patch-node-pty-race-fix.cjs first)', to: pins.CONPTY_CC_BUILT_SHA256, edits: CONPTY_EDITS },
  { rel: ['lib', 'windowsPtyAgent.js'], from: pins.AGENT_JS_PRISTINE_SHA256, fromName: 'pristine 1.1.0', to: pins.AGENT_JS_HANDOFF_SHA256, edits: AGENT_EDITS }
];

// Decide everything first, write afterwards: a refusal leaves both files as they were.
const writes = [];
for (const t of targets) {
  const name = t.rel.join('/');
  const file = path.join(root, ...t.rel);
  if (!fs.existsSync(file)) fail(`node-pty ${name} missing`);
  let source = fs.readFileSync(file, 'utf8');
  const inputSha = sha(source);
  if (inputSha === t.to) continue;
  if (check) fail(`${name} is not the pinned root-handle form (sha256 ${inputSha})`);
  if (inputSha !== t.from) fail(`${name} is neither ${t.fromName} nor the pinned root-handle form (sha256 ${inputSha})`);
  for (const [label, before, after] of t.edits) {
    const at = source.indexOf(before);
    if (at < 0 || source.indexOf(before, at + 1) >= 0) fail(`${name} patch point missing or not unique: ${label}`);
    source = source.slice(0, at) + after + source.slice(at + before.length);
  }
  const outSha = sha(source);
  if (outSha !== t.to) fail(`patched ${name} sha256 ${outSha} != pinned ${t.to}`);
  writes.push([file, source]);
}
for (const [file, source] of writes) fs.writeFileSync(file, source, 'utf8');
if (check) console.log(`${TAG} node-pty hands over the root handle (conpty.cc, windowsPtyAgent.js)`);
else if (writes.length === 0) console.log(`${TAG} root-handle handoff already applied`);
else console.log(`${TAG} applied the root-handle handoff to node-pty ${version} (${writes.length} file(s))`);
