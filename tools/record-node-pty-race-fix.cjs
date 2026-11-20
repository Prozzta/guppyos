#!/usr/bin/env node
'use strict';

// Emit evidence only when electron-rebuild compiled the fully patched source
// (#922, then the PTY-HOLD-NODEPTY-HANDOFF root-handle handoff, then the
// PTY-CONHOST-LEAK-NATIVE close on exit):
// node-pty is the pinned 1.1.0, conpty.cc is byte-for-byte the pinned built
// form (CONPTY_CC_BUILT_SHA256), lib/windowsPtyAgent.js is its pinned handoff form, and build/Release/conpty.node is newer than that patched source (a
// binary built before the patch, or a stale copy, is refused rather than
// blessed). scripts/release-markers.cjs re-checks the recorded digests.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const pins = require('./node-pty-race-fix-pins.cjs');

if (process.platform !== 'win32') process.exit(0);
const root = path.join(__dirname, '..', 'node_modules', 'node-pty');
const pkgPath = path.join(root, 'package.json');
const sourcePath = path.join(root, 'src', 'win', 'conpty.cc');
const markerPath = path.join(root, pins.MARKER_FILE);
const hash = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const fail = (msg) => { console.error(`[record-node-pty-race-fix] FAILED: ${msg}`); process.exit(1); };
if (!fs.existsSync(pkgPath) || !fs.existsSync(sourcePath)) fail('node-pty source missing');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
if (pkg.version !== pins.NODE_PTY_VERSION) fail(`node-pty ${pins.NODE_PTY_VERSION} required, got ${pkg.version}`);
const sourceSha256 = hash(sourcePath);
if (sourceSha256 !== pins.CONPTY_CC_BUILT_SHA256) fail(`conpty.cc is not the pinned #922 + root-handle source (sha256 ${sourceSha256})`);
const agentPath = path.join(root, 'lib', 'windowsPtyAgent.js');
const agentSha256 = fs.existsSync(agentPath) ? hash(agentPath) : 'missing';
if (agentSha256 !== pins.AGENT_JS_HANDOFF_SHA256) fail(`lib/windowsPtyAgent.js is not the pinned root-handle form (sha256 ${agentSha256})`);
const sourceStat = fs.statSync(sourcePath);
// node-pty loads this Electron-ABI build; npm's prebuilds are for stock Node
// and cannot be rebuilt against Electron here.
const binaries = [path.join(root, 'build', 'Release', 'conpty.node')];
if (!fs.existsSync(binaries[0])) fail('electron-rebuild did not produce build/Release/conpty.node');
if (binaries.some((p) => fs.statSync(p).mtimeMs <= sourceStat.mtimeMs)) fail('conpty.node is not newer than patched conpty.cc (stale binary; rerun electron-rebuild -f)');
// mtime alone can be faked by a plain copy; the lock imports are a property of the #922 code.
if (!binaries.every(pins.hasMutexImports)) fail(`conpty.node lacks the #922 mutex imports (${pins.MUTEX_IMPORTS.join(', ')}): not built from the patched source`);
// The same for the handoff: only its code calls DuplicateHandle.
if (!binaries.every(pins.hasHandoffImports)) fail(`conpty.node lacks the root-handle import (${pins.HANDOFF_IMPORTS.join(', ')}): not built from the handoff source`);
// PTY-CONHOST-LEAK-NATIVE: the close on exit needs no new import, so the patched module exports a
// name that no other build carries.
if (!binaries.every(pins.hasCloseMarker)) fail(`conpty.node lacks the close-on-exit marker (${pins.CLOSE_MARKER}): not built from the source that closes an ended terminal's pseudoconsole`);
const files = Object.fromEntries(binaries.map((p) => [path.relative(root, p).replaceAll('\\', '/'), { sha256: hash(p), mtimeMs: fs.statSync(p).mtimeMs }]));
fs.writeFileSync(markerPath, `${JSON.stringify({ version: pkg.version, sourceSha256, sourceMtimeMs: sourceStat.mtimeMs, files }, null, 2)}\n`);
console.log(`[record-node-pty-race-fix] ${pkg.version}; recorded ${binaries.length} rebuilt conpty.node digest(s)`);
