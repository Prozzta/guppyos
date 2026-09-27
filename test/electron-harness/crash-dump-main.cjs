'use strict';

/**
 * RENDERER-RECOVERY-164: the local crash reporter, for real, in a hidden Electron.
 *   --mode dump      start the reporter (crashDumps.ts, uploadToServer:false), crash a hidden
 *                    renderer with process.crash(), and report the exit code and the dump that
 *                    waitForDump finds in the sandbox's crashDumps folder
 *   --mode ready     only measure time from process start to app 'ready', with
 *                    --reporter on|off, for the startup-cost comparison
 * The parent owns the sandbox directory.
 */
const { app, BrowserWindow, crashReporter } = require('electron');
const { writeFileSync, readFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const ts = require('typescript');

const t0 = Date.now() - Math.round(process.uptime() * 1000);
const MARKER = '__CRASHDUMP_RESULT__';
const argOf = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const sandbox = argOf('sandbox', null);
const mode = argOf('mode', 'dump');
const withReporter = argOf('reporter', 'on') === 'on';
if (!sandbox) { process.stderr.write('crash-dump harness: --sandbox required\n'); process.exit(2); }
const crashDir = join(sandbox, 'Crashpad');
mkdirSync(crashDir, { recursive: true });
app.setPath('userData', sandbox);
app.setPath('sessionData', sandbox);
app.setPath('crashDumps', crashDir);

const load = (rel) => {
  const src = readFileSync(join(__dirname, '..', '..', 'src', 'main', rel), 'utf8');
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', js)(mod, mod.exports, require);
  return mod.exports;
};
const D = load('crashDumps.ts');

const start = withReporter ? D.startLocalCrashReporter(crashReporter) : null;
const finish = (r) => { process.stdout.write(`${MARKER}${JSON.stringify(r)}\n`); app.exit(0); };
setTimeout(() => finish({ ok: false, error: 'timeout' }), 45_000).unref?.();

app.whenReady().then(async () => {
  const readyMs = Date.now() - t0;
  const startCostMs = start ? start.readyAt - start.startedAt : null;
  if (mode === 'ready') { finish({ ok: true, readyMs, startCostMs, reporter: withReporter }); return; }
  const page = join(sandbox, 'crash.html');
  writeFileSync(page, '<!doctype html><meta charset="utf-8"><script>setTimeout(() => process.crash(), 300);</script>');
  const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false } });
  const since = Date.now();
  win.webContents.on('render-process-gone', async (_e, d) => {
    const dump = await D.waitForDump(crashDir, since, { tries: 40, intervalMs: 250 });
    finish({ ok: true, reason: d.reason, exitCode: d.exitCode, dumpPath: dump?.path ?? null, dumpBytes: dump?.size ?? null, inSandbox: !!dump && dump.path.startsWith(crashDir), startCostMs, readyMs, uploadsEnabled: crashReporter.getUploadToServer() });
  });
  win.loadFile(page);
});
