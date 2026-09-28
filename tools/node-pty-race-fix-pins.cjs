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

module.exports = {
  NODE_PTY_VERSION: '1.1.0',
  CONPTY_CC_PRISTINE_SHA256: '52c893b689ab3210c0961e2a6aa805a82350003767b21069b164926b5becd4e2',
  CONPTY_CC_PATCHED_SHA256: 'a000a53daa90506662e4747c6585a403b93431d1fe46f99895aa6d58faaa9082',
  MARKER_FILE: 'munder-conpty-race-fix.json',
  MUTEX_IMPORTS,
  peImports,
  hasMutexImports,
};
