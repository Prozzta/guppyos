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
    '        });\n' +
    '        workerSocket.on(\'error\', function (err) {\n' +
    '            conoutSocket.unpipe(workerSocket);\n' +
    '            if (!guppyPeerGone(err, workerSocket)) {\n' +
    '                throw err;\n' +
    '            }\n' +
    '        });\n' +
    '        conoutSocket.pipe(workerSocket);\n']
];

module.exports = {
  NODE_PTY_VERSION: '1.1.0',
  // lib/worker/conoutSocketWorker.js: from the same tarball, and with the error listeners.
  WORKER_JS_PRISTINE_SHA256: '3e4bac095ac3870c3248a7302f5d10217de625f30c32b7000fe48a34788e47ac',
  WORKER_JS_QUIET_SHA256: 'c878b1b0ce5a301d3ad752a006221a4b5646dd073a5c914bc80b96daa87e4713',
  WORKER_JS_EDITS,
  CONPTY_CC_PRISTINE_SHA256: '52c893b689ab3210c0961e2a6aa805a82350003767b21069b164926b5becd4e2',
  CONPTY_CC_PATCHED_SHA256: 'a000a53daa90506662e4747c6585a403b93431d1fe46f99895aa6d58faaa9082',
  // conpty.cc after BOTH patches (#922, then the root-handle handoff): the only source
  // conpty.node may be built from, and what the record and the release markers require.
  // CONPTY_CC_PATCHED_SHA256 above is the state in between.
  CONPTY_CC_BUILT_SHA256: '7f9d90c35006328d4ac0dec08bafb4d7ac31cf35cc2363bde4dd9b0f375d160c',
  // lib/windowsPtyAgent.js: from the same tarball, and after the handoff patch.
  AGENT_JS_PRISTINE_SHA256: '8636d16b38266112204061a22b135734177c242837982fd3a4055be726efa64a',
  AGENT_JS_HANDOFF_SHA256: '33390ba2cc9bc5bbf78d6123abb914f627445fadb89745de466a5eab8bbb197e',
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
