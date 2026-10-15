'use strict';
/**
 * GPU-SETTING-188 rendered proof: for each saved Graphics mode, a fresh jailed Electron (gpu-mode-main.cjs,
 * no --disable-gpu, no visible window) runs the product's startup step and reports what WebGL really got.
 *   node test/electron-harness/run-gpu-setting-188.cjs --out <dir> [--modes cpu,auto,gpu,corrupt]
 * Pass: cpu -> a software renderer (SwiftShader) with GPU compositing off; auto/gpu -> a hardware renderer
 * (this needs a PC with a usable GPU); corrupt config.json -> treated as auto. Writes <out>/summary.json.
 * Jailed: APPDATA, LOCALAPPDATA, USERPROFILE, HOME and every Electron path under <out>; HIVE_/AGENT_/
 * MEMORY_/MUNDER_ variables are scrubbed. Kills only the child it started, and only on its own timeout.
 */
const { mkdirSync, writeFileSync, readFileSync, existsSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { spawn } = require('node:child_process');
const loadTs = require('../load-ts.cjs');
const { isSoftwareRenderer } = loadTs('src/shared/graphicsMode.ts');

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const out = arg('--out') && resolve(arg('--out'));
if (!out) { console.error('--out <dir> is required'); process.exit(2); }
const modes = (arg('--modes') || 'cpu,auto,gpu,corrupt').split(',');
for (const k of Object.keys(process.env)) if (/^(HIVE_|AGENT_|MEMORY_|MUNDER_)/i.test(k)) delete process.env[k];

const root = resolve(__dirname, '..', '..');
const main = join(__dirname, 'gpu-mode-main.cjs');
const CONFIG = { cpu: '{"graphicsMode":"cpu"}', auto: '{"graphicsMode":"auto"}', gpu: '{"graphicsMode":"gpu"}', corrupt: '{"graphicsMode": "cpu"' };
const EXPECT = { cpu: 'software', auto: 'hardware', gpu: 'hardware', corrupt: 'hardware' };
const MODE = { cpu: 'cpu', auto: 'auto', gpu: 'gpu', corrupt: 'auto' };

function runOne(name) {
  const dir = join(out, name);
  const jail = join(dir, 'jail');
  const userData = join(dir, 'userData');
  for (const d of [join(jail, 'AppData/Roaming'), join(jail, 'AppData/Local'), userData]) mkdirSync(d, { recursive: true });
  writeFileSync(join(userData, 'config.json'), CONFIG[name]);
  const result = join(dir, 'result.json');
  return new Promise((done) => {
    const child = spawn(require('electron'), [main, userData, result], {
      cwd: root,
      env: { ...process.env, MUNDER_DEV: '', ELECTRON_ENABLE_LOGGING: '1',
        APPDATA: join(jail, 'AppData/Roaming'), LOCALAPPDATA: join(jail, 'AppData/Local'), USERPROFILE: jail, HOME: jail },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.stdout.on('data', () => {});
    const timer = setTimeout(() => child.kill(), 90_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      const r = existsSync(result) ? JSON.parse(readFileSync(result, 'utf8')) : { error: `no result (exit ${code})`, stderr: err.slice(-2000) };
      done({ name, code, ...r });
    });
  });
}

(async () => {
  mkdirSync(out, { recursive: true });
  const rows = [];
  for (const name of modes) rows.push(await runOne(name)); // one at a time: GPU processes must not overlap
  const checks = rows.map((r) => {
    const renderer = r.page && r.page.renderer;
    const got = r.error ? 'error' : !r.page.webgl ? 'no-webgl' : isSoftwareRenderer(renderer) ? 'software' : 'hardware';
    const compositing = r.feature && r.feature.gpu_compositing;
    const ok = got === EXPECT[r.name] && r.started && r.started.mode === MODE[r.name] && r.started.applied === true
      && (r.name !== 'cpu' || !String(compositing).startsWith('enabled'));
    return { name: r.name, ok, expected: EXPECT[r.name], got, renderer, powerPreference: r.page && r.page.powerPreference,
      gpu_compositing: compositing, label: r.label, mode: r.started && r.started.mode, error: r.error };
  });
  writeFileSync(join(out, 'summary.json'), JSON.stringify({ electron: rows[0] && rows[0].electron, checks, rows }, null, 2));
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}: ${c.got} (${c.renderer}) pp=${c.powerPreference} compositing=${c.gpu_compositing} | ${c.label}${c.error ? ' | ' + c.error : ''}`);
  process.exit(checks.every((c) => c.ok) ? 0 : 1);
})();
