#!/usr/bin/env node
'use strict';
/**
 * PTY-CONHOST-ORPHAN-OWNER-DEATH (option A): every Guppy PTY runs on the OpenConsole that ships
 * inside node-pty (useConptyDll), not on the inbox conhost.exe. When its ConPTY owner dies
 * abruptly, the inbox conhost (10.0.19041) parks forever with no parent; OpenConsole goes.
 *
 * conpty.cc loads `<dir of conpty.node>\conpty\conpty.dll`, and that dll starts
 * `OpenConsole.exe` from the same folder. node-pty's own scripts/post-install.js puts them there,
 * but our postinstall builds with electron-rebuild, which never runs it, so the folder was missing.
 * This tool copies the pair from node-pty's third_party folder into build/Release/conpty/ and
 * checks every byte against the pins (tools/node-pty-race-fix-pins.cjs). Run after
 * electron-rebuild. Windows only; a no-op elsewhere.
 *
 *   node tools/stage-node-pty-openconsole.cjs           copy (idempotent), then verify
 *   node tools/stage-node-pty-openconsole.cjs --check   verify only; exit 1 when anything is off
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const pins = require('./node-pty-race-fix-pins.cjs');

/** Where the pair must sit, for a node-pty root (node_modules/node-pty or a packaged copy). */
function stagedDir(npRoot) { return path.join(npRoot, 'build', 'Release', 'conpty'); }

function sha256(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
}

/** The pinned arch: npm_config_arch when an install cross-builds, else this process's. */
function targetArch(env = process.env) {
  const a = env.npm_config_arch || process.arch;
  return a === 'arm64' ? 'arm64' : a === 'x64' ? 'x64' : null;
}

/** Problems with the staged pair under `npRoot` for `arch` (empty = good). */
function checkStaged(npRoot, arch) {
  const want = pins.OPENCONSOLE_SHA256[arch];
  if (!want) return [`no pinned OpenConsole for arch ${arch}`];
  const out = [];
  for (const name of Object.keys(want)) {
    const got = sha256(path.join(stagedDir(npRoot), name));
    if (got === null) out.push(`${name} is missing from ${stagedDir(npRoot)}`);
    else if (got !== want[name]) out.push(`${name} is ${got.slice(0, 12)}, not the pinned ${want[name].slice(0, 12)}`);
  }
  return out;
}

/** Copy the pair for `arch` from node-pty's third_party folder; the source must match the pins. */
function stage(npRoot, arch) {
  const want = pins.OPENCONSOLE_SHA256[arch];
  if (!want) throw new Error(`no pinned OpenConsole for arch ${arch}`);
  const src = path.join(npRoot, 'third_party', 'conpty', pins.CONPTY_THIRD_PARTY_VERSION, `win10-${arch}`);
  fs.mkdirSync(stagedDir(npRoot), { recursive: true });
  for (const name of Object.keys(want)) {
    const from = path.join(src, name);
    const got = sha256(from);
    if (got !== want[name]) throw new Error(`${from} is ${got === null ? 'missing' : got.slice(0, 12)}, not the pinned ${want[name].slice(0, 12)}`);
    const to = path.join(stagedDir(npRoot), name);
    if (sha256(to) !== want[name]) fs.copyFileSync(from, to);
  }
}

function main(argv) {
  if (process.platform !== 'win32') return 0;
  const npRoot = path.join(__dirname, '..', 'node_modules', 'node-pty');
  const arch = targetArch();
  if (!arch) { console.error(`[stage-node-pty-openconsole] unsupported arch ${process.env.npm_config_arch || process.arch}`); return 1; }
  if (!argv.includes('--check')) {
    try { stage(npRoot, arch); } catch (e) { console.error(`[stage-node-pty-openconsole] ${e.message}`); return 1; }
  }
  const bad = checkStaged(npRoot, arch);
  if (bad.length) { console.error(`[stage-node-pty-openconsole] NOT STAGED: ${bad.join('; ')}`); return 1; }
  console.log(`[stage-node-pty-openconsole] OpenConsole ${pins.CONPTY_THIRD_PARTY_VERSION} (${arch}) staged in build/Release/conpty`);
  return 0;
}

module.exports = { stagedDir, checkStaged, stage, targetArch };
if (require.main === module) process.exitCode = main(process.argv.slice(2));
