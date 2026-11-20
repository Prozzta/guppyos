'use strict';
// Pins for the node-pty #922 backport (tools/patch-node-pty-race-fix.cjs,
// tools/record-node-pty-race-fix.cjs, scripts/release-markers.cjs).
//   PRISTINE: src/win/conpty.cc from the npm tarball locked in package-lock.json
//             (node-pty-1.1.0.tgz, sha512-20Jqtut...lUg==).
//   PATCHED : the same file after the backport; its #922 hunks are byte-identical
//             to upstream's (node-pty 1.2.0-beta.13 src/win/conpty.cc).
const fs = require('node:fs');

// PE import names of a Windows binary ("KERNEL32.dll!Name"); [] if it cannot be parsed.
function peImports(file) {
  try {
    const b = fs.readFileSync(file);
    const pe = b.readUInt32LE(0x3c);
    if (b.readUInt32LE(pe) !== 0x4550) return [];
    const nsec = b.readUInt16LE(pe + 6); const optSize = b.readUInt16LE(pe + 20); const opt = pe + 24;
    const ddir = opt + (b.readUInt16LE(opt) === 0x20b ? 112 : 96);
    const impRva = b.readUInt32LE(ddir + 8);
    const secs = [];
    for (let i = 0; i < nsec; i += 1) { const s = opt + optSize + i * 40; secs.push({ va: b.readUInt32LE(s + 12), vs: Math.max(b.readUInt32LE(s + 8), b.readUInt32LE(s + 16)), raw: b.readUInt32LE(s + 20) }); }
    const off = (rva) => { const s = secs.find((x) => rva >= x.va && rva < x.va + x.vs); if (!s) throw new Error('rva'); return rva - s.va + s.raw; };
    const cstr = (o) => { let e = o; while (b[e]) e += 1; return b.toString('latin1', o, e); };
    const out = [];
    for (let d = off(impRva); ; d += 20) {
      const ilt = b.readUInt32LE(d); const name = b.readUInt32LE(d + 12);
      if (!name) break;
      const dll = cstr(off(name)).toUpperCase();
      for (let t = off(ilt || b.readUInt32LE(d + 16)); ; t += 8) {
        const v = b.readBigUInt64LE(t);
        if (!v) break;
        if (!(v >> 63n)) out.push(`${dll}!${cstr(off(Number(v & 0x7fffffffn)) + 2)}`);
      }
    }
    return out;
  } catch { return []; }
}

// Binary fingerprint of #922: node-pty 1.1.0's conpty.node has no lock at all; the patched
// build's g_ptyHandlesMutex (std::mutex, static CRT) imports the SRW-lock primitives. This ties
// the recorded binary to the patched source independently of file mtimes.
const MUTEX_IMPORTS = ['KERNEL32.DLL!AcquireSRWLockExclusive', 'KERNEL32.DLL!ReleaseSRWLockExclusive'];
const hasMutexImports = (file) => { const imp = peImports(file); return MUTEX_IMPORTS.every((n) => imp.includes(n)); };

// PTY-HOLD-NODEPTY-HANDOFF (tools/patch-node-pty-root-handle.cjs), applied on top of #922.
// Binary fingerprint: neither node-pty 1.1.0's conpty.node nor the #922 build calls
// DuplicateHandle; the handoff does, to duplicate the root's process handle for its caller.
const HANDOFF_IMPORTS = ['KERNEL32.DLL!DuplicateHandle'];
const hasHandoffImports = (file) => { const imp = peImports(file); return HANDOFF_IMPORTS.every((n) => imp.includes(n)); };

