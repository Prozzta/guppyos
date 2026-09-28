#!/usr/bin/env node
'use strict';

// Emit evidence only when electron-rebuild compiled a #922-patched source.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.join(__dirname, '..', 'node_modules', 'node-pty');
const pkgPath = path.join(root, 'package.json');
const sourcePath = path.join(root, 'src', 'win', 'conpty.cc');
const markerPath = path.join(root, '.munder-conpty-race-fix.json');
const hash = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
if (!fs.existsSync(pkgPath) || !fs.existsSync(sourcePath)) throw new Error('node-pty source missing');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const source = fs.readFileSync(sourcePath, 'utf8');
if (pkg.version !== '1.1.0') throw new Error(`node-pty 1.1.0 required, got ${pkg.version}`);
if (!source.includes('std::mutex g_ptyHandlesMutex') || !source.includes('std::erase_if(ptyHandles')) throw new Error('node-pty #922 mutex/erase absent');
const sourceStat = fs.statSync(sourcePath);
// node-pty loads this Electron-ABI build; npm's prebuilds are for stock Node
// and cannot be rebuilt against Electron here.
const binaries = [path.join(root, 'build', 'Release', 'conpty.node')];
if (!fs.existsSync(binaries[0])) throw new Error('electron-rebuild did not produce build/Release/conpty.node');
if (binaries.some((p) => fs.statSync(p).mtimeMs <= sourceStat.mtimeMs)) throw new Error('conpty.node is not newer than patched conpty.cc');
const files = Object.fromEntries(binaries.map((p) => [path.relative(root, p).replaceAll('\\', '/'), { sha256: hash(p), mtimeMs: fs.statSync(p).mtimeMs }]));
fs.writeFileSync(markerPath, `${JSON.stringify({ version: pkg.version, sourceSha256: hash(sourcePath), sourceMtimeMs: sourceStat.mtimeMs, files }, null, 2)}\n`);
console.log(`[record-node-pty-race-fix] ${pkg.version}; recorded ${binaries.length} rebuilt conpty.node digest(s)`);
