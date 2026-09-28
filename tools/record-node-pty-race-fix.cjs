#!/usr/bin/env node
'use strict';

// Emit evidence only when electron-rebuild compiled a #922-patched source:
// node-pty is the pinned 1.1.0, conpty.cc is byte-for-byte the pinned patched
// form, and build/Release/conpty.node is newer than that patched source (a
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
if (sourceSha256 !== pins.CONPTY_CC_PATCHED_SHA256) fail(`conpty.cc is not the pinned #922-patched source (sha256 ${sourceSha256})`);
const sourceStat = fs.statSync(sourcePath);
// node-pty loads this Electron-ABI build; npm's prebuilds are for stock Node
// and cannot be rebuilt against Electron here.
const binaries = [path.join(root, 'build', 'Release', 'conpty.node')];
if (!fs.existsSync(binaries[0])) fail('electron-rebuild did not produce build/Release/conpty.node');
if (binaries.some((p) => fs.statSync(p).mtimeMs <= sourceStat.mtimeMs)) fail('conpty.node is not newer than patched conpty.cc (stale binary; rerun electron-rebuild -f)');
const files = Object.fromEntries(binaries.map((p) => [path.relative(root, p).replaceAll('\\', '/'), { sha256: hash(p), mtimeMs: fs.statSync(p).mtimeMs }]));
fs.writeFileSync(markerPath, `${JSON.stringify({ version: pkg.version, sourceSha256, sourceMtimeMs: sourceStat.mtimeMs, files }, null, 2)}\n`);
console.log(`[record-node-pty-race-fix] ${pkg.version}; recorded ${binaries.length} rebuilt conpty.node digest(s)`);