// PTY-EARLY-KILL-EPIPE-108 (tools/patch-node-pty-root-handle.cjs): node-pty's output worker
// (lib/worker/conoutSocketWorker.js) pipes the console's output to the data socket and listens for
// no error, on either end. A data socket destroyed before the worker writes to it gives EPIPE,
// uncaught in the worker thread; Node ends the worker and emits the error on the Worker object in
// the main thread, where node-pty does not listen either: thrown outside any caller.
// The edits live here, not in the tool, so that a test can take them back out and run the
// unpatched worker as its control.
const WORKER_JS_EDITS = [
  ['the console pipe: an error listener',
    'conoutSocket.setEncoding(\'utf8\');\n',
    'conoutSocket.setEncoding(\'utf8\');\n' +
    '// GUPPY PTY-EARLY-KILL-EPIPE-108 (tools/patch-node-pty-root-handle.cjs): neither end of this\n' +
    '// worker had an error listener, so a write to a data socket that was destroyed before the\n' +
    '// write (EPIPE) ended the worker, and the main thread threw it outside any caller. A reader\n' +
    '// that has gone is a normal end: EPIPE or ECONNRESET on a socket that is destroyed is torn\n' +
    '// down quietly. Anything else is thrown again, as it was before.\n' +
    'var guppyDataSockets = [];\n' +
    'function guppyPeerGone(err, socket) {\n' +
    '    return !!err && (err.code === \'EPIPE\' || err.code === \'ECONNRESET\') && socket.destroyed === true;\n' +
    '}\n' +
    'conoutSocket.on(\'error\', function (err) {\n' +
    '    if (!guppyPeerGone(err, conoutSocket)) {\n' +
    '        throw err;\n' +
    '    }\n' +
    '    // The console is gone: end the data sockets, as the pipe does when the console ends.\n' +
    '    guppyDataSockets.slice().forEach(function (dataSocket) { dataSocket.end(); });\n' +
    '});\n'],
  ['the data socket: an error listener',
    '        conoutSocket.pipe(workerSocket);\n',
    '        // GUPPY PTY-EARLY-KILL-EPIPE-108: see guppyPeerGone above.\n' +
    '        guppyDataSockets.push(workerSocket);\n' +
    '        workerSocket.on(\'close\', function () {\n' +
    '            guppyDataSockets.splice(guppyDataSockets.indexOf(workerSocket), 1);\n' +
    '            // GUPPY PTY-CONHOST-LEAK-NATIVE: the console still writes when its reader has gone.\n' +
    '            // A pipe with no destination stops reading; the console host then blocks in its\n' +
    '            // own write for ever, and the close of the pseudoconsole waits on the host. So\n' +
    '            // with no reader left the output is read and thrown away.\n' +
    '            if (guppyDataSockets.length === 0) {\n' +
    '                conoutSocket.unpipe();\n' +
    '                conoutSocket.resume();\n' +
    '            }\n' +
    '        });\n' +
    '        workerSocket.on(\'error\', function (err) {\n' +
    '            conoutSocket.unpipe(workerSocket);\n' +
    '            if (!guppyPeerGone(err, workerSocket)) {\n' +
    '                throw err;\n' +
    '            }\n' +
    '        });\n' +
    '        conoutSocket.pipe(workerSocket);\n'],
  ['the console pipe: its end is the worker\'s end',
    '    server.listen(conout_1.getWorkerPipeName(conoutPipeName));\n',
    '    // GUPPY PTY-CONHOST-LEAK-NATIVE: this worker reads until the console host has closed its\n' +
    '    // end, and then ends by itself. Nothing ends it earlier: the main thread cannot see the\n' +
    '    // close of the pseudoconsole return, and a worker ended before it leaves the host\n' +
    '    // writing output nobody reads. It ends by listening no more, and only when a reader\n' +
    '    // has been served and none is open: a reader that connects after the console has\n' +
    '    // closed still finds the pipe (PTY-EARLY-CLOSE-EOF, PTY-LATE-READY-ENOENT).\n' +
    '    var guppyReaders = 0;\n' +
    '    var guppyHadReader = false;\n' +
    '    var guppyEndWhenDone = function () {\n' +
    '        if (conoutSocket.destroyed && guppyHadReader && guppyReaders === 0) {\n' +
    '            server.close();\n' +
    '        }\n' +
    '    };\n' +
    '    server.on(\'connection\', function (dataSocket) {\n' +
    '        guppyHadReader = true;\n' +
    '        guppyReaders++;\n' +
    '        dataSocket.on(\'close\', function () { guppyReaders--; guppyEndWhenDone(); });\n' +
    '    });\n' +
    '    conoutSocket.on(\'close\', guppyEndWhenDone);\n' +
    '    server.listen(conout_1.getWorkerPipeName(conoutPipeName));\n']
];

