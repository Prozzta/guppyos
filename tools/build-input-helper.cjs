'use strict';
/** Build the Windows input helper with the in-box .NET Framework C# compiler. */
const { mkdirSync, existsSync, statSync } = require('node:fs');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'resources', 'input', 'guppy-input.cs');
const OUT_DIR = join(ROOT, 'resources', 'input', 'bin');
const OUT = join(OUT_DIR, 'guppy-input.exe');
mkdirSync(OUT_DIR, { recursive: true });
if (process.platform !== 'win32') { console.log('[build-input-helper] not Windows: skipped'); process.exit(0); }
const csc = join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
if (!existsSync(csc)) { console.error(`[build-input-helper] no C# compiler at ${csc}`); process.exit(1); }
const r = spawnSync(csc, ['-nologo', '-O', '-platform:anycpu', '-r:System.Windows.Forms.dll', `-out:${OUT}`, SRC], { encoding: 'utf8', windowsHide: true });
if (r.status !== 0) { console.error(`[build-input-helper] csc failed (${r.status}):\n${r.stdout || ''}${r.stderr || ''}`); process.exit(1); }
console.log(`[build-input-helper] ${OUT} (${statSync(OUT).size} bytes)`);
