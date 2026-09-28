#!/usr/bin/env node
'use strict';

// Backport upstream node-pty #922 to the stable 1.1.0 source before
// electron-rebuild compiles conpty.node. Keep this deliberately strict: a
// package-source change must fail visibly instead of silently skipping a
// security-critical native patch.
//
// Accepted input states (by SHA-256 of src/win/conpty.cc, see node-pty-race-fix-pins.cjs):
//   pristine 1.1.0 -> patch, then require the result to equal the pinned patched digest
//   already patched -> no-op (second npm ci / npm rebuild / npm run postinstall)
//   anything else  -> throw (different node-pty, partial patch, line-ending change, ...)
// `--root <node-pty dir>` targets another tree (used by the self-test only).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const pins = require('./node-pty-race-fix-pins.cjs');

if (process.platform !== 'win32') process.exit(0);
const rootArg = process.argv.indexOf('--root');
const root = rootArg > 0 ? path.resolve(process.argv[rootArg + 1]) : path.join(__dirname, '..', 'node_modules', 'node-pty');
const pkgPath = path.join(root, 'package.json');
const file = path.join(root, 'src', 'win', 'conpty.cc');
const fail = (msg) => { console.error(`[patch-node-pty-race-fix] FAILED: ${msg}`); process.exit(1); };
if (!fs.existsSync(pkgPath)) fail(`node-pty package.json missing at ${pkgPath}`);
const version = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version;
if (version !== pins.NODE_PTY_VERSION) fail(`node-pty ${pins.NODE_PTY_VERSION} required, got ${version}; re-derive the #922 backport before changing the dependency`);
if (!fs.existsSync(file)) fail('node-pty src/win/conpty.cc missing');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
let source = fs.readFileSync(file, 'utf8');
const inputSha = sha(source);
if (inputSha === pins.CONPTY_CC_PATCHED_SHA256) {
  console.log('[patch-node-pty-race-fix] node-pty #922 already applied');
  process.exit(0);
}
if (inputSha !== pins.CONPTY_CC_PRISTINE_SHA256) fail(`conpty.cc is neither pristine 1.1.0 nor the pinned patched form (sha256 ${inputSha})`);

const replaceOnce = (before, after, label) => {
  const at = source.indexOf(before);
  if (at < 0) fail(`node-pty 1.1.0 #922 patch point missing: ${label}`);
  source = source.slice(0, at) + after + source.slice(at + before.length);
};

replaceOnce('#include <Shlwapi.h> // PathCombine, PathIsRelative\n',
  '#include <Shlwapi.h> // PathCombine, PathIsRelative\n#include <atomic>\n#include <mutex>\n', 'includes');
replaceOnce(
  'static std::vector<std::unique_ptr<pty_baton>> ptyHandles;\n' +
  'static volatile LONG ptyCounter;\n\n' +
  'static pty_baton* get_pty_baton(int id) {',
  'static std::vector<std::unique_ptr<pty_baton>> ptyHandles;\n' +
  'static std::mutex g_ptyHandlesMutex;\n' +
  'static std::atomic<int> ptyCounter{0};\n\n' +
  '// The leading scoped-lock parameter encodes the precondition that the caller\n' +
  '// holds g_ptyHandlesMutex.\n' +
  'static pty_baton* get_pty_baton(const std::lock_guard<std::mutex>&, int id) {',
  'globals');
replaceOnce(
  'static bool remove_pty_baton(int id) {\n' +
  '  auto it = std::remove_if(ptyHandles.begin(), ptyHandles.end(), [id](const auto& ptyHandle) {\n' +
  '    return ptyHandle->id == id;\n' +
  '  });\n' +
  '  if (it != ptyHandles.end()) {\n' +
  '    ptyHandles.erase(it);\n' +
  '    return true;\n' +
  '  }\n' +
  '  return false;\n' +
  '}\n\n',
  '',
  'unsafe erase helper');
replaceOnce(
  '    // Get process exit code.\n' +
  '    GetExitCodeProcess(baton->hShell, (LPDWORD)(&exit_event->exit_code));\n' +
  '    // Clean up handles\n' +
  '    CloseHandle(baton->hShell);\n' +
  '    assert(remove_pty_baton(baton->id));',
  '    {\n' +
  '      std::lock_guard<std::mutex> lock(g_ptyHandlesMutex);\n' +
  '      GetExitCodeProcess(baton->hShell, (LPDWORD)(&exit_event->exit_code));\n' +
  '      CloseHandle(baton->hShell);\n' +
  '      const int id = baton->id;\n' +
  '      std::erase_if(ptyHandles, [id](const auto& ptyHandle) {\n' +
  '        return ptyHandle->id == id;\n' +
  '      });\n' +
  '    }',
  'watcher erase');
replaceOnce(
  '    const int ptyId = InterlockedIncrement(&ptyCounter);\n' +
  '    marshal.Set("pty", Napi::Number::New(env, ptyId));\n' +
  '    ptyHandles.emplace_back(\n' +
  '        std::make_unique<pty_baton>(ptyId, hIn, hOut, hpc));',
  '    const int ptyId = ++ptyCounter;\n' +
  '    marshal.Set("pty", Napi::Number::New(env, ptyId));\n' +
  '    {\n' +
  '      std::lock_guard<std::mutex> lock(g_ptyHandlesMutex);\n' +
  '      ptyHandles.emplace_back(\n' +
  '          std::make_unique<pty_baton>(ptyId, hIn, hOut, hpc));\n' +
  '    }',
  'handle insert');
replaceOnce(
  '  // Fetch pty handle from ID and start process\n' +
  '  pty_baton* handle = get_pty_baton(id);\n' +
  '  if (!handle) {\n' +
  '    throw Napi::Error::New(env, "Invalid pty handle");\n' +
  '  }',
  '  pty_baton* handle;\n' +
  '  {\n' +
  '    std::lock_guard<std::mutex> lock(g_ptyHandlesMutex);\n' +
  '    handle = get_pty_baton(lock, id);\n' +
  '    if (!handle) {\n' +
  '      throw Napi::Error::New(env, "Invalid pty handle");\n' +
  '    }\n' +
  '  }',
  'connect lookup');
// resize, clear, kill (in file order): upstream holds the lock for the whole call.
for (const label of ['resize lookup', 'clear lookup', 'kill lookup']) {
  replaceOnce('  const pty_baton* handle = get_pty_baton(id);',
    '  std::lock_guard<std::mutex> lock(g_ptyHandlesMutex);\n  const pty_baton* handle = get_pty_baton(lock, id);', label);
}
if (/get_pty_baton\(id\)|remove_pty_baton|InterlockedIncrement\(&ptyCounter\)/.test(source)) fail('node-pty #922 patch incomplete');
const outSha = sha(source);
if (outSha !== pins.CONPTY_CC_PATCHED_SHA256) fail(`patched conpty.cc sha256 ${outSha} != pinned ${pins.CONPTY_CC_PATCHED_SHA256}`);
fs.writeFileSync(file, source, 'utf8');
console.log('[patch-node-pty-race-fix] applied upstream #922 to node-pty 1.1.0');