// PTY-CONHOST-LEAK-NATIVE (tools/patch-node-pty-root-handle.cjs), applied on top of the handoff.
// A terminal's console host (conhost.exe, or OpenConsole.exe with the bundled conpty.dll) lives
// until its pseudoconsole is closed. node-pty 1.1.0 closes it only in its kill, and only while the
// terminal's record is still in the native list; the exit thread erases the record without
// closing. So every terminal whose root had ended kept its host until the app quit.
// The edits live here, not in the tool, so that a test can take them back out and prove the
// handoff form byte for byte.
const CONPTY_CC_CLOSE_EDITS = [
  ['the record: which library made the pseudoconsole, and whether it is closed',
    '  HANDLE hShell;\n' +
    '\n' +
    '  pty_baton(',
    '  HANDLE hShell;\n' +
    '  // GUPPY PTY-CONHOST-LEAK-NATIVE (tools/patch-node-pty-root-handle.cjs): guppyHpcClosed is\n' +
    '  // read and written under g_ptyHandlesMutex only. guppyUseConptyDll is written once, by\n' +
    '  // PtyConnect before it starts the exit thread, and is only read after that.\n' +
    '  bool guppyUseConptyDll = false;\n' +
    '  bool guppyHpcClosed = false;\n' +
    '\n' +
    '  pty_baton('],
  ['a close that needs no JavaScript environment',
    'struct ExitEvent {\n' +
    '  int exit_code = 0;\n' +
    '};\n',
    '// GUPPY PTY-CONHOST-LEAK-NATIVE (tools/patch-node-pty-root-handle.cjs): close a pseudoconsole\n' +
    '// from any thread. The library that made it is already loaded (PtyStartProcess loaded it), so\n' +
    '// it is looked up by name; no Napi value is needed, which the exit thread does not have.\n' +
    'static void GuppyClosePseudoConsole(HPCON hpc, bool useConptyDll) {\n' +
    '  HMODULE hLibrary = GetModuleHandleW(useConptyDll ? L"conpty.dll" : L"kernel32.dll");\n' +
    '  if (hLibrary == nullptr) {\n' +
    '    return;\n' +
    '  }\n' +
    '  PFNCLOSEPSEUDOCONSOLE const pfnClosePseudoConsole = (PFNCLOSEPSEUDOCONSOLE)GetProcAddress(\n' +
    '    hLibrary,\n' +
    '    useConptyDll ? "ConptyClosePseudoConsole" : "ClosePseudoConsole");\n' +
    '  if (pfnClosePseudoConsole) {\n' +
    '    pfnClosePseudoConsole(hpc);\n' +
    '  }\n' +
    '}\n' +
    '\n' +
    'struct ExitEvent {\n' +
    '  int exit_code = 0;\n' +
    '  // GUPPY PTY-CONHOST-LEAK-NATIVE: the thread that closes the pseudoconsole could not be started.\n' +
    '  bool guppy_close_unstarted = false;\n' +
    '};\n'],
  ['the exit thread has the pseudoconsole it drops closed, off the joined thread',
    '    WaitForSingleObject(baton->hShell, INFINITE);\n' +
    '    {\n' +
    '      std::lock_guard<std::mutex> lock(g_ptyHandlesMutex);\n' +
    '      GetExitCodeProcess(baton->hShell, (LPDWORD)(&exit_event->exit_code));\n' +
    '      CloseHandle(baton->hShell);\n' +
    '      const int id = baton->id;\n' +
    '      std::erase_if(ptyHandles, [id](const auto& ptyHandle) {\n' +
    '        return ptyHandle->id == id;\n' +
    '      });\n' +
    '    }\n' +
    '\n' +
    '    auto status = tsfn.BlockingCall(exit_event, callback); // In main thread\n' +
    '    switch (status) {\n' +
    '      case napi_closing:\n' +
    '        break;\n' +
    '\n' +
    '      case napi_queue_full:\n' +
    '        Napi::Error::Fatal("SetupExitCallback", "Queue was full");\n' +
    '\n' +
    '      case napi_ok:\n' +
    '        if (tsfn.Release() != napi_ok) {\n' +
    '          Napi::Error::Fatal("SetupExitCallback", "ThreadSafeFunction.Release() failed");\n' +
    '        }\n' +
    '        break;\n' +
    '\n' +
    '      default:\n' +
    '        Napi::Error::Fatal("SetupExitCallback", "ThreadSafeFunction.BlockingCall() failed");\n' +
    '    }\n',
    '    WaitForSingleObject(baton->hShell, INFINITE);\n' +
    '    // GUPPY PTY-CONHOST-LEAK-NATIVE (tools/patch-node-pty-root-handle.cjs): this thread erases the\n' +
    '    // record of the terminal, and after that no kill can find the pseudoconsole. Unclosed, its\n' +
    '    // console host stayed for the life of the app. So the thread takes the pseudoconsole out\n' +
    '    // of the record under the lock (unless a kill has closed it already) and has it closed\n' +
    '    // after the lock is released and after the exit is reported, so that a slow close holds up\n' +
    '    // neither a kill or resize of another terminal nor the exit event.\n' +
    '    HPCON guppyHpc = nullptr;\n' +
    '    bool guppyUseConptyDll = false;\n' +
    '    {\n' +
    '      std::lock_guard<std::mutex> lock(g_ptyHandlesMutex);\n' +
    '      GetExitCodeProcess(baton->hShell, (LPDWORD)(&exit_event->exit_code));\n' +
    '      CloseHandle(baton->hShell);\n' +
    '      if (!baton->guppyHpcClosed) {\n' +
    '        guppyHpc = baton->hpc;\n' +
    '        baton->guppyHpcClosed = true;\n' +
    '      }\n' +
    '      guppyUseConptyDll = baton->guppyUseConptyDll;\n' +
    '      const int id = baton->id;\n' +
    '      std::erase_if(ptyHandles, [id](const auto& ptyHandle) {\n' +
    '        return ptyHandle->id == id;\n' +
    '      });\n' +
    '    }\n' +
    // The test hook GUPPY_PTY_TEST_CLOSE_THREAD_FAILS below IS SHIPPED in the native binary. It is
    // safe there because it fails safe: a process that has it set keeps each ended terminal's console
    // host until the app quits (the very state this handler exists for), and never crashes. Nothing
    // in Guppy sets it; only test/pty-conhost-leak-native.test.cjs does, in its own child process.
    '    // GUPPY PTY-CONHOST-LEAK-NATIVE (tools/patch-node-pty-root-handle.cjs): the thread that will\n' +
    '    // close the pseudoconsole is started here, parked on an event, before the exit is reported,\n' +
    '    // so that the report can say whether there is one. A thread that cannot be started throws,\n' +
    '    // and nothing on this thread would catch it: that is std::terminate, the whole app gone.\n' +
    '    // Caught instead, the pseudoconsole stays open (a console host that stays until the app\n' +
    '    // quits, never a crash) and the exit report says so: the agent then ends the output worker\n' +
    '    // itself, which would otherwise wait for ever for a host that never closes its end.\n' +
    '    // (GUPPY_PTY_TEST_CLOSE_THREAD_FAILS makes the start fail: the test of this handler.)\n' +
    '    HANDLE guppyGo = nullptr;\n' +
    '    if (guppyHpc != nullptr) {\n' +
    '      try {\n' +
    '        if (GetEnvironmentVariableW(L"GUPPY_PTY_TEST_CLOSE_THREAD_FAILS", nullptr, 0) != 0) {\n' +
    '          throw std::system_error(std::make_error_code(std::errc::resource_unavailable_try_again));\n' +
    '        }\n' +
    '        guppyGo = CreateEventW(nullptr, TRUE, FALSE, nullptr);\n' +
    '        if (guppyGo == nullptr) {\n' +
    '          throw std::system_error(std::make_error_code(std::errc::resource_unavailable_try_again));\n' +
    '        }\n' +
    '        std::thread([guppyHpc, guppyUseConptyDll, guppyGo] {\n' +
    '          WaitForSingleObject(guppyGo, INFINITE);\n' +
    '          CloseHandle(guppyGo);\n' +
    '          GuppyClosePseudoConsole(guppyHpc, guppyUseConptyDll);\n' +
    '        }).detach();\n' +
    '      } catch (...) {\n' +
    '        if (guppyGo != nullptr) {\n' +
    '          CloseHandle(guppyGo);\n' +
    '          guppyGo = nullptr;\n' +
    '        }\n' +
    '        exit_event->guppy_close_unstarted = true;\n' +
    '      }\n' +
    '    }\n' +
    '\n' +
    '    auto status = tsfn.BlockingCall(exit_event, callback); // In main thread\n' +
    '    switch (status) {\n' +
    '      case napi_closing:\n' +
    '        break;\n' +
    '\n' +
    '      case napi_queue_full:\n' +
    '        Napi::Error::Fatal("SetupExitCallback", "Queue was full");\n' +
    '\n' +
    '      case napi_ok:\n' +
    '        if (tsfn.Release() != napi_ok) {\n' +
    '          Napi::Error::Fatal("SetupExitCallback", "ThreadSafeFunction.Release() failed");\n' +
    '        }\n' +
    '        break;\n' +
    '\n' +
    '      default:\n' +
    '        Napi::Error::Fatal("SetupExitCallback", "ThreadSafeFunction.BlockingCall() failed");\n' +
    '    }\n' +
    '    // GUPPY PTY-CONHOST-LEAK-NATIVE (tools/patch-node-pty-root-handle.cjs): the close runs on a\n' +
    '    // detached thread of its own, let go here, after the callback function is released. On Windows 10\n' +
    '    // the close can wait for the console host for ever (measured: the output socket destroyed,\n' +
    '    // then a program that floods and ends by itself). This thread is joined by the finalizer on\n' +
    '    // the main thread, and until Release() the function keeps the event loop alive: a close\n' +
    '    // here held both. The detached thread holds only the handle, the library flag and its event.\n' +
    '    if (guppyGo != nullptr) {\n' +
    '      SetEvent(guppyGo);\n' +
    '    }\n'],
  ['the exit report says when the close could not be started',
    '      cb.Call({Napi::Number::New(env, exit_event->exit_code)});\n',
    '      // GUPPY PTY-CONHOST-LEAK-NATIVE: the second argument is true when the close was not started.\n' +
    '      cb.Call({Napi::Number::New(env, exit_event->exit_code), Napi::Boolean::New(env, exit_event->guppy_close_unstarted)});\n'],
  ['connect records which library made the pseudoconsole',
    '  // Update handle\n' +
    '  handle->hShell = piClient.hProcess;\n',
    '  // Update handle\n' +
    '  handle->hShell = piClient.hProcess;\n' +
    '  // GUPPY PTY-CONHOST-LEAK-NATIVE: the exit thread closes with the same library.\n' +
    '  handle->guppyUseConptyDll = useConptyDll;\n'],
  ['kill closes once and says so',
    '  const pty_baton* handle = get_pty_baton(lock, id);\n' +
    '\n' +
    '  if (handle != nullptr) {\n' +
    '    HANDLE hLibrary = LoadConptyDll(info, useConptyDll);\n' +
    '    bool fLoadedDll = hLibrary != nullptr;\n' +
    '    if (fLoadedDll)\n' +
    '    {\n' +
    '      PFNCLOSEPSEUDOCONSOLE const pfnClosePseudoConsole = (PFNCLOSEPSEUDOCONSOLE)GetProcAddress(\n' +
    '        (HMODULE)hLibrary,\n' +
    '        useConptyDll ? "ConptyClosePseudoConsole" : "ClosePseudoConsole");\n' +
    '      if (pfnClosePseudoConsole)\n' +
    '      {\n' +
    '        pfnClosePseudoConsole(handle->hpc);\n' +
    '      }\n',
    '  // GUPPY PTY-CONHOST-LEAK-NATIVE (tools/patch-node-pty-root-handle.cjs): a pseudoconsole is\n' +
    '  // closed exactly once, by this kill or by the exit thread, whichever holds the lock first.\n' +
    '  pty_baton* handle = get_pty_baton(lock, id);\n' +
    '\n' +
    '  if (handle != nullptr) {\n' +
    '    HANDLE hLibrary = LoadConptyDll(info, useConptyDll);\n' +
    '    bool fLoadedDll = hLibrary != nullptr;\n' +
    '    if (fLoadedDll)\n' +
    '    {\n' +
    '      PFNCLOSEPSEUDOCONSOLE const pfnClosePseudoConsole = (PFNCLOSEPSEUDOCONSOLE)GetProcAddress(\n' +
    '        (HMODULE)hLibrary,\n' +
    '        useConptyDll ? "ConptyClosePseudoConsole" : "ClosePseudoConsole");\n' +
    '      if (pfnClosePseudoConsole && !handle->guppyHpcClosed)\n' +
    '      {\n' +
    '        handle->guppyHpcClosed = true;\n' +
    '        pfnClosePseudoConsole(handle->hpc);\n' +
    '      }\n'],
  ['the binary says that it closes on exit',
    '  exports.Set("kill", Napi::Function::New(env, PtyKill));\n' +
    '  return exports;\n',
    '  exports.Set("kill", Napi::Function::New(env, PtyKill));\n' +
    '  // GUPPY PTY-CONHOST-LEAK-NATIVE (tools/patch-node-pty-root-handle.cjs): the close needs no new\n' +
    '  // import, so the build names itself. The name is in the binary and on the loaded module.\n' +
    '  exports.Set("guppyClosesPseudoConsoleOnExit", Napi::Boolean::New(env, true));\n' +
    '  return exports;\n']
];
// Binary fingerprint of the close: the export name above, as bytes in conpty.node.
const CLOSE_MARKER = 'guppyClosesPseudoConsoleOnExit';
const hasCloseMarker = (file) => { try { return fs.readFileSync(file).includes(Buffer.from(CLOSE_MARKER, 'latin1')); } catch { return false; } };

