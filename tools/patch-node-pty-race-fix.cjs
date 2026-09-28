#!/usr/bin/env node
'use strict';

// Backport upstream node-pty #922 to the stable 1.1.0 source before
// electron-rebuild compiles conpty.node. Keep this deliberately strict: a
// package-source change must fail visibly instead of silently skipping a
// security-critical native patch.
const fs = require('node:fs');
const path = require('node:path');

if (process.platform !== 'win32') process.exit(0);
const file = path.join(__dirname, '..', 'node_modules', 'node-pty', 'src', 'win', 'conpty.cc');
if (!fs.existsSync(file)) throw new Error('node-pty conpty.cc source missing');
let source = fs.readFileSync(file, 'utf8');
if (source.includes('std::mutex g_ptyHandlesMutex')) {
  console.log('[patch-node-pty-race-fix] node-pty #922 already applied');
  process.exit(0);
}
const replaceOnce = (before, after, label) => {
  if (!source.includes(before)) throw new Error(`node-pty 1.1.0 #922 patch point missing: ${label}`);
  source = source.replace(before, after);
};

replaceOnce('#include <assert.h>\n', '#include <assert.h>\n#include <atomic>\n#include <mutex>\n', 'includes');
replaceOnce(
  'static std::vector<std::unique_ptr<pty_baton>> ptyHandles;\n' +
  'static volatile LONG ptyCounter;\n\n' +
  'static pty_baton* get_pty_baton(int id) {',
  'static std::vector<std::unique_ptr<pty_baton>> ptyHandles;\n' +
  'static std::mutex g_ptyHandlesMutex;\n' +
  'static std::atomic<int> ptyCounter{0};\n\n' +
  '// The leading scoped-lock parameter encodes the caller-held mutex precondition.\n' +
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
  'const int ptyId = InterlockedIncrement(&ptyCounter);\n' +
  '    marshal.Set("pty", Napi::Number::New(env, ptyId));\n' +
  '    ptyHandles.emplace_back(\n' +
  '        std::make_unique<pty_baton>(ptyId, hIn, hOut, hpc));',
  'const int ptyId = ++ptyCounter;\n' +
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
  '  // Fetch pty handle from ID and start process\n' +
  '  pty_baton* handle;\n' +
  '  {\n' +
  '    std::lock_guard<std::mutex> lock(g_ptyHandlesMutex);\n' +
  '    handle = get_pty_baton(lock, id);\n' +
  '    if (!handle) {\n' +
  '      throw Napi::Error::New(env, "Invalid pty handle");\n' +
  '    }\n' +
  '  }',
  'connect lookup');
replaceOnce('  const pty_baton* handle = get_pty_baton(id);', '  std::lock_guard<std::mutex> lock(g_ptyHandlesMutex);\n  const pty_baton* handle = get_pty_baton(lock, id);', 'resize lookup');
replaceOnce('  const pty_baton* handle = get_pty_baton(id);', '  std::lock_guard<std::mutex> lock(g_ptyHandlesMutex);\n  const pty_baton* handle = get_pty_baton(lock, id);', 'clear lookup');
replaceOnce('  const pty_baton* handle = get_pty_baton(id);', '  std::lock_guard<std::mutex> lock(g_ptyHandlesMutex);\n  const pty_baton* handle = get_pty_baton(lock, id);', 'kill lookup');
if (source.includes('get_pty_baton(id)') || source.includes('remove_pty_baton')) throw new Error('node-pty #922 patch incomplete');
fs.writeFileSync(file, source, 'utf8');
console.log('[patch-node-pty-race-fix] applied upstream #922 to node-pty 1.1.0');
