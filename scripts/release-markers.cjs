#!/usr/bin/env node
/*
 * The release markers (runbook Appendix B steps 4 and 7), now TWELVE: the 9 postinstall markers
 * (node-pty's conpty patch, its #922 backport source and rebuilt-binary provenance, native builds,
 * better-sqlite3) plus the 3 native-memory artifacts
 * (NATIVE-MEMORY spec section 5.5, Jim fix 5), each checked by SHA-256 against
 * resources/models/native-memory-manifest.json:
 *   10 vec0.dll                       (sqlite-vec, win32-x64)
 *   11 onnxruntime.dll + binding      (onnxruntime-node, win32-x64 CPU)
 *   12 the model (onnx + tokenizer)   (all-MiniLM-L6-v2 fp32)
 *
 *   node scripts/release-markers.cjs <node_modules root> <models dir>
 *     source:  node_modules                                        resources/models
 *     build:   dist/win-unpacked/resources/app.asar.unpacked/node_modules   dist/win-unpacked/resources/models
 * Prints ALL 12 MARKERS OK, or MARKERS FAILED (exit 1).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = process.argv[2];
const modelsDir = process.argv[3];
if (!root || !modelsDir) { console.error('usage: release-markers.cjs <node_modules root> <models dir>'); process.exit(2); }
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'resources', 'models', 'native-memory-manifest.json'), 'utf8'));
const agent = path.join(root, 'node-pty', 'lib', 'conpty_console_list_agent.js');
const src = fs.existsSync(agent) ? fs.readFileSync(agent, 'utf8') : '';
const ptyRoot = path.join(root, 'node-pty');
const ptySource = path.join(ptyRoot, 'src', 'win', 'conpty.cc');
const ptyPackagePath = path.join(ptyRoot, 'package.json');
const ptyPackage = fs.existsSync(ptyPackagePath) ? JSON.parse(fs.readFileSync(ptyPackagePath, 'utf8')) : null;
const racePins = require('../tools/node-pty-race-fix-pins.cjs');
const raceMarkerPath = path.join(ptyRoot, racePins.MARKER_FILE);
const raceMarker = (() => { try { return JSON.parse(fs.readFileSync(raceMarkerPath, 'utf8')); } catch { return null; } })();
const findFile = (dir, name) => { const out = []; const walk = (d) => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name === name) out.push(p); } }; walk(dir); return out; };
const built = (pkg, name) => findFile(path.join(root, pkg), name).filter((p) => fs.statSync(p).size > 0);
const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; } };
// node-pty #922 backport (tools/patch-node-pty-race-fix.cjs). electron-builder strips *.cc
// from the packaged tree, so there the recorded (pinned) source digest stands in for the
// source file; in the source tree the file itself must match and be older than the binary.
const ptySourcePresent = fs.existsSync(ptySource);
const race922Source = () => ptySourcePresent
  ? sha(ptySource) === racePins.CONPTY_CC_PATCHED_SHA256
  : !!raceMarker && raceMarker.sourceSha256 === racePins.CONPTY_CC_PATCHED_SHA256;
const raceBinaryProvenance = () => {
  const v = racePins.NODE_PTY_VERSION;
  if (!raceMarker || !ptyPackage || ptyPackage.version !== v || raceMarker.version !== v || !raceMarker.files || typeof raceMarker.files !== 'object') return false;
  if (raceMarker.sourceSha256 !== racePins.CONPTY_CC_PATCHED_SHA256) return false;
  if (ptySourcePresent && raceMarker.sourceSha256 !== sha(ptySource)) return false;
  const sourceMtimeMs = ptySourcePresent ? fs.statSync(ptySource).mtimeMs : -Infinity;
  const binaries = [path.join(ptyRoot, 'build', 'Release', 'conpty.node')].filter((p) => fs.existsSync(p) && fs.statSync(p).size > 0);
  return binaries.length > 0 && binaries.every((p) => {
    const record = raceMarker.files[path.relative(ptyRoot, p).replaceAll('\\', '/')];
    return record && record.sha256 === sha(p) && fs.statSync(p).mtimeMs > sourceMtimeMs && racePins.hasMutexImports(p);
  });
};
const plat = 'win32-x64';
const vec = manifest.vec0[plat];
const ort = manifest.ort[plat];
const checks = [
  ['conpty guard present', src.includes('try { consoleProcessList = getConsoleProcessList(shellPid); } catch (e) { consoleProcessList = []; }')],
  ['unguarded form absent', src.length > 0 && !src.includes('var consoleProcessList = getConsoleProcessList(shellPid);')],
  ['send guard present', src.includes('try { process.send({ consoleProcessList: consoleProcessList }); } catch (e)')],
  ['node-pty #922 backport source', race922Source()],
  ['conpty race-fix rebuilt binary provenance', raceBinaryProvenance()],
  ['pty.node built', built('node-pty', 'pty.node').length > 0],
  ['conpty.node built', built('node-pty', 'conpty.node').length > 0],
  ['winpty-agent.exe built', built('node-pty', 'winpty-agent.exe').length > 0],
  ['better_sqlite3.node built', built('better-sqlite3', 'better_sqlite3.node').length > 0],
  // The packager may nest the platform package under sqlite-vec (the installed layout does).
  ['vec0.dll digest = manifest', !!vec && [path.join(root, vec.package, vec.file), path.join(root, 'sqlite-vec', 'node_modules', vec.package, vec.file)].some((p) => sha(p) === vec.sha256)],
  ['onnxruntime win32-x64 digests = manifest', !!ort && Object.entries(ort).every(([rel, want]) => sha(path.join(root, 'onnxruntime-node', ...rel.split('/'))) === want)],
  ['model files digests = manifest', Object.entries(manifest.model.files).every(([rel, want]) => sha(path.join(modelsDir, manifest.model.dir, ...rel.split('/'))) === want)]
];
let ok = true;
for (const [n, v] of checks) { console.log((v ? 'OK   ' : 'FAIL ') + n); ok = ok && v; }
console.log(ok ? `ALL ${checks.length} MARKERS OK` : 'MARKERS FAILED');
process.exit(ok ? 0 : 1);