module.exports = {
  NODE_PTY_VERSION: '1.1.0',
  // lib/worker/conoutSocketWorker.js: from the same tarball, and with the error listeners.
  WORKER_JS_PRISTINE_SHA256: '3e4bac095ac3870c3248a7302f5d10217de625f30c32b7000fe48a34788e47ac',
  WORKER_JS_QUIET_SHA256: '8e3c38cc4ff78d0f07a15d8f653953e2ad9d630e8afe15b2398dec2b0e637d4c',
  WORKER_JS_EDITS,
  CONPTY_CC_PRISTINE_SHA256: '52c893b689ab3210c0961e2a6aa805a82350003767b21069b164926b5becd4e2',
  CONPTY_CC_PATCHED_SHA256: 'a000a53daa90506662e4747c6585a403b93431d1fe46f99895aa6d58faaa9082',
  // conpty.cc after #922 and the root-handle handoff: a state in between, like PATCHED above.
  CONPTY_CC_HANDOFF_SHA256: '7f9d90c35006328d4ac0dec08bafb4d7ac31cf35cc2363bde4dd9b0f375d160c',
  // conpty.cc after ALL its patches (#922, the root-handle handoff, then the close on exit of
  // PTY-CONHOST-LEAK-NATIVE): the only source conpty.node may be built from, and what the record
  // and the release markers require.
  CONPTY_CC_BUILT_SHA256: '66801835bc8b51a98b59b29f969865c14f3744866a1c5049d0399497ecfd2888',
  CONPTY_CC_CLOSE_EDITS,
  CLOSE_MARKER,
  hasCloseMarker,
  // lib/windowsPtyAgent.js: from the same tarball, and after the handoff patch.
  AGENT_JS_PRISTINE_SHA256: '8636d16b38266112204061a22b135734177c242837982fd3a4055be726efa64a',
  AGENT_JS_HANDOFF_SHA256: '3b77443093cc1e7bc5afb74f491c5b5a6477731e18fa1ebc21df8374cc9004b3',
  // lib/utils.js (NODEPTY-PACKAGED-PROOF): from the same tarball, and after the loader patch that
  // stops Windows from falling back to node-pty's unpatched prebuilt binaries.
  UTILS_JS_PRISTINE_SHA256: 'f75ad341c13fbf1a9a6605d7ee42dff5bbc5d43b7b381e413fb97eb1b8300beb',
  UTILS_JS_BUILT_ONLY_SHA256: 'c53c55c4b8f87f08ee89c7a01b150ccfaee0f6effca9e4fc9686c806cf236d49',
  HANDOFF_IMPORTS,
  hasHandoffImports,
  MARKER_FILE: 'munder-conpty-race-fix.json',
  MUTEX_IMPORTS,
  peImports,
  hasMutexImports,
};
