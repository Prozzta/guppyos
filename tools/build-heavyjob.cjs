'use strict';
/**
 * HEAVY-CPU-OPTIONS-191: compile the heavy-job helper (resources/heavyjob/guppy-heavyjob.cs) with the
 * C# compiler that ships with Windows (.NET Framework 4.x csc), into resources/heavyjob/bin, which
 * electron-builder ships as <resources>/heavyjob. Built from source on every build, locally and in the
 * release job; no prebuilt .exe is committed and no npm dependency is added. Elsewhere it only makes the
 * (empty) folder: the options are Windows-only.
 */
const { mkdirSync, existsSync, statSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'resources', 'heavyjob', 'guppy-heavyjob.cs');
const OUT_DIR = join(ROOT, 'resources', 'heavyjob', 'bin');
const OUT = join(OUT_DIR, 'guppy-heavyjob.exe');

mkdirSync(OUT_DIR, { recursive: true });
if (process.platform !== 'win32') {
  console.log('[build-heavyjob] not Windows: skipped');
  process.exit(0);
}
const csc = join(process.env.WINDIR || 'C:\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
if (!existsSync(csc)) {
  console.error(`[build-heavyjob] no C# compiler at ${csc}`);
  process.exit(1);
}
const r = spawnSync(csc, ['-nologo', '-O', '-platform:anycpu', `-out:${OUT}`, SRC], { encoding: 'utf8', windowsHide: true });
if (r.status !== 0) {
  console.error(`[build-heavyjob] csc failed (${r.status}):\n${r.stdout || ''}${r.stderr || ''}`);
  process.exit(1);
}
console.log(`[build-heavyjob] ${OUT} (${statSync(OUT).size} bytes)`);
